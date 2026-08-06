"""paint_ms_ancient_hulk — 2048² PBR set for ms_ancient_hulk.

Ancient register: smooth graphite monolith, alternating tone-on-tone
segment bands (±13%, baker-safe) with etched segment seams and chine
shelves — no rivets, no patches, no rust. Cyan tracery circuits live
on the -X flank only (bright in emissive, faint in diffuse), the
breach rim glows and scorches, the chamber is near-black with a cyan
core. Grounded +X flank and belly take berm mud; the stern half takes
a computed waterline scum band that follows the baked list/pitch.
No team colour (terrain feature, validated --no-team).
"""
from __future__ import annotations
import numpy as np

import ms_ancient_hulk_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL
from paint import (Maps, fill, seam_h, seam_v, wear_edges, shade, jit,
                   CYAN, AO_BASE, AO_SEAM, AO_DEEP)

W = 2048
STEM = 'ms_ancient_hulk'

HULLC = (78, 83, 92)         # graphite monolith base
SEG_A = (73, 78, 87)         # segment band dark
SEG_B = (84, 89, 99)         # segment band light  (~13% apart: baker-safe)
BELLYC = (60, 64, 72)
DECKC = (85, 90, 99)
CHAM_DK = (16, 18, 22)
CORE_D = (40, 72, 80)
SAND = (148, 131, 101)
SOIL = (118, 102, 79)
SCUM = (74, 82, 74)
TRACE_D = (84, 112, 122)     # tracery in diffuse: faint tint only
CYAN_DIM = (28, 84, 96)
R_ANC, M_ANC = 118, 120      # smoother + more metallic than scavenger steel

SEG_EDGES = [-50.0] + L.SEG_Z + [50.0]


def seg_fill(m, zone, py_top, py_bot, base_a, base_b):
    """Alternating segment bands between the layout's step boundaries."""
    x0, y0, x1, y1 = zone.rect

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    for i in range(len(SEG_EDGES) - 1):
        c = base_a if i % 2 == 0 else base_b
        m.d.rectangle([pz(SEG_EDGES[i]), py_top, pz(SEG_EDGES[i + 1]),
                       py_bot], fill=jit(c, 2))


def paint_flank(m, zone, tracery):
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HULLC, ao=AO_BASE - 6, rough=R_ANC,
         metal=M_ANC)

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    seg_fill(m, zone, y0, y1, SEG_A, SEG_B)
    # etched segment seams + chine shelves (tone-on-tone)
    for wz in L.SEG_Z:
        seam_v(m, int(pz(wz)), y0 + 2, y1 - 2, HULLC, hi=False)
    for wy in L.CHINES:
        seam_h(m, x0 + 2, x1 - 2, int(py(wy)), HULLC, hi=False)

    # stern-half waterline scum band (follows the baked list/pitch):
    # upright-y of world WATER_Y at this flank, linear in z
    side = -1.0 if tracery else 1.0          # tracery flank is -x
    th, ph = np.radians(L.ROLL_DEG), np.radians(L.PITCH_DEG)
    xf = side * 7.0
    for z0 in np.arange(16.0, 48.0, 2.0):
        ys = []
        for wz in (z0, z0 + 2.0):
            y_up = (L.WATER_Y + L.SINK + wz * np.sin(ph)
                    - xf * np.sin(th)) / (np.cos(th) * np.cos(ph))
            ys.append(y_up)
        m.d.polygon([(pz(z0), py(ys[0] + 0.5)), (pz(z0 + 2), py(ys[1] + 0.5)),
                     (pz(z0 + 2), py(ys[1] - 0.1)), (pz(z0), py(ys[0] - 0.1))],
                    fill=jit(SCUM, 5))

    if tracery:
        # cyan tracery circuits: two rails + connectors at segment seams
        for wy in (5.4, 8.6):
            yy = int(py(wy))
            m.d.line([(pz(-36), yy), (pz(34), yy)], fill=TRACE_D, width=2)
            m.e.line([(pz(-36), yy), (pz(34), yy)], fill=CYAN, width=3)
            for wz in np.arange(-34.0, 34.0, 8.0):
                m.e.ellipse([pz(wz) - 4, yy - 4, pz(wz) + 4, yy + 4],
                            fill=CYAN)
        for wz in [-29.4, -19.4, -9.4, 24.6]:
            uu = int(pz(wz))
            m.d.line([(uu, py(8.6)), (uu, py(5.4))], fill=TRACE_D, width=2)
            m.e.line([(uu, py(8.6)), (uu, py(5.4))], fill=CYAN, width=3)
            m.e.line([(uu, py(11.2)), (uu, py(8.6))], fill=CYAN_DIM, width=2)
        # breach rim glow + scorch
        bx0, bx1 = pz(L.BR_Z0), pz(L.BR_Z1)
        by0, by1 = py(L.BR_Y_TOP), py(L.BR_Y_BOT)
        for i, col in enumerate((CYAN, (60, 170, 190), CYAN_DIM)):
            g = 4 + i * 7
            m.e.rectangle([bx0 - g, by0 - g, bx1 + g, by1 + g],
                          outline=col, width=6)
        m.d.rectangle([bx0 - 26, by0 - 26, bx1 + 26, by1 + 26],
                      outline=(44, 46, 50), width=18)
    wear_edges(m, (x0, y0, x1, y1), HULLC, 22)


