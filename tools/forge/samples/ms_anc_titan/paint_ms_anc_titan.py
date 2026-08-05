"""paint_ms_anc_titan — 2048² PBR set for ms_anc_titan (Titan warframe).

ANCIENT REGISTER. Pale monolithic alloy, unbroken surfaces divided only
by CLEAN RECESSED SEAMS — no rivets, no bolts, no patchwork, no rust.
Emissive CYAN is the whole signature and it is DORMANT: the long vein
rails carry the brightest embers (they are their own geometry, so they
read from the horizon), the prow core / spire lens / lance aperture hold
a slow glow, and every seam gets a hairline that is barely alive.

Impostor discipline: the big hull cells (side/top/prow/rear/shoulder)
are painted TONE-ON-TONE — all their contrast lives in the emissive map,
which the impostor baker never samples, so the sheet stays clean.

Weathering is geological: dust drift on every up-facing surface, soil
burial climbing the feet, scorch at the emitter. Nothing corrodes.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import ImageFilter

import ms_anc_titan_layout as L        # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, wear_edges, shade, jit,
                   BOLT_LOG, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
STEM = 'ms_anc_titan'

# ── ancient palette: pale machined alloy over basalt ────────────────────
ANC = (132, 134, 128)
ANC_LT = (158, 159, 151)
ANC_XL = (178, 178, 169)
ANC_DK = (101, 104, 101)
ANC_DP = (66, 70, 72)          # recessed seam channel
BASALT = (44, 47, 50)
VOID = (22, 24, 27)
DUSTC = (152, 136, 108)
CY_HOT = (150, 244, 255)
CY_MID = (52, 176, 208)
CY_DIM = (24, 92, 112)
CY_EMB = (13, 44, 56)          # dormant ember
SCORCH = (34, 30, 28)

R_ANC, M_ANC = 152, 40
R_GLOW = 70


# ── seam language (RECESSED channels — never a bolted joint) ────────────

def chan_h(m, x0, x1, y, glow=None, w=5, base=ANC, f=0.72):
    """Recessed horizontal seam: dark channel, pale lip, optional ember.
    `f` is the diffuse darkening — keep it near 0.88 on the BIG hull cells
    so the impostor baker's per-triangle flood stays tone-on-tone."""
    m.d.rectangle([x0, y - w // 2, x1, y + w // 2], fill=shade(base, f))
    m.d.line([(x0, y + w // 2 + 1), (x1, y + w // 2 + 1)],
             fill=shade(base, 1.0 + (1.0 - f) * 0.5), width=1)
    m.o.rectangle([x0, y - w // 2, x1, y + w // 2],
                  fill=(AO_SEAM, R_ANC + 20, M_ANC))
    if glow:
        m.e.line([(x0 + 3, y), (x1 - 3, y)], fill=glow, width=2)


def chan_v(m, x, y0, y1, glow=None, w=5, base=ANC, f=0.72):
    m.d.rectangle([x - w // 2, y0, x + w // 2, y1], fill=shade(base, f))
    m.d.line([(x + w // 2 + 1, y0), (x + w // 2 + 1, y1)],
             fill=shade(base, 1.0 + (1.0 - f) * 0.5), width=1)
    m.o.rectangle([x - w // 2, y0, x + w // 2, y1],
                  fill=(AO_SEAM, R_ANC + 20, M_ANC))
    if glow:
        m.e.line([(x, y0 + 3), (x, y1 - 3)], fill=glow, width=2)


def ember_ring(m, cx, cy, r, glow=CY_DIM, width=3, base=ANC):
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade(base, 0.70),
                width=width + 2)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=glow, width=width)


def glyph_row(m, x0, x1, y, n, col, h=16):
    """Ancient machine-script frieze: a run of tall abstract ideograms."""
    step = (x1 - x0) / n
    for i in range(n):
        gx = x0 + step * (i + 0.5)
        r = RNG.random()
        m.d.rectangle([gx - step * 0.16, y - h, gx + step * 0.16, y + h],
                      outline=col, width=3)
        if r < 0.34:
            m.d.line([(gx - step * 0.16, y), (gx + step * 0.16, y)],
                     fill=col, width=3)
        elif r < 0.67:
            m.d.line([(gx, y - h), (gx, y + h)], fill=col, width=3)
        else:
            m.d.line([(gx - step * 0.16, y - h),
                      (gx + step * 0.16, y + h)], fill=col, width=3)


def mandala(m, cx, cy, r, rings=4, spokes=12, base=ANC, glow=CY_DIM):
    """Ancient tracery: perfect concentric circles + radial channels."""
    for i in range(rings):
        rr = r * (i + 1) / rings
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(base, 0.74), width=5)
        m.o.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=(AO_SEAM, R_ANC + 20, M_ANC), width=5)
        m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=glow if i % 2 else CY_EMB, width=2)
    for k in range(spokes):
        a = 2 * np.pi * k / spokes
        m.d.line([(cx + np.cos(a) * r * 0.18, cy + np.sin(a) * r * 0.18),
                  (cx + np.cos(a) * r, cy + np.sin(a) * r)],
                 fill=shade(base, 0.74), width=4)
    m.d.ellipse([cx - r * 0.16, cy - r * 0.16, cx + r * 0.16, cy + r * 0.16],
                fill=shade(base, 0.55))
    m.e.ellipse([cx - r * 0.13, cy - r * 0.13, cx + r * 0.13, cy + r * 0.13],
                fill=CY_MID)


# ── hull ────────────────────────────────────────────────────────────────

def paint_hull_side(m):
    z = L.C_HULL_SIDE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC, ao=AO_BASE, rough=R_ANC, metal=M_ANC)
    # tone-on-tone stratification: upper shoulder lighter, keel darker
    m.d.rectangle([x0, y0, x1, v(13.2)], fill=ANC_LT)
    m.d.rectangle([x0, v(10.6), x1, y1], fill=ANC_DK)
    m.o.rectangle([x0, v(10.6), x1, y1], fill=(AO_BASE - 16, R_ANC, M_ANC))
    # long recessed horizon seams (the reads at strategic zoom)
    for wy, g in ((13.35, CY_EMB), (12.30, CY_DIM), (10.75, CY_EMB)):
        chan_h(m, x0 + 4, x1 - 4, int(v(wy)), glow=g, f=0.88)
    # transverse segment seams — the monolith is divided, never patched
    for wz in (-9.6, -7.6, -5.0, -2.0, 1.4, 4.4, 7.0, 9.2):
        chan_v(m, int(u(wz)), int(v(15.4)), int(v(9.0)), f=0.88)
    # machine-script frieze under the shoulder line
    glyph_row(m, int(u(-6.0)), int(u(5.0)), int(v(12.85)), 13,
              shade(ANC, 0.66), h=13)
    # battle scorch scar across the forward flank (geological, not rust)
    m.d.polygon([(u(-8.4), v(12.9)), (u(-6.6), v(13.4)), (u(-5.4), v(12.4)),
                 (u(-7.2), v(11.4))], fill=shade(ANC_DK, 0.80))
    wear_edges(m, (x0, y0, x1, y1), ANC, 26)


def paint_hull_top(m):
    """Deck shell. Axes are ('x','z'): u()=x, v()=z — longitudinal seams
    are VERTICAL in the atlas, transverse ones horizontal."""
    z = L.C_HULL_TOP
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE, rough=R_ANC - 8,
         metal=M_ANC)
    for wx, g in ((0.0, CY_DIM), (1.9, CY_EMB), (-1.9, CY_EMB)):
        chan_v(m, int(u(wx)), int(v(-10.6)), int(v(10.6)), glow=g, w=7,
               base=ANC_LT, f=0.88)
    for wz in (-8.4, -5.6, -2.4, 1.0, 4.2, 7.4, 9.6):
        chan_h(m, int(u(-5.0)), int(u(5.0)), int(v(wz)), base=ANC_LT, f=0.88)
    mandala(m, u(0.0), v(-6.6), 86, rings=3, spokes=16, base=ANC_LT)
    wear_edges(m, (x0, y0, x1, y1), ANC_LT, 22)


def paint_prow(m):
    z = L.C_PROW
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 10, rough=R_ANC,
         metal=M_ANC)
    cx, cy = u(0.0), v(12.3)
    mandala(m, cx, cy, 150, rings=4, spokes=18, base=ANC_DK, glow=CY_DIM)
    for wy in (14.6, 9.6):
        chan_h(m, x0 + 6, x1 - 6, int(v(wy)), glow=CY_EMB, base=ANC_DK,
               f=0.88)
    chan_v(m, int(u(0.0)), y0 + 6, int(v(13.9)), base=ANC_DK, f=0.88)
    glyph_row(m, int(u(-2.4)), int(u(2.4)), int(v(9.15)), 7,
              shade(ANC_DK, 0.62), h=12)
    wear_edges(m, (x0, y0, x1, y1), ANC_DK, 30)


def paint_hull_rear(m):
    z = L.C_HULL_REAR
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 8, rough=R_ANC,
         metal=M_ANC)
    for i, rr in enumerate((190, 138, 92, 50)):
        ember_ring(m, u(0.0), v(12.6), rr, glow=CY_DIM if i % 2 else CY_EMB,
                   width=3, base=ANC_DK)
    for wy in (14.8, 9.4):
        chan_h(m, x0 + 6, x1 - 6, int(v(wy)), base=ANC_DK, f=0.88)
    m.e.ellipse([u(0.0) - 22, v(12.6) - 22, u(0.0) + 22, v(12.6) + 22],
                fill=CY_MID)
    m.d.ellipse([u(0.0) - 22, v(12.6) - 22, u(0.0) + 22, v(12.6) + 22],
                fill=shade(CY_DIM, 0.7))


def paint_under(m):
    x0, y0, x1, y1 = L.C_UNDER.rect
    fill(m, (x0, y0, x1, y1), dif=BASALT, ao=AO_DEEP, rough=R_ANC + 40,
         metal=20)
    u, v = PL.zone_fns(L.C_UNDER)
    for wz in (-7.0, -3.0, 1.0, 5.0, 8.6):
        chan_h(m, x0 + 4, x1 - 4, int(v(wz)), base=BASALT, w=6)
    ember_ring(m, u(0.0), v(1.4), 46, glow=CY_EMB, base=BASALT)


def paint_shoulder(m):
    z = L.C_SHOULDER
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC, ao=AO_BASE - 6, rough=R_ANC,
         metal=M_ANC)
    for wx in (-4.7, 4.7):
        chan_v(m, int(u(wx)), y0 + 6, y1 - 6, base=ANC, f=0.88)
    for wz in (-6.2, 6.0):
        chan_h(m, x0 + 6, x1 - 6, int(v(wz)), glow=CY_DIM, base=ANC, f=0.88)
        ember_ring(m, u(4.7), v(wz), 44, glow=CY_DIM, base=ANC)
        ember_ring(m, u(-4.7), v(wz), 44, glow=CY_DIM, base=ANC)


