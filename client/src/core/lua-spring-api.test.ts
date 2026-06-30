import { describe, it, expect } from 'vitest';
import {
    buildSpringGlobals,
    createDefaultLiveState,
    diffTimers,
    applyPlayerTeamRosterEffect,
    ensurePlayerEntry,
    seedPlayersFromRoster,
    reconcilePlayerAllyTeams,
    parseMapInfoFields,
    PlayerTeamEventKind,
    type SpringAPIContext,
    type LiveState,
    type UnitEntry,
    type FeatureEntry,
    type PlayerInfo,
    type TeamInfo,
    type TeamStatsHistoryEntry,
} from './lua-spring-api.js';
import { isLuaTable, luaTable, type LuaValue } from './lua-runtime.js';

// Minimal context — the read shims under test only touch mapSize*,
// squareSize and getUnitDefRadius. Everything else is stubbed; cast
// covers the fields no exercised path reads.
function makeCtx(over: Partial<SpringAPIContext> = {}): SpringAPIContext {
    return {
        mapSizeX: 512,
        mapSizeZ: 512,
        squareSize: 8,
        heightmap: new Uint16Array(1),
        heightmapWidth: 1,
        heightmapHeight: 1,
        minHeight: 0,
        maxHeight: 100,
        vfsFiles: new Map(),
        getGameSeconds: () => 0,
        ...over,
    } as unknown as SpringAPIContext;
}

function unit(over: Partial<UnitEntry>): UnitEntry {
    return {
        x: 0, y: 0, z: 0, heading: 0, healthRatio: 1, defId: 1, team: 0,
        buildProgress: 1, vx: 0, vy: 0, vz: 0, stateBits: 0, losState: 0x0f,
        ...over,
    };
}

function feature(over: Partial<FeatureEntry>): FeatureEntry {
    return { x: 0, y: 0, z: 0, defId: 1, team: 0, healthRatio: 1, ...over };
}

// buildSpringGlobals returns the worker's global table; the Spring
// functions live under the `Spring` key.
function springApi(ctx: SpringAPIContext, ls: LiveState): Record<string, LuaValue> {
    return (buildSpringGlobals(ctx, ls) as Record<string, LuaValue>).Spring as Record<string, LuaValue>;
}

function call(fn: LuaValue, ...args: LuaValue[]): LuaValue {
    return (fn as (...a: LuaValue[]) => LuaValue)(...args);
}

function ids(v: LuaValue): number[] {
    if (!isLuaTable(v)) throw new Error('expected a Lua table');
    return v.items.map(Number).sort((a, b) => a - b);
}

