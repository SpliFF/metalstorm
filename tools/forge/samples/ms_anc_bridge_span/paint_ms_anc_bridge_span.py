"""paint_ms_anc_bridge_span — 2048² PBR set for ms_anc_bridge_span.

ANCIENT REGISTER.  Pale grey-green monolithic alloy in large unbroken
fields, segmented only by clean RECESSED seams — no rivets, no bolted
straps, no patchwork.  Emissive CYAN is the signature: an ACTIVE core
running the recessed deck guide-channel and the inner rim of the mid-span
ring, DORMANT embers in the soffit tracery, the parapet groove and the
plinth lenses.  Weathering is geological, not mechanical: wind-drifted
dust banked against the parapets and along the deck edges, soil creeping
up the plinths, scorch on one flank — and no rust anywhere.

Deterministic seed 90210 via paint.RNG.
"""
from __future__ import annotations
import numpy as np

import ms_anc_bridge_span_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_v, wear_edges, jit, shade, BOLT_LOG,
                   AO_BASE, AO_SEAM, AO_DEEP, RNG)

W = 2048

# ── ancient palette ──────────────────────────────────────────────────────
ANC     = (150, 155, 152)     # monolithic alloy, sun side
ANC_L   = (174, 178, 173)
ANC_D   = (118, 123, 121)     # recessed seam floor
ANC_DD  = (86, 91, 90)
SOFF    = (126, 131, 129)     # underside, always in shade
STONE   = (139, 140, 133)     # plinth
CYAN    = (150, 246, 255)     # active core
CYAN_M  = (66, 176, 194)      # cyan-lit alloy
CYAN_D  = (44, 104, 116)      # dormant ember
E_HOT   = (86, 232, 248)      # emissive, active
E_WARM  = (30, 104, 118)      # emissive, dormant
SCORCH  = (54, 50, 48)

R_ANC, M_ANC = 118, 96        # smooth, half-metallic ancient alloy
R_STONE, M_STONE = 196, 14


# ── local helpers ────────────────────────────────────────────────────────

def recess_v(m, x, y0, y1, base=ANC, w=3):
    """Clean recessed seam, vertical in atlas space."""
    m.d.line([(x, y0), (x, y1)], fill=shade(base, 0.62), width=w)
    m.d.line([(x + w * 0.6, y0), (x + w * 0.6, y1)], fill=shade(base, 1.10),
             width=1)
    m.o.line([(x, y0), (x, y1)], fill=(AO_SEAM, R_ANC + 24, M_ANC), width=w)


def recess_h(m, x0, x1, y, base=ANC, w=3):
    m.d.line([(x0, y), (x1, y)], fill=shade(base, 0.62), width=w)
    m.d.line([(x0, y + w * 0.6), (x1, y + w * 0.6)], fill=shade(base, 1.10),
             width=1)
    m.o.line([(x0, y), (x1, y)], fill=(AO_SEAM, R_ANC + 24, M_ANC), width=w)


def glow_rect(m, box, core=CYAN, halo=CYAN_M, emi=E_HOT, pad=4):
    """Cyan tracery: lit alloy halo, bright core, matching emissive."""
    x0, y0, x1, y1 = [int(v) for v in box]
    m.d.rectangle([x0 - pad, y0 - pad, x1 + pad, y1 + pad], fill=halo)
    m.d.rectangle([x0, y0, x1, y1], fill=core)
    m.o.rectangle([x0 - pad, y0 - pad, x1 + pad, y1 + pad],
                  fill=(AO_BASE, 70, 40))
    m.e.rectangle([x0 - pad, y0 - pad, x1 + pad, y1 + pad],
                  fill=tuple(int(c * 0.30) for c in emi))
    m.e.rectangle([x0, y0, x1, y1], fill=emi)


def glow_disc(m, cx, cy, r, core=CYAN_D, emi=E_WARM):
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=shade(ANC, 0.72))
    m.d.ellipse([cx - r * 0.62, cy - r * 0.62, cx + r * 0.62, cy + r * 0.62],
                fill=core)
    m.o.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(AO_SEAM, 96, 60))
    m.e.ellipse([cx - r * 0.62, cy - r * 0.62, cx + r * 0.62, cy + r * 0.62],
                fill=emi)