def paint_deck(m):
    z = L.C_DECK
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE, rough=R_ANC - 10,
         metal=M_ANC)
    for wx in (-0.55, 0.55):
        chan_v(m, int(u(wx)), y0 + 4, y1 - 4, glow=CY_DIM, base=ANC_LT,
               f=0.88)
    for wz in (-6.4, -3.2, 0.0, 3.2, 6.4):
        chan_h(m, x0 + 4, x1 - 4, int(v(wz)), base=ANC_LT, f=0.88)


def paint_tracery(m):
    z = L.C_TRACERY
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE, rough=R_ANC - 14,
         metal=M_ANC)
    mandala(m, u(0.0), v(0.0), 190, rings=5, spokes=24, base=ANC_LT,
            glow=CY_MID)
    glyph_row(m, x0 + 30, x1 - 30, y0 + 34, 9, shade(ANC_LT, 0.68), h=14)
    glyph_row(m, x0 + 30, x1 - 30, y1 - 34, 9, shade(ANC_LT, 0.68), h=14)


def paint_banner(m):
    """Capturable-hero team read: a recessed banner panel, both flanks.
    Team colour lives ONLY in the mask; the sigil is punched out of it."""
    z = L.C_BANNER
    x0, y0, x1, y1 = z.rect
    PL.team_panel(m, (x0 + 26, y0 + 26, x1 - 26, y1 - 26))
    fill(m, (x0, y0, x0 + 26, y1), dif=ANC_DP, ao=AO_SEAM, rough=R_ANC,
         metal=M_ANC)
    fill(m, (x1 - 26, y0, x1, y1), dif=ANC_DP, ao=AO_SEAM, rough=R_ANC,
         metal=M_ANC)
    fill(m, (x0, y0, x1, y0 + 26), dif=ANC_DP, ao=AO_SEAM, rough=R_ANC,
         metal=M_ANC)
    fill(m, (x0, y1 - 26, x1, y1), dif=ANC_DP, ao=AO_SEAM, rough=R_ANC,
         metal=M_ANC)
    # cyan rim inside the recess
    m.e.rectangle([x0 + 22, y0 + 22, x1 - 22, y1 - 22], outline=CY_MID,
                  width=4)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = min(x1 - x0, y1 - y0) * 0.30
    # punched sigil: perfect ring + inscribed rotated square (no team there)
    m.t.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0))
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ANC_DP)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CY_MID, width=5)
    sq = [(cx, cy - r * 0.66), (cx + r * 0.66, cy), (cx, cy + r * 0.66),
          (cx - r * 0.66, cy)]
    m.d.polygon(sq, outline=shade(ANC, 0.9))
    m.e.polygon(sq, outline=CY_DIM)
    m.e.ellipse([cx - r * 0.16, cy - r * 0.16, cx + r * 0.16, cy + r * 0.16],
                fill=CY_HOT)


