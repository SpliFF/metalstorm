"""paint_ms_fighters_s1 — 1024² PBR set for the s1 interceptor drone.

Eight of these fly in one squad, so the scheme is deliberately LOW
CONTRAST and simple: weathered olive-grey upper surfaces, pale grey
underside, gunmetal edges and fittings. Cues: matte low-vis roundel,
2-digit drone serial on the fin-less tip panel, amber formation-light
strip on each downturned tip, gun-gas soot aft of the chin MG fairing,
team-mask panels on the upper wing shoulders (visible from the RTS
camera). Team colour lives ONLY in the team-mask R channel.
"""
from __future__ import annotations
import numpy as np

import ms_fighters_s1_layout as L        # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from PIL import Image, ImageDraw
from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade, jit,
                   BOLT_LOG, BLACKISH, TEAMGREY, STEEL, STEEL_DK,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS)

STEM = 'ms_fighters_s1'
W = 1024

# ── palette: weathered gunmetal / olive, all tones within ±15% ──
TOPC     = (86, 92, 78)          # upper-surface olive grey
TOPC_LT  = (95, 101, 86)
TOPC_DK  = (76, 82, 70)
SIDEC    = (92, 97, 92)          # chined flank
BOTC     = (105, 110, 113)       # pale grey underside
BOTC_DK  = (94, 99, 102)
GUNMET   = (74, 78, 78)          # edges, fittings, fairings
GUNMET_D = (58, 61, 62)
EO_GLASS = (30, 34, 38)
AMBER    = (232, 158, 54)
SERIAL   = '07'


