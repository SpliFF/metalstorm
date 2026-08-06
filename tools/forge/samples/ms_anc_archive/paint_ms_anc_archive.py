"""paint_ms_anc_archive — 2048^2 PBR set for ms_anc_archive.

ANCIENT REGISTER: monolithic, precise, seamless. Large unbroken
basalt-alloy surfaces cut by clean RECESSED SEAMS — no rivets, no bolted
patches, no scrap, no team colour. Emissive CYAN is the signature and is
ACTIVE here: horizontal glyph-line rows run the data-stack faces like
library stacks of light, a running index line threads the floating ring,
and a glyph rosette is inscribed in the court floor. Weathering is
GEOLOGICAL — soil burial at the buried skirt, dust drift on the walkway,
scorch across the court — never rust streaks from fittings.

Atlas mapping conventions (must match gen_ms_anc_archive.py):
  W_* wrap rects  : u = around the ring (x0..x1); world-DOWN ring maps to
                    the rect's BOTTOM edge, so world-up reads image-up.
  W_STACK[i]      : u = along the stack (x0 = footing, x1 = crown);
                    v = 4 face bands — 0 = broad outward, 1 = side,
                    2 = broad inward, 3 = side.
  W_RING          : u = around the ring; v = 8 profile bands —
                    0 = outer face, 2 = +B top, 4 = inner face.
  W_TABLET        : u = base->tip; v = 4 bands, 0 = outward lens face.
"""
from __future__ import annotations
import numpy as np

import ms_anc_archive_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, shade, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, M_ARMOR, R_GLASS, M_GLASS, R_GLOW, BLACKISH)

W = 2048
RNG = np.random.default_rng(90210)

ALLOY     = (98, 104, 110)    # pale basalt-alloy — reads at strategic zoom
ALLOY_LT  = (121, 127, 133)
ALLOY_DK  = (76, 82, 88)
ALLOY_XDK = (54, 58, 63)
SOIL      = (100, 89, 69)     # geological burial
DUST      = (129, 121, 103)
SCORCH    = (46, 43, 40)
CYAN      = (60, 235, 255)
CYAN_DIM  = (40, 124, 140)    # tone-on-tone tracery in diffuse
CYAN_MID  = (52, 168, 188)


# ── small rect helpers (all wrap rects are parametric u/v) ──────────────

def ux(rect, f):
    """fraction along u -> atlas px."""
    x0, _, x1, _ = rect
    return x0 + (x1 - x0) * f


def vy(rect, f):
    """fraction across v (0 = rect top) -> atlas px."""
    _, y0, _, y1 = rect
    return y0 + (y1 - y0) * f


def bandv(rect, j, n, f0=0.0, f1=1.0):
    """v-range of band j of n, optionally sub-ranged."""
    _, y0, _, y1 = rect
    a = y0 + (y1 - y0) * (j + f0) / n
    b = y0 + (y1 - y0) * (j + f1) / n
    return a, b


def cyan_line(m, p0, p1, wd=3, dim=CYAN_DIM, emi=0.8):
    m.d.line([p0, p1], fill=dim, width=wd + 1)
    m.e.line([p0, p1], fill=shade(CYAN, emi), width=wd)


def cyan_rect(m, box, dim=CYAN_DIM, emi=0.8):
    m.d.rectangle(box, fill=dim)
    m.e.rectangle(box, fill=shade(CYAN, emi))


def facet_seams(m, rect, n, col=None, wd=3):
    """n vertical recessed seams aligned with the geometry's facet edges."""
    col = col or shade(ALLOY_DK, 0.72)
    _, y0, _, y1 = rect
    for i in range(n):
        x = ux(rect, i / n)
        m.d.line([(x, y0), (x, y1)], fill=col, width=wd)


# ── the court ──────────────────────────────────────────────────────────

