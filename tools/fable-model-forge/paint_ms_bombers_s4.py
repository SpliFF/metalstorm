"""paint_ms_bombers_s4 — 2048^2 PBR set for ms_bombers_s4.

HERO of the bomber line.  The upper surface is one enormous planform
canvas, so everything is derived PARAMETRICALLY from the wing planform:
chord-fraction curves give leading-edge RAM chevrons, chordwise panel
runs, spanwise ribs and a sawtooth-aligned trailing-edge edge treatment
that follows the W exactly.  Section 26 splinter camo scaled up to this
canvas (angular blocks in three greys keyed to the sweep), dense access
hatch work over the centrebody, over-wing intake lip warnings, heat
gradients and soot fans aft of the shielded slot nozzles.

The undersurface carries the two bay-door assemblies — hazard striping,
red ARM outlines, hinge lines, jettison arrows — because that is the read
from a low camera.

TEAM: a local `team_zone()` holds the diffuse base near (126,130,132)
while writing the full-R team mask, and the panels stay small and close
to the centrebody.  `paintlib.team_panel`'s TEAMGREY would flood whole
planform quads through the impostor baker's centroid sampling on a model
this flat and wide.
"""
from __future__ import annotations
import numpy as np

import ms_bombers_s4_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   stencil, BOLT_LOG, GLASS, YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS, M_ARMOR, M_STEEL, M_GLASS)

W = 2048
STEM = 'ms_bombers_s4'
RNG = np.random.default_rng(4471)

# ── palette: low-vis strategic-bomber greys (one family with the fighters,
# one stop colder and flatter — this airframe lives at 180 m cruise) ──────
GUN      = (84, 88, 92)          # topside base
GUN_LT   = (106, 110, 112)       # splinter tone 2
GUN_DK   = (63, 67, 71)          # splinter tone 3
CHAR     = (45, 47, 51)          # RAM / radar-absorbent panel charcoal
BELLY    = (76, 80, 84)
BELLY_LT = (96, 100, 104)
DKST     = (38, 40, 44)          # duct shadow / structure
SOOT     = (34, 34, 36)
HEAT_A   = (124, 102, 84)
HEAT_B   = (94, 80, 82)
HEAT_C   = (70, 66, 76)
RED      = (162, 46, 36)
REDBR    = (204, 60, 42)
WHITE_MK = (194, 198, 200)
GOLD     = (120, 104, 62)        # canopy tint
FORM     = (66, 142, 96)         # formation-light strip
NAV_R    = (200, 40, 30)
NAV_G    = (50, 190, 80)
LIVE_BR  = (172, 128, 44)
# team-mask base: kept close to the diffuse base on purpose — the impostor
# baker flat-shades a whole quad from its UV centroid, and on a flying wing
# the quads are huge.  Team colour comes from the mask, not the diffuse.
TEAM_BASE = (114, 118, 120)


def team_zone(m, box, outline=GUN_DK):
    b = PL.nbox(*box)
    m.t.rectangle(b, fill=(255, 0, 0))
    m.d.rectangle(b, fill=TEAM_BASE)
    m.d.rectangle(b, outline=shade(outline, 0.55), width=3)


def rect(a, b, c, d):
    """Normalised rect — mirrored +-s loops swap corner order (preamble 6)."""
    return PL.nbox(a, b, c, d)


# ── zone coordinate helpers ─────────────────────────────────────────────
TU, TV = PL.zone_fns(L.F_TOP)       # TU(x), TV(z)   planform, nose up
BU, BV = PL.zone_fns(L.F_BOT)       # BU(x), BV(z)
SU, SV = PL.zone_fns(L.F_SIDE)      # SU(z), SV(y)

# ── planform parametrics: everything on the wing derives from these ──────
_XS = [st[0] for st in L.WING]
_ZLE = [st[1] for st in L.WING]
_ZTE = [st[2] for st in L.WING]
_TIP = _XS[-1]


def z_le(x):
    return float(np.interp(abs(x), _XS, _ZLE))


def z_te(x):
    return float(np.interp(abs(x), _XS, _ZTE))


def pz(x, f):
    """World z at span station x and chord fraction f (0 = LE, 1 = TE)."""
    a = z_le(x)
    return a + f * (z_te(x) - a)


def TP(x, f):
    return (TU(x), TV(pz(x, f)))


