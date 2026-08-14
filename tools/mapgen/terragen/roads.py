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
`detour_lambda`. A forest is the right answer for two basins a wall apart and
the wrong one for a site standing on ground the cost field cannot leave —
`unbuildable_mask` is that condition as a `settle.pick_sites(forbidden=...)`
field, and `plan_roads` names it when it meets it (PLAN-maps M9a FIND 1).

Two entry points, and they are not alternatives (PLAN-maps §2c/§2d):

  * `plan_roads` — one flat network of one class. Untouched by R2, so every
    pre-R2 map is reproducible from it.
  * `plan_network` — the same planner run as a HIERARCHY (highways to the map's
    portals and its major towns, roads joining the trunk deck where it passes,
    tracks out to points of interest), driven by a `NODE_*` role per endpoint.
    Per class it moves the two BLOCKS, the deck width, the shoulder and the
    curvature bound — never the prices. `rasterize_network` / `flatten_network`
    / `carve_junction_aprons` are its rasterization half.

⚠ **The grade limit above is a claim about one mask edge, not about the deck
that ships.** The cost graph is memoryless, so a pair of opposite legal
traverses climbs at the terrain's fall line while every edge certifies the
limit, and Chaikin then smooths the saw-tooth into a straight climb.
`deck_grade_profile` measures what shipped, at a declared scale, and
`report_delivered_grades` warns when the two disagree — see PLAN-maps §2d.1 for
the open design question behind it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

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


def unbuildable_mask(
    height: np.ndarray,
    water_level: float,
    cellsize: float,
    params: RoadParams | None = None,
) -> np.ndarray:
    """Heightmap-resolution mask of ground the road planner cannot leave.

    A settlement standing here is isolated **by construction**: every mask
    edge that touches its planning cell is infinite, so the planner cannot
    reach it from anywhere and hands it its own one-site "network". The map
    then quietly gains a second road system that no gameplay reading of it
    will explain.

    That is not hypothetical — it is M9a FIND 1. One Sundered Arc town site
    stood on a planning cell reading 29.3 deg against a 26 deg side-hill
    wall, and `settlement_score` (which calls ground under 8 deg buildable,
    averaged over a 320-elmo disc) and the road planner (which reads the
    single decimated planning cell) disagreed about whether that was ground
    you could build on. **Nothing checked.** Feed this to
    `settle.pick_sites(forbidden=...)` and the disagreement becomes a
    rejected site instead of a silent second network.

    Deliberately a *necessary* condition only: it says the cost field cannot
    take a single step off the cell, not that the cell is unreachable from
    some particular other site. Genuine map topology — two basins a wall
    apart, two islands — is a real spanning forest and stays one; only
    isolated-by-construction cells are flagged. `plan_roads` reports the same
    condition when it meets it, so the two never drift apart.
    """
    p = params or RoadParams()
    h, water, slope = _plan_grid(height, water_level, cellsize, p)
    graph = _edge_costs(h, water, slope, cellsize, p, deep=_deep_water(water, p))
    bad = np.asarray(graph.getnnz(axis=1) == 0).reshape(h.shape)

    # upsample by the same rounding `plan_roads.to_node` uses, so a cell this
    # mask forbids is exactly the cell that planner would snap the site to
    H, W = height.shape
    PH, PW = h.shape
    pr = np.clip(np.rint(np.arange(H) / p.plan_step).astype(np.int64), 0, PH - 1)
    pc = np.clip(np.rint(np.arange(W) / p.plan_step).astype(np.int64), 0, PW - 1)
    return bad[pr[:, None], pc[None, :]]