def paint_glyph(m):
    z = L.C_GLYPH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DP, ao=AO_SEAM, rough=R_ANC,
         metal=M_ANC)
    glyph_row(m, x0 + 20, x1 - 20, (y0 + y1) // 2, 16, shade(ANC, 0.85), h=22)
    m.e.line([(x0 + 12, y0 + 10), (x1 - 12, y0 + 10)], fill=CY_EMB, width=3)
    m.e.line([(x0 + 12, y1 - 10), (x1 - 12, y1 - 10)], fill=CY_EMB, width=3)


# ── legs ────────────────────────────────────────────────────────────────

def paint_leg_plate(m):
    z = L.C_LEG_PLATE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC, ao=AO_BASE - 6, rough=R_ANC,
         metal=M_ANC)
    for wy in (1.5, 0.0, -1.5):
        chan_h(m, x0 + 8, x1 - 8, int(v(wy)), glow=CY_EMB, base=ANC)
    chan_v(m, int(u(0.0)), y0 + 8, y1 - 8, glow=CY_DIM, base=ANC)
    ember_ring(m, u(0.0), v(0.0), 54, glow=CY_DIM, base=ANC)
    m.d.rectangle([x0, y1 - 40, x1, y1], fill=ANC_DK)


def paint_foot(m):
    z = L.C_FOOT_SIDE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 20, rough=R_ANC + 24,
         metal=M_ANC)
    for wy in (-0.42, -0.86):
        chan_h(m, x0, x1, int(v(wy)), base=ANC_DK, w=7)
    m.d.rectangle([x0, v(-0.86), x1, y1], fill=shade(ANC_DK, 0.84))
    m.e.line([(x0 + 12, v(-0.30)), (x1 - 12, v(-0.30))], fill=CY_EMB, width=3)
    wear_edges(m, (x0, y0, x1, y1), ANC_DK, 46)

    x0, y0, x1, y1 = L.C_FOOT_TOP.rect
    uu, vv = PL.zone_fns(L.C_FOOT_TOP)
    fill(m, (x0, y0, x1, y1), dif=ANC, ao=AO_BASE - 10, rough=R_ANC,
         metal=M_ANC)
    mandala(m, uu(0.0), vv(0.0), 118, rings=3, spokes=12, base=ANC,
            glow=CY_DIM)

    x0, y0, x1, y1 = L.C_SOLE.rect
    fill(m, (x0, y0, x1, y1), dif=BASALT, ao=AO_DEEP, rough=R_ANC + 50,
         metal=15)
    for i in range(5):
        gx = x0 + (x1 - x0) * (i + 0.5) / 5
        m.d.line([(gx, y0 + 4), (gx, y1 - 4)], fill=shade(BASALT, 0.7),
                 width=6)


