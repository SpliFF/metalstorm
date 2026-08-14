// Unit tests for the AI veto-loop verdict — PLAN-ai-synced-write task 5.
//
// The live arm (a real sim, a real human over the wire) is
// ai-veto-loop-run.mjs's; everything here is about the SHAPE of the verdict, and
// in particular about the two ways this arm could pass while proving nothing:
// an AI that stopped issuing directives entirely, and a goal that was never
// being pursued in the first place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseSample, headGoalId, pickVetoTarget, vetoLoopVerdict, pushOrderVerdict,
} from '../lib/ai-veto-checks.mjs';

const s = (frame, goalIds, vetoKeys = []) => ({ frame, goalIds, vetoKeys });

test('parseSample reads the flat probe shape, empty lists included', () => {
    assert.deepEqual(parseSample('7700|obj:1,,scout:ash_habitat|obj:1'), {
        frame: 7700, goalIds: ['obj:1', '', 'scout:ash_habitat'], vetoKeys: ['obj:1'],
    });
    // No intent lines and no vetoes is three empty fields, not a parse failure.
    assert.deepEqual(parseSample('120||'), { frame: 120, goalIds: [], vetoKeys: [] });
    assert.deepEqual(parseSample(''), { frame: 0, goalIds: [], vetoKeys: [] });
});

test('headGoalId is the newest line, which is the only one a fresh charge can write', () => {
    assert.equal(headGoalId(s(1, ['obj:1', 'obj:2'])), 'obj:1');
    assert.equal(headGoalId(s(1, ['', 'obj:2'])), '');   // untagged head
    assert.equal(headGoalId(s(1, [])), '');
});

test('pickVetoTarget prefers the most persistently directed goal, ties by id', () => {
    const samples = [
        s(1, ['obj:1', 'scout:a']),
        s(2, ['obj:1', 'scout:a']),
        s(3, ['obj:1']),
    ];
    assert.deepEqual(pickVetoTarget(samples), { id: 'obj:1', samples: 3 });
    // Untagged lines are not candidates: '' is what publishIntent writes for a
    // scripted-slate directive, and vetoing it would blacklist nothing.
    assert.equal(pickVetoTarget([s(1, ['', '']), s(2, [''])]), null);
    assert.equal(pickVetoTarget([]), null);
    assert.deepEqual(pickVetoTarget([s(1, ['b:2', 'a:1'])]), { id: 'a:1', samples: 1 });
    // A goal charged four times in ONE tick is four lines of one sample, and
    // must not outrank one the AI is still directing two samples later: the
    // whole point of the pick is persistence over time.
    assert.deepEqual(
        pickVetoTarget([s(1, ['x:1', 'x:1', 'x:1', 'x:1', 'y:2']), s(2, ['y:2'])]),
        { id: 'y:2', samples: 2 });
});

test('the loop passes when the goal stops, the AI keeps working, and the planner said so', () => {
    const v = vetoLoopVerdict({
        vetoedGoalId: 'obj:1', vetoFrame: 8500, plannerVetoReports: ['obj:1'],
        before: [s(8200, ['obj:1']), s(8400, ['obj:1'])],
        after: [
            s(8600, ['scout:east', 'obj:1'], ['obj:1']),
            s(8800, ['def:west', 'scout:east', 'obj:1'], ['obj:1']),
        ],
    });
    assert.equal(v.status, 'pass');
    assert.deepEqual(v.problems, []);
    // The vetoed line is still IN the list — it ages out on its own TTL — and
    // that must not read as a re-offence. Only the head can be a fresh charge.
    assert.deepEqual(v.facts.freshGoalsAfter, ['scout:east', 'def:west']);
});

test('a re-offence fails, and it is the HEAD of a later sample that says so', () => {
    const v = vetoLoopVerdict({
        vetoedGoalId: 'obj:1', vetoFrame: 8500,
        before: [s(8200, ['obj:1']), s(8400, ['obj:1'])],
        after: [
            s(8600, ['scout:east', 'obj:1'], ['obj:1']),
            s(8800, ['obj:1', 'scout:east'], ['obj:1']),
        ],
    });
    assert.equal(v.status, 'fail');
    assert.match(v.problems.join(' '), /directed again after the veto/);
});