def plate_field(m, rect, base, seams_u, seams_v=(), tone=0.035):
    """Large unbroken plates: tone-on-tone casts + clean recessed seams.
    Contrast stays low — big quads sample these cells (impostor baker)."""
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=base, ao=AO_BASE - 4, rough=R_ANC, metal=M_ANC)
    us = [x0] + list(seams_u) + [x1]
    vs = [y0] + list(seams_v) + [y1]
    for i in range(len(us) - 1):
        for j in range(len(vs) - 1):
            f = 1.0 + tone * (((i * 3 + j * 5) % 5) - 2) / 2.0
            m.d.rectangle([us[i], vs[j], us[i + 1], vs[j + 1]],
                          fill=jit(shade(base, f), 2))
    for u in seams_u:
        recess_v(m, int(u), y0 + 1, y1 - 1, base)
    for v in seams_v:
        recess_h(m, x0 + 1, x1 - 1, int(v), base)


# ── deck: seamless plates + the recessed cyan guide channel ──────────────

def paint_deck(m):
    z = L.Z_DECK
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    seams_u = [u(sz) for sz in L.SEAM_Z]
    seams_v = [v(wx) for wx in (-4.95, -4.25, -2.55, 2.55, 4.25, 4.95)]
    plate_field(m, z.rect, ANC, seams_u, seams_v)

    # dust drifted into the lee of the parapets (tone-on-tone, no hard edge)
    for wx0, wx1 in ((-4.25, -3.35), (3.35, 4.25)):
        m.d.rectangle([x0, v(wx0), x1, v(wx1)], fill=jit(shade(ANC, 0.955), 2))
    # geological pitting — shallow, sparse, low contrast
    for _ in range(90):
        px = x0 + RNG.random() * (x1 - x0)
        py = y0 + RNG.random() * (y1 - y0)
        r = 3 + RNG.random() * 9
        m.d.ellipse([px, py, px + r, py + r * 0.7],
                    fill=jit(shade(ANC, 0.93), 3))
    # a hairline of the guide glow bleeding onto the deck either side
    gv0, gv1 = v(-0.62), v(0.62)
    m.d.rectangle([x0, gv0, x1, v(-0.42)], fill=shade(CYAN_M, 0.62))
    m.d.rectangle([x0, v(0.42), x1, gv1], fill=shade(CYAN_M, 0.62))
    m.e.rectangle([x0, gv0, x1, v(-0.42)], fill=tuple(int(c * 0.18) for c in E_HOT))
    m.e.rectangle([x0, v(0.42), x1, gv1], fill=tuple(int(c * 0.18) for c in E_HOT))
    wear_edges(m, z.rect, ANC, 26)


def paint_guide(m):
    """Channel floor + walls — the ACTIVE cyan line down the deck centre."""
    z = L.Z_GUIDE
    u, _ = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=shade(ANC_DD, 0.9), ao=AO_DEEP, rough=90, metal=120)
    mid = (y0 + y1) // 2
    glow_rect(m, [x0, mid - 7, x1, mid + 7], pad=6)
    # brighter nodes where the deck seams cross the channel
    for sz in L.SEAM_Z:
        su = int(u(sz))
        m.d.rectangle([su - 5, y0 + 3, su + 5, y1 - 3], fill=CYAN)
        m.e.rectangle([su - 5, y0 + 3, su + 5, y1 - 3], fill=E_HOT)

    zw = L.Z_GUIDEW
    x0, y0, x1, y1 = zw.rect
    fill(m, zw.rect, dif=CYAN_M, ao=AO_DEEP + 8, rough=88, metal=110)
    m.d.rectangle([x0, y1 - 8, x1, y1], fill=CYAN)
    m.e.rectangle([x0, y0, x1, y1], fill=tuple(int(c * 0.35) for c in E_HOT))
    m.e.rectangle([x0, y1 - 8, x1, y1], fill=E_HOT)


# ── fascia, haunch, soffit — the arc itself ──────────────────────────────

def paint_fascia(m):
    z = L.Z_FASCIA
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    plate_field(m, z.rect, shade(ANC, 0.97), [u(sz) for sz in L.SEAM_Z])
    # one clean shadow recess under the deck lip, full length
    recess_h(m, x0 + 1, x1 - 1, int(v(6.86)), ANC, w=4)
    wear_edges(m, z.rect, ANC, 20)


