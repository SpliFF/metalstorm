"""paint_ms_command_s2 — 1024² PBR set for ms_command_s2 (Command vehicle).

THE commander-as-unit body: line-tank armour language (paint.py palette)
plus command dressing — white recognition band + roof star, '01' hull
numerals, canvas map-table awning, tactical-display table top (dim cyan
emissive), off-white scanning dish, amber pole beacon, and a banner that
is almost entirely team mask (faction read) around a punched dark sigil.
Weathering is kinetic but a notch lighter than the line tank — staff
vehicle, not assault armour.
"""
from __future__ import annotations
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_command_s2_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   RUBBER, TRACK_MET, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   CYAN, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)

W = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   '..', '..', 'out')
STEM = 'ms_command_s2'

CANVAS     = (99, 92, 72)         # awning fabric
CANVAS_LT  = (114, 106, 84)
CANVAS_DK  = (78, 72, 56)
GALV       = (150, 154, 159)
DISHC      = (208, 206, 199)
AMBER      = (255, 176, 60)
MAPGLOW    = (60, 170, 190)
WHITE_MK   = (198, 202, 206)
BANNER_DK  = (38, 40, 46)

FONTS = ('/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
         '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
         '/System/Library/Fonts/Helvetica.ttc')


def font(size):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def numeral(m, cx, cy, text, size, color=WHITE_MK):
    f = font(size)
    tw = m.d.textlength(text, font=f)
    m.d.text((cx - tw / 2 + 2, cy - size * 0.55 + 2), text, font=f,
             fill=shade(ARMOR_DK, 0.55))
    m.d.text((cx - tw / 2, cy - size * 0.55), text, font=f, fill=color)


def command_sigil(m, cx, cy, r, on_team_mask=False, ring=WHITE_MK):
    """Mirror-safe command emblem: ring + solid 4-point star (symmetric)."""
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ring, width=3)
    pts = []
    for i in range(8):
        a = i * np.pi / 4 - np.pi / 2
        rr = r * 0.80 if i % 2 == 0 else r * 0.28
        pts.append((cx + rr * np.cos(a), cy + rr * np.sin(a)))
    m.d.polygon(pts, fill=ring)
    if on_team_mask:
        m.t.ellipse([cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2],
                    fill=(0, 0, 0))


# ── hull ────────────────────────────────────────────────────────────────

def paint_dark(m):
    fill(m, L.C_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_hull_top(m):
    z = L.C_HULL_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(6):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 10), (bx + 76, by), (bx + 90, by + 40),
                     (bx + 16, by + 52)], fill=jit(ARMOR_DK, 3))
    # deck panel seams
    for wz in (-3.0, -2.0, -0.9, 0.4, 1.6, 2.6, 3.2):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    for wx in (-0.85, 0.0, 0.85):
        u, _ = z.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 4, y1 - 4, ARMOR)
    # rear porch: painted deck-plate area between cabin and hull rear
    pu0, pv0 = z.uv((-1.05, 0, 1.62))
    pu1, pv1 = z.uv((1.05, 0, 3.55))
    porch = [pu0 * W, pv0 * W, pu1 * W, pv1 * W]
    m.d.rectangle(porch, fill=shade(ARMOR_DK, 0.92))
    m.o.rectangle(porch, fill=(AO_BASE - 20, R_ARMOR + 10, M_ARMOR))
    for gy in range(int(porch[1]) + 4, int(porch[3]) - 2, 9):
        m.d.line([(porch[0] + 3, gy), (porch[2] - 3, gy)],
                 fill=shade(ARMOR_DK, 0.72), width=1)
    # white recognition band across the front deck (air-ID for own side)
    bu0, bv0 = z.uv((-1.1, 0, -3.0))
    bu1, bv1 = z.uv((1.1, 0, -2.6))
    m.d.rectangle([bu0 * W, bv0 * W, bu1 * W, bv1 * W], fill=WHITE_MK)
    m.o.rectangle([bu0 * W, bv0 * W, bu1 * W, bv1 * W],
                  fill=(AO_BASE, R_ARMOR + 15, M_ARMOR))
    wear_edges(m, (int(bu0 * W), int(bv0 * W), int(bu1 * W), int(bv1 * W)),
               ARMOR, 30)
    # grip strips beside the driver hatch
    for wz in (-2.25, -2.1):
        _, v = z.uv((0, 0, wz))
        m.d.rectangle([x0 + 26, v * W - 2, x1 - 26, v * W + 2],
                      fill=shade(ARMOR, 0.7))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 55)


