"""paint_ms_metal_pit — 2048² PBR set for ms_metal_pit (resource site).

Working-mine read: ore-stained concrete pad with hazard border, rusted
oxide-red headframe lattice with galvanised deck, dark steel winding wheel
with painted spokes, corrugated tan winch house, ochre ore heap and bin
fill, dark rubber conveyor belt on rust-red trusswork, greasy cable drum.
Map prop: NO team colour anywhere. No emissive — an unpowered field site.
Weathering: ore dust around the heap and hopper, oil at the winch drum,
mud at pad edges, rust streaks on the shed and lattice roots.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_metal_pit_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges,
                   jit, shade, BOLT_LOG,
                   YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
STEM = 'ms_metal_pit'

CONCRETE = (147, 143, 135)     # pad
DECKPL   = (104, 108, 112)     # steel deck plate
GALV     = (160, 164, 170)     # galvanised deck steel
OXIDE    = (139, 72, 50)       # oxide-red headframe / truss steel
OXIDE_DK = (110, 57, 41)
STEEL    = (88, 92, 98)        # mechanical steel
STEEL_DK = (54, 57, 62)
RUBBER   = (44, 44, 46)        # conveyor belt
TAN      = (166, 154, 126)     # corrugated winch-house skin
TAN_DK   = (136, 126, 102)
ORE      = (121, 84, 48)       # raw ore ochre
ORE_DK   = (88, 60, 34)
SPOIL    = (105, 92, 76)       # spoil-heap rock


def hazard_row(m, x0, y, x1, h, step=24):
    i = 0
    x = x0
    while x < x1:
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x, y), (min(x + step, x1), y),
                     (min(x + step - 8, x1), y + h), (max(x - 8, x0), y + h)],
                    fill=c)
        x += step
        i += 1


# ── ground plate ─────────────────────────────────────────────────────────

def paint_plate(m):
    z = L.R_PLATE_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4,
         rough=R_ARMOR + 24, metal=0)

    def u(wx):
        return z.uv((wx, 0, 0))[0] * W

    def v(wz):
        return z.uv((0, 0, wz))[1] * W

    for wx in (-4.8, -1.6, 1.6, 4.8):
        seam_v(m, int(u(wx)), y0 + 3, y1 - 3, CONCRETE, hi=False)
    for wz in (-2.6, 0.0, 2.6):
        seam_h(m, x0 + 3, x1 - 3, int(v(wz)), CONCRETE, hi=False)
    for _ in range(24):
        bx = x0 + RNG.random() * (x1 - x0 - 140)
        by = y0 + RNG.random() * (y1 - y0 - 100)
        m.d.polygon([(bx, by + 12), (bx + 120, by), (bx + 138, by + 66),
                     (bx + 24, by + 86)],
                    fill=jit(shade(CONCRETE, RNG.uniform(0.9, 1.02)), 3))
    # hazard border along the plate rim
    bw = 16
    for i in range(int((x1 - x0) / 32) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0 + i * 32, y0, x0 + (i + 1) * 32, y0 + bw], fill=c)
        m.d.rectangle([x0 + i * 32, y1 - bw, x0 + (i + 1) * 32, y1], fill=c)
    for i in range(int((y1 - y0) / 32) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0, y0 + i * 32, x0 + bw, y0 + (i + 1) * 32], fill=c)
        m.d.rectangle([x1 - bw, y0 + i * 32, x1, y0 + (i + 1) * 32], fill=c)

    # headframe leg anchor pads + bolt rings
    cx, cz = L.FRAME_C
    for sx in (-1, 1):
        for sz in (-1, 1):
            ax, az = u(cx + sx * L.BASE_H), v(cz + sz * L.BASE_H)
            m.d.rectangle([ax - 26, az - 26, ax + 26, az + 26], fill=DECKPL)
            m.o.rectangle([ax - 26, az - 26, ax + 26, az + 26],
                          fill=(AO_BASE - 10, R_STEEL, M_STEEL))
            bolts(m, [(ax - 17, az - 17), (ax + 17, az - 17),
                      (ax - 17, az + 17), (ax + 17, az + 17)], r=4,
                  base=DECKPL)
    # spoil-heap ground stain (ore dust ring bleeding past the heap base)
    hx, hz = L.HEAP_C
    hr = (u(L.HEAP_R * 1.5) - u(0))
    m.d.ellipse([u(hx) - hr, v(hz) - hr * 0.8, u(hx) + hr, v(hz) + hr * 0.8],
                fill=shade(SPOIL, 0.9))
    # hopper drop-zone stain under the chute
    m.d.ellipse([u(-3.6), v(-4.9), u(-2.0), v(-3.9)], fill=shade(ORE, 0.8))
    # winch-house footprint shadow
    m.d.rectangle([u(2.4), v(-1.8), u(5.2), v(0.6)],
                  fill=shade(CONCRETE, 0.85))
    wear_edges(m, (x0, y0, x1, y1), CONCRETE, 60)

    for zs in (L.R_PLATE_SX, L.R_PLATE_SZ):
        sx0, sy0, sx1, sy1 = zs.rect
        fill(m, (sx0, sy0, sx1, sy1), dif=STEEL_DK, ao=AO_BASE - 14,
             rough=R_ARMOR + 10, metal=M_STEEL - 60)
        hazard_row(m, sx0, sy0 + 4, sx1, 14, step=30)
        wear_edges(m, (sx0, sy0, sx1, sy1), STEEL_DK, 30)


# ── parametric wraps ─────────────────────────────────────────────────────

def paint_wraps(m):
    # headframe lattice: oxide red, worn, weld dots at u ends
    x0, y0, x1, y1 = L.R_LATTICE
    fill(m, (x0, y0, x1, y1), dif=OXIDE, ao=AO_BASE - 4,
         rough=R_ARMOR + 6, metal=M_ARMOR + 30)
    for fu in np.linspace(0.08, 0.92, 12):
        gx = x0 + (x1 - x0) * fu
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)],
                 fill=shade(OXIDE, 0.88 + 0.1 * (RNG.random() - 0.5)), width=2)
    for gx in (x0 + 8, x1 - 8):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(OXIDE, 0.7), width=4)
        m.o.line([(gx, y0 + 2), (gx, y1 - 2)], fill=(AO_SEAM, R_STEEL, M_STEEL),
                 width=4)
    wear_edges(m, (x0, y0, x1, y1), OXIDE, 40)
    # rake struts / supports: darker oxide
    x0, y0, x1, y1 = L.R_STRUT
    fill(m, (x0, y0, x1, y1), dif=OXIDE_DK, ao=AO_BASE - 5,
         rough=R_ARMOR + 4, metal=M_ARMOR + 30)
    for fu in (0.25, 0.75):
        m.d.line([(x0 + (x1 - x0) * fu, y0 + 2), (x0 + (x1 - x0) * fu, y1 - 2)],
                 fill=shade(OXIDE_DK, 0.82), width=3)
    wear_edges(m, (x0, y0, x1, y1), OXIDE_DK, 40)
    # cable / drum wrap: greasy dark steel with wind grooves
    x0, y0, x1, y1 = L.R_CABLE
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10,
         rough=R_STEEL - 20, metal=M_STEEL)
    for fu in np.linspace(0.1, 0.9, 9):
        gx = x0 + (x1 - x0) * fu
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(STEEL_DK, 0.8),
                 width=2)
    # small-part trim wrap: worn galvanised
    x0, y0, x1, y1 = L.R_TRIM
    fill(m, (x0, y0, x1, y1), dif=shade(GALV, 0.92), ao=AO_BASE - 8,
         rough=R_STEEL, metal=M_STEEL)


# ── swatch cells ─────────────────────────────────────────────────────────

def paint_cells(m):
    fill(m, L.R_STEELG.rect, dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    fill(m, L.R_MACH.rect, dif=STEEL_DK, ao=AO_BASE - 12, rough=R_STEEL + 12,
         metal=M_STEEL)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)
    # ore fill: ochre rubble speckle
    x0, y0, x1, y1 = L.R_ORE.rect
    fill(m, (x0, y0, x1, y1), dif=ORE, ao=AO_BASE - 12,
         rough=R_ARMOR + 26, metal=0)
    for _ in range(120):
        bx = x0 + RNG.random() * (x1 - x0 - 10)
        by = y0 + RNG.random() * (y1 - y0 - 10)
        r = 3 + RNG.random() * 6
        m.d.ellipse([bx, by, bx + r, by + r],
                    fill=jit(shade(ORE, RNG.uniform(0.7, 1.2)), 6))
    # wheel rim wrap: dark steel, low-contrast
    fill(m, L.R_WHEEL_RIM.rect, dif=shade(STEEL_DK, 1.05), ao=AO_BASE - 8,
         rough=R_STEEL, metal=M_STEEL)
    # shaft collar: dark concrete ring with hazard top course
    z = L.R_COLLAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.82), ao=AO_BASE - 12,
         rough=R_ARMOR + 20, metal=0)
    hazard_row(m, x0 + 4, y0 + 6, x1 - 4, 16, step=26)
    wear_edges(m, (x0, y0, x1, y1), shade(CONCRETE, 0.82), 30)


# ── deck + wheel ─────────────────────────────────────────────────────────

def paint_deck(m):
    x0, y0, x1, y1 = L.R_DECK_S.rect
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 6,
         rough=R_STEEL - 6, metal=M_STEEL)
    hazard_row(m, x0 + 2, y0 + 4, x1 - 2, 18, step=26)
    wear_edges(m, (x0, y0, x1, y1), GALV, 24)
    x0, y0, x1, y1 = L.R_DECK_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GALV, 0.94), ao=AO_BASE - 6,
         rough=R_STEEL, metal=M_STEEL)
    for fy in np.linspace(0.15, 0.85, 5):
        m.d.line([(x0 + 3, y0 + (y1 - y0) * fy), (x1 - 3, y0 + (y1 - y0) * fy)],
                 fill=shade(GALV, 0.8), width=3)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=shade(GALV, 0.72), width=3)


def paint_wheel(m):
    # wheel side faces: dark steel disc, painted spoke wedges + hub
    z = L.R_WHEEL_S
    x0, y0, x1, y1 = z.rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rad = (x1 - x0) / 2 * (1.15 / 1.45) * 0.98
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8,
         rough=R_STEEL + 6, metal=M_STEEL - 20)
    # spokes: lighter wedges between darker cutout wedges (tone-on-tone)
    for i in range(8):
        a0 = i * np.pi / 4 + 0.10
        a1 = (i + 1) * np.pi / 4 - 0.10
        m.d.pieslice([cx - rad, cy - rad, cx + rad, cy + rad],
                     np.degrees(a0), np.degrees(a1),
                     fill=shade(STEEL_DK, 1.18))
    # rim ring + hub
    m.d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad],
                outline=shade(STEEL_DK, 1.3), width=10)
    hub = rad * 0.22
    m.d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub],
                fill=shade(OXIDE, 0.9))
    m.o.ellipse([cx - hub, cy - hub, cx + hub, cy + hub],
                fill=(AO_BASE - 12, R_STEEL - 20, M_STEEL))
    bolts(m, [(cx + hub * 1.6 * np.cos(a), cy + hub * 1.6 * np.sin(a))
              for a in np.linspace(0, 2 * np.pi, 6, endpoint=False)],
          r=4, base=STEEL_DK)


# ── winch house / hopper / conveyor / heap ───────────────────────────────

def paint_winch_house(m):
    z = L.R_WINCH_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TAN, ao=AO_BASE - 5,
         rough=R_ARMOR + 12, metal=70)

    def vs(wy):
        return z.uv((0, wy, 0))[1] * W

    for gx in range(x0 + 4, x1, 14):
        m.d.line([(gx, y0 + 2), (gx, int(vs(0.5)))], fill=shade(TAN, 0.9))
    m.d.rectangle([x0, vs(0.5), x1, y1], fill=TAN_DK)
    # window strip facing the headframe
    wx0, wx1 = x0 + (x1 - x0) * 0.56, x0 + (x1 - x0) * 0.82
    m.d.rectangle([wx0, vs(2.2), wx1, vs(1.5)], fill=(46, 52, 58))
    m.o.rectangle([wx0, vs(2.2), wx1, vs(1.5)], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.rectangle([wx0, vs(2.2), wx1, vs(1.5)], outline=shade(TAN, 0.7),
                  width=3)
    wear_edges(m, (x0, y0, x1, y1), TAN, 40)

    z = L.R_WINCH_F
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TAN, ao=AO_BASE - 5,
         rough=R_ARMOR + 12, metal=70)

    def vf(wy):
        return z.uv((0, wy, 0))[1] * W

    for gx in range(x0 + 4, x1, 14):
        m.d.line([(gx, y0 + 2), (gx, int(vf(0.5)))], fill=shade(TAN, 0.9))
    m.d.rectangle([x0, vf(0.5), x1, y1], fill=TAN_DK)
    # steel door
    dx0, dx1 = x0 + (x1 - x0) * 0.38, x0 + (x1 - x0) * 0.60
    m.d.rectangle([dx0, vf(2.25), dx1, vf(0.35)], fill=STEEL)
    m.o.rectangle([dx0, vf(2.25), dx1, vf(0.35)],
                  fill=(AO_BASE - 12, R_STEEL, M_STEEL))
    m.d.rectangle([dx0, vf(2.25), dx1, vf(0.35)], outline=shade(TAN, 0.6),
                  width=3)
    m.d.line([(dx0 + 10, vf(1.3)), (dx0 + 26, vf(1.3))],
             fill=shade(STEEL, 0.6), width=4)
    wear_edges(m, (x0, y0, x1, y1), TAN, 40)

    x0, y0, x1, y1 = L.R_WINCH_R.rect
    fill(m, (x0, y0, x1, y1), dif=shade(TAN, 0.88), ao=AO_BASE - 7,
         rough=R_ARMOR + 20, metal=90)
    for gx in range(x0 + 6, x1, 16):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(TAN, 0.78))
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=shade(TAN, 0.7), width=3)


def paint_hopper(m):
    x0, y0, x1, y1 = L.R_HOP_S.rect
    fill(m, (x0, y0, x1, y1), dif=OXIDE, ao=AO_BASE - 6,
         rough=R_ARMOR + 8, metal=M_ARMOR + 30)
    # rib seams + bolts
    for fu in (0.25, 0.5, 0.75):
        seam_v(m, int(x0 + (x1 - x0) * fu), y0 + 4, y1 - 4, OXIDE, hi=False)
    bolts(m, [(x0 + 18 + RNG.random() * (x1 - x0 - 36),
               y0 + 14 + RNG.random() * (y1 - y0 - 28)) for _ in range(10)],
          r=3, base=OXIDE)
    hazard_row(m, x0 + 4, y1 - 24, x1 - 4, 16, step=22)
    wear_edges(m, (x0, y0, x1, y1), OXIDE, 40)


def paint_conveyor(m):
    # belt top: dark rubber with cleat bars
    z = L.R_BELT_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 10,
         rough=R_ARMOR + 30, metal=0)
    for fu in np.linspace(0.04, 0.96, 22):
        gx = x0 + (x1 - x0) * fu
        m.d.line([(gx, y0 + 6), (gx, y1 - 6)], fill=shade(RUBBER, 1.25),
                 width=3)
    # ore dribble down the centre line
    for fu in np.linspace(0.05, 0.95, 40):
        gx = x0 + (x1 - x0) * fu
        gy = (y0 + y1) / 2 + (RNG.random() - 0.5) * (y1 - y0) * 0.4
        r = 2 + RNG.random() * 4
        m.d.ellipse([gx, gy, gx + r, gy + r],
                    fill=jit(shade(ORE, RNG.uniform(0.8, 1.1)), 5))
    # belt sides / truss: oxide frame with X-brace lines
    x0, y0, x1, y1 = L.R_BELT_S.rect
    fill(m, (x0, y0, x1, y1), dif=OXIDE_DK, ao=AO_BASE - 6,
         rough=R_ARMOR + 6, metal=M_ARMOR + 30)
    step = (x1 - x0) / 12
    for i in range(12):
        bx = x0 + i * step
        m.d.line([(bx, y1 - 4), (bx + step, y0 + 4)],
                 fill=shade(OXIDE_DK, 0.84), width=3)
        m.d.line([(bx, y0 + 4), (bx + step, y1 - 4)],
                 fill=shade(OXIDE_DK, 0.84), width=3)
    m.d.rectangle([x0, y0, x1, y0 + 8], fill=shade(OXIDE_DK, 1.12))
    m.d.rectangle([x0, y1 - 8, x1, y1], fill=shade(OXIDE_DK, 1.12))
    wear_edges(m, (x0, y0, x1, y1), OXIDE_DK, 30)


def paint_heap(m):
    x0, y0, x1, y1 = L.R_HEAP.rect
    fill(m, (x0, y0, x1, y1), dif=SPOIL, ao=AO_BASE - 10,
         rough=R_ARMOR + 28, metal=0)
    # rubble speckle, low-contrast (large-quad cell — keep tone-on-tone)
    for _ in range(260):
        bx = x0 + RNG.random() * (x1 - x0 - 14)
        by = y0 + RNG.random() * (y1 - y0 - 14)
        r = 3 + RNG.random() * 9
        m.d.ellipse([bx, by, bx + r, by + r],
                    fill=jit(shade(SPOIL, RNG.uniform(0.88, 1.12)), 5))
    # faint ore veining down the u axis (spill lines from the conveyor head)
    for fv in np.linspace(0.15, 0.85, 5):
        gy = y0 + (y1 - y0) * fv
        m.d.line([(x0 + 6, gy + (RNG.random() - 0.5) * 20),
                  (x1 - 6, gy + (RNG.random() - 0.5) * 20)],
                 fill=shade(ORE, 0.95), width=3)


# ── assemble ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_plate(m)
    paint_wraps(m)
    paint_cells(m)
    paint_deck(m)
    paint_wheel(m)
    paint_winch_house(m)
    paint_hopper(m)
    paint_conveyor(m)
    paint_heap(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.35)

    z = L.R_PLATE_T

    def u(wxm):
        return z.uv((wxm, 0, 0))[0] * W

    def v(wzm):
        return z.uv((0, 0, wzm))[1] * W

    # pad: ore dust around heap + hopper, oil under the winch drum
    wx.mud_band((u(1.8), v(0.6), u(7.2), v(5.2)), 0.35, fade=None,
                spatter=True)                          # heap quadrant dust
    wx.mud_band((u(-4.2), v(-5.2), u(-1.4), v(-3.4)), 0.3, fade=None,
                spatter=True)                          # under the hopper
    wx.oily((u(1.6), v(-1.4), u(3.2), v(0.2)), 0.45)   # drum / winch grease
    x0, y0, x1, y1 = z.rect
    wx.mud_band((x0, y0, x1, y0 + 60), 0.3, fade=None, spatter=True)
    wx.mud_band((x0, y1 - 60, x1, y1), 0.3, fade=None, spatter=True)
    wx.mud_band((x0, y0, x0 + 60, y1), 0.25, fade=None, spatter=True)
    wx.mud_band((x1 - 60, y0, x1, y1), 0.25, fade=None, spatter=True)
    for zs in (L.R_PLATE_SX, L.R_PLATE_SZ):
        wx.mud_band(zs.rect, 0.5, fade='down', spatter=True)

    # lattice: mud at the leg roots, rust blotches up the steel
    wx.mud_band(L.R_LATTICE, 0.3, fade='left', spatter=False, dust=0.2)
    lx0, ly0, lx1, ly1 = L.R_LATTICE
    for _ in range(14):
        wx.rust_blotch(lx0 + RNG.random() * (lx1 - lx0),
                       ly0 + 6 + RNG.random() * (ly1 - ly0 - 12),
                       3 + RNG.random() * 5, strength=0.5)
    # cable drum grease
    wx.oily(L.R_CABLE, 0.5)
    wx.oily(L.R_MACH.rect, 0.4)
    # winch house: skirt mud + roof-line rust streaks
    for zd in (L.R_WINCH_S, L.R_WINCH_F):
        x0, y0, x1, y1 = zd.rect
        wx.mud_band((x0, y1 - 40, x1, y1), 0.4, fade='down', spatter=True)
        wx.plate_bottom_rust(zd.rect, n=6, strength=0.5)
        for fx in np.linspace(0.12, 0.88, 6):
            wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 8,
                           20 + RNG.random() * 30, width=2.2, strength=0.28)
    wx.mud_band(L.R_WINCH_R.rect, 0.2, fade=None, spatter=False, dust=0.3)
    # hopper: ore dust from the top edge + rust
    hx0, hy0, hx1, hy1 = L.R_HOP_S.rect
    wx.mud_band((hx0, hy0, hx1, hy0 + 40), 0.35, fade='down', spatter=True)
    wx.plate_bottom_rust(L.R_HOP_S.rect, n=5, strength=0.5)
    # heap: nothing — it IS dirt
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.45)
    wx.apply(m)

    # ── normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for zd in (L.R_WINCH_S, L.R_WINCH_F):              # corrugation
        x0, y0, x1, y1 = zd.rect
        for gx in range(x0 + 4, x1, 14):
            hm.line((gx, y0 + 2), (gx, y1 - 46), 0.25, width=1)
    x0, y0, x1, y1 = L.R_WINCH_R.rect
    for gx in range(x0 + 6, x1, 16):
        hm.line((gx, y0 + 2), (gx, y1 - 2), 0.3, width=2)
    z = L.R_PLATE_T                                    # expansion joints
    for wxm in (-4.8, -1.6, 1.6, 4.8):
        gx = z.uv((wxm, 0, 0))[0] * W
        hm.line((gx, z.rect[1] + 3), (gx, z.rect[3] - 3), -0.5, width=2)
    for wzm in (-2.6, 0.0, 2.6):
        gy = z.uv((0, 0, wzm))[1] * W
        hm.line((z.rect[0] + 3, gy), (z.rect[2] - 3, gy), -0.5, width=2)
    # belt cleats
    x0, y0, x1, y1 = L.R_BELT_T.rect
    for fu in np.linspace(0.04, 0.96, 22):
        gx = x0 + (x1 - x0) * fu
        hm.line((gx, y0 + 6), (gx, y1 - 6), 0.35, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=3.6).save(f'out/{STEM}_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save(f'out/{STEM}_diffuse.png')
    m.orm.save(f'out/{STEM}_orm.png')
    m.emi.save(f'out/{STEM}_emissive.png')
    m.tea.save(f'out/{STEM}_team.png')
    print(f'[paint_ms_metal_pit] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
