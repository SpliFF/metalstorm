#!/usr/bin/env python3
"""archipelago.py — free-form island map generator (terragen).

Unlike meridian2.py (which re-enforces a hand-authored 24-region layout),
this generator is fully parameterized and derives EVERYTHING from its
inputs — island placement, elevations, start positions, settlements,
per-island road networks, biomes, vegetation, ruins. Deterministic:

    same (--seed, --landmass, --islands, --terrain, --router, --arc-detail,
          --hardness-detail, --arc-segmentation, --connect-starts,
          --carve-raise-penalty)
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
from typing import NamedTuple

import numpy as np
from scipy import ndimage

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from terragen import biomes as bio          # noqa: E402
from terragen import erosion as ero         # noqa: E402
from terragen import hydrology as hyd       # noqa: E402
from terragen import noise as tn            # noqa: E402
from terragen import package as pkg         # noqa: E402
from terragen import passability as pas     # noqa: E402
from terragen import placement as pl        # noqa: E402
from terragen import rivers as riv          # noqa: E402
from terragen import roads as rd            # noqa: E402
from terragen import selftest as stest      # noqa: E402
from terragen import settle as st           # noqa: E402
from terragen import smf                    # noqa: E402
from terragen import uplift as up           # noqa: E402
from terragen import vegetation as veg      # noqa: E402
from terragen.vegetation import _hash01     # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MAP_SIZE = 16384.0
SEED_DEFAULT = 20260730
N_STARTS = 8
SYNTH_REV = 4          # bump when synth_height changes — keys the erosion cache

# `--terrain arc` only. The fine grain authored into `arc_platform`: an fBm
# whose coarsest octave is ARC_DETAIL_WAVELENGTH and whose finest is ~2 cells
# at 8 elmos, i.e. the 15-120 elmo band. ARC_DETAIL_DEFAULT is the amplitude
# that puts the platform's high-pass residual on the shipped mounds
# generator's 2.27 elmos — see `arc_platform` and PLAN-maps M8r.
ARC_DETAIL_WAVELENGTH = 120.0
ARC_DETAIL_DEFAULT = 17.0
# bump when anything upstream of the arc's erosion changes shape — it keys
# the arc's half of the cache the way SYNTH_REV keys the mounds half.
# v2: the relief aim is taken on the grain-free platform (M8r).
ARC_REV = 2

# Substrate erodibility. The coarse field varies at 3400 elmos over 3 octaves,
# i.e. nothing below 850; HARDNESS_WAVELENGTH/3 octaves puts variation at
# 800/400/200 elmos, the scale the arc's feathered spurs repeat at.
# See `substrate_hardness` for why it ships off anyway, and PLAN-maps M8s.
HARDNESS_WAVELENGTH = 800.0
HARDNESS_FLOOR = 0.006
# measured OFF: 0.004/0.008 barely move the band they were built for and
# make 120-300 worse — see `substrate_hardness` and PLAN-maps M8s.
ARC_HARDNESS_DETAIL = 0.0
HARD_REV = 1

# Tectonic segmentation of the arc: cross-strike breaks + an en-echelon step
# + a back-arc high, one knob (`arc_uplift`'s `segmentation`). Measured ON —
# it takes the coarse-band anisotropy the last three milestones chased from
# 1.62 to 1.19 excess against the shipped map's 0.99, and it is the only
# thing that has moved it. See `arc_uplift` and PLAN-maps M8t.
ARC_SEGMENTATION = 1.0
SEG_REV = 1

# Passes of the closed-loop relief aim (`generate`'s `aim_iterations`).
# `scale_uplift_for_relief` is first-order — it measures the steady-state
# relief of the drainage the *platform* has, and the solver then builds a
# different one — so what stands is not what was asked for: +0.4 % on the
# un-segmented arc but +28 % on the segmented one, and M8u measured four
# first-order estimators that each aim one arm and miss the other. A second
# pass with the uplift scaled by target/stood closes it, and pass 0 is
# cache-addressable at the pre-M8u key, so the loop costs one extra pass.
# 1 restores the M8t surface bit-for-bit.
ARC_AIM_ITERATIONS = 2

# The SMF height ceiling this generator has always shipped. `mounds` stands
# 553 elmos, so it never came near it — see `height_ceiling`.
HEIGHT_CEILING_FLOOR = 1200.0

# Sill carving, so armour can cross the arc (PLAN-maps M8x). Default ON for
# `arc` and OFF for `mounds`, for the same reason as every other knob here:
# the shipped `skerry_reach` package must not move. Turning it on for
# `mounds` is a real option — skerry_reach splits 8 starts into 8 components
# for every class — but that is a re-ship, not a default.
ARC_CONNECT_STARTS = True

# The placer-side half of the same question (PLAN-maps M9c): a pad the carve
# turns out not to be able to reach is a pad that should not have been kept.
# Same default rule — turning it on for `mounds` re-ships skerry_reach, and
# whether an archipelago is *allowed* to be armour-split is the open call in
# the lane queue, not this loop's to make.
ARC_GATE_START_PADS = True

# How many times the pads may be re-picked against what the carve could not
# reach. Each pass is a full roads + rivers + carve re-derivation (~30 s of a
# 289 s full-res arc run), and the ban only ever grows, so this is a wall
# clock cap rather than a convergence one.
PAD_PASSES = 3


def height_ceiling(top: float) -> float:
    """`max_height` for a surface whose highest cell is `top` elmos.

    SMF quantises the heightmap by **clipping** it to
    [`min_height`, `max_height`] (`smf.quantize_heightmap`), so a summit above
    the ceiling does not overflow and does not fail — it ships as a flat mesa,
    silently. The fixed 1200 this generator used clears `mounds`' 553 elmos
    with room to spare, which is why it was never a problem there.

    The arc is the case that breaks it, and not by accident: its relief is
    *aimed at a quantile*, and the summit runs 1.24-1.37x the relief that was
    aimed for on every eroded surface this generator has written (PLAN-maps
    M8u). `--relief-target 950` stands **1212** — so the peak the whole
    closed-loop aim exists to place is exactly what the ceiling would have
    sheared off.

    100-elmo steps with 5 % headroom (the rule itself lives in
    `terragen.smf`, next to the clip it guards — `meridian2.py` floors the
    same rule at its own shipped 1500), floored at the shipped 1200 so the
    `skerry_reach` package cannot move:

    >>> height_ceiling(553.0)      # shipped mounds — unchanged
    1200.0
    >>> height_ceiling(1212.0)     # shipped arc
    1300.0
    """
    return smf.height_ceiling(top, floor=HEIGHT_CEILING_FLOOR)


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
               bow: float = 3400.0,
               segmentation: float = 0.0,
               seg_centres: int = 2, break_depth: float = 0.88,
               break_width: float = 1250.0, echelon_step: float = 1.9,
               back_arc: float = 0.34, back_arc_offset: float = 3400.0,
               back_arc_sig: float = 1000.0) -> np.ndarray:
    """The `--terrain arc` authoring surface: uplift, normalised to [0, 1].

    Volcanic centres strung along `arc_centreline`, each an ellipse elongated
    along strike and stepped across it, over a weak submarine ridge (`floor`)
    that joins them below the waterline. The along-strike structure is not
    decoration: a *smooth* uplift belt converges to one continuous wall with
    regular transverse valleys (measured — PLAN-maps M8p), which is a
    mountain range, not an archipelago.

    `segmentation` (0-1) is the tectonic-segment knob added by M8t, and it
    scales three coupled terms at once — the arc-segment idea is one idea,
    not three:

      * **cross-strike breaks** — a transverse trough at each segment
        boundary (`break_depth`, `break_width`), multiplied into the belt
        *including* its submarine ridge, so a break is a strait rather than
        a saddle;
      * **en-echelon step** — a per-*segment* across-strike staircase of
        `echelon_step` * `sig_across`, replacing most of the per-centre
        jitter, so consecutive segments are laterally offset by more than
        their own width;
      * **back-arc high** — a second, weaker belt (`back_arc`) offset
        `back_arc_offset` to the concave side, i.e. a second divide axis
        with a basin between it and the arc.

    Measured at 2049^2 / 8 elmos, dinf, `--arc-detail 17`, seed 20260730,
    landmass 0.30 — `uplift.anisotropy_bands` **excess** on M8r's 1025^2
    crop, and `uplift.divide_topology` on the whole map (PLAN-maps M8t):

        arm                        16-32  32-120  120-300  300-800  islands  relief
        seg 0 (M8s)                 2.32   1.35    1.24     1.62       1     1262
        seg 1                       2.02   1.32    1.17     1.05       3     1650
        seg 1, relief-matched       1.54   1.51    1.24     1.19       5     1263
        shipped skerry_reach        1.49   1.48    1.17     0.99       8      553

    The verdict rests on the third row, because segmentation *removes*
    uplift and the aim hands back a larger rate for the same target: at the
    same `--relief-target 950` the segmented arm stands 1 650 elmos of
    relief against 1 262, so its readings are not a like-for-like pair.
    Aimed at 730 it lands on 1 263 — the baseline's relief to 0.1 % — and
    three of the four bands then sit within 0.07 of the shipped map's.
    Read relief on the output, never assume it.

    ⚠ **Every number in that table is the ERODED surface** (and a single
    crop, which M8v then replaced with the pooled survey). Re-taken on the
    surface that ships — after roads, rivers and the sill — the verdict
    holds but the band it holds in *swaps*, so quote M8z's table and not
    this one when ranking arms (PLAN-maps M8z):

        arm (pooled survey)        16-32  32-120  120-300  300-800  ridges  span
        seg 0, shipped surface      1.19   1.22    1.17     1.27      3     9288
        seg 1, shipped surface      1.11   1.18    1.06     1.12      7     5830

    300-800 was M8t's headline at −0.30 eroded; on the shipped surface it is
    −0.15 against a matched-arm envelope of up to 0.12, i.e. no longer
    decisive, while 16-32 (−0.08 against 0.01) and the divide topology
    (3 pieces spanning 9 288 elmos against 7 spanning 5 830) are.

    Amplitudes here are relative. `uplift.scale_uplift_for_relief` turns
    them into a rate that stands the highest ground where the author asked —
    and on this field it overshoots by **+65 %** (950 asked, 1 570 stood)
    against +27 % un-segmented, which is a bigger target for the aim item
    and not a reason to quietly retune `--relief-target`.
    """
    ax, az = arc_centreline(bow)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(ax), np.diff(az)))])

    n_c = int(s[-1] // spacing) + 1
    j = np.arange(n_c, dtype=np.int64)
    h_off = _hash01(j, j * 7 + 1, seed, 61)      # along-strike jitter
    h_ech = _hash01(j, j * 7 + 2, seed, 62)      # across-strike step
    h_amp = _hash01(j, j * 7 + 3, seed, 63)
    h_len = _hash01(j, j * 7 + 4, seed, 64)
    h_brk = _hash01(j, j * 7 + 5, seed, 65)      # break-position jitter

    seg = float(np.clip(segmentation, 0.0, 1.0))
    sj_all = ((j + 0.5) * spacing + (h_off - 0.5) * 0.44 * spacing)

    u = np.zeros(xx.shape)
    for i in range(n_c):
        sj = sj_all[i]
        if sj <= 0.0 or sj >= s[-1]:
            continue
        k = int(np.clip(np.searchsorted(s, sj), 1, ax.size - 2))
        tx, tz = ax[k + 1] - ax[k - 1], az[k + 1] - az[k - 1]
        L = np.hypot(tx, tz)
        tx, tz = tx / L, tz / L
        # en-echelon: a per-segment staircase across strike, plus what is
        # left of the per-centre jitter. At seg = 0 this is the shipped
        # per-centre random offset, bit-for-bit.
        stair = (((i // max(seg_centres, 1)) % 2) * 2.0 - 1.0)
        if seg <= 0.0:
            off = (h_ech[i] * 2.0 - 1.0) * sig_across * 1.5
        else:
            off = ((1.0 - seg) * (h_ech[i] * 2.0 - 1.0) * 1.5
                   + seg * (stair * echelon_step
                            + (h_ech[i] - 0.5) * 0.5)) * sig_across
        cx, cz = ax[k] - tz * off, az[k] + tx * off
        dx, dz = xx - cx, zz - cz
        along = (dx * tx + dz * tz) / (sig_along * (0.75 + 0.5 * h_len[i]))
        across = (-dx * tz + dz * tx) / sig_across
        u = np.maximum(u, (0.55 + 0.45 * h_amp[i])
                       * np.exp(-(along ** 2 + across ** 2)))

    # distance to the arc, and — for the breaks — the along-strike station of
    # the nearest point on it. Same stride as the shipped d_arc loop.
    breaking = seg > 0.0 and break_depth > 0.0
    d_arc = np.full(xx.shape, np.inf)
    s_arc = np.zeros(xx.shape) if breaking else None
    for k in range(0, ax.size, 8):
        if breaking:
            d = np.hypot(xx - ax[k], zz - az[k])
            closer = d < d_arc
            d_arc = np.where(closer, d, d_arc)
            s_arc = np.where(closer, s[k], s_arc)
        else:
            d_arc = np.minimum(d_arc, np.hypot(xx - ax[k], zz - az[k]))
    u = np.maximum(u, floor * np.exp(-(d_arc / 2600.0) ** 2))

    if seg > 0.0 and back_arc > 0.0:
        # the concave side of a bowed arc is the side its chord is on, and
        # +off in the loop above is that side (checked: the centreline's
        # midpoint is 3397 elmos from the chord's, towards -z, and +off
        # moves +z). One belt, so one extra divide axis, not a mirror.
        d_bk = np.full(xx.shape, np.inf)
        for k in range(4, ax.size - 4, 8):
            tx, tz = ax[k + 4] - ax[k - 4], az[k + 4] - az[k - 4]
            L = np.hypot(tx, tz)
            bx = ax[k] - tz / L * back_arc_offset
            bz = az[k] + tx / L * back_arc_offset
            d_bk = np.minimum(d_bk, np.hypot(xx - bx, zz - bz))
        u = np.maximum(u, seg * back_arc
                       * np.exp(-(d_bk / back_arc_sig) ** 2))

    # a little lithospheric grain, so the centres are not nine ellipses
    u *= 0.55 + 0.6 * (0.5 + 0.5 * tn.fbm(
        tn.SimplexNoise(seed + 3), xx / 1900.0, zz / 1900.0, octaves=3))

    if breaking:
        # breaks go on LAST (before the low-pass) and multiply everything,
        # submarine ridge and back-arc high included: a transverse fault
        # zone offsets the whole structure, it does not notch the summits.
        cut = np.ones(xx.shape)
        for i in range(n_c - 1):
            if (i + 1) % max(seg_centres, 1) != 0:
                continue
            sb = 0.5 * (sj_all[i] + sj_all[i + 1]) \
                + (h_brk[i] - 0.5) * 0.3 * spacing
            if sb <= 0.0 or sb >= s[-1]:
                continue
            cut *= 1.0 - (seg * break_depth
                          * np.exp(-((s_arc - sb) / break_width) ** 2))
        u *= np.maximum(cut, 0.0)

    u = up.smooth_uplift(u, cell, wavelength_elmos=900.0)
    return u / max(float(u.max()), 1e-9)


def arc_platform(seed: int, landmass: float, u: np.ndarray,
                 xx: np.ndarray, zz: np.ndarray,
                 detail: float = ARC_DETAIL_DEFAULT) -> np.ndarray:
    """The surface the arc grows out of: trench floor, shelf, and fine grain.

    The LEM has no sea in it — every cell erodes as if subaerial — so the
    *bathymetry* has to be authored even when the relief is not. Uplift
    draws the land; this draws the water it stands in, and the landmass
    quantile puts the waterline where the contract says.

    `detail` is the fine grain, and it is not decoration. The multires
    driver carries the input's *band detail* — the high-pass residual the
    coarse grid could not represent — across the upsample, and then 30 fine
    iterations incise into it. A platform of smooth bathymetry has nothing
    in that band to carry (0.040 elmos of residual std, measured), so every
    elmo of the arc's fine relief was made by the solver itself, out of its
    own cell-scale channel initiation — which is what the eye reads as
    hatching even after the router stops combing it (PLAN-maps M8q FIND 4).
    The shipped `mounds` generator escapes that by construction: its input
    carries **2.266** elmos of high-pass residual and erosion only finishes
    it (output 2.125). This term authors the same amount for the arc —
    fBm over 15-120 elmos, i.e. the band `structural_anisotropy` reads, at
    the amplitude that lands the residual on the mounds figure (0.131 elmos
    of residual per elmo of amplitude, so ~17). Its coarsest octave is
    representable on the 32-elmo coarse grid and so reaches the coarse solve
    too; the landform is unaffected either way, because `smooth_uplift`
    holds that at 900 elmos and up.

    It rides everywhere, seafloor included, because the solver erodes
    everywhere; below the waterline it is invisible in-game and it is the
    channel network's seed, not scenery.
    """
    coast = tn.fbm(tn.SimplexNoise(seed + 9), xx / 2400.0, zz / 2400.0,
                   octaves=5)
    h = -90.0 + 240.0 * np.clip(u * 1.9, 0.0, 1.0) + 30.0 * coast
    if detail > 0.0:
        h = h + detail * tn.fbm(tn.SimplexNoise(seed + 11),
                                xx / ARC_DETAIL_WAVELENGTH,
                                zz / ARC_DETAIL_WAVELENGTH, octaves=4)
    return h - np.quantile(h, 1.0 - landmass)


def substrate_hardness(seed: int, xx: np.ndarray, zz: np.ndarray,
                       detail: float = 0.0) -> np.ndarray:
    """The erodibility field `K`: coarse substrate, plus optional mid grain.

    The coarse term is the shipped one — 3400 elmos over 3 octaves, so its
    finest variation is at 850 elmos. `detail` adds a zero-mean fBm at
    HARDNESS_WAVELENGTH over 3 octaves (800/400/200), in the same absolute
    K units, floored at HARDNESS_FLOOR so no cell becomes unerodible.

    ⛔ **`detail` defaults to 0 on every path, because it was measured and
    it does not do what it was built for** (PLAN-maps M8s). The premise was
    that the arc's regular feathered spurs are drainage-spacing regularity
    on a homogeneous substrate, so varying the substrate at the spurs' own
    scale would break the spacing. Two full 2049^2 arms say otherwise. On
    `uplift.anisotropy_bands` excess, against the shipped map's 1.06 at
    300-800: a17 1.62 -> 1.49 (detail 0.004) -> 1.50 (0.008), i.e. the
    target band barely moves — while **120-300 goes the wrong way**, 1.24 ->
    1.50 -> 1.74, its lobe swinging onto the arc's own strike, because
    erodibility contrast at 200-800 elmos organises channels along the
    contrast bands. Relief also drifts +8 % at 0.008 despite the aim being
    taken on the coarse field, so even the "free" arm is not free.

    The knob is kept, off, because it is the tested implementation of an
    idea the lane will otherwise propose again, and this paragraph is the
    answer. What the same milestone found instead: the 150 deg lobe is
    largely the *authored landform's* — the un-eroded arc platform reads
    1.34 excess at 300-800 on the same crop, before any solver runs — and
    the hillshade's real defect is topological, one continuous smooth
    divide corner to corner with regular opposing spurs, which is what a
    converged LEM on a single smooth linear ridge must produce. That is
    `arc_uplift`'s to fix (segmentation), not this function's.

    ⚠ `detail` must NOT reach the relief aim. `scale_uplift_for_relief` sums
    `U/(K*sqrt(a))` down a flow path, and `1/K` is convex, so a zero-mean
    perturbation of `K` *raises* `Psi` and the aim hands back less uplift —
    the same class of confound M8r found for the surface grain, arriving
    through a different term. `generate` aims on the coarse field and solves
    on the full one.
    """
    k = 0.016 + 0.020 * (0.5 + 0.5 * tn.fbm(
        tn.SimplexNoise(seed + 2), xx / 3400.0, zz / 3400.0, octaves=3))
    if detail > 0.0:
        k = k + detail * tn.fbm(tn.SimplexNoise(seed + 13),
                                xx / HARDNESS_WAVELENGTH,
                                zz / HARDNESS_WAVELENGTH, octaves=3)
        k = np.maximum(k, HARDNESS_FLOOR)
    return k


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

def erosion_cache_path(terrain: str, router: str, seed: int, landmass: float,
                       islands: int, relief_target: float, arc_detail: float,
                       fast: bool, hardness_detail: float = 0.0,
                       segmentation: float = 0.0, aim_pass: int = 0) -> str:
    """Where a converged surface is cached — and the key IS the contract.

    Every input the solver saw has to appear here or a later run silently
    gets someone else's landscape. `arc_detail` is in it for that reason: a
    cache written before `arc_platform` grew its grain is a *different*
    surface under identical parameters. It is left out of the `mounds` key
    so the shipped `skerry_reach` cache stays addressable.

    `hardness_detail` and `segmentation` are keyed the same way and only when
    they are on, so every surface converged before `substrate_hardness` grew
    its mid-scale term, or before `arc_uplift` grew its segment breaks, stays
    addressable at its own key — which is what makes an A/B against an older
    arm free rather than a 450-second re-run.

    `aim_pass` keys the closed-loop aim's passes (`generate`'s
    `aim_iterations`). Pass 0 takes no suffix, so it is the same key every
    arm converged at before M8u and **the first pass of a two-pass run is
    free on any machine that has one** — which is the whole reason the loop
    costs one extra pass rather than two.
    """
    arc_key = f"_a{arc_detail}v{ARC_REV}" if terrain == "arc" else ""
    k_key = f"_k{hardness_detail}v{HARD_REV}" if hardness_detail > 0.0 else ""
    s_key = (f"_g{segmentation}v{SEG_REV}"
             if terrain == "arc" and segmentation > 0.0 else "")
    i_key = f"_i{aim_pass}" if aim_pass > 0 else ""
    return os.path.join(
        os.environ.get("TMPDIR", "/tmp"),
        f"archipelago_eroded_r{SYNTH_REV}_{terrain}_{router}_{seed}_{landmass}_"
        f"{islands}_{relief_target}{arc_key}{k_key}{s_key}{i_key}_"
        f"{'fast' if fast else 'full'}.npy")


class SurfaceReport(NamedTuple):
    """The three readings this lane ranks arc arms by, on ONE named surface."""
    label: str
    divides: "up.DivideReading"
    relief: float                       # max - min, the summit reading
    aim: "up.ReliefReading | None"      # arc only — the quantile the aim is at
    texture: "list[up.SurveyReading]"


def report_surface(h: np.ndarray, cellsize: float, label: str,
                   terrain: str = "arc", relief_target: float = 950.0,
                   log=print) -> SurfaceReport:
    """Print (and return) the divides / aim / texture readings of `h`.

    **Every line is tagged with the surface it was read on, because they do
    not agree, and the lane spent M8q-M8t ranking arms on the wrong one**
    (M8x FIND 5). `generate` calls this twice:

    * `eroded` — step 3, straight off the solver. This is the surface an
      erosion arm *is*: the only thing between it and the cache is the
      landmass re-quantile, so it is what an uplift/grain/segmentation knob
      can be held responsible for.
    * `shipped` — step 7b, after roads, rivers and the sill carve, which is
      the surface `regions_from_map.py --verify` reads and the surface the
      player drives. On the shipped arc, 14 road segments at 44 elmos wide
      and 5 707 river reaches take the 16-32 elmo band from **1.59 to
      1.11** — so a fine-band verdict quoted off `eroded` is quoting a map
      that was never packaged.

    Neither is "the" reading: a solver knob is answerable for `eroded` and
    the map ships `shipped`. Printing one and calling it both is what the
    correction is against, so print both, always.

    The `aim` line is the one place the two are *reconciled* rather than just
    both printed: M9f attributed its whole 1.6-2.7 % gap to the river pass's
    bank clamp (pads, roads and the sill carve spend 0.0), and the closed loop
    is left aiming at `eroded` on purpose — see the `aim_probe` note in
    `generate`, which prints the per-pass decomposition on every arc run.

    ~15 s per call on a 2049^2 grid (the survey; the other two are cheap)
    against a ~430 s solve.
    """
    tag = f"[{label}]"
    # how many independent massifs, and how long is the longest divide — the
    # reading M8s's spectral instrument is blind to (PLAN-maps M8t). Cheap
    # (two labelings), and the number every arc arm has to be judged on.
    dv = up.divide_topology(h, cellsize)
    relief = float(h.max() - h.min())
    log(f"divides{tag}: {dv.ridges} high-ground pieces, longest span "
        f"{dv.ridge_span:.0f} elmos ({dv.ridge_share:.0%} of the high "
        f"ground), relief {relief:.0f}")
    # ...and the same surface read at the statistic the aim is TAKEN at, so
    # nobody judges a quantile aim by a summit again: `max-min` above runs
    # 1.24-1.37x this number on every full-res surface this generator has
    # written, the shipped mounds map included (PLAN-maps M8u).
    rr = None
    if terrain == "arc":
        rr = up.relief_reading(h, relief_target)
        log(f"aim{tag}: stood {rr.stood:.0f} of {rr.aimed:.0f} asked "
            f"({rr.residual:+.1%}) at q{rr.quantile}, "
            f"summit {rr.summit:.0f} ({rr.summit / rr.stood:.2f}x)")
    # ...and the texture, pooled over every land-dense window rather than off
    # one crop, because one crop of one surface scatters 0.45-0.60 of excess
    # depending only on where it is taken (PLAN-maps M8v). ~15 s on a 2049^2
    # grid against a 430 s solve, and it is what makes two arms comparable.
    an = up.anisotropy_survey(h, cellsize)
    log(f"texture{tag}: " + "  ".join(
        f"{r.lo:.0f}-{r.hi:.0f} {r.excess:.2f}@{r.lobes[0][0]:.0f}deg"
        for r in an)
        # the envelope quoted here is the POOLED one M8v measured on two
        # matched arm sets (0.04-0.14 per band). The +-0.15 this line used to
        # print was the single-crop scatter — i.e. the number that milestone
        # exists to say is NOT the reading's error bar.
        + (f"  (pooled over {an[0].tiles} tiles, +-0.04..0.14 per band)"
           if an[0].tiles > 1 else
           "  (ONE crop — a sample, not a reading; needs a full-res grid)"))
    return SurfaceReport(label, dv, relief, rr, an)


def generate(out_dir: str, seed: int, landmass: float = 0.34, islands: int = 9,
             fast: bool = False, with_features: bool = False,
             preview_only: bool = False, no_package: bool = False,
             map_id: str = "skerry_reach", display_name: str = "Skerry Reach",
             climate: str = "temperate", terrain: str = "mounds",
             router: str = "auto", relief_target: float = 950.0,
             arc_detail: float = ARC_DETAIL_DEFAULT,
             hardness_detail: "float | None" = None,
             segmentation: "float | None" = None,
             aim_iterations: "int | None" = None,
             connect: "bool | None" = None,
             start_connectivity: "bool | None" = None,
             raise_penalty: int = 1):
    t0 = time.time()
    cell = 32.0 if fast else 8.0
    S = int(MAP_SIZE / cell) + 1
    # 'auto' is per-terrain, not global: `mounds` must stay on D8 or the
    # shipped skerry_reach package moves, while `arc` builds its channel
    # network from nothing and so inherits whatever lattice it routes over
    # (PLAN-maps M8q).
    if router == "auto":
        router = "dinf" if terrain == "arc" else "d8"
    # the mid-scale substrate term is an `arc` knob: `mounds` ships, and a
    # non-zero default there would move the skerry_reach package (M8s).
    if hardness_detail is None:
        hardness_detail = ARC_HARDNESS_DETAIL if terrain == "arc" else 0.0
    # segmentation is meaningless off the arc — there is no belt to break
    if segmentation is None:
        segmentation = ARC_SEGMENTATION if terrain == "arc" else 0.0
    # only the arc is aimed at all; `mounds` draws its heights directly
    if aim_iterations is None:
        aim_iterations = ARC_AIM_ITERATIONS if terrain == "arc" else 1
    aim_iterations = max(1, int(aim_iterations))
    # sill carving is post-erosion and submarine, so it is not in the erosion
    # cache key — it cannot change what the solver converged to
    if connect is None:
        connect = ARC_CONNECT_STARTS if terrain == "arc" else False
    # the pad gate is placement, not erosion, so it is not in the cache key
    # either — but unlike the carve it DOES move where the pads land, so it
    # moves roads, towns and every downstream placement on the map
    if start_connectivity is None:
        start_connectivity = ARC_GATE_START_PADS if terrain == "arc" else False
    print(f"grid {S}x{S} @ {cell} elmos/cell  "
          f"(seed={seed} landmass={landmass} islands={islands} "
          f"climate={climate} terrain={terrain} router={router}"
          + (f" segmentation={segmentation}" if terrain == "arc" else "")
          + ")")

    zz, xx = np.mgrid[0:S, 0:S].astype(np.float64) * cell
    hardness = substrate_hardness(seed, xx, zz, detail=hardness_detail)
    # the aim runs on the COARSE substrate — see substrate_hardness's warning
    hardness_aim = (hardness if hardness_detail <= 0.0
                    else substrate_hardness(seed, xx, zz, detail=0.0))

    # 1. skeleton — drawn (mounds) or authored as a rate (arc)
    u = None
    if terrain == "arc":
        u = arc_uplift(seed, xx, zz, cell,
                       segmentation=segmentation)
        h = arc_platform(seed, landmass, u, xx, zz, detail=arc_detail)
        # aim with the PATH INTEGRAL, not (U/K)*Phi: this field varies on
        # the drainage network's own scale, which is exactly the case the
        # scalar form factorises away (2.4x out — PLAN-maps M8p).
        # Aim on the LANDFORM, not on the grained surface: `Psi` is a sum
        # down a flow path, so cell-scale grain shortens it and inflates the
        # rate it hands back — the same target came out at 2046 elmos of
        # relief aimed through the grained platform against 1406 through the
        # smooth one, and the extra relief carries its own fine texture,
        # which is the effect the grain exists to remove (PLAN-maps M8r).
        h_aim = (h if arc_detail <= 0.0
                 else arc_platform(seed, landmass, u, xx, zz, detail=0.0))
        u = u * up.scale_uplift_for_relief(h_aim, u, hardness_aim,
                                           relief_target, router=router)
        print(f"arc uplift authored {time.time()-t0:.0f}s "
              f"(aim {relief_target:.0f} elmos, U max {u.max():.4f})")
    else:
        h = synth_height(seed, landmass, islands, xx, zz)
    print(f"synth done {time.time()-t0:.0f}s relief {h.min():.0f}..{h.max():.0f}")

    # 2. erosion (cached per parameter set — the cache key IS the contract)
    def _cache(aim_pass=0):
        return erosion_cache_path(terrain, router, seed, landmass, islands,
                                  relief_target, arc_detail, fast,
                                  hardness_detail, segmentation, aim_pass)

    cache = _cache(aim_iterations - 1)
    if os.path.exists(cache):
        h = np.load(cache)
        print(f"erosion loaded from cache {cache}")
    elif terrain == "arc":
        # the landform IS the erosion here, so it has to run to steady state:
        # ~30 iterations only *adds* the field (M8m). Coarse-first makes that
        # affordable, and `match_relief` is what keeps the coarse grid aiming
        # at the fine grid's relief rather than half of it.
        #
        # CLOSED-LOOP AIM (M8u): `scale_uplift_for_relief` above is
        # first-order — it reads the steady-state relief of the drainage the
        # *platform* has, and this solver then builds a different one. Read
        # at the aim's own statistic that is worth +0.4 % on the
        # un-segmented arc and +28 % on the segmented one, and it is not a
        # bad estimator that a better one replaces: the residual is set by
        # how the drainage reorganises, so no ratio measured before the
        # solve runs aims both arms (M8u tested four). So measure what stood
        # and correct it, which is exact to the linearity of relief in U.
        platform = h
        for ap in range(aim_iterations):
            cache = _cache(ap)
            if os.path.exists(cache):
                h = np.load(cache)
                print(f"erosion loaded from cache {cache}")
            else:
                h = ero.stream_power_erode_multires(
                    platform, cellsize=cell, coarse_factor=4,
                    coarse_iterations=(600 if fast else 3000),
                    fine_iterations=(10 if fast else 30),
                    uplift=u, k_erode=hardness, dt=1.4, m_exp=0.5,
                    talus_deg=33.0, thermal_rate=0.35, router=router,
                    progress=lambda i, n_: print(
                        f"  erosion {i}/{n_} ({time.time()-t0:.0f}s)")
                    if i % 200 == 0 else None)
                np.save(cache, h)
                print(f"erosion done {time.time()-t0:.0f}s (cached -> {cache})")
            rr = up.relief_reading(h - np.quantile(h, 1.0 - landmass),
                                   relief_target)
            print(f"aim pass {ap}: stood {rr.stood:.0f} of {rr.aimed:.0f} "
                  f"asked ({rr.residual:+.1%}) at q{rr.quantile}, "
                  f"summit {rr.summit:.0f}")
            if ap + 1 < aim_iterations:
                corr = relief_target / max(rr.stood, 1e-9)
                u = u * corr
                print(f"  closing the loop: uplift x{corr:.4f}")
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
    report_surface(h, cell, "eroded", terrain=terrain,
                   relief_target=relief_target)

    # The aim is read here and again at step 7c, and the two disagree by
    # 1.6-2.7 points on every arm measured (M8z FIND 5) — the closed loop
    # converges on a surface the map does not ship. This probe says WHICH
    # terrain pass spends it: one quantile over the grid (~40 ms against a
    # ~430 s solve) after each pass of the pad loop, tagged like every other
    # reading here. It is a reading, not a knob — nothing branches on it.
    #
    # Measured, two full-res arms (M9f): pads 0.0, roads 0.0, sill carve 0.0,
    # **rivers all of it** — 930 -> 909 on the shipped arm and 954 -> 939 on
    # the un-segmented one, and inside rivers it is the bank clamp rather than
    # the bed (`RiverParams.bank_width` carries the numbers). The aim is left
    # closing on `[eroded]` deliberately: the uplift scale is a solver knob and
    # `[eroded]` is the solver's surface, the summit and the max-min relief do
    # not move across the river pass at all (1212 and 1278 on both surfaces —
    # what falls is a quantile, because the bank clamp shaves the high band
    # while leaving the peaks: only 3 % of strict ridge cells are cut at all,
    # 0.1 % of the cut volume, M9g), and re-aiming through it would re-ship
    # terrain the arc's open armour-split question is measured on. Closing on
    # `[shipped]` instead is
    # ~1 extra erosion pass plus ~13 s of placement per pass, NOT the "2x a
    # pass" M8z estimated — the roads half of that estimate is free.
    def aim_probe(hh, label):
        if terrain != "arc":
            return
        rr = up.relief_reading(hh, relief_target)
        print(f"  aim[{label}]: stood {rr.stood:.0f} of {rr.aimed:.0f} "
              f"({rr.residual:+.1%}) at q{rr.quantile}, "
              f"summit {rr.summit:.0f}")

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
    # The separation is GLOBAL, and it used to be per-island: each island's
    # picks were made on their own masked copy of the score, so the round
    # robin never saw the pads it had already placed elsewhere. Measured
    # (PLAN-maps M9b), the shipped skerry_reach put two pads **3 496 elmos**
    # apart across a strait against a 3 600 constraint, and sundered_arc
    # 3 558. Carrying one accumulated exclusion field costs one pick per call
    # instead of re-deriving the island's whole greedy prefix, and is exactly
    # the old within-island behaviour when there is only one island.
    # ...and the score is not the only thing a pad has to satisfy: `banned`
    # carries the ground a previous pass proved no sill can reach. It is empty
    # on the first pass and stays empty forever unless `--start-connectivity`
    # is on. See the pad-pass loop below for why this is an outer loop and not
    # a per-candidate test.
    def place_pads(banned, strict=True):
        """`strict=False` returns None instead of exiting — a *re*-placement
        that cannot be made is a map that has to ship split, not a failure."""
        starts: list[tuple[float, float]] = []
        ring = [l for l in big if sizes[l] * cell * cell > 2.5e6] or big
        per_island = {l: 0 for l in ring}
        taken = banned.copy()
        while len(starts) < N_STARTS and ring:
            l = min(ring, key=lambda l_: per_island[l_])
            s_isl = np.where(labels == l, score, 0.0)
            got = st.pick_sites(s_isl, cell, 1, sp, forbidden=taken)
            if not got:
                ring.remove(l)                    # island is full
                continue
            sx, sz = got[0]
            starts.append(got[0])
            per_island[l] += 1
            taken |= np.hypot(xx - sx, zz - sz) < sp.min_separation
        if len(starts) < N_STARTS:
            banned_note = ("; the connectivity ban covers "
                           f"{100.0 * banned.mean():.1f}% of the map"
                           if banned.any() else "")
            if not strict:
                place_pads.why = (
                    f"only {len(starts)} of {N_STARTS} pads fit once the ban "
                    f"is applied ("
                    + "; ".join(f"island {l_}: {n}"
                                for l_, n in per_island.items()) + ")")
                return None
            raise SystemExit(
                f"only {len(starts)} start pads fit on {len(per_island)} "
                f"island(s) — raise --landmass or lower --islands (need "
                f"{N_STARTS} sites scoring above zero and "
                f"{sp.min_separation:.0f} elmos apart; "
                + "; ".join(f"island {l_}: {n}"
                            for l_, n in per_island.items())
                + f"{banned_note})")
        return starts

    # 5b-7b as ONE pad pass, so a pad the map turns out not to be able to
    # reach can be re-picked and the whole placement re-derived (PLAN-maps
    # M9c). This has to be an OUTER loop, and that is the milestone's finding
    # rather than a structural preference: the obvious design — gate each
    # candidate at pick time on `read_connectivity` — was built first and
    # starves, because at the moment the placer runs the arc grades 2.4 %
    # armour-passable in 27 285 components (largest 2.9 % of that) and only
    # reads 17.4 % in 2 components once roads, rivers and the sill are in.
    # The roads that make the map drivable are planned FROM the pads, so the
    # pads must exist before the thing that decides whether they were
    # placeable. Measured: the pick-time gate rejected 66 sites and placed 1
    # pad. Each pass costs roads + rivers + carve, ~30 s of a 289 s arc run.
    h_pre = h
    banned = np.zeros(h.shape, dtype=bool)
    starts = place_pads(banned)
    for pad_pass in range(PAD_PASSES if start_connectivity else 1):
        h = h_pre.copy()
        after = None

        # flatten the pads (guaranteed dry: pad level >= +18)
        for sx, sz in starts:
            m = np.hypot(xx - sx, zz - sz) < 420.0
            pad_h = max(float(np.median(h[m])), 18.0)
            d = ndimage.distance_transform_edt(~m) * cell
            w = np.clip(1.0 - d / 500.0, 0.0, 1.0) ** 2
            h = h * (1 - w) + pad_h * w
        aim_probe(h, f"pass {pad_pass}: +pads")

        # 6. settlements + per-island road networks (roads never island-hop:
        # each island's sites are planned as their own network)
        slope = np.degrees(np.arctan(np.hypot(*np.gradient(h, cell)[::-1])))
        # a DIFFERENT field from the pad score above: this one is read on the
        # post-pad surface and only towns use it. `place_pads` closes over the
        # pre-pad `score`, and re-binding this name would quietly hand pass 2
        # a score that already has pass 1's pads levelled into it.
        town_score = st.settlement_score(h, slope, b, 0.0, cell, score_sp)
        pad_excl = np.zeros(h.shape, bool)
        for sx, sz in starts:
            pad_excl |= np.hypot(xx - sx, zz - sz) < 700.0
        # no slope override: the M9a cost model blocks on the road's own grade and
        # prices the hillside it is cut into, so the old `max_slope_deg=26` (a
        # terrain-slope wall that isolated a town site standing on 29 deg ground)
        # has no successor here — see PLAN-maps M9a.
        rp = rd.RoadParams(plan_step=(1 if fast else 4), road_width=44.0,
                           water_penalty=80.0)
        # ...and the two now have to AGREE about buildable ground. M9a FIND 1 was
        # a town site standing where the road cost field could not take a single
        # step, so the planner handed it its own one-site network and the map
        # gained a second, unexplained road system. `settlement_score` reads a
        # 320-elmo disc of full-res slope; the planner reads one decimated
        # planning cell. This is the planner's own field, so the site placer is
        # answering the planner's question rather than a similar-looking one.
        # Pads do not need it: they are levelled over a 420-elmo disc above,
        # which is ~13 planning cells, so a pad makes its own cell buildable.
        unbuildable = rd.unbuildable_mask(h, 0.0, cell, rp)
        # roads R2 — each island gets its own HIERARCHY, not just its own
        # network. The role reading for an archipelago: a start pad is a portal
        # (the trunk has to reach it), the island's best town is the highway's
        # other end, and the remaining towns — `pick_sites` returns them in
        # descending score order — are villages that join the trunk wherever it
        # passes them. Giving every town portal status instead would make every
        # road on the island a highway, which is the one answer a hierarchy is
        # supposed to rule out.
        network = rd.RoadNetwork()
        towns: list[tuple[float, float]] = []
        for l in big:
            area = sizes[l] * cell * cell
            want = int(np.clip(area / 6.0e6, 1, 4))
            s_isl = np.where((labels == l) & ~pad_excl, town_score, 0.0)
            sites = st.pick_sites(s_isl, cell, want,
                                  st.SettleParams(min_separation=2000.0),
                                  forbidden=unbuildable)
            towns += sites
            # connect this island's towns + its start pads into one network
            isl_starts = [p for p in starts
                          if labels[int(p[1] / cell), int(p[0] / cell)] == l]
            eps = list(sites) + isl_starts
            roles = ([rd.NODE_TOWN] + [rd.NODE_MINOR] * (len(sites) - 1)
                     + [rd.NODE_EDGE] * len(isl_starts)) if sites else \
                    [rd.NODE_EDGE] * len(isl_starts)
            if len(eps) >= 2:
                sub = rd.plan_network(h, 0.0, cell, eps, roles, rp)
                network.links += sub.links
                network.junctions += sub.junctions
        polylines = network.polylines
        raster = rd.rasterize_network(network, h.shape, cell, rp)
        road_mask, road_dist = raster.mask, raster.dist
        rd.carve_plazas(road_mask, road_dist, towns, 85.0, cell, rp)
        rd.carve_junction_aprons(raster, network.junctions, cell, rp)
        # ONE flatten pass over the combined field — see roads.flatten_network
        h = rd.flatten_network(h, raster, cell, rp)
        _mix = ", ".join(f"{rd.ROAD_CLASS_NAMES[k]} {v:.0f}"
                         for k, v in sorted(network.length_by_class().items())
                         if v > 0)
        print(f"roads done {time.time()-t0:.0f}s ({len(polylines)} segments, "
              f"{len(towns)} town plazas, {len(starts)} starts, "
              f"{len(network.junctions)} junctions; length by class: {_mix})")
        rd.report_delivered_grades(network, h, cell, rp)
        aim_probe(h, f"pass {pad_pass}: +roads")

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
        #
        # ⚠ `bank_width` is the arc's most consequential terrain knob and the
        # one nothing here is aimed at (M9g). It is not the channels that are
        # narrow: at 55 the graded apron is 110 elmos either side of a median
        # 10-elmo channel, it covers 31.8 % of the land against the bed's
        # 4.4 %, and because the clamp is deepest at its outer edge and then
        # terminates, it replaces the erosion fabric with flat pods rimmed by
        # one-cell steps (mean 17 elmos, max 153). At 20 the same network
        # reads as drainage etched into intact ridges. Left at 55 on purpose
        # for now: any change here re-ships the terrain the arc's blocked-on-
        # user armour-split verdict is measured on, and the fix is a shape
        # change in `_bin_field`, not this number. PLAN-maps M9g.
        rp_riv = riv.RiverParams(channel_fraction=(0.045 if fast else 0.025),
                                 width_coef=0.05, width_min=9.0, width_max=48.0,
                                 depth_max=6.0, bank_width=55.0)
        net = riv.build(h, recv, levels, accum, cell, 0.0, seed, rp_riv, protect)
        h = net.terrain
        rivers = net.is_water
        print(f"rivers done {time.time()-t0:.0f}s ({len(net.polylines)} reaches, "
              f"{100.0 * net.channel_mask.mean():.2f}% channel cells)")
        aim_probe(h, f"pass {pad_pass}: +rivers")

        # 7b. make the map playable for armour: raise a submarine sill across the
        # shallowest strait until every start can reach every other (PLAN-maps
        # M8x). This runs LAST of the terrain passes, and that placement is the
        # milestone's find rather than a detail: roads are worth about half the
        # reading. Measured on the shipped arc, the same grading before roads and
        # rivers says VEH 11.5 % passable in EIGHT components, and after them
        # 17.5 % in two — `flatten_under_roads` lays graded corridors across
        # ground erosion left too steep to drive. Carving against the pre-road
        # surface would therefore chase eight splits that the road network is
        # about to close on its own. The verdict `regions_from_map.py --verify`
        # takes is on the packaged bytes; this has to be the same surface.
        #
        # The carve is strictly submarine and only ever raises, so it moves the
        # land fraction and the relief aim by nothing at all and the texture
        # survey by at most 0.01 in one band (M8x measured both `.smf`s) — but
        # roads and rivers, two steps above, move it by 0.48, which is why the
        # `[shipped]` report below is taken after all three rather than at step 3.
        # Nothing is placed on the sill either (`excl` takes everything under +2).
        before = pas.read_all(h, cell, starts)
        print("passability: " + " | ".join(
            f"{r.cls} {'PASS' if r.ok else str(len(r.groups)) + ' comps'}"
            f" {r.passable_frac:.1%}" for r in before))
        if connect and any(not r.ok for r in before
                           if r.cls in pas.ARMOUR_CLASSES):
            h, crossings, after = pas.connect_starts(
                h, cell, starts, raise_penalty=raise_penalty, log=print)
            print(f"connect done {time.time()-t0:.0f}s "
                  f"({len(crossings)} sill(s) carved)")
            for r in after:
                print("  " + r.describe())
            aim_probe(h, f"pass {pad_pass}: +carve")
            if any(not r.ok for r in after if r.cls in pas.ARMOUR_CLASSES):
                print("  ⚠ armour STILL cannot cross this map end to end")

        if not start_connectivity:
            break
        arm = [r for r in (after or before) if r.cls in pas.ARMOUR_CLASSES]
        if all(r.ok for r in arm):
            break
        # Whatever is still split after the carve is split for good — a sill
        # raises a seabed and cannot grade one (M8y FIND 3) — so ban that
        # ground and re-place. The strictest class decides, because a carve
        # aimed at it answers every class it covers (`strictest`).
        worst = max(arm, key=lambda r: (len(r.groups), len(r.stranded)))
        mask, kept, stranded = pas.strand_mask(h, cell, starts)
        # ...and the ban has to be at ISLAND granularity, not component. The
        # component ban was tried first and does not converge: it covers only
        # the 1.9 % of cells the *armour grading* calls passable inside the
        # stranded group, so the placer simply re-picks a site a few hundred
        # elmos away on the same island — which the pad flattening and the
        # road network then re-attach to the same isolated group. Passes 0 and
        # 1 both came back [0, 3, 6] that way. An island is the unit the
        # round-robin already reasons in, and it is the unit a strait splits.
        isl = {int(labels[int(starts[i][1] / cell), int(starts[i][0] / cell)])
               for i in stranded}
        isl.discard(0)
        banned = banned | (np.isin(labels, list(isl)) if isl else mask)
        print(f"  pad pass {pad_pass}: {worst.cls} leaves starts {stranded} "
              f"where no sill reaches starts {kept} — island(s) {sorted(isl)}, "
              f"{100.0 * banned.mean():.1f}% of the map")
        if pad_pass + 1 >= PAD_PASSES:
            print(f"  pad pass {pad_pass}: no passes left — shipping it split")
            break
        # A re-placement that cannot be made is the map answering the
        # question, not an error: `sundered_arc` at --landmass 0.30 puts its
        # stranded group on island 1, which is 14.4 % of the map, and only 5
        # of 8 pads fit on what is left. Say so and ship the split map rather
        # than refuse to build one (PLAN-maps M9c FIND 3). And it is not a
        # property of that landmass: at 0.26 the same map bans 12.5 % on the
        # other side of the split (islands 144+304) and again fits 5 of 8, on
        # a map the carve leaves in three realms instead of two (M9d).
        retry = place_pads(banned, strict=False)
        if retry is None:
            print(f"  pad pass {pad_pass}: the ban leaves no other pad set — "
                  f"{place_pads.why}. THIS MAP IS ARMOUR-SPLIT and ships that "
                  f"way; `regions_from_map.py --verify` will fail it.")
            break
        starts = retry


    # 7c. the same three readings again, on the surface that actually ships.
    # Nothing below here moves the heightmap (placement reads it; packaging
    # quantizes it), so this IS the packaged map to within 16-bit height
    # quantization — and it does not agree with the `[eroded]` lines above,
    # which is the whole point of printing both (M8x FIND 5: roads and rivers
    # took the shipped arc's 16-32 elmo band from 1.59 to 1.11).
    report_surface(h, cell, "shipped", terrain=terrain,
                   relief_target=relief_target)

    # 8. final climate + biomes on the settled surface
    slope, temp, moist = fields(h)
    water_all = (h <= 0.0) | rivers
    b = bio.classify(h, slope, temp, moist, 0.0, river_mask=water_all)
    print(f"biomes done {time.time()-t0:.0f}s ({climate}, land): "
          f"{bio.format_biome_mix(b)}")

    # 8a. road surface classes (roads R1) — needs moisture, so it runs after
    # the biome step; `network`/`polylines`/`towns`/`rp` survive the pad-pass
    # loop above.
    # R2: sealing follows the hierarchy, so R1's length budget is not consulted
    road_cls = rd.classify_roads(polylines, moist, h, 0.0, cell,
                                 road_classes=network.road_classes)
    _surf_raster = rd.rasterize_network(network, h.shape, cell, rp,
                                        surfaces=road_cls)
    road_class = _surf_raster.surf
    rd.carve_plaza_classes(road_class, towns, 85.0, cell)
    rd.carve_junction_aprons(_surf_raster, network.junctions, cell, rp)
    _deck = max(1, int((road_class != rd.SURF_NONE).sum()))
    print("road surfaces (%d deck cells): %s" % (_deck, ", ".join(
        "%s %.1f%%" % (rd.SURFACE_NAMES[k], 100.0 * int((road_class == k).sum()) / _deck)
        for k in (rd.SURF_BITUMEN, rd.SURF_DIRT, rd.SURF_MUD))))

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
                               stamps=stamps, road_class=road_class)
        Image.fromarray(bk.make_minimap(baker, bk.hillshade(h, cell))).save(
            os.path.join(out_dir, "preview.png"))
        print(f"PREVIEW ONLY — total {time.time()-t0:.0f}s")
        return h, b, slope

    top = float(h.max())
    max_h = height_ceiling(top)
    if max_h > HEIGHT_CEILING_FLOOR:
        print(f"height ceiling {max_h:.0f} (surface tops at {top:.0f}; the "
              f"{HEIGHT_CEILING_FLOOR:.0f} floor would have sheared "
              f"{int((h > HEIGHT_CEILING_FLOOR).sum())} cells "
              f"({top - HEIGHT_CEILING_FLOOR:.0f} elmos off the summit) "
              f"into a flat top)")

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
        min_height=-120.0, max_height=max_h,
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
        roads_lua=pkg.emit_roads_lua(network, cell, rp),
        feature_files=feature_files, stamps=stamps, road_class=road_class,
    )
    baker = bk.AlbedoBaker(h, slope, b, moist, road_dist, 0.0, cell, seed,
                           stamps=stamps, road_class=road_class)
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
                         "threshold, just spread differently). M8q read that "
                         "as needing --landmass 0.30 to fit 8 separated start "
                         "pads where the D8 arm fit them at 0.26; M9b found "
                         "the real cause was the placer excluding a bounding "
                         "box rather than a disc, and 0.26 fits 8 now. "
                         "⛔ M9d then measured what those 8 pads are worth: "
                         "at 0.26 the arc is THREE armour realms against the "
                         "0.30 map's two, and six of the seven pairs the "
                         "carve is asked to join are refused for seabed "
                         "SLOPE rather than depth — a lower waterline widens "
                         "the straits onto steeper flanks, and a sill raises "
                         "a seabed but cannot grade one (M8y FIND 3). Less "
                         "land is a WORSE map here, not an escape from the "
                         "armour-split question. The shipped sundered_arc "
                         "stays at 0.30, where every M8t/M8u/M8v arm was "
                         "ranked — though M9d also measured that ranking "
                         "cost as near zero (summit 1.34x, inside M8u's "
                         "1.24-1.37; shipped 16-32 anisotropy 1.09 against "
                         "0.30's 1.11), so landmass is not the tuning "
                         "tripwire this lane has been treating it as.")
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
                         "uplift.scale_uplift_for_relief (~10%% first-order) "
                         "and then closed to ~0%% by --aim-iterations. ⚠ that "
                         "loop closes on the ERODED surface: the packaged map "
                         "stands 1.6-2.7%% lower at q0.999 because the river "
                         "pass's bank clamp shaves the high band (M9f — pads, "
                         "roads and the sill carve spend nothing, and the "
                         "summit does not move at all). Read the "
                         "`aim[shipped]` line for what the map ships.")
    ap.add_argument("--arc-detail", dest="arc_detail", type=float,
                    default=ARC_DETAIL_DEFAULT,
                    help="--terrain arc only: elmos of authored fBm grain in "
                         "the 15-120 elmo band on the platform the solver "
                         "erodes, so the fine relief is finished noise rather "
                         "than solver-made channel texture (PLAN-maps M8r). "
                         "0 restores the M8q surface.")
    ap.add_argument("--hardness-detail", dest="hardness_detail", type=float,
                    default=None,
                    help="erodibility variation in the 200-800 elmo band, in "
                         "absolute K units on a coarse field spanning "
                         "0.016-0.036. ⛔ measured NEGATIVE and defaulted to "
                         "0 everywhere: it barely moves the band it was "
                         "built for and makes 120-300 worse (PLAN-maps M8s, "
                         "and `substrate_hardness` carries the numbers).")
    ap.add_argument("--arc-segmentation", dest="segmentation", type=float,
                    default=None,
                    help="--terrain arc only, 0-1: tectonic segmentation of "
                         "the arc — cross-strike breaks, an en-echelon step "
                         "per segment, and a back-arc high, scaled together. "
                         "0 restores the M8s belt, which converges to one "
                         "continuous divide corner to corner (PLAN-maps M8t, "
                         "and `arc_uplift` carries the numbers).")
    ap.add_argument("--aim-iterations", dest="aim_iterations", type=int,
                    default=None,
                    help="--terrain arc only: passes of the closed-loop "
                         "relief aim. The first-order aim reads the relief "
                         "of the drainage the PLATFORM has and the solver "
                         "then builds a different one (+28%% on the "
                         "segmented arc), so pass 2 scales the uplift by "
                         "target/stood. Default 2; 1 restores the M8t "
                         "surface. Pass 0 is cache-addressable at the "
                         "pre-M8u key, so this costs one extra pass "
                         "(~430 s at full res). See PLAN-maps M8u.")
    ap.add_argument("--connect-starts", dest="connect",
                    action=argparse.BooleanOptionalAction, default=None,
                    help="raise a submarine sill across the shallowest "
                         "strait until every start position can reach every "
                         "other for VEH and HEAVY — the reading "
                         "`regions_from_map.py --verify` takes, answered by "
                         "the generator. Default ON for --terrain arc, OFF "
                         "for mounds (turning it on there re-ships "
                         "skerry_reach). See PLAN-maps M8x.")
    ap.add_argument("--start-connectivity", dest="start_connectivity",
                    action=argparse.BooleanOptionalAction, default=None,
                    help="make the start-pad placer connectivity-aware: if "
                         "--connect-starts still leaves the map split, ban "
                         "the ground no sill reached and re-place the pads, "
                         "up to 3 passes. The placer cannot answer this at "
                         "pick time — the roads that make the map drivable "
                         "are planned FROM the pads — so each pass re-derives "
                         "roads, rivers and the carve (~30 s). Default ON for "
                         "--terrain arc, OFF for mounds. See PLAN-maps M9c.")
    ap.add_argument("--carve-raise-penalty", dest="raise_penalty", type=int,
                    default=1, metavar="K",
                    help="what a sill route pays per cell the carve would have "
                         "to raise, against 1 for a cell it can walk over — so "
                         "K>1 buys a longer route to build less causeway. "
                         "Default 1 (the shortest-hop search this generator "
                         "has always used); only meaningful with "
                         "--connect-starts. See PLAN-maps M9e.")
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
                       "--relief-target", str(args.relief_target),
                       "--arc-detail", str(args.arc_detail)]
        if args.hardness_detail is not None:
            passthrough += ["--hardness-detail", str(args.hardness_detail)]
        if args.segmentation is not None:
            passthrough += ["--arc-segmentation", str(args.segmentation)]
        if args.aim_iterations is not None:
            passthrough += ["--aim-iterations", str(args.aim_iterations)]
        if args.connect is not None:
            passthrough.append("--connect-starts" if args.connect
                               else "--no-connect-starts")
        if args.start_connectivity is not None:
            passthrough.append("--start-connectivity"
                               if args.start_connectivity
                               else "--no-start-connectivity")
        if args.raise_penalty != 1:
            passthrough += ["--carve-raise-penalty", str(args.raise_penalty)]
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
             router=args.router, relief_target=args.relief_target,
             arc_detail=args.arc_detail,
             hardness_detail=args.hardness_detail,
             segmentation=args.segmentation,
             aim_iterations=args.aim_iterations,
             connect=args.connect,
             start_connectivity=args.start_connectivity,
             raise_penalty=args.raise_penalty)


if __name__ == "__main__":
    main()
