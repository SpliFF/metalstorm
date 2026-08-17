#!/usr/bin/env python3
"""Meridian Basin v2 — realistic terrain generation (PLAN-maps.md M3).

Replaces meridian.py's plateau-blend look with geologically plausible terrain
while honouring the SAME 24-region gameplay skeleton (meridian_layout.json):
region bboxes, ford decks, ridge corridors, civilian districts, convoy
routes, and start rows keep their contracts. mapdata/regions.lua and
mapdata/civilians.lua are emitted from that same layout (meridian.py's and
civilians_gen.py's emitters) rather than authored here — layout-only, so the
bytes do not depend on the seed and a `--id` variant is a complete package.

Pipeline: structural surface (region blend, as before) + wildness-masked
mountain detail -> stream-power + thermal erosion -> contract re-enforcement
(ford decks, start pads, river channel) -> roads (districts + convoy spine)
-> biomes -> full package (SMF/SMT albedo bake, splat textures, mapinfo).

Deterministic: same --seed => byte-identical map, checked by --selftest.

Usage:
    .venv/bin/python meridian2.py [--out DIR] [--fast] [--seed N]
      --fast: quarter-res heightfield (513^2) for iteration; NOT for shipping.
    .venv/bin/python meridian2.py --id basin_variant --name "Basin Variant" --seed 7
      a variant package under content/maps/<id> on the same layout contract.
    .venv/bin/python meridian2.py --selftest [--fast]
      two cold runs with isolated TMPDIRs, packages compared byte-for-byte.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)

from terragen import biomes as bio
from terragen import bridges as brg
from terragen import erosion as ero
from terragen import hydrology as hyd
from terragen import noise as tn
from terragen import package as pkg
from terragen import rivers as riv
from terragen import roads as rd
from terragen import selftest as stest
from terragen import smf
from terragen import yards as yd

import civilians_gen as civ
import meridian as m1   # the v1 generator, kept for its layout-only emitters
import ms_defs

GAME_DIR = os.path.join(REPO_ROOT, "data", "games", "metalstorm")
LAYOUT_PATH = os.path.join(HERE, "meridian_layout.json")
MAP_SIZE = 16384.0
SEED_DEFAULT = 20260727

# The SMF height ceiling this generator has always shipped, and it is not the
# comfortable margin it looks like (PLAN-maps M9h, audit of M8w FIND 1).
# `smf.quantize_heightmap` CLIPS, so a summit above this ships as a flat mesa
# with no error. The shipped package tops at 1305.4 elmos — but the surface
# that goes INTO erosion stands 1522.6, i.e. already over the ceiling, and
# only 30 iterations of stream-power + thermal (x0.898) bring it under. The
# summit is `west_scarp`'s authored 1230 plus a seed-dependent ridged-noise
# term of amplitude 620x0.58, so the clearance is a property of the seed and
# of how much erosion runs, neither of which is pinned. `height_ceiling`
# therefore derives the ceiling per surface and this value is only its FLOOR,
# so the shipped `meridian_basin` package cannot move (the derived value for
# 1305.4 is 1400) while a seed that would have clipped lifts it instead.
MAX_HEIGHT = 1500.0
MIN_HEIGHT = -120.0

# Structural targets — copied from meridian.py (the gameplay contract).
ELEVATION = {
    "cinder_forge": 140, "northgate": 140, "northwatch": 140,
    "slag_forge": 140, "southgate": 140, "southwatch": 140,
    "ash_habitat": 110, "granary_vale": 110, "north_market": 110,
    "shale_habitat": 110, "sorghum_vale": 110, "south_market": 110,
    "west_scarp_n": 1230, "west_scarp_s": 1230,
    "hollow_overlook_n": 950, "gulch_overlook_s": 950,
    "east_bluffs_n": 950, "east_bluffs_s": 950,
    # meridian_basin: the STRUCTURAL floor is dry (+16); the meandering ford
    # channel carved through it (step 4b) provides the actual <=12-deep
    # crossing — the region reads as a wide contested basin with banks
    # instead of a region-wide flat slab of seabed.
    "west_narrows": -34, "west_pass": -6, "meridian_basin": 16,
    "east_pass": -6, "still_mere": -25, "heron_ait": 18,
}
MARGIN = {
    "west_scarp_n": 750.0, "west_scarp_s": 750.0,
    "hollow_overlook_n": 900.0, "gulch_overlook_s": 900.0,
    "east_bluffs_n": 900.0, "east_bluffs_s": 900.0,
    "west_pass": 250.0, "east_pass": 250.0,
    "meridian_basin": 700.0, "west_narrows": 900.0,
    "still_mere": 500.0, "heron_ait": 250.0,
    "ash_habitat": 900.0, "granary_vale": 900.0, "north_market": 900.0,
    "shale_habitat": 900.0, "sorghum_vale": 900.0, "south_market": 900.0,
}
DEFAULT_MARGIN = 550.0
OVERLAP_SUPPRESSED_BY = {"still_mere": "heron_ait"}

# Wildness (mountain-detail amplitude multiplier) per region tag/row.
# Ridge rows get full relief; ford decks/starts/civilian rows stay calm so
# their slope-band + buildability contracts survive erosion.
WILDNESS = {
    "west_scarp_n": 1.0, "west_scarp_s": 1.0,
    "hollow_overlook_n": 0.50, "gulch_overlook_s": 0.50,
    "east_bluffs_n": 0.50, "east_bluffs_s": 0.50,
    "cinder_forge": 0.30, "northwatch": 0.45, "slag_forge": 0.30, "southwatch": 0.45,
    "northgate": 0.22, "southgate": 0.22,
    "ash_habitat": 0.18, "granary_vale": 0.28, "north_market": 0.18,
    "shale_habitat": 0.18, "sorghum_vale": 0.28, "south_market": 0.18,
    "west_pass": 0.06, "east_pass": 0.06, "meridian_basin": 0.10,
    "west_narrows": 0.25, "still_mere": 0.12, "heron_ait": 0.12,
}


def load_layout():
    with open(LAYOUT_PATH) as f:
        return json.load(f)


def region_fields(layout, xx, zz):
    """Blend per-region (elevation, wildness) via the same margin-weighted
    bbox scheme meridian.py used — but computed vectorized on numpy grids."""
    elev = np.zeros_like(xx)
    wild = np.zeros_like(xx)
    total = np.zeros_like(xx)
    weights = {}
    for r in layout["regions"]:
        key = r["key"]
        b = r["bbox"]
        margin = MARGIN.get(key, DEFAULT_MARGIN)
        dx = np.maximum(np.maximum(b["x0"] - xx, 0.0), xx - b["x1"])
        dz = np.maximum(np.maximum(b["z0"] - zz, 0.0), zz - b["z1"])
        outside = np.hypot(dx, dz)
        inside = np.minimum(
            np.minimum(xx - b["x0"], b["x1"] - xx),
            np.minimum(zz - b["z0"], b["z1"] - zz),
        )
        dist = np.where((dx > 0) | (dz > 0), outside, -np.maximum(inside, 0.0))
        w = np.clip((margin - dist) / (2.0 * margin), 0.0, 1.0)
        weights[key] = w
    for loser, winner in OVERLAP_SUPPRESSED_BY.items():
        if loser in weights and winner in weights:
            weights[loser] = weights[loser] * (1.0 - weights[winner])
    for r in layout["regions"]:
        key = r["key"]
        w = weights[key]
        elev += w * ELEVATION[key]
        wild += w * WILDNESS.get(key, 0.5)
        total += w
    total = np.maximum(total, 1e-6)
    return elev / total, wild / total


def box_mask(shape, cellsize, x0, z0, x1, z1):
    m = np.zeros(shape, dtype=bool)
    c0 = max(0, int(x0 / cellsize)); c1 = min(shape[1], int(x1 / cellsize) + 1)
    r0 = max(0, int(z0 / cellsize)); r1 = min(shape[0], int(z1 / cellsize) + 1)
    m[r0:r1, c0:c1] = True
    return m


def blend_toward(h, target, mask, cellsize, feather_elmos):
    """Blend h toward `target` inside mask, feathered outward smoothly."""
    d = ndimage.distance_transform_edt(~mask) * cellsize
    w = np.clip(1.0 - d / feather_elmos, 0.0, 1.0)
    w = w * w * (3 - 2 * w)
    return h * (1 - w) + target * w


def generate(out_dir, seed, fast=False, with_features=False, preview_only=False,
             no_package=False, climate="temperate",
             map_id="meridian_basin", display_name="Meridian Basin"):
    t_start = time.time()
    layout = load_layout()
    cell = 32.0 if fast else 8.0
    S = int(MAP_SIZE / cell) + 1
    print(f"grid {S}x{S} @ {cell} elmos/cell")

    zz, xx = np.mgrid[0:S, 0:S].astype(np.float64) * cell

    # 1. structural surface + wildness
    struct_elev, wild = region_fields(layout, xx, zz)
    # soften the bbox blend kinks before adding detail
    struct_elev = ndimage.gaussian_filter(struct_elev, sigma=max(2.0, 180.0 / cell))

    # 2. mountain/hill detail, wildness-masked
    n = tn.SimplexNoise(seed)
    wx, wy = tn.domain_warp(n, xx / 2600.0, zz / 2600.0, strength=0.55, frequency=1.0)
    ridges = tn.ridged(tn.SimplexNoise(seed + 1), wx * 1.15, wy * 1.15, octaves=6)
    hills = tn.fbm(n, xx / 900.0, zz / 900.0, octaves=6)
    detail = 620.0 * (ridges - 0.42) * np.clip(wild, 0, 1) ** 1.4 \
        + 90.0 * hills * np.clip(wild, 0.15, 1.0)
    h = struct_elev + detail
    print(f"synth done {time.time()-t_start:.0f}s relief {h.min():.0f}..{h.max():.0f}")

    # 3. erosion (cached: E1/packaging iteration shouldn't re-pay ~11 min)
    cache_path = os.path.join(
        os.environ.get("TMPDIR", "/tmp"),
        f"meridian2_eroded_{seed}_{'fast' if fast else 'full'}.npy")
    if os.path.exists(cache_path):
        h = np.load(cache_path)
        print(f"erosion loaded from cache {cache_path}")
    else:
        hardness = 0.018 + 0.022 * (0.5 + 0.5 * tn.fbm(tn.SimplexNoise(seed + 2), xx / 3800.0, zz / 3800.0, octaves=3))
        iters = 12 if fast else 30
        h = ero.stream_power_erode(
            h, cellsize=cell, iterations=iters, dt=1.4, k_erode=hardness,
            m_exp=0.5, talus_deg=33.0, thermal_rate=0.35,
            progress=lambda i, n_: print(f"  erosion {i}/{n_} ({time.time()-t_start:.0f}s)") if i % 10 == 0 else None,
        )
        np.save(cache_path, h)
        print(f"erosion done {time.time()-t_start:.0f}s (cached -> {cache_path})")

    # 4. contract re-enforcement -------------------------------------------
    cps = layout["chokepoints"]

    # 4a. ford decks + basin crossing: pull back to target elevation
    for key, elevt, feather in (
        ("west_pass", -6.0, 420.0), ("east_pass", -6.0, 420.0),
        ("meridian_basin", 16.0, 700.0), ("heron_ait", 18.0, 300.0),
    ):
        r = next(r for r in layout["regions"] if r["key"] == key)
        b = r["bbox"]
        m = box_mask(h.shape, cell, b["x0"] + 150, b["z0"] + 150, b["x1"] - 150, b["z1"] - 150)
        h = blend_toward(h, elevt, m, cell, feather)

    # 4b. river channel through row D: carve a smooth channel along the row
    # centreline so west_narrows is deep, fords shallow, still_mere a lake.
    # The channel meanders: centreline z offset by low-frequency noise in x,
    # and its half-width is capped so wide regions (the basin) keep real
    # banks instead of becoming a region-wide flat slab.
    meander = 420.0 * tn.fbm(tn.SimplexNoise(seed + 9), xx / 5200.0,
                             np.zeros_like(xx), octaves=3)
    CHANNEL_TARGET = {  # bed elevation of the carved channel per region
        "west_narrows": -34.0, "west_pass": -6.0, "meridian_basin": -5.0,
        "east_pass": -6.0, "still_mere": -25.0,
    }
    rowd = [r for r in layout["regions"] if r["key"] in CHANNEL_TARGET]
    for r in rowd:
        b = r["bbox"]
        target = CHANNEL_TARGET[r["key"]]
        m = box_mask(h.shape, cell, b["x0"], b["z0"] + 250, b["x1"], b["z1"] - 250)
        zc = (b["z0"] + b["z1"]) / 2.0 + meander
        # fords/basin: wide shallow crossing; narrows/mere: tighter, deeper
        halfspan = min((b["z1"] - b["z0"]) / 2.0 - 250,
                       1400.0 if target >= -10 else 900.0)
        prof = np.clip(1.0 - np.abs(zz - zc) / max(halfspan, 1.0), 0.0, 1.0) ** 0.6
        tgt = 12.0 + (target - 12.0) * prof   # banks above water -> bed
        w = np.where(m, prof, 0.0)
        w = ndimage.gaussian_filter(w, sigma=max(1.0, 120.0 / cell))
        h = h * (1 - w) + tgt * w

    # 4c. start pads + home-row buildable cores
    starts = [(p["x"], p["z"]) for p in layout["start_positions"]["north"]]
    starts += [(p["x"], p["z"]) for p in layout["start_positions"]["south"]]
    for sx, sz in starts:
        m = box_mask(h.shape, cell, sx - 420, sz - 420, sx + 420, sz + 420)
        pad_h = float(np.median(h[m]))
        h = blend_toward(h, np.clip(pad_h, 90.0, 190.0), m, cell, 500.0)

    # 4d. slope-band enforcement: per-region targeted thermal erosion pulls
    # slopes into the tagged band (veh <=32deg, infantry 32-45deg). Blended
    # by region box (feathered), so surrounding terrain keeps its character.
    BAND_TALUS = {
        "hollow_overlook_n": 25.0, "gulch_overlook_s": 25.0,
        "east_bluffs_n": 25.0, "east_bluffs_s": 25.0,
        "west_scarp_n": 39.0, "west_scarp_s": 39.0,
    }
    BAND_DOMINANT = {  # (band lo, band hi) the region must be dominant in
        "hollow_overlook_n": (24.0, 32.0), "gulch_overlook_s": (24.0, 32.0),
        "east_bluffs_n": (24.0, 32.0), "east_bluffs_s": (24.0, 32.0),
        "west_scarp_n": (32.0, 45.0), "west_scarp_s": (32.0, 45.0),
    }
    for key, talus in BAND_TALUS.items():
        r = next(r for r in layout["regions"] if r["key"] == key)
        b = r["bbox"]
        # crop to the region bbox + a working margin — thermal is local
        pad = int(600 / cell)
        c0 = max(0, int(b["x0"] / cell) - pad); c1 = min(S, int(b["x1"] / cell) + pad)
        r0 = max(0, int(b["z0"] / cell) - pad); r1 = min(S, int(b["z1"] / cell) + pad)
        m = box_mask((r1 - r0, c1 - c0), cell,
                     b["x0"] - c0 * cell, b["z0"] - r0 * cell,
                     b["x1"] - c0 * cell, b["z1"] - r0 * cell)
        d = ndimage.distance_transform_edt(~m) * cell
        w = np.clip(1.0 - d / 300.0, 0.0, 1.0)
        lo, hi = BAND_DOMINANT[key]
        # iterate until the tagged band dominates (E1 is build-blocking)
        for attempt in range(6):
            sub = h[r0:r1, c0:c1]
            gy_, gx_ = np.gradient(sub, cell)
            sl = np.degrees(np.arctan(np.hypot(gx_, gy_)))[m]
            bands = np.select([sl <= 24, sl <= 32, sl <= 45], [0, 1, 2], 3)
            counts = np.bincount(bands, minlength=4)
            want = 1 if hi <= 32 else 2  # band index: 1 = veh, 2 = infantry
            if counts[want] == counts.max():
                break
            relaxed = ero.thermal_erode(sub, cell, angle_deg=talus, rate=0.8,
                                        iterations=(40 if fast else 80))
            h[r0:r1, c0:c1] = sub * (1 - w) + relaxed * w

    print(f"contracts done {time.time()-t_start:.0f}s")

    # 5. hydrology on the final surface -> river ribbons (PLAN-maps §2b item 3)
    filled = hyd.fill_depressions(h)
    routing = hyd.resolve_flats(filled)
    recv = hyd.d8_receivers(routing)
    levels = hyd.topo_levels(recv)
    accum = hyd.flow_accumulation(recv, levels)

    # Everything steps 4a-4d pulled to a specified elevation is off limits to
    # the tributary system: the ford decks and row-D channel are a passability
    # contract, the start pads are each side's buildable core, and the
    # slope-band regions were just iterated into E1 compliance. A river through
    # any of them is a silent breach that no later stage re-checks. The mask is
    # feathered so the ribbons taper out rather than ending in a step.
    protect = np.zeros(h.shape)
    for r in layout["regions"]:
        if r["key"] in CHANNEL_TARGET or r["key"] in BAND_TALUS:
            bb = r["bbox"]
            protect = np.maximum(protect, box_mask(
                h.shape, cell, bb["x0"], bb["z0"], bb["x1"], bb["z1"]).astype(float))
    for sx, sz in starts:
        protect = np.maximum(protect, box_mask(
            h.shape, cell, sx - 520, sz - 520, sx + 520, sz + 520).astype(float))
    protect = np.clip(ndimage.gaussian_filter(
        protect, sigma=max(1.0, 160.0 / cell)) * 1.35, 0.0, 1.0)

    # minor streams: this map's water feature is the authored row-D channel, so
    # the generated network is a tributary system feeding it, not a rival to it
    rp_riv = riv.RiverParams(channel_fraction=(0.03 if fast else 0.015),
                             width_coef=0.045, width_max=70.0,
                             depth_max=8.0, bank_width=70.0)
    net = riv.build(h, recv, levels, accum, cell, 0.0, seed, rp_riv, protect)
    h = net.terrain
    rivers = net.is_water
    print(f"rivers done {time.time()-t_start:.0f}s "
          f"({len(net.polylines)} reaches, "
          f"{100.0 * net.channel_mask.mean():.2f}% channel cells)")

    # 6. roads: district centres + convoy waypoints + gates.
    #
    # roads R2 — the endpoints now carry ROLES, and the roles are what build the
    # hierarchy (roads.plan_network). The reading of this map's own layout:
    #   * a MARKET district is a major town — a highway destination. The
    #     habitats are not: making every civilian district a trunk node was the
    #     first reading and it produced a network that is 90 % highway by length
    #     and 95 % bitumen by area, i.e. a hierarchy that classifies everything
    #     into its top tier and therefore says nothing. Four district centres
    #     plus two gates is six trunk nodes and an MST over six nodes is five
    #     links — the whole map;
    #   * a habitat district and a convoy waypoint are villages on the way,
    #     joined by an ordinary road to wherever the trunk passes them;
    #   * the two gates are the network's PORTALS. They sit on start pads rather
    #     than on the map border, and that is the right reading anyway: what a
    #     portal means to the planner is "the trunk has to reach here", and on a
    #     two-base map the bases are exactly that. Nothing on this map is a POI
    #     yet, so there is no track tier — see PLAN-maps §2c.
    sites = []
    roles = []
    for d in layout["civilian_districts"]:
        r = next(r for r in layout["regions"] if r["key"] == d)
        b = r["bbox"]
        sites.append(((b["x0"] + b["x1"]) / 2.0, (b["z0"] + b["z1"]) / 2.0))
        roles.append(rd.NODE_TOWN if d.endswith("_market") else rd.NODE_MINOR)
    for route in layout["convoy_routes"]:
        for wp in route["waypoints"]:
            sites.append((wp["x"], wp["z"]))
            roles.append(rd.NODE_MINOR)
    for sx, sz in (starts[1], starts[5]):  # a gate per side joins the network
        sites.append((sx, sz))
        roles.append(rd.NODE_EDGE)
    # see the note at archipelago.py's road step: M9a retired the terrain-slope
    # wall in favour of a grade block plus a side-hill price
    rp = rd.RoadParams(plan_step=(1 if fast else 4), road_width=44.0,
                       water_penalty=30.0)
    net = rd.plan_network(h, 0.0, cell, sites, roles, rp)
    polylines = net.polylines
    raster = rd.rasterize_network(net, h.shape, cell, rp)
    road_mask, road_dist = raster.mask, raster.dist
    # worn junction plazas where routes meet (district centres + waypoints;
    # the trailing 2 gate sites sit on start pads — no plaza there)
    plaza_sites = sites[:-2]
    rd.carve_plazas(road_mask, road_dist, plaza_sites, 85.0, cell, rp)
    # ...and an apron where a lesser way meets the deck it joins, which is a
    # different place from a plaza: a plaza is authored at a site, a junction is
    # wherever the planner found the cheapest point on the trunk.
    rd.carve_junction_aprons(raster, net.junctions, cell, rp)
    # 6b. roadside yard PADS (roads R4b): prepared ground beside a link for the
    # scenario layer to stand a depot on. Carved as ordinary deck, and BEFORE the
    # flatten, because a pad that is not in the raster when the grader runs is a
    # pad nothing ever levels — see terragen/yards.py.
    yard_pads, yard_refusals = yd.plan_yard_pads(net, h, raster, cell, 0.0)
    yd.carve_yard_pads(raster, yard_pads, cell, rp)
    # ONE flatten pass over the combined field. Per-class passes would grade the
    # crossing twice — see roads.flatten_network.
    h = rd.flatten_network(h, raster, cell, rp)
    # ...and the pads are PLATEAUED after it, not by it: the grader blends toward
    # a blur, which does nothing to a uniform slope, so a pad it "graded" comes
    # off a ramp still on the ramp (terragen/yards.py measured 31.2 of 31.5
    # elmos). A yard is cut into graded ground, in that order.
    h = yd.level_yard_pads(h, yard_pads, cell)
    _mix = ", ".join(f"{rd.ROAD_CLASS_NAMES[k]} {v:.0f}"
                     for k, v in sorted(net.length_by_class().items()) if v > 0)
    print(f"roads done {time.time()-t_start:.0f}s "
          f"({len(polylines)} segments, {len(plaza_sites)} plazas, "
          f"{len(net.junctions)} junctions; length by class: {_mix})")
    print(f"yard pads: {len(yard_pads)} prepared, "
          f"{len(yard_refusals)} station(s) refused")
    yd.report_pad_refusals(yard_refusals)
    yd.report_pad_relief(h, yard_pads, cell)
    # ...and the ramp INTO each pad, which the relief report cannot see:
    # a plateau is flat by construction and can still sit above an
    # unclimbable verge (roads R4d, yards.pad_ramps).
    yd.report_pad_ramps(h, yard_pads, cell)
    # ...and the GATE (roads Call 2, answered 2026-08-18): a pad whose delivered
    # driveway beats HEAVY's maxslope is not published. Safe to read `h` here —
    # this generator runs rivers BEFORE roads and nothing below moves the
    # heightmap, which is why its instruments always agreed with the shipped
    # bytes where archipelago's did not (roads FIND 32). On this map the gate
    # refuses nothing: the worst driveway is 22.9 deg of the 24 allowed.
    yard_pads_all = yard_pads
    yard_pads, yard_undrivable = yd.refuse_undrivable_pads(h, yard_pads, cell)
    # 6a. water crossings (roads R3b) — measured on the DELIVERED surface, so a
    # ford is graded where the deck now stands and not where the planner drew
    # it. Published in mapdata/roads.lua; nothing is placed here (terragen/
    # bridges.py explains why a map-authored span sinks to the seabed).
    cross_params = brg.CrossingParams(
        pitch=ms_defs.feature_chain_pitch(GAME_DIR))
    crossings, crossing_refusals = brg.find_crossings(
        net, h, cell, 0.0, cross_params)
    _fordable = [r for r in crossing_refusals if r.fordable]
    print(f"crossings: {len(crossings)} bridgeable "
          f"({sum(c.spans for c in crossings)} spans), "
          f"{len(_fordable)} unbridged ford(s), "
          f"{len(crossing_refusals) - len(_fordable)} wet stretches refused")
    for r in crossing_refusals:
        print(f"  crossing {'ford, unbridged' if r.fordable else 'REFUSED'}"
              f": {r.describe()}")
    # the grade the DELIVERED deck holds, which is not the grade the planner
    # costed — the instrument warns when they disagree (roads R2 finding)
    rd.report_delivered_grades(net, h, cell, rp)

    # 7. biomes
    gy, gx = np.gradient(h, cell)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    # base_moisture re-based from the 0.45 default when the orographic model
    # became mean-preserving (PLAN-maps M8k): the old running-max rain shadow
    # only ever subtracted, so it was silently drying this map by 0.032 on top
    # of whatever base_moisture said. Re-basing keeps the authored biome mix
    # and leaves the model change to be about the shadow's *shape*.
    cp = bio.ClimateParams(seed=seed, lat_axis="z", lat_hot=0.62, lat_cold=0.45,
                           altitude_lapse=0.52, wind_dir=(1.0, 0.15),
                           base_moisture=0.418)
    # --climate shifts that baseline; "temperate" is an exact identity. Only
    # the biomes move: this map's sites, roads and E1 slope bands all come
    # from meridian_layout.json, not from the climate.
    cp = bio.apply_climate_preset(cp, climate)
    temp = bio.temperature_field(h, 0.0, cp, cell)
    moist = bio.moisture_field(h, 0.0, cp, cell)
    water_all = (h <= 0.0) | rivers
    b = bio.classify(h, slope, temp, moist, 0.0, river_mask=water_all)
    print(f"biomes done {time.time()-t_start:.0f}s ({climate}, land): "
          f"{bio.format_biome_mix(b)}")

    # 7a. road surface classes (roads R1). Classification needs moisture, so it
    # runs here rather than in step 6 — the polylines and the graded height are
    # both final by now, and the class raster is grown by the same distance
    # transform that produced road_dist, so it cannot disagree with road_mask.
    # R2: sealing now follows the HIERARCHY (a highway is bitumen because it is
    # a highway), so R1's longest-40 %-by-length budget — which was a proxy for
    # exactly this — is not consulted.
    road_cls = rd.classify_roads(polylines, moist, h, 0.0, cell,
                                 road_classes=net.road_classes)
    _surf_raster = rd.rasterize_network(net, h.shape, cell, rp, surfaces=road_cls)
    road_class = _surf_raster.surf
    rd.carve_plaza_classes(road_class, plaza_sites, 85.0, cell)
    rd.carve_junction_aprons(_surf_raster, net.junctions, cell, rp)
    # The pads again, on the class raster this time: both rasters get every
    # carve, for the reason the apron note gives — a pad that is deck in one and
    # not in the other is a hole in the typemap exactly where the tarmac is.
    # `yard_pads_all`: a pad the driveway gate refused keeps its tarmac, because
    # the graded ground is already in `h` — see refuse_undrivable_pads.
    yd.carve_yard_pads(_surf_raster, yard_pads_all, cell, rp)
    yd.carve_yard_pad_classes(road_class, yard_pads_all, cell, rp)
    _deck = max(1, int((road_class != rd.SURF_NONE).sum()))
    _surf_mix = ", ".join(
        f"{rd.SURFACE_NAMES[k]} {100.0 * int((road_class == k).sum()) / _deck:.1f}%"
        for k in (rd.SURF_BITUMEN, rd.SURF_DIRT, rd.SURF_MUD))
    print(f"road surfaces ({_deck} deck cells): {_surf_mix}")

    # 7b. placement (terragen/placement.py): vegetation + boulder features,
    # scree/sand ground stamps. Stamps always run — the albedo bake and
    # splat-distr composite them (baked decals). Feature emission stays behind
    # the flag because a full scatter replaces the placement list with tens of
    # thousands of entries.
    from terragen import placement as pl
    from terragen import vegetation as veg

    excl = road_mask.copy() | (h <= 2.0) | rivers
    excl = ndimage.binary_dilation(excl, iterations=2)
    for sx, sz in starts:  # keep start pads clear
        excl |= box_mask(h.shape, cell, sx - 500, sz - 500, sx + 500, sz + 500)
    # keep the ford decks + corridors passable (no blocking features)
    for r in layout["regions"]:
        if any(t in ("corridor", "choke") for t in r["tags"]):
            bb = r["bbox"]
            excl |= box_mask(h.shape, cell, bb["x0"], bb["z0"], bb["x1"], bb["z1"])

    ctx = pl.PlacementContext(h, slope, b, moist, cell, seed, exclusion=excl,
                              paths=polylines)

    def sand_suit(c):
        desert = pl.biome_suitability({bio.DESERT: 0.9})(c)
        shore = (c.height > 0.5) & (c.height < 6.0) & (c.slope_deg < 8.0)
        return np.maximum(desert, shore.astype(np.float32) * 0.5)

    stamp_res = pl.run(ctx, [
        pl.Layer("talus_scree", pl.StampEmit("scree", (70.0, 180.0), 0.85),
                 suitability=pl.below_cliffs(34.0, 6),
                 stratum=150.0, max_slope_deg=32.0, respect_exclusion=False),
        pl.Layer("sand_flats", pl.StampEmit("sand", (90.0, 220.0), 0.8),
                 suitability=sand_suit,
                 stratum=280.0, max_slope_deg=10.0, respect_exclusion=False),
    ], progress=print)
    stamps = stamp_res.stamps

    feature_files = None
    palette = veg.palette_for(climate)
    if with_features:
        def species_layer(sp):
            return pl.Layer(
                sp.name, pl.FeatureEmit([(sp.name, 1.0)], sp.scale_range),
                suitability=lambda c, sp=sp: veg.build_density_field(
                    sp, c.biome_ids, c.moisture, c.cellsize, c.seed,
                    exclusion=c.exclusion),
                stratum=sp.stratum, max_slope_deg=sp.max_slope_deg)

        scree_fld = stamps.get("scree")

        def boulder_suit(c):
            s = pl.biome_suitability({bio.ROCK: 0.75, bio.TUNDRA: 0.4,
                                      bio.GRASSLAND: 0.2, bio.SNOW: 0.15})(c)
            if scree_fld is not None:  # boulder fields favour talus aprons
                s = np.maximum(s, scree_fld.astype(np.float32) * 0.9)
            return s

        # deadwood accumulates in the wooded-edge band; sparse stumps inside.
        # "Wooded" is the palette's, not FOREST's: an arctic map's trees are
        # a tundra treeline and the hard-coded id starved this to 0.0000 %
        # (PLAN-maps M8o)
        def deadwood_suit(c):
            edge = pl.forest_edge(list(palette.wooded))(c) * 0.42
            interior = pl.biome_suitability({b: 0.09 for b in palette.wooded})(c)
            return edge + interior

        # broken fence runs flank the roads (dry ground only; the exclusion
        # mask covers the road deck itself, so fences opt out of it)
        def fence_suit(c):
            return (c.height > 2.0).astype(np.float32) * 0.5

        # ruin sites: flat open ground within sight of a road
        def ruin_suit(c):
            near = (road_dist > 120.0) & (road_dist < 900.0)
            flat = c.slope_deg < 12.0
            ground = np.isin(c.biome_ids, [bio.GRASSLAND, bio.TUNDRA])
            return (near & flat & ground).astype(np.float32) * 0.85

        # lone monoliths on high open ground
        def stone_suit(c):
            hi = c.height > np.percentile(c.height, 70)
            ground = np.isin(c.biome_ids,
                             [bio.TUNDRA, bio.GRASSLAND, bio.ROCK, bio.SNOW])
            return (hi & ground & (c.slope_deg < 24.0)).astype(np.float32)

        res = pl.run(ctx, [
            *(species_layer(sp) for sp in palette.species),
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
                     suitability=ruin_suit, stratum=1100.0, max_slope_deg=12.0),
            pl.Layer("ridge_stones",
                     pl.FeatureEmit([("standing_stone", 1.0)], (0.9, 1.3)),
                     suitability=stone_suit, stratum=800.0, max_slope_deg=24.0),
            pl.Layer("boulder_field",
                     pl.FeatureEmit([("rock_boulder_large", 0.35),
                                     ("rock_boulder", 0.65)], (0.8, 1.4)),
                     suitability=pl.slope_window(boulder_suit, 0.0, 30.0),
                     sampler="clusters", cluster_stratum=1100.0,
                     cluster_radius=180.0, cluster_members=(4, 10),
                     max_slope_deg=30.0),
            pl.Layer("erratic",  # lone outcrops on open ground
                     pl.FeatureEmit([("rock_boulder_large", 1.0)], (0.9, 1.3)),
                     suitability=pl.slope_window(
                         pl.biome_suitability({bio.GRASSLAND: 0.18,
                                               bio.TUNDRA: 0.22,
                                               bio.ROCK: 0.2}), 0.0, 22.0),
                     stratum=2300.0, max_slope_deg=22.0),
        ], progress=print)
        print(f"placement: {len(res.features)} features total")

        lines = ["-- GENERATED by meridian2.py", "return {", "  objectlist = {"]
        for name, x, z, rot, _sc in res.features:
            heading = int((rot / (2 * np.pi)) * 65536) & 0xFFFF
            lines.append(f"    {{ name = '{name}', x = {x:.0f}, z = {z:.0f}, rot = \"{heading}\" }},")
        lines += ["  },", "  unitlist = {}, buildinglist = {},", "}"]
        feature_files = {
            "mapconfig/featureplacer/config.lua": "\n".join(lines) + "\n",
        }

    # 8. E1 self-check (same contract as MapProcessor's validator)
    ok = selfcheck(layout, h, cell)
    if not ok:
        print("WARNING: E1 self-check has mismatches (see above)")

    # placement-tuning iteration mode: skip the ~10 min bake/package
    if no_package:
        print(f"NO PACKAGE (placement tuning) — total {time.time()-t_start:.0f}s")
        return h, b, slope

    # 9. package
    if preview_only:
        from PIL import Image
        from terragen import bake as bk
        os.makedirs(out_dir, exist_ok=True)
        baker = bk.AlbedoBaker(h, slope, b, moist, road_dist, 0.0, cell, seed,
                               stamps=stamps, road_class=road_class)
        shade = bk.hillshade(h, cell)
        Image.fromarray(bk.make_minimap(baker, shade)).save(
            os.path.join(out_dir, "preview.png"))
        print(f"PREVIEW ONLY — total {time.time()-t_start:.0f}s")
        return h, b, slope

    scratch = os.environ.get("TMPDIR", "/tmp")
    top = float(h.max())
    max_h = smf.height_ceiling(top, floor=MAX_HEIGHT)
    if max_h > MAX_HEIGHT:
        print(f"height ceiling {max_h:.0f} (surface tops at {top:.0f}; the "
              f"{MAX_HEIGHT:.0f} floor would have sheared "
              f"{int((h > MAX_HEIGHT).sum())} cells "
              f"({top - MAX_HEIGHT:.0f} elmos off the summit) into a flat top)")
    cfg = pkg.MapPackageConfig(
        map_id=map_id,
        display_name=display_name,
        description="Two sides of an eroded river basin: ridge corridors, three fords, civilian valleys.",
        min_height=MIN_HEIGHT, max_height=max_h,
        tile_budget=(2048 if fast else 12288),
        start_positions=starts,
        seed=seed,
    )
    # The 24-region contract and the civilian data are layout-derived, not
    # terrain-derived, so they are the same bytes for any seed or id — but a
    # variant written under a new `--id` got neither until M9h. Absence is
    # not loud: `mapconverter` copies `mapdata/` through and only validates
    # it when it is there (it aborts the build on an E1 slope mismatch), so
    # a variant with no regions.lua converts and installs cleanly and then
    # `scenariogen.read_regions` rejects it — the fixed 2048-elmo grid, no
    # named regions. Emitting them here makes the package self-contained;
    # for `meridian_basin` they reproduce the checked-in files exactly
    # (pinned in tests/test_meridian2.py).
    civ_lua, _n_sites, _n_convoys = civ.build_civilians_lua(layout)
    contract_files = dict(feature_files or {})
    contract_files["mapdata/civilians.lua"] = civ_lua
    pkg.write_package(
        out_dir, cfg, h, slope, b, moist, road_dist, road_mask, cell,
        scratch_dir=scratch, regions_lua=m1.build_regions_lua(layout),
        roads_lua=pkg.emit_roads_lua(net, cell, rp, crossings=crossings,
                                     yards=yard_pads,
                                     refusals=crossing_refusals,
                                     p_cross=cross_params),
        feature_files=contract_files, stamps=stamps, road_class=road_class,
    )

    # quick-look preview (albedo * hillshade) for iteration without the client
    from PIL import Image
    from terragen import bake as bk
    baker = bk.AlbedoBaker(h, slope, b, moist, road_dist, 0.0, cell, seed,
                           stamps=stamps, road_class=road_class)
    shade = bk.hillshade(h, cell)
    Image.fromarray(bk.make_minimap(baker, shade)).save(os.path.join(out_dir, "preview.png"))

    print(f"TOTAL {time.time()-t_start:.0f}s")
    return h, b, slope


TAG_EXPECTED = {"infantry_only": "infantry", "heavy_restricted": "veh",
                "corridor": "flat", "choke": "flat"}
DRY_ONLY = {"infantry_only", "heavy_restricted"}


def selfcheck(layout, h, cell):
    gy, gx = np.gradient(h, cell)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    all_ok = True
    for r in layout["regions"]:
        expected = None
        for tag in r["tags"]:
            if tag in TAG_EXPECTED:
                expected = TAG_EXPECTED[tag]
                dry = tag in DRY_ONLY
                break
        if expected is None:
            continue
        b = r["bbox"]
        c0, c1 = int(b["x0"] / cell), int(b["x1"] / cell)
        r0, r1 = int(b["z0"] / cell), int(b["z1"] / cell)
        sl = slope[r0:r1:8, c0:c1:8]
        hh = h[r0:r1:8, c0:c1:8]
        if dry:
            sel = hh > 0
            sl = sl[sel]
        bands = np.select(
            [sl <= 24, sl <= 32, sl <= 45], ["flat", "veh", "infantry"], "cliff"
        )
        vals, counts = np.unique(bands, return_counts=True)
        dominant = vals[np.argmax(counts)]
        frac = counts.max() / counts.sum()
        ok = dominant == expected
        all_ok &= ok
        print(f"  E1 {r['key']:20s} expected={expected:9s} dominant={dominant:9s} "
              f"({frac*100:4.1f}%)  {'OK' if ok else 'MISMATCH'}")
    return all_ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None,
                    help="map package dir (default content/maps/<id>)")
    ap.add_argument("--seed", type=int, default=SEED_DEFAULT)
    ap.add_argument("--id", dest="map_id", default="meridian_basin",
                    help="package id; anything but the default writes a "
                         "VARIANT under content/maps/<id>. It carries the "
                         "same 24-region layout contract (regions.lua + "
                         "civilians.lua are layout-derived and go in the "
                         "package), so only its terrain differs — vary "
                         "--seed/--climate")
    ap.add_argument("--name", dest="display_name", default="Meridian Basin")
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--with-features", action="store_true",
                    help="scatter the full vegetation set into "
                         "mapconfig/featureplacer/config.lua, replacing the "
                         "placeholder placement list")
    ap.add_argument("--preview-only", action="store_true",
                    help="skip the package bake; write preview.png only")
    ap.add_argument("--no-package", action="store_true",
                    help="stop after placement + E1 (fast layer-tuning loop)")
    ap.add_argument("--climate", default="temperate",
                    choices=sorted(bio.CLIMATE_PRESETS),
                    help="climate preset shifted on top of this map's own "
                         "authored climate; 'temperate' is an exact identity "
                         "(shipped meridian_basin). The 24-region layout "
                         "contract is unaffected — only the biomes.")
    ap.add_argument("--selftest", action="store_true",
                    help="generate twice as independent cold subprocesses "
                         "(isolated TMPDIR each, so the erosion cache cannot "
                         "fake it) and assert byte-identical packages; "
                         "honours --seed/--id/--name/--climate/--fast/"
                         "--with-features")
    args = ap.parse_args()

    if args.selftest:
        if args.preview_only or args.no_package:
            ap.error("--selftest needs the full package path; drop "
                     "--preview-only/--no-package")
        passthrough = ["--seed", str(args.seed), "--climate", args.climate,
                       "--id", args.map_id, "--name", args.display_name]
        if args.fast:
            passthrough.append("--fast")
        if args.with_features:
            passthrough.append("--with-features")
        sys.exit(stest.run_selftest(
            os.path.abspath(__file__), passthrough, label="meridian2",
            cache_globs=("meridian2_eroded_*.npy",)))

    out = args.out or os.path.join(REPO_ROOT, "content", "maps", args.map_id)
    # `mapconverter` names the installed map after the package DIRECTORY, not
    # after the id inside mapinfo.lua, so `--out .../foo --id bar` installs as
    # `data/maps/foo` holding `maps/bar.smf` — which loads, and then every
    # scenario and every lobby row disagrees with it about the map's name. The
    # default can't produce that; an explicit --out can, so it is said out loud
    # (a warn, not an error: an --out to scratch for inspection is legitimate).
    if os.path.basename(os.path.normpath(out)) != args.map_id:
        print(f"WARNING: --out directory '{os.path.basename(os.path.normpath(out))}' "
              f"is not the map id '{args.map_id}' — mapconverter installs a map "
              f"under its directory name, so this package is only safe to "
              f"inspect, not to convert", file=sys.stderr)
    generate(out, args.seed, fast=args.fast, with_features=args.with_features,
             preview_only=args.preview_only, no_package=args.no_package,
             climate=args.climate, map_id=args.map_id,
             display_name=args.display_name)


if __name__ == "__main__":
    main()
