"""paint_ms_fuel_tanker — 1024² PBR set for the armoured fuel tanker.

Military grey-green shell over the fable_tank armour palette: armoured
cab with vision slits and door seams, drab tank shell with painted
weld rings, two yellow/black hazard stripe rings, a team-colour ring
(mask R channel, never baked into diffuse), manhole collars under the
geometry domes, a painted access ladder, rear valve cabinet with valve
wheels + hazard placard.  Weathering: crevice grime, wheel/skirt mud,
fuel-drip stains (oily streaks below the fillers and valves — the
spec's drip weathering), bolt rust with gravity streaks.  Emissive
stays black — the spec asks for no glow.

Usage: python3 paint_ms_fuel_tanker.py   (after gen_ms_fuel_tanker.py)
"""
from __future__ import annotations
import numpy as np

import ms_fuel_tanker_layout as T
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG, ARMOR, ARMOR_LT, ARMOR_DK, LOWER,
                   STEEL, STEEL_DK, RUBBER, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP, R_ARMOR, R_STEEL, R_RUBBER,
                   R_GLASS, M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 1024
TANKC = (112, 119, 111)          # drab olive-grey shell
HOSE = (38, 39, 42)
TAIL_RED = (92, 28, 24)

ZMAX, ZMIN = T.TANK_Z1, T.TANK_Z0


def tu(z):
    x0, _, x1, _ = T.TANKW
    return x0 + (x1 - x0) * (ZMAX - z) / (ZMAX - ZMIN)


# ── cab ─────────────────────────────────────────────────────────────────

