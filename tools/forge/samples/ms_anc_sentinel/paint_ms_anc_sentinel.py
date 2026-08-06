"""paint_ms_anc_sentinel — 1024² PBR set for ms_anc_sentinel (ancient register).

One monolithic pale alloy, segmented only by clean recessed CONCENTRIC
seams — no rivets, no bolted patches, no scrap.  Cyan is the signature and
lives in tracery channels, the equatorial light line, the halo ring and the
iris; it is ACTIVE here (a sentinel on station), so the emissive map carries
it hot while the diffuse keeps the same channels muted and tone-on-tone —
that keeps the flat-shading impostor baker from flooding whole facets cyan.
Weathering is geological: dust films and drifts, one scorch bloom on the
belly rim.  Nothing rusts; nothing is bolted.  Team colour: the vane tips
only (the capture tell), team mask R channel exclusively.
"""
from __future__ import annotations
import numpy as np

import ms_anc_sentinel_layout as L   # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, shade, BOLT_LOG,
                   TEAMGREY, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS, R_GLOW, M_ARMOR, M_STEEL, M_GLASS)
import paintlib as PL

W = 1024

# ── ancient palette ─────────────────────────────────────────────────────
ANC      = (170, 174, 171)      # pale monolithic alloy
ANC_LT   = (196, 199, 195)
ANC_DK   = (132, 137, 138)      # underside / shaded register
ANC_SEAM = shade(ANC, 0.84)     # recessed seam (tone-on-tone, ~16%)
ANC_HI   = shade(ANC, 1.09)     # seam lip catch
VOID     = (26, 30, 34)         # bottomless recess
SHELL    = (54, 60, 66)         # eye-pod shell
CY_DIF   = (124, 158, 168)      # cyan channel AS SEEN IN DIFFUSE (muted)
CY_DIF_H = (150, 192, 205)
CY_HOT   = (86, 226, 255)       # emissive cyan — ancient tech signature
CY_CORE  = (188, 244, 255)
IRIS_D   = (108, 186, 210)      # iris diffuse (one flat facet — reads at range)
# Tracery crossing the BIG lofted cells (crown, belly, vanes) must stay
# tone-on-tone in diffuse — those quads are large, and the impostor baker
# flat-fills a whole triangle from its UV centroid.  The channels still run
# hot in the emissive map, which is where the cyan actually belongs.
CY_CROWN = (152, 166, 170)      # on ANC   — ~6% darker, faintly cool
CY_BELLY = (120, 136, 142)      # on ANC_DK
CY_VANE  = (156, 170, 174)

R_ANC, M_ANC = R_STEEL - 22, 120     # polished, half-metallic monolith

S_TOP = 512.0 / 3.60            # px per metre in the disc cells
TOP_C = (256.0, 256.0)
BOT_C = (768.0, 256.0)
RING_R = [r for (_, r) in L.HULL_RINGS]


# ── helpers ─────────────────────────────────────────────────────────────

def top_px(x, z):
    return (TOP_C[0] + x * S_TOP, TOP_C[1] + z * S_TOP)


def bot_px(x, z):
    return (BOT_C[0] + x * S_TOP, BOT_C[1] - z * S_TOP)


def circle(d, c, r, col, width=1):
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], outline=col, width=width)


def disc(d, c, r, col):
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=col)


def radial(d, c, az_deg, r0, r1, col, width, flip_v=False):
    a = np.radians(az_deg)
    sy = -1.0 if flip_v else 1.0
    d.line([(c[0] + r0 * np.cos(a) * S_TOP, c[1] + sy * r0 * np.sin(a) * S_TOP),
            (c[0] + r1 * np.cos(a) * S_TOP, c[1] + sy * r1 * np.sin(a) * S_TOP)],
           fill=col, width=width)


# ── the disc: crown ─────────────────────────────────────────────────────

