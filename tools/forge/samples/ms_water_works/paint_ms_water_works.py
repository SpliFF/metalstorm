"""paint_ms_water_works — 2048² PBR set for ms_water_works.

Named-resource-site read: pale riveted tank with plate courses + rivet
rows, red-oxide cone roof, WATER ident + level gauge, the signature
overflow stain (mineral-white + rust bleeding down the front facet seam,
drip halo on the catwalk, algae-dark ground patch), tan corrugated
pumphouse with dark windows, hazard-striped counterweight, spoked
valve/flywheel, banded water drums, stained concrete pad. Weathering:
rust weeps off every rivet seam, soot at the stack, oil at the crank.
Team mask: tank crown band + pumphouse door square. Emissive: none —
the spec calls out no lit features (map stays black).
"""
from __future__ import annotations
import numpy as np
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_water_works_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, STEEL, STEEL_DK, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
# macOS fallback for the painter's stencil font
if not os.path.exists(P.FONT):
    P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
FONT = P.FONT

CONCRETE = (148, 146, 140)
TANKC = (139, 141, 134)          # pale weathered tank steel
ROOFC = (122, 76, 58)            # red-oxide cone roof
SIDING = (134, 122, 102)         # tan corrugated pumphouse
WAINSCOT = (66, 62, 56)
PIPEC = (86, 94, 88)             # painted utility pipe green-grey
LEGC = (88, 92, 97)              # tower trestle steel
MINERAL = (196, 198, 190)        # calcite overflow bloom


def corrugate(m, rect, base, step=10, shade_f=0.82, horizontal=False):
    x0, y0, x1, y1 = rect
    if horizontal:
        for gy in range(int(y0) + step // 2, int(y1), step):
            m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(base, shade_f),
                     width=2)
    else:
        for gx in range(int(x0) + step // 2, int(x1), step):
            m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(base, shade_f),
                     width=2)


