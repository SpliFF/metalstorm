"""paint_ms_rail_bridge — 2048² PBR set for ms_rail_bridge.

Weathered steel deck-truss read: riveted grey-green steel deck plate
with tread lines and rust bloom, dark ribbed underside, girder webs
with rivet rows, oxide-red bottom chords + truss steel, dark timber
sleepers, rusty rail webs with bright worn heads, stained concrete
piers with a high-water grime line.  No team colour, no emissive
(static unlit feature).  Tileable: all longitudinal cells keep their
pattern continuous end-to-end (jointed at 3 m module lines that land
inside the segment) and low-contrast on large quads (baker quirk).
"""
from __future__ import annotations
import numpy as np

import ms_rail_bridge_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges,
                   jit, shade, BOLT_LOG, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP, R_STEEL, M_STEEL, RNG)

W = 2048
DECKST = (104, 108, 100)      # grey-green deck steel
UNDER = (58, 60, 62)
GIRD = (96, 92, 84)
CHORDR = (112, 62, 46)        # oxide-red truss steel
TIMBER = (48, 42, 36)
RAILWEB = (96, 68, 48)
RAILHEAD = (184, 188, 194)
CONCRETE = (144, 142, 136)


def u_of(zone, wz):
    return zone.uv((0, 0, wz))[0] * W


def v_of(zone, wy):
    return zone.uv((0, wy, 0))[1] * W


def paint_deck(m):
    zone = L.Z_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKST, ao=AO_BASE - 6, rough=185, metal=170)
    # plate joints every 3 m (module lines inside the segment; ends align on tile)
    for wz in np.arange(-9.0, 10.0, 3.0):
        seam_v(m, int(u_of(zone, wz)), y0 + 2, y1 - 2, DECKST, hi=False)
    # low-contrast tread stripes (tone-on-tone for the baker)
    for fy in np.linspace(0.12, 0.88, 6):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.line([(x0, yy), (x1, yy)], fill=jit(shade(DECKST, 0.94), 3), width=2)
    # rivet rows along both edges
    bolts(m, [(x0 + 12 + i * (x1 - x0 - 24) / 30, y0 + 10) for i in range(31)],
          base=DECKST)
    bolts(m, [(x0 + 12 + i * (x1 - x0 - 24) / 30, y1 - 10) for i in range(31)],
          base=DECKST)
    # subtle stain patches
    for _ in range(18):
        bx = x0 + RNG.random() * (x1 - x0 - 80)
        by = y0 + RNG.random() * (y1 - y0 - 30)
        m.d.rectangle([bx, by, bx + 40 + RNG.random() * 50, by + 20],
                      fill=jit(shade(DECKST, 0.95), 3))

    zone = L.Z_UNDER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=UNDER, ao=AO_DEEP + 10, rough=200, metal=140)
    for wz in np.arange(-10.5, 11.0, 1.5):    # rib lines
        seam_v(m, int(u_of(zone, wz)), y0 + 2, y1 - 2, UNDER, hi=False)


def paint_girders(m):
    zone = L.Z_GIRD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=GIRD, ao=AO_BASE - 10, rough=180, metal=160)
    # splice plates at the 3 m module lines with rivet pairs
    for wz in np.arange(-9.0, 10.0, 3.0):
        fu = int(u_of(zone, wz))
        m.d.rectangle([fu - 10, y0 + 6, fu + 10, y1 - 6], fill=shade(GIRD, 1.1))
        bolts(m, [(fu - 5, (y0 + y1) // 2), (fu + 5, (y0 + y1) // 2)], base=GIRD)
    # top flange line
    seam_h(m, x0 + 2, x1 - 2, y0 + 12, GIRD, hi=False)
    bolts(m, [(x0 + 14 + i * (x1 - x0 - 28) / 40, y1 - 10) for i in range(41)],
          base=GIRD)
    wear_edges(m, (x0, y0, x1, y1), GIRD, 45)

    zone = L.Z_KERB
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GIRD, 0.9), ao=AO_BASE - 8, rough=190,
         metal=140)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, shade(GIRD, 0.9), hi=False)

    zone = L.Z_CHORD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CHORDR, ao=AO_BASE - 12, rough=185, metal=150)
    for wz in np.arange(-9.0, 10.0, 3.0):
        fu = int(u_of(zone, wz))
        m.d.rectangle([fu - 8, y0 + 4, fu + 8, y1 - 4], fill=shade(CHORDR, 1.12))
        bolts(m, [(fu, (y0 + y1) // 2)], base=CHORDR)
    wear_edges(m, (x0, y0, x1, y1), CHORDR, 40)


def paint_cells(m):
    # truss member wrap: oxide-red steel, low contrast
    x0, y0, x1, y1 = L.Z_TRUSS.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CHORDR, 1.04), ao=AO_BASE - 10,
         rough=180, metal=150)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, CHORDR, hi=False)
    for _ in range(120):
        gx = x0 + RNG.random() * (x1 - x0)
        gy = y0 + RNG.random() * (y1 - y0)
        m.d.point((gx, gy), fill=jit(CHORDR, 12))
    # dark cell (butt ends, misc)
    fill(m, L.Z_DARK.rect, dif=(40, 40, 42), ao=AO_DEEP, rough=210, metal=60)
    # sleepers: dark creosote timber with grain lines
    x0, y0, x1, y1 = L.Z_SLEEP.rect
    fill(m, (x0, y0, x1, y1), dif=TIMBER, ao=AO_BASE - 14, rough=215, metal=20)
    for _ in range(40):
        sx = x0 + RNG.random() * (x1 - x0 - 60)
        sy = y0 + RNG.random() * (y1 - y0)
        m.d.line([(sx, sy), (sx + 40 + RNG.random() * 20, sy)],
                 fill=jit(shade(TIMBER, 0.85), 6), width=1)


