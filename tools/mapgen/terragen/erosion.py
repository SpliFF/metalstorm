"""Fluvial (stream-power) and thermal erosion, vectorized numpy + numba.

The fluvial model is the implicit O(n) scheme of Braun & Willett (2013),
solved in flow-tree level order (receivers before donors), which is fully
vectorizable per level:

    h_i^{t+dt} = (h_i^t + dt * U_i + F_i * h_recv^{t+dt}) / (1 + F_i)
    F_i = K * A_i^m * dt / dx        (for slope exponent n = 1)

where A is drainage area, U uplift rate, K erodibility. Iterating
{fill -> route -> solve} a few dozen times from a noise/uplift base produces
realistic dendritic valley networks — the "geologically plausible" look that
plain fBm lacks.

Thermal erosion moves material down slopes steeper than a talus angle,
rounding scree slopes and cliff bases. It runs as vectorized 8-neighbour
transfers with per-iteration caps, so it is stable at large step counts.

Numba port (PLAN-maps.md §2b item 1): the per-level implicit solve and the
thermal-erosion neighbour exchange are `@njit` kernels. Both preserve the
original's exact operation order (level-by-level dependency order for the
solve; the same fixed 8-direction summation order for thermal transfers) so
output is byte-identical to the pre-port numpy implementation — see
`tools/mapgen/terragen/_selftest_numba.py`. `hydrology.fill_depressions`
(skimage) and `hydrology.topo_levels` are comparatively cheap (~1-2s and
~1s/iter @2049² vs ~22-25s for the now-ported `resolve_flats`) and are left
as numpy/skimage to avoid the risk of a from-scratch reimplementation
silently diverging from skimage's morphological reconstruction.
"""
from __future__ import annotations

from typing import Callable

import numpy as np
from numba import njit, prange

from . import hydrology as hyd
from .hydrology import _D8_DR, _D8_DC  # noqa: F401 (numba needs bare globals, not module attrs)


@njit(cache=True)
def _lem_solve_kernel(
    newh: np.ndarray,
    F: np.ndarray,
    recv: np.ndarray,
    flat_levels: np.ndarray,
    level_offsets: np.ndarray,
) -> None:
    """In-place implicit stream-power solve, level order (receivers-first).

    `flat_levels` is the concatenation of `levels[1:]` (level 0 = roots,
    which never update — they have no receiver to solve against); assumes
    the caller only invokes this on genuinely at-least-2-level input (see
    `stream_power_erode`, which iterates `levels[1:]` too and simply skips
    the loop body when there is nothing to solve).
    """
    n_levels = level_offsets.size - 1
    for li in range(n_levels):
        s = level_offsets[li]
        e = level_offsets[li + 1]
        # Cells within one level have no data dependency on each other
        # (each reads only its receiver, already finalized in an earlier
        # level), so this inner loop is safe to parallelize — but it's kept
        # sequential here since the per-level cell counts are small and the
        # dominant cost is elsewhere (resolve_flats).
        for i in range(s, e):
            cell = flat_levels[i]
            r = recv[cell]
            F_cell = F[cell]
            newh[cell] = (newh[cell] + F_cell * newh[r]) / (1.0 + F_cell)


def stream_power_erode(
    dem: np.ndarray,
    cellsize: float,
    iterations: int = 40,
    dt: float = 1.0,
    k_erode: float | np.ndarray = 0.02,
    m_exp: float = 0.5,
    uplift: np.ndarray | None = None,
    talus_deg: float | None = 34.0,
    thermal_rate: float = 0.5,
    progress: "Callable | None" = None,
) -> np.ndarray:
    """Run coupled fluvial + thermal erosion on `dem` (modifies a copy).

    k_erode may be a scalar or a per-cell array (rock hardness variation —
    feeding lithology noise here produces varied landform character).
    Returns the eroded DEM.
    """
    h = dem.astype(np.float64).copy()
    H, W = h.shape
    n = H * W
    idx = np.arange(n, dtype=np.int64)
    k_arr = np.broadcast_to(np.asarray(k_erode, dtype=np.float64), h.shape).ravel()
    u_arr = None if uplift is None else uplift.ravel().astype(np.float64)

    for it in range(iterations):
        filled = hyd.fill_depressions(h)
        routing = hyd.resolve_flats(filled)
        recv = hyd.d8_receivers(routing)
        levels = hyd.topo_levels(recv)
        accum = hyd.flow_accumulation(recv, levels)  # cells
        area = accum * (cellsize * cellsize)

        # Solve on the real surface but route via the filled/resolved
        # elevations so flow crosses depressions instead of stalling in them.
        hf = h.ravel()
        F = k_arr * np.power(area, m_exp) * dt / cellsize
        F[recv == idx] = 0.0  # outlets don't erode toward themselves

        newh = hf.copy()
        if u_arr is not None:
            newh = newh + dt * u_arr
        sub_levels = levels[1:]
        if sub_levels:
            flat_levels = np.concatenate(sub_levels)
            sizes = np.array([lvl.size for lvl in sub_levels], dtype=np.int64)
            offsets = np.empty(len(sub_levels) + 1, dtype=np.int64)
            offsets[0] = 0
            offsets[1:] = np.cumsum(sizes)
            _lem_solve_kernel(newh, F, recv, flat_levels, offsets)
        h = newh.reshape(H, W)

        if talus_deg is not None:
            h = thermal_erode(h, cellsize, angle_deg=talus_deg, rate=thermal_rate)

        if progress is not None:
            progress(it + 1, iterations)
    return h


