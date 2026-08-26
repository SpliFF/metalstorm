import { describe, it, expect } from 'vitest';
import { LuaRuntime, type LuaValue } from './lua-runtime.js';
import {
    buildSpringGlobals,
    createDefaultLiveState,
    type SpringAPIContext,
    type LiveState,
    type UnitEntry,
    type UnitOrder,
    type StandingOrderEntry,
} from './lua-spring-api.js';

/**
 * Marshalling audit tests (bare-array return-value bug class).
 *
 * A JS function bound into Lua that returns a plain JS array is spread into
 * N Lua RETURN VALUES by the runtime marshaller (lua-runtime.ts pushValue);
 * only luaTable(...) produces the single-table encoding Lua callers expect.
 * An unwrapped EMPTY array marshals as ZERO return values, which a caller
 * capturing one value sees as nil — `ipairs(nil)` then throws.
 *
 * These tests therefore call the bindings THROUGH a real fengari runtime and
 * assert `type(t) == 'table'`, `#t`, and ipairs iteration counts — including
 * the empty case — rather than poking the JS functions directly (a direct
 * call cannot see the multi-return spread).
 */

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

function unit(over: Partial<UnitEntry> = {}): UnitEntry {
    return {
        x: 0, y: 0, z: 0, heading: 0, healthRatio: 1, defId: 1, team: 0,
        buildProgress: 1, vx: 0, vy: 0, vz: 0, stateBits: 0, losState: 0x0f,
        ...over,
    };
}

function order(over: Partial<UnitOrder> = {}): UnitOrder {
    return { cmdId: 10, params: [100, 0, 200], options: 0, tag: 1, timeout: 0, ...over };
}

function standingOrder(over: Partial<StandingOrderEntry> = {}): StandingOrderEntry {
    return {
        orderId: 1,
        ownerTeam: 0,
        type: 'patrol',
        priority: 5,
        params: [1, 2, 3],
        conditions: {
            idleOnly: false,
            squadTypes: [],
            withinCenter: [0, 0, 0],
            withinRadius: 0,
            outsideCenter: [0, 0, 0],
            outsideRadius: 0,
            minStrength: 0,
            hasCapabilities: [],
        },
        assignedSquadCount: 0,
        active: true,
        createdAtFrame: 0,
        expiresAtFrame: 0,
        ...over,
    };
}

/** Build a real fengari runtime with the Spring globals installed. */
function makeRuntime(ctx: SpringAPIContext, ls: LiveState): LuaRuntime {
    const rt = new LuaRuntime('marshalling-test');
    const globals = buildSpringGlobals(ctx, ls);
    for (const [k, v] of Object.entries(globals)) rt.setGlobal(k, v as LuaValue);
    return rt;
}

/** Run a Lua chunk and return its single return value; fails the test on a
 *  Lua load/runtime error instead of silently returning null. */
function evalLua(rt: LuaRuntime, source: string): LuaValue {
    const { value, error } = rt.evalStringEx(source, 'test-chunk');
    expect(error).toBeNull();
    return value;
}