def BP(x, f):
    return (BU(x), BV(pz(x, f)))


def span_pts(s, f, xs=None, proj=TP):
    """Polyline at constant chord fraction across one half-span.  Sampled at
    the WING station x's so the trailing-edge sawtooth stays exact."""
    xs = xs if xs is not None else _XS
    return [proj(s * x, f) for x in xs]


def chord_band(m, s, f0, f1, x0, x1, col, proj=TP):
    """Filled band between two chord fractions over a span range — always
    inside the planform by construction."""
    xs = [x for x in _XS if x0 <= x <= x1]
    if not xs or xs[0] > x0:
        xs = [x0] + xs
    if xs[-1] < x1:
        xs = xs + [x1]
    poly = [proj(s * x, f0) for x in xs] + [proj(s * x, f1) for x in xs[::-1]]
    m.d.polygon(poly, fill=col)


# ─────────────────────────────────────────────────────────────────────────
#  UPPER SURFACE — the hero canvas
# ─────────────────────────────────────────────────────────────────────────
def paint_top(m):
    z = L.F_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=GUN, ao=AO_BASE, rough=R_ARMOR, metal=M_ARMOR)

    for s in (1, -1):
        # ── splinter camo, scaled up.  Angular blocks keyed to the 35 deg
        # sweep: each block is a chord-fraction band over a span range, so
        # its edges run parallel to the LE and never leave the planform.
        for (xa, xb, f0, f1, col) in (
                (0.30, 3.20, 0.06, 0.30, GUN_DK),
                (2.70, 6.30, 0.10, 0.26, GUN_LT),
                (5.40, 9.00, 0.05, 0.34, GUN_DK),
                (8.10, 10.85, 0.10, 0.55, GUN_LT),
                (0.90, 4.50, 0.44, 0.66, GUN_DK),
                (3.60, 7.20, 0.52, 0.78, GUN_LT),
                (6.30, 9.70, 0.46, 0.74, GUN_DK),
                (1.80, 5.40, 0.80, 0.94, GUN_LT)):
            chord_band(m, s, f0, f1, xa, xb, jit(col, 3))

        # ── radar-absorbent leading-edge chevron (charcoal, full span) ──
        chord_band(m, s, 0.0, 0.045, 0.0, _TIP, CHAR)
        m.d.line(span_pts(s, 0.048), fill=shade(CHAR, 1.5), width=3)

        # ── sawtooth trailing-edge treatment: the planform tell.  A dark
        # band inboard of the TE, following the W exactly (station-sampled).
        chord_band(m, s, 0.955, 1.0, 0.0, _TIP, CHAR)
        m.d.line(span_pts(s, 0.945), fill=shade(GUN, 0.62), width=4)
        m.d.line(span_pts(s, 1.0), fill=shade(CHAR, 0.6), width=5)
        # elevon hinge line + elevon division ticks along the sawtooth
        m.d.line(span_pts(s, 0.90), fill=shade(GUN, 0.70), width=3)
        for xx in (3.15, 4.95, 6.75, 8.55, 9.70):
            m.d.line([TP(s * xx, 0.90), TP(s * xx, 1.0)],
                     fill=shade(GUN, 0.62), width=3)

        # ── chordwise panel runs (parallel to the LE) + spanwise ribs ──
        for f in (0.13, 0.24, 0.37, 0.50, 0.63, 0.76, 0.86):
            m.d.line(span_pts(s, f), fill=shade(GUN, 0.86), width=2)
        for xx in (1.35, 2.25, 3.15, 4.05, 4.95, 5.85, 6.75, 7.65, 8.55,
                   9.35, 10.00, 10.50):
            m.d.line([TP(s * xx, 0.03), TP(s * xx, 0.93)],
                     fill=shade(GUN, 0.88), width=2)

        # ── access-hatch density over the centrebody ──
        for i, xx in enumerate(np.arange(0.35, 3.30, 0.62)):
            for f0 in (0.30, 0.44, 0.58, 0.72):
                a = TP(s * xx, f0)
                b = TP(s * (xx + 0.44), f0 + 0.09)
                m.d.rectangle(rect(a[0], a[1], b[0], b[1]),
                              fill=jit(shade(GUN, 0.96), 4),
                              outline=shade(GUN, 0.74))
            if i % 2 == 0:
                pt = TP(s * (xx + 0.06), 0.33)
                pt2 = TP(s * (xx + 0.38), 0.68)
                bolts(m, [pt, pt2], base=GUN)

        # ── over-wing intake ramp ──
        (za, xi, xo, _b, _t) = L.INTAKE_SECTIONS[0]
        (zb, xi2, xo2, _b2, _t2) = L.INTAKE_SECTIONS[-1]
        ramp = [(TU(s * xi), TV(za)), (TU(s * xo), TV(za)),
                (TU(s * xo2), TV(zb)), (TU(s * xi2), TV(zb))]
        m.d.polygon(ramp, fill=shade(GUN, 0.86), outline=shade(GUN, 0.66))
        # inlet lip: dark throat shadow + red/bone warning ring
        m.d.rectangle(rect(TU(s * xi), TV(za), TU(s * xo), TV(za + 0.34)),
                      fill=DKST)
        m.d.rectangle(rect(TU(s * xi), TV(za - 0.16), TU(s * xo), TV(za)),
                      fill=jit(RED, 10))
        m.d.rectangle(rect(TU(s * xi), TV(za - 0.28), TU(s * xo),
                           TV(za - 0.16)), fill=WHITE_MK)
        # boundary-layer diverter slot inboard of the ramp
        m.d.line([(TU(s * (xi - 0.06)), TV(za)),
                  (TU(s * (xi2 - 0.06)), TV(zb))],
                 fill=shade(DKST, 1.3), width=4)
        for wz in np.arange(za + 0.5, zb, 0.45):
            m.d.line([(TU(s * xi), TV(wz)), (TU(s * (xo - 0.25)), TV(wz))],
                     fill=shade(GUN, 0.76), width=2)
        stencil(m, (TU(s * xi) + (6 if s > 0 else -70), TV(za + 0.55)),
                'NO STEP', 18, shade(WHITE_MK, 0.62))

        # ── shielded slot nozzle shelf: heat gradient + soot fan aft ──
        for i, (nz, nxi, nxo, _yb, _yt) in enumerate(L.NOZZLE_SECTIONS):
            col = (shade(GUN, 0.84), HEAT_C, HEAT_B, HEAT_A)[i]
            nz2 = (L.NOZZLE_SECTIONS[i + 1][0] if
                   i + 1 < len(L.NOZZLE_SECTIONS) else nz + 0.30)
            m.d.polygon([(TU(s * nxi), TV(nz)), (TU(s * nxo), TV(nz)),
                         (TU(s * nxo), TV(nz2)), (TU(s * nxi), TV(nz2))],
                        fill=col)
        m.d.rectangle(rect(TU(s * 0.46), TV(4.30), TU(s * 1.42), TV(4.55)),
                      fill=SOOT)
        for _ in range(70):                    # soot fan streaming aft
            xx = RNG.uniform(0.42, 1.60)
            zz = RNG.uniform(4.30, 5.90)
            ln = RNG.uniform(0.15, 0.70)
            if zz > z_te(xx) - 0.12:
                continue
            m.d.line([(TU(s * xx), TV(zz)), (TU(s * xx), TV(zz + ln))],
                     fill=shade(SOOT, RNG.uniform(1.2, 2.6)),
                     width=int(RNG.integers(2, 6)))
        for wz in np.arange(2.60, 4.30, 0.30):  # shelf louvre seams
            m.d.line([(TU(s * 0.42), TV(wz)), (TU(s * 1.50), TV(wz))],
                     fill=shade(GUN_DK, 0.75), width=2)

        # ── TEAM: modest panels near the centrebody only ──
        a, b = TP(s * 1.45, 0.36), TP(s * 2.35, 0.48)
        team_zone(m, rect(a[0], a[1], b[0], b[1]))
        a, b = TP(s * 3.70, 0.34), TP(s * 4.45, 0.46)
        team_zone(m, rect(a[0], a[1], b[0], b[1]))

        # ── national roundel + spanwise wing code ──
        cx, cy = TP(s * 5.60, 0.40)
        m.d.ellipse([cx - 40, cy - 40, cx + 40, cy + 40],
                    fill=shade(GUN, 0.74), outline=shade(WHITE_MK, 0.8),
                    width=3)
        PL.roundel_star(m, cx, cy, 26, WHITE_MK, ring=False)
        tx, ty = TP(s * 7.40, 0.30)
        stencil(m, (tx - 46, ty), 'MSB-22', 30, shade(WHITE_MK, 0.66))
        tx, ty = TP(s * 9.10, 0.36)
        stencil(m, (tx - 34, ty), 'SB-04', 24, shade(WHITE_MK, 0.55))

        # ── wingtip formation-light strip (emissive) ──
        a, b = TP(s * 9.80, 0.18), TP(s * 10.60, 0.30)
        st = rect(a[0], a[1], b[0], b[1])
        m.d.rectangle(st, fill=(36, 52, 44))
        m.e.rectangle([st[0] + 2, st[1] + 2, st[2] - 2, st[3] - 2], fill=FORM)

    # ── centreline spine: anti-glare, turret seat, antenna bases ──
    m.d.polygon([(TU(-0.30), TV(-6.10)), (TU(0.30), TV(-6.10)),
                 (TU(0.92), TV(-4.10)), (TU(-0.92), TV(-4.10))],
                fill=(30, 32, 34))                       # anti-glare panel
    # dorsal flak barbette seat: painted ring the turret piece sits in
    rr = abs(TU(1.12) - TU(0.0))
    rz = abs(TV(-2.30 + 1.12) - TV(-2.30))
    cx, cy = TU(0.0), TV(-2.30)
    m.d.ellipse([cx - rr, cy - rz, cx + rr, cy + rz],
                fill=shade(GUN, 0.80), outline=shade(GUN, 0.58), width=4)
    for a_ in np.linspace(0, 2 * np.pi, 28, endpoint=False):
        m.d.line([(cx + rr * 0.88 * np.cos(a_), cy + rz * 0.88 * np.sin(a_)),
                  (cx + rr * np.cos(a_), cy + rz * np.sin(a_))],
                 fill=shade(GUN, 0.62), width=3)
    PL.hazard_band(m, rect(TU(-1.05), TV(-3.62), TU(1.05), TV(-3.42)),
                   step=15)
    stencil(m, (TU(-0.95), TV(-1.05)), 'DANGER TRAVERSE', 18, REDBR)
    # centreline keel strip between the two nozzle shelves
    m.d.rectangle(rect(TU(-0.36), TV(2.30), TU(0.36), TV(5.40)),
                  fill=shade(GUN, 0.88))
    for wz in np.arange(2.5, 5.4, 0.42):
        m.d.line([(TU(-0.36), TV(wz)), (TU(0.36), TV(wz))],
                 fill=shade(GUN, 0.70), width=2)
    # canopy sill shadow
    m.d.rectangle(rect(TU(-1.00), TV(-6.00), TU(1.00), TV(-3.78)),
                  fill=shade(GUN, 0.82))
    stencil(m, (TU(-0.55), TV(4.62)), 'SB-04', 26, shade(WHITE_MK, 0.6))
    wear_edges(m, z.rect, GUN, 90)