def _report_split(nets, k, edges, graph, nodes, endpoints, idx, tier="roads",
                  progress=print):
    """M9a FIND 1's diagnostic, shared by `plan_roads` and `plan_network`.

    Factored out rather than duplicated because R2's tiered planner is a second
    caller and the first cut of it simply did not report at all: Meridian
    Basin's trunk really does split into two components (its halves are a wall
    apart at a 15 deg grade limit), and the new planner delivered that silently
    where the old one had named it. A diagnostic that only one of two planners
    emits is worse than none — it reads as "no split" on the planner that lost
    it.
    """
    if nets <= 1:
        return
    progress(f"  {tier}: {k} sites split into {nets} unconnected networks by the "
             f"cost field; each gets its own tree ({len(edges)} links total)")
    # ...and say WHICH KIND of split it is. A spanning forest is the right
    # answer for two basins a wall apart; it is the wrong answer for a site
    # the cost field cannot take one step away from, which is a placer /
    # planner disagreement about buildable ground and was M9a FIND 1.
    # `unbuildable_mask` is the same condition offered to `pick_sites` as a
    # `forbidden` field, so a generator can reject the site instead.
    out_deg = np.asarray(graph.getnnz(axis=1)).ravel()
    stranded = [j for j in range(k) if out_deg[nodes[j]] == 0]
    if stranded:
        where = ", ".join(f"#{idx[j]} at ({endpoints[idx[j]][0]:.0f},"
                          f"{endpoints[idx[j]][1]:.0f})" for j in stranded)
        progress(f"  {tier}: WARNING {len(stranded)} of those sites are "
                 f"isolated BY CONSTRUCTION — every mask edge touching their "
                 f"own planning cell is impassable, so no route to them can "
                 f"exist at any cost: {where}. The site placer and the road "
                 f"cost field disagree about buildable ground here; see "
                 f"roads.unbuildable_mask.")


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

    _report_split(nets, k, edges, graph, nodes, endpoints, list(range(k)))

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
    road_class: np.ndarray | None = None,
) -> None:
    """Merge circular worn plazas into the road fields in-place.

    Each site becomes a disc that reads as road surface: the distance field
    is lowered so `road_dist < road_width/2` holds across the disc, which
    makes flatten_under_roads grade it level and the albedo bake paint it as
    deck with the same sharp edge + worn shoulder as the ways that meet it.

    When a class raster is supplied it is carved too, and the plaza takes the
    class the roads arriving at it already carry (the commonest inside the
    disc, dirt if none arrive) — a plaza left at SURF_NONE would be a hole in
    the typemap exactly where the traffic is.
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

    if road_class is not None:
        carve_plaza_classes(road_class, sites, radius, cellsize)


def carve_plaza_classes(
    road_class: np.ndarray,
    sites: list[tuple[float, float]],
    radius: float,
    cellsize: float,
) -> None:
    """In-place: give each plaza disc the surface the roads arriving at it
    already carry (the commonest class inside the disc; dirt if none arrive).

    Split out of `carve_plazas` because a generator that needs moisture to
    classify only has it after the biome step, i.e. after the plazas are
    already carved into the mask — see meridian2.py step 7b.
    """
    H, W = road_class.shape
    rc = int(np.ceil(radius / cellsize)) + 2
    for (sx, sz) in sites:
        c = sx / cellsize; r = sz / cellsize
        c0 = max(0, int(c) - rc); c1 = min(W, int(c) + rc + 1)
        r0 = max(0, int(r) - rc); r1 = min(H, int(r) + rc + 1)
        if c0 >= c1 or r0 >= r1:
            continue
        zz, xx = np.mgrid[r0:r1, c0:c1]
        disc = np.hypot(xx - c, zz - r) * cellsize <= radius
        window = road_class[r0:r1, c0:c1]
        arriving = window[disc & (window != SURF_NONE)]
        if arriving.size:
            plaza_cls = np.uint8(int(np.bincount(arriving, minlength=SURF_MUD + 1).argmax()))
        else:
            plaza_cls = np.uint8(SURF_DIRT)
        window[disc] = plaza_cls


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


# ---------------------------------------------------------------------------
# Road surface classes (roads lane R1)
# ---------------------------------------------------------------------------
#
# A network is not one material. The class is what drives the albedo recipe
# (bake.py), the baked wheel ruts, and the SMF typemap value — which is what
# gives the engine a per-surface `receiveTracks` and per-move-class speed
# (mapinfo `terrainTypes`, read by rts/Map/MapInfo.cpp::ReadTerrainTypes).
#
# The classes are ordinal on purpose: 1..3 runs sealed -> unsealed -> soft, so
# a typemap value orders the same way the surface does.

SURF_NONE = 0
SURF_BITUMEN = 1        # sealed trunk road: broken bitumen, patches, potholes
SURF_DIRT = 2           # graded unsealed road: gravel/earth, wheel ruts
SURF_MUD = 3            # soft wet ground: deep ruts, standing water

SURFACE_NAMES = {
    SURF_BITUMEN: "bitumen",
    SURF_DIRT: "dirt",
    SURF_MUD: "mud",
}


@dataclass
class SurfaceParams:
    """How a planned network is split into surface classes.

    The rules are deliberately terrain-driven rather than authored, so a
    generator gets a plausible network for free and a map that moves its
    towns moves its surfaces with them.
    """
    # The sealed network is the longest links until they account for this much
    # of the network's total LENGTH — a length budget rather than a count or a
    # median, because the two are wildly different answers: on Meridian Basin
    # a median-length split seals half the links and 94 % of the deck AREA,
    # since the links it seals are by construction the long ones. A budget
    # says what it means ("the trunk is 40 % of the network") and holds that
    # meaning on a map whose link lengths are distributed differently.
    sealed_length_fraction: float = 0.40
    # Unsealed road through wet ground is mud. Both tests are ORed: standing
    # moisture, or freeboard so low the water table is at the surface.
    mud_moisture: float = 0.62
    mud_freeboard: float = 3.0     # world units above water_level
    # A sealed road is *built*, so it stays sealed across a wet dip — the fill
    # and the drain are part of the road. Only unsealed links go muddy.
    seal_survives_wet: bool = True
    # Runs shorter than this collapse into their neighbours: a two-vertex mud
    # fleck in the middle of a dirt road is a texture artefact, not a bog.
    min_run_len: float = 260.0     # world units


def classify_roads(
    polylines: list[np.ndarray],
    moisture: np.ndarray,
    height: np.ndarray,
    water_level: float,
    cellsize: float,
    surface: SurfaceParams | None = None,
    road_classes: list[int] | None = None,
) -> list[np.ndarray]:
    """Assign a surface class to every vertex of every polyline.

    Returns one uint8 array per polyline (same length as the polyline), with
    values from the SURF_* set. Deterministic: no RNG, only the fields.

    `road_classes` (R2) is the ROAD_* hierarchy, one per polyline. When it is
    given, sealing comes from `RoadClassParams.sealed` — a highway is sealed
    because it is a highway — and the `sealed_length_fraction` budget is not
    consulted at all. **That budget was always a proxy for the hierarchy**
    ("the longest 40 % of the network is the trunk"), so with a real hierarchy
    to read it is a worse answer to the same question, not a second opinion.
    It stays the rule for callers with no hierarchy, which is the only caller
    it was ever written for.
    """
    s = surface or SurfaceParams()
    if not polylines:
        return []

    gh, gw = height.shape
    lengths = np.array([_polyline_length(pl) for pl in polylines], dtype=np.float64)
    if road_classes is None:
        sealed = _sealed_set(lengths, s.sealed_length_fraction)
    else:
        if len(road_classes) != len(polylines):
            raise ValueError("road_classes must be one per polyline")
        sealed = {i for i, rc in enumerate(road_classes)
                  if ROAD_CLASS_PARAMS[rc].sealed}

    out = []
    for idx, (pl, length) in enumerate(zip(polylines, lengths)):
        base = SURF_BITUMEN if idx in sealed else SURF_DIRT
        cls = np.full(len(pl), base, dtype=np.uint8)

        if not (s.seal_survives_wet and base == SURF_BITUMEN):
            cc = np.clip((pl[:, 0] / cellsize).astype(np.int64), 0, gw - 1)
            rr = np.clip((pl[:, 1] / cellsize).astype(np.int64), 0, gh - 1)
            wet = (moisture[rr, cc] >= s.mud_moisture) | (
                (height[rr, cc] - water_level) <= s.mud_freeboard
            )
            cls[wet] = SURF_MUD

        _collapse_short_runs(cls, pl, s.min_run_len)
        out.append(cls)
    return out


def _sealed_set(lengths: np.ndarray, fraction: float) -> set:
    """Indices of the longest links whose lengths sum to `fraction` of the
    network. Always at least one link (a lone road is its own trunk) and never
    every link unless the fraction asks for it."""
    if lengths.size == 0:
        return set()
    total = float(lengths.sum())
    if total <= 0.0 or fraction <= 0.0:
        return {int(np.argmax(lengths))}
    order = np.argsort(-lengths, kind="stable")
    budget = total * min(fraction, 1.0)
    taken, acc = set(), 0.0
    for i in order:
        taken.add(int(i))
        acc += float(lengths[i])
        if acc >= budget:
            break
    return taken


def _polyline_length(pl: np.ndarray) -> float:
    if len(pl) < 2:
        return 0.0
    return float(np.hypot(*(pl[1:] - pl[:-1]).T).sum())


def _collapse_short_runs(cls: np.ndarray, pl: np.ndarray, min_len: float) -> None:
    """In-place: any run of one class shorter than `min_len` takes the class of
    its longer neighbour (or its only neighbour at an end)."""
    if len(cls) < 2 or min_len <= 0.0:
        return
    step = np.hypot(*(pl[1:] - pl[:-1]).T)
    # length attributed to a vertex: half of each adjoining segment
    vlen = np.zeros(len(cls))
    vlen[:-1] += step * 0.5
    vlen[1:] += step * 0.5

    changed = True
    while changed:
        changed = False
        bounds = np.flatnonzero(np.diff(cls.astype(np.int16))) + 1
        starts = np.concatenate([[0], bounds])
        ends = np.concatenate([bounds, [len(cls)]])
        if starts.size < 2:
            return
        runs = [(a, b, float(vlen[a:b].sum())) for a, b in zip(starts, ends)]
        for i, (a, b, ln) in enumerate(runs):
            if ln >= min_len:
                continue
            prev_len = runs[i - 1][2] if i > 0 else -1.0
            next_len = runs[i + 1][2] if i + 1 < len(runs) else -1.0
            take = runs[i - 1] if prev_len >= next_len else runs[i + 1]
            cls[a:b] = cls[take[0]]
            changed = True
            break


def rasterize_roads_classified(
    polylines: list[np.ndarray],
    classes: list[np.ndarray] | None,
    shape: tuple[int, int],
    cellsize: float,
    params: RoadParams | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """`rasterize_roads` plus a full-res surface-class raster.

    The class raster is grown from the centreline by the SAME distance
    transform that produces `road_dist`, so a texel's class is the class of
    the centreline texel nearest to it and mask/class can never disagree.
    Cells off the deck are SURF_NONE.
    """
    p = params or RoadParams()
    H, W = shape
    hit = np.zeros(shape, dtype=bool)
    seed = np.zeros(shape, dtype=np.uint8)

    for idx, line in enumerate(polylines):
        line_cls = None
        if classes is not None:
            line_cls = np.asarray(classes[idx], dtype=np.uint8)
        for i, (a, b) in enumerate(zip(line[:-1], line[1:])):
            seg = b - a
            length = float(np.hypot(*seg))
            steps = max(2, int(length / (cellsize * 0.5)))
            ts = np.linspace(0.0, 1.0, steps)
            xs = a[0] + seg[0] * ts
            zs = a[1] + seg[1] * ts
            cc = np.clip((xs / cellsize).astype(np.int64), 0, W - 1)
            rr = np.clip((zs / cellsize).astype(np.int64), 0, H - 1)
            hit[rr, cc] = True
            if line_cls is not None:
                # a sample belongs to the vertex it started from; the last
                # segment's far end takes the final vertex's class
                seed[rr, cc] = line_cls[i]
                if i == len(line) - 2:
                    seed[rr[-1], cc[-1]] = line_cls[-1]

    if classes is None:
        dist = ndimage.distance_transform_edt(~hit) * cellsize
        mask = dist <= (p.road_width * 0.5)
        return mask, dist, np.where(mask, np.uint8(SURF_DIRT), np.uint8(SURF_NONE))

    dist_cells, idxs = ndimage.distance_transform_edt(~hit, return_indices=True)
    dist = dist_cells * cellsize
    mask = dist <= (p.road_width * 0.5)
    cls = np.where(mask, seed[idxs[0], idxs[1]], np.uint8(SURF_NONE)).astype(np.uint8)
    return mask, dist, cls


# ---------------------------------------------------------------------------
# Road hierarchy (roads lane R2)
# ---------------------------------------------------------------------------
#
# R1 gave the network three SURFACE classes (bitumen/dirt/mud): what the deck
# is made of. R2 adds the axis R1 was standing in for — what the road is FOR.
# The two are not the same axis and must not be conflated:
#
#   * SURF_* is a material. It drives albedo, ruts, the SMF typemap value and
#     therefore `receiveTracks` and the per-move-class speed multiplier.
#   * ROAD_* is a function. It drives width, flatten blend, the grade and
#     side-hill limits the route is planned under, and how much curvature the
#     deck is allowed to carry.
#
# **R1 chose the material from a length budget, and that budget was an
# undeclared proxy for exactly this hierarchy** — "the longest 40 % of the
# network is sealed" is a guess at which links are trunk roads, made without a
# trunk/branch distinction to read. With a real hierarchy the material follows
# from the function (`RoadClassParams.sealed`) and the proxy is retired; the
# budget stays reachable for callers with no hierarchy to offer, because a
# generator that hands `classify_roads` no road classes is exactly the caller
# R1's rule was written for.
#
# Ordinal, coarsest-first: 0 highway, 1 road, 2 track.

ROAD_HIGHWAY = 0
ROAD_ROAD = 1
ROAD_TRACK = 2

ROAD_CLASS_NAMES = {
    ROAD_HIGHWAY: "highway",
    ROAD_ROAD: "road",
    ROAD_TRACK: "track",
}

# Node roles, which is what decides the hierarchy. A generator knows what its
# endpoints ARE (a district centre, a convoy waypoint, a map gate, a resource
# site); it does not know which links between them should be trunk roads. Roles
# in, hierarchy out.
NODE_EDGE = "edge"      # map-edge portal: where the network leaves the map
NODE_TOWN = "town"      # major settlement: a highway destination
NODE_MINOR = "minor"    # village / waypoint: joins the network by an ordinary road
NODE_POI = "poi"        # resource or ancient site: reached by a track
NODE_ROLES = (NODE_EDGE, NODE_TOWN, NODE_MINOR, NODE_POI)


@dataclass(frozen=True)
class RoadClassParams:
    """Per-class geometry and planning limits.

    `width` and `flatten_blend` are MULTIPLES of `RoadParams.road_width` /
    `RoadParams.flatten_blend`, not absolutes, so a generator that has already
    tuned its deck width (both shipped maps run 44 rather than the 48 default)
    keeps that tuning and gets the hierarchy scaled around it. `ROAD_ROAD` is
    the identity class — every multiplier 1.0 and every limit the base value —
    which is what makes "the road tier reproduces the pre-R2 network" a
    checkable property rather than a claim (`tests/test_road_hierarchy.py`).
    """
    width_mult: float
    blend_mult: float
    max_grade_deg: float | None       # None = take RoadParams.max_grade_deg
    max_sidehill_deg: float | None    # None = take RoadParams.max_sidehill_deg
    min_turn_radius: float            # world units; 0 = unbounded (stays wiggly)
    smooth_iterations: int            # Chaikin rounds before the curvature bound
    sealed: bool                      # -> SURF_BITUMEN when classify_roads sees it


# A highway is graded, wide and cannot hold a tight corner: 8 deg is 14 %, the
# grade a trunk road is built to hold, and the 900-unit easement radius is what
# makes it read as engineered rather than as a wide goat track. A track is the
# opposite end of every knob and deliberately keeps NO curvature bound, because
# "tracks stay wiggly" is the look, not a defect: an unbounded radius means
# Chaikin's own corner cutting is the only smoothing it gets.
ROAD_CLASS_PARAMS: dict[int, RoadClassParams] = {
    ROAD_HIGHWAY: RoadClassParams(
        width_mult=1.6, blend_mult=1.5, max_grade_deg=8.0,
        max_sidehill_deg=None, min_turn_radius=900.0,
        smooth_iterations=5, sealed=True),
    ROAD_ROAD: RoadClassParams(
        width_mult=1.0, blend_mult=1.0, max_grade_deg=None,
        max_sidehill_deg=None, min_turn_radius=320.0,
        smooth_iterations=3, sealed=False),
    ROAD_TRACK: RoadClassParams(
        width_mult=0.55, blend_mult=0.5, max_grade_deg=22.0,
        max_sidehill_deg=50.0, min_turn_radius=0.0,
        smooth_iterations=2, sealed=False),
}


def class_width(road_class: int, p: RoadParams) -> float:
    return p.road_width * ROAD_CLASS_PARAMS[road_class].width_mult


def class_blend(road_class: int, p: RoadParams) -> float:
    return p.flatten_blend * ROAD_CLASS_PARAMS[road_class].blend_mult


def class_road_params(road_class: int, p: RoadParams) -> RoadParams:
    """`p` with the class's planning limits substituted.

    Only the two BLOCKS move, not the prices: a highway and a track are built
    on the same terrain by the same economics, and what separates them is what
    they refuse. Moving `grade_cost` per class as well would make the class
    change which route is cheapest for reasons that have nothing to do with the
    class, and there is no evidence for a per-class price.
    """
    cp = ROAD_CLASS_PARAMS[road_class]
    return replace(
        p,
        max_grade_deg=p.max_grade_deg if cp.max_grade_deg is None else cp.max_grade_deg,
        max_sidehill_deg=(p.max_sidehill_deg if cp.max_sidehill_deg is None
                          else cp.max_sidehill_deg),
        road_width=class_width(road_class, p),
        flatten_blend=class_blend(road_class, p),
    )


# --- curvature -------------------------------------------------------------

def turn_angles(pts: np.ndarray) -> np.ndarray:
    """Direction change at each vertex in degrees; 0 straight, 180 a reversal.

    Endpoints are 0 (a polyline does not turn at its ends).
    """
    out = np.zeros(len(pts))
    if len(pts) < 3:
        return out
    a = pts[1:-1] - pts[:-2]
    b = pts[2:] - pts[1:-1]
    na = np.hypot(a[:, 0], a[:, 1])
    nb = np.hypot(b[:, 0], b[:, 1])
    ok = (na > 1e-9) & (nb > 1e-9)
    cos = np.ones(len(a))
    cos[ok] = np.clip(((a[ok] * b[ok]).sum(axis=1)) / (na[ok] * nb[ok]), -1.0, 1.0)
    out[1:-1] = np.degrees(np.arccos(cos))
    return out


def turn_radii(pts: np.ndarray) -> np.ndarray:
    """Circumradius of each consecutive triple, in world units; inf at the ends.

    The circumradius of the three points through a vertex is the standard
    discrete curvature reading and it is the right one here: it is the radius
    of the arc a vehicle would actually drive through that vertex, which is
    what a minimum-turn-radius bound is about.
    """
    out = np.full(len(pts), np.inf)
    if len(pts) < 3:
        return out
    p0, p1, p2 = pts[:-2], pts[1:-1], pts[2:]
    a = np.hypot(*(p1 - p0).T)
    b = np.hypot(*(p2 - p1).T)
    c = np.hypot(*(p2 - p0).T)
    # twice the triangle area, signed cross product
    area2 = np.abs((p1[:, 0] - p0[:, 0]) * (p2[:, 1] - p0[:, 1])
                   - (p1[:, 1] - p0[:, 1]) * (p2[:, 0] - p0[:, 0]))
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(area2 > 1e-9, (a * b * c) / (2.0 * area2), np.inf)
    out[1:-1] = r
    return out


def _easement(pl: np.ndarray, min_radius: float, max_shift: float | None) -> np.ndarray:
    """Gaussian easement along ARC LENGTH until the radius bound holds.

    Why not iterated Laplacian relaxation of the offending vertices, which is
    the obvious implementation and was the first one: Laplacian diffusion
    travels about sqrt(passes) vertices per pass, and Chaikin has already
    multiplied the vertex count by 2^iterations, so on a smoothed polyline it
    moves a few units of arc length in 40 passes. Measured on the saw-tooth
    fixture it delivered a 180-unit radius against a 900-unit bound and stopped
    improving — the bound simply was not being met, quietly, by an
    implementation that looked like it was converging.

    An easement is a fixed ARC LENGTH of curve, not a local nudge: a corner of
    angle theta eased to radius R occupies R*theta of road. So the operation
    that produces one is a smoothing whose kernel is a length — a Gaussian over
    arc length — and the sigma is grown until the bound is met, which also makes
    an unsatisfiable bound (a saw-tooth pitched far tighter than R) resolve to
    "nearly straight" rather than to a silent failure. Endpoints are pinned and
    the displacement is tapered to zero at them, so a piece can be smoothed
    without its ends drifting off the junction they were planned onto.
    """
    if len(pl) < 5:
        return pl
    seg = np.hypot(*(pl[1:] - pl[:-1]).T)
    ds = float(np.mean(seg))
    if ds <= 0.0:
        return pl
    n = len(pl)
    # normalised arc length, for the endpoint correction below
    t = np.concatenate([[0.0], np.cumsum(seg)])
    t = t / t[-1]
    out = pl
    sigma = min_radius * 0.30
    for _ in range(7):
        k = min(max(sigma / ds, 0.5), n / 3.0)
        sm = np.stack([ndimage.gaussian_filter1d(pl[:, i], k, mode="nearest")
                       for i in range(pl.shape[1])], axis=1)
        # Pin the ends by adding the LINEAR field that cancels their drift.
        # Blending smoothed and unsmoothed geometry through a taper window was
        # the first attempt and it is worse than doing nothing: the transition
        # zone is a mixture of a straight original and a heavily smoothed copy,
        # which is itself a corner — measured, it took the saw-tooth's minimum
        # radius DOWN to 16 units against a 900 bound. Adding a linear function
        # cannot introduce curvature, so this pins the ends for free.
        corr = (np.outer(1.0 - t, pl[0] - sm[0]) + np.outer(t, pl[-1] - sm[-1]))
        cand = sm + corr
        if max_shift is not None:
            off = cand - pl
            worst = float(np.hypot(off[:, 0], off[:, 1]).max())
            if worst > max_shift:
                # scale the WHOLE displacement field by one scalar, never
                # per-vertex: clamping individual vertices puts a kink exactly
                # where the easement was working, which is the same mistake the
                # taper made. A capped easement is a smaller easement.
                cand = pl + off * (max_shift / worst)
        out = cand
        r = turn_radii(out)[1:-1]
        if r.size == 0 or float(np.nanmin(r)) >= min_radius:
            break
        sigma *= 1.8
    return out


def _split_at_hairpins(pts: np.ndarray, hairpin_deg: float) -> list[np.ndarray]:
    """Cut the RAW path at every heading reversal, apex shared by both pieces.

    Detected before smoothing, deliberately. Chaikin blunts a 150 deg apex into
    a run of moderate turns, so a hairpin test applied to the smoothed polyline
    reads a switchback as an ordinary corner and eases it away — the same
    declare-your-scale trap `deck_grade_profile` documents for grade. Splitting
    also makes the protection exact rather than approximate: each leg gets its
    own easement, the apex is an endpoint of both and therefore pinned, and no
    kernel ever straddles the reversal.
    """
    apex = [i for i in np.flatnonzero(turn_angles(pts) > hairpin_deg)
            if 0 < i < len(pts) - 1]
    if not apex:
        return [pts]
    cuts = [0] + apex + [len(pts) - 1]
    return [pts[a:b + 1] for a, b in zip(cuts[:-1], cuts[1:]) if b > a]


def curvature_limited_smooth(
    pts: np.ndarray,
    min_radius: float = 0.0,
    iterations: int = 3,
    hairpin_deg: float = 110.0,
    max_shift: float | None = None,
) -> np.ndarray:
    """Chaikin `iterations` rounds, then ease every corner tighter than
    `min_radius` — except a switchback's, which is the point of the bound.

    Chaikin cuts every corner by the same fixed proportion, so it smooths a
    highway and a goat track identically and neither ends up with the geometry
    its class implies. The curvature bound is the part that differs by class: a
    highway gets a long easement (`min_turn_radius` 900), a track gets none at
    all (0), and "tracks stay wiggly" is therefore a declared value rather than
    an accident of how many Chaikin rounds someone ran.

    **Hairpins are protected, and that is the whole interaction with
    switchbacks.** A switchback is a deliberate heading reversal that holds a
    grade limit across a slope too steep to climb directly; its apex radius is
    small BY CONSTRUCTION. Easing it cuts the corner, which shortens the run
    over the same rise — i.e. the curvature bound would undo the grade limit
    that built the switchback. The path is split at reversals and each leg eased
    on its own, so the apex cannot move and no kernel spans it.

    `max_shift` caps how far a vertex may move from where the planner put it.
    Easing is a geometric operation with no cost field in it, so an unbounded
    one is free to walk the deck off the least-cost route and onto ground the
    planner refused; the cap keeps an easement local. Terrain under the FINAL
    deck is graded by `flatten_under_roads`, so a shifted vertex still gets a
    drivable surface — it is the side-hill it was moved onto that the cap is
    protecting.
    """
    if min_radius <= 0.0:
        return chaikin_smooth(pts, iterations)
    pieces = []
    for raw in _split_at_hairpins(np.asarray(pts, dtype=np.float64), hairpin_deg):
        q = chaikin_smooth(raw, iterations)
        pieces.append(_easement(q, min_radius, max_shift))
    out = pieces[0]
    for nxt in pieces[1:]:
        out = np.vstack([out, nxt[1:]])
    return out


# --- hierarchy planning ----------------------------------------------------

@dataclass
class RoadLink:
    """One planned way: its geometry, its class, and what it joins."""
    polyline: np.ndarray
    road_class: int
    a: int                  # endpoint index, or -1 when the end is a deck junction
    b: int


@dataclass
class RoadNetwork:
    links: list[RoadLink] = field(default_factory=list)
    junctions: list[tuple[float, float]] = field(default_factory=list)
    networks: int = 0       # connected components of the highway/road tier

    @property
    def polylines(self) -> list[np.ndarray]:
        return [ln.polyline for ln in self.links]

    @property
    def road_classes(self) -> list[int]:
        return [ln.road_class for ln in self.links]

    def of_class(self, road_class: int) -> list[np.ndarray]:
        return [ln.polyline for ln in self.links if ln.road_class == road_class]

    def length_by_class(self) -> dict[int, float]:
        out = {c: 0.0 for c in ROAD_CLASS_PARAMS}
        for ln in self.links:
            out[ln.road_class] += _polyline_length(ln.polyline)
        return out


def _graph_cache(h, water, slope, cellsize, p: RoadParams, deep):
    """One cost graph per distinct pair of BLOCKS, built on demand.

    The classes differ only in what they refuse (`class_road_params`), so two
    classes with the same grade and side-hill limits share a graph. On the
    shipped maps highway and road differ (8 vs 15 deg) and track differs again,
    so this is three Dijkstra graphs where R1 built one — the honest cost of a
    hierarchy, and the cache is what keeps it at three rather than one per link.
    """
    cache: dict[tuple[float, float], object] = {}

    def get(road_class: int):
        cp = class_road_params(road_class, p)
        key = (float(cp.max_grade_deg), float(cp.max_sidehill_deg))
        if key not in cache:
            cache[key] = _edge_costs(h, water, slope, cellsize, cp, deep=deep)
        return cache[key]

    return get


def _tier_edges(pair_cost: np.ndarray, pts: np.ndarray, lam: float):
    """MST forest + Gabriel shortcuts over one tier's nodes."""
    edges = _mst_forest(pair_cost)
    nets = len(pair_cost) - len(edges)
    edges = edges + _gabriel_extras(pts, pair_cost, edges, lam)
    return edges, nets