describe('BAR read shims', () => {
    describe('GetUnitRadius', () => {
        it('returns the def radius for a known unit', () => {
            const ls = createDefaultLiveState();
            ls.units.set(42, unit({ defId: 7 }));
            const api = springApi(
                makeCtx({ getUnitDefRadius: (d) => (d === 7 ? 31.5 : undefined) }), ls);
            expect(call(api.GetUnitRadius, 42)).toBe(31.5);
        });
        it('returns nil for an unknown unit', () => {
            const ls = createDefaultLiveState();
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetUnitRadius, 99)).toBeNull();
        });
        it('returns nil when the def has not streamed in yet', () => {
            const ls = createDefaultLiveState();
            ls.units.set(1, unit({ defId: 3 }));
            const api = springApi(makeCtx({ getUnitDefRadius: () => undefined }), ls);
            expect(call(api.GetUnitRadius, 1)).toBeNull();
        });
    });

    describe('GetTeamUnitsByDefs', () => {
        it('filters a team by a single def id', () => {
            const ls = createDefaultLiveState();
            ls.units.set(1, unit({ team: 0, defId: 5 }));
            ls.units.set(2, unit({ team: 0, defId: 6 }));
            ls.units.set(3, unit({ team: 1, defId: 5 }));
            const api = springApi(makeCtx(), ls);
            expect(ids(call(api.GetTeamUnitsByDefs, 0, 5))).toEqual([1]);
        });
        it('accepts a Lua table of def ids', () => {
            const ls = createDefaultLiveState();
            ls.units.set(1, unit({ team: 2, defId: 5 }));
            ls.units.set(2, unit({ team: 2, defId: 6 }));
            ls.units.set(3, unit({ team: 2, defId: 7 }));
            const api = springApi(makeCtx(), ls);
            expect(ids(call(api.GetTeamUnitsByDefs, 2, luaTable(5, 7)))).toEqual([1, 3]);
        });
        it('returns empty for a team with no matching units', () => {
            const ls = createDefaultLiveState();
            ls.units.set(1, unit({ team: 0, defId: 5 }));
            const api = springApi(makeCtx(), ls);
            expect(ids(call(api.GetTeamUnitsByDefs, 0, 999))).toEqual([]);
        });
    });

    describe('GetFeaturesInCylinder', () => {
        it('returns features within the radius (2D x/z)', () => {
            const ls = createDefaultLiveState();
            ls.features.set(1, feature({ x: 100, z: 100 }));   // inside
            ls.features.set(2, feature({ x: 130, z: 100 }));   // edge (dist 30)
            ls.features.set(3, feature({ x: 400, z: 400 }));   // outside
            const api = springApi(makeCtx(), ls);
            expect(ids(call(api.GetFeaturesInCylinder, 100, 100, 30))).toEqual([1, 2]);
        });
        it('ignores Y when testing the cylinder', () => {
            const ls = createDefaultLiveState();
            ls.features.set(1, feature({ x: 0, y: 9999, z: 0 }));
            const api = springApi(makeCtx(), ls);
            expect(ids(call(api.GetFeaturesInCylinder, 0, 0, 10))).toEqual([1]);
        });
    });

    describe('GetScreenGeometry / GetNumDisplays', () => {
        it('reports the canvas size at origin', () => {
            const ls = createDefaultLiveState();
            ls.viewport.width = 1920;
            ls.viewport.height = 1080;
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetScreenGeometry)).toEqual([1920, 1080, 0, 0]);
        });
        it('returns 8 values when queryUsable is set', () => {
            const ls = createDefaultLiveState();
            ls.viewport.width = 800;
            ls.viewport.height = 600;
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetScreenGeometry, -1, true))
                .toEqual([800, 600, 0, 0, 800, 600, 0, 0]);
        });
        it('reports a single display', () => {
            const api = springApi(makeCtx(), createDefaultLiveState());
            expect(call(api.GetNumDisplays)).toBe(1);
        });
    });

    describe('GetGroundExtremes', () => {
        it('returns 4 values (initMin, initMax, currMin, currMax)', () => {
            const ls = createDefaultLiveState();
            const api = springApi(makeCtx({ minHeight: -42, maxHeight: 318 }), ls);
            // Recoil returns 4; we mirror init→curr (no live deformed extremes).
            expect(call(api.GetGroundExtremes)).toEqual([-42, 318, -42, 318]);
        });
        it('exposes the curr-min at select-index 3 (BAR gui_top_bar)', () => {
            const ls = createDefaultLiveState();
            const api = springApi(makeCtx({ minHeight: -10, maxHeight: 5 }), ls);
            const ret = call(api.GetGroundExtremes) as number[];
            expect(ret[2]).toBe(-10); // select(3, ...) — Lua 1-based 3rd value
        });
    });

    describe('GetGameState', () => {
        it('reports done-loading, not-saved, paused-flag, not-lagging', () => {
            const ls = createDefaultLiveState();
            ls.gamePaused = true;
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetGameState)).toEqual([true, false, true, false]);
        });
    });

    describe('GetPositionLosState', () => {
        it('returns all-visible for a full-vision spectator (no bitmap → false)', () => {
            // Without a streamed bitmap the sampler returns false; the
            // first return value is inLos||inRadar.
            const ls = createDefaultLiveState();
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetPositionLosState, 10, 0, 10)).toEqual([false, false, false, false]);
        });
        it('samples the LOS bitmap when present', () => {
            const ls = createDefaultLiveState();
            // 8x8 bitmap, all-LOS, empty radar.
            const inLos = new Uint8Array(8); inLos.fill(0xff);
            const inRadar = new Uint8Array(8);
            ls.losBitmaps.set(ls.identity.myAllyTeam, {
                width: 8, height: 8, frame: 0,
                inLos, inRadar, explored: new Uint8Array(8),
            });
            const api = springApi(makeCtx({ mapSizeX: 64, mapSizeZ: 64 }), ls);
            // legacy z is flipped to RH internally; sample a central cell.
            const r = call(api.GetPositionLosState, 32, 0, 32) as boolean[];
            expect(r[1]).toBe(true);   // inLos
            expect(r[0]).toBe(true);   // inLos || inRadar
            expect(r[3]).toBe(false);  // inJammer never streamed
        });
    });

    describe('GetTeamStartPosition', () => {
        it('returns x,y,z,valid for a known team', () => {
            const ls = createDefaultLiveState();
            ls.teamStartPositions.set(0, { x: 1024, y: 80, z: 2048, valid: true, allyTeam: 0 });
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetTeamStartPosition, 0)).toEqual([1024, 80, 2048, true]);
        });
        it('reports an invalid start position via the 4th return', () => {
            const ls = createDefaultLiveState();
            ls.teamStartPositions.set(3, { x: 0, y: 0, z: 0, valid: false, allyTeam: 1 });
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetTeamStartPosition, 3)).toEqual([0, 0, 0, false]);
        });
        it('returns nil for an unknown team', () => {
            const ls = createDefaultLiveState();
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetTeamStartPosition, 5)).toBeNull();
        });
    });

    describe('GetAllyTeamStartBox', () => {
        it('returns xmin,zmin,xmax,zmax for a known ally team', () => {
            const ls = createDefaultLiveState();
            ls.allyStartBoxes.set(1, { xmin: 0, zmin: 0, xmax: 4096, zmax: 4096 });
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetAllyTeamStartBox, 1)).toEqual([0, 0, 4096, 4096]);
        });
        it('returns nil for an unknown ally team', () => {
            const ls = createDefaultLiveState();
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetAllyTeamStartBox, 0)).toBeNull();
        });
    });

    // PLAN-bar.md §7 UI-2 — the worker had no team roster (liveState.teams was
    // never seeded), so GetAllyTeamList()/GetTeamList()/GetTeamInfo() returned
    // empty/nil and gui_ecostats built a nil-aID allyData entry → crash. With
    // teams seeded (from TeamStartInfo, in the game-processor) the team reads
    // resolve and Gaia is derived as the highest team id.
    describe('team roster reads (UI-2 gui_ecostats crash root cause)', () => {
        function seedTeam(over: Partial<TeamInfo>): TeamInfo {
            return { teamId: 0, leader: -1, isDead: false, isAiTeam: false, side: '', allyTeam: 0, incomeMultiplier: 1, customKeys: {}, ...over };
        }
        function seededLs(): LiveState {
            const ls = createDefaultLiveState();
            // 2 players + Gaia (team 2 = last), the BAR/ZK 1v1+AI shape.
            ls.teams.set(0, seedTeam({ teamId: 0, allyTeam: 0 }));
            ls.teams.set(1, seedTeam({ teamId: 1, allyTeam: 1, isAiTeam: true }));
            ls.teams.set(2, seedTeam({ teamId: 2, allyTeam: 2 }));
            return ls;
        }

        it('GetAllyTeamList lists every ally team once (not empty)', () => {
            const api = springApi(makeCtx(), seededLs());
            expect(ids(call(api.GetAllyTeamList))).toEqual([0, 1, 2]);
        });
        it('GetTeamList returns the teams of one ally team', () => {
            const api = springApi(makeCtx(), seededLs());
            expect(ids(call(api.GetTeamList, 1))).toEqual([1]);
        });
        it('GetTeamInfo returns the Recoil tuple order, incomeMultiplier (number) in slot 7', () => {
            const api = springApi(makeCtx(), seededLs());
            // Recoil LuaSyncedRead::GetTeamInfo order:
            // teamNum, leader, isDead, hasAI, side, allyTeam, incomeMultiplier, customTeamKeys.
            expect(call(api.GetTeamInfo, 1)).toEqual([1, -1, false, true, '', 1, 1, {}]);
        });
        it('GetTeamInfo slot 7 is the numeric incomeMultiplier, NOT the customKeys table', () => {
            // Regression for BAR gui_advplayerslist.lua:2987 `pDraw.incomeMultiplier > 1`
            // ("compare number with table"): the customKeys table used to land in slot 7.
            const api = springApi(makeCtx(), seededLs());
            const ret = call(api.GetTeamInfo, 1) as unknown[];
            expect(typeof ret[6]).toBe('number');
            expect(ret[6]).toBe(1);
            expect(ret[7]).toEqual({}); // customTeamKeys, slot 8
        });
        it('GetTeamInfo(team, false) omits customTeamKeys (Recoil 7 + getTeamKeys)', () => {
            // BAR gui_advplayerslist passes getTeamKeys=false → 7 returns,
            // incomeMultiplier last; no trailing customKeys table.
            const api = springApi(makeCtx(), seededLs());
            expect(call(api.GetTeamInfo, 1, false)).toEqual([1, -1, false, true, '', 1, 1]);
        });
        it('GetGaiaTeamID derives the highest team id (Recoil creates Gaia last)', () => {
            const api = springApi(makeCtx(), seededLs());
            expect(call(api.GetGaiaTeamID)).toBe(2);
        });
        it('GetGaiaTeamID is NOT the old hardcoded 1 when Gaia is team 2', () => {
            const api = springApi(makeCtx(), seededLs());
            expect(call(api.GetGaiaTeamID)).not.toBe(1);
        });
        it('GetGaiaTeamID returns -1 before any team roster is seeded', () => {
            const api = springApi(makeCtx(), createDefaultLiveState());
            expect(call(api.GetGaiaTeamID)).toBe(-1);
            // Empty list (the pre-fix state) — the gui_ecostats crash trigger.
            expect(ids(call(api.GetAllyTeamList))).toEqual([]);
        });
    });

    // Faithful to Recoil LuaUnsyncedRead::DiffTimers — verifies the unit
    // conversion matrix for both the millisecond (GetTimer) and microsecond
    // (GetTimerMicros) timer handles BAR's profilers pass.
    describe('DiffTimers', () => {
        it('default: millisecond delta returned as seconds', () => {
            // 1500 ms elapsed → 1.5 s
            expect(diffTimers(2500, 1000, false, false)).toBeCloseTo(1.5, 9);
        });
        it('returnMs: millisecond delta returned as milliseconds', () => {
            expect(diffTimers(2500, 1000, true, false)).toBeCloseTo(1500, 9);
        });
        it('fromMicroSecs: microsecond delta returned as seconds', () => {
            // 1.5e6 µs elapsed → 1.5 s
            expect(diffTimers(2_500_000, 1_000_000, false, true)).toBeCloseTo(1.5, 9);
        });
        it('fromMicroSecs + returnMs: microsecond delta returned as milliseconds', () => {
            expect(diffTimers(2_500_000, 1_000_000, true, true)).toBeCloseTo(1500, 9);
        });
        it('GetTimerMicros handle is 1000x the GetTimer handle', () => {
            const api = springApi(makeCtx(), createDefaultLiveState());
            const ms = Number(call(api.GetTimer));
            const us = Number(call(api.GetTimerMicros));
            // same clock source; micros is ms*1000 (allow for the tiny gap
            // between the two performance.now() reads)
            expect(us).toBeGreaterThanOrEqual(ms * 1000 - 1);
        });
        it('Spring.DiffTimers honours the BAR profiler call shape', () => {
            const api = springApi(makeCtx(), createDefaultLiveState());
            // spDiffTimers(spGetTimer(), startTimer, nil, highres) with micros
            const dt = call(api.DiffTimers, 5_000_000, 4_000_000, null, true);
            expect(Number(dt)).toBeCloseTo(1.0, 9);
        });
    });

    describe('GetUnitBasePosition', () => {
        it('returns the same point as GetUnitPosition', () => {
            const ls = createDefaultLiveState();
            ls.units.set(42, unit({ x: 100, y: 25, z: 300 }));
            const api = springApi(makeCtx(), ls);
            expect(call(api.GetUnitBasePosition, 42)).toEqual(call(api.GetUnitPosition, 42));
            expect(call(api.GetUnitBasePosition, 42)).toEqual([100, 25, 300]);
        });
        it('returns nil for an unknown unit', () => {
            const api = springApi(makeCtx(), createDefaultLiveState());
            expect(call(api.GetUnitBasePosition, 999)).toBeNull();
        });
    });

    describe('GetProjectilesInRectangle', () => {
        function withProjectiles(): LiveState {
            const ls = createDefaultLiveState();
            ls.projectiles.set(1, { defId: 0, x: 50, y: 0, z: 50, vx: 0, vy: 0, vz: 0, ttl: -1, isBeam: false });
            ls.projectiles.set(2, { defId: 0, x: 150, y: 0, z: 150, vx: 0, vy: 0, vz: 0, ttl: -1, isBeam: false });
            ls.projectiles.set(3, { defId: 0, x: 90, y: 0, z: 10, vx: 0, vy: 0, vz: 0, ttl: -1, isBeam: false });
            return ls;
        }
        it('returns only projectiles inside the rectangle', () => {
            const api = springApi(makeCtx(), withProjectiles());
            // rect (0,0)-(100,100) contains ids 1 and 3, excludes 2
            expect(ids(call(api.GetProjectilesInRectangle, 0, 0, 100, 100))).toEqual([1, 3]);
        });
        it('returns empty when weapon projectiles are excluded', () => {
            const api = springApi(makeCtx(), withProjectiles());
            expect(ids(call(api.GetProjectilesInRectangle, 0, 0, 1000, 1000, true))).toEqual([]);
        });
        it('returns empty for a rectangle covering no projectiles', () => {
            const api = springApi(makeCtx(), withProjectiles());
            expect(ids(call(api.GetProjectilesInRectangle, 500, 500, 600, 600))).toEqual([]);
        });
    });
});

