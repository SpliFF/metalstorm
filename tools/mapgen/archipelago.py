#!/usr/bin/env python3
"""archipelago.py — free-form island map generator (terragen).

Unlike meridian2.py (which re-enforces a hand-authored 24-region layout),
this generator is fully parameterized and derives EVERYTHING from its
inputs — island placement, elevations, start positions, settlements,
per-island road networks, biomes, vegetation, ruins. Deterministic:

    same (--seed, --landmass, --islands, --terrain, --router)
        =>  byte-identical map

The --landmass fraction is a hard contract, enforced by quantile
calibration of the height field both before and after erosion: exactly
that fraction of the map area ends up above the waterline.

Usage:
    .venv/bin/python archipelago.py                        # shipped defaults
    .venv/bin/python archipelago.py --seed 7 --landmass 0.28 --islands 12
    .venv/bin/python archipelago.py --fast --preview-only  # 30 s look
    .venv/bin/python archipelago.py --climate arid --id dune_reach \
        --name "Dune Reach"                                # climate variant
    .venv/bin/python archipelago.py --terrain arc --landmass 0.30 \
        --id sundered_arc --name "Sundered Arc"            # tectonic variant
    .venv/bin/python archipelago.py --no-package           # layer tuning
    .venv/bin/python archipelago.py --selftest [--fast]    # determinism gate

Package the result with gen_vegetation_models.py --out <map dir> --climate
<same climate> (prop models — a climate palette references props temperate
does not, and the flag keeps a package to the ones it places) and
build/*/tools/mapconverter (processing + validation).
"""
from __future__ import annotations

import argparse
import os
import shutil
import time

import numpy as np
from scipy import ndimage

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from terragen import biomes as bio          # noqa: E402
from terragen import erosion as ero         # noqa: E402
from terragen import hydrology as hyd       # noqa: E402
from terragen import noise as tn            # noqa: E402
from terragen import package as pkg         # noqa: E402
from terragen import placement as pl        # noqa: E402
from terragen import rivers as riv          # noqa: E402
from terragen import roads as rd            # noqa: E402
from terragen import selftest as stest      # noqa: E402
from terragen import settle as st           # noqa: E402
from terragen import uplift as up           # noqa: E402
from terragen import vegetation as veg      # noqa: E402
from terragen.vegetation import _hash01     # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MAP_SIZE = 16384.0
SEED_DEFAULT = 20260730
N_STARTS = 8
SYNTH_REV = 4          # bump when synth_height changes — keys the erosion cache


# ---------------------------------------------------------------------------
# Island skeleton
# ---------------------------------------------------------------------------

def island_centres(seed: int, count: int, margin: float, min_sep: float):
    """Deterministic dart-throwing: hashed candidate sequence, greedy accept
    with min separation. Returns (x, z, radius_scale, peak_scale) rows."""
    out = []
    span = MAP_SIZE - 2 * margin
    k = np.arange(count * 64, dtype=np.int64)
    hx = _hash01(k, k * 7 + 1, seed, 41)
    hz = _hash01(k, k * 7 + 2, seed, 42)
    hr = _hash01(k, k * 7 + 3, seed, 43)
    hp = _hash01(k, k * 7 + 4, seed, 44)
    for i in range(k.size):
        x = margin + hx[i] * span
        z = margin + hz[i] * span
        if all((x - ox) ** 2 + (z - oz) ** 2 >= min_sep ** 2
               for ox, oz, _, _ in out):
            out.append((x, z, 0.55 + 0.9 * hr[i], 0.6 + 0.8 * hp[i]))
            if len(out) == count:
                break
    return out


def arc_centreline(bow: float = 3400.0, samples: int = 2048):
    """A bowed volcanic-arc trace across the map, SW -> NE.

    Real island arcs are the surface expression of a subducting slab, so
    they are long, gently curved and *segmented* — which is the shape that
    makes an archipelago out of one tectonic structure.
    """
    t = np.linspace(0.0, 1.0, samples)
    ax = 1700.0 + t * (MAP_SIZE - 3400.0)
    az = 2400.0 + t * (MAP_SIZE - 4800.0) - bow * np.sin(np.pi * t)
    return ax, az


