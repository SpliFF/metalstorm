"""paint_ms_radar_s3 — 1024² PBR set for ms_radar_s3 (Coastal Surveillance Array).

Same field-hardware register as ms_radar_s1/ms_comms_relay, scaled up:
weathered concrete pad + plinth with hazard corners and anchor plates,
two MISMATCHED salvage container cabins (patchwork plates, corrugation
seams, door, vent, ladder), galvanised braced tower, oily winch drum with
a dark wound-cable spool, a marine-orange ribbed hydrophone, and a dark
planar array face with a 6x2 grid of lit-edge elements. Emissive = amber
status lamps only. Team colour ONLY in the team-mask R channel (ID panel
on cabin B and on the array's back truss).
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import ms_radar_s3_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_LT, ARMOR_DK, STEEL, STEEL_DK,
                   YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 1024
RNG = np.random.default_rng(90210)

CONCRETE = (146, 144, 138)
GALV     = (166, 170, 175)
CABLE    = (78, 80, 86)
AMBER    = (255, 176, 60)
ARRAY_F  = (92, 96, 100)
ARRAY_B  = (108, 104, 96)
ELEM     = (168, 172, 172)
ORANGE   = (196, 96, 40)
CAB_A    = (104, 108, 96)      # olive salvage container
CAB_B    = (122, 96, 78)       # rust-red salvage container
SCRAP    = [(104, 108, 96), (122, 96, 78), (118, 118, 112), (92, 88, 82),
            (134, 120, 96), (88, 96, 100)]


def paint_pad(m):
    z = L.R_PAD
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE, rough=R_ARMOR + 22, metal=0)
    for f in (0.25, 0.5, 0.75):
        m.d.line([(x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2)],
                 fill=shade(CONCRETE, 0.86), width=2)
        m.d.line([(x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f)],
                 fill=shade(CONCRETE, 0.86), width=2)
    cw = 52
    for cx, cy in ((x0, y0), (x1-cw, y0), (x0, y1-cw), (x1-cw, y1-cw)):
        for i in range(0, cw, 14):
            m.d.polygon([(cx+i, cy), (cx+i+7, cy), (cx, cy+i+7), (cx, cy+i)],
                        fill=YELLOW if (i//14) % 2 == 0 else BLACKISH)
    # tower-leg anchor plates at the four base corners
    u, v = PL.zone_fns(z)
    for sx in (-1, 1):
        for sz in (-1, 1):
            ax, ay = u(sx * L.TOWER_HB), v(sz * L.TOWER_HB)
            m.d.rectangle([ax-15, ay-15, ax+15, ay+15], fill=STEEL)
            m.o.rectangle([ax-15, ay-15, ax+15, ay+15], fill=(AO_BASE-10, R_STEEL, M_STEEL))
            bolts(m, [(ax-8, ay-8), (ax+8, ay-8), (ax-8, ay+8), (ax+8, ay+8)],
                  r=3, base=STEEL)
    fill(m, L.R_PADS.rect, dif=shade(CONCRETE, 0.9), ao=AO_BASE-10,
         rough=R_ARMOR + 22, metal=0)
    fill(m, L.R_PLI.rect, dif=shade(CONCRETE, 0.82), ao=AO_BASE-14,
         rough=R_ARMOR + 18, metal=0)
    px0, py0, px1, py1 = L.R_PLI.rect
    for i in range(6):
        gx = px0 + (px1-px0) * (i + 1) / 7
        m.d.line([(gx, py0+2), (gx, py1-2)], fill=shade(CONCRETE, 0.66), width=2)


def paint_cabins(m):
    """Front/back faces of BOTH cabins share one world-mapped zone, so each
    cabin gets its own patchwork block — the mismatched-salvage read."""
    z = L.R_CAB_F
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE-4, rough=R_ARMOR, metal=M_ARMOR)
    for cx, base in ((L.CAB_AX, CAB_A), (L.CAB_BX, CAB_B)):
        bx = PL.nbox(u(cx - L.CAB_W/2), v(L.PLINTH_TOP),
                     u(cx + L.CAB_W/2), v(L.CAB_TOP))
        fill(m, bx, dif=base, ao=AO_BASE-4, rough=R_ARMOR+8, metal=M_ARMOR)
        PL.panel_patchwork(m, bx, SCRAP, cols=4, rows=2, bolt_every=1, seed=90210)
        # container corrugation
        for i in range(1, 16):
            gx = bx[0] + (bx[2]-bx[0]) * i / 16
            m.d.line([(gx, bx[1]+4), (gx, bx[3]-4)], fill=shade(base, 0.84), width=2)
        # cargo-door bars on the -Z face half + a personnel door
        dx0 = bx[0] + (bx[2]-bx[0]) * 0.58
        m.d.rectangle([dx0, bx[1]+18, bx[2]-10, bx[3]-6],
                      fill=shade(base, 0.9), outline=shade(base, 0.55), width=3)
        m.o.rectangle([dx0, bx[1]+18, bx[2]-10, bx[3]-6],
                      fill=(AO_BASE-16, R_ARMOR+10, M_ARMOR))
        m.d.line([((dx0 + bx[2]-10)/2, bx[1]+18), ((dx0 + bx[2]-10)/2, bx[3]-6)],
                 fill=shade(base, 0.55), width=3)
        vent_slots(m, (bx[0]+16, bx[1]+16, bx[0]+96, bx[1]+52), 4)
        wear_edges(m, [int(q) for q in bx], base, density=22)
        bolts(m, [(bx[0]+10, bx[1]+10), (bx[2]-10, bx[1]+10),
                  (bx[0]+10, bx[3]-10), (bx[2]-10, bx[3]-10)], base=base)
    # team ID panel + stencilled numeral on cabin B
    tb = PL.nbox(u(L.CAB_BX - 0.95), v(L.CAB_TOP - 0.30),
                 u(L.CAB_BX - 0.05), v(L.CAB_TOP - 0.95))
    PL.team_panel(m, tb, outline=BLACKISH)
    f = PL.font(30)
    m.d.text((tb[0] + 14, tb[1] + 8), 'S3', font=f, fill=BLACKISH)
    # amber status LEDs (diffuse only; the lamp boxes carry the emissive)
    for cx in (L.CAB_AX, L.CAB_BX):
        for i, c in enumerate(((92, 226, 112), AMBER, (200, 70, 56))):
            lx = u(cx - 0.85 + i * 0.16)
            ly = v(L.CAB_TOP - 0.16)
            m.d.ellipse([lx-5, ly-5, lx+5, ly+5], fill=c)

    # cabin end walls
    z = L.R_CAB_S
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CAB_A, 0.92), ao=AO_BASE-6,
         rough=R_ARMOR+8, metal=M_ARMOR)
    for i in range(1, 9):
        gy = y0 + (y1-y0) * i / 9
        m.d.line([(x0+2, gy), (x1-2, gy)], fill=shade(CAB_A, 0.78), width=2)
    seam_v(m, y0+2, y1-2, (x0+x1)//2, CAB_A)
    bolts(m, [(x0+12, y0+12), (x1-12, y0+12), (x0+12, y1-12), (x1-12, y1-12)],
          base=CAB_A)
    wear_edges(m, z.rect, CAB_A, density=18)

    # cabin roofs (also used by the winch frames / fairlead / cradles)
    z = L.R_CAB_T
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CAB_A, 0.86), ao=AO_BASE-8,
         rough=R_ARMOR+14, metal=M_ARMOR)
    fill(m, PL.nbox(u(0.05), v(1.15), u(2.45), v(2.55)),
         dif=shade(CAB_B, 0.86), ao=AO_BASE-8, rough=R_ARMOR+14, metal=M_ARMOR)
    for i in range(1, 22):
        gx = x0 + (x1-x0) * i / 22
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(CAB_A, 0.74), width=2)
    PL.hazard_band(m, PL.nbox(u(-2.55), v(1.20), u(-2.15), v(2.50)))


def paint_hardware(m):
    fill(m, L.R_TOWER, dif=GALV, ao=AO_BASE-4, rough=R_STEEL-8, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_TOWER
    for gy in range(int(y0)+14, int(y1), 22):
        m.d.line([(x0+2, gy), (x1-2, gy)], fill=shade(GALV, 0.86), width=2)
    for gx in range(int(x0)+40, int(x1), 80):
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(GALV, 0.92), width=3)

    fill(m, L.R_TRIM, dif=STEEL_DK, ao=AO_BASE-8, rough=R_STEEL, metal=M_STEEL)
    fill(m, L.R_CABLE, dif=CABLE, ao=AO_DEEP, rough=R_STEEL+22, metal=M_STEEL-50)
    x0, y0, x1, y1 = L.R_CABLE
    for gx in range(int(x0)+6, int(x1), 11):     # wound-cable turns
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(CABLE, 1.22), width=2)
        m.d.line([(gx+5, y0+2), (gx+5, y1-2)], fill=shade(CABLE, 0.72), width=2)

    fill(m, L.R_DRUM, dif=STEEL, ao=AO_BASE-6, rough=R_STEEL+6, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_DRUM
    for gy in range(int(y0)+8, int(y1), 16):
        m.d.line([(x0+2, gy), (x1-2, gy)], fill=shade(STEEL, 0.8), width=2)

    # hydrophone: marine orange body with dark ribs
    fill(m, L.R_HYD, dif=ORANGE, ao=AO_BASE-6, rough=R_ARMOR+10, metal=M_ARMOR)
    x0, y0, x1, y1 = L.R_HYD
    for gx in range(int(x0)+12, int(x1), 26):
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(ORANGE, 0.62), width=4)
    m.d.rectangle([x1-46, y0+2, x1-2, y1-2], fill=BLACKISH)

    fill(m, L.R_COLLAR, dif=STEEL, ao=AO_BASE-8, rough=R_STEEL, metal=M_STEEL)
    x0, y0, x1, y1 = L.R_COLLAR
    for gx in range(int(x0)+16, int(x1), 26):
        m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(STEEL, 0.78), width=3)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR+16, metal=M_ARMOR)
    fill(m, L.R_SPARE, dif=shade(STEEL_DK, 0.9), ao=AO_DEEP, rough=R_STEEL, metal=M_STEEL)

    # array narrow edges
    for z in (L.R_ARR_TB, L.R_ARR_LR):
        fill(m, z.rect, dif=shade(ARRAY_B, 0.82), ao=AO_BASE-10,
             rough=R_ARMOR+10, metal=M_ARMOR)
        x0, y0, x1, y1 = z.rect
        for gx in range(int(x0)+18, int(x1), 34):
            m.d.line([(gx, y0+2), (gx, y1-2)], fill=shade(ARRAY_B, 0.66), width=2)

    # amber lamp lens zone — the model's only emissive
    z = L.R_LIGHT
    fill(m, z.rect, dif=AMBER, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    x0, y0, x1, y1 = z.rect
    m.e.rectangle([x0+3, y0+3, x1-3, y1-3], fill=shade(AMBER, 0.85))


def paint_array(m):
    # front face: dark radome grey + the 6x2 element grid the geometry sits on
    z = L.R_ARRAY_F
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARRAY_F, ao=AO_BASE-6, rough=R_ARMOR+6, metal=M_ARMOR)
    span = (L.ELEM_X1 - L.ELEM_X0) / L.ELEM_COLS
    for i in range(L.ELEM_COLS):
        cx = L.ELEM_X0 + span * (i + 0.5)
        for cy in L.ELEM_ROW_Y:
            bx = PL.nbox(u(cx - L.ELEM_W/2), v(cy - L.ELEM_H/2),
                         u(cx + L.ELEM_W/2), v(cy + L.ELEM_H/2))
            fill(m, bx, dif=ELEM, ao=AO_BASE, rough=R_ARMOR-14, metal=M_ARMOR)
            m.d.rectangle(bx, outline=shade(ELEM, 0.6), width=3)
            for k in range(1, 5):          # slot elements inside each cell
                sy = bx[1] + (bx[3]-bx[1]) * k / 5
                m.d.line([(bx[0]+8, sy), (bx[2]-8, sy)], fill=shade(ELEM, 0.72), width=4)
            bolts(m, [(bx[0]+7, bx[1]+7), (bx[2]-7, bx[1]+7),
                      (bx[0]+7, bx[3]-7), (bx[2]-7, bx[3]-7)], r=3, base=ELEM)
    seam_h(m, x0+4, x1-4, int(v(L.ARR_CY)), ARRAY_F)

    # back face: ribbed shell, stencil + team ID panel on the truss frame
    z = L.R_ARRAY_B
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARRAY_B, ao=AO_BASE-8, rough=R_ARMOR+12, metal=M_ARMOR)
    PL.panel_patchwork(m, [x0+4, y0+4, x1-4, y1-4], SCRAP, cols=5, rows=2,
                       bolt_every=2, seed=90210)
    for bx in (-1.42, -0.71, 0.0, 0.71, 1.42):
        gx = u(bx)
        m.d.line([(gx, y0+8), (gx, y1-8)], fill=shade(ARRAY_B, 0.7), width=5)
    tb = PL.nbox(u(-1.30), v(L.ARR_CY + 0.34), u(-0.30), v(L.ARR_CY - 0.30))
    PL.team_panel(m, tb, outline=BLACKISH)
    f = PL.font(34)
    m.d.text((tb[0] + 16, tb[1] + 12), 'CSA', font=f, fill=BLACKISH)
    f2 = PL.font(26)
    m.d.text((u(0.40), v(L.ARR_CY + 0.22)), 'SONAR-3', font=f2, fill=shade(ARRAY_B, 0.55))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_pad(m)
    paint_cabins(m)
    paint_hardware(m)
    paint_array(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.R_PADS.rect, L.R_PLI.rect),
        side_zones=(L.R_CAB_F, L.R_CAB_S),
        seed=90210, mud=0.45, grime=0.5, rust_fraction=0.55)
    wx.mud_band(L.R_PAD.rect, 0.32, fade=None, spatter=True)
    for z in (L.R_CAB_F, L.R_CAB_S):
        wx.plate_bottom_rust(z.rect, n=6, strength=0.5)
    wx.plate_bottom_rust(L.R_ARRAY_B.rect, n=5, strength=0.4)
    wx.rust_streak(L.R_ARRAY_B.rect[0] + 180, L.R_ARRAY_B.rect[1] + 40, 70,
                   width=3.0, strength=0.35)
    wx.rust_streak(L.R_TOWER[0] + 70, L.R_TOWER[1] + 16, 40, width=2.2, strength=0.3)
    wx.rust_streak(L.R_CAB_T.rect[0] + 260, L.R_CAB_T.rect[1] + 30, 60,
                   width=2.6, strength=0.3)

    from normals import HeightMap
    hm = HeightMap()
    x0, y0, x1, y1 = L.R_PAD.rect
    for f in (0.25, 0.5, 0.75):
        hm.line((x0 + (x1-x0)*f, y0+2), (x0 + (x1-x0)*f, y1-2), -0.5, width=2)
        hm.line((x0+2, y0 + (y1-y0)*f), (x1-2, y0 + (y1-y0)*f), -0.5, width=2)
    zx0, zy0, zx1, zy1 = L.R_CAB_F.rect
    for i in range(1, 64):
        gx = zx0 + (zx1-zx0) * i / 64
        hm.line((gx, zy0+4), (gx, zy1-4), -0.35, width=2)

    PL.finish(m, L, 'ms_radar_s3', hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
