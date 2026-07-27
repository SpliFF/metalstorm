"""Fluvial (stream-power) and thermal erosion, vectorized numpy.

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
"""
from __future__ import annotations

import numpy as np

from . import hydrology as hyd


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
    progress: "callable | None" = None,
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
        for lvl in levels[1:]:
            r = recv[lvl]
            newh[lvl] = (newh[lvl] + F[lvl] * newh[r]) / (1.0 + F[lvl])
        h = newh.reshape(H, W)

        if talus_deg is not None:
            h = thermal_erode(h, cellsize, angle_deg=talus_deg, rate=thermal_rate)

        if progress is not None:
            progress(it + 1, iterations)
    return h


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
    h = dem.astype(np.float64).copy()
    H, W = h.shape
    tan_crit = np.tan(np.radians(angle_deg))

    offsets = hyd._D8
    dists = hyd._D8_DIST * cellsize

    for _ in range(iterations):
        pad = np.pad(h, 1, mode="edge")
        # Excess height over the talus criterion toward each lower neighbour.
        excesses = []
        total_excess = np.zeros_like(h)
        for k, (dr, dc) in enumerate(offsets):
            nb = pad[1 + dr : 1 + dr + H, 1 + dc : 1 + dc + W]
            drop = h - nb
            ex = np.maximum(drop - tan_crit * dists[k], 0.0)
            excesses.append(ex)
            total_excess += ex
        # Move a stable fraction of the single largest excess, split across
        # all violating neighbours proportionally to their excess.
        move_total = rate * 0.5 * np.max(np.stack(excesses), axis=0)
        scale = np.divide(
            move_total, total_excess, out=np.zeros_like(h), where=total_excess > 0
        )
        removed = total_excess * scale  # == move_total where any excess
        received = np.zeros_like(h)
        for k, (dr, dc) in enumerate(offsets):
            amt = excesses[k] * scale
            # deposit amt into the (dr, dc) neighbour: shift the array
            r0, r1 = max(dr, 0), H + min(dr, 0)
            c0, c1 = max(dc, 0), W + min(dc, 0)
            sr0, sr1 = max(-dr, 0), H + min(-dr, 0)
            sc0, sc1 = max(-dc, 0), W + min(-dc, 0)
            received[r0:r1, c0:c1] += amt[sr0:sr1, sc0:sc1]
        h = h - removed + received
    return h