def paint_court_floor(m):
    z = L.R_COURT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 6,
         rough=R_ARMOR + 10, metal=M_ARMOR + 30)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    ppm = (x1 - x0) / 14.2          # px per world metre

    # concentric recessed seams — precise, unbroken
    for r_m in (2.05, 3.25, 4.45, 5.55, 6.55):
        r = r_m * ppm
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r],
                    outline=shade(ALLOY_DK, 0.74), width=6)
    # inscribed cyan index rosette: a ring plus one spoke per data-stack
    for r_m, wd, e in ((2.45, 4, 0.85), (6.15, 3, 0.6)):
        r = r_m * ppm
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CYAN_DIM,
                    width=wd + 1)
        m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade(CYAN, e),
                    width=wd)
    for (theta, *_rest) in L.STACKS:
        a = np.radians(theta)
        ca, sa = np.cos(a), np.sin(a)
        cyan_line(m, (cx + 2.5 * ppm * ca, cy + 2.5 * ppm * sa),
                  (cx + 6.1 * ppm * ca, cy + 6.1 * ppm * sa), wd=4, emi=0.75)
        # glyph ticks along each index path
        for k in range(9):
            rr = (2.9 + k * 0.38) * ppm
            pa = a + 0.055
            pb = a - 0.055
            cyan_line(m, (cx + rr * np.cos(pa), cy + rr * np.sin(pa)),
                      (cx + rr * np.cos(pb), cy + rr * np.sin(pb)),
                      wd=2, emi=float(0.35 + 0.5 * RNG.random()))
    # dust drift creeping in from the rim (geological, not mechanical)
    for _ in range(70):
        a = RNG.uniform(0, 2 * np.pi)
        rr = RNG.uniform(5.0, 6.9) * ppm
        rad = RNG.uniform(10, 46)
        m.d.ellipse([cx + rr * np.cos(a) - rad, cy + rr * np.sin(a) - rad,
                     cx + rr * np.cos(a) + rad, cy + rr * np.sin(a) + rad],
                    fill=shade(DUST, RNG.uniform(0.55, 0.8)))


