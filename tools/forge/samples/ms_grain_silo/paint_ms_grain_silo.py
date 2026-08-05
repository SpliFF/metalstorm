"""paint_ms_grain_silo — 2048² PBR set for ms_grain_silo.

Civilian-tan / concrete register (STYLE.md palette row 3): tan corrugated
silo sheets on ring seams with bolt rows, galvanised cones + elevator
leg + gallery cladding, stained concrete pad with truck lanes and grain-
dust spill, steel weighbridge with hazard edges, painted cage ladders.
Weathering: eave/ring rust streaks, plate-bottom rust, dust films, oil
at the pit + roller. NO emissive (spec calls for none — map stays black);
team mask limited to small silo ident patches, the gallery band and the
shed door flash.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_grain_silo_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

# macOS/Linux font fallback (paint.FONT default is the Linux DejaVu path)
for _f in ('/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
           '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf',
           '/System/Library/Fonts/Supplemental/Arial Bold.ttf'):
    if os.path.exists(_f):
        P.FONT = _f
        break

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
OUT = '/private/tmp/claude-501/-Users-shannon-WarriorHut-Projects-springrts-web/a3af7b17-2167-4d4d-9b46-0cec735eddd1/scratchpad/forge/ms_grain_silo/out'

# civilian-tan / concrete palette register
TAN      = (196, 180, 146)     # silo sheet tan
TAN_LT   = (209, 195, 164)
TAN_DK   = (172, 156, 124)
CONCRETE = (149, 146, 139)
CONC_DK  = (127, 124, 117)
GALV     = (158, 160, 155)     # galvanised steel (cones, leg, gallery roof)
STEELM   = (96, 100, 104)      # mechanical steel trim
STEEL_DK = (52, 55, 60)
DUSTY    = (206, 192, 158)     # spilled grain dust


def corrugate(m, rect, base, step=8, shade_f=0.86):
    x0, y0, x1, y1 = rect
    for gx in range(int(x0) + step // 2, int(x1), step):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(base, shade_f),
                 width=2)


def cage_ladder(m, x, y0, y1, base):
    """Painted wall ladder + safety cage hoops (greeble-budget friendly)."""
    for rx in (x - 7, x + 7):
        m.d.rectangle([rx - 2, y0, rx + 2, y1], fill=STEEL_DK)
        m.o.rectangle([rx - 2, y0, rx + 2, y1], fill=(AO_SEAM, R_STEEL, M_STEEL))
    yy = y0 + 8
    while yy < y1 - 4:
        m.d.line([(x - 7, yy), (x + 7, yy)], fill=shade(STEEL_DK, 1.5), width=2)
        yy += 12
    yy = y0 + 26
    while yy < y1 - 20:
        m.d.arc([x - 14, yy - 5, x + 14, yy + 5], 0, 180, fill=STEEL_DK,
                width=2)
        yy += 34
    m.d.rectangle([x - 9, y0 - 8, x + 9, y0], fill=YELLOW)


def paint_silos(m):
    x0, y0, x1, y1 = L.Z_SILO
    fill(m, (x0, y0, x1, y1), dif=TAN, ao=AO_BASE - 6, rough=176, metal=64)
    corrugate(m, (x0, y0, x1, y1), TAN)
    # bolted ring seams every ~1.15 m of wall (v spans PAD_TOP-0.05..eave)
    ring_ys = [int(y0 + (y1 - y0) * f) for f in np.linspace(0.09, 0.91, 11)]
    for i, ry in enumerate(ring_ys):
        seam_h(m, x0 + 2, x1 - 2, ry, TAN, hi=False)
        if i % 2 == 0:
            bolts(m, [(x0 + 12 + j * 26, ry + 5)
                      for j in range(int((x1 - x0 - 24) / 26))], base=TAN)
    # staggered vertical sheet laps
    for i, fx in enumerate(np.linspace(0.06, 0.94, 12)):
        sx = int(x0 + (x1 - x0) * fx)
        sy0 = y0 + 4 if i % 2 == 0 else (ring_ys[0] + ring_ys[1]) // 2
        seam_v(m, sx, sy0, y1 - 40, TAN, hi=False)
    # concrete stem wall (bottom ~0.9 m)
    st = y1 - 38
    m.d.rectangle([x0, st, x1, y1], fill=CONCRETE)
    m.o.rectangle([x0, st, x1, y1], fill=(AO_BASE - 20, 205, 8))
    seam_h(m, x0, x1, st, CONCRETE, hi=False)
    # painted cage ladder on one facet + ident + team patch
    cage_ladder(m, x0 + 96, y0 + 30, st - 4, TAN)
    stencil(m, (x0 + 420, y0 + 150), 'GRN-03', 64, shade(TAN, 0.62))
    m.t.rectangle([x0 + 700, y0 + 40, x0 + 800, y0 + 110], fill=(255, 0, 0))
    m.d.rectangle([x0 + 700, y0 + 40, x0 + 800, y0 + 110], fill=TEAMGREY)
    m.d.rectangle([x0 + 700, y0 + 40, x0 + 800, y0 + 110],
                  outline=shade(TAN, 0.6), width=3)
    # aeration fan cowl painted near the base + level gauge strip
    m.d.ellipse([x0 + 980, st - 66, x0 + 1040, st - 6], fill=STEELM)
    m.d.ellipse([x0 + 996, st - 50, x0 + 1024, st - 22], fill=BLACKISH)
    m.o.ellipse([x0 + 980, st - 66, x0 + 1040, st - 6],
                fill=(AO_SEAM, R_STEEL, M_STEEL))
    m.d.rectangle([x0 + 250, y0 + 30, x0 + 264, st - 10], fill=(44, 47, 51))
    m.d.rectangle([x0 + 252, y0 + int((st - y0) * 0.42), x0 + 262, st - 12],
                  fill=(102, 160, 96))
    wear_edges(m, (x0, y0, x1, y1), TAN, 70)
    # eave band: dark steel + bolt row
    x0, y0, x1, y1 = L.Z_EAVE
    fill(m, (x0, y0, x1, y1), dif=STEELM, ao=AO_BASE - 16, rough=160,
         metal=150)
    bolts(m, [(x0 + 10 + j * 24, (y0 + y1) // 2)
              for j in range(int((x1 - x0 - 20) / 24))], base=STEELM)
    # roof cones: galvanised panels, facet seams
    x0, y0, x1, y1 = L.Z_CONE
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 8, rough=150, metal=150)
    for j in range(L.SILO_N + 1):
        sx = int(x0 + (x1 - x0) * j / L.SILO_N)
        seam_v(m, min(sx, x1 - 2), y0 + 2, y1 - 2, GALV, hi=False)
    m.d.rectangle([x0, y0, x1, y0 + 14], fill=shade(GALV, 0.72))  # apex collar
    for fy in (0.45, 0.8):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), GALV, hi=False)
    # hatch drum + lid
    x0, y0, x1, y1 = L.Z_HATCH
    fill(m, (x0, y0, x1, y1), dif=STEELM, ao=AO_BASE - 14, rough=165,
         metal=140)
    m.d.rectangle([x0, y0, x1, y0 + 8], fill=shade(STEELM, 0.7))
    x0, y0, x1, y1 = L.Z_HATCH_TOP
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 8, rough=150, metal=150)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=shade(GALV, 0.85),
                outline=shade(GALV, 0.6), width=3)
    bolts(m, [(cx + np.cos(a) * 34, cy + np.sin(a) * 34)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 6, endpoint=False)],
          base=GALV)


def paint_pad(m):
    zone = L.Z_PAD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4, rough=205,
         metal=8)
    for fx in np.linspace(0.11, 0.89, 8):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, CONCRETE,
               hi=False)
    for fy in np.linspace(0.18, 0.82, 4):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), CONCRETE,
               hi=False)
    for _ in range(16):
        bx = x0 + RNG.random() * (x1 - x0 - 120)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 12), (bx + 88, by), (bx + 116, by + 38),
                     (bx + 24, by + 52)], fill=jit(shade(CONCRETE, 0.94), 3))
    # weighbridge lane (along Z at x = -4.5): worn yellow edge lines
    for lx in (-5.75, -3.25):
        u, _ = zone.uv((lx, 0, 0))
        m.d.rectangle([u * W - 3, y0 + 6, u * W + 3, y1 - 6], fill=YELLOW)
    # load-out lane (along Z at x = 9.35)
    for lx in (8.1, 10.6):
        u, _ = zone.uv((lx, 0, 0))
        m.d.rectangle([u * W - 3, y0 + 6, u * W + 3, y1 - 6],
                      fill=shade(YELLOW, 0.85))
    # tire tracks down both lanes
    for lane_x in (-4.5, 9.35):
        for dx in (-0.55, 0.55):
            u, _ = zone.uv((lane_x + dx, 0, 0))
            for t in range(46):
                ty = y0 + 10 + t * (y1 - y0 - 20) / 46
                m.d.ellipse([u * W - 5, ty - 3, u * W + 5, ty + 3],
                            fill=jit(shade(CONCRETE, 0.82), 4))
    # grain-dust spill around silo bases, the pit and the load-out drop
    for (sx, sz, sr, _e, _a) in L.SILOS:
        u, v = zone.uv((sx, 0, sz))
        rr = (sr + 0.9) * (x1 - x0) / 27.0
        m.d.ellipse([u * W - rr, v * W - rr * 0.62, u * W + rr,
                     v * W + rr * 0.62], fill=jit(DUSTY, 5))
        m.o.ellipse([u * W - rr, v * W - rr * 0.62, u * W + rr,
                     v * W + rr * 0.62], fill=(AO_BASE - 8, 215, 5))
    for (px, pz, pr) in ((L.PIT[0], L.PIT[2], 2.0), (L.LOADOUT_X, L.LEG_Z, 1.4)):
        u, v = zone.uv((px, 0, pz))
        rr = pr * (x1 - x0) / 27.0
        m.d.ellipse([u * W - rr, v * W - rr * 0.62, u * W + rr,
                     v * W + rr * 0.62], fill=jit(DUSTY, 5))
    # pad ident
    u, v = zone.uv((11.6, 0, -6.8))
    f = ImageFont.truetype(P.FONT, 66)
    m.d.text((u * W, v * W), '03', font=f, fill=shade(CONCRETE, 0.72))
    # pad sides: concrete with a chevron strip at the lane entries
    x0, y0, x1, y1 = L.Z_PADS.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.92), ao=AO_BASE - 12,
         rough=210, metal=5)
    seam_h(m, x0, x1, y0 + (y1 - y0) // 2, CONCRETE, hi=False)
    for i in range(int((x1 - x0) / 18) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 18, y0 + 2), (x0 + i * 18 + 18, y0 + 2),
                     (x0 + i * 18 + 9, y0 + 10), (x0 + i * 18 - 9, y0 + 10)],
                    fill=c)


def paint_leg(m):
    for zone in (L.Z_LEG, ):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 8, rough=155,
             metal=150)
        # trunk panel seams every ~1.1 m + bolts
        for fy in np.linspace(0.06, 0.94, 12):
            sy = int(y0 + (y1 - y0) * fy)
            seam_h(m, x0 + 4, x1 - 4, sy, GALV, hi=False)
        bolts(m, [(x0 + 12, int(y0 + (y1 - y0) * f)) for f in
                  np.linspace(0.08, 0.92, 8)] +
              [(x1 - 12, int(y0 + (y1 - y0) * f)) for f in
               np.linspace(0.08, 0.92, 8)], base=GALV)
        # painted cage ladder up the trunk face
        cage_ladder(m, (x0 + x1) // 2, y0 + 30, y1 - 60, GALV)
        stencil(m, (x0 + 24, y1 - 120), 'ELV-1', 30, shade(GALV, 0.6))
    # boot/pit/bearing trim + generic steel
    x0, y0, x1, y1 = L.Z_TRIMZ.rect
    fill(m, (x0, y0, x1, y1), dif=STEELM, ao=AO_BASE - 14, rough=160,
         metal=155)
    for fy in (0.3, 0.7):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), STEELM, hi=False)
    fill(m, L.Z_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    # spout wrap: steel tube with flange collars
    x0, y0, x1, y1 = L.Z_SPOUT
    fill(m, (x0, y0, x1, y1), dif=(112, 114, 116), ao=AO_BASE - 12,
         rough=150, metal=170)
    for fx in (0.12, 0.5, 0.88):
        sx = int(x0 + (x1 - x0) * fx)
        m.d.rectangle([sx - 4, y0, sx + 4, y1],
                      fill=shade((112, 114, 116), 0.7))
    # trim wrap (rails/posts/bollards): dark steel + bollard hazard bands
    x0, y0, x1, y1 = L.Z_TRIM
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 15, rough=165,
         metal=150)
    m.d.rectangle([x0, y0, x1, y0 + 18], fill=YELLOW)


def paint_head(m):
    x0, y0, x1, y1 = L.Z_HEAD.rect
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 6, rough=152, metal=150)
    corrugate(m, (x0, y0, x1, y1), GALV, step=12, shade_f=0.88)
    # access louver + inspection door
    lv = [x0 + 30, y0 + 40, x0 + 130, y0 + 120]
    m.d.rectangle(lv, fill=STEEL_DK)
    vent_slots(m, [lv[0] + 6, lv[1] + 6, lv[2] - 6, lv[3] - 6], 4)
    m.d.rectangle([x1 - 120, y0 + 50, x1 - 40, y1 - 30], fill=(70, 74, 78),
                  outline=shade(GALV, 0.6), width=3)
    m.o.rectangle([x1 - 120, y0 + 50, x1 - 40, y1 - 30],
                  fill=(AO_BASE - 20, R_ARMOR, M_ARMOR))
    # bottom hazard strip + team band along the head crown
    for i in range(int((x1 - x0) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 16, y1 - 12), (x0 + i * 16 + 16, y1 - 12),
                     (x0 + i * 16 + 8, y1 - 2), (x0 + i * 16 - 8, y1 - 2)],
                    fill=c)
    m.t.rectangle([x0 + 4, y0 + 6, x1 - 4, y0 + 26], fill=(255, 0, 0))
    m.d.rectangle([x0 + 4, y0 + 6, x1 - 4, y0 + 26], fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), GALV, 45)
    x0, y0, x1, y1 = L.Z_HEAD_ROOF.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GALV, 0.95), ao=AO_BASE - 10,
         rough=155, metal=150)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, GALV, hi=False)
    m.d.rectangle([x0 + 26, y0 + 26, x0 + 80, y0 + 74],
                  fill=shade(GALV, 0.8), outline=shade(GALV, 0.6), width=3)


def paint_gallery(m):
    x0, y0, x1, y1 = L.Z_GAL_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=TAN, ao=AO_BASE - 6, rough=176, metal=64)
    corrugate(m, (x0, y0, x1, y1), TAN)
    # structural chords top + bottom
    m.d.rectangle([x0, y0, x1, y0 + 12], fill=STEELM)
    m.d.rectangle([x0, y1 - 12, x1, y1], fill=STEELM)
    m.o.rectangle([x0, y1 - 12, x1, y1], fill=(AO_SEAM, R_STEEL, M_STEEL))
    # inspection hatches every ~3 m + support-frame verticals
    for fx in np.linspace(0.1, 0.9, 5):
        sx = int(x0 + (x1 - x0) * fx)
        m.d.rectangle([sx - 22, y0 + 40, sx + 22, y0 + 84],
                      fill=shade(TAN, 0.8), outline=shade(TAN, 0.6), width=3)
        m.o.rectangle([sx - 22, y0 + 40, sx + 22, y0 + 84],
                      fill=(AO_BASE - 18, R_ARMOR, M_ARMOR))
    for fx in np.linspace(0.04, 0.96, 9):
        sx = int(x0 + (x1 - x0) * fx)
        m.d.rectangle([sx - 3, y0 + 10, sx + 3, y1 - 10],
                      fill=shade(TAN, 0.72))
    # team band along the length
    m.t.rectangle([x0 + 4, y0 + 16, x1 - 4, y0 + 34], fill=(255, 0, 0))
    m.d.rectangle([x0 + 4, y0 + 16, x1 - 4, y0 + 34], fill=TEAMGREY)
    stencil(m, (x0 + 60, y0 + 44), 'GRAIN CO-OP 03', 30, shade(TAN, 0.6))
    wear_edges(m, (x0, y0, x1, y1), TAN, 50)
    # roof/underside: galvanised with cross seams + walk strip
    x0, y0, x1, y1 = L.Z_GAL_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 10, rough=152,
         metal=150)
    for fx in np.linspace(0.05, 0.95, 12):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, GALV, hi=False)
    m.d.rectangle([x0 + 10, (y0 + y1) // 2 - 10, x1 - 10,
                   (y0 + y1) // 2 + 10], fill=shade(GALV, 0.85))
    # east end wall: belt-exit mouth + hazard border
    x0, y0, x1, y1 = L.Z_GAL_END.rect
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 10, rough=152,
         metal=150)
    mouth = [x0 + 24, y0 + 44, x1 - 24, y1 - 30]
    m.d.rectangle(mouth, fill=BLACKISH)
    m.o.rectangle(mouth, fill=(AO_DEEP, R_STEEL, M_STEEL))
    for i in range(int((mouth[2] - mouth[0]) / 14) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(mouth[0] + i * 14, mouth[1] - 10),
                     (mouth[0] + i * 14 + 14, mouth[1] - 10),
                     (mouth[0] + i * 14 + 7, mouth[1] - 2),
                     (mouth[0] + i * 14 - 7, mouth[1] - 2)], fill=c)
    # roller: rubber-lagged drum with herringbone grip + steel hub caps
    x0, y0, x1, y1 = L.Z_ROLLER
    fill(m, (x0, y0, x1, y1), dif=(42, 42, 46), ao=AO_BASE - 16, rough=205,
         metal=30)
    for gx in range(x0 + 10, x1 - 10, 24):
        m.d.line([(gx, y0 + 4), (gx + 16, (y0 + y1) // 2)],
                 fill=(58, 58, 62), width=3)
        m.d.line([(gx + 16, (y0 + y1) // 2), (gx, y1 - 4)],
                 fill=(58, 58, 62), width=3)
    x0, y0, x1, y1 = L.Z_ROLLER_CAP
    fill(m, (x0, y0, x1, y1), dif=STEELM, ao=AO_BASE - 10, rough=140,
         metal=185)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 18, cy - 18, cx + 18, cy + 18], fill=STEEL_DK)
    bolts(m, [(cx + np.cos(a) * 40, cy + np.sin(a) * 40)
              for a in np.linspace(0.2, 2 * np.pi + 0.2, 6, endpoint=False)],
          base=STEELM)


def paint_shed(m):
    for zone, is_front in ((L.Z_SHED_SIDE, False), (L.Z_SHED_FRONT, True)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=TAN_LT, ao=AO_BASE - 4, rough=180,
             metal=40)
        corrugate(m, (x0, y0, x1, y1), TAN_LT, step=10, shade_f=0.88)
        # concrete plinth
        wy = int(y1 - (y1 - y0) * 0.16)
        m.d.rectangle([x0, wy, x1, y1], fill=CONC_DK)
        m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 22, 205, 8))
        seam_h(m, x0, x1, wy, TAN_LT, hi=False)
        if is_front:
            # office door + WEIGH sign + team flash
            db = [x0 + 70, wy - 150, x0 + 150, y1 - 8]
            m.d.rectangle(db, fill=(60, 64, 68), outline=STEEL_DK, width=3)
            m.o.rectangle(db, fill=(AO_BASE - 20, R_ARMOR, M_ARMOR))
            stencil(m, (x0 + 190, y0 + 40), 'WEIGH', 44, shade(TAN_LT, 0.58))
            m.t.rectangle([x1 - 120, y0 + 30, x1 - 40, y0 + 86],
                          fill=(255, 0, 0))
            m.d.rectangle([x1 - 120, y0 + 30, x1 - 40, y0 + 86],
                          fill=TEAMGREY)
        else:
            # window band looking over the bridge
            for i in range(3):
                wx0 = x0 + 60 + i * 130
                wb = [wx0, y0 + 60, wx0 + 96, y0 + 128]
                m.d.rectangle(wb, fill=GLASS, outline=STEEL_DK, width=3)
                m.o.rectangle(wb, fill=(AO_BASE, R_GLASS, M_GLASS))
        wear_edges(m, (x0, wy, x1, y1), CONC_DK, 40)
    x0, y0, x1, y1 = L.Z_SHED_ROOF.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GALV, 0.94), ao=AO_BASE - 8,
         rough=158, metal=145)
    for fy in np.linspace(0.15, 0.85, 5):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), GALV, hi=False)


def paint_bridge(m):
    x0, y0, x1, y1 = L.Z_BRIDGE.rect
    fill(m, (x0, y0, x1, y1), dif=(64, 66, 70), ao=AO_BASE - 12, rough=165,
         metal=175)
    # deck plate seams + wheel-track wear
    for fy in np.linspace(0.12, 0.88, 6):
        seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * fy), (64, 66, 70),
               hi=False)
    for fx in (0.3, 0.7):
        tx = x0 + (x1 - x0) * fx
        m.d.rectangle([tx - 16, y0 + 8, tx + 16, y1 - 8],
                      fill=shade((64, 66, 70), 1.18))
    # yellow edge stripes + load stencil
    for ex in (x0 + 4, x1 - 12):
        m.d.rectangle([ex, y0 + 4, ex + 8, y1 - 4], fill=YELLOW)
    stencil(m, (x0 + 70, y0 + 30), 'MAX 40t', 30, shade((200, 200, 200), 0.9))
    bolts(m, [(x0 + 24, int(y0 + (y1 - y0) * f)) for f in
              np.linspace(0.1, 0.9, 6)] +
          [(x1 - 24, int(y0 + (y1 - y0) * f)) for f in
           np.linspace(0.1, 0.9, 6)], base=(64, 66, 70))
    # receiving grate: dark bars + dust
    x0, y0, x1, y1 = L.Z_GRATE.rect
    fill(m, (x0, y0, x1, y1), dif=BLACKISH, ao=AO_DEEP, rough=190, metal=90)
    vent_slots(m, [x0 + 10, y0 + 10, x1 - 10, y1 - 10], 7)
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=STEELM, width=5)
    for _ in range(30):
        gx = x0 + RNG.random() * (x1 - x0)
        gy = y0 + RNG.random() * (y1 - y0)
        m.d.ellipse([gx - 3, gy - 2, gx + 3, gy + 2], fill=jit(DUSTY, 8))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_silos(m)
    paint_pad(m)
    paint_leg(m)
    paint_head(m)
    paint_gallery(m)
    paint_shed(m)
    paint_bridge(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=61)
    wx.crevice_grime(m.dif, 0.45)
    # silo wrap: dust film + rust off the ring seams and the stem line
    x0, y0, x1, y1 = L.Z_SILO
    wx.mud_band((x0, y0, x1, y1), 0.4, fade='down', dust=0.3)
    for i in range(10):
        sx = x0 + (x1 - x0) * (i + 0.5 + 0.3 * (i % 2)) / 10
        wx.rust_streak(sx, y0 + 60 + (i * 53) % 380, 30 + (i * 11) % 40,
                       width=2.6, strength=0.34)
    wx.plate_bottom_rust((x0, y0, x1, y1 - 38), n=9, strength=0.5)
    # cones: rain/rust streaks running downslope from the apex collar
    x0, y0, x1, y1 = L.Z_CONE
    for fx in (0.14, 0.33, 0.52, 0.71, 0.9):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 18, 60, width=3.4,
                       strength=0.36)
    wx.mud_band((x0, y0, x1, y1), 0.2, fade=None, spatter=False, dust=0.25)
    # leg + head: dust low, streaks from panel seams
    wx.mud_band(L.Z_LEG.rect, 0.4, fade='down', dust=0.25)
    wx.plate_bottom_rust(L.Z_LEG.rect, n=6, strength=0.5)
    wx.mud_band(L.Z_HEAD.rect, 0.22, fade='down', dust=0.2)
    # gallery: streaks off the top chord
    x0, y0, x1, y1 = L.Z_GAL_SIDE.rect
    for fx in np.linspace(0.06, 0.94, 10):
        wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 16, 26, width=2.2,
                       strength=0.3)
    wx.mud_band(L.Z_GAL_TOP.rect, 0.25, fade=None, spatter=False)
    # pad: edge dust + oil at pit lane end and under the roller
    wx.mud_band(L.Z_PAD.rect, 0.24, fade=None, spatter=True)
    pz = L.Z_PAD
    px0, py0, px1, py1 = pz.rect
    pu, pv = pz.uv((L.PIT[0], 0, L.PIT[2]))
    wx.oily((pu * W - 90, pv * W - 60, pu * W + 90, pv * W + 60), 0.45)
    lu, lv = pz.uv((L.LOADOUT_X, 0, L.LEG_Z))
    wx.oily((lu * W - 60, lv * W - 46, lu * W + 60, lv * W + 46), 0.3)
    wx.mud_band(L.Z_PADS.rect, 0.5, fade='down')
    # shed + bridge
    wx.mud_band(L.Z_SHED_SIDE.rect, 0.3, fade='down', dust=0.2)
    wx.mud_band(L.Z_SHED_FRONT.rect, 0.3, fade='down', dust=0.2)
    wx.oily(L.Z_BRIDGE.rect, 0.28)
    wx.oily(L.Z_ROLLER, 0.35)
    wx.soot_patch(L.Z_GRATE.rect, 0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for rect, step in ((L.Z_SILO, 8), (L.Z_GAL_SIDE.rect, 8),
                       (L.Z_SHED_SIDE.rect, 10), (L.Z_SHED_FRONT.rect, 10),
                       (L.Z_HEAD.rect, 12)):
        x0, y0, x1, y1 = rect
        for gx in range(int(x0) + step // 2, int(x1), step):
            hm.line((gx, y0 + 2), (gx, y1 - 2), 0.4, width=2)
    # silo ring seams recessed
    x0, y0, x1, y1 = L.Z_SILO
    for f in np.linspace(0.09, 0.91, 11):
        hm.line((x0 + 2, y0 + (y1 - y0) * f), (x1 - 2, y0 + (y1 - y0) * f),
                -0.45, width=2)
    # pad expansion joints recessed
    x0, y0, x1, y1 = L.Z_PAD.rect
    for fx in np.linspace(0.11, 0.89, 8):
        hm.line((x0 + (x1 - x0) * fx, y0 + 2), (x0 + (x1 - x0) * fx, y1 - 2),
                -0.5, width=3)
    for fy in np.linspace(0.18, 0.82, 4):
        hm.line((x0 + 2, y0 + (y1 - y0) * fy), (x1 - 2, y0 + (y1 - y0) * fy),
                -0.5, width=3)
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.4).save(f'{OUT}/ms_grain_silo_normals.png')

    # emissive stays black: the spec names no lit elements on this site
    m.dif.save(f'{OUT}/ms_grain_silo_diffuse.png')
    m.orm.save(f'{OUT}/ms_grain_silo_orm.png')
    m.emi.save(f'{OUT}/ms_grain_silo_emissive.png')
    m.tea.save(f'{OUT}/ms_grain_silo_team.png')
    print('[paint_ms_grain_silo] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
