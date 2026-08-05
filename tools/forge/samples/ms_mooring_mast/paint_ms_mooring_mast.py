"""paint_ms_mooring_mast — 2048² PBR set for ms_mooring_mast.

Airfield-hardware read: stained concrete anchor pad with hazard corners
and a painted mooring circle, ARMOR equipment hut with vent grille +
team stripe, galvanised lattice tower, steel spiral stair with tread
nosings, hazard-chevroned parapet, rotating mooring head (panelled drum
with a team band, ribbed receiver cone with aviation hazard rings at the
mouth), gangway walkway, striped counterweight, and the red aviation
beacon — the ONLY emissive on the model (spec: red beacon, emissive).
Weathering: pad grime + spatter, hut/counterweight rust, bearing grease
at the drum base, bolt rust with gravity streaks.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_mooring_mast_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
CONCRETE = (146, 144, 138)
GALV = (166, 170, 175)
DECK = (88, 93, 100)
RED = (188, 44, 36)
RED_GLOW = (255, 62, 40)


def hazard_band_v(m, box, step=18):
    """Vertical-edge hazard chevrons across a horizontal band."""
    x0, y0, x1, y1 = [int(v) for v in box]
    for i in range((x1 - x0) // step + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * step, y0), (x0 + i * step + step, y0),
                     (x0 + i * step + step - 8, y1), (x0 + i * step - 8, y1)],
                    fill=c)
    m.o.rectangle(box, fill=(AO_BASE - 6, R_ARMOR, M_ARMOR))


# ── pad + hut ────────────────────────────────────────────────────────────

def paint_pad(m):
    z = L.R_PAD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 24,
         metal=0)
    # expansion joints
    for f in (0.25, 0.5, 0.75):
        m.d.line([(x0 + (x1 - x0) * f, y0 + 2), (x0 + (x1 - x0) * f, y1 - 2)],
                 fill=shade(CONCRETE, 0.85), width=3)
        m.d.line([(x0 + 2, y0 + (y1 - y0) * f), (x1 - 2, y0 + (y1 - y0) * f)],
                 fill=shade(CONCRETE, 0.85), width=3)
    # tonal patches
    for _ in range(10):
        bx = x0 + RNG.random() * (x1 - x0 - 120)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 10), (bx + 84, by), (bx + 108, by + 38),
                     (bx + 22, by + 50)], fill=jit(shade(CONCRETE, 0.94), 3))
    # painted mooring circle (yellow ring, r ≈ 4.3 m) + inner rotation ring
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    px_m = (x1 - x0) / 10.8
    for rr, wd in ((4.3 * px_m, 8), (2.0 * px_m, 5)):
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=(178, 150, 52), width=wd)
    # approach lane to the stair foot (-Z = image top of the zone)
    m.d.rectangle([cx - 34, y0 + 8, cx + 34, cy - 2.0 * px_m],
                  outline=(178, 150, 52), width=5)
    # hazard corner wedges
    cw = 52
    for ax, ay in ((x0, y0), (x1 - cw, y0), (x0, y1 - cw), (x1 - cw, y1 - cw)):
        for i in range(0, cw, 16):
            m.d.polygon([(ax + i, ay), (ax + i + 8, ay), (ax, ay + i + 8),
                         (ax, ay + i)],
                        fill=YELLOW if (i // 16) % 2 == 0 else BLACKISH)
    # anchor bolts by the footings (world ±1.85 m)
    for sx in (-1, 1):
        for sz in (-1, 1):
            u, v = z.uv((sx * 1.85, 0, sz * 1.85))
            bolts(m, [(u * W - 18, v * W - 18), (u * W + 18, v * W - 18),
                      (u * W - 18, v * W + 18), (u * W + 18, v * W + 18)],
                  r=5, base=CONCRETE)
    # tire scuff arcs on the lane
    for dx in (-20, 20):
        for t in range(30):
            a = t / 29
            m.d.ellipse([cx + dx - 5, y0 + 20 + a * 150 - 3,
                         cx + dx + 5, y0 + 20 + a * 150 + 3],
                        fill=jit(shade(CONCRETE, 0.82), 4))
    fill(m, L.R_PADS.rect, dif=shade(CONCRETE, 0.9), ao=AO_BASE - 10,
         rough=R_ARMOR + 24, metal=0)
    x0, y0, x1, y1 = L.R_PADS.rect
    seam_h(m, x0 + 2, x1 - 2, y0 + (y1 - y0) // 2, CONCRETE, hi=False)


def paint_hut(m):
    for z in (L.R_HUT, L.R_HUT_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
             metal=M_ARMOR)
        seam_h(m, x0 + 2, x1 - 2, y0 + (y1 - y0) // 3, ARMOR)
        vent_slots(m, (x0 + 36, y1 - 110, x0 + (x1 - x0) // 2 - 20, y1 - 40), 4)
        # personnel door (right half)
        dx0 = x0 + (x1 - x0) * 0.58
        m.d.rectangle([dx0, y0 + (y1 - y0) * 0.28, dx0 + 92, y1 - 16],
                      fill=(52, 56, 62), outline=shade(ARMOR, 0.5), width=3)
        m.o.rectangle([dx0, y0 + (y1 - y0) * 0.28, dx0 + 92, y1 - 16],
                      fill=(AO_BASE - 22, R_ARMOR, M_ARMOR))
        # team stripe down the left edge
        m.d.rectangle([x0 + 8, y0 + 6, x0 + 30, y1 - 6], fill=TEAMGREY)
        m.t.rectangle([x0 + 8, y0 + 6, x0 + 30, y1 - 6], fill=(255, 0, 0))
        bolts(m, [(x0 + 44, y0 + 14), (x1 - 14, y0 + 14),
                  (x0 + 44, y1 - 14), (x1 - 14, y1 - 14)], base=ARMOR)
        wear_edges(m, z.rect, ARMOR, density=22)
    x0, y0, x1, y1 = L.R_HUT_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.94), ao=AO_BASE - 6,
         rough=R_ARMOR + 6, metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, ARMOR)


# ── tower / stair / platform ─────────────────────────────────────────────

def paint_tower(m):
    fill(m, L.R_TOWER, dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 10,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.R_TOWER
    # gusset/splice banding along the members (u runs along each limb)
    for gx in range(int(x0) + 28, int(x1), 56):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(GALV, 0.8), width=3)
        m.d.line([(gx + 3, y0 + 2), (gx + 3, y1 - 2)],
                 fill=shade(GALV, 1.12), width=1)
    # dulled galv patches
    for _ in range(8):
        bx = x0 + RNG.random() * (x1 - x0 - 60)
        by = y0 + RNG.random() * (y1 - y0 - 24)
        m.d.polygon([(bx, by + 6), (bx + 48, by), (bx + 60, by + 18),
                     (bx + 12, by + 24)], fill=jit(shade(GALV, 0.92), 4))
    fill(m, L.R_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.R_TRIM
    for gy in range(int(y0) + 12, int(y1), 24):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(STEEL_DK, 0.82),
                 width=2)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)
    # footing blocks: concrete with a steel base ring
    x0, y0, x1, y1 = L.R_ANCHOR.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.88), ao=AO_BASE - 8,
         rough=R_ARMOR + 20, metal=0)
    m.d.rectangle([x0 + 8, y0 + 8, x1 - 8, y1 - 8],
                  outline=STEEL_DK, width=5)
    bolts(m, [(x0 + 22, y0 + 22), (x1 - 22, y0 + 22),
              (x0 + 22, y1 - 22), (x1 - 22, y1 - 22)], r=4,
          base=shade(CONCRETE, 0.88))


def paint_stair(m):
    x0, y0, x1, y1 = L.R_STAIR
    bh = (y1 - y0) // 4
    # top band: treads — step nosings across the ribbon (u = along)
    fill(m, (x0, y0, x1, y0 + bh), dif=DECK, ao=AO_BASE - 6, rough=R_STEEL + 20,
         metal=M_STEEL - 40)
    for gx in range(int(x0) + 6, int(x1), 11):
        m.d.line([(gx, y0 + 3), (gx, y0 + bh - 3)], fill=shade(DECK, 0.7),
                 width=2)
        m.d.line([(gx + 2, y0 + 3), (gx + 2, y0 + bh - 3)],
                 fill=shade(DECK, 1.25), width=1)
    # outer band: side plate with a stiffener + bolt row
    fill(m, (x0, y0 + bh, x1, y0 + 2 * bh), dif=STEEL, ao=AO_BASE - 8,
         rough=R_STEEL, metal=M_STEEL)
    seam_h(m, x0 + 2, x1 - 2, y0 + bh + bh // 2, STEEL, hi=False)
    bolts(m, [(x0 + 24 + i * 60, y0 + bh + bh // 2 + 12)
              for i in range((int(x1 - x0) - 40) // 60)], r=3, base=STEEL)
    # bottom + inner bands: darker underside steel
    fill(m, (x0, y0 + 2 * bh, x1, y0 + 3 * bh), dif=shade(STEEL, 0.78),
         ao=AO_BASE - 16, rough=R_STEEL + 10, metal=M_STEEL - 20)
    fill(m, (x0, y0 + 3 * bh, x1, y1), dif=shade(STEEL, 0.85),
         ao=AO_BASE - 12, rough=R_STEEL, metal=M_STEEL)


def paint_platform(m):
    z = L.R_PLAT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DECK, ao=AO_BASE - 4, rough=R_STEEL + 24,
         metal=M_STEEL - 60)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    px_m = (x1 - x0) / 6.6
    # tread cross-hatch
    for gx in range(int(x0) + 10, int(x1), 26):
        m.d.line([(gx, y0 + 3), (gx, y1 - 3)], fill=shade(DECK, 0.88), width=2)
    for gy in range(int(y0) + 10, int(y1), 26):
        m.d.line([(x0 + 3, gy), (x1 - 3, gy)], fill=shade(DECK, 0.88), width=2)
    # radial plate seams from the hub
    for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        m.d.line([(cx + np.cos(a) * 0.95 * px_m, cy + np.sin(a) * 0.95 * px_m),
                  (cx + np.cos(a) * 3.1 * px_m, cy + np.sin(a) * 3.1 * px_m)],
                 fill=shade(DECK, 0.72), width=3)
    # hazard edge ring
    rr = 3.05 * px_m
    for i, a in enumerate(np.linspace(0, 2 * np.pi, 48, endpoint=False)):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.line([(cx + np.cos(a) * (rr - 12), cy + np.sin(a) * (rr - 12)),
                  (cx + np.cos(a + 0.13) * rr, cy + np.sin(a + 0.13) * rr)],
                 fill=c, width=9)
    # centre bearing hub + team quadrant
    hub = 1.0 * px_m
    m.d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub],
                fill=shade(DECK, 0.8), outline=shade(DECK, 0.6), width=4)
    m.o.ellipse([cx - hub, cy - hub, cx + hub, cy + hub],
                fill=(AO_BASE - 14, R_STEEL, M_STEEL))
    m.d.pieslice([cx - hub, cy - hub, cx + hub, cy + hub], -45, 45,
                 fill=TEAMGREY)
    m.t.pieslice([cx - hub, cy - hub, cx + hub, cy + hub], -45, 45,
                 fill=(255, 0, 0))
    bolts(m, [(cx + np.cos(a) * hub * 1.25, cy + np.sin(a) * hub * 1.25)
              for a in np.linspace(0.2, 2 * np.pi + 0.2, 12, endpoint=False)],
          r=4, base=DECK)
    # stair-arrival walk strip (-Z = image top)
    m.d.rectangle([cx - 0.55 * px_m, y0 + 6, cx + 0.55 * px_m, cy - hub],
                  fill=shade(DECK, 1.1))
    m.d.rectangle([cx - 0.55 * px_m, y0 + 6, cx + 0.55 * px_m, cy - hub],
                  outline=(178, 150, 52), width=4)
    # rim + parapet wrap bands
    x0, y0, x1, y1 = L.R_RIM
    h = y1 - y0
    fill(m, (x0, y0, x1, y0 + int(h * 0.33)), dif=STEEL_DK, ao=AO_BASE - 10,
         rough=R_STEEL, metal=M_STEEL)
    seam_h(m, x0 + 2, x1 - 2, y0 + int(h * 0.16), STEEL_DK, hi=False)
    hazard_band_v(m, (x0, y0 + int(h * 0.33), x1, y0 + int(h * 0.62)))
    fill(m, (x0, y0 + int(h * 0.62), x1, y0 + int(h * 0.80)), dif=STEEL,
         ao=AO_BASE - 8, rough=R_STEEL, metal=M_STEEL)
    fill(m, (x0, y0 + int(h * 0.80), x1, y1), dif=shade(STEEL, 0.85),
         ao=AO_BASE - 14, rough=R_STEEL, metal=M_STEEL)
    bolts(m, [(x0 + 30 + i * 72, y0 + int(h * 0.70))
              for i in range((int(x1 - x0) - 60) // 72)], r=3, base=STEEL)


# ── head / cone / gangway / counterweight / beacon ───────────────────────

def paint_head(m):
    # drum wrap: panel seams + team band + base bolt ring
    x0, y0, x1, y1 = L.R_HEAD
    fill(m, (x0, y0, x1, y1), dif=ARMOR_LT, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR + 40)
    for f in (0.125, 0.375, 0.625, 0.875):
        seam_v(m, int(x0 + (x1 - x0) * f), y0 + 2, y1 - 2, ARMOR_LT, hi=False)
    m.d.rectangle([x0 + 2, y0 + 14, x1 - 2, y0 + 40], fill=TEAMGREY)
    m.t.rectangle([x0 + 2, y0 + 14, x1 - 2, y0 + 40], fill=(255, 0, 0))
    bolts(m, [(x0 + 18 + i * 48, y1 - 12)
              for i in range((int(x1 - x0) - 30) // 48)], r=3, base=ARMOR_LT)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_LT, density=26)
    # drum top: radial plate, hub, bolt circle
    z = L.R_HEAD_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR_LT, 0.94), ao=AO_BASE - 6,
         rough=R_ARMOR + 6, metal=M_ARMOR + 40)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.42, 0.22):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(ARMOR_LT, 0.78), width=4)
    m.d.ellipse([cx - 16, cy - 16, cx + 16, cy + 16], fill=STEEL_DK)
    bolts(m, [(cx + np.cos(a) * (x1 - x0) * 0.42,
               cy + np.sin(a) * (x1 - x0) * 0.42)
              for a in np.linspace(0.15, 2 * np.pi + 0.15, 10, endpoint=False)],
          r=3, base=ARMOR_LT)
    # receiver cone: ribbed steel, aviation hazard rings at the mouth (right)
    x0, y0, x1, y1 = L.R_CONE
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 6, rough=R_STEEL - 6,
         metal=M_STEEL)
    for f in (0.22, 0.46, 0.7):
        sx = int(x0 + (x1 - x0) * f)
        m.d.rectangle([sx - 3, y0 + 2, sx + 3, y1 - 2],
                      fill=shade(GALV, 0.74))
        m.o.rectangle([sx - 3, y0 + 2, sx + 3, y1 - 2],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    band = int((x1 - x0) * 0.09)
    for i in range(3):
        bx1 = int(x1 - i * band)
        c = RED if i % 2 == 0 else (222, 220, 214)
        m.d.rectangle([bx1 - band, y0 + 2, bx1, y1 - 2], fill=c)
    # cone interior + mouth annulus: shadowed throat
    fill(m, L.R_CONE_IN, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=M_ARMOR)


def paint_gangway(m):
    for z in (L.R_GANG, L.R_GANG_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6, rough=R_ARMOR,
             metal=M_ARMOR)
        seam_h(m, x0 + 2, x1 - 2, y0 + (y1 - y0) // 2, ARMOR, hi=False)
        # handrail line + hazard toe plate
        m.d.rectangle([x0 + 2, y0 + 10, x1 - 2, y0 + 20],
                      fill=shade(STEEL, 0.9))
        hazard_band_v(m, (x0 + 2, y1 - 24, x1 - 2, y1 - 4), step=16)
        bolts(m, [(x0 + 14, y0 + 34), (x1 - 14, y0 + 34)], base=ARMOR)
        wear_edges(m, z.rect, ARMOR, density=18)
    z = L.R_GANG_T
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DECK, ao=AO_BASE - 6, rough=R_STEEL + 20,
         metal=M_STEEL - 40)
    for gy in range(int(y0) + 8, int(y1), 14):
        m.d.line([(x0 + 4, gy), (x1 - 4, gy)], fill=shade(DECK, 0.72), width=2)
    m.d.rectangle([x0 + 2, y0 + 2, x0 + 12, y1 - 2], fill=(178, 150, 52))
    m.d.rectangle([x1 - 12, y0 + 2, x1 - 2, y1 - 2], fill=(178, 150, 52))


def paint_counterweight(m):
    for z in (L.R_CW, L.R_CW_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8,
             rough=R_STEEL + 10, metal=M_STEEL)
        # diagonal hazard stripes — the counterweight signature
        step = 34
        for i in range(-2, (x1 - x0) // step + 2):
            sx = x0 + i * step
            if i % 2 == 0:
                m.d.polygon([(sx, y1 - 4), (sx + step // 2, y1 - 4),
                             (sx + step // 2 + (y1 - y0 - 8), y0 + 4),
                             (sx + (y1 - y0 - 8), y0 + 4)], fill=YELLOW)
        m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade(STEEL_DK, 0.7),
                      width=4)
        bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12),
                  (x0 + 12, y1 - 12), (x1 - 12, y1 - 12)], base=STEEL_DK)
        wear_edges(m, z.rect, STEEL_DK, density=26)
    x0, y0, x1, y1 = L.R_CW_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_DK, 0.92), ao=AO_BASE - 10,
         rough=R_STEEL + 10, metal=M_STEEL)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, STEEL_DK, hi=False)


def paint_beacon(m):
    z = L.R_BEACON
    x0, y0, x1, y1 = z.rect
    # housing: red aviation-obstruction paint, dark cap and base
    fill(m, (x0, y0, x1, y1), dif=RED, ao=AO_BASE - 4, rough=R_GLASS + 40,
         metal=M_GLASS)
    m.d.rectangle([x0, y0, x1, y0 + 14], fill=BLACKISH)
    m.d.rectangle([x0, y1 - 14, x1, y1], fill=BLACKISH)
    # lens band — the ONLY emissive on the model (red beacon per spec)
    ly0 = y0 + (y1 - y0) * 0.3
    ly1 = y0 + (y1 - y0) * 0.7
    m.d.rectangle([x0 + 2, ly0, x1 - 2, ly1], fill=shade(RED, 1.25))
    m.o.rectangle([x0 + 2, ly0, x1 - 2, ly1], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([x0 + 2, ly0, x1 - 2, ly1], fill=RED_GLOW)


# ── assemble ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_hut(m)
    paint_tower(m)
    paint_stair(m)
    paint_platform(m)
    paint_head(m)
    paint_gangway(m)
    paint_counterweight(m)
    paint_beacon(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.4)
    wx.mud_band(L.R_PAD.rect, 0.32, fade=None, spatter=True)
    wx.mud_band(L.R_PADS.rect, 0.55, fade='down')
    for z in (L.R_HUT, L.R_HUT_F):
        wx.mud_band(z.rect, 0.42, fade='down', dust=0.3)
        wx.plate_bottom_rust(z.rect, n=5, strength=0.45)
    # galvanised tower: thin dust film only, splice-plate rust specks
    wx.mud_band(L.R_TOWER, 0.16, fade=None, spatter=False, dust=0.25)
    x0, y0, x1, y1 = L.R_TOWER
    for fx in (0.2, 0.55, 0.85):
        wx.rust_blotch(x0 + (x1 - x0) * fx, y0 + 20 + 60 * fx, 5, 0.5)
    # stair side plate + counterweight catch water
    x0, y0, x1, y1 = L.R_STAIR
    wx.plate_bottom_rust((x0, y0 + (y1 - y0) // 4, x1, y0 + (y1 - y0) // 2),
                         n=6, strength=0.4)
    for z in (L.R_CW, L.R_CW_F):
        wx.plate_bottom_rust(z.rect, n=5, strength=0.55)
        wx.mud_band(z.rect, 0.2, fade='down', dust=0.25)
    # drum: bearing grease ring at the base (rotating joint), light streaks
    x0, y0, x1, y1 = L.R_HEAD
    wx.oily((x0, y1 - 22, x1, y1), 0.55)
    for fx in (0.18, 0.5, 0.8):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 42, 30, width=2.4,
                       strength=0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.45)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    z = L.R_PAD
    x0, y0, x1, y1 = z.rect
    for f in (0.25, 0.5, 0.75):
        hm.line((x0 + (x1 - x0) * f, y0 + 2), (x0 + (x1 - x0) * f, y1 - 2),
                -0.5, width=3)
        hm.line((x0 + 2, y0 + (y1 - y0) * f), (x1 - 2, y0 + (y1 - y0) * f),
                -0.5, width=3)
    # stair tread nosings raised
    x0, y0, x1, y1 = L.R_STAIR
    bh = (y1 - y0) // 4
    for gx in range(int(x0) + 6, int(x1), 11):
        hm.line((gx, y0 + 3), (gx, y0 + bh - 3), 0.4, width=2)
    # platform tread grid raised
    x0, y0, x1, y1 = L.R_PLAT.rect
    for gx in range(int(x0) + 10, int(x1), 26):
        hm.line((gx, y0 + 3), (gx, y1 - 3), 0.3, width=2)
    for gy in range(int(y0) + 10, int(y1), 26):
        hm.line((x0 + 3, gy), (x1 - 3, gy), 0.3, width=2)
    # cone stiffener ribs raised
    x0, y0, x1, y1 = L.R_CONE
    for f in (0.22, 0.46, 0.7):
        hm.line((x0 + (x1 - x0) * f, y0 + 2), (x0 + (x1 - x0) * f, y1 - 2),
                0.45, width=4)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save('out/ms_mooring_mast_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_mooring_mast_diffuse.png')
    m.orm.save('out/ms_mooring_mast_orm.png')
    m.emi.save('out/ms_mooring_mast_emissive.png')
    m.tea.save('out/ms_mooring_mast_team.png')
    print('[paint_ms_mooring_mast] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
