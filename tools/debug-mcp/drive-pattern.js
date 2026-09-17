// drive-pattern.js — pure waypoint generation for the `drive_pattern` MCP tool.
//
// TOOLING GAP (docs/reviews/beta/README.md, pres-decals): there was no
// dedicated figure-8/waypoint-loop routine for driving a unit through a
// scripted path — the pres-decals fire hand-built one from 7-8 individual
// `give_order` MOVE calls. This module is the reusable waypoint generator;
// server.js's `drive_pattern` case issues the waypoints as queued MOVE orders
// (reusing the same `execOnGameServer`/`buildVerb` plumbing as `give_order`,
// and the same `sampleUnitMotion`/`readSimFrame` polling as `order_and_film`).

export const PATTERNS = ['figure8', 'circle', 'line', 'zigzag'];

/** Minimum useful resolution per lap — below this a "circle" is a triangle. */
const MIN_SEGMENTS_PER_LAP = 3;
const DEFAULT_SEGMENTS_PER_LAP = 12;

/**
 * Compute the waypoint list for one of the four patterns, centred on
 * `center` ({x, z}). All patterns are closed or round-trip shapes: laps
 * repeat the same geometry rather than drifting, so a queued order list is
 * just this array issued in order (first waypoint opts 0, the rest opts 32
 * to queue — see server.js).
 *
 * - figure8 / circle: `radius` sets the loop size, `segmentsPerLap` waypoints
 *   per lap, `laps` repeats the loop.
 * - line: `length` is the total end-to-end distance; each lap is one round
 *   trip (there and back), 2 waypoints per lap.
 * - zigzag: `length` is the total forward span, `radius` the lateral
 *   amplitude; each lap is one forward-and-back sweep, `segmentsPerLap`
 *   waypoints per sweep leg.
 */
export function generateWaypoints(opts = {}) {
    const pattern = opts.pattern;
    if (!PATTERNS.includes(pattern)) {
        throw new Error(`drive_pattern: unknown pattern "${pattern}" — expected one of ${PATTERNS.join(', ')}`);
    }
    const cx = Number.isFinite(opts.center?.x) ? opts.center.x : 0;
    const cz = Number.isFinite(opts.center?.z) ? opts.center.z : 0;
    const laps = Math.max(1, Math.floor(Number.isFinite(opts.laps) ? opts.laps : 1));
    const n = Math.max(MIN_SEGMENTS_PER_LAP,
        Math.floor(Number.isFinite(opts.segmentsPerLap) ? opts.segmentsPerLap : DEFAULT_SEGMENTS_PER_LAP));
    const radius = Number.isFinite(opts.radius) && opts.radius > 0 ? opts.radius : 300;
    const length = Number.isFinite(opts.length) && opts.length > 0 ? opts.length : 300;

    const pts = [];
    switch (pattern) {
        case 'circle': {
            for (let lap = 0; lap < laps; lap++) {
                for (let i = 1; i <= n; i++) {
                    const t = (i / n) * 2 * Math.PI;
                    pts.push({ x: cx + radius * Math.cos(t), z: cz + radius * Math.sin(t) });
                }
            }
            break;
        }
        case 'figure8': {
            // Lissajous 2:1 curve — x=sin(2t), z=sin(t) — traces a closed
            // figure-eight through the centre once per t in [0, 2π).
            for (let lap = 0; lap < laps; lap++) {
                for (let i = 1; i <= n; i++) {
                    const t = (i / n) * 2 * Math.PI;
                    pts.push({ x: cx + radius * Math.sin(2 * t), z: cz + radius * Math.sin(t) });
                }
            }
            break;
        }
        case 'line': {
            const half = length / 2;
            for (let lap = 0; lap < laps; lap++) {
                pts.push({ x: cx + half, z: cz });
                pts.push({ x: cx - half, z: cz });
            }
            break;
        }
        case 'zigzag': {
            const half = length / 2;
            // One lap = advance from -half to +half and back, alternating the
            // lateral offset every segment.
            for (let lap = 0; lap < laps; lap++) {
                for (let i = 1; i <= n; i++) {
                    const x = cx - half + (i / n) * length;
                    const z = cz + (i % 2 === 1 ? radius : -radius);
                    pts.push({ x, z });
                }
                for (let i = 1; i <= n; i++) {
                    const x = cx + half - (i / n) * length;
                    const z = cz + (i % 2 === 1 ? -radius : radius);
                    pts.push({ x, z });
                }
            }
            break;
        }
    }
    return pts;
}
