/**
 * Terrain page visibility — the **CPU-computed visible set** of PLAN-maps.md
 * §1.2 v2 streaming.
 *
 * ⚠ **There is deliberately no GPU feedback pass, and this is settled.** The
 * usual virtual-texturing answer renders a page-id buffer and reads it back to
 * learn which pages the frame actually sampled; the Chalmers measurements §1.2
 * cites put that readback at **17-100 ms**, i.e. between one and six frames of
 * budget, and on this client a GPU→CPU sync is the exact failure PLAN-perf M8
 * spent a milestone deleting (the CSM depth-bounds reducer, 27.7 ms of a
 * 31.1 ms render phase). Do not re-litigate it. The visible set is computed
 * analytically instead, from the camera pose and the heightfield.
 *
 * The computation reuses the geometry core PLAN-perf M8 already built and
 * tested for that deletion:
 *
 * - `viewDepthRangeOfBox` — exact `frustum ∩ box` (polytope vertices and
 *   edge/face crossings, not sampling), returning the view-depth slab. A page
 *   whose box misses the frustum returns `null` and is culled.
 * - `HeightRangeGrid.rangeOverRect` — conservative terrain height range over a
 *   world XZ rectangle, off a min/max pyramid built once from the heightmap.
 *   This is the "∩ heightfield" half: a page over a valley the camera looks
 *   *across* is culled by its own low box, not by the map-wide height span.
 *
 * The descent is a quadtree walk from the 1×1 root page down: a node is emitted
 * when its level is already as fine as the nearest visible point of it
 * justifies, and subdivided otherwise. That makes the output naturally
 * multi-resolution — fine pages under the camera, coarse pages at the horizon —
 * and bounds the set without a heuristic cutoff.
 */

import {
    viewDepthRangeOfBox, type ViewFrustum, type WorldBox, type HeightRangeGrid,
} from './shadow-depth-bounds.js';
import {
    type PageGrid, type PageId, keyOf, pageWorldRect,
} from './terrain-page-grid.js';

/** Where a page came from in the descent. */
export type PageWant =
    /** Inside the true frustum — its absence is on screen right now. */
    | 'visible'
    /** Only inside the padded frustum — wanted before the camera turns to it. */
    | 'predicted';

/** One page the frame wants resident. */
export interface DesiredPage {
    readonly id: PageId;
    readonly key: number;
    readonly want: PageWant;
    /** View depth (elmos) of the nearest visible point of this page. */
    readonly depth: number;
    /**
     * Texels this page contributes per screen pixel at `depth`. 1.0 is a
     * perfect match; below 1 the page is blurrier than the screen, above 1 it
     * is finer than needed. The descent stops at the coarsest level ≥ 1.0.
     */
    readonly texelsPerPixel: number;
}

export interface VisiblePagesOptions {
    /** Render height in pixels — sets the world-units-per-pixel scale. */
    viewportHeightPx: number;
    /**
     * Shifts the chosen level. `+1` halves the resident texel density (and
     * roughly quarters the page count); `-1` doubles it. The knob to trade
     * sharpness for residency without touching the descent.
     */
    levelBias?: number;
    /**
     * Hard cap on emitted pages. When the descent would exceed it, remaining
     * nodes are emitted at their current (coarser) level rather than being
     * dropped — a capped frame is blurry, never missing.
     */
    maxPages?: number;
    /**
     * Fraction to widen the frustum by for the `predicted` pass (0.25 = 25 %
     * wider each way). 0 skips the second pass entirely.
     */
    predictPadFrac?: number;
    /**
     * Coarsest-allowed FLOOR on the descent: no page finer than this level is
     * ever desired. The real page producer only ships levels the source
     * resolution covers (PLAN-maps §1.2.1 — `ground_pages.json.finestLevel`),
     * so descending past it would request pages that do not exist and fill
     * cache layers with upsampled blur. 0 (the default) is the full pyramid.
     */
    minLevel?: number;
    /** Vertical slack (elmos) added to every page box, for terrain the height
     *  pyramid quantises away plus anything standing on the ground. */
    heightMargin?: number;
}

const DEFAULT_MAX_PAGES = 256;
const DEFAULT_HEIGHT_MARGIN = 32;

/**
 * World units one screen pixel spans at view depth `d`.
 *
 * A perspective frustum's world half-height at depth `d` is `d / yScale`
 * (that is what `m[5]` of a Babylon projection matrix means, both
 * handednesses — the same reading `ShadowDepthBounds.update` takes), and that
 * half-height maps to half the viewport in pixels.
 */
