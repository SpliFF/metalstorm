"""paint_ms_ships_s1 — 2048 PBR set for ms_ships_s1 (patrol boat flotilla).

Order register: uniform haze-grey topsides over a black boot-top and oxide
anti-foul, hull number `24` stencilled on the bow flare, draft marks at the
stem, scupper rust streaks and a waterline scum band, spray erosion where
the bow knuckle throws water. Team colour appears ONLY on two small ID
panels (wheelhouse side + roof plinth) via paintlib.team_panel(base=...).
Wheelhouse window band is lit amber (instrument glow); nav beacon amber.
No funnel, no soot stack — the s1 hull has none.
"""
from __future__ import annotations
import numpy as np

import ms_ships_s1_layout as L   # sets meshlib.ATLAS = 2048
import paint as Pnt
Pnt.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, YELLOW, BLACKISH, AO_BASE, AO_DEEP,
                   R_ARMOR, M_ARMOR)
import paintlib as PL

W = 2048
HAZE     = (134, 140, 147)      # topside haze grey (Order finish)
ANTIFOUL = (94, 50, 42)         # oxide red below the waterline
BOOT     = (25, 27, 30)         # boot-top band
DECKC    = (96, 101, 108)         # deck steel
WHC      = (140, 146, 153)      # wheelhouse
TEAMBASE = (132, 136, 141)      # hull-matched base under team panels
DRUMC    = (74, 94, 72)         # od-green drums
CRATEC   = (104, 96, 78)        # timber crates
TARPC    = (86, 92, 84)         # lashed tarp
HULLNO   = '24'


# ── hull ────────────────────────────────────────────────────────────────

def paint_hull(m):
    zone = L.S_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)

    # plated strakes + transverse frame seams (tone-on-tone)
    for wy in (0.55, 1.05, 1.45):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), HAZE, hi=False)
    for wz in np.arange(-8.4, 10.0, 2.4):
        seam_v(m, int(u(wz)), int(v(1.75)), int(v(0.3)), HAZE, hi=False)

    # chine knuckle shadow line (the hard-chine read, follows the spray rail)
    m.d.rectangle([x0, v(0.06), x1, v(-0.02)], fill=shade(HAZE, 0.82))

    # boot-top straddling Y=0, anti-foul below
    m.d.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, v(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))

    # rub strake shadow just under the sheer
    m.d.rectangle([x0, v(1.62), x1, v(1.54)], fill=shade(HAZE, 0.80))

    # bow spray erosion: bare, scoured metal at the forward knuckle
    for i, wz in enumerate(np.arange(-9.8, -6.0, 0.55)):
        t = 1.0 - (wz + 9.8) / 4.2
        m.d.polygon([(u(wz), v(0.55 + 0.25 * t)), (u(wz + 0.45), v(0.62)),
                     (u(wz + 0.30), v(0.05)), (u(wz), v(0.02))],
                    fill=shade(HAZE, 1.0 + 0.12 * t))

    # hull number stencil on the bow flare
    fh = PL.font(60)
    m.d.text((u(-7.9) + 3, v(1.42) + 3), HULLNO, font=fh,
             fill=shade(HAZE, 0.5))
    m.d.text((u(-7.9), v(1.42)), HULLNO, font=fh, fill=(216, 220, 224))

    # draft marks at the stem (small ticks + numerals above the boot-top)
    fd = PL.font(20)
    for k, wy in enumerate((0.55, 0.90, 1.25)):
        m.d.rectangle([u(-9.5), v(wy), u(-9.5) + 16, v(wy) + 4],
                      fill=(206, 210, 214))
        m.d.text((u(-9.5) + 22, v(wy) - 8), str(k + 1), font=fd,
                 fill=(206, 210, 214))

    # scupper mouths every ~4 m along the sheer (rust source below each)
    for wz in np.arange(-6.0, 9.5, 3.8):
        m.d.rectangle([u(wz), v(1.50), u(wz) + 12, v(1.42)],
                      fill=shade(HAZE, 0.45))

    wear_edges(m, (x0, int(v(1.75)), x1, int(v(0.3))), HAZE, 38)

    # belly: anti-foul with keel/strake lines
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.92), ao=AO_BASE - 25, rough=220,
         metal=15)
    for fx in (0.30, 0.50, 0.70):
        seam_v(m, int(r[0] + (r[2] - r[0]) * fx), r[1] + 3, r[3] - 3,
               ANTIFOUL, hi=False)