describe('applyPlayerTeamRosterEffect', () => {
    function makePlayer(over: Partial<PlayerInfo> = {}): PlayerInfo {
        return {
            name: 'p', active: true, spectator: false, team: 0, allyTeam: 0,
            pingMs: 0, cpuUsage: 0, country: '', rank: 0, hasController: true,
            customKeys: {}, ...over,
        };
    }
    function makeTeam(over: Partial<TeamInfo> = {}): TeamInfo {
        return { teamId: 0, leader: -1, isDead: false, isAiTeam: false, side: '', allyTeam: 0, incomeMultiplier: 1, customKeys: {}, ...over };
    }

    it('PlayerRemoved clears the active flag', () => {
        const players = new Map([[3, makePlayer({ active: true })]]);
        applyPlayerTeamRosterEffect(players, new Map(), { kind: PlayerTeamEventKind.PlayerRemoved, id: 3 });
        expect(players.get(3)!.active).toBe(false);
    });

    it('PlayerAdded sets the active flag', () => {
        const players = new Map([[3, makePlayer({ active: false })]]);
        applyPlayerTeamRosterEffect(players, new Map(), { kind: PlayerTeamEventKind.PlayerAdded, id: 3 });
        expect(players.get(3)!.active).toBe(true);
    });

    it('TeamDied marks the team dead', () => {
        const teams = new Map([[5, makeTeam({ isDead: false })]]);
        applyPlayerTeamRosterEffect(new Map(), teams, { kind: PlayerTeamEventKind.TeamDied, id: 5 });
        expect(teams.get(5)!.isDead).toBe(true);
    });

    it('PlayerChanged is a no-op on the roster (new spec/team not on the wire)', () => {
        const p = makePlayer({ active: true, spectator: false, team: 1 });
        const players = new Map([[3, p]]);
        applyPlayerTeamRosterEffect(players, new Map(), { kind: PlayerTeamEventKind.PlayerChanged, id: 3 });
        expect(players.get(3)).toEqual(p);
    });

    it('tolerates an unknown id (no throw, no mutation)', () => {
        const players = new Map([[3, makePlayer()]]);
        expect(() => applyPlayerTeamRosterEffect(players, new Map(), { kind: PlayerTeamEventKind.PlayerRemoved, id: 99 })).not.toThrow();
        expect(players.get(3)!.active).toBe(true);
    });
});

