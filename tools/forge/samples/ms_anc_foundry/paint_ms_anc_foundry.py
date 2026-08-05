"""paint_ms_anc_foundry — 2048² PBR set for ms_anc_foundry.

ANCIENT REGISTER: monolithic, precise, seamless. Large unbroken alloy
faces segmented by clean RECESSED seams — no rivets, no bolted patches, no
scrap, no rust. Emissive CYAN is the signature and it is DORMANT here: dim
embers in the tracery and vent throats, a little more life in the core
shaft and the apex lens, brightest where the pour gate still remembers its
work. Weathering is geological — dust drift, soil burial at the foot,
scorch from the last pour, and slag spill gone to glass.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_foundry_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, shade, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS, M_ARMOR, M_GLASS, BLACKISH)

W = 2048

ANC       = (68, 74, 80)      # monolithic alloy — one material, everywhere
ANC_LT    = (80, 87, 93)
ANC_DK    = (54, 59, 64)
ANC_DEEP  = (38, 42, 46)      # recessed seam floor
SOIL      = (88, 78, 62)      # drifted dust / burial
SOIL_DK   = (63, 56, 45)
SCORCH    = (31, 29, 27)
GLASSLG   = (34, 47, 52)      # slag gone to glass
GLASS_HI  = (66, 94, 102)
CYAN      = (60, 235, 255)
CYAN_DIM  = (26, 92, 104)     # dormant tracery in the diffuse
CYAN_DEEP = (16, 54, 62)

RNG = np.random.default_rng(90210)

VENT_ROWS = [(5.4, 0), (11.6, 1), (17.8, 2), (23.2, 3)]


def emi_line(m, a, b, k, width=3, dif=CYAN_DIM):
    m.d.line([a, b], fill=dif, width=width + 1)
    m.e.line([a, b], fill=shade(CYAN, k), width=width)


# ── the ziggurat flanks ─────────────────────────────────────────────────

def paint_flank(m, zone, dim_idx):
    """One continuous world-projected flank cell (all five tiers at once)."""
    u, v = PL.zone_fns(zone)
    x0, y0, x1, y1 = zone.rect
    halfs = [(s[2] if dim_idx == 0 else s[0]) / 2.0 for _c, s in L.TIERS]

    fill(m, zone.rect, dif=ANC, ao=AO_BASE - 2, rough=R_ARMOR + 6,
         metal=M_ARMOR + 40)

    # clean recessed horizontal seams — the only division of the mass
    for wy in np.arange(2.4, 29.6, 2.4):
        yy = v(wy)
        m.d.line([(x0, yy), (x1, yy)], fill=ANC_DEEP, width=3)
        m.d.line([(x0, yy + 3), (x1, yy + 3)], fill=ANC_LT, width=1)
        m.o.line([(x0, yy), (x1, yy)], fill=(AO_SEAM, R_ARMOR, M_ARMOR),
                 width=3)
    # vertical seams: large panels, tone-on-tone (never through the centre)
    for wa in (-11.5, -7.5, -3.5, 3.5, 7.5, 11.5):
        xx = u(wa)
        m.d.line([(xx, v(29.5)), (xx, v(0.2))], fill=ANC_DEEP, width=3)
        m.d.line([(xx + 3, v(29.5)), (xx + 3, v(0.2))], fill=ANC_LT, width=1)
    # step lines at every tier top: a heavier recess
    for wy in L.TIER_TOPS:
        yy = v(wy)
        m.d.rectangle([x0, yy - 6, x1, yy], fill=ANC_DEEP)
        m.o.rectangle([x0, yy - 6, x1, yy], fill=(AO_SEAM, R_ARMOR, M_ARMOR))

    # dormant cyan tracery: two grooves the full height + a band per step
    for wa in (-5.5, 5.5):
        xx = u(wa)
        emi_line(m, (xx, v(29.2)), (xx, v(1.2)), 0.28, width=3)
    for i, wy in enumerate(L.TIER_TOPS):
        h = halfs[i] - 1.4
        emi_line(m, (u(-h), v(wy - 1.1)), (u(h), v(wy - 1.1)), 0.22, width=3)

    # rows of clean vents (recessed slot banks, tone-controlled)
    for (wy, ti) in VENT_ROWS:
        h = halfs[ti] - 2.2
        va, vb = v(wy + 0.35), v(wy - 0.35)
        m.d.rectangle([u(-h), va, u(h), vb], fill=shade(ANC, 0.88))
        m.o.rectangle([u(-h), va, u(h), vb],
                      fill=(AO_SEAM, R_ARMOR + 10, M_ARMOR))
        step = 1.15
        wa = -h + 0.4
        while wa < h - 0.4:
            m.d.rectangle([u(wa), va + 4, u(wa + 0.36), vb - 4], fill=ANC_DEEP)
            m.e.rectangle([u(wa), vb - 9, u(wa + 0.36), vb - 6],
                          fill=shade(CYAN, 0.16))
            wa += step

    # geological burial: soil packed against the foot, irregular tide line
    for px in range(int(x0), int(x1), 6):
        h = 1.0 + 1.3 * RNG.random()
        m.d.rectangle([px, v(h), px + 6, v(0.0)], fill=SOIL_DK)
    m.d.rectangle([x0, v(0.45), x1, v(0.0)], fill=shade(SOIL_DK, 0.82))

    if dim_idx == 1:      # the pour side: scorch fanning off the gate
        cx, cy = u(0.0), v(6.0)
        for r, k in ((330, 0.42), (240, 0.30), (150, 0.20)):
            col = tuple(int(a * (1 - k) + b * k) for a, b in zip(ANC, SCORCH))
            m.d.ellipse([cx - r * 1.35, cy - r, cx + r * 1.35, cy + r],
                        outline=col, width=int(r * 0.30))


def paint_shelf(m):
    """Every tier top shares one concentric cell — dust settles up here."""
    z = L.R_SHELF
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=ANC_LT, ao=AO_BASE - 4, rough=R_ARMOR + 8,
         metal=M_ARMOR + 40)
    for r in (5.75, 8.0, 10.5, 13.25, 15.4):
        m.d.rectangle([u(-r), v(-r), u(r), v(r)], outline=ANC_DEEP, width=4)
        m.o.rectangle([u(-r), v(-r), u(r), v(r)],
                      fill=None, outline=(AO_SEAM, R_ARMOR, M_ARMOR), width=4)
    for r in (6.6, 9.2, 11.8, 14.3):
        m.d.rectangle([u(-r), v(-r), u(r), v(r)], outline=CYAN_DEEP, width=3)
        m.e.rectangle([u(-r), v(-r), u(r), v(r)],
                      outline=shade(CYAN, 0.18), width=2)
    # wind-drifted dust on the shelves
    for _ in range(260):
        a = RNG.uniform(-15, 15)
        b = RNG.uniform(-15, 15)
        r = RNG.uniform(0.4, 1.9)
        m.d.ellipse([u(a - r), v(b - r), u(a + r), v(b + r)],
                    fill=shade(SOIL_DK, 0.9 + 0.2 * RNG.random()))


def paint_cornice(m):
    z = L.R_CORNICE
    fill(m, z.rect, dif=ANC_LT, ao=AO_BASE - 6, rough=R_ARMOR + 2,
         metal=M_ARMOR + 50)
    x0, y0, x1, y1 = z.rect
    m.d.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6], outline=shade(ANC_LT, 0.88),
                  width=5)


# ── cantilevered casting halls ──────────────────────────────────────────

def paint_halls(m):
    x0, y0, x1, y1 = L.R_HALL_SIDE
    fill(m, L.R_HALL_SIDE, dif=ANC, ao=AO_BASE - 2, rough=R_ARMOR + 4,
         metal=M_ARMOR + 40)
    h = y1 - y0
    for f in (0.24, 0.62):
        m.d.line([(x0, y0 + h * f), (x1, y0 + h * f)], fill=ANC_DEEP, width=4)
        m.d.line([(x0, y0 + h * f + 4), (x1, y0 + h * f + 4)], fill=ANC_LT,
                 width=1)
    # slot bank along the upper flank
    for i in range(16):
        sx = x0 + 24 + i * ((x1 - x0 - 48) / 16)
        m.d.rectangle([sx, y0 + h * 0.08, sx + 12, y0 + h * 0.20],
                      fill=ANC_DEEP)
    # the casting line still glows, faintly, under the cantilever
    emi_line(m, (x0 + 10, y0 + h * 0.86), (x1 - 10, y0 + h * 0.86), 0.30,
             width=4)

    # end wall = the casting mouth: a deep recess with embers inside
    x0, y0, x1, y1 = L.R_HALL_END
    fill(m, L.R_HALL_END, dif=ANC_DK, ao=AO_BASE - 4, rough=R_ARMOR + 8,
         metal=M_ARMOR + 30)
    ix0, iy0 = x0 + (x1 - x0) * 0.16, y0 + (y1 - y0) * 0.20
    ix1, iy1 = x1 - (x1 - x0) * 0.16, y1 - (y1 - y0) * 0.14
    m.d.rectangle([ix0, iy0, ix1, iy1], fill=CYAN_DEEP)
    m.o.rectangle([ix0, iy0, ix1, iy1], fill=(AO_DEEP, R_ARMOR + 20, M_ARMOR))
    m.e.rectangle([ix0 + 10, iy0 + 10, ix1 - 10, iy1 - 10],
                  fill=shade(CYAN, 0.22))
    m.d.rectangle([ix0, iy0, ix1, iy1], outline=CYAN_DIM, width=4)
    m.e.rectangle([ix0, iy0, ix1, iy1], outline=shade(CYAN, 0.40), width=3)

    x0, y0, x1, y1 = L.R_HALL_TOP
    fill(m, L.R_HALL_TOP, dif=ANC_LT, ao=AO_BASE - 5, rough=R_ARMOR + 10,
         metal=M_ARMOR + 40)
    for f in (0.3, 0.7):
        m.d.line([(x0, y0 + (y1 - y0) * f), (x1, y0 + (y1 - y0) * f)],
                 fill=shade(ANC_LT, 0.86), width=5)
    for _ in range(160):     # dust
        px, py = RNG.uniform(x0, x1), RNG.uniform(y0, y1)
        r = RNG.uniform(2, 9)
        m.d.ellipse([px, py, px + r, py + r], fill=shade(SOIL_DK, 0.95))


def paint_pylon(m):
    x0, y0, x1, y1 = L.R_PYLON
    fill(m, L.R_PYLON, dif=ANC, ao=AO_BASE - 2, rough=R_ARMOR + 4,
         metal=M_ARMOR + 50)
    w = x1 - x0
    for f in (0.32, 0.68):                     # never through the centre
        emi_line(m, (x0 + w * f, y0 + 14), (x0 + w * f, y1 - 14), 0.26,
                 width=4)
    for f in (0.14, 0.5, 0.86):
        m.d.line([(x0 + w * f, y0), (x0 + w * f, y1)], fill=ANC_DEEP, width=3)
    for f in (0.10, 0.22):
        m.d.line([(x0, y0 + (y1 - y0) * f), (x1, y0 + (y1 - y0) * f)],
                 fill=ANC_DEEP, width=3)


def paint_vent(m):
    x0, y0, x1, y1 = L.R_VENT
    fill(m, L.R_VENT, dif=ANC_DK, ao=AO_BASE - 8, rough=R_ARMOR + 14,
         metal=M_ARMOR + 20)
    h = y1 - y0
    for f in (0.18, 0.36, 0.64, 0.82):
        m.d.rectangle([x0 + 12, y0 + h * f, x1 - 12, y0 + h * f + 14],
                      fill=ANC_DEEP)
        m.o.rectangle([x0 + 12, y0 + h * f, x1 - 12, y0 + h * f + 14],
                      fill=(AO_DEEP, R_ARMOR + 18, M_ARMOR))
    emi_line(m, (x0 + 12, y0 + h * 0.94), (x1 - 12, y0 + h * 0.94), 0.24,
             width=3)


# ── pour gate, core, gantries ───────────────────────────────────────────

def paint_gate(m):
    z = L.R_GATE
    u, v = PL.zone_fns(z)
    fill(m, z.rect, dif=ANC, ao=AO_BASE, rough=R_ARMOR + 4, metal=M_ARMOR + 40)
    gx, gy = 0.0, L.GATE_C[1]

    def circ(r, **kw):
        return [u(gx - r), v(gy + r), u(gx + r), v(gy - r)]

    m.d.ellipse(circ(3.55), fill=ANC_DK)
    m.d.ellipse(circ(3.10), fill=shade(ANC_DEEP, 0.8))
    m.o.ellipse(circ(3.10), fill=(AO_DEEP, R_ARMOR + 20, M_ARMOR))
    for r, k in ((2.55, 0.44), (1.70, 0.54), (0.95, 0.64)):
        m.d.ellipse(circ(r), outline=CYAN_DIM, width=6)
        m.e.ellipse(circ(r), outline=shade(CYAN, k), width=4)
    m.d.ellipse(circ(0.48), fill=CYAN_DEEP)
    m.e.ellipse(circ(0.48), fill=shade(CYAN, 0.58))
    # the last pour: scorch dripping from the gate lip
    for a in RNG.uniform(np.pi * 0.15, np.pi * 0.85, 14):
        r0, r1 = 3.2, 4.3
        m.d.line([(u(gx + r0 * np.cos(a)), v(gy - r0 * np.sin(a))),
                  (u(gx + r1 * np.cos(a)), v(gy - r1 * np.sin(a)))],
                 fill=SCORCH, width=int(RNG.uniform(4, 11)))

    x0, y0, x1, y1 = L.R_GATERING
    fill(m, L.R_GATERING, dif=ANC_LT, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR + 60)
    emi_line(m, (x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2), 0.34, width=5)


def paint_core(m):
    """Shaft wrap: u runs the shaft's length, v runs around it."""
    x0, y0, x1, y1 = L.R_SHAFT
    fill(m, L.R_SHAFT, dif=ANC_DK, ao=AO_BASE - 6, rough=R_ARMOR - 6,
         metal=M_ARMOR + 60)
    h = y1 - y0
    # rings around the shaft (constant-u lines)
    for f in (0.16, 0.34, 0.52, 0.70, 0.88):
        m.d.line([(x0 + (x1 - x0) * f, y0), (x0 + (x1 - x0) * f, y1)],
                 fill=ANC_DEEP, width=5)
    # four longitudinal cyan channels, aligned to facet centres so the
    # silhouette reads as a lit core even at impostor range
    for j in (1, 4, 7, 10):
        cy = y0 + h * (2 * j + 1) / 24.0
        m.d.rectangle([x0, cy - h / 26, x1, cy + h / 26], fill=CYAN_DEEP)
        m.e.rectangle([x0, cy - h / 30, x1, cy + h / 30], fill=shade(CYAN, 0.42))
        m.d.line([(x0, cy), (x1, cy)], fill=CYAN_DIM, width=5)
        m.e.line([(x0, cy), (x1, cy)], fill=shade(CYAN, 0.62), width=4)

    x0, y0, x1, y1 = L.R_COLLAR
    fill(m, L.R_COLLAR, dif=ANC_DK, ao=AO_BASE - 4, rough=R_ARMOR - 8,
         metal=M_ARMOR + 70)
    m.d.rectangle([x0, y0 + (y1 - y0) * 0.38, x1, y0 + (y1 - y0) * 0.62],
                  fill=CYAN_DEEP)
    emi_line(m, (x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2), 0.50, width=6)

    # apex / stud / ladle lens
    z = L.R_LENS
    u, v = PL.zone_fns(z)
    fill(m, z.rect, dif=ANC_DK, ao=AO_BASE - 4, rough=R_GLASS, metal=M_GLASS)
    for r, dc, k in ((3.0, CYAN_DEEP, 0.30), (2.0, CYAN_DIM, 0.55),
                     (1.1, shade(CYAN, 0.5), 0.85)):
        box = [u(-r), v(-r), u(r), v(r)]
        m.d.ellipse(box, fill=dc)
        m.e.ellipse(box, fill=shade(CYAN, k))

    x0, y0, x1, y1 = L.R_ARM
    fill(m, L.R_ARM, dif=ANC, ao=AO_BASE - 2, rough=R_ARMOR + 4,
         metal=M_ARMOR + 50)
    m.d.line([(x0, y0 + (y1 - y0) * 0.28), (x1, y0 + (y1 - y0) * 0.28)],
             fill=ANC_DEEP, width=4)
    emi_line(m, (x0, y0 + (y1 - y0) * 0.72), (x1, y0 + (y1 - y0) * 0.72),
             0.22, width=3)
    # soot at the working end of the arms
    m.d.rectangle([x1 - (x1 - x0) * 0.22, y0, x1, y1], fill=shade(ANC, 0.62))

    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=M_ARMOR)


