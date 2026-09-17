import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWaypoints, createProgressTracker, patternSpan, passiveStateLua, queueReportLua, PATTERNS, DEFAULT_CLEARANCE } from './drive-pattern.js';

test('unknown pattern is refused by name', () => {
    assert.throws(() => generateWaypoints({ pattern: 'hexagon' }), /unknown pattern "hexagon"/);
});

test('circle: every waypoint sits exactly `radius` from centre', () => {
    const center = { x: 100, z: -50 };
    const pts = generateWaypoints({ pattern: 'circle', center, radius: 250, laps: 1, segmentsPerLap: 16 });
    assert.equal(pts.length, 16);
    for (const p of pts) {
        const d = Math.hypot(p.x - center.x, p.z - center.z);
        assert.ok(Math.abs(d - 250) < 1e-9, `waypoint ${JSON.stringify(p)} is ${d} from centre, expected 250`);
    }
});

test('circle: laps repeat the same ring', () => {
    const pts = generateWaypoints({ pattern: 'circle', radius: 100, laps: 3, segmentsPerLap: 8 });
    assert.equal(pts.length, 24);
    assert.deepEqual(pts.slice(0, 8), pts.slice(8, 16));
    assert.deepEqual(pts.slice(0, 8), pts.slice(16, 24));
});

test('figure8: passes back through the centre at the lap midpoint and stays within radius', () => {
    const center = { x: 8192, z: 8192 };
    const pts = generateWaypoints({ pattern: 'figure8', center, radius: 300, laps: 1, segmentsPerLap: 12 });
    assert.equal(pts.length, 12);
    for (const p of pts) {
        assert.ok(Math.abs(p.x - center.x) <= 300 + 1e-9);
        assert.ok(Math.abs(p.z - center.z) <= 300 + 1e-9);
    }
    // t = π/2 (the 3rd of 12 segments) sits at x=sin(π)=0, z=sin(π/2)=1 → (centre.x, centre.z + radius).
    const mid = pts[2];
    assert.ok(Math.abs(mid.x - center.x) < 1e-9);
    assert.ok(Math.abs(mid.z - (center.z + 300)) < 1e-9);
});

test('line: only two distinct waypoints per round trip, length apart, centred', () => {
    const center = { x: 500, z: 500 };
    const pts = generateWaypoints({ pattern: 'line', center, length: 400, laps: 2 });
    assert.equal(pts.length, 4);
    for (const p of pts) assert.equal(p.z, 500);
    const xs = new Set(pts.map((p) => p.x));
    assert.deepEqual([...xs].sort((a, b) => a - b), [300, 700]);
    // Each lap is a round trip: +end then -end.
    assert.equal(pts[0].x, 700);
    assert.equal(pts[1].x, 300);
    assert.equal(pts[2].x, 700);
    assert.equal(pts[3].x, 300);
});

test('zigzag: lateral offset alternates sign and stays within the amplitude', () => {
    const pts = generateWaypoints({ pattern: 'zigzag', center: { x: 0, z: 0 }, length: 1000, radius: 150, laps: 1, segmentsPerLap: 4 });
    assert.equal(pts.length, 8);
    for (const p of pts) assert.ok(Math.abs(p.z) <= 150 + 1e-9);
    // Forward leg ends near +length/2, return leg back near -length/2.
    assert.ok(Math.abs(pts[3].x - 500) < 1e-9);
    assert.ok(Math.abs(pts[7].x - (-500)) < 1e-9);
});

test('degenerate laps/segments are clamped, never zero or negative', () => {
    const pts = generateWaypoints({ pattern: 'circle', laps: 0, segmentsPerLap: 1 });
    assert.equal(pts.length, 3); // laps clamped to 1, segments clamped to MIN_SEGMENTS_PER_LAP (3)
});

