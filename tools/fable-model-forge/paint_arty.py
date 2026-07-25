"""paint_arty — 1024² PBR set for ms_artillery_s2.

FH-7 "Ordinant" self-propelled howitzer: faction blue-grey armor, dark
lower hull, rubber-padded tracks with drive hubs, casemate with team
chevron + roof numeral "07", gunmetal howitzer with heat-banded chase,
cyan recuperator glow (energy plumbing), hazard-striped recoil spade.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import arty_layout as L             # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
P.FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, stencil, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   RUBBER, TRACK_MET, YELLOW, BLACKISH, TEAMGREY, CYAN, ORANGE,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)

GUNMETAL = (58, 62, 68)


def paint_hull(m):
    # top deck
    z = L.A_HULL_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_v(m, int((x0 + x1) / 2), y0 + 2, y1 - 2, ARMOR)
    for fz in (0.28, 0.55, 0.80):
        seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * fz), ARMOR)
    # tread plate strips along the deck edges
    for ex in (x0 + 14, x1 - 26):
        m.d.rectangle([ex, y0 + 4, ex + 12, y1 - 4], fill=shade(ARMOR, 0.92))
        m.o.rectangle([ex, y0 + 4, ex + 12, y1 - 4],
                      fill=(AO_BASE - 8, R_ARMOR + 10, M_ARMOR))
    bolts(m, [(x, y) for x in range(int(x0) + 30, int(x1) - 12, 72)
              for y in (y0 + 16, y1 - 16)], r=3, base=ARMOR)
    # glacis: chevron team flash + light guards
    z = L.A_GLACIS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_LT, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.55), ARMOR_LT)
    mid = (x0 + x1) / 2
    m.d.polygon([(mid - 70, y1 - 12), (mid, y0 + (y1 - y0) * 0.42),
                 (mid + 70, y1 - 12), (mid + 44, y1 - 12), (mid, y0 + (y1 - y0) * 0.62),
                 (mid - 44, y1 - 12)], fill=TEAMGREY)
    m.t.polygon([(mid - 70, y1 - 12), (mid, y0 + (y1 - y0) * 0.42),
                 (mid + 70, y1 - 12), (mid + 44, y1 - 12), (mid, y0 + (y1 - y0) * 0.62),
                 (mid - 44, y1 - 12)], fill=(255, 0, 0))
    wear_edges(m, z.rect, ARMOR_LT, density=26)
    # rear plate: vents + stowage straps
    z = L.A_HULL_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    vent_slots(m, (x0 + 24, y0 + 30, x0 + (x1 - x0) // 2 - 8, y0 + 86), 4)
    m.d.rectangle([x1 - 90, y0 + 26, x1 - 20, y0 + 90], fill=shade(ARMOR_DK, 0.88))
    bolts(m, [(x, y) for x in (x0 + 14, x1 - 14) for y in (y0 + 14, y1 - 14)],
          r=3, base=ARMOR_DK)
    # hull side band
    z = L.A_HULL_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.5), ARMOR)
    # unit code on the bow side (single-projection zone → text safe)
    stencil(m, (x0 + 40, y0 + 22), 'FH-07', 34, shade(ARMOR_DK, 0.55))
    wear_edges(m, z.rect, ARMOR, density=30)


def paint_tracks(m):
    z = L.A_TRACK_SIDE
    x0, y0, x1, y1 = z.rect
    # side: dark void behind wheels (deep-void cheat §11), wheels redrawn
    fill(m, (x0, y0, x1, y1), dif=(13, 13, 15), ao=AO_DEEP, rough=R_RUBBER,
         metal=0)
    # road wheels along the lower band
    wy = y0 + (y1 - y0) * 0.68
    wr = (y1 - y0) * 0.24
    for fx in np.linspace(0.10, 0.90, 6):
        wx = x0 + (x1 - x0) * fx
        m.d.ellipse([wx - wr, wy - wr, wx + wr, wy + wr], fill=TRACK_MET)
        m.d.ellipse([wx - wr * 0.55, wy - wr * 0.55, wx + wr * 0.55, wy + wr * 0.55],
                    fill=shade(TRACK_MET, 1.18))
        m.d.ellipse([wx - wr * 0.18, wy - wr * 0.18, wx + wr * 0.18, wy + wr * 0.18],
                    fill=shade(TRACK_MET, 0.7))
        m.o.ellipse([wx - wr, wy - wr, wx + wr, wy + wr],
                    fill=(AO_BASE - 30, R_STEEL + 20, M_TRACK))
    # upper run: track links behind the skirt line
    m.d.rectangle([x0, y0, x1, y0 + (y1 - y0) * 0.30], fill=RUBBER)
    for lx in range(int(x0), int(x1), 14):
        m.d.line([(lx, y0 + 2), (lx, y0 + (y1 - y0) * 0.30)],
                 fill=shade(RUBBER, 0.75), width=2)
    z = L.A_TRACK_WRAP
    x0, y0, x1, y1 = z
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 16, rough=R_RUBBER,
         metal=M_TRACK - 60)
    # track links: grouser bars across the wrap
    for lx in range(int(x0), int(x1), 12):
        m.d.rectangle([lx, y0 + 2, lx + 5, y1 - 2], fill=TRACK_MET)
        m.o.rectangle([lx, y0 + 2, lx + 5, y1 - 2],
                      fill=(AO_BASE - 20, R_STEEL, M_TRACK))
    # hubs
    x0, y0, x1, y1 = L.A_HUB
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 12, rough=R_STEEL,
         metal=M_TRACK)
    for lx in range(int(x0), int(x1), 16):
        m.d.line([(lx, y0), (lx, y1)], fill=shade(TRACK_MET, 0.8), width=3)
    z = L.A_HUB_CAP
    fill(m, z.rect, dif=TRACK_MET, ao=AO_BASE - 10, rough=R_STEEL, metal=M_TRACK)
    x0, y0, x1, y1 = z.rect
    c = ((x0 + x1) / 2, (y0 + y1) / 2)
    rr = (x1 - x0) * 0.32
    m.d.ellipse([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr],
                fill=shade(TRACK_MET, 1.2))
    bolts(m, [(c[0] + rr * 0.7 * np.cos(a), c[1] + rr * 0.7 * np.sin(a))
              for a in np.linspace(0, 2 * np.pi, 7)[:-1]], r=2, base=TRACK_MET)
    # fender: tread plate + hazard tips
    z = L.A_FENDER
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.94), ao=AO_BASE - 4,
         rough=R_ARMOR + 8, metal=M_ARMOR)
    for lx in range(int(x0) + 8, int(x1) - 8, 22):
        m.d.line([(lx, y0 + 4), (lx + 10, y1 - 4)], fill=shade(ARMOR, 0.86), width=2)
    for tip in (x0, x1 - 26):
        for i in range(0, 26, 12):
            m.d.polygon([(tip + i, y0), (tip + i + 6, y0), (tip, y0 + i + 6),
                         (tip, y0 + i)], fill=YELLOW if (i // 12) % 2 == 0 else BLACKISH)


def paint_cab(m):
    # sides: big flat armor with team panel + kill rings on a rail
    z = L.A_CAB_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_v(m, int(x0 + (x1 - x0) * 0.36), y0 + 3, y1 - 3, ARMOR)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.30), ARMOR)
    # team panel strip along the upper edge
    m.d.rectangle([x0 + 8, y0 + 8, x1 - 8, y0 + 34], fill=TEAMGREY)
    m.t.rectangle([x0 + 8, y0 + 8, x1 - 8, y0 + 34], fill=(255, 0, 0))
    bolts(m, [(x, y) for x in range(int(x0) + 18, int(x1) - 8, 64)
              for y in (y0 + 46, y1 - 12)], r=3, base=ARMOR)
    wear_edges(m, z.rect, ARMOR, density=26)
    # front/rear shared: darker, vision blocks (front), door (rear reads same
    # rect mirrored — keep it symmetric, a plated face with a hatch)
    z = L.A_CAB_FRONT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.5), ARMOR_DK)
    m.d.rectangle([x0 + (x1 - x0) * 0.34, y0 + 18, x0 + (x1 - x0) * 0.66, y0 + 34],
                  fill=(24, 34, 40))
    m.e.rectangle([x0 + (x1 - x0) * 0.36, y0 + 21, x0 + (x1 - x0) * 0.64, y0 + 31],
                  fill=(26, 60, 70))
    bolts(m, [(x, y) for x in (x0 + 12, x1 - 12) for y in (y0 + 12, y1 - 12)],
          r=3, base=ARMOR_DK)
    # roof: numeral panel + hatch ring + panel seams
    z = L.A_CAB_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.97), ao=AO_BASE,
         rough=R_ARMOR + 4, metal=M_ARMOR)
    seam_v(m, int((x0 + x1) / 2), y0 + 3, y1 - 3, ARMOR)
    seam_h(m, x0 + 2, x1 - 2, int(y0 + (y1 - y0) * 0.42), ARMOR)
    nx, ny = x0 + (x1 - x0) * 0.5, y0 + (y1 - y0) * 0.72
    m.d.rectangle([nx - 38, ny - 44, nx + 38, ny + 44], fill=TEAMGREY)
    m.t.rectangle([nx - 38, ny - 44, nx + 38, ny + 44], fill=(255, 0, 0))
    stencil(m, (nx - 30, ny - 38), '07', 64, shade(ARMOR_DK, 0.6))
    f = ImageFont.truetype(P.FONT, 64)
    m.t.text((nx - 30, ny - 38), '07', font=f, fill=(0, 0, 0))
    wear_edges(m, z.rect, ARMOR, density=20)


def paint_gun(m):
    # tube wrap: gunmetal, breech collar, heat bands toward muzzle
    x0, y0, x1, y1 = L.A_TUBE
    fill(m, (x0, y0, x1, y1), dif=GUNMETAL, ao=AO_BASE - 6, rough=R_STEEL + 8,
         metal=M_STEEL - 25)
    m.d.rectangle([x0, y0, x0 + 30, y1], fill=STEEL_DK)
    for fx, c in ((0.62, (70, 62, 70)), (0.75, (82, 66, 60)), (0.9, (60, 52, 50))):
        m.d.rectangle([x0 + (x1 - x0) * fx, y0, x0 + (x1 - x0) * (fx + 0.08), y1],
                      fill=c)
    # thermal sleeve straps
    for fx in (0.25, 0.4, 0.55):
        m.d.rectangle([x0 + (x1 - x0) * fx, y0 + 2, x0 + (x1 - x0) * fx + 6, y1 - 2],
                      fill=shade(GUNMETAL, 0.72))
    z = L.A_TUBE_CAP
    fill(m, z.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_STEEL, metal=M_STEEL - 40)
    # brake: steel with soot
    z = L.A_BRAKE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    m.d.ellipse([x0 + 24, y0 + 40, x1 - 24, y1 - 40], fill=BLACKISH)
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14), (x0 + 14, y1 - 14),
              (x1 - 14, y1 - 14)], r=3, base=STEEL)
    # breech block
    z = L.A_BREECH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    seam_h(m, x0 + 2, x1 - 2, int((y0 + y1) / 2), STEEL_DK)
    bolts(m, [(x, y) for x in (x0 + 12, x1 - 12) for y in (y0 + 12, y1 - 12)],
          r=3, base=STEEL_DK)
    # recuperators: steel cylinders with cyan charge windows
    x0, y0, x1, y1 = (L.A_RECUP.rect if hasattr(L.A_RECUP, 'rect') else L.A_RECUP)
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL - 20,
         metal=M_STEEL)
    for fx in (0.30, 0.52, 0.74):
        m.d.rectangle([x0 + (x1 - x0) * fx, y0 + 3, x0 + (x1 - x0) * fx + 9,
                       y1 - 3], fill=(30, 60, 70))
        m.e.rectangle([x0 + (x1 - x0) * fx + 1, y0 + 5, x0 + (x1 - x0) * fx + 8,
                       y1 - 5], fill=shade(CYAN, 0.55))


def paint_details(m):
    # spade: steel blade with hazard chevrons
    z = L.A_SPADE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL + 12,
         metal=M_STEEL - 30)
    for i in range(0, x1 - x0, 40):
        m.d.polygon([(x0 + i, y1), (x0 + i + 20, y1), (x0 + i + 40, y0 + 60),
                     (x0 + i + 20, y0 + 60)],
                    fill=YELLOW if (i // 40) % 2 == 0 else BLACKISH)
    m.d.rectangle([x0, y0, x1, y0 + 56], fill=shade(STEEL, 0.9))
    bolts(m, [(x, y0 + 28) for x in range(int(x0) + 20, int(x1), 44)], r=3,
          base=STEEL)
    # hatch cell
    z = L.A_HATCH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 1.05), ao=AO_BASE - 4,
         rough=R_ARMOR, metal=M_ARMOR)
    c = ((x0 + x1) / 2, (y0 + y1) / 2)
    rr = (x1 - x0) * 0.36
    m.d.ellipse([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr],
                outline=shade(ARMOR, 0.6), width=3)
    bolts(m, [(c[0] + rr * np.cos(a), c[1] + rr * np.sin(a))
              for a in np.linspace(0, 2 * np.pi, 7)[:-1]], r=2, base=ARMOR)
    # intake grille
    z = L.A_INTAKE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.92), ao=AO_BASE - 8,
         rough=R_ARMOR + 6, metal=M_ARMOR)
    vent_slots(m, (x0 + 10, y0 + 12, x1 - 10, y1 - 12), 5)
    # exhaust port: sooted steel with orange heat glow at the core
    z = L.A_EXHAUST
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 12, rough=R_STEEL + 10,
         metal=M_STEEL - 20)
    m.d.ellipse([x0 + 22, y0 + 22, x1 - 22, y1 - 22], fill=BLACKISH)
    m.e.ellipse([x0 + 34, y0 + 34, x1 - 34, y1 - 34], fill=(120, 44, 8))
    # crane/limb wrap: dark steel
    x0, y0, x1, y1 = L.A_CRANE
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    # stowage baskets: olive crates strapped
    z = L.A_AMMO
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(86, 92, 76), ao=AO_BASE - 6,
         rough=R_ARMOR + 14, metal=M_ARMOR - 10)
    for fy in (0.3, 0.62):
        m.d.line([(x0 + 4, y0 + (y1 - y0) * fy), (x1 - 4, y0 + (y1 - y0) * fy)],
                 fill=shade((86, 92, 76), 0.7), width=3)
    stencil(m, (x0 + 14, y0 + 16), '155H', 26, jit(YELLOW, 8))
    # headlights
    z = L.A_LIGHT
    fill(m, z.rect, dif=(226, 232, 224), ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=(140, 150, 140))
    # dark cell
    fill(m, L.A_DARK.rect, dif=(14, 14, 16), ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=0)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_tracks(m)
    paint_cab(m)
    paint_gun(m)
    paint_details(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=57)
    wx.crevice_grime(m.dif, 0.42)
    wx.mud_band(L.A_TRACK_SIDE.rect, 0.9, fade='down', spatter=True)
    wx.mud_band(L.A_TRACK_WRAP, 0.85, fade=None, spatter=True)
    wx.mud_band(L.A_HULL_SIDE.rect, 0.6, fade='down')
    wx.mud_band(L.A_GLACIS.rect, 0.5, fade='down', spatter=True)
    wx.mud_band(L.A_HULL_REAR.rect, 0.55, fade='down')
    wx.mud_band(L.A_FENDER.rect, 0.35, fade=None)
    wx.mud_band(L.A_CAB_SIDE.rect, 0.22, fade='down', dust=0.3)
    wx.mud_band(L.A_HULL_TOP.rect, 0.15, fade=None, dust=0.25)
    wx.soot_patch((L.A_TUBE[0] + int((L.A_TUBE[2] - L.A_TUBE[0]) * 0.8),
                   L.A_TUBE[1], L.A_TUBE[2], L.A_TUBE[3]), strength=0.65)
    wx.soot_patch(L.A_BRAKE.rect, strength=0.5)
    wx.soot_patch(L.A_EXHAUST.rect, strength=0.6)
    wx.oily(L.A_HUB, strength=0.5)
    wx.plate_bottom_rust(L.A_HULL_REAR.rect, n=5, strength=0.45)
    wx.plate_bottom_rust(L.A_SPADE.rect, n=6, strength=0.6)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.35)
    wx.apply(m)
    # re-void the wheel wells after mud (§11 deep-void rule), then redraw
    # the road wheels ON TOP so only they catch light
    x0, y0, x1, y1 = L.A_TRACK_SIDE.rect
    m.d.rectangle([x0, y0 + (y1 - y0) * 0.30, x1, y1], fill=(12, 12, 14))
    wy = y0 + (y1 - y0) * 0.68
    wr = (y1 - y0) * 0.24
    WHEEL = shade(TRACK_MET, 1.5)
    for fx in np.linspace(0.10, 0.90, 6):
        wx_ = x0 + (x1 - x0) * fx
        m.d.ellipse([wx_ - wr, wy - wr, wx_ + wr, wy + wr], fill=WHEEL)
        m.d.ellipse([wx_ - wr * 0.55, wy - wr * 0.55, wx_ + wr * 0.55,
                     wy + wr * 0.55], fill=shade(WHEEL, 1.16))
        m.d.ellipse([wx_ - wr * 0.18, wy - wr * 0.18, wx_ + wr * 0.18,
                     wy + wr * 0.18], fill=shade(WHEEL, 0.68))
        m.d.ellipse([wx_ - wr, wy - wr, wx_ + wr, wy + wr],
                    outline=shade(WHEEL, 0.5), width=2)

    from normals import HeightMap
    hm = HeightMap()
    # recessed wheel wells with proud road wheels
    x0, y0, x1, y1 = L.A_TRACK_SIDE.rect
    hm.rect((x0, y0 + (y1 - y0) * 0.30, x1, y1), -3.0)
    wy = y0 + (y1 - y0) * 0.68
    wr = (y1 - y0) * 0.24
    for fx in np.linspace(0.10, 0.90, 6):
        wx_ = x0 + (x1 - x0) * fx
        hm.disc(wx_, wy, wr, 3.4)
    # track link grooves on the wrap
    tx0, ty0, tx1, ty1 = L.A_TRACK_WRAP
    for lx in range(int(tx0), int(tx1), 12):
        hm.line((lx, ty0 + 2), (lx, ty1 - 2), 1.4, width=3)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.55)
    hm.weather_from(wx)
    hm.to_normal_image(strength=5.0).save('out/ms_artillery_s2_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save('out/ms_artillery_s2_diffuse.png')
    m.orm.save('out/ms_artillery_s2_orm.png')
    m.emi.save('out/ms_artillery_s2_emissive.png')
    m.tea.save('out/ms_artillery_s2_team.png')
    print('[paint_arty] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
