"""paint_ms_anc_obelisk_field — 2048² PBR set for the resonant obelisk kit.

ANCIENT register: one seamless grey-green alloy-stone, segmented by clean
recessed seams and collars — no rivets, no bolts, no patch plates anywhere
(BOLT_LOG stays empty on purpose, so no bolt-rust ever fires).  Weathering
is geological: dust drift high on the shafts, soil burial and scorch at the
foot, never a rust streak.

Emissive is CYAN and only cyan — the resonance channel cut into each shaft's
-Z face, its crown lens, and a few embers in obelisk_c's fracture.  The
channel spirals with the shaft twist, so the paint follows the SAME
`groove_center_x` the generator used.  Intensity tells the story:
obelisk_a ACTIVE (flowing, node-pulsed), obelisk_b DORMANT (embers with one
dead fault), obelisk_c all but extinguished.

Never team-owned: the team mask is written black and unreferenced.
"""
from __future__ import annotations
import numpy as np

import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

import paintlib as PL
import ms_anc_obelisk_field_layout as L
from paint import (Maps, fill, shade, jit, CYAN, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP)

RNG = np.random.default_rng(90210)
W = 2048
STEM = 'ms_anc_obelisk_field'

STONE    = (121, 127, 130)     # ancient alloy-stone, cool grey-green
STONE_LT = (140, 145, 148)
STONE_DK = (92, 97, 103)
DUSTY    = (150, 145, 132)     # wind-bleached upper surfaces
CHANNEL  = (15, 29, 34)        # deep recess interior
CYAN_DIF = (88, 190, 210)      # lit-rim diffuse under the emissive core
EARTH    = (95, 78, 57)
EARTH_LT = (117, 99, 72)
FRACT    = (152, 154, 155)     # raw fractured interior
SCORCH   = (42, 40, 42)


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


def zrect(zone, y_lo, y_hi):
    """Full-width band of a vertical zone between two world heights."""
    _, v = PL.zone_fns(zone)
    x0, y0, x1, y1 = zone.rect
    a, b = sorted((v(y_lo), v(y_hi)))
    return [x0, max(y0, a), x1, min(y1, b)]


# ── shaft faces ─────────────────────────────────────────────────────────

def paint_shaft_zone(m, zone, ytop, ybot, collars, tracery, seed):
    """Base stone treatment shared by the FACE / SIDE / BACK zones of one
    obelisk.  Everything is tone-on-tone (±15%) — the impostor baker
    flat-shades large quads, so bold thin stripes are forbidden here."""
    rng = np.random.default_rng(seed)
    x0, y0, x1, y1 = zone.rect
    _, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=STONE, ao=AO_BASE, rough=132, metal=32)

    # slow vertical tonal grain — the monolith is one poured surface
    n = 7
    for i in range(n):
        bx0 = x0 + (x1 - x0) * i / n
        bx1 = x0 + (x1 - x0) * (i + 1) / n
        m.d.rectangle([bx0, y0, bx1, y1],
                      fill=jit(shade(STONE, rng.uniform(0.94, 1.06)), 3))

    # dust-bleached crown / soil-stained foot (both very low contrast)
    hi = zrect(zone, ytop - 1.6, ytop + 0.3)
    m.d.rectangle(hi, fill=jit(mix(STONE, DUSTY, 0.35), 3))
    lo = zrect(zone, ybot - 0.9, ybot + 1.1)
    m.d.rectangle(lo, fill=jit(mix(STONE, EARTH, 0.30), 3))
    m.o.rectangle(lo, fill=(AO_BASE - 14, 196, 12))

    # precise recessed tracery seams — thin, dark, low contrast
    for ty in tracery:
        py = v(ty)
        if not (y0 + 2 < py < y1 - 3):
            continue
        m.d.line([(x0, py), (x1, py)], fill=shade(STONE, 0.86), width=3)
        m.d.line([(x0, py + 3), (x1, py + 3)], fill=shade(STONE, 1.05),
                 width=1)
        m.o.rectangle([x0, py - 1, x1, py + 2],
                      fill=(AO_SEAM, 168, 26))

    # recessed collar bands (real geometry — paint just shades the recess)
    for (cy0, cy1) in collars:
        b = zrect(zone, cy0 - 0.02, cy1 + 0.02)
        m.d.rectangle(b, fill=shade(STONE, 0.88))
        m.o.rectangle(b, fill=(AO_SEAM - 6, 176, 26))
        m.d.rectangle(b, outline=shade(STONE, 0.72), width=2)