def paint_pad(m):
    zone = L.W_PAD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4, rough=205, metal=8)
    for fx in np.linspace(0.14, 0.86, 6):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, CONCRETE, hi=False)
    for fy in np.linspace(0.2, 0.8, 4):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fy), CONCRETE, hi=False)
    for _ in range(12):
        bx = x0 + RNG.random() * (x1 - x0 - 120)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 12), (bx + 90, by), (bx + 116, by + 38),
                     (bx + 24, by + 52)], fill=jit(shade(CONCRETE, 0.94), 3))
    # service lane from the pad edge to the standpipe
    su, sv = zone.uv((L.STAND_X, 0, L.STAND_Z))
    lu, lv = zone.uv((L.STAND_X + 2.4, 0, -8.2))
    m.d.rectangle([su * W - 60, lv * W, lu * W, sv * W], outline=YELLOW,
                  width=5)
    # algae-dark overflow ground stain below the catwalk drip line
    ou, ov = zone.uv((L.TWR_X, 0, L.TWR_Z - 4.0))
    for r, c in ((58, (92, 96, 82)), (40, (76, 82, 68)), (24, (62, 70, 58))):
        m.d.ellipse([ou * W - r, ov * W - r * 0.62, ou * W + r,
                     ov * W + r * 0.62], fill=c)
        m.o.ellipse([ou * W - r, ov * W - r * 0.62, ou * W + r,
                     ov * W + r * 0.62], fill=(AO_BASE - 30, 150, 20))
    # damp run-off channel toward the pad edge (front)
    eu, ev = zone.uv((L.TWR_X, 0, -8.2))
    m.d.line([(ou * W, ov * W), (eu * W, ev * W)],
             fill=(84, 90, 80), width=9)
    # puddle under the standpipe spout
    pu, pv = zone.uv((L.STAND_X, 0, L.STAND_Z - 0.7))
    m.d.ellipse([pu * W - 16, pv * W - 10, pu * W + 16, pv * W + 10],
                fill=(88, 94, 86))
    m.o.ellipse([pu * W - 16, pv * W - 10, pu * W + 16, pv * W + 10],
                fill=(AO_BASE - 20, 90, 30))
    # pad edges: darker concrete + hazard chevron lip
    for zone in (L.W_PADS, L.W_PADS_F):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.9), ao=AO_BASE - 12,
             rough=210, metal=5)
        seam_h(m, x0, x1, y0 + (y1 - y0) // 3, CONCRETE, hi=False)
        for i in range(int((x1 - x0) / 18) + 1):
            c = YELLOW if i % 2 == 0 else BLACKISH
            m.d.polygon([(x0 + i * 18, y0 + 2), (x0 + i * 18 + 18, y0 + 2),
                         (x0 + i * 18 + 9, y0 + 12), (x0 + i * 18 - 9, y0 + 12)],
                        fill=c)


def paint_tank(m):
    x0, y0, x1, y1 = L.W_TANK
    fill(m, (x0, y0, x1, y1), dif=TANKC, ao=AO_BASE - 6, rough=165, metal=125)
    n = L.TANK_N
    # three plate courses; riveted seams + staggered vertical joints
    course_vs = [y0 + (y1 - y0) * f for f in (0.27, 0.52, 0.77)]
    for ci, sy in enumerate(course_vs):
        seam_h(m, x0, x1, int(sy), TANKC)
        bolts(m, [(x0 + 8 + i * 14, sy - 5) for i in range((x1 - x0 - 10) // 14)],
              base=TANKC)
    for j in range(n):
        fx = x0 + (x1 - x0) * j / n
        for ci, (cv0, cv1) in enumerate(((y0, course_vs[0]),
                                         (course_vs[0], course_vs[1]),
                                         (course_vs[1], course_vs[2]),
                                         (course_vs[2], y1))):
            off = (x1 - x0) / n * (0.5 if ci % 2 else 0.0)
            sx = fx + off
            if sx < x1 - 2:
                seam_v(m, int(sx), int(cv0) + 2, int(cv1) - 2, TANKC, hi=False)
                bolts(m, [(sx + 5, cv0 + 10 + k * 16)
                          for k in range(int((cv1 - cv0 - 16) / 16))],
                      base=TANKC)
    # crown: team band under the roof line
    m.t.rectangle([x0, y0 + 10, x1, y0 + 44], fill=(255, 0, 0))
    m.d.rectangle([x0, y0 + 10, x1, y0 + 44], fill=TEAMGREY)
    m.d.rectangle([x0, y0 + 44, x1, y0 + 50], fill=shade(TANKC, 0.6))
    # big ident on the facet left of the overflow seam (u 0.6..0.7)
    iu0 = x0 + (x1 - x0) * 0.6
    f = ImageFont.truetype(FONT, 64)
    m.d.text((iu0 + 12 + 3, y0 + 130 + 3), 'WATER', font=f,
             fill=shade(TANKC, 0.55))
    m.d.text((iu0 + 12, y0 + 130), 'WATER', font=f, fill=(210, 212, 205))
    stencil(m, (iu0 + 16, y0 + 205), 'WKS-04', 30, shade(TANKC, 0.6),
            bridge=False)
    # level gauge on the facet at u ~0.5
    gx = x0 + (x1 - x0) * 0.53
    m.d.rectangle([gx, y0 + 70, gx + 14, y1 - 30], fill=(40, 44, 48))
    m.d.rectangle([gx + 2, y0 + (y1 - y0) * 0.42, gx + 12, y1 - 32],
                  fill=(96, 150, 160))
    m.o.rectangle([gx, y0 + 70, gx + 14, y1 - 30], fill=(AO_SEAM, R_GLASS, 0))
    # ── the overflow stain (spec feature): failed joint at u = 0.7 ──
    ox = x0 + (x1 - x0) * L.OVER_F
    # mineral bloom widening down the seam
    for i in range(int(y1 - (y0 + 50))):
        yy = y0 + 50 + i
        t = i / (y1 - y0 - 50)
        half = 3 + t * 17
        c = jit(MINERAL, 6) if RNG.random() > 0.3 else shade(MINERAL, 0.9)
        m.d.line([(ox - half, yy), (ox + half, yy)], fill=c, width=1)
    m.o.rectangle([ox - 20, y0 + 50, ox + 20, y1], fill=(AO_BASE - 18, 200, 30))
    wear_edges(m, (x0, y0, x1, y1), TANKC, 50)
    # underside
    x0, y0, x1, y1 = L.W_TANK_BOT.rect
    fill(m, (x0, y0, x1, y1), dif=shade(TANKC, 0.55), ao=AO_DEEP + 20,
         rough=185, metal=90)


def paint_roof(m):
    zone = L.W_ROOF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ROOFC, ao=AO_BASE - 8, rough=190, metal=70)
    cu, cv = zone.uv((L.TWR_X, 0, L.TWR_Z))
    ccx, ccy = cu * W, cv * W
    for a in np.linspace(0, 2 * np.pi, L.TANK_N, endpoint=False):
        m.d.line([(ccx, ccy), (ccx + np.cos(a) * 240, ccy + np.sin(a) * 240)],
                 fill=shade(ROOFC, 0.7), width=3)
    # access hatch near the apex + finial base plate
    m.d.rectangle([ccx + 40, ccy - 70, ccx + 110, ccy - 20],
                  fill=shade(ROOFC, 0.6), outline=STEEL_DK, width=3)
    m.o.rectangle([ccx + 40, ccy - 70, ccx + 110, ccy - 20],
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    m.d.ellipse([ccx - 26, ccy - 26, ccx + 26, ccy + 26],
                fill=shade(ROOFC, 0.8), outline=shade(ROOFC, 0.55), width=3)
    bolts(m, [(ccx + np.cos(a) * 20, ccy + np.sin(a) * 20)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 6, endpoint=False)],
          base=ROOFC)
    wear_edges(m, (x0, y0, x1, y1), ROOFC, 40)


def paint_catwalk(m):
    zone = L.W_CATWALK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(76, 80, 85), ao=AO_BASE - 14, rough=175,
         metal=150)
    cu, cv = zone.uv((L.TWR_X, 0, L.TWR_Z))
    ccx, ccy = cu * W, cv * W
    for a in np.linspace(0, 2 * np.pi, 20, endpoint=False):
        m.d.line([(ccx + np.cos(a) * 120, ccy + np.sin(a) * 120),
                  (ccx + np.cos(a) * 210, ccy + np.sin(a) * 210)],
                 fill=shade((76, 80, 85), 0.72), width=2)
    # drip halo where the overflow lands (world -4.6, -3.15)
    du, dv = zone.uv((L.TWR_X, 0, L.TWR_Z - 3.75))
    for r, c in ((26, jit(MINERAL, 4)), (17, (120, 96, 70)), (9, (86, 60, 40))):
        m.d.ellipse([du * W - r, dv * W - r, du * W + r, dv * W + r], fill=c)
    m.o.ellipse([du * W - 26, dv * W - 26, du * W + 26, dv * W + 26],
                fill=(AO_BASE - 24, 200, 40))


def paint_ladder(m):
    zone = L.W_LADDER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LEGC, 0.75), ao=AO_BASE - 16,
         rough=170, metal=160)
    m.d.rectangle([x0, y0, x0 + 10, y1], fill=shade(LEGC, 0.55))
    m.d.rectangle([x1 - 10, y0, x1, y1], fill=shade(LEGC, 0.55))
    for gy in range(int(y0) + 8, int(y1) - 4, 17):
        m.d.rectangle([x0 + 12, gy, x1 - 12, gy + 5], fill=shade(LEGC, 0.4))
        m.d.line([(x0 + 12, gy), (x1 - 12, gy)], fill=shade(LEGC, 1.2), width=1)
    m.d.rectangle([x0, y0, x1, y0 + 30], fill=YELLOW)  # safety top


