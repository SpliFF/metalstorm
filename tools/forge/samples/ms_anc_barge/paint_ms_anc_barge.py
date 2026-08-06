"""paint_ms_anc_barge — 2048² PBR set for ms_anc_barge (ancient gravity barge).

ANCIENT REGISTER: pale monolithic stone-metal in three tone-on-tone
registers (deck / flank / belly), segmented ONLY by clean recessed seams —
no rivets, no bolt heads, no patchwork, no rust. Emissive CYAN is the whole
signature and it is ACTIVE (the barge is flying): a continuous lift-field
line runs the recessed hull groove bow to stern, three emitter channels and
five perfect-circle emitter faces burn in the keel-less plenum, and the two
threading rings and the sensor ring glow along their inboard faces.
Weathering is geological — dust drift on the deck, thin dust on the flank,
field scorch under the emitters. Team colour is the deck chevron (capturable
marker) plus a small flank stripe, mask-only.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_barge_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, shade, jit, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP, R_ARMOR, M_ARMOR)

W = 2048

# ── ancient palette: pale, precise, low-contrast ────────────────────────
ANC_DECK = (147, 150, 145)
ANC_HULL = (133, 136, 134)
ANC_BELL = (105, 108, 110)
ANC_LT = (163, 166, 160)
ANC_DK = (70, 74, 77)
ANC_SEAM = (88, 92, 94)
CY = CYAN
CY_DIM = (26, 92, 116)
CY_MID = (48, 150, 184)

R_STONE, M_STONE = 148, 70          # smooth, barely metallic monolith


def rc(rect):
    return [int(v) for v in rect]


def seam(m, a, b, w=3, col=ANC_SEAM):
    """A clean recessed seam — the ONLY thing that breaks these surfaces."""
    m.d.line([a, b], fill=col, width=w)
    m.o.line([a, b], fill=(AO_SEAM, 190, M_STONE), width=w)


# ── deck ────────────────────────────────────────────────────────────────

def paint_deck(m):
    z = L.Z_DECK
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_DECK, ao=AO_BASE, rough=R_STONE,
         metal=M_STONE)

    zs = np.linspace(-15.0, 15.0, 61)
    # deck-edge inset band: one continuous margin following the cantilever
    for sgn in (1, -1):
        outer = [(u(zz), v(sgn * L.wd_at(zz))) for zz in zs]
        inner = [(u(zz), v(sgn * (L.wd_at(zz) - 0.55))) for zz in zs]
        m.d.polygon(outer + inner[::-1], fill=shade(ANC_DECK, 0.965))
        m.d.line(inner, fill=ANC_SEAM, width=3)
        m.o.line(inner, fill=(AO_SEAM, 195, M_STONE), width=3)

    # transverse recessed seams — big unbroken panels between them
    for sz in L.DECK_SEAMS:
        wd = L.wd_at(sz)
        seam(m, (u(sz), v(-wd)), (u(sz), v(wd)), w=4)
    for lx in L.DECK_LONG:
        for sgn in (1, -1):
            seam(m, (u(-13.6), v(sgn * lx)), (u(13.6), v(sgn * lx)), w=3)

    # centre spine channel: recessed, with the deck tracery running in it
    sz0, sz1 = L.SPINE_Z
    ch = rc([u(sz0), v(-L.SPINE_HW), u(sz1), v(L.SPINE_HW)])
    m.d.rectangle(ch, fill=shade(ANC_DECK, 0.90))
    m.o.rectangle(ch, fill=(AO_DEEP, 200, M_STONE))
    for sgn in (1, -1):
        ln = [(u(sz0 + 0.4), v(sgn * 0.42)), (u(sz1 - 0.4), v(sgn * 0.42))]
        m.d.line(ln, fill=CY_MID, width=3)
        m.e.line(ln, fill=CY_MID, width=3)
    # tracery nodes — sparing, but alive
    for nz in (-13.0, -8.0, -2.0, 4.0, 9.5, 13.4):
        node = rc([u(nz - 0.16), v(-0.60), u(nz + 0.16), v(0.60)])
        m.d.rectangle(node, fill=CY_MID)
        m.e.rectangle(node, fill=CY)

    # team-mask deck chevron — the capturable marker
    poly = [(u(cz), v(cx)) for (cz, cx) in L.CHEVRON]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAMGREY)
    m.d.line(poly + [poly[0]], fill=shade(ANC_DECK, 0.72), width=3)

    # ancient glyph course aft: shallow recessed blocks, tone-on-tone
    for i, gz in enumerate((6.2, 6.9, 7.6, 8.3)):
        gh = 0.55 + 0.18 * (i % 3)
        blk = rc([u(gz), v(-gh), u(gz + 0.34), v(gh)])
        m.d.rectangle(blk, fill=shade(ANC_DECK, 0.93))
        m.o.rectangle(blk, fill=(AO_SEAM, 200, M_STONE))


# ── flank ───────────────────────────────────────────────────────────────

def paint_hull(m):
    z = L.Z_HULL
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_HULL, ao=AO_BASE - 4, rough=R_STONE,
         metal=M_STONE)

    # deck-edge bevel band (y 4.35..4.00) reads a shade lighter
    m.d.rectangle(rc([x0, v(4.50), x1, v(4.00)]), fill=ANC_LT)
    # lower flank below the groove darkens toward the plenum
    m.d.rectangle(rc([x0, v(2.60), x1, v(1.90)]), fill=shade(ANC_HULL, 0.94))

    # THE lift-field groove: recessed channel, cyan running its whole length
    gr = rc([x0, v(L.Y_G_HI), x1, v(L.Y_G_LO)])
    m.d.rectangle(gr, fill=ANC_DK)
    m.o.rectangle(gr, fill=(AO_DEEP, 205, M_STONE))
    core = rc([x0, v(3.455), x1, v(3.335)])
    m.d.rectangle(core, fill=CY_MID)
    m.e.rectangle(core, fill=CY)
    # a second, dimmer field line on the chine
    ch = rc([x0, v(2.40), x1, v(2.34)])
    m.d.rectangle(ch, fill=CY_MID)
    m.e.rectangle(ch, fill=CY_MID)

    # clean vertical seams — sparse, low contrast, never a plate joint
    for sz in np.arange(-13.0, 14.1, 3.4):
        seam(m, (u(sz), v(4.48)), (u(sz), v(1.94)), w=3)
    # field nodes where the groove crosses a seam
    for sz in (-11.6, -4.8, 2.0, 8.8):
        nd = rc([u(sz - 0.16), v(3.55), u(sz + 0.16), v(3.24)])
        m.d.rectangle(nd, fill=CY_MID)
        m.e.rectangle(nd, fill=CY)

    # team stripe on the upper flank band (side-readable ownership)
    for (sz0, sz1) in ((-13.2, -10.4), (9.6, 12.6)):
        bar = rc([u(sz0), v(3.96), u(sz1), v(3.70)])
        m.t.rectangle(bar, fill=(255, 0, 0))
        m.d.rectangle(bar, fill=TEAMGREY)


# ── belly ───────────────────────────────────────────────────────────────

def paint_belly(m):
    z = L.Z_BELLY
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_BELL, ao=AO_BASE - 14, rough=R_STONE + 20,
         metal=M_STONE)

    cz0, cz1 = L.CHANNEL_Z
    # three longitudinal emitter channels — recessed, cyan cored
    for cx in L.BELLY_CHANNELS:
        hw = 0.52 if cx == 0.0 else 0.36
        for sgn in ((1,) if cx == 0.0 else (1, -1)):
            band = rc([u(cz0), v(sgn * cx - hw), u(cz1), v(sgn * cx + hw)])
            m.d.rectangle(band, fill=shade(ANC_BELL, 0.84))
            m.o.rectangle(band, fill=(AO_DEEP, 210, M_STONE))
            core = rc([u(cz0 + 0.3), v(sgn * cx - 0.08),
                       u(cz1 - 0.3), v(sgn * cx + 0.08)])
            m.d.rectangle(core, fill=CY_MID)
            m.e.rectangle(core, fill=CY_MID)

    # transverse ties, tone-on-tone
    for sz in np.arange(-11.5, 12.1, 3.9):
        seam(m, (u(sz), v(-5.6)), (u(sz), v(5.6)), w=3,
             col=shade(ANC_BELL, 0.90))


# ── detail cells ────────────────────────────────────────────────────────

def paint_cells(m):
    # bow transom: a single recessed slot with a dim core
    z = L.Z_BOW
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_HULL, ao=AO_BASE - 6, rough=R_STONE,
         metal=M_STONE)
    cxm = (x0 + x1) // 2
    m.d.rectangle([cxm - 16, y0 + 40, cxm + 16, y1 - 34], fill=ANC_DK)
    m.o.rectangle([cxm - 16, y0 + 40, cxm + 16, y1 - 34],
                  fill=(AO_DEEP, 205, M_STONE))
    m.d.rectangle([cxm - 5, y0 + 52, cxm + 5, y1 - 46], fill=CY_MID)
    m.e.rectangle([cxm - 5, y0 + 52, cxm + 5, y1 - 46], fill=CY_MID)

    # stern transom: twin perfect circles — the drive apertures
    z = L.Z_STERN
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_HULL, ao=AO_BASE - 6, rough=R_STONE,
         metal=M_STONE)
    for fx in (0.30, 0.70):
        cx, cy, r = x0 + (x1 - x0) * fx, (y0 + y1) / 2 + 12, 40
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ANC_DK)
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r],
                    fill=(AO_DEEP, 205, M_STONE))
        m.d.ellipse([cx - r * 0.55, cy - r * 0.55, cx + r * 0.55,
                     cy + r * 0.55], fill=CY_MID)
        m.e.ellipse([cx - r * 0.55, cy - r * 0.55, cx + r * 0.55,
                     cy + r * 0.55], fill=CY)
    m.d.rectangle([x0 + 10, y0 + 10, x1 - 10, y0 + 18],
                  fill=shade(ANC_HULL, 0.8))

    # fin sides — deliberately tone-on-tone (3-tri faces: no thin bright art)
    z = L.Z_FIN
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_HULL, ao=AO_BASE - 4, rough=R_STONE,
         metal=M_STONE)
    m.d.rectangle(rc([x0, y0, x1, v(5.75)]), fill=shade(ANC_HULL, 1.06))
    seam(m, (u(11.0), y0 + 4), (u(11.0), y1 - 4), w=4)
    seam(m, (u(13.1), y0 + 4), (u(13.1), y1 - 4), w=4)

    # fin leading edge — solid lit rim
    x0, y0, x1, y1 = L.Z_FINLEAD.rect
    fill(m, (x0, y0, x1, y1), dif=CY_MID, ao=AO_BASE - 10, rough=120, metal=40)
    m.e.rectangle([x0, y0, x1, y1], fill=CY)

    # neutral structural trim + dark recesses
    x0, y0, x1, y1 = L.Z_TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE - 6, rough=R_STONE,
         metal=M_STONE)
    m.d.rectangle([x0, (y0 + y1) // 2 - 4, x1, (y0 + y1) // 2 + 4],
                  fill=shade(ANC_LT, 0.86))
    fill(m, L.Z_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=30)

    # deck cradle pad face: concentric circles + one thin cyan ring
    x0, y0, x1, y1 = L.Z_PAD
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE - 2, rough=R_STONE,
         metal=M_STONE)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = (x1 - x0) / 2
    for f, col, wdt in ((0.94, shade(ANC_LT, 0.88), 4),
                        (0.70, shade(ANC_LT, 0.90), 3),
                        (0.34, shade(ANC_LT, 0.90), 3)):
        r = half * f
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=wdt)
    r = half * 0.52
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CY_MID, width=5)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CY_MID, width=5)
    for a in range(8):
        th = np.pi * a / 4 + np.pi / 8
        m.d.line([(cx + half * 0.72 * np.cos(th), cy + half * 0.72 * np.sin(th)),
                  (cx + half * 0.92 * np.cos(th), cy + half * 0.92 * np.sin(th))],
                 fill=shade(ANC_LT, 0.88), width=4)
    x0, y0, x1, y1 = L.R_PADBAND
    fill(m, (x0, y0, x1, y1), dif=shade(ANC_LT, 0.80), ao=AO_SEAM,
         rough=R_STONE, metal=M_STONE)

    # belly emitter face: dark annulus around a burning cyan core
    x0, y0, x1, y1 = L.Z_EMIT
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_DEEP, rough=170, metal=60)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = (x1 - x0) / 2
    r = half * 0.86
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade(ANC_BELL, 0.92),
                width=5)
    r = half * 0.62
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CY_MID)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CY_MID)
    r = half * 0.34
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(200, 246, 255))
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(206, 250, 255))
    x0, y0, x1, y1 = L.R_EMITBAND
    fill(m, (x0, y0, x1, y1), dif=shade(ANC_BELL, 0.6), ao=AO_DEEP,
         rough=190, metal=50)
    m.d.rectangle([x0, y1 - 26, x1, y1 - 12], fill=CY_MID)
    m.e.rectangle([x0, y1 - 26, x1, y1 - 12], fill=CY_MID)

    # ring wraps — v band nn//2 (0.50..0.667) is the INBOARD face
    for (rect, nn, glow) in ((L.R_RING, L.PROW_RING['nn'], CY),
                             (L.R_SENS, L.SENSOR['nn'], CY)):
        x0, y0, x1, y1 = rect
        h = y1 - y0
        fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE - 2, rough=R_STONE,
             metal=M_STONE)
        j = nn // 2
        ib = [x0, int(y0 + h * j / nn) + 1, x1, int(y0 + h * (j + 1) / nn) - 1]
        m.d.rectangle(ib, fill=CY_MID)
        m.e.rectangle(ib, fill=glow)
        for k in (j - 1, j + 1):                     # soft falloff either side
            band = [x0, int(y0 + h * k / nn) + 2, x1,
                    int(y0 + h * (k + 1) / nn) - 2]
            m.d.rectangle(band, fill=shade(ANC_LT, 0.82))
            m.e.rectangle([band[0], band[3] - 6, band[2], band[3]]
                          if k < j else [band[0], band[1], band[2], band[1] + 6],
                          fill=CY_DIM)
        for i in range(1, 12):                       # segment seams around it
            sx = x0 + (x1 - x0) * i / 12
            m.d.line([(sx, y0), (sx, y1)], fill=shade(ANC_LT, 0.88), width=3)
            m.o.line([(sx, y0), (sx, y1)], fill=(AO_SEAM, 195, M_STONE),
                     width=3)

    x0, y0, x1, y1 = L.R_PYLON
    fill(m, (x0, y0, x1, y1), dif=shade(ANC_LT, 0.66), ao=AO_SEAM,
         rough=R_STONE, metal=M_STONE)


# ── assembly ────────────────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_deck(m)
    paint_hull(m)
    paint_belly(m)
    paint_cells(m)

    # geological weathering only: dust drift, no rust, nothing bolted
    from weathering import Weather
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.30)
    wx.mud_band(L.Z_DECK.rect, 0.20, fade=None, spatter=True, dust=0.26)
    wx.mud_band(L.Z_HULL.rect, 0.16, fade='down', spatter=False, dust=0.22)
    wx.soot_patch(L.Z_BELLY.rect, 0.34)              # field scorch
    wx.soot_patch(L.R_EMITBAND, 0.45)
    wx.soot_patch(L.Z_STERN.rect, 0.22)

    # recessed seams and channels as real height detail
    from normals import HeightMap
    hm = HeightMap()
    zd, zh, zb = L.Z_DECK, L.Z_HULL, L.Z_BELLY
    ud, vd = PL.zone_fns(zd)
    uh, vh = PL.zone_fns(zh)
    ub, vb = PL.zone_fns(zb)
    for sz in L.DECK_SEAMS:
        wd = L.wd_at(sz)
        hm.line((ud(sz), vd(-wd)), (ud(sz), vd(wd)), -0.55, width=4)
    for lx in L.DECK_LONG:
        for sgn in (1, -1):
            hm.line((ud(-13.6), vd(sgn * lx)), (ud(13.6), vd(sgn * lx)),
                    -0.45, width=3)
    hm.rect(rc([ud(L.SPINE_Z[0]), vd(-L.SPINE_HW), ud(L.SPINE_Z[1]),
                vd(L.SPINE_HW)]), -0.7)
    hm.rect(rc([zh.rect[0], vh(L.Y_G_HI), zh.rect[2], vh(L.Y_G_LO)]), -0.9)
    for sz in np.arange(-13.0, 14.1, 3.4):
        hm.line((uh(sz), vh(4.48)), (uh(sz), vh(1.94)), -0.5, width=3)
    for cx in L.BELLY_CHANNELS:
        hw = 0.52 if cx == 0.0 else 0.36
        for sgn in ((1,) if cx == 0.0 else (1, -1)):
            hm.rect(rc([ub(L.CHANNEL_Z[0]), vb(sgn * cx - hw),
                        ub(L.CHANNEL_Z[1]), vb(sgn * cx + hw)]), -0.75)

    PL.finish(m, L, 'ms_anc_barge', hm=hm, wx=wx, emissive_blur=0.9)


if __name__ == '__main__':
    paint_all()