test('a planner that never reported the exclusion fails, even with no re-offence', () => {
    // The neutralisation that PASSED this gate on 2026-08-14 before this check
    // existed: `guidanceExcludes`'s veto clause commented out. The AI's top goal
    // rotates on its own, so it stopped directing the vetoed goal anyway — the
    // only thing that separates the two worlds is whether the veto was
    // consulted, and only the planner can report that.
    const v = vetoLoopVerdict({
        vetoedGoalId: 'obj:1', vetoFrame: 8500, plannerVetoReports: [],
        before: [s(8200, ['obj:1']), s(8400, ['obj:1'])],
        after: [s(8600, ['scout:east'], ['obj:1']), s(8800, ['def:west'], ['obj:1'])],
    });
    assert.equal(v.status, 'fail');
    assert.match(v.problems.join(' '), /never reported excluding/);
    // …and it must not be satisfied by a report naming some OTHER goal.
    const other = vetoLoopVerdict({
        vetoedGoalId: 'obj:1', vetoFrame: 8500, plannerVetoReports: ['obj:7'],
        before: [s(8200, ['obj:1'])],
        after: [s(8600, ['scout:east'], ['obj:1']), s(8800, ['def:west'], ['obj:1'])],
    });
    assert.equal(other.status, 'fail');
});

test('a veto that never reached veto_keys fails, even with no re-offence', () => {
    // The gadget can accept a veto into its own store and fail to publish it;
    // the planner reads ONLY the published list (picture.lua), so an unpublished
    // veto is invisible to the AI and indistinguishable from a working one from
    // the gadget's side. This is the shape task 2's `Wire.num()` defect had.
    const v = vetoLoopVerdict({
        vetoedGoalId: 'obj:1', vetoFrame: 8500, plannerVetoReports: ['obj:1'],
        before: [s(8200, ['obj:1']), s(8400, ['obj:1'])],
        after: [s(8600, ['scout:east'], []), s(8800, ['def:west'], [])],
    });
    assert.equal(v.status, 'fail');
    assert.match(v.problems.join(' '), /never appeared in guidance veto_keys/);
});

test('an AI that stopped issuing anything is VACUOUS, not a pass', () => {
    // The failure mode this arm is most likely to hit: a co-commander that runs
    // out of authority charges nothing, so no goal — vetoed or not — reaches the
    // intent list, and "it stopped proposing the vetoed goal" is true for the
    // wrong reason.
    const v = vetoLoopVerdict({
        vetoedGoalId: 'obj:1', vetoFrame: 8500,
        before: [s(8200, ['obj:1']), s(8400, ['obj:1'])],
        after: [s(8600, ['obj:1'], ['obj:1']), s(8900, ['obj:1'], ['obj:1'])],
    });
    // Every post-veto head is the vetoed id from BEFORE the veto, still in the
    // rolling window: no new charge at all.
    assert.equal(v.status, 'fail');   // it re-offends by the head rule
    const quiet = vetoLoopVerdict({
        vetoedGoalId: 'obj:1', vetoFrame: 8500,
        before: [s(8200, ['obj:1']), s(8400, ['obj:1'])],
        after: [s(8600, ['', ''], ['obj:1']), s(8900, [''], ['obj:1'])],
    });
    assert.equal(quiet.status, 'vacuous');
    assert.match(quiet.problems.join(' '), /issued no charged directive at all/);
});

test('a goal the AI was not pursuing, and a too-short window, are both VACUOUS', () => {
    const notPursued = vetoLoopVerdict({
        vetoedGoalId: 'obj:9', vetoFrame: 8500,
        before: [s(8200, ['obj:1'])], after: [s(8900, ['obj:2'], ['obj:9'])],
    });
    assert.equal(notPursued.status, 'vacuous');
    assert.match(notPursued.problems.join(' '), /never directed/);

    const short = vetoLoopVerdict({
        vetoedGoalId: 'obj:1', vetoFrame: 8500,
        before: [s(8200, ['obj:1'])], after: [s(8600, ['obj:2'], ['obj:1'])],
    });
    assert.equal(short.status, 'vacuous');
    assert.match(short.problems.join(' '), /strategic tick/);
    assert.equal(short.facts.ticksObserved, 0);
});