describe('ensurePlayerEntry', () => {
    it('creates a minimal active placeholder for an unknown id', () => {
        const players = new Map<number, PlayerInfo>();
        const p = ensurePlayerEntry(players, 4);
        expect(players.get(4)).toBe(p);
        expect(p).toMatchObject({ name: 'Player4', active: true, spectator: false, team: 0, allyTeam: 0 });
    });

    it('applies the seed over the defaults (e.g. local player team/allyTeam)', () => {
        const players = new Map<number, PlayerInfo>();
        const p = ensurePlayerEntry(players, 0, { team: 7, allyTeam: 2 });
        expect(p).toMatchObject({ name: 'Player0', team: 7, allyTeam: 2 });
    });

    it('returns the existing entry unchanged (idempotent, no clobber)', () => {
        const existing: PlayerInfo = {
            name: 'test1', active: true, spectator: false, team: 1, allyTeam: 1,
            pingMs: 0, cpuUsage: 0, country: '', rank: 0, hasController: true, customKeys: {},
        };
        const players = new Map<number, PlayerInfo>([[3, existing]]);
        const p = ensurePlayerEntry(players, 3, { team: 9 });
        expect(p).toBe(existing);
        expect(p.name).toBe('test1');
        expect(p.team).toBe(1); // seed must not overwrite a real entry
    });
});

