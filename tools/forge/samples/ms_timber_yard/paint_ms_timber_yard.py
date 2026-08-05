"""paint_ms_timber_yard — 1024² PBR set for ms_timber_yard.

Weathered industrial timber read: dirt pad strewn with sawdust drifts
and drag ruts, grey-brown bark log wraps with pale end-grain rings,
sun-bleached cut-lumber stacks with sticker gaps, oil-dark saw bench,
a galvanised circular blade (16-fold symmetric teeth + radially
symmetric hub — the blade spins), red-oxide crane steel, corrugated
rusty roof kept low-contrast (impostor-baker quirk), pale sawdust
cones.  Map prop: team mask stays black, no emissive.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_timber_yard_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges,
                   jit, shade, BOLT_LOG,
                   STEEL, STEEL_DK, YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_STEEL, M_STEEL, RNG)

W = 1024
DIRT     = (122, 112, 96)
DIRT_DK  = (100, 90, 76)
BARK     = (104, 88, 68)
BARK_DK  = (78, 64, 48)
GRAIN    = (196, 172, 128)          # end grain / fresh cut
LUMBER   = (188, 164, 116)          # sun-bleached boards
LUMBER_DK = (146, 124, 84)
BENCHW   = (110, 92, 66)            # oil-darkened bench timber
DUST     = (206, 188, 146)          # sawdust
ROOFC    = (128, 96, 78)            # rusty corrugated iron (low contrast)
OXIDE    = (118, 70, 58)            # red-oxide crane steel
GALV     = (168, 172, 176)          # blade steel


def paint_pad(m):
    x0, y0, x1, y1 = L.PAD_T
    fill(m, (x0, y0, x1, y1), dif=DIRT, ao=AO_BASE - 6, rough=215, metal=0)
    for _ in range(800):
        px = RNG.uniform(x0, x1 - 2)
        py = RNG.uniform(y0, y1 - 2)
        c = jit(shade(DIRT, RNG.uniform(0.84, 1.14)), 6)
        m.d.rectangle([px, py, px + RNG.uniform(1, 3), py + RNG.uniform(1, 3)],
                      fill=c)
    # log-drag ruts toward the shed (east)
    for fy in (0.32, 0.44, 0.6):
        pts = []
        for t in np.linspace(0, 1, 10):
            pts.append((x0 + (x1 - x0) * t,
                        y0 + (y1 - y0) * (fy + np.sin(t * 4.1) * 0.02)))
        m.d.line(pts, fill=shade(DIRT_DK, 0.95), width=7)
        m.o.line(pts, fill=(AO_BASE - 20, 228, 0), width=7)
    # sawdust drift around the shed quarter (world +x, -z → u high, v low)
    for _ in range(60):
        px = RNG.uniform(x0 + (x1 - x0) * 0.5, x1 - 20)
        py = RNG.uniform(y0, y0 + (y1 - y0) * 0.5)
        rw, rh = RNG.uniform(8, 30), RNG.uniform(6, 22)
        m.d.ellipse([px, py, px + rw, py + rh],
                    fill=jit(shade(DUST, RNG.uniform(0.88, 1.04)), 5))
    # bark litter near the stacks (u low, v high)
    for _ in range(40):
        px = RNG.uniform(x0, x0 + (x1 - x0) * 0.45)
        py = RNG.uniform(y0 + (y1 - y0) * 0.4, y1 - 8)
        m.d.rectangle([px, py, px + RNG.uniform(3, 9), py + RNG.uniform(2, 5)],
                      fill=jit(BARK_DK, 8))
    wear_edges(m, (x0, y0, x1, y1), DIRT, 40)
    fill(m, L.PAD_S, dif=shade(DIRT_DK, 0.9), ao=AO_BASE - 18, rough=225,
         metal=0)


def paint_logs(m):
    # bark wrap: u = length, v = around
    x0, y0, x1, y1 = L.LOG_W
    fill(m, (x0, y0, x1, y1), dif=BARK, ao=AO_BASE - 6, rough=225, metal=0)
    for i in range(6):                                  # facet banding
        fy = y0 + (y1 - y0) * i / 6
        m.d.rectangle([x0, fy, x1, fy + (y1 - y0) / 6],
                      fill=jit(shade(BARK, 0.88 + 0.06 * (i % 3)), 5))
    for _ in range(70):                                 # bark fissures
        gx = RNG.uniform(x0 + 4, x1 - 40)
        gy = RNG.uniform(y0 + 3, y1 - 3)
        m.d.line([(gx, gy), (gx + RNG.uniform(14, 38), gy + RNG.uniform(-2, 2))],
                 fill=jit(BARK_DK, 6), width=1)
    for _ in range(10):                                 # knots + scars
        kx, ky = RNG.uniform(x0 + 10, x1 - 10), RNG.uniform(y0 + 8, y1 - 8)
        m.d.ellipse([kx - 4, ky - 3, kx + 4, ky + 3], fill=shade(BARK_DK, 0.8))
    # bare patches where bark sloughed off
    for fx in (0.18, 0.62, 0.85):
        px = x0 + (x1 - x0) * fx
        py = RNG.uniform(y0 + 8, y1 - 24)
        m.d.ellipse([px, py, px + 26, py + 14], fill=jit(shade(GRAIN, 0.82), 6))
    wear_edges(m, (x0, y0, x1, y1), BARK, 30)

    # end grain
    x0, y0, x1, y1 = L.LOG_E
    fill(m, (x0, y0, x1, y1), dif=GRAIN, ao=AO_BASE - 4, rough=210, metal=0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for rr in range(6, 46, 7):                          # growth rings
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=jit(shade(GRAIN, 0.8), 6))
    m.d.line([(cx - 30, cy - 4), (cx + 22, cy + 8)],    # drying check
             fill=shade(GRAIN, 0.6), width=2)
    m.d.rectangle([x0, y0, x1, y1], outline=BARK_DK, width=3)
    wear_edges(m, (x0, y0, x1, y1), GRAIN, 16)


def paint_lumber(m):
    x0, y0, x1, y1 = L.LUMBER_S
    fill(m, (x0, y0, x1, y1), dif=LUMBER, ao=AO_BASE - 4, rough=210, metal=0)
    layers = 6
    for i in range(layers):                             # board courses
        py0 = y0 + (y1 - y0) * i / layers
        py1 = y0 + (y1 - y0) * (i + 1) / layers
        m.d.rectangle([x0, py0, x1, py1],
                      fill=jit(shade(LUMBER, 0.86 + 0.07 * (i % 3)), 5))
        # sticker gap shadow between courses
        m.d.rectangle([x0, py1 - 3, x1, py1], fill=shade(LUMBER_DK, 0.6))
        m.o.rectangle([x0, py1 - 3, x1, py1], fill=(AO_DEEP, 210, 0))
        # board end joints
        for _ in range(3):
            jx = RNG.uniform(x0 + 20, x1 - 20)
            m.d.line([(jx, py0 + 1), (jx, py1 - 3)], fill=LUMBER_DK, width=1)
    wear_edges(m, (x0, y0, x1, y1), LUMBER, 30)

    x0, y0, x1, y1 = L.LUMBER_T
    fill(m, (x0, y0, x1, y1), dif=shade(LUMBER, 0.96), ao=AO_BASE - 5,
         rough=210, metal=0)
    n = 6
    for i in range(n):                                  # top boards
        py = y0 + (y1 - y0) * i / n
        m.d.rectangle([x0, py, x1, py + (y1 - y0) / n],
                      fill=jit(shade(LUMBER, 0.88 + 0.06 * (i % 2)), 5))
        if i:
            m.d.line([(x0, py), (x1, py)], fill=LUMBER_DK, width=2)
            m.o.line([(x0, py), (x1, py)], fill=(AO_SEAM, 210, 0), width=2)
    # grey weathering bloom on the exposed top
    for _ in range(24):
        gx = RNG.uniform(x0, x1 - 30)
        gy = RNG.uniform(y0, y1 - 8)
        m.d.line([(gx, gy), (gx + RNG.uniform(12, 30), gy)],
                 fill=jit((150, 142, 122), 6), width=1)
    wear_edges(m, (x0, y0, x1, y1), LUMBER, 24)


def paint_shed(m):
    # post wrap
    x0, y0, x1, y1 = L.POST_W
    fill(m, (x0, y0, x1, y1), dif=BENCHW, ao=AO_BASE - 6, rough=215, metal=0)
    for _ in range(30):
        gy = RNG.uniform(y0 + 3, y1 - 3)
        gx = RNG.uniform(x0 + 4, x1 - 30)
        m.d.line([(gx, gy), (gx + RNG.uniform(12, 28), gy)],
                 fill=jit(shade(BENCHW, RNG.uniform(0.82, 1.1)), 5))
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14),
              (x0 + 14, y1 - 14), (x1 - 14, y1 - 14)], r=2, base=BENCHW)
    wear_edges(m, (x0, y0, x1, y1), BENCHW, 30)

    # roof top — corrugation kept tone-on-tone (baker flat-shades big quads)
    x0, y0, x1, y1 = L.ROOF_T
    fill(m, (x0, y0, x1, y1), dif=ROOFC, ao=AO_BASE - 4, rough=180, metal=90)
    n = 26
    for i in range(n):                                  # ±10% corrugation
        px = x0 + (x1 - x0) * i / n
        m.d.rectangle([px, y0, px + (x1 - x0) / n, y1],
                      fill=jit(shade(ROOFC, 0.94 + 0.10 * (i % 2)), 3))
    for fy in (0.33, 0.66):                             # sheet overlaps
        sy = y0 + (y1 - y0) * fy
        m.d.line([(x0, sy), (x1, sy)], fill=shade(ROOFC, 0.85), width=2)
    wear_edges(m, (x0, y0, x1, y1), ROOFC, 26)
    # roof underside / fascia
    fill(m, L.ROOF_U, dif=shade(ROOFC, 0.62), ao=AO_BASE - 34, rough=200,
         metal=60)

    # bench side + top
    x0, y0, x1, y1 = L.BENCH_S
    fill(m, (x0, y0, x1, y1), dif=BENCHW, ao=AO_BASE - 6, rough=205, metal=0)
    for i in range(3):
        py = y0 + (y1 - y0) * (i + 1) / 4
        m.d.line([(x0, py), (x1, py)], fill=shade(BENCHW, 0.7), width=2)
        m.o.line([(x0, py), (x1, py)], fill=(AO_SEAM, 205, 0), width=2)
    for bx in (x0 + 20, (x0 + x1) / 2, x1 - 20):        # leg battens
        m.d.rectangle([bx - 8, y0 + 2, bx + 8, y1 - 2],
                      fill=jit(shade(BENCHW, 0.82), 5))
    wear_edges(m, (x0, y0, x1, y1), BENCHW, 34)
    x0, y0, x1, y1 = L.BENCH_T
    fill(m, (x0, y0, x1, y1), dif=shade(BENCHW, 1.08), ao=AO_BASE - 5,
         rough=195, metal=0)
    # blade slot down the length + sawdust dusting
    cy = (y0 + y1) / 2
    m.d.rectangle([x0 + 8, cy - 4, x1 - 8, cy + 4], fill=BLACKISH)
    m.o.rectangle([x0 + 8, cy - 4, x1 - 8, cy + 4], fill=(AO_DEEP, 195, 0))
    for _ in range(50):
        px = RNG.uniform(x0 + 4, x1 - 8)
        py = RNG.uniform(y0 + 4, y1 - 4)
        m.d.rectangle([px, py, px + RNG.uniform(2, 6), py + RNG.uniform(1, 3)],
                      fill=jit(DUST, 8))
    wear_edges(m, (x0, y0, x1, y1), BENCHW, 26)


def paint_blade(m):
    # disk cell (both faces map here) — pattern must be 16-fold/radially
    # symmetric because the piece spins.
    x0, y0, x1, y1 = L.BLADE_C
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    R = (x1 - x0) / 2 - 2
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 4, rough=90, metal=220)
    # radial brushed-steel sheen (radially symmetric)
    for rr in range(14, int(R), 8):
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=jit(shade(GALV, 0.94 + 0.08 * ((rr // 8) % 2)), 3))
    # gullet ring: 16 evenly spaced dark gullets (matches BLADE_N)
    n = 16
    for i in range(n):
        a = 2 * np.pi * i / n
        gx = cx + (R - 14) * np.cos(a)
        gy = cy + (R - 14) * np.sin(a)
        m.d.ellipse([gx - 6, gy - 6, gx + 6, gy + 6], fill=shade(GALV, 0.55))
        m.o.ellipse([gx - 6, gy - 6, gx + 6, gy + 6], fill=(AO_BASE - 16, 90, 220))
    # tooth ring rim (darker band, symmetric)
    m.d.ellipse([cx - R, cy - R, cx + R, cy + R],
                outline=shade(GALV, 0.7), width=5)
    # hub: concentric only (perfectly rotation-symmetric)
    for rr, s in ((26, 0.8), (18, 1.15), (9, 0.5)):
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    fill=shade(GALV, s))
    m.o.ellipse([cx - 26, cy - 26, cx + 26, cy + 26],
                fill=(AO_BASE - 10, 110, 220))
    # faint radial heat-tint spokes, 16-fold to match the spin symmetry
    for i in range(n):
        a = 2 * np.pi * (i + 0.5) / n
        m.d.line([(cx + 30 * np.cos(a), cy + 30 * np.sin(a)),
                  (cx + (R - 24) * np.cos(a), cy + (R - 24) * np.sin(a))],
                 fill=shade(GALV, 0.9), width=1)

    # arbor wrap
    fill(m, L.ARBOR_W, dif=STEEL_DK, ao=AO_BASE - 10, rough=120, metal=200)
    x0, y0, x1, y1 = L.ARBOR_W
    m.d.line([(x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)],
             fill=shade(STEEL, 1.1), width=2)


def paint_crane(m):
    # mast — red-oxide industrial steel
    x0, y0, x1, y1 = L.MAST_W
    fill(m, (x0, y0, x1, y1), dif=OXIDE, ao=AO_BASE - 5, rough=170, metal=140)
    for fy in (0.3, 0.62):                              # weld collars
        sy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, sy - 3, x1, sy + 3], fill=shade(OXIDE, 1.18))
        m.o.rectangle([x0, sy - 3, x1, sy + 3], fill=(AO_BASE - 12, 160, 150))
    bolts(m, [(x0 + 16, y1 - 12), (x0 + 60, y1 - 12), (x0 + 104, y1 - 12),
              (x0 + 148, y1 - 12)], r=2, base=OXIDE)
    wear_edges(m, (x0, y0, x1, y1), OXIDE, 30)
    # jib
    x0, y0, x1, y1 = L.JIB_W
    fill(m, (x0, y0, x1, y1), dif=shade(OXIDE, 0.92), ao=AO_BASE - 5,
         rough=170, metal=140)
    for fx in np.linspace(0.12, 0.88, 5):               # rivet lines
        sx = x0 + (x1 - x0) * fx
        m.d.line([(sx, y0 + 3), (sx, y1 - 3)], fill=shade(OXIDE, 0.75))
    # hazard tip band
    m.d.rectangle([x1 - 26, y0, x1, y1], fill=YELLOW)
    m.d.rectangle([x1 - 14, y0, x1 - 8, y1], fill=BLACKISH)
    wear_edges(m, (x0, y0, x1, y1), OXIDE, 26)
    # cable
    x0, y0, x1, y1 = L.CABLE_W
    fill(m, (x0, y0, x1, y1), dif=(58, 56, 52), ao=AO_BASE - 12, rough=200,
         metal=120)
    for i in range(10):
        sy = y0 + (y1 - y0) * i / 10
        m.d.line([(x0, sy), (x1, sy)], fill=(44, 42, 40))
    # hook block
    x0, y0, x1, y1 = L.HOOK_C
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=140,
         metal=180)
    m.d.rectangle([x0 + 8, y0 + 8, x1 - 8, y1 - 8],
                  outline=shade(STEEL, 1.1), width=2)
    hzy = y1 - 16
    m.d.rectangle([x0 + 4, hzy, x1 - 4, hzy + 10], fill=YELLOW)
    m.d.rectangle([x0 + 24, hzy, x0 + 36, hzy + 10], fill=BLACKISH)
    # concrete footing
    x0, y0, x1, y1 = L.CONC_C
    fill(m, (x0, y0, x1, y1), dif=(138, 136, 128), ao=AO_BASE - 5,
         rough=195, metal=0)
    seam_v(m, (x0 + x1) // 2, y0 + 2, y1 - 2, (138, 136, 128))
    for _ in range(16):
        px = RNG.uniform(x0 + 4, x1 - 10)
        py = RNG.uniform(y0 + 4, y1 - 6)
        m.d.rectangle([px, py, px + RNG.uniform(2, 7), py + RNG.uniform(2, 5)],
                      fill=jit((122, 120, 112), 6))
    wear_edges(m, (x0, y0, x1, y1), (138, 136, 128), 34)


def paint_sawdust(m):
    x0, y0, x1, y1 = L.SAWDUST
    fill(m, (x0, y0, x1, y1), dif=DUST, ao=AO_BASE - 4, rough=235, metal=0)
    for _ in range(500):
        px = RNG.uniform(x0, x1 - 2)
        py = RNG.uniform(y0, y1 - 2)
        m.d.rectangle([px, py, px + RNG.uniform(1, 3), py + RNG.uniform(1, 2)],
                      fill=jit(shade(DUST, RNG.uniform(0.86, 1.1)), 6))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 30, cy - 30, cx + 30, cy + 30],
                fill=jit(shade(DUST, 1.06), 4))          # fresh crown
    wear_edges(m, (x0, y0, x1, y1), DUST, 20)

    fill(m, L.DARK, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=30)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_logs(m)
    paint_lumber(m)
    paint_shed(m)
    paint_blade(m)
    paint_crane(m)
    paint_sawdust(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.35)
    for rect, s in ((L.LUMBER_S, 0.35), (L.BENCH_S, 0.5), (L.POST_W, 0.45),
                    (L.CONC_C, 0.4), (L.LOG_W, 0.3)):
        x0, y0, x1, y1 = rect
        wx.mud_band((x0, y0, x1, y1), s, fade='down', dust=0.2)
    px0, py0, px1, py1 = L.PAD_T
    wx.mud_band((px0, py0, px1, py1), 0.2, fade=None, spatter=True)
    # oil around the bench/blade slot + under the crane
    wx.oily((L.BENCH_T[0] + 10, L.BENCH_T[1] + 8,
             L.BENCH_T[2] - 10, L.BENCH_T[3] - 8), 0.35)
    # rust: crane steel + roof streaks
    x0, y0, x1, y1 = L.MAST_W
    for fx in np.linspace(0.15, 0.85, 4):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * 0.32,
                       16 + int(fx * 14), width=2.0, strength=0.4)
    wx.plate_bottom_rust(L.MAST_W, n=5, strength=0.5)
    wx.plate_bottom_rust(L.JIB_W, n=4, strength=0.4)
    x0, y0, x1, y1 = L.ROOF_T
    for fx in np.linspace(0.1, 0.9, 6):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 6, 30 + int(fx * 30),
                       width=2.4, strength=0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.45)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    # lumber sticker gaps
    x0, y0, x1, y1 = L.LUMBER_S
    for i in range(1, 6):
        gy = y0 + (y1 - y0) * i / 6
        hm.line((x0 + 2, gy), (x1 - 2, gy), -0.6, width=3)
    # bench slot
    x0, y0, x1, y1 = L.BENCH_T
    hm.line((x0 + 8, (y0 + y1) / 2), (x1 - 8, (y0 + y1) / 2), -0.7, width=6)
    # roof corrugation ridges (subtle)
    x0, y0, x1, y1 = L.ROOF_T
    for i in range(0, 26, 2):
        gx = x0 + (x1 - x0) * i / 26
        hm.line((gx, y0 + 2), (gx, y1 - 2), 0.3, width=3)
    # bark fissure roughness via crevices; blade hub raised
    x0, y0, x1, y1 = L.BLADE_C
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hm.line((cx - 18, cy), (cx + 18, cy), 0.4, width=30)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=3.4).save('out/ms_timber_yard_normals.png')

    # no emissive, no team — map prop
    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save('out/ms_timber_yard_diffuse.png')
    m.orm.save('out/ms_timber_yard_orm.png')
    m.emi.save('out/ms_timber_yard_emissive.png')
    m.tea.save('out/ms_timber_yard_team.png')
    print('[paint_ms_timber_yard] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
