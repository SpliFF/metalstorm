import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerb, verbToken, numToken, VerbArgError } from './verb-args.js';

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