# ─────────────────────────────────────────────────────────────────────────
#  UNDER SURFACE — two bay-door assemblies carry the read
# ─────────────────────────────────────────────────────────────────────────
def _bay_doors(m, c, sz, label, code):
    """Painted double doors with hazard striping and a red ARM outline."""
    (cx, _cy, cz), (sx, _sy, sd) = c, sz
    z0, z1 = cz - sd / 2, cz + sd / 2
    x0_, x1_ = cx - sx / 2, cx + sx / 2
    box = rect(BU(x0_), BV(z0), BU(x1_), BV(z1))
    m.d.rectangle(box, fill=shade(BELLY, 0.84), outline=shade(BELLY, 0.60),
                  width=4)
    # the door split down the centreline + hinge lines outboard
    m.d.line([(BU(0), BV(z0)), (BU(0), BV(z1))], fill=shade(BELLY, 0.50),
             width=5)
    for xx in (x0_, x1_):
        m.d.line([(BU(xx), BV(z0)), (BU(xx), BV(z1))],
                 fill=shade(BELLY, 0.58), width=4)
    for wz in np.arange(z0 + 0.30, z1, 0.42):     # door stiffener ribs
        m.d.line([(BU(x0_), BV(wz)), (BU(x1_), BV(wz))],
                 fill=shade(BELLY, 0.74), width=2)
    # hazard striping along both door edges
    PL.hazard_band(m, rect(BU(x0_), BV(z0), BU(x1_), BV(z0 + 0.16)), step=17)
    PL.hazard_band(m, rect(BU(x0_), BV(z1 - 0.16), BU(x1_), BV(z1)), step=17)
    # red ARM outline + release stencils
    m.d.rectangle(rect(BU(x0_ + 0.16), BV(z0 + 0.30), BU(x1_ - 0.16),
                       BV(z1 - 0.30)), outline=REDBR, width=4)
    stencil(m, (BU(x0_ + 0.26), BV(z0 + 0.40)), 'ARM', 26, REDBR)
    stencil(m, (BU(x0_ + 0.26), BV(cz - 0.34)), label, 20, REDBR)
    stencil(m, (BU(x0_ + 0.26), BV(cz + 0.46)), code, 18,
            shade(WHITE_MK, 0.72))
    # jettison arrows pointing aft
    for xx in (x0_ + 0.45, x1_ - 0.45):
        ax_, ay_ = BU(xx), BV(z1 - 0.46)
        m.d.polygon([(ax_ - 12, ay_ - 16), (ax_ + 12, ay_ - 16),
                     (ax_, ay_ + 12)], fill=shade(WHITE_MK, 0.7))
    bolts(m, [(BU(x0_ + 0.10), BV(z0 + 0.22)), (BU(x1_ - 0.10), BV(z0 + 0.22)),
              (BU(x0_ + 0.10), BV(z1 - 0.22)), (BU(x1_ - 0.10), BV(z1 - 0.22))],
          base=BELLY)


