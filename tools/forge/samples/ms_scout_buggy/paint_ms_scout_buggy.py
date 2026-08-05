"""paint_ms_scout_buggy — 1024² PBR set for ms_scout_buggy.

Fast/fragile scout read: light armor-grey tub with a dark lower band,
black padded roll cage, chunky rubber tyres on steel hubs, canvas seats
and rear-rack tarp, sensor pod with a glowing visor slit, dish plate
with a team wedge. Team mask (R channel): hood chevron, side door
panels, rear ID square, dish wedge — never baked into diffuse.
Weathering: dust film up top, heavy mud low + on wheels, plate-bottom
rust, greasy hubs, soot at the exhaust.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_scout_buggy_layout as L      # sets meshlib.ATLAS = 1024
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
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)

W = 1024
CANVAS = (96, 88, 70)          # seat / tarp canvas
PAD = (40, 42, 46)             # roll-cage padding
CYAN_GLOW = (110, 225, 245)
AMBER = (255, 176, 60)


def paint_top(m):
    z = L.S_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # camo blocks
    for _ in range(5):
        bx = x0 + RNG.random() * (x1 - x0 - 80)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 8), (bx + 64, by), (bx + 78, by + 34),
                     (bx + 12, by + 46)], fill=jit(ARMOR_DK, 3))
    # cockpit opening: dark tub interior between cowl and engine deck
    _, cv0 = z.uv((0, 0, -0.42))
    _, cv1 = z.uv((0, 0, 0.72))
    m.d.rectangle([x0 + 26, cv0 * W, x1 - 26, cv1 * W], fill=BLACKISH)
    m.o.rectangle([x0 + 26, cv0 * W, x1 - 26, cv1 * W],
                  fill=(AO_DEEP, R_RUBBER, 20))
    # hood panel seams
    for wz in (-1.9, -1.35, -0.85):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 6, x1 - 6, int(v * W), ARMOR)
    for wx in (-0.42, 0.42):
        u, _ = z.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 6, int(cv0 * W) - 4, ARMOR)
    # hood team chevron (mask + neutral grey diffuse)
    cu, _ = z.uv((0, 0, 0))
    _, hv0 = z.uv((0, 0, -1.85))
    _, hv1 = z.uv((0, 0, -1.05))
    cx = cu * W
    hw = (x1 - x0) * 0.30
    poly = [(cx - hw, hv1 * W), (cx, hv0 * W), (cx + hw, hv1 * W),
            (cx + hw, hv1 * W + 14), (cx, hv0 * W + 14), (cx - hw, hv1 * W + 14)]
    m.t.polygon(poly, fill=(255, 0, 0))
    m.d.polygon(poly, fill=TEAMGREY, outline=shade(ARMOR_DK, 0.55))
    # engine-deck seams + grip strips
    for wz in (0.85, 1.55, 2.0):
        _, v = z.uv((0, 0, wz))
        seam_h(m, x0 + 6, x1 - 6, int(v * W), ARMOR)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 5), y0 + 10) for i in range(6)],
          base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 50)


def paint_side(m):
    z = L.S_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    # lower band dark (tub bottom / rocker)
    _, wv = z.uv((0, 0.55, 0))
    wy = int(wv * W)
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
    seam_h(m, x0, x1, wy, ARMOR)
    # panel seams
    for wz in (-1.5, -0.7, 0.35, 1.1, 1.8):
        u, _ = z.uv((0, 0, wz))
        seam_v(m, int(u * W), y0 + 3, wy, ARMOR)
    # team door panel (mirror-safe symmetric block, no text)
    pu0, pv0 = z.uv((0, 0.98, -0.55))
    pu1, pv1 = z.uv((0, 0.60, 0.35))
    panel = [pu0 * W, pv0 * W, pu1 * W, pv1 * W]
    m.t.rectangle(panel, fill=(255, 0, 0))
    m.d.rectangle(panel, fill=TEAMGREY, outline=shade(ARMOR, 0.5), width=2)
    # symmetric double-bar emblem on the panel
    cxp = (panel[0] + panel[2]) / 2
    ph = panel[3] - panel[1]
    for k in (0.30, 0.58):
        bar = [cxp - 22, panel[1] + ph * k, cxp + 22, panel[1] + ph * k + 8]
        m.t.rectangle(bar, fill=(0, 0, 0))
        m.d.rectangle(bar, fill=(44, 48, 52))
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 9), y0 + 9) for i in range(10)],
          base=ARMOR)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 45)


def paint_front(m):
    z = L.S_FRONT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_v(m, (x0 + x1) // 2, y0 + 3, y1 - 3, ARMOR_DK)
    # headlight pair (emissive)
    for fx in (0.26, 0.74):
        lx = x0 + (x1 - x0) * fx
        ly = y0 + (y1 - y0) * 0.32
        m.d.rectangle([lx - 8, ly - 5, lx + 8, ly + 5], fill=GLASS)
        m.e.rectangle([lx - 6, ly - 3, lx + 6, ly + 3], fill=(190, 205, 215))
        m.o.rectangle([lx - 8, ly - 5, lx + 8, ly + 5],
                      fill=(AO_SEAM, R_GLASS, M_GLASS))
    # tow shackle
    tx, ty = (x0 + x1) / 2, y1 - (y1 - y0) * 0.24
    m.d.rectangle([tx - 9, ty - 5, tx + 9, ty + 5], fill=STEEL_DK)
    m.d.ellipse([tx - 5, ty - 3, tx + 5, ty + 3], fill=BLACKISH)
    m.o.rectangle([tx - 9, ty - 5, tx + 9, ty + 5], fill=(AO_SEAM, R_STEEL, M_STEEL))
    bolts(m, [(x0 + 8 + i * ((x1 - x0 - 16) / 3), y1 - 9) for i in range(4)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)


def paint_rear(m):
    z = L.S_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # hazard strip along the bottom edge
    for i in range(int((x1 - x0) / 14) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 14, y1 - 14), (x0 + i * 14 + 14, y1 - 14),
                     (x0 + i * 14 + 7, y1 - 4), (x0 + i * 14 - 7, y1 - 4)],
                    fill=c)
    # team ID square + taillights
    m.t.rectangle([x1 - 38, y0 + 10, x1 - 10, y0 + 36], fill=(255, 0, 0))
    m.d.rectangle([x1 - 38, y0 + 10, x1 - 10, y0 + 36], fill=TEAMGREY)
    m.e.rectangle([x0 + 12, y0 + 16, x0 + 34, y0 + 22], fill=(160, 30, 24))
    m.d.rectangle([x0 + 12, y0 + 16, x0 + 34, y0 + 22], fill=(70, 20, 18))
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 28)


def paint_running_gear(m):
    # tyre tread wrap: rubber with lug blocks
    x0, y0, x1, y1 = L.S_WHEEL
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_SEAM, rough=R_RUBBER, metal=0)
    n = 24
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx + 1, y0 + 2, lx + lw * 0.55, y1 - 2],
                      fill=jit((44, 46, 50), 3))
        m.o.rectangle([lx + 1, y0 + 2, lx + lw * 0.55, y1 - 2],
                      fill=(AO_BASE - 40, R_RUBBER + 20, 0))
    # hub caps (side + spare orientations share the drawing)
    for z in (L.S_HUB, L.S_HUB_Z):
        r = z.rect
        fill(m, r, dif=RUBBER, ao=AO_SEAM, rough=R_RUBBER, metal=0)
        cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
        rr = (r[2] - r[0]) / 2
        # tyre sidewall ring
        m.d.ellipse([cx - rr + 2, cy - rr + 2, cx + rr - 2, cy + rr - 2],
                    fill=RUBBER)
        # steel hub
        hr = rr * 0.52
        m.d.ellipse([cx - hr, cy - hr, cx + hr, cy + hr], fill=jit(TRACK_MET, 3))
        m.o.ellipse([cx - hr, cy - hr, cx + hr, cy + hr],
                    fill=(AO_SEAM, R_STEEL, M_TRACK))
        for a in np.linspace(0, 2 * np.pi, 6, endpoint=False):
            m.d.line([(cx + np.cos(a) * hr * 0.25, cy + np.sin(a) * hr * 0.25),
                      (cx + np.cos(a) * hr * 0.88, cy + np.sin(a) * hr * 0.88)],
                     fill=shade(TRACK_MET, 0.6), width=4)
        bolts(m, [(cx + np.cos(a) * hr * 0.55, cy + np.sin(a) * hr * 0.55)
                  for a in np.linspace(0.4, 2 * np.pi + 0.4, 5, endpoint=False)],
              r=2, base=TRACK_MET)
        m.d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=STEEL_DK)


def paint_cockpit(m):
    # seats: worn canvas
    z = L.S_SEAT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 20, rough=205, metal=5)
    for fy in (0.3, 0.55, 0.8):
        m.d.line([(x0 + 6, y0 + (y1 - y0) * fy), (x1 - 6, y0 + (y1 - y0) * fy)],
                 fill=shade(CANVAS, 0.78), width=3)
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 20)
    # dash: dark panel with small instrument glow
    z = L.S_DASH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 15, rough=R_STEEL,
         metal=M_STEEL)
    for i in range(3):
        gx = x0 + 20 + i * 22
        m.d.ellipse([gx - 6, y0 + 14, gx + 6, y0 + 26], fill=GLASS)
        m.e.ellipse([gx - 4, y0 + 16, gx + 4, y0 + 24],
                    fill=(40, 90, 60) if i else (90, 60, 30))
    # engine intake hump: grille slats
    z = L.S_ENGINE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 20)
    vent_slots(m, [x0 + 8, y0 + 10, x1 - 8, y1 - 10], 5)
    # sill step plates: diamond tread
    z = L.S_SILL
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8)
    for gx in range(x0 + 6, x1 - 4, 14):
        for gy in range(y0 + 6, y1 - 4, 12):
            off = 4 if ((gy - y0) // 12) % 2 else 0
            m.d.line([(gx + off, gy), (gx + off + 5, gy + 4)],
                     fill=shade(ARMOR_DK, 1.28), width=2)
    # rear rack stowage: strapped tarp
    z = L.S_STOW
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CANVAS, 1.08), ao=AO_BASE - 25,
         rough=200, metal=5)
    for fx in (0.28, 0.55, 0.8):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0 + 4, sx + 3, y1 - 4], fill=STEEL_DK)
        m.o.rectangle([sx - 3, y0 + 4, sx + 3, y1 - 4],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), CANVAS, 16)


def paint_pod(m):
    # cage tubes: black padding with clamp collars
    x0, y0, x1, y1 = L.S_CAGE
    fill(m, (x0, y0, x1, y1), dif=PAD, ao=AO_BASE - 12, rough=195, metal=25)
    for fx in np.linspace(0.08, 0.92, 7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 3, y0, sx + 3, y1], fill=STEEL_DK)
        m.o.rectangle([sx - 3, y0, sx + 3, y1], fill=(AO_SEAM, R_STEEL, M_STEEL))
    # trim wrap: mechanical steel
    fill(m, L.S_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL, metal=M_STEEL)
    # pod housing
    z = L.S_POD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, y0 + (y1 - y0) // 3, ARMOR_DK)
    bolts(m, [(x0 + 12, y0 + 12), (x1 - 12, y0 + 12), (x0 + 12, y1 - 12),
              (x1 - 12, y1 - 12)], base=ARMOR_DK)
    # pod front: visor glass + glowing sensor slit
    z = L.S_POD_F
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    midy = (y0 + y1) / 2
    m.e.rectangle([x0 + 8, midy - 3, x1 - 8, midy + 3], fill=CYAN_GLOW)
    m.e.ellipse([(x0 + x1) / 2 - 4, midy - 12, (x0 + x1) / 2 + 4, midy - 4],
                fill=(170, 60, 50))
    # dish plate front: pale, ribbed, team wedge, feed glow
    z = L.S_DISH
    x0, y0, x1, y1 = z.rect
    DISHC = (206, 204, 197)
    fill(m, (x0, y0, x1, y1), dif=DISHC, ao=AO_BASE, rough=R_ARMOR + 6,
         metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.42, 0.27, 0.13):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(DISHC, 0.82), width=3)
    m.d.polygon([(cx, cy), (cx + (x1 - x0) * 0.42, cy - 26),
                 (cx + (x1 - x0) * 0.42, cy + 26)], fill=TEAMGREY)
    m.t.polygon([(cx, cy), (cx + (x1 - x0) * 0.42, cy - 26),
                 (cx + (x1 - x0) * 0.42, cy + 26)], fill=(255, 0, 0))
    m.e.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=shade(CYAN_GLOW, 0.55))
    # dish back
    z = L.S_DISH_B
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DISHC, 0.72), ao=AO_BASE - 8,
         rough=R_ARMOR + 10, metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.40, 0.24):
        rr = (x1 - x0) * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(DISHC, 0.6), width=4)
    # dark cell (undersides, bores)
    fill(m, L.S_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_top(m)
    paint_side(m)
    paint_front(m)
    paint_rear(m)
    paint_running_gear(m)
    paint_cockpit(m)
    paint_pod(m)

    # ── weathering: scout lives off-road ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.6)
    # running gear heaviest
    wx.mud_band(L.S_WHEEL, 0.85, fade=None)
    wx.mud_band(L.S_HUB.rect, 0.7, fade='down')
    wx.mud_band(L.S_HUB_Z.rect, 0.55, fade='down')
    # tub: graded up from the rocker line + dry dust film
    wx.mud_band(L.S_SIDE.rect, 0.7, fade='down', dust=0.4)
    wx.mud_band(L.S_FRONT.rect, 0.6, fade='down', dust=0.3)
    wx.mud_band(L.S_REAR.rect, 0.55, fade='down', dust=0.25)
    wx.mud_band(L.S_SILL.rect, 0.75, fade=None)
    # high surfaces: thin dust only
    wx.mud_band(L.S_TOP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.S_STOW.rect, 0.3, fade=None, spatter=False)
    wx.mud_band(L.S_SEAT.rect, 0.22, fade=None, spatter=False)
    wx.mud_band(L.S_CAGE, 0.25, fade=None, spatter=False)
    # rust: water lines + bolts
    for r in (L.S_SIDE.rect, L.S_FRONT.rect, L.S_REAR.rect):
        wx.plate_bottom_rust(r, n=6, strength=0.55)
    gx0, gy0, gx1, gy1 = L.S_FRONT.rect
    for fx in (0.26, 0.5, 0.74):
        wx.rust_streak(gx0 + (gx1 - gx0) * fx, gy0 + (gy1 - gy0) * 0.45,
                       26, width=2.4, strength=0.35)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.55)
    # grease on hubs; soot at the exhaust corner of the rear panel
    wx.oily(L.S_HUB.rect, 0.4)
    wx.oily(L.S_HUB_Z.rect, 0.3)
    rx0, ry0, rx1, ry1 = L.S_REAR.rect
    wx.soot_patch((rx0, ry0 + (ry1 - ry0) * 0.45, rx0 + (rx1 - rx0) * 0.4, ry1),
                  0.55)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # tyre tread lugs stand proud
    x0, y0, x1, y1 = L.S_WHEEL
    for i in range(24):
        lx = x0 + (x1 - x0) * i / 24
        lw = (x1 - x0) / 24
        hm.rect((lx + 1, y0 + 2, lx + lw * 0.55, y1 - 2), 0.7)
    # hub dish + spokes
    for z in (L.S_HUB, L.S_HUB_Z):
        r = z.rect
        cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
        hr = (r[2] - r[0]) / 2 * 0.52
        hm.disc(cx, cy, hr, -0.35)
        for a in np.linspace(0, 2 * np.pi, 6, endpoint=False):
            hm.line((cx + np.cos(a) * hr * 0.25, cy + np.sin(a) * hr * 0.25),
                    (cx + np.cos(a) * hr * 0.88, cy + np.sin(a) * hr * 0.88),
                    0.4, width=4)
        hm.disc(cx, cy, 6, 0.55)
    # sill tread diamonds
    sx0, sy0, sx1, sy1 = L.S_SILL.rect
    for gx in range(sx0 + 6, sx1 - 4, 14):
        for gy in range(sy0 + 6, sy1 - 4, 12):
            off = 4 if ((gy - sy0) // 12) % 2 else 0
            hm.line((gx + off, gy), (gx + off + 5, gy + 4), 0.45, width=2)
    # dish concentric ribs
    r = L.S_DISH.rect
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    for f in (0.42, 0.27, 0.13):
        rr = (r[2] - r[0]) * f
        hm.disc(cx, cy, rr, 0.18)
    hm.crevices_from(m.dif, 0.6)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.5).save('out/ms_scout_buggy_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_scout_buggy_diffuse.png')
    m.orm.save('out/ms_scout_buggy_orm.png')
    m.emi.save('out/ms_scout_buggy_emissive.png')
    m.tea.save('out/ms_scout_buggy_team.png')
    print('[paint_ms_scout_buggy] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