def paint_deck_belly(m):
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 8, rough=R_ANC + 12,
         metal=M_ANC - 10)

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    def px(wx):
        return zone.uv((wx, 0, 0))[1] * W

    seg_fill(m, zone, y0, y1, jit(SEG_A, 3), jit(SEG_B, 3))
    for wz in L.SEG_Z:
        seam_v(m, int(pz(wz)), y0 + 2, y1 - 2, DECKC, hi=False)
    # etched deck channels flanking the spine line
    for wx in (-1.4, 1.4):
        m.d.line([(x0 + 4, px(wx)), (x1 - 4, px(wx))],
                 fill=shade(DECKC, 0.88), width=2)
    wear_edges(m, (x0, y0, x1, y1), DECKC, 28)

    zone = L.S_BELLY
    r = zone.rect
    fill(m, r, dif=BELLYC, ao=AO_BASE - 20, rough=R_ANC + 30, metal=M_ANC - 30)
    seg_fill(m, zone, r[1], r[3], shade(SEG_A, 0.82), shade(SEG_B, 0.82))


def paint_ends(m):
    for zone, prow in ((L.S_BOW, True), (L.S_STERN, False)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=HULLC, ao=AO_BASE - 8, rough=R_ANC,
             metal=M_ANC)
        cx = (x0 + x1) / 2
        if prow:
            # raised prow blade: light catch line down the centre
            m.d.rectangle([cx - 4, y0 + 8, cx + 4, y1 - 8],
                          fill=shade(HULLC, 1.12))
            for dx in (44, 96):
                m.d.rectangle([cx - dx - 3, y0 + 24, cx - dx + 3, y1 - 4],
                              fill=shade(HULLC, 0.9))
                m.d.rectangle([cx + dx - 3, y0 + 24, cx + dx + 3, y1 - 4],
                              fill=shade(HULLC, 0.9))
        else:
            # stern: etched concentric rings + dim ancient port glow
            cy = (y0 + y1) / 2 - 20
            for rr, kk in ((90, 0.9), (58, 1.08), (30, 0.86)):
                m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                            outline=shade(HULLC, kk), width=5)
            m.e.ellipse([cx - 22, cy - 22, cx + 22, cy + 22],
                        outline=CYAN_DIM, width=6)
            # scum across the lower stern
            m.d.rectangle([x0, y1 - 60, x1, y1], fill=jit(SCUM, 5))


def paint_fin_masts(m):
    zone = L.S_FIN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=jit(SEG_B, 2), ao=AO_BASE - 6,
         rough=R_ANC - 8, metal=M_ANC + 10)

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    for wz in (12.0, 18.0, 24.0):     # fin segment seams
        seam_v(m, int(pz(wz)), y0 + 3, y1 - 3, SEG_B, hi=False)
    m.d.rectangle([x0, y0 + 6, x1, y0 + 12], fill=shade(SEG_B, 1.1))
    wear_edges(m, (x0, y0, x1, y1), SEG_B, 25)

    # masts/spars wrap: banded monolith spar
    x0, y0, x1, y1 = L.S_MAST
    fill(m, (x0, y0, x1, y1), dif=(60, 64, 72), ao=AO_BASE - 10,
         rough=R_ANC + 10, metal=M_ANC)
    for fx in (0.25, 0.5, 0.75):
        xx = int(x0 + (x1 - x0) * fx)
        m.d.rectangle([xx - 4, y0, xx + 4, y1], fill=(54, 58, 66))

    # shed hull shards: segment-band tones
    x0, y0, x1, y1 = L.S_SHARD
    fill(m, (x0, y0, x1, y1), dif=SEG_A, ao=AO_BASE - 12, rough=R_ANC + 20,
         metal=M_ANC - 20)
    for fx in (0.33, 0.66):
        xx = int(x0 + (x1 - x0) * fx)
        m.d.rectangle([xx - 3, y0, xx + 3, y1], fill=shade(SEG_A, 0.88))


