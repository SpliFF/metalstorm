"""paint_ms_subs_s2 — 2048 PBR set for ms_subs_s2 (attack sub pair boat).

Submerged-runner scheme: continuous dark anti-foul over the whole hull
(no boot-top — this boat runs submerged), tone-on-tone plating +-15%,
limber-hole slots along the casing line, torpedo door pair on the blunt
bow face, pale hull number + team panel on the sail flanks, bronze open
screw, single tiny periscope-head sensor dot. Weathering: rust under the
limber holes and fittings, algae/salt streaking along the flank, grime
at the sail root.
"""
from __future__ import annotations
import numpy as np

import ms_subs_s2_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL
from paint import (Maps, fill, seam_h, seam_v, shade, jit, stencil,
                   AO_BASE, AO_DEEP, BOLT_LOG)

W = 2048
RNG = np.random.default_rng(90210)

HULL = (54, 60, 56)                # charcoal grey-green anti-foul
TOPC = (60, 66, 61)
BELLY = (45, 49, 47)
SAIL = (50, 56, 53)
FINC = (47, 52, 49)
BRONZE = (98, 84, 62)
PALE = (176, 182, 176)             # stencil grey
SLOT = (26, 29, 27)


def panels(m, zone, base, du, nv, tone=0.12):
    """Tone-on-tone plate patchwork inside a zone rect (+-tone max)."""
    x0, y0, x1, y1 = zone.rect
    us = np.arange(x0, x1, du)
    vs = np.linspace(y0, y1, nv + 1)
    for ua in us:
        for j in range(nv):
            f = 1.0 + float(RNG.uniform(-tone, tone))
            m.d.rectangle([ua, vs[j], min(ua + du, x1), vs[j + 1]],
                          fill=jit(shade(base, f), 3))
    for ua in us[1:]:
        seam_v(m, int(ua), y0 + 2, y1 - 2, base, hi=False)
    for vv in vs[1:-1]:
        seam_h(m, x0 + 2, x1 - 2, int(vv), base, hi=False)


def paint_hull(m):
    for zone, base in ((L.S_HULL_SIDE, HULL), (L.S_TOP, TOPC),
                       (L.S_BELLY, BELLY)):
        fill(m, zone.rect, dif=base, ao=AO_BASE - 10, rough=212, metal=35)
        panels(m, zone, base, du=170, nv=3)

    # limber holes along the casing line (side zone, both flanks share)
    u, v = PL.zone_fns(L.S_HULL_SIDE)
    for wz in np.arange(-6.5, 4.5, 1.1):
        m.d.rectangle([u(wz) - 16, v(1.62) - 5, u(wz) + 16, v(1.62) + 5],
                      fill=SLOT)
        m.o.rectangle([u(wz) - 16, v(1.62) - 5, u(wz) + 16, v(1.62) + 5],
                      fill=(AO_DEEP, 220, 20))
    # flood ports low on the flank, bow + stern groups
    for wz in list(np.arange(-12.5, -9.0, 0.9)) + list(np.arange(8.0, 11.5, 0.9)):
        m.d.rectangle([u(wz) - 12, v(-1.45) - 4, u(wz) + 12, v(-1.45) + 4],
                      fill=SLOT)
    # weld line where the sail fairing lands (grime anchor)
    m.d.rectangle([u(-4.4), v(1.95), u(2.7), v(1.90)], fill=shade(HULL, 0.72))

    # top: escape-trunk + capstan discs on the centreline
    ut, vt = PL.zone_fns(L.S_TOP)
    for wz in (-11.0, 6.0):
        cxp, cyp = ut(wz), vt(0.0)
        m.d.ellipse([cxp - 16, cyp - 16, cxp + 16, cyp + 16],
                    fill=shade(TOPC, 0.8), outline=shade(TOPC, 0.6))


