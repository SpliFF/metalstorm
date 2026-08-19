"""paint_ms_radar_s2 — 1024² PBR set for ms_radar_s2 (Sector Tracking Station).

Scavenger-WW4 register: weathered poured-concrete pad and blockhouse with
mismatched patch plates, a bolted steel door, a sooted louvre bank, rust
streaks under the roof line, a stencilled team ID panel (team mask only),
galvanised pedestal/yoke steel, and a chalky off-white dish with a darker
ribbed back. Emissive = two amber status lamps, nothing else.
"""
from __future__ import annotations
import numpy as np

import ms_radar_s2_layout as L        # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   shade, jit, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS, M_ARMOR, M_STEEL, M_GLASS)

W = 1024
CONCRETE = (148, 145, 138)
CONC_DK = (124, 121, 114)
GALV = (164, 168, 173)
DISHC = (206, 203, 194)
DISHB = (140, 137, 130)
RUSTP = (122, 78, 52)
AMBER = (255, 176, 60)


def stencil(m, xy, text, size, color):
    """paint.stencil hardcodes a Linux font path — use paintlib.font()."""
    m.d.text(xy, text, font=PL.font(size), fill=color)


PATCH = [(150, 152, 146), (132, 134, 128), (118, 116, 110), (160, 158, 150),
         (126, 130, 132)]


# ── pad ─────────────────────────────────────────────────────────────────