def paint_court_shell(m):
    # buried soil skirt — fully swallowed by the ground
    fill(m, L.W_SKIRT, dif=SOIL, ao=AO_DEEP, rough=250, metal=0)

    # outer plinth flank: one unbroken monolithic surface
    r = L.W_PLINTH
    fill(m, r, dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR, metal=M_ARMOR + 40)
    facet_seams(m, r, L.COURT_N, wd=4)
    for f in (0.36, 0.68):
        m.d.line([(r[0], vy(r, f)), (r[2], vy(r, f))],
                 fill=shade(ALLOY, 0.80), width=5)
    cyan_line(m, (r[0], vy(r, 0.17)), (r[2], vy(r, 0.17)), wd=4, emi=0.55)
    # a second, dashed register line — the outer index band
    for i in range(L.COURT_N * 3):
        xa = ux(r, (i + 0.18) / (L.COURT_N * 3))
        xb = ux(r, (i + 0.82) / (L.COURT_N * 3))
        cyan_rect(m, [xa, vy(r, 0.845), xb, vy(r, 0.885)],
                  emi=float(0.30 + 0.55 * RNG.random()))

    fill(m, L.W_CHAM, dif=ALLOY_LT, ao=AO_BASE, rough=R_ARMOR - 6,
         metal=M_ARMOR + 50)
    facet_seams(m, L.W_CHAM, L.COURT_N, wd=3)

    # walkway annulus (image bottom = outer edge)
    r = L.W_SHELF
    fill(m, r, dif=shade(ALLOY, 1.06), ao=AO_BASE - 2, rough=R_ARMOR + 6,
         metal=M_ARMOR + 30)
    facet_seams(m, r, L.COURT_N, wd=4)
    m.d.rectangle([r[0], vy(r, 0.40), r[2], vy(r, 0.60)],
                  fill=shade(ALLOY, 0.94))
    cyan_line(m, (r[0], vy(r, 0.50)), (r[2], vy(r, 0.50)), wd=3, emi=0.5)

    fill(m, L.W_RIM, dif=ALLOY_LT, ao=AO_SEAM, rough=R_ARMOR, metal=M_ARMOR + 50)
    facet_seams(m, L.W_RIM, L.COURT_N, wd=3)

    # inner court wall — faces the sunken court
    r = L.W_INNER
    fill(m, r, dif=ALLOY, ao=AO_BASE - 8, rough=R_ARMOR, metal=M_ARMOR + 40)
    facet_seams(m, r, L.COURT_N, wd=4)
    cyan_line(m, (r[0], vy(r, 0.22)), (r[2], vy(r, 0.22)), wd=4, emi=0.7)
    for i in range(L.COURT_N * 4):
        xa = ux(r, (i + 0.22) / (L.COURT_N * 4))
        xb = ux(r, (i + 0.78) / (L.COURT_N * 4))
        cyan_rect(m, [xa, vy(r, 0.52), xb, vy(r, 0.57)],
                  emi=float(0.25 + 0.5 * RNG.random()))

    fill(m, L.W_FCHAM, dif=ALLOY_DK, ao=AO_SEAM, rough=R_ARMOR + 8,
         metal=M_ARMOR + 30)

    # stack footings
    r = L.W_PAD
    fill(m, r, dif=ALLOY_LT, ao=AO_BASE - 4, rough=R_ARMOR, metal=M_ARMOR + 50)
    facet_seams(m, r, L.PAD_N, wd=5)
    cyan_line(m, (r[0], vy(r, 0.30)), (r[2], vy(r, 0.30)), wd=4, emi=0.65)
    r = L.R_PADTOP
    fill(m, r, dif=ALLOY_LT, ao=AO_BASE - 4, rough=R_ARMOR, metal=M_ARMOR + 50)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) * 0.40
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=CYAN_DIM, width=7)
    m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                outline=shade(CYAN, 0.6), width=5)

    # central altar
    r = L.W_ALTAR
    fill(m, r, dif=ALLOY, ao=AO_BASE - 6, rough=R_ARMOR, metal=M_ARMOR + 40)
    facet_seams(m, r, L.ALTAR_N, wd=6)
    for i in range(L.ALTAR_N):
        xa, xb = ux(r, (i + 0.30) / L.ALTAR_N), ux(r, (i + 0.70) / L.ALTAR_N)
        cyan_rect(m, [xa, vy(r, 0.34), xb, vy(r, 0.44)], emi=0.75)
    z = L.R_ALTAR_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR + 40)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for k, (fr, e) in enumerate(((0.86, 0.5), (0.62, 0.7), (0.34, 0.95))):
        rr = (x1 - x0) / 2 * fr
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=CYAN_DIM,
                    width=8)
        m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(CYAN, e), width=6)
    rr = (x1 - x0) * 0.11
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=shade(CYAN, 0.4))
    m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=CYAN)

    # floating data-shards: dim cyan bodies with a hot core
    r = L.W_NODE
    fill(m, r, dif=shade(CYAN, 0.20), ao=AO_BASE, rough=R_GLOW,
         metal=M_ARMOR + 20)
    for f in (0.30, 0.50, 0.70):
        cyan_line(m, (r[0], vy(r, f)), (r[2], vy(r, f)), wd=5, emi=0.95)
    m.e.rectangle([ux(r, 0.62), r[1], r[2], r[3]], fill=shade(CYAN, 0.55))


# ── the five leaning data-stacks ───────────────────────────────────────

