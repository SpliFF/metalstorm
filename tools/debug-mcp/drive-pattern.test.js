import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWaypoints, PATTERNS } from './drive-pattern.js';

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
