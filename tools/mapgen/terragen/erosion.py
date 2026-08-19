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
from scipy import ndimage

from . import hydrology as hyd
from .hydrology import _D8_DR, _D8_DC, _D8_DIST  # noqa: F401 (numba needs bare globals, not module attrs)


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


@njit(cache=True)
def _lem_solve_multi_kernel(
    newh: np.ndarray,
    G: np.ndarray,
    w: np.ndarray,
    order: np.ndarray,
    W: int,
    cellsize: float,
) -> None:
    """In-place implicit stream-power solve over a *multi*-receiver DAG.

        h_i = (h_i + sum_k F_ik h_k) / (1 + sum_k F_ik),
        F_ik = w_ik * G_i / (d_k * cellsize),   G_i = K_i * A_i^m * dt

    the direct generalisation of the Braun & Willett single-receiver form
    above: the donor is still solved after every one of its receivers (which
    `order` guarantees, ascending routing elevation), and the weights, which
    sum to 1, partition the incision between them.

    ⚠ Deviation from the D8 path, deliberate: this divides by the *true*
    neighbour distance `d_k * cellsize`, where `stream_power_erode`'s D8 form
    divides every link by `cellsize` regardless of whether the link is
    diagonal. Making a diagonal link 1.41x cheaper than a cardinal one is a
    lattice bias of precisely the kind this router exists to remove, so the
    new path does not inherit it; the D8 path is left alone because changing
    it moves both shipped maps.
    """
    for i in range(order.size):
        cell = order[i]
        r = cell // W
        c = cell - r * W
        num = newh[cell]
        den = 1.0
        g = G[cell]
        for k in range(8):
            wt = w[r, c, k]
            if wt > 0.0:
                f = g * wt / (_D8_DIST[k] * cellsize)
                num += f * newh[(r + _D8_DR[k]) * W + (c + _D8_DC[k])]
                den += f
        newh[cell] = num / den


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
    pin_base_level: bool = True,
    router: str = "d8",
    mfd_p: float = 1.1,
    progress: "Callable | None" = None,
) -> np.ndarray:
    """Run coupled fluvial + thermal erosion on `dem` (modifies a copy).

    k_erode may be a scalar or a per-cell array (rock hardness variation —
    feeding lithology noise here produces varied landform character).
    Returns the eroded DEM.

    `uplift` is a per-cell rate; the steady state it drives is
    `h = (uplift/k_erode) * Phi`, and `terragen.uplift` inverts that so a
    target relief can be authored directly (PLAN-maps.md §2b item 2).

    `pin_base_level` zeroes the uplift at outlets each iteration, and it must
    stay on for uplift to mean anything. Outlets are never eroded (`F` is
    zeroed there), so an outlet that also uplifts rises with everything
    upstream of it and the whole field reduces to a rigid translation of the
    U = 0 result — measured at relief 0.28 unpinned vs 180.66 pinned on the
    same 129^2 control. It is a no-op when `uplift is None`.

    `router` selects the flow graph: `"d8"` (default, single steepest
    receiver, the shipped maps' path, byte-for-byte unchanged), or `"dinf"` /
    `"mfd"` — see `hydrology.flow_weights`. The multi-receiver routers exist
    because a converged D8 landscape is *structurally periodic*: PLAN-maps
    M8p measured 5.27x angular energy concentration against a shipped map's
    1.24, and nothing on the D8 arm moved it. Judge the result with
    `uplift.structural_anisotropy`, not with a gradient-aspect histogram.
    """
    if router not in hyd.ROUTERS:
        raise ValueError(f"unknown router {router!r}, expected one of {hyd.ROUTERS}")
    h = dem.astype(np.float64).copy()
    H, W = h.shape
    n = H * W
    idx = np.arange(n, dtype=np.int64)
    k_arr = np.broadcast_to(np.asarray(k_erode, dtype=np.float64), h.shape).ravel()
    u_arr = None if uplift is None else uplift.ravel().astype(np.float64)

    for it in range(iterations):
        filled = hyd.fill_depressions(h)
        routing = hyd.resolve_flats(filled)

        if router == "d8":
            recv = hyd.d8_receivers(routing)
            levels = hyd.topo_levels(recv)
            accum = hyd.flow_accumulation(recv, levels)  # cells
        else:
            w = hyd.flow_weights(routing, router=router, mfd_p=mfd_p)
            order = hyd.flow_order(routing)
            accum = hyd.flow_accumulation_multi(w, order)
            is_root = ~hyd.has_receiver(w)
        area = accum * (cellsize * cellsize)

        # Solve on the real surface but route via the filled/resolved
        # elevations so flow crosses depressions instead of stalling in them.
        hf = h.ravel()

        newh = hf.copy()
        if u_arr is not None:
            u_it = u_arr
            if pin_base_level:
                u_it = np.where(recv == idx if router == "d8" else is_root,
                                0.0, u_arr)
            newh = newh + dt * u_it

        if router == "d8":
            F = k_arr * np.power(area, m_exp) * dt / cellsize
            F[recv == idx] = 0.0  # outlets don't erode toward themselves
            sub_levels = levels[1:]
            if sub_levels:
                flat_levels = np.concatenate(sub_levels)
                sizes = np.array([lvl.size for lvl in sub_levels], dtype=np.int64)
                offsets = np.empty(len(sub_levels) + 1, dtype=np.int64)
                offsets[0] = 0
                offsets[1:] = np.cumsum(sizes)
                _lem_solve_kernel(newh, F, recv, flat_levels, offsets)
        else:
            # G carries everything but the per-link weight/distance, which
            # the kernel applies as it walks each cell's receivers. Roots
            # have no receivers, so the kernel leaves them alone without a
            # mask (den stays 1, num stays newh).
            G = k_arr * np.power(area, m_exp) * dt
            _lem_solve_multi_kernel(newh, G, w, order, W, cellsize)
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


