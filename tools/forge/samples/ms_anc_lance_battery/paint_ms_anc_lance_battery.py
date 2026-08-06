"""paint_ms_anc_lance_battery — 2048^2 PBR set, ANCIENT register.

Pale monolith alloy-stone, cut only by clean recessed seams; nothing bolted,
nothing patched, no rust anywhere. Emissive CYAN is the only light on the
model and it is ACTIVE: dim tracery in the drum's recesses, a flowing bore in
the floating yoke ring, six acceleration rings brightening down the lance, and
a hot core at the emitter. Weathering is geological — soil burial at the foot,
dust drift up the wall and across the crown shelf, scorch at the muzzle.

Team colour appears ONLY as the capture chevron in the team mask (four
cardinal plaques on the base drum).
"""
from __future__ import annotations
import numpy as np

import ms_anc_lance_battery_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, shade, jit, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP)

W = 2048

# ── ancient palette ──────────────────────────────────────────────────────
ANC = (170, 174, 168)        # monolith alloy-stone
ANC_LT = (203, 206, 200)
ANC_DK = (118, 123, 122)
ANC_DEEP = (58, 64, 67)      # inside a recessed seam
ALLOY = (94, 100, 104)       # lance shaft
ALLOY_LT = (146, 152, 155)
CY = (86, 226, 255)
CY_HOT = (206, 250, 255)
CY_DIM = (26, 84, 104)       # diffuse tint under a cyan groove
SCORCH = (48, 45, 44)

# ORM registers: ancient alloy is smooth and half-metallic
AO_A, RO_A, ME_A = AO_BASE, 104, 96          # monolith
AO_L, RO_L, ME_L = AO_BASE - 6, 86, 168      # lance alloy
AO_G, RO_G, ME_G = AO_BASE, 56, 0            # glowing cyan cell


def cyan(f):
    return tuple(int(c * f) for c in CY)


def hot(f):
    return tuple(int(c * f) for c in CY_HOT)


def glow_rect(m, box, f=1.0, dif=CY_DIM):
    """A recessed cyan channel: dark diffuse, cyan in the emissive map."""
    b = PL.nbox(*box)
    m.d.rectangle(b, fill=dif)
    m.o.rectangle(b, fill=(AO_G, RO_G, ME_G))
    m.e.rectangle(b, fill=cyan(f))


def recess(m, box, base=ANC):
    """A clean recessed seam — the ancients' only surface break."""
    b = PL.nbox(*box)
    m.d.rectangle(b, fill=shade(base, 0.42))
    m.o.rectangle(b, fill=(AO_SEAM, RO_A + 18, ME_A))


# ── base drum ───────────────────────────────────────────────────────────

def paint_skirt(m):
    r = L.R_SKIRT
    fill(m, r, dif=ANC_DK, ao=AO_A - 22, rough=RO_A + 40, metal=ME_A - 40)
    # the wall carries on down into the soil — same seams, no plinth course
    for j in (1, 4, 7, 10, 13, 16, 19, 22):
        u = L.wrap_u(r, L.N_DRUM, j)
        recess(m, (u - 5, r[1], u + 5, r[3]), ANC_DK)


def paint_drum(m):
    r = L.R_DRUM
    x0, y0, x1, y1 = r

    def vy(y):
        return L.wrap_v(r, y, L.DRUM_Y_TOP, L.DRUM_Y_BOT)

    fill(m, r, dif=ANC, ao=AO_A, rough=RO_A, metal=ME_A)
    # three broad registers, tone-on-tone (impostor-safe, +-6%)
    m.d.rectangle([x0, vy(4.60), x1, vy(2.60)], fill=shade(ANC, 1.05))
    m.d.rectangle([x0, vy(2.60), x1, vy(L.DRUM_Y_BOT)], fill=shade(ANC, 0.94))
    # crown tracery ring — its own quad row, so it floods as a clean ring
    m.d.rectangle([x0, vy(L.CROWN_Y0), x1, vy(L.CROWN_Y1)], fill=CY_DIM)
    m.o.rectangle([x0, vy(L.CROWN_Y0), x1, vy(L.CROWN_Y1)],
                  fill=(AO_G, RO_G, ME_G))
    m.e.rectangle([x0, vy(L.CROWN_Y0), x1, vy(L.CROWN_Y1)], fill=cyan(0.72))
    # base course where the monolith enters the soil (its own row too)
    m.d.rectangle([x0, vy(1.45), x1, vy(L.DRUM_Y_BOT)], fill=ANC_DK)
    # eight full-height recessed seams; every other one runs cyan tracery
    for k, j in enumerate((1, 4, 7, 10, 13, 16, 19, 22)):
        u = L.wrap_u(r, L.N_DRUM, j)
        recess(m, (u - 7, vy(5.60), u + 7, y1))
        if k % 2 == 0:
            glow_rect(m, (u - 2, vy(5.30), u + 2, vy(1.55)), 0.42)
    # horizontal course seams, straddling geometry ring boundaries
    for y in (4.60, 2.60):
        recess(m, (x0, vy(y) - 4, x1, vy(y) + 4))
    PL.wear_edges(m, (x0, y0, x1, y1), ANC, density=40)


