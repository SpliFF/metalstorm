"""paint_ms_arsenal_barge — 2048 PBR set for ms_arsenal_barge.

Field-improvised Resistance register: patched scrap-plate hull sides
over a black boot-top and oxide anti-foul, worn steel cargo deck with
painted cause-marks, sandbag/tarp/crate/drum clutter cells, hazard
band at the rack rear, warm deckhouse windows, team colour on the deck
ID panel and rack cheeks only (mask R channel).
"""
from __future__ import annotations
import numpy as np

import ms_arsenal_barge_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL
import os
if not os.path.exists(P.FONT):      # stencil() reads paint.FONT at call time
    for _cand in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                  '/System/Library/Fonts/Supplemental/Courier New Bold.ttf'):
        if os.path.exists(_cand):
            P.FONT = _cand
            break

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, stencil,
                   jit, shade, BOLT_LOG, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_DEEP, R_ARMOR, R_STEEL,
                   M_ARMOR, M_STEEL)

W = 2048
OLIVE = (86, 88, 66)
RUSTP = (110, 74, 52)
GREYP = (96, 99, 100)
DECKC = (78, 80, 82)
ANTIFOUL = (92, 50, 42)
BOOT = (26, 28, 31)
SAND = (150, 132, 96)
TARPC = (74, 82, 68)
WARM = (255, 190, 120)


def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    # scrap patchwork topside (Resistance improvised register)
    PL.panel_patchwork(m, (x0, y0, x1, int(v(L.WATERLINE[1]))),
                       [OLIVE, RUSTP, GREYP, shade(OLIVE, 0.85)],
                       cols=10, rows=2)
    # boot-top + anti-foul below waterline
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))
    # hand-painted cause-mark + hull name at the bow
    PL.roundel_star(m, u(-22.0), v(1.7), 26, (208, 200, 180))
    f = PL.font(40)
    m.d.text((u(-18.5), v(2.1)), 'AB-7', font=f, fill=(202, 198, 186))
    wear_edges(m, (x0, y0, x1, int(v(L.WATERLINE[1]))), OLIVE, 60)

    # belly
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.9), ao=AO_BASE - 25, rough=220, metal=15)

    # bow / stern faces: patch grey over boot band
    for zone in (L.S_BOW, L.S_STERN):
        x0, y0, x1, y1 = zone.rect
        _, vv = PL.zone_fns(zone)
        fill(m, (x0, y0, x1, y1), dif=jit(GREYP, 6), ao=AO_BASE - 8,
             rough=R_ARMOR, metal=M_ARMOR)
        m.d.rectangle([x0, vv(L.WATERLINE[1]), x1, vv(L.WATERLINE[0])],
                      fill=BOOT)
        m.d.rectangle([x0, vv(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
        wear_edges(m, (x0, y0, x1, y1), GREYP, 45)


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200,
         metal=100)
    for wz in np.arange(-26.0, 28.0, 3.4):        # plate seams
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, DECKC, hi=False)
    for wx in (-4.2, 0.0, 4.2):
        seam_h(m, x0 + 3, x1 - 3, int(v(wx)), DECKC, hi=False)
    # team ID panel painted on the deck
    tx, tz, tw, td = L.TEAM_DECK
    PL.team_panel(m, (u(tz - td / 2), v(tx - tw / 2),
                      u(tz + td / 2), v(tx + tw / 2)), outline=DECKC)
    # hazard square under the rack blast area
    PL.hazard_band(m, (u(-6.6), v(-2.2), u(-6.0), v(2.2)))
    PL.hazard_band(m, (u(0.4), v(-2.2), u(1.0), v(2.2)))
    # hand-stencilled warning aft of the mount
    stencil(m, (u(2.8), v(-3.6)), 'NO SMOKING', 26, (188, 60, 40))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 70)


def paint_rack(m):
    # cheeks: olive with TEAM cheek flash forward
    zone = L.S_RACK_SIDE
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    fill(m, (x0, y0, x1, y1), dif=jit(OLIVE, 5), ao=AO_BASE - 8,
         rough=R_ARMOR, metal=M_ARMOR)
    for wz in (-4.6, -2.4, -0.2):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, OLIVE, hi=False)
    PL.team_panel(m, PL.nbox(u(-6.6), v(1.6), u(-4.9), v(0.6)), outline=OLIVE)
    bolts(m, [(u(z), v(-0.55)) for z in (-5.5, -3.5, -1.5, 0.4)], base=OLIVE)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 55)

    # rear blast plate: hazard edge + panel
    zone = L.S_RACK_FACE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE, 0.9), ao=AO_BASE - 10,
         rough=R_ARMOR, metal=M_ARMOR)
    PL.hazard_band(m, (x0 + 4, y0 + 4, x1 - 4, y0 + 22))
    bolts(m, [(x0 + 14 + i * (x1 - x0 - 28) / 5, y1 - 14) for i in range(6)],
          base=OLIVE)

    # top cover: tarp-green with lashing straps
    zone = L.S_RACK_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=TARPC, ao=AO_BASE - 8, rough=215, metal=25)
    for fy in np.linspace(0.15, 0.85, 4):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.rectangle([x0 + 2, yy - 3, x1 - 2, yy + 3], fill=shade(TARPC, 0.7))
    # tube wrap: steel, soot ring at the mouth end (u = along length, u0=mouth)
    x0, y0, x1, y1 = L.S_TUBE
    fill(m, (x0, y0, x1, y1), dif=(70, 72, 74), ao=AO_BASE - 10, rough=170,
         metal=170)
    m.d.rectangle([x0, y0, x0 + 30, y1], fill=(38, 38, 40))
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)

    # mount ring
    r = L.S_MOUNT.rect
    fill(m, r, dif=shade(GREYP, 0.9), ao=AO_BASE - 12, rough=185, metal=140)
    m.d.ellipse([r[0] + 20, r[1] + 20, r[2] - 20, r[3] - 20],
                outline=shade(GREYP, 0.6), width=6)