def paint_stacks(m):
    for i, rect in enumerate(L.W_STACK):
        top_y = L.STACKS[i][1]
        x0, y0, x1, y1 = rect
        fill(m, rect, dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR,
             metal=M_ARMOR + 40)
        # broad faces a touch lighter, narrow sides a touch darker (±8%,
        # tone-on-tone: these are large quads, keep the baker calm)
        for j, f in ((0, 1.07), (1, 0.90), (2, 1.03), (3, 0.90)):
            a, b = bandv(rect, j, 4)
            m.d.rectangle([x0, a, x1, b], fill=shade(ALLOY, f))
            m.d.line([(x0, a), (x1, a)], fill=shade(ALLOY_DK, 0.80), width=3)

        # ── glyph-line rows: library stacks of light ──────────────────
        rows = max(24, int((top_y - L.PAD_Y1) / 0.30))
        seam_t = L.STK_SEAMS
        for k in range(rows):
            t = 0.022 + (k + 0.5) / rows * 0.955
            if any(abs(t - s) < 0.032 for s in seam_t):
                continue
            if RNG.random() < 0.17:
                continue                      # gaps in the index
            x = x0 + (x1 - x0) * t
            e = float(0.34 + 0.62 * RNG.random())
            for j in (0, 2):                  # the two broad faces
                a, b = bandv(rect, j, 4, 0.10, 0.90)
                nseg = 3 if RNG.random() < 0.55 else 4
                for s in range(nseg):
                    ya = a + (b - a) * (s + 0.10) / nseg
                    yb = a + (b - a) * (s + 0.90) / nseg
                    m.d.line([(x, ya), (x, yb)], fill=CYAN_DIM, width=3)
                    m.e.line([(x, ya), (x, yb)], fill=shade(CYAN, e), width=2)

        # continuous edge channels down the two narrow sides
        for j in (1, 3):
            a, b = bandv(rect, j, 4)
            yc = (a + b) / 2
            m.d.line([(ux(rect, 0.02), yc), (ux(rect, 0.985), yc)],
                     fill=CYAN_DIM, width=5)
            m.e.line([(ux(rect, 0.02), yc), (ux(rect, 0.985), yc)],
                     fill=shade(CYAN, 0.62), width=3)

        # ── clean recessed seams (geometry-matched) ───────────────────
        for s in seam_t:
            xa = x0 + (x1 - x0) * (s - 0.021)
            xb = x0 + (x1 - x0) * (s + 0.021)
            m.d.rectangle([xa, y0, xb, y1], fill=shade(ALLOY, 0.66))
            xc = (xa + xb) / 2
            m.d.line([(xc, y0), (xc, y1)], fill=CYAN_DIM, width=4)
            m.e.line([(xc, y0), (xc, y1)], fill=shade(CYAN, 0.55), width=3)

        # scorch + soil at the footing end, brighter register at the crown
        m.d.rectangle([x0, y0, ux(rect, 0.045), y1], fill=SCORCH)
        cyan_rect(m, [ux(rect, 0.972), y0, x1, y1], dim=shade(CYAN, 0.30),
                  emi=0.9)

    # crown lens
    r = L.R_STKCAP
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    for fr, e in ((0.90, 0.45), (0.62, 0.7), (0.34, 1.0)):
        rr = (r[2] - r[0]) / 2 * fr
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=CYAN_DIM,
                    width=9)
        m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(CYAN, e), width=7)


# ── the floating index ring ────────────────────────────────────────────

