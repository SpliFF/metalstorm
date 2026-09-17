// tranche.js — PLAN-perf.md §M19 XL-battle spawn recipe, reproduced as data.
//
// TOOLING GAP (docs/reviews/beta/README.md): "No committed script reproduces
// PLAN-perf.md's XL900 (900-unit) population". The table below is the exact
// cumulative grid recipe PLAN-perf.md §M19 measured (S → M → L → XL750 →
// XL900 → XL1200 tranches, each one added ON TOP of the last, same map/room/
// centre every time) — reproduced here from that file's tranche table and its
// S-battle `grid()` Lua helper, not redefined. `server.js`'s `populate_tranche`
// case runs `buildTrancheLua` through `exec_lua` (LuaRules scope) as ONE
// batched call per rung, per the plan's own "spawn N armored units in one
// Spring.CreateUnit + SetUnitArmored loop" practical note — 900 individual
// `spawn_unit` round trips would be both slow and off-recipe.
//
// Map: `meridian_basin`, centre (8192, 8192) — the map's own contested-core
// ford. Teams: 0 (north bank, host) and 4 (south bank, AI/second player) per
// `modOptions.war_sides = "compact:0,union:4"` — PLAN-perf.md's own caveat
// applies: read `lobby.currentRoom.modOptions.war_sides` before assuming this
// mapping still holds.

import { verbToken, VerbArgError } from './verb-args.js';
import { LUA_JSON } from './lua-snippets.js';

export const CENTER = { x: 8192, z: 8192 };
export const DEFAULT_TEAM_NORTH = 0;
export const DEFAULT_TEAM_SOUTH = 4;
export const SOLDIER_DEF = 'ms_soldiers_s1';
export const TANK_DEF = 'ms_tanks_s2';

export const RUNGS = ['S', 'M', 'L', 'XL750', 'XL900', 'XL1200'];

/** Each rung's OWN increment (not cumulative) — z is absolute, matching
 *  PLAN-perf.md §M19's table verbatim; `perRow` widens with the tranche so
 *  the formation stays 2-4 rows deep rather than growing a long queue. */
const TRANCHE_ROWS = {
    S:      { soldiers: { n: 20, perRow: 5,  zNorth: 7500, zSouth: 8900 }, tanks: { n: 10, perRow: 5,  zNorth: 7300, zSouth: 9100 } },
    M:      { soldiers: { n: 80, perRow: 20, zNorth: 7200, zSouth: 9250 }, tanks: { n: 40, perRow: 20, zNorth: 6950, zSouth: 9500 } },
    L:      { soldiers: { n: 100, perRow: 25, zNorth: 7100, zSouth: 9350 }, tanks: { n: 50, perRow: 25, zNorth: 6800, zSouth: 9650 } },
    XL750:  { soldiers: { n: 50, perRow: 25, zNorth: 7000, zSouth: 9450 }, tanks: { n: 25, perRow: 25, zNorth: 6700, zSouth: 9750 } },
    XL900:  { soldiers: { n: 50, perRow: 25, zNorth: 6900, zSouth: 9550 }, tanks: { n: 25, perRow: 25, zNorth: 6600, zSouth: 9850 } },
    XL1200: { soldiers: { n: 100, perRow: 25, zNorth: 6750, zSouth: 9700 }, tanks: { n: 50, perRow: 25, zNorth: 6450, zSouth: 10000 } },
};

/** Running total of sim UNITS (both teams combined) at each rung, as recorded
 *  in PLAN-perf.md §M19 — kept as a fixture to check against, never derived,
 *  per that file's own rule ("always *record* the member count, never derive
 *  it"). */
export const RUNNING_TOTAL_UNITS = { S: 60, M: 300, L: 600, XL750: 750, XL900: 900, XL1200: 1200 };

/** Every rung from S up to and including `rung` — the cumulative population. */
export function trancheRungs(rung) {
    const idx = RUNGS.indexOf(rung);
    if (idx < 0) throw new Error(`populate_tranche: unknown rung "${rung}" — expected one of ${RUNGS.join(', ')}`);
    return RUNGS.slice(0, idx + 1);
}

/** The flat list of grid() calls that reproduce the cumulative population up
 *  to and including `rung` — one entry per (def, side) per included rung. */