def paint_bot(m):
    z = L.F_BOT
    fill(m, z.rect, dif=BELLY, ao=AO_BASE - 8, rough=R_ARMOR + 6,
         metal=M_ARMOR)

    for s in (1, -1):
        chord_band(m, s, 0.0, 0.05, 0.0, _TIP, CHAR, proj=BP)   # LE RAM
        chord_band(m, s, 0.94, 1.0, 0.0, _TIP, CHAR, proj=BP)   # TE
        chord_band(m, s, 0.16, 0.32, 3.60, 8.10, shade(BELLY, 0.90), proj=BP)
        chord_band(m, s, 0.58, 0.74, 5.40, 9.70, shade(BELLY, 1.08), proj=BP)
        for f in (0.20, 0.40, 0.60, 0.80):
            m.d.line(span_pts(s, f, proj=BP), fill=shade(BELLY, 0.80), width=2)
        for xx in (1.80, 3.60, 5.40, 7.20, 9.00, 10.30):
            m.d.line([BP(s * xx, 0.04), BP(s * xx, 0.92)],
                     fill=shade(BELLY, 0.82), width=2)
        # main gear bay + door plate
        (gx, gy, gz), _d, _r, _h = L.GEAR_M
        m.d.rectangle(rect(BU(s * (gx - 0.62)), BV(gz - 1.30),
                           BU(s * (gx + 0.62)), BV(gz + 1.30)),
                      fill=shade(BELLY, 0.70), outline=shade(BELLY, 0.52),
                      width=4)
        for i in range(22):                      # hydraulic staining
            zz = RNG.uniform(gz - 1.2, gz + 1.2)
            m.d.line([(BU(s * gx), BV(zz)), (BU(s * gx) + 22, BV(zz))],
                     fill=shade((42, 36, 30), RNG.uniform(0.8, 1.6)), width=3)
        # belly dispenser + wingtip nav underside
        cx_, _cy, cz_ = L.CHAFF
        m.d.rectangle(rect(BU(s * (cx_ - 0.36)), BV(cz_ - 0.31),
                           BU(s * (cx_ + 0.36)), BV(cz_ + 0.31)),
                      fill=DKST, outline=shade(BELLY, 0.6), width=2)
        tx, ty = BP(s * 7.60, 0.42)
        stencil(m, (tx - 60, ty), 'MSB-22', 32, shade(BELLY_LT, 1.12))
        cx2, cy2 = BP(s * 5.20, 0.45)
        PL.roundel_star(m, cx2, cy2, 30, shade(BELLY_LT, 1.1))

    _bay_doors(m, *L.BAY_FWD, 'CRUISE  X4', 'BAY 1 FWD')
    _bay_doors(m, *L.BAY_AFT, 'HE BOMB  X12', 'BAY 2 AFT')

    # nose gear bay + chin sensor blister ring
    (nx, ny, nz) = L.GEAR_N[0]
    m.d.rectangle(rect(BU(-0.55), BV(nz - 0.75), BU(0.55), BV(nz + 0.75)),
                  fill=shade(BELLY, 0.70), outline=shade(BELLY, 0.52), width=4)
    sx, _sy, sz = L.SENSOR
    m.d.ellipse([BU(sx) - 30, BV(sz) - 26, BU(sx) + 30, BV(sz) + 26],
                fill=DKST, outline=shade(BELLY, 0.6), width=3)
    for s in (1, -1):
        tx, ty = BP(s * 6.10, 0.52)
        stencil(m, (tx - 44, ty), 'RESCUE', 22, REDBR)
    wear_edges(m, z.rect, BELLY, 60)