def paint_index(m):
    r = L.W_RING
    x0, y0, x1, y1 = r
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 4, rough=R_ARMOR - 10,
         metal=M_ARMOR + 60)
    tone = {0: 1.00, 1: 1.12, 2: 1.18, 3: 1.12, 4: 0.94, 5: 0.86,
            6: 0.80, 7: 0.86}
    for j in range(8):
        a, b = bandv(r, j, 8)
        m.d.rectangle([x0, a, x1, b], fill=shade(ALLOY_DK, tone[j]))
        m.d.line([(x0, a), (x1, a)], fill=shade(ALLOY_XDK, 0.9), width=2)

    # band 0 = outer face: the running index — a continuous rail plus
    # dense glyph blocks, the archive reading itself out
    a, b = bandv(r, 0, 8)
    yc = (a + b) / 2
    cyan_line(m, (x0, yc), (x1, yc), wd=4, emi=0.85)
    nblk = 96
    for i in range(nblk):
        if RNG.random() < 0.22:
            continue
        xa = ux(r, (i + 0.15) / nblk)
        xb = ux(r, (i + 0.85) / nblk)
        hh = (b - a) * float(RNG.uniform(0.16, 0.34))
        cyan_rect(m, [xa, yc - hh, xb, yc - hh * 0.45],
                  emi=float(0.35 + 0.6 * RNG.random()))
        cyan_rect(m, [xa, yc + hh * 0.45, xb, yc + hh],
                  emi=float(0.35 + 0.6 * RNG.random()))

    # band 2 = the ring's +B face (tablets stand on it): a guide rail
    a, b = bandv(r, 2, 8)
    cyan_line(m, (x0, (a + b) / 2), (x1, (a + b) / 2), wd=3, emi=0.5)
    # band 4 = inner face: a sparser register
    a, b = bandv(r, 4, 8)
    yc = (a + b) / 2
    for i in range(48):
        xa, xb = ux(r, (i + 0.25) / 48), ux(r, (i + 0.75) / 48)
        cyan_rect(m, [xa, yc - 4, xb, yc + 4],
                  emi=float(0.25 + 0.45 * RNG.random()))

    # index tablets (u = base -> tip)
    r = L.W_TABLET
    x0, y0, x1, y1 = r
    fill(m, r, dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR, metal=M_ARMOR + 50)
    for j, f in ((0, 1.0), (1, 0.88), (2, 0.80), (3, 0.88)):
        a, b = bandv(r, j, 4)
        m.d.rectangle([x0, a, x1, b], fill=shade(ALLOY, f))
    a, b = bandv(r, 0, 4, 0.12, 0.88)          # outward lens face
    m.d.rectangle([ux(r, 0.10), a, ux(r, 0.94), b], fill=shade(CYAN, 0.30))
    m.e.rectangle([ux(r, 0.10), a, ux(r, 0.94), b], fill=shade(CYAN, 0.55))
    for k in range(14):                        # glyph rows on the tablet
        x = ux(r, 0.14 + k * 0.058)
        m.e.line([(x, a + 3), (x, b - 3)], fill=shade(CYAN, 0.95), width=3)
    r = L.R_TABCAP
    fill(m, r, dif=shade(CYAN, 0.28), ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    m.e.rectangle([r[0] + 6, r[1] + 6, r[2] - 6, r[3] - 6], fill=shade(CYAN, 0.8))

    fill(m, L.R_DARK, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=M_ARMOR)


# ── weather + normals ──────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_court_floor(m)
    paint_court_shell(m)
    paint_stacks(m)
    paint_index(m)

    from weathering import Weather
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.22)
    # geological burial + dust drift; no rust — nothing here is bolted
    wx.mud_band(L.W_SKIRT, 0.95, fade=None)
    wx.mud_band(L.W_PLINTH, 0.52, fade='down', dust=0.30)
    wx.mud_band(L.W_PAD, 0.42, fade='down', dust=0.26)
    wx.mud_band(L.W_INNER, 0.30, fade='down', dust=0.24)
    wx.mud_band(L.W_ALTAR, 0.26, fade='down', dust=0.20)
    wx.mud_band(L.W_SHELF, 0.20, fade=None, dust=0.30)
    for rect in L.W_STACK:
        wx.mud_band(rect, 0.40, fade='left', dust=0.16)
    wx.soot_patch(L.R_COURT.rect, 0.30)
    wx.soot_patch(L.W_PLINTH, 0.18)

    from normals import HeightMap
    hm = HeightMap()
    # recessed seams cut into the stacks
    for i, rect in enumerate(L.W_STACK):
        x0, y0, x1, y1 = rect
        for s in L.STK_SEAMS:
            x = x0 + (x1 - x0) * s
            hm.line((x, y0), (x, y1), -0.85, width=int((x1 - x0) * 0.040))
        for j in range(1, 4):
            yy = y0 + (y1 - y0) * j / 4
            hm.line((x0, yy), (x1, yy), -0.5, width=3)
    # facet seams around the court body
    for rect, n in ((L.W_PLINTH, L.COURT_N), (L.W_SHELF, L.COURT_N),
                    (L.W_INNER, L.COURT_N), (L.W_PAD, L.PAD_N),
                    (L.W_ALTAR, L.ALTAR_N)):
        x0, y0, x1, y1 = rect
        for i in range(n):
            x = x0 + (x1 - x0) * i / n
            hm.line((x, y0), (x, y1), -0.6, width=4)
    # concentric grooves in the court floor
    zx0, zy0, zx1, zy1 = L.R_COURT.rect
    cx, cy = (zx0 + zx1) / 2, (zy0 + zy1) / 2
    ppm = (zx1 - zx0) / 14.2
    for r_m in (2.05, 3.25, 4.45, 5.55, 6.55):
        rr = r_m * ppm
        pts = [(cx + rr * np.cos(t), cy + rr * np.sin(t))
               for t in np.linspace(0, 2 * np.pi, 96)]
        for a, b in zip(pts, pts[1:]):
            hm.line(a, b, -0.5, width=5)

    PL.finish(m, L, 'ms_anc_archive', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
