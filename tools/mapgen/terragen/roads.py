"""Road networks: least-cost paths between settlements, smoothing, carving.

Roads are planned on a decimated cost grid (planning every Kth heightmap
cell keeps Dijkstra cheap), then smoothed (Chaikin) and rasterized back at
full resolution as (a) a road mask for texturing, (b) a terrain-flattening
pass (roads grade into the hillside like real cut-and-fill construction),
and (c) polylines for gameplay (convoy routes, region transit tags).

Planning uses Galin 2010 *segment masks* (PLAN-maps §2b item 5): the
neighbourhood is every primitive (coprime) offset inside a (2k+1)^2 window,
not just the 8 adjacent cells, so a path can hold a heading that is not a
multiple of 45 deg. Each mask edge is costed as the line integral along the
cells it actually crosses (Bresenham sub-steps), which is what stops a long
offset from stepping over a cliff or a river that a short one would have to
pay for. `mask_k = 1` reproduces the old 8-connected graph exactly.

Cost model — two slopes, and they are not the same slope (PLAN-maps M9a).
One belongs to the edge, the other to each sub-step of it:

  * **grade** — the road's *own* longitudinal climb over the whole mask edge:
    the summed |dh| of its sub-steps over its length, i.e. the mean absolute
    grade of the run. This is Galin's cost variable and the thing a 48-heading
    mask exists to let the route choose: a traverse or a switchback holds a
    gentle grade across a hillside that is itself steep. `_edge_costs` carries
    the two ways of reading it that are wrong and the map each was wrong on.
    Only edges with both feet on land have a grade — bridge abutments do not.
  * **side-hill** — the terrain slope the deck is cut into, which prices the
    cut-and-fill volume. Steep side-hill is expensive to build on and gets
    expensive fast; it is not, on its own, impossible.

  sub_length * (1 + grade_cost    * (grade    / grade_ref)^grade_exp
                  + sidehill_cost * (sidehill / sidehill_ref)^sidehill_exp)
  water crossings replace the whole edge with length * water_penalty
    (bridge decks are level, so neither slope applies)
  the whole edge is multiplied by `road_discount` when every cell it touches
    is already carrying road — this is what grows trunk/branch topology
    instead of parallel spaghetti
Impassable (inf): the edge's grade beyond `max_grade_deg`, side-hill beyond
`max_sidehill_deg` on any dry sub-step, and water further than
`max_bridge_cells / 2` from land (see `_deep_water`).

Setting `grade_cost = 0`, `max_grade_deg = inf` and the side-hill triple to
the old slope triple reproduces the pre-M9a model exactly, which is how the
A/B was measured — `tests/test_roads.py::pre_m9a` is that arm, and every
test that wants the old behaviour builds it there.

Topology is a per-component minimum spanning forest (every reachable
settlement joined, disconnected groups given their own network rather than
silently dropped) plus Gabriel-graph shortcuts that beat a detour factor of
`detour_lambda`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra


@dataclass
class RoadParams:
    plan_step: int = 4              # plan on every Kth cell
    # mask_k=4 (48 headings) rather than §2b item 5's k=5: measured on both
    # shipped maps it is 97 % of k=5's turning reduction for 62 % of the plan
    # time, and its 9.10 deg length-weighted heading gap is the one that
    # matches the item's stated "9.5 deg" — k=5's is 11.31.
    mask_k: int = 4                 # Galin segment-mask half-width; 1 == 8-connected
    # The road's own longitudinal grade. 6 deg is 10.5 %, the grade a built
    # road holds comfortably; the exponent is M8l's measured 2.5, kept because
    # it was chosen against a grade reading in the first place. The block is
    # 15 deg = 27 %, past any sealed road and about where a graded mountain
    # track gives up — the pre-M9a model's 26 deg block, read as a grade,
    # would have been 49 %. **The block is the load-bearing half**: with the
    # side-hill wall relaxed and no grade limit, Meridian Basin's two halves
    # join over a pitch whose road grade reads p95 21.9 deg / max 41.7 deg
    # (M9a arm B) — a link no vehicle could use. At 15 they stay apart, which
    # is the honest answer for that map.
    grade_cost: float = 18.0
    grade_ref_deg: float = 6.0
    grade_exp: float = 2.5
    max_grade_deg: float = 15.0
    # Side-hill: the terrain slope the deck is cut into, pricing cut-and-fill
    # volume. The triple is M8l's calibration unchanged — only what it is
    # measured on is new — so the shipped price of a hillside did not move.
    # What moved is the block: 26 deg was standing in for a grade limit and
    # walled off 39.9 % of the map with it, isolating a Sundered Arc town site
    # that stands on 29 deg ground. A benched traverse across a 35 deg
    # hillside is ordinary mountain-road construction; 45 deg is where a bench
    # becomes a viaduct.
    sidehill_cost: float = 18.0
    sidehill_ref_deg: float = 10.0
    sidehill_exp: float = 2.5
    max_sidehill_deg: float = 45.0
    water_penalty: float = 25.0     # per planning cell of water crossed
    max_bridge_cells: int = 24      # longest allowed water crossing (plan cells)
    # road_discount is the item's 0.15 reuse multiplier, and it is shipped OFF:
    # it moves both shipped maps by <0.3 % of road length for 5-7x the planning
    # time, because their settlements are chains with no trunk to share. The
    # mechanism works (tests/test_roads.py::Reuse) — the content has no use
    # for it yet, so a map with a denser settlement graph can just set it.
    road_discount: float = 1.0      # cost multiplier for reusing an existing way
    detour_lambda: float = 1.5      # Gabriel shortcut kept when route/direct > this
    road_width: float = 48.0        # world units, full-res rasterization
    flatten_blend: float = 96.0     # shoulder blend distance (world units)


def mask_offsets(k: int) -> list[tuple[int, int]]:
    """Primitive (coprime) offsets inside a (2k+1)^2 window, Galin 2010.

    Non-primitive offsets are dropped because they are exactly reproduced by
    repeating a shorter one at the same heading and cost, so they only inflate
    the edge count. k=1 gives the 8 adjacent cells; k=4 gives 48 headings.
    """
    offs = []
    for dr in range(-k, k + 1):
        for dc in range(-k, k + 1):
            if dr == 0 and dc == 0:
                continue
            if math.gcd(abs(dr), abs(dc)) != 1:
                continue
            offs.append((dr, dc))
    return offs


def _segment_samples(dr: int, dc: int) -> list[tuple[int, int]]:
    """Cells the segment (0,0)->(dr,dc) is costed over, endpoints included.

    One sample per unit of the dominant axis (Bresenham), so a k=1 offset has
    exactly one sub-step and reproduces the old two-endpoint cost rule.
    """
    n = max(abs(dr), abs(dc))
    return [(int(math.floor(dr * i / n + 0.5)), int(math.floor(dc * i / n + 0.5)))
            for i in range(n + 1)]


def _plan_grid(height: np.ndarray, water_level: float, cellsize: float, p: RoadParams):
    step = p.plan_step
    h = height[::step, ::step]
    water = h <= water_level
    gy, gx = np.gradient(h, cellsize * step)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    return h, water, slope


def _deep_water(water: np.ndarray, p: RoadParams) -> np.ndarray:
    """Water cells that no legal bridge can reach.

    `max_bridge_cells` was declared from the start and never read, so bridges
    were unbounded: a road could cross open sea at a flat per-cell toll. The
    exact test ("is the water run this segment crosses shorter than the
    limit") is a property of the whole path, not of one edge, so it would need
    a state-augmented graph. This is the cheap necessary condition instead: a
    cell more than half the limit from any shore cannot lie on *any* crossing
    within the limit, whatever direction it is taken in. It admits a few
    over-long diagonal crossings it cannot see; it never blocks a legal one.
    """
    if p.max_bridge_cells <= 0 or not water.any():
        return np.zeros(water.shape, dtype=bool)
    depth = ndimage.distance_transform_edt(water)
    return depth > (p.max_bridge_cells * 0.5)


def _edge_costs(h, water, slope, cellsize, p: RoadParams,
                deep: np.ndarray | None = None,
                on_road: np.ndarray | None = None):
    """Build the sparse segment-mask cost graph over the planning grid."""
    H, W = h.shape
    n = H * W
    idx = np.arange(n).reshape(H, W)
    if deep is None:
        deep = np.zeros(water.shape, dtype=bool)
    # `h` is the decimated planning grid, so one planning cell is plan_step
    # heightmap cells wide — the run a sub-step's rise is taken over
    world_step = cellsize * p.plan_step
    grade_ref = max(p.grade_ref_deg, 1e-6)
    side_ref = max(p.sidehill_ref_deg, 1e-6)

    rows, cols, costs = [], [], []
    for dr, dc in mask_offsets(p.mask_k):
        samples = _segment_samples(dr, dc)
        lo_r = min(s[0] for s in samples); hi_r = max(s[0] for s in samples)
        lo_c = min(s[1] for s in samples); hi_c = max(s[1] for s in samples)
        r0, r1 = max(0, -lo_r), H - max(0, hi_r)
        c0, c1 = max(0, -lo_c), W - max(0, hi_c)
        if r0 >= r1 or c0 >= c1:
            continue

        def win(a, off):
            return a[r0 + off[0]:r1 + off[0], c0 + off[1]:c1 + off[1]].ravel()

        src = win(idx, samples[0])
        dst = win(idx, samples[-1])
        length = np.hypot(dr, dc)
        nsub = len(samples) - 1
        sub_len = length / nsub

        # The grade belongs to the whole EDGE — one straight run of deck — and
        # it is the rise the road actually walks: the sum of |dh| over the
        # Bresenham sub-steps, over the edge's length. The two rules it is not
        # are both wrong, and each was measured wrong on a shipping map:
        #   * per sub-step forbids the traverse the 48-heading mask exists to
        #     express (a 2:1 offset across a 29 deg plane holds 13.9 deg while
        #     one of its sub-steps is a 21 deg diagonal), and left Sundered
        #     Arc's town split off exactly as the terrain-slope wall had;
        #   * endpoint-to-endpoint hides everything between the ends — it let
        #     Meridian Basin's halves join over a pitch that reads p95 21 deg
        #     and max 40 deg on the delivered road, because the deck climbed
        #     and dropped back inside a single 128-elmo edge.
        # Summing |dh| is the mean absolute grade along the run, so a climb
        # and its matching descent both count. `flatten_under_roads` grades
        # the ground toward a blurred copy of itself rather than to the deck
        # line, so the road it delivers follows the terrain: this is the
        # measure that matches what gets built.
        rise = np.zeros(src.shape, dtype=np.float64)
        for i in range(nsub):
            rise += np.abs(win(h, samples[i + 1]) - win(h, samples[i]))
        # ...and it is only the road's grade when both ends stand on land. An
        # edge that begins or ends in water is a bridge abutment, where the
        # heightmap is seabed and the deck is level: the rise to it is the
        # bank, not a climb the road makes. Those edges keep the water toll.
        both_dry = ~win(water, samples[0]) & ~win(water, samples[-1])
        grade = np.where(both_dry,
                         np.degrees(np.arctan(rise / (length * world_step))), 0.0)
        grade_term = p.grade_cost * (grade / grade_ref) ** p.grade_exp

        cost = np.zeros(src.shape, dtype=np.float64)
        blocked = grade > p.max_grade_deg
        reuse = np.ones(src.shape, dtype=bool) if on_road is not None else None
        for i in range(nsub):
            s = np.maximum(win(slope, samples[i]), win(slope, samples[i + 1]))
            w = win(water, samples[i]) | win(water, samples[i + 1])
            # priced per sub-step, not per edge: a long offset that clips one
            # wet cell must not be billed as a bridge for its whole length,
            # or the cost of a crossing would depend on the mask size
            dry = sub_len * (1.0 + grade_term
                             + p.sidehill_cost * (s / side_ref) ** p.sidehill_exp)
            cost += np.where(w, sub_len * p.water_penalty, dry)
            # water cells are never blocked by the hillside they cross: a
            # bridge deck is level and spans it
            blocked |= (s > p.max_sidehill_deg) & ~w
            blocked |= win(deep, samples[i]) | win(deep, samples[i + 1])
            if reuse is not None:
                reuse &= win(on_road, samples[i]) & win(on_road, samples[i + 1])

        if reuse is not None and p.road_discount != 1.0:
            cost = np.where(reuse, cost * p.road_discount, cost)
        keep = ~blocked

        rows.append(src[keep]); cols.append(dst[keep]); costs.append(cost[keep])

    rows = np.concatenate(rows); cols = np.concatenate(cols); costs = np.concatenate(costs)
    return coo_matrix((costs, (rows, cols)), shape=(n, n)).tocsr()


def _mst_forest(pair_cost: np.ndarray) -> list[tuple[int, int]]:
    """Minimum spanning *forest* over endpoint pairs (Prim's per component).

    The old code grew one tree and `break`ed the moment no finite edge left
    the tree, which silently dropped every endpoint that had not been reached
    yet — on Meridian Basin that was the entire southern half of the map,
    which kept its worn junction plazas and lost all its roads. Unreachable
    groups now get their own tree instead.
    """
    k = len(pair_cost)
    seen: set[int] = set()
    edges: list[tuple[int, int]] = []
    for root in range(k):
        if root in seen:
            continue
        tree = {root}
        seen.add(root)
        while True:
            best = None
            for i in sorted(tree):
                for j in range(k):
                    if j in seen or not np.isfinite(pair_cost[i][j]):
                        continue
                    if best is None or pair_cost[i][j] < best[0]:
                        best = (pair_cost[i][j], i, j)
            if best is None:
                break
            _, i, j = best
            edges.append((i, j))
            tree.add(j); seen.add(j)
    return edges


def _gabriel_extras(pts: np.ndarray, pair_cost: np.ndarray,
                    tree: list[tuple[int, int]], lam: float) -> list[tuple[int, int]]:
    """Gabriel-graph shortcuts that beat a detour factor of `lam`.

    An MST is a tree, so every pair is joined exactly one way and a village
    two ridges apart from its neighbour on the tree may be a short hop apart
    on the ground. The Gabriel graph (edge i-j kept when no third settlement
    lies in the disc with i-j as diameter) is the standard candidate set for
    that: it is planar-ish, has no long-range clutter, and matches how real
    road networks close local loops. Candidates are then kept only when the
    route already in the network costs more than `lam` times the direct link,
    so a shortcut has to actually save something to be built.
    """
    k = len(pts)
    adj: dict[int, list[int]] = {i: [] for i in range(k)}
    for i, j in tree:
        adj[i].append(j); adj[j].append(i)

    cand = []
    for i in range(k):
        for j in range(i + 1, k):
            if not np.isfinite(pair_cost[i][j]) or (i, j) in tree or (j, i) in tree:
                continue
            mid = (pts[i] + pts[j]) * 0.5
            rad = float(np.hypot(*(pts[j] - pts[i]))) * 0.5
            if rad <= 0.0:
                continue
            if any(m != i and m != j and np.hypot(*(pts[m] - mid)) < rad for m in range(k)):
                continue
            cand.append((pair_cost[i][j], i, j))
    cand.sort()

    extras: list[tuple[int, int]] = []
    for direct, i, j in cand:
        # Dijkstra over the current settlement graph (k is tiny)
        best = {i: 0.0}
        frontier = [i]
        while frontier:
            u = min(frontier, key=lambda x: best[x])
            frontier.remove(u)
            for v in adj[u]:
                d = best[u] + pair_cost[u][v]
                if v not in best or d < best[v] - 1e-9:
                    best[v] = d
                    if v not in frontier:
                        frontier.append(v)
        route = best.get(j, np.inf)
        if route > lam * direct:
            extras.append((i, j))
            adj[i].append(j); adj[j].append(i)
    return extras


def plan_roads(
    height: np.ndarray,
    water_level: float,
    cellsize: float,
    endpoints: list[tuple[float, float]],
    params: RoadParams | None = None,
    extra_pairs: list[tuple[int, int]] | None = None,
) -> list[np.ndarray]:
    """Plan a road network connecting `endpoints` (world-coordinate (x, z)).

    Topology: a minimum spanning *forest* over pairwise path costs (every
    reachable settlement joined; a group the cost field walls off gets its own
    network instead of being dropped), plus Gabriel-graph shortcuts that beat
    `detour_lambda`, plus any `extra_pairs` (indices into endpoints).

    When `road_discount < 1` the links are then realised one at a time in
    increasing cost order, re-costing the graph after each so later routes can
    merge into what is already built (Galin's trunk/branch reuse). Topology is
    still decided on the undiscounted metric — the discount changes where a
    link runs, not which links exist.

    Returns a list of polylines in world coordinates (N x 2 arrays of x, z).
    """
    p = params or RoadParams()
    h, water, slope = _plan_grid(height, water_level, cellsize, p)
    H, W = h.shape
    deep = _deep_water(water, p)
    graph = _edge_costs(h, water, slope, cellsize, p, deep=deep)

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
    pair_cost = np.array([[dist[i][nodes[j]] for j in range(k)] for i in range(k)])

    edges = _mst_forest(pair_cost)
    nets = k - len(edges)          # a spanning forest has k - (#components) edges
    edges += _gabriel_extras(np.asarray(endpoints, dtype=np.float64),
                             pair_cost, edges, p.detour_lambda)
    for pair in extra_pairs or []:
        if pair not in edges and (pair[1], pair[0]) not in edges:
            edges.append(pair)

    if nets > 1:
        print(f"  roads: {k} sites split into {nets} unconnected networks by the "
              f"cost field; each gets its own tree ({len(edges)} links total)")

    world = cellsize * p.plan_step

    def to_polyline(path_nodes):
        rr = path_nodes // W
        cc = path_nodes % W
        pts = np.stack([cc * world, rr * world], axis=1)
        return chaikin_smooth(pts.astype(np.float64), iterations=3)

    if p.road_discount == 1.0:
        polylines = []
        for i, j in edges:
            path_nodes = _walk_predecessors(pred[i], nodes[i], nodes[j])
            if path_nodes is not None:
                polylines.append(to_polyline(path_nodes))
        return polylines

    on_road = np.zeros((H, W), dtype=bool)
    polylines = []
    for i, j in sorted(edges, key=lambda e: (pair_cost[e[0]][e[1]], e)):
        g = graph if not on_road.any() else _edge_costs(
            h, water, slope, cellsize, p, deep=deep, on_road=on_road)
        _d, pr = dijkstra(g, indices=[nodes[i]], return_predecessors=True)
        path_nodes = _walk_predecessors(pr[0], nodes[i], nodes[j])
        if path_nodes is None:
            continue
        on_road.ravel()[path_nodes] = True
        polylines.append(to_polyline(path_nodes))
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