# ─────────────────────────────────────────────────────────────────────────
#  EDGE BAND, CANOPY, FLAT CELLS
# ─────────────────────────────────────────────────────────────────────────
def paint_side(m):
    z = L.F_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=GUN_DK, ao=AO_BASE, rough=R_ARMOR, metal=M_ARMOR)
    # trailing-edge blunt band (charcoal RAM) + wingtip caps
    m.d.rectangle(rect(SU(1.80), y0, SU(6.60), y1), fill=CHAR)
    for wz in np.arange(2.0, 6.4, 0.55):
        seam_v(m, int(SU(wz)), y0 + 2, y1 - 2, CHAR, hi=False)
    # nozzle shelf side walls (they sample this band): heat wash aft
    for (za, col) in ((2.60, shade(GUN_DK, 1.05)), (3.40, HEAT_C),
                      (4.05, HEAT_B)):
        m.d.rectangle(rect(SU(za), SV(2.45), SU(4.40), SV(1.55)), fill=col)
    m.d.rectangle(rect(SU(4.20), SV(2.10), SU(4.42), SV(1.55)), fill=SOOT)
    # intake ramp side walls
    m.d.rectangle(rect(SU(-1.45), SV(2.58), SU(2.35), SV(1.80)),
                  fill=shade(GUN, 0.92))
    for wz in np.arange(-1.2, 2.3, 0.42):
        m.d.line([(SU(wz), SV(2.56)), (SU(wz), SV(1.86))],
                 fill=shade(GUN, 0.74), width=2)
    m.d.rectangle(rect(SU(-1.45), SV(2.58), SU(-1.28), SV(1.90)), fill=RED)
    stencil(m, (SU(-1.0), SV(1.78)), 'INTAKE  DANGER', 18, REDBR)
    wear_edges(m, z.rect, GUN_DK, 45)