def paint_chamber(m):
    zone = L.S_CHAMBER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CHAM_DK, ao=AO_DEEP, rough=140, metal=60)
    # dim interior wash, brighter toward the centre (kept low-contrast)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.e.rectangle([x0 + 30, y0 + 40, x1 - 30, y1 - 40], fill=(12, 36, 42))
    m.e.rectangle([cx - 90, cy - 60, cx + 90, cy + 60], fill=CYAN_DIM)

    r = L.S_CORE.rect
    fill(m, r, dif=CORE_D, ao=AO_BASE, rough=60, metal=0)
    m.e.rectangle(r, fill=(70, 200, 225))
    m.e.rectangle([r[0] + 18, r[1] + 18, r[2] - 18, r[3] - 18], fill=CYAN)

    fill(m, L.S_DK.rect, dif=(24, 26, 30), ao=AO_DEEP, rough=190, metal=40)


def paint_berm(m):
    zone = L.S_BERM
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=SAND, ao=AO_BASE - 10, rough=232, metal=0)

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    rng = np.random.default_rng(90210)
    for _ in range(70):      # soil blotches, tone-on-tone
        bx = rng.uniform(x0 + 8, x1 - 8)
        by = rng.uniform(y0 + 8, y1 - 8)
        rr = rng.uniform(6, 26)
        m.d.ellipse([bx - rr, by - rr * 0.5, bx + rr, by + rr * 0.5],
                    fill=jit(SOIL, 9))
    for _ in range(160):     # pebbles/debris specks
        bx = rng.uniform(x0 + 4, x1 - 4)
        by = rng.uniform(y0 + 4, y1 - 4)
        c = shade(SOIL, rng.uniform(0.8, 1.15))
        m.d.ellipse([bx - 2, by - 2, bx + 2, by + 2], fill=c)
    # wet sand toward the waterline (stern end of the berm)
    m.d.rectangle([pz(18.0), y0, x1, y1], fill=jit(shade(SAND, 0.84), 4))
    m.o.rectangle([pz(18.0), y0, x1, y1], fill=(AO_BASE - 25, 245, 0))


def paint_all():
    PL.BOLT_LOG.clear()
    m = Maps()
    paint_flank(m, L.S_HULL_HI, tracery=True)
    paint_flank(m, L.S_HULL_LO, tracery=False)
    paint_deck_belly(m)
    paint_ends(m)
    paint_fin_masts(m)
    paint_chamber(m)
    paint_berm(m)

    # ── weathering: grime + berm mud + breach scorch (no rust — ancient) ──
    wx = weathering.Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.45)

    def py_hi(wy):
        return L.S_HULL_HI.uv((0, wy, 0))[1] * W

    def py_lo(wy):
        return L.S_HULL_LO.uv((0, wy, 0))[1] * W

    def pz_hi(wz):
        return L.S_HULL_HI.uv((0, 0, wz))[0] * W

    r = L.S_HULL_LO.rect
    wx.mud_band((r[0], int(py_lo(5.0)), r[2], r[3]), 0.55, fade='down',
                spatter=True)                        # berm side buried deep
    r = L.S_HULL_HI.rect
    wx.mud_band((r[0], int(py_hi(2.4)), r[2], r[3]), 0.3, fade='down',
                spatter=True)
    wx.mud_band(L.S_BELLY.rect, 0.5, fade=None, spatter=True)
    wx.mud_band(L.S_BERM.rect, 0.3, fade=None, spatter=True)
    wx.soot_patch((int(pz_hi(L.BR_Z0)) - 30, int(py_hi(L.BR_Y_TOP)) - 30,
                   int(pz_hi(L.BR_Z1)) + 30, int(py_hi(L.BR_Y_BOT)) + 30),
                  0.55)                              # breach scorch
    wx.soot_patch(L.S_CHAMBER.rect, 0.35)

    # ── height → normals: etched seams and chines ──
    hm = NM.HeightMap()
    for zone, py in ((L.S_HULL_HI, py_hi), (L.S_HULL_LO, py_lo)):
        x0, y0, x1, y1 = zone.rect

        def pz(wz, zone=zone):
            return zone.uv((0, 0, wz))[0] * W

        for wz in L.SEG_Z:
            hm.line((pz(wz), y0 + 2), (pz(wz), y1 - 2), -0.5, width=3)
        for wy in L.CHINES:
            hm.line((x0 + 2, py(wy)), (x1 - 2, py(wy)), -0.3, width=2)
    zone = L.S_DECK
    x0, y0, x1, y1 = zone.rect
    for wz in L.SEG_Z:
        u = zone.uv((0, 0, wz))[0] * W
        hm.line((u, y0 + 2), (u, y1 - 2), -0.5, width=3)
    # tracery lightly recessed
    for wy in (5.4, 8.6):
        hm.line((pz_hi(-36), py_hi(wy)), (pz_hi(34), py_hi(wy)), -0.25,
                width=2)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
