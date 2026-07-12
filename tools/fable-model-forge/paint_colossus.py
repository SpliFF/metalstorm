"""paint_colossus — 2048² PBR set for fable_colossus (FW-15 Fenrir).

Mean read: near-black trim borders with rivet rows around every armor
plate, red predator visor + sensor lights, furnace-orange radiator and
stack glow, chrome hydraulics, heavy soot on the flamer, mud up the
shins. Faction ties: same armor family, cyan kept to one spine conduit.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import colossus_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK, RUBBER,
                   TRACK_MET, GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, FONT, RNG)

W = 2048
RED = (255, 62, 40)
EMBER = (255, 120, 30)
CHROME = (208, 214, 220)
TRIMC = (30, 32, 36)
PLATE = ARMOR


def rivets(m, x0, y0, x1, y1, step=26, inset=8):
    """Rivet rows just inside a rect border — the plate-edge signature."""
    pts = []
    for x in range(int(x0 + inset), int(x1 - inset) + 1, step):
        pts += [(x, y0 + inset), (x, y1 - inset)]
    for y in range(int(y0 + inset), int(y1 - inset) + 1, step):
        pts += [(x0 + inset, y), (x1 - inset, y)]
    bolts(m, pts, r=2, base=PLATE)


def plate_face(m, rect, base=PLATE, stencil_txt=None, chips=45):
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=base, ao=AO_BASE - 6)
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade(base, 0.55), width=3)
    rivets(m, x0, y0, x1, y1)
    if stencil_txt:
        stencil(m, (x0 + 14, (y0 + y1) / 2 - 9), stencil_txt, 18,
                shade(base, 1.3), bridge=False)
    wear_edges(m, rect, base, chips)


def hatch(m, cx, cy, w, h, label=None):
    """Small outlined access hatch with corner bolts + stencil label —
    scattered on big plates, these read as human-scale doors and sell
    the building-size of the hull."""
    x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
    m.d.rectangle([x0, y0, x1, y1], fill=shade(PLATE, 0.92),
                  outline=shade(PLATE, 0.5), width=2)
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 22, R_ARMOR, M_ARMOR))
    bolts(m, [(x0 + 5, y0 + 5), (x1 - 5, y0 + 5), (x0 + 5, y1 - 5),
              (x1 - 5, y1 - 5)], r=2, base=PLATE)
    m.d.line([(x1 - 12, (y0 + y1) / 2 - 4), (x1 - 12, (y0 + y1) / 2 + 4)],
             fill=STEEL_DK, width=3)
    if label:
        stencil(m, (x0 + 4, y0 - 14), label, 11, shade(PLATE, 1.35),
                bridge=False)


def cable_run(m, pts, width=4):
    """Painted conduit: dark line with clamp dots every ~40 px."""
    for i in range(len(pts) - 1):
        m.d.line([pts[i], pts[i + 1]], fill=(30, 31, 34), width=width)
        m.o.line([pts[i], pts[i + 1]], fill=(AO_SEAM, 190, 120), width=width)
    total = 0
    for i in range(len(pts) - 1):
        (ax, ay), (bx, by) = pts[i], pts[i + 1]
        seg = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        k = int(seg // 44)
        for j in range(1, k + 1):
            t = j / (k + 1)
            m.d.rectangle([ax + (bx - ax) * t - 3, ay + (by - ay) * t - 3,
                           ax + (bx - ax) * t + 3, ay + (by - ay) * t + 3],
                          fill=STEEL_DK)


# ── torso / hull ─────────────────────────────────────────────────────────

def paint_torso(m):
    # FRONT: dark chest armor + emblem + reactor slit
    zone = L.C_TORSO_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE)
    for wy in (0.8, 1.9, 3.0):
        _, v = zone.uv((0, wy, 0))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), PLATE)
    for wx in (-1.1, 1.1):
        u, _ = zone.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, PLATE)
    # mirror-safe fanged double chevron on the chest plate area
    cu, cv0 = zone.uv((0, 2.75, 0))
    _, cv1 = zone.uv((0, 1.35, 0))
    cx = cu * W
    chw = (zone.uv((0.95, 0, 0))[0] - zone.uv((0, 0, 0))[0]) * W
    for k, ph in ((0.0, 0), (0.42, 1)):
        ty0 = cv0 * W + (cv1 - cv0) * W * k
        th = (cv1 - cv0) * W * 0.36
        poly = [(cx - chw, ty0), (cx, ty0 + th), (cx + chw, ty0),
                (cx + chw, ty0 + th * 0.45), (cx, ty0 + th * 1.45),
                (cx - chw, ty0 + th * 0.45)]
        m.t.polygon(poly, fill=(255, 0, 0))
        m.d.polygon(poly, fill=TEAMGREY if ph == 0 else shade(TEAMGREY, 0.8),
                    outline=shade(PLATE, 0.5))
    # reactor slit under the collar
    ru0, rv = zone.uv((-0.5, 3.55, 0))
    ru1, _ = zone.uv((0.5, 3.55, 0))
    m.d.rectangle([ru0 * W, rv * W - 5, ru1 * W, rv * W + 5], fill=GLASS)
    m.e.rectangle([ru0 * W + 3, rv * W - 3, ru1 * W - 3, rv * W + 3],
                  fill=(36, 90, 100))
    rivets(m, x0, y0, x1, y1, step=34)
    hatch(m, x0 + 78, y1 - 60, 46, 60, 'A-01')
    hatch(m, x1 - 84, y1 - 64, 46, 60, 'A-02')
    cable_run(m, [(x0 + 30, y0 + 40), (x0 + 30, y1 - 120), (x0 + 96, y1 - 40)])
    wear_edges(m, (x0, y0, x1, y1), PLATE, 70)

    # SIDE
    zone = L.C_TORSO_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE)
    for wz in (-2.2, -0.9, 0.5, 1.4):
        u, _ = zone.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, PLATE)
    _, mv = zone.uv((0, 1.1, 0))
    m.d.rectangle([x0, int(mv * W), x1, y1], fill=LOWER)
    m.o.rectangle([x0, int(mv * W), x1, y1], fill=(AO_BASE - 35, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, int(mv * W), PLATE)
    for wz in (-1.6, 0.0):
        u, _ = zone.uv((0, 0, wz))
        seam_v(m, int(u * W), int(mv * W), y1 - 4, PLATE)
    rivets(m, x0, y0, x1, int(mv * W), step=40)
    hatch(m, x0 + 120, y0 + 90, 44, 56, 'S-11')
    hatch(m, x1 - 150, y0 + 210, 44, 56, 'S-12')
    # lower machinery band: louver strips + cabling
    vent_slots(m, [x0 + 60, int(mv * W) + 18, x0 + 210, int(mv * W) + 58], 3)
    vent_slots(m, [x1 - 240, int(mv * W) + 18, x1 - 90, int(mv * W) + 58], 3)
    cable_run(m, [(x0 + 40, int(mv * W) + 76), (x1 - 60, int(mv * W) + 76)])
    wear_edges(m, (x0, y0, x1, y1), PLATE, 55)

    # REAR: engine wall + furnace band behind radiator fins
    zone = L.C_TORSO_REAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.25), ao=AO_BASE - 20)
    gu0, gv0 = zone.uv((1.3, 2.3, 0))
    gu1, gv1 = zone.uv((-1.3, 0.9, 0))
    gb = [gu0 * W, gv0 * W, gu1 * W, gv1 * W]
    m.d.rectangle(gb, fill=BLACKISH)
    m.o.rectangle(gb, fill=(AO_DEEP - 30, 210, 60))
    m.e.rectangle([gb[0] + 6, gb[1] + 6, gb[2] - 6, gb[3] - 6], fill=(120, 40, 8))
    for fx in np.linspace(0.12, 0.88, 6):
        sx = gb[0] + (gb[2] - gb[0]) * fx
        m.d.rectangle([sx - 3, gb[1] + 3, sx + 3, gb[3] - 3], fill=STEEL_DK)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12)], base=LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 40)

    # TOP: carapace with jagged two-tone striping + numeral
    zone = L.C_TORSO_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE)
    for i in range(6):
        bx = x0 + (x1 - x0) * (0.05 + i * 0.16)
        m.d.polygon([(bx, y0 + 6), (bx + 46, y0 + 6), (bx + 106, y1 - 6),
                     (bx + 60, y1 - 6)], fill=jit(shade(PLATE, 0.82), 3))
    for wz in (-2.2, -0.6, 0.9):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), PLATE)
    nu, nv = zone.uv((0.0, 0, 1.5))
    f = ImageFont.truetype(FONT, 60)
    tw = m.d.textlength('01', font=f)
    m.d.text((nu * W - tw / 2 + 2, nv * W - 28 + 2), '01', font=f,
             fill=shade(PLATE, 0.55))
    m.d.text((nu * W - tw / 2, nv * W - 28), '01', font=f, fill=(196, 200, 204))
    rivets(m, x0, y0, x1, y1, step=44)
    hatch(m, x0 + 110, y0 + 120, 50, 50, 'T-01')
    hatch(m, x1 - 130, y0 + 190, 50, 50, 'T-02')
    for fx in (0.25, 0.5, 0.75):
        lx = x0 + (x1 - x0) * fx
        m.e.ellipse([lx - 4, y1 - 18, lx + 4, y1 - 10], fill=(200, 205, 210))
        m.d.ellipse([lx - 4, y1 - 18, lx + 4, y1 - 10], fill=(90, 94, 100))
    wear_edges(m, (x0, y0, x1, y1), PLATE, 80)

    # pelvis machinery + skirts
    zone = L.C_PELVIS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.25), ao=AO_BASE - 15)
    _, hv = zone.uv((0, 7.6, 0))
    seam_h(m, x0 + 3, x1 - 3, int(hv * W), LOWER)
    for i in range(int((x1 - x0) / 18) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 18, y1 - 16), (x0 + i * 18 + 18, y1 - 16),
                     (x0 + i * 18 + 9, y1 - 4), (x0 + i * 18 - 9, y1 - 4)], fill=c)
    rivets(m, x0, y0, x1, y1, step=38)
    hatch(m, (x0 + x1) / 2, y0 + 60, 40, 50, 'P-03')
    cable_run(m, [(x0 + 16, y0 + 24), (x1 - 16, y0 + 24)])
    wear_edges(m, (x0, y0, x1, y1), LOWER, 50)


def paint_head(m):
    # TOP: brow armor
    x0, y0, x1, y1 = L.C_HEAD_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2, PLATE)
    rivets(m, x0, y0, x1, y1, step=30)
    wear_edges(m, (x0, y0, x1, y1), PLATE, 40)
    # SIDE: cheek vents
    x0, y0, x1, y1 = L.C_HEAD_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE)
    vent_slots(m, [x0 + (x1 - x0) * 0.55, y0 + (y1 - y0) * 0.45,
                   x1 - 14, y0 + (y1 - y0) * 0.72], 3)
    wear_edges(m, (x0, y0, x1, y1), PLATE, 35)
    # FRONT: RED visor slit + grille "teeth"
    x0, y0, x1, y1 = L.C_HEAD_FRONT.rect
    fill(m, (x0, y0, x1, y1), dif=(44, 46, 50), ao=AO_BASE - 20)
    vy = y0 + (y1 - y0) * 0.30
    m.d.rectangle([x0 + 10, vy - 9, x1 - 10, vy + 9], fill=GLASS)
    m.e.rectangle([x0 + 12, vy - 6, x1 - 12, vy + 6], fill=RED)
    m.o.rectangle([x0 + 10, vy - 9, x1 - 10, vy + 9], fill=(AO_BASE, R_GLASS, 0))
    ty = y0 + (y1 - y0) * 0.62
    for i in range(7):
        tx = x0 + 14 + (x1 - x0 - 28) * i / 7
        tw_ = (x1 - x0 - 28) / 7
        m.d.polygon([(tx + 3, ty), (tx + tw_ - 3, ty),
                     (tx + tw_ / 2, ty + 26)], fill=BLACKISH)
        m.o.polygon([(tx + 3, ty), (tx + tw_ - 3, ty),
                     (tx + tw_ / 2, ty + 26)], fill=(AO_DEEP, 200, 40))
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10)], base=(44, 46, 50))


def paint_pack(m):
    x0, y0, x1, y1 = L.C_PACK.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2 + 20, PLATE)
    vent_slots(m, [x0 + 30, y0 + 24, x0 + 150, y0 + 74], 3)
    rivets(m, x0, y0, x1, y1, step=40)
    hatch(m, x0 + 90, y1 - 66, 44, 56, 'R-07')
    hatch(m, x1 - 96, y1 - 66, 44, 56, 'R-08')
    for fx in (0.18, 0.82):
        lx = x0 + (x1 - x0) * fx
        m.e.ellipse([lx - 5, y0 + 12, lx + 5, y0 + 22], fill=(230, 140, 30))
        m.d.ellipse([lx - 5, y0 + 12, lx + 5, y0 + 22], fill=(110, 70, 20))
    wear_edges(m, (x0, y0, x1, y1), PLATE, 45)
    x0, y0, x1, y1 = L.C_PACK_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE)
    rivets(m, x0, y0, x1, y1, step=40)
    # RACK: 2×3 missile doors with hazard frame + status lights
    zone = L.C_RACK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(PLATE, 0.9), ao=AO_BASE - 10)
    for i in range(int((x1 - x0) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 16, y0 + 2), (x0 + i * 16 + 16, y0 + 2),
                     (x0 + i * 16 + 8, y0 + 12), (x0 + i * 16 - 8, y0 + 12)], fill=c)
    for r in range(2):
        for c_ in range(3):
            dx0 = x0 + 20 + c_ * (x1 - x0 - 40) / 3
            dx1 = x0 + 8 + (c_ + 1) * (x1 - x0 - 40) / 3
            dy0 = y0 + 24 + r * (y1 - y0 - 44) / 2
            dy1 = y0 + 12 + (r + 1) * (y1 - y0 - 44) / 2
            m.d.rectangle([dx0, dy0, dx1, dy1], fill=(52, 55, 60),
                          outline=shade(PLATE, 0.5), width=3)
            m.o.rectangle([dx0, dy0, dx1, dy1], fill=(AO_SEAM, R_ARMOR, M_ARMOR))
            m.d.line([(dx0 + 4, (dy0 + dy1) / 2), (dx1 - 4, (dy0 + dy1) / 2)],
                     fill=shade(PLATE, 0.55), width=2)
            m.e.ellipse([dx1 - 12, dy0 + 5, dx1 - 5, dy0 + 12], fill=RED)
    # side team stripe
    m.t.rectangle([x0 + 4, y1 - 22, x0 + 60, y1 - 6], fill=(255, 0, 0))
    m.d.rectangle([x0 + 4, y1 - 22, x0 + 60, y1 - 6], fill=TEAMGREY)
    # stacks: heat-banded steel
    x0, y0, x1, y1 = L.C_STACK
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 25, rough=185,
         metal=170)
    heat = Image.new('RGB', (x1 - x0, (y1 - y0) // 3), (96, 62, 50))
    grad = Image.new('L', (1, (y1 - y0) // 3), 0)
    for gy in range((y1 - y0) // 3):
        grad.putpixel((0, gy), int(120 * (1 - gy / max(1, (y1 - y0) // 3 - 1))))
    m.dif.paste(heat, (x0, y0), grad.resize((x1 - x0, (y1 - y0) // 3)))
    for fy in (0.3, 0.62):
        sy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0 + 2, sy - 3, x1 - 2, sy + 3], fill=STEEL_DK)
    r = L.C_STACK_TOP.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=60)
    scx, scy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.e.ellipse([scx - 26, scy - 26, scx + 26, scy + 26], fill=(150, 48, 10))
    m.d.ellipse([scx - 14, scy - 14, scx + 14, scy + 14], fill=(14, 13, 13))


def paint_shoulders(m):
    zone = L.C_PAULDRON
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PLATE)
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade(PLATE, 0.55), width=4)
    # team edge band along the outer rim
    m.t.rectangle([x0 + 6, y0 + 6, x1 - 6, y0 + 40], fill=(255, 0, 0))
    m.d.rectangle([x0 + 6, y0 + 6, x1 - 6, y0 + 40], fill=TEAMGREY)
    for i in range(4):
        sx = x0 + (x1 - x0) * (i + 1) / 5
        seam_v(m, int(sx), y0 + 46, y1 - 8, PLATE)
    rivets(m, x0, y0 + 40, x1, y1, step=34)
    stencil(m, (x0 + 16, y1 - 42), 'FW-15', 24, shade(PLATE, 1.3), bridge=False)
    wear_edges(m, (x0, y0, x1, y1), PLATE, 90)
    x0, y0, x1, y1 = L.C_PAULDRON_S.rect
    fill(m, (x0, y0, x1, y1), dif=TRIMC, ao=AO_BASE - 25, rough=180, metal=140)
    rivets(m, x0, y0, x1, y1, step=30, inset=7)
    x0, y0, x1, y1 = L.C_HORN.rect
    fill(m, (x0, y0, x1, y1), dif=(24, 25, 28), ao=AO_BASE - 15, rough=140,
         metal=180)
    m.d.rectangle([x0, y0, x1, y0 + 24], fill=(120, 124, 130))  # worn tip band
    m.o.rectangle([x0, y0, x1, y0 + 24], fill=(AO_BASE, 90, 220))


def paint_limbs(m):
    # machinery wraps: thigh / shin / arm
    for rect, nseg in ((L.C_THIGH, 4), (L.C_SHIN, 3), (L.C_ARM, 3)):
        x0, y0, x1, y1 = rect
        fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 18, rough=150,
             metal=150)
        for i in range(1, nseg):
            sx = x0 + (x1 - x0) * i / nseg
            seam_v(m, int(sx), y0 + 2, y1 - 2, STEEL)
        # cable run
        m.d.line([(x0 + 6, (y0 + y1) / 2 + 14), (x1 - 6, (y0 + y1) / 2 + 14)],
                 fill=(30, 31, 34), width=5)
        wear_edges(m, (x0, y0, x1, y1), STEEL, 30)
    # armor plates cell (thigh/shin/arm plates + calf)
    x0, y0, x1, y1 = L.C_SHINGUARD.rect
    plate_face(m, (x0, y0, x1, y1), stencil_txt='FW-15')
    hatch(m, (x0 + x1) / 2, y1 - 52, 40, 48, 'L-21')
    cable_run(m, [(x0 + 14, y0 + 30), (x0 + 14, y1 - 30)])
    # team patch
    m.t.rectangle([x1 - 52, y0 + 8, x1 - 8, y0 + 42], fill=(255, 0, 0))
    m.d.rectangle([x1 - 52, y0 + 8, x1 - 8, y0 + 42], fill=TEAMGREY)
    # trim borders (rims): near-black + rivet line
    x0, y0, x1, y1 = L.C_TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=TRIMC, ao=AO_BASE - 30, rough=175, metal=150)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 11), (y0 + y1) / 2)
              for i in range(12)], r=2, base=TRIMC)
    # joints: dark steel drum + groove rings
    x0, y0, x1, y1 = L.C_JOINT
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 25, rough=140,
         metal=195)
    for fx in (0.25, 0.5, 0.75):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0, sx + 2, y1], fill=BLACKISH)
    # joint cap: radial bolt circle
    r = L.C_JOINT_CAP.rect
    fill(m, r, dif=STEEL_DK, ao=AO_BASE - 18, rough=135, metal=200)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    rr = (r[2] - r[0]) / 2 - 8
    m.d.ellipse([ccx - rr, ccy - rr, ccx + rr, ccy + rr],
                outline=shade(STEEL_DK, 0.6), width=3)
    m.d.ellipse([ccx - rr * 0.35, ccy - rr * 0.35, ccx + rr * 0.35,
                 ccy + rr * 0.35], fill=(38, 40, 44))
    bolts(m, [(ccx + np.cos(a) * rr * 0.7, ccy + np.sin(a) * rr * 0.7)
              for a in np.linspace(0, 2 * np.pi, 10, endpoint=False)],
          base=STEEL_DK)
    # pistons: chrome rod / dark housing (u: p0 housing -> p1 rod end)
    x0, y0, x1, y1 = L.C_PISTON
    fill(m, (x0, y0, x1, y1), dif=CHROME, ao=AO_BASE, rough=52, metal=235)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) // 2, y1], fill=(58, 60, 66))
    m.o.rectangle([x0, y0, x0 + (x1 - x0) // 2, y1], fill=(AO_BASE - 15, 130, 200))
    m.d.rectangle([x0 + (x1 - x0) // 2 - 4, y0, x0 + (x1 - x0) // 2 + 4, y1],
                  fill=BLACKISH)
    # hoses: ribbed rubber
    x0, y0, x1, y1 = L.C_HOSE.rect
    fill(m, (x0, y0, x1, y1), dif=(34, 35, 38), ao=AO_BASE - 30, rough=215,
         metal=15)
    for gx in range(x0, x1, 9):
        m.d.line([(gx, y0), (gx, y1)], fill=(24, 25, 27), width=3)
    # collar
    x0, y0, x1, y1 = L.C_COLLAR.rect
    plate_face(m, (x0, y0, x1, y1), chips=30)
    # vents
    x0, y0, x1, y1 = L.C_VENT.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 25)
    vent_slots(m, [x0 + 8, y0 + 10, x1 - 8, y1 - 10], 4, glow=(90, 30, 6))


def paint_feet(m):
    x0, y0, x1, y1 = L.C_FOOT_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.3), ao=AO_BASE - 20)
    seam_h(m, x0 + 3, x1 - 3, y0 + (y1 - y0) // 3, LOWER)
    rivets(m, x0, y0, x1, y1, step=34)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 60)
    x0, y0, x1, y1 = L.C_FOOT_WRAP
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.3), ao=AO_BASE - 22)
    for fx in (0.33, 0.66):
        sx = x0 + (x1 - x0) * fx
        seam_v(m, int(sx), y0 + 2, y1 - 2, LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 40)
    x0, y0, x1, y1 = L.C_CLAW.rect
    fill(m, (x0, y0, x1, y1), dif=(26, 27, 30), ao=AO_BASE - 10, rough=130,
         metal=190)
    m.d.rectangle([x0, y1 - 30, x1, y1], fill=(130, 134, 140))  # worn tips
    m.o.rectangle([x0, y1 - 30, x1, y1], fill=(AO_BASE, 85, 225))


def paint_weapons(m):
    # receiver blocks
    x0, y0, x1, y1 = L.C_RECEIVER.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 15, rough=140, metal=185)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2 - 12, STEEL)
    for fx in (0.3, 0.62):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, STEEL)
    rivets(m, x0, y0, x1, y1, step=36)
    m.d.rectangle([x0 + 12, y1 - 32, x0 + 68, y1 - 14], fill=YELLOW)
    m.d.text((x0 + 15, y1 - 31), 'ARM', font=ImageFont.truetype(FONT, 14),
             fill=BLACKISH)
    hatch(m, x1 - 70, y0 + 60, 44, 52, 'W-04')
    # pressure gauge dial
    gx, gy = x0 + 60, y0 + 54
    m.d.ellipse([gx - 16, gy - 16, gx + 16, gy + 16], fill=(214, 216, 220),
                outline=STEEL_DK, width=3)
    m.d.line([(gx, gy), (gx + 9, gy - 7)], fill=(180, 40, 30), width=2)
    m.o.ellipse([gx - 16, gy - 16, gx + 16, gy + 16], fill=(AO_BASE, 70, 0))
    cable_run(m, [(x0 + 20, y0 + 20), (x1 - 30, y0 + 20)])
    wear_edges(m, (x0, y0, x1, y1), STEEL, 45)
    # gun tubes: fluted steel + heat toward muzzle (right)
    x0, y0, x1, y1 = L.C_GUN_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 12, rough=115,
         metal=210)
    hx0 = x0 + int((x1 - x0) * 0.62)
    heat = Image.new('RGB', (x1 - hx0, y1 - y0), (80, 56, 52))
    grad = Image.new('L', (x1 - hx0, 1), 0)
    for gx in range(x1 - hx0):
        grad.putpixel((gx, 0), int(85 * (gx / max(1, x1 - hx0 - 1)) ** 1.5))
    m.dif.paste(heat, (hx0, y0), grad.resize((x1 - hx0, y1 - y0)))
    for fy in (0.2, 0.5, 0.8):
        m.d.line([(x0, y0 + (y1 - y0) * fy), (x1, y0 + (y1 - y0) * fy)],
                 fill=shade(STEEL_DK, 0.7), width=2)
    # muzzle cell
    r = L.C_MUZZLE_CELL.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=205, metal=70)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([ccx - 16, ccy - 16, ccx + 16, ccy + 16], fill=(12, 12, 14))
    # missile box doors (2×3) + hazard
    zone = L.C_MISSILE_BOX
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(PLATE, 0.92), ao=AO_BASE - 8)
    for r_ in range(2):
        for c_ in range(3):
            dx0 = x0 + 14 + c_ * (x1 - x0 - 28) / 3
            dx1 = x0 + 4 + (c_ + 1) * (x1 - x0 - 28) / 3
            dy0 = y0 + 14 + r_ * (y1 - y0 - 28) / 2
            dy1 = y0 + 6 + (r_ + 1) * (y1 - y0 - 28) / 2
            m.d.rectangle([dx0, dy0, dx1, dy1], fill=(52, 55, 60),
                          outline=shade(PLATE, 0.5), width=2)
            m.o.rectangle([dx0, dy0, dx1, dy1], fill=(AO_SEAM, R_ARMOR, M_ARMOR))
            m.e.ellipse([dx1 - 10, dy0 + 4, dx1 - 4, dy0 + 10], fill=RED)
    for i in range(int((x1 - x0) / 14) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 14, y1 - 12), (x0 + i * 14 + 14, y1 - 12),
                     (x0 + i * 14 + 7, y1 - 2), (x0 + i * 14 - 7, y1 - 2)], fill=c)
    # flamer wrap: steel, heavy burn toward nozzle
    x0, y0, x1, y1 = L.C_FLAMER_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 15, rough=150, metal=180)
    hx0 = x0 + int((x1 - x0) * 0.45)
    burn = Image.new('RGB', (x1 - hx0, y1 - y0), (52, 40, 38))
    grad = Image.new('L', (x1 - hx0, 1), 0)
    for gx in range(x1 - hx0):
        grad.putpixel((gx, 0), int(150 * (gx / max(1, x1 - hx0 - 1)) ** 1.3))
    m.dif.paste(burn, (hx0, y0), grad.resize((x1 - hx0, y1 - y0)))
    # nozzle bell: blackened + blue-burn ring at the throat
    x0, y0, x1, y1 = L.C_NOZZLE
    fill(m, (x0, y0, x1, y1), dif=(38, 34, 33), ao=AO_BASE - 25, rough=190,
         metal=120)
    m.d.rectangle([x0, y0, x0 + 14, y1], fill=(66, 60, 88))   # blued steel ring
    m.e.rectangle([x1 - 8, y0, x1, y1], fill=(120, 50, 14))   # pilot glow rim
    # fuel tanks / ammo drum wrap
    x0, y0, x1, y1 = L.C_TANK
    fill(m, (x0, y0, x1, y1), dif=(66, 70, 74), ao=AO_BASE - 12, rough=150,
         metal=170)
    m.d.rectangle([x0, y0 + 10, x1, y0 + 26], fill=YELLOW)
    m.d.rectangle([x0, y0 + 26, x1, y0 + 32], fill=BLACKISH)
    stencil(m, (x0 + 10, y0 + (y1 - y0) * 0.55), 'FLAM', 16, shade(ARMOR, 1.3),
            bridge=False)
    r = L.C_TANK_CAP.rect
    fill(m, r, dif=(66, 70, 74), ao=AO_BASE - 10, rough=150, metal=170)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([ccx - 10, ccy - 10, ccx + 10, ccy + 10], fill=STEEL_DK)
    bolts(m, [(ccx + np.cos(a) * 26, ccy + np.sin(a) * 26)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 6, endpoint=False)],
          base=(66, 70, 74))
    # knuckle guards / shields
    x0, y0, x1, y1 = L.C_KNUCKLE.rect
    fill(m, (x0, y0, x1, y1), dif=(48, 50, 55), ao=AO_BASE - 15)
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade(PLATE, 0.5), width=3)
    rivets(m, x0, y0, x1, y1, step=30)
    wear_edges(m, (x0, y0, x1, y1), (48, 50, 55), 70)


def paint_dark(m):
    fill(m, L.C_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_dark(m)
    paint_torso(m)
    paint_head(m)
    paint_pack(m)
    paint_shoulders(m)
    paint_limbs(m)
    paint_feet(m)
    paint_weapons(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=53)
    wx.crevice_grime(m.dif, 0.42)
    # mud: feet heaviest, shins graded, thigh spatter
    wx.mud_band(L.C_FOOT_SIDE.rect, 1.0, fade='down')
    wx.mud_band(L.C_FOOT_WRAP, 0.9, fade=None)
    wx.mud_band(L.C_CLAW.rect, 0.75, fade=None)
    wx.mud_band(L.C_SHIN, 0.55, fade='down', dust=0.3)
    wx.mud_band(L.C_SHINGUARD.rect, 0.5, fade='down', dust=0.3)
    wx.mud_band(L.C_THIGH, 0.3, fade='down', spatter=True)
    wx.mud_band(L.C_PELVIS.rect, 0.35, fade='down', spatter=False)
    # dust film high up
    wx.mud_band(L.C_TORSO_TOP.rect, 0.16, fade=None, spatter=False)
    wx.mud_band(L.C_PACK_TOP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.C_PAULDRON.rect, 0.2, fade=None, spatter=False)
    # rust: plate bottoms + streaks off the pack and skirts
    for r in (L.C_TORSO_SIDE.rect, L.C_PELVIS.rect, L.C_PACK.rect,
              L.C_FOOT_SIDE.rect, L.C_SHINGUARD.rect):
        wx.plate_bottom_rust(r, n=7, strength=0.6)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    px0, py0, px1, py1 = L.C_PACK.rect
    for fx in (0.25, 0.6, 0.85):
        wx.rust_streak(px0 + (px1 - px0) * fx, py0 + (py1 - py0) * 0.4,
                       30, strength=0.4)
    # oil: joints, pistons housing end, hoses
    wx.oily(L.C_JOINT, 0.5)
    wx.oily(L.C_JOINT_CAP.rect, 0.4)
    wx.oily((L.C_PISTON[0], L.C_PISTON[1],
             (L.C_PISTON[0] + L.C_PISTON[2]) // 2, L.C_PISTON[3]), 0.55)
    wx.oily(L.C_HOSE.rect, 0.3)
    # soot: flamer heavy, gun muzzle light, stacks
    fx0, fy0, fx1, fy1 = L.C_FLAMER_WRAP
    wx.soot_patch((fx0 + (fx1 - fx0) * 0.55, fy0, fx1, fy1), 0.8, fade='right')
    wx.soot_patch(L.C_NOZZLE, 0.9)
    wx.soot_patch((L.C_KNUCKLE.rect[0], L.C_KNUCKLE.rect[1],
                   L.C_KNUCKLE.rect[2], L.C_KNUCKLE.rect[3]), 0.25)
    gx0, gy0, gx1, gy1 = L.C_GUN_WRAP
    wx.soot_patch((gx0 + (gx1 - gx0) * 0.8, gy0, gx1, gy1), 0.45, fade='right')
    wx.soot_patch(L.C_MUZZLE_CELL.rect, 0.5)
    sx0, sy0, sx1, sy1 = L.C_STACK
    wx.soot_patch((sx0, sy0, sx1, sy0 + (sy1 - sy0) // 3), 0.7)
    wx.soot_patch(L.C_STACK_TOP.rect, 0.85)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # missile/rack doors recessed
    for zone in (L.C_RACK, L.C_MISSILE_BOX):
        x0, y0, x1, y1 = zone.rect
        hm.rect((x0 + 16, y0 + 16, x1 - 8, y1 - 8), -0.5)
    # radiator furnace recess (torso rear grille)
    zone = L.C_TORSO_REAR
    gu0, gv0 = zone.uv((1.3, 2.3, 0))
    gu1, gv1 = zone.uv((-1.3, 0.9, 0))
    hm.rect((gu0 * W, gv0 * W, gu1 * W, gv1 * W), -1.2)
    # vent cells recess
    x0, y0, x1, y1 = L.C_VENT.rect
    hm.rect((x0 + 8, y0 + 10, x1 - 8, y1 - 10), -0.8)
    # stack top hollow
    r = L.C_STACK_TOP.rect
    hm.disc((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, (r[2] - r[0]) / 2 - 12, -1.1)
    # hose ribs
    x0, y0, x1, y1 = L.C_HOSE.rect
    for gx in range(x0, x1, 9):
        hm.line((gx, y0), (gx, y1), 0.4, width=2)
    # joint grooves
    x0, y0, x1, y1 = L.C_JOINT
    for fx_ in (0.25, 0.5, 0.75):
        sx = x0 + (x1 - x0) * fx_
        hm.rect((sx - 2, y0, sx + 2, y1), -0.5)
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.55)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.6).save('out/fable_colossus_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_colossus_diffuse.png')
    m.orm.save('out/fable_colossus_orm.png')
    m.emi.save('out/fable_colossus_emissive.png')
    m.tea.save('out/fable_colossus_team.png')
    print('[paint_colossus] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