describe('seedPlayersFromRoster', () => {
    it('populates players from the lobby roster so GetPlayerInfo resolves a name', () => {
        const players = new Map<number, PlayerInfo>();
        seedPlayersFromRoster(players, [
            { id: 5, name: 'test1', team: 0, spectator: false },
            { id: 2, name: 'foe', team: 1, spectator: false },
        ]);
        expect(players.get(5)).toMatchObject({ name: 'test1', team: 0, active: true, spectator: false, allyTeam: 0 });
        expect(players.get(2)).toMatchObject({ name: 'foe', team: 1, hasController: true });
        // allyTeam best-effort = team until reconcile
        expect(players.get(2)!.allyTeam).toBe(1);
    });

    it('marks spectators (no controller) and falls back to PlayerN for a blank name', () => {
        const players = new Map<number, PlayerInfo>();
        seedPlayersFromRoster(players, [{ id: 7, name: '', team: 3, spectator: true }]);
        expect(players.get(7)).toMatchObject({ name: 'Player7', spectator: true, hasController: false });
    });

    it('preserves an existing entry\'s allyTeam/customKeys (idempotent re-seed)', () => {
        const players = new Map<number, PlayerInfo>([[5, {
            name: 'old', active: true, spectator: false, team: 0, allyTeam: 4,
            pingMs: 9, cpuUsage: 0, country: 'x', rank: 2, hasController: true, customKeys: { k: 'v' },
        }]]);
        seedPlayersFromRoster(players, [{ id: 5, name: 'test1', team: 0, spectator: false }]);
        const p = players.get(5)!;
        expect(p.name).toBe('test1');      // name refreshed from roster
        expect(p.allyTeam).toBe(4);        // prior allyTeam kept
        expect(p.customKeys).toEqual({ k: 'v' });
    });

    it('makes Spring.GetPlayerInfo return a non-nil name (gui_chat:2647 root cause)', () => {
        const ls = createDefaultLiveState();
        seedPlayersFromRoster(ls.players, [{ id: 5, name: 'test1', team: 0, spectator: false }]);
        const Spring = buildSpringGlobals(makeCtx(), ls).Spring as Record<string, (...a: LuaValue[]) => LuaValue[]>;
        const [name] = Spring.GetPlayerInfo(5, false);
        expect(name).toBe('test1'); // before the fix this was null → "table index is nil"
        const list = Spring.GetPlayerList();
        expect(isLuaTable(list)).toBe(true);
    });
});

describe('reconcilePlayerAllyTeams', () => {
    it('propagates allyTeam from each player\'s team once teams are known', () => {
        const players = new Map<number, PlayerInfo>();
        seedPlayersFromRoster(players, [
            { id: 5, name: 'test1', team: 0, spectator: false },
            { id: 2, name: 'foe', team: 1, spectator: false },
        ]);
        const teams = new Map<number, TeamInfo>([
            [0, { teamId: 0, leader: 5, isDead: false, isAiTeam: false, side: '', allyTeam: 0, incomeMultiplier: 1, customKeys: {} }],
            [1, { teamId: 1, leader: -1, isDead: false, isAiTeam: true, side: '', allyTeam: 1, incomeMultiplier: 1, customKeys: {} }],
        ]);
        reconcilePlayerAllyTeams(players, teams);
        expect(players.get(5)!.allyTeam).toBe(0);
        expect(players.get(2)!.allyTeam).toBe(1);
    });

    it('leaves a player whose team is not yet known untouched', () => {
        const players = new Map<number, PlayerInfo>();
        seedPlayersFromRoster(players, [{ id: 9, name: 'late', team: 4, spectator: false }]);
        reconcilePlayerAllyTeams(players, new Map());
        expect(players.get(9)!.allyTeam).toBe(4); // best-effort copy of team, unchanged
    });
});

describe('SendLuaUIMsg', () => {
    function captureCtx() {
        const sent: Array<{ data: string; mode: number }> = [];
        const ctx = makeCtx({ sendLuaUIMsg: (data, mode) => sent.push({ data, mode }) });
        const api = springApi(ctx, createDefaultLiveState());
        return { sent, api };
    }

    it('defaults to mode 0 (all) when no mode given', () => {
        const { sent, api } = captureCtx();
        call(api.SendLuaUIMsg, 'hello');
        expect(sent).toEqual([{ data: 'hello', mode: 0 }]);
    });

    it("maps 'a'/'allies' to byte 97 and 's'/'specs' to byte 115", () => {
        const { sent, api } = captureCtx();
        call(api.SendLuaUIMsg, 'x', 'a');
        call(api.SendLuaUIMsg, 'y', 'allies');
        call(api.SendLuaUIMsg, 'z', 's');
        call(api.SendLuaUIMsg, 'w', 'specs');
        expect(sent.map((s) => s.mode)).toEqual([97, 97, 115, 115]);
    });

    it('treats an unknown mode as 0 (all), not an error', () => {
        const { sent, api } = captureCtx();
        call(api.SendLuaUIMsg, 'x', 'q');
        expect(sent).toEqual([{ data: 'x', mode: 0 }]);
    });

    it('ignores a nil message', () => {
        const { sent, api } = captureCtx();
        call(api.SendLuaUIMsg, null);
        expect(sent).toEqual([]);
    });
});

describe('SetLogSectionFilterLevel (PLAN-bar.md §7 UI-2)', () => {
    // Recoil engine function widgets call from Initialize() (e.g.
    // map_start_position_suggestions). It must live in the core engine Spring
    // table so it exists BEFORE the LuaUI bootstrap runs widgets' Initialize.
    it('exists on the core Spring table and is a no-op callable', () => {
        const api = springApi(makeCtx(), createDefaultLiveState());
        expect(typeof api.SetLogSectionFilterLevel).toBe('function');
        // Accepts (section, level) and returns nothing without throwing.
        expect(call(api.SetLogSectionFilterLevel, 'SomeWidget', 30)).toBeUndefined();
    });
});

