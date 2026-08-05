"""paint_ms_dress_anarchic — 1024² PBR set for the Anarchic dressing kit.

Mad-Max salvage register: mismatched welded scrap (paintlib.panel_patchwork
per spec) with weld beads and a crude circle-A cause-mark, dark rammed
steel on the prow, bone-white skull with painted sockets and a bolt row on
the totem, junk-tone trophies on greased chains, char-and-ember flame drum
(emissive warm flame + coals — amber register, never cyan), and a team-rag
streamer (team colour ONLY in the team mask R channel).  Tone-on-tone
patchwork (±15%) keeps the impostor baker's flat-shading honest.
"""
from __future__ import annotations
import numpy as np

import ms_dress_anarchic_layout as L
import paint as Pt
Pt.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit,
                   shade, BOLT_LOG, BLACKISH, TEAMGREY,
                   AO_BASE, AO_DEEP, R_ARMOR, M_STEEL)

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_dress_anarchic'

SCRAP = [(138, 130, 118), (124, 116, 106), (148, 118, 88),
         (116, 111, 103), (152, 132, 102), (131, 124, 113)]  # close-value scrap
STEEL_D = (66, 68, 71)
PROW_C  = (104, 101, 95)
TIMBER  = (96, 76, 54)
BONE    = (196, 186, 164)
OLIVE   = (86, 88, 64)
JERRY   = (118, 60, 46)
PLAQUE  = (110, 78, 52)
CHAR    = (38, 32, 28)
EMBER   = (255, 120, 40)
FLAME_C = (242, 156, 62)
FLAME_T = (252, 214, 116)
MARK    = (188, 182, 170)     # off-white daub


def paint_plates(m):
    x0, y0, x1, y1 = L.PLATES_F.rect
    PL.panel_patchwork(m, (x0, y0, x1, y1), SCRAP, cols=5, rows=3)
    u, v = PL.zone_fns(L.PLATES_F)
    # weld beads along the real plate boundaries (bright stitched lines)
    for (cx, w, py0, top, _z) in L.PLATE_SET:
        for wx in (cx - w / 2, cx + w / 2):
            seam_v(m, int(u(wx)), int(v(top)) + 2, int(v(py0)) - 2,
                   (140, 132, 118))
        bolts(m, [(u(cx - w / 2) + 6, v(top) + 8),
                  (u(cx + w / 2) - 6, v(top) + 8)], r=2, base=SCRAP[1])
    # crude circle-A cause-mark on the second plate
    cx_, cy_ = u(-0.36), v(0.95)
    r = 34
    m.d.ellipse([cx_ - r, cy_ - r, cx_ + r, cy_ + r], outline=MARK, width=5)
    m.d.line([(cx_ - r * 0.62, cy_ + r * 0.7), (cx_, cy_ - r * 0.9)],
             fill=MARK, width=5)
    m.d.line([(cx_ + r * 0.62, cy_ + r * 0.7), (cx_, cy_ - r * 0.9)],
             fill=MARK, width=5)
    m.d.line([(cx_ - r * 0.44, cy_ + r * 0.12), (cx_ + r * 0.44, cy_ + r * 0.12)],
             fill=MARK, width=5)
    wear_edges(m, (x0, y0, x1, y1), SCRAP[1], 55)
    # back + top: plain dark salvage
    x0, y0, x1, y1 = L.PLATES_B.rect
    fill(m, (x0, y0, x1, y1), dif=shade(SCRAP[1], 0.82), ao=AO_BASE - 12,
         rough=200, metal=110)
    for fx in np.linspace(0.18, 0.86, 4):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, SCRAP[1],
               hi=False)
    x0, y0, x1, y1 = L.PLATES_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(SCRAP[0], 0.9), ao=AO_BASE - 10,
         rough=195, metal=110)
    wear_edges(m, (x0, y0, x1, y1), SCRAP[0], 25)