def paint_glacis(m):
    z = L.C_GLACIS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * 0.40), ARMOR_DK)
    seam_v(m, int(x0 + (x1 - x0) * 0.5), y0 + 3, y1 - 3, ARMOR_DK)
    # team chevron
    cxm = (x0 + x1) / 2
    ch_w, ch_h = (x1 - x0) * 0.30, (y1 - y0) * 0.26
    cy0 = y0 + (y1 - y0) * 0.24
    poly = [(cxm - ch_w, cy0 + ch_h), (cxm, cy0), (cxm + ch_w, cy0 + ch_h),
            (cxm + ch_w, cy0 + ch_h + 14), (cxm, cy0 + 14),
            (cxm - ch_w, cy0 + ch_h + 14)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAMGREY, outline=shade(ARMOR_DK, 0.5))
    # headlights (emissive, small)
    for fx in (0.18, 0.82):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.52
        m.d.rectangle([lx - 8, ly - 5, lx + 8, ly + 5], fill=GLASS)
        m.e.rectangle([lx - 6, ly - 3, lx + 6, ly + 3], fill=(185, 200, 210))
        m.o.rectangle([lx - 8, ly - 5, lx + 8, ly + 5],
                      fill=(AO_SEAM, R_GLASS, M_GLASS))
    # tow points
    for fx in (0.14, 0.86):
        tx = x0 + (x1 - x0) * fx
        ty = y1 - (y1 - y0) * 0.20
        m.d.rectangle([tx - 8, ty - 5, tx + 8, ty + 5], fill=STEEL_DK)
        m.d.ellipse([tx - 4, ty - 3, tx + 4, ty + 3], fill=BLACKISH)
        m.o.rectangle([tx - 8, ty - 5, tx + 8, ty + 5],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 7), y0 + 8) for i in range(8)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 45)


def paint_hull_rear(m):
    z = L.C_HULL_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # crew ramp door with hinges + handle
    db = [x0 + (x1 - x0) * 0.26, y0 + (y1 - y0) * 0.14,
          x0 + (x1 - x0) * 0.74, y0 + (y1 - y0) * 0.86]
    m.d.rectangle(db, outline=shade(ARMOR_DK, 0.5), width=3)
    m.o.rectangle(db, fill=(AO_BASE - 12, R_ARMOR, M_ARMOR))
    for fy in (0.25, 0.72):
        hy = db[1] + (db[3] - db[1]) * fy
        m.d.rectangle([db[2] - 4, hy - 8, db[2] + 6, hy + 8], fill=STEEL_DK)
    m.d.rectangle([db[0] + 10, (db[1] + db[3]) / 2 - 3,
                   db[0] + 30, (db[1] + db[3]) / 2 + 3], fill=STEEL_DK)
    bolts(m, [(db[0] + 8, db[1] + 8), (db[2] - 8, db[1] + 8),
              (db[0] + 8, db[3] - 8), (db[2] - 8, db[3] - 8)], base=ARMOR_DK)
    numeral(m, (db[0] + db[2]) / 2, db[1] + 26, '01', 40)
    # hazard strip along the bottom edge
    for i in range(int((x1 - x0) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 16, y1 - 14), (x0 + i * 16 + 16, y1 - 14),
                     (x0 + i * 16 + 8, y1 - 4), (x0 + i * 16 - 8, y1 - 4)],
                    fill=c)
    # team ID square + convoy taillights
    m.t.rectangle([x1 - 46, y0 + 12, x1 - 12, y0 + 42], fill=(255, 0, 0))
    m.d.rectangle([x1 - 46, y0 + 12, x1 - 12, y0 + 42], fill=TEAMGREY)
    m.e.rectangle([x0 + 14, y0 + 20, x0 + 40, y0 + 26], fill=(160, 30, 24))
    m.d.rectangle([x0 + 14, y0 + 20, x0 + 40, y0 + 26], fill=(70, 20, 18))
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 35)


def paint_hull_side(m):
    z = L.C_HULL_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    _, wv = z.uv((0, 0.88, 0))
    wy = int(wv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    for wz in (-2.5, -1.2, 0.2, 1.6, 2.9):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 40)


# ── running gear ────────────────────────────────────────────────────────