# ── ground: burial, scorch, slag glass ──────────────────────────────────

def paint_ground(m):
    z = L.R_GLASS_TOP
    u, v = PL.zone_fns(z)
    fill(m, z.rect, dif=SOIL_DK, ao=AO_BASE, rough=R_ARMOR + 24, metal=8)

    # drifted dust piled against the mass
    for _ in range(500):
        a = RNG.uniform(-33, 33)
        b = RNG.uniform(-33, 33)
        r = RNG.uniform(0.8, 3.4)
        m.d.ellipse([u(a - r), v(b - r), u(a + r), v(b + r)],
                    fill=shade(SOIL if RNG.random() < 0.5 else SOIL_DK,
                               0.9 + 0.25 * RNG.random()))

    # scorch running out of the pour gate (world x 0, z -15)
    for a in RNG.uniform(np.pi * 0.75, np.pi * 1.25, 40):
        r0, r1 = 15.0, RNG.uniform(19.0, 33.0)
        m.d.line([(u(r0 * np.cos(a - np.pi / 2) * 0.5),
                   v(-15 - (r0 - 15) * 0.5)),
                  (u((r1 - 15) * np.cos(a) * 0.9),
                   v(-15 - (r1 - 15) * 0.9))],
                 fill=SCORCH, width=int(RNG.uniform(8, 26)))

    # the slag itself: gone to glass, cracked, a memory of heat inside
    for (cx, _cy, cz), r, _n in L.POOLS:
        m.d.ellipse([u(cx - r * 1.06), v(cz - r * 1.06),
                     u(cx + r * 1.06), v(cz + r * 1.06)], fill=GLASSLG)
        m.o.ellipse([u(cx - r), v(cz - r), u(cx + r), v(cz + r)],
                    fill=(AO_BASE, R_GLASS + 20, M_GLASS // 2))
        for _ in range(26):     # crackle
            a0 = RNG.uniform(0, 2 * np.pi)
            r0 = RNG.uniform(0, r * 0.85)
            a1 = a0 + RNG.uniform(-0.9, 0.9)
            r1 = min(r * 0.98, r0 + RNG.uniform(1.5, 5.0))
            m.d.line([(u(cx + r0 * np.cos(a0)), v(cz + r0 * np.sin(a0))),
                      (u(cx + r1 * np.cos(a1)), v(cz + r1 * np.sin(a1)))],
                     fill=GLASS_HI, width=2)
        for _ in range(7):      # embers still trapped in the glass
            a0 = RNG.uniform(0, 2 * np.pi)
            r0 = RNG.uniform(0, r * 0.7)
            px, py = u(cx + r0 * np.cos(a0)), v(cz + r0 * np.sin(a0))
            ln = RNG.uniform(1.2, 3.5)
            p1 = (u(cx + (r0 + ln) * np.cos(a0 + 0.4)),
                  v(cz + (r0 + ln) * np.sin(a0 + 0.4)))
            emi_line(m, (px, py), p1, 0.30, width=2)

    fill(m, L.R_GLASS_S.rect, dif=shade(SOIL_DK, 0.82), ao=AO_BASE - 8,
         rough=R_ARMOR + 26, metal=8)


def paint_all():
    m = Maps()
    paint_flank(m, L.R_TIER_X, 0)
    paint_flank(m, L.R_TIER_Z, 1)
    paint_shelf(m)
    paint_cornice(m)
    paint_halls(m)
    paint_pylon(m)
    paint_vent(m)
    paint_gate(m)
    paint_core(m)
    paint_ground(m)

    # geological weathering only — dust and burial, never rust from bolts
    wx = PL.standard_weather(m, L, ground_rects=(L.R_GLASS_S.rect,),
                             side_zones=(L.R_TIER_X, L.R_TIER_Z),
                             seed=41, mud=0.42, grime=0.45, rust_fraction=0.0)
    wx.soot_patch(L.R_GATE.rect, 0.35)
    wx.soot_patch(L.R_ARM, 0.30, fade='right')

    hm = NM.HeightMap()
    for z in (L.R_TIER_X, L.R_TIER_Z):
        x0, y0, x1, y1 = z.rect
        _u, v = PL.zone_fns(z)
        for wy in np.arange(2.4, 29.6, 2.4):
            hm.line((x0, v(wy)), (x1, v(wy)), -0.7, width=3)
        for wy in L.TIER_TOPS:
            hm.line((x0, v(wy) - 3), (x1, v(wy) - 3), -1.0, width=6)
    su, sv = PL.zone_fns(L.R_SHELF)
    for r in (5.75, 8.0, 10.5, 13.25, 15.4):
        a, b, c, d = su(-r), sv(-r), su(r), sv(r)
        for p0, p1 in (((a, b), (c, b)), ((c, b), (c, d)),
                       ((c, d), (a, d)), ((a, d), (a, b))):
            hm.line(p0, p1, -0.5, width=4)

    PL.finish(m, L, 'ms_anc_foundry', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
