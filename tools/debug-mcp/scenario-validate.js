/**
 * Offline scenario validation — replicates BOTH scenario parsers.
 *
 * A scenario file is read by two different parsers with two different failure
 * modes, and neither tells an author anything useful:
 *
 *  - The lobby's discovery pass (`ScenarioDiscovery.cpp`) loads it into a bare
 *    `lua_State`. A file that fails there is not offered in the Create Game
 *    picker; the only trace is one SLOG warning nobody reads.
 *  - The sim loader (`game_scenario.lua`'s `validate()`) runs at GameStart —
 *    i.e. only after a full server boot — and `error()`s the whole finding
 *    list at once.
 *
 * This module runs both rule sets against an already-evaluated table and
 * returns structured findings, so the loop is "write → validate → fix" instead
 * of "write → boot a war → read a log".
 *
 * Every rule carries a stable `rule` id (documented in docs/scenarios.md §11)
 * and a `path` that mirrors the context string the in-game error would have
 * used (`units[3]`, `world.features[1]`, `ai[2].slate.home`), so a finding here
 * and a finding there are the same finding.
 *
 * Severity contract:
 *   error   — the sim's validate() would reject it, or the lobby would refuse
 *             to offer the war. Blocks `write_scenario`.
 *   warning — loads and runs, but a documented contract is broken (two victory
 *             objectives, a no-op `orders` block, a region key this map's
 *             on-disk graph does not declare).
 *   info    — advisory.
 *   skipped — a rule that could not run offline (no baked defs cache, no
 *             region graph on disk). Never silently absent: an unrun rule is
 *             reported so nobody mistakes "not checked" for "checked and fine".
 */
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { evalBareLua } from './scenario-lua.js';
import { loadDefNames, loadRegionKeys } from './scenario-defs.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// The CMD name universe (game_scenario.lua's `resolveCmd`, :156-163).
//
// `resolveCmd` accepts a number, or any string key of the engine's global CMD
// table whose value is a number. That table is built by
// `LuaConstCMD::PushEntries` (rts/Lua/LuaConstCMD.cpp) from its `PUSH_CMD(X)`
// macros plus the `LuaPushNamedNumber(L, "X", …)` option/state constants —
// there is no Lua-side list to read, so this is a mirror.
//
// The mirror is kept honest by a test, not by discipline:
// scenario-validate.test.js re-derives both sets straight out of
// LuaConstCMD.cpp and asserts this constant equals them. Add a command to the
// engine, run `node --test tools/debug-mcp/`, and the test names the missing
// entry.
// ---------------------------------------------------------------------------
export const CMD_NAMES = new Set([
    // PUSH_CMD(...) — the command ids themselves
    'AREA_ATTACK', 'ATTACK', 'AUTOREPAIRLEVEL', 'CAPTURE', 'CLOAK', 'DEATHWAIT',
    'FIGHT', 'FIRE_STATE', 'GATHERWAIT', 'GROUPADD', 'GROUPCLEAR', 'GROUPSELECT',
    'GUARD', 'IDLEMODE', 'INSERT', 'INTERNAL', 'LOAD_ONTO', 'LOAD_UNITS',
    'MANUALFIRE', 'MOVE', 'MOVE_STATE', 'ONOFF', 'PATROL', 'RECLAIM', 'REMOVE',
    'REPAIR', 'REPEAT', 'RESTORE', 'RESURRECT', 'SELFD', 'SETBASE', 'SQUADWAIT',
    'STOCKPILE', 'STOP', 'TIMEWAIT', 'TRAJECTORY', 'UNLOAD_UNIT', 'UNLOAD_UNITS',
    'WAIT',
    // LuaPushNamedNumber(...) — options, move/fire states, wait codes, aliases.
    // These are numbers on CMD too, so resolveCmd accepts them; listing them
    // keeps this set equal to "keys of CMD holding a number".
    'DGUN', 'LOOPBACKATTACK',
    'OPT_ALT', 'OPT_CTRL', 'OPT_INTERNAL', 'OPT_META', 'OPT_RIGHT', 'OPT_SHIFT',
    'MOVESTATE_NONE', 'MOVESTATE_HOLDPOS', 'MOVESTATE_MANEUVER', 'MOVESTATE_ROAM',
    'FIRESTATE_NONE', 'FIRESTATE_HOLDFIRE', 'FIRESTATE_RETURNFIRE',
    'FIRESTATE_FIREATWILL', 'FIRESTATE_FIREATNEUTRAL',
    'WAITCODE_TIME', 'WAITCODE_DEATH', 'WAITCODE_SQUAD', 'WAITCODE_GATHER',
]);