def paint_tracks_side(m):
    zone = L.C_TRACK_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    # wheel-well band (empty space behind the wheels)
    m.d.rectangle([x0, py(0.90), x1, py(0.05)], fill=BLACKISH)
    m.o.rectangle([x0, py(0.90), x1, py(0.05)], fill=(AO_DEEP - 30, R_RUBBER, 30))
    # 6 road wheels
    for wz in L.ROAD_WHEELS:
        cx, cy = pz(wz), py(0.48)
        r = pz(wz + 0.38) - pz(wz)
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RUBBER)
        r2 = r * 0.66
        m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=jit(TRACK_MET, 3))
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(AO_DEEP, R_RUBBER, 30))
        m.o.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=(AO_SEAM, R_STEEL, M_TRACK))
        for k in range(6):
            a = k * np.pi / 3 + 0.3
            bolts(m, [(cx + np.cos(a) * r2 * 0.55, cy + np.sin(a) * r2 * 0.55)],
                  r=2, base=TRACK_MET)
        m.d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=STEEL_DK)
    # skirt armour band
    sy0, sy1 = py(1.13), py(0.67)
    m.d.rectangle([x0, sy0, x1, sy1], fill=ARMOR_DK)
    m.o.rectangle([x0, sy0, x1, sy1], fill=(AO_BASE, R_ARMOR, M_ARMOR))
    for i in range(6):
        sx = x0 + (x1 - x0) * (i + 1) / 7.0
        seam_v(m, int(sx), int(sy0) + 2, int(sy1) - 2, ARMOR_DK)
    bolts(m, [(x0 + (x1 - x0) * (i + 0.5) / 7.0, (sy0 + sy1) / 2)
              for i in range(7)], base=ARMOR_DK)
    # team stripe segment at the skirt front
    m.t.rectangle([x0 + 6, sy0 + 3, x0 + 56, sy1 - 3], fill=(255, 0, 0))
    m.d.rectangle([x0 + 6, sy0 + 3, x0 + 56, sy1 - 3], fill=TEAMGREY)
    # fender edge band
    fy0, fy1 = py(1.30), py(1.16)
    m.d.rectangle([x0, fy0, x1, fy1], fill=ARMOR)
    seam_h(m, x0, x1, int(fy1), ARMOR)
    wear_edges(m, (x0, int(sy0), x1, int(sy1)), ARMOR_DK, 30)


def paint_track_wrap(m):
    x0, y0, x1, y1 = L.C_TRACK_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    n = 56
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx + 1, y0, lx + lw - 1, y1], fill=jit(TRACK_MET, 5))
        m.d.line([(lx, y0), (lx, y1)], fill=BLACKISH, width=2)
        m.d.rectangle([lx + lw * 0.35, y0 + 2, lx + lw * 0.65, y1 - 2],
                      fill=RUBBER)
        m.o.rectangle([lx + lw * 0.35, y0 + 2, lx + lw * 0.65, y1 - 2],
                      fill=(AO_SEAM, R_RUBBER, 60))


def paint_fender(m):
    x0, y0, x1, y1 = L.C_FENDER.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    for gx in range(x0 + 6, x1 - 4, 14):
        for gy in range(y0 + 6, y1 - 4, 12):
            off = 4 if ((gy - y0) // 12) % 2 else 0
            m.d.line([(gx + off, gy), (gx + off + 5, gy + 4)],
                     fill=shade(ARMOR_DK, 1.28), width=2)
    seam_h(m, x0, x1, y0 + 2, ARMOR_DK, hi=False)
    for i in range(5):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 10, y0 + 2), (x0 + 10 + i * 10, y0 + 2),
                     (x0 + 4 + i * 10, y0 + 14), (x0 - 6 + i * 10, y0 + 14)],
                    fill=c)


# ── casemate cabin ──────────────────────────────────────────────────────

def paint_cabin_side(m):
    zone = L.C_CABIN_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # lower recess band
    _, bv = zone.uv((0, 1.56, 0))
    m.d.rectangle([x0, int(bv * W), x1, y1], fill=STEEL_DK)
    m.o.rectangle([x0, int(bv * W), x1, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
    # white command band along the top edge (mirror-safe)
    m.d.rectangle([x0 + 2, y0 + 4, x1 - 2, y0 + 16], fill=WHITE_MK)
    wear_edges(m, (x0 + 2, y0 + 4, x1 - 2, y0 + 16), ARMOR, 20)
    # team panel with command sigil (symmetric — zone is L/R shared)
    pu0, pv0 = zone.uv((0, 2.16, -0.55))
    pu1, pv1 = zone.uv((0, 1.62, 0.65))
    panel = [pu0 * W, pv0 * W, pu1 * W, pv1 * W]
    m.t.rectangle(panel, fill=(255, 0, 0))
    m.d.rectangle(panel, fill=TEAMGREY)
    m.d.rectangle(panel, outline=shade(ARMOR, 0.5), width=2)
    command_sigil(m, (panel[0] + panel[2]) / 2, (panel[1] + panel[3]) / 2,
                  min(panel[2] - panel[0], panel[3] - panel[1]) * 0.36,
                  on_team_mask=True, ring=(50, 54, 60))
    # vision block strip forward of the panel
    vu0, vv0 = zone.uv((0, 2.20, -1.30))
    vu1, vv1 = zone.uv((0, 2.06, -0.75))
    m.d.rectangle([vu0 * W, vv0 * W, vu1 * W, vv1 * W], fill=GLASS)
    m.o.rectangle([vu0 * W, vv0 * W, vu1 * W, vv1 * W],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    # seams
    for wz in (-1.0, 0.8, 1.3):
        u, _ = zone.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, int(bv * W), ARMOR)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 9), int(bv * W) - 8)
              for i in range(10)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, int(bv * W)), ARMOR, 30)