def paint_sail(m):
    fill(m, L.S_SAIL.rect, dif=SAIL, ao=AO_BASE - 8, rough=205, metal=45)
    u, v = PL.zone_fns(L.S_SAIL)
    for wz in (-2.6, -0.9, 0.8):
        seam_v(m, int(u(wz)), L.S_SAIL.rect[1] + 4, L.S_SAIL.rect[3] - 4,
               SAIL, hi=False)
    # team panel on the sail flank (aft), neutral base per preamble
    PL.team_panel(m, PL.nbox(u(-0.5), v(3.95), u(2.0), v(3.15)),
                  outline=shade(SAIL, 0.9), base=(120, 124, 128))
    # pale hull number forward — the mirrored twin zone unreverses it
    stencil(m, (u(-3.35), v(3.85)), 'S-207', 52, PALE)
    # window/no — just a dark quieting-tile band at the sail root
    m.d.rectangle([u(-4.5), v(1.95), u(2.8), v(1.60)], fill=shade(SAIL, 0.8))

    fill(m, L.S_SAIL_T.rect, dif=shade(SAIL, 1.08), ao=AO_BASE - 8,
         rough=205, metal=45)
    x0, y0, x1, y1 = L.S_SAIL_T.rect
    # cockpit hatch + mast wells on the sail top
    m.d.rectangle([x0 + 60, (y0 + y1) // 2 - 22, x0 + 130,
                   (y0 + y1) // 2 + 22], fill=SLOT)
    m.d.ellipse([x0 + 190, (y0 + y1) // 2 - 14, x0 + 218,
                 (y0 + y1) // 2 + 14], fill=shade(SAIL, 0.7))


def paint_gear(m):
    for zone in (L.S_FIN, L.S_SFIN, L.S_VFIN):
        fill(m, zone.rect, dif=FINC, ao=AO_BASE - 10, rough=200, metal=80)
        x0, y0, x1, y1 = zone.rect
        seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, FINC, hi=False)
    # blunt bow face: anti-foul + twin torpedo tube doors low on the face
    fill(m, L.S_BOW.rect, dif=shade(HULL, 0.94), ao=AO_BASE - 12,
         rough=212, metal=35)
    ub, vb = PL.zone_fns(L.S_BOW)
    for wx in (-0.26, 0.26):
        cxp, cyp = ub(wx), vb(-0.30)
        m.d.ellipse([cxp - 20, cyp - 20, cxp + 20, cyp + 20],
                    fill=SLOT, outline=shade(HULL, 0.6), width=2)
    fill(m, L.S_DARK.rect, dif=(30, 32, 31), ao=AO_DEEP, rough=210, metal=40)
    fill(m, L.S_BLIST.rect, dif=(38, 42, 40), ao=AO_BASE - 14, rough=190,
         metal=60)
    # masts: dark steel, ONE tiny periscope-head sensor dot (u=1 = tip)
    x0, y0, x1, y1 = L.S_MAST
    fill(m, (x0, y0, x1, y1), dif=(58, 61, 60), ao=AO_BASE - 8, rough=160,
         metal=150)
    m.e.ellipse([x1 - 14, y0 + 20, x1 - 4, y0 + 30], fill=(200, 150, 90))
    # screw: worn bronze
    fill(m, L.S_PROP.rect, dif=BRONZE, ao=AO_BASE - 8, rough=140, metal=190)
    x0, y0, x1, y1 = L.S_PROP.rect
    m.d.ellipse([(x0 + x1) / 2 - 30, (y0 + y1) / 2 - 30,
                 (x0 + x1) / 2 + 30, (y0 + y1) / 2 + 30],
                fill=shade(BRONZE, 0.82))
    fill(m, L.S_HUB, dif=shade(BRONZE, 0.9), ao=AO_BASE - 10, rough=150,
         metal=190)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_sail(m)
    paint_gear(m)

    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_HULL_SIDE,),
                             mud=0.28, grime=0.5)
    u, v = PL.zone_fns(L.S_HULL_SIDE)
    for wz in np.arange(-6.5, 4.5, 1.1):        # rust weeping the limber holes
        wx.rust_streak(u(wz), v(1.55), 30 + (int(wz * 3) % 4) * 10,
                       width=2.6, strength=0.5)
    for wz in (-12.0, -9.6, 8.4, 10.8):         # flood-port rust
        wx.rust_streak(u(wz), v(-1.5), 24, width=2.2, strength=0.4)
    x0, y0, x1, y1 = L.S_HULL_SIDE.rect
    wx.mud_band((x0, int(v(0.6)), x1, int(v(-0.9))), 0.35, fade=None,
                spatter=True)                    # algae/salt flank streaking
    wx.mud_band(L.S_SAIL.rect, 0.3, fade='down', spatter=False)  # sail-root grime
    xt0, yt0, xt1, yt1 = L.S_TOP.rect
    ut, _ = PL.zone_fns(L.S_TOP)
    wx.mud_band((int(ut(-4.6)), yt0, int(ut(2.9)), yt1), 0.4, fade=None,
                spatter=True)                    # grime around the sail root
    wx.rust_blotch((L.S_PROP.rect[0] + L.S_PROP.rect[2]) / 2,
                   (L.S_PROP.rect[1] + L.S_PROP.rect[3]) / 2, 60,
                   strength=0.35)                # screw verdigris-ish staining

    PL.finish(m, L, 'ms_subs_s2', wx=wx)


if __name__ == '__main__':
    paint_all()