export function trancheGridCalls(rung, { soldierDef = SOLDIER_DEF, tankDef = TANK_DEF } = {}) {
    return trancheRungs(rung).flatMap((r) => {
        const row = TRANCHE_ROWS[r];
        return [
            { rung: r, def: soldierDef, side: 'north', n: row.soldiers.n, z: row.soldiers.zNorth, perRow: row.soldiers.perRow },
            { rung: r, def: tankDef,    side: 'north', n: row.tanks.n,    z: row.tanks.zNorth,    perRow: row.tanks.perRow },
            { rung: r, def: soldierDef, side: 'south', n: row.soldiers.n, z: row.soldiers.zSouth, perRow: row.soldiers.perRow },
            { rung: r, def: tankDef,    side: 'south', n: row.tanks.n,    z: row.tanks.zSouth,    perRow: row.tanks.perRow },
        ];
    });
}

export function trancheUnitCount(rung) {
    if (!(rung in RUNNING_TOTAL_UNITS)) {
        throw new Error(`populate_tranche: unknown rung "${rung}" — expected one of ${RUNGS.join(', ')}`);
    }
    return RUNNING_TOTAL_UNITS[rung];
}

/**
 * Render the LuaRules program that spawns the cumulative `rung` population in
 * one batch, using the S-battle `grid()` helper verbatim (PLAN-perf.md: bulk
 * `Spring.CreateUnit` + `Spring.SetUnitArmored` in one Lua call — confirmed
 * crash-free across M6/M9/M19-M26). Returns one JSON line via `LUA_JSON`'s
 * `J()` encoder: `{teamNorth, teamSouth, teamNorthCount, teamSouthCount}`.
 */
export function buildTrancheLua(rung, opts = {}) {
    const calls = trancheGridCalls(rung, opts);
    const center = {
        x: Number.isFinite(opts.center?.x) ? opts.center.x : CENTER.x,
        z: Number.isFinite(opts.center?.z) ? opts.center.z : CENTER.z,
    };
    const teamNorth = Number.isFinite(opts.teamNorth) ? Math.floor(opts.teamNorth) : DEFAULT_TEAM_NORTH;
    const teamSouth = Number.isFinite(opts.teamSouth) ? Math.floor(opts.teamSouth) : DEFAULT_TEAM_SOUTH;
    const armored = opts.armored !== false;
    // Reject anything that is not a bare Lua-safe token before it goes anywhere
    // near a string literal — same discipline verb-args.js applies to server
    // exec verbs.
    for (const c of calls) {
        try { verbToken(c.def, 'defName'); }
        catch (e) { throw e instanceof VerbArgError ? e : new Error(String(e)); }
    }

    const lines = [];
    lines.push(LUA_JSON.trim());
    lines.push('GG = GG or {}');
    lines.push('GG.perfTranche = GG.perfTranche or {}');
    lines.push(`GG.perfTranche[${teamNorth}] = GG.perfTranche[${teamNorth}] or {}`);
    lines.push(`GG.perfTranche[${teamSouth}] = GG.perfTranche[${teamSouth}] or {}`);
    lines.push('local function grid(def, cx, cz, n, team, perRow)');
    lines.push('  local ids = GG.perfTranche[team]');
    lines.push('  for i = 1, n do');
    lines.push('    local c = (i-1) % perRow');
    lines.push('    local r = math.floor((i-1) / perRow)');
    lines.push('    local x = cx + (c - (perRow-1)/2) * 48');
    lines.push('    local z = cz + r * 48');
    lines.push('    local u = Spring.CreateUnit(def, x, Spring.GetGroundHeight(x, z), z, 0, team)');
    lines.push(armored
        ? '    if u then ids[#ids+1] = u; Spring.SetUnitArmored(u, true, 0.00003) end'
        : '    if u then ids[#ids+1] = u end');
    lines.push('  end');
    lines.push('end');
    if (opts.suppressGameOver) {
        lines.push('GG.perfRealGameOver = GG.perfRealGameOver or Spring.GameOver');
        lines.push('Spring.GameOver = function(w) return w and #w or 0 end');
    }
    for (const call of calls) {
        const team = call.side === 'north' ? teamNorth : teamSouth;
        lines.push(`grid('${call.def}', ${center.x}, ${call.z}, ${call.n}, ${team}, ${call.perRow})`);
    }
    lines.push(`return J({teamNorth = ${teamNorth}, teamSouth = ${teamSouth}, `
        + `teamNorthCount = #GG.perfTranche[${teamNorth}], teamSouthCount = #GG.perfTranche[${teamSouth}]})`);
    return lines.join('\n');
}
