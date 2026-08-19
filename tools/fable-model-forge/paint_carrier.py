"""paint_carrier — 2048² PBR set for fable_carrier (FCV-8 Bastion).

Flight deck does the talking: dark non-skid with panel grid, TWO EM
catapult lanes with glowing rails and shuttles, yellow/black JBD
chevrons, the ~2° angled recovery strip (borders, dashed centreline,
threshold chevrons, three arrestor wires), red foul lines, big bow
number 08, painted parking — 4 helo spads, 2 herringbone fighter
spots, 1 bomber spot — hazard-bordered elevator with EL 1, deck-park
fighter livery, lit island bridge + flyco bands, hangar mouth interior
with girders and warm light, haze-grey hull with boot-top and
anti-foul.  Weathering: arrestor tire skids, cat-lane blast stain,
scupper rust, waterline scum, elevator track grime.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import carrier_layout as L         # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, FONT, RNG)

W = 2048
HAZE = (106, 112, 119)          # hull grey (battleship family)
DECKC = (58, 61, 65)            # non-skid
LANE = (74, 77, 82)             # catapult lane
MARK = (222, 225, 228)          # deck markings white
REDL = (196, 60, 46)            # foul line red
WARM = (255, 190, 120)
RED = (255, 62, 40)
GREEN = (60, 220, 90)

STRIP_AX = None                 # filled in paint_deck


def rot_text(m, text, size, anchor_uv, fill_c, angle=-90, shadow=True):
    f = font(size)
    tw = int(m.d.textlength(text, font=f)) + 6
    timg = Image.new('RGBA', (tw, size + 12), (0, 0, 0, 0))
    td = ImageDraw.Draw(timg)
    if shadow:
        td.text((4, 4), text, font=f, fill=(20, 22, 24, 255))
    td.text((2, 2), text, font=f, fill=fill_c + (255,))
    timg = timg.rotate(angle, expand=True)
    m.dif.paste(timg, (int(anchor_uv[0]), int(anchor_uv[1])), timg)


def paint_deck(m):
    zone = L.C_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 8, rough=205, metal=70)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wx):
        return zone.uv((wx, 0, 0))[1] * W

    U, V = 2048 / 104.0, 640 / 32.0      # px per metre

    # panel grid + mottled tone patches
    for wz in np.arange(-48, 52, 8.0):
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, DECKC, hi=False)
    for wx in (-12.0, -6.0, 0.0, 6.0, 12.0):
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))], fill=shade(DECKC, 0.92))
    for _ in range(70):
        pz = RNG.uniform(-49, 50)
        px_ = RNG.uniform(-14, 14)
        m.d.rectangle([u(pz), v(px_), u(pz + RNG.uniform(1.5, 4)),
                       v(px_ + RNG.uniform(1.0, 2.5))],
                      fill=jit(shade(DECKC, RNG.uniform(0.93, 1.08)), 2))

    # ── catapult lanes ──
    for ci, cx in enumerate(L.CATS):
        z0, z1 = L.CAT_Z
        m.d.rectangle([u(z0), v(cx - 2.5), u(z1), v(cx + 2.5)], fill=LANE)
        for wz in np.arange(z0 + 1, z1, 3.0):        # side dashes
            for s in (-2.3, 2.3):
                m.d.rectangle([u(wz), v(cx + s - 0.14), u(wz + 1.5),
                               v(cx + s + 0.14)], fill=MARK)
        # EM rails (emissive) + shuttle block
        for rs in (-0.55, 0.55):
            m.d.rectangle([u(z0 + 0.5), v(cx + rs - 0.1), u(z1 - 0.5),
                           v(cx + rs + 0.1)], fill=(40, 60, 66))
            m.e.rectangle([u(z0 + 0.5), v(cx + rs - 0.07), u(z1 - 0.5),
                           v(cx + rs + 0.07)], fill=(40, 170, 190))
        m.d.rectangle([u(-46.5 + ci * 2), v(cx - 0.8), u(-45.3 + ci * 2),
                       v(cx + 0.8)], fill=(36, 38, 42))
        rot_text(m, f'CAT {ci + 1}', 26, (u(-17.5) - 16, v(cx) - 34),
                 MARK)

    # bow number, reading along the axis
    rot_text(m, '08', 150, (u(-44) - 80, v(-1.8)), MARK)

    # ── recovery strip (angled) ──
    z0, xx0, z1, xx1, wid = L.STRIP
    p0 = np.array([u(z0), v(xx0)])
    p1 = np.array([u(z1), v(xx1)])
    d = p1 - p0
    d = d / np.linalg.norm(d)
    n = np.array([-d[1], d[0]])
    hw = wid / 2 * V
    if abs(n[1]) > 0:
        n = n * np.sign(n[1])
    c0, c1 = p0 + n * hw, p0 - n * hw
    c2, c3 = p1 - n * hw, p1 + n * hw
    for off in (hw, -hw):                            # borders
        a, b = p0 + n * off, p1 + n * off
        m.d.line([tuple(a), tuple(b)], fill=MARK, width=4)
    steps = int(np.linalg.norm(p1 - p0) / 60)
    for i in range(steps):                           # dashed centreline
        a = p0 + (p1 - p0) * (i + 0.15) / steps
        b = p0 + (p1 - p0) * (i + 0.6) / steps
        m.d.line([tuple(a), tuple(b)], fill=MARK, width=4)
    for i in range(5):                               # threshold bars
        base = p0 + d * (8 + i * 9)
        a, b = base + n * (hw - 10), base - n * (hw - 10)
        m.d.line([tuple(a), tuple(b)], fill=MARK, width=3)
    # arrestor wires + sheaves
    for wz in L.WIRES:
        t = (wz - z0) / (z1 - z0)
        c = p0 + (p1 - p0) * t
        a, b = c + n * (hw + 12), c - n * (hw + 12)
        m.d.line([tuple(a), tuple(b)], fill=(30, 32, 35), width=3)
        for e in (a, b):
            m.d.ellipse([e[0] - 5, e[1] - 5, e[0] + 5, e[1] + 5],
                        fill=(38, 40, 44))

    # ── foul lines + deck edge dashes ──
    for off in (hw + 8, -hw - 8):
        a, b = p0 + n * off, p1 + n * off
        m.d.line([tuple(a), tuple(b)], fill=REDL, width=3)
    edge_pts = [(-50.5, 5.2), (-40.5, 10.7), (-24.5, 14.3), (-6, 14.7),
                (11.5, 14.6), (28.5, 14.0), (39.5, 13.7), (50.5, 12.3)]
    for i in range(len(edge_pts) - 1):
        (za, wa), (zb, wb) = edge_pts[i], edge_pts[i + 1]
        for s in (1, -1):
            segs = int((zb - za) / 2.4)
            for k in range(segs):
                t0_, t1_ = k / segs, (k + 0.55) / segs
                m.d.line([(u(za + (zb - za) * t0_),
                           v(s * (wa + (wb - wa) * t0_))),
                          (u(za + (zb - za) * t1_),
                           v(s * (wa + (wb - wa) * t1_)))],
                         fill=shade(MARK, 0.85), width=3)

    # ── parking ──
    for i, (px_, pz) in enumerate(L.PADS_HELO):      # helo spads
        cx_, cy_ = u(pz), v(px_)
        rz, rx = 3.2 * U, 3.2 * V
        m.d.ellipse([cx_ - rz, cy_ - rx, cx_ + rz, cy_ + rx],
                    outline=MARK, width=3)
        m.d.ellipse([cx_ - rz * 0.42, cy_ - rx * 0.42, cx_ + rz * 0.42,
                     cy_ + rx * 0.42], outline=shade(MARK, 0.8), width=2)
        f = font(30)
        m.d.text((cx_ - 9, cy_ - 17), 'H', font=f, fill=MARK)
    for (px_, pz) in L.PADS_FIGHT:                   # herringbone brackets
        ang = np.radians(40)
        da = np.array([np.cos(ang) * U, np.sin(ang) * V])
        na = np.array([-np.sin(ang) * U, np.cos(ang) * V])
        c = np.array([u(pz), v(px_)])
        for sl in (1, -1):
            for st in (1, -1):
                corner = c + da * (7.5 * sl) + na * (5.0 * st)
                m.d.line([tuple(corner), tuple(corner - da * 2.2 * sl)],
                         fill=MARK, width=3)
                m.d.line([tuple(corner), tuple(corner - na * 1.6 * st)],
                         fill=MARK, width=3)
        m.d.line([tuple(c - da * 6.0), tuple(c + da * 6.0)],
                 fill=shade(MARK, 0.75), width=2)
    (px_, pz) = L.PAD_BOMBER                         # bomber spot (wider)
    ang = np.radians(L.BOMBER_ANG)
    da = np.array([np.cos(ang) * U, np.sin(ang) * V])
    na = np.array([-np.sin(ang) * U, np.cos(ang) * V])
    c = np.array([u(pz), v(px_)])
    for sl in (1, -1):
        for st in (1, -1):
            corner = c + da * (6.5 * sl) + na * (6.5 * st)
            m.d.line([tuple(corner), tuple(corner - da * 2.4 * sl)],
                     fill=jit(YELLOW, 10), width=3)
            m.d.line([tuple(corner), tuple(corner - na * 2.4 * st)],
                     fill=jit(YELLOW, 10), width=3)
    # tie-down T marks scattered on aprons
    for (px_, pz) in [(-9, 18), (-11.5, 26), (-8.5, -22), (-11, -31),
                      (9.5, -12), (11.5, -28), (-8, 42), (-11, 48)]:
        cx_, cy_ = u(pz), v(px_)
        m.d.line([(cx_ - 6, cy_), (cx_ + 6, cy_)], fill=(40, 42, 46),
                 width=2)
        m.d.line([(cx_, cy_), (cx_, cy_ + 6)], fill=(40, 42, 46), width=2)

    # nav strip lights along the bow edge + team chevron amidships
    m.t.polygon([(u(-38), v(-9)), (u(-33), v(0)), (u(-38), v(9)),
                 (u(-35.2), v(9)), (u(-30.2), v(0)), (u(-35.2), v(-9))],
                fill=(255, 0, 0))
    m.d.polygon([(u(-38), v(-9)), (u(-33), v(0)), (u(-38), v(9)),
                 (u(-35.2), v(9)), (u(-30.2), v(0)), (u(-35.2), v(-9))],
                fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), DECKC, 90)


def paint_hull(m):
    zone = L.C_HULL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    # catwalk band under the deck edge + plating
    m.d.rectangle([x0, y0, x1, py(7.15)], fill=(48, 51, 55))
    for wz in np.arange(-46, 50, 3.2):
        m.d.line([(u(wz), y0 + 2), (u(wz), py(7.18))], fill=(40, 42, 46))
    for wy in (2.6, 3.8, 5.0, 6.2):
        seam_h(m, x0 + 3, x1 - 3, int(py(wy)), HAZE, hi=False)
    for wz in np.arange(-44, 50, 6.0):
        seam_v(m, int(u(wz)), int(py(6.9)), int(py(2.0)), HAZE, hi=False)
    # boot-top + anti-foul
    m.d.rectangle([x0, py(L.WATERLINE[1]), x1, py(L.WATERLINE[0])],
                  fill=(28, 30, 33))
    m.d.rectangle([x0, py(L.WATERLINE[0]), x1, y1], fill=(96, 52, 44))
    m.o.rectangle([x0, py(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))
    # hangar-deck intake grilles + team flash at the bow
    for wz in (-24.0, -6.0, 34.0, 42.0):
        vent_slots(m, (int(u(wz)), int(py(6.4)), int(u(wz + 2.6)),
                       int(py(5.2))), 4)
    m.t.polygon([(u(-50), py(7.1)), (u(-42), py(7.1)), (u(-44.5), py(4.9)),
                 (u(-50), py(4.9))], fill=(255, 0, 0))
    m.d.polygon([(u(-50), py(7.1)), (u(-42), py(7.1)), (u(-44.5), py(4.9)),
                 (u(-50), py(4.9))], fill=TEAMGREY)
    # scuppers
    for wz in np.arange(-38, 48, 7.0):
        m.d.rectangle([u(wz) - 4, int(py(7.05)), u(wz) + 4, int(py(6.9))],
                      fill=(38, 40, 44))
    wear_edges(m, (x0, y0, x1, int(py(2.0))), HAZE, 70)

    # stern transom: name + engine vents (emissive) + docking light
    zone = L.C_STERN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8)

    def uf(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def vy(wy):
        return zone.uv((0, wy, 0))[1] * W

    f = font(44)
    tw = m.d.textlength('BASTION', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2 + 2, vy(6.4) + 2), 'BASTION', font=f,
             fill=shade(HAZE, 0.5))
    m.d.text(((x0 + x1) / 2 - tw / 2, vy(6.4)), 'BASTION', font=f,
             fill=(212, 216, 220))
    for wx in (-4.5, -1.5, 1.5, 4.5):                # fusion drive vents
        m.d.rectangle([uf(wx + 1.1), vy(3.4), uf(wx - 1.1), vy(2.2)],
                      fill=(30, 32, 36))
        m.e.rectangle([uf(wx + 0.9), vy(3.25), uf(wx - 0.9), vy(2.35)],
                      fill=(45, 150, 170))
    m.t.rectangle([x0 + 12, vy(5.4), x1 - 12, vy(4.7)], fill=(255, 0, 0))
    m.d.rectangle([x0 + 12, vy(5.4), x1 - 12, vy(4.7)], fill=TEAMGREY)
    m.e.ellipse([(x0 + x1) / 2 - 5, vy(7.6), (x0 + x1) / 2 + 5, vy(7.3)],
                fill=(235, 240, 245))


def paint_island(m):
    zone = L.C_ISL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 1.03), ao=AO_BASE - 5)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    for wz in (0.5, 3.5, 6.5, 9.5, 12.5):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, HAZE, hi=False)
    for wy in (11.2, 14.0):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), HAZE, hi=False)
    # bridge glass band (fwd island) + flyco band (aft island heights)
    m.d.rectangle([u(1.8), v(15.7), u(7.0), v(14.9)], fill=GLASS)
    m.o.rectangle([u(1.8), v(15.7), u(7.0), v(14.9)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    for i in range(6):
        gx = u(1.8) + (u(7.0) - u(1.8)) * i / 6
        m.d.rectangle([gx - 2, v(15.7), gx + 2, v(14.9)],
                      fill=shade(HAZE, 0.7))
    m.e.rectangle([u(2.7), v(15.62), u(4.4), v(14.98)], fill=(150, 110, 60))
    m.d.rectangle([u(31.5), v(12.9), u(35.6), v(11.4)], fill=GLASS)
    m.o.rectangle([u(31.5), v(12.9), u(35.6), v(11.4)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([u(31.9), v(12.75), u(34.2), v(11.55)], fill=(150, 110, 60))
    # porthole rows on the bases + doors + vents
    for wz in np.arange(1.0, 13.5, 1.6):
        m.d.ellipse([u(wz) - 4, v(10.1) - 4, u(wz) + 4, v(10.1) + 4],
                    fill=GLASS)
    vent_slots(m, (int(u(9.8)), int(v(13.6)), int(u(11.8)), int(v(12.4))), 3)
    for wz in (2.2, 11.4, 32.4):
        m.d.rectangle([u(wz), v(9.9), u(wz + 0.75), v(8.4)],
                      fill=(50, 54, 60), outline=shade(HAZE, 0.6), width=2)
    # team band around the fwd island top + stripes on aft tower
    m.t.rectangle([u(-0.4), v(16.15), u(9.2), v(15.8)], fill=(255, 0, 0))
    m.d.rectangle([u(-0.4), v(16.15), u(9.2), v(15.8)], fill=TEAMGREY)
    m.t.rectangle([u(31.2), v(13.25), u(35.8), v(12.95)], fill=(255, 0, 0))
    m.d.rectangle([u(31.2), v(13.25), u(35.8), v(12.95)], fill=TEAMGREY)
    bolts(m, [(u(wz), v(8.6)) for wz in (0.8, 4.0, 7.2, 10.4, 13.2)],
          base=HAZE)
    wear_edges(m, (x0, y0, x1, y1), HAZE, 45)


def paint_elevator_hangar(m):
    # elevator platform (piece-local zone)
    zone = L.C_ELEV
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DECKC, 1.04), ao=AO_BASE - 8,
         rough=205, metal=70)

    def u(lz):
        return zone.uv((0, 0, lz))[0] * W

    def v(lx):
        return zone.uv((lx, 0, 0))[1] * W

    # hazard border
    step = 16
    for i in range(int((x1 - x0) / step)):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0 + i * step, v(-5.2), x0 + (i + 1) * step, v(-4.6)],
                      fill=c)
        m.d.rectangle([x0 + i * step, v(4.6), x0 + (i + 1) * step, v(5.2)],
                      fill=c)
    for i in range(int((v(5.2) - v(-5.2)) / step)):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([u(-7.7), v(-5.2) + i * step, u(-7.1),
                       v(-5.2) + (i + 1) * step], fill=c)
        m.d.rectangle([u(7.1), v(-5.2) + i * step, u(7.7),
                       v(-5.2) + (i + 1) * step], fill=c)
    for lz in (-4.0, 0.0, 4.0):
        m.d.line([(u(lz), v(-4.4)), (u(lz), v(4.4))], fill=shade(DECKC, 0.9))
    rot_text(m, 'EL 1', 30, (u(6.0) - 16, v(-4.2)), MARK)
    for (lz, lx) in ((-5, -3), (-5, 3), (5, -3), (5, 3), (0, -4), (0, 4)):
        m.d.line([(u(lz) - 6, v(lx)), (u(lz) + 6, v(lx))], fill=(40, 42, 46),
                 width=2)
        m.d.line([(u(lz), v(lx)), (u(lz), v(lx) + 6)], fill=(40, 42, 46),
                 width=2)

    # deck-park fighter livery (local top zone)
    zone = L.C_PLANE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(117, 120, 126), ao=AO_BASE - 4,
         rough=R_ARMOR, metal=M_ARMOR)

    def up(lz):
        return zone.uv((0, 0, lz))[0] * W

    def vp(lx):
        return zone.uv((lx, 0, 0))[1] * W

    m.d.rectangle([x0, vp(-0.8), up(-5.6), vp(1.6)], fill=(96, 92, 94))
    m.d.polygon([(up(-3.3), vp(-0.3)), (up(-1.2), vp(-0.3)),
                 (up(-1.2), vp(1.1)), (up(-3.3), vp(1.1))],
                fill=(70, 60, 34))                   # canopy from above
    for s in (1, -1):
        rc = np.array([up(2.2), vp(s * 3.4 + 0.4)])
        m.d.ellipse([rc[0] - 26, rc[1] - 16, rc[0] + 26, rc[1] + 16],
                    fill=(205, 208, 212))
        m.t.ellipse([rc[0] - 16, rc[1] - 10, rc[0] + 16, rc[1] + 10],
                    fill=(255, 0, 0))
        m.d.ellipse([rc[0] - 16, rc[1] - 10, rc[0] + 16, rc[1] + 10],
                    fill=TEAMGREY)
    seam_v(m, int(up(1.0)), y0 + 4, y1 - 4, (117, 120, 126), hi=False)

    # hangar mouth interior (body zone, world coords)
    zone = L.C_HANGAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(26, 28, 32), ao=AO_DEEP, rough=190,
         metal=60)

    def uh(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vh(wy):
        return zone.uv((0, wy, 0))[1] * W

    for wz in np.arange(13.0, 28.5, 2.6):            # girder columns
        m.d.rectangle([uh(wz) - 4, y0 + 4, uh(wz) + 4, y1 - 4],
                      fill=(44, 47, 52))
    m.d.rectangle([x0, vh(7.3), x1, vh(6.9)], fill=(44, 47, 52))
    m.e.rectangle([x0 + 6, vh(7.25), x1 - 6, vh(7.0)], fill=(170, 130, 80))
    # parked silhouettes deep in the bay
    for wz in (16.0, 23.0):
        m.d.polygon([(uh(wz), vh(4.6)), (uh(wz + 3.6), vh(4.6)),
                     (uh(wz + 1.8), vh(5.9))], fill=(15, 16, 18))
    # warning frame
    step = 14
    for i in range(int((x1 - x0) / step)):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0 + i * step, y0, x0 + (i + 1) * step, y0 + 8],
                      fill=c)
        m.d.rectangle([x0 + i * step, y1 - 8, x0 + (i + 1) * step, y1],
                      fill=c)


def paint_weapons_misc(m):
    # PDC turret (piece-local)
    zone = L.C_TUR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(64, 68, 74), ao=AO_BASE - 10, rough=150,
         metal=185)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, (64, 68, 74), hi=False)
    m.e.ellipse([(x0 + x1) / 2 - 4, y0 + 14, (x0 + x1) / 2 + 4, y0 + 22],
                fill=(255, 90, 60))
    bolts(m, [(x0 + 16 + i * (x1 - x0 - 32) / 5, y1 - 12) for i in range(6)],
          base=(64, 68, 74))
    # barrels
    x0, y0, x1, y1 = L.C_BARREL
    fill(m, (x0, y0, x1, y1), dif=(52, 50, 48), ao=AO_BASE - 12, rough=120,
         metal=210)
    m.d.rectangle([x0, y0, x0 + 40, y1], fill=(38, 36, 34))
    # radar panel (piece-local)
    zone = L.C_RADAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(140, 144, 150), ao=AO_BASE - 5,
         rough=150, metal=130)
    for i in range(10):
        sx = x0 + (x1 - x0) * i / 10
        m.d.rectangle([sx, y0 + 10, sx + (x1 - x0) / 20, y1 - 10],
                      fill=(112, 116, 122))
    m.e.ellipse([(x0 + x1) / 2 - 4, y0 + 4, (x0 + x1) / 2 + 4, y0 + 12],
                fill=RED)
    # JBD chevrons
    zone = L.C_JBD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 62, 66), ao=AO_BASE - 8, rough=190,
         metal=110)
    stepj = 22
    for i in range(int((x1 - x0) / stepj) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * stepj, y1), (x0 + (i + 1) * stepj, y1),
                     (x0 + (i + 1) * stepj - 12, y0), (x0 + i * stepj - 12, y0)],
                    fill=c)
    # sponson / trim / dark / nav / glow cells
    fill(m, L.C_SPONSON.rect, dif=shade(HAZE, 0.9), ao=AO_BASE - 12,
         rough=170, metal=150)
    fill(m, L.C_TRIM.rect, dif=(52, 55, 60), ao=AO_BASE - 12, rough=165,
         metal=150)
    fill(m, L.C_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    for rect, col in ((L.C_NAVP.rect, RED), (L.C_NAVS.rect, GREEN)):
        fill(m, rect, dif=(30, 32, 35), ao=AO_BASE - 10, rough=120, metal=100)
        m.e.rectangle(list(rect), fill=col)
    x0, y0, x1, y1 = L.C_GLOW.rect
    fill(m, (x0, y0, x1, y1), dif=(36, 44, 48), ao=AO_BASE - 10, rough=120,
         metal=140)
    m.e.rectangle([x0, y0, x1, y1], fill=(45, 150, 170))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_deck(m)
    paint_hull(m)
    paint_island(m)
    paint_elevator_hangar(m)
    paint_weapons_misc(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    from paint import enrich
    enrich(m)
    wx = Weather(seed=97)
    wx.crevice_grime(m.dif, 0.4)
    dz = L.C_DECK

    def ud(wz):
        return dz.uv((0, 0, wz))[0] * W

    def vd(wx_):
        return dz.uv((wx_, 0, 0))[1] * W

    # arrestor-area tire skids + catapult blast stain
    wx.soot_patch((int(ud(30.0)), int(vd(-1.5)), int(ud(46.0)), int(vd(7.0))),
                  0.5, fade='right')
    for cx in L.CATS:
        wx.soot_patch((int(ud(-20.0)), int(vd(cx - 2.2)), int(ud(-12.5)),
                       int(vd(cx + 2.2))), 0.55, fade='right')
    wx.mud_band(L.C_DECK.rect, 0.22, fade=None, spatter=True)
    # hull: scupper rust + waterline scum
    hz = L.C_HULL

    def uh(wz):
        return hz.uv((0, 0, wz))[0] * W

    def ph(wy):
        return hz.uv((0, wy, 0))[1] * W

    for wz in np.arange(-38, 48, 7.0):
        wx.rust_streak(uh(wz), ph(6.9), 34 + (int(wz) % 3) * 12, width=3.0,
                       strength=0.45)
    wx.mud_band((hz.rect[0], int(ph(2.1)), hz.rect[2], int(ph(1.25))), 0.5,
                fade=None, spatter=False)
    # island exhaust smudge + elevator track grime
    wx.soot_patch((int(L.C_ISL.uv((0, 0, 9.0))[0] * W),
                   int(L.C_ISL.uv((0, 14.2, 0))[1] * W),
                   int(L.C_ISL.uv((0, 0, 14.5))[0] * W),
                   int(L.C_ISL.uv((0, 11.0, 0))[1] * W)), 0.35, fade='right')
    wx.oily(L.C_HANGAR.rect, 0.3)
    wx.mud_band(L.C_ELEV.rect, 0.25, fade=None, spatter=True)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for wz in np.arange(-48, 52, 8.0):
        uu = ud(wz)
        hm.line((uu, dz.rect[1] + 2), (uu, dz.rect[3] - 2), -0.3, width=2)
    for wy in (2.6, 3.8, 5.0, 6.2):
        hm.line((hz.rect[0] + 2, ph(wy)), (hz.rect[2] - 2, ph(wy)), -0.3,
                width=2)
    ez = L.C_ELEV
    hm.rect((ez.rect[0] + 4, ez.rect[1] + 4, ez.rect[2] - 4, ez.rect[3] - 4),
            0.25)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save('out/fable_carrier_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_carrier_diffuse.png')
    m.orm.save('out/fable_carrier_orm.png')
    m.emi.save('out/fable_carrier_emissive.png')
    m.tea.save('out/fable_carrier_team.png')
    print('[paint_carrier] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