/** Scripted-slate kinds the AI plugin implements (game_scenario.lua:66). */
export const AI_SLATE_KINDS = new Set(['garrison', 'raid', 'toll']);

/** Cardinal names `featureHeading` resolves (game_scenario.lua:219-226). */
const FEATURE_FACINGS = new Set(['north', 'east', 'south', 'west']);

const SUPPORTED_VERSION = 1;

// --- small helpers -------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
/** The Lua-side `ipairs(x or {})` idiom: a non-array is an empty sequence. */
const seq = (v) => (Array.isArray(v) ? v : []);
/**
 * Lua's `{}` is both an empty array and an empty hash, and the reader has to
 * pick one — it picks object. So "the author wrote a sequence here" is
 * `Array.isArray(v) || an object with no keys`, and a rule that distinguishes
 * "absent" from "present but empty" (`slate.kinds = {}`) must ask this, not
 * `Array.isArray`.
 */
const isSeqLike = (v) => Array.isArray(v)
    || (v !== null && typeof v === 'object' && Object.keys(v).length === 0);
/** The Lua-side `(x or {})` idiom for a sub-table. */
const tbl = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * @param {object} scn        the evaluated scenario table
 * @param {object} opts
 * @param {Map<string,object>|null} opts.unitDefs     null ⇒ skip unknown-unitdef
 * @param {Map<string,object>|null} opts.featureDefs  null ⇒ skip unknown-featuredef
 * @param {Set<string>|null} opts.regionKeys          null ⇒ skip region-key checks
 * @param {boolean|null} opts.mapDirExists            null ⇒ not checked
 * @param {string} [opts.scenarioId]
 * @returns {Array<{severity, rule, path, message}>}
 */
export function validateScenario(scn, opts = {}) {
    const F = [];
    const add = (severity, rule, path, message) => F.push({ severity, rule, path, message });
    // ONE name space across units[] and world.features[] — a site and a bridge
    // that both call themselves "Ferry Crossing" collide in the rulesParam key
    // space exactly as two sites would (game_scenario.lua:241-259).
    const checkName = makeNameChecker(add);

    checkVersion(scn, add);
    checkVictory(scn, add);
    checkSides(scn, add);
    checkLandmarksAndUnits(scn, add, opts, checkName);
    checkTowns(scn, add, opts);
    checkRegions(scn, add);
    checkFeatures(scn, add, opts, checkName);
    checkAi(scn, add, opts);
    checkObjectiveChaining(scn, add);
    checkObjectivePopulation(scn, add, opts);
    checkReservedBlocks(scn, add);
    checkMcpLayer(scn, add, opts);

    return F;
}

