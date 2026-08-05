"""paint_ms_rail_platform — 2048² PBR set for ms_rail_platform.

Civic-industrial terminus read: stained concrete slab and deck with
expansion joints, white platform-edge safety line + tactile strip,
grey-brown ballast with rail-line oil dribble, rust-webbed rails with a
bright worn head, striped canvas canopy (tan/slate) over a steel
colonnade, kiosk with glazed band, mustard loading crane with hazard
tip and lattice jib, red buffer beam, black signal head (red aspect dim,
green aspect lit — the only emissive on the model).  Team colour: fascia
band + crane house square (mask only, never baked).  Weathering: mud at
the slab foot and ballast shoulders, rust streaks off the fascia and
buffer, soot at the approach end, oil on the deck under the crane.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageFilter

import ms_rail_platform_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   STEEL_DK, GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS, RNG)

W = 2048
CONCRETE = (148, 146, 140)
CONC_DK = (118, 116, 110)
BALLAST = (92, 87, 80)
TIMBER = (46, 40, 34)
RAILWEB = (96, 68, 48)
RAILHEAD = (186, 190, 196)
TRIMS = (58, 61, 66)
CANV_A = (176, 158, 122)      # civilian tan stripe
CANV_B = (66, 76, 84)         # slate stripe
KIOSKW = (124, 118, 104)
CRANEY = (172, 138, 46)       # mustard crane
BUFFRED = (128, 42, 34)


def u_of(zone, wz):
    return zone.uv((0, 0, wz))[0] * W


def v_of(zone, wy):
    return zone.uv((0, wy, 0))[1] * W


# ── concrete: slab sides/ends + deck ─────────────────────────────────────

def paint_concrete(m):
    for zone in (L.P_SIDE, L.P_END):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 6, rough=205,
             metal=8)
        # coping band along the top of the wall
        cv = int(v_of(zone, 0.92))
        m.d.rectangle([x0, y0, x1, cv], fill=shade(CONCRETE, 1.06))
        seam_h(m, x0 + 2, x1 - 2, cv, CONCRETE, hi=False)
        # expansion joints every ~3 m
        n = 8 if zone is L.P_SIDE else 2
        for fx in np.linspace(0.11, 0.89, n):
            seam_v(m, int(x0 + (x1 - x0) * fx), y0 + 2, y1 - 2, CONCRETE,
                   hi=False)
        # staining blocks
        for _ in range(n * 2):
            bx = x0 + RNG.random() * (x1 - x0 - 60)
            by = y0 + RNG.random() * (y1 - y0 - 20)
            m.d.rectangle([bx, by, bx + 40 + RNG.random() * 60, by + 18],
                          fill=jit(shade(CONCRETE, 0.93), 4))
        wear_edges(m, (x0, y0, x1, y1), CONCRETE, 40)

    zone = L.P_DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CONCRETE, ao=AO_BASE - 4, rough=210,
         metal=8)

    def vd(wx):                       # deck v maps world x
        return zone.uv((wx, 0, 0))[1] * W

    # stain patches
    for _ in range(26):
        bx = x0 + RNG.random() * (x1 - x0 - 90)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.polygon([(bx, by + 12), (bx + 66, by), (bx + 84, by + 40),
                     (bx + 20, by + 52)], fill=jit(shade(CONCRETE, 0.95), 3))
    # expansion joint grid: every 3 m along z, two lines across x
    for wz in np.arange(-9.0, 10.0, 3.0):
        seam_v(m, int(u_of(zone, wz)), y0 + 2, y1 - 2, CONCRETE, hi=False)
    for wx in (-4.0, -2.0):
        seam_h(m, x0 + 2, x1 - 2, int(vd(wx)), CONCRETE, hi=False)
    # tactile strip + white safety line along the track edge (x → 0)
    ty0, ty1 = int(vd(-0.95)), int(vd(-0.6))
    m.d.rectangle([x0, ty0, x1, ty1], fill=shade(CONCRETE, 0.88))
    for gx in range(x0 + 6, x1 - 6, 12):
        m.d.ellipse([gx - 2, (ty0 + ty1) // 2 - 2, gx + 2,
                     (ty0 + ty1) // 2 + 2], fill=shade(CONCRETE, 0.78))
    ly0, ly1 = int(vd(-0.55)), int(vd(-0.32))
    m.d.rectangle([x0, ly0, x1, ly1], fill=(212, 210, 200))
    m.o.rectangle([x0, ly0, x1, ly1], fill=(AO_BASE, 195, 8))
    # coping shadow at the very edge
    m.d.rectangle([x0, int(vd(-0.14)), x1, y1], fill=CONC_DK)
    wear_edges(m, (x0, y0, x1, y1), CONCRETE, 55)


# ── track: ballast, sleepers (3D use P_DARK), rails ──────────────────────

def paint_track(m):
    for zone in (L.P_BAL,):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=BALLAST, ao=AO_BASE - 14, rough=225,
             metal=6)
        # gravel speckle
        for _ in range(4200):
            gx = x0 + RNG.random() * (x1 - x0)
            gy = y0 + RNG.random() * (y1 - y0)
            m.d.point((gx, gy), fill=jit(BALLAST, 26))
        # darker compacted strips under the rail lines (v maps world x)
        for rx in (L.TRACK_X - L.GAUGE_X, L.TRACK_X + L.GAUGE_X):
            rv0 = zone.uv((rx - 0.35, 0, 0))[1] * W
            rv1 = zone.uv((rx + 0.35, 0, 0))[1] * W
            m.d.rectangle([x0, min(rv0, rv1), x1, max(rv0, rv1)],
                          fill=jit(shade(BALLAST, 0.82), 3))
    x0, y0, x1, y1 = L.P_BALS.rect
    fill(m, (x0, y0, x1, y1), dif=shade(BALLAST, 0.94), ao=AO_BASE - 16,
         rough=228, metal=6)
    for _ in range(1400):
        gx = x0 + RNG.random() * (x1 - x0)
        gy = y0 + RNG.random() * (y1 - y0)
        m.d.point((gx, gy), fill=jit(BALLAST, 24))

    # rail web (sides): rusty steel with fishplates
    zone = L.P_RAIL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=RAILWEB, ao=AO_BASE - 18, rough=185,
         metal=90)
    for wz in np.arange(-10.8, 11.0, 3.6):
        fu = int(u_of(zone, wz))
        m.d.rectangle([fu - 10, y0 + 8, fu + 10, y1 - 6],
                      fill=shade(RAILWEB, 1.14))
        bolts(m, [(fu - 5, (y0 + y1) // 2), (fu + 5, (y0 + y1) // 2)],
              base=RAILWEB)
    # rail head top: bright worn running surface
    x0, y0, x1, y1 = L.P_RAILT.rect
    fill(m, (x0, y0, x1, y1), dif=RAILHEAD, ao=AO_BASE, rough=60, metal=225)
    for _ in range(60):
        sx = x0 + RNG.random() * (x1 - x0 - 30)
        sy = y0 + RNG.random() * (y1 - y0)
        m.d.line([(sx, sy), (sx + 24, sy)], fill=shade(RAILHEAD, 1.06),
                 width=1)


# ── canopy: striped top, ribbed underside, fascia with team band ─────────

def paint_canopy(m):
    zone = L.P_CAN_TOP
    x0, y0, x1, y1 = zone.rect
    stripe_w = 1.27                   # metres along z
    zlo, zhi = zone.win[0]
    k = 0
    wz = zlo
    while wz < zhi:
        su0 = u_of(zone, wz)
        su1 = u_of(zone, min(zhi, wz + stripe_w))
        c = CANV_A if k % 2 == 0 else CANV_B
        m.d.rectangle([su0, y0, su1, y1], fill=c)
        m.o.rectangle([su0, y0, su1, y1], fill=(AO_BASE - 6, 215, 12))
        m.d.line([(su1, y0), (su1, y1)], fill=shade(c, 0.8), width=2)
        k += 1
        wz += stripe_w
    # canvas sag shading between the four column bays
    for cz in L.COLS:
        cu = int(u_of(zone, cz))
        m.o.line([(cu, y0), (cu, y1)], fill=(AO_BASE, 215, 12), width=6)
    wear_edges(m, (x0, y0, x1, y1), CANV_A, 40)

    zone = L.P_CAN_BOT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(TRIMS, 1.15), ao=AO_BASE - 22,
         rough=180, metal=120)
    for cz in np.arange(-9.8, 4.6, 1.8):     # purlins
        cu = int(u_of(zone, cz))
        m.d.rectangle([cu - 3, y0 + 2, cu + 3, y1 - 2],
                      fill=shade(TRIMS, 0.8))
        m.o.rectangle([cu - 3, y0 + 2, cu + 3, y1 - 2],
                      fill=(AO_SEAM, R_STEEL, M_STEEL))

    zone = L.P_CAN_EDGE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CANV_B, ao=AO_BASE - 8, rough=200,
         metal=20)
    seam_h(m, x0 + 2, x1 - 2, y0 + 8, CANV_B, hi=False)
    # faction team band along the fascia (mask; diffuse stays neutral)
    m.t.rectangle([x0 + 8, y0 + 14, x1 - 8, y1 - 10], fill=(255, 0, 0))
    m.d.rectangle([x0 + 8, y0 + 14, x1 - 8, y1 - 10], fill=TEAMGREY)
    bolts(m, [(x0 + 30 + i * (x1 - x0 - 60) / 11, y1 - 14)
              for i in range(12)], base=CANV_B)


# ── kiosk, generic trim/dark/lamp/crate cells ────────────────────────────

def paint_kiosk(m):
    zone = L.P_KIOSK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=KIOSKW, ao=AO_BASE - 8, rough=195,
         metal=25)
    # glazed band (world y 2.35..2.95)
    gy0, gy1 = int(v_of(zone, 2.95)), int(v_of(zone, 2.35))
    m.d.rectangle([x0 + 8, gy0, x1 - 8, gy1], fill=GLASS)
    m.o.rectangle([x0 + 8, gy0, x1 - 8, gy1],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    for fx in (0.28, 0.52, 0.76):
        seam_v(m, int(x0 + (x1 - x0) * fx), gy0, gy1, KIOSKW, hi=False)
    # counter lip + base skirt
    m.d.rectangle([x0, gy1 + 4, x1, gy1 + 12], fill=shade(KIOSKW, 0.78))
    m.d.rectangle([x0, int(v_of(zone, 1.45)), x1, y1],
                  fill=shade(KIOSKW, 0.85))
    # door leaf on the right
    dv0, dv1 = int(v_of(zone, 3.0)), y1 - 4
    m.d.rectangle([x1 - 90, dv0, x1 - 30, dv1], fill=shade(TRIMS, 1.05),
                  outline=shade(KIOSKW, 0.6), width=3)
    m.d.ellipse([x1 - 44, (dv0 + dv1) // 2 - 4, x1 - 36,
                 (dv0 + dv1) // 2 + 4], fill=BLACKISH)
    wear_edges(m, (x0, y0, x1, y1), KIOSKW, 40)


def paint_cells(m):
    fill(m, L.P_DARK.rect, dif=TIMBER, ao=AO_DEEP, rough=215, metal=15)
    x0, y0, x1, y1 = L.P_TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=TRIMS, ao=AO_BASE - 10, rough=170,
         metal=140)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, TRIMS, hi=False)
    # lamp cell: dark housing (unlit — emissive is signal-only per spec)
    x0, y0, x1, y1 = L.P_LAMP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(TRIMS, 0.85), ao=AO_BASE - 12,
         rough=150, metal=150)
    m.d.rectangle([x0 + 20, (y0 + y1) // 2 - 8, x1 - 20,
                   (y0 + y1) // 2 + 8], fill=GLASS)
    m.o.rectangle([x0 + 20, (y0 + y1) // 2 - 8, x1 - 20,
                   (y0 + y1) // 2 + 8], fill=(AO_BASE, R_GLASS, M_GLASS))
    # crate cell: olive freight + straps (train language)
    x0, y0, x1, y1 = L.P_CRATE.rect
    fill(m, (x0, y0, x1, y1), dif=(96, 100, 72), ao=AO_BASE - 6, rough=200,
         metal=30)
    m.d.rectangle([x0 + 20, (y0 + y1) // 2 - 10, x1 - 20,
                   (y0 + y1) // 2 + 10], fill=(70, 72, 52))
    for fx in (0.3, 0.7):
        sx = x0 + (x1 - x0) * fx
        m.d.rectangle([sx - 4, y0 + 4, sx + 4, y1 - 4], fill=(48, 46, 40))
    bolts(m, [(x0 + 16, y0 + 16), (x1 - 16, y0 + 16),
              (x0 + 16, y1 - 16), (x1 - 16, y1 - 16)], base=(96, 100, 72))


# ── crane / hook / buffer / signal ───────────────────────────────────────

def paint_crane(m):
    zone = L.P_CRANE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=CRANEY, ao=AO_BASE - 8, rough=165,
         metal=120)

    def cu(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def cv(wy):
        return zone.uv((0, wy, 0))[1] * W

    # jib band: lattice diagonals, hazard chevrons at the tip
    jv0, jv1 = int(cv(4.31)), int(cv(3.89))
    for wx in np.arange(-1.6, 4.4, 0.75):
        a0, a1 = cu(wx), cu(wx + 0.75)
        m.d.line([(a0, jv1), (a1, jv0)], fill=shade(CRANEY, 0.62), width=3)
        m.d.line([(a0, jv0), (a1, jv1)], fill=shade(CRANEY, 0.62), width=3)
    step = 22
    tip0, tip1 = int(cu(4.4)), int(cu(5.75))
    for i in range((tip1 - tip0) // step + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(tip0 + i * step, jv0), (tip0 + (i + 1) * step, jv0),
                     (tip0 + (i + 1) * step - 10, jv1),
                     (tip0 + i * step - 10, jv1)], fill=c)
    seam_h(m, x0 + 2, x1 - 2, jv0, CRANEY, hi=False)
    seam_h(m, x0 + 2, x1 - 2, jv1, CRANEY, hi=False)
    # mast rungs
    mu0, mu1 = int(cu(-0.22)), int(cu(0.22))
    for wy in np.arange(0.6, 4.3, 0.4):
        m.d.line([(mu0 + 2, cv(wy)), (mu1 - 2, cv(wy))],
                 fill=shade(CRANEY, 0.7), width=2)
    # house: panel seams, glazed front slit, team square
    hv0, hv1 = int(cv(1.06)), int(cv(0.26))
    hu0, hu1 = int(cu(-0.4)), int(cu(1.1))
    m.d.rectangle([hu0, hv0, hu1, hv1], fill=shade(CRANEY, 0.94))
    m.d.rectangle([hu0 + 10, hv0 + 10, hu1 - 46, hv0 + 34], fill=GLASS)
    m.o.rectangle([hu0 + 10, hv0 + 10, hu1 - 46, hv0 + 34],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.t.rectangle([hu1 - 38, hv0 + 8, hu1 - 8, hv0 + 38], fill=(255, 0, 0))
    m.d.rectangle([hu1 - 38, hv0 + 8, hu1 - 8, hv0 + 38], fill=TEAMGREY)
    bolts(m, [(hu0 + 8 + i * (hu1 - hu0 - 16) / 4, hv1 - 8)
              for i in range(5)], base=CRANEY)
    # counterweight: dark block with yellow border
    wu0, wu1 = int(cu(-1.92)), int(cu(-0.98))
    wv0, wv1 = int(cv(4.3)), int(cv(3.4))
    m.d.rectangle([wu0, wv0, wu1, wv1], fill=(64, 66, 70),
                  outline=YELLOW, width=4)
    m.o.rectangle([wu0, wv0, wu1, wv1], fill=(AO_BASE - 14, 190, 60))
    wear_edges(m, (x0, y0, x1, y1), CRANEY, 60)


def paint_hook(m):
    zone = L.P_HOOK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 14, rough=140,
         metal=200)

    def hv(wy):
        return zone.uv((0, wy, 0))[1] * W

    # block: yellow with black stripes
    bv0, bv1 = int(hv(-2.28)), int(hv(-2.82))
    m.d.rectangle([x0 + 8, bv0, x1 - 8, bv1], fill=YELLOW)
    m.o.rectangle([x0 + 8, bv0, x1 - 8, bv1], fill=(AO_BASE - 10, 175, 90))
    for i in range(4):
        sx = x0 + 8 + (x1 - x0 - 16) * (i + 0.5) / 4
        m.d.rectangle([sx - 6, bv0, sx + 6, bv1], fill=BLACKISH)
    bolts(m, [((x0 + x1) / 2, (bv0 + bv1) / 2)], base=YELLOW)


def paint_buffer(m):
    zone = L.P_BUFF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(52, 54, 58), ao=AO_BASE - 16, rough=175,
         metal=160)
    # beam band (world y 1.1..1.6): faded red with bolted end plates
    bv0, bv1 = int(v_of(zone, 1.62)), int(v_of(zone, 1.08))
    m.d.rectangle([x0, bv0, x1, bv1], fill=BUFFRED)
    m.o.rectangle([x0, bv0, x1, bv1], fill=(AO_BASE - 12, 195, 70))
    seam_h(m, x0 + 2, x1 - 2, (bv0 + bv1) // 2, BUFFRED, hi=False)
    bolts(m, [(x0 + 14 + i * (x1 - x0 - 28) / 7, bv1 - 10)
              for i in range(8)], base=BUFFRED)
    wear_edges(m, (x0, bv0, x1, bv1), BUFFRED, 45)


def paint_signal(m):
    zone = L.P_SIGHEAD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(26, 28, 30), ao=AO_BASE - 20, rough=180,
         metal=90)

    def su(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def sv(wy):
        return zone.uv((0, wy, 0))[1] * W

    cxp = su(L.SIG_X)
    # red aspect (upper, dim) + green aspect (lower, lit)
    for (wy, dcol, ecol) in ((4.62, (74, 26, 22), (60, 12, 8)),
                             (4.07, (48, 120, 62), (46, 214, 96))):
        cyp = sv(wy)
        r = max(6.0, sv(wy - 0.14) - cyp)
        m.d.ellipse([cxp - r, cyp - r, cxp + r, cyp + r], fill=dcol)
        m.e.ellipse([cxp - r + 2, cyp - r + 2, cxp + r - 2, cyp + r - 2],
                    fill=ecol)
        m.o.ellipse([cxp - r, cyp - r, cxp + r, cyp + r],
                    fill=(AO_BASE, R_GLASS, M_GLASS))
    bolts(m, [(x0 + 10, y0 + 10), (x1 - 10, y0 + 10),
              (x0 + 10, y1 - 10), (x1 - 10, y1 - 10)], base=(26, 28, 30))


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_cells(m)
    paint_concrete(m)
    paint_track(m)
    paint_canopy(m)
    paint_kiosk(m)
    paint_crane(m)
    paint_hook(m)
    paint_buffer(m)
    paint_signal(m)

    # ── weathering (physically placed) ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=13)
    wx.crevice_grime(m.dif, 0.5)
    for zone in (L.P_SIDE, L.P_END):          # slab foot mud + splash
        x0, y0, x1, y1 = zone.rect
        wx.mud_band((x0, y1 - 40, x1, y1), 0.6, fade=None, spatter=True)
        wx.plate_bottom_rust((x0, y0, x1, y1), n=6, band=12, strength=0.5)
    wx.mud_band(L.P_BALS.rect, 0.4, fade='down', spatter=True)
    # rust dribble off the rails onto the ballast rail-lines
    bz = L.P_BAL
    for rx in (L.TRACK_X - L.GAUGE_X, L.TRACK_X + L.GAUGE_X):
        rv = bz.uv((rx, 0, 0))[1] * W
        for fx in np.linspace(0.05, 0.95, 12):
            wx.rust_blotch(bz.rect[0] + (bz.rect[2] - bz.rect[0]) * fx,
                           rv, 5, strength=0.5)
    # fascia drip streaks
    fz = L.P_CAN_EDGE.rect
    for fx in np.linspace(0.08, 0.92, 10):
        wx.rust_streak(fz[0] + (fz[2] - fz[0]) * fx, fz[1] + 12,
                       18 + int(fx * 30) % 14, width=2.2, strength=0.35)
    # buffer: heavy rust + soot on the ballast at the stop
    wx.plate_bottom_rust(L.P_BUFF.rect, n=10, band=16, strength=0.8)
    wx.soot_patch((int(u_of(bz, 8.6)), bz.rect[1] + 6,
                   int(u_of(bz, 11.6)), bz.rect[3] - 6), 0.35)
    # approach-end brake soot band
    wx.soot_patch((int(u_of(bz, -11.9)), bz.rect[1] + 6,
                   int(u_of(bz, -8.6)), bz.rect[3] - 6), 0.25)
    # oil on the deck under the crane jib + on the crane turntable
    dz = L.P_DECK
    wx.oily((int(u_of(dz, 6.2)), dz.rect[1] + 40,
             int(u_of(dz, 9.2)), dz.rect[3] - 40), 0.5)
    wx.oily(L.P_HOOK.rect, 0.3)
    wx.mud_band(L.P_CAN_TOP.rect, 0.18, fade=None, spatter=False)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.55)
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    # canopy stripe ribs
    ct = L.P_CAN_TOP
    zlo, zhi = ct.win[0]
    wz = zlo
    while wz < zhi:
        cu = u_of(ct, wz)
        hm.line((cu, ct.rect[1]), (cu, ct.rect[3]), 0.35, width=3)
        wz += 1.27
    # rail head stands proud
    hm.rect(L.P_RAILT.rect, 0.5)
    # deck safety line slightly proud paint layer
    hm.rect((dz.rect[0], dz.uv((-0.55, 0, 0))[1] * W,
             dz.rect[2], dz.uv((-0.32, 0, 0))[1] * W), 0.2)
    hm.crevices_from(m.dif, 0.5)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.4).save('out/ms_rail_platform_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/ms_rail_platform_diffuse.png')
    m.orm.save('out/ms_rail_platform_orm.png')
    m.emi.save('out/ms_rail_platform_emissive.png')
    m.tea.save('out/ms_rail_platform_team.png')
    print('[paint_ms_rail_platform] 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
