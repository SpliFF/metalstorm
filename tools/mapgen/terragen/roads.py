"""Road networks: least-cost paths between settlements, smoothing, carving.

Roads are planned on a decimated cost grid (planning every Kth heightmap
cell keeps Dijkstra cheap), then smoothed (Chaikin) and rasterized back at
full resolution as (a) a road mask for texturing, (b) a terrain-flattening
pass (roads grade into the hillside like real cut-and-fill construction),
and (c) polylines for gameplay (convoy routes, region transit tags).

Cost model per grid edge:
  base length * (1 + slope_cost * (slope / slope_ref)^2)   on land
  + water_penalty per cell of water crossed (bridges: allowed, expensive,
    and only where the crossing is narrow)
  + biome_cost (e.g. wetland/forest slightly pricier than grassland)
Impassable (inf): slope beyond `max_slope_deg`.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra


@dataclass
class RoadParams:
    plan_step: int = 4              # plan on every Kth cell
    slope_cost: float = 18.0
    slope_ref_deg: float = 10.0
    max_slope_deg: float = 28.0
    water_penalty: float = 25.0     # per planning cell of water crossed
    max_bridge_cells: int = 24      # longest allowed water crossing (plan cells)
    road_width: float = 48.0        # world units, full-res rasterization
    flatten_blend: float = 96.0     # shoulder blend distance (world units)


def _plan_grid(height: np.ndarray, water_level: float, cellsize: float, p: RoadParams):
    step = p.plan_step
    h = height[::step, ::step]
    water = h <= water_level
    gy, gx = np.gradient(h, cellsize * step)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    return h, water, slope


def _edge_costs(h, water, slope, cellsize, p: RoadParams):
    """Build the sparse 8-connected cost graph over the planning grid."""
    H, W = h.shape
    n = H * W
    idx = np.arange(n).reshape(H, W)

    rows, cols, costs = [], [], []
    offsets = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    for dr, dc in offsets:
        r0, r1 = max(dr, 0), H + min(dr, 0)
        c0, c1 = max(dc, 0), W + min(dc, 0)
        sr0, sr1 = max(-dr, 0), H + min(-dr, 0)
        sc0, sc1 = max(-dc, 0), W + min(-dc, 0)

        src = idx[sr0:sr1, sc0:sc1].ravel()
        dst = idx[r0:r1, c0:c1].ravel()
        length = np.hypot(dr, dc)

        s_src = slope[sr0:sr1, sc0:sc1].ravel()
        s_dst = slope[r0:r1, c0:c1].ravel()
        w_src = water[sr0:sr1, sc0:sc1].ravel()
        w_dst = water[r0:r1, c0:c1].ravel()
        s = np.maximum(s_src, s_dst)

        cost = length * (1.0 + p.slope_cost * (s / p.slope_ref_deg) ** 2)
        cost = np.where(w_src | w_dst, length * p.water_penalty, cost)
        cost = np.where(s > p.max_slope_deg, np.inf, cost)
        # water cells never blocked by slope (bridge decks are level)
        cost = np.where((w_src | w_dst) & (s > p.max_slope_deg),
                        length * p.water_penalty, cost)

        keep = np.isfinite(cost)
        rows.append(src[keep]); cols.append(dst[keep]); costs.append(cost[keep])

    rows = np.concatenate(rows); cols = np.concatenate(cols); costs = np.concatenate(costs)
    return coo_matrix((costs, (rows, cols)), shape=(n, n)).tocsr()


def plan_roads(
    height: np.ndarray,
    water_level: float,
    cellsize: float,
    endpoints: list[tuple[float, float]],
    params: RoadParams | None = None,
    extra_pairs: list[tuple[int, int]] | None = None,
) -> list[np.ndarray]:
    """Plan a road network connecting `endpoints` (world-coordinate (x, z)).

    Default topology: minimum spanning tree over pairwise path costs (every
    settlement reachable, no redundant spaghetti), plus any `extra_pairs`
    (indices into endpoints) for deliberate loops.
    Returns a list of polylines in world coordinates (N x 2 arrays of x, z).
    """
    p = params or RoadParams()
    h, water, slope = _plan_grid(height, water_level, cellsize, p)
    H, W = h.shape
    graph = _edge_costs(h, water, slope, cellsize, p)

    def to_node(pt):
        x, z = pt
        c = int(round(x / (cellsize * p.plan_step)))
        r = int(round(z / (cellsize * p.plan_step)))
        return np.clip(r, 0, H - 1) * W + np.clip(c, 0, W - 1)

    nodes = [to_node(pt) for pt in endpoints]
    k = len(nodes)
    if k < 2:
        return []

    dist, pred = dijkstra(graph, indices=nodes, return_predecessors=True)

    # MST over the complete graph of endpoint pairs (Prim's, tiny k)
    pair_cost = np.array([[dist[i][nodes[j]] for j in range(k)] for i in range(k)])
    in_tree = {0}
    edges: list[tuple[int, int]] = []
    while len(in_tree) < k:
        best = None
        for i in in_tree:
            for j in range(k):
                if j in in_tree or not np.isfinite(pair_cost[i][j]):
                    continue
                if best is None or pair_cost[i][j] < best[0]:
                    best = (pair_cost[i][j], i, j)
        if best is None:
            break  # disconnected endpoint (e.g. island) — skip it
        _, i, j = best
        edges.append((i, j))
        in_tree.add(j)
    for pair in extra_pairs or []:
        if pair not in edges and (pair[1], pair[0]) not in edges:
            edges.append(pair)

    polylines = []
    for i, j in edges:
        path_nodes = _walk_predecessors(pred[i], nodes[i], nodes[j])
        if path_nodes is None:
            continue
        rr = path_nodes // W
        cc = path_nodes % W
        pts = np.stack([cc * cellsize * p.plan_step, rr * cellsize * p.plan_step], axis=1)
        polylines.append(chaikin_smooth(pts.astype(np.float64), iterations=3))
    return polylines


def _walk_predecessors(pred_row: np.ndarray, src: int, dst: int) -> np.ndarray | None:
    path = [dst]
    cur = dst
    for _ in range(pred_row.size):
        if cur == src:
            return np.array(path[::-1], dtype=np.int64)
        cur = pred_row[cur]
        if cur < 0:
            return None
        path.append(cur)
    return None


def chaikin_smooth(pts: np.ndarray, iterations: int = 3) -> np.ndarray:
    """Chaikin corner cutting; keeps endpoints.

    Works on any (N, K) array, not just (N, 2): rivers.py carries per-vertex
    width and water-surface elevation as extra columns so they are subdivided
    by the same weights as the geometry and stay in step with it.
    """
    p = pts
    for _ in range(iterations):
        if len(p) < 3:
            break
        q = p[:-1] * 0.75 + p[1:] * 0.25
        r = p[:-1] * 0.25 + p[1:] * 0.75
        mid = np.empty((q.shape[0] * 2, p.shape[1]))
        mid[0::2] = q
        mid[1::2] = r
        p = np.vstack([p[:1], mid, p[-1:]])
    return p


def rasterize_roads(
    polylines: list[np.ndarray],
    shape: tuple[int, int],
    cellsize: float,
    params: RoadParams | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Rasterize road polylines at full resolution.

    Returns (road_mask, road_dist): boolean mask of road surface and the
    distance (world units) to the nearest road centreline (useful for
    shoulder blending and texture edge fades).
    """
    p = params or RoadParams()
    H, W = shape
    hit = np.zeros(shape, dtype=bool)
    for line in polylines:
        # dense sampling along segments at half-cell steps
        for a, b in zip(line[:-1], line[1:]):
            seg = b - a
            length = float(np.hypot(*seg))
            steps = max(2, int(length / (cellsize * 0.5)))
            ts = np.linspace(0.0, 1.0, steps)
            xs = a[0] + seg[0] * ts
            zs = a[1] + seg[1] * ts
            cc = np.clip((xs / cellsize).astype(np.int64), 0, W - 1)
            rr = np.clip((zs / cellsize).astype(np.int64), 0, H - 1)
            hit[rr, cc] = True

    dist = ndimage.distance_transform_edt(~hit) * cellsize
    mask = dist <= (p.road_width * 0.5)
    return mask, dist


