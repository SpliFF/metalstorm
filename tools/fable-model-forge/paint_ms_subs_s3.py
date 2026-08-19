"""paint_ms_subs_s3 — 2048 PBR set for ms_subs_s3 (hunter-killer pair).

Submerged-runner scheme: continuous dark anti-foul charcoal-green over
the whole hull (no boot-top — this boat runs submerged), tone-on-tone
plate bays (+-12%), limber-hole rows with rust weeps under the sail
hump, torpedo shutter outlines at the bow, anechoic-tile sonar strips,
team panel + pale hull-number stencil on the sail flanks (mirror-twin
safe), single tiny periscope-head emissive dot, algae/salt streaking
along the flanks and grime at the sail root.
"""
from __future__ import annotations
import numpy as np

import ms_subs_s3_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade,
                   jit, AO_BASE, AO_DEEP, R_ARMOR, M_ARMOR)

STEM = 'ms_subs_s3'
W = 2048
rng = np.random.default_rng(90210)

HULL  = (52, 57, 53)     # charcoal-green anti-foul
TOPC  = (57, 62, 57)
BELLY = (43, 47, 44)
SAILC = (45, 49, 49)
FINC  = (49, 54, 51)
SHRC  = (48, 52, 50)
SONARC = (38, 42, 43)    # anechoic rubber
DARK  = (25, 27, 29)
PALE  = (164, 168, 162)  # stencil grey


def tone_bays(m, zone, base, zs, v0, v1, u, v):
    """Tone-on-tone plate bays between frame seams (max +-12%)."""
    for i in range(len(zs) - 1):
        f = 0.92 + 0.16 * float(rng.random())
        m.d.rectangle([u(zs[i]) + 1, v(v0), u(zs[i + 1]) - 1, v(v1)],
                      fill=jit(shade(base, f), 3))
    for z in zs:
        seam_v(m, int(u(z)), int(v(v0)), int(v(v1)), base, hi=False)


def paint_hull(m, hm):
    # side
    zone = L.S_SIDE
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=HULL, ao=AO_BASE - 10, rough=R_ARMOR + 20,
         metal=45)
    zs = list(np.arange(-21.0, 22.0, 3.0))
    tone_bays(m, zone, HULL, zs, 2.85, -2.85, u, v)
    for wy in (1.5, 0.0, -1.5):           # strake seams
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), HULL, hi=False)
        hm.line((x0 + 3, v(wy)), (x1 - 3, v(wy)), -0.35, width=2)
    # limber holes under the sail hump + aft dorsal hump root
    for wz in np.arange(-8.5, 13.0, 1.6):
        m.d.rectangle([u(wz) - 9, v(2.45), u(wz) + 9, v(2.15)], fill=DARK)
        m.o.rectangle([u(wz) - 9, v(2.45), u(wz) + 9, v(2.15)],
                      fill=(AO_DEEP, 210, 30))
    # torpedo shutter outlines at the bow (two per flank)
    for (wz, wy) in ((-20.4, -0.5), (-19.6, 0.3)):
        r = 16
        m.d.ellipse([u(wz) - r, v(wy) - r, u(wz) + r, v(wy) + r],
                    outline=shade(HULL, 0.6), width=3)
    # retracted-plane recess hint forward
    wear_edges(m, (x0, y0, x1, y1), HULL, 40)

    # top deck
    zone = L.S_TOP
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=TOPC, ao=AO_BASE - 8, rough=R_ARMOR + 25,
         metal=45)
    tone_bays(m, zone, TOPC, zs, -2.85, 2.85, u, v)
    # safety-track walkway line + escape hatch rings
    m.d.rectangle([u(-18.0), v(-0.35), u(16.0), v(0.35)],
                  fill=shade(TOPC, 0.88))
    for wz in (-12.5, 9.0):
        r = 22
        m.d.ellipse([u(wz) - r, v(0) - r, u(wz) + r, v(0) + r],
                    outline=shade(TOPC, 1.25), width=4)
        m.d.ellipse([u(wz) - 6, v(0) - 6, u(wz) + 6, v(0) + 6],
                    fill=shade(TOPC, 0.7))
    # capstan / cleat dots forward
    for wz in (-19.5, -18.2):
        m.d.ellipse([u(wz) - 7, v(0) - 7, u(wz) + 7, v(0) + 7], fill=DARK)

    # belly
    zone = L.S_BELLY
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=BELLY, ao=AO_BASE - 18, rough=R_ARMOR + 35,
         metal=35)
    tone_bays(m, zone, BELLY, zs, -2.85, 2.85, u, v)
    seam_h(m, x0 + 3, x1 - 3, int(v(0.0)), BELLY, hi=False)
    # flood ports along the keel line
    for wz in np.arange(-14.0, 18.0, 2.4):
        m.d.rectangle([u(wz) - 10, v(-0.5), u(wz) + 10, v(-0.2)], fill=DARK)

    # nose cap: shutter cluster
    zone = L.S_NOSE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HULL, 0.92), ao=AO_BASE - 12,
         rough=R_ARMOR + 30, metal=40)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for (dx, dy) in ((-30, -30), (30, -30), (-30, 30), (30, 30)):
        m.d.ellipse([cx + dx - 14, cy + dy - 14, cx + dx + 14, cy + dy + 14],
                    outline=shade(HULL, 0.55), width=3)