def paint_cabin_front(m):
    x0, y0, x1, y1 = L.C_CABIN_FRONT.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ARMOR_DK)
    # commander vision visor (emissive slit)
    vy = y0 + (y1 - y0) * 0.30
    m.d.rectangle([x0 + 18, vy - 8, x1 - 18, vy + 8], fill=GLASS)
    m.o.rectangle([x0 + 18, vy - 8, x1 - 18, vy + 8],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([x0 + 22, vy - 2, x1 - 22, vy + 2], fill=(40, 110, 125))
    bolts(m, [(x0 + 8 + i * ((x1 - x0 - 16) / 5), y1 - 8) for i in range(6)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 25)


def paint_cabin_rear(m):
    x0, y0, x1, y1 = L.C_CABIN_REAR.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # porch door + window
    db = [x0 + (x1 - x0) * 0.30, y0 + (y1 - y0) * 0.12,
          x0 + (x1 - x0) * 0.70, y1 - 6]
    m.d.rectangle(db, outline=shade(ARMOR_DK, 0.5), width=3)
    m.d.rectangle([db[0] + 10, db[1] + 8, db[2] - 10, db[1] + 34], fill=GLASS)
    m.o.rectangle([db[0] + 10, db[1] + 8, db[2] - 10, db[1] + 34],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    # status LEDs over the door (comms rack tell-tales)
    for i, c in enumerate(((90, 230, 110), AMBER, (90, 230, 110), AMBER)):
        lx = x0 + 24 + i * 18
        m.d.ellipse([lx - 4, y0 + 12, lx + 4, y0 + 20], fill=c)
        m.e.ellipse([lx - 4, y0 + 12, lx + 4, y0 + 20], fill=shade(c, 0.7))
    numeral(m, x1 - 34, y0 + 26, '01', 30)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 25)


def paint_cabin_top(m):
    zone = L.C_CABIN_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(4):
        bx = x0 + RNG.random() * (x1 - x0 - 70)
        by = y0 + RNG.random() * (y1 - y0 - 44)
        m.d.polygon([(bx, by + 8), (bx + 60, by), (bx + 70, by + 30),
                     (bx + 12, by + 40)], fill=jit(ARMOR_DK, 3))
    for wz in (-0.8, 0.1, 1.0):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), ARMOR)
    # white roof star in a ring — the strategic-zoom command read
    su, sv = zone.uv((0.0, 0, 0.15))
    command_sigil(m, su * W, sv * W, 52, ring=WHITE_MK)
    # roof numeral aft of the star
    nu, nv = zone.uv((0.0, 0, 1.15))
    numeral(m, nu * W, nv * W, '01', 46)
    # dish-mast base plate
    mu, mv = zone.uv((L.MAST_BASE[0], 0, L.MAST_BASE[2]))
    m.d.ellipse([mu * W - 16, mv * W - 16, mu * W + 16, mv * W + 16],
                fill=STEEL_DK)
    m.o.ellipse([mu * W - 16, mv * W - 16, mu * W + 16, mv * W + 16],
                fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(mu * W + np.cos(a) * 12, mv * W + np.sin(a) * 12)
              for a in np.linspace(0, 2 * np.pi, 6, endpoint=False)],
          base=STEEL)
    # banner-mount plate
    bu, bv = zone.uv((L.BANNER_OFF[0], 0, L.BANNER_OFF[2]))
    m.d.rectangle([bu * W - 10, bv * W - 10, bu * W + 10, bv * W + 10],
                  fill=STEEL_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 35)