def paint_pad(m):
    x0, y0, x1, y1 = L.Z_PAD.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 24,
         metal=0)
    for f in (0.25, 0.5, 0.75):                       # expansion joints
        m.d.line([(x0 + (x1 - x0) * f, y0 + 2), (x0 + (x1 - x0) * f, y1 - 2)],
                 fill=CONC_DK, width=2)
        m.d.line([(x0 + 2, y0 + (y1 - y0) * f), (x1 - 2, y0 + (y1 - y0) * f)],
                 fill=CONC_DK, width=2)
    cw = 54                                            # hazard corner wedges
    for cx, cy in ((x0, y0), (x1 - cw, y0), (x0, y1 - cw), (x1 - cw, y1 - cw)):
        for i in range(0, cw, 16):
            m.d.polygon([(cx + i, cy), (cx + i + 8, cy),
                         (cx, cy + i + 8), (cx, cy + i)],
                        fill=YELLOW if (i // 16) % 2 == 0 else BLACKISH)
    bolts(m, [(x0 + 26, y0 + 26), (x1 - 26, y0 + 26),
              (x0 + 26, y1 - 26), (x1 - 26, y1 - 26),
              ((x0 + x1) // 2, y0 + 26), ((x0 + x1) // 2, y1 - 26)],
          r=4, base=CONCRETE)
    fill(m, L.Z_PADS.rect, dif=CONC_DK, ao=AO_BASE - 10, rough=R_ARMOR + 24,
         metal=0)
    fill(m, L.R_STEP, dif=shade(CONCRETE, 0.93), ao=AO_BASE - 8,
         rough=R_ARMOR + 20, metal=0)


# ── blockhouse ──────────────────────────────────────────────────────────

def _wall_base(m, zone, seed):
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4, rough=R_ARMOR + 14,
         metal=0)
    PL.panel_patchwork(m, (x0 + 6, y0 + 6, x1 - 6, y1 - 6), PATCH,
                       cols=4, rows=3, bolt_every=2, seed=seed)
    seam_h(m, x0 + 4, x1 - 4, y0 + 26, CONCRETE)       # roof-line capping
    wear_edges(m, zone.rect, CONCRETE, density=20)


def paint_walls(m):
    # front (-Z): steel door, threshold, lamp bracket
    z = L.Z_BLK_FZ
    _wall_base(m, z, 11)
    u, v = PL.zone_fns(z)
    dx0, dx1 = u(-0.48), u(0.48)
    dy0, dy1 = v(1.98), v(L.PAD_H)
    box = PL.nbox(dx0, dy0, dx1, dy1)
    fill(m, box, dif=ARMOR_DK, ao=AO_BASE - 12, rough=R_STEEL + 8,
         metal=M_STEEL)
    m.d.rectangle(box, outline=BLACKISH, width=3)
    seam_v(m, (box[0] + box[2]) // 2, box[1] + 4, box[3] - 4, ARMOR_DK)
    bolts(m, [(box[0] + 10, box[1] + 12), (box[2] - 10, box[1] + 12),
              (box[0] + 10, box[3] - 12), (box[2] - 10, box[3] - 12)],
          base=ARMOR_DK)
    m.d.rectangle([box[2] - 26, (box[1] + box[3]) // 2 - 5,
                   box[2] - 14, (box[1] + box[3]) // 2 + 5], fill=STEEL)
    stencil(m, (u(-1.18), v(0.92)), 'S2', 30, shade(CONCRETE, 0.62))

    # rear (+Z): cable trays, soot patch under the louvre bank
    z = L.Z_BLK_BZ
    _wall_base(m, z, 23)
    u, v = PL.zone_fns(z)
    for wx_ in (-0.9, -0.75):
        m.d.line([(u(wx_), v(2.20)), (u(wx_), v(0.30))], fill=CONC_DK, width=3)

    # +X: stencilled team ID panel
    z = L.Z_BLK_PX
    _wall_base(m, z, 37)
    u, v = PL.zone_fns(z)
    panel = PL.nbox(u(-0.62), v(1.86), u(0.62), v(1.00))
    PL.team_panel(m, panel, outline=BLACKISH)
    stencil(m, (panel[0] + 18, panel[1] + 14), 'R-02', 34, BLACKISH)
    m.d.rectangle(PL.nbox(u(-0.62), v(0.86), u(0.62), v(0.62)), fill=CONC_DK)
    stencil(m, (u(-0.55), v(0.84)), 'TRACK STN', 18, shade(CONCRETE, 0.75))

    # -X: blank wall + conduit shadow + patches
    z = L.Z_BLK_NX
    _wall_base(m, z, 53)
    u, v = PL.zone_fns(z)
    m.d.rectangle(PL.nbox(u(0.90), v(2.20), u(1.14), v(0.26)), fill=CONC_DK)

    # roof
    x0, y0, x1, y1 = L.Z_BLK_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CONCRETE, 0.90), ao=AO_BASE - 8,
         rough=R_ARMOR + 20, metal=0)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    m.d.ellipse([cx - 92, cy - 92, cx + 92, cy + 92], outline=CONC_DK, width=5)
    bolts(m, [(cx - 78, cy), (cx + 78, cy), (cx, cy - 78), (cx, cy + 78)],
          r=4, base=CONCRETE)

    # vent louvre bank
    x0, y0, x1, y1 = L.R_VENT
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    vent_slots(m, (x0 + 14, y0 + 18, x1 - 14, y1 - 18), 6)
    bolts(m, [(x0 + 8, y0 + 8), (x1 - 8, y0 + 8),
              (x0 + 8, y1 - 8), (x1 - 8, y1 - 8)], base=ARMOR)


# ── mount + dish ────────────────────────────────────────────────────────

def paint_mount(m):
    for rect, col in ((L.R_PED, ARMOR), (L.R_SLEW, STEEL_DK),
                      (L.R_TURN, STEEL), (L.R_YOKE, GALV),
                      (L.R_TRIM, STEEL_DK), (L.R_RIB, shade(GALV, 0.82)),
                      (L.R_LIP, shade(DISHB, 0.92))):
        fill(m, rect, dif=col, ao=AO_BASE - 6, rough=R_STEEL, metal=M_STEEL)
        x0, y0, x1, y1 = rect
        for gy in range(int(y0) + 20, int(y1) - 6, 34):
            m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(col, 0.90),
                     width=2)
    # pedestal: bolted flange bands top and bottom
    x0, y0, x1, y1 = L.R_PED
    for by in (y0 + 12, y1 - 16):
        m.d.rectangle([x0, by - 7, x1, by + 7], fill=shade(ARMOR, 0.84))
        bolts(m, [(x0 + 14 + i * 18, by) for i in range(3)], base=ARMOR)
    for rect in (L.R_CWT, L.R_FEED):
        fill(m, rect, dif=ARMOR_DK, ao=AO_DEEP, rough=R_STEEL + 10,
             metal=M_STEEL)
        x0, y0, x1, y1 = rect
        m.d.rectangle([x0 + 10, y0 + 10, x1 - 10, y1 - 10],
                      outline=shade(ARMOR_DK, 1.18), width=3)


def paint_dish(m):
    # FRONT — chalky off-white; rings kept tone-on-tone so the impostor
    # baker's per-triangle flat sampling doesn't checkerboard the face.
    x0, y0, x1, y1 = L.R_DISH_F
    fill(m, (x0, y0, x1, y1), dif=DISHC, ao=AO_BASE, rough=R_ARMOR + 18,
         metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    R = (x1 - x0) / 2.0
    for f in (0.96, 0.72, 0.48, 0.24):
        rr = R * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(DISHC, 0.90), width=3)
    for i in range(8):                                  # radial panel joins
        a = i * np.pi / 4.0 + np.pi / 8.0
        m.d.line([(cx, cy), (cx + R * 0.97 * np.cos(a),
                             cy + R * 0.97 * np.sin(a))],
                 fill=shade(DISHC, 0.92), width=2)
    m.d.ellipse([cx - R * 0.12, cy - R * 0.12, cx + R * 0.12, cy + R * 0.12],
                fill=shade(DISHC, 0.80), outline=shade(DISHC, 0.66), width=3)
    bolts(m, [(cx + R * 0.86 * np.cos(i * np.pi / 3.0),
               cy + R * 0.86 * np.sin(i * np.pi / 3.0)) for i in range(6)],
          r=4, base=DISHC)
    # a single low-contrast team wedge (mask carries the colour)
    wedge = [(cx, cy), (cx + R * 0.94, cy - R * 0.22),
             (cx + R * 0.94, cy + R * 0.22)]
    m.d.polygon(wedge, fill=TEAMGREY)
    m.t.polygon(wedge, fill=(255, 0, 0))

    # BACK — darker ribbed shell
    x0, y0, x1, y1 = L.R_DISH_B
    fill(m, (x0, y0, x1, y1), dif=DISHB, ao=AO_BASE - 10, rough=R_ARMOR + 22,
         metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    R = (x1 - x0) / 2.0
    for f in (0.94, 0.62, 0.30):
        rr = R * f
        m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                    outline=shade(DISHB, 0.88), width=4)
    for i in range(6):
        a = i * np.pi / 3.0 + np.pi / 6.0
        m.d.line([(cx, cy), (cx + R * 0.94 * np.cos(a),
                             cy + R * 0.94 * np.sin(a))],
                 fill=shade(DISHB, 0.88), width=5)


def paint_lights(m):
    x0, y0, x1, y1 = L.R_LIGHT
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR_DK, 0.9), ao=AO_BASE,
         rough=R_STEEL, metal=M_STEEL)
    m.d.rectangle([x0 + 12, y0 + 12, x1 - 12, y1 - 12], fill=AMBER)
    m.e.rectangle([x0 + 12, y0 + 12, x1 - 12, y1 - 12], fill=shade(AMBER, 0.85))
    m.o.rectangle([x0 + 12, y0 + 12, x1 - 12, y1 - 12],
                  fill=(AO_BASE, R_GLASS, M_GLASS))


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_walls(m)
    paint_mount(m)
    paint_dish(m)
    paint_lights(m)

    side_zones = (L.Z_BLK_FZ, L.Z_BLK_BZ, L.Z_BLK_PX, L.Z_BLK_NX)
    wx = PL.standard_weather(m, L, ground_rects=(L.Z_PAD.rect, L.Z_PADS.rect,
                                                 L.R_STEP),
                             side_zones=side_zones, seed=41, mud=0.45,
                             grime=0.55, rust_fraction=0.5)
    for z in side_zones:                       # rust streaks under the roof
        x0, y0, x1, y1 = z.rect
        wx.plate_bottom_rust(z.rect, n=6, strength=0.5)
        for i in range(5):
            wx.rust_streak(x0 + 40 + i * 52, y0 + 30, 70 + 14 * (i % 3),
                           width=2.6, strength=0.4)
    wx.soot_patch(L.R_VENT, 0.7)
    wx.soot_patch((L.Z_BLK_BZ.rect[0] + 60, L.Z_BLK_BZ.rect[1] + 40,
                   L.Z_BLK_BZ.rect[2] - 60, L.Z_BLK_BZ.rect[1] + 120), 0.45)
    wx.rust_streak(L.R_DISH_B[0] + 150, L.R_DISH_B[1] + 50, 90,
                   width=3.0, strength=0.35)
    wx.rust_streak(L.R_DISH_B[0] + 190, L.R_DISH_B[1] + 40, 70,
                   width=2.4, strength=0.3)

    from normals import HeightMap
    hm = HeightMap()
    x0, y0, x1, y1 = L.Z_PAD.rect
    for f in (0.25, 0.5, 0.75):
        hm.line((x0 + (x1 - x0) * f, y0 + 2), (x0 + (x1 - x0) * f, y1 - 2),
                -0.6, width=2)
        hm.line((x0 + 2, y0 + (y1 - y0) * f), (x1 - 2, y0 + (y1 - y0) * f),
                -0.6, width=2)

    PL.finish(m, L, 'ms_radar_s2', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