def paint_haunch(m):
    z = L.Z_HAUNCH
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    plate_field(m, z.rect, shade(ANC, 0.93), [u(sz) for sz in L.SEAM_Z],
                tone=0.03)

    def ys(wz):                       # soffit height at world z
        t = abs(wz) / L.Z1
        return L.DTOP - (L.T_MIN + (L.T_MAX - L.T_MIN) * t * t)

    # a DORMANT tracery that follows the arc, two thirds down the haunch
    pts = []
    for wz in np.linspace(L.Z0, L.Z1, 120):
        wy = 6.45 - 0.62 * (6.45 - ys(float(wz)))
        pts.append((u(float(wz)), v(wy)))
    m.d.line(pts, fill=CYAN_D, width=5)
    m.e.line(pts, fill=E_WARM, width=5)
    m.o.line(pts, fill=(AO_SEAM, 96, 70), width=5)
    # and a clean recessed seam tracking the springing line above it
    pts2 = [(px, py - 26) for px, py in pts]
    m.d.line(pts2, fill=shade(ANC, 0.66), width=3)
    m.o.line(pts2, fill=(AO_SEAM, R_ANC + 20, M_ANC), width=3)
    wear_edges(m, z.rect, ANC, 22)


def paint_soffit(m):
    z = L.Z_SOFFIT
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    plate_field(m, z.rect, SOFF, [u(sz) for sz in L.SEAM_Z],
                [v(wx) for wx in (-2.2, 2.2)], tone=0.028)
    # dormant tracery down the centre of the underside — kept narrow so the
    # impostor baker's per-triangle centroid sampling rarely lands on it
    cv = int(v(0.0))
    m.d.rectangle([x0, cv - 3, x1, cv + 3], fill=CYAN_D)
    m.e.rectangle([x0, cv - 3, x1, cv + 3], fill=E_WARM)
    m.o.rectangle([x0, cv - 3, x1, cv + 3], fill=(AO_SEAM, 100, 70))
    wear_edges(m, z.rect, SOFF, 24)


# ── parapets ─────────────────────────────────────────────────────────────

def paint_parapets(m):
    z = L.Z_PARA
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    plate_field(m, z.rect, ANC, [u(sz) for sz in L.SEAM_Z])
    # a continuous dormant groove near the coping
    gv = int(v(8.00))
    m.d.rectangle([x0, gv - 4, x1, gv + 4], fill=shade(ANC, 0.6))
    m.d.rectangle([x0, gv - 2, x1, gv + 2], fill=CYAN_D)
    m.e.rectangle([x0, gv - 2, x1, gv + 2], fill=E_WARM)
    m.o.rectangle([x0, gv - 4, x1, gv + 4], fill=(AO_SEAM, 100, 70))
    # nodes at each seam — the groove brightens where the segments meet
    for sz in L.SEAM_Z:
        su = int(u(sz))
        m.d.rectangle([su - 7, gv - 6, su + 7, gv + 6], fill=CYAN)
        m.e.rectangle([su - 7, gv - 6, su + 7, gv + 6], fill=E_HOT)
    wear_edges(m, z.rect, ANC, 22)

    zt = L.Z_PARAT_R
    ut, vt = PL.zone_fns(zt)
    x0, y0, x1, y1 = zt.rect
    plate_field(m, zt.rect, shade(ANC, 1.03), [ut(sz) for sz in L.SEAM_Z])
    cv = (y0 + y1) // 2
    m.d.rectangle([x0, cv - 2, x1, cv + 2], fill=shade(ANC, 0.66))
    m.o.rectangle([x0, cv - 2, x1, cv + 2], fill=(AO_SEAM, R_ANC + 20, M_ANC))


# ── plinth footings ──────────────────────────────────────────────────────

