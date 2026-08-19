"""paint_nexus — 2048² PBR set for ms_command_nexus.

Command-centre read: heavy armor plating with a dark wainscot, lit
window strips on both keep tiers, a glowing cyan war-room band on the
tower, team-banded crown parapet + gate chevron + bastion tops, hex
command insignia on the pad, guide-lit gate lane, red mast beacon.
Weathering: dust at wall bases, rust off sills and the pipe run, tire
wear on the ramp + gate lane, dish/vent grime.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import nexus_layout as L          # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
CONCRETE = (146, 144, 138)
WAINSCOT = (56, 60, 66)
PLATE = ARMOR
PLATE_T2 = shade(ARMOR, 1.08)
ROOFC = (86, 92, 99)
WARM = (255, 190, 120)
CYAN_GLOW = (120, 235, 255)
RED = (235, 60, 40)


def plating(m, rect, base, vstep=64, hstep=0):
    """Panel seams — the armor-plate signature (vertical panel joints)."""
    x0, y0, x1, y1 = rect
    for gx in range(int(x0) + vstep, int(x1), vstep):
        seam_v(m, gx, y0 + 2, y1 - 2, base)
    if hstep:
        for gy in range(int(y0) + hstep, int(y1), hstep):
            seam_h(m, x0 + 2, x1 - 2, gy, base)


def window_strip(m, x0, x1, y, wh=14, ww=22, gap=14, lit=0.35, col=WARM):
    """A horizontal run of small windows, ~`lit` fraction glowing."""
    gx = int(x0)
    while gx + ww < x1:
        m.d.rectangle([gx, y, gx + ww, y + wh], fill=BLACKISH)
        m.o.rectangle([gx, y, gx + ww, y + wh], fill=(AO_BASE, R_GLASS, M_GLASS))
        if RNG.random() < lit:
            c = jit(col, 14)
            m.d.rectangle([gx + 2, y + 2, gx + ww - 2, y + wh - 2], fill=shade(c, 0.55))
            m.e.rectangle([gx + 2, y + 2, gx + ww - 2, y + wh - 2], fill=shade(c, 0.8))
        gx += ww + gap


def paint_walls(m):
    for zone, base in ((L.N_T1_SIDE, PLATE), (L.N_T1_FR, PLATE),
                       (L.N_T2_SIDE, PLATE_T2), (L.N_T2_FR, PLATE_T2)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE - 6, rough=R_ARMOR,
             metal=M_ARMOR)
        plating(m, zone.rect, base, vstep=(x1 - x0) // 8, hstep=(y1 - y0) // 3)
        # dark wainscot along the wall base (v-down: base = bottom of rect)
        wy = int(y1 - (y1 - y0) * 0.16)
        m.d.rectangle([x0, wy, x1, y1], fill=WAINSCOT)
        m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 14, R_ARMOR + 12, M_ARMOR))
        seam_h(m, x0 + 2, x1 - 2, wy, base)
        # eave team band along the top
        m.d.rectangle([x0, y0, x1, y0 + 12], fill=TEAMGREY)
        m.t.rectangle([x0, y0, x1, y0 + 12], fill=(255, 0, 0))
        # two lit window strips
        window_strip(m, x0 + 30, x1 - 30, y0 + int((y1 - y0) * 0.30))
        window_strip(m, x0 + 30, x1 - 30, y0 + int((y1 - y0) * 0.55), lit=0.3)
        bolts(m, [(gx, y0 + 20) for gx in range(int(x0) + 24, int(x1), 48)],
              base=base)
        wear_edges(m, zone.rect, base, density=26)


def paint_tower(m):
    # octagon wrap: ribbed panels, cool tint — the landmark
    x0, y0, x1, y1 = L.N_TOWER
    fill(m, (x0, y0, x1, y1), dif=PLATE_T2, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)
    seg = (x1 - x0) // 8
    for gx in range(int(x0) + seg, int(x1), seg):     # facet joints
        seam_v(m, gx, y0 + 2, y1 - 2, PLATE_T2)
    for fy in (0.25, 0.5):
        seam_h(m, x0 + 2, x1 - 2, y0 + int((y1 - y0) * fy), PLATE_T2)
    window_strip(m, x0 + 20, x1 - 20, y0 + int((y1 - y0) * 0.62),
                 wh=12, ww=18, gap=22, lit=0.4)
    # war-room band: glazed, cyan glow with mullions
    bx0, by0, bx1, by1 = L.N_BAND
    m.d.rectangle([bx0, by0, bx1, by1], fill=shade(CYAN_GLOW, 0.30))
    m.o.rectangle([bx0, by0, bx1, by1], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([bx0 + 1, by0 + 8, bx1 - 1, by1 - 8], fill=shade(CYAN_GLOW, 0.75))
    mseg = (bx1 - bx0) // 16
    for gx in range(int(bx0) + mseg, int(bx1), mseg):
        m.d.line([(gx, by0 + 4), (gx, by1 - 4)], fill=STEEL_DK, width=3)
        m.e.line([(gx, by0 + 4), (gx, by1 - 4)], fill=(0, 0, 0), width=3)
    # crown parapet wrap: team band over armor
    cx0, cy0, cx1, cy1 = L.N_CROWN_W
    fill(m, (cx0, cy0, cx1, cy1), dif=PLATE, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    m.d.rectangle([cx0, cy0 + 10, cx1, cy0 + 34], fill=TEAMGREY)
    m.t.rectangle([cx0, cy0 + 10, cx1, cy0 + 34], fill=(255, 0, 0))
    # crown cap: dark pad + warning ring + team wedge
    z = L.N_CROWN
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ROOFC, ao=AO_BASE - 6, rough=R_ARMOR + 10,
         metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) * 0.44
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=YELLOW, width=6)
    m.d.ellipse([cx - rr * 0.4, cy - rr * 0.4, cx + rr * 0.4, cy + rr * 0.4],
                fill=shade(ROOFC, 0.8), outline=STEEL_DK, width=3)


def paint_roofs(m):
    for z, base in ((L.N_T1_ROOF, ROOFC), (L.N_T2_ROOF, shade(ROOFC, 1.06))):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE - 4, rough=R_ARMOR + 8,
             metal=M_ARMOR)
        step = (x1 - x0) // 10
        for gx in range(int(x0) + step, int(x1), step):   # rib panels
            m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(base, 0.85), width=2)
        wear_edges(m, z.rect, base, density=20)
    # tier2 roof: hazard ring where the tower rises + corner hatch
    x0, y0, x1, y1 = L.N_T2_ROOF.rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) * 0.36
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=YELLOW, width=5)
    hx, hy = x0 + 60, y0 + 60
    m.d.rectangle([hx, hy, hx + 70, hy + 70], fill=shade(ROOFC, 0.85),
                  outline=STEEL_DK, width=3)
    bolts(m, [(hx + 10, hy + 10), (hx + 60, hy + 10), (hx + 10, hy + 60),
              (hx + 60, hy + 60)], base=ROOFC)


def paint_pad(m):
    z = L.N_PAD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 20,
         metal=0)
    # expansion joints
    for f in np.linspace(0.125, 0.875, 7):
        gx = x0 + (x1 - x0) * f
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(CONCRETE, 0.86), width=3)
        gy = y0 + (y1 - y0) * f
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(CONCRETE, 0.86), width=3)
    # hex command insignia centred (under the keep it reads at the edges only,
    # but the corners + gate lane carry it)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) * 0.40
    pts = [(cx + rr * np.cos(a), cy + rr * np.sin(a))
           for a in np.linspace(0, 2 * np.pi, 7)[:-1]]
    m.d.line(pts + [pts[0]], fill=jit(TEAMGREY, 3), width=8)
    m.t.line(pts + [pts[0]], fill=(255, 0, 0), width=8)
    # gate lane: guide stripes toward -Z edge (v-down: -Z = high v = y1 side)
    lane_w = (x1 - x0) * 0.16
    m.d.rectangle([cx - lane_w, cy + rr * 0.7, cx + lane_w, y1 - 6],
                  fill=shade(CONCRETE, 0.94))
    for gy in range(int(cy + rr * 0.75), int(y1 - 12), 40):
        m.d.rectangle([cx - 8, gy, cx + 8, gy + 22], fill=YELLOW)
    # guide lights flanking the lane
    for sx in (cx - lane_w - 10, cx + lane_w + 10):
        for gy in range(int(cy + rr * 0.75), int(y1 - 12), 80):
            m.d.ellipse([sx - 4, gy - 4, sx + 4, gy + 4], fill=WARM)
            m.e.ellipse([sx - 4, gy - 4, sx + 4, gy + 4], fill=shade(WARM, 0.7))
    # pad sides: concrete with a hazard top band
    x0, y0, x1, y1 = L.N_PADS.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.92), ao=AO_BASE - 10,
         rough=R_ARMOR + 20, metal=0)
    for gx in range(int(x0), int(x1), 36):
        m.d.polygon([(gx, y0), (gx + 18, y0), (gx + 6, y0 + 12), (gx - 12, y0 + 12)],
                    fill=YELLOW if (gx // 36) % 2 == 0 else BLACKISH)


def paint_gate(m):
    z = L.N_GATE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    # segmented blast door
    n = 6
    seg_h = (y1 - y0 - 40) / n
    for i in range(n):
        sy = y0 + 20 + i * seg_h
        m.d.rectangle([x0 + 24, sy + 3, x1 - 24, sy + seg_h - 3],
                      fill=jit(shade(STEEL, 0.9), 4))
        m.o.rectangle([x0 + 24, sy + 3, x1 - 24, sy + seg_h - 3],
                      fill=(AO_BASE - 6, R_STEEL, M_STEEL))
    # interior glow seeping at the segment seams near the base
    m.e.rectangle([x0 + 24, int(y1 - 34), x1 - 24, int(y1 - 26)],
                  fill=shade(WARM, 0.55))
    # team chevron across the middle segments
    mid = (y0 + y1) / 2
    ch = [(x0 + 40, mid + 46), ((x0 + x1) / 2, mid - 24), (x1 - 40, mid + 46),
          (x1 - 40, mid + 14), ((x0 + x1) / 2, mid - 56), (x0 + 40, mid + 14)]
    m.d.polygon(ch, fill=TEAMGREY)
    m.t.polygon(ch, fill=(255, 0, 0))
    # frame trim
    z = L.N_TRIM_Z
    fill(m, z.rect, dif=shade(PLATE, 0.9), ao=AO_BASE - 12, rough=R_ARMOR,
         metal=M_ARMOR)
    x0, y0, x1, y1 = z.rect
    for gx in range(int(x0), int(x1), 30):
        m.d.polygon([(gx, y1 - 16), (gx + 15, y1 - 16), (gx + 7, y1), (gx - 8, y1)],
                    fill=YELLOW if (gx // 30) % 2 == 0 else BLACKISH)


def paint_ramp(m):
    z = L.N_RAMP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.96), ao=AO_BASE,
         rough=R_ARMOR + 22, metal=0)
    # edge chevrons + centre guide dashes
    for gy in range(int(y0) + 10, int(y1) - 10, 46):
        m.d.rectangle([x0 + 6, gy, x0 + 26, gy + 24], fill=YELLOW)
        m.d.rectangle([x1 - 26, gy, x1 - 6, gy + 24], fill=YELLOW)
        m.d.rectangle([(x0 + x1) / 2 - 7, gy + 4, (x0 + x1) / 2 + 7, gy + 20],
                      fill=shade(YELLOW, 0.9))


def paint_bastions(m):
    for z in (L.N_BASTION,):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=PLATE, ao=AO_BASE - 8, rough=R_ARMOR,
             metal=M_ARMOR)
        plating(m, z.rect, PLATE, vstep=(x1 - x0) // 4, hstep=0)
        wy = int(y1 - (y1 - y0) * 0.2)
        m.d.rectangle([x0, wy, x1, y1], fill=WAINSCOT)
        vent_slots(m, (x0 + 30, y0 + 26, x1 - 30, y0 + 62), 4)
    z = L.N_BASTION_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ROOFC, ao=AO_BASE - 6, rough=R_ARMOR + 8,
         metal=M_ARMOR)
    m.d.rectangle([x0 + 14, y0 + 14, x1 - 14, y1 - 14], outline=TEAMGREY, width=8)
    m.t.rectangle([x0 + 14, y0 + 14, x1 - 14, y1 - 14], outline=(255, 0, 0), width=8)


def paint_details(m):
    # vents
    z = L.N_VENT
    fill(m, z.rect, dif=STEEL, ao=AO_BASE - 8, rough=R_STEEL, metal=M_STEEL)
    x0, y0, x1, y1 = z.rect
    vent_slots(m, (x0 + 8, y0 + 10, x1 - 8, y1 - 10), 5)
    # dish face: concentric rings + warm feed glow
    z = L.N_DISH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL, 1.05), ao=AO_BASE, rough=R_STEEL,
         metal=M_STEEL)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.42, 0.3, 0.18):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=STEEL_DK, width=3)
    m.e.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=shade(CYAN_GLOW, 0.5))
    # mast/trim/pipe wraps + dark
    for rect, dif, ro, me in ((L.N_MAST, STEEL, R_STEEL, M_STEEL),
                              (L.N_TRIM, shade(STEEL, 0.92), R_STEEL, M_STEEL),
                              (L.N_PIPE, STEEL_DK, R_STEEL, M_STEEL)):
        fill(m, rect, dif=dif, ao=AO_BASE - 8, rough=ro, metal=me)
    fill(m, L.N_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)
    x0, y0, x1, y1 = L.N_PIPE
    for fy in (0.3, 0.7):
        seam_h(m, x0 + 2, x1 - 2, y0 + (y1 - y0) * fy, STEEL_DK)
    # beacon: red, strongly emissive
    z = L.N_BEACON
    fill(m, z.rect, dif=RED, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(RED, 0.85))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_walls(m)
    paint_tower(m)
    paint_roofs(m)
    paint_pad(m)
    paint_gate(m)
    paint_ramp(m)
    paint_bastions(m)
    paint_details(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    from paint import enrich
    enrich(m)
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.4)
    for zone in (L.N_T1_SIDE, L.N_T1_FR, L.N_T2_SIDE, L.N_T2_FR):
        x0, y0, x1, y1 = zone.rect
        wx.mud_band(zone.rect, 0.38, fade='down', dust=0.28)
        wx.plate_bottom_rust(zone.rect, n=7, strength=0.5)
        for i in range(7):
            sx = x0 + (x1 - x0) * (i + 0.5) / 7
            wx.rust_streak(sx, y0 + 14, 26 + (i * 9) % 24, width=2.2, strength=0.32)
    wx.mud_band(L.N_PAD.rect, 0.2, fade=None, spatter=True)
    wx.oily((L.N_PAD.rect[0] + 380, L.N_PAD.rect[3] - 260,
             L.N_PAD.rect[0] + 640, L.N_PAD.rect[3] - 40), 0.45)
    wx.mud_band(L.N_PADS.rect, 0.5, fade='down')
    wx.mud_band(L.N_RAMP.rect, 0.35, fade=None, spatter=True)
    wx.mud_band(L.N_BASTION.rect, 0.4, fade='down')
    wx.soot_patch(L.N_VENT.rect, 0.4)
    wx.oily(L.N_PIPE, 0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.45)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for zone in (L.N_T1_SIDE, L.N_T1_FR, L.N_T2_SIDE, L.N_T2_FR):
        x0, y0, x1, y1 = zone.rect
        step = (x1 - x0) // 8
        for gx in range(int(x0) + step, int(x1), step):
            hm.line((gx, y0 + 2), (gx, y1 - 2), 0.4, width=2)
    x0, y0, x1, y1 = L.N_PAD.rect
    for f in np.linspace(0.125, 0.875, 7):
        hm.line((x0 + (x1 - x0) * f, y0 + 2), (x0 + (x1 - x0) * f, y1 - 2),
                -0.5, width=3)
        hm.line((x0 + 2, y0 + (y1 - y0) * f), (x1 - 2, y0 + (y1 - y0) * f),
                -0.5, width=3)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.4).save('out/ms_command_nexus_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_command_nexus_diffuse.png')
    m.orm.save('out/ms_command_nexus_orm.png')
    m.emi.save('out/ms_command_nexus_emissive.png')
    m.tea.save('out/ms_command_nexus_team.png')
    print('[paint_nexus] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
