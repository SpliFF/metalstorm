"""paint_ms_road_bridge — 2048² PBR set for ms_road_bridge.

Chokepoint terrain read: cracked concrete deck slabs with expansion
joints every 4 m (joints land exactly at the tileable z ends), faded
centre-line dashes, worn wheel tracks, kerbs with chipped edges; riveted
oxide-red-gone-brown steel truss (rivet rows at both chord heights on
the shared chord cell, gusset plates at panel points), grimy steel cell
for limbs/braces/floor-beams, stained concrete pier footings with a
waterline band.  No team colour, no emissive (dead infrastructure).
Weathering: rust streaks off the chords and rivets, grime at the deck /
kerb joints, mud + waterline on the piers, soot-oil down the deck
centre.  Deterministic seed 90210 via paint.RNG.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_road_bridge_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges,
                   jit, shade, BOLT_LOG, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_STEEL, M_STEEL, RNG)

W = 2048
CONCRETE = (150, 147, 139)
CONC_DK = (116, 113, 106)
TRUSSRED = (108, 62, 46)             # oxide-red truss gone brown
TRUSS_DK = (82, 50, 40)
STEELGRIM = (74, 70, 66)
KERBC = (162, 158, 148)
LINEPAINT = (196, 188, 158)          # faded road paint


def u_of(zone, wz):
    return zone.uv((0, 0, wz))[0] * W


def v_of(zone, wy):
    return zone.uv((0, wy, 0))[1] * W


# ── deck: cracked slabs, joints on a 4 m grid (ends included) ────────────

def paint_deck(m):
    zone = L.Z_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4, rough=212,
         metal=8)

    def vd(wx):                      # deck v maps world x
        return zone.uv((wx, 0, 0))[1] * W

    # slab tone patchwork (each 4 m slab its own cast)
    joints = np.arange(-12.0, 12.1, 4.0)
    for i in range(len(joints) - 1):
        su0, su1 = u_of(zone, joints[i]), u_of(zone, joints[i + 1])
        m.d.rectangle([su0, y0, su1, y1],
                      fill=jit(shade(CONCRETE, 0.96 + 0.05 * (i % 3)), 3))
    # stain patches
    for _ in range(30):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 12), (bx + 60, by), (bx + 82, by + 38),
                     (bx + 18, by + 50)], fill=jit(shade(CONCRETE, 0.94), 4))
    # expansion joints (dark, at slab bounds incl. both tile ends)
    for wz in joints:
        ju = int(np.clip(u_of(zone, wz), x0 + 2, x1 - 3))
        seam_v(m, ju, y0 + 2, y1 - 2, CONCRETE, hi=False)
        m.d.line([(ju, y0 + 2), (ju, y1 - 2)], fill=CONC_DK, width=3)
    # cracks: jagged polylines wandering off joints and wheel tracks
    for _ in range(22):
        cx = x0 + RNG.random() * (x1 - x0 - 120)
        cy = y0 + RNG.random() * (y1 - y0 - 80)
        pts = [(cx, cy)]
        for _s in range(5):
            cx += 12 + RNG.random() * 22
            cy += (RNG.random() - 0.5) * 46
            pts.append((cx, cy))
        m.d.line(pts, fill=shade(CONC_DK, 0.8), width=2)
        m.o.line(pts, fill=(AO_SEAM, 220, 8), width=2)
    # faded centre-line dashes (x = 0)
    cv = int(vd(0.0))
    for wz in np.arange(-11.4, 11.5, 2.4):
        du0, du1 = u_of(zone, wz), u_of(zone, wz + 1.2)
        m.d.rectangle([du0, cv - 5, du1, cv + 5], fill=jit(LINEPAINT, 6))
    # worn wheel tracks (darker polished bands either side of centre)
    for wx in (-1.5, 1.5):
        tv = int(vd(wx))
        m.d.rectangle([x0, tv - 26, x1, tv + 26],
                      fill=jit(shade(CONCRETE, 0.9), 2))
        m.o.rectangle([x0, tv - 26, x1, tv + 26], fill=(AO_BASE - 4, 175, 10))
    wear_edges(m, (x0, y0, x1, y1), CONCRETE, 55)

    # deck sides + underside: plain stained concrete
    x0, y0, x1, y1 = L.Z_DECKS.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.9), ao=AO_BASE - 10,
         rough=210, metal=8)
    for wz in joints:
        seam_v(m, int(np.clip(u_of(L.Z_DECKS, wz), x0 + 2, x1 - 3)),
               y0 + 2, y1 - 2, CONCRETE, hi=False)
    x0, y0, x1, y1 = L.Z_DECKB.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONC_DK, 0.92), ao=AO_DEEP + 10,
         rough=205, metal=10)


# ── kerbs ────────────────────────────────────────────────────────────────

def paint_kerb(m):
    zone = L.Z_KERB
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=KERBC, ao=AO_BASE - 6, rough=205, metal=8)
    # kerb stones every 2 m, chipped tone shifts
    for wz in np.arange(-12.0, 12.1, 2.0):
        ku = int(np.clip(u_of(zone, wz), x0 + 2, x1 - 3))
        seam_v(m, ku, y0 + 2, y1 - 2, KERBC, hi=False)
    for _ in range(24):
        bx = x0 + RNG.random() * (x1 - x0 - 40)
        m.d.rectangle([bx, y0 + RNG.random() * 20, bx + 20 + RNG.random() * 24,
                       y0 + 26 + RNG.random() * 24],
                      fill=jit(shade(KERBC, 0.88), 5))
    wear_edges(m, (x0, y0, x1, y1), KERBC, 50)


# ── truss chords: riveted oxide steel ────────────────────────────────────

def paint_chords(m):
    zone = L.Z_CHORD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=TRUSSRED, ao=AO_BASE - 10, rough=178,
         metal=120)
    # panel plate seams between panel points
    for pz in L.POSTS_Z:
        pu = int(np.clip(u_of(zone, pz), x0 + 2, x1 - 3))
        seam_v(m, pu, y0 + 2, y1 - 2, TRUSSRED, hi=False)
    # rivet rows at both chord heights + gusset plates at panel points
    for cy, half in ((L.TC_Y, L.TC_SZ[1] / 2), (L.BC_Y, L.BC_SZ[1] / 2)):
        for edge in (cy + half - 0.08, cy - half + 0.08):
            rv = int(v_of(zone, edge))
            bolts(m, [(x0 + 10 + i * (x1 - x0 - 20) / 47, rv)
                      for i in range(48)], base=TRUSSRED)
        for pz in L.POSTS_Z:
            pu = int(np.clip(u_of(zone, pz), x0 + 26, x1 - 26))
            gv0, gv1 = int(v_of(zone, cy + half + 0.16)), \
                int(v_of(zone, cy - half - 0.16))
            m.d.rectangle([pu - 22, gv0, pu + 22, gv1],
                          fill=shade(TRUSSRED, 1.1))
            bolts(m, [(pu - 12, (gv0 + gv1) // 2), (pu + 12, (gv0 + gv1) // 2)],
                  base=TRUSSRED)
    wear_edges(m, (x0, y0, x1, y1), TRUSSRED, 60)


# ── generic cells: steel limbs, dark ends ────────────────────────────────

def paint_cells(m):
    x0, y0, x1, y1 = L.Z_STEEL.rect
    fill(m, (x0, y0, x1, y1), dif=TRUSS_DK, ao=AO_BASE - 12, rough=182,
         metal=130)
    # tone-on-tone streaking only (large quads sample this cell — keep
    # contrast low for the impostor baker)
    for _ in range(26):
        sx = x0 + RNG.random() * (x1 - x0)
        m.d.line([(sx, y0 + 4), (sx + (RNG.random() - 0.5) * 8, y1 - 4)],
                 fill=jit(shade(TRUSS_DK, 0.94), 4), width=2)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, TRUSS_DK, hi=False)
    fill(m, L.Z_DARK.rect, dif=jit(shade(STEELGRIM, 0.6), 2), ao=AO_DEEP,
         rough=200, metal=60)


# ── pier footings ────────────────────────────────────────────────────────

def paint_piers(m):
    zone = L.Z_PIER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.94), ao=AO_BASE - 12,
         rough=215, metal=8)
    # shutter-board seams
    for fx in np.linspace(0.12, 0.88, 6):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, CONCRETE,
               hi=False)
    # waterline / damp band at the foot
    wv = int(v_of(zone, 0.32))
    m.d.rectangle([x0, wv, x1, y1], fill=jit(shade(CONC_DK, 0.85), 3))
    m.o.rectangle([x0, wv, x1, y1], fill=(AO_DEEP + 6, 225, 8))
    wear_edges(m, (x0, y0, x1, y1), CONCRETE, 45)


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_cells(m)
    paint_deck(m)
    paint_kerb(m)
    paint_chords(m)
    paint_piers(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=13)
    wx.crevice_grime(m.dif, 0.5)
    # rust streaks off the chord rivet rows
    cz = L.Z_CHORD.rect
    for fx in np.linspace(0.05, 0.95, 14):
        wx.rust_streak(cz[0] + (cz[2] - cz[0]) * fx, cz[1] + 20,
                       16 + int(fx * 40) % 18, width=2.4, strength=0.45)
    # deck: grime along the kerb lines, oily centre strip
    dz = L.Z_DECK
    wx.oily((dz.rect[0] + 8, int(dz.uv((-0.5, 0, 0))[1] * W),
             dz.rect[2] - 8, int(dz.uv((0.5, 0, 0))[1] * W)), 0.35)
    wx.mud_band((dz.rect[0], dz.rect[1], dz.rect[2], dz.rect[1] + 26),
                0.4, fade='up', spatter=True)
    wx.mud_band((dz.rect[0], dz.rect[3] - 26, dz.rect[2], dz.rect[3]),
                0.4, fade='down', spatter=True)
    # deck sides: plate-foot rust dribble off the bottom chord line
    wx.plate_bottom_rust(L.Z_DECKS.rect, n=8, band=12, strength=0.5)
    # piers: heavy mud at the waterline
    pz = L.Z_PIER.rect
    wx.mud_band((pz[0], pz[3] - 60, pz[2], pz[3]), 0.7, fade=None,
                spatter=True)
    wx.mud_band(L.Z_KERB.rect, 0.2, fade=None, spatter=False)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.6)
    wx.apply(m)

    # ── height → normals ──
    from normals import HeightMap
    hm = HeightMap()
    for wz in np.arange(-12.0, 12.1, 4.0):     # deck expansion joints
        ju = float(np.clip(u_of(L.Z_DECK, wz), dz.rect[0] + 2,
                           dz.rect[2] - 3))
        hm.line((ju, dz.rect[1]), (ju, dz.rect[3]), -0.4, width=3)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.6)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save('out/ms_road_bridge_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_road_bridge_diffuse.png')
    m.orm.save('out/ms_road_bridge_orm.png')
    m.emi.save('out/ms_road_bridge_emissive.png')
    m.tea.save('out/ms_road_bridge_team.png')
    print('[paint_ms_road_bridge] 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
