/**
 * MetalSpotMap — discovers metal extraction sites from the raw metal map.
 *
 * The map ships a per-square density grid (`metalmap`, 0..255) at half the
 * heightmap resolution: each cell covers a 16-elmo square. Metal spots are
 * connected components of non-zero cells. Each spot's centroid (in world
 * elmos, weighted by density) is the canonical build position for an
 * extractor that wants to harvest it.
 *
 * Used by InputManager during ghost placement of metal extractors
 * (UnitDef.extractsMetal > 0): the cursor snaps to the nearest spot within
 * a search radius, and the ghost is tinted red when no spot is in range so
 * the player can see the placement won't actually extract anything.
 */

export interface MetalSpot {
    /** World-space centroid X (elmos). */
    x: number;
    /** World-space centroid Z (elmos). */
    z: number;
    /** Sum of metalmap densities in the cluster. Higher = richer spot. */
    totalMetal: number;
    /** Approximate radius in elmos covering the cluster — half the
     *  bounding-box diagonal of cells in the spot. */
    radius: number;
}

/**
 * Cluster the metal map into discrete spots by 4-way flood fill.
 *
 * @param metalmap   Per-square density (0..255) in row-major order.
 * @param mmWidth    Cells per row of the metal map (typically mapx/2).
 * @param mmHeight   Cells per column (mapy/2).
 * @param cellSize   World elmos per metalmap cell (typically 16).
 * @returns          One MetalSpot per connected component of non-zero cells.
 */
export function findMetalSpots(
    metalmap: Uint8Array,
    mmWidth: number,
    mmHeight: number,
    cellSize = 16,
): MetalSpot[] {
    if (metalmap.length === 0 || mmWidth <= 0 || mmHeight <= 0) return [];
    const visited = new Uint8Array(metalmap.length);
    const spots: MetalSpot[] = [];

    // Reusable BFS stack — avoids per-cluster allocation churn on large maps.
    const stack: number[] = [];

    for (let y = 0; y < mmHeight; y++) {
        for (let x = 0; x < mmWidth; x++) {
            const idx = y * mmWidth + x;
            if (visited[idx] || metalmap[idx] === 0) continue;

            // Flood-fill the connected component starting at (x,y). Track
            // the density-weighted centroid and the cell bounding box.
            let sumX = 0, sumZ = 0, sumW = 0;
            let minCx = x, maxCx = x, minCy = y, maxCy = y;
            stack.length = 0;
            stack.push(idx);
            visited[idx] = 1;

            while (stack.length > 0) {
                const k = stack.pop() as number;
                const cy = (k / mmWidth) | 0;
                const cx = k - cy * mmWidth;
                const w = metalmap[k];
                sumX += (cx + 0.5) * w;
                sumZ += (cy + 0.5) * w;
                sumW += w;
                if (cx < minCx) minCx = cx;
                if (cx > maxCx) maxCx = cx;
                if (cy < minCy) minCy = cy;
                if (cy > maxCy) maxCy = cy;

                // 4-connectivity. Diagonal cells often belong to the same
                // logical spot in Spring maps but the engine itself treats
                // metal in 4-connected steps, so match that.
                if (cx > 0) {
                    const n = k - 1;
                    if (!visited[n] && metalmap[n] > 0) { visited[n] = 1; stack.push(n); }
                }
                if (cx + 1 < mmWidth) {
                    const n = k + 1;
                    if (!visited[n] && metalmap[n] > 0) { visited[n] = 1; stack.push(n); }
                }
                if (cy > 0) {
                    const n = k - mmWidth;
                    if (!visited[n] && metalmap[n] > 0) { visited[n] = 1; stack.push(n); }
                }
                if (cy + 1 < mmHeight) {
                    const n = k + mmWidth;
                    if (!visited[n] && metalmap[n] > 0) { visited[n] = 1; stack.push(n); }
                }
            }

            if (sumW === 0) continue;
            const cx = (sumX / sumW) * cellSize;
            const cz = (sumZ / sumW) * cellSize;
            // Half-diagonal of the bounding box gives a reasonable radius
            // even for elongated/L-shaped metal patches.
            const halfW = ((maxCx - minCx + 1) * cellSize) * 0.5;
            const halfH = ((maxCy - minCy + 1) * cellSize) * 0.5;
            const radius = Math.hypot(halfW, halfH);
            spots.push({ x: cx, z: cz, totalMetal: sumW, radius });
        }
    }

    return spots;
}

/**
 * Marker radius (world elmos) for a metal spot on the minimap overlay
 * (PLAN-playable.md G4). Scales with the square root of the cluster's
 * summed density so a handful of unusually rich spots don't dwarf the rest
 * of the map, clamped to stay legible at both ends of the range.
 */
export function metalSpotMarkerRadius(totalMetal: number): number {
    return Math.max(20, Math.min(90, 20 + Math.sqrt(Math.max(0, totalMetal)) * 3));
}

/**
 * Find the nearest metal spot to a world-space point, within a search radius.
 * Returns null when no spot is close enough — the caller can use that to tint
 * the build ghost red and reject the placement.
 *
 * `searchRadius` should reflect the extractor's effective influence: in Spring
 * an extractor with `extractsMetal > 0` harvests cells within its
 * `extractRange`, so we use that (multiplied by a small fudge factor to
 * tolerate the player clicking just off-centre).
 */
export function nearestMetalSpot(
    spots: readonly MetalSpot[],
    x: number,
    z: number,
    searchRadius: number,
): MetalSpot | null {
    let best: MetalSpot | null = null;
    let bestDistSq = searchRadius * searchRadius;
    for (const s of spots) {
        const dx = s.x - x;
        const dz = s.z - z;
        const d = dx * dx + dz * dz;
        if (d < bestDistSq) {
            bestDistSq = d;
            best = s;
        }
    }
    return best;
}