# ── awning + map table ──────────────────────────────────────────────────

def paint_awning(m):
    zone = L.C_AWNING_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 6, rough=225, metal=0)
    # fabric panels between rafters, alternating tone; rafter shadows
    n = 5
    for i in range(n + 1):
        gy = y0 + (y1 - y0) * i / n
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=CANVAS_DK, width=3)
    for i in range(n):
        if i % 2 == 0:
            continue
        gy0 = y0 + (y1 - y0) * i / n + 3
        gy1 = y0 + (y1 - y0) * (i + 1) / n - 3
        m.d.rectangle([x0 + 2, gy0, x1 - 2, gy1], fill=jit(CANVAS_LT, 3))
    # centre ridge + stitch seams
    seam_v(m, (x0 + x1) // 2, y0 + 2, y1 - 2, CANVAS)
    # white command border on the canvas edges (reads from the air)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y0 + 10], fill=WHITE_MK)
    m.d.rectangle([x0 + 2, y1 - 10, x1 - 2, y1 - 2], fill=WHITE_MK)
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 40)

    x0, y0, x1, y1 = L.C_AWNING_BOT.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CANVAS_LT, 1.08), ao=AO_BASE - 40,
         rough=225, metal=0)
    for i in range(4):
        gy = y0 + (y1 - y0) * (i + 0.5) / 4
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=CANVAS, width=2)

    fill(m, L.C_AWNING_EDGE.rect, dif=CANVAS_DK, ao=AO_BASE - 20,
         rough=225, metal=0)
    x0, y0, x1, y1 = L.C_AWNING_EDGE.rect
    # scalloped hem
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.arc([sx, y1 - 18, sx + (x1 - x0) / 8, y1 + 10], 180, 360,
                fill=shade(CANVAS_DK, 0.7), width=3)


def paint_table(m):
    # tabletop: recessed tactical display + paper chart corner
    x0, y0, x1, y1 = L.C_TABLE_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=140,
         metal=170)
    scr = [x0 + 12, y0 + 12, x1 - 12, y1 - 26]
    m.d.rectangle(scr, fill=(14, 22, 28))
    m.o.rectangle(scr, fill=(AO_BASE, R_GLASS, M_GLASS))
    # dim cyan grid + contacts (the commander's plot)
    for fx in np.linspace(0.12, 0.88, 6):
        gx = scr[0] + (scr[2] - scr[0]) * fx
        m.e.line([(gx, scr[1] + 4), (gx, scr[3] - 4)], fill=(16, 46, 52))
    for fy in np.linspace(0.12, 0.88, 6):
        gy = scr[1] + (scr[3] - scr[1]) * fy
        m.e.line([(scr[0] + 4, gy), (scr[2] - 4, gy)], fill=(16, 46, 52))
    for (fx, fy, c) in ((0.3, 0.4, MAPGLOW), (0.62, 0.28, MAPGLOW),
                        (0.72, 0.66, (200, 90, 60)), (0.4, 0.72, MAPGLOW)):
        bx = scr[0] + (scr[2] - scr[0]) * fx
        by = scr[1] + (scr[3] - scr[1]) * fy
        m.e.ellipse([bx - 3, by - 3, bx + 3, by + 3], fill=c)
        m.d.ellipse([bx - 3, by - 3, bx + 3, by + 3], fill=(30, 44, 48))
    # clipped paper chart across one corner
    m.d.polygon([(x1 - 64, y0 + 6), (x1 - 8, y0 + 6), (x1 - 8, y0 + 58),
                 (x1 - 40, y0 + 66)], fill=(196, 186, 158))
    m.d.line([(x1 - 58, y0 + 22), (x1 - 16, y0 + 30)], fill=(120, 60, 50),
             width=2)
    m.d.line([(x1 - 52, y0 + 42), (x1 - 20, y0 + 48)], fill=(60, 80, 120),
             width=2)
    # tool rail along the exposed rear edge
    m.d.rectangle([x0 + 8, y1 - 18, x1 - 8, y1 - 8], fill=STEEL)
    bolts(m, [(x0 + 20, y1 - 13), (x1 - 20, y1 - 13)], base=STEEL)

    x0, y0, x1, y1 = L.C_TABLE_SIDE.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_DK, 1.05), ao=AO_BASE - 15,
         rough=150, metal=170)
    # chart drawers
    for fy in (0.30, 0.66):
        dy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0 + 14, dy - 9, x1 - 14, dy + 9],
                      outline=shade(STEEL_DK, 0.6), width=2)
        m.d.rectangle([(x0 + x1) / 2 - 10, dy - 2, (x0 + x1) / 2 + 10, dy + 2],
                      fill=BLACKISH)