def paint_top(m):
    x0, y0, x1, y1 = L.Z_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=ANC, ao=AO_BASE, rough=R_ANC, metal=M_ANC)

    # tone-on-tone annular banding (±4%) so the shoulders read as segments
    for i, r in enumerate(reversed(RING_R)):
        disc(m.d, TOP_C, r * S_TOP, shade(ANC, 1.0 + 0.035 * ((i % 2) - 0.5)))

    # twelve recessed radial seams — segmentation, not panelling
    for k in range(12):
        radial(m.d, TOP_C, k * 30.0, 0.55, 1.72, ANC_SEAM, 3)
        radial(m.d, TOP_C, k * 30.0 + 0.6, 0.55, 1.72, ANC_HI, 1)

    # recessed concentric seams on the real ring stations
    for r in RING_R:
        circle(m.d, TOP_C, r * S_TOP, ANC_SEAM, 3)
        circle(m.d, TOP_C, r * S_TOP - 3, ANC_HI, 1)
        m.o.ellipse([TOP_C[0] - r * S_TOP, TOP_C[1] - r * S_TOP,
                     TOP_C[0] + r * S_TOP, TOP_C[1] + r * S_TOP],
                    outline=(AO_SEAM, R_ANC + 20, M_ANC), width=3)

    # crown plateau — one clean raised step, brighter alloy
    disc(m.d, TOP_C, 0.32 * S_TOP, ANC_LT)
    circle(m.d, TOP_C, 0.32 * S_TOP, ANC_SEAM, 3)

    # cyan tracery: two perfect rings + three radials aligned to the vanes
    for r, wdt in ((0.68, 6), (1.46, 4)):
        circle(m.d, TOP_C, r * S_TOP, CY_CROWN, wdt)
        circle(m.e, TOP_C, r * S_TOP, CY_HOT, wdt)
        m.o.ellipse([TOP_C[0] - r * S_TOP, TOP_C[1] - r * S_TOP,
                     TOP_C[0] + r * S_TOP, TOP_C[1] + r * S_TOP],
                    outline=(AO_BASE, R_GLOW, M_GLASS), width=wdt)
    for az in L.VANE_AZ:
        radial(m.d, TOP_C, az, 0.36, 1.70, CY_CROWN, 6)
        radial(m.e, TOP_C, az, 0.36, 1.70, CY_HOT, 6)
        radial(m.d, TOP_C, az + 180.0 / 3, 0.72, 1.44, CY_CROWN, 3)
        radial(m.e, TOP_C, az + 180.0 / 3, 0.72, 1.44, CY_HOT, 3)

    # crown core — the sentinel's heart, seen from above
    disc(m.d, TOP_C, 0.175 * S_TOP, CY_DIF_H)
    disc(m.e, TOP_C, 0.175 * S_TOP, CY_HOT)
    disc(m.d, TOP_C, 0.075 * S_TOP, CY_CORE)
    disc(m.e, TOP_C, 0.075 * S_TOP, CY_CORE)
    circle(m.d, TOP_C, 0.175 * S_TOP, ANC_SEAM, 3)
    m.o.ellipse([TOP_C[0] - 0.175 * S_TOP, TOP_C[1] - 0.175 * S_TOP,
                 TOP_C[0] + 0.175 * S_TOP, TOP_C[1] + 0.175 * S_TOP],
                fill=(AO_BASE, R_GLOW, M_GLASS))


# ── the disc: belly ─────────────────────────────────────────────────────

def paint_bot(m):
    x0, y0, x1, y1 = L.Z_BOT.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 18, rough=R_ANC + 14,
         metal=M_ANC)

    for i, r in enumerate(reversed(RING_R)):
        disc(m.d, BOT_C, r * S_TOP, shade(ANC_DK, 1.0 + 0.035 * ((i % 2) - 0.5)))
    for k in range(12):
        radial(m.d, BOT_C, k * 30.0 + 15.0, 0.42, 1.72, shade(ANC_DK, 0.85), 3,
               flip_v=True)
    for r in RING_R:
        circle(m.d, BOT_C, r * S_TOP, shade(ANC_DK, 0.84), 3)
        circle(m.d, BOT_C, r * S_TOP - 3, shade(ANC_DK, 1.08), 1)

    # cyan tracery running out to the vane roots
    for az in L.VANE_AZ:
        radial(m.d, BOT_C, az, 0.34, 1.62, CY_BELLY, 5, flip_v=True)
        radial(m.e, BOT_C, az, 0.34, 1.62, CY_HOT, 5, flip_v=True)
    circle(m.d, BOT_C, 1.10 * S_TOP, CY_BELLY, 4)
    circle(m.e, BOT_C, 1.10 * S_TOP, CY_HOT, 4)

    # the eye well: a deep, dark, perfectly circular mouth with a lit collar
    circle(m.d, BOT_C, 0.335 * S_TOP, CY_BELLY, 5)
    circle(m.e, BOT_C, 0.335 * S_TOP, CY_HOT, 5)
    disc(m.d, BOT_C, 0.30 * S_TOP, VOID)
    m.o.ellipse([BOT_C[0] - 0.30 * S_TOP, BOT_C[1] - 0.30 * S_TOP,
                 BOT_C[0] + 0.30 * S_TOP, BOT_C[1] + 0.30 * S_TOP],
                fill=(AO_DEEP, R_ARMOR, M_ARMOR))