def paint_prow(m):
    x0, y0, x1, y1 = L.PROW_F.rect
    fill(m, (x0, y0, x1, y1), dif=PROW_C, ao=AO_BASE - 8, rough=175,
         metal=150)
    # ram plating: tone-on-tone horizontal courses + heavy bolt rows
    u, v = PL.zone_fns(L.PROW_F)
    for wy in (0.62, 1.02):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), PROW_C)
    for wy in (0.5, 0.9, 1.28):
        n = 14
        bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / n, v(wy))
                  for i in range(n)], r=3, base=PROW_C)
    # gouges from ramming
    for _ in range(26):
        gx = RNG.uniform(x0 + 6, x1 - 20)
        gy = RNG.uniform(y0 + 8, y1 - 8)
        gl = RNG.uniform(6, 22)
        m.d.line([(gx, gy), (gx + gl, gy + RNG.uniform(-4, 4))],
                 fill=jit(shade(PROW_C, RNG.uniform(0.6, 1.3)), 6), width=2)
    wear_edges(m, (x0, y0, x1, y1), PROW_C, 80)
    x0, y0, x1, y1 = L.PROW_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(PROW_C, 0.92), ao=AO_BASE - 10,
         rough=180, metal=150)
    wear_edges(m, (x0, y0, x1, y1), PROW_C, 40)


def paint_skull(m):
    for zone in (L.SKULL_F, L.SKULL_S):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=BONE, ao=AO_BASE - 6, rough=215,
             metal=10)
        # crack lines
        for _ in range(8):
            sx = RNG.uniform(x0 + 8, x1 - 8)
            sy = RNG.uniform(y0 + 8, y1 - 30)
            m.d.line([(sx, sy), (sx + RNG.uniform(-10, 10), sy + 22)],
                     fill=shade(BONE, 0.72), width=2)
    # face: sockets, nose, tooth line (front zone only)
    u, v = PL.zone_fns(L.SKULL_F)
    for sx in (-1, 1):
        ex0, ey0 = u(sx * 0.13 - 0.07), v(2.48)
        ex1, ey1 = u(sx * 0.13 + 0.07), v(2.34)
        m.d.ellipse([min(ex0, ex1), ey0, max(ex0, ex1), ey1], fill=BLACKISH)
        m.o.ellipse([min(ex0, ex1), ey0, max(ex0, ex1), ey1],
                    fill=(AO_DEEP, 230, 10))
    nx0, ny0 = u(-0.035), v(2.31)
    nx1, ny1 = u(0.035), v(2.22)
    m.d.polygon([(nx0, ny1), (nx1, ny1), ((nx0 + nx1) / 2, ny0)],
                fill=BLACKISH)
    ty = v(2.14)
    m.d.line([(u(-0.14), ty), (u(0.14), ty)], fill=shade(BONE, 0.6), width=3)
    for wx in np.linspace(-0.12, 0.12, 6):
        m.d.line([(u(wx), ty - 6), (u(wx), ty + 6)], fill=shade(BONE, 0.55),
                 width=2)
    # bolt ring across the brow (skull-AND-BOLTS)
    bolts(m, [(u(wx), v(2.56)) for wx in np.linspace(-0.17, 0.17, 5)],
          r=3, base=BONE)
    x0, y0, x1, y1 = L.SKULL_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(BONE, 0.94), ao=AO_BASE - 8,
         rough=215, metal=10)


