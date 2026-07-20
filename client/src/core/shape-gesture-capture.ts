/**
 * ShapeGestureCapture — pure click/paint gesture state machine for the
 * macro-order shapes (PLAN-macro-ui.md §2 "Painting intent"; wire layout
 * `OrderShape` in `schemas/protocol.fbs`).
 *
 *   Point    → single click.                              params [x,y,z]
 *   Circle   → press-drag radius (same feel as AREA_ATTACK). [x,y,z,radius]
 *   Polygon  → click vertices; click near vertex 0 (or        [x1,y1,z1,...]
 *              `finish()`) closes the ring.
 *   Polyline → click-chain vertices, OR freehand drag          [frontage,
 *              simplified via Douglas-Peucker on release        x1,y1,z1,...]
 *              (`begin('Polyline', {freehand: true})` — both
 *              gestures are supported per PLAN-macro-ui.md §7
 *              open-question-2 resolution "both").
 *   Arrow    → NOT a separate `OrderShape` — the landed schema only has
 *              Point/Circle/Polygon/Polyline (the brainstorm's dedicated
 *              Arrow shape never made it into `protocol.fbs`; `Polyline`'s
 *              leading `frontage` param already carries an arrow's width).
 *              `beginArrow()` is a 2-vertex Polyline convenience: drag
 *              start→end, `setFrontage()` (wheel while dragging) sets the
 *              width, release commits.
 *
 * DELIBERATELY worker-agnostic: no Babylon, no picking, no network. The
 * caller (today: `DirectiveShapeCapture` in the game-processor worker) feeds
 * already-resolved world XYZ (post ground-pick) and reads back preview state
 * to render + a finished result to commit. This is the "shared library, not
 * widget-private" surface PLAN-macro-ui.md §2/§5 asks for — metalstorm-
 * scripting task 4 (map-arm integration) reuses the same class from a native
 * JS widget by driving it through the `gp:armDirectiveShape` /
 * `gp:directiveShapeResult` cross-thread messages (game-worker-protocol.ts)
 * instead of the in-worker hotkey path, without duplicating any gesture
 * logic.
 */

export type ShapeKind = 'Point' | 'Circle' | 'Polygon' | 'Polyline';

export type WorldPoint = readonly [number, number, number];

export interface ShapeCaptureResult {
    shape: ShapeKind;
    /** Wire-ready `OrderShape` params (macro-directives §1 layout). */
    params: number[];
}

export interface ShapeCaptureBeginOpts {
    /** Polyline only: capture every pointer-move as a raw vertex while the
     *  button is held, then Douglas-Peucker-simplify on release, instead of
     *  click-chaining discrete vertices. */
    freehand?: boolean;
}

/// AREA_ATTACK-matching radius clamps (elmos) — same feel, same constants
/// as `worker-command-modes.ts`'s area-attack drag.
const MIN_CIRCLE_RADIUS = 16;
const MAX_CIRCLE_RADIUS = 4096;

/// Click within this world-space radius of vertex 0 closes a Polygon.
const POLYGON_CLOSE_RADIUS = 48;

/// Freehand polyline: minimum world-space spacing between captured raw
/// points (avoids a degenerate point cloud at high pointer-move rates).
const FREEHAND_MIN_SPACING = 24;

/// Default front-line width (elmos) for a fresh Polyline/Arrow capture.
const DEFAULT_FRONTAGE = 128;
const MIN_FRONTAGE = 16;
const MAX_FRONTAGE = 4096;

type Phase = 'idle' | 'dragging-circle' | 'chaining' | 'dragging-freehand' | 'done';

export class ShapeGestureCapture {
    private shape: ShapeKind | null = null;
    private phase: Phase = 'idle';
    private freehand = false;
    private arrowMode = false;

    private vertices: WorldPoint[] = [];
    private circleCenter: WorldPoint | null = null;
    private circleRadius = MIN_CIRCLE_RADIUS;
    private frontage = DEFAULT_FRONTAGE;
    /** Live end-point while an arrow/circle drag is in flight (preview only,
     *  not yet committed to `vertices`). */
    private liveCursor: WorldPoint | null = null;

    /** True while a capture is armed (before or during the gesture). */
    get isArmed(): boolean { return this.shape !== null; }
    get currentShape(): ShapeKind | null { return this.shape; }
    get isFreehand(): boolean { return this.freehand; }

