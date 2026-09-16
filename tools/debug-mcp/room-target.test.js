import test from 'node:test';
import assert from 'node:assert/strict';
import { pickServer, rowIsLive } from './room-target.js';

const alive = new Set([101, 102]);
const pidAlive = (pid) => alive.has(pid);
const rows = [
    { room_id: 7, port: 9100, pid: 100, state: 'ended', map_id: 'meridian_basin' },
    { room_id: 8, port: 9100, pid: 101, state: 'running', map_id: 'meridian_basin' },
    { room_id: 9, port: 9101, pid: 102, state: 'starting' },
    { room_id: 10, port: 0, pid: 0, state: 'hibernated' },
];

test('the trap: an ended room whose port a live room now holds is REFUSED, naming the squatter', () => {
    const r = pickServer(rows, 7, { pidAlive });
    assert.ok(r.error);
    assert.match(r.error, /room 7 has ended/);
    assert.match(r.error, /now bound by room 8/);
    assert.match(r.error, /answered from room 8/);
});

test('an explicit live room resolves to its own row', () => {
    assert.equal(pickServer(rows, 8, { pidAlive }).server.room_id, 8);
    assert.equal(pickServer(rows, 9, { pidAlive }).server.room_id, 9);
});

test('a live-looking row with a dead pid is refused (lobby rows outlive processes)', () => {
    const r = pickServer([{ room_id: 3, port: 9100, pid: 555, state: 'running' }], 3, { pidAlive });
    assert.match(r.error, /is dead \(pid 555 is gone/);
});

test('a hibernated (pid 0) room is refused rather than signalling pid 0', () => {
    const r = pickServer(rows, 10, { pidAlive });
    assert.match(r.error, /hibernated/);
});

test('a roomId equal to a PORT is told it passed a port', () => {
    const r = pickServer(rows, 9100, { pidAlive });
    assert.match(r.error, /9100 is a PORT, not a room id/);
    assert.match(r.error, /belongs to room 7/);
});

test('an unknown roomId lists the candidates', () => {
    const r = pickServer(rows, 42, { pidAlive });
    assert.match(r.error, /no game server for room 42/);
    assert.match(r.error, /room 8 \(state=running/);
});

test('auto-pick prefers running, then starting, and never a dead or ended row', () => {
    assert.equal(pickServer(rows, undefined, { pidAlive }).server.room_id, 8);
    assert.equal(pickServer(rows.filter(r => r.room_id !== 8), undefined, { pidAlive }).server.room_id, 9);
    const r = pickServer([rows[0], rows[3]], 0, { pidAlive });
    assert.match(r.error, /no LIVE game server/);
    assert.match(pickServer([], undefined, { pidAlive }).error, /no game servers found/);
});

test('rowIsLive', () => {
    assert.equal(rowIsLive(rows[1], pidAlive), true);
    assert.equal(rowIsLive(rows[0], pidAlive), false);
    assert.equal(rowIsLive(null, pidAlive), false);
});