def paint_joint_cap(m):
    z = L.C_JOINT_CAP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 14, rough=R_ANC - 20,
         metal=M_STEEL)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rmax = min(x1 - x0, y1 - y0) / 2
    for f in (0.94, 0.72, 0.46):
        rr = rmax * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(ANC_DK, 0.66), width=6)
    m.d.ellipse([cx - rmax * 0.26, cy - rmax * 0.26,
                 cx + rmax * 0.26, cy + rmax * 0.26], fill=ANC_DP)
    m.e.ellipse([cx - rmax * 0.20, cy - rmax * 0.20,
                 cx + rmax * 0.20, cy + rmax * 0.20], fill=CY_MID)
    m.o.ellipse([cx - rmax * 0.26, cy - rmax * 0.26,
                 cx + rmax * 0.26, cy + rmax * 0.26],
                fill=(AO_SEAM, R_GLOW, M_GLASS))


# ── weapons ─────────────────────────────────────────────────────────────

def paint_yoke(m):
    z = L.C_YOKE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC, ao=AO_BASE - 6, rough=R_ANC,
         metal=M_ANC)
    for wy in (2.6, 1.4, 0.2):
        chan_h(m, x0 + 6, x1 - 6, int(v(wy)), glow=CY_EMB, base=ANC)
    for wx in (-1.9, 1.9):
        chan_v(m, int(u(wx)), y0 + 6, y1 - 6, glow=CY_DIM, base=ANC)
    ember_ring(m, u(0.0), v(1.0), 74, glow=CY_DIM, base=ANC)