test('push order: an intent immediately before its directive, same frame, passes', () => {
    const v = pushOrderVerdict([
        { seq: 10, frame: 600, kind: 'ai-command', verb: 'lua-msg', playerId: 0 },
        { seq: 11, frame: 600, kind: 'ai-command', verb: 'issue-directive', playerId: 0 },
        { seq: 12, frame: 750, kind: 'ai-command', verb: 'lua-msg', playerId: 0 },
        { seq: 13, frame: 750, kind: 'ai-command', verb: 'set-posture', playerId: 0 },
        // Another player's records interleave and must not be paired across.
        { seq: 14, frame: 750, kind: 'ai-command', verb: 'issue-directive', playerId: 1 },
        { seq: 15, frame: 750, kind: 'client-message', playerId: 2 },
    ]);
    assert.equal(v.status, 'pass');
    assert.equal(v.facts.orderedPairs, 2);
    assert.deepEqual(v.facts.verbs, ['lua-msg', 'issue-directive', 'set-posture']);
});

test('push order: two tags in a row, and a tag a frame early, both fail', () => {
    const doubled = pushOrderVerdict([
        { seq: 1, frame: 600, kind: 'ai-command', verb: 'lua-msg', playerId: 0 },
        { seq: 2, frame: 600, kind: 'ai-command', verb: 'lua-msg', playerId: 0 },
        { seq: 3, frame: 600, kind: 'ai-command', verb: 'issue-directive', playerId: 0 },
    ]);
    assert.equal(doubled.status, 'fail');
    assert.match(doubled.problems.join(' '), /followed by another ai.intent/);

    const early = pushOrderVerdict([
        { seq: 1, frame: 590, kind: 'ai-command', verb: 'lua-msg', playerId: 0 },
        { seq: 2, frame: 600, kind: 'ai-command', verb: 'issue-directive', playerId: 0 },
    ]);
    assert.equal(early.status, 'fail');
    assert.match(early.problems.join(' '), /annotates nothing/);
});

test('push order: no tag in the window is VACUOUS', () => {
    const v = pushOrderVerdict([
        { seq: 1, frame: 600, kind: 'ai-command', verb: 'issue-directive', playerId: 0 },
    ]);
    assert.equal(v.status, 'vacuous');
    // A journal from a binary that did not stamp the verb reads as one
    // anonymous kind — which is exactly what SG1 5(b) had to fix, and it must
    // report as "nothing to inspect" rather than as a passing order check.
    const unstamped = pushOrderVerdict([
        { seq: 1, frame: 600, kind: 'ai-command', verb: 'unit-command', playerId: 0 },
        { seq: 2, frame: 600, kind: 'ai-command', verb: 'unit-command', playerId: 0 },
    ]);
    assert.equal(unstamped.status, 'vacuous');
});

test('push order: the head/tail seam is not an adjacency', () => {
    // /api/journal publishes the ring's head and tail, never the middle. On
    // 2026-08-14 the concatenated form read head's last tag (seq 20, frame 449)
    // against tail's first directive (seq 39, frame 899) and reported the
    // 450-frame gap as a defect — a failure invented by the reader. Blocks fix
    // it, and this is the regression: the same rows must PASS as two blocks and
    // FAIL as one.
    const head = [
        { seq: 19, frame: 449, kind: 'ai-command', verb: 'issue-directive', playerId: 0 },
        { seq: 20, frame: 449, kind: 'ai-command', verb: 'lua-msg', playerId: 0 },
    ];
    const tail = [
        { seq: 39, frame: 899, kind: 'ai-command', verb: 'issue-directive', playerId: 0 },
        { seq: 40, frame: 1049, kind: 'ai-command', verb: 'lua-msg', playerId: 0 },
        { seq: 41, frame: 1049, kind: 'ai-command', verb: 'issue-directive', playerId: 0 },
    ];
    const blocked = pushOrderVerdict([head, tail]);
    assert.equal(blocked.status, 'pass');
    assert.equal(blocked.facts.orderedPairs, 1);   // seq 40→41; seq 20 ends its block
    assert.equal(blocked.facts.tagRecords, 2);

    const seamed = pushOrderVerdict([...head, ...tail]);
    assert.equal(seamed.status, 'fail');
    assert.match(seamed.problems.join(' '), /annotates nothing/);
});