def paint_trophies(m):
    for zone, col in ((L.TROPHY_A, OLIVE), (L.TROPHY_B, JERRY),
                      (L.TROPHY_C, PLAQUE)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=col, ao=AO_BASE - 10, rough=205,
             metal=60)
        wear_edges(m, (x0, y0, x1, y1), col, 40)
    # helmet: dent + scratched stripe
    x0, y0, x1, y1 = L.TROPHY_A.rect
    m.d.ellipse([x0 + 30, y0 + 30, x0 + 70, y0 + 62],
                fill=shade(OLIVE, 0.78))
    # jerry can: X cross rib
    x0, y0, x1, y1 = L.TROPHY_B.rect
    m.d.line([(x0 + 12, y0 + 14), (x1 - 12, y1 - 14)],
             fill=shade(JERRY, 0.7), width=4)
    m.d.line([(x0 + 12, y1 - 14), (x1 - 12, y0 + 14)],
             fill=shade(JERRY, 0.7), width=4)
    # plaque: tally marks
    x0, y0, x1, y1 = L.TROPHY_C.rect
    for i in range(5):
        tx = x0 + 26 + i * 16
        m.d.line([(tx, y0 + 34), (tx, y0 + 74)], fill=MARK, width=4)
    m.d.line([(x0 + 18, y0 + 70), (x0 + 26 + 4 * 16 + 8, y0 + 38)],
             fill=MARK, width=4)
    # hanging scrap tokens (totem crossbar)
    x0, y0, x1, y1 = L.TOKEN.rect
    fill(m, (x0, y0, x1, y1), dif=PLAQUE, ao=AO_BASE - 12, rough=210,
         metal=90)
    seam_v(m, (x0 + x1) // 2, y0 + 2, y1 - 2, PLAQUE, hi=False)
    wear_edges(m, (x0, y0, x1, y1), PLAQUE, 30)


def paint_brazier(m):
    x0, y0, x1, y1 = L.DRUM.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 10, rough=190,
         metal=130)
    # drum ribs
    u, v = PL.zone_fns(L.DRUM)
    for wy in (0.24, 0.62):
        seam_h(m, x0 + 2, x1 - 2, int(v(wy)), STEEL_D)
    # cut-out vent holes near the base, faint ember glow inside
    for fx in np.linspace(0.14, 0.86, 5):
        vx = x0 + (x1 - x0) * fx
        vy = v(0.14)
        m.d.rectangle([vx - 7, vy - 9, vx + 7, vy + 9], fill=BLACKISH)
        m.e.rectangle([vx - 5, vy - 6, vx + 5, vy + 6], fill=(120, 42, 8))
    # coals cap: char + embers (emissive)
    x0, y0, x1, y1 = L.COALS.rect
    fill(m, (x0, y0, x1, y1), dif=CHAR, ao=AO_DEEP + 20, rough=235, metal=10)
    for _ in range(70):
        ex = RNG.uniform(x0 + 4, x1 - 6)
        ey = RNG.uniform(y0 + 4, y1 - 6)
        s = RNG.uniform(2, 6)
        col = jit(EMBER, 30)
        m.d.ellipse([ex, ey, ex + s, ey + s], fill=col)
        m.e.ellipse([ex, ey, ex + s, ey + s],
                    fill=(col[0], int(col[1] * 0.8), 10))
    # flame: warm gradient, strongly emissive
    x0, y0, x1, y1 = L.FLAME.rect
    for i in range(y1 - y0):
        t = i / (y1 - y0)          # v=0 top (tip) .. 1 base
        col = tuple(int(FLAME_T[c] * (1 - t) + FLAME_C[c] * t)
                    for c in range(3))
        m.d.line([(x0, y0 + i), (x1, y0 + i)], fill=col)
        m.e.line([(x0, y0 + i), (x1, y0 + i)],
                 fill=tuple(int(cc * 0.92) for cc in col))
    m.o.rectangle([x0, y0, x1, y1], fill=(250, 255, 0))