describe('GetUnitWeaponState', () => {
    // A unit with one weapon: def 7 → weapon def 100.
    function wsApi() {
        const ls = createDefaultLiveState();
        ls.units.set(42, unit({ defId: 7 }));
        const ctx = makeCtx({
            getUnitDefWeaponDefIds: (d) => (d === 7 ? [100, 101] : undefined),
            getWeaponDefStats: (w) => (w === 100 ? {
                range: 480, reloadTime: 3.5, projectileSpeed: 9,
                salvoSize: 3, salvoDelay: 0.2, accuracy: 0.05,
                sprayAngle: 0.1, targetMoveError: 0.02, ttl: 1.5,
            } : w === 101 ? {
                range: 120, reloadTime: 1, projectileSpeed: 4,
                salvoSize: 1, salvoDelay: 0, accuracy: 0,
                sprayAngle: 0, targetMoveError: 0, ttl: 0,
            } : undefined),
        });
        return springApi(ctx, ls);
    }

    it('returns faithful static def fields for weapon 1', () => {
        const api = wsApi();
        expect(call(api.GetUnitWeaponState, 42, 1, 'range')).toBe(480);
        expect(call(api.GetUnitWeaponState, 42, 1, 'reloadTime')).toBe(3.5);
        // No XP streamed → reloadTimeXP == reloadTime.
        expect(call(api.GetUnitWeaponState, 42, 1, 'reloadTimeXP')).toBe(3.5);
        expect(call(api.GetUnitWeaponState, 42, 1, 'projectileSpeed')).toBe(9);
        expect(call(api.GetUnitWeaponState, 42, 1, 'burst')).toBe(3);
        expect(call(api.GetUnitWeaponState, 42, 1, 'burstRate')).toBe(0.2);
        expect(call(api.GetUnitWeaponState, 42, 1, 'ttl')).toBe(1.5);
    });

    it('indexes weapons 1-based (weapon 2 → second def)', () => {
        const api = wsApi();
        expect(call(api.GetUnitWeaponState, 42, 2, 'range')).toBe(120);
    });

    it('returns weapon-ready FIDELITY-STANDIN for dynamic reload state', () => {
        const api = wsApi();
        expect(call(api.GetUnitWeaponState, 42, 1, 'reloadFrame')).toBe(0);
        expect(call(api.GetUnitWeaponState, 42, 1, 'reloadState')).toBe(0);
        expect(call(api.GetUnitWeaponState, 42, 1, 'salvoLeft')).toBe(0);
    });

    it('salvoError returns a zero {x,y,z} table', () => {
        const api = wsApi();
        const v = call(api.GetUnitWeaponState, 42, 1, 'salvoError');
        expect(isLuaTable(v)).toBe(true);
        expect((v as { items: number[] }).items).toEqual([0, 0, 0]);
    });

    it('no-key form returns 5 values (angleGood, reloaded, frame, salvoLeft, stockpile)', () => {
        const api = wsApi();
        expect(call(api.GetUnitWeaponState, 42, 1)).toEqual([true, true, 0, 0, 0]);
    });

    it('returns nil for an unknown unit, out-of-range weapon, or unknown key', () => {
        const api = wsApi();
        expect(call(api.GetUnitWeaponState, 99, 1, 'range')).toBeNull();
        expect(call(api.GetUnitWeaponState, 42, 9, 'range')).toBeNull();
        expect(call(api.GetUnitWeaponState, 42, 1, 'bogusKey')).toBeNull();
    });
});

describe('GetSelectionBox', () => {
    it('returns [left, top, right, bottom] when a box is active', () => {
        const ls = createDefaultLiveState();
        const api = springApi(
            makeCtx({ getSelectionBox: () => [10, 200, 110, 50] }), ls);
        expect(call(api.GetSelectionBox)).toEqual([10, 200, 110, 50]);
    });
    it('returns nil when no box is being drawn', () => {
        const ls = createDefaultLiveState();
        const api = springApi(makeCtx({ getSelectionBox: () => null }), ls);
        expect(call(api.GetSelectionBox)).toBeNull();
    });
    it('returns nil when the host provides no selection-box accessor', () => {
        const ls = createDefaultLiveState();
        const api = springApi(makeCtx(), ls);
        expect(call(api.GetSelectionBox)).toBeNull();
    });
});