# ─────────────────────────────────────────────────────── helpers
def stencil(m, xy, text, size, color, angle=0):
    """Local stencil — toolkit paint.stencil hard-codes a Linux font path;
    PL.font() has the macOS fallbacks."""
    f = PL.font(size)
    tmp = Image.new('L', (size * (len(text) + 1), int(size * 1.5)), 0)
    td = ImageDraw.Draw(tmp)
    td.text((2, 2), text, font=f, fill=255)
    bb = tmp.getbbox()
    if bb:                                     # stencil bridge cuts
        for fx in (0.34, 0.64):
            y = bb[1] + (bb[3] - bb[1]) * fx
            td.line([(0, y), (tmp.width, y)], fill=0, width=max(2, size // 12))
    if angle:
        tmp = tmp.rotate(angle, expand=True)
    m.dif.paste(Image.new('RGB', tmp.size, color), (int(xy[0]), int(xy[1])),
                tmp)


def wr(u, v, a0, b0, a1, b1):
    """World rect (zone axis-1 range, axis-2 range) → normalised px box."""
    return PL.nbox(u(a0), v(b0), u(a1), v(b1))


# ─────────────────────────────────────────────────────── upper surfaces
def paint_top(m):
    z = L.F_TOP
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TOPC, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    # spine band: a hair lighter so the blended body reads from above
    m.d.rectangle(wr(u, v, -3.4, -0.46, 2.2, 0.46), fill=TOPC_LT)
    # nose radome tone break (matched in F_SIDE / F_BOT)
    m.d.rectangle(wr(u, v, -3.45, -0.5, -2.75, 0.5), fill=TOPC_DK)

    # spanwise panel seams (constant z) — continuous across the wing root
    for wz in (-2.20, -1.35, -0.30, 0.75, 1.55):
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, TOPC)
    # chordwise seams (constant x): wing-root joint + mid-span rib
    for wx in (-2.55, -1.55, -0.85, 0.85, 1.55, 2.55):
        seam_h(m, x0 + 2, x1 - 2, int(v(wx)), TOPC)

    # dorsal intake mouth + duct roof
    m.d.rectangle(wr(u, v, -0.98, -0.30, -0.62, 0.30), fill=GUNMET_D)
    m.o.rectangle(wr(u, v, -0.98, -0.30, -0.62, 0.30),
                  fill=(AO_DEEP, R_STEEL, M_STEEL))
    m.d.rectangle(wr(u, v, -0.62, -0.35, 1.32, 0.35), fill=TOPC_DK)
    for wz in (-0.20, 0.35, 0.90):
        m.d.line([(u(wz), v(-0.34)), (u(wz), v(0.34))],
                 fill=shade(TOPC_DK, 0.86), width=2)

    # EO blister shadow ring on the deck (where the canopy would be)
    m.d.rectangle(wr(u, v, -2.90, -0.26, -1.58, 0.26),
                  outline=shade(TOPC, 0.84), width=2)

    for s in (1, -1):
        # ── team-mask panel on the upper wing shoulder ──
        panel = wr(u, v, -0.34, s * 1.06, 0.54, s * 1.68)
        PL.team_panel(m, panel, outline=shade(TOPC, 0.78))
        # symmetric two-bar device inside the panel (mirror-safe)
        pz0, pz1 = sorted((u(-0.34), u(0.54)))
        px0, px1 = sorted((v(s * 1.06), v(s * 1.68)))
        for k in (0.32, 0.60):
            by = px0 + (px1 - px0) * k
            m.t.rectangle([pz0 + 14, by, pz1 - 14, by + 4], fill=(0, 0, 0))
            m.d.rectangle([pz0 + 14, by, pz1 - 14, by + 4], fill=TOPC_DK)

        # ── matte low-vis roundel (world-circular ⇒ elliptical in atlas) ──
        r = 0.26
        cu, cv = u(0.90), v(s * 2.12)
        ru = abs(u(r) - u(0.0))
        rv = abs(v(r) - v(0.0))
        for f, col in ((1.0, shade(TOPC, 0.80)), (0.60, TOPC_LT)):
            m.d.ellipse([cu - ru * f, cv - rv * f, cu + ru * f, cv + rv * f],
                        outline=col, width=2)
        m.d.ellipse([cu - ru * 0.28, cv - rv * 0.28,
                     cu + ru * 0.28, cv + rv * 0.28], fill=shade(TOPC, 0.80))

        # ── 2-digit drone serial on the fin-less tip panel ──
        sx = v(s * 2.34)
        stencil(m, (u(0.74), sx - 14), SERIAL, 20, shade(TOPC, 0.76),
                angle=-90)

        # ── downturned tip: amber formation-light strip ──
        tz0, tz1, tx0, tx1 = L.TIP_LIGHT
        strip = PL.nbox(u(tz0), v(s * tx0), u(tz1), v(s * tx1))
        m.d.rectangle(strip, fill=shade(TOPC, 0.66))
        m.e.rectangle([strip[0] + 1, strip[1] + 1, strip[2] - 1, strip[3] - 1],
                      fill=AMBER)
        m.o.rectangle(strip, fill=(AO_BASE, R_GLASS, M_GLASS))
        # tip-fin hinge/rib line
        m.d.line([(u(0.55), v(s * 2.58)), (u(1.52), v(s * 2.58))],
                 fill=shade(TOPC, 0.86), width=2)

        # small access hatches + fasteners on the shoulder
        for wz in (-1.90, -1.20):
            m.d.rectangle(wr(u, v, wz, s * 0.70, wz + 0.45, s * 1.05),
                          outline=shade(TOPC, 0.85), width=2)
        bolts(m, [(u(-2.05 + i * 0.30), v(s * 0.60)) for i in range(4)],
              r=2, base=TOPC)

    wear_edges(m, (x0, y0, x1, y1), TOPC, 34)


# ─────────────────────────────────────────────────────── flanks
def paint_side(m):
    z = L.F_SIDE
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=SIDEC, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)
    # below the chine is the pale underside tone
    m.d.rectangle(PL.nbox(x0, v(0.90), x1, y1), fill=BOTC_DK)
    m.d.line([(x0, v(0.90)), (x1, v(0.90))], fill=shade(SIDEC, 0.86), width=2)
    # nose radome break (same station as F_TOP/F_BOT)
    m.d.rectangle(PL.nbox(x0, y0, u(-2.75), v(0.90)), fill=shade(SIDEC, 0.90))
    # panel seams
    for wz in (-2.20, -1.35, -0.30, 0.75, 1.55):
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, SIDEC)
    seam_h(m, x0 + 2, x1 - 2, int(v(1.18)), SIDEC)
    # chin MG fairing flank + gun-gas soot start
    m.d.rectangle(PL.nbox(u(-3.02), v(0.80), u(-1.98), v(0.52)), fill=GUNMET)
    m.o.rectangle(PL.nbox(u(-3.02), v(0.80), u(-1.98), v(0.52)),
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    # avionics bay hatch
    m.d.rectangle(PL.nbox(u(-1.70), v(1.14), u(-0.95), v(0.94)),
                  outline=shade(SIDEC, 0.84), width=2)
    bolts(m, [(u(-1.60 + i * 0.22), v(1.09)) for i in range(4)], r=2,
          base=SIDEC)
    # tail band + nozzle collar shadow
    m.d.rectangle(PL.nbox(u(1.62), y0, u(1.78), v(0.90)), fill=shade(SIDEC, 0.88))
    wear_edges(m, (x0, y0, x1, y1), SIDEC, 30)


# ─────────────────────────────────────────────────────── underside
def paint_bot(m):
    z = L.F_BOT
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=BOTC, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)
    m.d.rectangle(wr(u, v, -3.45, -0.5, -2.75, 0.5), fill=BOTC_DK)
    for wz in (-2.20, -1.35, -0.30, 0.75, 1.55):
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, BOTC)
    for wx in (-1.55, -0.85, 0.85, 1.55):
        seam_h(m, x0 + 2, x1 - 2, int(v(wx)), BOTC)
    # chin MG fairing underside
    m.d.rectangle(wr(u, v, -3.05, -0.20, -1.95, 0.20), fill=GUNMET)
    m.o.rectangle(wr(u, v, -3.05, -0.20, -1.95, 0.20),
                  fill=(AO_SEAM, R_STEEL, M_STEEL))
    # gear bay outlines (nose + mains)
    m.d.rectangle(wr(u, v, -1.95, -0.16, -1.45, 0.16),
                  outline=shade(BOTC, 0.82), width=2)
    for s in (1, -1):
        m.d.rectangle(wr(u, v, 0.28, s * 0.38, 0.84, s * 0.74),
                      outline=shade(BOTC, 0.82), width=2)
    wear_edges(m, (x0, y0, x1, y1), BOTC, 26)