def paint_shelf(m):
    """Crown shelf: three concentric rows, the middle one a live cyan channel."""
    r = L.R_SHELF
    x0, y0, x1, y1 = r
    h = (y1 - y0) / 3.0
    fill(m, (x0, y0, x1, y0 + h), dif=shade(ANC, 0.90), ao=AO_A - 12,
         rough=RO_A + 20, metal=ME_A)
    glow_rect(m, (x0, y0 + h, x1, y0 + 2 * h), 0.60)
    fill(m, (x0, y0 + 2 * h, x1, y1), dif=ANC_DK, ao=AO_A - 20,
         rough=RO_A + 24, metal=ME_A)


def paint_plinth(m):
    r = L.R_PLINTH
    x0, y0, x1, y1 = r

    def vy(y):
        return L.wrap_v(r, y, L.PLINTH_Y_TOP, L.PLINTH_Y_BOT)

    fill(m, r, dif=ANC_LT, ao=AO_A, rough=RO_A - 14, metal=ME_A + 20)
    recess(m, (x0, vy(7.52) - 4, x1, vy(7.52) + 4), ANC_LT)
    glow_rect(m, (x0, vy(7.86), x1, vy(7.70)), 0.62)
    for j in (1, 4, 7, 10, 13, 16, 19, 22):
        u = L.wrap_u(r, L.N_DRUM, j)
        recess(m, (u - 6, y0, u + 6, y1), ANC_LT)


def paint_dais(m):
    """The levitation dais, seen through the floating ring's bore: four
    concentric rows — pale stone, live channel, dark well, live channel —
    around a hot core cap."""
    r = L.R_DAIS
    x0, y0, x1, y1 = r
    h = (y1 - y0) / 4.0
    fill(m, (x0, y0, x1, y0 + h), dif=ANC_LT, ao=AO_A, rough=RO_A - 14,
         metal=ME_A + 20)
    glow_rect(m, (x0, y0 + h, x1, y0 + 2 * h), 0.62)
    fill(m, (x0, y0 + 2 * h, x1, y0 + 3 * h), dif=ANC_DEEP, ao=AO_DEEP,
         rough=RO_A + 20, metal=ME_A)
    glow_rect(m, (x0, y0 + 3 * h, x1, y1), 0.90)

    z = L.Z_DAIS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DEEP, ao=AO_G, rough=RO_G, metal=ME_G)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for rr, f in ((52, 0.45), (30, 0.85)):
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=CY_DIM)
        m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=cyan(f))
    m.e.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=hot(1.0))


def paint_plaque(m):
    """CAPTURABLE mark: an ancient recessed tablet whose chevron is the only
    team-mask element on the model."""
    z = L.Z_PLAQ_Z
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_DEEP, ao=AO_A - 26, rough=RO_A + 16,
         metal=ME_A)
    # tablet body + raised frame (world 1.5 x 2.4 centred on the zone window)
    b = PL.nbox(u(-0.75), v(4.50), u(0.75), v(2.10))
    m.d.rectangle(b, fill=ANC_LT)
    m.o.rectangle(b, fill=(AO_A, RO_A - 10, ME_A + 20))
    inn = [b[0] + 20, b[1] + 20, b[2] - 20, b[3] - 20]
    m.d.rectangle(inn, fill=ANC_DEEP)
    m.o.rectangle(inn, fill=(AO_SEAM, RO_A + 20, ME_A))

    # the chevron itself — the ONLY team-mask element on the model. Sized to
    # dominate the tablet so it survives both distance and impostor flooding.
    cx = (inn[0] + inn[2]) / 2
    iw, ih = inn[2] - inn[0], inn[3] - inn[1]
    wdt = iw * 0.45
    thick = ih * 0.30
    top = inn[1] + ih * 0.10
    pts = [(cx, top), (cx + wdt, top + thick * 0.92),
           (cx + wdt, top + thick * 1.86), (cx, top + thick * 0.94),
           (cx - wdt, top + thick * 1.86), (cx - wdt, top + thick * 0.92)]
    m.d.polygon(pts, fill=TEAMGREY)
    m.t.polygon(pts, fill=(255, 0, 0))
    bar = [cx - wdt, inn[3] - ih * 0.26, cx + wdt, inn[3] - ih * 0.14]
    m.d.rectangle(bar, fill=TEAMGREY)
    m.t.rectangle(bar, fill=(255, 0, 0))
    # a live cyan sill under the chevron — the tablet is still powered
    glow_rect(m, (inn[0] + 24, inn[3] - 34, inn[2] - 24, inn[3] - 18), 0.72)
    PL.wear_edges(m, tuple(b), ANC_LT, density=26)


