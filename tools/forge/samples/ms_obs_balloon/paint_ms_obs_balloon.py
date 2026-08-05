"""paint_ms_obs_balloon — 2048² PBR set for ms_obs_balloon.

Doped-fabric envelope in a pale high-visibility tone (the intel tell —
reads against sky at extreme distance) with gore/ring seams, a bold
team nose band + flank roundel and team tail-fin panels; armoured
sensor gondola with camera ball; workhorse winch trailer below: tread
deck with hazard edging, equipment cabinet with vents/LEDs/team stripe,
galvanised A-frame, wound winch drum, rubber tires. Weathering: mud and
rust live on the trailer, the envelope only picks up dust films and
panel grime. Emissive: anti-collision beacon, cabinet LEDs, sensor eye.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_obs_balloon_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK, RUBBER,
                   GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
FABRIC   = (196, 190, 176)      # doped envelope fabric
FABRIC_B = shade(FABRIC, 0.76)  # belly
GALV     = (166, 170, 175)
AMBER    = (255, 176, 60)
BCN_RED  = (255, 76, 48)
CYAN_GLOW = (120, 235, 255)

RING_Z = [z for (z, _) in L.ENV_SECTIONS[1:-1]]   # gore ring stations
TEAM_Z = (-3.35, -2.45)                           # nose team band


def _env_common(m, zone, base):
    """Fabric fill + ring seams + longitudinal gore lines for one env zone."""
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE - 4, rough=R_ARMOR + 34,
         metal=6)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    for wz in RING_Z:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, base, hi=False)
    # sub-seams between stations
    for wz in (-2.7, -1.35, 0.2, 1.8, 3.25):
        m.d.line([(u(wz), y0 + 4), (u(wz), y1 - 4)], fill=shade(base, 0.93))
    # nose team band (the distance tell)
    m.d.rectangle([u(TEAM_Z[0]), y0, u(TEAM_Z[1]), y1], fill=TEAMGREY)
    m.t.rectangle([u(TEAM_Z[0]), y0, u(TEAM_Z[1]), y1], fill=(255, 0, 0))
    m.d.line([(u(TEAM_Z[0]), y0), (u(TEAM_Z[0]), y1)], fill=shade(base, 0.6),
             width=2)
    m.d.line([(u(TEAM_Z[1]), y0), (u(TEAM_Z[1]), y1)], fill=shade(base, 0.6),
             width=2)
    # patch repairs
    for _ in range(3):
        px = x0 + 200 + RNG.random() * (x1 - x0 - 420)
        py = y0 + 40 + RNG.random() * (y1 - y0 - 110)
        pw, ph = 46 + RNG.random() * 60, 34 + RNG.random() * 40
        m.d.rectangle([px, py, px + pw, py + ph], fill=jit(shade(base, 0.92), 3),
                      outline=shade(base, 0.78))
    wear_edges(m, (x0, y0, x1, y1), base, 40)
    return u


def paint_envelope(m):
    # flanks (shared ±x — mirror-safe): gore lines + roundel
    zone = L.Z_ENV_SIDE
    u = _env_common(m, zone, FABRIC)
    x0, y0, x1, y1 = zone.rect

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    for wy in (0.85, 1.75, 2.65):
        seam_h(m, x0 + 4, x1 - 4, int(v(wy)), FABRIC, hi=False)
    # belly shade rolling into the lower flank
    m.d.rectangle([x0, v(0.55), x1, y1], fill=shade(FABRIC, 0.85))
    # team roundel amidships
    rcx, rcy = u(0.4), v(1.8)
    rx = abs(u(1.25) - u(0.4))
    ry = abs(v(1.8) - v(1.25)) * 1.0
    m.d.ellipse([rcx - rx, rcy - ry, rcx + rx, rcy + ry], fill=(214, 216, 218))
    m.d.ellipse([rcx - rx * 0.66, rcy - ry * 0.66, rcx + rx * 0.66,
                 rcy + ry * 0.66], fill=TEAMGREY)
    m.t.ellipse([rcx - rx * 0.66, rcy - ry * 0.66, rcx + rx * 0.66,
                 rcy + ry * 0.66], fill=(255, 0, 0))

    # topside: brighter, with spine walk-line
    zone = L.Z_ENV_TOP
    u = _env_common(m, zone, shade(FABRIC, 1.05))
    x0, y0, x1, y1 = zone.rect
    cy = (y0 + y1) // 2
    m.d.line([(u(-3.6), cy), (u(4.2), cy)], fill=shade(FABRIC, 0.9), width=3)

    # belly: darker, rigging patch reinforcements
    zone = L.Z_ENV_BELLY
    u = _env_common(m, zone, FABRIC_B)
    x0, y0, x1, y1 = zone.rect
    cy = (y0 + y1) // 2
    for (rx_, ry_, rz_) in L.RIGGING:
        pu = u(rz_)
        pv = cy + (1 if rx_ < 0 else -1) * (y1 - y0) * 0.16
        m.d.ellipse([pu - 26, pv - 26, pu + 26, pv + 26],
                    fill=shade(FABRIC_B, 0.86), outline=shade(FABRIC_B, 0.7))
        bolts(m, [(pu - 14, pv), (pu + 14, pv), (pu, pv - 14), (pu, pv + 14)],
              r=4, base=FABRIC_B)


def paint_fins(m):
    z = L.Z_FIN
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(FABRIC, 0.97), ao=AO_BASE - 6,
         rough=R_ARMOR + 30, metal=6)

    def u(wz):
        return z.uv((0, 0, wz))[0] * W

    # rib seams along the chord
    for wz in (2.9, 3.5, 4.1):
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, FABRIC, hi=False)
    # trailing team panel — tail reads team from every aspect
    m.d.rectangle([u(3.9), y0, x1, y1], fill=TEAMGREY)
    m.t.rectangle([u(3.9), y0, x1, y1], fill=(255, 0, 0))
    m.d.line([(u(3.9), y0), (u(3.9), y1)], fill=shade(FABRIC, 0.6), width=2)
    wear_edges(m, (x0, y0, x1, y1), FABRIC, 24)


def paint_gondola(m):
    z = L.Z_GONDOLA
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, y0 + (y1 - y0) // 3, ARMOR)
    vent_slots(m, (x0 + 40, y1 - 90, x0 + 190, y1 - 34), 3)
    # equipment hatch + team square
    m.d.rectangle([x1 - 200, y0 + 40, x1 - 60, y0 + 130],
                  fill=shade(ARMOR, 0.92), outline=shade(ARMOR, 0.6))
    m.t.rectangle([x1 - 176, y0 + 56, x1 - 84, y0 + 114], fill=(255, 0, 0))
    m.d.rectangle([x1 - 176, y0 + 56, x1 - 84, y0 + 114], fill=TEAMGREY)
    bolts(m, [(x0 + 18, y0 + 16), (x1 - 18, y0 + 16),
              (x0 + 18, y1 - 16), (x1 - 18, y1 - 16)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 20)

    # sensor ball: dark steel housing, big optic + glow dot
    z = L.Z_SENS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) * 0.30
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=GLASS,
                outline=shade(STEEL_DK, 0.6), width=4)
    m.o.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=shade(CYAN_GLOW, 0.6))


def paint_bed(m):
    # deck: tread plate + hazard edging + drum shadow
    z = L.Z_BED_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8, rough=R_ARMOR + 10,
         metal=M_ARMOR)
    for gy in range(y0 + 14, y1, 26):     # tread strips
        m.d.line([(x0 + 6, gy), (x1 - 6, gy)], fill=shade(ARMOR_DK, 0.9),
                 width=2)
    for gx in range(x0 + 20, x1, 64):
        m.d.line([(gx, y0 + 6), (gx, y1 - 6)], fill=shade(ARMOR_DK, 0.93))
    # hazard edging front + rear
    for ey in (y0 + 6, y1 - 22):
        for i in range(int((x1 - x0) / 24) + 1):
            c = YELLOW if i % 2 == 0 else BLACKISH
            m.d.polygon([(x0 + i * 24, ey), (x0 + i * 24 + 24, ey),
                         (x0 + i * 24 + 12, ey + 16),
                         (x0 + i * 24 - 12, ey + 16)], fill=c)
    # tie-down rings along the rails
    bolts(m, [(x0 + 24, y0 + 120 + i * 120) for i in range(6)]
          + [(x1 - 24, y0 + 120 + i * 120) for i in range(6)],
          r=5, base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 70)

    for z in (L.Z_BED_SIDE, L.Z_BED_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 14,
             rough=R_ARMOR + 8, metal=M_ARMOR)
        seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, LOWER, hi=False)
        n = max(3, (x1 - x0) // 160)
        bolts(m, [(x0 + 30 + i * ((x1 - x0 - 60) / (n - 1)), y0 + 18)
                  for i in range(n)], base=LOWER)
        wear_edges(m, (x0, y0, x1, y1), LOWER, 26)


def paint_cabinet(m):
    for z in (L.Z_CAB, L.Z_CAB_F):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 4, rough=R_ARMOR,
             metal=M_ARMOR)
        seam_v(m, x0 + (x1 - x0) // 2, y0 + 4, y1 - 4, ARMOR)   # door split
        vent_slots(m, (x0 + 26, y1 - 96, x0 + (x1 - x0) // 2 - 14, y1 - 30), 4)
        # team stripe down the edge
        m.d.rectangle([x1 - 30, y0 + 8, x1 - 10, y1 - 8], fill=TEAMGREY)
        m.t.rectangle([x1 - 30, y0 + 8, x1 - 10, y1 - 8], fill=(255, 0, 0))
        # status LEDs
        for i, c in enumerate(((90, 230, 110), AMBER)):
            lx = x0 + 36 + i * 30
            m.d.ellipse([lx - 7, y0 + 24, lx + 7, y0 + 38], fill=c)
            m.e.ellipse([lx - 7, y0 + 24, lx + 7, y0 + 38], fill=shade(c, 0.7))
        bolts(m, [(x0 + 16, y0 + 16), (x1 - 44, y0 + 16),
                  (x0 + 16, y1 - 16), (x1 - 44, y1 - 16)], base=ARMOR)
        wear_edges(m, z.rect, ARMOR, 20)
    x0, y0, x1, y1 = L.Z_CAB_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 0.94), ao=AO_BASE - 6,
         rough=R_ARMOR + 6, metal=M_ARMOR)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, ARMOR)


def paint_details(m):
    # wheels: rubber sidewall + steel hub + lugs
    z = L.Z_WHEEL
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 20, rough=R_RUBBER,
         metal=0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hr = (x1 - x0) * 0.30
    m.d.ellipse([cx - hr, cy - hr, cx + hr, cy + hr], fill=STEEL_DK,
                outline=shade(STEEL_DK, 0.7), width=3)
    m.o.ellipse([cx - hr, cy - hr, cx + hr, cy + hr],
                fill=(AO_BASE - 10, R_STEEL, M_STEEL))
    for i in range(6):
        a = 2 * np.pi * i / 6
        bolts(m, [(cx + np.cos(a) * hr * 0.55, cy + np.sin(a) * hr * 0.55)],
              r=4, base=STEEL_DK)
    # tire tread wrap: cross lugs
    x0, y0, x1, y1 = L.Z_TIRE
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 24, rough=R_RUBBER,
         metal=0)
    for gy in range(int(y0) + 8, int(y1), 18):
        m.d.line([(x0 + 4, gy), (x1 - 4, gy)], fill=shade(RUBBER, 0.7),
                 width=4)

    # winch drum: galvanised flanges, wound-cable belly
    x0, y0, x1, y1 = L.Z_DRUM
    fill(m, (x0, y0, x1, y1), dif=GALV, ao=AO_BASE - 6, rough=R_STEEL - 10,
         metal=M_STEEL)
    for gx in range(int(x0) + 26, int(x1) - 26, 9):   # cable windings
        m.d.line([(gx, y0 + 6), (gx, y1 - 6)], fill=(96, 92, 86), width=5)
        m.d.line([(gx + 2, y0 + 6), (gx + 2, y1 - 6)], fill=(126, 120, 110),
                 width=2)
    m.o.rectangle([x0 + 26, y0 + 6, x1 - 26, y1 - 6],
                  fill=(AO_BASE - 24, R_STEEL + 30, M_STEEL - 60))

    # frame/struts wrap + tether/rigging wrap + trim + dark
    fill(m, L.Z_FRAME, dif=GALV, ao=AO_BASE - 4, rough=R_STEEL - 6,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.Z_FRAME
    for gy in range(int(y0) + 14, int(y1), 26):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(GALV, 0.88), width=2)
    x0, y0, x1, y1 = L.Z_CABLEW
    fill(m, (x0, y0, x1, y1), dif=(88, 84, 78), ao=AO_BASE - 10,
         rough=R_STEEL + 20, metal=M_STEEL - 40)
    for gx in range(int(x0) + 6, int(x1), 14):        # braid hint
        m.d.line([(gx, y0 + 2), (gx - 8, y1 - 2)], fill=(70, 66, 60), width=2)
    fill(m, L.Z_TRIM.rect, dif=STEEL_DK, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    x0, y0, x1, y1 = L.Z_TRIM.rect
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, STEEL_DK, hi=False)
    fill(m, L.Z_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 16,
         metal=M_ARMOR)

    # anti-collision beacon: red-amber, full glow
    z = L.Z_LIGHT
    fill(m, z.rect, dif=BCN_RED, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(BCN_RED, 0.85))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_envelope(m)
    paint_fins(m)
    paint_gondola(m)
    paint_bed(m)
    paint_cabinet(m)
    paint_details(m)

    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=17)
    wx.crevice_grime(m.dif, 0.4)
    # trailer lives in the mud; envelope only collects dust films
    wx.mud_band(L.Z_BED_SIDE.rect, 0.5, fade='down', dust=0.3)
    wx.mud_band(L.Z_BED_F.rect, 0.55, fade='down', spatter=True)
    wx.mud_band(L.Z_TIRE, 0.6, fade=None, spatter=True)
    wx.mud_band(L.Z_WHEEL.rect, 0.45, fade='down', spatter=True)
    wx.mud_band(L.Z_FRAME, 0.3, fade='right')
    wx.mud_band(L.Z_CAB.rect, 0.35, fade='down', dust=0.25)
    wx.mud_band(L.Z_ENV_BELLY.rect, 0.14, fade=None, spatter=False, dust=0.3)
    wx.plate_bottom_rust(L.Z_BED_SIDE.rect, n=6, strength=0.5)
    wx.plate_bottom_rust(L.Z_CAB.rect, n=4, strength=0.4)
    wx.plate_bottom_rust(L.Z_GONDOLA.rect, n=3, strength=0.3)
    wx.rust_streak(L.Z_BED_SIDE.rect[0] + 320, L.Z_BED_SIDE.rect[1] + 30, 60,
                   width=2.5, strength=0.35)
    wx.rust_streak(L.Z_BED_SIDE.rect[0] + 470, L.Z_BED_SIDE.rect[1] + 44, 40,
                   width=2.0, strength=0.3)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.4)
    wx.oily(L.Z_DRUM, 0.5)
    wx.oily((L.Z_FRAME[0], L.Z_FRAME[1], L.Z_FRAME[0] + 80, L.Z_FRAME[3]), 0.4)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    # deck tread strips ride proud
    x0, y0, x1, y1 = L.Z_BED_TOP.rect
    for gy in range(y0 + 14, y1, 26):
        hm.line((x0 + 6, gy), (x1 - 6, gy), 0.35, width=2)
    # drum winding grooves
    x0, y0, x1, y1 = L.Z_DRUM
    for gx in range(int(x0) + 26, int(x1) - 26, 9):
        hm.line((gx, y0 + 6), (gx, y1 - 6), -0.4, width=2)
    # envelope ring seams as soft creases
    for zone in (L.Z_ENV_SIDE, L.Z_ENV_TOP, L.Z_ENV_BELLY):
        zx0, zy0, zx1, zy1 = zone.rect
        for wz in RING_Z:
            u = zone.uv((0, 0, wz))[0] * W
            hm.line((u, zy0 + 2), (u, zy1 - 2), -0.3, width=2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=3.5).save('out/ms_obs_balloon_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_obs_balloon_diffuse.png')
    m.orm.save('out/ms_obs_balloon_orm.png')
    m.emi.save('out/ms_obs_balloon_emissive.png')
    m.tea.save('out/ms_obs_balloon_team.png')
    print('[paint_ms_obs_balloon] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
