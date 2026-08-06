"""paint_ms_anc_beacon — 2048^2 PBR set for ms_anc_beacon.

ANCIENT REGISTER: monolithic, precise, seamless. Large unbroken
basalt-alloy surfaces broken ONLY by clean recessed seams — no rivets, no
bolted patches, no scrap, no team colour. Emissive CYAN is the signature
and this beacon is ACTIVE: the tracery flows, brightening as it climbs
the mast, floods the petal array's inner emitter faces and the emitter
filaments, and burns hardest at the crown lens. Weathering is geological
— soil burial at the buried dais, wind-drift dust on horizontals, faint
scorch — never rust streaks from fittings.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_beacon_layout as L   # sets meshlib.ATLAS = 2048
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
# Pale basalt-alloy: ancient stone-metal, read at strategic zoom. The first
# pass was near-black and vanished into its own impostor.
ALLOY    = (104, 112, 124)   # seamless basalt alloy
ALLOY_LT = (132, 141, 154)
ALLOY_DK = (80, 87, 98)
SEAMC    = (46, 51, 59)
SOIL     = (104, 88, 68)
SOIL_DK  = (76, 63, 48)
DUST     = (150, 140, 122)
SCORCH   = (52, 48, 46)
CYAN     = (70, 240, 255)
CYAN_HOT = (208, 253, 255)
CYAN_MID = (96, 214, 232)
CYAN_DIM = (52, 162, 182)    # the groove tone still has to READ in diffuse

RNG = np.random.default_rng(90210)


def band(rect, f0, f1):
    """Sub-rect by vertical fraction of `rect`."""
    x0, y0, x1, y1 = rect
    h = y1 - y0
    return (x0, y0 + h * f0, x1, y0 + h * f1)


def flow(y):
    """Cyan intensity ramp — energy climbing the mast toward the crown."""
    return 0.40 + 0.55 * min(max(y / L.CROWN_Y, 0.0), 1.0)


def glow(m, pts, y, width=4, dim=CYAN_DIM):
    """A tracery line: dim groove in diffuse, live cyan in emissive."""
    m.d.line(pts, fill=dim, width=width)
    m.e.line(pts, fill=shade(CYAN, flow(y)), width=max(2, width - 1))


# ── dais ─────────────────────────────────────────────────────────────────

def paint_dais(m):
    z = L.R_DAIS_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE, rough=R_ARMOR + 10,
         metal=M_ARMOR + 30)
    u, v = PL.zone_fns(z)
    cx, cy = u(0.0), v(0.0)
    px = (u(1.0) - u(0.0))            # px per world metre

    def circle(r, **kw):
        m.d.ellipse([cx - r * px, cy - r * px, cx + r * px, cy + r * px], **kw)

    def ecircle(r, **kw):
        m.e.ellipse([cx - r * px, cy - r * px, cx + r * px, cy + r * px], **kw)

    # geological burial: soil creeping over the outermost tier, dust inboard
    circle(7.28, fill=SOIL_DK)
    circle(6.60, fill=SOIL)
    circle(5.90, fill=tuple((a + b) // 2 for a, b in zip(SOIL, ALLOY_DK)))
    circle(4.90, fill=ALLOY_DK)       # tier-2 top begins
    circle(3.00, fill=ALLOY)          # tier-3 top begins
    # recessed concentric seams (the ONLY segmentation — nothing bolted)
    for r in (4.75, 4.40, 2.88, 2.52):
        circle(r, outline=SEAMC, width=4)
    # six radial tracery grooves aligned with the six petals, running into a
    # perfect cyan circle around the mast foot
    for a in L.PETAL_ANGLES:
        p0 = (cx + 2.10 * px * np.cos(a), cy + 2.10 * px * np.sin(a))
        p1 = (cx + 5.70 * px * np.cos(a), cy + 5.70 * px * np.sin(a))
        glow(m, [p0, p1], 1.0, width=11)
    circle(2.00, outline=CYAN_DIM, width=12)
    ecircle(2.00, outline=shade(CYAN, flow(3.0)), width=8)
    circle(1.82, outline=SEAMC, width=3)
    # faint scorch halo where the beam has cooked the dais over aeons
    for a in RNG.uniform(0, 2 * np.pi, 22):
        r0, r1 = 3.2, RNG.uniform(4.0, 5.6)
        m.d.line([(cx + r0 * px * np.cos(a), cy + r0 * px * np.sin(a)),
                  (cx + r1 * px * np.cos(a), cy + r1 * px * np.sin(a))],
                 fill=SCORCH, width=int(RNG.uniform(3, 9)))

    # dais flank: alloy above, soil burial below, one recessed seam per tier
    r = L.R_DAIS_SX.rect
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 8, rough=R_ARMOR + 12,
         metal=M_ARMOR + 30)
    us, vs = PL.zone_fns(L.R_DAIS_SX)
    for yy in (2.20, 1.10):
        m.d.line([(r[0], vs(yy)), (r[2], vs(yy))], fill=SEAMC, width=4)
    m.d.rectangle([r[0], vs(0.62), r[2], r[3]], fill=SOIL)
    m.d.rectangle([r[0], vs(0.26), r[2], r[3]], fill=SOIL_DK)
    glow(m, [(r[0], vs(1.55)), (r[2], vs(1.55))], 1.5, width=5)
    fill(m, L.R_SOIL, dif=SOIL_DK, ao=AO_DEEP, rough=R_ARMOR + 30,
         metal=M_ARMOR)


# ── mast ─────────────────────────────────────────────────────────────────

def paint_mast(m):
    for z in (L.R_MAST_X, L.R_MAST_Z):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 2, rough=R_ARMOR,
             metal=M_ARMOR + 40)
        u, v = PL.zone_fns(z)
        # clean recessed seams at every segment joint — low contrast on these
        # very large quads (impostor baker floods bold stripes)
        for (_, _, sy0, sy1, _w) in L.SEGS + [(0, 0, L.MAST_TOP, L.CORBEL_TOP, 0)]:
            va, vb = v(sy1), v(sy0)
            m.d.rectangle([x0, va - 5, x1, va + 5], fill=SEAMC)
            m.d.rectangle([x0, va + 6, x1, va + 26], fill=shade(ALLOY, 1.10))
            m.d.rectangle([x0, vb - 22, x1, vb - 7], fill=shade(ALLOY, 0.90))
        # twin cyan tracery filaments climbing the whole mast, placed clear of
        # the flank quads' UV centroids
        for wx in (-0.90, 0.90):
            lx = u(wx)
            for (_, _, sy0, sy1, _w) in L.SEGS:
                m.d.line([(lx, v(sy1) + 8), (lx, v(sy0) - 8)], fill=CYAN_DIM,
                         width=5)
                m.e.line([(lx, v(sy1) + 8), (lx, v(sy0) - 8)],
                         fill=shade(CYAN, flow((sy0 + sy1) / 2)), width=3)
        # cross-links: the filaments knit at each seam
        for (_, _, _s0, sy1, _w) in L.SEGS[:-1]:
            yy = v(sy1) + 16
            glow(m, [(u(-0.90), yy), (u(0.90), yy)], sy1, width=5)
        # corbel band reads brightest — it feeds the array
        glow(m, [(u(-1.5), v(18.15)), (u(1.5), v(18.15))], 18.15, width=8)
        # geological dust drift licking the lowest 1.5 m of the mast
        m.d.rectangle([x0, v(4.2), x1, v(3.0)], fill=shade(ALLOY_DK, 0.92))

    # segment shoulders + corbel top
    x0, y0, x1, y1 = L.R_SHELF.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY_LT, ao=AO_BASE - 4, rough=R_ARMOR + 4,
         metal=M_ARMOR + 40)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for rr, col in ((0.44, SEAMC), (0.30, CYAN_DIM)):
        r = (x1 - x0) * rr
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=5)
    r = (x1 - x0) * 0.30
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r],
                fill=None, outline=shade(CYAN, 0.55), width=3)
    m.d.rectangle([x0, y0, x1, y0 + 10], fill=DUST)   # wind-drift dust edge


# ── cantilevers, buttresses, floating keystones ──────────────────────────

def paint_prismatic(m):
    def plate(rect, dif, cyan_at=None, hot=0.6):
        fill(m, rect, dif=dif, ao=AO_BASE - 2, rough=R_ARMOR, metal=M_ARMOR + 40)
        x0, y0, x1, y1 = rect
        m.d.line([(x0, (y0 + y1) * 0.52), (x1, (y0 + y1) * 0.52)],
                 fill=SEAMC, width=3)
        if cyan_at is not None:
            for f in cyan_at:
                yy = y0 + (y1 - y0) * f
                m.d.line([(x0, yy), (x1, yy)], fill=CYAN_DIM, width=6)
                m.e.line([(x0, yy), (x1, yy)], fill=shade(CYAN, hot), width=4)

    plate(L.R_VANE, ALLOY, cyan_at=(0.16, 0.36), hot=0.62)
    plate(L.R_BUTT, ALLOY_DK, cyan_at=(0.30,), hot=0.38)
    # the floating keystones are the loudest thing below the crown
    plate(L.R_KEY, ALLOY_LT, cyan_at=(0.12, 0.26, 0.40), hot=0.85)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)


# ── array: hub, column, crown lens ───────────────────────────────────────

def paint_array(m):
    # hub sides: u along the 2 ring spans, v around 12 facets
    x0, y0, x1, y1 = L.R_HUB
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 4, rough=R_ARMOR - 6,
         metal=M_ARMOR + 60)
    m.d.rectangle([x0, y0, x1, y0 + (y1 - y0) * 0.5], fill=ALLOY)
    for f in (0.30, 0.72):
        yy = y0 + (y1 - y0) * f
        m.d.line([(x0, yy), (x1, yy)], fill=SEAMC, width=4)
    mid = (x0 + x1) / 2
    m.d.rectangle([mid - 26, y0, mid + 26, y1], fill=CYAN_DIM)
    m.e.rectangle([mid - 20, y0, mid + 20, y1], fill=shade(CYAN, 0.80))

    # hub caps: perfect concentric circles, cyan aperture
    x0, y0, x1, y1 = L.R_HUBCAP.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR + 50)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for rr, col, wd in ((0.44, SEAMC, 5), (0.34, SEAMC, 4), (0.22, CYAN_DIM, 10)):
        r = (x1 - x0) * rr
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=wd)
    r = (x1 - x0) * 0.22
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade(CYAN, 0.9),
                width=7)

    # axis column: alloy with four running cyan filaments
    x0, y0, x1, y1 = L.R_COLUMN
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 4, rough=R_ARMOR - 8,
         metal=M_ARMOR + 60)
    for f in (0.18, 0.43, 0.68, 0.93):
        yy = y0 + (y1 - y0) * f
        m.d.line([(x0, yy), (x1, yy)], fill=CYAN_DIM, width=7)
        m.e.line([(x0, yy), (x1, yy)], fill=shade(CYAN, 0.92), width=5)

    # crown lens: the beacon proper — intense, near-white core
    x0, y0, x1, y1 = L.R_LENS
    fill(m, (x0, y0, x1, y1), dif=shade(CYAN, 0.55), ao=AO_BASE,
         rough=R_GLASS, metal=M_GLASS)
    m.d.rectangle([x0 + (x1 - x0) * 0.20, y0, x0 + (x1 - x0) * 0.72, y1],
                  fill=CYAN_HOT)
    m.e.rectangle([x0, y0, x1, y1], fill=shade(CYAN, 0.86))
    m.e.rectangle([x0 + (x1 - x0) * 0.18, y0, x0 + (x1 - x0) * 0.75, y1],
                  fill=CYAN_HOT)


# ── petals ───────────────────────────────────────────────────────────────

def paint_petals(m):
    x0, y0, x1, y1 = L.R_PETAL
    n = L.PETAL_SECT
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR + 40)
    row = (y1 - y0) / n

    def rows(a, b):
        return (x0, y0 + row * a, x1, y0 + row * b)

    # facet rows 0..3 face OUTWARD (alloy back of the blade), 4..7 INWARD
    fill(m, rows(0, 4), dif=ALLOY, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR + 40)
    fill(m, rows(1, 3), dif=ALLOY_LT, ao=AO_BASE - 4, rough=R_ARMOR - 4,
         metal=M_ARMOR + 50)
    # tone-on-tone lengthwise segmentation on the outer back (low contrast)
    for k in range(1, 5):
        lx = x0 + (x1 - x0) * k / 5.0
        m.d.line([(lx, y0), (lx, y0 + row * 4)], fill=SEAMC, width=4)
        m.d.line([(lx + 5, y0), (lx + 5, y0 + row * 4)],
                 fill=shade(ALLOY, 1.10), width=6)
    # inner emitter faces: live cyan tracery, brightest at the root
    fill(m, rows(4, 8), dif=ALLOY_DK, ao=AO_BASE - 6, rough=R_ARMOR - 6,
         metal=M_ARMOR + 60)
    fill(m, rows(5, 7), dif=CYAN_DIM, ao=AO_BASE, rough=R_GLASS + 20,
         metal=M_GLASS)
    m.e.rectangle(rows(5, 7), fill=shade(CYAN, 0.55))
    for k in range(0, 22):
        lx = x0 + (x1 - x0) * (0.02 + 0.955 * k / 21.0)
        t = 1.0 - k / 21.0                    # fades toward the blade tip
        m.d.line([(lx, y0 + row * 5), (lx, y0 + row * 7)], fill=CYAN_MID,
                 width=5)
        m.e.line([(lx, y0 + row * 5), (lx, y0 + row * 7)],
                 fill=shade(CYAN_HOT, 0.35 + 0.6 * t), width=4)
    for f in (4.35, 7.65):
        yy = y0 + row * f
        m.d.line([(x0, yy), (x1, yy)], fill=CYAN_DIM, width=5)
        m.e.line([(x0, yy), (x1, yy)], fill=shade(CYAN, 0.7), width=3)
    # blade end caps
    fill(m, L.R_PETAL_CAP, dif=ALLOY_DK, ao=AO_SEAM, rough=R_ARMOR,
         metal=M_ARMOR + 40)
    cx0, cy0, cx1, cy1 = L.R_PETAL_CAP
    m.d.rectangle([cx0 + 22, cy0 + 22, cx1 - 22, cy1 - 22], fill=CYAN_DIM)
    m.e.rectangle([cx0 + 30, cy0 + 30, cx1 - 30, cy1 - 30],
                  fill=shade(CYAN, 0.75))

    # emitter filaments — glowing rods standing off each blade's inner face
    x0, y0, x1, y1 = L.R_FIL
    fill(m, (x0, y0, x1, y1), dif=shade(CYAN, 0.45), ao=AO_BASE,
         rough=R_GLASS, metal=M_GLASS)
    m.e.rectangle([x0, y0, x1, y1], fill=shade(CYAN, 0.80))
    m.d.rectangle([x0, y0 + (y1 - y0) * 0.36, x1, y0 + (y1 - y0) * 0.64],
                  fill=CYAN_HOT)
    m.e.rectangle([x0, y0 + (y1 - y0) * 0.36, x1, y0 + (y1 - y0) * 0.64],
                  fill=CYAN_HOT)


# ── assemble ─────────────────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_dais(m)
    paint_mast(m)
    paint_prismatic(m)
    paint_array(m)
    paint_petals(m)

    # ancient tech does not rust or patch: grime, buried soil, wind dust only
    from weathering import Weather
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.22)
    wx.mud_band(L.R_DAIS_SX.rect, 0.62, fade='down', dust=0.35)
    wx.mud_band(band(L.R_DAIS_TOP.rect, 0.86, 1.0), 0.30, fade=None)
    wx.mud_band(band(L.R_MAST_X.rect, 0.94, 1.0), 0.28, fade='down', dust=0.3)
    wx.mud_band(band(L.R_MAST_Z.rect, 0.94, 1.0), 0.28, fade='down', dust=0.3)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    # recessed seams are the only relief on the whole model
    for z in (L.R_MAST_X, L.R_MAST_Z):
        x0, y0, x1, y1 = z.rect
        _, v = PL.zone_fns(z)
        for (_, _, _s0, sy1, _w) in L.SEGS:
            hm.line((x0, v(sy1)), (x1, v(sy1)), -0.75, width=5)
    hm.crevices_from(m.dif, 0.35)
    hm.weather_from(wx)

    PL.finish(m, L, 'ms_anc_beacon', hm=hm, wx=None, emissive_blur=0.8)


if __name__ == '__main__':
    paint_all()
