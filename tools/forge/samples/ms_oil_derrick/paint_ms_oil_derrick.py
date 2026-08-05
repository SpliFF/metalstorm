"""paint_ms_oil_derrick — 2048² PBR set for ms_oil_derrick (resource site).

Working-oilfield read: oil-stained concrete pad with hazard border and
anchor pads, galvanised lattice derrick steel, oxide-red pump machinery
(samson post, walking beam, handwheels), dark flow-line pipes with flange
bands, hazard-banded wellhead stack, corrugated tan doghouse shed with a
steel door.  Team colour: horsehead side panels + doghouse placard
(runtime mask, never baked).  No emissive — an unpowered field site.
Weathering: heavy oil slick around the wellhead/cellar and under the
gearbox, mud at the pad edges and leg bases, rust on bolts, plate feet
and the doghouse skirt.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_oil_derrick_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
STEM = 'ms_oil_derrick'

CONCRETE = (149, 146, 139)     # pad
DECKPL   = (104, 108, 112)     # steel deck plate under the pump skid
GALV     = (163, 167, 172)     # galvanised derrick lattice
OXIDE    = (142, 74, 52)       # oxide-red painted pump machinery
OXIDE_DK = (112, 58, 42)
STEEL    = (88, 92, 98)        # mechanical steel
STEEL_DK = (56, 59, 64)
PIPE     = (72, 76, 82)        # flow lines
TAN      = (168, 156, 128)     # civilian-tan doghouse skin
TAN_DK   = (138, 128, 104)
OILDARK  = (30, 29, 27)        # pooled crude


def hazard_row(m, x0, y, x1, h, step=24):
    """Horizontal hazard chevron band."""
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

    # expansion-joint grid
    for wx in (-4.8, -1.6, 1.6, 4.8):
        seam_v(m, int(u(wx)), y0 + 3, y1 - 3, CONCRETE, hi=False)
    for wz in (-2.6, 0.0, 2.6):
        seam_h(m, x0 + 3, x1 - 3, int(v(wz)), CONCRETE, hi=False)
    # pour-patch tonal blocks
    for _ in range(26):
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

    # derrick leg anchor pads + bolt rings
    cx, cz = L.DERRICK_C
    for sx in (-1, 1):
        for sz in (-1, 1):
            ax, az = u(cx + sx * L.BASE_H), v(cz + sz * L.BASE_H)
            m.d.rectangle([ax - 26, az - 26, ax + 26, az + 26], fill=DECKPL)
            m.o.rectangle([ax - 26, az - 26, ax + 26, az + 26],
                          fill=(AO_BASE - 10, R_STEEL, M_STEEL))
            bolts(m, [(ax - 17, az - 17), (ax + 17, az - 17),
                      (ax - 17, az + 17), (ax + 17, az + 17)], r=4,
                  base=DECKPL)
    # steel deck plate under the pump skid + gearbox
    dp = [u(2.2), v(-1.6), u(4.7), v(3.0)]
    m.d.rectangle(dp, fill=DECKPL)
    m.o.rectangle(dp, fill=(AO_BASE - 8, R_STEEL - 20, M_STEEL))
    for fy in np.arange(dp[1] + 10, dp[3], 22):      # tread strips
        m.d.line([(dp[0] + 4, fy), (dp[2] - 4, fy)], fill=shade(DECKPL, 0.86))
    bolts(m, [(dp[0] + 10, dp[1] + 10), (dp[2] - 10, dp[1] + 10),
              (dp[0] + 10, dp[3] - 10), (dp[2] - 10, dp[3] - 10)],
          r=4, base=DECKPL)
    # wellhead cellar ring
    wx_, wz_ = u(L.WELL_X), v(L.WELL_Z)
    m.d.ellipse([wx_ - 46, wz_ - 46, wx_ + 46, wz_ + 46], fill=STEEL_DK)
    m.o.ellipse([wx_ - 46, wz_ - 46, wx_ + 46, wz_ + 46],
                fill=(AO_DEEP, R_STEEL, M_STEEL))
    m.d.ellipse([wx_ - 34, wz_ - 34, wx_ + 34, wz_ + 34], fill=OILDARK)
    m.o.ellipse([wx_ - 34, wz_ - 34, wx_ + 34, wz_ + 34],
                fill=(AO_DEEP, 60, 0))               # wet crude: low rough
    # crude pools: wellhead spill fan + gearbox drips + doghouse drum stain
    pool = [(wx_ + 20, wz_ + 30, 120, 76), (u(4.6), v(1.9), 66, 48),
            (u(2.7), v(-0.4), 46, 34), (u(-1.0), v(-4.0), 58, 36)]
    for (px, py, rx, ry) in pool:
        m.d.ellipse([px - rx, py - ry, px + rx, py + ry], fill=OILDARK)
        m.o.ellipse([px - rx, py - ry, px + rx, py + ry],
                    fill=(AO_DEEP + 15, 55, 0))
        for _ in range(10):                          # ragged splash edge
            a = RNG.random() * 2 * np.pi
            ex, ey = px + np.cos(a) * rx * 1.08, py + np.sin(a) * ry * 1.08
            r = 3 + RNG.random() * 7
            m.d.ellipse([ex - r, ey - r, ex + r, ey + r], fill=OILDARK)
    # doghouse footprint shadow
    m.d.rectangle([u(-4.6), v(2.7), u(-1.4), v(4.9)],
                  fill=shade(CONCRETE, 0.85))
    wear_edges(m, (x0, y0, x1, y1), CONCRETE, 60)

    # plate skirts: dark steel formwork + hazard top course
    for zs in (L.R_PLATE_SX, L.R_PLATE_SZ):
        sx0, sy0, sx1, sy1 = zs.rect
        fill(m, (sx0, sy0, sx1, sy1), dif=STEEL_DK, ao=AO_BASE - 14,
             rough=R_ARMOR + 10, metal=M_STEEL - 60)
        hazard_row(m, sx0, sy0 + 4, sx1, 14, step=30)
        wear_edges(m, (sx0, sy0, sx1, sy1), STEEL_DK, 30)


# ── parametric wraps ─────────────────────────────────────────────────────

def paint_wraps(m):
    # lattice: galvanised, faint length-wise banding + weld dots at u ends
    x0, y0, x1, y1 = L.R_LATTICE
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 4,
         rough=R_STEEL - 8, metal=M_STEEL)
    for fu in np.linspace(0.08, 0.92, 12):
        gx = x0 + (x1 - x0) * fu
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)],
                 fill=shade(GALV, 0.88 + 0.1 * (RNG.random() - 0.5)), width=2)
    for gx in (x0 + 8, x1 - 8):                       # joint welds
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(GALV, 0.7), width=4)
        m.o.line([(gx, y0 + 2), (gx, y1 - 2)], fill=(AO_SEAM, R_STEEL, M_STEEL),
                 width=4)
    # samson post / skid: oxide red, worn edges
    x0, y0, x1, y1 = L.R_POST
    fill(m, (x0, y0, x1, y1), dif=OXIDE, ao=AO_BASE - 5,
         rough=R_ARMOR + 4, metal=M_ARMOR + 30)
    for fu in (0.25, 0.75):
        m.d.line([(x0 + (x1 - x0) * fu, y0 + 2), (x0 + (x1 - x0) * fu, y1 - 2)],
                 fill=shade(OXIDE, 0.82), width=3)
    wear_edges(m, (x0, y0, x1, y1), OXIDE, 40)
    # flow-line pipe: dark steel + flange bands near both ends
    x0, y0, x1, y1 = L.R_PIPE
    fill(m, (x0, y0, x1, y1), dif=PIPE, ao=AO_BASE - 6,
         rough=R_STEEL, metal=M_STEEL)
    for fu in (0.06, 0.94):
        gx = x0 + (x1 - x0) * fu
        m.d.rectangle([gx - 6, y0 + 2, gx + 6, y1 - 2], fill=shade(PIPE, 0.72))
        m.o.rectangle([gx - 6, y0 + 2, gx + 6, y1 - 2],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    m.d.line([(x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)],
             fill=shade(PIPE, 1.18), width=2)          # spec highlight seam
    # wellhead stack: dark steel with a hazard collar mid-length
    x0, y0, x1, y1 = L.R_WELL
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 6,
         rough=R_STEEL + 8, metal=M_STEEL - 30)
    gx0, gx1 = x0 + (x1 - x0) * 0.42, x0 + (x1 - x0) * 0.58
    m.d.rectangle([gx0, y0 + 2, gx1, y1 - 2], fill=YELLOW)
    for fy in np.linspace(0.12, 0.88, 4):
        m.d.rectangle([gx0, y0 + (y1 - y0) * fy - 4, gx1,
                       y0 + (y1 - y0) * fy + 4], fill=BLACKISH)
    for fu in (0.1, 0.86):
        gx = x0 + (x1 - x0) * fu
        m.d.rectangle([gx - 5, y0 + 2, gx + 5, y1 - 2], fill=shade(STEEL, 0.7))
    # small-part trim wrap: galvanised
    x0, y0, x1, y1 = L.R_TRIM
    fill(m, (x0, y0, x1, y1), dif=shade(GALV, 0.92), ao=AO_BASE - 8,
         rough=R_STEEL, metal=M_STEEL)


# ── swatch cells (huge world window -> effectively flat colour) ──────────

def paint_cells(m):
    fill(m, L.R_STEELG.rect, dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    fill(m, L.R_GEAR.rect, dif=STEEL_DK, ao=AO_BASE - 12, rough=R_STEEL + 12,
         metal=M_STEEL)
    fill(m, L.R_VALVE.rect, dif=OXIDE, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR + 40)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)


# ── crown + doghouse ─────────────────────────────────────────────────────

def paint_crown(m):
    for zc in (L.R_CROWN_S,):                 # S and F share one rect
        x0, y0, x1, y1 = zc.rect
        fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 6,
             rough=R_STEEL - 6, metal=M_STEEL)
        hazard_row(m, x0 + 2, y0 + 4, x1 - 2, 18, step=26)
        wear_edges(m, (x0, y0, x1, y1), GALV, 24)
    x0, y0, x1, y1 = L.R_CROWN_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GALV, 0.94), ao=AO_BASE - 6,
         rough=R_STEEL, metal=M_STEEL)
    for fy in np.linspace(0.15, 0.85, 5):     # walkway grating strips
        m.d.line([(x0 + 3, y0 + (y1 - y0) * fy), (x1 - 3, y0 + (y1 - y0) * fy)],
                 fill=shade(GALV, 0.8), width=3)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=shade(GALV, 0.72), width=3)


def paint_doghouse(m):
    # sides (x faces): corrugated tan, window strip on one bay
    z = L.R_DOG_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TAN, ao=AO_BASE - 5,
         rough=R_ARMOR + 12, metal=70)

    def vs(wy):
        return z.uv((0, wy, 0))[1] * W

    for gx in range(x0 + 4, x1, 14):
        m.d.line([(gx, y0 + 2), (gx, int(vs(0.5)))], fill=shade(TAN, 0.9))
    m.d.rectangle([x0, vs(0.5), x1, y1], fill=TAN_DK)   # skirt course
    # window
    wx0, wx1 = x0 + (x1 - x0) * 0.58, x0 + (x1 - x0) * 0.82
    m.d.rectangle([wx0, vs(2.35), wx1, vs(1.6)], fill=(46, 52, 58))
    m.o.rectangle([wx0, vs(2.35), wx1, vs(1.6)], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.rectangle([wx0, vs(2.35), wx1, vs(1.6)], outline=shade(TAN, 0.7),
                  width=3)
    wear_edges(m, (x0, y0, x1, y1), TAN, 40)

    # front/back (z faces): corrugation + steel door + team placard
    z = L.R_DOG_F
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TAN, ao=AO_BASE - 5,
         rough=R_ARMOR + 12, metal=70)

    def vf(wy):
        return z.uv((0, wy, 0))[1] * W

    for gx in range(x0 + 4, x1, 14):
        m.d.line([(gx, y0 + 2), (gx, int(vf(0.5)))], fill=shade(TAN, 0.9))
    m.d.rectangle([x0, vf(0.5), x1, y1], fill=TAN_DK)
    dx0, dx1 = x0 + (x1 - x0) * 0.36, x0 + (x1 - x0) * 0.62
    m.d.rectangle([dx0, vf(2.45), dx1, vf(0.35)], fill=STEEL)
    m.o.rectangle([dx0, vf(2.45), dx1, vf(0.35)],
                  fill=(AO_BASE - 12, R_STEEL, M_STEEL))
    m.d.rectangle([dx0, vf(2.45), dx1, vf(0.35)], outline=shade(TAN, 0.6),
                  width=3)
    m.d.line([(dx0 + 10, vf(1.35)), (dx0 + 26, vf(1.35))],
             fill=shade(STEEL, 0.6), width=4)           # handle
    # team placard beside the door
    px0, px1 = dx1 + 14, dx1 + 74
    m.d.rectangle([px0, vf(2.3), px1, vf(1.75)], fill=TEAMGREY,
                  outline=shade(TAN, 0.6))
    m.t.rectangle([px0, vf(2.3), px1, vf(1.75)], fill=(255, 0, 0))
    wear_edges(m, (x0, y0, x1, y1), TAN, 40)

    # roof: ribbed metal, weathered
    x0, y0, x1, y1 = L.R_DOG_R.rect
    fill(m, (x0, y0, x1, y1), dif=shade(TAN, 0.88), ao=AO_BASE - 7,
         rough=R_ARMOR + 20, metal=90)
    for gx in range(x0 + 6, x1, 16):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(TAN, 0.78))
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=shade(TAN, 0.7), width=3)


# ── walking beam piece ───────────────────────────────────────────────────

def paint_beam(m):
    # beam sides: oxide red I-beam web with rivet row
    z = L.R_BEAM_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=OXIDE, ao=AO_BASE - 4,
         rough=R_ARMOR + 4, metal=M_ARMOR + 30)

    def ub(wz):
        return z.uv((0, 0, wz))[0] * W

    def vb(wy):
        return z.uv((0, wy, 0))[1] * W

    # flange lines top/bottom + web shading
    m.d.rectangle([x0, vb(0.30), x1, vb(0.18)], fill=shade(OXIDE, 0.86))
    m.d.rectangle([x0, vb(-0.05), x1, vb(-0.12)], fill=shade(OXIDE, 0.86))
    m.d.line([(x0, vb(0.18)), (x1, vb(0.18))], fill=shade(OXIDE, 0.6), width=2)
    m.d.line([(x0, vb(-0.05)), (x1, vb(-0.05))], fill=shade(OXIDE, 0.6), width=2)
    bolts(m, [(ub(wz), (vb(0.18) + vb(-0.05)) / 2)
              for wz in np.arange(-2.3, 1.8, 0.45)], r=3, base=OXIDE)
    wear_edges(m, (x0, y0, x1, y1), OXIDE, 40)
    # beam top: oxide with grip strip
    x0, y0, x1, y1 = L.R_BEAM_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OXIDE, 0.94), ao=AO_BASE - 5,
         rough=R_ARMOR + 8, metal=M_ARMOR + 30)
    m.d.rectangle([x0 + 4, (y0 + y1) / 2 - 4, x1 - 4, (y0 + y1) / 2 + 4],
                  fill=shade(OXIDE, 0.8))

    # horsehead sides: team-masked panel with oxide frame
    z = L.R_HEAD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=OXIDE_DK, ao=AO_BASE - 5,
         rough=R_ARMOR + 6, metal=M_ARMOR + 30)
    m.d.rectangle([x0 + 14, y0 + 18, x1 - 14, y1 - 30], fill=TEAMGREY,
                  outline=shade(OXIDE_DK, 0.7), width=3)
    m.t.rectangle([x0 + 14, y0 + 18, x1 - 14, y1 - 30], fill=(255, 0, 0))
    wear_edges(m, (x0, y0, x1, y1), OXIDE_DK, 30)

    # counterweight: dark steel slab with bolt corners + hazard bottom edge
    z = L.R_CWT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8,
         rough=R_STEEL + 10, metal=M_STEEL - 40)
    seam_v(m, (x0 + x1) // 2, y0 + 4, y1 - 4, STEEL_DK, hi=False)
    bolts(m, [(x0 + 16, y0 + 16), (x1 - 16, y0 + 16),
              (x0 + 16, y1 - 40), (x1 - 16, y1 - 40)], r=4, base=STEEL_DK)
    hazard_row(m, x0 + 4, y1 - 22, x1 - 4, 16, step=22)


# ── assemble ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_plate(m)
    paint_wraps(m)
    paint_cells(m)
    paint_crown(m)
    paint_doghouse(m)
    paint_beam(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.35)

    # pad: oil sheen around the cellar + gearbox, mud creeping in at the rim
    z = L.R_PLATE_T
    def u(wxm):
        return z.uv((wxm, 0, 0))[0] * W

    def v(wzm):
        return z.uv((0, 0, wzm))[1] * W
    wx.oily((u(1.9), v(-4.4), u(6.4), v(0.6)), 0.55)   # wellhead spill fan
    wx.oily((u(2.0), v(0.6), u(5.2), v(3.4)), 0.4)     # under skid/gearbox
    wx.oily((u(-2.0), v(-4.8), u(0.2), v(-3.2)), 0.3)  # drum stain
    x0, y0, x1, y1 = z.rect
    wx.mud_band((x0, y0, x1, y0 + 60), 0.3, fade=None, spatter=True)
    wx.mud_band((x0, y1 - 60, x1, y1), 0.3, fade=None, spatter=True)
    wx.mud_band((x0, y0, x0 + 60, y1), 0.25, fade=None, spatter=True)
    wx.mud_band((x1 - 60, y0, x1, y1), 0.25, fade=None, spatter=True)
    for zs in (L.R_PLATE_SX, L.R_PLATE_SZ):
        wx.mud_band(zs.rect, 0.5, fade='down', spatter=True)

    # lattice wrap: mud at the limb start (legs root at the plate)
    wx.mud_band(L.R_LATTICE, 0.3, fade='left', spatter=False, dust=0.2)
    lx0, ly0, lx1, ly1 = L.R_LATTICE
    for _ in range(14):                                # zinc-worn rust spots
        wx.rust_blotch(lx0 + RNG.random() * (lx1 - lx0),
                       ly0 + 6 + RNG.random() * (ly1 - ly0 - 12),
                       3 + RNG.random() * 5, strength=0.5)
    # pump machinery: greasy joints
    wx.oily(L.R_GEAR.rect, 0.5)
    wx.oily(L.R_POST, 0.15)
    gb = L.R_BEAM_S.rect
    wx.oily((gb[0] + (gb[2] - gb[0]) * 0.45, gb[1],
             gb[0] + (gb[2] - gb[0]) * 0.62, gb[3]), 0.45)  # saddle bearing
    # wellhead wrap: crude seep from the stuffing box (u≈1 end)
    wwx0, wwy0, wwx1, wwy1 = L.R_WELL
    wx.oily((wwx0 + (wwx1 - wwx0) * 0.75, wwy0, wwx1, wwy1), 0.5)
    # doghouse: skirt mud + roof-line rust streaks
    for zd in (L.R_DOG_S, L.R_DOG_F):
        x0, y0, x1, y1 = zd.rect
        wx.mud_band((x0, y1 - 40, x1, y1), 0.4, fade='down', spatter=True)
        wx.plate_bottom_rust(zd.rect, n=6, strength=0.5)
        for fx in np.linspace(0.12, 0.88, 6):
            wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 8,
                           20 + RNG.random() * 30, width=2.2, strength=0.28)
    wx.mud_band(L.R_DOG_R.rect, 0.2, fade=None, spatter=False, dust=0.3)
    # counterweight rust
    wx.plate_bottom_rust(L.R_CWT.rect, n=4, strength=0.5)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.45)
    wx.apply(m)

    # ── normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for zd in (L.R_DOG_S, L.R_DOG_F):                 # corrugation
        x0, y0, x1, y1 = zd.rect
        for gx in range(x0 + 4, x1, 14):
            hm.line((gx, y0 + 2), (gx, y1 - 46), 0.25, width=1)
    x0, y0, x1, y1 = L.R_DOG_R.rect
    for gx in range(x0 + 6, x1, 16):
        hm.line((gx, y0 + 2), (gx, y1 - 2), 0.3, width=2)
    z = L.R_PLATE_T                                    # expansion joints
    for wxm in (-4.8, -1.6, 1.6, 4.8):
        gx = z.uv((wxm, 0, 0))[0] * W
        hm.line((gx, z.rect[1] + 3, ), (gx, z.rect[3] - 3), -0.5, width=2)
    for wzm in (-2.6, 0.0, 2.6):
        gy = z.uv((0, 0, wzm))[1] * W
        hm.line((z.rect[0] + 3, gy), (z.rect[2] - 3, gy), -0.5, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=3.6).save(f'out/{STEM}_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save(f'out/{STEM}_diffuse.png')
    m.orm.save(f'out/{STEM}_orm.png')
    m.emi.save(f'out/{STEM}_emissive.png')
    m.tea.save(f'out/{STEM}_team.png')
    print(f'[paint_ms_oil_derrick] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