describe('command-queue getters return ONE Lua sequence table', () => {
    for (const fn of ['GetUnitCommands', 'GetFactoryCommands', 'GetCommandQueue'] as const) {
        describe(`Spring.${fn}`, () => {
            it('empty queue → a table (not nil), #q == 0, ipairs runs 0 times', () => {
                const ls = createDefaultLiveState();
                ls.units.set(1, unit());
                ls.unitCommands.set(1, []);
                const rt = makeRuntime(makeCtx(), ls);
                try {
                    const res = evalLua(rt, `
                        local q = Spring.${fn}(1, -1)
                        if type(q) ~= 'table' then return 'not-a-table:' .. type(q) end
                        local n = 0
                        for _ in ipairs(q) do n = n + 1 end
                        return #q .. '/' .. n
                    `);
                    expect(res).toBe('0/0');
                } finally { rt.dispose(); }
            });

            it('unknown unit (no queue entry) still yields an iterable table', () => {
                const ls = createDefaultLiveState();
                const rt = makeRuntime(makeCtx(), ls);
                try {
                    const res = evalLua(rt, `
                        local q = Spring.${fn}(999, -1)
                        if type(q) ~= 'table' then return 'not-a-table:' .. type(q) end
                        local n = 0
                        for _ in ipairs(q) do n = n + 1 end
                        return #q .. '/' .. n
                    `);
                    expect(res).toBe('0/0');
                } finally { rt.dispose(); }
            });

            it('full queue via count=-1: one table holding ALL orders, in order', () => {
                const ls = createDefaultLiveState();
                ls.units.set(1, unit());
                ls.unitCommands.set(1, [
                    order({ cmdId: 10, tag: 1, params: [100, 0, 200] }),
                    order({ cmdId: 20, tag: 2, params: [5] }),
                    order({ cmdId: 16, tag: 3 }),
                ]);
                const rt = makeRuntime(makeCtx(), ls);
                try {
                    const res = evalLua(rt, `
                        local q = Spring.${fn}(1, -1)
                        if type(q) ~= 'table' then return 'not-a-table:' .. type(q) end
                        local n = 0
                        local idSum = 0
                        for i, cmd in ipairs(q) do
                            n = n + 1
                            idSum = idSum + cmd.id
                        end
                        -- first entry keeps its keyed fields + params sequence
                        -- (%d formatting: JS numbers arrive as Lua 5.3 floats)
                        return string.format('%d/%d/%d/%d/%d/%d/%d',
                            #q, n, idSum, q[1].id, q[1].tag, #q[1].params, q[1].params[3])
                    `);
                    expect(res).toBe('3/3/46/10/1/3/200');
                } finally { rt.dispose(); }
            });

            it('positive count caps the returned entries', () => {
                const ls = createDefaultLiveState();
                ls.units.set(1, unit());
                ls.unitCommands.set(1, [
                    order({ cmdId: 10 }), order({ cmdId: 20 }), order({ cmdId: 30 }),
                ]);
                const rt = makeRuntime(makeCtx(), ls);
                try {
                    const res = evalLua(rt, `
                        local q = Spring.${fn}(1, 2)
                        local n = 0
                        for _ in ipairs(q) do n = n + 1 end
                        return string.format('%d/%d/%d', #q, n, q[2].id)
                    `);
                    expect(res).toBe('2/2/20');
                } finally { rt.dispose(); }
            });

            it('count=0 returns the queue size as a NUMBER (Recoil semantics)', () => {
                const ls = createDefaultLiveState();
                ls.units.set(1, unit());
                ls.unitCommands.set(1, [order(), order()]);
                const rt = makeRuntime(makeCtx(), ls);
                try {
                    const res = evalLua(rt, `
                        local n = Spring.${fn}(1, 0)
                        return type(n) .. '/' .. string.format('%d', n)
                    `);
                    expect(res).toBe('number/2');
                } finally { rt.dispose(); }
            });
        });
    }
});

describe('Spring.GetStandingOrders returns ONE Lua sequence table', () => {
    it('empty store → a table, #t == 0, ipairs runs 0 times', () => {
        const ls = createDefaultLiveState();
        const rt = makeRuntime(makeCtx(), ls);
        try {
            const res = evalLua(rt, `
                local t = Spring.GetStandingOrders()
                if type(t) ~= 'table' then return 'not-a-table:' .. type(t) end
                local n = 0
                for _ in ipairs(t) do n = n + 1 end
                return #t .. '/' .. n
            `);
            expect(res).toBe('0/0');
        } finally { rt.dispose(); }
    });

    it('multiple orders → one table, ipairs visits all, priority-desc order', () => {
        const ls = createDefaultLiveState();
        ls.standingOrders.set(1, standingOrder({ orderId: 1, priority: 2 }));
        ls.standingOrders.set(2, standingOrder({ orderId: 2, priority: 9 }));
        ls.standingOrders.set(3, standingOrder({ orderId: 3, priority: 5 }));
        const rt = makeRuntime(makeCtx(), ls);
        try {
            const res = evalLua(rt, `
                local t = Spring.GetStandingOrders()
                if type(t) ~= 'table' then return 'not-a-table:' .. type(t) end
                local ids = {}
                for i, o in ipairs(t) do ids[#ids + 1] = string.format('%d', o.id) end
                return #t .. ':' .. table.concat(ids, ',')
                    .. ':' .. t[1].type .. ':' .. tostring(t[1].conditions.idleOnly)
            `);
            expect(res).toBe('3:2,3,1:patrol:false');
        } finally { rt.dispose(); }
    });

    it('teamId filter still yields a single (possibly empty) table', () => {
        const ls = createDefaultLiveState();
        ls.standingOrders.set(1, standingOrder({ orderId: 1, ownerTeam: 0 }));
        ls.standingOrders.set(2, standingOrder({ orderId: 2, ownerTeam: 3 }));
        const rt = makeRuntime(makeCtx(), ls);
        try {
            const res = evalLua(rt, `
                local mine = Spring.GetStandingOrders(3)
                local none = Spring.GetStandingOrders(7)
                return string.format('%d/%d/%s/%d', #mine, mine[1].id, type(none), #none)
            `);
            expect(res).toBe('1/2/table/0');
        } finally { rt.dispose(); }
    });
});