# ── greeble cells ───────────────────────────────────────────────────────

def paint_details(m):
    # hatches
    x0, y0, x1, y1 = L.C_HATCH.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    m.d.ellipse([x0 + 8, y0 + 8, x1 - 8, y1 - 8], fill=ARMOR,
                outline=shade(ARMOR_DK, 0.55), width=2)
    bolts(m, [((x0 + x1) / 2 + np.cos(a) * ((x1 - x0) / 2 - 12),
               (y0 + y1) / 2 + np.sin(a) * ((y1 - y0) / 2 - 12))
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          base=ARMOR)
    m.d.rectangle([(x0 + x1) / 2 - 12, (y0 + y1) / 2 - 4,
                   (x0 + x1) / 2 + 12, (y0 + y1) / 2 + 4], fill=STEEL_DK)
    # intake grille
    x0, y0, x1, y1 = L.C_INTAKE.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 25)
    vent_slots(m, [x0 + 6, y0 + 8, x1 - 6, y1 - 8], 5)
    # exhaust mufflers (faint orange heat inside the slats)
    x0, y0, x1, y1 = L.C_EXHAUST.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 30, rough=190,
         metal=160)
    vent_slots(m, [x0 + 8, y0 + 10, x1 - 8, y1 - 10], 3, glow=(110, 40, 12))
    # glacis sensor visor: black glass + cyan core line
    x0, y0, x1, y1 = L.C_SENSOR.rect
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    midy = (y0 + y1) / 2
    m.e.rectangle([x0 + 6, midy - 2, x1 - 6, midy + 2], fill=CYAN)
    for fx in (0.25, 0.5, 0.75):
        lx = x0 + (x1 - x0) * fx
        m.e.ellipse([lx - 3, midy - 8, lx + 3, midy - 2],
                    fill=(120, 200, 220))
    # stowage bins: straps + latches
    x0, y0, x1, y1 = L.C_STOW.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.06), ao=AO_BASE - 12)
    for fx in (0.25, 0.55, 0.85):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 4, sx + 3, y1 - 4], fill=STEEL_DK)
        m.d.rectangle([sx - 5, (y0 + y1) / 2 - 5, sx + 5, (y0 + y1) / 2 + 5],
                      fill=STEEL)
    seam_h(m, x0 + 2, x1 - 2, y0 + 12, LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 25)
    x0, y0, x1, y1 = L.C_STOW_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 1.02), ao=AO_BASE - 8)
    for fx in (0.25, 0.55, 0.85):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 4, sx + 3, y1 - 4], fill=STEEL_DK)
    # parametric wraps: whips, pole, mast/yoke, trim
    fill(m, L.C_ANT, dif=STEEL_DK, ao=AO_BASE - 10, rough=120, metal=200)
    x0, y0, x1, y1 = L.C_ANT
    for fy in (0.25, 0.5, 0.75):     # whip segment ferrules
        gy = y0 + (y1 - y0) * fy
        m.d.rectangle([x0, gy - 2, x1, gy + 2], fill=GALV)
    fill(m, L.C_POLE, dif=GALV, ao=AO_BASE - 6, rough=R_STEEL - 20,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.C_POLE
    m.d.rectangle([x0, y0 + (y1 - y0) // 2 - 3, x1, y0 + (y1 - y0) // 2 + 3],
                  fill=STEEL_DK)
    fill(m, L.C_MAST, dif=STEEL, ao=AO_BASE - 6, rough=R_STEEL, metal=M_STEEL)
    x0, y0, x1, y1 = L.C_MAST
    for gy in range(int(y0) + 14, int(y1), 22):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(STEEL, 0.85),
                 width=2)
    fill(m, L.C_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    # beacon / feed-head light cell: amber, emissive
    z = L.C_LIGHT
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(AMBER, 0.8))


def paint_dish(m):
    # front: off-white, concentric ribs, team wedge, feed glow
    z = L.C_DISH_F
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DISHC, ao=AO_BASE, rough=R_ARMOR + 6,
         metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.44, 0.30, 0.16):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(DISHC, 0.82), width=3)
    m.d.polygon([(cx, cy), (cx + (x1 - x0) * 0.44, cy - 34),
                 (cx + (x1 - x0) * 0.44, cy + 34)], fill=TEAMGREY)
    m.t.polygon([(cx, cy), (cx + (x1 - x0) * 0.44, cy - 34),
                 (cx + (x1 - x0) * 0.44, cy + 34)], fill=(255, 0, 0))
    m.e.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(66, 130, 140))
    # back: darker ribbed shell
    z = L.C_DISH_B
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DISHC, 0.72), ao=AO_BASE - 8,
         rough=R_ARMOR + 10, metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.42, 0.26):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(DISHC, 0.6), width=4)


