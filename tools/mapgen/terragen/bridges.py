"""Road water crossings — where a bridge belongs, published by the map (roads R3b).

The road planner prices water rather than forbidding it (`RoadParams.water_
penalty`), so a generated network fords its rivers and inlets: on skerry_reach
four stretches of deck run below the waterline, the longest 992 elmos. Those
stretches are the ONLY places on a map where a bridge span means anything —
scenariogen's `find_crossing` was searching for narrow water inside a region
with no idea where the roads were, and its own docstring made the assumption
out loud ("a bridge is built where the river is thinnest, and that is also
where a road would naturally run"). This module makes that true instead of
assumed: the crossings are read off the planned network, with the chain's
heading taken from the road's own tangent.

WHAT THIS MODULE DOES NOT DO — placement. It publishes crossings into
`mapdata/roads.lua` for the scenario stager to build spans on, and deliberately
does NOT write featureplacer entries, because the map feature path cannot carry
the one number a span over water needs:

  * `CFeatureHandler::LoadFeaturesFromMap` (rts/Sim/Features/FeatureHandler.cpp)
    spawns every map-authored feature at `CGround::GetHeightReal(x, z)` — the
    SEABED under a crossing. The featureplacer config format has no `y` at all
    (rts/Server/FeatureProcessor.cpp parses name/x/z/rot), and
    `floating = true` only zeroes the gravity term (Feature.cpp:533); it does
    not buoy a span up. A map-placed chain therefore lies on the riverbed, which
    is the staircase §M3 measured live (-31.0 / -34.5 / -45.9 / -57.6).
  * `game_scenario.lua`'s `stageFeatures` takes an explicit `y`, and §M3
    measured four spans staged at `y = 0` holding 0.00 across the chain. So the
    scenario path is the one that can lay a level deck, and the map's job is to
    tell it where.

⛔ **A span is DECORATION over a ford, and this is v1 saying so out loud.**
`features/bridges.lua` ships `blocking = false` with a header explaining why:
Spring/Recoil pathing is single-layer, `CFeature::Block()` is all-or-nothing,
and a blocking span is a wall across the gap it exists to open. So units do not
drive ON the deck — they wade the ford UNDER it, which is why
`crossing_is_fordable` is an acceptance rule here rather than a nicety: a
crossing this module publishes is one the map's own vehicles can already cross.
When the `deckHeight` engine ask lands (.tasks/notes/model-integration.md), the
crossings published here are already the right places to raise.

⛔ **AND A MAP CANNOT CLOSE THAT GAP BY SHAPING GROUND** (roads R3c, measured
2026-08-15 — PLAN-maps.md §2j). The obvious terrain answer, "raise a causeway
whose top IS the deck", is arithmetically impossible, not merely expensive:
`CFeature::UpdatePosition` clamps a feature's y UP to `CGround::GetHeightReal`
every tick and never down (Feature.cpp:570), so a span standing on ground `g`
puts its deck at `g + deck_top` (1.5 for `ms_road_bridge`, measured off the
shipped mesh, published as `customparams.deck_top`). Raise the ground under the
crossing by `d` and BOTH the road surface and the deck rise by `d`: the gap is
invariant under every earthwork this module could ever plan. The map's terrain
levers here are real but they are about the ROUTE — how deep the ford is, how
wide, whether the road should be there at all — never about the deck.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .roads import resample_by_arclength, sample_height

# Spring's 16-bit heading, and the direction a chain lays along it. Mirrors
# game_scenario.lua's `headingToDir` exactly — heading 0 is FACING_NORTH and a
# feature's local forward at heading 0 is -Z for an RH/glTF-native game, so
# dir = (sin t, -cos t). tests/test_bridges.py reads the cardinals out of
# game_scenario.lua and checks these two against them, so the convention cannot
# drift here without the gadget drifting too.
HEADING_SCALE = 65536.0


def heading_short(dx: float, dz: float) -> int:
    """Spring heading whose chain direction is (dx, dz). 0..65535."""
    theta = math.atan2(dx, -dz)
    return int(round(theta * HEADING_SCALE / (2.0 * math.pi))) % 65536


def heading_dir(short: int) -> tuple[float, float]:
    """Unit chain direction for a heading — the gadget's `headingToDir`."""
    theta = short * (2.0 * math.pi / HEADING_SCALE)
    return math.sin(theta), -math.cos(theta)


