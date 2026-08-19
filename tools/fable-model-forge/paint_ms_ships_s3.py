"""paint_ms_ships_s3 — 2048² PBR set for the s3 cruiser.

Order register: formal, uniform, NUMBERED.  Haze-grey topsides with the
tumblehome wedge held a step darker so the superstructure reads as one
mass; dark non-skid decks; black boot-top over oxide anti-foul; hull
number and draft-mark stencils; team colour ONLY on three small ID
panels (paintlib.team_panel with a hull-matched base).

Emissive: warm bridge windows, nav lights (red port / green starboard),
masthead light — plus the ONE licensed cyan: the railgun's capacitor
rings (fable_battleship railgun-family precedent).

Weathering: scupper rust streaks every ~6 m, waterline scum band, soot
and scorch around the VLS lids and the CIWS muzzles, salt haze on the
topsides.
"""
from __future__ import annotations
import numpy as np

import ms_ships_s3_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, YELLOW, BLACKISH, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, M_ARMOR, M_STEEL)
import paintlib as PL

W = 2048

HAZE = (146, 151, 156)          # topsides
HAZE_DK = (124, 129, 135)       # the wedge — a step darker so it reads
HAZE_LT = (158, 163, 167)
DECKC = (96, 100, 103)            # main deck non-skid
ROOFC = (86, 90, 94)
ANTIFOUL = (94, 54, 46)
BOOT = (28, 29, 32)
STEELDK = (56, 58, 62)
GUNMET = (112, 116, 121)
TEAMBASE = (132, 136, 141)
WHITEISH = (206, 208, 202)
CYAN = (96, 226, 255)           # railgun capacitor rings ONLY
WARM = (255, 192, 124)
NAV_RED = (200, 40, 34)
NAV_GRN = (40, 190, 90)

HULLNO = 'C 317'


# ── hull ─────────────────────────────────────────────────────────────────

def paint_hull(m):
    z = L.S_HULL_SIDE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=HAZE, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR)

    # strake seams (horizontal) + frame lines (every 3 m)
    for wy in (3.2, 1.9, -1.1, -2.3):
        seam_h(m, x0, x1, int(v(wy)), HAZE)
    for wz in np.arange(-27.0, 27.5, 3.0):
        seam_v(m, int(u(wz)), y0 + 2, int(v(-3.3)), HAZE, hi=False)

    # tumblehome knuckle: a shadow line just under the deck edge
    m.d.rectangle([x0, v(4.05), x1, v(3.90)], fill=shade(HAZE, 0.86))

    # boot-top band straddling Y=0, anti-foul below
    m.d.rectangle([x0, v(L.BOOT_TOP[1]), x1, v(L.BOOT_TOP[0])], fill=BOOT)
    m.o.rectangle([x0, v(L.BOOT_TOP[1]), x1, v(L.BOOT_TOP[0])],
                  fill=(AO_BASE - 14, 195, 40))
    m.d.rectangle([x0, v(L.BOOT_TOP[0]), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(L.BOOT_TOP[0]), x1, y1], fill=(AO_BASE - 18, 215, 25))

    # hull number stencil, both sides share this projection
    fh = PL.font(70)
    for wz in (-22.5, 20.0):
        m.d.text((u(wz) + 3, v(3.3) + 3), HULLNO, font=fh,
                 fill=shade(HAZE, 0.55))
        m.d.text((u(wz), v(3.3)), HULLNO, font=fh, fill=WHITEISH)

    # draft marks up the stem and at the transom
    fm = PL.font(26)
    for wz, sgn in ((-25.2, 1), (25.6, -1)):
        for i, wy in enumerate((-2.6, -1.9, -1.2, -0.5)):
            m.d.text((u(wz), v(wy)), f'{32 - i * 6}', font=fm, fill=WHITEISH)

    # anchor hawse + chain run down from the fo'c'sle
    m.d.ellipse([u(-24.6) - 13, v(3.1) - 10, u(-24.6) + 13, v(3.1) + 10],
                fill=STEELDK, outline=shade(HAZE, 0.6), width=2)
    for i in range(16):
        cx = u(-24.6) + 5 + i * 4
        cy = v(3.1) + 3 + i * 2.1
        m.d.ellipse([cx - 3, cy - 2, cx + 3, cy + 2], outline=STEELDK,
                    width=2)

    # scuppers (rust origins painted as small dark slots)
    for wz in np.arange(-21.0, 25.0, 6.0):
        m.d.rectangle([u(wz) - 6, v(3.55), u(wz) + 6, v(3.35)], fill=STEELDK)

    bolts(m, [(u(wz), v(wy)) for wz in (-16.0, -2.0, 12.0)
              for wy in (2.6, 1.0)], base=HAZE)
    wear_edges(m, (x0, y0, x1, int(v(0.4))), HAZE, 70)

    # belly
    fill(m, L.S_BELLY.rect, dif=shade(ANTIFOUL, 0.9), ao=AO_BASE - 24,
         rough=225, metal=15)

    # bow + transom end faces
    for zn, is_stern in ((L.S_BOW, False), (L.S_STERN, True)):
        bx0, by0, bx1, by1 = zn.rect
        uu, vv = PL.zone_fns(zn)
        fill(m, (bx0, by0, bx1, by1), dif=HAZE, ao=AO_BASE - 6,
             rough=R_ARMOR, metal=M_ARMOR)
        m.d.rectangle([bx0, vv(L.BOOT_TOP[1]), bx1, vv(L.BOOT_TOP[0])],
                      fill=BOOT)
        m.d.rectangle([bx0, vv(L.BOOT_TOP[0]), bx1, by1], fill=ANTIFOUL)
        if is_stern:
            ft = PL.font(46)
            m.d.text((uu(-1.9), vv(3.4)), HULLNO, font=ft, fill=WHITEISH)
            PL.team_panel(m, PL.nbox(uu(-0.9), vv(2.6), uu(0.9), vv(1.6)),
                          outline=HAZE, base=TEAMBASE)
        wear_edges(m, (bx0, by0, bx1, int(vv(0.3))), HAZE, 40)


