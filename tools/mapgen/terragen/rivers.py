"""River ribbons: slope-area channels, smoothed centrelines, distance-field carve.

PLAN-maps.md §2b item 3. This replaces the "accumulation over a threshold,
subtract a blurred log" carve the generators used to do inline, which produced
8-connected staircase gullies with no water surface of their own: the mask was
a raster, so the carve inherited every D8 zigzag, and depth came from a scalar
function of accumulation, so a channel got deeper without getting wider and
confluences did nothing at all.

The pipeline here is the one the research verdict picked:

  1. **Channel seeding by slope-area** — `A * S^2 > C`, with `C` solved as a
     quantile so a tuned *fraction* of land cells seed (1-3 %), rather than a
     hand-picked accumulation number that means something different on every
     map size. Seeds are then closed downstream (if a cell is channel, its
     receiver is channel), so the network is a forest, never a dotted line.
  2. **Monotone water surface, assigned before any carving** — `w[i] =
     max(h[i], w[receiver[i]])` swept root-first over the flow tree. The
     surface is non-increasing downstream by construction, and where the
     terrain dips below it the result is a lake *that is never baked into the
     heightmap* — it falls out of `water_z` vs `terrain`, which is why those
     two fields stay separate all the way out of this module.
  3. **Centrelines, not rasters** — the channel forest is cut into reaches
     (headwater-to-junction, junction-to-junction, junction-to-outlet), each
     Douglas-Peucker simplified, Chaikin smoothed, then meandered by
     low-frequency noise along its own arclength (amplitude 1-2 channel
     widths, wavelength ~12). The meander is tapered to zero at both ends so
     junction points stay welded no matter what the noise does.
  4. **Width from hydraulic geometry** — `w = k * sqrt(A)`. That form is
     chosen for its confluence behaviour: drainage areas add, so
     `w_down^2 == w_1^2 + w_2^2` falls out of the model instead of being a
     special case bolted onto junctions (`test_junction_width_rule`).
  5. **Distance-field carve, combined with `min`** — never a lerp. A lerp
     toward a bed profile *raises* terrain wherever the bed sits above the
     ground (the outer bank of a meander on a slope, every time), and at a
     confluence it blends two beds into a ridge between them. `min` cannot do
     either: it is order-independent, idempotent, and monotone, so overlapping
     ribbons simply take the deeper one.

Reaches are binned by width and one EDT is run per bin, min-combined. A single
global EDT would assign every cell to its *nearest* centreline, which at a
confluence hands cells well inside a trunk river the shallow bed of the tributary
that happens to be a few metres closer — a bump in the middle of the water. Per-bin
min-combination removes that while staying at a handful of EDTs for the whole map.

Everything is deterministic from `seed` + inputs; no file I/O.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from . import hydrology as hyd
from . import noise as tn
from .roads import chaikin_smooth


@dataclass
class RiverParams:
    """Tunables for the whole river stage. World units are elmos."""

    # --- channel seeding -------------------------------------------------
    channel_fraction: float = 0.02   # fraction of LAND cells that SEED a channel
    min_slope: float = 1e-4          # floor on S so flat reaches keep a finite metric

    # --- hydraulic geometry ----------------------------------------------
    width_coef: float = 0.055        # w = width_coef * sqrt(drainage area)
    width_min: float = 12.0
    width_max: float = 140.0
    depth_ratio: float = 0.12        # depth = depth_ratio * width
    depth_min: float = 1.5
    depth_max: float = 14.0

    # --- carve shape ------------------------------------------------------
    # ⚠ THIS BLOCK IS A RELIEF TERM, not a river-edge cosmetic (PLAN-maps
    # M9f). The bank grades every cell within its reach of a channel down to
    # `water_z + rise(d - half)`, so on ground steeper than the bank it shaves
    # the valley shoulders. It, and not the bed depth above, is the entire
    # reason the packaged map stood 1.6-2.7 % under the relief the closed-loop
    # aim converged to (the bed spends 0.2 of 21.3 elmos at q0.999; pads,
    # roads and the sill carve spend 0.0 each). Pinned in
    # tests/test_rivers.py::BankClampIsAReliefTerm.
    #
    # ⚠ RESHAPED BY M9g (2026-08-18). What it used to be: a PLANE at
    # `bank_slope` out to a CONSTANT `bank_width`, `+inf` beyond. Both halves
    # were defects, and neither was `bank_slope` (0.35 = 19 deg and 0.65 = the
    # solver's own talus are visually indistinguishable and differ by 3.9
    # elmos of q0.999):
    #
    #   * a plane that rises slower than the ground it replaces cuts DEEPEST
    #     AT ITS RIM — 15.1 elmos at 0-10 from the water against 27.4 at
    #     55-70 on the shipped arc — and then terminated dead at the clip, so
    #     the last cell inside the ribbon was a step whose height was its own
    #     cut (mean 17, p95 51, max 153 elmos across one 8-elmo cell). That is
    #     the dark rim that turned a hillshade of a dense network into a quilt
    #     of flat pods.
    #   * a CONSTANT reach means a headwater trickle at the 9-elmo width floor
    #     (46 % of the arc's channel vertices) grades the same apron as the
    #     trunk, 12x its own water.
    #
    # So the bank is now a RAMP whose slope grows from `bank_slope` at the
    # wetted edge to `bank_outer_slope` one reach out (and stays there), over
    # a reach of `bank_reach_ratio * w` — the LOCAL channel width — clamped
    # into `[bank_reach_min, bank_width]`. `bank_width` survives as the CAP,
    # not the reach. An outer slope above the generator's own talus is what
    # makes the ribbon end where the bank CROSSES the hillside instead of
    # where the raster stops caring, and a crossing is not a truncation.
    #
    # ⚠ The rim step this leaves is a FLOOR, not a residual defect (M9g). A
    # `min` carve against a height-independent field is a projection: the cut
    # it leaves at its last inside cell is the slope difference at the
    # crossing times the cell size, so tapering it to nothing would need a
    # field that hugs the terrain — which is height-referenced, and therefore
    # neither idempotent nor order-independent (see `carve`). Gentler crossing
    # = wider ribbon = more relief spent; `bank_outer_slope` IS that dial.
    # Measured on tests/test_rivers.py's fixture, pre-M9g against shipped:
    # rim step mean 6.38 -> 3.93 elmos and p95 35.8 -> 15.5 against a natural
    # 1.30, ribbon 38.1 % -> 21.1 % of land, relief spent 10.97 -> 3.44 elmos
    # of q0.999, and the cut profile turns over (9.9 / 12.0 / 10.7 by band)
    # instead of climbing to a wall. Pinned in
    # tests/test_rivers.py::BankRibbonIsAValleyForm.
    bank_slope: float = 0.35         # rise per world unit at the wetted edge
    bank_width: float = 90.0         # CAP on the reach (was: the reach itself)
    bank_reach_ratio: float = 1.6    # reach = ratio * channel width (0 = constant)
    bank_reach_min: float = 12.0     # floor on the reach, world units
    bank_outer_slope: float = 1.4    # slope the ramp reaches one reach out
    bank_reach_slack: float = 3.0    # hard backstop clip, in reaches (1 = pre-M9g)

    # --- centreline treatment --------------------------------------------
    dp_epsilon: float = 24.0         # Douglas-Peucker tolerance, world units
    chaikin_iterations: int = 3
    meander_amp: float = 1.5         # x local channel width
    meander_wavelength: float = 12.0  # x local channel width
    meander_taper: float = 0.18      # fraction of reach length pinned at each end
    meander_octaves: int = 3

    width_bins: int = 4              # EDT passes; see module docstring


@dataclass
class RiverNetwork:
    """Everything the rest of the pipeline wants out of the river stage.

    `terrain`, `water_z` and `is_water` are deliberately three separate fields
    (§2b item 3: *never bake lakes into the heightmap*). `terrain` is the only
    one the SMF heightmap is written from.
    """

    terrain: np.ndarray        # (H, W) carved heightfield
    water_z: np.ndarray        # (H, W) water-surface elevation, NaN off-network
    is_water: np.ndarray       # (H, W) bool: wetted (channel, lake or sea)
    channel_mask: np.ndarray   # (H, W) bool: cells in the channel forest
    dist: np.ndarray           # (H, W) world-unit distance to nearest centreline
    polylines: list[np.ndarray]   # per reach, (N, 2) world (x, z)
    widths: list[np.ndarray]      # per reach, (N,) world-unit channel width
    surfaces: list[np.ndarray]    # per reach, (N,) water-surface elevation
    seed_threshold: float      # the solved slope-area constant C

    def attrs(self) -> list[np.ndarray]:
        """Per-reach (N, 2) width/water-surface pairs, in `carve`'s layout."""
        return [np.stack([w, s], axis=1) for w, s in zip(self.widths, self.surfaces)]


