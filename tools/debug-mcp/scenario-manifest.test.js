/**
 * `node --test tools/debug-mcp/` — pure-builder tests for launch_scenario.
 *
 * The "parity fixture" cases below are the same inputs and the same expected
 * manifest as `client/src/lobby/play-boot.test.ts`'s fixture, modulo the two
 * deliberate differences (room-name convention, default AI). Change one
 * builder, change the other, and run both suites.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenarioManifest, derivePlaySlots } from './scenario-manifest.js';

const CROSSING = {
    id: 'crossing_standoff',
    map: 'scorched_crossing_v2.4',
    sides: [
        { faction: 'compact', team: 0, staged: true },
        { faction: 'union', team: 1, staged: true },
    ],
    terminal: true,
};

test('host takes the first side, every other playable side gets an AI', () => {
    assert.deepEqual(derivePlaySlots(CROSSING.sides, undefined, 'null'),
        { hostTeam: 0, aiSlots: [{ aiId: 'null', team: 1 }] });
});

test('side override moves the host and the AI', () => {
    assert.deepEqual(derivePlaySlots(CROSSING.sides, 'union', 'strategos'),
        { hostTeam: 1, aiSlots: [{ aiId: 'strategos', team: 0 }] });
});

test('an unknown side names the valid ones', () => {
    assert.throws(() => derivePlaySlots(CROSSING.sides, 'martians', 'null'),
        /Valid: compact, union/);
});

test('sideless scenarios fall back to the legacy two-team shape', () => {
    assert.deepEqual(derivePlaySlots([], undefined, 'null'),
        { hostTeam: 0, aiSlots: [{ aiId: 'null', team: 1 }] });
    assert.deepEqual(derivePlaySlots([], undefined, '').aiSlots, []);
});

test('parity fixture: crossing_standoff, admin host, ai=null', () => {
    const { manifest, notes } = buildScenarioManifest({
        scenario: CROSSING, scenarioId: 'crossing_standoff', gameId: 'metalstorm',
        players: [{ username: 'admin' }], ai: 'null', roomName: 'mcp:crossing_standoff',
    });
    assert.deepEqual(manifest, {
        name: 'mcp:crossing_standoff',
        game: 'metalstorm',
        map: 'scorched_crossing_v2.4',
        scenario: 'crossing_standoff',
        players: [{ username: 'admin', team: 0 }],
        aiSlots: [{ aiId: 'null', team: 1 }],
        modoptions: {},
        autoStart: true,
    });
    assert.deepEqual(notes, []);
});

test('parity fixture: side=union override', () => {
    const { manifest } = buildScenarioManifest({
        scenario: CROSSING, scenarioId: 'crossing_standoff', side: 'union',
        players: [{ username: 'admin' }], ai: 'null', roomName: 'r',
    });
    assert.deepEqual(manifest.players, [{ username: 'admin', team: 1 }]);
    assert.deepEqual(manifest.aiSlots, [{ aiId: 'null', team: 0 }]);
});

test('modoptions.scenario is hoisted out and reported', () => {
    const { manifest, notes } = buildScenarioManifest({
        scenario: CROSSING, scenarioId: 'crossing_standoff', roomName: 'r',
        players: [{ username: 'admin' }], modoptions: { scenario: 'other', foo: '1' },
    });
    assert.equal(manifest.scenario, 'crossing_standoff');
    assert.deepEqual(manifest.modoptions, { foo: '1' });
    assert.match(notes[0], /top-level scenario "crossing_standoff"/);
});

test('extra players default to spectators; explicit team and side both win', () => {
    const { manifest } = buildScenarioManifest({
        scenario: CROSSING, scenarioId: 'crossing_standoff', roomName: 'r', ai: '',
        players: [{ username: 'a' }, { username: 'b' }, { username: 'c', side: 'union' },
                  { username: 'd', team: 7 }],
    });
    assert.deepEqual(manifest.players, [
        { username: 'a', team: 0 },
        { username: 'b', spectator: true },
        { username: 'c', team: 1 },
        { username: 'd', team: 7 },
    ]);
});

test('force mode without a map is a caller-facing error', () => {
    assert.throws(() => buildScenarioManifest({
        scenario: null, scenarioId: 'brand_new', roomName: 'r',
        players: [{ username: 'admin' }],
    }), /pass mapId/);
});

test('idleGraceSeconds lands as idleStartupGraceSeconds', () => {
    const { manifest } = buildScenarioManifest({
        scenario: CROSSING, scenarioId: 'crossing_standoff', roomName: 'r',
        players: [{ username: 'admin' }], idleGraceSeconds: 3600,
    });
    assert.equal(manifest.idleStartupGraceSeconds, 3600);
});