# ── floating yoke ring ──────────────────────────────────────────────────

def paint_ring(m):
    ro = L.R_RING_O
    x0, y0, x1, y1 = ro
    fill(m, ro, dif=ANC_LT, ao=AO_A, rough=RO_A - 20, metal=ME_A + 30)
    mid = (y0 + y1) / 2
    recess(m, (x0, mid - 14, x1, mid + 14), ANC_LT)
    glow_rect(m, (x0, mid - 6, x1, mid + 6), 0.70)
    for j in range(L.N_RING):
        u = L.wrap_u(ro, L.N_RING, j)
        m.d.line([(u, y0 + 6), (u, y1 - 6)], fill=shade(ANC_LT, 0.55), width=3)

    ri = L.R_RING_I                       # the bore: the field lives in here
    x0, y0, x1, y1 = ri
    fill(m, ri, dif=CY_DIM, ao=AO_G, rough=RO_G, metal=ME_G)
    n = 10
    for i in range(n):
        f = 0.32 + 0.68 * (1 - abs(i - (n - 1) / 2) / ((n - 1) / 2)) ** 1.4
        m.e.rectangle([x0, y0 + (y1 - y0) * i / n,
                       x1, y0 + (y1 - y0) * (i + 1) / n], fill=cyan(f))

    rt = L.R_RING_T                       # crown annulus, v: outer -> inner
    x0, y0, x1, y1 = rt
    fill(m, rt, dif=ANC_LT, ao=AO_A, rough=RO_A - 20, metal=ME_A + 30)
    recess(m, (x0, y0 + (y1 - y0) * 0.52, x1, y0 + (y1 - y0) * 0.64), ANC_LT)
    glow_rect(m, (x0, y0 + (y1 - y0) * 0.80, x1, y1), 0.60)
    for j in range(L.N_RING):
        u = L.wrap_u(rt, L.N_RING, j)
        m.d.line([(u, y0), (u, y0 + (y1 - y0) * 0.5)],
                 fill=shade(ANC_LT, 0.55), width=3)

    rb = L.R_RING_B                       # underside: the levitation face
    x0, y0, x1, y1 = rb
    fill(m, rb, dif=ANC_DK, ao=AO_A - 30, rough=RO_A, metal=ME_A)
    glow_rect(m, (x0, y0 + (y1 - y0) * 0.22, x1, y0 + (y1 - y0) * 0.86), 0.82)


def paint_arms(m):
    """Four faces per blade (u = around, v = foot -> trunnion): a recessed
    spine down every face, live at the top where it feeds the lance."""
    r = L.R_ARM
    x0, y0, x1, y1 = r
    fill(m, r, dif=ANC, ao=AO_A, rough=RO_A, metal=ME_A)
    for j in range(4):
        ua = L.wrap_u(r, 4, j)
        ub = L.wrap_u(r, 4, j + 1)
        c = (ua + ub) / 2
        m.d.line([(ua, y0), (ua, y1)], fill=shade(ANC, 0.5), width=4)
        recess(m, (c - 11, y0 + 8, c + 11, y1 - 8))
        glow_rect(m, (c - 4, y0 + 16, c + 4, y1 - 16), 0.50)
    PL.wear_edges(m, (x0, y0, x1, y1), ANC, density=24)

    t = L.R_TRUN
    x0, y0, x1, y1 = t
    fill(m, t, dif=ANC_DK, ao=AO_A - 10, rough=RO_A - 10, metal=ME_A + 40)
    mid = (y0 + y1) / 2
    recess(m, (x0, mid - 13, x1, mid + 13), ANC_DK)
    glow_rect(m, (x0, mid - 5, x1, mid + 5), 0.68)


