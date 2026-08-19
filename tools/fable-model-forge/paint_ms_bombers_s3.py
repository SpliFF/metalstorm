"""paint_ms_bombers_s3 — 2048² PBR set for the s3 Medium Level Bomber.

§26 strike-line identity: angular SPLINTER CAMO in a second grey across the
topsides with wedges reaching down the shared flank band, a long ventral
weapons bay painted as two doors with hinge seams, hazard striping and a red
ARM outline, warning rings at both podded nacelle intakes with heat-tinted
nozzles, spanwise wing codes (PIL rotate(-90) reads correctly nose-up),
roundels, a chine cheatline and a tall fin band carrying team colour.

Team colour lives ONLY in the team-mask R channel. Team panels use a local
team_zone() holding the diffuse near the gunmetal base — the impostor baker
flat-shades a quad from its UV centroid and this airframe has very large flat
wing panels, so a TEAMGREY fill would flood them pale.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw

import ms_bombers_s3_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, stencil,
                   jit, shade, BOLT_LOG, GLASS, YELLOW, BLACKISH,
                   STEEL, STEEL_DK, TRACK_MET,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 2048

AIR = (100, 105, 111)            # bomber topside grey
SPL = (78, 84, 78)               # splinter second tone (green-grey)
SPL2 = (86, 90, 96)              # third, lighter splinter facet
UNDER = (120, 126, 130)          # pale underside
DKPANEL = (58, 63, 68)
RADOME = (60, 62, 66)
WARN_RED = (152, 48, 36)
BONE = (178, 180, 170)
AMBER = (255, 176, 60)
GREENLT = (70, 220, 110)
REDLT = (235, 70, 55)
REDL = (196, 60, 46)
# team-mask base: held near the diffuse base on purpose (preamble note 4)
TEAM_BASE = (126, 130, 132)

STATIONS = [z for (z, *_) in L.FUS_SECTIONS[2:-2]]

SU, SV = PL.zone_fns(L.B_SIDE)      # SU(z), SV(y)
TU, TV = PL.zone_fns(L.B_TOP)       # TU(z), TV(x)
BU, BV = PL.zone_fns(L.B_BOT)       # BU(z), BV(x)


def rect(a, b, c, d):
    return PL.nbox(a, b, c, d)


def team_zone(m, box, outline=AIR):
    """Team respray that holds the diffuse near the base grey."""
    b = PL.nbox(*box)
    m.t.rectangle(b, fill=(255, 0, 0))
    m.d.rectangle(b, fill=TEAM_BASE)
    m.d.rectangle(b, outline=shade(outline, 0.55), width=2)


def text_stamp(m, xy, s, size, color, angle=0):
    """Rotated text stamped into the diffuse (PIL rotate(angle, expand))."""
    f = PL.font(size)
    tmp = Image.new('L', (int(size * 0.85 * len(s)) + 8, int(size * 1.5)), 0)
    ImageDraw.Draw(tmp).text((3, 2), s, font=f, fill=255)
    bb = tmp.getbbox()
    if bb:
        tmp = tmp.crop(bb)
    if angle:
        tmp = tmp.rotate(angle, expand=True)
    m.dif.paste(Image.new('RGB', tmp.size, color), (int(xy[0]), int(xy[1])),
                tmp)


def hazard(m, box, step=18, col=YELLOW):
    """Alternating hazard wedges (bay-door edges)."""
    x0, y0, x1, y1 = PL.nbox(*box)
    n = max(1, int((x1 - x0) / step))
    for i in range(n + 1):
        m.d.rectangle([x0 + i * step, y0, min(x0 + (i + 1) * step, x1), y1],
                      fill=jit(col, 10) if i % 2 == 0 else BLACKISH)


# ── zone painters ──────────────────────────────────────────────────────
def paint_side(m):
    x0, y0, x1, y1 = L.B_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=AIR, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)

    # pale underside below a jagged chine break (splinter grammar, not a
    # soft demarcation — angular knots)
    knots = [(-9.0, 2.30), (-7.2, 2.06), (-5.6, 2.26), (-3.8, 2.00),
             (-2.0, 2.22), (-0.2, 1.98), (1.8, 2.20), (3.6, 2.02),
             (5.4, 2.24), (8.2, 2.10)]
    poly = [(SU(kz), SV(ky)) for (kz, ky) in knots]
    poly += [(x1, y1), (x0, y1)]
    m.d.polygon(poly, fill=UNDER)

    # splinter wedges reaching DOWN the flank from the topside
    for (za, zb, low, col) in ((-7.6, -5.4, 2.10, SPL), (-4.8, -2.4, 1.85, SPL2),
                               (-1.6, 1.0, 2.05, SPL), (1.6, 3.8, 1.80, SPL2),
                               (4.4, 6.8, 2.14, SPL)):
        zm = (za + zb) / 2
        m.d.polygon([(SU(za), SV(3.30)), (SU(zm - 0.35), SV(low)),
                     (SU(zm + 0.35), SV(low + 0.22)), (SU(zb), SV(3.30))],
                    fill=jit(col, 3))

    # radome / glazed-nose tone break (mirrored into TOP + BOT — note 7)
    m.d.rectangle(rect(x0, SV(3.10), SU(-7.55), SV(1.30)), fill=RADOME)

    # fuselage frame stations + a long chord-wise stringer
    for wz in STATIONS:
        seam_v(m, int(SU(wz)), int(SV(3.10)), int(SV(1.30)), AIR, hi=False)
    seam_h(m, int(SU(-7.4)), int(SU(7.6)), int(SV(2.62)), AIR, hi=False)

    # team cheatline along the chine (thin — reads without flooding)
    team_zone(m, rect(SU(-7.2), SV(2.42), SU(7.4), SV(2.30)))

    # weapons-bay door line: the class signature in side view
    m.d.rectangle(rect(SU(-2.60), SV(1.51), SU(3.00), SV(1.18)),
                  fill=shade(UNDER, 0.88), outline=jit(REDL, 14), width=3)
    hazard(m, rect(SU(-2.60), SV(1.545), SU(3.00), SV(1.495)), step=22)
    for wz in (-1.20, 0.20, 1.60):
        m.d.line([(SU(wz), SV(1.50)), (SU(wz), SV(1.20))],
                 fill=shade(UNDER, 0.66), width=2)

    # canopy sill + glazed nose framing
    m.d.rectangle(rect(SU(-7.45), SV(2.86), SU(-5.25), SV(2.62)),
                  fill=(38, 40, 43))
    # ventral MG blister shadow, aft of the bay
    m.d.rectangle(rect(SU(3.32), SV(1.62), SU(4.30), SV(1.16)), fill=DKPANEL)
    m.d.rectangle(rect(SU(4.16), SV(1.32), SU(4.66), SV(1.16)), fill=BLACKISH)

    # formation-light strips
    for (za, zb) in ((-6.8, -5.8), (5.4, 6.6)):
        st = rect(SU(za), SV(2.02), SU(zb), SV(1.92))
        m.d.rectangle(st, fill=(44, 50, 42))
        m.e.rectangle(st, fill=AMBER)

    # access panels
    for (wz, ya, yb) in ((-4.6, 2.90, 2.66), (0.6, 2.94, 2.70),
                         (5.0, 2.80, 2.58)):
        m.d.rectangle(rect(SU(wz), SV(ya), SU(wz + 0.9), SV(yb)),
                      fill=jit(shade(AIR, 0.95), 3), outline=shade(AIR, 0.78))

    stencil(m, (SU(4.9), SV(2.98)), 'FB 13', 34, shade(AIR, 0.58))
    bolts(m, [(SU(-6.4 + i * 1.8), SV(2.98)) for i in range(8)], base=AIR)
    wear_edges(m, (x0, y0, x1, int(SV(1.1))), AIR, 55)


def paint_top(m):
    x0, y0, x1, y1 = L.B_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(AIR, 1.03), ao=AO_BASE,
         rough=R_ARMOR, metal=M_ARMOR)

    # ── splinter camo: angular polygons, mirror-safe (B_TOP is single-sampled)
    for (pts, col) in (
        ((( -7.6, -1.2), (-5.4, -3.4), (-3.2, -1.0), (-5.0, 1.4)), SPL),
        ((( -4.2, 1.4), (-1.6, -0.6), (1.0, 2.6), (-1.8, 4.0)), SPL2),
        ((( -2.8, -2.2), (0.4, -5.4), (2.6, -2.4), (0.0, -0.8)), SPL),
        (((-1.0, 4.6), (1.6, 3.0), (3.0, 6.6), (0.6, 7.6)), SPL),
        (((-0.6, -5.8), (1.4, -7.8), (1.9, -5.6), (1.0, -4.2)), SPL2),
        (((2.4, -1.4), (5.0, -2.6), (6.6, -0.4), (4.0, 1.0)), SPL),
        (((3.2, 1.6), (5.4, 0.6), (7.4, 2.4), (5.0, 3.2)), SPL2),
        (((-6.2, 2.0), (-4.4, 1.0), (-3.0, 3.4), (-5.2, 4.2)), SPL2),
    ):
        m.d.polygon([(TU(a), TV(b)) for (a, b) in pts], fill=jit(col, 3))

    # radome + anti-glare panel forward of the canopy
    m.d.polygon([(TU(-8.6), TV(-0.20)), (TU(-7.55), TV(-1.05)),
                 (TU(-7.55), TV(1.05)), (TU(-8.6), TV(0.20))], fill=RADOME)
    m.d.polygon([(TU(-8.1), TV(-0.35)), (TU(-7.0), TV(-0.62)),
                 (TU(-7.0), TV(0.62)), (TU(-8.1), TV(0.35))], fill=(34, 36, 39))

    # frame stations across the deck
    for wz in STATIONS:
        seam_v(m, int(TU(wz)), int(TV(-1.20)), int(TV(1.20)), AIR, hi=False)

    # dorsal spine band + its frames
    m.d.rectangle(rect(TU(-5.0), TV(-0.40), TU(6.4), TV(0.40)), fill=DKPANEL)
    for wz in (-3.4, -1.6, 0.4, 2.4, 4.4):
        m.d.line([(TU(wz), TV(-0.40)), (TU(wz), TV(0.40))],
                 fill=shade(DKPANEL, 0.62), width=2)

    for s in (1, -1):
        # wing leading-edge de-ice strip (LE sweeps aft with span)
        m.d.line([(TU(-3.20), TV(s * 0.80)), (TU(0.40), TV(s * 8.00))],
                 fill=(150, 154, 158), width=3)
        # unswept trailing edge + flap/aileron hinge line
        m.d.line([(TU(1.70), TV(s * 0.85)), (TU(1.70), TV(s * 7.95))],
                 fill=shade(AIR, 0.68), width=3)
        m.d.line([(TU(1.05), TV(s * 0.90)), (TU(1.05), TV(s * 7.90))],
                 fill=shade(AIR, 0.74), width=2)
        # wing-root walkway (NO STEP outboard of it)
        wv0, wv1 = sorted((TV(s * 0.85), TV(s * 1.90)))
        m.d.rectangle([TU(-2.60), wv0, TU(1.50), wv1],
                      fill=shade(AIR, 0.93))
        text_stamp(m, (TU(-1.6), (wv0 + wv1) / 2 - 9), 'NO STEP', 20,
                   shade(AIR, 0.62))

        # SMALL team panel on the wing shoulder (note 4 — big quads flood)
        tv0, tv1 = sorted((TV(s * 2.35), TV(s * 3.35)))
        team_zone(m, [TU(-1.90), tv0, TU(-0.70), tv1])

        # nacelle pylon fairing shadow on the wing underside line
        pv0, pv1 = sorted((TV(s * L.NAC_X - 0.18), TV(s * L.NAC_X + 0.18)))
        m.d.rectangle([TU(-1.10), pv0, TU(1.90), pv1], fill=shade(AIR, 0.86))

        # roundel outboard of the pylon (ellipse — B_TOP is 119x53 px/m)
        rcx, rcy = TU(0.30), TV(s * 6.40)
        rx, ry = 80, 60
        m.d.ellipse([rcx - rx, rcy - ry, rcx + rx, rcy + ry], fill=(198, 202, 206))
        m.t.ellipse([rcx - rx * 0.58, rcy - ry * 0.58, rcx + rx * 0.58,
                     rcy + ry * 0.58], fill=(255, 0, 0))
        m.d.ellipse([rcx - rx * 0.58, rcy - ry * 0.58, rcx + rx * 0.58,
                     rcy + ry * 0.58], fill=TEAM_BASE)

        # spanwise squadron code — rotate(-90) reads nose-up; kept aft of the
        # pylon band and inboard of the roundel so nothing collides
        code = 'MB-3' if s > 0 else '218'
        cv0 = min(TV(s * 4.20), TV(s * 5.70))
        text_stamp(m, (TU(1.05) - 15, cv0), code, 24, shade(AIR, 0.52),
                   angle=-90)

        # wingtip band (thin, team) — sorted() corners for the ±s mirror
        bv0, bv1 = sorted((TV(s * 7.62), TV(s * 7.98)))
        team_zone(m, [TU(0.35), bv0, TU(1.65), bv1])

        # tailplane leading edge + elevator hinge
        m.d.line([(TU(5.60), TV(s * 0.45)), (TU(6.15), TV(s * 3.20))],
                 fill=(150, 154, 158), width=3)
        m.d.line([(TU(6.95), TV(s * 0.50)), (TU(6.95), TV(s * 3.15))],
                 fill=shade(AIR, 0.68), width=2)

    # canopy sill shadow on the forward deck
    m.d.rectangle(rect(TU(-7.5), TV(-1.02), TU(-5.2), TV(1.02)),
                  fill=shade(AIR, 0.80))
    bolts(m, [(TU(-4.6 + i * 2.0), TV(0.68)) for i in range(7)], base=AIR)
    wear_edges(m, (x0, y0, x1, y1), AIR, 60)


def paint_bot(m):
    x0, y0, x1, y1 = L.B_BOT.rect
    fill(m, (x0, y0, x1, y1), dif=UNDER, ao=AO_BASE - 10, rough=R_ARMOR + 8,
         metal=M_ARMOR - 15)

    # radome break carried onto the belly (note 7)
    m.d.polygon([(BU(-8.6), BV(-0.20)), (BU(-7.55), BV(-0.95)),
                 (BU(-7.55), BV(0.95)), (BU(-8.6), BV(0.20))],
                fill=shade(RADOME, 1.05))
    # glazed bomb-aimer panel outline
    m.d.rectangle(rect(BU(-7.75), BV(-0.45), BU(-6.45), BV(0.45)),
                  fill=(46, 56, 62), outline=DKPANEL, width=3)

    for wz in STATIONS:
        seam_v(m, int(BU(wz)), int(BV(-1.35)), int(BV(1.35)), UNDER, hi=False)

    # ── the long weapons bay: two doors, hinge seams, ARM outline, hazard
    bx, by, bz, bw, bh, bd = L.BAY
    z0, z1 = bz - bd / 2, bz + bd / 2
    m.d.rectangle(rect(BU(z0), BV(-bw / 2), BU(z1), BV(bw / 2)),
                  fill=shade(UNDER, 0.90), outline=jit(REDL, 14), width=4)
    m.d.line([(BU(z0) + 4, BV(0)), (BU(z1) - 4, BV(0))],
             fill=shade(UNDER, 0.64), width=3)
    for wz in (z0 + 1.4, bz, z1 - 1.4):
        m.d.line([(BU(wz), BV(-bw / 2) + 4), (BU(wz), BV(bw / 2) - 4)],
                 fill=shade(UNDER, 0.76), width=2)
    for s in (1, -1):
        hv0, hv1 = sorted((BV(s * bw / 2), BV(s * (bw / 2 - 0.10))))
        hazard(m, [BU(z0), hv0, BU(z1), hv1], step=24)
    stencil(m, (BU(-2.30), BV(-1.50)), 'ARM', 20, jit(REDL, 10))
    stencil(m, (BU(1.70), BV(0.85)), 'BAY', 20, jit(REDL, 10))

    # gear doors
    for (za, zb, xa, xb) in ((-6.55, -5.05, -0.34, 0.34),
                             (0.55, 2.05, 3.05, 4.35),
                             (0.55, 2.05, -4.35, -3.05)):
        m.d.rectangle(rect(BU(za), BV(xa), BU(zb), BV(xb)),
                      fill=shade(UNDER, 0.93), outline=jit(REDL, 20), width=2)

    # MG blister
    m.d.rectangle(rect(BU(3.34), BV(-0.30), BU(4.26), BV(0.30)), fill=DKPANEL)

    # under-wing roundels + panel lines
    for s in (1, -1):
        rcx, rcy = BU(-0.40), BV(s * 5.30)
        rx, ry = 90, 34
        m.d.ellipse([rcx - rx, rcy - ry, rcx + rx, rcy + ry],
                    fill=(176, 180, 184))
        m.t.ellipse([rcx - rx * 0.58, rcy - ry * 0.58, rcx + rx * 0.58,
                     rcy + ry * 0.58], fill=(255, 0, 0))
        m.d.ellipse([rcx - rx * 0.58, rcy - ry * 0.58, rcx + rx * 0.58,
                     rcy + ry * 0.58], fill=TEAM_BASE)
        pv0, pv1 = sorted((BV(s * L.NAC_X - 0.20), BV(s * L.NAC_X + 0.20)))
        m.d.rectangle([BU(-1.10), pv0, BU(1.90), pv1], fill=shade(UNDER, 0.84))
    for wz in (-2.8, -1.0, 0.8, 2.6):
        m.d.line([(BU(wz), BV(-7.9)), (BU(wz), BV(7.9))],
                 fill=shade(UNDER, 0.80), width=2)
    wear_edges(m, (x0, y0, x1, y1), UNDER, 40)


def paint_canopy(m):
    x0, y0, x1, y1 = L.B_CANOPY.rect
    CU, CV = PL.zone_fns(L.B_CANOPY)
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    for i in range(10):
        f = i / 10.0
        m.d.rectangle(rect(x0, y0 + (y1 - y0) * f, x1,
                           y0 + (y1 - y0) * (f + 0.1)),
                      fill=shade((28, 42, 52), 1.0 + f * 0.5))
    # THREE frame bows — the §26 side-by-side crew cue
    for wz in (-7.05, -6.40, -5.78):
        b = rect(CU(wz) - 6, y0 + 2, CU(wz) + 6, CV(2.72))
        m.d.rectangle(b, fill=DKPANEL)
        m.o.rectangle(b, fill=(AO_BASE - 5, R_ARMOR, M_ARMOR))
    # sill below the glazing
    sill = rect(x0, CV(2.80), x1, y1)
    m.d.rectangle(sill, fill=DKPANEL)
    m.o.rectangle(sill, fill=(AO_BASE - 8, R_ARMOR, M_ARMOR))
    # two abreast instrument glows (manned, crew side-by-side)
    for wz in (-6.75, -6.10):
        m.e.rectangle(rect(CU(wz), CV(3.02), CU(wz + 0.22), CV(2.92)),
                      fill=(110, 145, 90))
    wear_edges(m, (x0, y0, x1, y1), (42, 56, 64), 24)


def paint_fin(m):
    x0, y0, x1, y1 = L.B_FIN.rect
    FU, FV = PL.zone_fns(L.B_FIN)
    fill(m, (x0, y0, x1, y1), dif=AIR, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)
    # splinter facet carried onto the fin
    m.d.polygon([(FU(4.35), FV(2.55)), (FU(5.60), FV(4.90)),
                 (FU(7.28), FV(4.30)), (FU(7.30), FV(2.55))], fill=SPL)
    # rudder hinge line
    m.d.line([(FU(6.85), FV(2.60)), (FU(6.95), FV(5.55))],
             fill=shade(AIR, 0.66), width=3)
    seam_h(m, x0 + 4, x1 - 4, int(FV(3.90)), AIR, hi=False)
    # team band high on the fin — reads from the RTS top-down camera
    team_zone(m, rect(FU(5.05), FV(5.30), FU(6.75), FV(4.55)))
    text_stamp(m, (FU(5.35), FV(4.35)), 'FB-13', 30, shade(AIR, 0.55))
    # fin-cap formation light
    cap = rect(FU(5.55), FV(5.58), FU(6.80), FV(5.48))
    m.d.rectangle(cap, fill=(46, 42, 30))
    m.e.rectangle(cap, fill=AMBER)
    wear_edges(m, (x0, y0, x1, y1), AIR, 28)


def paint_cells(m):
    # ── nacelle wrap: x0 edge = nozzle (aft), x1 edge = intake lip (fwd)
    x0, y0, x1, y1 = L.B_NAC
    fill(m, (x0, y0, x1, y1), dif=shade(AIR, 1.06), ao=AO_BASE,
         rough=R_ARMOR - 6, metal=M_ARMOR + 20)
    span = x1 - x0
    # intake warning ring at the lip
    m.d.rectangle([x1 - 26, y0, x1, y1], fill=jit(WARN_RED, 10))
    m.d.rectangle([x1 - 40, y0, x1 - 26, y1], fill=BONE)
    # cowl split seams + access panels
    for i in range(12):
        vy = y0 + (y1 - y0) * i / 12.0
        m.d.line([(x0, vy), (x1, vy)], fill=shade(AIR, 0.80), width=2)
    for f in (0.34, 0.58):
        m.d.line([(x0 + span * f, y0), (x0 + span * f, y1)],
                 fill=shade(AIR, 0.72), width=3)
    # heat tint toward the nozzle end
    for i in range(9):
        f = i / 9.0
        m.d.rectangle([x0 + span * f * 0.26, y0, x0 + span * (f + 0.12) * 0.26,
                       y1], fill=shade((96, 78, 66), 0.62 + f * 0.55))
    text_stamp(m, (x0 + span * 0.66, y0 + 8), 'NO STEP', 14, shade(AIR, 0.6))

    # burner can behind the nozzle
    r = L.B_BURNER.rect
    fill(m, r, dif=(30, 27, 25), ao=AO_DEEP, rough=185, metal=110)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) * 0.34
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(42, 24, 18))
    m.e.ellipse([cx - rr * 0.72, cy - rr * 0.72, cx + rr * 0.72,
                 cy + rr * 0.72], fill=(180, 84, 28))

    # intake duct funnel: pale throat with a warning lip
    r = L.B_DUCT.rect
    fill(m, r, dif=(124, 126, 122), ao=AO_DEEP, rough=R_ARMOR, metal=M_STEEL)
    m.d.rectangle([r[0], r[1], r[0] + 12, r[3]], fill=WARN_RED)
    m.d.rectangle([r[0] + 12, r[1], r[0] + 22, r[3]], fill=BONE)

    # gear cell: bare steel struts + oleo band
    r = L.B_GEAR.rect
    fill(m, r, dif=STEEL, ao=AO_SEAM, rough=R_STEEL, metal=M_STEEL)
    m.d.rectangle([r[0], r[1] + (r[3] - r[1]) * 0.36, r[2],
                   r[1] + (r[3] - r[1]) * 0.60], fill=(160, 164, 168))
    bolts(m, [(r[0] + 12, r[1] + 12), (r[2] - 12, r[3] - 12)], base=STEEL)

    # trim cell: pylons, doors, antennas, tailcone
    fill(m, L.B_TRIM.rect, dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    # dark cell: bores, wheel treads, throat cap
    fill(m, L.B_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    # MG barrel wrap
    fill(m, L.B_BARREL, dif=TRACK_MET, ao=AO_SEAM, rough=R_STEEL - 20,
         metal=205)
    bx0, by0, bx1, by1 = L.B_BARREL
    m.d.rectangle([bx0, by0, bx0 + 18, by1], fill=(36, 32, 30))

    # bomb-aimer glazing
    r = L.B_GLASS.rect
    fill(m, r, dif=(44, 58, 66), ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    for i in range(4):
        vx = r[0] + (r[2] - r[0]) * (i + 1) / 5.0
        m.d.line([(vx, r[1]), (vx, r[3])], fill=DKPANEL, width=4)
    m.e.rectangle([r[0] + 10, r[1] + 8, r[0] + 30, r[1] + 18], fill=(60, 90, 60))

    # spare bay-interior cell (kept neutral dark)
    fill(m, L.B_BAYIN.rect, dif=(46, 48, 50), ao=AO_DEEP, rough=190, metal=90)

    # nav lights (port red / starboard green)
    for (zone, col) in ((L.B_NAVP, REDLT), (L.B_NAVS, GREENLT)):
        r = zone.rect
        fill(m, r, dif=GLASS, ao=AO_SEAM, rough=R_GLASS, metal=M_GLASS)
        m.e.rectangle([r[0] + 10, r[1] + 10, r[2] - 10, r[3] - 10], fill=col)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_side(m)
    paint_top(m)
    paint_bot(m)
    paint_canopy(m)
    paint_fin(m)
    paint_cells(m)

    # ── weathering: a hard-worked line bomber ──
    wx = PL.standard_weather(m, L, ground_rects=(L.B_GEAR.rect,),
                             side_zones=(), seed=61, mud=0.35, grime=0.5,
                             rust_fraction=0.35)
    wx.mud_band(L.B_SIDE.rect, 0.20, fade='down', dust=0.30, spatter=False)
    wx.mud_band(L.B_TOP.rect, 0.14, fade=None, spatter=False)   # ≤0.2 (note 10)
    wx.mud_band(L.B_BOT.rect, 0.30, fade=None, spatter=False)
    wx.mud_band(L.B_FIN.rect, 0.12, fade=None, spatter=False)
    # exhaust soot: aft of both nacelles, on the wing upper AND lower skin
    for s in (1, -1):
        tv0, tv1 = sorted((TV(s * L.NAC_X - 0.9), TV(s * L.NAC_X + 0.9)))
        wx.soot_patch((TU(2.9), tv0, TU(6.6), tv1), 0.55, fade='right')
        bv0, bv1 = sorted((BV(s * L.NAC_X - 0.9), BV(s * L.NAC_X + 0.9)))
        wx.soot_patch((BU(2.9), bv0, BU(6.6), bv1), 0.45, fade='right')
    wx.soot_patch(L.B_NAC, 0.45, fade='left')
    wx.soot_patch(L.B_BURNER.rect, 0.8)
    # gun-gas staining aft of the ventral MG
    wx.soot_patch((BU(4.2), BV(-0.5), BU(6.2), BV(0.5)), 0.45, fade='right')
    # bay-seam grime + gear-door oil trails
    wx.oily((BU(-2.8), BV(-0.9), BU(3.2), BV(0.9)), 0.32)
    wx.oily(L.B_GEAR.rect, 0.4)
    sx0, sy0, sx1, sy1 = L.B_SIDE.rect
    for f in (0.26, 0.48, 0.70):
        wx.rust_streak(sx0 + (sx1 - sx0) * f, SV(2.10), 34, width=2.4,
                       strength=0.28)
    wx.plate_bottom_rust(L.B_SIDE.rect, n=6, strength=0.4)

    # ── height detail ──
    from normals import HeightMap
    hm = HeightMap()
    hm.rect(rect(TU(-5.0), TV(-0.40), TU(6.4), TV(0.40)), 0.55)      # spine
    bx, by, bz, bw, bh, bd = L.BAY
    hm.rect(rect(BU(bz - bd / 2), BV(-bw / 2), BU(bz + bd / 2), BV(bw / 2)),
            -0.45)                                                   # bay
    for zr, uf, vf in ((L.B_SIDE, SU, SV), (L.B_TOP, TU, TV),
                       (L.B_BOT, BU, BV)):
        for wz in STATIONS:
            hm.line((uf(wz), zr.rect[1] + 3), (uf(wz), zr.rect[3] - 3),
                    -0.32, width=2)
    CU, CV = PL.zone_fns(L.B_CANOPY)
    for wz in (-7.05, -6.40, -5.78):
        hm.line((CU(wz), L.B_CANOPY.rect[1] + 3), (CU(wz), CV(2.72)), 0.45,
                width=5)
    x0, y0, x1, y1 = L.B_NAC
    for i in range(12):
        vy = y0 + (y1 - y0) * i / 12.0
        hm.line((x0, vy), (x1, vy), -0.35, width=2)
    PL.finish(m, L, 'ms_bombers_s3', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