describe('GetTeamStatsHistory', () => {
    function statsEntry(over: Partial<TeamStatsHistoryEntry> = {}): TeamStatsHistoryEntry {
        return {
            frame: 0,
            metalUsed: 0, energyUsed: 0, metalProduced: 0, energyProduced: 0,
            metalExcess: 0, energyExcess: 0, metalReceived: 0, energyReceived: 0,
            metalSent: 0, energySent: 0, damageDealt: 0, damageReceived: 0,
            unitsProduced: 0, unitsDied: 0, unitsReceived: 0, unitsSent: 0,
            unitsCaptured: 0, unitsOutCaptured: 0, unitsKilled: 0,
            ...over,
        };
    }
    function teamInfo(over: Partial<TeamInfo>): TeamInfo {
        return {
            teamId: 0, leader: -1, isDead: false, isAiTeam: false,
            side: '', allyTeam: 0, customKeys: {}, ...over,
        };
    }
    function player(over: Partial<PlayerInfo>): PlayerInfo {
        return {
            name: '', active: true, spectator: false, team: 0, allyTeam: 0,
            pingMs: 0, cpuUsage: 0, country: '', rank: 0, hasController: true,
            customKeys: {}, ...over,
        };
    }
    // An allied (own-team) viewer so the alliance gate passes.
    function alliedLs(): LiveState {
        const ls = createDefaultLiveState();
        ls.identity = { myTeam: 0, myAllyTeam: 0, myPlayerId: 0 };
        ls.players.set(0, player({ team: 0, allyTeam: 0 }));
        ls.teams.set(0, teamInfo({ teamId: 0, allyTeam: 0 }));
        ls.teams.set(1, teamInfo({ teamId: 1, allyTeam: 1 }));
        return ls;
    }

    it('returns the entry count in the 1-arg form', () => {
        const ls = alliedLs();
        ls.teamStatsHistory.set(0, [statsEntry(), statsEntry(), statsEntry()]);
        const api = springApi(makeCtx(), ls);
        expect(call(api.GetTeamStatsHistory, 0)).toBe(3);
    });

    it('returns nil for an unknown team', () => {
        const api = springApi(makeCtx(), alliedLs());
        expect(call(api.GetTeamStatsHistory, 9)).toBeNull();
    });

    it('returns a 1-indexed slice of stats tables', () => {
        const ls = alliedLs();
        ls.gameFrame = 900;
        ls.teamStatsHistory.set(0, [
            statsEntry({ frame: 450, metalProduced: 10 }),
            statsEntry({ frame: 1350, metalProduced: 25 }),  // live tail (future frame)
        ]);
        const api = springApi(makeCtx(), ls);
        const res = call(api.GetTeamStatsHistory, 0, 1, 2);
        if (!isLuaTable(res)) throw new Error('expected table');
        const items = res.items as Array<Record<string, number>>;
        expect(items).toHaveLength(2);
        // finalised entry keeps its own frame/time
        expect(items[0].frame).toBe(450);
        expect(items[0].time).toBe(15);
        expect(items[0].metalProduced).toBe(10);
        // live tail reports the *current* frame, not its future finalisation frame
        expect(items[1].frame).toBe(900);
        expect(items[1].time).toBe(30);
        expect(items[1].metalProduced).toBe(25);
    });

    it('hides a non-allied team until the game is over', () => {
        const ls = alliedLs();
        ls.teamStatsHistory.set(1, [statsEntry()]);   // enemy ally team
        let api = springApi(makeCtx(), ls);
        expect(call(api.GetTeamStatsHistory, 1)).toBeNull();
        ls.gameOver = true;
        api = springApi(makeCtx(), ls);
        expect(call(api.GetTeamStatsHistory, 1)).toBe(1);
    });

    it('lets a full-view spectator read any team', () => {
        const ls = alliedLs();
        ls.players.set(0, player({ spectator: true }));
        ls.teamStatsHistory.set(1, [statsEntry(), statsEntry()]);
        const api = springApi(makeCtx(), ls);
        expect(call(api.GetTeamStatsHistory, 1)).toBe(2);
    });

    it('resolves alliance from teamStartPositions when the team roster is empty', () => {
        // Mirrors the live worker: ls.teams is unpopulated, but the
        // TeamStartInfo stream supplies each team's allyTeam.
        const ls = createDefaultLiveState();
        ls.identity = { myTeam: 0, myAllyTeam: 0, myPlayerId: 0 };
        ls.players.set(0, player({ team: 0, allyTeam: 0 }));
        ls.teamStartPositions.set(0, { x: 0, y: 0, z: 0, valid: true, allyTeam: 0 });
        ls.teamStartPositions.set(1, { x: 0, y: 0, z: 0, valid: true, allyTeam: 1 });
        ls.teamStatsHistory.set(0, [statsEntry(), statsEntry()]);
        ls.teamStatsHistory.set(1, [statsEntry()]);
        const api = springApi(makeCtx(), ls);
        expect(call(api.GetTeamStatsHistory, 0)).toBe(2);   // own ally → readable
        expect(call(api.GetTeamStatsHistory, 1)).toBeNull(); // enemy ally → gated
    });
});

describe('GetModOptions (PLAN-bar.md §5 5c)', () => {
    it('returns the empty default before any GameModOptions arrives', () => {
        const ls = createDefaultLiveState();
        const api = springApi(makeCtx(), ls);
        expect(call(api.GetModOptions)).toEqual({});
    });

    it('reflects liveState.modOptions and returns a copy (not the backing store)', () => {
        const ls = createDefaultLiveState();
        // onGameModOptions stores the decoded map verbatim (strings).
        ls.modOptions = { ffa: '1', startmetal: '1000', map_waterlevel: '0' };
        const api = springApi(makeCtx(), ls);
        const out = call(api.GetModOptions) as Record<string, unknown>;
        expect(out).toEqual({ ffa: '1', startmetal: '1000', map_waterlevel: '0' });
        // Values stay strings — faithful to Recoil's PushAllOptions; callers
        // tonumber() them. A mutation of the result must not leak back.
        expect(typeof out.startmetal).toBe('string');
        out.ffa = '0';
        expect((call(api.GetModOptions) as Record<string, unknown>).ffa).toBe('1');
    });
});

// Round-trips the GameModOptions FlatBuffer through the exact decode loop
// connection.ts runs (build → getRootAs → optionsLength/options/key/value),
// guarding the §5 5c wire end-to-end at the binding layer.
describe('GameModOptions wire decode', () => {
    it('builds and decodes a key→value map', async () => {
        const flatbuffers = await import('flatbuffers');
        const { GameModOptions } = await import('../protocol/spring-web/game-mod-options.js');
        const { ModOption } = await import('../protocol/spring-web/mod-option.js');

        const pairs: Array<[string, string]> = [['ffa', '1'], ['startmetal', '1000']];
        const b = new flatbuffers.Builder(256);
        const offs = pairs.map(([k, v]) =>
            ModOption.createModOption(b, b.createString(k), b.createString(v)));
        const vec = GameModOptions.createOptionsVector(b, offs);
        GameModOptions.startGameModOptions(b);
        GameModOptions.addOptions(b, vec);
        b.finish(GameModOptions.endGameModOptions(b));

        const mo = GameModOptions.getRootAsGameModOptions(
            new flatbuffers.ByteBuffer(b.asUint8Array()));
        const options: Record<string, string> = {};
        for (let i = 0; i < mo.optionsLength(); i++) {
            const o = mo.options(i);
            if (!o) continue;
            const key = o.key();
            if (key) options[key] = o.value() ?? '';
        }
        expect(options).toEqual({ ffa: '1', startmetal: '1000' });
    });
});