@njit(cache=True, parallel=True)
def _thermal_scale_kernel(
    h: np.ndarray, tan_crit: float, dists: np.ndarray, rate: float
) -> tuple[np.ndarray, np.ndarray]:
    """Per-cell scale factor + removed amount (phase 1 of thermal_erode)."""
    H, W = h.shape
    scale = np.empty((H, W), dtype=np.float64)
    removed = np.empty((H, W), dtype=np.float64)
    for r in prange(H):
        for c in range(W):
            v = h[r, c]
            total_excess = 0.0
            max_ex = 0.0
            for k in range(8):
                nr = r + _D8_DR[k]
                nc = c + _D8_DC[k]
                if nr < 0:
                    nr = 0
                elif nr >= H:
                    nr = H - 1
                if nc < 0:
                    nc = 0
                elif nc >= W:
                    nc = W - 1
                drop = v - h[nr, nc]
                ex = drop - tan_crit * dists[k]
                if ex < 0.0:
                    ex = 0.0
                total_excess += ex
                if ex > max_ex:
                    max_ex = ex
            move_total = rate * 0.5 * max_ex
            sc = move_total / total_excess if total_excess > 0.0 else 0.0
            scale[r, c] = sc
            removed[r, c] = total_excess * sc
    return scale, removed


@njit(cache=True, parallel=True)
def _thermal_received_kernel(
    h: np.ndarray, scale: np.ndarray, tan_crit: float, dists: np.ndarray
) -> np.ndarray:
    """Gather form of the scatter-add `received[target] += amt[source]` loop
    in the original: for each target cell, sum the contribution from each of
    its 8 neighbours (as a source moving material toward this cell), in the
    same fixed direction order as the original's k=0..7 accumulation — so
    the summation order (and thus the floating-point result) matches
    exactly. Safe to parallelize over target cells: each output element is
    written by exactly one iteration, no cross-thread accumulation."""
    H, W = h.shape
    received = np.zeros((H, W), dtype=np.float64)
    for r in prange(H):
        for c in range(W):
            acc = 0.0
            for k in range(8):
                dr = _D8_DR[k]
                dc = _D8_DC[k]
                sr = r - dr
                sc_ = c - dc
                if sr < 0 or sr >= H or sc_ < 0 or sc_ >= W:
                    continue
                # source (sr, sc_) -> target (sr+dr, sc_+dc) == (r, c);
                # both endpoints in-bounds here, so no edge-clamping applies.
                drop = h[sr, sc_] - h[r, c]
                ex = drop - tan_crit * dists[k]
                if ex < 0.0:
                    ex = 0.0
                acc += ex * scale[sr, sc_]
            received[r, c] = acc
    return received


def thermal_erode(
    dem: np.ndarray,
    cellsize: float,
    angle_deg: float = 34.0,
    rate: float = 0.5,
    iterations: int = 1,
) -> np.ndarray:
    """Move material from cells to lower neighbours where slope exceeds the
    talus angle. `rate` in (0, 1] is the fraction of the excess moved per
    iteration (0.5 is stable)."""
    h = np.ascontiguousarray(dem.astype(np.float64))
    tan_crit = np.tan(np.radians(angle_deg))
    dists = np.ascontiguousarray(hyd._D8_DIST * cellsize)

    for _ in range(iterations):
        scale, removed = _thermal_scale_kernel(h, tan_crit, dists, rate)
        received = _thermal_received_kernel(h, scale, tan_crit, dists)
        h = h - removed + received
    return h