# A single 24-elmo segment is a plank and the gap under it is a ditch; past 24
# segments the "gap" is open water and the chain is a landfill. Same window
# scenariogen's blind placer uses (MIN_BRIDGE_SPANS / MAX_BRIDGE_SPANS), stated
# once per placer because they are separate acceptance rules over the same def.
MIN_SPANS = 3
MAX_SPANS = 24

# VEH's wade depth from `moveinfo.tdf`, via terragen.passability.MOVE_CLASSES.
# Imported lazily in `find_crossings` so this module stays importable without
# scipy; the default here is the number, not a second table.
VEH_WADE_DEPTH = 20.0


@dataclass(frozen=True)
class CrossingParams:
    pitch: float = 24.0          # the def publishes it (customparams.chain_pitch)
    min_spans: int = MIN_SPANS
    max_spans: int = MAX_SPANS
    step: float = 8.0            # arclength sampling along the polyline (1 square)
    wade_depth: float = VEH_WADE_DEPTH
    # How far the wet run may bend before a straight chain would walk off it.
    # The afloat test below is the real gate; this reports the shape.
    max_bend_deg: float = 45.0


@dataclass(frozen=True)
class Crossing:
    """A stretch of road under water, sized for a chain of spans."""
    link: int                   # index into net.links
    road_class: int
    x: float                    # CHAIN CENTRE — stageFeatures chains centred
    z: float
    heading: int                # Spring heading short; chain lays along it
    spans: int
    length: float               # wetted deck length along the road (elmos)
    width: float                # bank-to-bank chord the chain covers (elmos)
    max_depth: float            # deepest point of the ford, positive elmos
    bend_deg: float             # heading spread across the run

    def span_centres(self, pitch: float) -> list[tuple[float, float]]:
        """The (x, z) of every segment, exactly as stageFeatures computes them."""
        dx, dz = heading_dir(self.heading)
        out = []
        for i in range(self.spans):
            step = (i - (self.spans - 1) / 2.0) * pitch
            out.append((self.x + dx * step, self.z + dz * step))
        return out


@dataclass(frozen=True)
class Refusal:
    """A wet stretch of road that gets no bridge, and why."""
    link: int
    reason: str
    length: float
    max_depth: float
    x: float
    z: float

    def describe(self) -> str:
        return (f"link {self.link} at ({self.x:.0f}, {self.z:.0f}): "
                f"{self.length:.0f} elmos wet, {self.max_depth:.1f} deep — "
                f"{self.reason}")


def _wet_runs(pts: np.ndarray, h: np.ndarray, water_level: float):
    """Contiguous index ranges of `pts` whose sampled height is under water."""
    wet = h <= water_level
    out = []
    i = 0
    n = len(wet)
    while i < n:
        if wet[i]:
            j = i
            while j + 1 < n and wet[j + 1]:
                j += 1
            out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def _arclength_mid(seg: np.ndarray) -> tuple[float, float]:
    d = np.hypot(*(seg[1:] - seg[:-1]).T)
    cum = np.concatenate([[0.0], np.cumsum(d)])
    half = cum[-1] / 2.0
    k = int(np.searchsorted(cum, half))
    k = min(max(k, 1), len(seg) - 1)
    t = (half - cum[k - 1]) / max(d[k - 1], 1e-6)
    p = seg[k - 1] + (seg[k] - seg[k - 1]) * t
    return float(p[0]), float(p[1])


def crossing_is_fordable(max_depth: float, wade_depth: float) -> bool:
    """Can the map's own vehicles cross here without the bridge?

    They have to, because the span is non-blocking decoration — see the module
    header. A wet stretch of deck deeper than VEH's wade is a road that leads
    into water its own traffic cannot follow, and that is a defect in the ROUTE,
    not a bridge opportunity: reported as a refusal so it is visible rather than
    quietly decorated over.
    """
    return max_depth <= wade_depth


