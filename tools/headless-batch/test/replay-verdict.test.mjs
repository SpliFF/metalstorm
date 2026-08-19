import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVerdict } from '../replay-verify-run.mjs';

// PLAN-replay T2-b: the exit code is unusable (spring-server aborts during
// static destruction, after main returns), so the whole gate hangs off parsing
// these log lines. If the engine's wording changes and this parser silently
// stops matching, the gate degrades to "no FAIL seen" — which is why 'absent'
// is a distinct verdict and not folded into either outcome.

test('a PASS verdict is parsed with its counts', () => {
    const out = [
        '[NOTICE] replay: 19 records loaded',
        '[NOTICE] replay verify: PASS — 12/12 state hashes matched, 19 records fed',
        '[NOTICE] exited cleanly',
    ].join('\n');
    const v = readVerdict(out);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.matched, 12);
    assert.equal(v.checked, 12);
    assert.equal(v.fed, 19);
});

test('a FAIL verdict wins even when surrounded by cheerful output', () => {
    const out = [
        '[NOTICE] replay: 19 records loaded',
        '[ERROR] replay verify: DIVERGENCE at frame 900 — expected dead..., got beef...',
        '[ERROR] replay verify: FAIL — checked=12 matched=11 missing=0 firstDivergence=900 expected=0 actual=1',
        '[NOTICE] exited cleanly',
    ].join('\n');
    const v = readVerdict(out);
    assert.equal(v.verdict, 'fail');
    assert.ok(v.line.includes('firstDivergence=900'));
});

// The failure mode that would make this gate silently vacuous: the run dies
// before it ever renders a verdict. "No FAIL line" must NOT read as success.
test('no verdict line at all is `absent`, not a pass', () => {
    const v = readVerdict('[NOTICE] replay: 19 records loaded\n[ERROR] segfault\n');
    assert.equal(v.verdict, 'absent');
    assert.equal(v.line, null);
});

test('the word "PASS" elsewhere in the log does not count', () => {
    const v = readVerdict('[NOTICE] preflight PASS\n[NOTICE] all checks pass\n');
    assert.equal(v.verdict, 'absent');
});
