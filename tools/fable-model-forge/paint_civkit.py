"""paint_civkit — shared 2048² PBR set for the civilian prop kit.

One texture set feeds five models.  Civilian palette: warm concrete,
light panel, muted teal, safety orange accents — deliberately apart
from the military grey-green.  Habitat window grid with scattered lit
rooms, transit glass curtain + striped canopy + TRANSIT sign, depot
corrugation + roller doors + crate/tank cells, bus and truck liveries
with glass bands and route glow.  Weathering: wall-base grime, window
streaks, depot roof rust, vehicle skirt mud.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import civkit_layout as L          # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_GLASS, M_ARMOR, M_GLASS, FONT, RNG)

W = 2048
CONC   = (156, 150, 140)
PANEL  = (176, 172, 162)
TEAL   = (96, 124, 126)
ORANGE = (176, 108, 58)
GLASS_D = (56, 66, 78)
LIT    = (255, 196, 128)
WHITE  = (208, 206, 200)
METAL  = (134, 138, 140)


def win_rect(m, x0, y0, x1, y1, lit):
    m.d.rectangle([x0, y0, x1, y1], fill=GLASS_D)
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE, R_GLASS, M_GLASS))
    if lit:
        m.e.rectangle([x0 + 1, y0 + 1, x1 - 1, y1 - 1],
                      fill=(int(LIT[0] * 0.9), int(LIT[1] * 0.9),
                            int(LIT[2] * 0.9)))
    m.d.rectangle([x0, y0, x1, y1], outline=shade(CONC, 0.7))


def paint_habitat(m):
    rng = np.random.default_rng(7)
    for zone, horiz in ((L.H_SIDE, 'z'), (L.H_FRONT, 'x')):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=CONC, ao=AO_BASE - 4,
             rough=R_ARMOR + 25, metal=30)

        def v(wy):
            return zone.uv((0, wy, 0))[1] * W

        # spandrel bands + ground floor + parapet
        for fy in range(7):
            m.d.rectangle([x0, v(2.6 + fy * 3.0), x1, v(2.0 + fy * 3.0)],
                          fill=shade(CONC, 0.92))
        m.d.rectangle([x0, v(2.4), x1, y1], fill=shade(CONC, 0.82))
        m.d.rectangle([x0, y0, x1, v(20.1)], fill=shade(CONC, 0.88))
        # teal service column strips
        for fx in (0.16, 0.62):
            m.d.rectangle([x0 + (x1 - x0) * fx, y0 + 4,
                           x0 + (x1 - x0) * fx + 26, y1 - 4],
                          fill=jit(TEAL, 4))
        # window grid, ~30% lit
        n_col = 16
        for fy in range(6):
            wy1, wy0 = 3.0 + fy * 3.0, 4.6 + fy * 3.0
            for c in range(n_col):
                wx0 = x0 + 14 + c * (x1 - x0 - 28) / n_col
                wx1 = wx0 + (x1 - x0 - 28) / n_col * 0.58
                win_rect(m, wx0, v(wy0), wx1, v(wy1),
                         lit=rng.random() < 0.3)
        # entrance
        mid = (x0 + x1) / 2
        m.d.rectangle([mid - 30, v(2.3), mid + 30, y1 - 2], fill=GLASS_D)
        m.e.rectangle([mid - 26, v(2.2), mid + 26, y1 - 4], fill=LIT)
        wear_edges(m, (x0, y0, x1, y1), CONC, 40)
    # roof
    x0, y0, x1, y1 = L.H_ROOF.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONC, 0.9), ao=AO_BASE - 6,
         rough=225, metal=20)
    for _ in range(40):
        px_, py_ = RNG.uniform(x0, x1 - 24), RNG.uniform(y0, y1 - 24)
        m.d.rectangle([px_, py_, px_ + RNG.uniform(8, 22),
                       py_ + RNG.uniform(8, 22)],
                      fill=jit(shade(CONC, RNG.uniform(0.82, 0.98)), 3))
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2],
                  outline=shade(CONC, 0.75), width=3)


def paint_transit(m):
    for zone in (L.T_SIDE, L.T_FRONT):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=PANEL, ao=AO_BASE - 4,
             rough=R_ARMOR + 15, metal=60)

        def v(wy):
            return zone.uv((0, wy, 0))[1] * W

        # glass curtain lower band with mullions + lit patches
        m.d.rectangle([x0 + 6, v(4.6), x1 - 6, v(0.6)], fill=GLASS_D)
        m.o.rectangle([x0 + 6, v(4.6), x1 - 6, v(0.6)],
                      fill=(AO_BASE, R_GLASS, M_GLASS))
        for i in range(14):
            gx = x0 + 6 + (x1 - x0 - 12) * i / 14
            m.d.rectangle([gx - 2, v(4.6), gx + 2, v(0.6)],
                          fill=shade(PANEL, 0.75))
        for i in (2, 5, 9, 11):
            gx0 = x0 + 6 + (x1 - x0 - 12) * i / 14 + 4
            gx1 = x0 + 6 + (x1 - x0 - 12) * (i + 1) / 14 - 4
            m.e.rectangle([gx0, v(4.3), gx1, v(0.9)], fill=(200, 150, 95))
        # teal fascia + dark plinth with a warning line
        m.d.rectangle([x0, v(6.2), x1, v(4.7)], fill=jit(TEAL, 3))
        m.d.rectangle([x0, v(0.55), x1, y1], fill=(52, 55, 58))
        m.d.rectangle([x0, v(0.55), x1, v(0.44)], fill=jit(YELLOW, 12))
        wear_edges(m, (x0, y0, x1, y1), PANEL, 30)
    # roof: pale with rib lines + skylight
    x0, y0, x1, y1 = L.T_ROOF.rect
    fill(m, (x0, y0, x1, y1), dif=shade(PANEL, 0.94), ao=AO_BASE - 5,
         rough=200, metal=90)
    for fy in np.linspace(0.08, 0.92, 9):
        m.d.line([(x0 + 3, y0 + (y1 - y0) * fy), (x1 - 3, y0 + (y1 - y0) * fy)],
                 fill=shade(PANEL, 0.8), width=2)
    m.d.rectangle([x0 + 30, (y0 + y1) / 2 - 16, x1 - 30, (y0 + y1) / 2 + 16],
                  fill=GLASS_D)
    m.e.rectangle([x0 + 34, (y0 + y1) / 2 - 12, x1 - 34, (y0 + y1) / 2 + 12],
                  fill=(140, 110, 70))
    # canopy: teal, white edge stripes, rib lines
    x0, y0, x1, y1 = L.T_CANOPY.rect
    fill(m, (x0, y0, x1, y1), dif=jit(TEAL, 3), ao=AO_BASE - 5, rough=190,
         metal=110)
    m.d.rectangle([x0, y0, x1, y0 + 14], fill=WHITE)
    m.d.rectangle([x0, y1 - 14, x1, y1], fill=WHITE)
    for fx in np.linspace(0.1, 0.9, 7):
        m.d.line([(x0 + (x1 - x0) * fx, y0 + 3), (x0 + (x1 - x0) * fx, y1 - 3)],
                 fill=shade(TEAL, 0.8), width=2)
    # sign: dark field + TRANSIT
    zone = L.T_SIGN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(30, 38, 52), ao=AO_BASE, rough=120,
         metal=90)
    f = ImageFont.truetype(FONT, 74)
    tw = m.d.textlength('TRANSIT', font=f)
    m.d.text(((x0 + x1) / 2 - tw / 2, (y0 + y1) / 2 - 40), 'TRANSIT',
             font=f, fill=(226, 230, 235))
    m.e.text(((x0 + x1) / 2 - tw / 2, (y0 + y1) / 2 - 40), 'TRANSIT',
             font=f, fill=(120, 130, 145))


def paint_depot(m):
    for zone in (L.D_SIDE, L.D_FRONT):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=METAL, ao=AO_BASE - 5, rough=170,
             metal=170)

        def v(wy):
            return zone.uv((0, wy, 0))[1] * W

        for gx in range(x0, x1, 12):                 # corrugation
            m.d.line([(gx, y0 + 2), (gx, v(0.4))], fill=shade(METAL, 0.9))
        m.d.rectangle([x0, v(0.9), x1, y1], fill=shade(METAL, 0.78))
        # teal wainscot band + eave trim
        m.d.rectangle([x0, v(2.6), x1, v(0.9)], fill=jit(TEAL, 4))
        m.d.rectangle([x0, y0, x1, v(7.9)], fill=shade(METAL, 0.85))
        if zone is L.D_FRONT:
            # three roller doors + person door (mirror-safe, no numbers)
            for fx in (0.24, 0.5, 0.76):
                dx0 = x0 + (x1 - x0) * fx - 62
                dx1 = dx0 + 124
                m.d.rectangle([dx0, v(5.4), dx1, v(0.35)],
                              fill=(150, 152, 150))
                for wy in np.arange(0.8, 5.4, 0.55):
                    m.d.line([(dx0 + 3, v(wy)), (dx1 - 3, v(wy))],
                             fill=(122, 124, 122))
                step = 12
                for i in range(int(124 / step) + 1):
                    c = YELLOW if i % 2 == 0 else BLACKISH
                    m.d.rectangle([dx0 + i * step, v(0.35),
                                   dx0 + (i + 1) * step, v(0.12)], fill=c)
            pd = x0 + (x1 - x0) * 0.08
            m.d.rectangle([pd, v(2.4), pd + 26, v(0.35)], fill=(70, 74, 78))
        wear_edges(m, (x0, y0, x1, y1), METAL, 40)
    # roof: ribbed metal + skylights
    x0, y0, x1, y1 = L.D_ROOF.rect
    fill(m, (x0, y0, x1, y1), dif=shade(METAL, 0.9), ao=AO_BASE - 6,
         rough=185, metal=160)
    for gx in range(x0, x1, 16):
        m.d.line([(gx, y0 + 2), (gx, y1 - 2)], fill=shade(METAL, 0.82))
    for fy in (0.3, 0.7):
        m.d.rectangle([x0 + 40, y0 + (y1 - y0) * fy - 10, x1 - 40,
                       y0 + (y1 - y0) * fy + 10], fill=(190, 195, 198))
    # crate cell + tank wrap
    x0, y0, x1, y1 = L.CRATE.rect
    fill(m, (x0, y0, x1, y1), dif=(150, 128, 92), ao=AO_BASE - 6,
         rough=210, metal=20)
    for fx in (0.25, 0.75):
        m.d.rectangle([x0 + (x1 - x0) * fx - 8, y0, x0 + (x1 - x0) * fx + 8,
                       y1], fill=(96, 82, 58))
    m.d.rectangle([x0 + 30, y0 + 30, x0 + 90, y0 + 78], fill=(205, 205, 200))
    m.d.rectangle([x0 + 4, y0 + 4, x1 - 4, y1 - 4],
                  outline=(96, 82, 58), width=3)
    x0, y0, x1, y1 = L.TANKW
    fill(m, (x0, y0, x1, y1), dif=(198, 198, 192), ao=AO_BASE - 5,
         rough=140, metal=120)
    m.d.rectangle([x0 + (x1 - x0) // 2 - 14, y0, x0 + (x1 - x0) // 2 + 14,
                   y1], fill=jit(ORANGE, 6))


def paint_vehicles(m):
    # ── bus ──
    zone = L.B_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WHITE, ao=AO_BASE - 3, rough=120,
         metal=140)

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    m.d.rectangle([x0, v(1.05), x1, y1], fill=jit(TEAL, 3))       # skirt
    m.d.rectangle([x0, v(1.25), x1, v(1.05)], fill=jit(ORANGE, 5))
    m.d.rectangle([u(-4.6), v(2.9), u(4.9), v(1.55)], fill=GLASS_D)
    m.o.rectangle([u(-4.6), v(2.9), u(4.9), v(1.55)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    for wz in np.arange(-3.6, 5.0, 1.1):                          # pillars
        m.d.rectangle([u(wz) - 2, v(2.9), u(wz) + 2, v(1.55)],
                      fill=shade(WHITE, 0.8))
    for i in (1, 4, 6):
        m.e.rectangle([u(-3.6 + i * 1.1) + 4, v(2.8), u(-2.5 + i * 1.1) - 4,
                       v(1.65)], fill=(170, 130, 85))
    # doors (front + mid)
    for wz in (-4.15, 0.6):
        m.d.rectangle([u(wz) - 16, v(2.95), u(wz) + 16, v(0.35)],
                      fill=shade(GLASS_D, 0.9), outline=shade(WHITE, 0.7),
                      width=2)
    wear_edges(m, (x0, y0, x1, y1), WHITE, 30)
    # bus front/rear + roof
    zone = L.B_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WHITE, ao=AO_BASE - 4, rough=120,
         metal=140)

    def vf(wy):
        return zone.uv((0, wy, 0))[1] * W

    m.d.rectangle([x0 + 10, vf(3.05), x1 - 10, vf(1.9)], fill=GLASS_D)
    m.o.rectangle([x0 + 10, vf(3.05), x1 - 10, vf(1.9)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.rectangle([x0 + 30, vf(3.5), x1 - 30, vf(3.15)], fill=(40, 44, 50))
    m.e.rectangle([x0 + 36, vf(3.45), x1 - 36, vf(3.2)], fill=(255, 170, 60))
    m.d.rectangle([x0, vf(1.0), x1, y1], fill=jit(TEAL, 3))
    for sx in (x0 + 26, x1 - 62):
        m.d.rectangle([sx, vf(1.5), sx + 36, vf(1.15)], fill=(220, 222, 218))
        m.e.rectangle([sx + 4, vf(1.45), sx + 32, vf(1.2)],
                      fill=(235, 235, 225))
    x0, y0, x1, y1 = L.B_ROOF.rect
    fill(m, (x0, y0, x1, y1), dif=shade(WHITE, 0.96), ao=AO_BASE - 4,
         rough=150, metal=120)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2, WHITE, hi=False)

    # ── truck ──
    zone = L.K_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WHITE, ao=AO_BASE - 3, rough=130,
         metal=130)

    def vk(wy):
        return zone.uv((0, wy, 0))[1] * W

    def uk(wz):
        return zone.uv((0, 0, wz))[0] * W

    # cab glass + door seam (cab occupies z -3.6..-1.9)
    m.d.rectangle([uk(-3.5), vk(2.65), uk(-2.0), vk(1.9)], fill=GLASS_D)
    m.o.rectangle([uk(-3.5), vk(2.65), uk(-2.0), vk(1.9)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.line([(uk(-2.6), vk(2.7)), (uk(-2.6), vk(0.9))],
             fill=shade(WHITE, 0.7), width=2)
    # box: corrugation + logo band (mirror-safe geometry)
    for gx in range(int(uk(-1.5)), int(uk(3.4)), 10):
        m.d.line([(gx, vk(3.3)), (gx, vk(1.0))], fill=shade(WHITE, 0.93))
    m.d.rectangle([uk(-1.2), vk(2.6), uk(3.1), vk(2.2)], fill=jit(TEAL, 3))
    m.d.ellipse([uk(0.4) - 26, vk(2.85) - 0, uk(0.4) + 26, vk(2.85) + 52],
                fill=jit(ORANGE, 6))
    m.d.rectangle([x0, vk(0.95), x1, y1], fill=shade(WHITE, 0.75))
    wear_edges(m, (x0, y0, x1, y1), WHITE, 30)
    zone = L.K_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=WHITE, ao=AO_BASE - 4, rough=130,
         metal=130)

    def vt(wy):
        return zone.uv((0, wy, 0))[1] * W

    m.d.rectangle([x0 + 12, vt(2.7), x1 - 12, vt(1.85)], fill=GLASS_D)
    m.o.rectangle([x0 + 12, vt(2.7), x1 - 12, vt(1.85)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.rectangle([x0 + 20, vt(1.3), x1 - 20, vt(0.9)], fill=(60, 64, 68))
    for sx in (x0 + 20, x1 - 52):
        m.d.rectangle([sx, vt(1.55), sx + 32, vt(1.32)], fill=(225, 225, 220))
        m.e.rectangle([sx + 4, vt(1.5), sx + 28, vt(1.35)],
                      fill=(235, 235, 225))
    x0, y0, x1, y1 = L.K_ROOF.rect
    fill(m, (x0, y0, x1, y1), dif=shade(WHITE, 0.96), ao=AO_BASE - 4,
         rough=150, metal=120)

    # wheels / hub / shared cells
    fill(m, L.WHEEL.rect, dif=(30, 30, 32), ao=AO_BASE - 14, rough=225,
         metal=10)
    fill(m, L.HUB.rect, dif=(120, 122, 126), ao=AO_BASE - 8, rough=140,
         metal=180)
    fill(m, L.TRIMC.rect, dif=(88, 90, 94), ao=AO_BASE - 8, rough=170,
         metal=120)
    fill(m, L.DARKC.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)
    x0, y0, x1, y1 = L.GLOWC.rect
    fill(m, (x0, y0, x1, y1), dif=(210, 205, 190), ao=AO_BASE, rough=90,
         metal=100)
    m.e.rectangle([x0, y0, x1, y1], fill=(240, 225, 190))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_habitat(m)
    paint_transit(m)
    paint_depot(m)
    paint_vehicles(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=61)
    wx.crevice_grime(m.dif, 0.3)
    for zone in (L.H_SIDE, L.H_FRONT, L.T_SIDE, L.T_FRONT, L.D_SIDE,
                 L.D_FRONT):
        x0, y0, x1, y1 = zone.rect
        wx.mud_band((x0, y1 - 22, x1, y1), 0.4, fade=None, spatter=False)
    # habitat window-sill streaks
    hz = L.H_SIDE
    for fx in np.linspace(0.08, 0.92, 12):
        wx.rust_streak(hz.rect[0] + (hz.rect[2] - hz.rect[0]) * fx,
                       hz.rect[1] + 60, 26, width=2.0, strength=0.18)
    # depot roof rust
    dz = L.D_ROOF.rect
    for fx in np.linspace(0.1, 0.9, 7):
        wx.rust_streak(dz[0] + (dz[2] - dz[0]) * fx, dz[1] + 12,
                       30 + int(fx * 20), width=3.0, strength=0.4)
    # vehicle skirt mud
    for zone in (L.B_SIDE, L.K_SIDE):
        x0, y0, x1, y1 = zone.rect
        wx.mud_band((x0, y1 - 22, x1, y1), 0.22, fade=None, spatter=True)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    for zone in (L.D_SIDE, L.D_FRONT):
        x0, y0, x1, y1 = zone.rect
        for gx in range(x0, x1, 12):
            hm.line((gx, y0 + 2), (gx, y1 - 40), 0.2, width=1)
    x0, y0, x1, y1 = L.T_CANOPY.rect
    for fx in np.linspace(0.1, 0.9, 7):
        hm.line((x0 + (x1 - x0) * fx, y0 + 3), (x0 + (x1 - x0) * fx, y1 - 3),
                0.3, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=3.8).save('out/fable_civkit_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_civkit_diffuse.png')
    m.orm.save('out/fable_civkit_orm.png')
    m.emi.save('out/fable_civkit_emissive.png')
    m.tea.save('out/fable_civkit_team.png')
    print('[paint_civkit] shared 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