def paint_receiver(m):
    z = L.C_RECEIVER
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 12, rough=R_ANC,
         metal=M_ANC)
    for wy in (1.0, -1.0):
        chan_h(m, x0 + 6, x1 - 6, int(v(wy)), base=ANC_DK)
    for wz in (2.4, 0.6, -1.4, -3.6, -5.4):
        chan_v(m, int(u(wz)), int(v(1.5)), int(v(-1.5)), glow=CY_DIM,
               base=ANC_DK)
    m.e.rectangle(PL.nbox(u(1.6), v(0.5), u(-4.8), v(-0.5)),
                  outline=CY_DIM, width=3)


def paint_emitter(m):
    z = L.C_EMITTER
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=VOID, ao=AO_DEEP, rough=R_GLASS,
         metal=M_GLASS)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rmax = min(x1 - x0, y1 - y0) / 2
    for f, c in ((0.92, CY_EMB), (0.70, CY_DIM), (0.48, CY_MID)):
        rr = rmax * f
        m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=c, width=5)
    m.e.ellipse([cx - rmax * 0.26, cy - rmax * 0.26,
                 cx + rmax * 0.26, cy + rmax * 0.26], fill=CY_HOT)
    m.d.ellipse([cx - rmax * 0.26, cy - rmax * 0.26,
                 cx + rmax * 0.26, cy + rmax * 0.26], fill=shade(CY_MID, 0.6))
    for k in range(8):
        a = 2 * np.pi * k / 8
        m.e.line([(cx + np.cos(a) * rmax * 0.30, cy + np.sin(a) * rmax * 0.30),
                  (cx + np.cos(a) * rmax * 0.90, cy + np.sin(a) * rmax * 0.90)],
                 fill=CY_DIM, width=3)


def paint_rep_body(m):
    z = L.C_REP_BODY
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 12, rough=R_ANC,
         metal=M_ANC)
    ember_ring(m, u(0.0), v(0.0), 84, glow=CY_DIM, base=ANC_DK)
    ember_ring(m, u(0.0), v(0.0), 52, glow=CY_EMB, base=ANC_DK)
    for wy in (1.2, -1.2):
        chan_h(m, x0 + 6, x1 - 6, int(v(wy)), base=ANC_DK)


# ── spire, halo, cores ──────────────────────────────────────────────────

def paint_spire(m):
    z = L.C_SPIRE_SIDE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE, rough=R_ANC - 12,
         metal=M_ANC)
    for wy in (5.6, 4.2, 2.9, 1.6, 0.4):
        chan_h(m, x0 + 4, x1 - 4, int(v(wy)), glow=CY_DIM, base=ANC_LT)
    chan_v(m, int(u(0.0)), y0 + 4, y1 - 4, glow=CY_MID, w=7, base=ANC_LT)
    glyph_row(m, x0 + 16, x1 - 16, int(v(3.5)), 4, shade(ANC_LT, 0.66), h=18)

    x0, y0, x1, y1 = L.C_SPIRE_TOP.rect
    uu, vv = PL.zone_fns(L.C_SPIRE_TOP)
    fill(m, (x0, y0, x1, y1), dif=ANC_XL, ao=AO_BASE, rough=R_ANC - 20,
         metal=M_ANC)
    mandala(m, uu(0.0), vv(0.0), 104, rings=3, spokes=8, base=ANC_XL,
            glow=CY_MID)


def paint_lens(m):
    z = L.C_LENS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=VOID, ao=AO_DEEP, rough=R_GLASS,
         metal=M_GLASS)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rmax = min(x1 - x0, y1 - y0) / 2
    for f, c in ((0.96, CY_DIM), (0.74, CY_MID), (0.50, CY_HOT)):
        rr = rmax * f
        m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=c, width=6)
    m.e.ellipse([cx - rmax * 0.30, cy - rmax * 0.30,
                 cx + rmax * 0.30, cy + rmax * 0.30], fill=CY_HOT)
    m.d.ellipse([cx - rmax * 0.30, cy - rmax * 0.30,
                 cx + rmax * 0.30, cy + rmax * 0.30], fill=shade(CY_MID, 0.55))