def paint_seam(m, zone, profile, twist_spec, y0, y1, intensity, steps=160):
    """The resonance channel: a recessed cyan conduit that spirals with the
    shaft twist.  Drawn as stacked slabs so it can gradate along its run."""
    u, v = PL.zone_fns(zone)
    g = L.GROOVE_HW
    for i in range(steps):
        ya = y0 + (y1 - y0) * i / steps
        yb = y0 + (y1 - y0) * (i + 1.25) / steps
        xa = L.groove_center_x(profile, twist_spec, ya)
        xb = L.groove_center_x(profile, twist_spec, yb)

        def band(hw):
            return [(u(xa - hw), v(ya)), (u(xa + hw), v(ya)),
                    (u(xb + hw), v(yb)), (u(xb - hw), v(yb))]

        m.d.polygon(band(g), fill=CHANNEL)
        m.o.polygon(band(g), fill=(AO_DEEP, 206, 8))
        k = intensity(ya)
        if k <= 0.015:
            continue
        m.d.polygon(band(g * 0.80), fill=mix(CHANNEL, CYAN_DIF, min(1.0, k)))
        m.e.polygon(band(g * 0.88),
                    fill=tuple(int(c * min(1.0, k) * 0.30) for c in CYAN))
        m.d.polygon(band(g * 0.40), fill=mix(CYAN_DIF, (200, 250, 255),
                                             min(1.0, k) * 0.5))
        m.e.polygon(band(g * 0.44),
                    fill=tuple(min(255, int(c * k)) for c in CYAN))


def paint_spurs(m, zone, profile, twist_spec, spurs, intensity):
    """Sparing lateral tracery branching off the main conduit (obelisk_a)."""
    u, v = PL.zone_fns(zone)
    for (sy, ext) in spurs:
        xc = L.groove_center_x(profile, twist_spec, sy)
        k = intensity(sy) * 0.45
        x_a, x_b = xc + (0.10 if ext > 0 else ext), xc + (ext if ext > 0 else -0.10)
        box = PL.nbox(u(x_a), v(sy + 0.035), u(x_b), v(sy - 0.035))
        m.d.rectangle(box, fill=mix(CHANNEL, CYAN_DIF, 0.55))
        m.e.rectangle(box, fill=tuple(min(255, int(c * k)) for c in CYAN))


def paint_crown(m, zone, glow):
    """Oblique crown slice with the conduit's terminal lens."""
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=mix(STONE, DUSTY, 0.30), ao=AO_BASE - 6,
         rough=146, metal=28)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (x1 - x0) * 0.40
    for (f, col) in ((1.00, shade(STONE, 0.90)), (0.86, shade(STONE, 0.80)),
                     (0.62, CHANNEL)):
        m.d.ellipse([cx - r * f, cy - r * f, cx + r * f, cy + r * f], fill=col)
    m.o.ellipse([cx - r * 0.62, cy - r * 0.62, cx + r * 0.62, cy + r * 0.62],
                fill=(AO_DEEP, 200, 10))
    if glow > 0.02:
        rc = r * 0.34
        m.d.ellipse([cx - rc, cy - rc, cx + rc, cy + rc],
                    fill=mix(CYAN_DIF, (215, 252, 255), glow * 0.6))
        m.e.ellipse([cx - r * 0.60, cy - r * 0.60, cx + r * 0.60,
                     cy + r * 0.60],
                    fill=tuple(int(c * glow * 0.22) for c in CYAN))
        m.e.ellipse([cx - rc, cy - rc, cx + rc, cy + rc],
                    fill=tuple(min(255, int(c * glow)) for c in CYAN))
    # the conduit arriving at the lens from the -Z (front) edge
    m.d.rectangle([cx - 5, y0 + 4, cx + 5, cy], fill=CHANNEL)
    if glow > 0.02:
        m.e.rectangle([cx - 3, y0 + 6, cx + 3, cy],
                      fill=tuple(int(c * glow * 0.8) for c in CYAN))