# ── equatorial light line ───────────────────────────────────────────────

def paint_equator(m):
    x0, y0, x1, y1 = L.Z_EQ.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 20, rough=R_ANC,
         metal=M_ANC)
    m.d.rectangle([x0, y0 + 8, x1, y1 - 8], fill=VOID)          # recessed slot
    m.o.rectangle([x0, y0 + 8, x1, y1 - 8],
                  fill=(AO_SEAM, R_ANC + 20, M_ANC))
    m.d.rectangle([x0, y0 + 19, x1, y1 - 19], fill=CY_DIF)      # the light line
    m.e.rectangle([x0, y0 + 19, x1, y1 - 19], fill=CY_HOT)
    m.d.rectangle([x0, y0 + 25, x1, y1 - 25], fill=CY_CORE)
    m.e.rectangle([x0, y0 + 25, x1, y1 - 25], fill=CY_CORE)
    m.o.rectangle([x0, y0 + 19, x1, y1 - 19], fill=(AO_BASE, R_GLOW, M_GLASS))
    # segment ticks — the line is divided, never continuous scrap
    for gx in range(x0, x1, 1024 // 24):
        m.d.line([(gx, y0 + 8), (gx, y1 - 8)], fill=shade(ANC_DK, 0.7), width=2)
        m.e.line([(gx, y0 + 8), (gx, y1 - 8)], fill=(0, 0, 0), width=2)


# ── stabiliser vanes (u = chord, v = span; tip band = team mask) ────────

def paint_vanes(m):
    x0, y0, x1, y1 = L.R_VANE
    w, h = x1 - x0, y1 - y0
    fill(m, (x0, y0, x1, y1), dif=ANC, ao=AO_BASE - 8, rough=R_ANC, metal=M_ANC)

    def vy(f):
        return y0 + f * h

    def ux(f):
        return x0 + f * w

    # chord edges read as their own faces
    m.d.rectangle([x0, y0, ux(0.055), y1], fill=shade(ANC, 0.88))
    m.d.rectangle([ux(0.945), y0, x1, y1], fill=shade(ANC, 0.88))
    # spanwise segment seams on the real stations
    for f in L.VANE_SP[1:-1]:
        m.d.line([(x0, vy(f)), (x1, vy(f))], fill=ANC_SEAM, width=3)
        m.d.line([(x0, vy(f) + 3), (x1, vy(f) + 3)], fill=ANC_HI, width=1)
    # long recessed chord flutes, tone-on-tone
    for f in (0.22, 0.38, 0.62, 0.78):
        m.d.line([(ux(f), vy(0.03)), (ux(f), vy(L.VANE_TEAM_V - 0.02))],
                 fill=shade(ANC, 0.9), width=2)

    # cyan tracery down the spine, feeding the tip.  u=0.5 is exactly where
    # every broad-face UV centroid lands, so the diffuse channel here is
    # tone-on-tone; the emissive map carries the actual light.
    m.d.line([(ux(0.5), vy(0.02)), (ux(0.5), vy(L.VANE_TEAM_V - 0.01))],
             fill=CY_VANE, width=7)
    m.e.line([(ux(0.5), vy(0.02)), (ux(0.5), vy(L.VANE_TEAM_V - 0.01))],
             fill=CY_HOT, width=7)
    m.o.line([(ux(0.5), vy(0.02)), (ux(0.5), vy(L.VANE_TEAM_V - 0.01))],
             fill=(AO_BASE, R_GLOW, M_GLASS), width=7)

    # CAPTURABLE tell: the vane tip is a team panel
    tb = (x0, vy(L.VANE_TEAM_V), x1, y1)
    m.d.rectangle(list(tb), fill=TEAMGREY)
    m.t.rectangle(list(tb), fill=(255, 0, 0))
    m.d.line([(x0, vy(L.VANE_TEAM_V)), (x1, vy(L.VANE_TEAM_V))],
             fill=ANC_SEAM, width=4)
    # the tracery terminates in a lit node on the team band
    nx, ny = ux(0.5), vy(L.VANE_TEAM_V)
    disc(m.d, (nx, ny), 13, shade(CY_VANE, 1.06))
    disc(m.e, (nx, ny), 13, CY_HOT)
    disc(m.d, (nx, ny), 5, shade(CY_VANE, 1.14))
    disc(m.e, (nx, ny), 5, CY_CORE)


# ── free-floating halo ring (u = major angle, v = minor angle) ──────────

def paint_halo(m):
    x0, y0, x1, y1 = L.R_HALO
    w, h = x1 - x0, y1 - y0
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE, rough=R_ANC - 14,
         metal=M_ANC + 40)
    # v=0 / v=1 is the ring's inner face — shade it; v=0.5 faces outward
    m.d.rectangle([x0, y0, x1, y0 + int(h * 0.16)], fill=shade(ANC_LT, 0.8))
    m.d.rectangle([x0, y1 - int(h * 0.16), x1, y1], fill=shade(ANC_LT, 0.8))
    # the ring is one continuous cyan conduit around its outer equator
    m.d.rectangle([x0, y0 + int(h * 0.40), x1, y0 + int(h * 0.60)], fill=CY_DIF)
    m.e.rectangle([x0, y0 + int(h * 0.40), x1, y0 + int(h * 0.60)], fill=CY_HOT)
    m.o.rectangle([x0, y0 + int(h * 0.40), x1, y0 + int(h * 0.60)],
                  fill=(AO_BASE, R_GLOW, M_GLASS))
    seg = w // L.HALO_NU
    for k in range(L.HALO_NU):
        gx = x0 + k * seg
        m.d.line([(gx, y0), (gx, y1)], fill=shade(ANC_LT, 0.86), width=2)
        if k % 4 == 0:                       # six brighter nodes around the ring
            m.d.rectangle([gx + 3, y0 + int(h * 0.30), gx + seg - 3,
                           y0 + int(h * 0.70)], fill=CY_DIF_H)
            m.e.rectangle([gx + 3, y0 + int(h * 0.30), gx + seg - 3,
                           y0 + int(h * 0.70)], fill=CY_CORE)