export function countFindings(findings) {
    const counts = { error: 0, warning: 0, info: 0, skipped: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
    return counts;
}

// --- rules ----------------------------------------------------------------

// game_scenario.lua:1103-1106 — the loader errors before validate() even runs.
function checkVersion(scn, add) {
    if (scn.version !== SUPPORTED_VERSION)
        add('error', 'version', 'version',
            `unsupported version ${JSON.stringify(scn.version)} (the loader supports ${SUPPORTED_VERSION})`);
}

// ScenarioDiscovery.cpp:69-86 (HasVictoryObjective).
//
// NOT an error, deliberately. `game_scenario.lua`'s validate() does not look
// at victory at all: a terminal-less war loads and plays, it just never ends
// on its own. This is a discovery-level state (the lobby lists it
// NO-TERMINAL-CONDITION and DefaultForMap skips it), and it is a legitimate
// one — four of the six scenarios this repo ships have no victory objective
// (tutorial_01, roundtrip_static, scenario_smoke_test, meridian_basin_soak),
// and a soak/tutorial/fixture war is *supposed* to run until something stops
// it. Erroring here would make write_scenario refuse to write a tutorial.
function checkVictory(scn, add) {
    const objectives = seq(scn.objectives);
    const victories = objectives.filter((o) => o && o.victory === true);
    if (victories.length === 0)
        add(scn.tutorial === true ? 'info' : 'warning', 'victory-count', 'objectives',
            'no objective has `victory = true` — the war loads and plays, but the lobby lists it '
            + 'NO-TERMINAL-CONDITION, DefaultForMap never auto-selects it for its map, and '
            + 'game_gameover has nothing to end it on. Intended for tutorials, soaks and fixtures; '
            + 'a war meant to be won needs exactly one');
    else if (victories.length > 1)
        add('warning', 'victory-count', 'objectives',
            `${victories.length} objectives declare \`victory = true\`; the lobby accepts this, `
            + 'but exactly one terminal objective is the generated-scenario contract '
            + '(scenariogen.py invariant 2) and whichever completes first ends the war');
}

/**
 * Replicates ReadSides (ScenarioDiscovery.cpp:121-287) and reports the states
 * that make a war unplayable or unroomable.
 */
function checkSides(scn, add) {
    const collectTeams = (key) => {
        const out = new Set();
        for (const e of seq(scn[key]))
            if (e && isNum(e.team)) out.add(e.team & 0xff);   // uint8_t, as the C++ casts
        return out;
    };
    const unitTeams = collectTeams('units');
    const aiTeams = collectTeams('ai');

    // Group by faction in first-declaration order.
    const sides = [];
    seq(scn.sides).forEach((e, i) => {
        if (!e || typeof e !== 'object') return;
        const faction = isStr(e.faction) ? e.faction : '';
        const hasTeam = isNum(e.team);
        if (!faction || !hasTeam) {
            // ReadSides simply skips the entry, so the side does not exist —
            // silently. Say so: an author who wrote `factoin =` gets a war
            // with one fewer room slot and no other symptom.
            add('warning', 'side-ignored', `sides[${i + 1}]`,
                'entry needs both a non-empty string `faction` and a numeric `team`; '
                + 'the lobby skips it, so this side gets no room slot');
            return;
        }
        let s = sides.find((x) => x.faction === faction);
        if (!s) { s = { faction, teams: [], index: i + 1, capacitySet: false }; sides.push(s); }
        const team = e.team & 0xff;
        if (!s.teams.includes(team)) s.teams.push(team);

        // First capacity declaration wins; a negative one is a typo, not
        // "unlimited" (:169-183).
        if (!s.capacitySet && e.capacity !== undefined) {
            if (isNum(e.capacity)) {
                if (e.capacity >= 0) s.capacitySet = true;
                else add('warning', 'side-capacity', `sides[${i + 1}].capacity`,
                    `negative capacity ${e.capacity} is dropped (it does NOT mean unlimited); `
                    + 'the side falls back to the seeding rule. Use "unlimited" for no cap');
            } else if (e.capacity === 'unlimited') s.capacitySet = true;
            else add('warning', 'side-capacity', `sides[${i + 1}].capacity`,
                `capacity must be a number or the string "unlimited", got ${JSON.stringify(e.capacity)} — ignored`);
        }
    });

    for (const s of sides) {
        s.teams.sort((a, b) => a - b);
        s.team = s.teams.length ? s.teams[0] : 0;
        s.staged = false;
        for (const t of s.teams) if (unitTeams.has(t)) { s.team = t; s.staged = true; break; }
        s.npc = s.teams.length > 0 && s.teams.every((t) => aiTeams.has(t));

        // endtoend D19: a playable side resolving to a team with no staged
        // units is a room slot that starts with no army.
        if (!s.npc && !s.staged)
            add('error', 'side-unstaged', `sides[${s.index}]`,
                `playable side "${s.faction}" resolves to team ${s.team}, which the scenario `
                + 'stages no `units` for — a player or AI seated there starts with nothing');

        // EncodeWarSides (:419-433) drops the side rather than emit a
        // war_sides string no parser can recover.
        if (!s.npc && (s.faction.includes(',') || s.faction.includes(':')))
            add('error', 'faction-key', `sides[${s.index}].faction`,
                `faction "${s.faction}" contains ',' or ':' — the war_sides modoption is split `
                + 'on both, so the lobby drops this side from the room entirely');
    }
}

function landmarkNameProblem(name) {
    if (!isStr(name)) return `must be a string, got ${name === null ? 'nil' : typeof name}`;
    if (name === '') return 'must not be empty';
    // The client's regex is /^landmark_(.+)_(x|z)$/ with a greedy capture, so
    // a name ending in _x/_z parses under a truncated name with a missing
    // coordinate (game_scenario.lua:135-151).
    if (/_[xz]$/.test(name))
        return `must not end in "_x" or "_z" — the client splits landmark_<name>_x at the `
            + `LAST underscore, so this would parse as "${name.slice(0, -2)}" with a missing coordinate`;
    return null;
}

function makeNameChecker(add) {
    const seen = new Map();
    return (name, path) => {
        if (name === undefined || name === null) return;
        const problem = landmarkNameProblem(name);
        if (problem) { add('error', 'landmark-name', `${path}.name`, `"name" ${problem}`); return; }
        if (seen.has(name)) {
            add('error', 'landmark-collision', `${path}.name`,
                `duplicate landmark name "${name}" (already used by ${seen.get(name)}) — the name IS `
                + 'the rulesParam key, so one would overwrite the other and a landmark would vanish');
            return;
        }
        seen.set(name, path);
    };
}

function checkDef(def, path, add, unitDefs, rule = 'unknown-unitdef') {
    if (!isStr(def)) {
        add('error', rule, path, `needs a string "def", got ${def === undefined ? 'nil' : JSON.stringify(def)}`);
        return;
    }
    if (unitDefs && !unitDefs.has(def))
        add('error', rule, path, `unknown ${rule === 'unknown-featuredef' ? 'feature' : 'unit'} def "${def}"`);
}

function checkLandmarksAndUnits(scn, add, opts, checkName) {
    seq(scn.units).forEach((u, i) => {
        const path = `units[${i + 1}]`;
        if (!u || typeof u !== 'object') { add('error', 'unknown-unitdef', path, 'entry is not a table'); return; }
        checkDef(u.def, path, add, opts.unitDefs);
        seq(u.orders).forEach((o, j) => {
            const cmd = o && o.cmd;
            const okCmd = isNum(cmd) || (isStr(cmd) && CMD_NAMES.has(cmd));
            if (!okCmd)
                add('error', 'unknown-cmd', `${path}.orders[${j + 1}]`,
                    `unknown cmd ${JSON.stringify(cmd)} — use a numeric command id or a CMD.* `
                    + 'constant name (e.g. "MOVE", "FIGHT", "PATROL", "GUARD")');
        });
        checkName(u.name, path);
        // 'neutral' (Gaia) is the ONLY string a team may be. Checked hard
        // because a typo would otherwise be reported as a missing team and
        // silently drop every neutral town (game_scenario.lua:285-288).
        if (u.team !== undefined && u.team !== null && !isNum(u.team) && u.team !== 'neutral')
            add('error', 'unit-team', `${path}.team`,
                `"team" must be a number or the string "neutral", got ${JSON.stringify(u.team)}`);
    });

    seq(tbl(scn.civilians).units).forEach((c, i) => {
        checkDef(c && c.def, `civilians.units[${i + 1}]`, add, opts.unitDefs);
    });
}

function checkTowns(scn, add, opts) {
    const declared = new Set();
    seq(scn.towns).forEach((t, i) => {
        const path = `towns[${i + 1}]`;
        if (!t || typeof t !== 'object') { add('error', 'town-key', path, 'entry is not a table'); return; }
        if (!isStr(t.key) || t.key === '') add('error', 'town-key', path, 'needs a non-empty string "key"');
        else if (declared.has(t.key)) add('error', 'town-key', path, `duplicate town key "${t.key}"`);
        else declared.add(t.key);

        if (t.x !== undefined && !isNum(t.x)) add('error', 'town-key', `${path}.x`, '"x" must be a number');
        if (t.hall !== undefined) {
            if (!t.hall || typeof t.hall !== 'object' || Array.isArray(t.hall))
                add('error', 'town-key', `${path}.hall`, '"hall" must be a table');
            else {
                checkDef(t.hall.def, `${path}.hall`, add, opts.unitDefs);
                if (!isNum(t.hall.x) || !isNum(t.hall.z))
                    add('error', 'town-key', `${path}.hall`, 'needs numeric "x"/"z"');
            }
        }
    });

    seq(tbl(scn.civilians).units).forEach((c, i) => {
        if (c && c.town !== undefined && !declared.has(c.town))
            add('error', 'orphan-civilian-town', `civilians.units[${i + 1}].town`,
                `names town "${c.town}", which no \`towns\` entry declares — the civilian gets no `
                + 'district, so the estate never counts it and a protect objective there finds nobody');
    });
}

function checkRegions(scn, add) {
    seq(tbl(scn.world).regions).forEach((r, i) => {
        if (!r || (r.key === undefined && (r.x === undefined || r.z === undefined)))
            add('error', 'region-entry', `world.regions[${i + 1}]`, 'needs either "key" or both "x" and "z"');
    });
}

/**
 * `featureChainPitch` (game_scenario.lua:229-236): a per-placement `pitch`
 * wins, else the def's own `customParams.chain_pitch` (the baked cache spells
 * that `custom_params`, and its values are strings). Chaining a def with no
 * pitch stacks every segment on one spot, so the loader refuses it outright.
 */
function checkChainPitch(f, path, add, featureDefs) {
    if (isNum(f.pitch) && f.pitch > 0) return;
    if (!featureDefs) {
        add('skipped', 'feature-chain', `${path}.chain`,
            `chain=${f.chain} with no per-placement "pitch" and no baked feature-def cache to read `
            + 'customParams.chain_pitch from — NOT checked');
        return;
    }
    const def = featureDefs.get(f.def);
    if (!def) return;                       // already reported as unknown-featuredef
    const pitch = Number((def.custom_params || {}).chain_pitch);
    if (!Number.isFinite(pitch) || pitch <= 0)
        add('error', 'feature-chain', `${path}.chain`,
            `"chain" is ${f.chain} but def "${f.def}" declares no customParams.chain_pitch and this `
            + 'entry sets no "pitch" — every segment would stack on one spot, so the loader rejects it');
}

function checkFeatures(scn, add, opts, checkName) {
    seq(tbl(scn.world).features).forEach((f, i) => {
        const path = `world.features[${i + 1}]`;
        if (!f || typeof f !== 'object') { add('error', 'unknown-featuredef', path, 'entry is not a table'); return; }
        checkName(f.name, path);
        checkDef(f.def, path, add, opts.featureDefs, 'unknown-featuredef');
        if (!isNum(f.x) || !isNum(f.z))
            add('error', 'feature-coords', path, 'needs numeric "x" and "z"');
        if (f.facing !== undefined && f.heading === undefined) {
            const ok = isNum(f.facing) || (isStr(f.facing) && FEATURE_FACINGS.has(f.facing.toLowerCase()));
            if (!ok)
                add('error', 'feature-facing', `${path}.facing`,
                    `unknown facing ${JSON.stringify(f.facing)} (expected north/east/south/west or a numeric heading)`);
        }
        if (f.chain !== undefined) {
            if (!isNum(f.chain) || f.chain < 1 || f.chain % 1 !== 0)
                add('error', 'feature-chain', `${path}.chain`, '"chain" must be a positive integer');
            else if (f.chain > 1)
                checkChainPitch(f, path, add, opts.featureDefs);
        }
    });
}

function checkAi(scn, add, opts) {
    seq(scn.ai).forEach((a, i) => {
        const path = `ai[${i + 1}]`;
        if (!a || typeof a !== 'object') { add('error', 'ai-team', path, 'entry is not a table'); return; }
        if (!isNum(a.team)) add('error', 'ai-team', `${path}.team`, 'needs a numeric "team"');
        if (a.profile !== undefined && !isStr(a.profile))
            add('error', 'ai-profile', `${path}.profile`, '"profile" must be a string');

        if (a.slate !== undefined) {
            if (!a.slate || typeof a.slate !== 'object' || Array.isArray(a.slate)) {
                add('error', 'ai-slate', `${path}.slate`, '"slate" must be a table');
                return;
            }
            const kinds = a.slate.kinds;
            for (const k of seq(kinds))
                if (!AI_SLATE_KINDS.has(k))
                    add('error', 'ai-slate', `${path}.slate.kinds`,
                        `unknown slate kind ${JSON.stringify(k)} (the AI plugin implements: `
                        + `${[...AI_SLATE_KINDS].join(', ')})`);
            if (kinds !== undefined && isSeqLike(kinds) && seq(kinds).length === 0)
                add('error', 'ai-slate', `${path}.slate.kinds`, '"slate.kinds" is empty');

            // Region keys: the live graph is authoritative in-game, so an
            // offline mismatch against mapdata/regions.lua is a warning.
            const checkRegion = (key, field) => {
                if (key === undefined || key === null) return;
                if (!opts.regionKeys) return;
                if (!opts.regionKeys.has(key))
                    add('warning', 'ai-region', `${path}.slate.${field}`,
                        `region ${JSON.stringify(key)} is not declared by this map's on-disk graph — `
                        + 'the live graph is authoritative, but if it agrees the loader rejects the war');
            };
            checkRegion(a.slate.home, 'home');
            seq(a.slate.targets).forEach((k) => checkRegion(k, 'targets'));
            seq(a.slate.route).forEach((k) => checkRegion(k, 'route'));
        }

        if (a.stipend !== undefined) {
            const s = a.stipend;
            if (!s || typeof s !== 'object' || Array.isArray(s) || !isNum(s.amount))
                add('error', 'ai-stipend', `${path}.stipend`, '"stipend" needs a numeric "amount"');
        }
    });
}

/**
 * Objective chaining (game_scenario.lua's objectives block in `validate`).
 * Mirrors the loader exactly, because the alternative is a chain the author
 * believes exists: a mis-shaped `phases` is skipped by GG.Objectives.Create's
 * `#def.phases > 0` guard and the parent quietly becomes an ordinary objective.
 */
function checkObjectiveChaining(scn, add) {
    seq(scn.objectives).forEach((o, i) => {
        const path = `objectives[${i + 1}]`;
        if (!o || typeof o !== 'object') return;
        if (o.phases !== undefined) {
            if (!isSeqLike(o.phases) || seq(o.phases).length === 0) {
                add('error', 'objective-phases', `${path}.phases`,
                    '"phases" must be a non-empty array of phases (each an array of child objectives)');
            } else {
                seq(o.phases).forEach((children, pi) => {
                    const ppath = `${path}.phases[${pi + 1}]`;
                    if (!isSeqLike(children) || seq(children).length === 0) {
                        add('error', 'objective-phases', ppath,
                            'each phase must be a non-empty array of child objectives');
                        return;
                    }
                    seq(children).forEach((c, ci) => {
                        const cpath = `${ppath}[${ci + 1}]`;
                        if (!c || typeof c !== 'object') {
                            add('error', 'objective-phases', cpath, 'child must be a table');
                            return;
                        }
                        if (!isStr(c.type))
                            add('error', 'objective-phases', cpath, 'child needs a string "type"');
                        if (c.phases !== undefined)
                            add('error', 'objective-phases', cpath,
                                'nested phases are not supported (one level of chaining only)');
                    });
                });
            }
        }
        for (const field of ['parentId', 'linkedId']) {
            if (o[field] !== undefined && !isNum(o[field]))
                add('error', 'objective-chain-id', `${path}.${field}`,
                    `"${field}" must be a numeric runtime objective id — a scenario file cannot `
                    + 'know an id the engine has not minted yet; use `phases` to author a chain');
        }
        if (o.phase !== undefined && !isNum(o.phase))
            add('error', 'objective-chain-id', `${path}.phase`, '"phase" must be a number');
    });
}

// The params fields a `_populateUnitsFrom` marker may resolve into, mirroring
// game_scenario.lua's POPULATE_INTO. kill's `targetUnitID` is the one SINGULAR
// field; everything else is an array.
const POPULATE_INTO = new Map([
    ['targetUnitID', 'singular'],       // kill
    ['targetUnitIDs', 'plural'],        // protect
    ['payloadUnitIDs', 'plural'],       // extract / escort
    ['buildingUnitIDs', 'plural'],      // infra
]);

/**
 * Population markers (game_scenario.lua's objectives block in `validate`).
 * Mirrored for the loader's reason: a malformed marker either errors inside
 * the frame-30 sweep or resolves into a params field the type module refuses
 * at init — both after the war has already booted clean.
 */
function checkObjectivePopulation(scn, add, opts) {
    const checkArea = (m, path, allowRoute) => {
        if (!m || typeof m !== 'object' || Array.isArray(m)) {
            add('error', 'objective-populate', path, 'must be a table');
            return false;
        }
        if (allowRoute && m.route !== undefined) {
            if (!isStr(m.route))
                add('error', 'objective-populate', path, '"route" must be a string convoy route id');
            return false;   // route form carries no area
        }
        if (!isNum(m.x) || !isNum(m.z) || !isNum(m.r)) {
            add('error', 'objective-populate', path,
                `needs numeric "x", "z" and "r"${allowRoute ? ' (or a string "route")' : ''}`);
            return false;
        }
        return true;
    };
    seq(scn.objectives).forEach((o, i) => {
        const path = `objectives[${i + 1}]`;
        if (!o || typeof o !== 'object') return;
        if (o._populateTargetsFrom !== undefined)
            checkArea(o._populateTargetsFrom, `${path}._populateTargetsFrom`, false);
        if (o._populatePayloadFrom !== undefined)
            checkArea(o._populatePayloadFrom, `${path}._populatePayloadFrom`, true);
        if (o._populateUnitsFrom !== undefined) {
            const m = o._populateUnitsFrom;
            const mpath = `${path}._populateUnitsFrom`;
            if (!checkArea(m, mpath, false)) return;
            const into = m.into === undefined ? 'targetUnitIDs' : m.into;
            if (!POPULATE_INTO.has(into)) {
                add('error', 'objective-populate', `${mpath}.into`,
                    `unknown "into" field "${into}" (expected one of `
                    + `${[...POPULATE_INTO.keys()].sort().join(', ')})`);
            }
            if (m.defs !== undefined) {
                if (!isSeqLike(m.defs) || seq(m.defs).length === 0) {
                    add('error', 'objective-populate', `${mpath}.defs`,
                        '"defs" must be a non-empty array of unit def names');
                } else {
                    seq(m.defs).forEach((d, di) =>
                        checkDef(d, `${mpath}.defs[${di + 1}]`, add, opts.unitDefs));
                }
            }
            if (m.team !== undefined && m.team !== null && !isNum(m.team) && m.team !== 'neutral')
                add('error', 'objective-populate', `${mpath}.team`,
                    `"team" must be a number or "neutral", got "${m.team}"`);
            // kill is the only type defined in terms of ONE runtime id; the
            // mismatch either way authors an objective its type module
            // refuses at init, every time, silently.
            if (o.type === 'kill' && POPULATE_INTO.get(into) !== 'singular')
                add('error', 'objective-populate', `${mpath}.into`,
                    'a kill objective needs `into = "targetUnitID"` (the one singular field)');
            else if (o.type !== 'kill' && POPULATE_INTO.get(into) === 'singular')
                add('error', 'objective-populate', `${mpath}.into`,
                    '`into = "targetUnitID"` is kill-only; every other type reads a plural field');
        }
    });
}

function checkReservedBlocks(scn, add) {
    // game_scenario.lua:1115-1121 — loudly ignored, so say so before the war.
    if (Array.isArray(scn.orders) && scn.orders.length > 0)
        add('warning', 'standing-orders-noop', 'orders',
            `${scn.orders.length} standalone order(s): no standing-order system exists yet and the `
            + 'loader ignores this block entirely. Use per-unit `orders` instead');
    if (scn.ephemeral === true)
        add('info', 'ephemeral', 'ephemeral',
            '`ephemeral = true` marks a scenario as throwaway; authored files normally omit it');
}

// MCP-layer rules with no in-game equivalent.
function checkMcpLayer(scn, add, opts) {
    if (opts.scenarioId && opts.scenarioId.startsWith('gen_'))
        add('warning', 'gen-prefix', 'id',
            `"${opts.scenarioId}" uses the gen_ prefix, which is reserved for DB-owned generated `
            + 'wars: ScenarioDb\'s orphan sweep deletes any gen_*.lua no row claims, so an authored '
            + 'file with this name is deleted on the next resync. write_scenario refuses it');

    const map = tbl(scn.world).map;
    // A scenario with NO world.map used to pass silently with zero findings —
    // no error, no warning, and not even a `skipped` marker for the map-
    // dependent passes that could not run. That is the one thing this tool
    // promises never to do: `skipped` means "not checked", and a clean result
    // has to mean "checked and fine". Deleting one line from the shipped
    // showcase war reproduced it (ok:true, findings:[], skipped:0).
    //
    // It is a WARNING, not an error: ScenarioDiscovery reads a missing map as
    // an empty mapId rather than rejecting the file, so the war still loads —
    // it just has no map affinity and must be launched with an explicit mapId.
    if (map === undefined)
        add('warning', 'world-map', 'world.map',
            'no "world.map" — the lobby stores this war with an EMPTY map affinity, so '
            + 'DefaultForMap never auto-selects it and a direct or headless launch must pass '
            + 'an explicit mapId. Every map-dependent pass (region keys, passability) was '
            + 'SKIPPED, not passed');
    else if (!isStr(map))
        add('error', 'world-map', 'world.map', `"map" must be a string, got ${JSON.stringify(map)}`);
    else if (opts.mapDirExists === false)
        add('warning', 'world-map', 'world.map',
            `no data/maps/${map}/ on this machine — a direct or headless launch of this scenario `
            + 'will fail here, and the region-key and passability passes cannot run');

    if (!opts.unitDefs)
        add('skipped', 'defs-cache-missing', 'units',
            'no baked unit-def cache (data/games/<gameId>/cache/defs/*/unitdefs.lua.br) — every '
            + 'unknown-unitdef check was SKIPPED, not passed. Run a game once to bake it');
    if (!opts.featureDefs)
        add('skipped', 'defs-cache-missing', 'world.features',
            'no baked feature-def cache (featuredefs.lua.br) — every unknown-featuredef check was '
            + 'SKIPPED, not passed. Run a game once to bake it');
    if (!opts.regionKeys && seq(scn.ai).some((a) => a && a.slate))
        add('skipped', 'region-graph-missing', 'ai',
            map === undefined
                ? 'this scenario declares no world.map, so there is no region graph to check '
                  + 'slate region keys against'
                : opts.mapDirExists === false
                ? `no data/maps/${map}/ on this machine, so slate region keys were not checked`
                : 'this map ships no mapdata/regions.lua, so it uses the 2048-elmo GRID provider '
                  + '(where any "col:row" string is a valid key) and slate region keys were not checked');
}

// ---------------------------------------------------------------------------
// Orchestration — resolve a source, load the offline universes, run the rules.
// ---------------------------------------------------------------------------

export function scenarioPath(projectRoot, gameId, scenarioId) {
    return join(projectRoot, 'data', 'games', gameId, 'scenarios', `${scenarioId}.lua`);
}

/**
 * The whole `validate_scenario` pass. Exported (rather than inlined in the MCP
 * handler) so the regression sweep over every shipped scenario is a plain
 * `node --test` case.
 *
 * @param {object} o
 * @param {string} o.projectRoot
 * @param {string} o.gameId
 * @param {string} [o.scenarioId]  read from disk; mutually exclusive with luaSource
 * @param {string} [o.luaSource]   validate source directly (the pre-write check)
 * @param {boolean} [o.passability] also run regions_from_map.py --verify
 */
export async function runScenarioValidation({
    projectRoot, gameId = 'metalstorm', scenarioId, luaSource, passability = false,
}) {
    let source = luaSource;
    let file;
    if (source === undefined) {
        if (!scenarioId) throw new Error('validate_scenario needs either scenarioId or luaSource');
        file = scenarioPath(projectRoot, gameId, scenarioId);
        if (!existsSync(file))
            return {
                ok: false, file,
                findings: [{
                    severity: 'error', rule: 'not-found', path: 'file',
                    message: `no such scenario file: ${file}`,
                }],
                counts: { error: 1, warning: 0, info: 0, skipped: 0 },
            };
        source = readFileSync(file, 'utf8');
    }

    // Parser A's gate. Nothing downstream is reachable if the file does not
    // evaluate to a table, so this finding stands alone.
    const evaluated = evalBareLua(source, scenarioId ? `${scenarioId}.lua` : 'scenario.lua');
    if (!evaluated.ok) {
        const findings = [{
            severity: 'error', rule: 'bare-parse', path: 'file',
            message: `${evaluated.error} — the lobby loads scenarios in a BARE lua_State `
                + '(luaL_openlibs only): no VFS, no Spring.*, no GG at file scope. A file that '
                + 'fails here is silently absent from the Create Game picker',
        }];
        return { ok: false, file, findings, counts: countFindings(findings) };
    }

    const scn = evaluated.table;
    const units = loadDefNames(projectRoot, gameId, 'unitdefs');
    const features = loadDefNames(projectRoot, gameId, 'featuredefs');
    const mapId = tbl(scn.world).map;
    const mapDirExists = isStr(mapId)
        ? existsSync(join(projectRoot, 'data', 'maps', mapId))
        : null;
    const regions = mapDirExists ? loadRegionKeys(projectRoot, mapId) : null;

    const findings = validateScenario(scn, {
        scenarioId,
        unitDefs: units ? units.defs : null,
        featureDefs: features ? features.defs : null,
        regionKeys: regions ? regions.keys : null,
        mapDirExists,
    });

    if (passability)
        findings.push(...await runPassability(projectRoot, mapId, mapDirExists));

    const counts = countFindings(findings);
    return {
        ok: counts.error === 0,
        file,
        scenarioId,
        map: isStr(mapId) ? mapId : null,
        defsSource: {
            unitdefs: units ? { file: units.file, mtime: units.mtime } : null,
            featuredefs: features ? { file: features.file, mtime: features.mtime } : null,
            regions: regions ? regions.file : null,
        },
        findings,
        counts,
    };
}

/**
 * The optional graph-level passability pass (off by default: it shells to
 * python and needs the processed map).
 *
 * `--verify` IS READ-ONLY — it implies `--dry-run` precisely because an
 * earlier version wrote `mapdata/regions.lua` as a side effect and converted
 * grid-provider maps to named graphs (regions_from_map.py:32-40). Nothing else
 * is passed: no `--starts`, no write mode.
 */
async function runPassability(projectRoot, mapId, mapDirExists) {
    if (!isStr(mapId) || !mapDirExists)
        return [{
            severity: 'skipped', rule: 'passability', path: 'world.map',
            message: 'no processed map directory for this scenario\'s map — passability not run',
        }];
    const script = join(projectRoot, 'tools', 'mapgen', 'regions_from_map.py');
    if (!existsSync(script))
        return [{
            severity: 'skipped', rule: 'passability', path: 'world.map',
            message: `${script} not found — passability not run`,
        }];
    try {
        await execFileAsync('python3', [script, join(projectRoot, 'data', 'maps', mapId), '--verify'],
            { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
        return [{
            severity: 'info', rule: 'passability', path: 'world.map',
            message: `regions_from_map.py --verify passed for map "${mapId}"`,
        }];
    } catch (e) {
        const detail = (e.stderr || e.stdout || e.message || '').toString().trim().slice(-4000);
        return [{
            severity: 'error', rule: 'passability', path: 'world.map',
            message: `regions_from_map.py --verify rejected map "${mapId}" (exit ${e.code}): ${detail}`,
        }];
    }
}