    /** Committed vertices so far, for polyline/polygon preview rendering. */
    get previewVertices(): ReadonlyArray<WorldPoint> {
        if (this.arrowMode && this.vertices.length === 1 && this.liveCursor) {
            return [this.vertices[0], this.liveCursor];
        }
        return this.vertices;
    }

    get previewCircle(): { center: WorldPoint; radius: number } | null {
        return this.circleCenter ? { center: this.circleCenter, radius: this.circleRadius } : null;
    }

    get previewFrontage(): number { return this.frontage; }

    /** Arm a capture. Cancels any capture already in progress. */
    begin(shape: ShapeKind, opts: ShapeCaptureBeginOpts = {}): void {
        this.shape = shape;
        this.freehand = shape === 'Polyline' && !!opts.freehand;
        this.arrowMode = false;
        this.phase = 'chaining';
        this.vertices = [];
        this.circleCenter = null;
        this.circleRadius = MIN_CIRCLE_RADIUS;
        this.frontage = DEFAULT_FRONTAGE;
        this.liveCursor = null;
    }

    /** Arm the 2-vertex-Polyline "arrow" convenience (see file header). */
    beginArrow(): void {
        this.begin('Polyline');
        this.arrowMode = true;
    }

    /** Abandon the in-progress capture without producing a result. Safe to
     *  call when nothing is armed. */
    cancel(): void {
        this.shape = null;
        this.phase = 'idle';
        this.freehand = false;
        this.arrowMode = false;
        this.vertices = [];
        this.circleCenter = null;
        this.liveCursor = null;
    }

    /** Left-press at a resolved world point. Returns true if the gesture is
     *  now complete (call `takeResult()`). */
    pointerDown(p: WorldPoint): boolean {
        if (!this.shape) return false;
        switch (this.shape) {
            case 'Point':
                this.vertices = [p];
                this.phase = 'done';
                return true;

            case 'Circle':
                this.circleCenter = p;
                this.circleRadius = MIN_CIRCLE_RADIUS;
                this.phase = 'dragging-circle';
                return false;

            case 'Polygon': {
                if (this.vertices.length >= 3 && withinXZ(p, this.vertices[0], POLYGON_CLOSE_RADIUS)) {
                    this.phase = 'done';
                    return true;
                }
                this.vertices.push(p);
                return false;
            }

            case 'Polyline':
                if (this.arrowMode) {
                    if (this.vertices.length === 0) {
                        this.vertices.push(p);
                        this.liveCursor = p;
                        this.phase = 'dragging-freehand'; // reuse: "drag in flight"
                        return false;
                    }
                    // A second press while an arrow is already anchored
                    // restarts it at the new point (defensive; the normal
                    // path completes on pointerUp).
                    this.vertices = [p];
                    this.liveCursor = p;
                    return false;
                }
                if (this.freehand) {
                    this.vertices = [p];
                    this.phase = 'dragging-freehand';
                    return false;
                }
                this.vertices.push(p);
                return false;
        }
    }

    /** Pointer move while a capture is armed — updates the live preview
     *  (circle radius, freehand trail, arrow end-point). No-op for the
     *  click-chained shapes between presses. */
    pointerMove(p: WorldPoint): void {
        if (!this.shape) return;
        if (this.shape === 'Circle' && this.circleCenter) {
            const r = Math.hypot(p[0] - this.circleCenter[0], p[2] - this.circleCenter[2]);
            this.circleRadius = clamp(r, MIN_CIRCLE_RADIUS, MAX_CIRCLE_RADIUS);
            return;
        }
        if (this.arrowMode && this.phase === 'dragging-freehand') {
            this.liveCursor = p;
            return;
        }
        if (this.freehand && this.phase === 'dragging-freehand') {
            const last = this.vertices[this.vertices.length - 1];
            if (!last || !withinXZ(p, last, FREEHAND_MIN_SPACING)) this.vertices.push(p);
        }
    }

