"""paint_ms_fighters_s2 — 1024² PBR set for the s2 manned light fighter.

Fighters-slice language (s1/s3 family): weathered gunmetal upper with
low-contrast olive splinter wedges, pale grey underside, maroon
cheatline along the fuselage flank, red/bone intake warning ring at the
nose lip (painted in ALL THREE bands — it wraps the fuselage), olive
anti-glare panel ahead of the bubble canopy, low-vis wing roundels and
spanwise wing codes, amber formation-light strips at the wingtips and
fin cap, live-round bands on the AA missiles, team panels on the wing
shoulders and the fin via team_panel(base=...). Team colour lives ONLY
in the team-mask R channel.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw

import ms_fighters_s2_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade,
                   BOLT_LOG, GLASS, YELLOW, BLACKISH, STEEL, STEEL_DK,
                   TRACK_MET, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

STEM = 'ms_fighters_s2'
W = 1024

# ── palette: gunmetal/olive family, tones within ±15% ──────────────────
GUNMETAL = (90, 96, 100)         # upper surfaces
OLIVE = (84, 89, 68)             # splinter second tone
UNDER = (122, 128, 132)          # pale underside
DKPANEL = (64, 69, 73)
RADOME = (58, 60, 62)
CHEAT = (118, 62, 50)            # worn maroon cheatline
WARN_RED = (150, 46, 36)
BONE = (176, 178, 168)
MSL_BODY = (152, 152, 144)
MSL_BROWN = (104, 74, 46)
AMBER = (255, 176, 60)
GREENLT = (70, 220, 110)
REDLT = (235, 70, 55)
TEAM_BASE = (120, 124, 128)      # low-contrast team-panel respray base

SU, SV = PL.zone_fns(L.F_SIDE)
TU, TV = PL.zone_fns(L.F_TOP)
BU, BV = PL.zone_fns(L.F_BOT)


def rect(a, b, c, d):
    return PL.nbox(a, b, c, d)


def text_stamp(m, xy, s, size, color, angle=0):
    """Rotated text stamped into the diffuse (PIL rotate(angle, expand))."""
    f = PL.font(size)
    tmp = Image.new('L', (int(size * 0.8 * len(s)) + 8, int(size * 1.5)), 0)
    ImageDraw.Draw(tmp).text((3, 2), s, font=f, fill=255)
    bb = tmp.getbbox()
    if bb:
        tmp = tmp.crop(bb)
    if angle:
        tmp = tmp.rotate(angle, expand=True)
    m.dif.paste(Image.new('RGB', tmp.size, color), (int(xy[0]), int(xy[1])),
                tmp)


# ── flanks ─────────────────────────────────────────────────────────────
def paint_side(m):
    z = L.F_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    # pale underside tone below a gently varying chine break
    knots = [(-5.5, 1.30), (-4.2, 1.24), (-2.8, 1.32), (-1.2, 1.22),
             (0.6, 1.30), (2.2, 1.24), (3.8, 1.34), (5.2, 1.40)]
    poly = [(SU(kz), SV(ky)) for (kz, ky) in knots]
    poly += [(x1, y1), (x0, y1)]
    m.d.polygon(poly, fill=UNDER)

    # olive splinter wedges riding the break (low contrast)
    for (a, b, drop) in ((-4.6, -3.0, 0.36), (-1.8, 0.0, 0.42),
                         (1.2, 2.8, 0.36)):
        m.d.polygon([(SU(a), SV(1.62)), (SU((a + b) / 2), SV(1.62 + drop)),
                     (SU(b), SV(1.58)), (SU(b), SV(1.42)),
                     (SU(a), SV(1.46))], fill=OLIVE)

    # maroon cheatline along the flank at chine height (mirror-safe)
    m.d.rectangle(rect(SU(-4.55), SV(1.52), SU(4.35), SV(1.40)), fill=CHEAT)
    m.d.rectangle(rect(SU(-4.55), SV(1.40), SU(4.35), SV(1.37)),
                  fill=shade(CHEAT, 0.72))

    # intake warning ring just aft of the nose lip (wraps — see TOP/BOT)
    m.d.rectangle(rect(SU(-5.00), SV(1.90), SU(-4.84), SV(0.92)),
                  fill=WARN_RED)
    m.d.rectangle(rect(SU(-4.84), SV(1.90), SU(-4.74), SV(0.92)), fill=BONE)

    # fuselage panel seams
    for wz in (-4.3, -3.1, -1.4, 0.6, 2.5, 3.6):
        seam_v(m, int(SU(wz)), int(SV(2.10)), int(SV(0.86)), GUNMETAL)
    seam_h(m, int(SU(-4.3)), int(SU(4.3)), int(SV(1.72)), GUNMETAL)

    # chin gun tray flank
    m.d.rectangle(rect(SU(-4.92), SV(1.15), SU(-3.80), SV(0.90)),
                  fill=DKPANEL)
    m.o.rectangle(rect(SU(-4.92), SV(1.15), SU(-3.80), SV(0.90)),
                  fill=(AO_SEAM, R_STEEL, M_STEEL))

    # avionics bay hatch + fasteners
    m.d.rectangle(rect(SU(-3.6), SV(1.86), SU(-2.9), SV(1.62)),
                  outline=shade(GUNMETAL, 0.82), width=2)
    bolts(m, [(SU(-3.52 + i * 0.20), SV(1.80)) for i in range(4)], r=2,
          base=GUNMETAL)

    # tail band ahead of the nozzle collar
    m.d.rectangle(rect(SU(3.95), SV(2.00), SU(4.15), SV(1.00)),
                  fill=shade(GUNMETAL, 0.86))

    # soot cone aft of the nozzle station
    for i in range(7):
        f = i / 7.0
        zz = 4.15 + f * 1.0
        m.d.rectangle(rect(SU(zz), SV(1.85 + f * 0.05), SU(zz + 0.16),
                           SV(1.05 - f * 0.05)),
                      fill=shade(GUNMETAL, 0.88 - f * 0.28))

    wear_edges(m, (x0, y0, x1, y1), GUNMETAL, 44)


# ── upper surfaces ─────────────────────────────────────────────────────
def paint_top(m):
    z = L.F_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    # olive splinter blocks (tone-on-tone; big quads sample this zone)
    for (za, zb, xa, xb) in ((-4.6, -2.6, -0.8, 0.8), (-1.4, 1.2, 1.6, 4.2),
                             (-0.6, 2.0, -4.2, -1.8), (2.4, 4.4, -1.2, 1.2)):
        m.d.polygon([(TU(za), TV(xa)), (TU(zb), TV(xa + 0.4)),
                     (TU(zb), TV(xb)), (TU(za), TV(xb - 0.4))], fill=OLIVE)

    # intake warning ring on the nose crown (wrap continuation)
    m.d.rectangle(rect(TU(-5.00), TV(-0.40), TU(-4.84), TV(0.40)),
                  fill=WARN_RED)
    m.d.rectangle(rect(TU(-4.84), TV(-0.40), TU(-4.74), TV(0.40)), fill=BONE)

    # olive anti-glare panel ahead of the canopy (manned cue from above)
    m.d.polygon([(TU(-4.70), TV(-0.24)), (TU(-3.55), TV(-0.38)),
                 (TU(-3.55), TV(0.38)), (TU(-4.70), TV(0.24))],
                fill=shade(OLIVE, 0.88))

    # canopy sill shadow ring on the deck
    m.d.rectangle(rect(TU(-3.55), TV(-0.42), TU(-1.25), TV(0.42)),
                  fill=shade(GUNMETAL, 0.78))

    # dorsal spine band back to the fin
    m.d.rectangle(rect(TU(-1.20), TV(-0.22), TU(4.00), TV(0.22)),
                  fill=DKPANEL)
    for wz in (-0.2, 1.2, 2.6):
        m.d.line([(TU(wz), TV(-0.22)), (TU(wz), TV(0.22))],
                 fill=shade(DKPANEL, 0.62), width=2)

    # spanwise panel seams — continuous across the wing root
    for wz in (-3.1, -1.4, -0.4, 0.6, 2.5):
        seam_v(m, int(TU(wz)), y0 + 2, y1 - 2, GUNMETAL)

    for s in (1, -1):
        # wing hinge/panel lines (chordwise, constant x)
        for wx in (1.35, 2.45, 3.5):
            vv = int(TV(s * wx))
            m.d.line([(TU(-1.6), vv), (TU(1.0), vv)],
                     fill=shade(GUNMETAL, 0.62), width=2)

        # team panel on the wing shoulder (low-contrast base respray)
        PL.team_panel(m, rect(TU(-1.15), TV(s * 0.95), TU(0.35), TV(s * 1.95)),
                      outline=shade(GUNMETAL, 0.7), base=TEAM_BASE)

        # low-vis roundel mid-span
        r = 0.34
        cu, cv = TU(0.05), TV(s * 2.85)
        ru = abs(TU(r) - TU(0.0))
        rv = abs(TV(r) - TV(0.0))
        for f, col in ((1.0, shade(GUNMETAL, 0.78)), (0.60, shade(GUNMETAL, 1.12))):
            m.d.ellipse([cu - ru * f, cv - rv * f, cu + ru * f, cv + rv * f],
                        outline=col, width=2)
        m.d.ellipse([cu - ru * 0.28, cv - rv * 0.28,
                     cu + ru * 0.28, cv + rv * 0.28],
                    fill=shade(GUNMETAL, 0.78))

        # spanwise wing code (tone-on-tone)
        code = 'MS-2' if s > 0 else '049'
        text_stamp(m, (TU(-0.75), TV(s * 3.75) - (0 if s > 0 else 30)),
                   code, 24, shade(GUNMETAL, 0.58), angle=-90)

        # wingtip amber formation-light strip
        tz0, tz1, tx0, tx1 = L.TIP_LIGHT
        strip = rect(TU(tz0), TV(s * tx0), TU(tz1), TV(s * tx1))
        m.d.rectangle(strip, fill=(46, 42, 30))
        m.e.rectangle([strip[0] + 1, strip[1] + 1, strip[2] - 1,
                       strip[3] - 1], fill=AMBER)
        m.o.rectangle(strip, fill=(AO_BASE, R_GLASS, M_GLASS))

        # tailplane leading-edge line
        m.d.line([(TU(3.42), TV(s * 0.30)), (TU(3.95), TV(s * 1.85))],
                 fill=shade(GUNMETAL, 0.64), width=2)

    bolts(m, [(TU(-3.9 + i * 1.4), TV(0.55)) for i in range(6)], r=2,
          base=GUNMETAL)
    wear_edges(m, (x0, y0, x1, y1), GUNMETAL, 52)


# ── underside ──────────────────────────────────────────────────────────
def paint_bot(m):
    z = L.F_BOT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=UNDER, ao=AO_BASE - 10, rough=R_ARMOR + 8,
         metal=M_ARMOR)

    # intake warning ring wrap on the nose underside
    m.d.rectangle(rect(BU(-5.00), BV(-0.32), BU(-4.84), BV(0.32)),
                  fill=WARN_RED)
    m.d.rectangle(rect(BU(-4.84), BV(-0.32), BU(-4.74), BV(0.32)), fill=BONE)

    # chin gun tray underside + gun-gas darkening
    m.d.rectangle(rect(BU(-4.92), BV(0.06), BU(-3.80), BV(0.44)),
                  fill=DKPANEL)
    m.o.rectangle(rect(BU(-4.92), BV(0.06), BU(-3.80), BV(0.44)),
                  fill=(AO_SEAM, R_STEEL, M_STEEL))

    # gear bay outlines (nose + mains)
    m.d.rectangle(rect(BU(-3.70), BV(-0.16), BU(-3.05), BV(0.16)),
                  outline=shade(UNDER, 0.80), width=2)
    for s in (1, -1):
        m.d.rectangle(rect(BU(0.02), BV(s * 1.00), BU(0.62), BV(s * 1.58)),
                      outline=shade(UNDER, 0.80), width=2)
        # pylon shadow strip under the wing
        m.d.rectangle(rect(BU(-1.05), BV(s * 2.08), BU(0.40), BV(s * 2.32)),
                      fill=shade(UNDER, 0.74))

    for wz in (-4.3, -3.1, -1.4, 0.6, 2.5):
        m.d.line([(BU(wz), BV(-4.5)), (BU(wz), BV(4.5))],
                 fill=shade(UNDER, 0.76), width=2)
    wear_edges(m, (x0, y0, x1, y1), UNDER, 34)


# ── canopy ─────────────────────────────────────────────────────────────
def paint_canopy(m):
    z = L.F_CANOPY
    x0, y0, x1, y1 = z.rect
    CU, CV = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    # tinted glass gradient
    for i in range(10):
        f = i / 10.0
        m.d.rectangle(rect(x0, y0 + (y1 - y0) * f, x1,
                           y0 + (y1 - y0) * (f + 0.1)),
                      fill=shade((26, 40, 50), 1.0 + f * 0.55))
    # windscreen + aft frame bows and sill rail
    for wz in (-3.42, -1.42):
        m.d.line([(CU(wz), y0), (CU(wz), y1)], fill=DKPANEL, width=5)
    m.d.line([(x0, CV(2.02)), (x1, CV(2.02))], fill=DKPANEL, width=4)
    # instrument glow under the windscreen (manned cue)
    m.e.rectangle(rect(CU(-3.30), CV(2.14), CU(-3.06), CV(2.04)),
                  fill=(120, 150, 90))
    wear_edges(m, (x0, y0, x1, y1), (40, 54, 62), 20)


# ── fin (two-sided zone — no lettering here, symmetric content only) ───
def paint_fin(m):
    z = L.F_FIN
    x0, y0, x1, y1 = z.rect
    FU, FV = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)
    # olive leading-edge wedge
    m.d.polygon([(FU(2.60), FV(1.75)), (FU(3.95), FV(3.38)),
                 (FU(4.45), FV(3.38)), (FU(3.10), FV(1.75))], fill=OLIVE)
    # team panel high on the fin — reads from the RTS camera
    PL.team_panel(m, rect(FU(3.85), FV(3.10), FU(4.45), FV(2.35)),
                  outline=shade(GUNMETAL, 0.7), base=TEAM_BASE)
    # rudder hinge line
    m.d.line([(FU(4.35), y0), (FU(4.55), y1)], fill=shade(GUNMETAL, 0.6),
             width=2)
    # amber formation light on the fin cap
    cap = rect(FU(4.00), FV(3.42), FU(4.45), FV(3.34))
    m.d.rectangle(cap, fill=(46, 42, 30))
    m.e.rectangle(cap, fill=AMBER)
    wear_edges(m, (x0, y0, x1, y1), GUNMETAL, 24)


# ── small cells ────────────────────────────────────────────────────────
def paint_cells(m):
    # missile body wrap: pale body, live-round yellow + brown bands
    x0, y0, x1, y1 = L.F_MISSILE
    fill(m, (x0, y0, x1, y1), dif=MSL_BODY, ao=AO_BASE, rough=R_ARMOR - 10,
         metal=M_STEEL)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) * 0.13, y1], fill=DKPANEL)
    for (a, b, c) in ((0.34, 0.40, YELLOW), (0.44, 0.49, MSL_BROWN),
                      (0.72, 0.78, YELLOW), (0.86, 1.00, RADOME)):
        m.d.rectangle([x0 + (x1 - x0) * a, y0, x0 + (x1 - x0) * b, y1],
                      fill=c)
    text_stamp(m, (x0 + 8, y0 + 22), 'AA-1', 12, shade(MSL_BODY, 0.45))

    # nozzle / gun-barrel wrap: heat-stained steel, petal seams
    x0, y0, x1, y1 = L.F_NOZZLE
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_STEEL - 20,
         metal=200)
    for i in range(9):
        m.d.line([(x0, y0 + (y1 - y0) * i / 9.0),
                  (x1, y0 + (y1 - y0) * i / 9.0)],
                 fill=shade(TRACK_MET, 0.55), width=2)
    for i in range(7):
        f = i / 7.0
        m.d.rectangle([x0 + (x1 - x0) * f, y0,
                       x0 + (x1 - x0) * (f + 0.15), y1],
                      fill=shade((96, 74, 60), 0.55 + f * 0.55))

    # burner can: black with a dull heat glow
    r = L.F_BURNER.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=190, metal=60)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) * 0.32
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(40, 22, 18))
    m.e.ellipse([cx - rr * 0.7, cy - rr * 0.7, cx + rr * 0.7, cy + rr * 0.7],
                fill=(90, 34, 18))

    # gear cell: bare steel struts + oleo
    r = L.F_GEAR.rect
    fill(m, r, dif=STEEL, ao=AO_SEAM, rough=R_STEEL, metal=M_STEEL)
    m.d.rectangle([r[0], r[1] + (r[3] - r[1]) * 0.35, r[2],
                   r[1] + (r[3] - r[1]) * 0.62], fill=(158, 162, 166))
    bolts(m, [(r[0] + 10, r[1] + 10), (r[2] - 10, r[3] - 10)], base=STEEL)

    # trim cell: mechanical dark steel (pylons, edges, caps, blade antenna)
    fill(m, L.F_TRIM.rect, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)

    # dark cell: bores, wheel treads, intake throat cap
    fill(m, L.F_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)

    # duct interior: pale grey funnel with a warning lip
    r = L.F_DUCT.rect
    fill(m, r, dif=(122, 124, 120), ao=AO_DEEP, rough=R_ARMOR, metal=M_STEEL)
    m.d.rectangle([r[0], r[1], r[0] + 10, r[3]], fill=WARN_RED)
    m.d.rectangle([r[0] + 10, r[1], r[0] + 18, r[3]], fill=BONE)

    # nav lights (port red / starboard green)
    for (zone, col) in ((L.F_NAVP, REDLT), (L.F_NAVS, GREENLT)):
        r = zone.rect
        fill(m, r, dif=GLASS, ao=AO_SEAM, rough=R_GLASS, metal=M_GLASS)
        m.e.rectangle([r[0] + 8, r[1] + 8, r[2] - 8, r[3] - 8], fill=col)


# ── assembly ───────────────────────────────────────────────────────────
def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_side(m)
    paint_top(m)
    paint_bot(m)
    paint_canopy(m)
    paint_fin(m)
    paint_cells(m)

    # ── weathering: hard-flown salvage-era airframe ──
    wx = PL.standard_weather(m, L, ground_rects=(L.F_GEAR.rect,),
                             side_zones=(), seed=47, mud=0.30, grime=0.48,
                             rust_fraction=0.38)
    wx.mud_band(L.F_SIDE.rect, 0.18, fade='down', dust=0.28, spatter=False)
    wx.mud_band(L.F_TOP.rect, 0.14, fade=None, spatter=False)
    wx.mud_band(L.F_BOT.rect, 0.28, fade=None, spatter=False)
    wx.mud_band(L.F_FIN.rect, 0.12, fade=None, spatter=False)
    # soot aft of the single nozzle (side + top bands) and the burner can
    sx0, sy0, sx1, sy1 = L.F_SIDE.rect
    wx.soot_patch((SU(3.9), sy0, sx1, sy1), 0.6)
    tx0, ty0, tx1, ty1 = L.F_TOP.rect
    wx.soot_patch((TU(3.9), TV(-0.6), tx1, TV(0.6)), 0.45)
    wx.soot_patch(L.F_NOZZLE, 0.7)
    wx.soot_patch(L.F_BURNER.rect, 0.8)
    # gun-gas staining aft of the chin tray (side + underside)
    wx.soot_patch((SU(-4.6), SV(1.15), SU(-3.3), SV(0.88)), 0.45)
    wx.soot_patch((BU(-4.5), BV(0.02), BU(-3.2), BV(0.50)), 0.42)
    # oil streaks off the flank panel seams
    for f in (0.30, 0.55, 0.76):
        wx.rust_streak(sx0 + (sx1 - sx0) * f, SV(1.60), 26, width=2.0,
                       strength=0.28)
    wx.oily(L.F_GEAR.rect, 0.4)
    wx.plate_bottom_rust(L.F_SIDE.rect, n=4, strength=0.35)

    # ── height detail ──
    from normals import HeightMap
    hm = HeightMap()
    hm.rect(rect(TU(-1.20), TV(-0.22), TU(4.00), TV(0.22)), 0.5)   # spine
    hm.rect(rect(TU(-3.55), TV(-0.42), TU(-1.25), TV(0.42)), 0.3)  # sill
    for s in (1, -1):
        hm.rect(rect(TU(-1.15), TV(s * 0.95), TU(0.35), TV(s * 1.95)), 0.22)
    hm.rect(rect(BU(-4.92), BV(0.06), BU(-3.80), BV(0.44)), 0.4)   # gun tray
    x0, y0, x1, y1 = L.F_NOZZLE
    for i in range(9):
        yy = y0 + (y1 - y0) * i / 9.0
        hm.line((x0, yy), (x1, yy), -0.4, width=2)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
