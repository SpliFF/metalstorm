"""paint_fighter — 2048² PBR set for fable_fighter (FA-6 Shrike).

Air-superiority scheme in the faction family: two-tone grey with a
darker radome and belly, team cheatline along the chine + fin tip
bands + wing roundels, FA-06 wing code, anti-glare nose panel, gold
canopy, intake-lip warning ring, live-round banded AA missiles,
petal-seamed afterburner nozzles with heat discoloration and glow,
red/green wingtip nav beacons, formation light strips.  Weathering:
panel-line wash, exhaust and gun-gas soot, gear-bay oil streaks,
leading-edge wear.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import fighter_layout as L         # sets meshlib.ATLAS = 2048
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
AIR   = (117, 120, 126)         # topside air-superiority grey
AIR_B = (97, 100, 106)          # underside
RADOME = (96, 92, 94)
DKST  = (56, 59, 64)
GOLD  = (146, 124, 72)          # canopy tint
RED   = (255, 62, 40)
GREEN = (60, 220, 90)
FORM  = (70, 150, 100)          # formation light strips

STATIONS = [z for (z, *_ ) in L.FUS_SECTIONS[1:-1]]


def paint_side(m):
    zone = L.F_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=AIR, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    # frame stations + extra panel verticals + stringers
    for wz in STATIONS:
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, AIR, hi=False)
    for wz in np.arange(-5.4, 7.0, 1.1):
        m.d.line([(u(wz), py(2.35)), (u(wz), py(0.9))], fill=shade(AIR, 0.92))
    for wy in (1.15, 1.95):
        seam_h(m, int(u(-6.0)), int(u(7.2)), int(py(wy)), AIR, hi=False)
    # radome tone break
    m.d.rectangle([x0, y0, u(-6.15), y1], fill=RADOME)
    m.d.line([(u(-6.15), y0 + 2), (u(-6.15), y1 - 2)], fill=shade(RADOME, 0.7),
             width=2)
    # belly shade below the chine
    m.d.rectangle([x0, py(1.05), x1, y1], fill=shade(AIR, 0.86))
    # team cheatline along the chine (mirror-safe)
    m.t.rectangle([u(-6.1), py(1.66), u(7.4), py(1.5)], fill=(255, 0, 0))
    m.d.rectangle([u(-6.1), py(1.66), u(7.4), py(1.5)], fill=TEAMGREY)
    # intake lip warning ring + duct shadow band
    m.d.rectangle([u(-2.78), py(1.84), u(-2.56), py(0.98)], fill=jit(RED, 14))
    m.d.rectangle([u(-2.56), py(1.84), u(-2.36), py(0.98)],
                  fill=shade(AIR, 0.7))
    # gun port blast panel
    m.d.rectangle([u(-5.75), py(1.45), u(-4.55), py(1.1)],
                  fill=shade(RADOME, 0.85))
    m.d.ellipse([u(-5.42) - 7, py(1.28) - 7, u(-5.42) + 7, py(1.28) + 7],
                fill=(22, 22, 24))
    # access panels + fasteners
    for (wz, wy0_, wy1_) in ((-4.2, 1.5, 1.15), (-0.2, 2.2, 1.95),
                             (3.1, 1.35, 1.05), (5.4, 1.9, 1.6)):
        m.d.rectangle([u(wz), py(wy0_), u(wz + 0.9), py(wy1_)],
                      fill=jit(shade(AIR, 0.95), 3), outline=shade(AIR, 0.8))
    bolts(m, [(u(wz), py(2.28)) for wz in (-3.6, -1.6, 0.4, 2.4, 4.4)],
          base=AIR)
    # formation light strips (emissive)
    for (wz0, wz1) in ((-6.0, -5.0), (2.2, 4.6)):
        m.d.rectangle([u(wz0), py(1.42), u(wz1), py(1.34)], fill=(40, 60, 50))
        m.e.rectangle([u(wz0) + 2, py(1.415), u(wz1) - 2, py(1.345)],
                      fill=FORM)
    # canopy sill anti-glare
    m.d.rectangle([u(-4.6), py(2.5), u(-1.85), py(2.32)], fill=(38, 40, 43))
    wear_edges(m, (x0, y0, x1, int(py(0.8))), AIR, 45)


def paint_top(m):
    zone = L.F_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(AIR, 1.05), ao=AO_BASE,
         rough=R_ARMOR, metal=M_ARMOR)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vx(wx):
        return zone.uv((wx, 0, 0))[1] * W

    # radome tone break wraps over the nose
    m.d.rectangle([x0, vx(-0.75), u(-6.15), vx(0.75)], fill=RADOME)
    for wz in STATIONS:
        seam_v(m, int(u(wz)), int(vx(-6.2)), int(vx(6.2)), AIR, hi=False)
    # spanwise wing panel seams
    for wx_ in (-4.9, -3.4, -1.9, 1.9, 3.4, 4.9):
        m.d.line([(u(0.0), vx(wx_)), (u(4.2), vx(wx_))], fill=shade(AIR, 0.92))
    # anti-glare nose panel
    m.d.polygon([(u(-6.6), vx(-0.28)), (u(-4.4), vx(-0.5)), (u(-4.4), vx(0.5)),
                 (u(-6.6), vx(0.28))], fill=(36, 38, 41))
    # nose team chevron
    m.t.polygon([(u(-5.6), vx(-0.9)), (u(-5.0), vx(0)), (u(-5.6), vx(0.9)),
                 (u(-5.15), vx(0.9)), (u(-4.55), vx(0)), (u(-5.15), vx(-0.9))],
                fill=(255, 0, 0))
    m.d.polygon([(u(-5.6), vx(-0.9)), (u(-5.0), vx(0)), (u(-5.6), vx(0.9)),
                 (u(-5.15), vx(0.9)), (u(-4.55), vx(0)), (u(-5.15), vx(-0.9))],
                fill=TEAMGREY)
    # leading-edge bright wear line + wing fences at the crank
    for s in (1, -1):
        m.d.line([(u(-0.85), vx(s * 0.75)), (u(0.4), vx(s * 2.4))],
                 fill=(150, 153, 158), width=2)
        m.d.line([(u(0.4), vx(s * 2.4)), (u(2.6), vx(s * 5.9))],
                 fill=(150, 153, 158), width=2)
        m.d.line([(u(0.45), vx(s * 2.4)), (u(4.1), vx(s * 2.4))],
                 fill=shade(AIR, 0.8), width=2)
        # elevon hinge + spanwise walkway line at the root
        m.d.line([(u(3.55), vx(s * 1.0)), (u(3.45), vx(s * 5.85))],
                 fill=shade(AIR, 0.72), width=2)
        m.d.line([(u(-0.5), vx(s * 0.85)), (u(4.25), vx(s * 0.85))],
                 fill=jit(YELLOW, 12), width=2)
        # stab hinge
        m.d.line([(u(6.6), vx(s * 0.8)), (u(6.85), vx(s * 3.0))],
                 fill=shade(AIR, 0.72), width=2)
        # wingtip team band
        bv0, bv1 = sorted((vx(s * 5.95 - 0.28), vx(s * 5.95 + 0.28)))
        m.t.rectangle([u(2.6), bv0, u(3.95), bv1], fill=(255, 0, 0))
        m.d.rectangle([u(2.6), bv0, u(3.95), bv1], fill=TEAMGREY)
    # roundels inboard-forward (clear of the code band + elevon hinge)
    for s in (1, -1):
        rcx, rcy = u(1.6), vx(s * 2.9)
        rx, ry = 0.62 * 128, 0.62 * 60
        m.d.ellipse([rcx - rx, rcy - ry, rcx + rx, rcy + ry],
                    fill=(205, 208, 212))
        m.t.ellipse([rcx - rx * 0.6, rcy - ry * 0.6, rcx + rx * 0.6,
                     rcy + ry * 0.6], fill=(255, 0, 0))
        m.d.ellipse([rcx - rx * 0.6, rcy - ry * 0.6, rcx + rx * 0.6,
                     rcy + ry * 0.6], fill=TEAMGREY)
    # FA-06 code on the starboard wing, reading spanwise, aft of the roundel
    f = font(46)
    timg = Image.new('RGBA', (160, 56), (0, 0, 0, 0))
    td = ImageDraw.Draw(timg)
    td.text((2, 2), 'FA-06', font=f, fill=(210, 213, 217, 255))
    timg = timg.rotate(-90, expand=True)
    m.dif.paste(timg, (int(u(3.0)) - 28, int(vx(-5.4))), timg)
    # spine walkway + NO STEP marks
    for s in (1, -1):
        m.d.line([(u(-1.5), vx(s * 0.62)), (u(4.6), vx(s * 0.62))],
                 fill=shade(AIR, 0.85), width=2)
    fs = font(16)
    for wz in (0.6, 2.8):
        m.d.text((u(wz), vx(1.15)), 'NO STEP', font=fs,
                 fill=shade(AIR, 0.65))
        m.d.text((u(wz), vx(-1.45)), 'NO STEP', font=fs,
                 fill=shade(AIR, 0.65))
    wear_edges(m, (int(u(-1.0)), int(vx(-6.2)), int(u(4.3)), int(vx(6.2))),
               AIR, 60)


def paint_bottom(m):
    zone = L.F_BOT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=AIR_B, ao=AO_BASE - 8, rough=R_ARMOR + 10,
         metal=M_ARMOR - 20)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vb(wx):
        return zone.uv((wx, 0, 0))[1] * W

    m.d.rectangle([x0, vb(-0.75), u(-6.15), vb(0.75)], fill=shade(RADOME, 0.9))
    for wz in STATIONS:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, AIR_B, hi=False)
    # gear doors with red edge stripes
    for (z0, z1, wx0, wx1) in ((-5.3, -4.15, -0.3, 0.3),
                               (2.25, 3.3, 0.62, 1.5), (2.25, 3.3, -1.5, -0.62)):
        m.d.rectangle([u(z0), vb(wx0), u(z1), vb(wx1)],
                      fill=shade(AIR_B, 0.94), outline=jit(RED, 20), width=2)
        seam_v(m, int(u((z0 + z1) / 2)), int(vb(wx0)) + 2, int(vb(wx1)) - 2,
               AIR_B, hi=False)
    # chaff dispenser grid
    for i in range(4):
        for j in range(2):
            m.d.rectangle([u(4.98 + i * 0.12), vb(-0.28 + j * 0.3),
                           u(5.06 + i * 0.12), vb(-0.08 + j * 0.3)],
                          fill=(30, 31, 34))
    # under-wing roundels
    for s in (1, -1):
        rcx, rcy = u(1.6), vb(s * 2.9)
        rx, ry = 0.62 * 128, 0.62 * 40
        m.d.ellipse([rcx - rx, rcy - ry, rcx + rx, rcy + ry],
                    fill=(185, 188, 192))
        m.t.ellipse([rcx - rx * 0.6, rcy - ry * 0.6, rcx + rx * 0.6,
                     rcy + ry * 0.6], fill=(255, 0, 0))
        m.d.ellipse([rcx - rx * 0.6, rcy - ry * 0.6, rcx + rx * 0.6,
                     rcy + ry * 0.6], fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), AIR_B, 40)


def paint_canopy_fin(m):
    # canopy: gold-tinted glass, frame bows, sill band
    zone = L.F_CANOPY
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=GOLD, ao=AO_BASE, rough=R_GLASS + 15,
         metal=M_GLASS)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([u(-4.3), v(2.95), u(-2.0), v(2.42)], fill=(66, 56, 30))
    for wz in (-4.32, -2.42):                     # frame bows
        m.d.rectangle([u(wz) - 5, y0 + 2, u(wz) + 5, v(2.3)], fill=DKST)
        m.o.rectangle([u(wz) - 5, y0 + 2, u(wz) + 5, v(2.3)],
                      fill=(AO_BASE - 5, R_ARMOR, M_ARMOR))
    m.d.rectangle([x0, v(2.38), x1, y1], fill=DKST)   # sill / deck band
    m.o.rectangle([x0, v(2.38), x1, y1], fill=(AO_BASE - 8, R_ARMOR, M_ARMOR))

    # fins: hinge, tip team band, diagonal stripes (no text — ±x shared)
    zone = L.F_FIN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(AIR, 0.98), ao=AO_BASE - 5,
         rough=R_ARMOR, metal=M_ARMOR)

    def uf(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vf(wy):
        return zone.uv((0, wy, 0))[1] * W

    m.d.line([(uf(6.55), int(vf(3.9))), (uf(6.35), y1 - 2)],
             fill=shade(AIR, 0.7), width=3)       # rudder hinge
    for wy in (2.6, 3.1):
        seam_h(m, x0 + 3, x1 - 3, int(vf(wy)), AIR, hi=False)
    m.t.rectangle([uf(6.0), vf(3.95), uf(7.5), vf(3.5)], fill=(255, 0, 0))
    m.d.rectangle([uf(6.0), vf(3.95), uf(7.5), vf(3.5)], fill=TEAMGREY)
    for i in range(3):
        zz = 5.35 + i * 0.35
        m.d.polygon([(uf(zz), vf(2.15)), (uf(zz + 0.16), vf(2.15)),
                     (uf(zz + 0.7), vf(3.35)), (uf(zz + 0.54), vf(3.35))],
                    fill=shade(AIR, 0.75))
    m.e.ellipse([uf(7.32) - 4, vf(3.42) - 4, uf(7.32) + 4, vf(3.42) + 4],
                fill=(235, 235, 240))             # tail position light
    wear_edges(m, (x0, y0, x1, y1), AIR, 35)


def paint_stores(m):
    # missiles: pale body, live-round bands, dark seeker
    x0, y0, x1, y1 = L.F_MISSILE
    fill(m, (x0, y0, x1, y1), dif=(168, 170, 174), ao=AO_BASE - 4,
         rough=140, metal=120)
    m.d.rectangle([x1 - 30, y0, x1, y1], fill=(30, 30, 34))     # seeker
    m.d.rectangle([x1 - 60, y0, x1 - 46, y1], fill=jit(YELLOW, 8))
    m.d.rectangle([x0 + 40, y0, x0 + 52, y1], fill=(120, 80, 50))
    for fx in (0.35, 0.6):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, (168, 170, 174),
               hi=False)
    # nozzles: petal seams + heat discoloration toward the lip (u0 = aft)
    x0, y0, x1, y1 = L.F_NOZZLE
    fill(m, (x0, y0, x1, y1), dif=(64, 60, 57), ao=AO_BASE - 12, rough=120,
         metal=215)
    for i in range(10):                            # petal seams (around = v)
        vy = y0 + (y1 - y0) * i / 10
        m.d.line([(x0, vy), (x1, vy)], fill=(44, 42, 40), width=2)
    heat = Image.new('RGB', (110, y1 - y0), (96, 68, 88))
    grad = Image.new('L', (110, 1), 0)
    for gx in range(110):
        grad.putpixel((gx, 0), int(110 * (1 - gx / 109) ** 1.6))
    m.dif.paste(heat, (x0, y0), grad.resize((110, y1 - y0)))
    seam_v(m, x0 + 130, y0 + 2, y1 - 2, (64, 60, 57), hi=False)
    # burner cell: glowing core
    zone = L.F_BURNER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(30, 26, 24), ao=AO_DEEP, rough=180,
         metal=120)
    m.e.rectangle([x0, y0, x1, y1], fill=(190, 92, 30))
    # gear cell: oleo silver
    fill(m, L.F_GEAR.rect, dif=(148, 150, 154), ao=AO_BASE - 6, rough=110,
         metal=200)
    # trim + dark + nav cells
    fill(m, L.F_TRIM.rect, dif=DKST, ao=AO_BASE - 12, rough=160, metal=150)
    fill(m, L.F_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    for rect, col in ((L.F_NAVP.rect, RED), (L.F_NAVS.rect, GREEN)):
        fill(m, rect, dif=(30, 32, 35), ao=AO_BASE - 10, rough=120, metal=100)
        m.e.rectangle(list(rect), fill=col)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_side(m)
    paint_top(m)
    paint_bottom(m)
    paint_canopy_fin(m)
    paint_stores(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    from paint import enrich
    enrich(m)
    wx = Weather(seed=59)
    wx.crevice_grime(m.dif, 0.35)
    zone = L.F_SIDE

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    # exhaust soot along the aft flanks + gun-gas stain
    wx.soot_patch((int(u(6.2)), int(py(2.0)), int(u(8.15)), int(py(1.0))),
                  0.55, fade='right')
    wx.soot_patch((int(u(-5.55)), int(py(1.5)), int(u(-4.0)), int(py(1.05))),
                  0.5, fade='right')
    # top spine soot behind the canopy + wing root scuffs
    tz = L.F_TOP
    wx.soot_patch((int(tz.uv((0, 0, 6.4))[0] * W), int(tz.uv((-1.2, 0, 0))[1] * W),
                   int(tz.uv((0, 0, 8.15))[0] * W), int(tz.uv((1.2, 0, 0))[1] * W)),
                  0.45, fade='right')
    wx.mud_band((int(tz.uv((0, 0, -0.5))[0] * W), int(tz.uv((-1.6, 0, 0))[1] * W),
                 int(tz.uv((0, 0, 4.3))[0] * W), int(tz.uv((1.6, 0, 0))[1] * W)),
                0.2, fade=None, spatter=False)
    # belly: oily trails aft of the gear doors + general grime
    bz = L.F_BOT
    for (wz, wx_) in ((-4.1, 0.0), (3.35, 1.05), (3.35, -1.05)):
        wx.soot_patch((int(bz.uv((0, 0, wz))[0] * W),
                       int(bz.uv((wx_ - 0.35, 0, 0))[1] * W),
                       int(bz.uv((0, 0, wz + 2.2))[0] * W),
                       int(bz.uv((wx_ + 0.35, 0, 0))[1] * W)),
                      0.35, fade='right')
    wx.mud_band(L.F_BOT.rect, 0.3, fade=None, spatter=True)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.35)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for zr in (L.F_SIDE, L.F_TOP, L.F_BOT):
        rx0, ry0, rx1, ry1 = zr.rect
        for wz in STATIONS:
            uu = zr.uv((0, 0, wz))[0] * W
            hm.line((uu, ry0 + 2), (uu, ry1 - 2), -0.35, width=2)
    tz = L.F_TOP
    for s in (1, -1):
        hm.line((tz.uv((0, 0, 3.55))[0] * W, tz.uv((s * 1.0, 0, 0))[1] * W),
                (tz.uv((0, 0, 3.45))[0] * W, tz.uv((s * 5.85, 0, 0))[1] * W),
                -0.4, width=2)
    cz = L.F_CANOPY
    for wz in (-4.32, -2.42):
        uu = cz.uv((0, 0, wz))[0] * W
        hm.line((uu, cz.rect[1] + 2), (uu, cz.uv((0, 2.3, 0))[1] * W), 0.45,
                width=4)
    hm.crevices_from(m.dif, 0.45)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.0).save('out/fable_fighter_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_fighter_diffuse.png')
    m.orm.save('out/fable_fighter_orm.png')
    m.emi.save('out/fable_fighter_emissive.png')
    m.tea.save('out/fable_fighter_team.png')
    print('[paint_fighter] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