def paint_core(m):
    z = L.C_CORE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=VOID, ao=AO_DEEP, rough=R_GLOW,
         metal=M_GLASS)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rmax = min(x1 - x0, y1 - y0) / 2
    # dormant core: a deep well with a slow ember and radial channels
    for k in range(16):
        a = 2 * np.pi * k / 16
        m.d.line([(cx, cy), (cx + np.cos(a) * rmax, cy + np.sin(a) * rmax)],
                 fill=shade(CY_DIM, 0.45), width=4)
        m.e.line([(cx + np.cos(a) * rmax * 0.34, cy + np.sin(a) * rmax * 0.34),
                  (cx + np.cos(a) * rmax * 0.96, cy + np.sin(a) * rmax * 0.96)],
                 fill=CY_EMB, width=4)
    for f, c in ((0.90, CY_EMB), (0.64, CY_DIM), (0.38, CY_MID)):
        rr = rmax * f
        m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=c, width=6)
    m.e.ellipse([cx - rmax * 0.22, cy - rmax * 0.22,
                 cx + rmax * 0.22, cy + rmax * 0.22], fill=CY_MID)
    m.d.ellipse([cx - rmax * 0.22, cy - rmax * 0.22,
                 cx + rmax * 0.22, cy + rmax * 0.22], fill=shade(CY_DIM, 0.6))


def paint_halo(m):
    z = L.C_HALO
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_XL, ao=AO_BASE, rough=R_ANC - 24,
         metal=M_STEEL)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rmax = min(x1 - x0, y1 - y0) / 2
    # the ring itself lands between r_in and r_out of the projection
    r_in = rmax * (L.HALO_R_IN / L.HALO_R_OUT) * 0.93
    r_out = rmax * 0.93
    m.d.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out],
                outline=shade(ANC_XL, 0.70), width=6)
    m.d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in],
                outline=shade(ANC_XL, 0.70), width=6)
    rm = (r_in + r_out) / 2
    m.e.ellipse([cx - rm, cy - rm, cx + rm, cy + rm], outline=CY_MID,
                width=6)
    m.d.ellipse([cx - rm, cy - rm, cx + rm, cy + rm],
                outline=shade(CY_DIM, 0.7), width=6)
    for k in range(24):
        a = 2 * np.pi * k / 24
        m.d.line([(cx + np.cos(a) * r_in, cy + np.sin(a) * r_in),
                  (cx + np.cos(a) * r_out, cy + np.sin(a) * r_out)],
                 fill=shade(ANC_XL, 0.74), width=4)


# ── parametric wraps ────────────────────────────────────────────────────

def band_wrap(m, rect, n, base, groove=None, glow=None, core=0.0):
    """Paint an n-facet limb/tube wrap: one band per facet, each with a
    recessed edge groove and (optionally) a lit core stripe."""
    x0, y0, x1, y1 = rect
    fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE - 8, rough=R_ANC,
         metal=M_ANC)
    h = (y1 - y0) / n
    for j in range(n):
        b0 = y0 + h * j
        b1 = b0 + h
        m.d.rectangle([x0, b0, x1, b0 + max(2, h * 0.10)],
                      fill=shade(groove or base, 0.68))
        m.o.rectangle([x0, b0, x1, b0 + max(2, h * 0.10)],
                      fill=(AO_SEAM, R_ANC + 20, M_ANC))
        if core > 0 and glow:
            cy0 = b0 + h * (0.5 - core / 2)
            cy1 = b0 + h * (0.5 + core / 2)
            m.d.rectangle([x0, cy0, x1, cy1], fill=shade(glow, 0.42))
            m.e.rectangle([x0 + 2, cy0 + 1, x1 - 2, cy1 - 1], fill=glow)
            m.o.rectangle([x0, cy0, x1, cy1], fill=(AO_SEAM, R_GLOW, M_GLASS))
        elif glow:
            m.e.line([(x0 + 3, (b0 + b1) / 2), (x1 - 3, (b0 + b1) / 2)],
                     fill=glow, width=2)


