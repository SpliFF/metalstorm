import { describe, it, expect } from 'vitest';
import {
    buildSpringGlobals,
    createDefaultLiveState,
    diffTimers,
    type SpringAPIContext,
    type LiveState,
    type UnitEntry,
    type FeatureEntry,
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
});
