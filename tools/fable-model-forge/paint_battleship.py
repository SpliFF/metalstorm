"""paint_battleship — 2048² PBR set for fable_battleship (FNS Sovereign).

Naval scheme in the faction family: haze-grey topsides over a black
boot-top and oxide anti-foul, plated hull strakes, planked steel deck
with walkway lanes and anchor chains, lit bridge windows with port/
starboard nav lights, funnel team band, cyan capacitor rings on the
rail tubes, helipad on the quarterdeck, and heavy marine weathering —
rust bleeding from every scupper and hawse, waterline scum, salt
streaks, funnel soot.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import battleship_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, FONT, RNG)

W = 2048
HAZE = (108, 114, 121)          # topside grey (family-adjacent)
ANTIFOUL = (96, 52, 44)         # oxide red below waterline
BOOT = (28, 30, 33)             # boot-top band
DECKC = (74, 79, 85)            # deck steel
WARM = (255, 190, 120)
RED = (255, 62, 40)
GREEN = (60, 220, 90)


def paint_hull(m):
    zone = L.B_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    # plated strakes (horizontal) + frame verticals
    for wy in (2.6, 3.4, 4.2, 5.0):
        seam_h(m, x0 + 3, x1 - 3, int(py(wy)), HAZE, hi=False)
    for wz in np.arange(-36, 39, 4.0):
        seam_v(m, int(pz(wz)), int(py(5.7)), int(py(1.95)), HAZE, hi=False)
    # boot-top + anti-foul
    m.d.rectangle([x0, py(L.WATERLINE[1]), x1, py(L.WATERLINE[0])], fill=BOOT)
    m.o.rectangle([x0, py(L.WATERLINE[1]), x1, py(L.WATERLINE[0])],
                  fill=(AO_BASE - 15, 200, 30))
    m.d.rectangle([x0, py(L.WATERLINE[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, py(L.WATERLINE[0]), x1, y1],
                  fill=(AO_BASE - 20, 215, 20))
    # bow team flash (geometric, mirror-safe)
    fu0, fu1 = pz(-38.5), pz(-33.5)
    m.t.polygon([(fu0, py(5.75)), (fu1, py(5.75)), (fu1 - 18, py(4.1)),
                 (fu0 - 18, py(4.1))], fill=(255, 0, 0))
    m.d.polygon([(fu0, py(5.75)), (fu1, py(5.75)), (fu1 - 18, py(4.1)),
                 (fu0 - 18, py(4.1))], fill=TEAMGREY)
    # hawse + anchor plate at the bow
    m.d.ellipse([pz(-36.6) - 9, py(4.6) - 7, pz(-36.6) + 9, py(4.6) + 7],
                fill=BLACKISH)
    m.d.rectangle([pz(-36.2), py(4.3), pz(-34.4), py(3.2)],
                  fill=shade(HAZE, 0.8))
    # scuppers along the deck edge
    for wz in np.arange(-30, 38, 6.0):
        m.d.rectangle([pz(wz) - 5, int(py(5.55)), pz(wz) + 5, int(py(5.4))],
                      fill=(40, 42, 46))
    # draft marks at bow + stern
    fdm = font(11)
    for (wz, base) in ((-35.0, None), (37.5, None)):
        for i, wy in enumerate((1.6, 2.2, 2.8)):
            m.d.text((pz(wz), py(wy) - 5), f'{2 * i + 2}', font=fdm,
                     fill=(210, 214, 218))
    wear_edges(m, (x0, int(py(5.8)), x1, int(py(1.95))), HAZE, 60)

    # stern transom: name + team stripe + docking light
    zone = L.B_STERN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8)
    m.t.rectangle([x0 + 10, y1 - 42, x1 - 10, y1 - 14], fill=(255, 0, 0))
    m.d.rectangle([x0 + 10, y1 - 42, x1 - 10, y1 - 14], fill=TEAMGREY)
    f = font(40)
    tw = m.d.textlength('SOVEREIGN', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2 + 2, y0 + 60 + 2), 'SOVEREIGN', font=f,
             fill=shade(HAZE, 0.5))
    m.d.text(((x0 + x1) / 2 - tw / 2, y0 + 60), 'SOVEREIGN', font=f,
             fill=(212, 216, 220))
    m.e.ellipse([(x0 + x1) / 2 - 5, y0 + 24, (x0 + x1) / 2 + 5, y0 + 34],
                fill=(235, 240, 245))
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14)], base=HAZE)


def paint_deck(m):
    zone = L.B_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 8, rough=195, metal=90)

    def pz(wz):
        return zone.uv((0, 0, wz))[0] * W

    def px(wx):
        return zone.uv((wx, 0, 0))[1] * W

    # deck plating: longitudinal lines + transverse joints
    for wx in (-5.0, -3.4, -1.8, 0.0, 1.8, 3.4, 5.0):
        m.d.line([(x0 + 2, px(wx)), (x1 - 2, px(wx))],
                 fill=shade(DECKC, 0.85), width=2)
    for wz in np.arange(-36, 39, 5.0):
        seam_v(m, int(pz(wz)), y0 + 2, y1 - 2, DECKC, hi=False)
    # centre walkway safety lanes
    for wx in (-0.9, 0.9):
        m.d.line([(pz(-27.0), px(wx)), (pz(32.0), px(wx))],
                 fill=jit(YELLOW, 8), width=3)
    # anchor chain runs (capstans to hawse)
    for wx in (-0.9, 0.9):
        for t in range(26):
            a = t / 25
            cx = pz(-33.6 - a * 4.4)
            cy = px(wx * (1 - a) + (wx * 2.2) * a)
            m.d.ellipse([cx - 4, cy - 3, cx + 4, cy + 3], fill=(38, 40, 44))
    # helipad on the quarterdeck
    hcx, hcy = pz(L.HELIPAD[1]), px(0.0)
    rr_z = pz(L.HELIPAD[1] + 3.6) - hcx
    rr_x = px(3.6) - hcy
    m.d.ellipse([hcx - rr_z, hcy - rr_x, hcx + rr_z, hcy + rr_x],
                fill=(52, 57, 63))
    for a in np.linspace(0, 2 * np.pi, 24, endpoint=False):
        m.d.arc([hcx - rr_z + 6, hcy - rr_x + 6, hcx + rr_z - 6,
                 hcy + rr_x - 6], np.degrees(a), np.degrees(a) + 8,
                fill=(220, 224, 228), width=4)
    fh = font(54)
    tw = m.d.textlength('H', font=fh)
    m.d.text((hcx - tw / 2, hcy - 27), 'H', font=fh, fill=(220, 224, 228))
    # tie-down dots around the pad
    for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        m.d.ellipse([hcx + np.cos(a) * rr_z * 0.7 - 3,
                     hcy + np.sin(a) * rr_x * 0.7 - 3,
                     hcx + np.cos(a) * rr_z * 0.7 + 3,
                     hcy + np.sin(a) * rr_x * 0.7 + 3], fill=(30, 32, 35))
    # fo'c'sle team chevron (reads for the RTS camera)
    ccx = pz(-21.0)
    m.t.polygon([(ccx - 30, px(-2.6)), (ccx + 30, px(0)), (ccx - 30, px(2.6))],
                fill=(255, 0, 0))
    m.d.polygon([(ccx - 30, px(-2.6)), (ccx + 30, px(0)), (ccx - 30, px(2.6))],
                fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), DECKC, 70)


def paint_superstructure(m):
    for zone in (L.B_SUPER,):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6)
        for fx in np.linspace(0.12, 0.88, 6):
            seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 3, y1 - 3, HAZE, hi=False)
        # porthole rows + doors
        for i in range(10):
            phx = x0 + 34 + i * (x1 - x0 - 68) / 10
            m.d.ellipse([phx - 6, (y0 + y1) / 2 - 6, phx + 6, (y0 + y1) / 2 + 6],
                        fill=GLASS)
            m.o.ellipse([phx - 6, (y0 + y1) / 2 - 6, phx + 6, (y0 + y1) / 2 + 6],
                        fill=(AO_BASE, R_GLASS, M_GLASS))
        for fx in (0.22, 0.74):
            dx0 = x0 + (x1 - x0) * fx
            m.d.rectangle([dx0, y1 - 74, dx0 + 34, y1 - 8], fill=(50, 54, 60),
                          outline=shade(HAZE, 0.6), width=2)
        wear_edges(m, (x0, y0, x1, y1), HAZE, 40)
    # bridge: window band + nav lights (port red / starboard green by
    # world +x sampling — both faces read correctly)
    zone = L.B_BRIDGE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 1.05), ao=AO_BASE - 4)
    wy0 = y0 + (y1 - y0) * 0.22
    wy1 = y0 + (y1 - y0) * 0.46
    m.d.rectangle([x0 + 8, wy0, x1 - 8, wy1], fill=GLASS)
    m.o.rectangle([x0 + 8, wy0, x1 - 8, wy1], fill=(AO_BASE, R_GLASS, M_GLASS))
    for i in range(9):
        gx = x0 + 8 + (x1 - x0 - 16) * i / 9
        m.d.rectangle([gx - 2, wy0, gx + 2, wy1], fill=shade(HAZE, 0.7))
    for i in (1, 4, 6):
        gx0 = x0 + 8 + (x1 - x0 - 16) * i / 9 + 3
        gx1 = x0 + 8 + (x1 - x0 - 16) * (i + 1) / 9 - 3
        m.e.rectangle([gx0, wy0 + 3, gx1, wy1 - 3], fill=(150, 110, 60))
    pu = zone.uv((3.6, 0, 0))[0] * W      # port (world +x)
    su = zone.uv((-3.6, 0, 0))[0] * W     # starboard
    m.e.ellipse([pu - 5, wy0 - 12, pu + 5, wy0 - 2], fill=RED)
    m.e.ellipse([su - 5, wy0 - 12, su + 5, wy0 - 2], fill=GREEN)
    wear_edges(m, (x0, y0, x1, y1), HAZE, 25)
    # fire-control tower: slits + sensor domes
    zone = L.B_TOWER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8)
    m.d.rectangle([x0 + 14, y0 + 30, x1 - 14, y0 + 44], fill=GLASS)
    m.e.rectangle([x0 + 16, y0 + 33, x0 + 60, y0 + 41], fill=(60, 160, 180))
    m.d.ellipse([(x0 + x1) / 2 - 14, y1 - 60, (x0 + x1) / 2 + 14, y1 - 32],
                fill=(140, 144, 150))
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2 + 20, HAZE, hi=False)
    # funnel: cap + team band
    x0, y0, x1, y1 = L.B_FUNNEL
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8)
    m.d.rectangle([x0, y0, x1, y0 + 26], fill=BLACKISH)
    m.t.rectangle([x0, y0 + 34, x1, y0 + 66], fill=(255, 0, 0))
    m.d.rectangle([x0, y0 + 34, x1, y0 + 66], fill=TEAMGREY)
    for fy in (0.55, 0.8):
        seam_h(m, x0, x1, int(y0 + (y1 - y0) * fy), HAZE, hi=False)
    r = L.B_STACKTOP.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=60)
    # deckhouse: hangar door + stripes
    zone = L.B_DECKHOUSE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6)
    m.d.rectangle([x0 + (x1 - x0) // 3, y0 + 24, x1 - (x1 - x0) // 3, y1 - 8],
                  fill=(60, 64, 70), outline=shade(HAZE, 0.6), width=3)
    for i in range(4):
        sy = y0 + 24 + (y1 - y0 - 32) * i / 4
        m.d.line([(x0 + (x1 - x0) // 3 + 3, sy), (x1 - (x1 - x0) // 3 - 3, sy)],
                 fill=shade(HAZE, 0.7), width=2)
    m.e.rectangle([x0 + (x1 - x0) // 3 + 4, y1 - 12, x1 - (x1 - x0) // 3 - 4,
                   y1 - 8], fill=WARM)
    # breakwater hazard
    zone = L.B_BREAK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 8)
    for i in range(int((x1 - x0) / 18) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 18, y1 - 20), (x0 + i * 18 + 18, y1 - 20),
                     (x0 + i * 18 + 9, y1 - 4), (x0 + i * 18 - 9, y1 - 4)],
                    fill=c)


def paint_weapons(m):
    # turret shells
    zone = L.B_TUR_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 5)
    for wz in (-2.4, 0.4, 2.8):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 4, x1 - 4, int(v * W), HAZE, hi=False)
    ccx = (x0 + x1) / 2
    cy0 = y0 + (y1 - y0) * 0.6
    m.t.polygon([(ccx - 70, cy0 + 54), (ccx, cy0), (ccx + 70, cy0 + 54),
                 (ccx + 70, cy0 + 72), (ccx, cy0 + 18), (ccx - 70, cy0 + 72)],
                fill=(255, 0, 0))
    m.d.polygon([(ccx - 70, cy0 + 54), (ccx, cy0), (ccx + 70, cy0 + 54),
                 (ccx + 70, cy0 + 72), (ccx, cy0 + 18), (ccx - 70, cy0 + 72)],
                fill=TEAMGREY)
    bolts(m, [(x0 + 16 + i * ((x1 - x0 - 32) / 9), y0 + 12) for i in range(10)],
          base=HAZE)
    wear_edges(m, (x0, y0, x1, y1), HAZE, 55)
    zone = L.B_TUR_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 6)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2 + 18, HAZE, hi=False)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 8), y1 - 14) for i in range(9)],
          base=HAZE)
    wear_edges(m, (x0, y0, x1, y1), HAZE, 45)
    zone = L.B_TUR_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 0.92), ao=AO_BASE - 10)
    # blast bags at the tube roots
    for fx in (0.22, 0.5, 0.78):
        bx = x0 + (x1 - x0) * fx
        m.d.ellipse([bx - 26, y1 - 60, bx + 26, y1 - 14], fill=(70, 66, 60))
        m.o.ellipse([bx - 26, y1 - 60, bx + 26, y1 - 14],
                    fill=(AO_BASE - 25, 215, 15))
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12)], base=HAZE)
    # tubes: steel + heat + cyan capacitor rings
    x0, y0, x1, y1 = L.B_BARREL
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=115,
         metal=210)
    hx0 = x0 + int((x1 - x0) * 0.72)
    heat = Image.new('RGB', (x1 - hx0, y1 - y0), (78, 56, 52))
    grad = Image.new('L', (x1 - hx0, 1), 0)
    for gx in range(x1 - hx0):
        grad.putpixel((gx, 0), int(70 * (gx / max(1, x1 - hx0 - 1)) ** 1.5))
    m.dif.paste(heat, (hx0, y0), grad.resize((x1 - hx0, y1 - y0)))
    for fy in (0.33, 0.66):
        m.d.line([(x0, y0 + (y1 - y0) * fy), (x1, y0 + (y1 - y0) * fy)],
                 fill=shade(STEEL_DK, 0.75), width=2)
    x0, y0, x1, y1 = L.B_CAP_RING
    fill(m, (x0, y0, x1, y1), dif=(50, 54, 60), ao=AO_BASE - 15, rough=120,
         metal=200)
    midx = (x0 + x1) / 2
    m.e.rectangle([midx - 6, y0, midx + 6, y1], fill=CYAN)
    m.d.rectangle([midx - 6, y0, midx + 6, y1], fill=(46, 70, 76))
    r = L.B_TUBE_CAP.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=205, metal=70)
    ccx, ccy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([ccx - 12, ccy - 12, ccx + 12, ccy + 12], fill=(12, 12, 14))
    # VLS panel
    zone = L.B_VLS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 0.9), ao=AO_BASE - 8)
    for r_ in range(4):
        for c_ in range(6):
            hx = x0 + 18 + c_ * (x1 - x0 - 36) / 6
            hx2 = x0 + 8 + (c_ + 1) * (x1 - x0 - 36) / 6
            hy = y0 + 18 + r_ * (y1 - y0 - 36) / 4
            hy2 = y0 + 10 + (r_ + 1) * (y1 - y0 - 36) / 4
            m.d.rectangle([hx, hy, hx2, hy2], fill=(52, 55, 60),
                          outline=shade(HAZE, 0.6), width=2)
            m.o.rectangle([hx, hy, hx2, hy2], fill=(AO_SEAM, R_ARMOR, M_ARMOR))
    for i in range(int((x1 - x0) / 16) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 16, y0 + 2), (x0 + i * 16 + 16, y0 + 2),
                     (x0 + i * 16 + 8, y0 + 10), (x0 + i * 16 - 8, y0 + 10)],
                    fill=c)
    m.e.ellipse([x1 - 16, y1 - 16, x1 - 8, y1 - 8], fill=RED)
    # PDC + barbettes + boats + radar + trim
    x0, y0, x1, y1 = L.B_PDC.rect
    fill(m, (x0, y0, x1, y1), dif=(58, 62, 68), ao=AO_BASE - 12, rough=150,
         metal=185)
    m.d.ellipse([(x0 + x1) / 2 - 20, (y0 + y1) / 2 - 20, (x0 + x1) / 2 + 20,
                 (y0 + y1) / 2 + 20], fill=(40, 44, 48))
    m.e.ellipse([(x0 + x1) / 2 - 4, (y0 + y1) / 2 - 4, (x0 + x1) / 2 + 4,
                 (y0 + y1) / 2 + 4], fill=(255, 90, 60))
    x0, y0, x1, y1 = L.B_BARBETTE
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 0.85), ao=AO_BASE - 15)
    for fx in (0.25, 0.5, 0.75):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, HAZE, hi=False)
    x0, y0, x1, y1 = L.B_BOAT
    fill(m, (x0, y0, x1, y1), dif=(88, 84, 74), ao=AO_BASE - 8, rough=200,
         metal=30)
    m.d.rectangle([x0, (y0 + y1) // 2 - 3, x1, (y0 + y1) // 2 + 3],
                  fill=(56, 54, 48))
    for fx in (0.25, 0.5, 0.75):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 2, y0, sx + 2, y1], fill=(56, 54, 48))
    r = L.B_BOAT_CAP.rect
    fill(m, r, dif=(88, 84, 74), ao=AO_BASE - 10, rough=200, metal=30)
    zone = L.B_RADAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(140, 144, 150), ao=AO_BASE - 5, rough=150,
         metal=130)
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.rectangle([sx, y0 + 8, sx + (x1 - x0) / 16, y1 - 8],
                      fill=(110, 114, 120))
    m.e.ellipse([(x0 + x1) / 2 - 4, y0 + 6, (x0 + x1) / 2 + 4, y0 + 14],
                fill=RED)
    x0, y0, x1, y1 = L.B_TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=(52, 55, 60), ao=AO_BASE - 15, rough=165,
         metal=150)
    fill(m, L.B_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_superstructure(m)
    paint_weapons(m)

    # ── marine weathering ──
    from weathering import Weather, vertical_rects_of
    from paint import enrich
    enrich(m)
    wx = Weather(seed=71)
    wx.crevice_grime(m.dif, 0.42)
    zone = L.B_HULL_SIDE
    x0, y0, x1, y1 = zone.rect

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    # rust bleeding from scuppers, hawse and down the topsides
    for wz in np.arange(-30, 38, 6.0):
        u = zone.uv((0, 0, wz))[0] * W
        wx.rust_streak(u, py(5.45), 40 + (int(wz) % 3) * 14, width=3.0,
                       strength=0.5)
    wx.rust_streak(zone.uv((0, 0, -36.4))[0] * W, py(4.4), 60, width=4.0,
                   strength=0.6)
    wx.plate_bottom_rust((x0, int(py(5.9)), x1, int(py(2.0))), n=12,
                         strength=0.5)
    # waterline scum band
    wx.mud_band((x0, int(py(2.15)), x1, int(py(1.3))), 0.55, fade=None,
                spatter=False)
    # deck wear + salt
    wx.mud_band(L.B_DECK.rect, 0.3, fade=None, spatter=True)
    wx.mud_band(L.B_SUPER.rect, 0.25, fade='down', spatter=False)
    wx.mud_band(L.B_TUR_SIDE.rect, 0.22, fade='down', spatter=False)
    dk = L.B_DECKHOUSE.rect
    wx.mud_band(dk, 0.25, fade='down', spatter=False)
    # funnel soot
    fx0, fy0, fx1, fy1 = L.B_FUNNEL
    wx.soot_patch((fx0, fy0, fx1, fy0 + (fy1 - fy0) // 3), 0.7)
    wx.soot_patch(L.B_STACKTOP.rect, 0.85)
    # gun soot + barbette grease
    bx0, by0, bx1, by1 = L.B_BARREL
    wx.soot_patch((bx0 + (bx1 - bx0) * 0.8, by0, bx1, by1), 0.4, fade='right')
    wx.soot_patch(L.B_TUBE_CAP.rect, 0.5)
    wx.oily(L.B_BARBETTE, 0.35)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.55)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    zone = L.B_HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    for wy in (2.6, 3.4, 4.2, 5.0):
        hm.line((x0 + 2, py(wy)), (x1 - 2, py(wy)), -0.4, width=2)
    for wz in np.arange(-36, 39, 4.0):
        u = zone.uv((0, 0, wz))[0] * W
        hm.line((u, py(5.7)), (u, py(1.95)), 0.3, width=2)
    # deck plating relief
    zone = L.B_DECK
    x0, y0, x1, y1 = zone.rect
    for wx_ in (-5.0, -3.4, -1.8, 0.0, 1.8, 3.4, 5.0):
        v = zone.uv((wx_, 0, 0))[1] * W
        hm.line((x0 + 2, v), (x1 - 2, v), -0.35, width=2)
    # VLS hatch recesses
    zone = L.B_VLS
    x0, y0, x1, y1 = zone.rect
    hm.rect((x0 + 14, y0 + 14, x1 - 14, y1 - 14), -0.5)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.6).save('out/fable_battleship_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_battleship_diffuse.png')
    m.orm.save('out/fable_battleship_orm.png')
    m.emi.save('out/fable_battleship_emissive.png')
    m.tea.save('out/fable_battleship_team.png')
    print('[paint_battleship] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