describe('Spring.GetUnitIsTransporting returns a FLAT sequence of cargo ids', () => {
    it('cargo present → {a, b}, not {{a, b}}', () => {
        const ls = createDefaultLiveState();
        ls.units.set(1, unit());
        ls.transportCargo.set(1, [40, 41]);
        const rt = makeRuntime(makeCtx(), ls);
        try {
            const res = evalLua(rt, `
                local t = Spring.GetUnitIsTransporting(1)
                if type(t) ~= 'table' then return 'not-a-table:' .. type(t) end
                local n = 0
                for _, id in ipairs(t) do
                    if type(id) ~= 'number' then return 'nested:' .. type(id) end
                    n = n + 1
                end
                return string.format('%d/%d/%d/%d', #t, n, t[1], t[2])
            `);
            expect(res).toBe('2/2/40/41');
        } finally { rt.dispose(); }
    });

    it('known unit with no cargo → empty table, ipairs runs 0 times', () => {
        const ls = createDefaultLiveState();
        ls.units.set(1, unit());
        const rt = makeRuntime(makeCtx(), ls);
        try {
            const res = evalLua(rt, `
                local t = Spring.GetUnitIsTransporting(1)
                if type(t) ~= 'table' then return 'not-a-table:' .. type(t) end
                local n = 0
                for _ in ipairs(t) do n = n + 1 end
                return #t .. '/' .. n
            `);
            expect(res).toBe('0/0');
        } finally { rt.dispose(); }
    });

    it('unknown unit → nil (Spring contract)', () => {
        const ls = createDefaultLiveState();
        const rt = makeRuntime(makeCtx(), ls);
        try {
            const res = evalLua(rt, `
                return tostring(Spring.GetUnitIsTransporting(999))
            `);
            expect(res).toBe('nil');
        } finally { rt.dispose(); }
    });
});

describe('VFS.Include returns ONE value even for sequence-table chunks', () => {
    it('chunk returning a sequence table → single table with # and ipairs intact', () => {
        const ls = createDefaultLiveState();
        const vfsFiles = new Map<string, string>([
            ['cfg/list.lua', 'local list = {11, 22, 33}\nreturn list'],
        ]);
        const rt = makeRuntime(makeCtx({ vfsFiles }), ls);
        try {
            const res = evalLua(rt, `
                local t = VFS.Include('cfg/list.lua')
                if type(t) ~= 'table' then return 'not-a-table:' .. type(t) end
                local n = 0
                for _ in ipairs(t) do n = n + 1 end
                return string.format('%d/%d/%d/%d', #t, n, t[1], t[3])
            `);
            expect(res).toBe('3/3/11/33');
        } finally { rt.dispose(); }
    });
});

describe('regression guard: table-returning list getters through the runtime', () => {
    it('GetSelectedUnits / GetVisibleUnits stay single tables (empty case)', () => {
        const ls = createDefaultLiveState();
        const rt = makeRuntime(makeCtx(), ls);
        try {
            const res = evalLua(rt, `
                local sel = Spring.GetSelectedUnits()
                local vis = Spring.GetVisibleUnits()
                return type(sel) .. #sel .. '/' .. type(vis) .. #vis
            `);
            expect(res).toBe('table0/table0');
        } finally { rt.dispose(); }
    });

    it('genuine multi-return APIs stay multi-return (GetUnitHealth 5-tuple)', () => {
        const ls = createDefaultLiveState();
        ls.units.set(1, unit({ healthRatio: 0.5, buildProgress: 1 }));
        const rt = makeRuntime(makeCtx(), ls);
        try {
            const res = evalLua(rt, `
                local r = { Spring.GetUnitHealth(1) }
                return #r
            `);
            // health, maxHealth, paralyze, capture, buildProgress
            expect(res).toBe(5);
        } finally { rt.dispose(); }
    });
});
