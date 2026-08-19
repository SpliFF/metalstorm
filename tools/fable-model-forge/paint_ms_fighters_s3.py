"""paint_ms_fighters_s3 — 1024² PBR set for the s3 Heavy Fighter.

Weathered gunmetal/olive family palette. Cues: two-tone air-superiority
splinter break along the chine, spanwise squadron codes on the wing upper
surfaces (PIL rotate(-90, expand)), red/white warning rings at both nacelle
mouths, soot cones aft of both nozzles, live-round yellow/brown bands on the
missile bodies, amber formation-light strips along the boom spines, and team
mask panels on the wing shoulders and both fins so team colour reads from the
top-down RTS camera. Team colour lives ONLY in the team-mask R channel.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw

import ms_fighters_s3_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   STEEL, STEEL_DK, RUBBER, TRACK_MET,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)

W = 1024

GUNMETAL = (88, 94, 99)          # upper air-superiority grey
OLIVE = (82, 87, 64)             # splinter second tone
UNDER = (124, 130, 134)          # pale underside
DKPANEL = (62, 67, 71)
RADOME = (58, 60, 62)
WARN_RED = (150, 46, 36)
BONE = (176, 178, 168)
MSL_BODY = (152, 152, 144)
MSL_BROWN = (104, 74, 46)
AMBER = (255, 176, 60)
GREENLT = (70, 220, 110)
REDLT = (235, 70, 55)
# team-mask base: kept close to GUNMETAL on purpose — the impostor baker
# flat-shades a whole quad from its UV centroid, so a bright TEAMGREY panel
# floods the entire wing panel it sits in. Team colour comes from the mask.
TEAM_BASE = (126, 130, 132)


def team_zone(m, box, outline=GUNMETAL):
    b = PL.nbox(*box)
    m.t.rectangle(b, fill=(255, 0, 0))
    m.d.rectangle(b, fill=TEAM_BASE)
    m.d.rectangle(b, outline=shade(outline, 0.55), width=2)


# ── coordinate helpers ─────────────────────────────────────────────────
SU, SV = PL.zone_fns(L.F_SIDE)      # SU(z), SV(y)
TU, TV = PL.zone_fns(L.F_TOP)       # TU(z), TV(x)
BU, BV = PL.zone_fns(L.F_BOT)       # BU(z), BV(x)


def rect(a, b, c, d):
    return PL.nbox(a, b, c, d)


def text_stamp(m, xy, s, size, color, angle=0, target=None):
    """Rotated text stamped into the diffuse (PIL rotate(angle, expand))."""
    f = PL.font(size)
    tmp = Image.new('L', (int(size * 0.8 * len(s)) + 8, int(size * 1.5)), 0)
    ImageDraw.Draw(tmp).text((3, 2), s, font=f, fill=255)
    bb = tmp.getbbox()
    if bb:
        tmp = tmp.crop(bb)
    if angle:
        tmp = tmp.rotate(angle, expand=True)
    img = m.dif if target is None else target
    img.paste(Image.new('RGB', tmp.size, color), (int(xy[0]), int(xy[1])), tmp)


# ── zone painters ──────────────────────────────────────────────────────
def paint_side(m):
    z = L.F_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    # two-tone splinter break along the chine: pale grey below a jagged line
    knots = [(-8.4, 2.32), (-6.6, 2.16), (-5.2, 2.28), (-3.8, 2.04),
             (-2.2, 2.20), (-0.6, 1.98), (1.2, 2.16), (3.0, 1.96),
             (4.6, 2.12), (6.6, 2.00)]
    poly = [(SU(kz), SV(ky)) for (kz, ky) in knots]
    poly += [(x1, y1), (x0, y1)]
    m.d.polygon(poly, fill=UNDER)
    # olive splinter wedges riding the break, upper side
    for (a, b, drop) in ((-7.0, -5.0, 0.42), (-3.6, -1.6, 0.5), (0.4, 2.4, 0.44),
                         (3.4, 5.2, 0.38)):
        m.d.polygon([(SU(a), SV(2.24)), (SU((a + b) / 2), SV(2.24 + drop)),
                     (SU(b), SV(2.20)), (SU(b), SV(2.44)),
                     (SU(a), SV(2.48))], fill=OLIVE)

    # radome tone break (nose cone is dark dielectric)
    m.d.rectangle(rect(SU(-8.4), SV(2.6), SU(-6.9), SV(1.7)), fill=RADOME)

    # fuselage / boom panel seams
    for wz in (-6.9, -5.6, -4.2, -2.6, -0.8, 1.2, 3.0, 4.6):
        seam_v(m, int(SU(wz)), int(SV(3.0)), int(SV(1.2)), GUNMETAL)
    seam_h(m, int(SU(-6.9)), int(SU(5.6)), int(SV(1.55)), GUNMETAL)

    # intake warning ring at the nacelle mouths (both booms share the zone)
    m.d.rectangle(rect(SU(-4.78), SV(2.62), SU(-4.60), SV(1.34)),
                  fill=WARN_RED)
    m.d.rectangle(rect(SU(-4.60), SV(2.62), SU(-4.50), SV(1.34)), fill=BONE)

    # gear bay lips (dark) under the booms
    m.d.rectangle(rect(SU(-0.2), SV(1.42), SU(1.5), SV(1.24)), fill=BLACKISH)

    # soot cone aft of the nozzles
    for i in range(9):
        f = i / 9.0
        zz = 4.0 + f * 2.6
        m.d.rectangle(rect(SU(zz), SV(2.6 + f * 0.1), SU(zz + 0.32),
                           SV(1.4 - f * 0.1)),
                      fill=shade(GUNMETAL, 0.86 - f * 0.30))

    bolts(m, [(SU(-6.6 + i * 1.5), SV(2.62)) for i in range(8)], base=GUNMETAL)
    wear_edges(m, (x0, y0, x1, y1), GUNMETAL, 55)


def _wing_span_bands(m, u_of, v_of, base):
    """Spanwise hinge/panel lines shared by wing upper + lower surfaces."""
    for wx in (1.2, 2.9, 4.4):
        for s in (1, -1):
            vv = int(v_of(s * wx))
            m.d.line([(u_of(-2.6), vv), (u_of(0.9), vv)],
                     fill=shade(base, 0.6), width=2)


def paint_top(m):
    z = L.F_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    # olive splinter blocks (low contrast — big quads sample this zone)
    for (za, zb, xa, xb) in ((-7.4, -5.2, -1.0, 1.0), (-3.2, -0.6, -6.2, -3.0),
                             (-2.4, 0.6, 2.8, 6.0), (1.0, 4.4, -2.9, -1.5),
                             (2.6, 5.6, 1.5, 2.9), (-4.6, -2.0, -2.9, -1.5)):
        m.d.polygon([(TU(za), TV(xa)), (TU(zb), TV(xa + 0.5)),
                     (TU(zb), TV(xb)), (TU(za), TV(xb - 0.5))], fill=OLIVE)

    # dorsal spine fairing band
    m.d.rectangle(rect(TU(-3.6), TV(-0.34), TU(5.0), TV(0.34)), fill=DKPANEL)
    for wz in (-2.2, -0.4, 1.4, 3.2):
        m.d.line([(TU(wz), TV(-0.34)), (TU(wz), TV(0.34))],
                 fill=shade(DKPANEL, 0.6), width=2)

    # radome (nose) tone break, top band
    m.d.polygon([(TU(-8.4), TV(-0.10)), (TU(-6.9), TV(-0.42)),
                 (TU(-6.9), TV(0.42)), (TU(-8.4), TV(0.10))], fill=RADOME)

    # boom spines: darker walkway strip + amber formation-light strip
    for s in (1, -1):
        bx = s * L.BOOM_X
        m.d.rectangle(rect(TU(-4.2), TV(bx - 0.30), TU(4.6), TV(bx + 0.30)),
                      fill=DKPANEL)
        for wz in (-3.0, -1.4, 0.4, 2.2, 3.8):
            m.d.line([(TU(wz), TV(bx - 0.30)), (TU(wz), TV(bx + 0.30))],
                     fill=shade(DKPANEL, 0.62), width=2)
        strip = rect(TU(-2.4), TV(bx - 0.07), TU(0.8), TV(bx + 0.07))
        m.d.rectangle(strip, fill=(46, 42, 30))
        m.e.rectangle(strip, fill=AMBER)
        # intake warning ring on the boom crown
        m.d.rectangle(rect(TU(-4.78), TV(bx - 0.52), TU(-4.60), TV(bx + 0.52)),
                      fill=WARN_RED)
        m.d.rectangle(rect(TU(-4.60), TV(bx - 0.52), TU(-4.50), TV(bx + 0.52)),
                      fill=BONE)
        # soot cone on the boom crown aft of the nozzle
        for i in range(8):
            f = i / 8.0
            zz = 4.2 + f * 2.4
            m.d.rectangle(rect(TU(zz), TV(bx - 0.5), TU(zz + 0.32),
                               TV(bx + 0.5)),
                          fill=shade(DKPANEL, 0.92 - f * 0.32))

        # wing upper surface: shoulder team panel + hinge lines + codes
        team_zone(m, rect(TU(-1.95), TV(s * 3.05), TU(-0.55), TV(s * 4.05)))
        for wx in (2.85, 4.30):
            m.d.line([(TU(-1.9), TV(s * wx)), (TU(0.2), TV(s * wx))],
                     fill=shade(GUNMETAL, 0.60), width=2)
        # spanwise squadron code (tone-on-tone; big quads flood in the bake)
        code = 'MS-3' if s > 0 else '074'
        text_stamp(m, (TU(-1.35), TV(s * 5.15) - (0 if s > 0 else 34)),
                   code, 26, shade(GUNMETAL, 0.55), angle=-90)
        # tailplane leading-edge line
        m.d.line([(TU(4.42), TV(s * 0.1)), (TU(4.42), TV(s * 2.28))],
                 fill=shade(GUNMETAL, 0.62), width=2)

    # canopy sill shadow on the pod crown
    m.d.rectangle(rect(TU(-6.7), TV(-0.56), TU(-3.9), TV(0.56)),
                  fill=shade(GUNMETAL, 0.78))
    bolts(m, [(TU(-5.0 + i * 1.6), TV(0.62)) for i in range(6)], base=GUNMETAL)
    wear_edges(m, (x0, y0, x1, y1), GUNMETAL, 60)


def paint_bot(m):
    z = L.F_BOT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=UNDER, ao=AO_BASE - 10, rough=R_ARMOR + 8,
         metal=M_ARMOR)
    # gun fairing + gear bays
    m.d.rectangle(rect(BU(-6.9), BV(0.18), BU(-5.3), BV(0.62)), fill=DKPANEL)
    m.d.rectangle(rect(BU(-5.1), BV(-0.42), BU(-3.7), BV(0.42)), fill=BLACKISH)
    for s in (1, -1):
        bx = s * L.BOOM_X
        m.d.rectangle(rect(BU(-0.3), BV(bx - 0.34), BU(1.6), BV(bx + 0.34)),
                      fill=BLACKISH)
        # pylon shadow strips under the wing
        for (px, _, _, _, _, mz0, mz1) in L.PYLONS:
            m.d.rectangle(rect(BU(mz0 + 0.4), BV(s * px - 0.12),
                               BU(mz1 - 0.2), BV(s * px + 0.12)),
                          fill=shade(UNDER, 0.72))
    for wz in (-6.2, -4.2, -2.2, 0.2, 2.4, 4.6):
        m.d.line([(BU(wz), BV(-6.2)), (BU(wz), BV(6.2))],
                 fill=shade(UNDER, 0.74), width=2)
    wear_edges(m, (x0, y0, x1, y1), UNDER, 40)


def paint_canopy(m):
    z = L.F_CANOPY
    x0, y0, x1, y1 = z.rect
    CU, CV = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    # tinted glass gradient + canopy frame bows
    for i in range(10):
        f = i / 10.0
        m.d.rectangle(rect(x0, y0 + (y1 - y0) * f, x1,
                           y0 + (y1 - y0) * (f + 0.1)),
                      fill=shade((26, 40, 50), 1.0 + f * 0.55))
    for wz in (-6.55, -4.05):
        m.d.line([(CU(wz), y0), (CU(wz), y1)], fill=DKPANEL, width=5)
    m.d.line([(x0, CV(2.72)), (x1, CV(2.72))], fill=DKPANEL, width=4)
    # instrument glow under the forward arch (manned cue)
    m.e.rectangle(rect(CU(-4.35), CV(2.86), CU(-4.10), CV(2.78)),
                  fill=(120, 150, 90))
    wear_edges(m, (x0, y0, x1, y1), (40, 54, 62), 22)


def paint_fin(m):
    z = L.F_FIN
    x0, y0, x1, y1 = z.rect
    FU, FV = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)
    m.d.polygon([(FU(3.05), FV(2.35)), (FU(4.05), FV(4.05)),
                 (FU(5.60), FV(4.05)), (FU(5.72), FV(2.35))], fill=OLIVE)
    # team panel high on the fin — visible from the RTS top-down camera
    team_zone(m, rect(FU(4.35), FV(3.85), FU(5.35), FV(3.10)))
    m.d.line([(FU(5.30), y0), (FU(5.30), y1)], fill=shade(GUNMETAL, 0.6),
             width=2)
    # formation light strip on the fin cap
    cap = rect(FU(4.30), FV(4.02), FU(5.30), FV(3.94))
    m.d.rectangle(cap, fill=(46, 42, 30))
    m.e.rectangle(cap, fill=AMBER)
    wear_edges(m, (x0, y0, x1, y1), GUNMETAL, 26)


def paint_cells(m):
    # missile body wrap: pale body, live-round yellow + brown bands
    x0, y0, x1, y1 = L.F_MISSILE
    fill(m, (x0, y0, x1, y1), dif=MSL_BODY, ao=AO_BASE, rough=R_ARMOR - 10,
         metal=M_STEEL)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) * 0.13, y1], fill=DKPANEL)  # tail
    for (a, b, c) in ((0.34, 0.40, YELLOW), (0.44, 0.49, MSL_BROWN),
                      (0.72, 0.78, YELLOW), (0.86, 1.00, RADOME)):
        m.d.rectangle([x0 + (x1 - x0) * a, y0, x0 + (x1 - x0) * b, y1], fill=c)
    text_stamp(m, (x0 + 8, y0 + 22), 'AA-2', 12, shade(MSL_BODY, 0.45))

    # nozzle wrap: heat-stained steel, petal seams
    x0, y0, x1, y1 = L.F_NOZZLE
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_STEEL - 20,
         metal=200)
    for i in range(9):
        m.d.line([(x0, y0 + (y1 - y0) * i / 9.0), (x1, y0 + (y1 - y0) * i / 9.0)],
                 fill=shade(TRACK_MET, 0.55), width=2)
    for i in range(7):
        f = i / 7.0
        m.d.rectangle([x0 + (x1 - x0) * f, y0, x0 + (x1 - x0) * (f + 0.15), y1],
                      fill=shade((96, 74, 60), 0.55 + f * 0.55))

    # burner can (nozzle throat): black with a dull heat glow
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

    # trim cell: mechanical dark steel (pylons, rails, edges, doors)
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


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_side(m)
    paint_top(m)
    paint_bot(m)
    paint_canopy(m)
    paint_fin(m)
    paint_cells(m)

    # ── weathering: hard-flown interceptor ──
    wx = PL.standard_weather(m, L, ground_rects=(L.F_GEAR.rect,),
                             side_zones=(), seed=53, mud=0.35, grime=0.5,
                             rust_fraction=0.35)
    # airframe: thin grime, no mud — it lives in the air
    wx.mud_band(L.F_SIDE.rect, 0.20, fade='down', dust=0.30, spatter=False)
    wx.mud_band(L.F_TOP.rect, 0.14, fade=None, spatter=False)
    wx.mud_band(L.F_BOT.rect, 0.30, fade=None, spatter=False)
    wx.mud_band(L.F_FIN.rect, 0.12, fade=None, spatter=False)
    # soot: aft of both nozzles (side + top bands) and around the burner cans
    sx0, sy0, sx1, sy1 = L.F_SIDE.rect
    wx.soot_patch((SU(4.2), sy0, sx1, sy1), 0.65)
    tx0, ty0, tx1, ty1 = L.F_TOP.rect
    wx.soot_patch((TU(4.2), ty0, tx1, ty1), 0.5)
    wx.soot_patch(L.F_NOZZLE, 0.7)
    wx.soot_patch(L.F_BURNER.rect, 0.8)
    # gun-gas staining aft of the nose gun port on the underside
    wx.soot_patch((BU(-6.6), BV(0.05), BU(-4.6), BV(0.8)), 0.45)
    # exhaust/oil streaks off the boom flanks
    for f in (0.30, 0.52, 0.74):
        wx.rust_streak(sx0 + (sx1 - sx0) * f, SV(2.05), 30, width=2.2,
                       strength=0.30)
    wx.oily(L.F_GEAR.rect, 0.4)
    wx.plate_bottom_rust(L.F_SIDE.rect, n=5, strength=0.4)

    # ── height detail ──
    from normals import HeightMap
    hm = HeightMap()
    hm.rect(rect(TU(-3.6), TV(-0.34), TU(5.0), TV(0.34)), 0.55)   # spine
    for s in (1, -1):
        bx = s * L.BOOM_X
        hm.rect(rect(TU(-4.2), TV(bx - 0.30), TU(4.6), TV(bx + 0.30)), 0.35)
    x0, y0, x1, y1 = L.F_NOZZLE
    for i in range(9):
        yy = y0 + (y1 - y0) * i / 9.0
        hm.line((x0, yy), (x1, yy), -0.4, width=2)
    PL.finish(m, L, 'ms_fighters_s3', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