def paint_deck(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200,
         metal=95)
    u, v = PL.zone_fns(zone)
    for wz in np.arange(-9.4, 10.0, 1.15):        # transverse tread strips
        m.d.line([(u(wz), y0 + 2), (u(wz), y1 - 2)],
                 fill=shade(DECKC, 0.88), width=2)
    for wx in (-2.0, 2.0):                        # side walk lanes
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(DECKC, 0.76), width=3)
    # non-skid patch around the gun tub and the aft working area
    m.d.rectangle([u(-7.6), v(-1.45), u(-4.4), v(1.45)],
                  fill=shade(DECKC, 0.92))
    m.d.rectangle([u(4.2), v(-2.05), u(9.4), v(2.05)],
                  fill=shade(DECKC, 0.94))
    # hazard edging fore and aft of the tub
    for wz0, wz1 in ((-7.9, -7.65), (-4.35, -4.10)):
        m.d.rectangle([u(wz0), v(-1.5), u(wz1), v(1.5)], fill=jit(YELLOW, 6))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 55)


def paint_transom(m):
    zone = L.S_STERN                     # x window is REVERSED -> use nbox
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    m.d.rectangle(PL.nbox(x0, v(L.WATERLINE[1]), x1, v(L.WATERLINE[0])),
                  fill=BOOT)
    m.d.rectangle(PL.nbox(x0, v(L.WATERLINE[0]), x1, y1), fill=ANTIFOUL)
    # waterjet tunnel mouths: dark recesses ringed on the transom plate
    for (jx, jy) in L.JETS:
        r = L.JET_R
        m.d.ellipse(PL.nbox(u(jx - r), v(jy + r), u(jx + r), v(jy - r)),
                    fill=(30, 32, 35), outline=shade(HAZE, 0.55), width=3)
    # hull number repeated on the transom
    f = PL.font(40)
    tw = m.d.textlength(HULLNO, font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2 + 2, y0 + 26 + 2), HULLNO, font=f,
             fill=shade(HAZE, 0.5))
    m.d.text(((x0 + x1) / 2 - tw / 2, y0 + 26), HULLNO, font=f,
             fill=(216, 220, 224))
    bolts(m, [(x0 + 18, y0 + 18), (x1 - 18, y0 + 18)], base=HAZE)


# ── wheelhouse ──────────────────────────────────────────────────────────

def _window_band(m, zone, wy0, wy1, mullions, inset):
    x0, y0, x1, y1 = zone.rect
    u, v = PL.zone_fns(zone)
    a, b = sorted((v(wy0), v(wy1)))
    box = (x0 + inset, a, x1 - inset, b)
    PL.glass_rect(m, box, outline=WHC)
    m.e.rectangle([box[0] + 4, box[1] + 3, box[2] - 4, box[3] - 3],
                  fill=(158, 116, 62))          # amber instrument glow
    for i in range(1, mullions):
        gx = box[0] + (box[2] - box[0]) * i / mullions
        m.d.rectangle([gx - 2, a, gx + 2, b], fill=shade(WHC, 0.68))
        m.e.rectangle([gx - 2, a, gx + 2, b], fill=(0, 0, 0))
    return u, v


def paint_wheelhouse(m):
    # port/starboard: wrap-around glazed band + door aft + small ID panel
    zone = L.S_WH_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WHC, ao=AO_BASE - 4)
    u, v = _window_band(m, zone, 2.95, 2.42, 4, 12)
    du = u(1.35)
    m.d.rectangle(PL.nbox(du - 20, v(1.55), du + 20, v(2.34)),
                  fill=(56, 60, 66), outline=shade(WHC, 0.6), width=2)
    # small team ID panel forward on the house side
    pu = u(-1.05)
    PL.team_panel(m, (pu, v(2.30), pu + 46, v(1.80)), outline=WHC,
                  base=TEAMBASE)
    wear_edges(m, (x0, y0, x1, y1), WHC, 25)

    # fore/aft faces: windscreen band (x window REVERSED -> nbox inside)
    zone = L.S_WH_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WHC, ao=AO_BASE - 4)
    _window_band(m, zone, 2.98, 2.40, 3, 14)
    wear_edges(m, (x0, y0, x1, y1), WHC, 25)

    # roof: walk lanes + a second small ID panel
    zone = L.S_WH_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(WHC, 0.93), ao=AO_BASE - 8,
         rough=195, metal=90)
    u, v = PL.zone_fns(zone)
    PL.team_panel(m, (u(-0.55), v(1.35), u(0.55), v(0.85)), outline=WHC,
                  base=TEAMBASE)
    bolts(m, [(x0 + 16, y0 + 16), (x1 - 16, y0 + 16), (x0 + 16, y1 - 16),
              (x1 - 16, y1 - 16)], base=WHC)


# ── fittings ────────────────────────────────────────────────────────────