def paint_fracture(m):
    """Raw interior of the break — crystalline, brighter than the weathered
    skin, with the severed conduit still smouldering at its core."""
    zone = L.C_FRAC
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=FRACT, ao=AO_BASE - 18, rough=196, metal=18)
    rng = np.random.default_rng(4242)
    for _ in range(46):
        cx = rng.uniform(x0, x1)
        cy = rng.uniform(y0, y1)
        r = rng.uniform(10, 46)
        pts = []
        for a in np.linspace(0, 2 * np.pi, int(rng.integers(3, 6)),
                             endpoint=False):
            rr = r * rng.uniform(0.6, 1.25)
            pts.append((cx + rr * np.cos(a), cy + rr * np.sin(a)))
        m.d.polygon(pts, fill=jit(shade(FRACT, rng.uniform(0.86, 1.10)), 4))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], fill=CHANNEL)
    for _ in range(5):
        ex = cx + rng.uniform(-20, 20)
        ey = cy + rng.uniform(-20, 20)
        s = rng.uniform(3, 7)
        m.d.ellipse([ex - s, ey - s, ex + s, ey + s], fill=CYAN_DIF)
        m.e.ellipse([ex - s, ey - s, ex + s, ey + s],
                    fill=tuple(int(c * rng.uniform(0.35, 0.8)) for c in CYAN))


def paint_soil(m, zone, seed, scorch_r=0.36):
    """Geological burial: packed earth, strata rings, stone speckle, and a
    scorch halo where the monolith meets the ground."""
    rng = np.random.default_rng(seed)
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=EARTH, ao=AO_BASE - 12, rough=238, metal=4)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    R = (x1 - x0) / 2
    for f in np.linspace(0.30, 0.98, 7):
        m.d.ellipse([cx - R * f, cy - R * f, cx + R * f, cy + R * f],
                    outline=jit(shade(EARTH, rng.uniform(0.86, 1.12)), 5),
                    width=int(rng.integers(3, 8)))
    for _ in range(900):
        sx = rng.uniform(x0, x1 - 4)
        sy = rng.uniform(y0, y1 - 4)
        s = rng.uniform(1.5, 4.5)
        m.d.ellipse([sx, sy, sx + s, sy + s],
                    fill=jit(shade(EARTH, rng.uniform(0.72, 1.30)), 7))
    # scorched ground ring at the foot
    for f, t in ((scorch_r, 0.72), (scorch_r * 1.5, 0.34)):
        m.d.ellipse([cx - R * f, cy - R * f, cx + R * f, cy + R * f],
                    fill=None, outline=mix(EARTH, SCORCH, t),
                    width=int(R * scorch_r * 0.55))
    m.d.ellipse([cx - R * 0.22, cy - R * 0.22, cx + R * 0.22, cy + R * 0.22],
                fill=mix(EARTH, SCORCH, 0.55))
    m.o.ellipse([cx - R * 0.5, cy - R * 0.5, cx + R * 0.5, cy + R * 0.5],
                fill=(AO_BASE - 26, 246, 2))


# ── seam intensity stories ──────────────────────────────────────────────

def act_a(y):
    """ACTIVE: a steady flow that strengthens with height, node-pulsed."""
    k = 0.22 + 0.72 * max(0.0, (y - 0.30)) / 8.2
    for ny in (1.90, 3.15, 4.90, 6.15, 7.60):
        k += 0.85 * float(np.exp(-((y - ny) / 0.16) ** 2))
    return min(1.35, k)


def act_b(y):
    """DORMANT: dim embers, with a dead fault where the shaft heaved."""
    if 3.35 < y < 4.25:
        return 0.02
    k = 0.10 + 0.16 * max(0.0, (y - 0.35)) / 5.2
    for ny in (1.15, 2.75, 5.05):
        k += 0.38 * float(np.exp(-((y - ny) / 0.13) ** 2))
    return min(0.75, k)