def paint_sail(m, hm):
    zone = L.S_SAIL
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=SAILC, ao=AO_BASE - 8, rough=R_ARMOR + 15,
         metal=50)
    # tone bays + leading-edge fairing seam
    zs = list(np.arange(-9.0, 14.0, 2.6))
    tone_bays(m, zone, SAILC, zs, 4.6, 1.9, u, v)
    for wy in (3.6, 2.7):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), SAILC, hi=False)
        hm.line((x0 + 3, v(wy)), (x1 - 3, v(wy)), -0.3, width=2)
    # team panel on the sail flank (base= stops the TEAMGREY flood)
    PL.team_panel(m, PL.nbox(u(-6.4), v(4.0), u(-3.4), v(3.35)),
                  outline=SAILC, base=(120, 124, 128))
    # pale hull-number stencil (mirror twin renders the -x side)
    f = PL.font(46)
    m.d.text((u(-2.6) + 2, v(3.95) + 2), 'K-31', font=f,
             fill=shade(SAILC, 0.55))
    m.d.text((u(-2.6), v(3.95)), 'K-31', font=f, fill=PALE)
    # intake grilles at the sail root aft
    for wz in np.arange(2.4, 5.6, 0.8):
        m.d.rectangle([u(wz) - 6, v(2.85), u(wz) + 6, v(2.45)], fill=DARK)
    wear_edges(m, (x0, y0, x1, y1), SAILC, 35)

    # sail top: darker, hatch, single periscope-head emissive dot
    zone = L.S_SAILTOP
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=shade(SAILC, 0.9), ao=AO_BASE - 10,
         rough=R_ARMOR + 20, metal=50)
    m.d.ellipse([u(-1.4) - 14, v(0) - 14, u(-1.4) + 14, v(0) + 14],
                outline=shade(SAILC, 0.6), width=3)
    m.e.ellipse([u(-3.2) - 4, v(0) - 4, u(-3.2) + 4, v(0) + 4],
                fill=(200, 160, 90))


def paint_gear(m):
    # X-fins: leading-edge wear, tone panel
    zone = L.S_FIN
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=FINC, ao=AO_BASE - 8, rough=R_ARMOR + 20,
         metal=55)
    m.d.rectangle([u(17.0), y0 + 2, u(17.7), y1 - 2], fill=shade(FINC, 1.18))
    seam_v(m, int(u(19.6)), y0 + 3, y1 - 3, FINC, hi=False)
    wear_edges(m, (x0, y0, x1, y1), FINC, 45)

    # pump-jet shroud: banded ring + bolts, dark trailing lip
    zone = L.S_SHROUD
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=SHRC, ao=AO_BASE - 10, rough=R_ARMOR + 15,
         metal=70)
    m.d.rectangle([u(21.1), y0 + 2, u(21.6), y1 - 2], fill=DARK)
    seam_v(m, int(u(20.2)), y0 + 3, y1 - 3, SHRC, hi=False)
    bolts(m, [(u(19.9), y0 + 20 + i * (y1 - y0 - 40) / 5) for i in range(6)],
          base=SHRC)

    # dark cell (inner duct, annuli, vanes, stern cap)
    fill(m, L.S_DARKR, dif=DARK, ao=AO_DEEP, rough=220, metal=60)

    # bow-plane blisters: hull tone + recess outline + hinge bolts
    zone = L.S_PLANE
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=shade(HULL, 1.05), ao=AO_BASE - 8,
         rough=R_ARMOR + 20, metal=50)
    m.d.rectangle([u(-17.2), v(0.6), u(-14.8), v(0.1)],
                  outline=shade(HULL, 0.6), width=3)
    bolts(m, [(u(-17.0), v(0.35)), (u(-15.0), v(0.35))], base=HULL)

    # sonar arrays: anechoic tile grid
    zone = L.S_SONAR
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=SONARC, ao=AO_BASE - 14, rough=235,
         metal=20)
    for wz in np.arange(-6.5, 7.0, 0.9):
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, SONARC, hi=False)
    seam_h(m, x0 + 2, x1 - 2, int(v(-0.33)), SONARC, hi=False)


def paint_all():
    P.BOLT_LOG.clear()
    m = Maps()
    from normals import HeightMap
    hm = HeightMap()
    paint_hull(m, hm)
    paint_sail(m, hm)
    paint_gear(m)

    # ── submerged-runner weathering ──
    wx = PL.standard_weather(m, L, ground_rects=(), side_zones=(),
                             seed=41, grime=0.5)
    zone = L.S_SIDE
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-8.5, 13.0, 1.6):        # rust weeps under limber holes
        wx.rust_streak(u(wz), v(2.15), 42 + (int(wz) % 3) * 14, width=2.5,
                       strength=0.45)
    for wz in (-20.4, -19.6):                    # shutter weeps
        wx.rust_streak(u(wz), v(-0.2), 30, width=2.0, strength=0.35)
    x0, y0, x1, y1 = zone.rect
    wx.mud_band((x0, int(v(-1.2)), x1, y1), 0.32, fade=None, spatter=True)
    wx.mud_band((x0, y0, x1, y1), 0.18, fade='down', spatter=False)
    sx0, sy0, sx1, sy1 = L.S_SAIL.rect
    us, vs = PL.zone_fns(L.S_SAIL)
    wx.mud_band((sx0, int(vs(2.7)), sx1, sy1), 0.5, fade=None, spatter=True)
    wx.mud_band(L.S_SONAR.rect, 0.25, fade=None, spatter=False)
    wx.mud_band(L.S_BELLY.rect, 0.3, fade=None, spatter=True)

    PL.finish(m, L, STEM, hm=hm, wx=wx)
    print('[paint_ms_subs_s3] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
