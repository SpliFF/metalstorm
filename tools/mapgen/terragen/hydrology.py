"""Hydrology: depression filling, D8 flow routing, accumulation, rivers.

Everything is vectorized numpy, except `resolve_flats` and `d8_receivers`
which are numba `@njit` kernels (PLAN-maps.md §2b item 1 — profiling showed
`resolve_flats` dominates the per-iteration LEM cost by ~1-2 orders of
magnitude over everything else it calls alongside, ~22-25s/iter @2049² vs
~1-2s for `fill_depressions` and <1s for the rest combined, so it was pulled
into the numba port even though it lives outside erosion.py). The one
algorithm that is naturally serial (downstream accumulation / upstream
solves) is handled with *level-order processing*: cells are grouped by their
depth in the flow (receiver) tree and each level is processed as one
vectorized operation. Tree depth on a 2k x 2k map is a few thousand, so
passes stay cheap.

Grid convention: elevation arrays are (H, W) float64, row-major, cell index
i = r * W + c. D8 receivers point to the steepest-descent neighbour
(diagonals use distance sqrt(2)); outlet/pit cells receive themselves.

`resolve_flats` is also an algorithmic win, not just a JIT one: the original
formulation re-scans the *entire* grid every BFS ring (dilate-and-mask over
the full (H, W) boolean arrays, repeated once per step of the wavefront).
The numba version walks an explicit frontier queue, touching each flat cell
exactly once — O(#flat cells) total instead of O(steps x H x W). Both
compute the exact same distance-labelling (same 8-neighbour adjacency, same
BFS order, same off-by-one "unreached cells get the final step count" edge
case), so output is byte-identical; see
`tools/mapgen/terragen/_selftest_numba.py`.
"""
from __future__ import annotations

import numpy as np
from numba import njit, prange

# D8 neighbour offsets (dr, dc) and distances
_D8 = np.array(
    [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)],
    dtype=np.int64,
)
_D8_DIST = np.array([np.sqrt(2), 1, np.sqrt(2), 1, 1, np.sqrt(2), 1, np.sqrt(2)])

# Same 8 directions, unzipped to flat int64 arrays for the numba kernels
# below (and reused by erosion.py's thermal_erode, which needs identical
# ordering for bit-identical tie-breaks/summation order).
_D8_DR = np.ascontiguousarray(_D8[:, 0])
_D8_DC = np.ascontiguousarray(_D8[:, 1])


def fill_depressions(dem: np.ndarray) -> np.ndarray:
    """Fill closed depressions to their spill level (morphological
    reconstruction by erosion, seeded from the border). Lakes are re-detected
    afterwards as filled-above-original areas."""
    from skimage.morphology import reconstruction

    seed = np.full_like(dem, dem.max())
    seed[0, :] = dem[0, :]
    seed[-1, :] = dem[-1, :]
    seed[:, 0] = dem[:, 0]
    seed[:, -1] = dem[:, -1]
    return reconstruction(seed, dem, method="erosion").astype(dem.dtype)


