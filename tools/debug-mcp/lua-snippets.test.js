import test from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_SPRING, runLua } from './lua-fake-env.js';
import {
    LUA_JSON, aiListLua, aiHealthLua, aiDirectivesLua, guidanceSendLua, nlContextLua,
} from './lua-snippets.js';

function run(code) {
    const r = runLua(FAKE_SPRING + '\n' + code);
    assert.ok(r.ok, r.error);
    return JSON.parse(r.value);
}

test('the Lua JSON encoder: scalars, escapes, arrays, sorted objects, non-finite numbers', () => {
    const r = runLua(LUA_JSON + `return J({ b = 1, a = 'x"y\\n', list = { 1, 2.5, true }, empty = {}, nan = 0/0, neg = -3 })`);
    assert.ok(r.ok, r.error);
    assert.deepEqual(JSON.parse(r.value), { a: 'x"y\n', b: 1, empty: {}, list: [1, 2.5, true], nan: null, neg: -3 });
});

test('aiListLua: AI virtual players are flagged and annotated with profile + pool', () => {
    const out = run(aiListLua());
    assert.equal(out.frame, 1234);
    assert.equal(out.teams.length, 2);
    const t1 = out.teams.find((t) => t.team === 1);
    assert.equal(t1.ais.length, 1);
    assert.equal(t1.ais[0].name, 'strategos');
    assert.equal(t1.ais[0].profile, 'caretaker');
    assert.equal(t1.ais[0].pool, 25.5);
    assert.equal(t1.activeHumans, 1);
    assert.equal(t1.players.find((p) => p.name === 'shannon').isAI, false);
    assert.equal(run(aiListLua(2)).teams.length, 1);
});

test('aiHealthLua: found/missing params are reported by name, guidance + directives summarised', () => {
    const out = run(aiHealthLua());
    const t1 = out.teams.find((t) => t.team === 1);
    assert.equal(t1.params.found.authority_pool, 640);
    assert.equal(t1.params.found.ai_profile_1, 'caretaker');
    assert.ok(t1.params.missing.includes('ai_slate_targets'));
    assert.equal(t1.guidance.stance, 'balanced');
    assert.equal(t1.guidance.store.painted, 1);
    assert.equal(t1.directives.active, 1);
    assert.equal(t1.groups.tasked, 1);
    const t2 = out.teams.find((t) => t.team === 2);
    assert.ok(t2.params.missing.includes('authority_player_2'));
});

test('aiDirectivesLua: directives with params + conditions, groups with members', () => {
    const out = run(aiDirectivesLua(1));
    assert.equal(out.teams[0].directives[0].type, 'Assault');
    assert.deepEqual(out.teams[0].directives[0].params, [100, 0, 200]);
    assert.equal(out.teams[0].groups[0].name, '3rd Tanks');
    assert.deepEqual(out.teams[0].groups[0].members, [100, 101]);
    assert.equal(run(aiDirectivesLua(1, false)).teams[0].groups, undefined);
});

test('guidanceSendLua: delivers via gadgetHandler:RecvLuaMsg as the team\'s human, reports applied', () => {
    const out = run(guidanceSendLua('cmd=guidance.stance&value=aggressive', { team: 1 }));
    assert.equal(out.playerId, 0, 'the human on team 1, not the AI');
    assert.equal(out.applied, true);
    assert.equal(out.changeSeqBefore, 3);
    assert.equal(out.changeSeqAfter, 4);
    assert.equal(out.store.stance, 'balanced');
});

test('guidanceSendLua: explicit playerId wins, team mismatch is refused, AI-only team falls back to the AI', () => {
    assert.equal(run(guidanceSendLua('cmd=guidance.roe&value=free', { playerId: 1 })).playerId, 1);
    assert.match(run(guidanceSendLua('cmd=guidance.roe&value=free', { playerId: 2, team: 1 })).error, /on team 2, not 1/);
    assert.equal(run(guidanceSendLua('cmd=guidance.roe&value=free', { team: 2 })).playerId, 2);
    assert.match(run(guidanceSendLua('cmd=x', {})).error, /need team or playerId/);
});

test('guidanceSendLua: a payload containing long-bracket closers still arrives intact', () => {
    const out = run(guidanceSendLua('cmd=guidance.veto&goalId=a]]b', { team: 1 }));
    assert.equal(out.sent, 'cmd=guidance.veto&goalId=a]]b');
});

test('nlContextLua: places from region params, groups, objectives, class counts, enemies, authority', () => {
    const out = run(nlContextLua(1));
    assert.deepEqual(out.places.map((p) => p.n), ['Basin A', 'North Gate']);
    assert.deepEqual(out.groups, [
        { n: '3rd Tanks', sz: 2, state: 'tasked' },
        { n: 'Reserve', sz: 0, state: 'idle' },
    ]);
    assert.deepEqual(out.objectives, ['hold (active)', 'capture (complete)']);
    assert.deepEqual(out.self.counts, { armour: 2, infantry: 1 });
    assert.deepEqual(out.classes, ['armour', 'infantry']);
    assert.deepEqual(out.enemies, [{ n: 'reavers' }]);
    assert.equal(out.self.authority, 640);
    assert.match(run(nlContextLua()).error, /need team/);
});