describe('Game table map fields (PLAN-bar.md A12 residual)', () => {
    const MAPINFO = `
        local mapinfo = {
            name = "Wanderlust",
            shortname = "Wanderlust 2",
            description = "Wanderlust. 1v1 to 3v3.",
            maphardness = 200,
            gravity = 100,
            tidalStrength = 20,
            extractorRadius = 80.0,
            atmosphere = { minWind = 5, maxWind = 19 },
            water = { damage = 100.0 },
        }
        return mapinfo
    `;

    describe('parseMapInfoFields', () => {
        it('extracts physics + identity fields faithfully', () => {
            const fields = parseMapInfoFields(MAPINFO, makeCtx());
            expect(fields).not.toBeNull();
            expect(fields).toMatchObject({
                mapName: 'Wanderlust',
                mapHumanName: 'Wanderlust',
                mapDescription: 'Wanderlust. 1v1 to 3v3.',
                mapHardness: 200,
                gravity: 100,         // raw mapinfo value (not 100*900)
                tidal: 20,
                extractorRadius: 80,
                waterDamage: 100,
                windMin: 5,
                windMax: 19,
            });
        });

        it('falls back to Recoil defaults for an empty mapinfo', () => {
            const fields = parseMapInfoFields('local mapinfo = {}\nreturn mapinfo', makeCtx());
            expect(fields).toMatchObject({
                mapName: '', mapDescription: '',
                mapHardness: 100, gravity: 130, tidal: 0,
                extractorRadius: 500, waterDamage: 0,
                windMin: 5, windMax: 25,
            });
        });

        it('returns null when the chunk fails to yield a table', () => {
            expect(parseMapInfoFields('this is not lua ===', makeCtx())).toBeNull();
        });

        // Regression: real mapinfo.lua (e.g. Wanderlust) ends with an
        // unguarded map-options merge block that calls getfenv() and
        // `table.sort(VFS.DirList(...))`. Before the fix, includeLuaFile's
        // sub-runtime had no getfenv (→ nil-call) and VFS.DirList returned a
        // JS `[]` that marshalled to zero values → nil → table.sort errored,
        // so the whole parse failed and every Game.* map field defaulted
        // silently. The earlier clean-MAPINFO test missed this entirely.
        it('parses past the unguarded getfenv + VFS.DirList/sort merge tail', () => {
            const withTail = `
                local function lowerkeys(t) return t end
                local function tmerge(a, b) end
                local mapinfo = {
                    name = "Wanderlust",
                    maphardness = 200,
                    gravity = 100,
                }
                do
                    getfenv()["mapinfo"] = mapinfo
                    local files = VFS.DirList("mapconfig/mapinfo/", "*.lua")
                    table.sort(files)
                    for i = 1, #files do
                        local newcfg = VFS.Include(files[i])
                        if newcfg then lowerkeys(newcfg); tmerge(mapinfo, newcfg) end
                    end
                    getfenv()["mapinfo"] = nil
                end
                return mapinfo
            `;
            const fields = parseMapInfoFields(withTail, makeCtx());
            expect(fields).not.toBeNull();
            expect(fields).toMatchObject({
                mapName: 'Wanderlust',
                mapHardness: 200,
                gravity: 100,
            });
        });
    });

    describe('Game table population', () => {
        function gameTable(ctx: SpringAPIContext): Record<string, LuaValue> {
            const ls = createDefaultLiveState();
            return (buildSpringGlobals(ctx, ls) as Record<string, LuaValue>)
                .Game as Record<string, LuaValue>;
        }

        it('sources map fields from ctx when present', () => {
            const g = gameTable(makeCtx({
                mapName: 'Wanderlust', mapHumanName: 'Wanderlust',
                mapDescription: 'desc', mapHardness: 200, gravity: 100,
                tidal: 20, extractorRadius: 80, waterDamage: 100,
                windMin: 5, windMax: 19,
            }));
            expect(g.mapName).toBe('Wanderlust');
            expect(g.mapDescription).toBe('desc');
            expect(g.mapHardness).toBe(200);
            expect(g.gravity).toBe(100);
            expect(g.tidal).toBe(20);
            expect(g.extractorRadius).toBe(80);
            expect(g.waterDamage).toBe(100);
            expect(g.windMin).toBe(5);
            expect(g.windMax).toBe(19);
        });

        it('uses Recoil defaults when ctx map fields are absent', () => {
            const g = gameTable(makeCtx());
            expect(g.mapHardness).toBe(100);
            expect(g.gravity).toBe(130);
            expect(g.tidal).toBe(0);
            expect(g.windMin).toBe(5);
            expect(g.windMax).toBe(25);
            expect(g.extractorRadius).toBe(500);
        });
    });

    // Game.maxUnits is NOT a gameplay cap — it's the unit/feature ID-space
    // boundary BAR widgets use to pack feature IDs into order params
    // (`featureID + Game.maxUnits`), decoded server-side as
    // `objID - unitHandler.MaxUnits()`. The client value MUST equal the
    // server's streamed `GameInfo.max_units`. See PLAN-bar.md.
    describe('Game.maxUnits (unit/feature ID-space boundary)', () => {
        function gameWith(maxUnits: number): Record<string, LuaValue> {
            const ls = createDefaultLiveState();
            ls.maxUnits = maxUnits;
            return (buildSpringGlobals(makeCtx(), ls) as Record<string, LuaValue>)
                .Game as Record<string, LuaValue>;
        }
        it('uses the streamed server value (unitHandler.MaxUnits()) when present', () => {
            expect(gameWith(16000).maxUnits).toBe(16000);
        });
        it('falls back to MAX_UNITS=32000 before GameInfo arrives (ls.maxUnits=0)', () => {
            expect(gameWith(0).maxUnits).toBe(32000);
        });
    });
});
