"""paint_ms_subs_s4 — 2048² PBR set for ms_subs_s4 (missile leviathan).

Submerged boomer: continuous dark anti-foul finish over the whole hull
(near-black grey-greens, tone-on-tone panels ±15% max, NO waterline band),
painted limber-hole rows along the flank and casing, big square VLS hatch
lids with cross seams on the turtleback, pale hull-number/class stencils on
the sail (with the mirrored-twin zone for the far side), team panel on the
sail flanks, bronze screw, one tiny periscope-head emissive dot. Weathering:
rust under limber holes and fittings, algae/salt streaking along the flank,
grime at the sail root.
"""
from __future__ import annotations
import os
import numpy as np

import ms_subs_s4_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL
from paint import (Maps, fill, seam_h, seam_v, bolts, shade, jit, BOLT_LOG,
                   TEAMGREY, AO_BASE, AO_DEEP, R_ARMOR, M_ARMOR)

# DejaVu path in paint.py is Linux-only; fall back to a macOS system font.
if not os.path.exists(P.FONT):
    for cand in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                 '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf',
                 '/Library/Fonts/Arial Bold.ttf'):
        if os.path.exists(cand):
            P.FONT = cand
            break

W = 2048
# dark anti-foul register (tone-on-tone, ±15% max)
HULL   = (52, 58, 54)     # charcoal grey-green flank
HULLT  = (56, 62, 57)     # upper hull
HULLB  = (45, 49, 47)     # belly
CASE   = (48, 53, 50)     # turtleback sides — slab dark
DECK   = (54, 59, 55)     # missile deck top
HATCH  = (60, 65, 60)     # hatch lids (still within family)
SAIL   = (49, 55, 51)
TRIMC  = (42, 46, 44)
BRONZE = (98, 80, 56)     # screw
PALE   = (168, 174, 168)  # stencils


def paint_hull(m):
    for zone, base in ((L.S_HULL_SIDE, HULL), (L.S_HULL_TOP, HULLT),
                       (L.S_HULL_BOT, HULLB)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE - 10, rough=205,
             metal=60)
        u, v = PL.zone_fns(zone)
        # plated frame seams, tone-on-tone
        for wz in np.arange(-30.0, 31.0, 4.2):
            seam_v(m, int(u(wz)), y0 + 3, y1 - 3, base, hi=False)
        # subtle strake shading bands (±10%)
        rng = np.random.default_rng(90210)
        for i, wz in enumerate(np.arange(-30.0, 27.0, 5.7)):
            if i % 2 == 0:
                continue
            m.d.rectangle([u(wz), y0 + 3, u(wz + 5.7), y1 - 3],
                          fill=jit(shade(base, 0.93), 3))

    # limber-hole row along the flank (free-flood vents)
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-27.0, -12.0, 1.9):
        m.d.rounded_rectangle([u(wz) - 13, v(2.9), u(wz) + 13, v(2.45)],
                              radius=6, fill=(24, 26, 25))
    for wz in np.arange(21.0, 29.0, 1.9):
        m.d.rounded_rectangle([u(wz) - 11, v(2.2), u(wz) + 11, v(1.8)],
                              radius=5, fill=(24, 26, 25))
    # bow torpedo tube doors (paired shutter outlines near the nose)
    for wy in (0.9, -0.4):
        m.d.rectangle([u(-31.4), v(wy), u(-29.2), v(wy - 0.9)],
                      outline=(30, 33, 31), width=3)


def paint_case(m):
    # slab sides
    zone = L.S_CASE_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CASE, ao=AO_BASE - 12, rough=210, metal=55)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-9.0, 20.0, 3.5):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, CASE, hi=False)
    # casing limber holes along the lower edge
    for wz in np.arange(-8.0, 20.0, 2.3):
        m.d.rounded_rectangle([u(wz) - 12, v(2.2), u(wz) + 12, v(1.8)],
                              radius=5, fill=(24, 26, 25))
    # missile deck
    zone = L.S_CASE_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECK, ao=AO_BASE - 8, rough=215, metal=50)
    u, v = PL.zone_fns(zone)
    # anti-slip walkway down the centreline
    m.d.rectangle([x0 + 2, v(-0.45), x1 - 2, v(0.45)],
                  fill=shade(DECK, 0.92))
    # VLS hatch lids: square plates, cross seams, corner bolts
    hw = L.HATCH_W / 2
    for hx in L.HATCH_ROWS:
        for hz in L.HATCH_Z:
            b = [u(hz - hw), v(hx - hw), u(hz + hw), v(hx + hw)]
            m.d.rectangle(b, fill=jit(HATCH, 3))
            m.o.rectangle(b, fill=(AO_BASE - 6, 195, 70))
            m.d.rectangle(b, outline=(28, 31, 29), width=3)
            m.d.line([(b[0] + b[2]) / 2, b[1], (b[0] + b[2]) / 2, b[3]],
                     fill=shade(HATCH, 0.75), width=2)
            m.d.line([b[0], (b[1] + b[3]) / 2, b[2], (b[1] + b[3]) / 2],
                     fill=shade(HATCH, 0.75), width=2)
            bolts(m, [(b[0] + 8, b[1] + 8), (b[2] - 8, b[1] + 8),
                      (b[0] + 8, b[3] - 8), (b[2] - 8, b[3] - 8)],
                  base=HATCH)
            # small pale hatch index at the forward edge
            f = PL.font(20)
            idx = L.HATCH_Z.index(hz) + 1 + (6 if hx > 0 else 0)
            m.d.text((b[0] + 6, (b[1] + b[3]) / 2 - 10), f'{idx:02d}',
                     font=f, fill=(150, 156, 150))