test('every declared pattern is generatable with defaults', () => {
    for (const pattern of PATTERNS) {
        const pts = generateWaypoints({ pattern });
        assert.ok(Array.isArray(pts) && pts.length > 0, `${pattern} produced no waypoints`);
        for (const p of pts) {
            assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `${pattern} produced a non-finite waypoint`);
        }
    }
});

// --- createProgressTracker: sequential arrival, never before departure ------

// clearance:0 on purpose — these tracker tests want the raw Lissajous with its coincident centre points.
const fig8 = () => generateWaypoints({ pattern: 'figure8', center: { x: 1000, z: 1000 }, radius: 200, laps: 1, segmentsPerLap: 8, clearance: 0 });

test('tracker: a closed loop is NOT arrived while the unit still sits at its start', () => {
    const waypoints = fig8();
    const origin = { x: 1000, z: 1000 };
    // The last waypoint IS the origin (sin(4π)=sin(2π)=0) — the naive "near the last waypoint" test passes here.
    assert.ok(Math.hypot(waypoints[7].x - origin.x, waypoints[7].z - origin.z) < 1e-9);
    const t = createProgressTracker({ waypoints, arriveRadius: 64, origin });
    for (let i = 0; i < 10; i++) {
        const s = t.update({ x: 1000.3, z: 1007.2 });   // the 11-frame "arrival" position from the first live call
        assert.equal(s.arrived, false);
        assert.equal(s.departed, false);
        assert.equal(s.waypointsReached, 0);
    }
});

test('tracker: visiting every waypoint in order arrives exactly at the last one', () => {
    const waypoints = fig8();
    const t = createProgressTracker({ waypoints, arriveRadius: 64, origin: { x: 1000, z: 1000 } });
    let s;
    waypoints.forEach((wp, i) => {
        s = t.update({ x: wp.x + 10, z: wp.z - 10 });
        assert.equal(s.waypointsReached, i + 1);
        assert.equal(s.arrived, i === waypoints.length - 1, `arrived flipped at waypoint ${i}`);
    });
    assert.equal(s.departed, true);
    assert.ok(s.farthestFromOrigin > 199);
});

test('tracker: the figure-8 centre crossing mid-lap is not mistaken for the finish', () => {
    const waypoints = fig8();
    const origin = { x: 1000, z: 1000 };
    // Waypoint index 3 (t = π) is the centre — the same point as the final waypoint.
    assert.ok(Math.hypot(waypoints[3].x - origin.x, waypoints[3].z - origin.z) < 1e-9);
    const t = createProgressTracker({ waypoints, arriveRadius: 64, origin });
    let s;
    for (let i = 0; i <= 3; i++) s = t.update(waypoints[i]);
    assert.equal(s.waypointsReached, 4);
    assert.equal(s.arrived, false);
});

test('tracker: one waypoint missed between polls is forgiven by the lookahead, two are not', () => {
    const waypoints = fig8();
    const t = createProgressTracker({ waypoints, arriveRadius: 64, origin: { x: 1000, z: 1000 } });
    t.update(waypoints[0]);
    let s = t.update(waypoints[2]);          // skipped waypoint 1
    assert.equal(s.waypointsReached, 3);
    s = t.update(waypoints[5]);              // skipped 3 and 4 — beyond the lookahead
    assert.equal(s.waypointsReached, 3);
    s = t.update(waypoints[3]);
    assert.equal(s.waypointsReached, 4);
});

test('tracker: no lookahead before departure, even if a later waypoint is close to the start', () => {
    // segmentsPerLap 4 puts the centre at index 1 — adjacent to the first waypoint.
    const waypoints = generateWaypoints({ pattern: 'figure8', center: { x: 0, z: 0 }, radius: 200, laps: 1, segmentsPerLap: 4, clearance: 0 });
    assert.ok(Math.hypot(waypoints[1].x, waypoints[1].z) < 1e-9);
    const t = createProgressTracker({ waypoints, arriveRadius: 64, origin: { x: 0, z: 0 } });
    const s = t.update({ x: 0, z: 0 });
    assert.equal(s.waypointsReached, 0);
    assert.equal(s.arrived, false);
});