def carve_plazas(
    road_mask: np.ndarray,
    road_dist: np.ndarray,
    sites: list[tuple[float, float]],
    radius: float,
    cellsize: float,
    params: RoadParams | None = None,
) -> None:
    """Merge circular worn plazas into the road fields in-place.

    Each site becomes a disc that reads as road surface: the distance field
    is lowered so `road_dist < road_width/2` holds across the disc, which
    makes flatten_under_roads grade it level and the albedo bake paint it as
    deck with the same sharp edge + worn shoulder as the ways that meet it.
    """
    p = params or RoadParams()
    H, W = road_mask.shape
    half = p.road_width * 0.5
    rc = int(np.ceil((radius + half) / cellsize)) + 2
    for (sx, sz) in sites:
        c = sx / cellsize; r = sz / cellsize
        c0 = max(0, int(c) - rc); c1 = min(W, int(c) + rc + 1)
        r0 = max(0, int(r) - rc); r1 = min(H, int(r) + rc + 1)
        if c0 >= c1 or r0 >= r1:
            continue
        zz, xx = np.mgrid[r0:r1, c0:c1]
        d = np.hypot(xx - c, zz - r) * cellsize
        plaza_dist = np.maximum(d - (radius - half), 0.0)
        np.minimum(road_dist[r0:r1, c0:c1], plaza_dist,
                   out=road_dist[r0:r1, c0:c1])
        road_mask[r0:r1, c0:c1] |= d <= radius


def flatten_under_roads(
    height: np.ndarray,
    road_dist: np.ndarray,
    cellsize: float,
    params: RoadParams | None = None,
) -> np.ndarray:
    """Grade terrain toward a smoothed road-level surface near roads.

    The road-level surface is the height field blurred along ~10 road widths,
    which behaves like cut-and-fill: highs are cut, dips are filled. Blend
    weight is 1 on the deck, fading to 0 at road_width/2 + flatten_blend.
    """
    p = params or RoadParams()
    sigma = max(2.0, (p.road_width * 4.0) / cellsize)
    graded = ndimage.gaussian_filter(height, sigma=sigma)

    half = p.road_width * 0.5
    t = np.clip((road_dist - half) / max(p.flatten_blend, 1e-3), 0.0, 1.0)
    w = 1.0 - t * t * (3 - 2 * t)  # smoothstep down from deck to shoulder end
    return height * (1.0 - w) + graded * w
