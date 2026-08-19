"""paint_train — shared 2048² PBR set for the land-train family.

Heavy-armour family language: big bolted plates over the shared hull
bands, darker skirts, firing-port rows with shutters on the carriage
band, hazard-striped coupler cell, cab vision slit with cyan glow,
running-light cells, inter-car end doors with ladders, engine deck
louvres, olive tarp/crate cargo cells, team flashes on hulls and
turret roofs.  Weathering: heavy skirt mud, port and bolt rust
streaks, stack soot, plow scrape.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import train_layout as L           # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, FONT, RNG)

W = 2048
SKIRT = tuple(int(c * 0.78) for c in ARMOR)
STEELD = (56, 54, 52)


def plate_band(m, zone, z_lo, z_hi, y_step, z_step, y_top, y_bot):
    """Bolted armour plates across a ('z','y') band."""
    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    for wz in np.arange(z_lo, z_hi, z_step):
        seam_v(m, int(u(wz)), int(v(y_top)), int(v(y_bot)), ARMOR, hi=False)
    for wy in np.arange(y_bot + y_step, y_top, y_step):
        seam_h(m, int(u(z_lo)), int(u(z_hi)), int(v(wy)), ARMOR, hi=False)
    pts = []
    for wz in np.arange(z_lo + 0.5, z_hi, z_step):
        for wy in (y_top - 0.25, y_bot + 0.25):
            pts.append((u(wz), v(wy)))
    bolts(m, pts, base=ARMOR)


def paint_hull_band(m, zone, hl, top, ports):
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 5, rough=R_ARMOR,
         metal=M_ARMOR)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    plate_band(m, zone, -hl + 0.4, hl - 0.3, 1.3, 2.6, top - 0.15, 2.55)
    # skirt band + segment seams + spall strip
    m.d.rectangle([x0, v(2.55), x1, y1], fill=SKIRT)
    for wz in np.arange(-hl + 1.2, hl, 2.0):
        seam_v(m, int(u(wz)), int(v(2.5)), int(v(0.6)), SKIRT, hi=False)
    m.d.rectangle([x0, v(2.62), x1, v(2.5)], fill=shade(ARMOR, 0.7))
    # team flash: angular band amidships
    m.t.polygon([(u(-2.6), v(top - 0.2)), (u(-0.6), v(top - 0.2)),
                 (u(0.6), v(2.7)), (u(-1.4), v(2.7))], fill=(255, 0, 0))
    m.d.polygon([(u(-2.6), v(top - 0.2)), (u(-0.6), v(top - 0.2)),
                 (u(0.6), v(2.7)), (u(-1.4), v(2.7))], fill=TEAMGREY)
    if ports:
        for wz in np.arange(-6.8, 7.0, 1.7):
            pu, pv0, pv1 = u(wz), v(L.PORT_Y + 0.16), v(L.PORT_Y - 0.16)
            m.d.rectangle([pu - 12, pv0 - 6, pu + 12, pv1 + 6],
                          fill=shade(ARMOR, 0.85))
            m.d.rectangle([pu - 7, pv0, pu + 7, pv1], fill=(16, 16, 18))
            m.d.rectangle([pu + 8, pv0 - 4, pu + 14, pv1 + 4],
                          fill=shade(ARMOR, 0.7))   # shutter hinge
            bolts(m, [(pu - 12, pv1 + 8), (pu + 12, pv1 + 8)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 70)


def paint_ends(m):
    # engine face: visor slit + plow chevrons + team diamond
    zone = L.E_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6)

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    for wy in (5.0, 3.6, 2.4):
        seam_h(m, x0 + 4, x1 - 4, int(v(wy)), ARMOR, hi=False)
    m.d.rectangle([x0 + 40, v(5.45), x1 - 40, v(5.1)], fill=(14, 16, 18))
    m.e.rectangle([x0 + 46, v(5.4), x1 - 46, v(5.15)], fill=(50, 180, 200))
    step = 26
    for i in range(int((x1 - x0) / step) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * step, v(0.6)), (x0 + (i + 1) * step, v(0.6)),
                     (x0 + (i + 1) * step - 14, v(2.3)),
                     (x0 + i * step - 14, v(2.3))], fill=c)
    cxm = (x0 + x1) / 2
    m.t.polygon([(cxm, v(4.9)), (cxm + 34, v(4.35)), (cxm, v(3.8)),
                 (cxm - 34, v(4.35))], fill=(255, 0, 0))
    m.d.polygon([(cxm, v(4.9)), (cxm + 34, v(4.35)), (cxm, v(3.8)),
                 (cxm - 34, v(4.35))], fill=TEAMGREY)
    bolts(m, [(x0 + 24, v(3.0)), (x1 - 24, v(3.0))], base=ARMOR)
    wear_edges(m, (x0, int(v(2.4)), x1, y1), ARMOR, 60)

    # carriage ends: armoured door + ladder + hazard frame
    zone = L.C_END
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 8)

    def vc(wy):
        return zone.uv((0, wy, 0))[1] * W

    for wy in (3.9, 2.6):
        seam_h(m, x0 + 4, x1 - 4, int(vc(wy)), ARMOR, hi=False)
    cxm = (x0 + x1) / 2
    m.d.rectangle([cxm - 30, vc(3.5), cxm + 30, vc(1.35)],
                  fill=shade(ARMOR, 0.82), outline=shade(ARMOR, 0.6),
                  width=3)
    m.d.ellipse([cxm + 12, vc(2.6) - 5, cxm + 22, vc(2.6) + 5],
                fill=(30, 30, 32))
    for wy in np.arange(1.5, 4.3, 0.4):                # ladder
        m.d.line([(cxm + 52, vc(wy)), (cxm + 72, vc(wy))],
                 fill=shade(ARMOR, 1.3), width=3)
    step = 22
    for i in range(int((x1 - x0) / step) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0 + i * step, vc(1.0), x0 + (i + 1) * step, vc(0.7)],
                      fill=c)
    bolts(m, [(x0 + 20, vc(4.3)), (x1 - 20, vc(4.3))], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 45)


def paint_tops(m):
    for zone, hl in ((L.E_TOP, 10.5), (L.C_TOP, 8.0)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.96), ao=AO_BASE - 4)

        def u(wz):
            return zone.uv((0, 0, wz))[0] * W

        for wz in np.arange(-hl + 1.0, hl, 2.4):
            seam_v(m, int(u(wz)), y0 + 3, y1 - 3, ARMOR, hi=False)
        # centre anti-slip walkway
        m.d.rectangle([x0 + 2, (y0 + y1) // 2 - 16, x1 - 2,
                       (y0 + y1) // 2 + 16], fill=shade(ARMOR, 0.8))
        for gx in range(x0 + 6, x1 - 6, 14):
            m.d.line([(gx, (y0 + y1) // 2 - 13), (gx + 7, (y0 + y1) // 2 + 13)],
                     fill=shade(ARMOR, 0.7))
        wear_edges(m, (x0, y0, x1, y1), ARMOR, 45)
    # engine deck louvres (drawn over E_TOP aft half)
    zone = L.E_TOP
    for wz in (1.0, 3.0, 5.0, 7.0):
        uu = zone.uv((0, 0, wz))[0] * W
        vent_slots(m, (int(uu), zone.rect[1] + 30, int(uu) + 34,
                       zone.rect[3] - 30), 4)

    # turret shells + cupolas + barrels + cells
    zone = L.TURZ
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2 - 14, ARMOR, hi=False)
    bolts(m, [(x0 + 16 + i * (x1 - x0 - 32) / 7, y1 - 16) for i in range(8)],
          base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 40)
    zone = L.TUR_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.98), ao=AO_BASE - 5)
    m.t.rectangle([x0 + 30, y0 + 30, x1 - 30, y0 + 70], fill=(255, 0, 0))
    m.d.rectangle([x0 + 30, y0 + 30, x1 - 30, y0 + 70], fill=TEAMGREY)
    m.d.ellipse([(x0 + x1) / 2 - 18, (y0 + y1) / 2 - 18,
                 (x0 + x1) / 2 + 18, (y0 + y1) / 2 + 18],
                fill=shade(ARMOR, 0.8))
    x0, y0, x1, y1 = L.BARRELW
    fill(m, (x0, y0, x1, y1), dif=STEELD, ao=AO_BASE - 10, rough=120,
         metal=210)
    m.d.rectangle([x0, y0, x0 + 60, y1], fill=(38, 36, 34))
    for fx in (0.4, 0.7):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, STEELD, hi=False)
    x0, y0, x1, y1 = L.CUPZ.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 1.03), ao=AO_BASE - 6)
    m.d.rectangle([x0 + 20, (y0 + y1) // 2 - 6, x1 - 20, (y0 + y1) // 2 + 6],
                  fill=(16, 16, 18))
    x0, y0, x1, y1 = L.CUPBW
    fill(m, (x0, y0, x1, y1), dif=STEELD, ao=AO_BASE - 10, rough=130,
         metal=200)
    # wheels / hubs / couplers / glow / trim / cargo
    fill(m, L.WHEELZ.rect, dif=(34, 34, 36), ao=AO_BASE - 14, rough=230,
         metal=10)
    fill(m, L.HUBZ.rect, dif=(96, 98, 102), ao=AO_BASE - 8, rough=150,
         metal=190)
    x0, y0, x1, y1 = L.COUPZ.rect
    fill(m, (x0, y0, x1, y1), dif=(64, 62, 58), ao=AO_BASE - 10, rough=170,
         metal=170)
    b0, b1 = y0 + 44, y1 - 44
    for i in range(-4, 12):
        m.d.polygon([(x0 + i * 24, b1), (x0 + i * 24 + 12, b1),
                     (x0 + i * 24 + 34, b0), (x0 + i * 24 + 22, b0)],
                    fill=(148, 128, 34) if i % 2 == 0 else (32, 32, 34))
    x0, y0, x1, y1 = L.GLOWZ.rect
    fill(m, (x0, y0, x1, y1), dif=(215, 210, 195), ao=AO_BASE, rough=90,
         metal=100)
    m.e.rectangle([x0, y0, x1, y1], fill=(240, 225, 185))
    fill(m, L.DARKT.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)
    fill(m, L.TRIMT.rect, dif=(58, 61, 66), ao=AO_BASE - 10, rough=170,
         metal=140)
    x0, y0, x1, y1 = L.CRATEZ.rect
    fill(m, (x0, y0, x1, y1), dif=(96, 100, 72), ao=AO_BASE - 6, rough=200,
         metal=30)
    m.d.rectangle([x0 + 20, (y0 + y1) // 2 - 10, x1 - 20, (y0 + y1) // 2 + 10],
                  fill=(70, 72, 52))
    x0, y0, x1, y1 = L.TARPZ.rect
    fill(m, (x0, y0, x1, y1), dif=(88, 92, 68), ao=AO_BASE - 5, rough=225,
         metal=10)
    for fx in np.linspace(0.15, 0.85, 5):              # lashing straps
        m.d.rectangle([x0 + (x1 - x0) * fx - 5, y0 + 4,
                       x0 + (x1 - x0) * fx + 5, y1 - 4], fill=(48, 46, 40))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull_band(m, L.E_SIDE, 10.5, L.ENG_TOP, ports=False)
    paint_hull_band(m, L.C_SIDE, 8.0, 4.35, ports=True)
    paint_ends(m)
    paint_tops(m)

    from weathering import Weather, vertical_rects_of
    from paint import enrich
    enrich(m)
    wx = Weather(seed=13)
    wx.crevice_grime(m.dif, 0.45)
    for zone, hl in ((L.E_SIDE, 10.5), (L.C_SIDE, 8.0)):
        x0, y0, x1, y1 = zone.rect
        wx.mud_band((x0, y1 - 60, x1, y1), 0.55, fade=None, spatter=True)
        for fx in np.linspace(0.06, 0.94, 9):
            wx.rust_streak(x0 + (x1 - x0) * fx, y0 + 40,
                           30 + int(fx * 20) % 25, width=2.6, strength=0.4)
    # stack soot on the engine deck + plow scrape
    ez = L.E_TOP
    wx.soot_patch((int(ez.uv((0, 0, 2.2))[0] * W), ez.rect[1] + 10,
                   int(ez.uv((0, 0, 9.5))[0] * W), ez.rect[3] - 10), 0.25,
                  fade='right')
    fz = L.E_FRONT.rect
    wx.mud_band((fz[0], fz[3] - 70, fz[2], fz[3]), 0.6, fade=None,
                spatter=True)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.6)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    for zone, hl, top in ((L.E_SIDE, 10.5, L.ENG_TOP), (L.C_SIDE, 8.0, 4.35)):
        for wz in np.arange(-hl + 0.4, hl, 2.6):
            uu = zone.uv((0, 0, wz))[0] * W
            hm.line((uu, zone.uv((0, top - 0.15, 0))[1] * W),
                    (uu, zone.uv((0, 2.55, 0))[1] * W), -0.35, width=2)
    cz = L.C_SIDE
    for wz in np.arange(-6.8, 7.0, 1.7):               # port recesses
        pu = cz.uv((0, 0, wz))[0] * W
        hm.rect((pu - 8, cz.uv((0, L.PORT_Y + 0.16, 0))[1] * W,
                 pu + 8, cz.uv((0, L.PORT_Y - 0.16, 0))[1] * W), -0.5)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.55)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.4).save('out/fable_train_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_train_diffuse.png')
    m.orm.save('out/fable_train_orm.png')
    m.emi.save('out/fable_train_emissive.png')
    m.tea.save('out/fable_train_team.png')
    print('[paint_train] shared 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