def plan_network(
    height: np.ndarray,
    water_level: float,
    cellsize: float,
    endpoints: list[tuple[float, float]],
    roles: list[str] | None = None,
    params: RoadParams | None = None,
    extra_pairs: list[tuple[int, int]] | None = None,
    junction_stride: int = 3,
) -> RoadNetwork:
    """Plan a HIERARCHICAL network: highways, roads to them, tracks to POIs.

    `roles` is one of `NODE_ROLES` per endpoint (default: everything
    `NODE_MINOR`, which is a flat single-tier network and is how a caller with
    no hierarchy to declare keeps the pre-R2 shape). The tiers:

      1. **Highways** span the `NODE_EDGE` + `NODE_TOWN` nodes — map-edge
         portals and major towns — as a spanning forest plus Gabriel
         shortcuts, planned under the highway's tighter grade limit. Edge
         portals are what stop a highway network from being a closed island:
         the trunk leaves the map where the map says it should.
      2. **Roads** join every remaining town/minor node to **the cheapest
         point on the highway deck**, not to the cheapest highway *endpoint*.
         That difference is the junction: a village joins the trunk where the
         trunk passes it, which is a T on the deck, instead of detouring to a
         town it does not care about. With no highway tier (fewer than two
         trunk nodes) this tier degenerates to a spanning forest over its own
         nodes, i.e. exactly `plan_roads`' topology.
      3. **Tracks** join each `NODE_POI` to the cheapest point on anything
         already built, under the loosest limits — a track is allowed up a
         slope no road would take.

    Returns a `RoadNetwork`. Deterministic: no RNG anywhere on this path.
    """
    p = params or RoadParams()
    roles = list(roles) if roles is not None else [NODE_MINOR] * len(endpoints)
    if len(roles) != len(endpoints):
        raise ValueError("roles must be one per endpoint")
    bad = sorted(set(roles) - set(NODE_ROLES))
    if bad:
        raise ValueError(f"unknown node roles: {bad}")

    h, water, slope = _plan_grid(height, water_level, cellsize, p)
    H, W = h.shape
    deep = _deep_water(water, p)
    graph_for = _graph_cache(h, water, slope, cellsize, p, deep)
    world = cellsize * p.plan_step

    def to_node(pt):
        c = int(round(pt[0] / world))
        r = int(round(pt[1] / world))
        return np.clip(r, 0, H - 1) * W + np.clip(c, 0, W - 1)

    nodes = [to_node(pt) for pt in endpoints]
    pts = np.asarray(endpoints, dtype=np.float64)
    net = RoadNetwork()
    # planning-grid nodes already carrying deck, and the class that put them
    # there — this is what tiers 2 and 3 aim at
    deck: dict[int, int] = {}

    def smooth_for(road_class: int, path_nodes: np.ndarray) -> np.ndarray:
        cp = ROAD_CLASS_PARAMS[road_class]
        rr = path_nodes // W
        cc = path_nodes % W
        raw = np.stack([cc * world, rr * world], axis=1).astype(np.float64)
        return curvature_limited_smooth(
            raw, min_radius=cp.min_turn_radius, iterations=cp.smooth_iterations,
            max_shift=class_width(road_class, p) * 1.5)

    def add_link(road_class: int, path_nodes: np.ndarray, a: int, b: int) -> None:
        line = smooth_for(road_class, path_nodes)
        net.links.append(RoadLink(polyline=line, road_class=road_class, a=a, b=b))
        for n in path_nodes.tolist():
            # a wider class owns a shared cell: ordinal, so min() is "coarsest"
            deck[n] = min(deck.get(n, road_class), road_class)

    def plan_tier(idx: list[int], road_class: int, lam: float):
        """Spanning forest + shortcuts over `idx` (indices into endpoints)."""
        if len(idx) < 2:
            return 0
        g = graph_for(road_class)
        sub_nodes = [nodes[i] for i in idx]
        dist, pred = dijkstra(g, indices=sub_nodes, return_predecessors=True)
        pair_cost = np.array([[dist[a][sub_nodes[b]] for b in range(len(idx))]
                              for a in range(len(idx))])
        edges, nets = _tier_edges(pair_cost, pts[idx], lam)
        for pair in extra_pairs or []:
            local = (idx.index(pair[0]) if pair[0] in idx else None,
                     idx.index(pair[1]) if pair[1] in idx else None)
            if None not in local and local not in edges and local[::-1] not in edges:
                edges.append(local)
        _report_split(nets, len(idx), edges, g, sub_nodes, endpoints, idx,
                      tier=f"roads/{ROAD_CLASS_NAMES[road_class]}")
        for a, b in edges:
            path = _walk_predecessors(pred[a], sub_nodes[a], sub_nodes[b])
            if path is not None:
                add_link(road_class, path, idx[a], idx[b])
        return nets

    # --- tier 1: highways over the map's portals and its major towns
    trunk = [i for i, r in enumerate(roles) if r in (NODE_EDGE, NODE_TOWN)]
    net.networks = plan_tier(trunk, ROAD_HIGHWAY, p.detour_lambda)

    # --- tier 2: everything else that is not a POI joins the deck
    rest = [i for i, r in enumerate(roles) if r == NODE_MINOR
            or (r == NODE_TOWN and not deck)]
    if not deck:
        # no trunk was built (fewer than two trunk nodes, or none reachable):
        # this tier is the whole network and takes plan_roads' own topology
        flat = [i for i, r in enumerate(roles) if r != NODE_POI]
        net.networks = plan_tier(flat, ROAD_ROAD, p.detour_lambda)
    else:
        _join_to_deck(net, rest, nodes, graph_for(ROAD_ROAD), deck,
                      ROAD_ROAD, add_link, W, world, junction_stride)

    # --- tier 3: tracks out to the points of interest
    pois = [i for i, r in enumerate(roles) if r == NODE_POI]
    if pois:
        if not deck:
            net.networks = max(net.networks, plan_tier(pois, ROAD_TRACK,
                                                       p.detour_lambda))
        else:
            _join_to_deck(net, pois, nodes, graph_for(ROAD_TRACK), deck,
                          ROAD_TRACK, add_link, W, world, junction_stride)
    return net