@njit(cache=True)
def _resolve_flats_kernel(filled: np.ndarray, epsilon: float) -> np.ndarray:
    H, W = filled.shape

    # A cell is "flat-stuck" if no 8-neighbour is strictly lower. Border
    # cells always drain off-map (has_lower forced True => never flat), so
    # only interior cells need the neighbour scan.
    flat = np.zeros((H, W), dtype=np.bool_)
    for r in range(1, H - 1):
        for c in range(1, W - 1):
            v = filled[r, c]
            has_lower = False
            for k in range(8):
                if filled[r + _D8_DR[k], c + _D8_DC[k]] < v:
                    has_lower = True
                    break
            flat[r, c] = not has_lower

    any_flat = False
    for r in range(H):
        for c in range(W):
            if flat[r, c]:
                any_flat = True
                break
        if any_flat:
            break
    if not any_flat:
        return filled.copy()

    # Initial frontier (distance 1): flat cells adjacent to a non-flat
    # neighbour with elevation <= this cell's (an actual drain point).
    # Out-of-bounds neighbours count as non-flat (matches the original's
    # constant-False-padded flat mask) but never arise for in-bounds flat
    # cells since border cells are never flat.
    init_r = np.empty(H * W, dtype=np.int64)
    init_c = np.empty(H * W, dtype=np.int64)
    n_init = 0
    for r in range(H):
        for c in range(W):
            if not flat[r, c]:
                continue
            v = filled[r, c]
            near_drain = False
            for k in range(8):
                nr = r + _D8_DR[k]
                nc = c + _D8_DC[k]
                if nr < 0 or nr >= H or nc < 0 or nc >= W:
                    nb_flat = False
                    nb_elev = v
                else:
                    nb_flat = flat[nr, nc]
                    nb_elev = filled[nr, nc]
                if (not nb_flat) and nb_elev <= v:
                    near_drain = True
                    break
            if near_drain:
                init_r[n_init] = r
                init_c[n_init] = c
                n_init += 1

    visited = np.zeros((H, W), dtype=np.bool_)
    dist = np.zeros((H, W), dtype=np.int32)
    for i in range(n_init):
        visited[init_r[i], init_c[i]] = True

    cur_r = init_r[:n_init].copy()
    cur_c = init_c[:n_init].copy()
    step = 1
    final_step = step
    max_steps = H + W

    while cur_r.size > 0:
        for i in range(cur_r.size):
            dist[cur_r[i], cur_c[i]] = step

        cap = cur_r.size * 8
        nxt_r = np.empty(cap, dtype=np.int64)
        nxt_c = np.empty(cap, dtype=np.int64)
        n_nxt = 0
        for i in range(cur_r.size):
            r = cur_r[i]
            c = cur_c[i]
            for k in range(8):
                nr = r + _D8_DR[k]
                nc = c + _D8_DC[k]
                if nr < 0 or nr >= H or nc < 0 or nc >= W:
                    continue
                if flat[nr, nc] and not visited[nr, nc]:
                    visited[nr, nc] = True
                    nxt_r[n_nxt] = nr
                    nxt_c[n_nxt] = nc
                    n_nxt += 1

        step += 1
        if step > max_steps:
            final_step = step
            cur_r = np.empty(0, dtype=np.int64)
            cur_c = np.empty(0, dtype=np.int64)
            break
        cur_r = nxt_r[:n_nxt].copy()
        cur_c = nxt_c[:n_nxt].copy()
        final_step = step

    out = np.empty((H, W), dtype=filled.dtype)
    for r in range(H):
        for c in range(W):
            d = dist[r, c]
            if flat[r, c] and not visited[r, c]:
                d = final_step
            out[r, c] = filled[r, c] + epsilon * d
    return out


def resolve_flats(filled: np.ndarray, epsilon: float = 1e-4) -> np.ndarray:
    """Impose a tiny drainage gradient across flat areas (incl. filled
    depressions) so D8 routing never stalls.

    Vectorized wavefront BFS (numba): start from flat cells that touch
    strictly lower ground ("outlets"), sweep inward, each wave adding
    `epsilon` elevation. Returns a routing elevation (filled + epsilon *
    wave-distance); use it for flow routing only, never as display/collision
    terrain.
    """
    return _resolve_flats_kernel(np.ascontiguousarray(filled), epsilon)


@njit(cache=True, parallel=True)
def _d8_receivers_kernel(elev: np.ndarray) -> np.ndarray:
    H, W = elev.shape
    best_idx = np.empty(H * W, dtype=np.int64)
    for r in prange(H):
        for c in range(W):
            self_idx = r * W + c
            v = elev[r, c]
            best_slope = 0.0
            best = self_idx
            for k in range(8):
                nr = r + _D8_DR[k]
                nc = c + _D8_DC[k]
                if nr < 0 or nr >= H or nc < 0 or nc >= W:
                    continue
                slope = (v - elev[nr, nc]) / _D8_DIST[k]
                if slope > best_slope:
                    best_slope = slope
                    best = nr * W + nc
            best_idx[self_idx] = best
    return best_idx