    /** Left-release. Completes a Circle (press-drag-release), an armed
     *  arrow, or a freehand-polyline drag (simplifying the raw trail).
     *  Click-chained Polygon/Polyline ignore release — they complete via a
     *  subsequent `pointerDown` (close-the-ring) or an explicit `finish()`.
     *  Returns true if a result is now available. */
    pointerUp(): boolean {
        if (this.shape === 'Circle' && this.phase === 'dragging-circle') {
            this.phase = 'done';
            return true;
        }
        if (this.arrowMode && this.phase === 'dragging-freehand') {
            if (this.liveCursor) this.vertices.push(this.liveCursor);
            this.liveCursor = null;
            if (this.vertices.length >= 2) { this.phase = 'done'; return true; }
            this.cancel();
            return false;
        }
        if (this.freehand && this.phase === 'dragging-freehand') {
            this.vertices = simplifyPolyline(this.vertices, FREEHAND_MIN_SPACING) as WorldPoint[];
            if (this.vertices.length >= 2) { this.phase = 'done'; return true; }
            this.cancel();
            return false;
        }
        return false;
    }

    /** Adjust the Polyline/Arrow frontage (front-line width). Driven by the
     *  scroll wheel while a drag is in flight, or a perpendicular-drag
     *  offset the caller has already projected to a width — both map to
     *  "set the number" here (PLAN-macro-ui.md §2 arrow-gesture row). */
    setFrontage(value: number): void {
        this.frontage = clamp(value, MIN_FRONTAGE, MAX_FRONTAGE);
    }

    adjustFrontage(deltaElmos: number): void {
        this.setFrontage(this.frontage + deltaElmos);
    }

    /** Explicit finish for click-chained shapes (Enter key / double-click):
     *  Polyline needs ≥2 vertices, Polygon ≥3 (closes without snapping to
     *  vertex 0). Returns true if a result is now available. */
    finish(): boolean {
        if (this.shape === 'Polyline' && !this.freehand && !this.arrowMode && this.vertices.length >= 2) {
            this.phase = 'done';
            return true;
        }
        if (this.shape === 'Polygon' && this.vertices.length >= 3) {
            this.phase = 'done';
            return true;
        }
        return false;
    }

    get isComplete(): boolean { return this.phase === 'done'; }

    /** Consume the finished shape as wire-ready `OrderShape` params. Returns
     *  null (and disarms) if called before `isComplete`. Re-arms to `idle`
     *  after consuming — the caller must `begin()` again for the next
     *  directive. */
    takeResult(): ShapeCaptureResult | null {
        if (this.phase !== 'done' || !this.shape) return null;
        const shape = this.shape;
        let params: number[];
        switch (shape) {
            case 'Point':
                params = [...this.vertices[0]];
                break;
            case 'Circle':
                params = this.circleCenter ? [...this.circleCenter, this.circleRadius] : [];
                break;
            case 'Polygon':
                params = this.vertices.flatMap((v) => [v[0], v[1], v[2]]);
                break;
            case 'Polyline':
                params = [this.frontage, ...this.vertices.flatMap((v) => [v[0], v[1], v[2]])];
                break;
        }
        this.cancel();
        return { shape, params };
    }
}

function withinXZ(a: WorldPoint, b: WorldPoint, radius: number): boolean {
    return Math.hypot(a[0] - b[0], a[2] - b[2]) <= radius;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

/**
 * Douglas-Peucker polyline simplification (PLAN-macro-ui.md §2: "freehand-
 * drag that gets simplified to a polyline"). Distance test is XZ-only
 * (directive shapes are near-flat ground paths); Y rides along with
 * whichever endpoint survives simplification. `epsilon` in world units
 * (elmos) — larger simplifies more aggressively.
 */
export function simplifyPolyline(
    points: ReadonlyArray<WorldPoint>,
    epsilon: number,
): WorldPoint[] {
    if (points.length < 3) return points.slice();
    let maxDist = 0;
    let maxIndex = 0;
    const [x0, , z0] = points[0];
    const [x1, , z1] = points[points.length - 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const segLenSq = dx * dx + dz * dz;
    for (let i = 1; i < points.length - 1; i++) {
        const [px, , pz] = points[i];
        let dist: number;
        if (segLenSq === 0) {
            dist = Math.hypot(px - x0, pz - z0);
        } else {
            const t = clamp(((px - x0) * dx + (pz - z0) * dz) / segLenSq, 0, 1);
            dist = Math.hypot(px - (x0 + t * dx), pz - (z0 + t * dz));
        }
        if (dist > maxDist) { maxDist = dist; maxIndex = i; }
    }
    if (maxDist > epsilon) {
        const left = simplifyPolyline(points.slice(0, maxIndex + 1), epsilon);
        const right = simplifyPolyline(points.slice(maxIndex), epsilon);
        return [...left.slice(0, -1), ...right];
    }
    return [points[0], points[points.length - 1]];
}
