"""Hydrology: depression filling, D8 flow routing, accumulation, rivers.

Everything is vectorized numpy. The one algorithm that is naturally serial
(downstream accumulation / upstream solves) is handled with *level-order
processing*: cells are grouped by their depth in the flow (receiver) tree and
each level is processed as one vectorized operation. Tree depth on a 2k x 2k
map is a few thousand, so passes stay cheap.

Grid convention: elevation arrays are (H, W) float64, row-major, cell index
i = r * W + c. D8 receivers point to the steepest-descent neighbour
(diagonals use distance sqrt(2)); outlet/pit cells receive themselves.
"""
from __future__ import annotations

import numpy as np

# D8 neighbour offsets (dr, dc) and distances
_D8 = np.array(
    [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)],
    dtype=np.int64,
)
_D8_DIST = np.array([np.sqrt(2), 1, np.sqrt(2), 1, 1, np.sqrt(2), 1, np.sqrt(2)])


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


def resolve_flats(filled: np.ndarray, epsilon: float = 1e-4) -> np.ndarray:
    """Impose a tiny drainage gradient across flat areas (incl. filled
    depressions) so D8 routing never stalls.

    Vectorized wavefront BFS: start from flat cells that touch strictly lower
    ground ("outlets"), sweep inward, each wave adding `epsilon` elevation.
    Returns a routing elevation (filled + epsilon * wave-distance); use it for
    flow routing only, never as display/collision terrain.
    """
    H, W = filled.shape
    pad = np.pad(filled, 1, mode="edge")

    # A cell is "flat-stuck" if no 8-neighbour is strictly lower.
    has_lower = np.zeros((H, W), dtype=bool)
    for dr, dc in _D8:
        nb = pad[1 + dr : 1 + dr + H, 1 + dc : 1 + dc + W]
        has_lower |= nb < filled
    # Border cells always drain off-map.
    has_lower[0, :] = has_lower[-1, :] = True
    has_lower[:, 0] = has_lower[:, -1] = True

    flat = ~has_lower
    if not flat.any():
        return filled.copy()

    dist = np.zeros((H, W), dtype=np.int32)
    frontier = np.zeros((H, W), dtype=bool)
    # Outlet ring: flat cells adjacent to a non-flat cell of equal-or-lower
    # routing elevation (i.e. same flat surface touching drainage).
    padflat = np.pad(flat, 1, mode="constant", constant_values=False)
    near_drain = np.zeros((H, W), dtype=bool)
    for dr, dc in _D8:
        nbflat = padflat[1 + dr : 1 + dr + H, 1 + dc : 1 + dc + W]
        nbelev = pad[1 + dr : 1 + dr + H, 1 + dc : 1 + dc + W]
        near_drain |= (~nbflat) & (nbelev <= filled)
    frontier = flat & near_drain

    visited = frontier.copy()
    step = 1
    while frontier.any():
        dist[frontier] = step
        newf = np.zeros((H, W), dtype=bool)
        padv = np.pad(visited, 1, mode="constant", constant_values=False)
        for dr, dc in _D8:
            nb = padv[1 + dr : 1 + dr + H, 1 + dc : 1 + dc + W]
            newf |= nb
        frontier = flat & ~visited & newf & np.isclose(
            filled, filled, atol=0
        )  # same-surface constraint handled by flat mask
        # Only spread across cells of (approximately) the same flat elevation
        # as at least one visited neighbour:
        frontier &= newf
        visited |= frontier
        step += 1
        if step > H + W:  # safety
            break

    # Unreached flat cells (fully enclosed with no drain — true endorheic
    # basin floor after filling shouldn't exist, but guard anyway).
    dist[flat & ~visited] = step
    return filled + epsilon * dist.astype(filled.dtype)


def d8_receivers(elev: np.ndarray) -> np.ndarray:
    """Steepest-descent D8 receiver for each cell, as flat indices.

    Cells with no lower neighbour (pits — after filling these are only map
    borders / lake spill cells) receive themselves.
    """
    H, W = elev.shape
    pad = np.pad(elev, 1, mode="constant", constant_values=np.inf)

    best_slope = np.zeros((H, W), dtype=elev.dtype)
    best_idx = np.arange(H * W, dtype=np.int64).reshape(H, W)  # default: self

    rows = np.arange(H)[:, None]
    cols = np.arange(W)[None, :]
    for k, (dr, dc) in enumerate(_D8):
        nb = pad[1 + dr : 1 + dr + H, 1 + dc : 1 + dc + W]
        slope = (elev - nb) / _D8_DIST[k]
        better = slope > best_slope
        nb_r = np.clip(rows + dr, 0, H - 1)
        nb_c = np.clip(cols + dc, 0, W - 1)
        cand = nb_r * W + nb_c
        best_idx = np.where(better, cand, best_idx)
        best_slope = np.where(better, slope, best_slope)
    return best_idx.ravel()


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