def act_c(y):
    """All but extinguished — two embers left, none across the break."""
    if 1.44 < y < 2.00:
        return 0.0
    k = 0.045
    for ny, s in ((1.28, 0.42), (2.55, 0.20)):
        k += s * float(np.exp(-((y - ny) / 0.12) ** 2))
    return min(0.6, k)


# ── main ────────────────────────────────────────────────────────────────

def paint_all():
    P.BOLT_LOG.clear()          # ancient tech has no bolts, ever
    m = Maps()
    fill(m, (0, 0, W, W), dif=STONE, ao=AO_BASE, rough=140, metal=30)

    tra_a = [0.9, 1.9, 4.0, 4.7, 5.3, 6.9, 7.5]
    tra_b = [0.7, 1.6, 2.1, 3.3, 3.9, 4.6]
    tra_c = [0.4, 1.5, 2.4, 3.0, 3.7]
    for z in (L.A_FACE, L.A_SIDE, L.A_BACK):
        paint_shaft_zone(m, z, 9.0, 0.0, L.A_COLLARS, tra_a, 11)
    for z in (L.B_FACE, L.B_SIDE, L.B_BACK):
        paint_shaft_zone(m, z, 6.0, 0.0, L.B_COLLARS, tra_b, 22)
    for z in (L.C_FACE, L.C_SIDE, L.C_BACK):
        paint_shaft_zone(m, z, 4.3, 0.0, L.C_COLLARS, tra_c, 33)

    paint_seam(m, L.A_FACE, L.A_PROFILE, L.A_TWIST, 0.10, 8.80, act_a)
    paint_seam(m, L.B_FACE, L.B_PROFILE, L.B_TWIST, 0.10, 5.85, act_b)
    paint_seam(m, L.C_FACE, L.C_FULL_PROFILE, L.C_TWIST, 0.10, 4.18, act_c)
    paint_spurs(m, L.A_FACE, L.A_PROFILE, L.A_TWIST,
                [(2.42, 0.52), (5.08, -0.46), (7.05, 0.40)], act_a)

    paint_crown(m, L.A_TOP, 1.0)
    paint_crown(m, L.B_TOP, 0.24)
    paint_crown(m, L.C_TOP, 0.0)
    paint_fracture(m)
    paint_soil(m, L.SOIL, 7, scorch_r=0.34)
    paint_soil(m, L.SOIL_B, 8, scorch_r=0.28)

    # groove side walls: uniform deep shadow (never a stripe — the baker
    # flat-shades, and this cell backs narrow slivers only)
    fill(m, L.GWALL.rect, dif=shade(STONE, 0.42), ao=AO_DEEP, rough=200,
         metal=14)
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=214, metal=20)

    # ── weathering: geological only, no rust anywhere ──
    sides = [L.A_FACE, L.A_SIDE, L.A_BACK, L.B_FACE, L.B_SIDE, L.B_BACK,
             L.C_FACE, L.C_SIDE, L.C_BACK]
    wx = PL.standard_weather(m, L, ground_rects=(L.SOIL.rect, L.SOIL_B.rect),
                             side_zones=sides, seed=41, mud=0.44, grime=0.50)
    for z, ybot in ((L.A_FACE, 1.5), (L.A_SIDE, 1.5), (L.A_BACK, 1.5),
                    (L.B_FACE, 1.3), (L.B_SIDE, 1.3), (L.B_BACK, 1.3),
                    (L.C_FACE, 1.1), (L.C_SIDE, 1.1), (L.C_BACK, 1.1)):
        wx.soot_patch(zrect(z, -0.8, ybot), strength=0.34)
        wx.mud_band(zrect(z, ybot, ybot + 5.0), 0.10, fade='down', dust=0.34,
                    spatter=False)
    wx.soot_patch(L.SOIL.rect, strength=0.22)
    wx.soot_patch(L.SOIL_B.rect, strength=0.18)

    # ── height → normals: the recessed collars read as real steps ──
    hm = NM.HeightMap()
    for zs, collars in ((sides[0:3], L.A_COLLARS), (sides[3:6], L.B_COLLARS),
                        (sides[6:9], L.C_COLLARS)):
        for z in zs:
            for (c0, c1) in collars:
                hm.rect(zrect(z, c0, c1), -0.5)
    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
