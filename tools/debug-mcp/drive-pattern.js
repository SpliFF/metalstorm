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
 * The engine DROPS a MOVE order whose target is within ~16-32 elmos of the
 * unit's current position — at issue time, shift-queued or not (measured
 * live: offsets 1/4/8/16 vanished from the queue, 32 survived). A figure-8
 * centred on the unit therefore lost both its centre crossings (mid-lap and
 * the finish) and stopped one waypoint short. Waypoints closer than this to
 * the centre are pulled back to `clearance` along their incoming segment.
 */
export const DEFAULT_CLEARANCE = 48;

/**
 * Compute the waypoint list for one of the four patterns, centred on
 * `center` ({x, z}). All patterns are closed or round-trip shapes: laps
 * repeat the same geometry rather than drifting, so a queued order list is
 * just this array issued in order (first waypoint opts 0, the rest opts 32
 * to queue — see server.js).
 *
 * - figure8 / circle: `radius` sets the loop size, `segmentsPerLap` waypoints
 *   per lap, `laps` repeats the loop.
 * - `clearance` (default DEFAULT_CLEARANCE): no waypoint is left closer than
 *   this to the centre; 0 disables the adjustment.
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

    // Keep every waypoint clear of the centre (the unit's own position when
    // the orders go in) — see DEFAULT_CLEARANCE. A waypoint inside the
    // clearance stops `clearance` short of the centre along the segment that
    // leads into it, so the path shape is kept and the loop still closes to
    // within `clearance` of where it began.
    const clearance = Number.isFinite(opts.clearance) ? Math.max(0, opts.clearance) : DEFAULT_CLEARANCE;
    if (clearance > 0) {
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (Math.hypot(p.x - cx, p.z - cz) >= clearance) continue;
            const prev = i > 0 ? pts[i - 1] : null;
            let dx = prev ? prev.x - cx : 1;
            let dz = prev ? prev.z - cz : 0;
            const len = Math.hypot(dx, dz);
            if (len < 1e-9) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
            pts[i] = { x: cx + dx * clearance, z: cz + dz * clearance };
        }
    }
    return pts;
}

/**
 * Sequential arrival tracking for a waypoint list.
 *
 * Every closed pattern (figure8, circle) ENDS where the unit STARTED, so
 * "within `arriveRadius` of the last waypoint" is already true before the
 * first order is even acknowledged — the first live by-name `drive_pattern`
 * call reported `arrived:true` after 11 sim frames for a 200-elmo figure-8.
 * This tracker only credits waypoints in order, and never declares arrival
 * until the unit has first left its origin (`departed`).
 *
 * A unit can pass a waypoint between two polls, so once it has departed the
 * tracker looks `lookahead` waypoints past the next expected one. The
 * lookahead is deliberately small: a figure-8 revisits its centre mid-lap,
 * and scanning too far ahead would mistake that midpoint for the finish.
 *
 * `update(pos)` folds in one position sample and returns the snapshot
 * `{waypointsReached, departed, arrived, farthestFromOrigin}`.
 */
export function createProgressTracker({ waypoints, arriveRadius = 64, origin, lookahead = 1 } = {}) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
        throw new Error('drive_pattern: no waypoints to track');
    }
    const r = Number.isFinite(arriveRadius) && arriveRadius > 0 ? arriveRadius : 64;
    const ahead = Number.isFinite(lookahead) ? Math.max(0, Math.floor(lookahead)) : 1;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    let next = 0;
    let departed = !origin;   // nothing to depart from when no origin is known
    let farthestFromOrigin = 0;
    const snapshot = () => ({
        waypointsReached: next,
        departed,
        arrived: departed && next >= waypoints.length,
        farthestFromOrigin,
    });
    return {
        update(pos) {
            if (origin) {
                const d = dist(pos, origin);
                if (d > farthestFromOrigin) farthestFromOrigin = d;
                if (d > r) departed = true;
            }
            if (next < waypoints.length) {
                const limit = Math.min(waypoints.length - 1, next + (departed ? ahead : 0));
                for (let j = limit; j >= next; j--) {
                    if (dist(pos, waypoints[j]) <= r) { next = j + 1; break; }
                }
            }
            return snapshot();
        },
        snapshot,
    };
}

/**
 * LuaRules snippet putting a unit on hold-fire + hold-position before it is
 * driven. An idle-or-idling unit that can see an enemy gets an INTERNAL
 * attack order from the engine (opts 8), which replaces whatever move queue
 * it had — the live smoke-test tanks all ended up on `20[<enemy>] opts=8`.
 * State commands are guarded by name so an engine without them is a no-op.
 */
export function passiveStateLua(unitId) {
    const u = Math.floor(unitId);
    if (!Number.isInteger(u) || u <= 0) throw new Error(`drive_pattern: bad unitId ${unitId}`);
    return `local u = ${u}\n`
        + `if CMD.FIRE_STATE then Spring.GiveOrderToUnit(u, CMD.FIRE_STATE, {0}, 0) end\n`
        + `if CMD.MOVE_STATE then Spring.GiveOrderToUnit(u, CMD.MOVE_STATE, {0}, 0) end\n`
        + `return 'passive'`;
}

/**
 * LuaRules snippet describing the head of a unit's command queue as
 * `<count>:<id>[<params>]#<coded opts> …` — what a non-arrival note quotes,
 * so a queue that was replaced (auto-engage, another gadget, a human) is
 * visible in the tool's reply instead of needing a follow-up exec_lua.
 */
export function queueReportLua(unitId, limit = 4) {
    const u = Math.floor(unitId);
    if (!Number.isInteger(u) || u <= 0) throw new Error(`drive_pattern: bad unitId ${unitId}`);
    const n = Math.max(1, Math.floor(limit));
    return `local cmds = Spring.GetUnitCommands(${u}, ${n}) or {}\n`
        + `local parts = {}\n`
        + `for i, c in ipairs(cmds) do parts[#parts + 1] = tostring(c.id) .. '[' .. table.concat(c.params or {}, ',') .. ']' .. ((c.options and c.options.coded) and ('#' .. tostring(c.options.coded)) or '') end\n`
        + `return #cmds .. ':' .. table.concat(parts, ' ')`;
}

/**
 * The pattern's characteristic size — how far the unit must travel from its
 * origin before it can possibly reach a waypoint. Below `arriveRadius` the
 * tracker can never observe a departure, so the server refuses such a call
 * up front instead of timing out on it.
 */
export function patternSpan(opts = {}) {
    const radius = Number.isFinite(opts.radius) && opts.radius > 0 ? opts.radius : 300;
    const length = Number.isFinite(opts.length) && opts.length > 0 ? opts.length : 300;
    switch (opts.pattern) {
        case 'line': return length / 2;
        case 'zigzag': return Math.max(length / 2, radius);
        default: return radius;
    }
}