def paint_cab(m):
    zone = T.CAB_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # lower skirt band
    m.d.rectangle([x0, v(1.15), x1, y1], fill=LOWER)
    seam_h(m, x0 + 2, x1 - 2, int(v(1.15)), ARMOR)
    # armoured side window slit + shutter ribs
    m.d.rectangle([u(-3.45), v(2.32), u(-2.95), v(2.05)], fill=GLASS)
    m.o.rectangle([u(-3.45), v(2.32), u(-2.95), v(2.05)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    for wz in (-3.35, -3.2, -3.05):
        m.d.line([(u(wz), v(2.32)), (u(wz), v(2.05))],
                 fill=shade(ARMOR, 0.65), width=2)
    # door seam + hinge dots + handle
    seam_v(m, int(u(-2.62)), int(v(2.45)), int(v(0.95)), ARMOR)
    m.d.rectangle([u(-2.56) - 6, v(1.85), u(-2.56) + 6, v(1.79)],
                  fill=STEEL_DK)
    # team square on the door
    m.t.rectangle([u(-2.55), v(1.65), u(-2.25), v(1.35)], fill=(255, 0, 0))
    m.d.rectangle([u(-2.55), v(1.65), u(-2.25), v(1.35)], fill=TEAMGREY)
    # stowage rack low on the hull rear of the door
    m.d.rectangle([u(-2.2), v(1.55), u(-2.05), v(1.2)], fill=jit(LOWER, 3))
    bolts(m, [(x0 + 10 + i * (x1 - x0 - 20) / 6, y0 + 8) for i in range(7)],
          base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 45)

    zone = T.CAB_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    def uf(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def vf(wy):
        return zone.uv((0, wy, 0))[1] * W

    # vision slit + radiator grille + headlight boxes (no emissive)
    m.d.rectangle([uf(0.8), vf(2.3), uf(-0.8), vf(2.05)], fill=GLASS)
    m.o.rectangle([uf(0.8), vf(2.3), uf(-0.8), vf(2.05)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    gb = [uf(0.6), vf(1.75), uf(-0.6), vf(1.3)]
    m.d.rectangle(gb, fill=STEEL_DK)
    vent_slots(m, [gb[0] + 3, gb[1] + 3, gb[2] - 3, gb[3] - 3], 4)
    for sx in (0.95, -0.95):
        m.d.rectangle([uf(sx) - 9, vf(1.62), uf(sx) + 9, vf(1.44)],
                      fill=(196, 198, 190))
        m.o.rectangle([uf(sx) - 9, vf(1.62), uf(sx) + 9, vf(1.44)],
                      fill=(AO_BASE, 80, 60))
    # tow hooks + glacis bolts
    for fx in (0.75, -0.75):
        m.d.rectangle([uf(fx) - 8, vf(1.05), uf(fx) + 8, vf(0.92)],
                      fill=STEEL_DK)
    bolts(m, [(x0 + 12 + i * (x1 - x0 - 24) / 7, y0 + 10) for i in range(8)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)

    zone = T.CAB_ROOF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=STEEL_DK,
                outline=shade(STEEL_DK, 0.6), width=2)
    m.o.ellipse([cx - 22, cy - 22, cx + 22, cy + 22],
                fill=(AO_SEAM, R_STEEL, M_STEEL))
    for i in range(8):
        a = 2 * np.pi * i / 8
        bolts(m, [(cx + np.cos(a) * 17, cy + np.sin(a) * 17)], r=2,
              base=STEEL)
    # aerial-ID team panel forward of the hatch
    m.t.rectangle([cx - 40, y0 + 8, cx + 40, y0 + 30], fill=(255, 0, 0))
    m.d.rectangle([cx - 40, y0 + 8, cx + 40, y0 + 30], fill=TEAMGREY)
    seam_h(m, x0 + 3, x1 - 3, int(cy + 34), ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 30)


# ── tank shell ──────────────────────────────────────────────────────────

def hazard_band(m, z_hi, z_lo):
    x0, y0, x1, y1 = T.TANKW
    ux0, ux1 = tu(z_hi), tu(z_lo)
    m.d.rectangle([ux0, y0, ux1, y1], fill=BLACKISH)
    m.o.rectangle([ux0, y0, ux1, y1], fill=(AO_BASE - 6, 185, 30))
    step, slant = 16, 9
    x = ux0 - step
    i = 0
    while x < ux1 + step:
        if i % 2 == 0:
            poly = [(max(ux0, min(ux1, x)), y0),
                    (max(ux0, min(ux1, x + step)), y0),
                    (max(ux0, min(ux1, x + step - slant)), y1),
                    (max(ux0, min(ux1, x - slant)), y1)]
            m.d.polygon(poly, fill=jit(YELLOW, 6))
        x += step
        i += 1
    seam_v(m, int(ux0), y0 + 2, y1 - 2, TANKC, hi=False)
    seam_v(m, int(ux1), y0 + 2, y1 - 2, TANKC, hi=False)


def paint_tank(m):
    x0, y0, x1, y1 = T.TANKW
    fill(m, (x0, y0, x1, y1), dif=TANKC, ao=AO_BASE - 4, rough=150,
         metal=110)
    # shell plate welds + end flange rings with bolt rows
    for wz in T.WELD_Z:
        seam_v(m, int(tu(wz)), y0 + 2, y1 - 2, TANKC)
    for wz in T.RING_Z:
        seam_v(m, int(tu(wz)), y0 + 2, y1 - 2, TANKC)
        bolts(m, [(tu(wz) + 5, y0 + 12 + k * 24) for k in range(10)], r=2,
              base=STEEL)
    for (zh, zl) in T.HAZBANDS:
        hazard_band(m, zh, zl)
    # team ring (mask R; diffuse under it stays neutral grey)
    tz0, tz1 = T.TEAM_BAND
    m.t.rectangle([tu(tz0), y0, tu(tz1), y1], fill=(255, 0, 0))
    m.d.rectangle([tu(tz0), y0, tu(tz1), y1], fill=TEAMGREY)
    seam_v(m, int(tu(tz0)), y0 + 2, y1 - 2, TANKC, hi=False)
    seam_v(m, int(tu(tz1)), y0 + 2, y1 - 2, TANKC, hi=False)
    # manhole collars under the geometry domes (top face row v 224..256)
    for hz in T.HATCH_Z:
        cx = tu(hz)
        m.d.ellipse([cx - 26, 226, cx + 26, 254], fill=STEEL_DK,
                    outline=shade(STEEL_DK, 0.6), width=2)
        m.o.ellipse([cx - 26, 226, cx + 26, 254],
                    fill=(AO_SEAM, R_STEEL, M_STEEL))
    # access ladder on the rear right flank (rails + rungs)
    lr0, lr1 = tu(2.95), tu(2.72)
    for lx in (lr0, lr1):
        m.d.line([(lx, 230), (lx, y1 - 4)], fill=STEEL_DK, width=3)
    for ry in range(246, y1 - 6, 16):
        m.d.line([(lr0, ry), (lr1, ry)], fill=STEEL_DK, width=2)
        m.o.line([(lr0, ry), (lr1, ry)], fill=(AO_SEAM, R_STEEL, M_STEEL),
                 width=2)
    # flammable placard on the left flank mid-tank: yellow diamond
    px, py = tu(0.55), 316
    dia = [(px, py - 20), (px + 20, py), (px, py + 20), (px - 20, py)]
    m.d.polygon(dia, fill=jit(YELLOW, 4), outline=BLACKISH)
    m.d.polygon([(px, py - 9), (px + 6, py + 6), (px - 6, py + 6)],
                fill=BLACKISH)
    # bottom drain line + sump plug
    m.d.line([(tu(2.9), 368), (tu(-1.5), 368)], fill=shade(TANKC, 0.6),
             width=2)
    m.d.rectangle([tu(2.45) - 6, 360, tu(2.45) + 6, 376], fill=BLACKISH)
    m.o.rectangle([tu(2.45) - 6, 360, tu(2.45) + 6, 376],
                  fill=(AO_DEEP, R_STEEL, M_STEEL))
    wear_edges(m, (x0, y0, x1, y1), TANKC, 50)

    # end caps: dished head, flange bolt ring
    zone = T.TANK_CAP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(TANKC, 0.94), ao=AO_BASE - 6,
         rough=155, metal=110)
    cu = zone.uv((0, T.TANK_CY, 0))
    cx, cy = cu[0] * W, cu[1] * W
    rr = abs(zone.uv((0.8, T.TANK_CY, 0))[0] * W - cx)
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                outline=shade(TANKC, 0.65), width=3)
    for i in range(12):
        a = 2 * np.pi * i / 12
        bolts(m, [(cx + np.cos(a) * (rr - 7), cy + np.sin(a) * (rr - 7))],
              r=2, base=STEEL)
    m.d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=STEEL_DK)


# ── rear valve cabinet ──────────────────────────────────────────────────

def paint_valves(m):
    zone = T.VALVEZ
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 6, rough=175,
         metal=90)

    def u(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # three valve wheels over outlet stubs
    for wx in (-0.5, 0.0, 0.5):
        cx, cy = u(wx), v(1.1)
        m.d.ellipse([cx - 13, cy - 13, cx + 13, cy + 13],
                    outline=jit(YELLOW, 8), width=3)
        m.d.line([(cx - 11, cy), (cx + 11, cy)], fill=jit(YELLOW, 8), width=2)
        m.d.line([(cx, cy - 11), (cx, cy + 11)], fill=jit(YELLOW, 8), width=2)
        m.o.ellipse([cx - 13, cy - 13, cx + 13, cy + 13],
                    fill=(AO_SEAM, R_STEEL, M_STEEL))
        m.d.ellipse([cx - 8, v(0.72) - 8, cx + 8, v(0.72) + 8],
                    fill=BLACKISH)
        m.o.ellipse([cx - 8, v(0.72) - 8, cx + 8, v(0.72) + 8],
                    fill=(AO_DEEP, R_STEEL, M_STEEL))
    # taillight blocks (diffuse only — no emissive on this model)
    for wx in (0.88, -0.88):
        m.d.rectangle([u(wx) - 8, v(1.35), u(wx) + 8, v(1.22)],
                      fill=TAIL_RED)
    # hazard chevron strip along the cabinet bottom edge
    step = 12
    for i in range(int((x1 - x0) / step) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0 + i * step, v(0.55), x0 + (i + 1) * step, v(0.44)],
                      fill=c)
    bolts(m, [(x0 + 10 + i * (x1 - x0 - 20) / 5, y0 + 8) for i in range(6)],
          base=LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 30)


# ── flat cells ──────────────────────────────────────────────────────────

def paint_cells(m):
    fill(m, T.TRIMZ.rect, dif=(88, 90, 94), ao=AO_BASE - 8, rough=170,
         metal=120)
    fill(m, T.DARKZ.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)
    fill(m, T.WHEELZ.rect, dif=RUBBER, ao=AO_BASE - 14, rough=R_RUBBER,
         metal=10)
    fill(m, T.HUBZ.rect, dif=(120, 122, 126), ao=AO_BASE - 8, rough=140,
         metal=180)
    fill(m, T.SKIRT.rect, dif=LOWER, ao=AO_BASE - 10, rough=190, metal=60)
    # reel flanges: steel with painted spokes + rim
    x0, y0, x1, y1 = T.REELZ.rect
    fill(m, (x0, y0, x1, y1), dif=(110, 112, 116), ao=AO_BASE - 6,
         rough=145, metal=170)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([x0 + 6, y0 + 6, x1 - 6, y1 - 6],
                outline=shade((110, 112, 116), 0.7), width=4)
    for i in range(4):
        a = np.pi * i / 4 + np.pi / 8
        m.d.line([(cx - np.cos(a) * 52, cy - np.sin(a) * 52),
                  (cx + np.cos(a) * 52, cy + np.sin(a) * 52)],
                 fill=shade((110, 112, 116), 0.75), width=5)
    m.d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=STEEL_DK)
    # hose drum: coiled rubber
    x0, y0, x1, y1 = T.REEL_DRUM.rect
    fill(m, (x0, y0, x1, y1), dif=HOSE, ao=AO_BASE - 16, rough=205,
         metal=15)
    for gy in range(y0 + 6, y1 - 4, 10):
        m.d.line([(x0 + 3, gy), (x1 - 3, gy)], fill=shade(HOSE, 1.45),
                 width=2)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_cells(m)
    paint_cab(m)
    paint_tank(m)
    paint_valves(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=61)
    wx.crevice_grime(m.dif, 0.35)
    # mud: wheels, hubs, fender skirts, cab + tank lower bands
    wx.mud_band(T.WHEELZ.rect, 0.55, fade=None, spatter=True)
    wx.mud_band(T.HUBZ.rect, 0.3, fade=None, spatter=False)
    wx.mud_band(T.SKIRT.rect, 0.5, fade=None, spatter=True)
    cs = T.CAB_SIDE.rect
    wx.mud_band((cs[0], cs[3] - 30, cs[2], cs[3]), 0.4, spatter=True)
    cf = T.CAB_FRONT.rect
    wx.mud_band((cf[0], cf[3] - 26, cf[2], cf[3]), 0.45, spatter=True)
    tx0, _, tx1, _ = T.TANKW
    wx.mud_band((tx0, 344, tx1, 392), 0.3, fade=None, spatter=False)
    # fuel-drip stains (dark, shiny): below fillers, sump and valves
    rng = np.random.default_rng(90210)
    for hz in T.HATCH_Z:
        for dx in (-9, -2, 6):
            x = tu(hz) + dx
            wx.oily((x - 2, 256, x + 2, 256 + int(rng.uniform(36, 78))),
                    strength=0.65)
        wx.oily((tu(hz) - 24, 232, tu(hz) + 24, 262), strength=0.35)
    wx.oily((tu(2.45) - 8, 366, tu(2.45) + 8, 400), strength=0.7)
    vz = T.VALVEZ
    for wxx in (-0.5, 0.0, 0.5):
        x = vz.uv((wxx, 0, 0))[0] * W
        wx.oily((x - 4, vz.uv((0, 0.7, 0))[1] * W, x + 4, vz.rect[3] - 2),
                strength=0.6)
    # hazard-band lower-edge rust streaks (left flank rows run down-image)
    for (zh, zl) in T.HAZBANDS:
        for fx in np.linspace(0.15, 0.85, 4):
            x = tu(zh) + (tu(zl) - tu(zh)) * fx
            wx.rust_streak(x, 300, int(rng.uniform(14, 30)), width=2.0,
                           strength=0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(T), fraction=0.4)
    wx.plate_bottom_rust(T.SKIRT.rect, n=5, strength=0.5)
    wx.plate_bottom_rust(T.VALVEZ.rect, n=4, strength=0.45)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    for wz in T.WELD_Z + T.RING_Z:
        hm.line((tu(wz), 194), (tu(wz), 446), 0.4, width=2)
    for (zh, zl) in T.HAZBANDS:
        hm.line((tu(zh), 194), (tu(zh), 446), 0.25, width=2)
        hm.line((tu(zl), 194), (tu(zl), 446), 0.25, width=2)
    for lx in (tu(2.95), tu(2.72)):
        hm.line((lx, 230), (lx, 444), 0.5, width=2)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.0).save('out/ms_fuel_tanker_normals.png')

    m.dif.save('out/ms_fuel_tanker_diffuse.png')
    m.orm.save('out/ms_fuel_tanker_orm.png')
    m.emi.save('out/ms_fuel_tanker_emissive.png')
    m.tea.save('out/ms_fuel_tanker_team.png')
    print('[paint_ms_fuel_tanker] full texture set written to out/')


if __name__ == '__main__':
    paint_all()