# ── the lance ───────────────────────────────────────────────────────────

def paint_lance(m):
    r = L.R_LANCE
    x0, y0, x1, y1 = r
    fill(m, r, dif=ALLOY, ao=AO_L, rough=RO_L, metal=ME_L)
    # breech block
    m.d.rectangle([L.lance_u(L.L_ZMAX), y0, L.lance_u(2.24), y1], fill=ANC_DK)
    m.o.rectangle([L.lance_u(L.L_ZMAX), y0, L.lance_u(2.24), y1],
                  fill=(AO_A - 10, RO_A, ME_A + 30))
    glow_rect(m, (L.lance_u(2.92), y0, L.lance_u(2.80), y1), 0.55)
    glow_rect(m, (L.lance_u(2.46), y0, L.lance_u(2.36), y1), 0.55)
    # longitudinal facet seams down the shaft (v = around)
    for j in range(L.N_TUBE):
        vy = y0 + (y1 - y0) * j / L.N_TUBE
        m.d.line([(L.lance_u(2.16), vy), (x1, vy)], fill=shade(ALLOY, 0.62),
                 width=3)
    # six acceleration rings, the charge brightening toward the emitter
    n = len(L.ACC_Z)
    for i, c in enumerate(L.ACC_Z):
        f = i / (n - 1)
        ua = L.lance_u(c + L.ACC_SHOULDER)
        ub = L.lance_u(c - L.ACC_SHOULDER)
        m.d.rectangle([ua, y0, ub, y1], fill=ANC_LT)
        m.o.rectangle([ua, y0, ub, y1], fill=(AO_A, RO_A - 20, ME_A + 30))
        ha, hb = L.lance_u(c + L.ACC_HALF), L.lance_u(c - L.ACC_HALF)
        glow_rect(m, (ha, y0, hb, y1), 0.45 + 0.55 * f)
    # emitter throat: the last squeeze before the cage
    m.d.rectangle([L.lance_u(-7.80), y0, L.lance_u(-8.50), y1], fill=ALLOY_LT)
    m.o.rectangle([L.lance_u(-7.80), y0, L.lance_u(-8.50), y1],
                  fill=(AO_A, RO_A - 20, ME_A + 30))
    glow_rect(m, (L.lance_u(-7.95), y0, L.lance_u(-8.35), y1), 1.0)
    # scorched nozzle section
    m.d.rectangle([L.lance_u(-8.70), y0, x1, y1], fill=shade(ALLOY, 0.72))


def paint_collars(m):
    co = L.R_COL_O
    x0, y0, x1, y1 = co
    fill(m, co, dif=ANC_LT, ao=AO_A, rough=RO_A - 20, metal=ME_A + 30)
    mid = (y0 + y1) / 2
    recess(m, (x0, mid - 12, x1, mid + 12), ANC_LT)
    glow_rect(m, (x0, mid - 5, x1, mid + 5), 0.75)
    for j in range(L.N_COLLAR):
        u = L.wrap_u(co, L.N_COLLAR, j)
        m.d.line([(u, y0 + 4), (u, y1 - 4)], fill=shade(ANC_LT, 0.55), width=3)

    ci = L.R_COL_I                    # the bore faces the shaft and burns
    x0, y0, x1, y1 = ci
    fill(m, ci, dif=CY_DIM, ao=AO_G, rough=RO_G, metal=ME_G)
    m.e.rectangle([x0, y0, x1, y1], fill=cyan(0.95))

    for rr in (L.R_COL_F, L.R_COL_B):     # annuli, v: outer -> inner
        x0, y0, x1, y1 = rr
        fill(m, rr, dif=ANC_LT, ao=AO_A - 8, rough=RO_A - 16, metal=ME_A + 30)
        glow_rect(m, (x0, y0 + (y1 - y0) * 0.74, x1, y1), 0.85)


def paint_prongs(m):
    """limb UV: u runs base -> tip, v around the four faces."""
    r = L.R_PRONG
    x0, y0, x1, y1 = r
    fill(m, r, dif=ANC_DK, ao=AO_A - 12, rough=RO_A, metal=ME_A + 40)
    m.d.rectangle([x0 + (x1 - x0) * 0.60, y0, x1, y1], fill=shade(ANC_DK, 0.72))
    glow_rect(m, (x0 + (x1 - x0) * 0.70, y0 + 6,
                  x0 + (x1 - x0) * 0.80, y1 - 6), 0.85)
    glow_rect(m, (x0 + (x1 - x0) * 0.92, y0 + 4, x1 - 4, y1 - 4), 1.0)