def paint_track(m):
    zone = L.Z_RAIL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=RAILWEB, ao=AO_BASE - 18, rough=185, metal=90)
    for wz in np.arange(-10.8, 11.0, 3.6):    # fishplates
        fu = int(u_of(zone, wz))
        m.d.rectangle([fu - 10, y0 + 8, fu + 10, y1 - 6],
                      fill=shade(RAILWEB, 1.14))
        bolts(m, [(fu - 5, (y0 + y1) // 2), (fu + 5, (y0 + y1) // 2)],
              base=RAILWEB)
    x0, y0, x1, y1 = L.Z_RAILT.rect
    fill(m, (x0, y0, x1, y1), dif=RAILHEAD, ao=AO_BASE, rough=60, metal=225)
    for _ in range(50):
        sx = x0 + RNG.random() * (x1 - x0 - 30)
        sy = y0 + RNG.random() * (y1 - y0)
        m.d.line([(sx, sy), (sx + 24, sy)], fill=shade(RAILHEAD, 1.06), width=1)


def paint_piers(m):
    for zone in (L.Z_PIER, L.Z_PIERT):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 8, rough=210,
             metal=8)
        for _ in range(30):
            bx = x0 + RNG.random() * (x1 - x0 - 70)
            by = y0 + RNG.random() * (y1 - y0 - 20)
            m.d.rectangle([bx, by, bx + 30 + RNG.random() * 40, by + 16],
                          fill=jit(shade(CONCRETE, 0.93), 4))
        wear_edges(m, (x0, y0, x1, y1), CONCRETE, 40)
    zone = L.Z_PIER
    x0, y0, x1, y1 = zone.rect
    # formwork board lines + footing step shadow
    for fy in (0.35, 0.6):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), CONCRETE, hi=False)
    # high-water grime line low on the pier
    gv = int(v_of(zone, 0.35))
    m.d.rectangle([x0, gv, x1, y1], fill=jit(shade(CONCRETE, 0.82), 3))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_cells(m)
    paint_deck(m)
    paint_girders(m)
    paint_track(m)
    paint_piers(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=13)
    wx.crevice_grime(m.dif, 0.5)
    # rust streaks off the deck plate onto girder webs
    gz = L.Z_GIRD.rect
    for fx in np.linspace(0.05, 0.95, 14):
        wx.rust_streak(gz[0] + (gz[2] - gz[0]) * fx, gz[1] + 8,
                       16 + int(fx * 40) % 18, width=2.0, strength=0.4)
    # rail-line rust dribble onto the deck under each rail
    dz = L.Z_DECK
    for rx in (-L.RAIL_X, L.RAIL_X):
        rv = dz.uv((rx, 0, 0))[1] * W
        for fx in np.linspace(0.05, 0.95, 10):
            wx.rust_blotch(dz.rect[0] + (dz.rect[2] - dz.rect[0]) * fx,
                           rv, 5, strength=0.45)
    wx.plate_bottom_rust(L.Z_CHORD.rect, n=8, band=12, strength=0.6)
    wx.plate_bottom_rust(L.Z_GIRD.rect, n=6, band=10, strength=0.4)
    # pier foot mud + splash
    pz = L.Z_PIER.rect
    wx.mud_band((pz[0], pz[3] - 50, pz[2], pz[3]), 0.6, fade=None, spatter=True)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    hm.rect(L.Z_RAILT.rect, 0.5)              # rail head proud
    for wz in np.arange(-9.0, 10.0, 3.0):     # deck plate joints
        u = u_of(L.Z_DECK, wz)
        hm.line((u, L.Z_DECK.rect[1]), (u, L.Z_DECK.rect[3]), 0.3, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.4).save('out/ms_rail_bridge_normals.png')

    m.dif.save('out/ms_rail_bridge_diffuse.png')
    m.orm.save('out/ms_rail_bridge_orm.png')
    m.emi.save('out/ms_rail_bridge_emissive.png')
    m.tea.save('out/ms_rail_bridge_team.png')
    print('[paint_ms_rail_bridge] 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
