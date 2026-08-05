"""paint_ms_anc_gate — 2048² PBR set for ms_anc_gate.

ANCIENT REGISTER: monolithic, precise, seamless. Large unbroken pale-basalt
alloy surfaces segmented only by clean recessed seams — no rivets, no bolted
patches, no scrap. Emissive CYAN is the signature and is DORMANT here: dim
embers in the inner-rim tracery and node lenses, not a flowing circuit.
Weathering is geological — dust films, soil burial at the plinth base,
scorch under the portal — never rust streaks from fittings.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_gate_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, shade, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, M_ARMOR, R_GLASS, M_GLASS, BLACKISH)

W = 2048
ANC      = (116, 122, 130)    # pale basalt-alloy — the ancient monolith tone
ANC_LT   = (138, 144, 152)
ANC_DK   = (88, 93, 100)
ANC_TEAL = (78, 96, 104)      # inner rim: alloy with a cool cast
SEAM     = (44, 47, 52)
DUST     = (156, 145, 122)
SOIL     = (84, 70, 54)
SCORCH   = (42, 40, 38)
CYAN     = (60, 235, 255)
CYAN_DIM = (44, 150, 168)     # dormant tracery in diffuse
E_LOW, E_MID, E_HI = 0.32, 0.48, 0.72   # dormant ember levels

RNG = np.random.default_rng(90210)
SEAMS = []          # (xy0, xy1, width) recessed seams -> normal map
HM = None


def seam_line(m, a, b, width=4, col=SEAM):
    m.d.line([a, b], fill=col, width=width)
    SEAMS.append((a, b, width))


def rmap(rect):
    """Parametric (u,v) fraction -> atlas px for the ring/cradle wraps."""
    x0, y0, x1, y1 = rect
    return (lambda f: x0 + (x1 - x0) * f, lambda f: y0 + (y1 - y0) * f)


# ───────────────────────────────────────────────────────── plinth
def paint_plinth(m):
    z = L.R_PL_TOP
    u, v = PL.zone_fns(z)
    fill(m, z.rect, dif=ANC, ao=AO_BASE, rough=R_ARMOR + 6, metal=M_ARMOR + 25)

    # concentric step footprints — tone-on-tone terraces, recessed seams
    for (cx, cy, cz, w, d), tone in (((L.T2[0], 0, L.T2[2], L.T2[3], L.T2[5]),
                                      1.06),
                                     ((L.DAIS[0], 0, L.DAIS[2], L.DAIS[3],
                                       L.DAIS[5]), 1.20)):
        box = PL.nbox(u(cx - w / 2), v(cz - d / 2), u(cx + w / 2), v(cz + d / 2))
        m.d.rectangle(box, fill=shade(ANC, tone))
        m.d.rectangle(box, outline=SEAM, width=5)
        SEAMS.append(((box[0], box[1]), (box[2], box[1]), 5))
        SEAMS.append(((box[0], box[3]), (box[2], box[3]), 5))
        SEAMS.append(((box[0], box[1]), (box[0], box[3]), 5))
        SEAMS.append(((box[2], box[1]), (box[2], box[3]), 5))

    # scorch pooled under the portal opening (geological, not mechanical)
    cx, cz = u(0.0), v(0.0)
    for rr, k in ((6.1, 0.16), (4.8, 0.24), (3.6, 0.30)):
        rx, ry = rr * abs(u(1.0) - u(0.0)), rr * abs(v(1.0) - v(0.0))
        col = tuple(int(a * (1 - k) + b * k)
                    for a, b in zip(shade(ANC, 1.20), SCORCH))
        m.d.ellipse([cx - rx, cz - ry, cx + rx, cz + ry], fill=col)

    # THE PERFECT CIRCLE: inscribed dormant ring on the dais, dead centre
    for rr, wdt, ecol in ((2.85, 10, E_MID), (2.35, 6, E_LOW)):
        rx, ry = rr * abs(u(1.0) - u(0.0)), rr * abs(v(1.0) - v(0.0))
        m.d.ellipse([cx - rx, cz - ry, cx + rx, cz + ry],
                    outline=CYAN_DIM, width=wdt)
        m.e.ellipse([cx - rx, cz - ry, cx + rx, cz + ry],
                    outline=shade(CYAN, ecol), width=max(2, wdt - 2))
    # eight radial grooves off the circle to the dais edge
    for i in range(8):
        a = np.pi * 2 * i / 8 + np.pi / 8
        p0 = (cx + 2.9 * np.cos(a) * abs(u(1.0) - u(0.0)),
              cz + 2.9 * np.sin(a) * abs(v(1.0) - v(0.0)))
        p1 = (cx + 5.4 * np.cos(a) * abs(u(1.0) - u(0.0)),
              cz + 5.4 * np.sin(a) * abs(v(1.0) - v(0.0)))
        m.d.line([p0, p1], fill=CYAN_DIM, width=4)
        m.e.line([p0, p1], fill=shade(CYAN, E_LOW * 0.7), width=2)
        SEAMS.append((p0, p1, 4))

    # dust drift blown against the outer terrace
    for _ in range(90):
        dx = RNG.uniform(z.rect[0], z.rect[2])
        dy = RNG.uniform(z.rect[1], z.rect[3])
        r = RNG.uniform(6, 22)
        m.d.ellipse([dx - r, dy - r * 0.55, dx + r, dy + r * 0.55],
                    fill=shade(DUST, RNG.uniform(0.42, 0.60)))

    # plinth flanks: three clean terraces, soil burial at grade
    for zz in (L.R_PL_SX, L.R_PL_SZ):
        uu, vv = PL.zone_fns(zz)
        x0, y0, x1, y1 = zz.rect
        fill(m, zz.rect, dif=ANC_DK, ao=AO_BASE - 6, rough=R_ARMOR + 10,
             metal=M_ARMOR + 25)
        for ys in (L.PL_T2_TOP, 1.40):
            seam_line(m, (x0, vv(ys)), (x1, vv(ys)), 5)
        # shallow vertical recessed seams every ~3.4 m
        span = zz.win[0]
        for t in np.linspace(0.08, 0.92, 9):
            lx = x0 + (x1 - x0) * t
            m.d.line([(lx, y0 + 3), (lx, vv(0.05))], fill=shade(ANC_DK, 0.84),
                     width=3)
        # dormant cyan hairline riding the upper terrace
        m.d.line([(x0, vv(2.05)), (x1, vv(2.05))], fill=CYAN_DIM, width=4)
        m.e.line([(x0, vv(2.05)), (x1, vv(2.05))], fill=shade(CYAN, E_LOW),
                 width=2)
        # buried base: soil creeping up a ragged 0.45 m
        for t in np.linspace(0, 1, 120):
            lx = x0 + (x1 - x0) * t
            hgt = vv(RNG.uniform(0.22, 0.52))
            m.d.line([(lx, hgt), (lx, y1)], fill=shade(SOIL,
                     RNG.uniform(0.85, 1.15)), width=8)


# ───────────────────────────────────────────────────────── uprights
def paint_uprights(m):
    for zz in (L.R_UP_X, L.R_UP_ZR):
        uu, vv = PL.zone_fns(zz)
        x0, y0, x1, y1 = zz.rect
        fill(m, zz.rect, dif=ANC, ao=AO_BASE - 2, rough=R_ARMOR,
             metal=M_ARMOR + 30)
        # segment joins: clean recessed seams (nothing bolted)
        for ys in (9.40, 16.40):
            seam_line(m, (x0, vv(ys)), (x1, vv(ys)), 7)
            m.d.rectangle([x0, vv(ys) + 4, x1, vv(ys) + 26],
                          fill=shade(ANC, 1.07))
        # two shallow vertical seams — tone-on-tone (big-quad baker rule)
        for t in (0.30, 0.70):
            lx = x0 + (x1 - x0) * t
            m.d.line([(lx, vv(24.1)), (lx, vv(2.9))], fill=shade(ANC, 0.89),
                     width=4)
            SEAMS.append(((lx, vv(24.1)), (lx, vv(2.9)), 4))
        # DORMANT TRACERY: one spine the full height + cross-links at joins
        sx = x0 + (x1 - x0) * 0.50
        m.d.line([(sx, vv(23.9)), (sx, vv(3.1))], fill=CYAN_DIM, width=6)
        m.e.line([(sx, vv(23.9)), (sx, vv(3.1))], fill=shade(CYAN, E_LOW),
                 width=3)
        for ys in (9.40, 16.40, 21.6):
            la, lb = x0 + (x1 - x0) * 0.30, x0 + (x1 - x0) * 0.70
            m.d.line([(la, vv(ys - 0.5)), (lb, vv(ys - 0.5))], fill=CYAN_DIM,
                     width=5)
            m.e.line([(la, vv(ys - 0.5)), (lb, vv(ys - 0.5))],
                     fill=shade(CYAN, E_MID), width=3)
        # scorch + soil at the foot
        m.d.rectangle([x0, vv(3.05), x1, vv(2.2)], fill=shade(ANC, 0.55))
        for t in np.linspace(0, 1, 90):
            lx = x0 + (x1 - x0) * t
            m.d.line([(lx, vv(RNG.uniform(2.75, 3.25))), (lx, vv(2.2))],
                     fill=shade(SOIL, RNG.uniform(0.85, 1.1)), width=8)

    # upright top shelves
    zz = L.R_UP_TR
    uu, vv = PL.zone_fns(zz)
    x0, y0, x1, y1 = zz.rect
    fill(m, zz.rect, dif=ANC_LT, ao=AO_BASE - 4, rough=R_ARMOR + 4,
         metal=M_ARMOR + 30)
    m.d.rectangle([x0 + 60, y0 + 60, x1 - 60, y1 - 60],
                  outline=SEAM, width=6)
    SEAMS.append((((x0 + 60), (y0 + 60)), ((x1 - 60), (y0 + 60)), 6))
    SEAMS.append((((x0 + 60), (y1 - 60)), ((x1 - 60), (y1 - 60)), 6))
    m.d.rectangle([x0 + 130, y0 + 130, x1 - 130, y1 - 130],
                  fill=shade(ANC_LT, 0.93))
    for _ in range(40):
        dx, dy = RNG.uniform(x0, x1), RNG.uniform(y0, y1)
        r = RNG.uniform(8, 26)
        m.d.ellipse([dx - r, dy - r * 0.6, dx + r, dy + r * 0.6],
                    fill=shade(DUST, RNG.uniform(0.40, 0.58)))


# ───────────────────────────────────────────────────────── yoke + keystone
def paint_brackets(m):
    for zz in (L.R_YK_X, L.R_YK_ZR, L.R_YK_YR):
        fill(m, zz.rect, dif=ANC_DK, ao=AO_BASE - 8, rough=R_ARMOR - 6,
             metal=M_ARMOR + 55)
    # cantilever spine: a dormant conduit running out to the cradle
    for zz in (L.R_YK_X, L.R_YK_ZR):
        x0, y0, x1, y1 = zz.rect
        my = (y0 + y1) // 2
        m.d.line([(x0 + 4, my), (x1 - 4, my)], fill=CYAN_DIM, width=8)
        m.e.line([(x0 + 4, my), (x1 - 4, my)], fill=shade(CYAN, E_MID), width=4)
        seam_line(m, (x0, y0 + (y1 - y0) * 0.22), (x1, y0 + (y1 - y0) * 0.22), 5)
        seam_line(m, (x0, y0 + (y1 - y0) * 0.78), (x1, y0 + (y1 - y0) * 0.78), 5)

    # floating keystone — brightest dormant element, it is the focus
    for zz in (L.R_KEY_X, L.R_KEY_Z, L.R_KEY_Y):
        x0, y0, x1, y1 = zz.rect
        fill(m, zz.rect, dif=ANC, ao=AO_BASE, rough=R_ARMOR - 10,
             metal=M_ARMOR + 60)
        m.d.rectangle([x0 + 10, y0 + (y1 - y0) * 0.40,
                       x1 - 10, y0 + (y1 - y0) * 0.60], fill=CYAN_DIM)
        m.e.rectangle([x0 + 14, y0 + (y1 - y0) * 0.43,
                       x1 - 14, y0 + (y1 - y0) * 0.57],
                      fill=shade(CYAN, E_HI))
        seam_line(m, (x0, y0 + (y1 - y0) * 0.24), (x1, y0 + (y1 - y0) * 0.24), 5)
        seam_line(m, (x0, y0 + (y1 - y0) * 0.76), (x1, y0 + (y1 - y0) * 0.76), 5)


# ───────────────────────────────────────────────────────── ring + cradle
def paint_ring(m):
    n = L.RING_N

    def is_boss(k):
        return (k % L.BOSS_MOD) in (0, 1)

    # outer band
    ru, rv = rmap(L.R_RING_OUT)
    fill(m, L.R_RING_OUT, dif=ANC, ao=AO_BASE, rough=R_ARMOR - 6,
         metal=M_ARMOR + 55)
    for k in range(n):
        if is_boss(k):
            m.d.rectangle([ru(k / n), rv(0.0), ru((k + 1) / n), rv(1.0)],
                          fill=shade(ANC, 1.22))
    for k in range(0, n, 3):          # 24 clean recessed segment seams
        lx = ru(k / n)
        seam_line(m, (lx, rv(0.0)), (lx, rv(1.0)), 5)
    m.d.line([(ru(0), rv(0.50)), (ru(1.0), rv(0.50))],
             fill=shade(ANC, 0.90), width=6)

    # inner rim — THE signature surface. Cool alloy base so the impostor
    # reads cyan-cast, with dormant ember tracery on top for the real render.
    ru, rv = rmap(L.R_RING_IN)
    fill(m, L.R_RING_IN, dif=ANC_TEAL, ao=AO_BASE - 6, rough=R_ARMOR - 20,
         metal=M_ARMOR + 50)
    m.d.rectangle([ru(0), rv(0.44), ru(1.0), rv(0.56)], fill=CYAN_DIM)
    m.e.rectangle([ru(0), rv(0.45), ru(1.0), rv(0.55)],
                  fill=shade(CYAN, E_MID))
    for k in range(n):
        if is_boss(k):
            a, b = ru(k / n), ru((k + 1) / n)
            m.d.rectangle([a + 3, rv(0.30), b - 3, rv(0.70)],
                          fill=shade(CYAN, 0.30))
            m.e.rectangle([a + 5, rv(0.32), b - 5, rv(0.68)],
                          fill=shade(CYAN, E_HI))
    for k in range(0, n, 3):
        lx = ru(k / n)
        m.d.line([(lx, rv(0.0)), (lx, rv(0.30))], fill=SEAM, width=4)
        m.d.line([(lx, rv(0.70)), (lx, rv(1.0))], fill=SEAM, width=4)

    # ring sides: v=0 outer rim, v=1 inner rim
    ru, rv = rmap(L.R_RING_SIDE)
    fill(m, L.R_RING_SIDE, dif=ANC, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR + 45)
    m.d.rectangle([ru(0), rv(0.0), ru(1.0), rv(0.16)], fill=shade(ANC, 0.93))
    for k in range(0, n, 3):
        lx = ru(k / n)
        seam_line(m, (lx, rv(0.0)), (lx, rv(1.0)), 4)
    # a perfect concentric groove near the inner rim, dormant
    m.d.line([(ru(0), rv(0.74)), (ru(1.0), rv(0.74))], fill=CYAN_DIM, width=7)
    m.e.line([(ru(0), rv(0.74)), (ru(1.0), rv(0.74))],
             fill=shade(CYAN, E_LOW), width=4)
    for k in range(n):
        if is_boss(k):
            a, b = ru(k / n), ru((k + 1) / n)
            m.d.rectangle([a, rv(0.20), b, rv(0.62)], fill=shade(ANC, 1.09))

    # cradle arcs — darker, structural, one dormant line on the gripping face
    for rect, tone in ((L.R_CRA_OUT, 0.94), (L.R_CRA_SIDE, 1.00)):
        cu, cv = rmap(rect)
        fill(m, rect, dif=shade(ANC_DK, tone), ao=AO_BASE - 10,
             rough=R_ARMOR - 4, metal=M_ARMOR + 60)
        for k in range(0, 15, 2):
            lx = cu(k / 14)
            seam_line(m, (lx, cv(0.0)), (lx, cv(1.0)), 4)
    cu, cv = rmap(L.R_CRA_IN)
    fill(m, L.R_CRA_IN, dif=ANC_DK, ao=AO_DEEP, rough=R_ARMOR - 16,
         metal=M_ARMOR + 70)
    m.d.rectangle([cu(0), cv(0.36), cu(1.0), cv(0.64)], fill=CYAN_DIM)
    m.e.rectangle([cu(0), cv(0.38), cu(1.0), cv(0.62)],
                  fill=shade(CYAN, E_MID))


# ───────────────────────────────────────────────────────── conduits
def paint_conduits(m):
    x0, y0, x1, y1 = L.R_CON
    fill(m, L.R_CON, dif=ANC_DK, ao=AO_BASE - 8, rough=R_ARMOR - 4,
         metal=M_ARMOR + 55)
    # u runs from the buried end (u=0) to the exposed cap (u=1)
    bx = x0 + (x1 - x0) * 0.42
    m.d.rectangle([x0, y0, bx, y1], fill=SOIL)
    for t in np.linspace(0.36, 0.52, 30):        # ragged soil waterline
        lx = x0 + (x1 - x0) * t
        m.d.line([(lx, RNG.uniform(y0, y1)), (lx, RNG.uniform(y0, y1))],
                 fill=SOIL, width=9)
    my = (y0 + y1) // 2
    m.d.line([(bx, my), (x1 - 4, my)], fill=CYAN_DIM, width=6)
    m.e.line([(bx, my), (x1 - 4, my)], fill=shade(CYAN, E_LOW), width=3)
    for t in (0.60, 0.78, 0.94):
        lx = x0 + (x1 - x0) * t
        seam_line(m, (lx, y0), (lx, y1), 4)

    # conduit end lens — dormant emitter
    cx0, cy0, cx1, cy1 = L.R_CON_CAP
    fill(m, L.R_CON_CAP, dif=shade(CYAN, 0.22), ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    ccx, ccy = (cx0 + cx1) / 2, (cy0 + cy1) / 2
    r = (cx1 - cx0) * 0.34
    m.d.ellipse([ccx - r, ccy - r, ccx + r, ccy + r], fill=CYAN_DIM)
    m.e.ellipse([ccx - r, ccy - r, ccx + r, ccy + r], fill=shade(CYAN, E_HI))
    m.d.ellipse([cx0 + 8, cy0 + 8, cx1 - 8, cy1 - 8], outline=SEAM, width=6)

    # collar plates, half swallowed by soil
    tx0, ty0, tx1, ty1 = L.R_COL_TOP
    fill(m, L.R_COL_TOP, dif=ANC_DK, ao=AO_BASE - 10, rough=R_ARMOR + 8,
         metal=M_ARMOR + 30)
    tcx, tcy = (tx0 + tx1) / 2, (ty0 + ty1) / 2
    rr = (tx1 - tx0) * 0.30
    m.d.ellipse([tcx - rr, tcy - rr, tcx + rr, tcy + rr], outline=CYAN_DIM,
                width=7)
    m.e.ellipse([tcx - rr, tcy - rr, tcx + rr, tcy + rr],
                fill=None, outline=shade(CYAN, E_LOW), width=4)
    for _ in range(70):
        dx, dy = RNG.uniform(tx0, tx1), RNG.uniform(ty0, ty1)
        r = RNG.uniform(10, 34)
        m.d.ellipse([dx - r, dy - r * 0.7, dx + r, dy + r * 0.7],
                    fill=shade(SOIL, RNG.uniform(0.8, 1.15)))
    fill(m, L.R_COL_SD, dif=SOIL, ao=AO_DEEP, rough=R_ARMOR + 24,
         metal=M_ARMOR)


# ───────────────────────────────────────────────────────── finish
def paint_all():
    m = Maps()
    fill(m, (0, 0, W, W), dif=ANC_DK, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR + 30)
    paint_plinth(m)
    paint_uprights(m)
    paint_brackets(m)
    paint_ring(m)
    paint_conduits(m)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)

    # geological weathering only — dust films, soil at grade, scorch. No rust:
    # nothing on this machine is bolted, so there is nothing to bleed.
    from weathering import Weather
    wx = Weather(seed=53)
    wx.crevice_grime(m.dif, 0.18)
    wx.mud_band(L.R_PL_SX.rect, 0.42, fade='down', dust=0.22)
    wx.mud_band(L.R_PL_SZ.rect, 0.42, fade='down', dust=0.22)
    wx.mud_band(L.R_UP_X.rect, 0.26, fade='down', dust=0.24)
    wx.mud_band(L.R_UP_ZR.rect, 0.26, fade='down', dust=0.24)
    wx.mud_band(L.R_COL_SD, 0.85, fade=None, dust=0.2)
    wx.mud_band(L.R_CON, 0.55, fade='left', dust=0.25)
    wx.soot_patch(L.R_PL_TOP.rect, 0.14)

    hm = NM.HeightMap()
    for (a, b, wdt) in SEAMS:
        hm.line(a, b, -0.75, width=int(wdt))
    PL.finish(m, L, 'ms_anc_gate', hm=hm, wx=wx, emissive_blur=0.9)


if __name__ == '__main__':
    paint_all()
