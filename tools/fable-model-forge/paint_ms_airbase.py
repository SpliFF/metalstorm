"""paint_ms_airbase — 2048 sq PBR set for ms_airbase.

Airfield read: weathered concrete apron carrying ALL airfield markings as
paint (runway strip along x with worn centreline dashes, edge lines and
threshold bars, two hard-stand pad circles, a big painted team roundel),
corrugated patched-steel hangar shell with a dark interior and an amber work
glow on the inner back wall, hazard-banded door jambs, galvanised lattice
tower with a glazed warm-lit cab and a red-amber beacon, orange windsock,
olive fuel drums/bowser and warm floodlight heads. Emissive is amber/warm
functional light only — zero blue-dominant pixels.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_airbase_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade, jit,
                   BOLT_LOG, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   ARMOR, ARMOR_DK, STEEL, STEEL_DK,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 2048
STEM = 'ms_airbase'
RNG = np.random.default_rng(90210)

CONCRETE = (140, 138, 131)
RUNWAY = (127, 126, 121)
MARK = (192, 188, 176)          # worn airfield paint
CORR = (123, 119, 112)          # corrugated patched steel
CORR_PAL = [(123, 119, 112), (131, 125, 116), (114, 112, 107), (127, 121, 106)]
GALV = (166, 170, 175)
OLIVE = (99, 92, 72)
ORANGE = (186, 92, 32)
INT_DARK = (32, 30, 27)
GLOW_AMBER = (226, 146, 46)
BEACON_RED = (232, 84, 26)
LAMP_WARM = (240, 214, 150)


def team_roundel(m, cx, cy, r):
    """Team-masked stencil roundel: neutral grey diffuse + full-R team star."""
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=shade(CONCRETE, 0.94),
                outline=MARK, width=5)
    pts = []
    for i in range(10):
        a = -np.pi / 2 + i * np.pi / 5
        rr = r * 0.82 if i % 2 == 0 else r * 0.35
        pts.append((cx + rr * np.cos(a), cy + rr * np.sin(a)))
    m.d.polygon(pts, fill=(158, 160, 163))
    m.t.polygon(pts, fill=(255, 0, 0))
    m.t.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 0, 0), width=5)


def paint_apron(m):
    z = L.R_APRON
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 22,
         metal=0)
    u, v = PL.zone_fns(z)
    # expansion joints every 4 m
    for wx in np.arange(-16.0, 16.1, 4.0):
        m.d.line([(u(wx), y0 + 2), (u(wx), y1 - 2)], fill=shade(CONCRETE, 0.90),
                 width=2)
    for wz in np.arange(-12.0, 12.1, 4.0):
        m.d.line([(x0 + 2, v(wz)), (x1 - 2, v(wz))], fill=shade(CONCRETE, 0.90),
                 width=2)
    # runway strip along x
    m.d.rectangle([x0, v(L.RUN_Z0), x1, v(L.RUN_Z1)], fill=RUNWAY)
    m.o.rectangle([x0, v(L.RUN_Z0), x1, v(L.RUN_Z1)],
                  fill=(AO_BASE - 4, R_ARMOR + 26, 0))
    # edge lines
    for wz in (L.RUN_Z0 + 0.25, L.RUN_Z1 - 0.25):
        m.d.line([(u(-19.4), v(wz)), (u(19.4), v(wz))], fill=MARK, width=4)
    # centreline dashes
    zc = (L.RUN_Z0 + L.RUN_Z1) / 2
    wx = -15.6
    while wx < 15.6:
        m.d.rectangle(PL.nbox(u(wx), v(zc) - 4, u(wx + 1.9), v(zc) + 4),
                      fill=MARK)
        wx += 3.6
    # threshold bars (piano keys) at both ends
    for sx in (-1, 1):
        for wz in np.arange(L.RUN_Z0 + 1.0, L.RUN_Z1 - 0.9, 1.5):
            m.d.rectangle(PL.nbox(u(sx * 19.0), v(wz), u(sx * 16.6),
                                  v(wz + 0.75)), fill=MARK)
    # hard-stand pad circles + tie-down crosses
    for (px, pz) in (L.PAD_A, L.PAD_B):
        m.d.ellipse([u(px - L.PAD_R), v(pz - L.PAD_R),
                     u(px + L.PAD_R), v(pz + L.PAD_R)],
                    fill=shade(CONCRETE, 0.95), outline=MARK, width=5)
        m.d.line([(u(px - 0.9), v(pz)), (u(px + 0.9), v(pz))], fill=MARK,
                 width=4)
        m.d.line([(u(px), v(pz - 0.9)), (u(px), v(pz + 0.9))], fill=MARK,
                 width=4)
    # big painted team roundel
    rx, rz, rr = L.ROUNDEL
    team_roundel(m, u(rx), v(rz), (u(rx + rr) - u(rx)))
    # oil staining on the pads and in front of the hangar
    for (px, pz) in (L.PAD_A, L.PAD_B, (0.0, 3.4), (5.5, 3.6)):
        m.d.ellipse([u(px - 1.1), v(pz - 0.8), u(px + 1.1), v(pz + 0.8)],
                    fill=shade(CONCRETE, 0.86))
    # apron slab sides
    for zz in (L.R_APRON_SX, L.R_APRON_SZ):
        fill(m, zz.rect, dif=shade(CONCRETE, 0.88), ao=AO_BASE - 12,
             rough=R_ARMOR + 24, metal=0)


def _corrugate(m, rect, seam_fracs=None):
    """Corrugated patched-steel cell, tone-on-tone (bake-safe)."""
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=CORR, ao=AO_BASE - 4, rough=R_STEEL + 10, metal=M_STEEL)
    # a few mismatched patch panels first (kept within ~±10%)
    for _ in range(7):
        px = x0 + RNG.integers(0, max(1, (x1 - x0) - 90))
        py = y0 + RNG.integers(0, max(1, (y1 - y0) - 70))
        col = CORR_PAL[int(RNG.integers(0, len(CORR_PAL)))]
        m.d.rectangle([px, py, px + int(RNG.integers(50, 90)),
                       py + int(RNG.integers(40, 70))], fill=jit(col, 4),
                      outline=shade(col, 0.82), width=2)
    # corrugation ribs along u
    for gx in range(int(x0) + 4, int(x1) - 2, 9):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(CORR, 0.90), width=2)
    # panel seams across v (arc joints)
    if seam_fracs:
        for f in seam_fracs:
            gy = int(y0 + (y1 - y0) * f)
            m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(CORR, 0.78),
                     width=3)


def paint_hangar(m):
    _corrugate(m, L.R_ARCH, seam_fracs=L.ARC_F[1:-1])
    # front rim fascia: dark steel
    fill(m, L.R_RIM, dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    # inner shell: near-black interior
    fill(m, L.R_INT, dif=INT_DARK, ao=AO_DEEP, rough=R_ARMOR + 20, metal=20)
    # back wall outer: corrugation + a faded stripe band
    z = L.R_BACK
    x0, y0, x1, y1 = z.rect
    _corrugate(m, z.rect)
    u, v = PL.zone_fns(z)
    m.d.rectangle([x0 + 4, v(7.4), x1 - 4, v(6.4)], fill=shade(CORR, 1.10))
    wear_edges(m, z.rect, CORR, density=26)
    # inner back wall: dark with the amber work glow (the factory read)
    z = L.R_GLOW
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=INT_DARK, ao=AO_DEEP, rough=R_ARMOR + 20, metal=20)
    u, v = PL.zone_fns(z)
    # dim amber wash low across the wall + two bright work-lamp cores
    m.e.rectangle([x0 + 30, v(4.6), x1 - 30, v(0.4)],
                  fill=(96, 56, 14))
    for wx in (-4.5, 4.5):
        m.e.ellipse([u(wx - 1.6), v(3.6), u(wx + 1.6), v(1.0)],
                    fill=GLOW_AMBER)
        m.d.ellipse([u(wx - 1.6), v(3.6), u(wx + 1.6), v(1.0)],
                    fill=(64, 48, 30))
    # hazard-banded door jambs (horizontal stripes: v-only, safe on all faces)
    for z2 in (L.R_JAMB_A, L.R_JAMB_B):
        x0, y0, x1, y1 = z2.rect
        fill(m, z2.rect, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
             metal=M_STEEL)
        step = 26
        for i, gy in enumerate(range(int(y0), int(y1), step)):
            m.d.rectangle([x0, gy, x1, min(gy + step, y1)],
                          fill=YELLOW if i % 2 == 0 else BLACKISH)


def paint_tower(m):
    # pad + slabs
    fill(m, L.R_PADT.rect, dif=shade(CONCRETE, 0.97), ao=AO_BASE,
         rough=R_ARMOR + 20, metal=0)
    x0, y0, x1, y1 = L.R_PADT.rect
    m.d.rectangle([x0, y0, x1, y1], outline=shade(CONCRETE, 0.85), width=3)
    fill(m, L.R_PADS.rect, dif=shade(CONCRETE, 0.88), ao=AO_BASE - 10,
         rough=R_ARMOR + 22, metal=0)
    fill(m, L.R_SLAB.rect, dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.R_SLAB.rect
    bolts(m, [(x0 + 18 + i * ((x1 - x0 - 36) / 6), (y0 + y1) / 2)
              for i in range(7)], r=3, base=STEEL_DK)
    # roof edge: hazard chevrons
    PL.hazard_band(m, L.R_ROOFE.rect, step=18)
    # lattice + trim
    fill(m, L.R_LEG, dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 10,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.R_LEG
    for gx in range(int(x0) + 14, int(x1), 26):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(GALV, 0.88), width=2)
    fill(m, L.R_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    fill(m, L.R_DARKZ.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)
    # cab: armour panels, glazed band (warm-lit), team stripe
    z = L.R_CAB
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR, metal=M_ARMOR)
    u, v = PL.zone_fns(z)
    gy0, gy1 = v(12.42), v(11.62)
    PL.glass_rect(m, (x0 + 12, gy0, x1 - 12, gy1), outline=ARMOR_DK)
    m.e.rectangle([x0 + 18, gy0 + 5, x1 - 18, gy1 - 5], fill=(172, 122, 52))
    for f in (0.25, 0.5, 0.75):
        mx = x0 + (x1 - x0) * f
        m.d.rectangle([mx - 4, gy0, mx + 4, gy1], fill=ARMOR_DK)
        m.o.rectangle([mx - 4, gy0, mx + 4, gy1],
                      fill=(AO_BASE - 4, R_ARMOR, M_ARMOR))
    seam_h(m, x0 + 4, x1 - 4, int(gy1) + 6, ARMOR)
    PL.team_panel(m, (x0 + 8, v(11.45), x1 - 8, v(11.15)),
                  base=shade(ARMOR, 1.04))
    bolts(m, [(x0 + 16, y1 - 12), (x0 + (x1 - x0) // 2, y1 - 12),
              (x1 - 16, y1 - 12)], base=ARMOR)
    wear_edges(m, z.rect, ARMOR, density=20)
    # cab/roof top deck
    z = L.R_CAB_T
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=shade(ARMOR, 0.84), ao=AO_BASE - 6, rough=R_ARMOR + 14,
         metal=M_ARMOR)
    for f in (1 / 3, 2 / 3):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * f), shade(ARMOR, 0.84))
    wear_edges(m, z.rect, shade(ARMOR, 0.84), density=18)
    # beacon: red-amber emissive (red-dominant — never cyan)
    z = L.R_BEACON
    fill(m, z.rect, dif=(70, 26, 20), ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 8, y0 + 8, x1 - 8, y1 - 8], fill=BEACON_RED)
    # dish panel: dark olive-grey mesh read (both sides, no text)
    z = L.R_DISHP
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=(88, 90, 84), ao=AO_BASE - 6, rough=R_STEEL + 8,
         metal=M_STEEL)
    for gx in range(int(x0) + 8, int(x1), 22):
        m.d.line([(gx, y0 + 3), (gx, y1 - 3)], fill=shade((88, 90, 84), 0.86),
                 width=2)
    for gy in range(int(y0) + 8, int(y1), 22):
        m.d.line([(x0 + 3, gy), (x1 - 3, gy)], fill=shade((88, 90, 84), 0.86),
                 width=2)
    fill(m, L.R_DISHR, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)


def paint_clutter(m):
    # fuel drums: olive with a rust-red top band
    z = L.R_DRUM
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=OLIVE, ao=AO_BASE - 6, rough=R_STEEL + 12,
         metal=M_STEEL)
    u, v = PL.zone_fns(z)
    m.d.rectangle([x0, v(1.02), x1, v(0.86)], fill=(126, 74, 48))
    for wy in (0.30, 0.62):
        m.d.line([(x0 + 2, v(wy)), (x1 - 2, v(wy))], fill=shade(OLIVE, 0.82),
                 width=3)
    # bowser: olive tank with a small team square
    z = L.R_BOWSER
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=jit(OLIVE, 4), ao=AO_BASE - 6, rough=R_STEEL + 10,
         metal=M_STEEL)
    u, v = PL.zone_fns(z)
    seam_h(m, x0 + 4, x1 - 4, int(v(0.7)), OLIVE)
    PL.team_panel(m, PL.nbox(u(12.4), v(1.1), u(13.4), v(0.75)),
                  base=shade(OLIVE, 1.08))
    bolts(m, [(x0 + 14, y1 - 10), (x1 - 14, y1 - 10)], base=OLIVE)
    # windsock: orange/white bands along the cone (u = along the limb)
    x0, y0, x1, y1 = L.R_SOCK
    fill(m, L.R_SOCK, dif=ORANGE, ao=AO_BASE, rough=R_ARMOR + 20, metal=0)
    bw = (x1 - x0) / 5
    for i in range(5):
        if i % 2 == 1:
            m.d.rectangle([x0 + i * bw, y0, x0 + (i + 1) * bw, y1],
                          fill=(214, 206, 190))
    # floodlight head (one shared cell): steel housing, warm emissive core
    z = L.R_FLOOD_A
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL, metal=M_STEEL)
    cw = (x1 - x0)
    m.d.rectangle([x0 + cw * 0.2, y0 + (y1 - y0) * 0.3,
                   x1 - cw * 0.2, y1 - (y1 - y0) * 0.15], fill=(214, 206, 184))
    m.e.rectangle([x0 + cw * 0.24, y0 + (y1 - y0) * 0.36,
                   x1 - cw * 0.24, y1 - (y1 - y0) * 0.2], fill=LAMP_WARM)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_apron(m)
    paint_hangar(m)
    paint_tower(m)
    paint_clutter(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=[L.R_APRON_SX.rect, L.R_APRON_SZ.rect, L.R_PADS.rect],
        side_zones=[L.R_BACK, L.R_CAB])
    # rain-streak rust down the hangar shell + soot over the work bays
    x0, y0, x1, y1 = L.R_ARCH
    for f in (0.2, 0.45, 0.72, 0.9):
        wx.rust_streak(x0 + (x1 - x0) * f, y0 + 20, 60, width=2.5,
                       strength=0.32)
    wx.rust_streak(L.R_BACK.rect[0] + 60, L.R_BACK.rect[1] + 30, 70,
                   width=2.5, strength=0.3)
    wx.rust_streak(L.R_BACK.rect[2] - 80, L.R_BACK.rect[1] + 30, 55,
                   width=2.0, strength=0.28)
    PL.finish(m, L, STEM, wx=wx)


if __name__ == '__main__':
    paint_all()