def paint_streamer(m):
    # rag: full team mask; tattered stripes over the TEAMGREY respray
    box = PL.nbox(*L.RAG.rect)
    PL.team_panel(m, box, outline=shade(TEAMGREY, 0.6))
    x0, y0, x1, y1 = (int(b) for b in box)
    for fx in np.linspace(0.12, 0.92, 6):
        sx = x0 + (x1 - x0) * fx
        m.d.line([(sx, y0 + 2), (sx + 4, y1 - 2)],
                 fill=shade(TEAMGREY, 0.8), width=2)
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 10, 245, 0))
    # frayed trailing edge notch
    m.d.polygon([(x1 - 10, y0), (x1, y0), (x1, y1), (x1 - 10, y1),
                 (x1 - 4, (y0 + y1) // 2)], fill=shade(TEAMGREY, 0.7))


def paint_cells(m):
    # timber pole (totem + rack uprights share POLE_R)
    x0, y0, x1, y1 = L.POLE_R
    fill(m, (x0, y0, x1, y1), dif=TIMBER, ao=AO_BASE - 10, rough=235,
         metal=5)
    for fy in np.linspace(0.15, 0.85, 5):
        yy = y0 + (y1 - y0) * fy
        m.d.line([(x0, yy), (x1, yy + RNG.uniform(-3, 3))],
                 fill=jit(shade(TIMBER, 0.82), 5), width=2)
    # bolt studs down the pole (skull-and-bolts)
    bolts(m, [(x0 + (x1 - x0) * f, (y0 + y1) / 2 + RNG.uniform(-14, 14))
              for f in np.linspace(0.08, 0.92, 7)], r=3, base=TIMBER)
    # crossbar / rack bar: dark steel
    x0, y0, x1, y1 = L.BAR_R
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 10, rough=180,
         metal=150)
    bolts(m, [(x0 + (x1 - x0) * f, (y0 + y1) / 2)
              for f in np.linspace(0.1, 0.9, 5)], r=2, base=STEEL_D)
    # chains: near-black greased steel
    fill(m, L.CHAIN_R, dif=(44, 45, 48), ao=AO_DEEP + 25, rough=150,
         metal=170)
    # spikes: steel gradient dark base -> bright tip (u runs along limb)
    x0, y0, x1, y1 = L.SPIKE_R
    for i in range(x1 - x0):
        t = i / (x1 - x0)
        m.d.line([(x0 + i, y0), (x0 + i, y1)],
                 fill=shade(PROW_C, 0.75 + 0.55 * t))
    fill(m, (x0, y0, x1, y1), ao=AO_BASE - 6, rough=150, metal=190)
    # horns: bone gradient
    x0, y0, x1, y1 = L.HORN_R
    for i in range(x1 - x0):
        t = i / (x1 - x0)
        m.d.line([(x0 + i, y0), (x0 + i, y1)],
                 fill=shade(BONE, 0.8 + 0.25 * t))
    fill(m, (x0, y0, x1, y1), ao=AO_BASE - 8, rough=220, metal=10)
    # mast: dark steel
    fill(m, L.MAST_R, dif=shade(STEEL_D, 1.05), ao=AO_BASE - 8, rough=170,
         metal=160)
    # trim + dark
    fill(m, L.TRIM.rect, dif=STEEL_D, ao=AO_BASE - 12, rough=165, metal=155)
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=SCRAP[1], ao=AO_BASE - 10, rough=195,
         metal=100)
    paint_plates(m)
    paint_prow(m)
    paint_skull(m)
    paint_trophies(m)
    paint_brazier(m)
    paint_streamer(m)
    paint_cells(m)

    # ── weathering ──
    wx = PL.standard_weather(
        m, L, ground_rects=(),
        side_zones=(L.PLATES_F, L.PLATES_B, L.PROW_F), seed=90210,
        mud=0.28, grime=0.4, rust_fraction=0.6)
    # soot: drum upper band + rim, flame stays clean (emissive)
    dx0, dy0, dx1, _ = L.DRUM.rect
    wx.soot_patch((dx0, dy0, dx1, dy0 + 34), 0.85)
    wx.soot_patch(L.SKULL_TOP.rect, 0.25)
    # rust: plate bottoms, prow gouges, chain grease
    wx.plate_bottom_rust(L.PLATES_F.rect, n=8, band=8, strength=0.7)
    px0, py0, px1, _ = L.PROW_F.rect
    for fx in np.linspace(0.1, 0.9, 8):
        wx.rust_streak(px0 + (px1 - px0) * fx, py0 + 12,
                       int(RNG.uniform(16, 38)), width=2.6, strength=0.5)
    wx.rust_blotch((px0 + px1) / 2, py0 + 60, 26, 0.6)
    wx.oily(L.CHAIN_R, 0.45)
    wx.oily(L.BAR_R, 0.25)
    wx.mud_band(L.DRUM.rect, 0.5, fade='down')

    PL.finish(m, L, STEM, wx=wx)


if __name__ == '__main__':
    paint_all()