def _coarsen(a: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Area-average `a` down to `shape` (not decimation — see the note in
    `stream_power_erode_multires`)."""
    zoom = (shape[0] / a.shape[0], shape[1] / a.shape[1])
    return ndimage.zoom(a.astype(np.float64), zoom, order=1, grid_mode=True,
                        mode="nearest")


def _refine(a: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Cubic upsample of `a` to `shape`."""
    zoom = (shape[0] / a.shape[0], shape[1] / a.shape[1])
    return ndimage.zoom(a.astype(np.float64), zoom, order=3, grid_mode=True,
                        mode="nearest")


def band_detail(dem: np.ndarray, coarse_factor: int = 4) -> np.ndarray:
    """The high-pass residual a `coarse_factor` grid cannot represent.

    `dem - refine(coarsen(dem))`, i.e. exactly what
    `stream_power_erode_multires` carries across the upsample — and, read as
    a statistic, how much fine relief a surface *has to give* the solver.
    A smooth authored platform has ~none (0.040 elmos std on the arc's
    bathymetry) while the shipped mounds generator hands over 2.266, which
    is the difference between fine structure that erosion finishes and fine
    structure erosion has to invent (PLAN-maps M8q FIND 4, M8r).

    Measure at the factor the multires call itself uses; a different scale
    reads against a band the pass never had.
    """
    a = np.asarray(dem, dtype=np.float64)
    H, W = a.shape
    ch = max(9, int(round(H / coarse_factor)))
    cw = max(9, int(round(W / coarse_factor)))
    return a - _refine(_coarsen(a, (ch, cw)), (H, W))


def stream_power_erode_multires(
    dem: np.ndarray,
    cellsize: float,
    *,
    coarse_factor: int = 4,
    coarse_iterations: int = 400,
    fine_iterations: int = 30,
    keep_band_detail: bool = True,
    match_relief: bool = True,
    uplift: np.ndarray | None = None,
    k_erode: float | np.ndarray = 0.02,
    dt: float = 1.0,
    m_exp: float = 0.5,
    talus_deg: float | None = 34.0,
    thermal_rate: float = 0.5,
    router: str = "d8",
    mfd_p: float = 1.1,
    progress: "Callable | None" = None,
) -> np.ndarray:
    """Two-level LEM: evolve structure coarse, then refine at full detail.

    PLAN-maps.md §2b item 2's second half. A stream-power landscape needs
    O(1000) iterations to approach steady state, and at 2049^2 one iteration
    is ~2.2 s on this machine, so a converged run is hours. But the relation
    `h_i - h_r = U/(K*sqrt(a))` has **no cell size in it** (see
    `terragen.uplift`), so the structure a coarse grid converges to is the
    same structure — the fine grid adds resolution to the channels, not a
    different landscape. Evolving at 1/`coarse_factor` resolution costs
    ~`coarse_factor**2` less per iteration, which is what makes convergence
    affordable at all.

    The sequence is: area-average down (decimation would alias the ridge
    crests that decide where the divides land), run `coarse_iterations`,
    cubic upsample, add back the *band detail* — the high-pass residual
    `dem - refine(coarsen(dem))`, i.e. exactly the component the coarse grid
    could not represent — then run `fine_iterations` so the fine channels
    incise into it and the seams heal.

    Set `keep_band_detail=False` to get the smooth coarse structure alone,
    which is the arm to compare against when judging whether the detail is
    worth carrying (M8m measured both).

    ⚠ `match_relief` is what makes the coarse pass converge to the *fine*
    grid's landscape rather than a flatter one, and it is on by default
    because getting it wrong is silent. The steady-state relation
    `h = (U/K)*Phi` has no cell size in it, but `Phi` is a sum of `1/sqrt(a)`
    over the *cells* of a flow path, and a finer grid resolves more headwater
    cells — where `a` is smallest and each step contributes most. Measured on
    one fBm surface, `Phi` at the 99.9th percentile runs 7.70 / 10.53 / 13.94
    / 18.99 / 25.43 at 128 / 256 / 512 / 1024 / 2049 cells across, i.e. about
    `N**0.43`. So the same uplift field converges to roughly half the relief
    on a quarter-resolution grid: uncorrected, this driver handed back a
    Meridian at 231 elmos of relief against a 750-elmo target. The fix is to
    scale the coarse uplift by `Phi_fine / Phi_coarse`, both measured on the
    input surface's own drainage.

    ⚠ That ratio is a `Phi` ratio, i.e. drainage depth alone, and for a
    *shaped* uplift the quantity it stands in for is a `Psi` ratio — the
    same distinction `uplift.steady_state_relief_field` exists for. The two
    are identical for a uniform `U/K` (the ratio factors straight out of
    `Psi`), which is the case every number above was measured on, and they
    are not identical on the island arc: `Phi_f/Phi_c` runs **1.12x** the
    `Psi` ratio on the un-segmented belt and **1.25x** on the segmented one
    (M8u, full res). Left as `Phi` deliberately — swapping in `Psi` is the
    derivable-looking change and it measures *worse*, because the ratio the
    arc actually needs is neither (1.43 and 1.29 against Phi's 1.44/1.65 and
    Psi's 1.28/1.33): what the coarse grid converges to depends on how its
    drainage reorganises, which nothing measured on the input surface knows.
    `archipelago.generate`'s closed-loop aim absorbs the residual instead.
    """
    H, W = dem.shape
    ch = max(9, int(round(H / coarse_factor)))
    cw = max(9, int(round(W / coarse_factor)))
    c_cell = cellsize * (H / ch)

    dem = np.asarray(dem, dtype=np.float64)
    coarse = _coarsen(dem, (ch, cw))
    c_k = k_erode if np.isscalar(k_erode) else _coarsen(np.asarray(k_erode), (ch, cw))
    c_u = None if uplift is None else _coarsen(np.asarray(uplift), (ch, cw))

    if c_u is not None and match_relief:
        from . import uplift as _up

        # Both `Phi` are measured with the router the solve will use, so the
        # correction is a like-for-like ratio (a dispersive router shortens
        # `Phi` on both grids, and only the ratio is being asked for).
        phi_f, _ = _up.erosional_distance_from_dem(dem, router=router, mfd_p=mfd_p)
        phi_c, _ = _up.erosional_distance_from_dem(coarse, router=router, mfd_p=mfd_p)
        c_u = c_u * (_up.relief_scale(phi_f) / max(_up.relief_scale(phi_c), 1e-9))

    coarse = stream_power_erode(
        coarse, cellsize=c_cell, iterations=coarse_iterations, dt=dt,
        k_erode=c_k, m_exp=m_exp, uplift=c_u, talus_deg=talus_deg,
        thermal_rate=thermal_rate, router=router, mfd_p=mfd_p, progress=progress,
    )

    h = _refine(coarse, (H, W))
    if keep_band_detail:
        h = h + band_detail(dem, coarse_factor)

    if fine_iterations > 0:
        h = stream_power_erode(
            h, cellsize=cellsize, iterations=fine_iterations, dt=dt,
            k_erode=k_erode, m_exp=m_exp, uplift=uplift, talus_deg=talus_deg,
            thermal_rate=thermal_rate, router=router, mfd_p=mfd_p,
            progress=progress,
        )
    return h
