"""paint_bomber — 2048² PBR set for fable_bomber (FB-9 Petrel).

Strike scheme in the faction family: darker two-tone than the fighter
with an angular splinter camo across the topside (mirror-safe
polygons), dark radome + anti-glare, wide 3-bow canopy, team cheatline
+ fin tips + wing roundels, FB-09 wing code, belly bomb-bay doors with
red ARM outline, live yellow-banded bombs, over-tail nozzles with heat
tint + burner glow, nav beacons, formation strips.  Weathering: panel
wash, over-tail exhaust soot, bay-seam grime, gear oil, LE wear.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import bomber_layout as L          # sets meshlib.ATLAS = 2048
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
AIR   = (104, 108, 114)         # bomber topside (darker than fighter)
AIR2  = (88, 92, 99)            # splinter tone
AIR_B = (86, 89, 95)            # underside
RADOME = (92, 88, 90)
DKST  = (54, 57, 62)
GOLD  = (140, 118, 68)
RED   = (255, 62, 40)
REDL  = (196, 60, 46)
GREEN = (60, 220, 90)
FORM  = (70, 150, 100)

STATIONS = [z for (z, *_ ) in L.FUS_SECTIONS[1:-1]]


def paint_side(m):
    zone = L.B_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=AIR, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    for wz in STATIONS:
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, AIR, hi=False)
    for wz in np.arange(-3.8, 5.4, 0.9):
        m.d.line([(u(wz), py(2.2)), (u(wz), py(0.9))], fill=shade(AIR, 0.92))
    seam_h(m, int(u(-4.6)), int(u(5.6)), int(py(1.42)), AIR, hi=False)
    # splinter camo wedges reaching down the flank
    for (za, zb, yl) in ((-3.6, -1.4, 1.6), (0.2, 2.6, 1.5), (3.4, 5.2, 1.7)):
        m.d.polygon([(u(za), y0), (u(zb), y0), (u((za + zb) / 2), py(yl))],
                    fill=AIR2)
    # radome + belly shade
    m.d.rectangle([x0, y0, u(-4.55), y1], fill=RADOME)
    m.d.rectangle([x0, py(0.95), x1, y1], fill=shade(AIR, 0.85))
    # team cheatline
    m.t.rectangle([u(-4.5), py(1.62), u(5.7), py(1.48)], fill=(255, 0, 0))
    m.d.rectangle([u(-4.5), py(1.62), u(5.7), py(1.48)], fill=TEAMGREY)
    # access panels + formation strips
    for (wz, wy0_, wy1_) in ((-2.6, 1.35, 1.05), (1.4, 2.1, 1.85),
                             (3.8, 1.3, 1.05)):
        m.d.rectangle([u(wz), py(wy0_), u(wz + 0.8), py(wy1_)],
                      fill=jit(shade(AIR, 0.95), 3), outline=shade(AIR, 0.8))
    for (wz0, wz1) in ((-4.4, -3.6), (2.8, 4.4)):
        m.d.rectangle([u(wz0), py(1.28), u(wz1), py(1.21)], fill=(40, 60, 50))
        m.e.rectangle([u(wz0) + 2, py(1.275), u(wz1) - 2, py(1.215)],
                      fill=FORM)
    m.d.rectangle([u(-4.2), py(2.36), u(-1.95), py(2.2)], fill=(38, 40, 43))
    bolts(m, [(u(wz), py(2.2)) for wz in (-2.8, -0.8, 1.2, 3.2)], base=AIR)
    wear_edges(m, (x0, y0, x1, int(py(0.8))), AIR, 40)


def paint_top(m):
    zone = L.B_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(AIR, 1.04), ao=AO_BASE,
         rough=R_ARMOR, metal=M_ARMOR)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vx(wx):
        return zone.uv((wx, 0, 0))[1] * W

    # splinter camo (mirror-safe angular polys)
    for (pa, pb, pc, pd) in (
        ((-4.5, -1.0), (-2.0, -4.2), (0.6, -2.0), (-1.8, 0.8)),
        ((0.2, 2.2), (2.4, 0.4), (4.6, 3.2), (2.2, 4.6)),
        ((-1.0, -2.4), (1.4, -5.6), (3.4, -3.2), (1.0, -1.4)),
        ((-4.8, 2.2), (-2.6, 1.2), (-1.2, 3.8), (-3.6, 4.4)),
    ):
        m.d.polygon([(u(pa[0]), vx(pa[1])), (u(pb[0]), vx(pb[1])),
                     (u(pc[0]), vx(pc[1])), (u(pd[0]), vx(pd[1]))],
                    fill=jit(AIR2, 3))
    # radome + anti-glare
    m.d.rectangle([x0, vx(-0.9), u(-4.55), vx(0.9)], fill=RADOME)
    m.d.polygon([(u(-5.5), vx(-0.3)), (u(-4.1), vx(-0.55)),
                 (u(-4.1), vx(0.55)), (u(-5.5), vx(0.3))], fill=(36, 38, 41))
    for wz in STATIONS:
        seam_v(m, int(u(wz)), int(vx(-6.2)), int(vx(6.2)), AIR, hi=False)
    for wx_ in (-4.6, -3.0, 3.0, 4.6):
        m.d.line([(u(0.6), vx(wx_)), (u(4.4), vx(wx_))], fill=shade(AIR, 0.9))
    # nose team chevron
    m.t.polygon([(u(-4.3), vx(-1.0)), (u(-3.7), vx(0)), (u(-4.3), vx(1.0)),
                 (u(-3.9), vx(1.0)), (u(-3.3), vx(0)), (u(-3.9), vx(-1.0))],
                fill=(255, 0, 0))
    m.d.polygon([(u(-4.3), vx(-1.0)), (u(-3.7), vx(0)), (u(-4.3), vx(1.0)),
                 (u(-3.9), vx(1.0)), (u(-3.3), vx(0)), (u(-3.9), vx(-1.0))],
                fill=TEAMGREY)
    for s in (1, -1):
        # LE wear + elevon hinge + walkway
        m.d.line([(u(-1.45), vx(s * 1.3)), (u(2.35), vx(s * 5.95))],
                 fill=(148, 151, 156), width=2)
        m.d.line([(u(3.85), vx(s * 1.4)), (u(3.75), vx(s * 5.9))],
                 fill=shade(AIR, 0.72), width=2)
        m.d.line([(u(-1.0), vx(s * 1.35)), (u(4.5), vx(s * 1.35))],
                 fill=jit(YELLOW, 12), width=2)
        # wingtip team band
        bv0, bv1 = sorted((vx(s * 5.95 - 0.26), vx(s * 5.95 + 0.26)))
        m.t.rectangle([u(2.45), bv0, u(3.9), bv1], fill=(255, 0, 0))
        m.d.rectangle([u(2.45), bv0, u(3.9), bv1], fill=TEAMGREY)
        # intake lip warning on the dorsal humps
        iv0, iv1 = sorted((vx(s * 0.6), vx(s * 1.32)))
        m.d.rectangle([u(-1.9), iv0, u(-1.72), iv1],
                      fill=jit((196, 60, 46), 12))
    # roundels + code
    for s in (1, -1):
        rcx, rcy = u(1.2), vx(s * 3.1)
        rx, ry = 0.6 * 168, 0.6 * 55
        m.d.ellipse([rcx - rx, rcy - ry, rcx + rx, rcy + ry],
                    fill=(203, 206, 210))
        m.t.ellipse([rcx - rx * 0.6, rcy - ry * 0.6, rcx + rx * 0.6,
                     rcy + ry * 0.6], fill=(255, 0, 0))
        m.d.ellipse([rcx - rx * 0.6, rcy - ry * 0.6, rcx + rx * 0.6,
                     rcy + ry * 0.6], fill=TEAMGREY)
    f = font(44)
    timg = Image.new('RGBA', (150, 54), (0, 0, 0, 0))
    td = ImageDraw.Draw(timg)
    td.text((2, 2), 'FB-09', font=f, fill=(206, 209, 213, 255))
    timg = timg.rotate(-90, expand=True)
    m.dif.paste(timg, (int(u(2.6)) - 27, int(vx(-5.3))), timg)
    fs = font(15)
    for s in (1.55, -1.85):
        m.d.text((u(0.2), vx(s)), 'NO STEP', font=fs, fill=shade(AIR, 0.65))
    wear_edges(m, (int(u(-1.6)), int(vx(-6.2)), int(u(4.6)), int(vx(6.2))),
               AIR, 55)


def paint_bottom(m):
    zone = L.B_BOT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=AIR_B, ao=AO_BASE - 8, rough=R_ARMOR + 10,
         metal=M_ARMOR - 20)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vb(wx):
        return zone.uv((wx, 0, 0))[1] * W

    m.d.rectangle([x0, vb(-0.9), u(-4.55), vb(0.9)], fill=shade(RADOME, 0.9))
    for wz in STATIONS:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, AIR_B, hi=False)
    # bomb-bay doors: centre seam, hinge seams, red ARM outline
    bx, by, bz, bw, bh, bd = L.BAY
    m.d.rectangle([u(bz - bd / 2), vb(-bw / 2), u(bz + bd / 2), vb(bw / 2)],
                  fill=shade(AIR_B, 0.94), outline=jit(REDL, 14), width=3)
    m.d.line([(u(bz - bd / 2) + 3, vb(0)), (u(bz + bd / 2) - 3, vb(0))],
             fill=shade(AIR_B, 0.7), width=2)
    for wz in (bz - 1.4, bz + 1.4):
        m.d.line([(u(wz), vb(-bw / 2) + 3), (u(wz), vb(bw / 2) - 3)],
                 fill=shade(AIR_B, 0.8))
    # gear doors
    for (z0, z1, wx0, wx1) in ((-4.2, -3.1, -0.3, 0.3),
                               (1.45, 2.45, 0.95, 2.0),
                               (1.45, 2.45, -2.0, -0.95)):
        m.d.rectangle([u(z0), vb(wx0), u(z1), vb(wx1)],
                      fill=shade(AIR_B, 0.94), outline=jit(REDL, 20), width=2)
    # under-wing roundels
    for s in (1, -1):
        rcx, rcy = u(1.2), vb(s * 3.9)
        rx, ry = 0.6 * 168, 0.6 * 40
        m.d.ellipse([rcx - rx, rcy - ry, rcx + rx, rcy + ry],
                    fill=(180, 183, 187))
        m.t.ellipse([rcx - rx * 0.6, rcy - ry * 0.6, rcx + rx * 0.6,
                     rcy + ry * 0.6], fill=(255, 0, 0))
        m.d.ellipse([rcx - rx * 0.6, rcy - ry * 0.6, rcx + rx * 0.6,
                     rcy + ry * 0.6], fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), AIR_B, 35)


def paint_canopy_fin(m):
    zone = L.B_CANOPY
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=GOLD, ao=AO_BASE, rough=R_GLASS + 15,
         metal=M_GLASS)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([u(-3.9), v(2.75), u(-2.3), v(2.25)], fill=(64, 54, 28))
    for wz in (-4.05, -3.1, -2.25):                # three frame bows
        m.d.rectangle([u(wz) - 5, y0 + 2, u(wz) + 5, v(2.1)], fill=DKST)
        m.o.rectangle([u(wz) - 5, y0 + 2, u(wz) + 5, v(2.1)],
                      fill=(AO_BASE - 5, R_ARMOR, M_ARMOR))
    m.d.rectangle([x0, v(2.16), x1, y1], fill=DKST)
    m.o.rectangle([x0, v(2.16), x1, y1], fill=(AO_BASE - 8, R_ARMOR, M_ARMOR))

    zone = L.B_FIN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(AIR, 0.98), ao=AO_BASE - 5,
         rough=R_ARMOR, metal=M_ARMOR)

    def uf(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vf(wy):
        return zone.uv((0, wy, 0))[1] * W

    m.d.line([(uf(4.15), int(vf(2.95))), (uf(4.0), y1 - 2)],
             fill=shade(AIR, 0.7), width=3)
    seam_h(m, x0 + 3, x1 - 3, int(vf(2.1)), AIR, hi=False)
    m.t.rectangle([uf(3.35), vf(3.05), uf(4.75), vf(2.6)], fill=(255, 0, 0))
    m.d.rectangle([uf(3.35), vf(3.05), uf(4.75), vf(2.6)], fill=TEAMGREY)
    m.e.ellipse([uf(4.55) - 4, vf(2.52) - 4, uf(4.55) + 4, vf(2.52) + 4],
                fill=(235, 235, 240))
    wear_edges(m, (x0, y0, x1, y1), AIR, 30)


def paint_stores(m):
    # bombs: dark olive body, yellow live band, steel fins
    x0, y0, x1, y1 = L.B_BOMB
    fill(m, (x0, y0, x1, y1), dif=(84, 88, 70), ao=AO_BASE - 4, rough=150,
         metal=110)
    m.d.rectangle([x1 - 36, y0, x1, y1], fill=(34, 34, 38))      # fuze tip
    m.d.rectangle([x1 - 66, y0, x1 - 50, y1], fill=jit(YELLOW, 8))
    m.d.rectangle([x0 + 30, y0, x0 + 42, y1], fill=jit(YELLOW, 8))
    seam_v(m, int(x0 + (x1 - x0) * 0.5), y0 + 2, y1 - 2, (84, 88, 70),
           hi=False)
    # nozzles + burner + gear + trim + dark + nav (fighter grammar)
    x0, y0, x1, y1 = L.B_NOZZLE
    fill(m, (x0, y0, x1, y1), dif=(64, 60, 57), ao=AO_BASE - 12, rough=120,
         metal=215)
    for i in range(10):
        vy = y0 + (y1 - y0) * i / 10
        m.d.line([(x0, vy), (x1, vy)], fill=(44, 42, 40), width=2)
    heat = Image.new('RGB', (100, y1 - y0), (96, 68, 88))
    grad = Image.new('L', (100, 1), 0)
    for gx in range(100):
        grad.putpixel((gx, 0), int(105 * (1 - gx / 99) ** 1.6))
    m.dif.paste(heat, (x0, y0), grad.resize((100, y1 - y0)))
    zone = L.B_BURNER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(30, 26, 24), ao=AO_DEEP, rough=180,
         metal=120)
    m.e.rectangle([x0, y0, x1, y1], fill=(190, 92, 30))
    fill(m, L.B_GEAR.rect, dif=(148, 150, 154), ao=AO_BASE - 6, rough=110,
         metal=200)
    fill(m, L.B_TRIM.rect, dif=DKST, ao=AO_BASE - 12, rough=160, metal=150)
    fill(m, L.B_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    for rect, col in ((L.B_NAVP.rect, RED), (L.B_NAVS.rect, GREEN)):
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

    from weathering import Weather, vertical_rects_of
    from paint import enrich
    enrich(m)
    wx = Weather(seed=43)
    wx.crevice_grime(m.dif, 0.35)
    tz = L.B_TOP
    # over-tail exhaust soot streaks
    wx.soot_patch((int(tz.uv((0, 0, 4.7))[0] * W),
                   int(tz.uv((-1.4, 0, 0))[1] * W),
                   int(tz.uv((0, 0, 6.15))[0] * W),
                   int(tz.uv((1.4, 0, 0))[1] * W)), 0.6, fade='right')
    wx.mud_band((int(tz.uv((0, 0, -1.4))[0] * W),
                 int(tz.uv((-1.5, 0, 0))[1] * W),
                 int(tz.uv((0, 0, 4.4))[0] * W),
                 int(tz.uv((1.5, 0, 0))[1] * W)), 0.18, fade=None,
                spatter=False)
    bz = L.B_BOT
    # bay-seam grime + gear-door oil trails
    wx.oily((int(bz.uv((0, 0, -0.6))[0] * W), int(bz.uv((-0.9, 0, 0))[1] * W),
             int(bz.uv((0, 0, 3.4))[0] * W), int(bz.uv((0.9, 0, 0))[1] * W)),
            0.3)
    for (wz, wx_) in ((-3.0, 0.0), (2.5, 1.5), (2.5, -1.5)):
        wx.soot_patch((int(bz.uv((0, 0, wz))[0] * W),
                       int(bz.uv((wx_ - 0.35, 0, 0))[1] * W),
                       int(bz.uv((0, 0, wz + 1.8))[0] * W),
                       int(bz.uv((wx_ + 0.35, 0, 0))[1] * W)),
                      0.3, fade='right')
    wx.mud_band(L.B_BOT.rect, 0.28, fade=None, spatter=True)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.35)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    for zr in (L.B_SIDE, L.B_TOP, L.B_BOT):
        for wz in STATIONS:
            uu = zr.uv((0, 0, wz))[0] * W
            hm.line((uu, zr.rect[1] + 2), (uu, zr.rect[3] - 2), -0.35,
                    width=2)
    # bay door recess
    bx, by, bzz, bw, bh, bd = L.BAY
    hm.rect((bz.uv((0, 0, bzz - bd / 2))[0] * W,
             bz.uv((-bw / 2, 0, 0))[1] * W,
             bz.uv((0, 0, bzz + bd / 2))[0] * W,
             bz.uv((bw / 2, 0, 0))[1] * W), -0.4)
    cz = L.B_CANOPY
    for wz in (-4.05, -3.1, -2.25):
        uu = cz.uv((0, 0, wz))[0] * W
        hm.line((uu, cz.rect[1] + 2), (uu, cz.uv((0, 2.1, 0))[1] * W), 0.45,
                width=4)
    hm.crevices_from(m.dif, 0.45)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.0).save('out/fable_bomber_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_bomber_diffuse.png')
    m.orm.save('out/fable_bomber_orm.png')
    m.emi.save('out/fable_bomber_emissive.png')
    m.tea.save('out/fable_bomber_team.png')
    print('[paint_bomber] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