def find_crossings(net, height: np.ndarray, cellsize: float,
                   water_level: float = 0.0,
                   p: CrossingParams | None = None,
                   ) -> tuple[list[Crossing], list[Refusal]]:
    """Every stretch of `net` under water, graded into crossings and refusals.

    `height` is the DELIVERED surface — call this after `flatten_network`, or
    the crossing is measured on ground the road no longer stands on.

    No RNG: runs are walked in link order, so two runs on one seed cannot
    disagree about where a river is.
    """
    p = p or CrossingParams()
    crossings: list[Crossing] = []
    refusals: list[Refusal] = []

    for idx, ln in enumerate(net.links):
        pts = resample_by_arclength(ln.polyline, p.step)
        if len(pts) < 2:
            continue
        hh = sample_height(height, pts, cellsize)
        for a, b in _wet_runs(pts, hh, water_level):
            seg = pts[a:b + 1]
            if len(seg) < 2:
                continue
            length = float(np.sum(np.hypot(*(seg[1:] - seg[:-1]).T)))
            depth = float(water_level - hh[a:b + 1].min())
            cx, cz = _arclength_mid(seg)
            chord = seg[-1] - seg[0]
            width = float(np.hypot(*chord))
            heading = heading_short(float(chord[0]), float(chord[1]))
            # How far the run bends: the widest angle between any sample's
            # local tangent and the chord the chain will lay along.
            tang = seg[1:] - seg[:-1]
            keep = np.hypot(tang[:, 0], tang[:, 1]) > 1e-6
            bend = 0.0
            if keep.any() and width > 1e-6:
                u = chord / width
                cosang = np.clip(
                    (tang[keep] @ u) / np.hypot(tang[keep, 0], tang[keep, 1]),
                    -1.0, 1.0)
                bend = float(np.degrees(np.arccos(cosang)).max())

            def refuse(reason):
                refusals.append(Refusal(idx, reason, length, depth, cx, cz))

            if not crossing_is_fordable(depth, p.wade_depth):
                refuse(f"deeper than VEH wades ({p.wade_depth:.0f}) — the "
                       f"ROUTE is broken here, not the decoration")
                continue
            # Sized by FLOOR over the water, never ceil, and measured on the
            # chord the chain actually lays along rather than on the wandering
            # deck length: segment i sits at (i - (n-1)/2) * pitch from the
            # centre, so n = floor(water / pitch) keeps the outermost centre
            # strictly inside the water. §M4 learned this the hard way — a deck
            # sized to reach the banks put half its chain on rising ground,
            # where `floating` does not defeat the ground clamp.
            water = width - 2.0 * cellsize
            spans = int(water // p.pitch) if water > 0 else 0
            if spans < p.min_spans:
                refuse(f"{spans} spans — a plank over a ditch")
                continue
            if spans > p.max_spans:
                refuse(f"{spans} spans — open water, not a river; a "
                       f"{p.max_spans}-span limit makes this a causeway")
                continue
            cand = Crossing(idx, ln.road_class, cx, cz, heading, spans,
                            length, water, depth, bend)
            # EVERY SPAN CENTRE MUST BE OVER WATER — asked of the same
            # arithmetic stageFeatures will use, not of the floor() above.
            centres = np.asarray(cand.span_centres(p.pitch))
            if float(sample_height(height, centres, cellsize).max()) > water_level:
                refuse(f"chain of {spans} leaves the water (bend "
                       f"{bend:.0f} deg over the run)")
                continue
            crossings.append(cand)
    return crossings, refusals


def emit_crossings_lua(crossings: list[Crossing], defname: str = "ms_road_bridge",
                       indent: str = "        ") -> list[str]:
    """`crossings = { ... }` rows for mapdata/roads.lua.

    `y` is NOT emitted: the waterline is the stager's business (it stages spans
    at y = 0 and the def floats), and a height baked into map data would be a
    second copy of the map's water plane.
    """
    out = []
    for c in crossings:
        out.append(
            f"{indent}{{ def = \"{defname}\", x = {c.x:.0f}, z = {c.z:.0f}, "
            f"heading = {c.heading}, spans = {c.spans}, "
            f"class = {c.road_class}, width = {c.width:.0f}, "
            f"depth = {c.max_depth:.1f} }},")
    return out