def paint_banner(m):
    """Faction standard: the cloth is ~all team mask around a punched
    dark sigil, gold fringe on the fly, dark hoist sleeve."""
    for z, mirror in ((L.C_BANNER_F, False), (L.C_BANNER_B, True)):
        x0, y0, x1, y1 = z.rect
        # cloth field: full team read
        fill(m, (x0, y0, x1, y1), dif=TEAMGREY, ao=AO_BASE - 4, rough=235,
             metal=0)
        m.t.rectangle([x0, y0, x1, y1], fill=(255, 0, 0))
        # woven texture: soft warp/weft value ripple (keeps the mask intact)
        for gy in range(y0 + 6, y1, 18):
            m.d.line([(x0 + 2, gy), (x1 - 2, gy)],
                     fill=jit(shade(TEAMGREY, 0.94), 3), width=2)
        # hoist sleeve (dark, no team) — at u=hoist edge
        hx0, hx1 = (x0, x0 + 14) if not mirror else (x1 - 14, x1)
        m.d.rectangle([hx0, y0, hx1, y1], fill=BANNER_DK)
        m.t.rectangle([hx0, y0, hx1, y1], fill=(0, 0, 0))
        # gold fringe along the fly + bottom edges
        fx0, fx1 = (x1 - 10, x1) if not mirror else (x0, x0 + 10)
        for gy in range(y0, y1, 12):
            m.d.rectangle([fx0, gy + 2, fx1, gy + 9], fill=YELLOW)
            m.t.rectangle([fx0, gy + 2, fx1, gy + 9], fill=(0, 0, 0))
        for gx in range(x0 + 14, x1 - 10, 12):
            m.d.rectangle([gx + 2, y1 - 10, gx + 9, y1], fill=YELLOW)
            m.t.rectangle([gx + 2, y1 - 10, gx + 9, y1], fill=(0, 0, 0))
        # punched command sigil (dark on the team field, both faces)
        command_sigil(m, (x0 + x1) / 2, y0 + (y1 - y0) * 0.42,
                      (x1 - x0) * 0.30, on_team_mask=True, ring=BANNER_DK)
        wear_edges(m, (x0, y0, x1, y1), TEAMGREY, 20)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_dark(m)
    paint_hull_top(m)
    paint_glacis(m)
    paint_hull_rear(m)
    paint_hull_side(m)
    paint_tracks_side(m)
    paint_track_wrap(m)
    paint_fender(m)
    paint_cabin_side(m)
    paint_cabin_front(m)
    paint_cabin_rear(m)
    paint_cabin_top(m)
    paint_awning(m)
    paint_table(m)
    paint_details(m)
    paint_dish(m)
    paint_banner(m)

    # ── weathering: kinetic, one notch lighter than the line tank ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.55)
    wx.mud_band(L.C_TRACK_SIDE.rect, 0.9, fade='down')
    tx0, ty0, tx1, ty1 = L.C_TRACK_SIDE.rect
    skirt_bot = int(L.C_TRACK_SIDE.uv((0, 0.67, 0))[1] * 1024)
    wx.plate_bottom_rust((tx0, ty0, tx1, skirt_bot), n=8, band=8,
                         strength=0.6)
    for i in range(6):
        sx = tx0 + (tx1 - tx0) * (i + 0.5) / 6.0
        wx.rust_streak(sx, skirt_bot - 4, 14, strength=0.35)
    wx.mud_band(L.C_TRACK_WRAP, 0.55, fade=None)
    wx.mud_band(L.C_FENDER.rect, 0.45, fade=None)
    wx.mud_band(L.C_HULL_SIDE.rect, 0.6, fade='down', dust=0.35)
    wx.mud_band(L.C_GLACIS.rect, 0.5, fade='down', dust=0.3)
    gx0, gy0, gx1, gy1 = L.C_GLACIS.rect
    for fx in (0.14, 0.5, 0.86):
        wx.rust_streak(gx0 + (gx1 - gx0) * fx, gy0 + (gy1 - gy0) * 0.55,
                       28, width=2.4, strength=0.35)
    wx.mud_band(L.C_HULL_REAR.rect, 0.4, fade='down', dust=0.22)
    wx.mud_band(L.C_HULL_TOP.rect, 0.16, fade=None, spatter=False)
    wx.mud_band(L.C_CABIN_TOP.rect, 0.14, fade=None, spatter=False)
    for z in (L.C_CABIN_SIDE, L.C_CABIN_FRONT, L.C_CABIN_REAR):
        wx.mud_band(z.rect, 0.2, fade='down', spatter=False)
    wx.mud_band(L.C_STOW.rect, 0.3, fade='down', spatter=False)
    wx.mud_band(L.C_AWNING_TOP.rect, 0.18, fade=None, spatter=False)
    wx.mud_band(L.C_BANNER_F.rect, 0.15, fade='down', spatter=False)
    wx.mud_band(L.C_BANNER_B.rect, 0.15, fade='down', spatter=False)
    for r in (L.C_HULL_SIDE.rect, L.C_GLACIS.rect, L.C_HULL_REAR.rect):
        wx.plate_bottom_rust(r, n=6, strength=0.5)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    wx.soot_patch(L.C_EXHAUST.rect, 0.65)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    zone = L.C_TRACK_SIDE

    def hpy(wy):
        return zone.uv((0, wy, 0))[1] * 1024

    def hpz(wz):
        return zone.uv((0, 0, wz))[0] * 1024

    tx0, ty0, tx1, ty1 = zone.rect
    hm.rect((tx0, hpy(0.90), tx1, hpy(0.05)), -3.0)   # wheel well recess
    for wz in L.ROAD_WHEELS:
        cx, cy = hpz(wz), hpy(0.48)
        r = hpz(wz + 0.38) - hpz(wz)
        hm.disc(cx, cy, r, 0.3)
        hm.disc(cx, cy, r * 0.66, 0.5)
        hm.disc(cx, cy, 4, 0.68)
    hm.rect((tx0, hpy(1.13), tx1, hpy(0.67)), 0.22)   # skirt proud
    hm.rect((tx0, hpy(1.30), tx1, hpy(1.16)), 0.3)    # fender edge band
    # discrete track links
    wx0, wy0, wx1, wy1 = L.C_TRACK_WRAP
    for i in range(56):
        lx = wx0 + (wx1 - wx0) * i / 56
        lw = (wx1 - wx0) / 56
        hm.rect((lx + 1.5, wy0, lx + lw - 1.5, wy1), 0.5)
        hm.rect((lx + lw * 0.35, wy0 + 2, lx + lw * 0.65, wy1 - 2), 0.85)
    # fender tread diamonds
    fx0, fy0, fx1, fy1 = L.C_FENDER.rect
    for gx in range(fx0 + 6, fx1 - 4, 14):
        for gy in range(fy0 + 6, fy1 - 4, 12):
            off = 4 if ((gy - fy0) // 12) % 2 else 0
            hm.line((gx + off, gy), (gx + off + 5, gy + 4), 0.45, width=2)
    # table display recess
    x0, y0, x1, y1 = L.C_TABLE_TOP.rect
    hm.rect((x0 + 12, y0 + 12, x1 - 12, y1 - 26), -0.5)
    # awning canvas: rafter ridges + gentle sag between them
    x0, y0, x1, y1 = L.C_AWNING_TOP.rect
    for i in range(6):
        gy = y0 + (y1 - y0) * i / 5
        hm.line((x0 + 2, gy), (x1 - 2, gy), 0.5, width=3)
    # banner ripple: vertical wavy folds following the baked wave
    for z in (L.C_BANNER_F, L.C_BANNER_B):
        x0, y0, x1, y1 = z.rect
        for fx in (0.3, 0.55, 0.8):
            pts = [((x0 + (x1 - x0) * fx) + 6 * np.sin(t / 26.0), y0 + t)
                   for t in range(0, y1 - y0, 13)]
            for a, b in zip(pts, pts[1:]):
                hm.line(a, b, 0.4, width=3)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.5).save(
        os.path.join(OUT, f'{STEM}_normals.png'))

    # soften emissive slightly so glow edges aren't razor-hard in mips
    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save(os.path.join(OUT, f'{STEM}_diffuse.png'))
    m.orm.save(os.path.join(OUT, f'{STEM}_orm.png'))
    m.emi.save(os.path.join(OUT, f'{STEM}_emissive.png'))
    m.tea.save(os.path.join(OUT, f'{STEM}_team.png'))
    print(f'[paint_{STEM}] full 1024 texture set written to {OUT}')


if __name__ == '__main__':
    paint_all()
