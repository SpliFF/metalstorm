"""paint_ms_dreadnought — 2048² PBR set for ms_dreadnought (Leviathan).

Anarchic salvage register: three mismatched hull plating bands
(panel_patchwork) over a black boot-top and oxide anti-foul, riveted
ram prow, scrap-patch superstructure with a lit bridge slit, soot-caped
funnels with a team band, dark iron trophy chains and battered trophy
plates, crude white war-glyphs, heavy rust/soot/scum weathering.
Team colour ONLY in the mask: battle standard panel + funnel band.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_dreadnought_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade, jit,
                   BOLT_LOG, TEAMGREY, GLASS, BLACKISH,
                   AO_BASE, AO_DEEP, R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 2048
# tone-on-tone scrap palette (±15% — impostor baker flat-shades big quads)
SCRAP = [(108, 96, 84), (98, 94, 90), (114, 102, 78), (92, 85, 78),
         (105, 87, 68), (100, 100, 98), (112, 105, 93)]
HULLBASE = (100, 92, 82)
BOOT = (30, 32, 34)
ANTIFOUL = (96, 56, 47)
DECKC = (96, 90, 82)
IRON = (44, 45, 48)
STEELC = (96, 100, 106)
BONE = (196, 188, 172)      # crude war-paint glyphs
WARM = (255, 186, 110)


def paint_hull(m):
    z = L.S_HULL
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=HULLBASE, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    # three welded plating bands from three donor hulls (mismatched runs)
    PL.panel_patchwork(m, (x0, v(4.6), x1, v(3.2)), SCRAP, cols=14, rows=1,
                       bolt_every=2, seed=90210)
    PL.panel_patchwork(m, (x0, v(3.2), x1, v(1.7)), SCRAP, cols=9, rows=1,
                       bolt_every=3, seed=90211)
    PL.panel_patchwork(m, (x0, v(1.7), x1, v(0.45)), SCRAP, cols=11, rows=1,
                       bolt_every=2, seed=90212)
    # sheer strake above the top band
    m.d.rectangle([x0, y0, x1, v(4.6)], fill=shade(HULLBASE, 0.9))
    seam_h(m, x0 + 2, x1 - 2, int(v(4.6)), HULLBASE, hi=False)
    # boot-top + anti-foul below the waterline (Y=0)
    m.d.rectangle([x0, v(L.BOOTTOP[1]), x1, v(L.BOOTTOP[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.BOOTTOP[1]), x1, v(L.BOOTTOP[0])],
                  fill=(AO_BASE - 15, 205, 30))
    m.d.rectangle([x0, v(L.BOOTTOP[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.BOOTTOP[0]), x1, y1], fill=(AO_BASE - 20, 218, 20))
    # weld seams between the three donor sections
    for wz in (-11.0, 14.0):
        seam_v(m, int(u(wz)), int(v(5.6)), int(v(L.BOOTTOP[1])), HULLBASE,
               hi=False)
        m.d.rectangle([u(wz) - 3, v(5.6), u(wz) + 3, v(L.BOOTTOP[1])],
                      fill=(58, 52, 46))
    # crude ship name amidships
    f = PL.font(40)
    m.d.text((u(-6.5) + 2, v(5.35) + 2), 'LEVIATHAN', font=f,
             fill=shade(HULLBASE, 0.45))
    m.d.text((u(-6.5), v(5.35)), 'LEVIATHAN', font=f, fill=BONE)
    wear_edges(m, (x0, y0, x1, int(v(L.BOOTTOP[1]))), HULLBASE, 70)

    # belly
    r = L.S_BELLY.rect
    fill(m, r, dif=shade(ANTIFOUL, 0.92), ao=AO_BASE - 25, rough=222,
         metal=15)
    for fx in (0.3, 0.55, 0.8):
        seam_v(m, int(r[0] + (r[2] - r[0]) * fx), r[1] + 3, r[3] - 3,
               ANTIFOUL, hi=False)


def paint_deck(m):
    z = L.S_DECK
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 10, rough=200, metal=90)
    # low-contrast plate patchwork (big quads — keep tone-on-tone)
    PL.panel_patchwork(m, (x0, y0 + 6, x1, y1 - 6),
                       [shade(DECKC, 1.06), DECKC, shade(DECKC, 0.94),
                        shade(DECKC, 1.10)], cols=16, rows=3, bolt_every=4,
                       seed=90213)
    # transverse plank seams
    for wz in np.arange(-34.0, 37.0, 4.0):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, DECKC, hi=False)
    # crude white war-glyph on the foredeck + stripes on the ram approach
    PL.roundel_star(m, u(-30.0), v(0.0), 42, BONE)
    for wz in np.arange(-36.5, -34.0, 0.9):
        m.d.rectangle([u(wz), v(-0.8), u(wz + 0.45), v(0.8)],
                      fill=jit(BONE, 12))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 45)


def paint_ends(m):
    for zone, name in ((L.S_BOW, None), (L.S_STERN, 'LEVIATHAN')):
        x0, y0, x1, y1 = zone.rect
        u, v = PL.zone_fns(zone)
        fill(m, (x0, y0, x1, y1), dif=shade(HULLBASE, 0.97), ao=AO_BASE - 8,
             rough=R_ARMOR, metal=M_ARMOR)
        b = PL.nbox(x0, v(L.BOOTTOP[1]), x1, v(L.BOOTTOP[0]))
        m.d.rectangle(b, fill=BOOT)
        m.d.rectangle(PL.nbox(x0, v(L.BOOTTOP[0]), x1, y1), fill=ANTIFOUL)
        seam_h(m, x0 + 2, x1 - 2, int(v(3.2)), HULLBASE, hi=False)
        if name:
            f = PL.font(30)
            tw = m.d.textlength(name, font=f)
            m.d.text(((x0 + x1) / 2 - tw / 2, v(3.9)), name, font=f,
                     fill=BONE)
            bolts(m, [(x0 + 14, y0 + 12), (x1 - 14, y0 + 12)], base=HULLBASE)
        wear_edges(m, (x0, y0, x1, y1), HULLBASE, 60)

    # riveted ram
    zone = L.S_RAM
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(74, 70, 68), ao=AO_BASE - 12, rough=180,
         metal=150)
    for fy in (0.25, 0.5, 0.75):
        yy = int(y0 + (y1 - y0) * fy)
        seam_h(m, x0 + 2, x1 - 2, yy, (74, 70, 68), hi=False)
        bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 7), yy - 6)
                  for i in range(8)], base=(74, 70, 68))
    wear_edges(m, (x0, y0, x1, y1), (74, 70, 68), 90)


def paint_super(m):
    for zone in (L.S_SUP_S, L.S_SUP_F):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=(97, 93, 87), ao=AO_BASE - 8,
             rough=R_ARMOR, metal=M_ARMOR)
        PL.panel_patchwork(m, (x0 + 3, y0 + 3, x1 - 3, y1 - 3), SCRAP,
                           cols=8 if zone is L.S_SUP_S else 5, rows=3,
                           bolt_every=2, seed=90214)
        wear_edges(m, (x0, y0, x1, y1), (97, 93, 87), 50)
    # bridge slit windows on the upper band (front + sides share zones)
    zs = L.S_SUP_S
    us, vs = PL.zone_fns(zs)
    b = PL.nbox(us(1.4), vs(11.1), us(6.2), vs(10.5))
    PL.glass_rect(m, b, outline=(40, 40, 42))
    for i in (0, 2):
        gx0 = b[0] + (b[2] - b[0]) * i / 3
        m.e.rectangle([gx0 + 3, b[1] + 3, gx0 + (b[2] - b[0]) / 3 - 3,
                       b[3] - 3], fill=(150, 108, 58))
    zf = L.S_SUP_F
    uf, vf = PL.zone_fns(zf)
    b = PL.nbox(uf(-2.6), vf(11.1), uf(2.6), vf(10.5))
    PL.glass_rect(m, b, outline=(40, 40, 42))
    m.e.rectangle([b[0] + 6, b[1] + 3, b[0] + 40, b[3] - 3],
                  fill=(150, 108, 58))
    # tops: dark deck steel with walk lanes
    zone = L.S_SUP_T
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DECKC, 0.92), ao=AO_BASE - 10,
         rough=200, metal=90)
    for fx in (0.3, 0.7):
        m.d.line([(x0 + (x1 - x0) * fx, y0 + 4), (x0 + (x1 - x0) * fx,
                                                  y1 - 4)],
                 fill=shade(DECKC, 0.8), width=3)
    wear_edges(m, (x0, y0, x1, y1), shade(DECKC, 0.92), 50)


def paint_turret(m):
    for zone, cols in ((L.S_TUR_S, 4), (L.S_TUR_F, 3)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=(96, 90, 82), ao=AO_BASE - 10,
             rough=R_ARMOR, metal=M_ARMOR)
        PL.panel_patchwork(m, (x0 + 3, y0 + 3, x1 - 3, y1 - 3), SCRAP,
                           cols=cols, rows=2, bolt_every=2, seed=90215)
        wear_edges(m, (x0, y0, x1, y1), (96, 90, 82), 70)
    zone = L.S_TUR_T
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(92, 88, 80), ao=AO_BASE - 8,
         rough=R_ARMOR, metal=M_ARMOR)
    m.d.ellipse([(x0 + x1) / 2 - 40, (y0 + y1) / 2 - 40,
                 (x0 + x1) / 2 + 40, (y0 + y1) / 2 + 40],
                outline=shade((92, 88, 80), 0.7), width=4)
    # crude kill tallies
    f = PL.font(26)
    m.d.text((x0 + 20, y0 + 16), 'IIII IIII II', font=f, fill=BONE)
    wear_edges(m, (x0, y0, x1, y1), (92, 88, 80), 60)
    # mantlet: near-black armour
    r = L.S_MANTLET.rect
    fill(m, r, dif=(56, 54, 52), ao=AO_BASE - 14, rough=185, metal=160)
    seam_h(m, r[0] + 3, r[2] - 3, (r[1] + r[3]) // 2, (56, 54, 52), hi=False)
    # barrels: steel wrap, dark collars at both rect ends (muzzle soot)
    x0, y0, x1, y1 = L.S_BARREL
    fill(m, (x0, y0, x1, y1), dif=(88, 90, 94), ao=AO_BASE - 8, rough=160,
         metal=190)
    m.d.rectangle([x1 - 30, y0, x1, y1], fill=(40, 40, 42))
    m.d.rectangle([x0, y0, x0 + 30, y1], fill=(40, 40, 42))
    m.d.rectangle([x0 + 70, y0, x0 + 84, y1], fill=shade((88, 90, 94), 0.75))
    fill(m, L.S_TUBECAP.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=60)


def paint_fittings(m):
    # funnels: dark iron, team band mid, soot cap at the top (u = x1 end)
    x0, y0, x1, y1 = L.S_FUNNEL
    fill(m, (x0, y0, x1, y1), dif=(58, 60, 64), ao=AO_BASE - 10, rough=185,
         metal=150)
    PL.team_panel(m, (x0 + int((x1 - x0) * 0.55), y0,
                      x0 + int((x1 - x0) * 0.72), y1),
                  outline=shade((58, 60, 64), 0.6))
    m.d.rectangle([x1 - int((x1 - x0) * 0.16), y0, x1, y1], fill=(34, 34, 36))
    for fy in (0.33, 0.66):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), (58, 60, 64),
               hi=False)
    # masts / posts / crane steel
    x0, y0, x1, y1 = L.S_MAST
    fill(m, (x0, y0, x1, y1), dif=STEELC, ao=AO_BASE - 10, rough=155,
         metal=170)
    m.d.rectangle([x1 - 22, y0, x1, y1], fill=shade(STEELC, 0.7))
    # chains: near-black iron with link speckle
    x0, y0, x1, y1 = L.S_CHAIN
    fill(m, (x0, y0, x1, y1), dif=IRON, ao=AO_BASE - 16, rough=205, metal=140)
    rng = np.random.default_rng(90210)
    for _ in range(60):
        px = int(rng.integers(x0 + 2, x1 - 2))
        py = int(rng.integers(y0 + 2, y1 - 2))
        m.d.rectangle([px, py, px + 3, py + 2], fill=shade(IRON, 1.35))
    # trophy plates: battered shields with crude marks
    zone = L.S_TROPHY
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(70, 64, 56), ao=AO_BASE - 12, rough=195,
         metal=120)
    PL.panel_patchwork(m, (x0 + 2, y0 + 2, x1 - 2, y1 - 2),
                       [(70, 64, 56), (80, 70, 54), (62, 60, 58)], cols=3,
                       rows=2, bolt_every=1, seed=90216)
    PL.roundel_star(m, (x0 + x1) / 2, (y0 + y1) / 2, 22, BONE, ring=False)
    m.d.line([(x0 + 20, y0 + 20), (x1 - 20, y1 - 20)], fill=(46, 42, 40),
             width=5)
    # battle standard: full team panel, ragged fly edge + dark border
    zone = L.S_FLAG
    x0, y0, x1, y1 = zone.rect
    PL.team_panel(m, (x0, y0, x1, y1))
    m.d.rectangle([x0, y0, x1, y1], outline=(38, 36, 34), width=6)
    rng = np.random.default_rng(90217)
    for py in range(y0, y1, 14):     # tattered fly edge (u = x1 = free end)
        wcut = int(rng.integers(4, 26))
        m.d.rectangle([x1 - wcut, py, x1, py + 14], fill=(38, 36, 34)[:3])
        m.t.rectangle([x1 - wcut, py, x1, py + 14], fill=(0, 0, 0))
    PL.roundel_star(m, (x0 + x1) / 2 - 20, (y0 + y1) / 2, 44, (30, 28, 26))
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=205, metal=50)
    # generic scrap trim plate zone
    zone = L.S_PLATE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(76, 72, 66), ao=AO_BASE - 12, rough=190,
         metal=110)
    PL.panel_patchwork(m, (x0 + 2, y0 + 2, x1 - 2, y1 - 2), SCRAP, cols=6,
                       rows=3, bolt_every=3, seed=90218)
    # barbettes: ring courses + bolts
    zone = L.S_BARB
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(84, 80, 74), ao=AO_BASE - 10,
         rough=R_ARMOR, metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, (84, 80, 74), hi=False)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 9), y0 + 14)
              for i in range(10)], base=(84, 80, 74))
    wear_edges(m, (x0, y0, x1, y1), (84, 80, 74), 60)
    # crane work lamp + stern lantern glows live on the mast zone
    x0, y0, x1, y1 = L.S_MAST
    m.e.rectangle([x0 + 8, y0 + 8, x0 + 26, y0 + 20], fill=WARM)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_ends(m)
    paint_super(m)
    paint_turret(m)
    paint_fittings(m)

    # ── weathering: heavy anarchic salt/rust/soot ──
    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_SUP_S, L.S_SUP_F),
                             seed=90210, mud=0.3, grime=0.5,
                             rust_fraction=0.65)
    z = L.S_HULL
    u, v = PL.zone_fns(z)
    for wz in np.arange(-33.0, 37.0, 4.5):       # scupper rust from the deck edge
        wx.rust_streak(u(wz), v(4.6), 42 + (int(wz) % 3) * 14, width=3.2,
                       strength=0.6)
    wx.plate_bottom_rust((z.rect[0], int(v(5.0)), z.rect[2],
                          int(v(L.BOOTTOP[1]))), n=12, strength=0.55)
    wx.mud_band((z.rect[0], int(v(1.0)), z.rect[2], int(v(-0.6))), 0.55,
                fade=None, spatter=True)          # waterline scum
    wx.mud_band(L.S_RAM.rect, 0.5, fade=None, spatter=True)
    sx0, sy0, sx1, sy1 = L.S_FUNNEL
    wx.soot_patch((sx1 - int((sx1 - sx0) * 0.30), sy0, sx1, sy1), 0.85)
    bx0, by0, bx1, by1 = L.S_BARREL
    wx.soot_patch((bx1 - 60, by0, bx1, by1), 0.7)
    wx.soot_patch((bx0, by0, bx0 + 60, by1), 0.7)
    fl = L.S_DECK.rect
    for (fx, fy) in ((0.30, 0.35), (0.52, 0.6), (0.74, 0.3)):
        wx.oily((int(fl[0] + (fl[2] - fl[0]) * fx), fl[1] + 30,
                 int(fl[0] + (fl[2] - fl[0]) * (fx + 0.1)), fl[3] - 30),
                0.4)

    # ── height → normals: plating courses + weld beads ──
    hm = NM.HeightMap()
    for wy in (4.6, 3.2, 1.7):
        hm.line((z.rect[0] + 2, v(wy)), (z.rect[2] - 2, v(wy)), -0.4, width=2)
    for wz in (-11.0, 14.0):
        hm.line((u(wz), v(5.6)), (u(wz), v(L.BOOTTOP[1])), 0.5, width=4)
    ud, vd = PL.zone_fns(L.S_DECK)
    for wz in np.arange(-34.0, 37.0, 4.0):
        hm.line((ud(wz), L.S_DECK.rect[1] + 2), (ud(wz), L.S_DECK.rect[3] - 2),
                0.3, width=2)

    PL.finish(m, L, 'ms_dreadnought', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
