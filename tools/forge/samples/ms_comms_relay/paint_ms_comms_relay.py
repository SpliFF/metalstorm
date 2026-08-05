"""paint_ms_comms_relay — 1024² PBR set for ms_comms_relay.

Field-hardware read one size up from ms_radar_s1: weathered concrete
equipment pad with hazard corners + guy anchor plates, ARMOR-grey walk-in
shelter with door, vent grille, team stripe + status LEDs (diffuse only),
galvanised guyed mast, off-white twin link dishes with team wedges, and
an amber warning beacon — the ONLY emissive on the model, per spec.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_comms_relay_layout as L   # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 1024
CONCRETE = (146, 144, 138)
GALV = (166, 170, 175)
CABLE = (94, 98, 104)
DISHC = (214, 212, 205)
AMBER = (255, 176, 60)


def px(zone, wx, wy, wz):
    u, v = zone.uv((wx, wy, wz))
    return u * W, v * W


def paint_pad(m):
    z = L.R_PAD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 20, metal=0)
    for f in (0.25, 0.5, 0.75):
        m.d.line([(x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2)], fill=shade(CONCRETE, 0.86), width=2)
        m.d.line([(x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f)], fill=shade(CONCRETE, 0.86), width=2)
    # hazard corner wedges + anchor bolts
    cw = 56
    for cx, cy in ((x0, y0), (x1-cw, y0), (x0, y1-cw), (x1-cw, y1-cw)):
        for i in range(0, cw, 16):
            m.d.polygon([(cx+i, cy), (cx+i+8, cy), (cx, cy+i+8), (cx, cy+i)],
                        fill=YELLOW if (i//16) % 2 == 0 else BLACKISH)
    bolts(m, [(x0+24, y0+24), (x1-24, y0+24), (x0+24, y1-24), (x1-24, y1-24)],
          r=4, base=CONCRETE)
    # guy anchor plates (match gen_ms_comms_relay anchor maths)
    mx, mz = L.MAST_X, L.MAST_Z
    for a in (1.047, 3.142, 5.236):
        gx = min(max(mx + L.GUY_R * np.sin(a), -2.3), 2.3)
        gz = min(max(mz + L.GUY_R * np.cos(a), -2.3), 2.3)
        ax, ay = px(z, gx, 0, gz)
        m.d.rectangle([ax-16, ay-16, ax+16, ay+16], fill=STEEL)
        m.o.rectangle([ax-16, ay-16, ax+16, ay+16], fill=(AO_BASE-8, R_STEEL, M_STEEL))
        bolts(m, [(ax-9, ay-9), (ax+9, ay-9), (ax-9, ay+9), (ax+9, ay+9)],
              r=3, base=STEEL)
    fill(m, L.R_PADS.rect, dif=shade(CONCRETE, 0.9), ao=AO_BASE-10,
         rough=R_ARMOR + 20, metal=0)


def paint_cabinet(m):
    for zi, z in enumerate((L.R_CAB, L.R_CAB_F)):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
             metal=M_ARMOR)
        seam_h(m, x0+2, x1-2, y0 + (y1-y0)//4, ARMOR)
        if zi == 1:
            # personnel door on the -Z (front) face
            dx0, dy0, dx1, dy1 = x0 + 40, y0 + 60, x0 + 150, y1 - 12
            m.d.rectangle([dx0, dy0, dx1, dy1], fill=shade(ARMOR, 0.92),
                          outline=shade(ARMOR, 0.55), width=3)
            m.o.rectangle([dx0, dy0, dx1, dy1], fill=(AO_BASE - 14, R_ARMOR, M_ARMOR))
            m.d.rectangle([dx1-18, (dy0+dy1)//2 - 4, dx1-8, (dy0+dy1)//2 + 4],
                          fill=STEEL_DK)
            vent_slots(m, (x0 + 210, y1 - 90, x0 + 330, y1 - 30), 4)
        else:
            vent_slots(m, (x0 + 30, y1 - 90, x0 + (x1-x0)//2 - 10, y1 - 30), 4)
        # team stripe down the right edge
        m.d.rectangle([x1-26, y0+6, x1-8, y1-6], fill=TEAMGREY)
        m.t.rectangle([x1-26, y0+6, x1-8, y1-6], fill=(255, 0, 0))
        # status LEDs (diffuse only — the beacon is the model's sole emissive)
        for i, c in enumerate(((90, 230, 110), AMBER, (90, 230, 110))):
            lx = x0 + 34 + i*26
            m.d.ellipse([lx-6, y0+22, lx+6, y0+34], fill=c)
        bolts(m, [(x0+14, y0+14), (x1-38, y0+14), (x0+14, y1-14), (x1-38, y1-14)],
              base=ARMOR)
        wear_edges(m, z.rect, ARMOR, density=18)
    x0, y0, x1, y1 = L.R_CAB_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.94), ao=AO_BASE - 6,
         rough=R_ARMOR + 6, metal=M_ARMOR)
    seam_h(m, x0+2, x1-2, (y0+y1)//2, ARMOR)


def paint_details(m):
    fill(m, L.R_MAST, dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 10, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_MAST
    for gy in range(int(y0)+16, int(y1), 24):        # lattice hint banding
        m.d.line([(x0+2, gy), (x1-2, gy)], fill=shade(GALV, 0.88), width=2)
    fill(m, L.R_YOKE, dif=STEEL, ao=AO_BASE - 6, rough=R_STEEL, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_YOKE
    for gx in range(int(x0)+24, int(x1), 40):        # cross-arm rib banding
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(STEEL, 0.84), width=2)
    fill(m, L.R_TRIM, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL, metal=M_STEEL)
    fill(m, L.R_GUY, dif=CABLE, ao=AO_BASE - 10, rough=R_STEEL + 14, metal=M_STEEL - 40)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16, metal=M_ARMOR)
    # dish front: off-white, concentric ribs, team wedge, dark feed hub
    z = L.R_DISH
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DISHC, ao=AO_BASE, rough=R_ARMOR + 6, metal=M_ARMOR)
    cx, cy = (x0+x1)/2, (y0+y1)/2
    for f in (0.44, 0.3, 0.16):
        rr = (x1-x0) * f
        m.d.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], outline=shade(DISHC, 0.82), width=3)
    m.d.polygon([(cx, cy), (cx + (x1-x0)*0.44, cy - 40), (cx + (x1-x0)*0.44, cy + 40)],
                fill=TEAMGREY)
    m.t.polygon([(cx, cy), (cx + (x1-x0)*0.44, cy - 40), (cx + (x1-x0)*0.44, cy + 40)],
                fill=(255, 0, 0))
    m.d.ellipse([cx-10, cy-10, cx+10, cy+10], fill=STEEL_DK)
    m.o.ellipse([cx-10, cy-10, cx+10, cy+10], fill=(AO_DEEP, R_STEEL, M_STEEL))
    # dish back: darker ribbed shell
    z = L.R_DISH_B
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(DISHC, 0.72), ao=AO_BASE - 8,
         rough=R_ARMOR + 10, metal=M_ARMOR)
    cx, cy = (x0+x1)/2, (y0+y1)/2
    for f in (0.42, 0.26):
        rr = (x1-x0) * f
        m.d.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], outline=shade(DISHC, 0.6), width=4)
    # beacon zone: amber lens, emissive (the spec's amber beacon)
    z = L.R_LIGHT
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0+2, y0+2, x1-2, y1-2], fill=shade(AMBER, 0.8))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_cabinet(m)
    paint_details(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=47)
    wx.crevice_grime(m.dif, 0.35)
    wx.mud_band(L.R_PAD.rect, 0.3, fade=None, spatter=True)
    wx.mud_band(L.R_PADS.rect, 0.5, fade='down')
    for z in (L.R_CAB, L.R_CAB_F):
        wx.mud_band(z.rect, 0.4, fade='down', dust=0.3)
        wx.plate_bottom_rust(z.rect, n=5, strength=0.45)
    wx.rust_streak(L.R_DISH_B.rect[0] + 200, L.R_DISH_B.rect[1] + 60, 40,
                   width=2.5, strength=0.3)
    wx.rust_streak(L.R_MAST[0] + 60, L.R_MAST[1] + 20, 34,
                   width=2.0, strength=0.25)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.4)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    x0, y0, x1, y1 = L.R_PAD.rect
    for f in (0.25, 0.5, 0.75):
        hm.line((x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2), -0.5, width=2)
        hm.line((x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f), -0.5, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.0).save('out/ms_comms_relay_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.5))
    m.dif.save('out/ms_comms_relay_diffuse.png')
    m.orm.save('out/ms_comms_relay_orm.png')
    m.emi.save('out/ms_comms_relay_emissive.png')
    m.tea.save('out/ms_comms_relay_team.png')
    print('[paint_ms_comms_relay] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