def paint_clutter(m):
    # deckhouse: corrugated patch walls + warm windows
    zone = L.S_HOUSE_S
    x0, y0, x1, y1 = zone.rect
    PL.panel_patchwork(m, (x0, y0, x1, y1), [GREYP, OLIVE, RUSTP],
                       cols=4, rows=2, bolt_every=3, seed=90211)
    wy0 = y0 + (y1 - y0) * 0.22
    wy1 = y0 + (y1 - y0) * 0.44
    for i in (1, 2, 4):
        gx0 = x0 + (x1 - x0) * i / 6 + 6
        gx1 = x0 + (x1 - x0) * (i + 1) / 6 - 6
        PL.glass_rect(m, (gx0, wy0, gx1, wy1), outline=GREYP)
        if i != 2:
            m.e.rectangle([gx0 + 3, wy0 + 3, gx1 - 3, wy1 - 3],
                          fill=(150, 110, 60))
    r = L.S_HOUSE_T.rect
    fill(m, r, dif=shade(DECKC, 0.95), ao=AO_BASE - 8, rough=200, metal=90)
    seam_h(m, r[0] + 3, r[2] - 3, (r[1] + r[3]) // 2, DECKC, hi=False)

    # clutter cells
    r = L.S_CRATE.rect
    fill(m, r, dif=(122, 100, 66), ao=AO_BASE - 8, rough=215, metal=10)
    m.d.rectangle(r, outline=(86, 68, 44), width=4)
    m.d.line([(r[0], r[1]), (r[2], r[3])], fill=(96, 78, 50), width=4)
    stencil(m, (r[0] + 70, r[1] + 120), 'AMMO', 30, (60, 48, 32))
    r = L.S_TARP.rect
    fill(m, r, dif=TARPC, ao=AO_BASE - 8, rough=220, metal=15)
    for fx in (0.25, 0.5, 0.75):
        m.d.line([(r[0] + (r[2] - r[0]) * fx, r[1]),
                  (r[0] + (r[2] - r[0]) * fx, r[3])],
                 fill=shade(TARPC, 0.75), width=5)
    r = L.S_SANDBAG.rect
    fill(m, r, dif=SAND, ao=AO_BASE - 12, rough=230, metal=5)
    m.d.rectangle(r, outline=shade(SAND, 0.8), width=3)
    r = L.S_DRUM.rect
    fill(m, r, dif=(104, 62, 48), ao=AO_BASE - 10, rough=190, metal=120)
    m.d.rectangle([r[0], (r[1] + r[3]) // 2 - 4, r[2], (r[1] + r[3]) // 2 + 4],
                  fill=shade((104, 62, 48), 0.7))
    r = L.S_PLATE.rect
    PL.panel_patchwork(m, r, [GREYP, RUSTP, shade(GREYP, 0.8)], cols=2,
                       rows=2, seed=90212)
    r = L.S_TRIM.rect
    fill(m, r, dif=(58, 60, 62), ao=AO_BASE - 15, rough=170, metal=150)
    r = L.S_MAST
    fill(m, r, dif=(92, 94, 96), ao=AO_BASE - 10, rough=155, metal=165)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_rack(m)
    paint_clutter(m)

    wx = PL.standard_weather(m, L, ground_rects=(L.S_DECK.rect,),
                             side_zones=(L.S_HULL_SIDE,), seed=41,
                             mud=0.35, grime=0.5)
    zone = L.S_HULL_SIDE
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-24.0, 27.0, 4.5):        # scupper rust streaks
        wx.rust_streak(u(wz), v(2.45), 40 + (int(wz) % 3) * 14, width=3.0,
                       strength=0.55)
    wx.mud_band((zone.rect[0], int(v(0.9)), zone.rect[2], int(v(-0.4))),
                0.55, fade=None, spatter=True)    # waterline scum
    sx0, sy0, sx1, sy1 = L.S_RACK_FACE.rect
    wx.soot_patch((sx0, sy0, sx1, sy1), 0.5)      # back-blast soot
    tx0, ty0, tx1, ty1 = L.S_TUBE
    wx.soot_patch((tx0, ty0, tx0 + (tx1 - tx0) // 4, ty1), 0.7)
    PL.finish(m, L, 'ms_arsenal_barge', wx=wx)


if __name__ == '__main__':
    paint_all()