def paint_deck(m):
    zn = L.S_DECK
    x0, y0, x1, y1 = zn.rect
    u, v = PL.zone_fns(zn)
    fill(m, (x0, y0, x1, y1), dif=DECKC, ao=AO_BASE - 12, rough=205,
         metal=90)
    # plate seams (tone-on-tone: the deck maps to big quads)
    for wz in np.arange(-26.0, 27.0, 2.6):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, DECKC, hi=False)
    for wx in (-2.6, 0.0, 2.6):
        m.d.line([(x0 + 2, v(wx)), (x1 - 2, v(wx))],
                 fill=shade(DECKC, 0.88), width=2)
    # painted keep-clear box around the VLS block + gun arcs
    m.d.rectangle([u(L.VLS_Z[0]) - 10, v(-3.2), u(L.VLS_Z[1]) + 10, v(3.2)],
                  outline=jit(YELLOW, 6), width=3)
    m.d.arc([u(-24.0), v(-4.6), u(-16.0), v(4.6)], 200, 340,
            fill=shade(DECKC, 0.7), width=3)
    ft = PL.font(34)
    m.d.text((u(-6.0), v(-1.0)), 'DANGER  BLAST', font=ft, fill=jit(YELLOW, 6))
    wear_edges(m, (x0, y0, x1, y1), DECKC, 90)


# ── the wedge ────────────────────────────────────────────────────────────