def paint_canopy(m):
    z = L.F_CANOPY
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, z.rect, dif=GOLD, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    # a LOW 3-bow side-by-side canopy: nose bow, two frame bows, sill
    m.d.rectangle(rect(x0, y0, u(-5.72), y1), fill=GUN_DK)
    m.d.rectangle(rect(u(-4.05), y0, x1, y1), fill=GUN_DK)
    for zb in (-5.18, -4.58):
        m.d.rectangle(rect(u(zb - 0.06), y0, u(zb + 0.06), y1), fill=GUN_DK)
    m.d.rectangle(rect(x0, v(1.92), x1, y1), fill=GUN_DK)          # sill
    for (za, zb) in ((-5.70, -5.24), (-5.12, -4.64), (-4.52, -4.07)):
        g = rect(u(za), v(2.38), u(zb), v(1.96))
        m.d.rectangle(g, fill=GLASS)
        m.o.rectangle(g, fill=(AO_BASE, R_GLASS, M_GLASS))
        m.d.polygon([(u(za) + 9, v(2.34)), (u(zb) - 8, v(2.22)),
                     (u(zb) - 8, v(2.12)), (u(za) + 9, v(2.24))],
                    fill=shade(GOLD, 1.35))
    # side-by-side crew: two instrument glows abreast under the centre bows
    for zc in (-5.16, -4.60):
        m.e.rectangle(rect(u(zc) - 20, v(2.02), u(zc) + 20, v(1.95)),
                      fill=(92, 68, 24))
    stencil(m, (u(-5.66), v(1.88)), 'RESCUE', 16, REDBR)
    wear_edges(m, z.rect, GUN_DK, 26)