def d8_receivers(elev: np.ndarray) -> np.ndarray:
    """Steepest-descent D8 receiver for each cell, as flat indices.

    Cells with no lower neighbour (pits — after filling these are only map
    borders / lake spill cells) receive themselves.
    """
    return _d8_receivers_kernel(np.ascontiguousarray(elev))


def topo_levels(receivers: np.ndarray) -> list[np.ndarray]:
    """Group cells by depth in the receiver forest for level-order processing.

    Level 0 = roots (cells that receive themselves: outlets/pits). Level k =
    cells whose receiver is in level k-1. Every cell appears exactly once.
    Processing level 0..N in order guarantees a cell's receiver was processed
    first (for upstream->downstream solves); reverse for accumulation.
    """
    n = receivers.size
    depth = np.full(n, -1, dtype=np.int32)
    roots = receivers == np.arange(n, dtype=receivers.dtype)
    depth[roots] = 0
    levels = [np.flatnonzero(roots)]
    current = levels[0]
    # donors: invert the receiver relation once
    order = np.argsort(receivers, kind="stable")
    sorted_recv = receivers[order]
    starts = np.searchsorted(sorted_recv, np.arange(n))
    ends = np.searchsorted(sorted_recv, np.arange(n), side="right")

    while current.size:
        s = starts[current]
        e = ends[current]
        if int((e - s).sum()) == 0:
            break
        nxt = _gather_ranges(order, s, e)
        nxt = nxt[depth[nxt] == -1]  # roots receive themselves; skip
        if nxt.size == 0:
            break
        depth[nxt] = len(levels)
        levels.append(nxt)
        current = nxt
    return levels


def _gather_ranges(order: np.ndarray, starts: np.ndarray, ends: np.ndarray) -> np.ndarray:
    """Concatenate order[starts[i]:ends[i]] for all i, vectorized."""
    lens = ends - starts
    total = int(lens.sum())
    cum = np.concatenate([[0], np.cumsum(lens)[:-1]])
    ramp = np.arange(total, dtype=np.int64) - np.repeat(cum, lens)
    src = np.repeat(starts, lens) + ramp
    return order[src]


def flow_accumulation(
    receivers: np.ndarray,
    levels: list[np.ndarray],
    weights: np.ndarray | None = None,
) -> np.ndarray:
    """Number of upstream cells (+1 for self), or weighted rainfall sum.

    Processes levels deepest-first so every donor is finalized before its
    receiver accumulates it.
    """
    n = receivers.size
    accum = (
        np.ones(n, dtype=np.float64)
        if weights is None
        else weights.ravel().astype(np.float64).copy()
    )
    for lvl in reversed(levels[1:]):  # roots have no receiver to push into
        np.add.at(accum, receivers[lvl], accum[lvl])
    return accum


def river_network(
    accum: np.ndarray,
    shape: tuple[int, int],
    threshold: float,
) -> np.ndarray:
    """Boolean river mask: cells whose accumulation exceeds `threshold`."""
    return (accum >= threshold).reshape(shape)


def flow_path_lengths(
    receivers: np.ndarray, levels: list[np.ndarray], W: int, cellsize: float
) -> np.ndarray:
    """Per-cell downstream distance to its root, in world units."""
    n = receivers.size
    idx = np.arange(n, dtype=np.int64)
    rr = receivers
    drow = np.abs(idx // W - rr // W)
    dcol = np.abs(idx % W - rr % W)
    step = np.where((drow + dcol) == 2, np.sqrt(2.0), 1.0) * cellsize
    step[rr == idx] = 0.0

    dist = np.zeros(n, dtype=np.float64)
    for lvl in levels[1:]:  # roots stay 0
        dist[lvl] = dist[receivers[lvl]] + step[lvl]
    return dist
