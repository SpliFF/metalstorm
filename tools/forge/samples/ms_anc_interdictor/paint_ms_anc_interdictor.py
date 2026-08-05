"""paint_ms_anc_interdictor — 2048^2 PBR set for ms_anc_interdictor.

ANCIENT REGISTER. Dark basalt-alloy monoliths, tone-on-tone segmentation
by clean recessed seams — no bolts, no patches, no rust. Emissive CYAN is
the signature and the machine is ACTIVE: it flows. The leg INNER faces
carry a true moiré interference field (two concentric wave families;
their intersections are the bright nodes) — dim in diffuse, bright in
emissive so the impostor baker's flat-shading has nothing to blotch.
Weathering is geological: ash fallout, soil burial at the feet, dust
drift, scorch — never a rust streak.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageChops, ImageFilter

import ms_anc_interdictor_layout as L   # sets meshlib.ATLAS = 2048
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
STEM = 'ms_anc_interdictor'

ALLOY     = (92, 100, 108)    # seamless basalt-alloy (reads at 200 m; the
ALLOY_LT  = (112, 121, 129)   # first bake came back a black blob)
ALLOY_DK  = (72, 79, 86)
ALLOY_XDK = (52, 57, 62)
CORE_A    = (126, 136, 146)   # the suspended core sits a stop brighter than
CORE_A_DK = (96, 104, 112)    # the legs so it reads as a separate object
ASH       = (126, 124, 118)   # dead-zone fallout
ASH_LT    = (136, 134, 128)
ASH_DK    = (114, 112, 107)
SOIL      = (72, 64, 55)
SOIL_DK   = (54, 48, 41)
SCORCH    = (36, 33, 30)
CYAN      = (86, 226, 255)
CYAN_DIM  = (26, 96, 112)     # tone-on-tone tracery in diffuse
CYAN_DIM2 = (19, 70, 82)

RNG = np.random.default_rng(90210)


# ── clipped compositing (draw anywhere, land only inside the rect) ───────

def layer(rect):
    x0, y0, x1, y1 = rect
    mask = Image.new('L', (x1 - x0, y1 - y0), 0)
    return mask, ImageDraw.Draw(mask)


def stamp(m, rect, mask, dif=None, emi=None, orm=None):
    x0, y0 = rect[0], rect[1]
    size = (rect[2] - x0, rect[3] - y0)
    if dif is not None:
        m.dif.paste(Image.new('RGB', size, dif), (x0, y0), mask)
    if emi is not None:
        m.emi.paste(Image.new('RGB', size, emi), (x0, y0), mask)
    if orm is not None:
        m.orm.paste(Image.new('RGB', size, orm), (x0, y0), mask)


def seams_u(m, rect, n, base, cyan_rows=()):
    """Recessed cross-seams along a parametric wrap (u = along the sweep)."""
    x0, y0, x1, y1 = rect
    for i in range(1, n):
        x = x0 + (x1 - x0) * i / n
        m.d.line([(x, y0), (x, y1)], fill=shade(base, 0.62), width=3)
        m.d.line([(x + 3, y0), (x + 3, y1)], fill=shade(base, 1.16), width=1)
        m.o.line([(x, y0), (x, y1)], fill=(AO_SEAM, R_ARMOR + 10, M_ARMOR), width=3)
    for (fa, fb) in cyan_rows:
        ya, yb = y0 + (y1 - y0) * fa, y0 + (y1 - y0) * fb
        yy = (ya + yb) / 2
        m.d.line([(x0, yy), (x1, yy)], fill=CYAN_DIM, width=max(3, int((yb - ya) * 0.5)))
        m.e.line([(x0, yy), (x1, yy)], fill=shade(CYAN, 0.85),
                 width=max(2, int((yb - ya) * 0.30)))


# ── dead-zone ash circle + inscribed rim ─────────────────────────────────

def paint_ash(m):
    z = L.R_ASH
    u, v = PL.zone_fns(z)
    cx, cy = u(0.0), v(0.0)
    s = u(1.0) - u(0.0)                       # px per world metre

    def ring(r, **kw):
        return [cx - r * s, cy - r * s, cx + r * s, cy + r * s]

    fill(m, z.rect, dif=ASH, ao=AO_BASE, rough=R_ARMOR + 40, metal=10)
    # fallout gradient: pale at the perimeter, scorched toward the emitter
    for rr, col in ((10.4, ASH), (8.6, shade(ASH, 0.97)), (6.4, shade(ASH, 0.93)),
                    (4.4, shade(ASH, 0.88)), (2.6, shade(ASH, 0.83))):
        m.d.ellipse(ring(rr), fill=col)
    # scour: fine radial wind-rake, ash only, low contrast
    for a in RNG.uniform(0, 2 * np.pi, 220):
        r0 = RNG.uniform(1.2, 9.4)
        r1 = r0 + RNG.uniform(0.5, 2.6)
        col = ASH_LT if RNG.random() < 0.5 else ASH_DK
        m.d.line([(cx + r0 * s * np.cos(a), cy + r0 * s * np.sin(a)),
                  (cx + r1 * s * np.cos(a), cy + r1 * s * np.sin(a))],
                 fill=col, width=int(RNG.integers(2, 5)))
    # soil disturbance where each leg is buried
    for th in L.LEG_THETAS:
        a = np.radians(th)
        fx, fy = cx + L.LEG_BEZ[0][0] * s * np.cos(a), cy + L.LEG_BEZ[0][0] * s * np.sin(a)
        for rr, col in ((3.1, shade(SOIL, 1.25)), (2.4, SOIL), (1.8, SOIL_DK)):
            m.d.ellipse([fx - rr * s, fy - rr * s, fx + rr * s, fy + rr * s], fill=col)
    # pylon footings
    for th in L.PYLON_THETAS:
        a = np.radians(th)
        fx, fy = cx + L.PYLON_R * s * np.cos(a), cy + L.PYLON_R * s * np.sin(a)
        m.d.ellipse([fx - 1.5 * s, fy - 1.5 * s, fx + 1.5 * s, fy + 1.5 * s],
                    fill=shade(ASH_DK, 0.86))
        m.d.ellipse([fx - 1.2 * s, fy - 1.2 * s, fx + 1.2 * s, fy + 1.2 * s],
                    outline=CYAN_DIM2, width=4)
        m.e.ellipse([fx - 1.2 * s, fy - 1.2 * s, fx + 1.2 * s, fy + 1.2 * s],
                    outline=shade(CYAN, 0.40), width=3)
    # burnt heart of the dead zone
    m.d.ellipse(ring(1.9), fill=SCORCH)
    m.o.ellipse(ring(1.9), fill=(AO_DEEP, R_ARMOR + 50, 6))

    # inscribed geometry: perfect circles, ancient precision
    m.d.ellipse(ring(9.55), outline=shade(ASH_DK, 0.80), width=4)
    m.d.ellipse(ring(8.05), outline=CYAN_DIM2, width=5)
    m.e.ellipse(ring(8.05), outline=shade(CYAN, 0.45), width=3)
    for i in range(L.BASE_N * 2):
        a = 2 * np.pi * i / (L.BASE_N * 2)
        p0 = (cx + 9.62 * s * np.cos(a), cy + 9.62 * s * np.sin(a))
        p1 = (cx + 10.25 * s * np.cos(a), cy + 10.25 * s * np.sin(a))
        m.d.line([p0, p1], fill=CYAN_DIM2, width=4)
        m.e.line([p0, p1], fill=shade(CYAN, 0.35), width=2)

    # the rim itself: crown in alloy, inner slope carries the live groove
    m.d.ellipse(ring(11.05), outline=ALLOY_DK, width=int(0.70 * s))
    m.o.ellipse(ring(11.05), outline=(AO_BASE, R_ARMOR, M_ARMOR + 40),
                width=int(0.70 * s))
    ga, gb = L.RIM_GROOVE_R
    gm = (ga + gb) / 2
    m.d.ellipse(ring(gm), outline=CYAN_DIM, width=int((gb - ga) * s))
    m.e.ellipse(ring(gm), outline=shade(CYAN, 0.90), width=int((gb - ga) * s * 0.55))


def paint_rim_side(m):
    r = L.R_RIM_S
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 6, rough=R_ARMOR, metal=M_ARMOR + 40)
    x0, y0, x1, y1 = r
    m.d.line([(x0, y0 + 10), (x1, y0 + 10)], fill=CYAN_DIM2, width=5)
    m.e.line([(x0, y0 + 10), (x1, y0 + 10)], fill=shade(CYAN, 0.55), width=3)
    m.d.rectangle([x0, y1 - 20, x1, y1], fill=SOIL_DK)
    seams_u(m, r, 32, ALLOY_DK)


# ── legs ─────────────────────────────────────────────────────────────────

def interference_field(m):
    """Two concentric wave families on the leg inner face; the moiré
    intersections are the bright emissive nodes."""
    rect = L.R_LEG_IN
    x0, y0, x1, y1 = rect
    w, h = x1 - x0, y1 - y0
    m1, d1 = layer(rect)
    m2, d2 = layer(rect)
    for (dr, cxy, step, nmax) in (((d1), (-0.18 * w, 0.46 * h), 44, 34),
                                  ((d2), (1.20 * w, 0.64 * h), 51, 34)):
        for i in range(1, nmax):
            r = step * i
            dr.ellipse([cxy[0] - r, cxy[1] - r, cxy[0] + r, cxy[1] + r],
                       outline=255, width=3)
    union = ImageChops.lighter(m1, m2)
    nodes = ImageChops.multiply(m1, m2)
    nodes = nodes.filter(ImageFilter.MaxFilter(5))
    stamp(m, rect, union, dif=CYAN_DIM2, emi=shade(CYAN, 0.30))
    stamp(m, rect, nodes, dif=CYAN_DIM, emi=CYAN)


def paint_legs(m):
    # inner face — the interference plate
    r = L.R_LEG_IN
    fill(m, r, dif=ALLOY_LT, ao=AO_BASE - 4, rough=R_ARMOR - 6, metal=M_ARMOR + 50)
    x0, y0, x1, y1 = r
    # standing-wave banding across the face, tone-on-tone
    for i in range(7):
        ya = y0 + (y1 - y0) * i / 7.0
        m.d.rectangle([x0, ya, x1, ya + (y1 - y0) / 14.0],
                      fill=shade(ALLOY_LT, 0.94 if i % 2 else 1.05))
    interference_field(m)
    seams_u(m, r, L.LEG_STATIONS - 1, ALLOY_LT)
    m.d.rectangle([x0, y0, x0 + 46, y1], fill=SOIL_DK)          # buried foot
    m.o.rectangle([x0, y0, x0 + 46, y1], fill=(AO_DEEP, R_ARMOR + 60, 8))

    # outer face — monolithic, dust drift on the upper (overhanging) run
    r = L.R_LEG_OUT
    fill(m, r, dif=ALLOY, ao=AO_BASE - 2, rough=R_ARMOR, metal=M_ARMOR + 40)
    x0, y0, x1, y1 = r
    for i in range(5):
        xa = x0 + (x1 - x0) * (0.55 + 0.09 * i)
        m.d.rectangle([xa, y0, xa + (x1 - x0) * 0.05, y1],
                      fill=shade(ALLOY, 1.06 + 0.015 * i))
    seams_u(m, r, L.LEG_STATIONS - 1, ALLOY, cyan_rows=((0.46, 0.54),))
    m.d.rectangle([x0, y0, x0 + 46, y1], fill=SOIL_DK)

    # flanks + chamfer facets — the recessed seams are where the light lives
    r = L.R_LEG_SIDE
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 6, rough=R_ARMOR + 6, metal=M_ARMOR + 40)
    seams_u(m, r, L.LEG_STATIONS - 1, ALLOY_DK, cyan_rows=((0.42, 0.58),))
    m.d.rectangle([r[0], r[1], r[0] + 46, r[3]], fill=SOIL_DK)

    r = L.R_LEG_CH
    fill(m, r, dif=ALLOY_XDK, ao=AO_SEAM, rough=R_ARMOR + 10, metal=M_ARMOR + 30)
    seams_u(m, r, L.LEG_STATIONS - 1, ALLOY_XDK, cyan_rows=((0.30, 0.70),))
    m.d.rectangle([r[0], r[1], r[0] + 46, r[3]], fill=SOIL_DK)


def paint_cantilever(m):
    r = L.R_CANT
    x0, y0, x1, y1 = r
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 8, rough=R_ARMOR, metal=M_ARMOR + 50)
    for j in range(4):
        ya = y0 + (y1 - y0) * (j + 0.5) / 4.0
        m.d.line([(x0 + (x1 - x0) * 0.18, ya), (x1, ya)], fill=CYAN_DIM, width=6)
        m.e.line([(x0 + (x1 - x0) * 0.18, ya), (x1, ya)], fill=shade(CYAN, 0.80), width=3)
    seams_u(m, r, 4, ALLOY_DK)
    m.d.rectangle([x1 - 34, y0, x1, y1], fill=shade(CYAN, 0.42))
    m.e.rectangle([x1 - 34, y0, x1, y1], fill=CYAN)


# ── suspended core ───────────────────────────────────────────────────────

def paint_core(m):
    r = L.R_CORE
    x0, y0, x1, y1 = r
    fill(m, r, dif=CORE_A, ao=AO_BASE - 6, rough=R_ARMOR - 10, metal=M_ARMOR + 70)
    # eight facets, tone-on-tone
    for j in range(L.CORE_N):
        ya = y0 + (y1 - y0) * j / L.CORE_N
        yb = y0 + (y1 - y0) * (j + 1) / L.CORE_N
        m.d.rectangle([x0, ya, x1, yb], fill=shade(CORE_A, 1.0 - 0.08 * (j % 2)))
        m.d.line([(x0, ya), (x1, ya)], fill=CORE_A_DK, width=3)
    # apex tracery: thin cyan meridians converging on both poles
    for j in range(L.CORE_N):
        ya = y0 + (y1 - y0) * (j + 0.5) / L.CORE_N
        m.d.line([(x0 + 12, ya), (x1 - 12, ya)], fill=CYAN_DIM2, width=4)
        m.e.line([(x0 + 12, ya), (x1 - 12, ya)], fill=shade(CYAN, 0.45), width=2)
    # the live equator belt (u ~ 0.5 == the core's widest ring)
    ea, eb = x0 + (x1 - x0) * 0.400, x0 + (x1 - x0) * 0.600
    m.d.rectangle([ea, y0, eb, y1], fill=shade(CYAN, 0.62))
    m.o.rectangle([ea, y0, eb, y1], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([ea, y0, eb, y1], fill=CYAN)
    m.d.rectangle([ea - 10, y0, ea, y1], fill=ALLOY_XDK)
    m.d.rectangle([eb, y0, eb + 10, y1], fill=ALLOY_XDK)


# ── broken halo antenna ──────────────────────────────────────────────────

def paint_halo(m):
    r = L.R_HALO
    x0, y0, x1, y1 = r
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 6, rough=R_ARMOR - 6, metal=M_ARMOR + 60)
    bh = (y1 - y0) / 4.0
    # band 1 is the face that stares at the core: the running light
    ib = y0 + bh * L.HALO_INNER_SIDE
    m.d.rectangle([x0, ib + bh * 0.30, x1, ib + bh * 0.70], fill=shade(CYAN, 0.38))
    m.e.rectangle([x0, ib + bh * 0.32, x1, ib + bh * 0.68], fill=CYAN)
    # hairline tracery on the top and outer bands
    for j in (0, 3):
        yy = y0 + bh * (j + 0.5)
        m.d.line([(x0, yy), (x1, yy)], fill=CYAN_DIM2, width=5)
        m.e.line([(x0, yy), (x1, yy)], fill=shade(CYAN, 0.5), width=2)
    seams_u(m, r, L.HALO_SEGS // 2, ALLOY_DK)
    # the broken ends go dark and dormant
    for (xa, xb) in ((x0, x0 + (x1 - x0) * 0.055), ((x1 - (x1 - x0) * 0.055), x1)):
        m.d.rectangle([xa, y0, xb, y1], fill=ALLOY_XDK)
        m.e.rectangle([xa, y0, xb, y1], fill=(0, 0, 0))
        m.o.rectangle([xa, y0, xb, y1], fill=(AO_DEEP, R_ARMOR + 30, M_ARMOR))


# ── resonator pylons, burial mounds, lens caps ───────────────────────────

def paint_pylon(m):
    r = L.R_PYLON
    x0, y0, x1, y1 = r
    fill(m, r, dif=ALLOY, ao=AO_BASE - 2, rough=R_ARMOR, metal=M_ARMOR + 40)
    bh = (y1 - y0) / L.PYLON_N
    for j in range(L.PYLON_N):
        ya = y0 + bh * j
        m.d.rectangle([x0, ya, x1, ya + bh], fill=shade(ALLOY, 1.0 + 0.05 * (j % 2)))
        m.d.line([(x0, ya), (x1, ya)], fill=shade(ALLOY, 0.58), width=3)
    for j in (1, 4):
        yy = y0 + bh * (j + 0.5)
        m.d.line([(x0 + (x1 - x0) * 0.10, yy), (x1, yy)], fill=CYAN_DIM, width=7)
        m.e.line([(x0 + (x1 - x0) * 0.18, yy), (x1, yy)], fill=shade(CYAN, 0.8), width=4)
    seams_u(m, r, 8, ALLOY)
    m.d.rectangle([x0, y0, x0 + 70, y1], fill=SOIL_DK)          # buried footing
    m.d.rectangle([x0 + 70, y0, x0 + 130, y1], fill=shade(ASH_DK, 0.9))


def paint_mound(m):
    r = L.R_MOUND
    x0, y0, x1, y1 = r
    fill(m, r, dif=SOIL, ao=AO_BASE - 14, rough=R_ARMOR + 60, metal=6)
    for i in range(9):
        xa = x0 + (x1 - x0) * i / 9.0
        m.d.rectangle([xa, y0, xa + (x1 - x0) / 9.0, y1],
                      fill=shade(SOIL, 0.92 + 0.05 * (i % 3)))
    m.d.rectangle([x0, y0, x0 + (x1 - x0) * 0.22, y1], fill=SOIL_DK)
    m.d.rectangle([x1 - (x1 - x0) * 0.16, y0, x1, y1], fill=shade(ASH_DK, 0.94))
    fill(m, L.R_DIRT, dif=shade(SOIL, 1.06), ao=AO_BASE - 14,
         rough=R_ARMOR + 60, metal=6)


def paint_lens(m):
    r = L.R_LENS
    x0, y0, x1, y1 = r
    fill(m, r, dif=ALLOY_XDK, ao=AO_BASE - 8, rough=R_ARMOR, metal=M_ARMOR + 40)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    rr = min(x1 - x0, y1 - y0) * 0.44
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=shade(CYAN, 0.45))
    m.o.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=CYAN)
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=ALLOY_XDK, width=6)
    m.d.ellipse([cx - rr * 0.42, cy - rr * 0.42, cx + rr * 0.42, cy + rr * 0.42],
                fill=(220, 250, 255))
    m.e.ellipse([cx - rr * 0.42, cy - rr * 0.42, cx + rr * 0.42, cy + rr * 0.42],
                fill=(235, 252, 255))


# ── assemble ─────────────────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_ash(m)
    paint_rim_side(m)
    paint_legs(m)
    paint_cantilever(m)
    paint_core(m)
    paint_halo(m)
    paint_pylon(m)
    paint_mound(m)
    paint_lens(m)

    # geological weathering only: ash fallout, buried soil, dust drift.
    from weathering import Weather
    wx = Weather(seed=90210 % 997)
    wx.crevice_grime(m.dif, 0.22)
    wx.mud_band(L.R_MOUND, 0.85, fade=None)
    wx.mud_band(L.R_DIRT, 0.7, fade=None)
    wx.mud_band((L.R_LEG_IN[0], L.R_LEG_IN[1], L.R_LEG_IN[0] + 150, L.R_LEG_IN[3]),
                0.55, fade=None)
    wx.mud_band((L.R_LEG_OUT[0], L.R_LEG_OUT[1], L.R_LEG_OUT[0] + 150, L.R_LEG_OUT[3]),
                0.55, fade=None)
    wx.mud_band((L.R_PYLON[0], L.R_PYLON[1], L.R_PYLON[0] + 190, L.R_PYLON[3]),
                0.6, fade=None)
    wx.soot_patch(L.R_RIM_S, 0.35)
    # NOTE: PL.finish() applies wx — never apply it twice.

    from normals import HeightMap
    hm = HeightMap()
    for rect, n in ((L.R_LEG_IN, L.LEG_STATIONS - 1), (L.R_LEG_OUT, L.LEG_STATIONS - 1),
                    (L.R_LEG_SIDE, L.LEG_STATIONS - 1), (L.R_HALO, L.HALO_SEGS // 2),
                    (L.R_PYLON, 8)):
        x0, y0, x1, y1 = rect
        for i in range(1, n):
            x = x0 + (x1 - x0) * i / n
            hm.line((x, y0), (x, y1), -0.65, width=3)
    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
