import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RUNGS, trancheRungs, trancheGridCalls, trancheUnitCount, buildTrancheLua, CENTER,
} from './tranche.js';
import { VerbArgError } from './verb-args.js';
import { runLua } from './lua-fake-env.js';

/** A minimal fake `Spring` — just enough of the engine surface `grid()` calls
 *  for the generated Lua to actually run under fengari, not just parse. */
const FAKE_SPRING_SPAWN = String.raw`
local nextId = 1
Spring = {
  GetGroundHeight = function(x, z) return 0 end,
  CreateUnit = function(def, x, y, z, facing, team) local id = nextId; nextId = nextId + 1; return id end,
  SetUnitArmored = function(u, on, mult) end,
}
`;

test('unknown rung is refused by name', () => {
    assert.throws(() => trancheRungs('XXL'), /unknown rung "XXL"/);
    assert.throws(() => trancheUnitCount('XXL'), /unknown rung "XXL"/);
});

test('trancheRungs is cumulative and ordered', () => {
    assert.deepEqual(trancheRungs('S'), ['S']);
    assert.deepEqual(trancheRungs('L'), ['S', 'M', 'L']);
    assert.deepEqual(trancheRungs('XL1200'), RUNGS);
});

test('each rung\'s grid calls sum to PLAN-perf.md\'s recorded running total', () => {
    for (const rung of RUNGS) {
        const calls = trancheGridCalls(rung);
        const total = calls.reduce((sum, c) => sum + c.n, 0);
        assert.equal(total, trancheUnitCount(rung), `${rung} grid calls sum to ${total}, expected ${trancheUnitCount(rung)}`);
    }
});

test('XL900 is 450 per side, north and south mirrored', () => {
    const calls = trancheGridCalls('XL900');
    const north = calls.filter((c) => c.side === 'north').reduce((s, c) => s + c.n, 0);
    const south = calls.filter((c) => c.side === 'south').reduce((s, c) => s + c.n, 0);
    assert.equal(north, 450);
    assert.equal(south, 450);
});

test('buildTrancheLua embeds the requested rung\'s grid() calls and the JSON return', () => {
    const lua = buildTrancheLua('S', { teamNorth: 0, teamSouth: 4 });
    assert.match(lua, /local function grid\(def, cx, cz, n, team, perRow\)/);
    assert.match(lua, /grid\('ms_soldiers_s1', 8192, 7500, 20, 0, 5\)/);
    assert.match(lua, /grid\('ms_tanks_s2', 8192, 9100, 10, 4, 5\)/);
    assert.match(lua, /return J\(\{teamNorth = 0, teamSouth = 4,/);
});

test('buildTrancheLua defaults centre to the meridian_basin ford', () => {
    const lua = buildTrancheLua('S');
    assert.match(lua, new RegExp(`${CENTER.x}, 7500`));
});

test('buildTrancheLua omits SetUnitArmored when armored:false', () => {
    const lua = buildTrancheLua('S', { armored: false });
    assert.doesNotMatch(lua, /SetUnitArmored/);
});

test('buildTrancheLua adds the GameOver suppression only when asked', () => {
    assert.doesNotMatch(buildTrancheLua('S'), /Spring\.GameOver = function/);
    assert.match(buildTrancheLua('S', { suppressGameOver: true }), /Spring\.GameOver = function/);
});

test('a def name that is not a bare Lua token is refused before it reaches the script', () => {
    assert.throws(() => buildTrancheLua('S', { soldierDef: 'ms soldiers; os.exit()' }), VerbArgError);
});

test('every rung produces syntactically balanced Lua (paren/brace counts match)', () => {
    for (const rung of RUNGS) {
        const lua = buildTrancheLua(rung);
        const opens = (lua.match(/\(/g) || []).length;
        const closes = (lua.match(/\)/g) || []).length;
        assert.equal(opens, closes, `${rung}: unbalanced parens`);
    }
});

test('every rung actually RUNS under fengari against a fake Spring and reports the right counts', () => {
    for (const rung of RUNGS) {
        const lua = buildTrancheLua(rung);
        const r = runLua(FAKE_SPRING_SPAWN + '\n' + lua);
        assert.ok(r.ok, `${rung}: ${r.error}`);
        const parsed = JSON.parse(r.value);
        assert.equal(parsed.teamNorth, 0);
        assert.equal(parsed.teamSouth, 4);
        assert.equal(parsed.teamNorthCount + parsed.teamSouthCount, trancheUnitCount(rung));
        assert.equal(parsed.teamNorthCount, parsed.teamSouthCount, `${rung}: sides should mirror`);
    }
});

test('custom teams and centre flow through to the running script', () => {
    const lua = buildTrancheLua('S', { teamNorth: 1, teamSouth: 2, center: { x: 0, z: 0 } });
    const r = runLua(FAKE_SPRING_SPAWN + '\n' + lua);
    assert.ok(r.ok, r.error);
    const parsed = JSON.parse(r.value);
    assert.deepEqual(parsed, { teamNorth: 1, teamSouth: 2, teamNorthCount: 30, teamSouthCount: 30 });
});