def paint_cells(m):
    # intake duct throat
    r = L.F_INTK.rect
    fill(m, r, dif=DKST, ao=AO_DEEP, rough=R_ARMOR, metal=M_ARMOR)
    m.d.rectangle([r[0], r[1], r[2], r[1] + 12], fill=RED)
    m.d.rectangle([r[0], r[1] + 12, r[2], r[1] + 22], fill=WHITE_MK)
    for i in range(6):                                # compressor face hint
        yy = r[1] + 30 + i * 14
        m.d.line([(r[0], yy), (r[2], yy)], fill=shade(DKST, 1.5), width=3)

    # shielded slot nozzle exit: dark slot with a banked heat glow
    r = L.F_SLOT.rect
    fill(m, r, dif=(24, 24, 26), ao=AO_DEEP, rough=R_STEEL, metal=M_STEEL)
    for i, c in enumerate(((58, 30, 18), (96, 44, 20), (140, 70, 26))):
        pad = 8 + i * 14
        m.d.rectangle([r[0] + pad, r[1] + pad, r[2] - pad, r[3] - pad], fill=c)
    m.e.rectangle([r[0] + 34, r[1] + 34, r[2] - 34, r[3] - 34],
                  fill=(150, 62, 22))

    fill(m, L.F_GEAR.rect, dif=(124, 128, 130), ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL + 40)
    r = L.F_GEAR.rect
    m.d.rectangle([r[0], r[1] + (r[3] - r[1]) * 0.36, r[2],
                   r[1] + (r[3] - r[1]) * 0.60], fill=(160, 164, 166))

    fill(m, L.F_TRIM.rect, dif=GUN_DK, ao=AO_SEAM, rough=R_ARMOR,
         metal=M_ARMOR + 30)
    fill(m, L.F_DARK.rect, dif=(20, 20, 22), ao=AO_DEEP, rough=R_STEEL,
         metal=M_STEEL)
    fill(m, L.F_RAM.rect, dif=CHAR, ao=AO_SEAM, rough=R_ARMOR + 20,
         metal=M_ARMOR)

    # bay side walls: structure grey with a lit interior hint
    r = L.F_BAYSD.rect
    fill(m, r, dif=shade(BELLY, 0.72), ao=AO_SEAM, rough=R_ARMOR,
         metal=M_ARMOR)
    for i in range(7):
        xx = r[0] + (r[2] - r[0]) * (i + 0.5) / 7.0
        m.d.line([(xx, r[1]), (xx, r[3])], fill=shade(BELLY, 0.54), width=3)
    PL.hazard_band(m, [r[0], r[3] - 12, r[2], r[3]], step=13)

    for (zr, col) in ((L.F_NAVP, NAV_R), (L.F_NAVS, NAV_G)):
        r = zr.rect
        fill(m, r, dif=shade(col, 0.32), ao=AO_BASE, rough=R_GLASS,
             metal=M_GLASS)
        m.e.rectangle([r[0] + 18, r[1] + 16, r[2] - 18, r[3] - 16], fill=col)