def paint_plinths(m):
    z = L.Z_PIERF
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=shade(ANC, 0.9), ao=AO_BASE - 8, rough=R_ANC + 20,
         metal=M_ANC - 20)
    # one big recessed panel, inset clean from every edge
    px0, py0 = int(u(-3.2)), int(v(3.9))
    px1, py1 = int(u(3.2)), int(v(0.55))
    m.d.rectangle([px0, py0, px1, py1], fill=shade(ANC, 0.83))
    m.o.rectangle([px0, py0, px1, py1], fill=(AO_SEAM + 6, R_ANC + 30, M_ANC))
    for wx in (-3.2, 3.2):
        recess_v(m, int(u(wx)), py0, py1, ANC, w=4)
    recess_h(m, px0, px1, py0, ANC, w=4)
    recess_h(m, px0, px1, py1, ANC, w=4)
    # dormant core lens, deliberately off the quad centroids
    glow_disc(m, (px0 + px1) // 2, int(v(2.55)), 26)
    # vertical tracery dropping from the lens into the buried foot
    lx = (px0 + px1) // 2
    m.d.rectangle([lx - 3, int(v(2.2)), lx + 3, int(v(0.7))], fill=CYAN_D)
    m.e.rectangle([lx - 3, int(v(2.2)), lx + 3, int(v(0.7))], fill=E_WARM)
    wear_edges(m, z.rect, ANC, 18)

    zx = L.Z_PIERX_P
    ux, vx = PL.zone_fns(zx)
    x0, y0, x1, y1 = zx.rect
    fill(m, zx.rect, dif=shade(ANC, 0.86), ao=AO_BASE - 12, rough=R_ANC + 24,
         metal=M_ANC - 20)
    recess_v(m, (x0 + x1) // 2, y0 + 6, y1 - 6, ANC, w=4)
    wear_edges(m, zx.rect, ANC, 16)

    zp = L.Z_PLINTH
    up, vp = PL.zone_fns(zp)
    x0, y0, x1, y1 = zp.rect
    fill(m, zp.rect, dif=STONE, ao=AO_BASE - 14, rough=R_STONE,
         metal=M_STONE)
    for f in np.linspace(0.14, 0.86, 6):
        recess_v(m, int(x0 + (x1 - x0) * f), y0 + 3, y1 - 3, STONE, w=3)
    wear_edges(m, zp.rect, STONE, 30)


# ── the mid-span ring ────────────────────────────────────────────────────

def paint_ring(m):
    # outer band — unbroken alloy, eight clean recessed seams round the circle
    x0, y0, x1, y1 = L.R_RING_O
    fill(m, L.R_RING_O, dif=shade(ANC, 1.12), ao=AO_BASE, rough=R_ANC - 20,
         metal=M_ANC + 40)
    for f in np.linspace(0.0, 1.0, 9)[:-1]:
        sx = int(x0 + (x1 - x0) * f)
        recess_v(m, sx, y0 + 2, y1 - 2, ANC, w=4)
    m.d.rectangle([x0, y0, x1, y0 + 5], fill=shade(ANC, 0.86))
    m.d.rectangle([x0, y1 - 5, x1, y1], fill=shade(ANC, 0.86))

    # inner band — the ACTIVE rim
    x0, y0, x1, y1 = L.R_RING_I
    fill(m, L.R_RING_I, dif=CYAN_M, ao=AO_BASE, rough=80, metal=110)
    mid = (y0 + y1) // 2
    glow_rect(m, [x0, mid - 11, x1, mid + 11], pad=7)
    for f in np.linspace(0.0, 1.0, 9)[:-1]:
        sx = int(x0 + (x1 - x0) * f)
        m.d.rectangle([sx - 3, y0, sx + 3, y1], fill=shade(ANC, 0.8))
        m.e.rectangle([sx - 3, y0, sx + 3, y1], fill=(0, 0, 0))

    # annulus faces — v=0 is the inner edge
    x0, y0, x1, y1 = L.R_RING_F
    fill(m, L.R_RING_F, dif=shade(ANC, 1.08), ao=AO_BASE - 4, rough=R_ANC - 10,
         metal=M_ANC + 30)
    m.d.rectangle([x0, y0, x1, y0 + 22], fill=CYAN_M)
    m.d.rectangle([x0, y0, x1, y0 + 11], fill=CYAN)
    m.e.rectangle([x0, y0, x1, y0 + 22], fill=tuple(int(c * 0.45)
                                                    for c in E_HOT))
    m.e.rectangle([x0, y0, x1, y0 + 11], fill=E_HOT)
    m.o.rectangle([x0, y0, x1, y0 + 22], fill=(AO_BASE, 70, 40))
    for f in np.linspace(0.0, 1.0, 9)[:-1]:
        sx = int(x0 + (x1 - x0) * f)
        recess_v(m, sx, y0 + 20, y1 - 2, ANC, w=4)


def paint_dark(m):
    fill(m, L.Z_DARK.rect, dif=shade(ANC_DD, 0.55), ao=AO_DEEP, rough=180,
         metal=60)


# ── assembly ─────────────────────────────────────────────────────────────

def restamp_cyan(m):
    """Re-lay the active cores after weathering so dust never mutes them."""
    z = L.Z_GUIDE
    u, _ = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    mid = (y0 + y1) // 2
    m.d.rectangle([x0, mid - 7, x1, mid + 7], fill=CYAN)
    m.e.rectangle([x0, mid - 7, x1, mid + 7], fill=E_HOT)
    for sz in L.SEAM_Z:
        su = int(u(sz))
        m.d.rectangle([su - 5, y0 + 3, su + 5, y1 - 3], fill=CYAN)
        m.e.rectangle([su - 5, y0 + 3, su + 5, y1 - 3], fill=E_HOT)
    x0, y0, x1, y1 = L.R_RING_I
    mid = (y0 + y1) // 2
    m.d.rectangle([x0, mid - 11, x1, mid + 11], fill=CYAN)
    m.e.rectangle([x0, mid - 11, x1, mid + 11], fill=E_HOT)
    x0, y0, x1, y1 = L.R_RING_F
    m.d.rectangle([x0, y0, x1, y0 + 7], fill=CYAN)
    m.e.rectangle([x0, y0, x1, y0 + 7], fill=E_HOT)


def paint_all():
    BOLT_LOG.clear()                 # ancient: nothing is bolted
    m = Maps()
    paint_dark(m)
    paint_deck(m)
    paint_guide(m)
    paint_fascia(m)
    paint_haunch(m)
    paint_soffit(m)
    paint_parapets(m)
    paint_plinths(m)
    paint_ring(m)

    # ── geological weathering: dust, buried feet, scorch — never rust ──
    from weathering import Weather
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.42)
    dk, pa, so, ha = (L.Z_DECK.rect, L.Z_PARA.rect, L.Z_SOFFIT.rect,
                      L.Z_HAUNCH.rect)
    udk, vdk = PL.zone_fns(L.Z_DECK)
    # dust banked against both parapets, drifting in from the deck edges
    wx.mud_band((dk[0], dk[1], dk[2], int(vdk(-3.9))), 0.42, fade=None,
                spatter=True)
    wx.mud_band((dk[0], int(vdk(3.9)), dk[2], dk[3]), 0.42, fade=None,
                spatter=True)
    wx.mud_band(dk, 0.10, fade=None, spatter=False, dust=0.26)
    # parapet flanks + coping: thin dry film, heavier low down
    wx.mud_band(pa, 0.30, fade='down', spatter=False, dust=0.24)
    wx.mud_band(L.Z_PARAT_R.rect, 0.34, fade=None, spatter=True)
    # the arc: dust cannot cling to a soffit — only a faint film
    wx.mud_band(ha, 0.16, fade='down', spatter=False, dust=0.14)
    wx.mud_band(so, 0.10, fade=None, spatter=False, dust=0.12)
    # soil creeping up the plinths and burying the pads
    pf, px, pp = L.Z_PIERF.rect, L.Z_PIERX_P.rect, L.Z_PLINTH.rect
    wx.mud_band(pf, 0.52, fade='down', spatter=True, dust=0.22)
    wx.mud_band(px, 0.52, fade='down', spatter=True, dust=0.22)
    wx.mud_band(pp, 0.68, fade=None, spatter=True)
    # scorch: one flank of a plinth and the soffit above it took a hit
    wx.soot_patch((pf[0] + 40, pf[1] + 14, pf[0] + 190, pf[3] - 30), 0.34)
    wx.soot_patch((so[0] + 60, so[1] + 20, so[0] + 300, so[3] - 20), 0.24)
    wx.soot_patch((ha[2] - 220, ha[1] + 10, ha[2] - 40, ha[3] - 10), 0.22)
    wx.apply(m)
    restamp_cyan(m)                  # the ancient cores outlast the dust

    # ── height → normals: recessed seams, channel, ring bands ──
    from normals import HeightMap
    hm = HeightMap()
    u, v = PL.zone_fns(L.Z_DECK)
    for sz in L.SEAM_Z:                       # deck cross seams
        hm.line((u(sz), dk[1]), (u(sz), dk[3]), -0.5, width=4)
    for wx0 in (-4.25, -2.55, 2.55, 4.25):    # deck longitudinal seams
        hm.line((dk[0], v(wx0)), (dk[2], v(wx0)), -0.45, width=4)
    hm.rect((L.Z_GUIDE.rect[0], L.Z_GUIDE.rect[1],
             L.Z_GUIDE.rect[2], L.Z_GUIDE.rect[3]), -0.75)
    up, vp = PL.zone_fns(L.Z_PARA)
    for sz in L.SEAM_Z:
        hm.line((up(sz), pa[1]), (up(sz), pa[3]), -0.55, width=4)
    hm.line((pa[0], vp(8.00)), (pa[2], vp(8.00)), -0.5, width=5)
    x0, y0, x1, y1 = L.R_RING_I
    hm.rect((x0, (y0 + y1) // 2 - 12, x1, (y0 + y1) // 2 + 12), -0.55)
    hm.weather_from(wx)
    PL.finish(m, L, 'ms_anc_bridge_span', hm=hm, wx=None)


if __name__ == '__main__':
    paint_all()