def paint_sail(m):
    zone = L.S_SAIL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=SAIL, ao=AO_BASE - 8, rough=200, metal=60)
    u, v = PL.zone_fns(zone)
    seam_h(m, x0 + 3, x1 - 3, int(v(4.6)), SAIL, hi=False)
    # team panel on the sail flank (base= stops the TEAMGREY flood)
    PL.team_panel(m, PL.nbox(u(-19.6), v(5.9), u(-17.4), v(4.9)),
                  outline=shade(SAIL, 0.6), base=(120, 124, 128))
    # pale hull number + class name (mirrored twin zone handles the far side)
    f = PL.font(58)
    m.d.text((u(-16.9) + 2, v(5.75) + 2), 'K-65', font=f,
             fill=shade(SAIL, 0.5))
    m.d.text((u(-16.9), v(5.75)), 'K-65', font=f, fill=PALE)
    f2 = PL.font(26)
    m.d.text((u(-16.8), v(4.45)), 'LEVIATHAN', font=f2,
             fill=(130, 136, 130))
    # sail-top: matte walk surface
    zone = L.S_SAIL_TOP
    fill(m, zone.rect, dif=shade(SAIL, 0.94), ao=AO_BASE - 10, rough=215,
         metal=45)
    zone = L.S_SAIL_END
    fill(m, zone.rect, dif=shade(SAIL, 0.97), ao=AO_BASE - 10, rough=205,
         metal=55)


def paint_small(m):
    # fins
    fill(m, L.S_FIN.rect, dif=HULL, ao=AO_BASE - 10, rough=205, metal=60)
    fill(m, L.S_FIN_PLAN.rect, dif=shade(HULL, 0.96), ao=AO_BASE - 10,
         rough=205, metal=60)
    x0, y0, x1, y1 = L.S_FIN_PLAN.rect
    for fx in (0.3, 0.55, 0.8):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, HULL, hi=False)
    # trim / dark / shroud / masts
    fill(m, L.S_TRIM.rect, dif=TRIMC, ao=AO_BASE - 14, rough=195, metal=80)
    fill(m, L.S_DARK.rect, dif=(24, 26, 25), ao=AO_DEEP, rough=210, metal=40)
    fill(m, L.S_SHROUD.rect, dif=(44, 48, 46), ao=AO_BASE - 12, rough=185,
         metal=110)
    x0, y0, x1, y1 = L.S_SHROUD.rect
    for fx in (0.25, 0.5, 0.75):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, (44, 48, 46),
               hi=False)
    fill(m, L.S_MAST, dif=(58, 62, 60), ao=AO_BASE - 8, rough=170, metal=140)
    # screw: worn bronze, high metal
    fill(m, L.S_PROP, dif=BRONZE, ao=AO_BASE - 10, rough=140, metal=200)
    fill(m, L.S_BLADE.rect, dif=jit(BRONZE, 4), ao=AO_BASE - 8, rough=130,
         metal=210)
    # single tiny emissive: periscope head dot (top of the mast wrap)
    x0, y0, x1, y1 = L.S_MAST
    m.e.ellipse([x1 - 26, y0 + 8, x1 - 12, y0 + 22], fill=(255, 180, 100))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_case(m)
    paint_sail(m)
    paint_small(m)

    # ── weathering: submerged-boat register ──
    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_HULL_SIDE, L.S_CASE_SIDE),
                             mud=0.30, grime=0.5, rust_fraction=0.45)
    zone = L.S_HULL_SIDE
    u, v = PL.zone_fns(zone)
    # rust weeping from the limber-hole rows
    for wz in np.arange(-27.0, -12.0, 3.8):
        wx.rust_streak(u(wz), v(2.4), 40 + (int(wz) % 3) * 14, width=3.0,
                       strength=0.5)
    for wz in np.arange(21.0, 29.0, 3.8):
        wx.rust_streak(u(wz), v(1.75), 30, width=2.5, strength=0.45)
    # algae/salt scum band along the lower flank
    x0, y0, x1, y1 = zone.rect
    wx.mud_band((x0, int(v(-1.0)), x1, int(v(-4.4))), 0.35, fade=None,
                spatter=True)
    # grime at the sail root
    zs = L.S_SAIL_SIDE.rect
    wx.mud_band((zs[0], int(zs[3] - (zs[3] - zs[1]) * 0.3), zs[2], zs[3]),
                0.4, fade=None, spatter=False)
    # casing limber-hole rust
    uc, vc = PL.zone_fns(L.S_CASE_SIDE)
    for wz in np.arange(-8.0, 20.0, 4.6):
        wx.rust_streak(uc(wz), vc(1.75), 34, width=2.5, strength=0.4)

    # ── height accents: hatch coaming grid + frame seams ──
    from normals import HeightMap
    hm = HeightMap()
    ut, vt = PL.zone_fns(L.S_CASE_TOP)
    hw = L.HATCH_W / 2
    for hx in L.HATCH_ROWS:
        for hz in L.HATCH_Z:
            hm.rect((ut(hz - hw), vt(hx - hw), ut(hz + hw), vt(hx + hw)),
                    0.5)
    for wz in np.arange(-30.0, 31.0, 4.2):
        hm.line((u(wz), y0 + 3), (u(wz), y1 - 3), 0.3, width=2)

    PL.finish(m, L, 'ms_subs_s4', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
