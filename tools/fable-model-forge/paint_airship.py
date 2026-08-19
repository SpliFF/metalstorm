"""paint_airship — 2048² PBR set for fable_airship (FT-2 Pelican).

Doped-alloy envelope in the faction family: panel grid over the ring
frames, side team flash + roundel (mirror-safe — the ±x flanks share a
zone), big topside code reading along the axis, darker belly with
nacelle soot trails, lit gondola window band, hazard-striped cargo
cradle rails, spinning-prop blur discs with tip-warning arcs, red/green
nav beacons and floodlit bays.  Weathering: panel-line grime, rain
streaks down the flanks, mooring scuffs at the nose, winch grease.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import airship_layout as L         # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   stencil, jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, FONT, RNG)

W = 2048
ENV   = (126, 124, 116)         # doped-alloy topside
ENV_B = (84, 84, 80)            # belly
DKST  = (52, 55, 60)            # structural steel
WARM  = (255, 190, 120)
RED   = (255, 62, 40)
GREEN = (60, 220, 90)

RING_Z = [z for (z, _, _) in L.ENV_SECTIONS[1:-1]]      # frame stations
SUB_Z  = [-25.0, -18.0, -9.0, 1.0, 10.0, 18.0, 25.0]   # panel sub-seams


def paint_envelope(m):
    # ── flanks (shared ±x — no text) ──
    zone = L.A_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ENV, ao=AO_BASE - 5, rough=R_ARMOR + 15,
         metal=M_ARMOR - 30)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    # ring frames + panel sub-seams + longitudinal stringers
    for wz in RING_Z:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, ENV, hi=True)
    for wz in SUB_Z:
        m.d.line([(u(wz), y0 + 4), (u(wz), y1 - 4)], fill=shade(ENV, 0.92))
    for wy in (4.5, 6.5, 8.5, 10.5, 12.5, 14.5):
        seam_h(m, x0 + 4, x1 - 4, int(py(wy)), ENV, hi=False)
    # subtle panel checker (alternate panels a hair off-tone)
    zs = [-32] + RING_Z + [32.5]
    for i in range(len(zs) - 1):
        for j, wy in enumerate((14.5, 12.5, 10.5, 8.5, 6.5, 4.5)):
            if (i + j) % 2:
                continue
            m.d.rectangle([u(zs[i]) + 1, py(wy) + 1, u(zs[i + 1]) - 1,
                           py(wy - 2.0) - 1], fill=jit(shade(ENV, 1.03), 2))
    # belly shadow gradient into the lower flank
    m.d.rectangle([x0, py(3.6), x1, y1], fill=shade(ENV, 0.82))
    m.d.rectangle([x0, py(2.4), x1, y1], fill=shade(ENV, 0.7))
    # team flash: long tapered stripe along the mid-flank
    pts = [(u(-26.0), py(9.8)), (u(20.0), py(10.6)), (u(24.0), py(9.4)),
           (u(20.0), py(8.4)), (u(-26.0), py(8.6))]
    m.t.polygon(pts, fill=(255, 0, 0))
    m.d.polygon(pts, fill=TEAMGREY)
    # roundel riding the flash band (mirror-safe geometry)
    rcx, rcy = u(-22.5), py(9.5)
    rx, ry = 1.35 * 30.57, 1.35 * 20.51
    m.d.ellipse([rcx - rx, rcy - ry, rcx + rx, rcy + ry], fill=(212, 214, 216))
    m.t.ellipse([rcx - rx * 0.62, rcy - ry * 0.62, rcx + rx * 0.62,
                 rcy + ry * 0.62], fill=(255, 0, 0))
    m.d.ellipse([rcx - rx * 0.62, rcy - ry * 0.62, rcx + rx * 0.62,
                 rcy + ry * 0.62], fill=TEAMGREY)
    # patch repairs + vents along the lower flank
    for (wz, wy) in ((-14.0, 5.5), (3.0, 4.6), (17.0, 6.0)):
        m.d.rectangle([u(wz), py(wy), u(wz + 1.8), py(wy - 1.2)],
                      fill=jit(shade(ENV, 0.9), 3),
                      outline=shade(ENV, 0.75))
    vent_slots(m, (int(u(-2.0)), int(py(14.2)), int(u(1.5)), int(py(13.2))),
               5, horizontal=False)
    wear_edges(m, (x0, y0, x1, y1), ENV, 55)

    # ── topside ──
    zone = L.A_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ENV, 1.06), ao=AO_BASE, rough=R_ARMOR + 15,
         metal=M_ARMOR - 30)

    def vx(wx):
        return zone.uv((wx, 0, 0))[1] * W

    for wz in RING_Z:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, ENV, hi=True)
    for wz in SUB_Z:
        m.d.line([(u(wz), y0 + 4), (u(wz), y1 - 4)], fill=shade(ENV, 0.94))
    for wx_ in (-5.0, -2.5, 2.5, 5.0):
        seam_h(m, x0 + 4, x1 - 4, int(vx(wx_)), ENV, hi=False)
    # dorsal walkway: anti-slip strip + yellow stay-inside lines
    m.d.rectangle([u(-20.0), vx(-0.7), u(15.0), vx(0.7)],
                  fill=shade(ENV, 0.78))
    for wx_ in (-0.85, 0.85):
        m.d.line([(u(-20.0), vx(wx_)), (u(15.0), vx(wx_))],
                 fill=jit(YELLOW, 10), width=2)
    # big topside code, reading along the axis
    f = font(96)
    tw = m.d.textlength('FT-02', font=f)
    tcx = u(22.0) - tw / 2
    m.d.text((tcx + 3, vx(-2.9) + 3), 'FT-02', font=f, fill=shade(ENV, 0.6))
    m.d.text((tcx, vx(-2.9)), 'FT-02', font=f, fill=(215, 217, 219))
    # team chevron on the bow topside
    ccx = u(-24.0)
    m.t.polygon([(ccx - 34, vx(-3.4)), (ccx + 34, vx(0)), (ccx - 34, vx(3.4))],
                fill=(255, 0, 0))
    m.d.polygon([(ccx - 34, vx(-3.4)), (ccx + 34, vx(0)), (ccx - 34, vx(3.4))],
                fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), ENV, 40)

    # ── belly ──
    zone = L.A_BELLY
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ENV_B, ao=AO_BASE - 12, rough=R_ARMOR + 20,
         metal=M_ARMOR - 30)

    def vb(wx):
        return zone.uv((wx, 0, 0))[1] * W

    for wz in RING_Z:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, ENV_B, hi=False)
    for wx_ in (-4.5, 0.0, 4.5):
        seam_h(m, x0 + 4, x1 - 4, int(vb(wx_)), ENV_B, hi=False)
    # keel attachment doubler band + bay aprons
    m.d.rectangle([u(-11.0), vb(-1.6), u(13.0), vb(1.6)],
                  fill=shade(ENV_B, 0.88))
    for bz in L.BAYS:
        m.d.rectangle([u(bz - L.BAY_LEN / 2), vb(-2.4),
                       u(bz + L.BAY_LEN / 2), vb(2.4)],
                      outline=jit(YELLOW, 12), width=3)
    wear_edges(m, (x0, y0, x1, y1), ENV_B, 45)


def paint_gondola(m):
    zone = L.A_GONDOLA
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # plating + window band (kept clear of the roof/floor sample rows)
    for wz in (-22.0, -19.5, -17.0, -14.5):
        seam_v(m, int(u(wz)), int(v(3.7)), int(v(0.6)), ARMOR, hi=False)
    seam_h(m, x0 + 3, x1 - 3, int(v(1.35)), ARMOR, hi=False)
    m.d.rectangle([u(-23.3), v(3.25), u(-14.1), v(2.6)], fill=GLASS)
    m.o.rectangle([u(-23.3), v(3.25), u(-14.1), v(2.6)],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    k = 0
    for wz in np.arange(-23.3, -14.1, 0.92):
        m.d.rectangle([u(wz) - 2, v(3.25), u(wz) + 2, v(2.6)],
                      fill=shade(ARMOR, 0.7))
        if k % 3 != 2:
            m.e.rectangle([u(wz) + 4, v(3.18), u(wz + 0.92) - 4, v(2.68)],
                          fill=(150, 110, 60))
        k += 1
    # crew door + handrail + kick plate at the aft end
    m.d.rectangle([u(-13.9), v(2.9), u(-13.0), v(0.75)], fill=(50, 54, 60),
                  outline=shade(ARMOR, 0.6), width=2)
    m.d.line([(u(-23.4), v(1.05)), (u(-13.0), v(1.05))],
             fill=shade(ARMOR, 1.25), width=3)
    m.d.rectangle([x0, v(0.75), x1, y1], fill=shade(ARMOR, 0.8))
    bolts(m, [(u(wz), v(3.55)) for wz in (-23.5, -21.0, -18.5, -16.0, -13.5)],
          base=ARMOR)
    wear_edges(m, (x0, int(v(3.75)), x1, int(v(0.55))), ARMOR, 45)

    # cockpit face: canopy + sensor strip (shared ±z — no text)
    zone = L.A_GONDOLA_F
    x0, y0, x1, y1 = zone.rect

    def uf(wx):
        return zone.uv((wx, 0, 0))[0] * W

    m.d.polygon([(uf(-2.4), v(3.3)), (uf(2.4), v(3.3)), (uf(2.0), v(2.5)),
                 (uf(-2.0), v(2.5))], fill=GLASS)
    m.o.polygon([(uf(-2.4), v(3.3)), (uf(2.4), v(3.3)), (uf(2.0), v(2.5)),
                 (uf(-2.0), v(2.5))], fill=(AO_BASE, R_GLASS, M_GLASS))
    for wx_ in (-1.2, 0.0, 1.2):
        m.d.line([(uf(wx_), v(3.3)), (uf(wx_ * 0.85), v(2.5))],
                 fill=shade(ARMOR, 0.7), width=3)
    m.e.polygon([(uf(-1.1), v(3.22)), (uf(1.1), v(3.22)), (uf(0.95), v(2.6)),
                 (uf(-0.95), v(2.6))], fill=(150, 110, 60))
    m.d.rectangle([uf(1.6), v(1.5), uf(-1.6), v(1.2)], fill=(40, 44, 48))
    m.e.rectangle([uf(0.5), v(1.44), uf(-0.5), v(1.26)], fill=(60, 160, 180))
    wear_edges(m, (min(uf(3.3), uf(-3.3)), y0, max(uf(3.3), uf(-3.3)), y1),
               ARMOR, 30)


def paint_cradle(m):
    zone = L.A_CRADLE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DKST, ao=AO_BASE - 12, rough=165, metal=170)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # keel flank: access panels + pipe run (no text — ±x shared)
    seam_h(m, x0 + 2, x1 - 2, int(v(2.72)), DKST, hi=False)
    for wz in np.arange(-9.5, 12.0, 3.4):
        m.d.rectangle([u(wz), v(2.62), u(wz + 1.6), v(2.12)],
                      fill=jit(shade(DKST, 0.88), 3),
                      outline=shade(DKST, 0.7))
    m.d.line([(x0 + 2, v(2.02)), (x1 - 2, v(2.02))], fill=(70, 74, 80),
             width=3)
    # hazard band — rail tops sample row v(2.0)
    bh0, bh1 = int(v(2.12)), int(v(1.55))
    for i in range(int((x1 - x0) / 14) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 14, bh0), (x0 + i * 14 + 14, bh0),
                     (x0 + i * 14 + 7, bh1), (x0 + i * 14 - 7, bh1)], fill=c)
    m.o.rectangle([x0, bh0, x1, bh1], fill=(AO_BASE - 10, 190, 60))
    # girder lattice below
    m.d.rectangle([x0, bh1, x1, y1], fill=shade(DKST, 0.9))
    for wz in np.arange(-12.0, 14.0, 2.2):
        m.d.line([(u(wz), bh1), (u(wz + 2.2), y1 - 60)],
                 fill=shade(DKST, 0.72), width=3)
        m.d.line([(u(wz + 2.2), bh1), (u(wz), y1 - 60)],
                 fill=shade(DKST, 0.72), width=3)
    bolts(m, [(u(wz), v(2.66)) for wz in np.arange(-10.0, 13.0, 2.3)],
          base=DKST)
    wear_edges(m, (x0, y0, x1, y1), DKST, 70)

    # winches: drum + cable wrap
    x0, y0, x1, y1 = L.A_WINCH.rect
    fill(m, (x0, y0, x1, y1), dif=(64, 68, 74), ao=AO_BASE - 14, rough=150,
         metal=190)
    for fy in np.linspace(0.25, 0.75, 6):
        m.d.line([(x0 + 8, y0 + (y1 - y0) * fy), (x1 - 8, y0 + (y1 - y0) * fy)],
                 fill=(40, 42, 46), width=3)
    m.e.ellipse([x1 - 26, y0 + 10, x1 - 14, y0 + 22], fill=(255, 170, 60))

    # trim / struts / dark caps
    fill(m, L.A_TRIM.rect, dif=DKST, ao=AO_BASE - 15, rough=165, metal=150)
    fill(m, L.A_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    # floodlight cluster — whole housing glows
    x0, y0, x1, y1 = L.A_LIGHT.rect
    fill(m, (x0, y0, x1, y1), dif=(200, 200, 195), ao=AO_BASE, rough=90,
         metal=120)
    m.e.rectangle([x0, y0, x1, y1], fill=(235, 225, 200))
    # nav beacons: port red (+x) / starboard green
    for rect, col in ((L.A_NAVP.rect, RED), (L.A_NAVS.rect, GREEN)):
        x0, y0, x1, y1 = rect
        fill(m, rect, dif=(30, 32, 35), ao=AO_BASE - 10, rough=120, metal=100)
        m.e.rectangle([x0, y0, x1, y1], fill=col)


def paint_nacelles(m):
    # pod wrap: u runs nose→tail
    x0, y0, x1, y1 = L.A_NACELLE
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL)
    m.d.rectangle([x0, y0, x0 + 24, y1], fill=BLACKISH)          # cowl lip
    m.t.rectangle([x0 + 32, y0, x0 + 58, y1], fill=(255, 0, 0))  # team band
    m.d.rectangle([x0 + 32, y0, x0 + 58, y1], fill=TEAMGREY)
    for fx in (0.45, 0.7):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, ARMOR, hi=False)
    vent_slots(m, (x1 - 92, y0 + 24, x1 - 40, y1 - 24), 4, horizontal=False)
    m.d.rectangle([x1 - 26, y0, x1, y1], fill=(58, 54, 50))      # exhaust ring

    # prop blur disc: radial smear + tip-warning arcs
    zone = L.A_PROP
    x0, y0, x1, y1 = zone.rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    fill(m, (x0, y0, x1, y1), dif=(38, 40, 43), ao=AO_BASE - 10, rough=170,
         metal=120)
    pr = 75.3
    for a in np.linspace(0, 2 * np.pi, 36, endpoint=False):
        r0, r1 = 0.25 * 1.55 * pr, 0.98 * 1.55 * pr
        m.d.line([(cx + np.cos(a) * r0, cy + np.sin(a) * r0),
                  (cx + np.cos(a + 0.22) * r1, cy + np.sin(a + 0.22) * r1)],
                 fill=jit((30, 31, 34), 3), width=4)
    for a in np.linspace(0, 2 * np.pi, 12, endpoint=False):
        m.d.arc([cx - 1.5 * pr, cy - 1.5 * pr, cx + 1.5 * pr, cy + 1.5 * pr],
                np.degrees(a), np.degrees(a) + 14, fill=jit(YELLOW, 10),
                width=6)
    m.d.ellipse([cx - 16, cy - 16, cx + 16, cy + 16], fill=(24, 25, 27))

    # nose mooring cone: collar rings, dark tip end
    x0, y0, x1, y1 = L.A_MOOR
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=130,
         metal=200)
    for fx in (0.3, 0.55):
        seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, STEEL_DK,
               hi=False)
    m.d.rectangle([x1 - 40, y0, x1, y1], fill=(40, 42, 46))


def paint_fins(m):
    # vertical fins (±x faces share — no text)
    zone = L.A_FIN
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ENV, 0.97), ao=AO_BASE - 6,
         rough=R_ARMOR + 10, metal=M_ARMOR - 20)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # rudder hinge + rib seams
    for wy in (15.0, 13.2, 5.2, 4.0):
        seam_h(m, x0 + 3, x1 - 3, int(v(wy)), ENV, hi=False)
    m.d.rectangle([u(30.4), y0 + 4, x1 - 2, y1 - 4],
                  fill=jit(shade(ENV, 0.93), 2))   # rudder panel tone shift
    m.d.line([(u(30.4), y0 + 2), (u(30.4), y1 - 2)], fill=shade(ENV, 0.65),
             width=3)
    # team tip flashes: dorsal tip band + ventral tip band
    for (wy0, wy1) in ((16.5, 15.3), (4.4, 3.2)):
        m.t.rectangle([u(25.6), v(wy0), u(31.6), v(wy1)], fill=(255, 0, 0))
        m.d.rectangle([u(25.6), v(wy0), u(31.6), v(wy1)], fill=TEAMGREY)
    bolts(m, [(u(wz), v(11.9)) for wz in (25.8, 27.4, 29.0, 30.6)], base=ENV)
    wear_edges(m, (x0, y0, x1, y1), ENV, 40)

    # horizontal fins (top/bottom faces)
    zone = L.A_FIN_H
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ENV, 0.97), ao=AO_BASE - 6,
         rough=R_ARMOR + 10, metal=M_ARMOR - 20)

    def uh(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vh(wx):
        return zone.uv((wx, 0, 0))[1] * W

    m.d.line([(uh(30.4), y0 + 2), (uh(30.4), y1 - 2)], fill=shade(ENV, 0.65),
             width=3)
    for wx_ in (-6.0, -4.0, 4.0, 6.0):
        seam_h(m, x0 + 3, x1 - 3, int(vh(wx_)), ENV, hi=False)
    for (wx0, wx1) in ((-7.9, -6.7), (6.7, 7.9)):
        m.t.rectangle([uh(25.6), vh(wx0), uh(31.6), vh(wx1)], fill=(255, 0, 0))
        m.d.rectangle([uh(25.6), vh(wx0), uh(31.6), vh(wx1)], fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), ENV, 40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_envelope(m)
    paint_gondola(m)
    paint_cradle(m)
    paint_nacelles(m)
    paint_fins(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    from paint import enrich
    enrich(m)
    wx = Weather(seed=83)
    wx.crevice_grime(m.dif, 0.4)
    zone = L.A_SIDE

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def py(wy):
        return zone.uv((0, wy, 0))[1] * W

    # rain streaks down the flanks from the frame stations
    for wz in RING_Z:
        wx.rust_streak(u(wz) + 3, py(15.2), 26 + (int(wz) % 3) * 9,
                       width=2.0, strength=0.28)
    # soot trails aft of the nacelle exhausts
    for nz in sorted({n[2] for n in L.NACELLES}):
        wx.soot_patch((int(u(nz + 1.6)), int(py(9.7)), int(u(nz + 8.5)),
                       int(py(7.6))), 0.4, fade='right')
    # mooring scuffs at the nose + belly grime
    wx.mud_band((int(u(-33.0)), int(py(11.0)), int(u(-29.0)), int(py(7.4))),
                0.35, fade=None, spatter=False)
    wx.mud_band(L.A_BELLY.rect, 0.3, fade=None, spatter=True)
    wx.mud_band(L.A_CRADLE.rect, 0.3, fade='down', spatter=False)
    wx.oily(L.A_WINCH.rect, 0.4)
    wx.soot_patch(L.A_NACELLE, 0.45, fade='right')
    wx.mud_band(L.A_GONDOLA.rect, 0.22, fade='down', spatter=False)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for zr, vfun in ((L.A_SIDE, None), (L.A_TOP, None), (L.A_BELLY, None)):
        x0, y0, x1, y1 = zr.rect
        for wz in RING_Z:
            uu = zr.uv((0, 0, wz))[0] * W
            hm.line((uu, y0 + 2), (uu, y1 - 2), 0.55, width=3)
        for wz in SUB_Z:
            uu = zr.uv((0, 0, wz))[0] * W
            hm.line((uu, y0 + 3), (uu, y1 - 3), -0.3, width=2)
    for wy in (4.5, 6.5, 8.5, 10.5, 12.5, 14.5):
        hm.line((2, py(wy)), (W - 2, py(wy)), 0.25, width=2)
    gz = L.A_GONDOLA
    hm.rect((gz.uv((0, 0, -23.3))[0] * W, gz.uv((0, 3.25, 0))[1] * W,
             gz.uv((0, 0, -14.1))[0] * W, gz.uv((0, 2.6, 0))[1] * W), -0.5)
    fz = L.A_FIN
    hm.line((fz.uv((0, 0, 30.4))[0] * W, fz.rect[1] + 2),
            (fz.uv((0, 0, 30.4))[0] * W, fz.rect[3] - 2), -0.45, width=3)
    fzh = L.A_FIN_H
    hm.line((fzh.uv((0, 0, 30.4))[0] * W, fzh.rect[1] + 2),
            (fzh.uv((0, 0, 30.4))[0] * W, fzh.rect[3] - 2), -0.45, width=3)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save('out/fable_airship_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_airship_diffuse.png')
    m.orm.save('out/fable_airship_orm.png')
    m.emi.save('out/fable_airship_emissive.png')
    m.tea.save('out/fable_airship_team.png')
    print('[paint_airship] full 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