# ─────────────────────────────────────────────────────── small cells
def paint_cells(m):
    # generic gunmetal trim (wing edges, blade antenna, MG box, body caps)
    fill(m, L.F_TRIM.rect, dif=GUNMET, ao=AO_BASE - 12, rough=R_STEEL,
         metal=M_STEEL)
    tx0, ty0, tx1, ty1 = L.F_TRIM.rect
    for i in range(5):
        m.d.line([(tx0, ty0 + 12 + i * 18), (tx1, ty0 + 12 + i * 18)],
                 fill=shade(GUNMET, 0.90), width=2)

    # dark cell: intake throat, wheel treads, gun bore
    fill(m, L.F_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_RUBBER, metal=40)

    # gear: steel struts + hubs
    fill(m, L.F_GEAR.rect, dif=STEEL, ao=AO_SEAM, rough=R_STEEL, metal=M_STEEL)
    gx0, gy0, gx1, gy1 = L.F_GEAR.rect
    m.d.ellipse([gx0 + 34, gy0 + 30, gx1 - 34, gy1 - 30], fill=STEEL_DK)
    bolts(m, [(gx0 + 46 + i * 12, (gy0 + gy1) // 2) for i in range(3)], r=2,
          base=STEEL_DK)

    # nozzle wrap: ringed heat-stained metal
    nx0, ny0, nx1, ny1 = L.F_NOZZLE
    fill(m, L.F_NOZZLE, dif=GUNMET_D, ao=AO_BASE - 24, rough=R_STEEL - 20,
         metal=M_STEEL)
    for i in range(7):
        rx = nx0 + (nx1 - nx0) * (i + 0.5) / 7
        m.d.line([(rx, ny0), (rx, ny1)], fill=shade(GUNMET_D, 1.16), width=3)
    m.d.rectangle([nx0, ny0, nx0 + (nx1 - nx0) * 0.22, ny1],
                  fill=shade(GUNMET_D, 0.78))

    # burner cap: sooted throat with a faint amber core
    bx0, by0, bx1, by1 = L.F_BURNER.rect
    fill(m, L.F_BURNER.rect, dif=(34, 32, 31), ao=AO_DEEP, rough=200, metal=60)
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    m.d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=(20, 19, 19))
    m.e.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=shade(AMBER, 0.42))

    # MG barrel wrap: dark gun steel with a soot tip
    rx0, ry0, rx1, ry1 = L.F_BARREL
    fill(m, L.F_BARREL, dif=GUNMET_D, ao=AO_SEAM, rough=R_STEEL, metal=M_STEEL)
    m.d.rectangle([rx0, ry0, rx0 + (rx1 - rx0) * 0.35, ry1], fill=(30, 29, 29))

    # EO sensor blister: faceted fairing + dark window (NO canopy glass)
    z = L.F_BLIST
    u, v = PL.zone_fns(z)
    bx0, by0, bx1, by1 = z.rect
    fill(m, z.rect, dif=shade(TOPC, 0.94), ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)
    win = PL.nbox(u(-2.72), v(1.32), u(-1.86), v(1.16))
    m.d.rectangle(win, fill=EO_GLASS, outline=GUNMET_D, width=2)
    m.o.rectangle(win, fill=(AO_SEAM, R_GLASS, M_GLASS))
    m.d.line([(bx0, v(1.36)), (bx1, v(1.36))], fill=shade(TOPC, 0.84), width=2)
    bolts(m, [(u(-2.66 + i * 0.24), v(1.42)) for i in range(4)], r=2,
          base=TOPC)