def paint_wedge(m):
    for zn, axis_is_z in ((L.S_DH_SIDE, True), (L.S_DH_END, False)):
        x0, y0, x1, y1 = zn.rect
        u, v = PL.zone_fns(zn)
        fill(m, (x0, y0, x1, y1), dif=HAZE_DK, ao=AO_BASE - 8, rough=R_STEEL,
             metal=M_STEEL)
        # plated panel grid — low contrast (large quads, impostor baker)
        for wy in (5.2, 6.6, 7.9, 10.2):
            seam_h(m, x0, x1, int(v(wy)), HAZE_DK)
        span = (-6.5, 14.5) if axis_is_z else (-3.6, 3.6)
        for wc in np.arange(span[0] + 1.0, span[1], 2.4):
            seam_v(m, int(u(wc)), y0 + 3, y1 - 3, HAZE_DK, hi=False)
        wear_edges(m, (x0, y0, x1, y1), HAZE_DK, 45)

    # side face detail: hatches, boat recess mouth, ID panel, ladder marks
    zn = L.S_DH_SIDE
    u, v = PL.zone_fns(zn)
    for wz in (-1.2, 5.0, 11.4):                      # weathertight doors
        m.d.rectangle(PL.nbox(u(wz) - 12, v(6.3), u(wz) + 12, v(4.35)),
                      fill=shade(HAZE_DK, 0.78),
                      outline=shade(HAZE_DK, 0.6), width=2)
    m.d.rectangle(PL.nbox(u(1.4), v(6.4), u(5.6), v(4.9)),
                  fill=shade(HAZE_DK, 0.7))            # boat recess mouth
    PL.team_panel(m, PL.nbox(u(7.6), v(6.9), u(9.1), v(5.7)), outline=HAZE_DK,
                  base=TEAMBASE)
    fn = PL.font(40)
    m.d.text((u(-3.4), v(7.6)), HULLNO, font=fn, fill=shade(WHITEISH, 0.9))

    # forward face: bridge front plate + chin sensor outline
    zn = L.S_DH_END
    u, v = PL.zone_fns(zn)
    m.d.rectangle(PL.nbox(u(-1.3), v(7.8), u(1.3), v(7.0)),
                  fill=shade(HAZE_DK, 0.72))
    PL.team_panel(m, PL.nbox(u(-0.7), v(5.6), u(0.7), v(4.6)), outline=HAZE_DK,
                  base=TEAMBASE)

    # bridge window belt — dark glass with a warm instrument glow
    for zn in (L.S_WIN_SIDE, L.S_WIN_END):
        x0, y0, x1, y1 = zn.rect
        fill(m, (x0, y0, x1, y1), dif=(38, 42, 46), ao=AO_SEAM, rough=60,
             metal=120)
        PL.glass_rect(m, (x0 + 2, y0 + 8, x1 - 2, y1 - 10), outline=HAZE_DK)
        m.e.rectangle([x0 + 6, y0 + 18, x1 - 6, y1 - 20], fill=WARM)
        # mullions
        for i in range(1, 12):
            gx = x0 + (x1 - x0) * i / 12
            m.d.line([(gx, y0 + 4), (gx, y1 - 4)], fill=shade(HAZE_DK, 0.6),
                     width=3)
            m.e.line([(gx, y0 + 4), (gx, y1 - 4)], fill=(0, 0, 0), width=3)

    # roof: dark non-skid, hatch squares, mast step ring
    zn = L.S_DH_ROOF
    x0, y0, x1, y1 = zn.rect
    u, v = PL.zone_fns(zn)
    fill(m, (x0, y0, x1, y1), dif=ROOFC, ao=AO_BASE - 16, rough=215, metal=70)
    for wz in np.arange(-4.0, 12.5, 2.2):
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, ROOFC, hi=False)
    m.d.ellipse([u(L.MAST_Z) - 26, v(-1.1), u(L.MAST_Z) + 26, v(1.1)],
                outline=shade(ROOFC, 0.7), width=3)
    m.d.rectangle([u(9.6), v(-1.6), u(12.4), v(1.6)],
                  outline=jit(YELLOW, 5), width=3)     # CIWS arc marking


# ── VLS ──────────────────────────────────────────────────────────────────

