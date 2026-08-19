"""Hydrology: depression filling, D8/D-infinity/MFD flow routing, accumulation.

Channel extraction lives in `rivers.py`, not here: the bare accumulation
threshold this module used to expose as `river_network` produced a *dotted*
network (a low-gradient reach drops under the threshold and the channel
vanishes), and every caller then had to re-derive the same slope-area seeding
and downstream closure. Removed 2026-08-08 with the river-ribbon stage.

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

**Two routers, and they use two different data structures.** D8 gives every
cell exactly one receiver, so it is carried as an `int64[n]` receiver array
plus `topo_levels`. D-infinity and MFD give a cell *several* receivers with
fractional weights, which is a DAG rather than a forest, so they are carried
as a `float32[H, W, 8]` weight array — one weight per `_D8` direction, zero
where no flow goes that way, no index array needed because the direction
*is* the index (PLAN-maps M8q). `flow_weights(..., router="d8")` emits the
one-hot form of the D8 answer, so the multi-receiver machinery can reproduce
the single-receiver answer exactly; `tests/test_flow_routers.py` gates that.

The DAG needs no level grouping: every receiver is *strictly lower* on the
routing surface, so ascending routing elevation is already a topological
order (`flow_order`). Walk it forwards for upstream->downstream solves,
backwards for accumulation.

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


# --------------------------------------------------------------------------
# Multiple-flow-direction routers (D-infinity / MFD)
# --------------------------------------------------------------------------
#
# Tarboton (1997) D-infinity facets. Each facet is a triangle (centre,
# cardinal neighbour, adjacent diagonal neighbour); the eight of them tile
# the cell's neighbourhood. Indices are into `_D8` above:
#   0 NW   1 N   2 NE   3 W   4 E   5 SW   6 S   7 SE
_DINF_CARD = np.array([4, 1, 1, 3, 3, 6, 6, 4], dtype=np.int64)
_DINF_DIAG = np.array([2, 2, 0, 0, 5, 5, 7, 7], dtype=np.int64)
_PI_4 = np.pi / 4.0


@njit(cache=True, parallel=True)
def _dinf_weights_kernel(elev: np.ndarray) -> np.ndarray:
    """D-infinity weights, `(H, W, 8)` float32, in `_D8` direction order.

    `cellsize` cancels: only the *ratio* s2/s1 sets the facet angle, and the
    steepest-facet comparison is scale-free as long as every facet uses the
    same cell size. So this kernel works in cell units (d1 = 1, d2 = 1).
    """
    H, W = elev.shape
    out = np.zeros((H, W, 8), dtype=np.float32)
    for r in prange(H):
        for c in range(W):
            e0 = elev[r, c]
            best_s = 0.0
            best_f = -1
            best_ang = 0.0
            for f in range(8):
                kc = _DINF_CARD[f]
                kd = _DINF_DIAG[f]
                r1 = r + _D8_DR[kc]
                c1 = c + _D8_DC[kc]
                r2 = r + _D8_DR[kd]
                c2 = c + _D8_DC[kd]
                if r1 < 0 or r1 >= H or c1 < 0 or c1 >= W:
                    continue
                if r2 < 0 or r2 >= H or c2 < 0 or c2 >= W:
                    continue
                e1 = elev[r1, c1]
                e2 = elev[r2, c2]
                s1 = e0 - e1                 # / d1, d1 = 1
                s2 = e1 - e2                 # / d2, d2 = 1
                ang = np.arctan2(s2, s1)
                if ang < 0.0:
                    ang = 0.0
                    s = s1
                elif ang > _PI_4:
                    ang = _PI_4
                    s = (e0 - e2) / np.sqrt(2.0)
                else:
                    s = np.sqrt(s1 * s1 + s2 * s2)
                if s > best_s:
                    best_s = s
                    best_f = f
                    best_ang = ang
            if best_f < 0:
                continue                     # pit / outlet: no receiver
            frac = best_ang / _PI_4
            out[r, c, _DINF_CARD[best_f]] = np.float32(1.0 - frac)
            out[r, c, _DINF_DIAG[best_f]] = np.float32(frac)
    return out


@njit(cache=True, parallel=True)
def _mfd_weights_kernel(elev: np.ndarray, p: float) -> np.ndarray:
    """Freeman (1991) MFD weights, `(H, W, 8)` float32: every downslope
    neighbour gets a share proportional to `slope**p`. `cellsize` cancels for
    the same reason as above (it divides every slope equally)."""
    H, W = elev.shape
    out = np.zeros((H, W, 8), dtype=np.float32)
    for r in prange(H):
        for c in range(W):
            e0 = elev[r, c]
            total = 0.0
            raw = np.zeros(8, dtype=np.float64)
            for k in range(8):
                nr = r + _D8_DR[k]
                nc = c + _D8_DC[k]
                if nr < 0 or nr >= H or nc < 0 or nc >= W:
                    continue
                slope = (e0 - elev[nr, nc]) / _D8_DIST[k]
                if slope <= 0.0:
                    continue
                v = slope ** p
                raw[k] = v
                total += v
            if total <= 0.0:
                continue                     # pit / outlet: no receiver
            for k in range(8):
                if raw[k] > 0.0:
                    out[r, c, k] = np.float32(raw[k] / total)
    return out


@njit(cache=True, parallel=True)
def _d8_weights_kernel(elev: np.ndarray) -> np.ndarray:
    """The D8 answer in the multi-receiver representation (one-hot).

    Deliberately re-derives the steepest neighbour with the *same* scan order
    and the same `slope > best_slope` strict comparison as
    `_d8_receivers_kernel`, so the tie-break matches and the two routers are
    provably the same graph — that equivalence is what makes `router="d8"` a
    control arm rather than a second implementation.
    """
    H, W = elev.shape
    out = np.zeros((H, W, 8), dtype=np.float32)
    for r in prange(H):
        for c in range(W):
            v = elev[r, c]
            best_slope = 0.0
            best_k = -1
            for k in range(8):
                nr = r + _D8_DR[k]
                nc = c + _D8_DC[k]
                if nr < 0 or nr >= H or nc < 0 or nc >= W:
                    continue
                slope = (v - elev[nr, nc]) / _D8_DIST[k]
                if slope > best_slope:
                    best_slope = slope
                    best_k = k
            if best_k >= 0:
                out[r, c, best_k] = np.float32(1.0)
    return out


ROUTERS = ("d8", "dinf", "mfd")


def flow_weights(
    elev: np.ndarray, router: str = "dinf", mfd_p: float = 1.1
) -> np.ndarray:
    """Fractional flow weights per `_D8` direction, `(H, W, 8)` float32.

    `router`:
      * `"d8"`   — one-hot steepest descent (the control arm; identical graph
                   to `d8_receivers`).
      * `"dinf"` — Tarboton D-infinity: flow leaves at a continuous angle and
                   is split between the two neighbours bracketing it, so the
                   direction field is not quantised to 45 degrees.
      * `"mfd"`  — Freeman multiple-flow-direction, share ~ `slope**mfd_p`.
                   Disperses across every downslope neighbour.

    Feed this the *routing* surface (`resolve_flats(fill_depressions(h))`),
    never raw terrain: a cell with no strictly-lower neighbour gets an
    all-zero row and becomes a root, exactly as `d8_receivers` makes it
    receive itself.

    Why this exists: PLAN-maps M8p measured a converged D8 stream-power
    landscape at **5.27x** angular energy concentration over the 32-120 elmo
    band against a shipped map's 1.24 — parallel herringbone spurs, because a
    solver asked to build a channel network from nothing builds it on the
    lattice it routes over. Six knobs on the D8 arm all missed by 2x or more.
    The router is the lattice.
    """
    if router not in ROUTERS:
        raise ValueError(f"unknown router {router!r}, expected one of {ROUTERS}")
    e = np.ascontiguousarray(np.asarray(elev, dtype=np.float64))
    if router == "d8":
        return _d8_weights_kernel(e)
    if router == "dinf":
        return _dinf_weights_kernel(e)
    return _mfd_weights_kernel(e, float(mfd_p))


def flow_order(routing_elev: np.ndarray) -> np.ndarray:
    """Topological order (flat indices) for a weight-array flow graph.

    Ascending routing elevation. Every receiver is strictly lower than its
    donor by construction, so a receiver always sorts earlier: walk forwards
    for downstream-first solves, `[::-1]` for accumulation. This replaces
    `topo_levels` for the multi-receiver routers, where the receiver relation
    is a DAG and level-order grouping would need a longest-path pass.
    """
    return np.argsort(np.asarray(routing_elev).ravel(), kind="stable")


@njit(cache=True)
def _accum_multi_kernel(
    w: np.ndarray, order: np.ndarray, accum: np.ndarray, W: int
) -> None:
    for i in range(order.size - 1, -1, -1):
        cell = order[i]
        r = cell // W
        c = cell - r * W
        a = accum[cell]
        for k in range(8):
            wt = w[r, c, k]
            if wt > 0.0:
                accum[(r + _D8_DR[k]) * W + (c + _D8_DC[k])] += a * wt


def flow_accumulation_multi(
    w: np.ndarray, order: np.ndarray, weights: np.ndarray | None = None
) -> np.ndarray:
    """Weighted upstream cell count for a `(H, W, 8)` flow-weight array.

    The multi-receiver counterpart of `flow_accumulation`: each cell hands
    its finalised total to every receiver in proportion to that receiver's
    weight. Returned flat, like `flow_accumulation`.
    """
    H, W, _ = w.shape
    accum = (
        np.ones(H * W, dtype=np.float64)
        if weights is None
        else np.asarray(weights, dtype=np.float64).ravel().copy()
    )
    _accum_multi_kernel(np.ascontiguousarray(w), np.ascontiguousarray(order),
                        accum, W)
    return accum


def has_receiver(w: np.ndarray) -> np.ndarray:
    """Flat boolean: does this cell send flow anywhere? (`~` = outlet/pit.)

    The multi-receiver equivalent of `receivers == arange(n)`, which is what
    `stream_power_erode` pins uplift on and `uplift.base_level_mask` reports.
    """
    return w.reshape(-1, 8).sum(axis=1) > 0.0


@njit(cache=True)
def _path_sum_multi_kernel(
    w: np.ndarray, order: np.ndarray, step: np.ndarray, out: np.ndarray, W: int
) -> None:
    for i in range(order.size):
        cell = order[i]
        r = cell // W
        c = cell - r * W
        acc = 0.0
        any_recv = False
        for k in range(8):
            wt = w[r, c, k]
            if wt > 0.0:
                any_recv = True
                acc += wt * out[(r + _D8_DR[k]) * W + (c + _D8_DC[k])]
        out[cell] = acc + step[cell] if any_recv else 0.0


def path_sum_multi(
    w: np.ndarray, order: np.ndarray, step: np.ndarray
) -> np.ndarray:
    """Flow-weighted downstream path integral: `P_i = step_i + sum_k w_ik P_k`.

    On a D8 forest this is exactly "add `step` along the single path to the
    outlet" — the integral `uplift.erosional_distance` (`Phi`) and
    `steady_state_relief_field` (`Psi`) walk. On a DAG it is the *expected*
    path sum over the flow partition, which is the only reading of "the path"
    that survives a cell sending water two ways. Roots contribute nothing, as
    there they are base level.
    """
    out = np.zeros(w.shape[0] * w.shape[1], dtype=np.float64)
    _path_sum_multi_kernel(np.ascontiguousarray(w),
                           np.ascontiguousarray(order),
                           np.ascontiguousarray(np.asarray(step, np.float64).ravel()),
                           out, w.shape[1])
    return out


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
