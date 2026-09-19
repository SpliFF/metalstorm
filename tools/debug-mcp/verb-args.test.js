import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerb, buildOrderLua, verbToken, numToken, VerbArgError } from './verb-args.js';

test('a well-formed spawn verb', () => {
    assert.equal(buildVerb('spawn', [['ms_tank', 'defName'], [100, 'x', 'num'], [200.5, 'z', 'num'], [0, 'team', 'num'], [1, 'count', 'num']]),
        'spawn ms_tank 100 200.5 0 1');
});

test('whitespace in a def name is refused by name, not forwarded as extra tokens', () => {
    assert.throws(() => verbToken('ms tank 5', 'defName'), (e) => e instanceof VerbArgError && /defName/.test(e.message));
    assert.throws(() => verbToken('a\nb', 'defName'), VerbArgError);
});

test('NaN / Infinity coordinates are refused', () => {
    assert.throws(() => numToken(NaN, 'x'), /x must be a finite number/);
    assert.throws(() => numToken(Infinity, 'z'), VerbArgError);
    assert.throws(() => numToken('12abc', 'unitId'), /unitId must be a number/);
});

test('numeric strings are accepted for numeric slots; booleans become 1/0', () => {
    assert.equal(numToken('42', 'unitId'), '42');
    assert.equal(verbToken(true, 'flag'), '1');
});

test('undefined parts are skipped (optional trailing arguments)', () => {
    assert.equal(buildVerb('clear', [[undefined, 'team', 'num']]), 'clear');
    assert.equal(buildVerb('revive_team', [['all', 'team']]), 'revive_team all');
});

// --- buildOrderLua: orders as literal Lua, because the `order` verb drops opts ---

test('buildOrderLua: a 3-param MOVE with SHIFT keeps its opts (the verb form silently could not)', () => {
    const lua = buildOrderLua(17312, 10, [11200, 0, 11141.5], 32);
    assert.equal(lua.split('\n')[0], 'Spring.GiveOrderToUnit(17312, 10, {11200, 0, 11141.5}, 32)');
    assert.match(lua, /return 'order 10 issued to 17312'/);
});

test('buildOrderLua: opts defaults to 0 and params may be empty', () => {
    assert.equal(buildOrderLua(5, 0).split('\n')[0], 'Spring.GiveOrderToUnit(5, 0, {}, 0)');
});

test('buildOrderLua: refuses what the Lua literal could not represent safely', () => {
    assert.throws(() => buildOrderLua(0, 10, [1, 2, 3], 0), /unitId must be positive/);
    assert.throws(() => buildOrderLua(1.5, 10, [1, 2, 3], 0), /unitId must be an integer/);
    assert.throws(() => buildOrderLua(7, 10, [1, 2, 3, 4, 5], 0), /at most 4 params/);
    assert.throws(() => buildOrderLua(7, 10, [1, NaN, 3], 0), /params\[1\] must be a finite number/);
    assert.throws(() => buildOrderLua(7, 10, [1, 2, 3], -1), /opts must be a non-negative/);
    assert.throws(() => buildOrderLua(7, '10; os.exit()', [1, 2, 3], 0), VerbArgError);
    assert.throws(() => buildOrderLua(7, 10, ['1) end os.exit() --'], 0), VerbArgError);
});