def paint_vls(m):
    zn = L.S_VLS_TOP
    x0, y0, x1, y1 = zn.rect
    u, v = PL.zone_fns(zn)
    fill(m, (x0, y0, x1, y1), dif=STEELDK, ao=AO_DEEP, rough=200, metal=100)
    z0, z1 = L.VLS_Z
    cw = (z1 - z0) / L.VLS_COLS
    chh = (L.VLS_HX * 2) / L.VLS_ROWS
    ft = PL.font(22)
    for i in range(L.VLS_COLS):
        for j in range(L.VLS_ROWS):
            zc = z0 + (i + 0.5) * cw
            xc = -L.VLS_HX + (j + 0.5) * chh
            b = PL.nbox(u(zc - cw / 2 + 0.10), v(xc - chh / 2 + 0.10),
                        u(zc + cw / 2 - 0.10), v(xc + chh / 2 - 0.10))
            m.d.rectangle(b, fill=GUNMET, outline=shade(GUNMET, 0.65),
                          width=3)
            # lid split line + hinge bar (tone-on-tone)
            m.d.line([(b[0] + 4, (b[1] + b[3]) / 2),
                      (b[2] - 4, (b[1] + b[3]) / 2)],
                     fill=shade(GUNMET, 0.78), width=3)
            m.d.rectangle([b[0] + 4, b[1] + 4, b[2] - 4, b[1] + 10],
                          fill=shade(GUNMET, 0.7))
            m.d.text((b[0] + 8, b[3] - 26), f'{i + 1}{chr(65 + j)}', font=ft,
                     fill=shade(GUNMET, 0.55))
            if (i, j) in L.VLS_OPEN:                    # burnt-out open cell
                m.d.rectangle(b, fill=(20, 20, 22))
                m.o.rectangle(b, fill=(AO_DEEP, 235, 20))

    zn = L.S_VLS_SIDE
    x0, y0, x1, y1 = zn.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HAZE, 0.86), ao=AO_BASE - 12,
         rough=R_STEEL, metal=M_STEEL)
    PL.hazard_band(m, (x0 + 4, y1 - 16, x1 - 4, y1 - 4))


# ── weapons, mast, small cells ───────────────────────────────────────────