def paint_house(m):
    # flanks: corrugated siding + two dark windows + wainscot
    zone = L.W_HOUSE_S
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=SIDING, ao=AO_BASE - 6, rough=185, metal=60)
    corrugate(m, (x0, y0, x1, y1), SIDING, step=11)
    for wz in (1.2, 3.5):
        wu0, wv0 = zone.uv((0, 3.2, wz))
        wu1, wv1 = zone.uv((0, 2.15, wz + 0.9))
        wb = [wu0 * W, wv0 * W, wu1 * W, wv1 * W]
        m.d.rectangle(wb, fill=GLASS, outline=(188, 184, 172), width=4)
        m.d.line([((wb[0] + wb[2]) / 2, wb[1]), ((wb[0] + wb[2]) / 2, wb[3])],
                 fill=(188, 184, 172), width=3)
        m.o.rectangle(wb, fill=(AO_BASE, R_GLASS, M_GLASS))
    wy = int(y1 - (y1 - y0) * 0.2)
    m.d.rectangle([x0, wy, x1, y1], fill=WAINSCOT)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 25, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, SIDING)
    wear_edges(m, (x0, wy, x1, y1), WAINSCOT, 40)
    # front: door + signboard + team square
    zone = L.W_HOUSE_F
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=SIDING, ao=AO_BASE - 6, rough=185, metal=60)
    corrugate(m, (x0, y0, x1, y1), SIDING, step=11)
    du0, dv0 = zone.uv((6.1, 3.15, 0))
    du1, dv1 = zone.uv((4.7, 0.95, 0))
    db = [du0 * W, dv0 * W, du1 * W, dv1 * W]
    m.d.rectangle(db, fill=(56, 58, 62), outline=shade(SIDING, 0.55), width=4)
    m.o.rectangle(db, fill=(AO_BASE - 25, R_ARMOR, M_ARMOR))
    m.d.line([(db[0] + 14, db[1] + 10), (db[0] + 14, db[3] - 10)],
             fill=shade((56, 58, 62), 1.4), width=2)
    # signboard over the door
    sb = [(db[0] + db[2]) / 2 - 74, db[1] - 46, (db[0] + db[2]) / 2 + 74,
          db[1] - 12]
    m.d.rectangle(sb, fill=(52, 56, 60), outline=(180, 176, 164), width=2)
    f = ImageFont.truetype(FONT, 22)
    m.d.text((sb[0] + 10, sb[1] + 5), 'WATER WORKS', font=f,
             fill=(206, 208, 200))
    # team square by the door
    m.t.rectangle([db[2] + 16, db[3] - 60, db[2] + 60, db[3] - 16],
                  fill=(255, 0, 0))
    m.d.rectangle([db[2] + 16, db[3] - 60, db[2] + 60, db[3] - 16],
                  fill=TEAMGREY)
    wy = int(y1 - (y1 - y0) * 0.2)
    m.d.rectangle([x0, wy, x1, y1], fill=WAINSCOT)
    seam_h(m, x0, x1, wy, SIDING)
    # rear: louver vent + pipe entry plate
    zone = L.W_HOUSE_R
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=SIDING, ao=AO_BASE - 6, rough=185, metal=60)
    corrugate(m, (x0, y0, x1, y1), SIDING, step=11)
    vu0, vv0 = zone.uv((5.2, 3.3, 0))
    vu1, vv1 = zone.uv((6.4, 2.5, 0))
    vb = [vu0 * W, vv0 * W, vu1 * W, vv1 * W]
    m.d.rectangle(vb, fill=STEEL_DK)
    vent_slots(m, [vb[0] + 4, vb[1] + 4, vb[2] - 4, vb[3] - 4], 4)
    wy = int(y1 - (y1 - y0) * 0.2)
    m.d.rectangle([x0, wy, x1, y1], fill=WAINSCOT)
    seam_h(m, x0, x1, wy, SIDING)
    wear_edges(m, (x0, wy, x1, y1), WAINSCOT, 30)
    # roof: corrugated sheets, ribs down-slope, ridge cap
    zone = L.W_HOUSE_RF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(94, 90, 84), ao=AO_BASE - 10, rough=195,
         metal=90)
    corrugate(m, (x0, y0, x1, y1), (94, 90, 84), step=12, horizontal=True)
    ru, _ = zone.uv((L.HOUSE[0], 0, 0))
    m.d.rectangle([ru * W - 8, y0, ru * W + 8, y1], fill=shade((94, 90, 84), 0.7))
    m.o.rectangle([ru * W - 8, y0, ru * W + 8, y1],
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), (94, 90, 84), 35)