# ─────────────────────────────────────────────────────────────────────────
#  DORSAL FLAK MOUNT (piece-local zones — it slews)
# ─────────────────────────────────────────────────────────────────────────
def paint_mount(m):
    zt, zs = L.T_TOP, L.T_SIDE
    ut, vt = PL.zone_fns(zt)      # ut(x), vt(z)
    us, vs = PL.zone_fns(zs)      # us(z), vs(y)
    fill(m, zt.rect, dif=GUN_LT, ao=AO_BASE, rough=R_ARMOR, metal=M_ARMOR)
    fill(m, zs.rect, dif=GUN, ao=AO_BASE, rough=R_ARMOR, metal=M_ARMOR)

    # barbette crown: turntable teeth + a hazard traverse band
    cx, cy = ut(0.0), vt(0.0)
    rr = abs(ut(1.00) - cx)
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                outline=shade(GUN_LT, 0.66), width=5)
    for a_ in np.linspace(0, 2 * np.pi, 30, endpoint=False):
        m.d.line([(cx + rr * 0.87 * np.cos(a_), cy + rr * 0.87 * np.sin(a_)),
                  (cx + rr * np.cos(a_), cy + rr * np.sin(a_))],
                 fill=shade(GUN_LT, 0.58), width=3)
    team_zone(m, rect(ut(-0.34), vt(-0.30), ut(0.34), vt(0.42)))
    stencil(m, (ut(-0.62), vt(-0.66)), 'FLAK', 20, shade(WHITE_MK, 0.7))

    # gun-body flanks: elevation quadrant, ammo feed hatches, live-round band
    m.d.rectangle(rect(us(-0.95), vs(0.20), us(0.36), vs(-0.20)),
                  fill=shade(GUN, 0.88), outline=shade(GUN, 0.68), width=2)
    for wz in np.arange(-0.90, 0.34, 0.22):
        m.d.line([(us(wz), vs(0.18)), (us(wz), vs(-0.18))],
                 fill=shade(GUN, 0.78), width=2)
    m.d.rectangle(rect(us(0.00), vs(0.34), us(0.34), vs(0.08)), fill=LIVE_BR)
    PL.hazard_band(m, rect(us(-0.20), vs(-0.24), us(0.30), vs(-0.36)), step=10)
    stencil(m, (us(-0.90), vs(-0.26)), 'AA-S1', 18, REDBR)
    bolts(m, [(us(-0.80), vs(0.24)), (us(-0.42), vs(0.24)),
              (us(-0.05), vs(0.24))], base=GUN)

    # flak barrel wrap: heat-stained steel with cooling-jacket rings
    x0, y0, x1, y1 = L.T_BARREL
    fill(m, L.T_BARREL, dif=(64, 66, 70), ao=AO_SEAM, rough=R_STEEL,
         metal=M_STEEL + 30)
    for i in range(14):
        xx = x0 + (x1 - x0) * i / 14.0
        m.d.rectangle([xx, y0, xx + 5, y1], fill=shade((64, 66, 70), 0.62))
    for i, c in enumerate((SOOT, (72, 52, 42), (96, 78, 62))):
        m.d.rectangle([x0 + (x1 - x0) * (0.80 + i * 0.07), y0,
                       x0 + (x1 - x0) * (0.87 + i * 0.07), y1], fill=c)
    fill(m, L.T_DARK.rect, dif=(18, 18, 20), ao=AO_DEEP, rough=R_STEEL,
         metal=M_STEEL)
    fill(m, L.T_TRIM.rect, dif=GUN_DK, ao=AO_SEAM, rough=R_ARMOR,
         metal=M_ARMOR + 30)


# ─────────────────────────────────────────────────────────────────────────
def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_top(m)
    paint_bot(m)
    paint_side(m)
    paint_canopy(m)
    paint_cells(m)
    paint_mount(m)

    ground = [L.F_GEAR.rect,
              rect(BU(-1.30), BV(-4.20), BU(1.30), BV(3.30))]
    wx = PL.standard_weather(m, L, ground_rects=ground,
                             side_zones=(), seed=71, mud=0.22, grime=0.50,
                             rust_fraction=0.30)
    # airframe: thin grime, no mud — it lives at 180 m
    wx.mud_band(L.F_TOP.rect, 0.12, fade=None, spatter=False)
    wx.mud_band(L.F_BOT.rect, 0.24, fade=None, spatter=False)
    wx.mud_band(L.F_SIDE.rect, 0.18, fade='down', dust=0.28, spatter=False)
    # soot: aft of both slot nozzles, on the slot cell, around the flak gun
    for s in (1, -1):
        a = rect(TU(s * 0.38), TV(3.60), TU(s * 1.70), TV(5.90))
        wx.soot_patch(tuple(int(v) for v in a), 0.72)
    wx.soot_patch(tuple(int(v) for v in L.F_SLOT.rect), 0.85)
    wx.soot_patch(tuple(int(v) for v in L.T_BARREL), 0.60)
    us, vs = PL.zone_fns(L.T_SIDE)
    wx.oily(L.F_GEAR.rect, 0.4)

    from normals import HeightMap
    hm = HeightMap()
    for s in (1, -1):                                  # LE + TE RAM edges
        pts = span_pts(s, 0.045)
        for i in range(len(pts) - 1):
            hm.line(pts[i], pts[i + 1], -0.5, width=3)
        pts = span_pts(s, 0.955)
        for i in range(len(pts) - 1):
            hm.line(pts[i], pts[i + 1], -0.6, width=4)
        for wz in np.arange(2.60, 4.30, 0.30):         # nozzle shelf louvres
            hm.line((TU(s * 0.42), TV(wz)), (TU(s * 1.50), TV(wz)),
                    -0.55, width=3)
    hm.rect(rect(TU(-1.00), TV(-6.00), TU(1.00), TV(-3.78)), 0.40)
    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