def paint_caps(m):
    # breech face: a dead-flat recessed disc, nothing lit
    z = L.Z_BREECH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_A - 20, rough=RO_A + 10,
         metal=ME_A + 30)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for rr, col in ((52, shade(ANC_DK, 0.7)), (30, ANC_DEEP)):
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=col)

    z = L.Z_TIP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CY_DIM, ao=AO_G, rough=RO_G, metal=ME_G)
    m.e.rectangle([x0, y0, x1, y1], fill=cyan(0.85))

    # emitter core — the hottest cell on the model
    z = L.Z_CORE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DEEP, ao=AO_G, rough=RO_G, metal=ME_G)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for rr, f, col in ((58, 0.55, CY_DIM), (40, 0.85, cyan(0.35)),
                       (22, 1.0, cyan(0.7))):
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=col)
        m.e.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=cyan(f))
    m.e.ellipse([cx - 12, cy - 12, cx + 12, cy + 12], fill=hot(1.0))

    fill(m, L.Z_TRIM.rect, dif=ANC_DEEP, ao=AO_SEAM, rough=RO_A + 20,
         metal=ME_A)
    fill(m, L.Z_DARK.rect, dif=(20, 22, 24), ao=AO_DEEP, rough=RO_A + 40,
         metal=0)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    P.BOLT_LOG.clear()          # ancient tech has no bolts — keep it empty
    m = Maps()
    paint_skirt(m)
    paint_drum(m)
    paint_shelf(m)
    paint_plinth(m)
    paint_dais(m)
    paint_plaque(m)
    paint_ring(m)
    paint_arms(m)
    paint_lance(m)
    paint_collars(m)
    paint_prongs(m)
    paint_caps(m)

    from weathering import Weather
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.36)
    # geological, not mechanical: burial, drift, scorch
    wx.mud_band(L.R_SKIRT, 0.92, fade='down', spatter=True)
    wx.mud_band(L.R_DRUM, 0.34, fade='down', dust=0.34)
    wx.mud_band(L.R_SHELF, 0.44, fade=None, spatter=True)
    wx.mud_band(L.R_PLINTH, 0.11, fade='down', dust=0.30)
    wx.mud_band(L.R_DAIS, 0.18, fade=None, spatter=False)
    wx.mud_band(L.Z_PLAQ_Z.rect, 0.15, fade='down', dust=0.18)
    wx.mud_band(L.R_RING_O, 0.05, fade='down', dust=0.20)
    wx.mud_band(L.R_RING_T, 0.16, fade=None, spatter=False)
    wx.mud_band(L.R_ARM, 0.06, fade='right', dust=0.16)
    wx.mud_band(L.R_LANCE, 0.07, fade=None, dust=0.20)
    # scorch: only the nozzle third of the lance, and the emitter cage
    lx0 = int(L.lance_u(-6.0))
    wx.soot_patch((lx0, L.R_LANCE[1], L.R_LANCE[2], L.R_LANCE[3]), 0.50,
                  fade='right')
    wx.soot_patch(L.R_PRONG, 0.34, fade='right')

    from normals import HeightMap
    hm = HeightMap()
    # recessed seams are the only relief on an ancient surface
    dr = L.R_DRUM
    for j in (1, 4, 7, 10, 13, 16, 19, 22):
        u = L.wrap_u(dr, L.N_DRUM, j)
        hm.line((u, L.wrap_v(dr, 5.60, L.DRUM_Y_TOP, L.DRUM_Y_BOT)),
                (u, dr[3]), -0.85, width=13)
        pu = L.wrap_u(L.R_PLINTH, L.N_DRUM, j)
        hm.line((pu, L.R_PLINTH[1]), (pu, L.R_PLINTH[3]), -0.7, width=11)
    for y in (4.60, 2.60):
        vy = L.wrap_v(dr, y, L.DRUM_Y_TOP, L.DRUM_Y_BOT)
        hm.line((dr[0], vy), (dr[2], vy), -0.8, width=8)
    b = L.Z_PLAQ_Z.rect
    hm.rect((b[0] + 30, b[1] + 60, b[2] - 30, b[3] - 60), 0.55)
    hm.crevices_from(m.dif, 0.5)
    hm.weather_from(wx)

    PL.finish(m, L, 'ms_anc_lance_battery', hm=hm, wx=wx, emissive_blur=0.8)


if __name__ == '__main__':
    paint_all()