test('tracker: refuses an empty waypoint list', () => {
    assert.throws(() => createProgressTracker({ waypoints: [] }), /no waypoints/);
});

test('patternSpan: the distance a unit must cover before any waypoint is reachable', () => {
    assert.equal(patternSpan({ pattern: 'circle', radius: 120 }), 120);
    assert.equal(patternSpan({ pattern: 'figure8' }), 300);
    assert.equal(patternSpan({ pattern: 'line', length: 500 }), 250);
    assert.equal(patternSpan({ pattern: 'zigzag', length: 100, radius: 150 }), 150);
});

test('passiveStateLua / queueReportLua: guarded state commands and a readable queue head', () => {
    const p = passiveStateLua(17312);
    assert.match(p, /^local u = 17312\n/);
    assert.match(p, /if CMD\.FIRE_STATE then Spring\.GiveOrderToUnit\(u, CMD\.FIRE_STATE, \{0\}, 0\) end/);
    assert.match(p, /if CMD\.MOVE_STATE then Spring\.GiveOrderToUnit\(u, CMD\.MOVE_STATE, \{0\}, 0\) end/);
    const q = queueReportLua(17312, 4);
    assert.match(q, /Spring\.GetUnitCommands\(17312, 4\)/);
    assert.throws(() => passiveStateLua(0), /bad unitId/);
    assert.throws(() => queueReportLua(-3), /bad unitId/);
});

// --- clearance: no waypoint on top of the unit's own start ------------------

test('figure8: with the default clearance no waypoint sits on the centre, and the loop still closes near it', () => {
    const center = { x: 1000, z: 1000 };
    const pts = generateWaypoints({ pattern: 'figure8', center, radius: 200, laps: 1, segmentsPerLap: 8 });
    assert.equal(pts.length, 8);
    for (const p of pts) {
        const d = Math.hypot(p.x - center.x, p.z - center.z);
        assert.ok(d >= DEFAULT_CLEARANCE - 1e-9, `waypoint ${JSON.stringify(p)} is only ${d} from the centre`);
    }
    // The two former centre crossings (indices 3 and 7) now stop `clearance` short, along their incoming segment.
    for (const i of [3, 7]) {
        const d = Math.hypot(pts[i].x - center.x, pts[i].z - center.z);
        assert.ok(Math.abs(d - DEFAULT_CLEARANCE) < 1e-9, `index ${i} is ${d} from the centre, expected ${DEFAULT_CLEARANCE}`);
        const prev = pts[i - 1];
        const along = ((pts[i].x - center.x) * (prev.x - center.x) + (pts[i].z - center.z) * (prev.z - center.z));
        assert.ok(along > 0, `index ${i} was not pulled back toward its previous waypoint`);
    }
});

test('clearance 0 keeps the exact Lissajous (centre hit mid-lap and at the finish)', () => {
    const pts = generateWaypoints({ pattern: 'figure8', center: { x: 0, z: 0 }, radius: 200, laps: 1, segmentsPerLap: 8, clearance: 0 });
    assert.ok(Math.hypot(pts[3].x, pts[3].z) < 1e-9);
    assert.ok(Math.hypot(pts[7].x, pts[7].z) < 1e-9);
});

test('clearance never touches circle / line / zigzag waypoints (none are near the centre)', () => {
    for (const pattern of ['circle', 'line', 'zigzag']) {
        const a = generateWaypoints({ pattern, radius: 200, length: 400, laps: 2, segmentsPerLap: 6 });
        const b = generateWaypoints({ pattern, radius: 200, length: 400, laps: 2, segmentsPerLap: 6, clearance: 0 });
        assert.deepEqual(a, b, `${pattern} changed under the default clearance`);
    }
});