# ── eye pod + iris ──────────────────────────────────────────────────────

def paint_eye(m):
    x0, y0, x1, y1 = L.Z_EYE.rect
    fill(m, (x0, y0, x1, y1), dif=SHELL, ao=AO_BASE - 24, rough=R_ANC - 30,
         metal=M_STEEL)
    c = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
    sc = (x1 - x0) / 2.0 / 0.36          # px per metre in this cell
    for r in (0.360, 0.300, 0.235):
        circle(m.d, c, r * sc, shade(SHELL, 0.7), 3)
        circle(m.d, c, r * sc - 3, shade(SHELL, 1.25), 1)
    circle(m.d, c, 0.330 * sc, CY_DIF, 5)   # collar conduit
    circle(m.e, c, 0.330 * sc, CY_HOT, 5)

    # iris: one flat facet — the diffuse colour IS what the impostor reads
    x0, y0, x1, y1 = L.Z_IRIS.rect
    fill(m, (x0, y0, x1, y1), dif=VOID, ao=AO_BASE - 30, rough=R_GLASS,
         metal=M_GLASS)
    c = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
    sc = (x1 - x0) / 2.0 / 0.30
    disc(m.d, c, 0.235 * sc, shade(SHELL, 0.9))          # bezel
    circle(m.d, c, 0.235 * sc, shade(SHELL, 0.6), 3)
    disc(m.d, c, 0.200 * sc, IRIS_D)                     # the lens
    disc(m.e, c, 0.200 * sc, CY_HOT)
    for r in (0.170, 0.135, 0.100):                      # aperture leaves
        circle(m.d, c, r * sc, shade(IRIS_D, 0.86), 2)
        circle(m.e, c, r * sc, shade(CY_HOT, 0.7), 2)
    disc(m.d, c, 0.055 * sc, CY_CORE)                    # pupil
    disc(m.e, c, 0.055 * sc, (255, 255, 255))
    m.o.ellipse([c[0] - 0.200 * sc, c[1] - 0.200 * sc,
                 c[0] + 0.200 * sc, c[1] + 0.200 * sc],
                fill=(AO_BASE, R_GLOW, M_GLASS))