def paint_pump(m):
    # beam: worked steel, rivet row, worn edges
    zone = L.W_BEAM
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(92, 88, 82), ao=AO_BASE - 10, rough=155,
         metal=170)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2 - 8, (92, 88, 82), hi=False)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2 + 8, (92, 88, 82), hi=False)
    bolts(m, [(x0 + 14 + i * 24, (y0 + y1) / 2) for i in range((x1 - x0 - 20) // 24)],
          base=(92, 88, 82))
    stencil(m, (x0 + (x1 - x0) * 0.55, y0 + 18), 'PUMP-04', 20,
            shade((92, 88, 82), 1.4), bridge=False)
    wear_edges(m, (x0, y0, x1, y1), (92, 88, 82), 55)
    # horsehead: dark forged steel with a worn face stripe
    zone = L.W_HEAD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(58, 60, 64), ao=AO_BASE - 16, rough=150,
         metal=185)
    m.d.rectangle([x0 + 8, y0 + 20, x1 - 8, y0 + 34], fill=shade((58, 60, 64), 1.35))
    wear_edges(m, (x0, y0, x1, y1), (58, 60, 64), 45)
    # counterweight: hazard diagonals over dark iron
    zone = L.W_WEIGHT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(70, 68, 64), ao=AO_BASE - 12, rough=170,
         metal=150)
    for i in range(-4, int((x1 - x0) / 26) + 4):
        gx = x0 + i * 26
        m.d.polygon([(gx, y1), (gx + 13, y1), (gx + 13 + (y1 - y0), y0),
                     (gx + (y1 - y0), y0)], fill=YELLOW if i % 2 == 0 else (70, 68, 64))
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade((70, 68, 64), 0.6),
                  width=4)
    wear_edges(m, (x0, y0, x1, y1), (70, 68, 64), 60)
    # wellhead / crank housing: machine green, bolts, plate seams
    zone = L.W_WELL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0 - 12, y0 - 8, x1 + 12, y1 + 8), dif=(78, 88, 80),
         ao=AO_BASE - 12, rough=160, metal=165)
    seam_h(m, x0, x1, (y0 + y1) // 2, (78, 88, 80), hi=False)
    bolts(m, [(x0 + 12 + i * 22, y0 + 14) for i in range((x1 - x0 - 20) // 22)],
          base=(78, 88, 80))
    bolts(m, [(x0 + 12 + i * 22, y1 - 12) for i in range((x1 - x0 - 20) // 22)],
          base=(78, 88, 80))
    # valve/flywheel cell: spoked wheel over dark steel
    zone = L.W_VALVE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0 - 12, y0 - 8, x1 + 12, y1 + 8), dif=(52, 55, 60),
         ao=AO_BASE - 16, rough=150, metal=180)
    ccx, ccy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = min(x1 - x0, y1 - y0) * 0.46
    m.d.ellipse([ccx - rr, ccy - rr, ccx + rr, ccy + rr],
                outline=(140, 62, 48), width=10)
    for a in np.linspace(0, np.pi, 3, endpoint=False):
        m.d.line([(ccx - np.cos(a) * rr, ccy - np.sin(a) * rr),
                  (ccx + np.cos(a) * rr, ccy + np.sin(a) * rr)],
                 fill=(140, 62, 48), width=7)
    m.d.ellipse([ccx - 12, ccy - 12, ccx + 12, ccy + 12], fill=STEEL_DK)


def paint_parametrics(m):
    # trestle legs: u along the leg (base at u0) — flange rings + foot band
    x0, y0, x1, y1 = L.W_LEG
    fill(m, (x0, y0, x1, y1), dif=LEGC, ao=AO_BASE - 10, rough=165, metal=155)
    for fx in np.linspace(0.12, 0.92, 5):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0, sx + 3, y1], fill=shade(LEGC, 0.7))
        m.o.rectangle([sx - 3, y0, sx + 3, y1], fill=(AO_SEAM, R_STEEL, M_STEEL))
    m.d.rectangle([x0, y0, x0 + 26, y1], fill=shade(LEGC, 0.55))
    bolts(m, [(x0 + 34, y0 + 8 + i * 22) for i in range((y1 - y0 - 12) // 22)],
          base=LEGC)
    # braces
    x0, y0, x1, y1 = L.W_BRACE
    fill(m, (x0, y0, x1, y1), dif=shade(LEGC, 0.85), ao=AO_BASE - 14,
         rough=170, metal=150)
    m.d.rectangle([x0, (y0 + y1) // 2 - 2, x1, (y0 + y1) // 2 + 2],
                  fill=shade(LEGC, 0.65))
    # pipes: painted utility green + flanges
    x0, y0, x1, y1 = L.W_PIPE
    fill(m, (x0, y0, x1, y1), dif=PIPEC, ao=AO_BASE - 12, rough=150, metal=165)
    for fx in np.linspace(0.08, 0.92, 7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0, sx + 3, y1], fill=shade(PIPEC, 0.7))
    # trim / fittings
    x0, y0, x1, y1 = L.W_TRIM
    fill(m, (x0, y0, x1, y1), dif=(64, 67, 72), ao=AO_BASE - 14, rough=160,
         metal=160)
    # pumphouse stack: soot toward the tip (u1)
    x0, y0, x1, y1 = L.W_STACK
    fill(m, (x0, y0, x1, y1), dif=(72, 74, 78), ao=AO_BASE - 12, rough=175,
         metal=140)
    m.d.rectangle([x1 - 40, y0, x1, y1], fill=(38, 37, 36))
    # water drums: banded, pale band + stencil
    x0, y0, x1, y1 = L.W_DRUM
    fill(m, (x0, y0, x1, y1), dif=(96, 104, 112), ao=AO_BASE - 8, rough=175,
         metal=110)
    for fy in (0.3, 0.7):
        sy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, sy - 4, x1, sy + 4], fill=shade((96, 104, 112), 0.7))
    m.d.rectangle([x0, y0 + 8, x1, y0 + 22], fill=(170, 174, 168))
    stencil(m, (x0 + 20, y0 + (y1 - y0) * 0.42), 'H2O', 22,
            shade((96, 104, 112), 1.45), bridge=False)
    # drum lids
    r = L.W_DRUM_TOP.rect
    fill(m, r, dif=(84, 92, 100), ao=AO_BASE - 10, rough=170, metal=120)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([ccx - 52, ccy - 52, ccx + 52, ccy + 52],
                outline=shade((84, 92, 100), 0.7), width=5)
    m.d.ellipse([ccx + 18, ccy - 10, ccx + 38, ccy + 10], fill=STEEL_DK)
    # catwalk rim + railing
    x0, y0, x1, y1 = L.W_RAIL
    fill(m, (x0, y0, x1, y1), dif=(58, 61, 66), ao=AO_BASE - 15, rough=165,
         metal=155)
    m.d.rectangle([x0, y0, x1, y0 + 14], fill=shade((58, 61, 66), 1.25))
    # dark cell
    fill(m, L.W_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_tank(m)
    paint_roof(m)
    paint_catwalk(m)
    paint_ladder(m)
    paint_house(m)
    paint_pump(m)
    paint_parametrics(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=61)
    wx.crevice_grime(m.dif, 0.45)
    # tank: rust weeps off the rivet courses + heavy bleed down the
    # overflow seam; streaks over the bottom edge
    tx0, ty0, tx1, ty1 = L.W_TANK
    for fx in np.linspace(0.06, 0.94, 12):
        wx.rust_streak(tx0 + (tx1 - tx0) * fx,
                       ty0 + (ty1 - ty0) * 0.27, 30 + (int(fx * 100) * 7) % 40,
                       width=2.4, strength=0.3)
    ox = tx0 + (tx1 - tx0) * L.OVER_F
    for dx in (-14, -6, 2, 9, 16):
        wx.rust_streak(ox + dx, ty0 + 54, 300 + (dx * 11) % 80, width=3.2,
                       strength=0.5)
    wx.plate_bottom_rust((tx0, ty0, tx1, ty1), n=10, strength=0.6)
    # roof: streaks radiating down from the apex hatch
    rx0, ry0, rx1, ry1 = L.W_ROOF.rect
    for fx in (0.35, 0.55, 0.72):
        wx.rust_streak(rx0 + (rx1 - rx0) * fx, ry0 + 40, 50, width=3.0,
                       strength=0.35)
    # house: dust low on the walls, rust off the window sills
    for zone in (L.W_HOUSE_S, L.W_HOUSE_F, L.W_HOUSE_R):
        x0, y0, x1, y1 = zone.rect
        wx.mud_band(zone.rect, 0.4, fade='down', dust=0.28)
        wx.plate_bottom_rust(zone.rect, n=7, strength=0.5)
    wx.mud_band(L.W_HOUSE_RF.rect, 0.24, fade=None, spatter=False)
    # trestle legs: grime at the feet (u0 = base)
    wx.mud_band(L.W_LEG, 0.55, fade='left', dust=0.2)
    wx.mud_band(L.W_BRACE, 0.25, fade=None, spatter=False)
    # pad: general dust + damp
    wx.mud_band(L.W_PAD.rect, 0.22, fade=None, spatter=True)
    wx.mud_band(L.W_PADS.rect, 0.5, fade='down')
    # machinery: oil on the crank/well + beam pivot, soot on the stack tip
    wx.oily((L.W_WELL.rect[0], L.W_WELL.rect[1], L.W_WELL.rect[2],
             L.W_WELL.rect[3]), 0.55)
    wx.oily(L.W_BEAM.rect, 0.25)
    sx0, sy0, sx1, sy1 = L.W_STACK
    wx.soot_patch((sx1 - 70, sy0, sx1, sy1), 0.7)
    wx.soot_patch(L.W_DARK.rect, 0.5)
    # catwalk + ladder grime
    wx.mud_band(L.W_CATWALK.rect, 0.3, fade=None, spatter=False)
    wx.mud_band(L.W_LADDER.rect, 0.35, fade='down', dust=0.2)
    # rivet rust: streaks in v-down zones (tank wrap + ladder qualify)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L) + [L.W_TANK], fraction=0.5)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # corrugation on the pumphouse walls + roof sheets
    for zone in (L.W_HOUSE_S, L.W_HOUSE_F, L.W_HOUSE_R):
        x0, y0, x1, y1 = zone.rect
        for gx in range(int(x0) + 5, int(x1), 11):
            hm.line((gx, y0 + 2), (gx, y1 - 2), 0.4, width=2)
    x0, y0, x1, y1 = L.W_HOUSE_RF.rect
    for gy in range(int(y0) + 6, int(y1), 12):
        hm.line((x0 + 2, gy), (x1 - 2, gy), 0.35, width=2)
    # tank plate courses stand proud (lap joints)
    tx0, ty0, tx1, ty1 = L.W_TANK
    for f in (0.27, 0.52, 0.77):
        hm.line((tx0, ty0 + (ty1 - ty0) * f), (tx1, ty0 + (ty1 - ty0) * f),
                0.45, width=3)
    # pad expansion joints recessed
    zone = L.W_PAD
    x0, y0, x1, y1 = zone.rect
    for fx in np.linspace(0.14, 0.86, 6):
        hm.line((x0 + (x1 - x0) * fx, y0 + 2), (x0 + (x1 - x0) * fx, y1 - 2),
                -0.5, width=3)
    for fy in np.linspace(0.2, 0.8, 4):
        hm.line((x0 + 2, y0 + (y1 - y0) * fy), (x1 - 2, y0 + (y1 - y0) * fy),
                -0.5, width=3)
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.5)   # every rivet becomes a dome
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.6).save('out/ms_water_works_normals.png')

    m.dif.save('out/ms_water_works_diffuse.png')
    m.orm.save('out/ms_water_works_orm.png')
    m.emi.save('out/ms_water_works_emissive.png')
    m.tea.save('out/ms_water_works_team.png')
    print('[paint_ms_water_works] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