def paint_wraps(m):
    # cyan power-vein rails — the horizon read. Brightest thing on the hull.
    band_wrap(m, L.C_VEIN, 3, ANC_DP, groove=BASALT, glow=CY_HOT, core=0.46)
    x0, y0, x1, y1 = L.C_VEIN
    for i in range(6):        # slow pulse nodes along every rail segment
        gx = x0 + (x1 - x0) * (i + 0.5) / 6
        m.e.rectangle([gx - 5, y0, gx + 5, y1], fill=CY_MID)
    # spire filaments + rib tracery
    band_wrap(m, L.C_FILAMENT, 3, ANC_DP, groove=BASALT, glow=CY_MID,
              core=0.40)
    band_wrap(m, L.C_RIB, 4, ANC, groove=ANC_DK, glow=CY_EMB)
    band_wrap(m, L.C_FLUTE, 3, ANC_LT, groove=ANC_DK)
    # columnar legs
    band_wrap(m, L.C_THIGH, 8, ANC, groove=ANC_DK, glow=CY_EMB)
    band_wrap(m, L.C_SHIN, 8, ANC, groove=ANC_DK, glow=CY_EMB)
    x0, y0, x1, y1 = L.C_THIGH
    for i in (2, 5, 8):       # column collars
        gx = x0 + (x1 - x0) * i / 10
        m.d.rectangle([gx - 6, y0, gx + 6, y1], fill=shade(ANC, 0.72))
    # main lance: pale at the breech, cooling to dark at the aperture
    x0, y0, x1, y1 = L.C_LANCE
    band_wrap(m, L.C_LANCE, L.LANCE_N, ANC, groove=ANC_DK, glow=CY_DIM)
    for i in range(12):
        gx0 = x0 + (x1 - x0) * i / 12
        gx1 = x0 + (x1 - x0) * (i + 1) / 12
        f = 1.0 - 0.22 * (i / 11.0)
        m.d.rectangle([gx0, y0, gx1, y1],
                      fill=shade(jit(ANC, 2), f))
    band_wrap(m, L.C_LANCE, L.LANCE_N, None, groove=ANC_DK, glow=CY_MID)
    # repeater tubes, joint drums, generic trim
    band_wrap(m, L.C_REP_WRAP, L.REP_N, ANC_DK, groove=BASALT, glow=CY_EMB)
    x0, y0, x1, y1 = L.C_JOINT
    fill(m, (x0, y0, x1, y1), dif=BASALT, ao=AO_BASE - 24, rough=R_ANC - 30,
         metal=M_STEEL)
    m.d.rectangle([x0, y0, x1, y0 + 18], fill=ANC_DK)
    m.d.rectangle([x0, y1 - 18, x1, y1], fill=ANC_DK)
    m.e.line([(x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)], fill=CY_DIM, width=4)
    fill(m, L.C_TRIM, dif=ANC_DK, ao=AO_BASE - 10, rough=R_ANC, metal=M_ANC)
    x0, y0, x1, y1 = L.C_TRIM
    m.d.rectangle([x0, (y0 + y1) // 2 - 4, x1, (y0 + y1) // 2 + 4],
                  fill=shade(ANC_DK, 0.70))
    m.e.line([(x0 + 4, (y0 + y1) / 2), (x1 - 4, (y0 + y1) / 2)],
             fill=CY_EMB, width=2)
    fill(m, L.C_DARK.rect, dif=BASALT, ao=AO_DEEP, rough=R_ANC + 30, metal=20)


def band_wrap_glow_only(m, rect, n, glow):
    x0, y0, x1, y1 = rect
    h = (y1 - y0) / n
    for j in range(n):
        m.e.line([(x0 + 3, y0 + h * (j + 0.5)), (x1 - 3, y0 + h * (j + 0.5))],
                 fill=glow, width=2)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_under(m)
    paint_hull_side(m)
    paint_hull_top(m)
    paint_prow(m)
    paint_hull_rear(m)
    paint_shoulder(m)
    paint_deck(m)
    paint_tracery(m)
    paint_banner(m)
    paint_glyph(m)
    paint_leg_plate(m)
    paint_foot(m)
    paint_joint_cap(m)
    paint_yoke(m)
    paint_receiver(m)
    paint_emitter(m)
    paint_rep_body(m)
    paint_spire(m)
    paint_lens(m)
    paint_core(m)
    paint_halo(m)
    paint_wraps(m)

    # ── weathering: GEOLOGICAL. Dust drift, soil burial, scorch. No rust,
    #    no bolt bleed — nothing on this machine was ever bolted. ──
    from weathering import Weather
    wx = Weather(seed=90210 % 9973)
    wx.crevice_grime(m.dif, 0.42)
    # soil climbing the feet, thinning up the columns
    wx.mud_band(L.C_SOLE.rect, 1.0, fade=None)
    wx.mud_band(L.C_FOOT_SIDE.rect, 0.95, fade='down', dust=0.5)
    wx.mud_band(L.C_FOOT_TOP.rect, 0.55, fade=None, dust=0.4)
    wx.mud_band(L.C_SHIN, 0.62, fade='right', dust=0.4)
    wx.mud_band(L.C_THIGH, 0.26, fade='right', dust=0.3)
    wx.mud_band(L.C_FLUTE, 0.30, fade='right', dust=0.3)
    wx.mud_band(L.C_LEG_PLATE.rect, 0.48, fade='down', dust=0.35)
    wx.mud_band(L.C_JOINT, 0.30, fade=None, spatter=False, dust=0.3)
    # dust drift on every up-facing surface (millennia of it)
    for r in (L.C_HULL_TOP.rect, L.C_SHOULDER.rect, L.C_DECK.rect,
              L.C_TRACERY.rect, L.C_SPIRE_TOP.rect, L.C_HALO.rect,
              L.C_YOKE.rect):
        wx.mud_band(r, 0.30, fade=None, spatter=False, dust=0.45)
    # fading dust films down the vertical faces
    for r in (L.C_HULL_SIDE.rect, L.C_PROW.rect, L.C_HULL_REAR.rect,
              L.C_SPIRE_SIDE.rect, L.C_RECEIVER.rect, L.C_REP_BODY.rect,
              L.C_GLYPH.rect):
        wx.mud_band(r, 0.34, fade='down', spatter=False, dust=0.36)
    wx.mud_band(L.C_BANNER.rect, 0.20, fade='down', spatter=False, dust=0.25)
    wx.mud_band(L.C_UNDER.rect, 0.55, fade=None, spatter=False)
    wx.mud_band(L.C_LANCE, 0.20, fade=None, spatter=False, dust=0.3)
    # scorch: the aperture and the ground the prow has burned through
    wx.soot_patch(L.C_EMITTER.rect, 0.62)
    wx.soot_patch(L.C_REP_WRAP, 0.55)
    hx0, hy0, hx1, hy1 = L.C_HULL_SIDE.rect
    wx.soot_patch((hx0 + 80, hy0 + 110, hx0 + 330, hy0 + 250), 0.42)
    wx.apply(m)

    # ── height → normal map: recessed seams, proud rails, worn plinths ──
    from normals import HeightMap
    hm = HeightMap()
    # vein rails stand proud
    vx0, vy0, vx1, vy1 = L.C_VEIN
    hm.rect((vx0, vy0, vx1, vy1), 0.55)
    # column flutes proud, joint drums recessed at the seam ring
    fx0, fy0, fx1, fy1 = L.C_FLUTE
    hm.rect((fx0, fy0, fx1, fy1), 0.42)
    jx0, jy0, jx1, jy1 = L.C_JOINT
    hm.rect((jx0, (jy0 + jy1) // 2 - 6, jx1, (jy0 + jy1) // 2 + 6), -0.7)
    # banner panel recess
    bx0, by0, bx1, by1 = L.C_BANNER.rect
    hm.rect((bx0 + 26, by0 + 26, bx1 - 26, by1 - 26), -0.65)
    # tracery mandala + deck panel recess
    tx0, ty0, tx1, ty1 = L.C_TRACERY.rect
    hm.rect((tx0 + 24, ty0 + 24, tx1 - 24, ty1 - 24), -0.30)
    # cores/lenses sink into their wells
    for zr in (L.C_CORE.rect, L.C_LENS.rect, L.C_EMITTER.rect):
        cx, cy = (zr[0] + zr[2]) / 2, (zr[1] + zr[3]) / 2
        hm.disc(cx, cy, min(zr[2] - zr[0], zr[3] - zr[1]) * 0.46, -0.85)
    # foot plinth courses
    fsx0, fsy0, fsx1, fsy1 = L.C_FOOT_SIDE.rect
    u, v = PL.zone_fns(L.C_FOOT_SIDE)
    hm.rect((fsx0, v(-0.86), fsx1, fsy1), 0.35)
    hm.crevices_from(m.dif, 0.50)
    hm.weather_from(wx)
    hm.to_normal_image(strength=3.6).save(
        os.path.join(OUT, f'{STEM}_normals.png'))

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.8))
    m.dif.save(os.path.join(OUT, f'{STEM}_diffuse.png'))
    m.orm.save(os.path.join(OUT, f'{STEM}_orm.png'))
    m.emi.save(os.path.join(OUT, f'{STEM}_emissive.png'))
    m.tea.save(os.path.join(OUT, f'{STEM}_team.png'))
    print(f'[paint_{STEM}] full 2048 texture set written to {OUT}')


if __name__ == '__main__':
    paint_all()