# ---------------------------------------------------------------------------
# 1. channel seeding
# ---------------------------------------------------------------------------

def slope_area_metric(
    height: np.ndarray,
    receivers: np.ndarray,
    cellsize: float,
    min_slope: float = 1e-4,
) -> np.ndarray:
    """`A * S^2` per cell, with A in world units^2 and S the D8 downstream slope.

    Note this takes *accumulation-free* inputs: A is supplied by the caller as
    part of `channel_mask`; this returns only the S^2 half scaled by cell area
    so the two can be multiplied. Kept separate because callers that already
    have `accum` should not pay for recomputing it.
    """
    n = receivers.size
    idx = np.arange(n, dtype=np.int64)
    W = height.shape[1]
    drow = np.abs(idx // W - receivers // W)
    dcol = np.abs(idx % W - receivers % W)
    step = np.where((drow + dcol) == 2, np.sqrt(2.0), 1.0) * cellsize
    flat = height.ravel()
    drop = flat - flat[receivers]
    slope = np.where(step > 0, drop / np.maximum(step, 1e-9), 0.0)
    return np.maximum(slope, min_slope) ** 2


def channel_mask(
    height: np.ndarray,
    receivers: np.ndarray,
    levels: list[np.ndarray],
    accum: np.ndarray,
    cellsize: float,
    water_level: float,
    params: RiverParams | None = None,
) -> tuple[np.ndarray, float]:
    """Seed channels where `A * S^2` is in the top `channel_fraction` of land,
    then close the seed set downstream.

    Returns `(mask, C)`. `mask` is a (H, W) boolean over the channel forest;
    `C` is the solved slope-area constant, reported so a generator can record
    what its terrain actually needed rather than assume a literal.

    Closure is what makes this a network: the raw quantile picks steep, high-
    accumulation cells, which on real terrain is a *dotted* line — a low-
    gradient reach mid-river drops below C and the channel vanishes for a
    hundred metres. Once a cell is a channel every cell it drains through is
    one too, which is both hydrologically true and the property reach
    extraction depends on.
    """
    p = params or RiverParams()
    shape = height.shape
    land = (height > water_level).ravel()
    if not land.any():
        return np.zeros(shape, dtype=bool), float("inf")

    area = accum.astype(np.float64) * (cellsize * cellsize)
    metric = area * slope_area_metric(height, receivers, cellsize, p.min_slope)

    frac = float(np.clip(p.channel_fraction, 1e-6, 1.0))
    c = float(np.quantile(metric[land], 1.0 - frac))
    seed = (metric >= c) & land

    # Downstream closure is exactly "does anything upstream of me seed?", which
    # is a flow accumulation with the seeds as weights — so it reuses the
    # shipping level-order solver instead of a second scatter loop of its own.
    upstream = hyd.flow_accumulation(receivers, levels,
                                     weights=seed.astype(np.float64))
    ch = (upstream > 0.0) & land  # a channel stops at the shoreline
    return ch.reshape(shape), c


# ---------------------------------------------------------------------------
# 2. monotone water surface
# ---------------------------------------------------------------------------

def water_surface(
    height: np.ndarray,
    receivers: np.ndarray,
    levels: list[np.ndarray],
    water_level: float,
) -> np.ndarray:
    """Water-surface elevation per cell, non-increasing downstream.

    Swept root-first: `w[i] = max(h[i], w[receiver[i]])`. Every cell's surface
    is at least its own ground (so the surface never runs underground) and at
    least its receiver's (so it never runs uphill). Where `h < w` the cell is
    under water — a lake — and the *heightmap is not touched*: the depression
    stays in the terrain and the lake exists only as the gap between these two
    fields.
    """
    flat = height.ravel()
    w = np.maximum(flat, water_level)
    for lvl in levels[1:]:  # roots keep max(h, sea)
        w[lvl] = np.maximum(w[lvl], w[receivers[lvl]])
    return w.reshape(height.shape)


# ---------------------------------------------------------------------------
# 3. reach extraction
# ---------------------------------------------------------------------------

def extract_reaches(
    mask: np.ndarray,
    receivers: np.ndarray,
) -> list[np.ndarray]:
    """Cut the channel forest into reaches of flat cell indices.

    A reach runs headwater-to-junction, junction-to-junction or
    junction/headwater-to-outlet. Junctions appear as the *last* point of every
    reach flowing into them and as the *first* point of the one flowing out, so
    the ribbons weld rather than abut. Every channel edge is covered exactly
    once (`test_reaches_cover_every_edge_once`).
    """
    ch = mask.ravel()
    ci = np.flatnonzero(ch)
    if ci.size == 0:
        return []

    recv = receivers
    down = recv[ci]
    moving = down != ci                      # drop self-receiving roots
    donors = np.bincount(down[moving], minlength=ch.size)

    is_junction = ch & (donors >= 2)
    is_head = ch & (donors == 0)
    starts = np.flatnonzero(is_head | is_junction)

    reaches: list[np.ndarray] = []
    for s in starts:
        pts = [int(s)]
        cur = int(s)
        while True:
            nxt = int(recv[cur])
            if nxt == cur or not ch[nxt]:
                break
            pts.append(nxt)
            if is_junction[nxt]:
                break
            cur = nxt
        if len(pts) >= 2:
            reaches.append(np.array(pts, dtype=np.int64))
    return reaches


# ---------------------------------------------------------------------------
# 4. centreline treatment
# ---------------------------------------------------------------------------

def douglas_peucker(pts: np.ndarray, epsilon: float) -> np.ndarray:
    """Indices of the Douglas-Peucker simplification of an (N, 2) polyline.

    Returns indices rather than points so callers can carry per-vertex
    attributes (width, water surface) through the simplification unchanged.
    Endpoints are always kept.
    """
    n = len(pts)
    if n <= 2 or epsilon <= 0:
        return np.arange(n, dtype=np.int64)

    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        seg = b - a
        length = float(np.hypot(*seg))
        rel = pts[i + 1:j] - a
        if length < 1e-9:
            d = np.hypot(rel[:, 0], rel[:, 1])
        else:
            d = np.abs(rel[:, 0] * seg[1] - rel[:, 1] * seg[0]) / length
        k = int(np.argmax(d))
        if d[k] > epsilon:
            k += i + 1
            keep[k] = True
            stack.append((i, k))
            stack.append((k, j))
    return np.flatnonzero(keep)


def meander(
    pts: np.ndarray,
    widths: np.ndarray,
    seed: int,
    params: RiverParams | None = None,
) -> np.ndarray:
    """Offset an (N, 2) centreline sideways by low-frequency noise.

    Amplitude scales with the *local* channel width (a trunk river swings
    further than a headwater creek) and wavelength with the reach's mean width,
    per §2b item 3's `amp 1-2w, lambda ~= 12w`. The offset is tapered to zero
    over `meander_taper` of the reach at each end, which is what keeps
    junctions welded: reach endpoints sit exactly on a shared cell centre, and
    a meander that moved them would tear the network apart at every confluence.
    """
    p = params or RiverParams()
    n = len(pts)
    if n < 3 or p.meander_amp <= 0:
        return pts.copy()

    seg = np.diff(pts, axis=0)
    step = np.hypot(seg[:, 0], seg[:, 1])
    s = np.concatenate([[0.0], np.cumsum(step)])
    total = float(s[-1])
    if total < 1e-6:
        return pts.copy()

    lam = max(p.meander_wavelength * float(np.mean(widths)), 1e-3)
    amp = p.meander_amp * widths
    wave = tn.fbm(tn.SimplexNoise(seed), s / lam, np.zeros_like(s),
                  octaves=p.meander_octaves)

    t = s / total
    edge = max(p.meander_taper, 1e-6)
    u = np.clip(np.minimum(t, 1.0 - t) / edge, 0.0, 1.0)
    taper = u * u * (3.0 - 2.0 * u)          # smoothstep, 0 at both endpoints

    # unit normals from central-difference tangents
    tan = np.empty_like(pts)
    tan[1:-1] = pts[2:] - pts[:-2]
    tan[0] = pts[1] - pts[0]
    tan[-1] = pts[-1] - pts[-2]
    mag = np.hypot(tan[:, 0], tan[:, 1])
    mag[mag < 1e-9] = 1.0
    nx = -tan[:, 1] / mag
    nz = tan[:, 0] / mag

    off = wave * amp * taper
    out = pts.copy()
    out[:, 0] += nx * off
    out[:, 1] += nz * off
    return out


def channel_width(area: np.ndarray, params: RiverParams | None = None) -> np.ndarray:
    """Hydraulic-geometry width from drainage area: `w = k * sqrt(A)`.

    The square-root form is not cosmetic. Drainage areas add at a confluence,
    so this model satisfies `w_down^2 = w_1^2 + w_2^2` — §2b item 3's junction
    rule — without any junction-specific code. Clamping to
    `[width_min, width_max]` is the only place that identity is approximate,
    and only outside the clamp range.
    """
    p = params or RiverParams()
    return np.clip(p.width_coef * np.sqrt(np.maximum(area, 0.0)),
                   p.width_min, p.width_max)


def junction_width(w1: float, w2: float) -> float:
    """`sqrt(w1^2 + w2^2)` — the width two confluent channels combine to."""
    return float(np.hypot(w1, w2))


# ---------------------------------------------------------------------------
# 5. carve
# ---------------------------------------------------------------------------

def _resample(pts: np.ndarray, attrs: np.ndarray, cellsize: float):
    """Densely resample a polyline (and its per-vertex attributes) at half-cell
    steps, so rasterizing it leaves no gaps."""
    seg = np.diff(pts, axis=0)
    step = np.hypot(seg[:, 0], seg[:, 1])
    s = np.concatenate([[0.0], np.cumsum(step)])
    total = float(s[-1])
    n = max(2, int(total / (cellsize * 0.5)) + 1)
    q = np.linspace(0.0, total, n)
    x = np.interp(q, s, pts[:, 0])
    z = np.interp(q, s, pts[:, 1])
    a = np.stack([np.interp(q, s, attrs[:, k]) for k in range(attrs.shape[1])], axis=1)
    return x, z, a


def _bin_field(shape, cellsize, lines, attrs, params: RiverParams):
    """Bed/bank elevation field for one width bin, +inf outside its influence.

    One EDT with `return_indices` gives, for every cell, both the distance to
    the nearest centreline *and which sample* that was — so bed elevation,
    half-width and depth are gathered from the right point on the right reach
    in a single pass over the map.
    """
    H, W = shape
    cells: list[np.ndarray] = []
    ws: list[np.ndarray] = []
    wzs: list[np.ndarray] = []
    for line, a in zip(lines, attrs):
        x, z, sa = _resample(line, a, cellsize)
        cc = np.clip((x / cellsize).astype(np.int64), 0, W - 1)
        rr = np.clip((z / cellsize).astype(np.int64), 0, H - 1)
        cells.append(rr * W + cc)
        ws.append(sa[:, 0])
        wzs.append(sa[:, 1])

    if not cells:
        return None
    cell_idx = np.concatenate(cells)
    w_all = np.concatenate(ws)
    wz_all = np.concatenate(wzs)

    # One winner per cell, chosen by (width, water surface) rather than by who
    # wrote last. Reaches share cells — every junction cell belongs to three of
    # them — and a last-writer-wins raster makes the carve depend on the ORDER
    # of the reach list, which is not a property of the terrain
    # (`test_carve_is_order_independent_and_idempotent`). Widest wins, because
    # at a confluence the trunk river is what the cell should be.
    order = np.lexsort((wz_all, w_all, cell_idx))
    cs = cell_idx[order]
    last = np.ones(order.size, dtype=bool)
    last[:-1] = cs[:-1] != cs[1:]
    win = order[last]

    hit = np.zeros(H * W, dtype=bool)
    src_wz = np.zeros(H * W)
    src_half = np.zeros(H * W)
    src_dep = np.zeros(H * W)
    wc = cell_idx[win]
    wv = w_all[win]
    hit[wc] = True
    src_wz[wc] = wz_all[win]
    src_half[wc] = wv * 0.5
    src_dep[wc] = np.clip(params.depth_ratio * wv,
                          params.depth_min, params.depth_max)

    hit = hit.reshape(shape)
    src_wz = src_wz.reshape(shape)
    src_half = src_half.reshape(shape)
    src_dep = src_dep.reshape(shape)
    if not hit.any():
        return None

    d, (ir, ic) = ndimage.distance_transform_edt(
        ~hit, sampling=cellsize, return_indices=True)
    wz = src_wz[ir, ic]
    half = np.maximum(src_half[ir, ic], 1e-6)
    dep = src_dep[ir, ic]

    if params.bank_reach_ratio > 0.0:
        reach = np.clip(params.bank_reach_ratio * (2.0 * half),
                        params.bank_reach_min, params.bank_width)
    else:
        reach = np.full_like(half, params.bank_width)
    reach = np.maximum(reach, 1e-6)

    inner = d <= half
    bed = wz - dep * np.clip(1.0 - (d / half) ** 2, 0.0, 1.0)

    # The bank is a RAMP, not a plane (M9g). Its slope grows from `bank_slope`
    # at the wetted edge to `bank_outer_slope` one reach out, and stays there;
    # so a bank that starts below the hillside it grades ends above it, and
    # the ribbon ends where the two surfaces CROSS instead of where the raster
    # stops caring. That is the whole of the rim-step fix: `min` carving can
    # only leave a step if the ribbon is truncated mid-cut, and the crossing
    # of two surfaces is not a truncation. `bank_outer_slope` above the
    # generator's own talus is what makes the crossing exist on steep ground.
    x = np.maximum(d - half, 0.0)
    ramp = np.minimum(x, reach)
    extra = max(params.bank_outer_slope - params.bank_slope, 0.0)
    rise = (params.bank_slope * x
            + extra * (ramp * ramp * 0.5 / reach + np.maximum(x - reach, 0.0)))
    bank = wz + rise
    field = np.where(inner, bed, bank)
    field = np.where(d <= half + params.bank_reach_slack * reach, field, np.inf)
    return field, inner, wz, d


def carve(
    height: np.ndarray,
    lines: list[np.ndarray],
    attrs: list[np.ndarray],
    cellsize: float,
    water_level: float,
    params: RiverParams | None = None,
    protect: np.ndarray | None = None,
):
    """Cut river ribbons into `height` with `min`, never a lerp.

    `attrs[i]` is (N, 2): per-vertex channel width and water-surface elevation.

    `min` is the whole point. It is idempotent, order-independent and can only
    ever lower terrain, so: carving the same network twice changes nothing;
    two ribbons crossing produce the deeper bed rather than a blend of two beds
    (which is a ridge down the middle of the confluence); and a bed that
    happens to sit *above* the ground — routine on the outer bank of a meander
    running across a slope — is a no-op instead of a wall of fill. A lerp fails
    all three (`test_lerp_carve_raises_terrain_min_carve_never_does`).

    `protect` is an optional (H, W) weight in [0, 1] attenuating the finished
    cut — 1 means "leave this ground exactly as authored". A generator with a
    gameplay contract needs it: meridian2 pulls ford decks, the row-D channel,
    the slope-band regions and the start pads to specified elevations, and a
    tributary wandering through a start pad would silently cost that side its
    buildable core. Note this attenuates the *combined* cut, after the ribbons
    have already been min-combined into `field` — it is not a per-ribbon blend,
    and being a multiplier on a non-negative cut it still cannot raise ground.

    Returns `(terrain, water_z, is_water, dist)`; `height` is not mutated.
    """
    p = params or RiverParams()
    shape = height.shape
    field = np.full(shape, np.inf)
    wet = np.zeros(shape, dtype=bool)
    surface = np.full(shape, -np.inf)
    dist = np.full(shape, np.inf)

    keep = [i for i in range(len(lines)) if len(lines[i]) >= 2]
    if keep:
        means = np.array([float(np.mean(attrs[i][:, 0])) for i in keep])
        nbins = max(1, min(p.width_bins, len(keep)))
        edges = np.quantile(means, np.linspace(0.0, 1.0, nbins + 1))
        edges[0] = -np.inf
        edges[-1] = np.inf
        which = np.searchsorted(edges, means, side="right") - 1
        which = np.clip(which, 0, nbins - 1)

        for b in range(nbins):
            sel = [keep[k] for k in np.flatnonzero(which == b)]
            if not sel:
                continue
            got = _bin_field(shape, cellsize, [lines[i] for i in sel],
                             [attrs[i] for i in sel], p)
            if got is None:
                continue
            f, inner, wz, d = got
            np.minimum(field, f, out=field)
            np.minimum(dist, d, out=dist)
            wet |= inner
            np.maximum(surface, np.where(inner, wz, -np.inf), out=surface)

    cut = np.maximum(height - field, 0.0)
    if protect is not None:
        cut = cut * (1.0 - np.clip(protect, 0.0, 1.0))
        wet &= cut > 1e-9      # ground that was not cut did not become river
    terrain = height - cut
    water_z = np.where(wet, surface, np.nan)
    is_water = (wet & (terrain < surface)) | (terrain <= water_level)
    return terrain, water_z, is_water, dist


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------

def build(
    height: np.ndarray,
    receivers: np.ndarray,
    levels: list[np.ndarray],
    accum: np.ndarray,
    cellsize: float,
    water_level: float,
    seed: int,
    params: RiverParams | None = None,
    protect: np.ndarray | None = None,
) -> RiverNetwork:
    """Run the whole river stage on a routed heightfield.

    `receivers`/`levels`/`accum` come from `hydrology` on the *filled +
    flat-resolved* surface; `height` is the real (unfilled) terrain, because
    that is what gets carved and what the water surface is measured against.
    `protect` is passed through to `carve` — see there.
    """
    p = params or RiverParams()
    mask, c = channel_mask(height, receivers, levels, accum,
                           cellsize, water_level, p)
    wsurf = water_surface(height, receivers, levels, water_level)
    reaches = extract_reaches(mask, receivers)

    area = accum.astype(np.float64) * (cellsize * cellsize)
    width_flat = channel_width(area, p)
    W = height.shape[1]
    wz_flat = wsurf.ravel()

    lines: list[np.ndarray] = []
    attrs: list[np.ndarray] = []
    for ridx, cells in enumerate(reaches):
        pts = np.stack([(cells % W) * cellsize, (cells // W) * cellsize],
                       axis=1).astype(np.float64)
        a = np.stack([width_flat[cells], wz_flat[cells]], axis=1)

        k = douglas_peucker(pts, p.dp_epsilon)
        pts, a = pts[k], a[k]

        both = chaikin_smooth(np.hstack([pts, a]), iterations=p.chaikin_iterations)
        pts, a = both[:, :2], both[:, 2:]

        # the water surface must stay monotone after smoothing, and Chaikin
        # averages neighbours so it cannot introduce a rise the sweep excluded
        pts = meander(pts, a[:, 0], seed * 1000003 + ridx, p)
        lines.append(pts)
        attrs.append(a)

    terrain, water_z, is_water, dist = carve(
        height, lines, attrs, cellsize, water_level, p, protect)

    return RiverNetwork(
        terrain=terrain,
        water_z=water_z,
        is_water=is_water,
        channel_mask=mask,
        dist=dist,
        polylines=lines,
        widths=[a[:, 0] for a in attrs],
        surfaces=[a[:, 1] for a in attrs],
        seed_threshold=c,
    )