def paint_utility(m):
    fill(m, L.Z_DARK.rect, dif=VOID, ao=AO_DEEP, rough=R_ARMOR, metal=M_ARMOR)
    fill(m, L.Z_TRIM.rect, dif=ANC_DK, ao=AO_BASE - 12, rough=R_ANC,
         metal=M_ANC)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    m.d.rectangle([0, 0, W, W], fill=ANC_DK)      # no stray sample-grey
    paint_top(m)
    paint_bot(m)
    paint_equator(m)
    paint_vanes(m)
    paint_halo(m)
    paint_eye(m)
    paint_utility(m)

    # ── weathering: geological, never mechanical ────────────────────────
    from weathering import Weather
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.34)                 # dust settled into the seams
    # dust drifts — a flyer never touches soil, so films only, no mud, no rust
    wx.mud_band(L.Z_TOP.rect, 0.05, fade=None, spatter=False, dust=0.30)
    wx.mud_band(L.Z_BOT.rect, 0.04, fade=None, spatter=False, dust=0.22)
    wx.mud_band(L.R_VANE, 0.04, fade='down', spatter=False, dust=0.16)
    wx.mud_band(L.R_HALO, 0.03, fade=None, spatter=False, dust=0.18)
    wx.mud_band(L.Z_EYE.rect, 0.03, fade=None, spatter=False, dust=0.20)
    # scorch: this one has been shot at, and the ancients' alloy only chars
    bx0, by0, bx1, by1 = L.Z_BOT.rect
    wx.soot_patch((bx0 + 96, by0 + 300, bx0 + 260, by0 + 460), 0.34)
    wx.soot_patch((L.R_VANE[0] + 20, L.R_VANE[1] + 160,
                   L.R_VANE[0] + 110, L.R_VANE[1] + 205), 0.22)
    wx.soot_patch((L.Z_EQ.rect[0] + 660, L.Z_EQ.rect[1],
                   L.Z_EQ.rect[0] + 790, L.Z_EQ.rect[3]), 0.22)

    # ── relief: the plateau stands proud, the channels cut in ───────────
    from normals import HeightMap
    hm = HeightMap()
    hm.disc(TOP_C[0], TOP_C[1], 0.32 * S_TOP, 0.55)
    hm.disc(TOP_C[0], TOP_C[1], 0.175 * S_TOP, -0.45)
    hm.disc(BOT_C[0], BOT_C[1], 0.30 * S_TOP, -0.75)
    ex0, ey0, ex1, ey1 = L.Z_EQ.rect
    hm.rect((ex0, ey0 + 8, ex1, ey1 - 8), -0.5)
    hx0, hy0, hx1, hy1 = L.R_HALO
    hm.rect((hx0, hy0 + int((hy1 - hy0) * 0.40), hx1,
             hy0 + int((hy1 - hy0) * 0.60)), -0.35)
    vx0, vy0, vx1, vy1 = L.R_VANE
    hm.line((vx0 + (vx1 - vx0) * 0.5, vy0 + (vy1 - vy0) * 0.02),
            (vx0 + (vx1 - vx0) * 0.5, vy0 + (vy1 - vy0) * 0.77), -0.4, width=7)

    PL.finish(m, L, 'ms_anc_sentinel', hm=hm, wx=wx, emissive_blur=0.9)


if __name__ == '__main__':
    paint_all()