# ─────────────────────────────────────────────────────── assembly
def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_top(m)
    paint_side(m)
    paint_bot(m)
    paint_cells(m)

    # ── weathering: sun-bleached deck, exhaust soot, gun gas ──
    wx = PL.standard_weather(m, L, ground_rects=(L.F_GEAR.rect,),
                             side_zones=(L.F_SIDE,), seed=41,
                             mud=0.28, grime=0.45, rust_fraction=0.4)
    u, v = PL.zone_fns(L.F_TOP)
    ub, vb = PL.zone_fns(L.F_BOT)
    us, vs = PL.zone_fns(L.F_SIDE)
    # gun-gas soot streaking aft of the chin MG fairing
    wx.soot_patch(PL.nbox(ub(-2.60), vb(-0.34), ub(-0.60), vb(0.34)), 0.55)
    wx.soot_patch(PL.nbox(us(-2.40), vs(0.86), us(-1.10), vs(0.50)), 0.42)
    # nozzle heat wash on the tail deck / underside
    wx.soot_patch(PL.nbox(u(1.45), v(-0.42), u(2.30), v(0.42)), 0.40)
    wx.soot_patch(PL.nbox(ub(1.45), vb(-0.42), ub(2.30), vb(0.42)), 0.35)
    wx.soot_patch(L.F_NOZZLE, 0.6)
    # dust film on the upper surfaces (thin — 8 of these, keep it flat)
    wx.mud_band(L.F_TOP.rect, 0.16, fade=None, spatter=False)

    from normals import HeightMap
    hm = HeightMap()
    # proud fittings: intake duct roof, EO blister deck ring, team panels
    hm.rect(PL.nbox(u(-0.62), v(-0.35), u(1.32), v(0.35)), 0.35)
    hm.rect(PL.nbox(u(-2.90), v(-0.26), u(-1.58), v(0.26)), 0.30)
    for s in (1, -1):
        hm.rect(PL.nbox(u(-0.34), v(s * 1.06), u(0.54), v(s * 1.68)), 0.22)
    hm.rect(PL.nbox(ub(-3.05), vb(-0.20), ub(-1.95), vb(0.20)), 0.40)
    nx0, ny0, nx1, ny1 = L.F_NOZZLE
    for i in range(7):
        rx = nx0 + (nx1 - nx0) * (i + 0.5) / 7
        hm.line((rx, ny0), (rx, ny1), 0.45, width=3)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