def paint_weapons(m):
    # railgun turret
    for zn, base in ((L.S_TUR, GUNMET), (L.S_TUR_SIDE, HAZE)):
        x0, y0, x1, y1 = zn.rect
        fill(m, (x0, y0, x1, y1), dif=base, ao=AO_BASE - 8, rough=R_ARMOR,
             metal=M_ARMOR)
        for i in range(1, 4):
            seam_h(m, x0, x1, int(y0 + (y1 - y0) * i / 4), base)
        wear_edges(m, (x0, y0, x1, y1), base, 45)
    zn = L.S_TUR_SIDE
    u, v = PL.zone_fns(zn)
    ft = PL.font(52)
    m.d.text((u(-0.5), v(1.6)), '1', font=ft, fill=WHITEISH)
    m.d.rectangle(PL.nbox(u(-2.1), v(0.1), u(2.1), v(-0.15)), fill=STEELDK)

    # CIWS
    x0, y0, x1, y1 = L.S_TUR2.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GUNMET, 0.86), ao=AO_BASE - 10,
         rough=R_STEEL, metal=M_STEEL)
    for i in range(1, 4):
        seam_h(m, x0, x1, int(y0 + (y1 - y0) * i / 4), shade(GUNMET, 0.86))

    # railgun tube + the two accelerator rails
    fill(m, L.R_BARREL, dif=shade(GUNMET, 0.8), ao=AO_BASE - 12, rough=150,
         metal=200)
    bx0, by0, bx1, by1 = L.R_BARREL
    for f in (0.25, 0.5, 0.75):
        yy = int(by0 + (by1 - by0) * f)
        m.d.rectangle([bx0, yy - 3, bx1, yy + 3], fill=shade(GUNMET, 0.62))

    # CYAN capacitor rings — the railgun family's licensed exception
    cx0, cy0, cx1, cy1 = L.R_CAP
    fill(m, L.R_CAP, dif=(46, 58, 66), ao=AO_SEAM, rough=110, metal=180)
    m.e.rectangle([cx0 + 4, cy0 + 10, cx1 - 4, cy1 - 10], fill=CYAN)
    for i in range(1, 8):
        yy = int(cy0 + (cy1 - cy0) * i / 8)
        m.e.line([(cx0, yy), (cx1, yy)], fill=(0, 0, 0), width=4)

    # gatling barrels, mast, rails, pipework
    fill(m, L.R_GAT, dif=STEELDK, ao=AO_BASE - 16, rough=130, metal=210)
    fill(m, L.R_MAST, dif=shade(HAZE, 0.9), ao=AO_BASE - 10, rough=175,
         metal=150)
    fill(m, L.R_RAIL, dif=shade(HAZE, 1.05), ao=AO_BASE - 8, rough=170,
         metal=150)
    fill(m, L.R_PIPE, dif=GUNMET, ao=AO_BASE - 12, rough=165, metal=170)

    # radar bar: dark slotted face, warm masthead light
    x0, y0, x1, y1 = L.S_RADAR.rect
    fill(m, (x0, y0, x1, y1), dif=(70, 74, 78), ao=AO_BASE - 14, rough=185,
         metal=120)
    for i in range(1, 22):
        gx = x0 + (x1 - x0) * i / 22
        m.d.line([(gx, y0 + 40), (gx, y1 - 40)], fill=(46, 48, 52), width=4)
    m.d.rectangle([x0, y0, x1, y0 + 22], fill=shade(HAZE, 0.9))
    m.e.rectangle([(x0 + x1) // 2 - 8, y0 + 4, (x0 + x1) // 2 + 8, y0 + 18],
                  fill=WHITEISH)

    # flat greeble cells (huge windows -> flat colour everywhere)
    fill(m, L.S_DARK.rect, dif=STEELDK, ao=AO_DEEP, rough=205, metal=60)
    fill(m, L.S_GREY.rect, dif=shade(HAZE_DK, 0.95), ao=AO_BASE - 10,
         rough=R_STEEL, metal=M_STEEL)
    fill(m, L.S_GREEB.rect, dif=shade(GUNMET, 0.9), ao=AO_BASE - 14,
         rough=190, metal=140)
    fill(m, L.S_HAZ.rect, dif=jit(YELLOW, 5), ao=AO_BASE - 8, rough=180,
         metal=110)
    PL.hazard_band(m, (L.S_HAZ.rect[0] + 4, L.S_HAZ.rect[1] + 40,
                       L.S_HAZ.rect[2] - 4, L.S_HAZ.rect[3] - 40), step=16)
    # nav lights: red to PORT (+x), green to STARBOARD (-x)
    for zn, col in ((L.S_NAV_P, NAV_RED), (L.S_NAV_S, NAV_GRN)):
        x0, y0, x1, y1 = zn.rect
        fill(m, (x0, y0, x1, y1), dif=col, ao=AO_BASE, rough=70, metal=40)
        m.e.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6], fill=col)


# ── assemble ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_hull(m)
    paint_deck(m)
    paint_wedge(m)
    paint_vls(m)
    paint_weapons(m)

    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.S_HULL_SIDE, L.S_DH_SIDE),
                             seed=90210, mud=0.18, grime=0.5,
                             rust_fraction=0.55)
    u, v = PL.zone_fns(L.S_HULL_SIDE)
    for wz in np.arange(-21.0, 25.0, 6.0):          # scupper rust runs
        wx.rust_streak(u(wz), v(3.3), 46 + (int(wz) % 3) * 12, width=3.2,
                       strength=0.55)
    for wz in (-24.4, -16.0, 2.0, 18.0):            # deck-fitting streaks
        wx.rust_streak(u(wz), v(3.9), 30, width=2.4, strength=0.4)
    wx.mud_band((L.S_HULL_SIDE.rect[0], int(v(0.85)),
                 L.S_HULL_SIDE.rect[2], int(v(-0.5))), 0.55, fade=None,
                spatter=True)                        # waterline salt/scum
    wx.mud_band(L.S_DECK.rect, 0.25, fade=None, spatter=True)
    wx.soot_patch(L.S_VLS_TOP.rect, 0.5)             # VLS efflux scorch
    wx.soot_patch(L.R_GAT, 0.55)                     # CIWS muzzle soot
    wx.soot_patch(L.S_DH_ROOF.rect, 0.28)
    wx.oily(L.S_DECK.rect, 0.22)

    PL.finish(m, L, 'ms_ships_s3', wx=wx)


if __name__ == '__main__':
    paint_all()