export function worldUnitsPerPixel(
    depth: number, yScale: number, viewportHeightPx: number,
): number {
    if (!(yScale > 0) || !(viewportHeightPx > 0)) return Infinity;
    return (2 * depth) / (yScale * viewportHeightPx);
}

/**
 * The coarsest pyramid level whose texels are still at least as fine as the
 * screen at `depth`. Clamped into the grid's level range.
 */
export function levelForDepth(
    grid: PageGrid, depth: number, yScale: number, viewportHeightPx: number,
    levelBias = 0,
): number {
    const wpp = worldUnitsPerPixel(depth, yScale, viewportHeightPx);
    if (!isFinite(wpp) || wpp <= 0) return 0;
    const raw = Math.log2(wpp / grid.elmosPerTexel) + levelBias;
    if (!isFinite(raw)) return grid.rootLevel;
    return Math.min(grid.rootLevel, Math.max(0, Math.floor(raw)));
}

/** Widen a frustum's NDC scales — a cheap conservative "where might the camera
 *  be looking in half a second" without predicting the controller. */
function padFrustum(view: ViewFrustum, frac: number): ViewFrustum {
    const k = 1 / (1 + frac);
    return { ...view, xScale: view.xScale * k, yScale: view.yScale * k };
}

/**
 * Compute the page set a frame wants, nearest first.
 *
 * `visible` pages come first (sorted by depth), then `predicted` ones. The
 * caller (`TerrainPageCache`) turns that ordering into Cesium-style priority
 * groups by folding in what is already resident — this function knows nothing
 * about residency, which is what makes it deterministic and testable.
 */
export function computeVisiblePages(
    grid: PageGrid,
    heights: HeightRangeGrid,
    view: ViewFrustum,
    opts: VisiblePagesOptions,
): DesiredPage[] {
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const margin = opts.heightMargin ?? DEFAULT_HEIGHT_MARGIN;
    const minLevel = Math.min(opts.minLevel ?? 0, grid.rootLevel);
    const seen = new Set<number>();
    const out: DesiredPage[] = [];

    const descend = (frustum: ViewFrustum, want: PageWant): void => {
        // Explicit stack: a 16 k map is only 6 levels deep, but recursion here
        // would allocate a frame per node and this runs every frame.
        const stack: PageId[] = [{ level: grid.rootLevel, x: 0, z: 0 }];
        const box: WorldBox = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
        while (stack.length > 0) {
            const id = stack.pop()!;
            const rect = pageWorldRect(grid, id);
            if (rect.x1 <= rect.x0 || rect.z1 <= rect.z0) continue;

            const hr = heights.rangeOverRect(rect.x0, rect.x1, rect.z0, rect.z1);
            box.minX = rect.x0; box.maxX = rect.x1;
            box.minZ = rect.z0; box.maxZ = rect.z1;
            box.minY = hr.min - margin; box.maxY = hr.max + margin;
            const hit = viewDepthRangeOfBox(frustum, box);
            if (!hit) continue;

            const depth = hit.minDepth;
            const wantLevel = Math.max(minLevel, levelForDepth(
                grid, depth, frustum.yScale, opts.viewportHeightPx,
                opts.levelBias ?? 0));

            // Subdivide only while the node is coarser than the screen wants
            // AND the budget allows another four children.
            const capped = out.length + stack.length >= maxPages;
            if (id.level > wantLevel && id.level > 0 && !capped) {
                const L = grid.levels[id.level - 1];
                for (let dz = 0; dz < 2; dz++) {
                    for (let dx = 0; dx < 2; dx++) {
                        const cx = id.x * 2 + dx, cz = id.z * 2 + dz;
                        if (cx < L.pagesX && cz < L.pagesZ) {
                            stack.push({ level: id.level - 1, x: cx, z: cz });
                        }
                    }
                }
                continue;
            }

            const key = keyOf(id);
            if (seen.has(key)) continue;
            seen.add(key);
            const wpp = worldUnitsPerPixel(
                depth, frustum.yScale, opts.viewportHeightPx);
            out.push({
                id, key, want, depth,
                texelsPerPixel: wpp > 0 ? wpp / grid.levels[id.level].texelElmos : 0,
            });
        }
    };

    descend(view, 'visible');
    const pad = opts.predictPadFrac ?? 0;
    if (pad > 0 && out.length < maxPages) descend(padFrustum(view, pad), 'predicted');

    // Visible before predicted, nearest first within each. This is the order
    // the cache turns into priority groups and the order requests are issued.
    out.sort((a, b) =>
        (a.want === b.want ? a.depth - b.depth : (a.want === 'visible' ? -1 : 1)));
    return out.length > maxPages ? out.slice(0, maxPages) : out;
}
