import { describe, it, expect } from 'vitest';
import { ShapeGestureCapture, simplifyPolyline } from './shape-gesture-capture.js';

/**
 * ShapeGestureCapture (PLAN-macro-ui.md §2) is a pure, environment-agnostic
 * state machine — no Babylon, no picking, no network — so it's fully
 * testable off already-resolved world XYZ, exactly as the shared-library
 * mandate (metalstorm-scripting task 4 reuses the same class) intends.
 */
describe('ShapeGestureCapture', () => {
    it('Point completes on the first press', () => {
        const c = new ShapeGestureCapture();
        c.begin('Point');
        expect(c.isComplete).toBe(false);
        const done = c.pointerDown([10, 0, 20]);
        expect(done).toBe(true);
        expect(c.isComplete).toBe(true);
        expect(c.takeResult()).toEqual({ shape: 'Point', params: [10, 0, 20] });
        // takeResult() disarms
        expect(c.isArmed).toBe(false);
    });

    it('Circle completes on press-drag-release, radius clamped to the AREA_ATTACK band', () => {
        const c = new ShapeGestureCapture();
        c.begin('Circle');
        expect(c.pointerDown([0, 0, 0])).toBe(false);
        c.pointerMove([5000, 0, 0]); // way past MAX_CIRCLE_RADIUS
        expect(c.previewCircle?.radius).toBe(4096);
        c.pointerMove([10, 0, 0]); // below MIN_CIRCLE_RADIUS
        expect(c.previewCircle?.radius).toBe(16);
        const done = c.pointerUp();
        expect(done).toBe(true);
        expect(c.takeResult()).toEqual({ shape: 'Circle', params: [0, 0, 0, 16] });
    });

    it('Polygon closes on a click near vertex 0 (min 3 vertices)', () => {
        const c = new ShapeGestureCapture();
        c.begin('Polygon');
        expect(c.pointerDown([0, 0, 0])).toBe(false);
        expect(c.pointerDown([100, 0, 0])).toBe(false);
        // too few vertices — a click near vertex 0 here is just vertex 3, not a close
        expect(c.pointerDown([0, 0, 0])).toBe(false);
        expect(c.pointerDown([0, 0, 100])).toBe(false);
        // now ≥3 vertices exist — a click within POLYGON_CLOSE_RADIUS of vertex 0 closes it
        const closed = c.pointerDown([2, 0, 1]);
        expect(closed).toBe(true);
        const result = c.takeResult();
        expect(result?.shape).toBe('Polygon');
        expect(result?.params).toEqual([0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 100]);
    });

    it('Polygon finish() closes early without snapping to vertex 0 (needs ≥3 vertices)', () => {
        const c = new ShapeGestureCapture();
        c.begin('Polygon');
        c.pointerDown([0, 0, 0]);
        c.pointerDown([50, 0, 0]);
        expect(c.finish()).toBe(false); // only 2 vertices
        c.pointerDown([50, 0, 50]);
        expect(c.finish()).toBe(true);
        expect(c.takeResult()?.params).toEqual([0, 0, 0, 50, 0, 0, 50, 0, 50]);
    });

    it('Polyline click-chains vertices and finishes via finish() (≥2 vertices), carrying frontage', () => {
        const c = new ShapeGestureCapture();
        c.begin('Polyline');
        c.pointerDown([0, 0, 0]);
        expect(c.finish()).toBe(false); // only 1 vertex
        c.pointerDown([100, 0, 0]);
        c.setFrontage(256);
        expect(c.finish()).toBe(true);
        expect(c.takeResult()).toEqual({ shape: 'Polyline', params: [256, 0, 0, 0, 100, 0, 0] });
    });

    it('Polyline freehand drag simplifies the trail on release', () => {
        const c = new ShapeGestureCapture();
        c.begin('Polyline', { freehand: true });
        expect(c.isFreehand).toBe(true);
        c.pointerDown([0, 0, 0]);
        // a straight line — Douglas-Peucker should collapse intermediate points
        for (let x = 30; x <= 300; x += 30) c.pointerMove([x, 0, 0]);
        const done = c.pointerUp();
        expect(done).toBe(true);
        const result = c.takeResult();
        expect(result?.shape).toBe('Polyline');
        // frontage (params[0]) + collapsed straight-line endpoints only
        expect(result?.params.length).toBe(1 + 2 * 3);
    });

    it('freehand release with a degenerate (too-short) trail cancels instead of completing', () => {
        const c = new ShapeGestureCapture();
        c.begin('Polyline', { freehand: true });
        c.pointerDown([0, 0, 0]);
        // no movement past FREEHAND_MIN_SPACING before release
        expect(c.pointerUp()).toBe(false);
        expect(c.isArmed).toBe(false);
    });

    it('beginArrow captures a 2-vertex drag and setFrontage/adjustFrontage clamp', () => {
        const c = new ShapeGestureCapture();
        c.beginArrow();
        expect(c.currentShape).toBe('Polyline');
        c.pointerDown([0, 0, 0]);
        c.pointerMove([200, 0, 0]);
        expect(c.previewVertices).toEqual([[0, 0, 0], [200, 0, 0]]);
        c.adjustFrontage(100000); // clamps to MAX_FRONTAGE
        const done = c.pointerUp();
        expect(done).toBe(true);
        const result = c.takeResult();
        expect(result?.shape).toBe('Polyline');
        expect(result?.params).toEqual([4096, 0, 0, 0, 200, 0, 0]);
    });

    it('an arrow drag that never moves off the anchor still completes (degenerate 2-point arrow)', () => {
        const c = new ShapeGestureCapture();
        c.beginArrow();
        c.pointerDown([0, 0, 0]);
        // liveCursor === the anchor itself (no pointerMove happened) — the
        // committed vertex list is [anchor, anchor], which is still ≥2, so
        // release completes rather than cancelling (only <2 vertices cancel).
        expect(c.pointerUp()).toBe(true);
        expect(c.takeResult()?.params).toEqual([128, 0, 0, 0, 0, 0, 0]);
    });

    it('cancel() abandons an in-progress capture without a result', () => {
        const c = new ShapeGestureCapture();
        c.begin('Polygon');
        c.pointerDown([0, 0, 0]);
        c.pointerDown([1, 0, 1]);
        c.cancel();
        expect(c.isArmed).toBe(false);
        expect(c.isComplete).toBe(false);
        expect(c.takeResult()).toBeNull();
    });

    it('begin() re-arms and discards a stale in-progress capture', () => {
        const c = new ShapeGestureCapture();
        c.begin('Polygon');
        c.pointerDown([0, 0, 0]);
        c.pointerDown([1, 0, 1]);
        c.begin('Point'); // re-arm mid-capture
        expect(c.currentShape).toBe('Point');
        expect(c.previewVertices).toEqual([]);
        expect(c.pointerDown([5, 0, 5])).toBe(true);
    });
});

describe('simplifyPolyline (Douglas-Peucker, XZ-only)', () => {
    it('collapses collinear points to their endpoints', () => {
        const points: [number, number, number][] = [
            [0, 0, 0], [10, 0, 0], [20, 0, 0], [30, 0, 0],
        ];
        expect(simplifyPolyline(points, 1)).toEqual([[0, 0, 0], [30, 0, 0]]);
    });

    it('keeps a point that deviates past epsilon', () => {
        const points: [number, number, number][] = [
            [0, 0, 0], [10, 0, 50], [20, 0, 0],
        ];
        expect(simplifyPolyline(points, 5)).toEqual(points);
    });

    it('passes through fewer than 3 points unchanged', () => {
        const points: [number, number, number][] = [[0, 0, 0], [10, 0, 0]];
        expect(simplifyPolyline(points, 1)).toEqual(points);
    });
});