def _join_to_deck(net, idx, nodes, graph, deck, road_class, add_link,
                  W, world, stride):
    """Join each node in `idx` to the cheapest point on the existing deck.

    One Dijkstra per node, from the node outward, then the minimum over the
    deck's planning cells. `stride` subsamples the deck so a long trunk does
    not offer thousands of near-identical targets — it costs nothing in route
    quality (adjacent deck cells are a planning cell apart) and it is what
    keeps this linear in deck length rather than in deck cells.
    """
    if not deck:
        return
    for i in idx:
        if nodes[i] in deck:
            continue          # the node is already standing on the network
        targets = sorted(deck)[::max(1, stride)]
        dist, pred = dijkstra(graph, indices=[nodes[i]],
                              return_predecessors=True)
        costs = dist[0][targets]
        if not np.isfinite(costs).any():
            continue
        target = targets[int(np.nanargmin(np.where(np.isfinite(costs),
                                                   costs, np.inf)))]
        path = _walk_predecessors(pred[0], nodes[i], target)
        if path is None:
            continue
        add_link(road_class, path, i, -1)
        net.junctions.append((float((target % W) * world),
                              float((target // W) * world)))


# --- rasterization with per-class widths ------------------------------------

@dataclass
class RoadRaster:
    """Full-res road fields for a hierarchical network.

    `dist` is the drop-in replacement for `rasterize_roads`' `road_dist` and it
    is **normalised**: each class's true distance is scaled by
    `road_width / class_width`, so `dist <= road_width/2` is on-deck for every
    class and every existing consumer keeps working unchanged against the base
    width. That is not a trick for its own sake — `bake.py` fades the deck edge
    against `p.road_width` and offsets R1's baked wheel ruts in world units, so
    a normalised field gives a highway a proportionally wider verge and a track
    a proportionally narrower rut pair for free, which is what those classes
    should look like anyway.

    `blend` is per-cell because the shoulder is the one thing normalisation
    cannot carry: it is measured OUTSIDE the deck, where the nearest class is
    what should set the distance, not the base.
    """
    mask: np.ndarray            # bool, on-deck
    dist: np.ndarray            # normalised distance to centreline (world units)
    surf: np.ndarray            # uint8 SURF_*
    road_class: np.ndarray      # uint8 ROAD_* of the nearest deck, 255 off-deck
    blend: np.ndarray           # per-cell flatten blend distance (world units)


def _stamp_centrelines(polylines, seeds, shape, cellsize):
    """Mark every cell a polyline passes through; carry a per-cell seed value."""
    H, W = shape
    hit = np.zeros(shape, dtype=bool)
    seed = np.zeros(shape, dtype=np.uint8)
    for idx, line in enumerate(polylines):
        vals = None if seeds is None else np.asarray(seeds[idx], dtype=np.uint8)
        for i, (a, b) in enumerate(zip(line[:-1], line[1:])):
            seg = b - a
            length = float(np.hypot(*seg))
            steps = max(2, int(length / (cellsize * 0.5)))
            ts = np.linspace(0.0, 1.0, steps)
            cc = np.clip(((a[0] + seg[0] * ts) / cellsize).astype(np.int64), 0, W - 1)
            rr = np.clip(((a[1] + seg[1] * ts) / cellsize).astype(np.int64), 0, H - 1)
            hit[rr, cc] = True
            if vals is not None:
                seed[rr, cc] = vals[i]
                if i == len(line) - 2:
                    seed[rr[-1], cc[-1]] = vals[-1]
    return hit, seed


def rasterize_network(
    net: RoadNetwork,
    shape: tuple[int, int],
    cellsize: float,
    params: RoadParams | None = None,
    surfaces: list[np.ndarray] | None = None,
) -> RoadRaster:
    """Rasterize a hierarchical network at full resolution.

    **One distance transform per ROAD class, and that is the point.** A single
    transform over every centreline together would hand each cell the class of
    the nearest centreline, which is the wrong answer wherever the widths
    differ: a cell 30 units off a track and 35 off a highway belongs to the
    highway deck (half-width 35) and not to the track (half-width 13), and
    nearest-centreline says track. Per-class transforms ask each class its own
    question and combine the answers by width.

    A cell claimed by two classes takes the COARSEST (lowest ROAD_*), which is
    what makes a junction one piece of deck instead of two overlapping ones —
    see `flatten_network` for the half of that which is about terrain.
    """
    p = params or RoadParams()
    base_half = p.road_width * 0.5
    mask = np.zeros(shape, dtype=bool)
    dist = np.full(shape, np.inf)
    surf = np.zeros(shape, dtype=np.uint8)
    rcls = np.full(shape, 255, dtype=np.uint8)
    blend = np.zeros(shape, dtype=np.float64)

    present = sorted({ln.road_class for ln in net.links})
    for rc in present:
        sel = [i for i, ln in enumerate(net.links) if ln.road_class == rc]
        lines = [net.links[i].polyline for i in sel]
        seeds = None if surfaces is None else [surfaces[i] for i in sel]
        hit, seed = _stamp_centrelines(lines, seeds, shape, cellsize)
        if not hit.any():
            continue
        half = class_width(rc, p) * 0.5
        if surfaces is None:
            d_cells = ndimage.distance_transform_edt(~hit)
            idxs = None
        else:
            d_cells, idxs = ndimage.distance_transform_edt(~hit, return_indices=True)
        true_d = d_cells * cellsize
        on = true_d <= half
        # normalised so the base half-width is the on-deck test for every class
        norm = true_d * (base_half / half)
        # `present` is sorted ascending and ROAD_* is coarsest-first, so the
        # first class to claim a cell IS the coarsest one that covers it: a
        # junction is one piece of highway deck, not highway plus track.
        take = on & (rcls == 255)
        mask |= on
        rcls[take] = np.uint8(rc)
        if idxs is not None:
            surf[take] = seed[idxs[0], idxs[1]][take]
        # The SHOULDER belongs to whichever class is nearest in normalised
        # terms, on-deck or not — a highway's verge has to reach further up the
        # hillside than a track's, and every cell it reaches is by definition
        # off the deck, so keying the blend off `take` would put the per-class
        # shoulder everywhere except where a shoulder is.
        nearer = norm < dist
        dist = np.where(nearer, norm, dist)
        blend = np.where(nearer, class_blend(rc, p), blend)

    if not mask.any():
        dist = np.full(shape, base_half * 4.0)
        blend = np.full(shape, p.flatten_blend)
    if surfaces is None:
        surf = np.where(mask, np.uint8(SURF_DIRT), np.uint8(SURF_NONE))
    else:
        surf = np.where(mask, surf, np.uint8(SURF_NONE))
    return RoadRaster(mask=mask, dist=dist, surf=surf.astype(np.uint8),
                      road_class=rcls, blend=blend)


def flatten_network(
    height: np.ndarray,
    raster: RoadRaster,
    cellsize: float,
    params: RoadParams | None = None,
) -> np.ndarray:
    """`flatten_under_roads` over a whole hierarchy in ONE pass.

    **Why one pass, i.e. what a double-carve is.** `flatten_under_roads` blends
    the terrain toward a blur of *the terrain it was handed*. Run it once per
    class and the second pass blurs a surface the first pass already graded, so
    every cell both classes claim is pulled toward the graded surface twice —
    at a crossing that is a visible dish in the middle of the junction, and it
    grows with the number of classes meeting there. Carving once over the
    combined field is the fix, and it is why `rasterize_network` resolves the
    class per cell instead of leaving the caller to loop.

    The blur radius is the widest class present, because the blur is what
    decides how far up the hillside a cut reaches and a highway's cut is the
    one that has to look graded.
    """
    p = params or RoadParams()
    widest = p.road_width
    seen = raster.road_class[raster.road_class != 255]
    if seen.size:
        widest = max(class_width(int(c), p) for c in np.unique(seen))
    sigma = max(2.0, (widest * 4.0) / cellsize)
    graded = ndimage.gaussian_filter(height, sigma=sigma)

    half = p.road_width * 0.5          # raster.dist is normalised to this
    t = np.clip((raster.dist - half) / np.maximum(raster.blend, 1e-3), 0.0, 1.0)
    w = 1.0 - t * t * (3 - 2 * t)
    return height * (1.0 - w) + graded * w


def carve_junction_aprons(
    raster: RoadRaster,
    junctions: list[tuple[float, float]],
    cellsize: float,
    params: RoadParams | None = None,
    radius_mult: float = 1.8,
) -> None:
    """In-place: a worn apron where a lesser way meets the deck it joins.

    A T-junction planned as two polylines meets at a point, so the deck there is
    exactly as wide as the two decks crossing and reads as a seam rather than as
    a junction. The apron is the widening real junctions have, and it is
    deliberately expressed as ORDINARY DECK — same distance field, same class
    raster — rather than as a new splat layer: R1 established there is no fifth
    detail channel to give roads (the distr texture is RGBA and all four are
    spoken for), so a junction treatment that wanted its own channel could not
    have one. Being deck means it inherits the deck albedo recipe, the rock
    detail channel and the surface class of the ways arriving at it, which is
    what "junction splat treatment" has to mean here.
    """
    p = params or RoadParams()
    if not junctions:
        return
    # The radius is a multiple of the WIDEST deck present, not of the base
    # width. Keyed off the base it read 39.6 units against a highway whose own
    # half-width is 35.2, so the apron fell entirely inside the deck it was
    # meant to widen and added exactly zero cells — a junction treatment that
    # ran, reported nothing and did nothing.
    seen = raster.road_class[raster.road_class != 255]
    widest = (max(class_width(int(c), p) for c in np.unique(seen))
              if seen.size else p.road_width)
    radius = widest * 0.5 * radius_mult
    carve_plazas(raster.mask, raster.dist, list(junctions), radius, cellsize, p,
                 road_class=raster.surf)


# --- delivered grade, which is not the grade the planner costed --------------

def resample_by_arclength(pl: np.ndarray, spacing: float) -> np.ndarray:
    """Re-sample a polyline at constant arc-length spacing.

    Smoothing multiplies vertices without adding information (Chaikin's output
    has ~8x the vertices of its input at 3 rounds), so any per-vertex reading of
    a smoothed polyline is a reading at whatever resolution the smoother
    happened to produce — for grade that is catastrophic, because a heightmap
    step of one cell divided by a 2-unit segment reads as a 55 deg pitch. Every
    geometric measurement here declares its scale and takes it.
    """
    if len(pl) < 2:
        return pl.copy()
    d = np.concatenate([[0.0], np.cumsum(np.hypot(*(pl[1:] - pl[:-1]).T))])
    if d[-1] <= 0.0:
        return pl[:1].copy()
    s = np.arange(0.0, d[-1], max(spacing, 1e-6))
    if s.size < 2:
        return pl[[0, -1]].copy()
    return np.stack([np.interp(s, d, pl[:, 0]), np.interp(s, d, pl[:, 1])], axis=1)


def sample_height(height: np.ndarray, pl: np.ndarray, cellsize: float) -> np.ndarray:
    """Bilinear height under each vertex (nearest-cell sampling quantises the
    reading to the heightmap step, which is the same artefact again)."""
    H, W = height.shape
    x = np.clip(pl[:, 0] / cellsize, 0.0, W - 1.001)
    z = np.clip(pl[:, 1] / cellsize, 0.0, H - 1.001)
    x0 = x.astype(np.int64); z0 = z.astype(np.int64)
    fx = x - x0; fz = z - z0
    return (height[z0, x0] * (1 - fx) * (1 - fz) + height[z0, x0 + 1] * fx * (1 - fz)
            + height[z0 + 1, x0] * (1 - fx) * fz + height[z0 + 1, x0 + 1] * fx * fz)


def deck_grade_profile(
    polyline: np.ndarray,
    height: np.ndarray,
    cellsize: float,
    window: float,
) -> np.ndarray:
    """Grade (deg) of the DELIVERED deck, read over `window` world units.

    **This is not the quantity the planner costed, and the difference is a
    defect the planner cannot see** (roads R2). `_edge_costs` prices the mean
    absolute grade of one mask edge; the cost graph is memoryless, so nothing
    stops a route from alternating two legal traverses left and right — each
    edge holds the grade limit while the pair climbs at the terrain's fall
    line. Chaikin then smooths that saw-tooth into a straight line up the
    slope, so the map ships a deck at 20 deg that every edge certified at 5.
    On ordinary terrain it is rare (1-2 reversals per route, measured on the
    `rolling` fixture); where the cost field is laterally symmetric — a walled
    corridor, a uniform ramp — it is what the planner *always* does, because
    every zigzag pitch costs exactly the same and the tightest one is shortest.

    Until the planner carries heading state (see PLAN-maps §2d, the R2 design
    question), this is the instrument: measure what shipped, at a declared
    scale, and let `plan_network` say so out loud.
    """
    r = resample_by_arclength(polyline, window)
    if len(r) < 2:
        return np.zeros(0)
    hh = sample_height(height, r, cellsize)
    d = np.hypot(*(r[1:] - r[:-1]).T)
    return np.degrees(np.arctan(np.abs(np.diff(hh)) / np.maximum(d, 1e-9)))


def report_delivered_grades(
    net: RoadNetwork,
    height: np.ndarray,
    cellsize: float,
    params: RoadParams | None = None,
    progress=print,
) -> dict[int, tuple[float, float]]:
    """Per class: (p95, max) delivered grade, warning where it beats the limit.

    The window is one mask edge (`mask_k * plan_step * cellsize`) — the longest
    run the planner costs as a unit, i.e. the finest scale at which its grade
    claim is a claim about anything.
    """
    p = params or RoadParams()
    window = max(p.mask_k, 1) * p.plan_step * cellsize
    out: dict[int, tuple[float, float]] = {}
    for rc in sorted({ln.road_class for ln in net.links}):
        g = np.concatenate([deck_grade_profile(ln.polyline, height, cellsize, window)
                            for ln in net.links if ln.road_class == rc] or [np.zeros(1)])
        if g.size == 0:
            continue
        p95, mx = float(np.percentile(g, 95)), float(g.max())
        out[rc] = (p95, mx)
        limit = class_road_params(rc, p).max_grade_deg
        name = ROAD_CLASS_NAMES[rc]
        progress(f"  roads: {name} delivered grade p95 {p95:.1f} deg / max {mx:.1f} "
                 f"deg over {window:.0f}-unit windows (class limit {limit:.0f})")
        if p95 > limit * 1.15 + 0.5:
            progress(f"  roads: WARNING the delivered {name} deck is steeper than "
                     f"the class limit the route was planned under. Every mask "
                     f"edge held {limit:.0f} deg; the deck does not, because the "
                     f"cost graph is memoryless and a pair of opposite legal "
                     f"traverses climbs at the fall line (see "
                     f"roads.deck_grade_profile). This is a road that looks "
                     f"engineered and drives like a cliff.")
    return out