def paint_fittings(m):
    # gun tub: splinter shield with a painted rim stripe
    zone = L.S_TUB
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(96, 101, 108), ao=AO_BASE - 8, rough=190,
         metal=120)
    u, v = PL.zone_fns(zone)
    m.d.rectangle(PL.nbox(x0, v(L.TUB_TOP), x1, v(L.TUB_TOP - 0.10)),
                  fill=shade((96, 101, 108), 0.62))
    for i in range(1, 8):                  # vertical stiffener ribs
        gx = x0 + (x1 - x0) * i / 8
        m.d.rectangle([gx - 3, y0 + 4, gx + 3, y1 - 4],
                      fill=shade((96, 101, 108), 0.86))
    wear_edges(m, (x0, y0, x1, y1), (96, 101, 108), 30)

    r = L.S_TUB_FLOOR.rect
    fill(m, r, dif=(70, 74, 80), ao=AO_BASE - 12, rough=185, metal=120)
    m.d.ellipse([r[0] + 10, r[1] + 10, r[2] - 10, r[3] - 10],
                outline=jit(YELLOW, 6), width=4)

    r = L.S_TURRET.rect
    fill(m, r, dif=(90, 95, 102), ao=AO_BASE - 8, rough=175, metal=140)
    seam_h(m, r[0] + 4, r[2] - 4, (r[1] + r[3]) // 2, (90, 95, 102),
           hi=False)
    bolts(m, [(r[0] + 22, r[1] + 22), (r[2] - 22, r[1] + 22)],
          base=(90, 95, 102))

    # parametric wraps
    fill(m, L.S_BARREL, dif=(48, 50, 54), ao=AO_BASE - 12, rough=150,
         metal=180)
    fill(m, L.S_MAST, dif=(98, 102, 108), ao=AO_BASE - 10, rough=150,
         metal=170)
    fill(m, L.S_RAIL, dif=(106, 110, 116), ao=AO_BASE - 8, rough=160,
         metal=150)
    fill(m, L.S_JET, dif=(44, 46, 50), ao=AO_DEEP, rough=205, metal=90)

    # trim boxes (winch, nav radar, roof plinth)
    r = L.S_TRIM.rect
    fill(m, r, dif=(60, 64, 70), ao=AO_BASE - 12, rough=165, metal=150)
    seam_h(m, r[0] + 4, r[2] - 4, (r[1] + r[3]) // 2, (60, 64, 70), hi=False)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)

    # nav beacon: amber
    r = L.S_LIGHT.rect
    fill(m, r, dif=(60, 52, 40), ao=AO_BASE - 8, rough=130, metal=120)
    m.e.rectangle([r[0] + 12, r[1] + 12, r[2] - 12, r[3] - 12],
                  fill=(255, 176, 80))

    # aft stowage: crates over tarp, drums
    r = L.S_RACK.rect
    fill(m, r, dif=CRATEC, ao=AO_BASE - 10, rough=215, metal=25)
    m.d.rectangle([r[0], r[1] + (r[3] - r[1]) // 2, r[2], r[3]], fill=TARPC)
    for fx in (0.25, 0.5, 0.75):
        sx = int(r[0] + (r[2] - r[0]) * fx)
        m.d.line([(sx, r[1] + 4), (sx, r[3] - 4)], fill=shade(CRATEC, 0.76),
                 width=3)
    r = L.S_DRUM.rect
    fill(m, r, dif=DRUMC, ao=AO_BASE - 10, rough=190, metal=60)
    m.d.rectangle([r[0], r[1] + 26, r[2], r[1] + 42], fill=shade(DRUMC, 0.78))
    m.d.rectangle([r[0], r[3] - 42, r[2], r[3] - 26], fill=shade(DRUMC, 0.78))


# ── assembly ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_transom(m)
    paint_wheelhouse(m)
    paint_fittings(m)

    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_HULL_SIDE,), seed=90210,
                             mud=0.24, grime=0.34, rust_fraction=0.4)
    zone = L.S_HULL_SIDE
    u, v = PL.zone_fns(zone)
    x0, y0, x1, y1 = zone.rect
    # rust streaks running down from the scuppers and deck fittings
    for wz in np.arange(-6.0, 9.5, 3.8):
        wx.rust_streak(u(wz) + 6, v(1.44), 34, width=2.6, strength=0.42)
    for wz in (-8.3, -3.2, 1.0, 6.4):
        wx.rust_streak(u(wz), v(1.58), 22, width=2.0, strength=0.30)
    # waterline scum band + light deck grime
    wx.mud_band((x0, int(v(0.55)), x1, int(v(-0.45))), 0.48, fade=None,
                spatter=True)
    wx.mud_band(L.S_DECK.rect, 0.16, fade=None, spatter=False)

    from normals import HeightMap
    hm = HeightMap()
    for wy in (0.55, 1.05, 1.45):
        hm.line((x0 + 2, v(wy)), (x1 - 2, v(wy)), -0.4, width=2)
    for wz in np.arange(-8.4, 10.0, 2.4):
        hm.line((u(wz), v(1.75)), (u(wz), v(0.3)), 0.3, width=2)
    ud, vd = PL.zone_fns(L.S_DECK)
    dr = L.S_DECK.rect
    for wz in np.arange(-9.4, 10.0, 1.15):
        hm.line((ud(wz), dr[1] + 2), (ud(wz), dr[3] - 2), 0.3, width=2)

    PL.finish(m, L, 'ms_ships_s1', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
