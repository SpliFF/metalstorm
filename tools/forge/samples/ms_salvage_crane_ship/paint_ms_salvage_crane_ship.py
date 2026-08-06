"""paint_ms_salvage_crane_ship — 2048² PBR set (no team colour).

Scavenger-industry scheme: patchwork-plated rust-and-primer hull over a
black boot-top and oxide anti-foul, oil-stained work deck with painted
crane-swing hazard arcs, ochre lattice crane with black hazard banding
at the boom tip, cable-grey rigging, workshop cabin with lit windows,
torch head with a hot emissive tip, scrap heap in mixed oxidised tones
(tone-on-tone for the impostor baker). Heavy rust weathering.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFont

import ms_salvage_crane_ship_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, YELLOW, BLACKISH, AO_BASE, AO_DEEP,
                   R_ARMOR, R_STEEL, M_ARMOR, M_STEEL)
import paintlib as PL

W = 2048
HULL = (104, 92, 80)            # weathered work-steel
PRIMER = (122, 84, 62)          # red-primer patch tone (±15% family)
RUSTY = (94, 74, 58)
ANTIFOUL = (88, 50, 42)
BOOT = (30, 31, 34)
DECKC = (78, 76, 70)
OCHRE = (158, 122, 52)          # crane ochre
CABIN = (96, 100, 96)
WARM = (255, 190, 120)
TORCH = (255, 210, 150)


def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HULL, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    # patchwork plating, tone-on-tone (baker flat-shades big quads)
    PL.panel_patchwork(m, (x0, y0, x1, int(v(L.WATERLINE[1]))),
                       [HULL, PRIMER, RUSTY, shade(HULL, 1.08)],
                       cols=10, rows=3)
    # boot-top + anti-foul
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))
    # hand-painted hull marking
    fh = PL.font(44)
    m.d.text((u(-11.0) + 2, v(2.2) + 2), 'SV-7', font=fh,
             fill=shade(HULL, 0.5))
    m.d.text((u(-11.0), v(2.2)), 'SV-7', font=fh, fill=(202, 196, 180))
    wear_edges(m, (x0, y0, x1, int(v(L.WATERLINE[1]))), HULL, 60)

    # belly
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.92), ao=AO_BASE - 25, rough=220,
         metal=15)

    # bow / stern faces
    for zone in (L.S_BOW, L.S_STERN):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=HULL, ao=AO_BASE - 8, rough=R_ARMOR,
             metal=M_ARMOR)
        _, vv = PL.zone_fns(zone)
        m.d.rectangle([x0, vv(L.WATERLINE[1]), x1, vv(L.WATERLINE[0])],
                      fill=BOOT)
        m.d.rectangle([x0, vv(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
        wear_edges(m, (x0, y0, x1, int(vv(L.WATERLINE[1]))), HULL, 45)
    # stern hazard band under the boom overhang
    x0, y0, x1, y1 = L.S_STERN.rect
    PL.hazard_band(m, (x0 + 6, y0 + 6, x1 - 6, y0 + 26))


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200, metal=95)
    u, v = PL.zone_fns(zone)
    # plate seams
    for wz in np.arange(-22.0, 25.0, 3.4):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, DECKC, hi=False)
    for wx in (-3.4, 0.0, 3.4):
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(DECKC, 0.85), width=2)
    # crane working-area hazard border (aft deck under the boom)
    PL.hazard_band(m, (int(u(8.5)), y0 + 4, int(u(9.3)), y1 - 4))
    # painted keep-clear text under the trolley run
    ft = PL.font(30)
    m.d.text((u(15.0), v(-0.6)), 'KEEP CLEAR', font=ft,
             fill=jit(YELLOW, 8))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 85)

    # cabin
    for zone in (L.S_CABIN_S, L.S_CABIN_F):
        cx0, cy0, cx1, cy1 = zone.rect
        fill(m, (cx0, cy0, cx1, cy1), dif=CABIN, ao=AO_BASE - 6, rough=185,
             metal=110)
        wy0 = cy0 + (cy1 - cy0) * 0.22
        wy1 = cy0 + (cy1 - cy0) * 0.46
        for i in range(4):
            gx = cx0 + 16 + (cx1 - cx0 - 32) * i / 4
            gx1 = gx + (cx1 - cx0 - 32) / 4 - 10
            PL.glass_rect(m, (gx, wy0, gx1, wy1))
            if i in (0, 2):
                m.e.rectangle([gx + 3, wy0 + 3, gx1 - 3, wy1 - 3], fill=WARM)
        m.d.rectangle([cx1 - 44, cy1 - 70, cx1 - 14, cy1 - 8],
                      fill=(50, 52, 56), outline=shade(CABIN, 0.6), width=2)
        wear_edges(m, (cx0, cy0, cx1, cy1), CABIN, 35)
    r = L.S_CABIN_R.rect
    fill(m, r, dif=shade(CABIN, 0.9), ao=AO_BASE - 8, rough=195, metal=90)
    bolts(m, [(r[0] + 14, r[1] + 14), (r[2] - 14, r[1] + 14),
              (r[0] + 14, r[3] - 14), (r[2] - 14, r[3] - 14)],
          base=shade(CABIN, 0.9))

    # scrap heap: mixed oxidised patchwork (tone-on-tone)
    r = L.S_SCRAP.rect
    fill(m, r, dif=RUSTY, ao=AO_BASE - 18, rough=225, metal=60)
    PL.panel_patchwork(m, r, [RUSTY, shade(RUSTY, 1.12), PRIMER,
                              shade(HULL, 0.9)], cols=6, rows=4)
    # salvaged turret shell: scorched military green showing through
    r = L.S_TURRET.rect
    fill(m, r, dif=(78, 84, 66), ao=AO_BASE - 15, rough=210, metal=80)
    PL.panel_patchwork(m, r, [(78, 84, 66), (70, 74, 60), RUSTY], cols=3,
                       rows=3)


def paint_gear(m):
    # lattice + boom: work-crane ochre
    for r in (L.S_LATTICE, L.S_BOOM):
        fill(m, r, dif=OCHRE, ao=AO_BASE - 8, rough=180, metal=130)
        x0, y0, x1, y1 = r
        for fy in (0.3, 0.7):
            yy = int(y0 + (y1 - y0) * fy)
            m.d.rectangle([x0, yy - 4, x1, yy + 4], fill=shade(OCHRE, 0.82))
    # boom-tip / hazard extremity banding lives in S_DARK cells
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    # rails: safety yellow, worn
    fill(m, L.S_RAIL, dif=jit(YELLOW, 6), ao=AO_BASE - 8, rough=175,
         metal=120)
    # cables/stays: greased steel
    fill(m, L.S_CABLE, dif=(58, 56, 52), ao=AO_BASE - 14, rough=120,
         metal=200)
    # masts/posts/stack
    fill(m, L.S_MAST, dif=(90, 88, 82), ao=AO_BASE - 10, rough=170, metal=150)

    # trolley carriage: ochre with black chevron
    r = L.S_TROLLEY.rect
    fill(m, r, dif=OCHRE, ao=AO_BASE - 8, rough=175, metal=140)
    PL.hazard_band(m, (r[0] + 8, r[3] - 30, r[2] - 8, r[3] - 10))
    # hook block: hazard-striped
    r = L.S_HOOK.rect
    fill(m, r, dif=jit(YELLOW, 5), ao=AO_BASE - 10, rough=170, metal=150)
    PL.hazard_band(m, (r[0] + 6, r[1] + 6, r[2] - 6, r[1] + 40))
    # torch head: dark body, hot emissive tip
    r = L.S_TORCH.rect
    fill(m, r, dif=(48, 46, 44), ao=AO_BASE - 12, rough=140, metal=170)
    m.e.rectangle([r[0] + 30, r[1] + 30, r[2] - 30, r[3] - 30], fill=TORCH)

    # crates + drums
    r = L.S_CRATE.rect
    fill(m, r, dif=(96, 88, 70), ao=AO_BASE - 10, rough=210, metal=30)
    x0, y0, x1, y1 = r
    m.d.rectangle([x0, y0 + (y1 - y0) // 2 - 4, x1, y0 + (y1 - y0) // 2 + 4],
                  fill=shade((96, 88, 70), 0.8))
    r = L.S_DRUM.rect
    fill(m, r, dif=(70, 78, 88), ao=AO_BASE - 10, rough=190, metal=120)
    m.d.rectangle([r[0], r[1] + 20, r[2], r[1] + 34],
                  fill=shade((70, 78, 88), 0.75))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_gear(m)

    # weathering: heavy salvage-yard rust
    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_HULL_SIDE,),
                             seed=90210, mud=0.45, grime=0.6,
                             rust_fraction=0.7)
    u, v = PL.zone_fns(L.S_HULL_SIDE)
    for wz in np.arange(-22.0, 24.0, 3.8):      # scupper rust from deck edge
        wx.rust_streak(u(wz), v(2.55), 40 + (int(wz) % 3) * 14, width=3.0,
                       strength=0.55)
    wx.mud_band((L.S_HULL_SIDE.rect[0], int(v(0.9)),
                 L.S_HULL_SIDE.rect[2], int(v(-0.5))), 0.6, fade=None,
                spatter=True)                    # waterline scum
    wx.mud_band(L.S_DECK.rect, 0.35, fade=None, spatter=True)
    for (fx, fy) in ((0.55, 0.5), (0.75, 0.4)):  # deck oil under the boom run
        r = L.S_DECK.rect
        wx.oily((int(r[0] + (r[2] - r[0]) * fx), r[1] + 30,
                 int(r[0] + (r[2] - r[0]) * (fx + 0.12)), r[3] - 30), 0.5)
    wx.soot_patch(L.S_TORCH.rect, 0.6)           # torch soot
    sx0, sy0, sx1, sy1 = L.S_SCRAP.rect
    wx.mud_band((sx0, sy0, sx1, sy1), 0.4, fade=None, spatter=True)

    PL.finish(m, L, 'ms_salvage_crane_ship', wx=wx)


if __name__ == '__main__':
    paint_all()