def arc_uplift(seed: int, xx: np.ndarray, zz: np.ndarray, cell: float,
               spacing: float = 2900.0, sig_along: float = 1150.0,
               sig_across: float = 620.0, floor: float = 0.10,
               bow: float = 3400.0) -> np.ndarray:
    """The `--terrain arc` authoring surface: uplift, normalised to [0, 1].

    En-echelon volcanic centres strung along `arc_centreline`, each an
    ellipse elongated along strike and stepped across it, over a weak
    submarine ridge (`floor`) that joins them below the waterline. The
    segmentation is not decoration: a *smooth* uplift belt converges to one
    continuous wall with regular transverse valleys (measured — PLAN-maps
    M8p), which is a mountain range, not an archipelago.

    Amplitudes here are relative. `uplift.scale_uplift_for_relief` turns
    them into a rate that stands the highest ground where the author asked.
    """
    ax, az = arc_centreline(bow)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(ax), np.diff(az)))])

    n_c = int(s[-1] // spacing) + 1
    j = np.arange(n_c, dtype=np.int64)
    h_off = _hash01(j, j * 7 + 1, seed, 61)      # along-strike jitter
    h_ech = _hash01(j, j * 7 + 2, seed, 62)      # across-strike step
    h_amp = _hash01(j, j * 7 + 3, seed, 63)
    h_len = _hash01(j, j * 7 + 4, seed, 64)

    u = np.zeros(xx.shape)
    for i in range(n_c):
        sj = (i + 0.5) * spacing + (h_off[i] - 0.5) * 0.44 * spacing
        if sj <= 0.0 or sj >= s[-1]:
            continue
        k = int(np.clip(np.searchsorted(s, sj), 1, ax.size - 2))
        tx, tz = ax[k + 1] - ax[k - 1], az[k + 1] - az[k - 1]
        L = np.hypot(tx, tz)
        tx, tz = tx / L, tz / L
        off = (h_ech[i] * 2.0 - 1.0) * sig_across * 1.5
        cx, cz = ax[k] - tz * off, az[k] + tx * off
        dx, dz = xx - cx, zz - cz
        along = (dx * tx + dz * tz) / (sig_along * (0.75 + 0.5 * h_len[i]))
        across = (-dx * tz + dz * tx) / sig_across
        u = np.maximum(u, (0.55 + 0.45 * h_amp[i])
                       * np.exp(-(along ** 2 + across ** 2)))

    d_arc = np.full(xx.shape, np.inf)
    for k in range(0, ax.size, 8):
        d_arc = np.minimum(d_arc, np.hypot(xx - ax[k], zz - az[k]))
    u = np.maximum(u, floor * np.exp(-(d_arc / 2600.0) ** 2))

    # a little lithospheric grain, so the centres are not nine ellipses
    u *= 0.55 + 0.6 * (0.5 + 0.5 * tn.fbm(
        tn.SimplexNoise(seed + 3), xx / 1900.0, zz / 1900.0, octaves=3))
    u = up.smooth_uplift(u, cell, wavelength_elmos=900.0)
    return u / max(float(u.max()), 1e-9)


def arc_platform(seed: int, landmass: float, u: np.ndarray,
                 xx: np.ndarray, zz: np.ndarray) -> np.ndarray:
    """The surface the arc grows out of: trench floor + a shallow shelf.

    The LEM has no sea in it — every cell erodes as if subaerial — so the
    *bathymetry* has to be authored even when the relief is not. Uplift
    draws the land; this draws the water it stands in, and the landmass
    quantile puts the waterline where the contract says.
    """
    coast = tn.fbm(tn.SimplexNoise(seed + 9), xx / 2400.0, zz / 2400.0,
                   octaves=5)
    h = -90.0 + 240.0 * np.clip(u * 1.9, 0.0, 1.0) + 30.0 * coast
    return h - np.quantile(h, 1.0 - landmass)


def synth_height(seed: int, landmass: float, islands: int,
                 xx: np.ndarray, zz: np.ndarray) -> np.ndarray:
    """Island height skeleton + detail, calibrated so that exactly
    `landmass` of the area sits above 0."""
    base_r = MAP_SIZE / (2.0 * np.sqrt(islands) + 1.0)
    # separation ~2x the mound reach keeps islands DISTINCT — adjacent pairs
    # may still merge into a larger landmass, but not into one continent
    min_sep = base_r * 1.9
    centres = island_centres(seed, islands, margin=base_r * 0.8,
                             min_sep=min_sep)

    # summed radial mounds: only close pairs merge. Gentler falloff exponent
    # keeps a wide shore shelf so coast noise can genuinely reshape the
    # waterline (steep-edged discs stay circles no matter the noise).
    h = np.full(xx.shape, -70.0)
    for (cx, cz, rs, ps) in centres:
        r = base_r * rs
        d = np.hypot(xx - cx, zz - cz)
        f = np.clip(1.0 - d / (r * 1.25), 0.0, 1.0) ** 1.45
        h += f * 400.0 * ps

    # coastline character + interior relief
    n = tn.SimplexNoise(seed)
    wx, wz = tn.domain_warp(n, xx / 2100.0, zz / 2100.0,
                            strength=0.6, frequency=1.0)
    coast = tn.fbm(n, wx * 1.6, wz * 1.6, octaves=5)          # bays, capes
    hills = tn.fbm(n, xx / 760.0 + 37.0, zz / 760.0 - 11.0, octaves=5)
    ridges = tn.ridged(tn.SimplexNoise(seed + 1), wx * 2.1, wz * 2.1, octaves=5)
    interior = np.clip(h / 260.0, 0.0, 1.0)                    # 0 at sea, 1 inland
    # deep-water attenuation: no noise-speck islets in the open ocean
    # (fringe skerries near the islands survive); shore band concentrates
    # the coast noise where it reshapes the waterline into bays and capes
    fringe = np.clip((h + 45.0) / 60.0, 0.10, 1.0)
    shore_band = np.exp(-(h / 110.0) ** 2)
    h = (h
         + 150.0 * coast * np.clip(shore_band + 0.35 * interior, 0.0, 1.0) * fringe
         + 55.0 * hills * fringe
         + 230.0 * (ridges - 0.45) * interior ** 1.9)

    # landmass contract: put the waterline at the (1-landmass) quantile
    h -= np.quantile(h, 1.0 - landmass)
    return h


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------

def generate(out_dir: str, seed: int, landmass: float = 0.34, islands: int = 9,
             fast: bool = False, with_features: bool = False,
             preview_only: bool = False, no_package: bool = False,
             map_id: str = "skerry_reach", display_name: str = "Skerry Reach",
             climate: str = "temperate", terrain: str = "mounds",
             router: str = "auto", relief_target: float = 950.0):
    t0 = time.time()
    cell = 32.0 if fast else 8.0
    S = int(MAP_SIZE / cell) + 1
    # 'auto' is per-terrain, not global: `mounds` must stay on D8 or the
    # shipped skerry_reach package moves, while `arc` builds its channel
    # network from nothing and so inherits whatever lattice it routes over
    # (PLAN-maps M8q).
    if router == "auto":
        router = "dinf" if terrain == "arc" else "d8"
    print(f"grid {S}x{S} @ {cell} elmos/cell  "
          f"(seed={seed} landmass={landmass} islands={islands} "
          f"climate={climate} terrain={terrain} router={router})")

    zz, xx = np.mgrid[0:S, 0:S].astype(np.float64) * cell
    hardness = 0.016 + 0.020 * (0.5 + 0.5 * tn.fbm(
        tn.SimplexNoise(seed + 2), xx / 3400.0, zz / 3400.0, octaves=3))

    # 1. skeleton — drawn (mounds) or authored as a rate (arc)
    u = None
    if terrain == "arc":
        u = arc_uplift(seed, xx, zz, cell)
        h = arc_platform(seed, landmass, u, xx, zz)
        # aim with the PATH INTEGRAL, not (U/K)*Phi: this field varies on
        # the drainage network's own scale, which is exactly the case the
        # scalar form factorises away (2.4x out — PLAN-maps M8p)
        u = u * up.scale_uplift_for_relief(h, u, hardness, relief_target,
                                           router=router)
        print(f"arc uplift authored {time.time()-t0:.0f}s "
              f"(aim {relief_target:.0f} elmos, U max {u.max():.4f})")
    else:
        h = synth_height(seed, landmass, islands, xx, zz)
    print(f"synth done {time.time()-t0:.0f}s relief {h.min():.0f}..{h.max():.0f}")

    # 2. erosion (cached per parameter set — the cache key IS the contract)
    cache = os.path.join(
        os.environ.get("TMPDIR", "/tmp"),
        f"archipelago_eroded_r{SYNTH_REV}_{terrain}_{router}_{seed}_{landmass}_"
        f"{islands}_{relief_target}_{'fast' if fast else 'full'}.npy")
    if os.path.exists(cache):
        h = np.load(cache)
        print(f"erosion loaded from cache {cache}")
    elif terrain == "arc":
        # the landform IS the erosion here, so it has to run to steady state:
        # ~30 iterations only *adds* the field (M8m). Coarse-first makes that
        # affordable, and `match_relief` is what keeps the coarse grid aiming
        # at the fine grid's relief rather than half of it.
        h = ero.stream_power_erode_multires(
            h, cellsize=cell, coarse_factor=4,
            coarse_iterations=(600 if fast else 3000),
            fine_iterations=(10 if fast else 30),
            uplift=u, k_erode=hardness, dt=1.4, m_exp=0.5,
            talus_deg=33.0, thermal_rate=0.35, router=router,
            progress=lambda i, n_: print(
                f"  erosion {i}/{n_} ({time.time()-t0:.0f}s)")
            if i % 200 == 0 else None)
        np.save(cache, h)
        print(f"erosion done {time.time()-t0:.0f}s (cached -> {cache})")
    else:
        h = ero.stream_power_erode(
            h, cellsize=cell, iterations=(10 if fast else 26), dt=1.4,
            k_erode=hardness, m_exp=0.5, talus_deg=33.0, thermal_rate=0.35,
            router=router,
            progress=lambda i, n_: print(
                f"  erosion {i}/{n_} ({time.time()-t0:.0f}s)")
            if i % 10 == 0 else None)
        np.save(cache, h)
        print(f"erosion done {time.time()-t0:.0f}s (cached -> {cache})")

    # re-assert the landmass contract (erosion moves mass around)
    h -= np.quantile(h, 1.0 - landmass)
    h = np.maximum(h, -95.0)                     # bounded seafloor

    # 3. island inventory
    land = h > 0.0
    labels, n_isl = ndimage.label(land)
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0                                  # background (sea)
    order = np.argsort(sizes)[::-1]               # island labels, largest first
    big = [int(l) for l in order if sizes[l] * cell * cell > 1.2e6][:islands]
    land_frac = float(land.mean())
    print(f"islands: {n_isl} components, {len(big)} major, "
          f"land {land_frac:.1%} (target {landmass:.1%})")

    # 4. preliminary climate for settlement scoring
    def fields(hh):
        gy, gx = np.gradient(hh, cell)
        sl = np.degrees(np.arctan(np.hypot(gx, gy)))
        # base_moisture re-based from the 0.45 default — see the same note in
        # meridian2.py. The old rain shadow was drying this map by 0.070 (more
        # than Meridian, because 66% of it is sea and the running-max model
        # counted every island's peak against everything downwind of it).
        cp = bio.ClimateParams(seed=seed, lat_axis="z", lat_hot=0.60,
                               lat_cold=0.42, altitude_lapse=0.55,
                               wind_dir=(1.0, 0.2), base_moisture=0.380)
        # --climate shifts that baseline; "temperate" is an exact identity
        cp = bio.apply_climate_preset(cp, climate)
        temp = bio.temperature_field(hh, 0.0, cp, cell)
        moist = bio.moisture_field(hh, 0.0, cp, cell)
        return sl, temp, moist

    slope, temp, moist = fields(h)
    b = bio.classify(h, slope, temp, moist, 0.0)

    # 5. start pads: the N largest islands get them first, round-robin, so
    # no start shares an island until every major island has one
    # (habitability is climate-relative — an ice map's people live on the ice;
    # `temperate` gives back the default table, so nothing shipped moves)
    score_sp = st.SettleParams(biome_score=st.biome_score_for(climate))
    score = st.settlement_score(h, slope, b, 0.0, cell, score_sp)
    sp = st.SettleParams(min_separation=3600.0, edge_margin=900.0)
    starts: list[tuple[float, float]] = []
    ring = [l for l in big if sizes[l] * cell * cell > 2.5e6] or big
    per_island = {l: 0 for l in ring}
    while len(starts) < N_STARTS and ring:
        l = min(ring, key=lambda l_: per_island[l_])
        s_isl = np.where(labels == l, score, 0.0)
        got = st.pick_sites(s_isl, cell, per_island[l] + 1, sp)
        if len(got) <= per_island[l]:
            ring.remove(l)                        # island is full
            continue
        starts.append(got[per_island[l]])
        per_island[l] += 1
    if len(starts) < N_STARTS:
        raise SystemExit(
            f"only {len(starts)} start pads fit — raise --landmass or lower "
            f"--islands (need {N_STARTS} buildable, separated sites)")

    # flatten the pads (guaranteed dry: pad level >= +18)
    for sx, sz in starts:
        m = np.hypot(xx - sx, zz - sz) < 420.0
        pad_h = max(float(np.median(h[m])), 18.0)
        d = ndimage.distance_transform_edt(~m) * cell
        w = np.clip(1.0 - d / 500.0, 0.0, 1.0) ** 2
        h = h * (1 - w) + pad_h * w

    # 6. settlements + per-island road networks (roads never island-hop:
    # each island's sites are planned as their own network)
    slope = np.degrees(np.arctan(np.hypot(*np.gradient(h, cell)[::-1])))
    score = st.settlement_score(h, slope, b, 0.0, cell, score_sp)
    pad_excl = np.zeros(h.shape, bool)
    for sx, sz in starts:
        pad_excl |= np.hypot(xx - sx, zz - sz) < 700.0
    rp = rd.RoadParams(plan_step=(1 if fast else 4), road_width=44.0,
                       max_slope_deg=26.0, water_penalty=80.0)
    polylines: list[np.ndarray] = []
    towns: list[tuple[float, float]] = []
    for l in big:
        area = sizes[l] * cell * cell
        want = int(np.clip(area / 6.0e6, 1, 4))
        s_isl = np.where((labels == l) & ~pad_excl, score, 0.0)
        sites = st.pick_sites(s_isl, cell, want,
                              st.SettleParams(min_separation=2000.0))
        towns += sites
        # connect this island's towns + its start pads into one network
        isl_starts = [p for p in starts
                      if labels[int(p[1] / cell), int(p[0] / cell)] == l]
        net = sites + isl_starts
        if len(net) >= 2:
            polylines += rd.plan_roads(h, 0.0, cell, net, rp)
    road_mask, road_dist = rd.rasterize_roads(polylines, h.shape, cell, rp)
    rd.carve_plazas(road_mask, road_dist, towns, 85.0, cell, rp)
    h = rd.flatten_under_roads(h, road_dist, cell, rp)
    print(f"roads done {time.time()-t0:.0f}s ({len(polylines)} segments, "
          f"{len(towns)} town plazas, {len(starts)} starts)")

    # 7. hydrology -> island stream ribbons (PLAN-maps §2b item 3)
    filled = hyd.fill_depressions(h)
    recv = hyd.d8_receivers(hyd.resolve_flats(filled))
    levels = hyd.topo_levels(recv)
    accum = hyd.flow_accumulation(recv, levels)

    # start pads only — this map has no authored elevation contract beyond
    # them, so the network is otherwise free to run wherever the terrain sends
    # it (which is the point of an archipelago: short, steep, radial streams)
    protect = np.zeros(h.shape)
    for sx, sz in starts:
        protect = np.maximum(protect,
                             (np.hypot(xx - sx, zz - sz) < 520.0).astype(float))
    protect = np.clip(ndimage.gaussian_filter(
        protect, sigma=max(1.0, 160.0 / cell)) * 1.35, 0.0, 1.0)

    # islands have tiny catchments: seed generously, keep the channels narrow
    rp_riv = riv.RiverParams(channel_fraction=(0.045 if fast else 0.025),
                             width_coef=0.05, width_min=9.0, width_max=48.0,
                             depth_max=6.0, bank_width=55.0)
    net = riv.build(h, recv, levels, accum, cell, 0.0, seed, rp_riv, protect)
    h = net.terrain
    rivers = net.is_water
    print(f"rivers done {time.time()-t0:.0f}s ({len(net.polylines)} reaches, "
          f"{100.0 * net.channel_mask.mean():.2f}% channel cells)")

    # 8. final climate + biomes on the settled surface
    slope, temp, moist = fields(h)
    water_all = (h <= 0.0) | rivers
    b = bio.classify(h, slope, temp, moist, 0.0, river_mask=water_all)
    print(f"biomes done {time.time()-t0:.0f}s ({climate}, land): "
          f"{bio.format_biome_mix(b)}")

    # 9. placement — same layer set as Meridian (minus its layout regions)
    excl = road_mask.copy() | (h <= 2.0) | rivers
    excl = ndimage.binary_dilation(excl, iterations=2)
    for sx, sz in starts:
        excl |= np.hypot(xx - sx, zz - sz) < 500.0

    ctx = pl.PlacementContext(h, slope, b, moist, cell, seed, exclusion=excl,
                              paths=polylines)

    def sand_suit(c):
        desert = pl.biome_suitability({bio.DESERT: 0.9})(c)
        shore = (c.height > 0.5) & (c.height < 10.0) & (c.slope_deg < 15.0)
        return np.maximum(desert, shore.astype(np.float32) * 0.7)

    stamp_res = pl.run(ctx, [
        pl.Layer("talus_scree", pl.StampEmit("scree", (70.0, 180.0), 0.85),
                 suitability=pl.below_cliffs(34.0, 6),
                 stratum=150.0, max_slope_deg=32.0, respect_exclusion=False),
        pl.Layer("sand_shores", pl.StampEmit("sand", (80.0, 200.0), 0.8),
                 suitability=sand_suit,
                 stratum=130.0, max_slope_deg=16.0, respect_exclusion=False),
    ], progress=print)
    stamps = stamp_res.stamps

    feature_files = None
    palette = veg.palette_for(climate)
    if with_features:
        def species_layer(sp_):
            return pl.Layer(
                sp_.name, pl.FeatureEmit([(sp_.name, 1.0)], sp_.scale_range),
                suitability=lambda c, sp2=sp_: veg.build_density_field(
                    sp2, c.biome_ids, c.moisture, c.cellsize, c.seed,
                    exclusion=c.exclusion),
                stratum=sp_.stratum, max_slope_deg=sp_.max_slope_deg)

        scree_fld = stamps.get("scree")

        def boulder_suit(c):
            s = pl.biome_suitability({bio.ROCK: 0.75, bio.TUNDRA: 0.4,
                                      bio.GRASSLAND: 0.2, bio.SNOW: 0.15})(c)
            if scree_fld is not None:
                s = np.maximum(s, scree_fld.astype(np.float32) * 0.9)
            return s

        # deadwood belongs wherever the palette's trees are, which is not
        # always FOREST — an arctic map has none, and the hard-coded id
        # starved this layer to 0.0000 % (PLAN-maps M8o)
        def deadwood_suit(c):
            edge = pl.forest_edge(list(palette.wooded))(c) * 0.42
            interior = pl.biome_suitability({b: 0.09 for b in palette.wooded})(c)
            return edge + interior

        def fence_suit(c):
            return (c.height > 2.0).astype(np.float32) * 0.5

        def ruin_suit(c):
            # overgrown ruins: forests count as ground here — colonnades
            # swallowed by woodland read wonderfully at gameplay zoom.
            # The eligible band is a thin ribbon on rugged islands, so
            # gaussian-soften it: candidates between ribbon cells still
            # sample a usable acceptance probability.
            near = (road_dist > 120.0) & (road_dist < 1400.0)
            flat = c.slope_deg < 15.0
            ground = np.isin(c.biome_ids,
                             [bio.GRASSLAND, bio.TUNDRA, bio.FOREST])
            band = (near & flat & ground).astype(np.float32)
            return np.clip(ndimage.gaussian_filter(band, 2.0) * 2.2, 0.0, 1.0)

        def stone_suit(c):
            hi = c.height > np.percentile(c.height[c.height > 0], 60)
            ground = np.isin(c.biome_ids,
                             [bio.TUNDRA, bio.GRASSLAND, bio.ROCK, bio.SNOW])
            return (hi & ground & (c.slope_deg < 24.0)).astype(np.float32)

        res = pl.run(ctx, [
            *(species_layer(sp_) for sp_ in palette.species),
            pl.Layer("deadwood",
                     pl.FeatureEmit([("fallen_log", 0.55), ("tree_stump", 0.45)],
                                    (0.9, 1.2)),
                     suitability=deadwood_suit, stratum=70.0, max_slope_deg=28.0),
            pl.Layer("road_fences",
                     pl.FeatureEmit([("log_fence", 1.0)], (0.95, 1.1)),
                     suitability=fence_suit, sampler="along_paths",
                     path_spacing=22.0, path_offset=30.0, path_offset_jitter=4.0,
                     max_slope_deg=18.0, respect_exclusion=False),
            pl.Layer("ruin_colonnade",
                     pl.TemplateEmit(
                         pl.ring_template("ruin_pillar", 7, 46.0, 0.65)
                         + pl.ring_template("ruin_wall", 3, 64.0, 0.55, phase=0.4)
                         + [("standing_stone", 0.0, 0.0, 0.35)],
                         jitter=5.0),
                     suitability=ruin_suit, stratum=680.0, max_slope_deg=18.0),
            pl.Layer("ridge_stones",
                     pl.FeatureEmit([("standing_stone", 1.0)], (0.9, 1.3)),
                     suitability=stone_suit, stratum=800.0, max_slope_deg=24.0),
            pl.Layer("boulder_field",
                     pl.FeatureEmit([("rock_boulder_large", 0.35),
                                     ("rock_boulder", 0.65)], (0.8, 1.4)),
                     suitability=pl.slope_window(boulder_suit, 0.0, 30.0),
                     sampler="clusters", cluster_stratum=800.0,
                     cluster_radius=180.0, cluster_members=(4, 10),
                     max_slope_deg=30.0),
            pl.Layer("erratic",
                     pl.FeatureEmit([("rock_boulder_large", 1.0)], (0.9, 1.3)),
                     suitability=pl.slope_window(
                         pl.biome_suitability({bio.GRASSLAND: 0.35,
                                               bio.TUNDRA: 0.4,
                                               bio.ROCK: 0.35}), 0.0, 22.0),
                     stratum=1700.0, max_slope_deg=22.0),
        ], progress=print)
        print(f"placement: {len(res.features)} features total")

        lines = ["-- GENERATED by archipelago.py "
                 f"(seed={seed} landmass={landmass} islands={islands})",
                 "return {", "  objectlist = {"]
        for name, x, z, rot, _sc in res.features:
            heading = int((rot / (2 * np.pi)) * 65536) & 0xFFFF
            lines.append(f"    {{ name = '{name}', x = {x:.0f}, z = {z:.0f}, "
                         f"rot = \"{heading}\" }},")
        lines += ["  },", "  unitlist = {}, buildinglist = {},", "}"]
        with open(os.path.join(HERE, "vegetation_defs.lua")) as f:
            defs_lua = pkg.filter_defs_lua(f.read(),
                                           veg.feature_names_for(climate))
        feature_files = {
            "mapconfig/featureplacer/config.lua": "\n".join(lines) + "\n",
            "features/vegetation.lua": defs_lua,
        }

    # 10. contract self-check (free-form maps have no regions.lua; the
    # contracts here are the generator's own: landmass, dry separated starts)
    ok = True
    lf = float((h > 0).mean())
    if abs(lf - landmass) > 0.03:
        print(f"CONTRACT FAIL: land fraction {lf:.1%} vs target {landmass:.1%}")
        ok = False
    for i, (sx, sz) in enumerate(starts):
        hh = float(h[int(sz / cell), int(sx / cell)])
        if hh < 8.0:
            print(f"CONTRACT FAIL: start {i} at ({sx:.0f},{sz:.0f}) h={hh:.1f}")
            ok = False
    print(f"contracts: land {lf:.1%}, {len(starts)} dry starts — "
          f"{'OK' if ok else 'MISMATCH'}")

    if no_package:
        print(f"NO PACKAGE (tuning) — total {time.time()-t0:.0f}s")
        return h, b, slope

    from PIL import Image
    from terragen import bake as bk
    if preview_only:
        os.makedirs(out_dir, exist_ok=True)
        baker = bk.AlbedoBaker(h, slope, b, moist, road_dist, 0.0, cell, seed,
                               stamps=stamps)
        Image.fromarray(bk.make_minimap(baker, bk.hillshade(h, cell))).save(
            os.path.join(out_dir, "preview.png"))
        print(f"PREVIEW ONLY — total {time.time()-t0:.0f}s")
        return h, b, slope

    cfg = pkg.MapPackageConfig(
        map_id=map_id,
        display_name=display_name,
        description=(
            (f"Volcanic island arc (seed {seed}, {landmass:.0%} land, "
             f"{climate} climate): tectonic uplift carved to steady state — "
             "en-echelon centres, straits, island road nets, coastal towns."
             if terrain == "arc" else
             f"Free-form archipelago (seed {seed}, {landmass:.0%} land, "
             f"{islands} islands, {climate} climate): "
             "island road nets, coastal towns, ruins.")),
        min_height=-120.0, max_height=1200.0,
        tile_budget=(2048 if fast else 12288),
        start_positions=starts,
        seed=seed,
        # sea-dominated map: brighter, more opaque surface so the ocean
        # reads clearly against the islands at strategic zoom
        water_surface_color=(0.40, 0.52, 0.60),
        water_surface_alpha=0.62,
        water_base_color=(0.30, 0.44, 0.52),
    )
    pkg.write_package(
        out_dir, cfg, h, slope, b, moist, road_dist, road_mask, cell,
        scratch_dir=os.environ.get("TMPDIR", "/tmp"),
        feature_files=feature_files, stamps=stamps,
    )
    baker = bk.AlbedoBaker(h, slope, b, moist, road_dist, 0.0, cell, seed,
                           stamps=stamps)
    Image.fromarray(bk.make_minimap(baker, bk.hillshade(h, cell))).save(
        os.path.join(out_dir, "preview.png"))
    print(f"TOTAL {time.time()-t0:.0f}s")
    return h, b, slope


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=None,
                    help="map package dir (default content/maps/<id>)")
    ap.add_argument("--seed", type=int, default=SEED_DEFAULT)
    ap.add_argument("--landmass", type=float, default=0.34,
                    help="fraction of map area above the waterline (0..1)")
    ap.add_argument("--islands", type=int, default=9,
                    help="number of island seeds (overlaps merge)")
    ap.add_argument("--id", dest="map_id", default="skerry_reach")
    ap.add_argument("--name", dest="display_name", default="Skerry Reach")
    ap.add_argument("--climate", default="temperate",
                    choices=sorted(bio.CLIMATE_PRESETS),
                    help="climate preset shifted on top of this map's own "
                         "authored climate; 'temperate' is an exact identity "
                         "(shipped skerry_reach). Terrain, roads, starts and "
                         "the landmass contract are unaffected — only the "
                         "biomes, and what the splat bake and vegetation "
                         "palettes make of them.")
    ap.add_argument("--terrain", default="mounds", choices=("mounds", "arc"),
                    help="'mounds' (default, shipped skerry_reach) draws the "
                         "islands as summed radial mounds plus noise and runs "
                         "erosion as a finishing filter. 'arc' authors a "
                         "volcanic island arc as an uplift RATE and lets a "
                         "converged stream-power solver carve the landform — "
                         "--islands is then unused, and generation is ~9 min "
                         "at full res instead of ~1. See PLAN-maps M8p, and "
                         "M8q for why it routes over D-infinity by default. "
                         "⚠ D-infinity redistributes the flat ground (it has "
                         "MORE of it than the D8 arm at every slope "
                         "threshold, just spread differently), so the arc "
                         "wants --landmass 0.30 to fit 8 separated start "
                         "pads where the D8 arm fit them at 0.26.")
    ap.add_argument("--router", default="auto",
                    choices=("auto", "d8", "dinf", "mfd"),
                    help="flow router the erosion solver routes over. "
                         "'auto' (default) = d8 for --terrain mounds (the "
                         "shipped skerry_reach path, byte-for-byte) and dinf "
                         "for --terrain arc, where D8's 45-degree lattice is "
                         "what a from-nothing solver builds its channel "
                         "network on — see PLAN-maps M8q.")
    ap.add_argument("--relief-target", dest="relief_target", type=float,
                    default=950.0,
                    help="--terrain arc only: elmos of relief the highest "
                         "ground should stand at, aimed through "
                         "uplift.scale_uplift_for_relief (~10%% first-order)")
    ap.add_argument("--fast", action="store_true",
                    help="513 grid iteration mode — preview/tuning only, "
                         "NOT shippable. ⚠ with --terrain arc it is not even "
                         "a look: the coarse LEM grid is 4x coarser in elmos, "
                         "so its own cell-scale channel texture upsamples into "
                         "a diagonal comb the full-res map does not have.")
    ap.add_argument("--with-features", action="store_true")
    ap.add_argument("--preview-only", action="store_true")
    ap.add_argument("--no-package", action="store_true")
    ap.add_argument("--selftest", action="store_true",
                    help="generate twice as independent cold subprocesses "
                         "(isolated TMPDIR each, so the erosion cache cannot "
                         "fake it) and assert byte-identical packages; honours "
                         "--seed/--landmass/--islands/--fast/--with-features")
    args = ap.parse_args()

    if args.selftest:
        if args.preview_only or args.no_package:
            ap.error("--selftest needs the full package path; drop "
                     "--preview-only/--no-package")
        passthrough = ["--seed", str(args.seed),
                       "--landmass", str(args.landmass),
                       "--islands", str(args.islands),
                       "--id", args.map_id, "--name", args.display_name,
                       "--climate", args.climate,
                       "--terrain", args.terrain,
                       "--router", args.router,
                       "--relief-target", str(args.relief_target)]
        if args.fast:
            passthrough.append("--fast")
        if args.with_features:
            passthrough.append("--with-features")
        sys.exit(stest.run_selftest(
            os.path.abspath(__file__), passthrough, label="archipelago",
            cache_globs=("archipelago_eroded_*.npy",)))

    repo = os.path.abspath(os.path.join(HERE, "..", ".."))
    out = args.out or os.path.join(repo, "content", "maps", args.map_id)
    generate(out, args.seed, landmass=args.landmass, islands=args.islands,
             fast=args.fast, with_features=args.with_features,
             preview_only=args.preview_only, no_package=args.no_package,
             map_id=args.map_id, display_name=args.display_name,
             climate=args.climate, terrain=args.terrain,
             router=args.router, relief_target=args.relief_target)


if __name__ == "__main__":
    main()
