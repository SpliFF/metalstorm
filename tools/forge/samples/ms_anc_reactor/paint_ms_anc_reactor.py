"""paint_ms_anc_reactor — 2048^2 PBR set for ms_anc_reactor.

ANCIENT REGISTER, ACTIVE. Monolithic dark basalt-alloy, segmented ONLY by
clean recessed seams — no rivets, no bolts, no patchwork, no team colour.
Emissive CYAN is the signature: it flows up the exposed core column, pools
under the crown flare, rings the dome oculus, runs the length of every
buttress pylon and every gyroscopic ring, and tips the emitter spikes.
Weathering is geological, not mechanical: soil burial at the skirt, dust
drift on the apron and the dome's windward face, radial scorch on the
crater floor. Zero rust — nothing here was ever bolted.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_reactor_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, shade, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS, R_GLOW,
                   M_ARMOR, M_STEEL, M_GLASS, BLACKISH)

W = 2048
RNG = np.random.default_rng(90210)

ALLOY    = (84, 90, 96)      # pale basalt-alloy — the ancient body colour
ALLOY_LT = (104, 111, 117)
ALLOY_DK = (63, 68, 74)
ALLOY_XD = (44, 48, 53)
SOIL     = (66, 57, 46)      # buried earth at the skirt
DUST     = (116, 108, 93)    # geological drift
SCORCH   = (27, 25, 23)
CYAN     = (60, 235, 255)
CYAN_HOT = (188, 250, 255)
CYAN_MID = (36, 150, 175)
CYAN_DIM = (25, 92, 106)     # tone-on-tone tracery in diffuse


# ── helpers ──────────────────────────────────────────────────────────────

def zfill(m, zone, dif, ao=AO_BASE, rough=R_ARMOR, metal=M_ARMOR + 40):
    fill(m, zone.rect if hasattr(zone, 'rect') else zone,
         dif=dif, ao=ao, rough=rough, metal=metal)


def rfrac(rect, fu0, fv0, fu1, fv1):
    """Sub-rect of a parametric wrap rect, in 0..1 fractions."""
    x0, y0, x1, y1 = rect
    return [x0 + (x1 - x0) * fu0, y0 + (y1 - y0) * fv0,
            x0 + (x1 - x0) * fu1, y0 + (y1 - y0) * fv1]


def glow_line(m, pts, width=4, hot=CYAN, dim=CYAN_DIM, e=0.85):
    m.d.line(pts, fill=dim, width=width)
    m.e.line(pts, fill=shade(hot, e), width=max(1, width - 1))


def glow_rect(m, box, hot=CYAN, dim=CYAN_MID, e=0.9, inset=2):
    b = [box[0], box[1], box[2], box[3]]
    m.d.rectangle(b, fill=dim)
    m.o.rectangle(b, fill=(AO_BASE, R_GLOW, M_GLASS))
    m.e.rectangle([b[0] + inset, b[1] + inset, b[2] - inset, b[3] - inset],
                  fill=shade(hot, e))


def glow_ellipse(m, cx, cy, r, hot=CYAN, dim=CYAN_MID, e=0.9, width=0):
    box = [cx - r, cy - r, cx + r, cy + r]
    if width:
        m.d.ellipse(box, outline=dim, width=width)
        m.e.ellipse(box, outline=shade(hot, e), width=max(1, width - 1))
    else:
        m.d.ellipse(box, fill=dim)
        m.e.ellipse(box, fill=shade(hot, e))


# ── the big top-down disc: apron shelf, crater floor, collar top, stubs ──

def paint_disc(m):
    z = L.R_DISC
    x0, y0, x1, y1 = z.rect
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    ppm = (x1 - x0) / 26.4          # px per metre (window is +-13.2 m)

    def rr(r):
        return r * ppm

    def ring(r, col, width):
        m.d.ellipse([cx - rr(r), cy - rr(r), cx + rr(r), cy + rr(r)],
                    outline=col, width=width)

    fill(m, (x0, y0, x1, y1), dif=ALLOY_XD, ao=AO_BASE - 12,
         rough=R_ARMOR + 14, metal=M_ARMOR + 20)

    # apron shelf annulus (9.52 .. 11.20 m)
    m.d.ellipse([cx - rr(L.APRON_R_LIP), cy - rr(L.APRON_R_LIP),
                 cx + rr(L.APRON_R_LIP), cy + rr(L.APRON_R_LIP)], fill=ALLOY)
    m.o.ellipse([cx - rr(L.APRON_R_LIP), cy - rr(L.APRON_R_LIP),
                 cx + rr(L.APRON_R_LIP), cy + rr(L.APRON_R_LIP)],
                fill=(AO_BASE, R_ARMOR + 6, M_ARMOR + 40))
    # concentric recessed seams — tone-on-tone (large quads, baker note)
    for r in (10.05, 10.62):
        ring(r, shade(ALLOY, 0.82), 4)
    # radial recessed seams, aligned to the n-gon EDGES so no quad centroid
    # ever lands on one (otherwise the impostor baker floods whole facets)
    half = 180.0 / L.N_APRON
    for i in range(L.N_APRON):
        a = np.radians(half + 360.0 * i / L.N_APRON)
        m.d.line([(cx + rr(L.APRON_R_IN) * np.cos(a),
                   cy + rr(L.APRON_R_IN) * np.sin(a)),
                  (cx + rr(L.APRON_R_LIP) * np.cos(a),
                   cy + rr(L.APRON_R_LIP) * np.sin(a))],
                 fill=shade(ALLOY, 0.80), width=4)

    # crater floor (8.20 .. 9.40 m): scorched, with an inscribed cyan groove
    m.d.ellipse([cx - rr(L.APRON_R_STEP), cy - rr(L.APRON_R_STEP),
                 cx + rr(L.APRON_R_STEP), cy + rr(L.APRON_R_STEP)],
                fill=ALLOY_DK)
    m.o.ellipse([cx - rr(L.APRON_R_STEP), cy - rr(L.APRON_R_STEP),
                 cx + rr(L.APRON_R_STEP), cy + rr(L.APRON_R_STEP)],
                fill=(AO_BASE - 18, R_ARMOR + 20, M_ARMOR + 10))
    for i in range(L.N_APRON):
        a = np.radians(half + 360.0 * i / L.N_APRON)
        m.d.line([(cx + rr(L.CRATER_R) * np.cos(a),
                   cy + rr(L.CRATER_R) * np.sin(a)),
                  (cx + rr(L.APRON_R_STEP) * np.cos(a),
                   cy + rr(L.APRON_R_STEP) * np.sin(a))],
                 fill=shade(ALLOY_DK, 0.80), width=4)
    glow_ellipse(m, cx, cy, rr(8.82), width=7)

    # collar top disc (r <= 3.40): the oculus deck, cyan iris around the core
    m.d.ellipse([cx - rr(L.COLLAR_R1), cy - rr(L.COLLAR_R1),
                 cx + rr(L.COLLAR_R1), cy + rr(L.COLLAR_R1)], fill=ALLOY_DK)
    m.o.ellipse([cx - rr(L.COLLAR_R1), cy - rr(L.COLLAR_R1),
                 cx + rr(L.COLLAR_R1), cy + rr(L.COLLAR_R1)],
                fill=(AO_BASE - 10, R_ARMOR, M_ARMOR + 60))
    glow_ellipse(m, cx, cy, rr(2.60), width=6)
    glow_ellipse(m, cx, cy, rr(1.72), e=1.0)      # hot pool around the shaft

    # grid-stub top caps: cyan lenses
    for az in L.STUB_AZ:
        a = np.radians(az)
        sx, sy = cx + rr(L.STUB_R) * np.cos(a), cy + rr(L.STUB_R) * np.sin(a)
        m.d.ellipse([sx - rr(0.66), sy - rr(0.66), sx + rr(0.66), sy + rr(0.66)],
                    fill=ALLOY_DK)
        glow_ellipse(m, sx, sy, rr(0.40), e=1.0)


# ── vertical skirt band (apron outer skirt + crater step wall) ───────────

def paint_skirt(m):
    z = L.R_SKIRT
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 8,
         rough=R_ARMOR + 8, metal=M_ARMOR + 30)
    # chamfered lip catches the light
    m.d.rectangle([x0, v(0.55), x1, v(0.40)], fill=ALLOY_LT)
    # a single recessed tracery groove runs the whole perimeter
    glow_line(m, [(x0 + 2, v(0.16)), (x1 - 2, v(0.16))], width=5, e=0.7)
    # soil burial: ragged earth line, geological not mechanical
    pts = [(x0, v(-0.30))]
    for i in range(1, 49):
        px = x0 + (x1 - x0) * i / 48.0
        pts.append((px, v(-0.30 + float(RNG.uniform(-0.16, 0.16)))))
    pts += [(x1, v(-1.20)), (x0, v(-1.20))]
    m.d.polygon(pts, fill=SOIL)
    m.o.rectangle([x0, v(-0.42), x1, y1], fill=(AO_DEEP, R_ARMOR + 60, 0))


# ── containment dome ─────────────────────────────────────────────────────

def paint_dome(m):
    z = L.R_DOME
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR + 45)
    # latitude seams exactly on the band boundaries (== quad edges, so the
    # impostor baker never floods a facet with them)
    ths = [L.DOME_TH_MAX * k / L.DOME_BANDS for k in range(L.DOME_BANDS + 1)]
    for k, th in enumerate(ths[1:-1], start=1):
        yy = L.DOME_CY + L.DOME_R * np.sin(th)
        m.d.rectangle([x0, v(yy) - 3, x1, v(yy) + 3], fill=shade(ALLOY, 0.72))
        m.o.rectangle([x0, v(yy) - 3, x1, v(yy) + 3],
                      fill=(AO_SEAM, R_ARMOR + 10, M_ARMOR + 30))
        glow_line(m, [(x0 + 2, v(yy) + 7), (x1 - 2, v(yy) + 7)], width=4, e=0.6)
    # tone-on-tone banding: the shell lightens toward the crown
    for k in range(L.DOME_BANDS):
        ya = L.DOME_CY + L.DOME_R * np.sin(ths[k])
        yb = L.DOME_CY + L.DOME_R * np.sin(ths[k + 1])
        f = 0.93 + 0.035 * k
        m.d.rectangle([x0, v(yb) + 6, x1, v(ya) - 6], fill=shade(ALLOY, f))
    # oculus shoulder ring: the dome's brightest tracery
    glow_line(m, [(x0 + 2, v(L.DOME_TOP_Y) + 10),
                  (x1 - 2, v(L.DOME_TOP_Y) + 10)], width=7, e=0.95)
    # the dome sits in a crater — the sunken skirt is in shadow and buried
    m.d.rectangle([x0, v(0.10), x1, y1], fill=ALLOY_DK)
    m.o.rectangle([x0, v(0.10), x1, y1],
                  fill=(AO_DEEP + 30, R_ARMOR + 40, M_ARMOR))


def paint_collar(m):
    z = L.R_COLLAR
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 6, rough=R_ARMOR - 6,
         metal=M_ARMOR + 70)
    # the flare between COLLAR_Y1 and COLLAR_Y2 is a solid cyan light ring
    glow_rect(m, [x0, v(L.COLLAR_Y2) + 2, x1, v(L.COLLAR_Y1) - 2], e=1.0)
    m.d.rectangle([x0, v(L.COLLAR_Y1) - 2, x1, v(L.COLLAR_Y1) + 4],
                  fill=shade(ALLOY_DK, 0.6))


# ── the exposed cyan core column ─────────────────────────────────────────

def paint_core(m):
    z = L.R_CORE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    # ACTIVE: the column is lit plasma-cyan the whole way up
    fill(m, (x0, y0, x1, y1), dif=CYAN_MID, ao=AO_BASE, rough=R_GLOW,
         metal=M_GLASS)
    m.e.rectangle([x0, y0, x1, y1], fill=shade(CYAN, 0.80))
    # energy striations live in EMISSIVE only — diffuse stays tone-on-tone so
    # the impostor baker cannot checker the column
    for yy in np.arange(L.CORE_Y0, L.CORE_Y1, 0.42):
        k = 0.55 + 0.45 * float(RNG.random())
        m.e.rectangle([x0, v(yy + 0.16), x1, v(yy)], fill=shade(CYAN_HOT, k))
    # three monolithic containment collars — dark, unlit, proud geometry
    for h in L.CORE_RIBS:
        m.d.rectangle([x0, v(h + 0.24), x1, v(h - 0.24)], fill=ALLOY)
        m.o.rectangle([x0, v(h + 0.24), x1, v(h - 0.24)],
                      fill=(AO_BASE - 10, R_ARMOR, M_ARMOR + 60))
        m.e.rectangle([x0, v(h + 0.24), x1, v(h - 0.24)], fill=(0, 0, 0))
        for s in (+0.24, -0.24):
            glow_line(m, [(x0, v(h + s)), (x1, v(h + s))], width=4, e=1.0)


def paint_crown(m):
    z = L.R_CROWN
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR + 50)
    # the cantilevered flare's underside pools with light
    glow_rect(m, [x0, v(L.CROWN[1][0]) + 2, x1, v(L.CROWN[0][0]) - 2], e=1.0)
    # body of the crown, with one recessed seam and a tracery band
    m.d.rectangle([x0, v(L.CROWN[2][0]), x1, v(L.CROWN[1][0])],
                  fill=shade(ALLOY, 0.97))
    glow_line(m, [(x0 + 2, v(22.30)), (x1 - 2, v(22.30))], width=6, e=0.85)
    m.d.rectangle([x0, v(L.CROWN[2][0]) - 3, x1, v(L.CROWN[2][0]) + 3],
                  fill=shade(ALLOY, 0.70))
    m.d.rectangle([x0, v(L.CROWN[3][0]), x1, v(L.CROWN[2][0])],
                  fill=shade(ALLOY, 0.88))
    # crown top deck
    tz = L.R_CROWNTOP
    tx0, ty0, tx1, ty1 = tz.rect
    fill(m, (tx0, ty0, tx1, ty1), dif=ALLOY_DK, ao=AO_BASE - 8,
         rough=R_ARMOR, metal=M_ARMOR + 60)
    tcx, tcy = (tx0 + tx1) / 2.0, (ty0 + ty1) / 2.0
    ppm = (tx1 - tx0) / 6.0
    glow_ellipse(m, tcx, tcy, 1.85 * ppm, width=6)
    glow_ellipse(m, tcx, tcy, 0.85 * ppm, e=1.0)

    # floating capstone emitter — a solid cyan lens
    cz = L.R_CAP
    cx0, cy0, cx1, cy1 = cz.rect
    _, cv = PL.zone_fns(cz)
    fill(m, (cx0, cy0, cx1, cy1), dif=CYAN_MID, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    m.e.rectangle([cx0, cy0, cx1, cy1], fill=shade(CYAN_HOT, 0.95))
    m.d.rectangle([cx0, cv(L.CAP_MID_Y) - 5, cx1, cv(L.CAP_MID_Y) + 5],
                  fill=ALLOY_DK)
    m.e.rectangle([cx0, cv(L.CAP_MID_Y) - 5, cx1, cv(L.CAP_MID_Y) + 5],
                  fill=(0, 0, 0))
    # the bridging rod
    fill(m, L.R_BEAM, dif=CYAN_MID, ao=AO_BASE, rough=R_GLOW, metal=M_GLASS)
    m.e.rectangle(L.R_BEAM, fill=CYAN_HOT)


# ── parametric wraps: pylons, dome ribs, conduits, stubs, rings, nodes ───

def paint_wraps(m):
    # buttress pylons — u along the limb, v around 6 facets
    r = L.R_PYLON
    fill(m, r, dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR, metal=M_ARMOR + 45)
    for f in (0, 3):                       # two opposed facets carry tracery
        band = rfrac(r, 0.0, (f + 0.34) / 6.0, 1.0, (f + 0.66) / 6.0)
        glow_rect(m, band, e=0.8, inset=3)
    m.d.rectangle(rfrac(r, 0.0, 0.0, 0.06, 1.0), fill=ALLOY_DK)   # sunk base
    for f in range(1, 6):                  # facet seams
        yy = r[1] + (r[3] - r[1]) * f / 6.0
        m.d.line([(r[0], yy), (r[2], yy)], fill=shade(ALLOY, 0.74), width=3)

    # dome meridian ribs
    r = L.R_RIB
    fill(m, r, dif=ALLOY_LT, ao=AO_BASE - 2, rough=R_ARMOR - 4,
         metal=M_ARMOR + 55)
    glow_rect(m, rfrac(r, 0.02, 0.36, 0.98, 0.62), e=0.7, inset=2)
    m.d.rectangle(rfrac(r, 0.0, 0.0, 0.10, 1.0), fill=shade(ALLOY_DK, 0.9))

    # conduit runs
    r = L.R_CONDUIT
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 8, rough=R_ARMOR + 6,
         metal=M_ARMOR + 40)
    glow_rect(m, rfrac(r, 0.04, 0.40, 0.96, 0.60), e=0.75, inset=2)

    # grid stubs — u = base(0) to top(1), v around 4 facets
    r = L.R_STUB
    fill(m, r, dif=ALLOY, ao=AO_BASE - 6, rough=R_ARMOR + 4, metal=M_ARMOR + 40)
    m.d.rectangle(rfrac(r, 0.0, 0.0, 0.18, 1.0), fill=SOIL)      # soil at foot
    glow_rect(m, rfrac(r, 0.74, 0.0, 0.86, 1.0), e=0.9, inset=2)
    for f in range(1, 4):
        yy = r[1] + (r[3] - r[1]) * f / 4.0
        m.d.line([(r[0], yy), (r[2], yy)], fill=shade(ALLOY, 0.74), width=3)

    # gyroscopic ring bars — a running light band on two opposed facets
    r = L.R_RING
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 4, rough=R_ARMOR - 10,
         metal=M_ARMOR + 80)
    for f in (0, 3):
        glow_rect(m, rfrac(r, 0.0, (f + 0.3) / 6.0, 1.0, (f + 0.7) / 6.0),
                  e=0.85, inset=2)

    # emitter node spikes — dark shank, incandescent tip
    r = L.R_NODE
    fill(m, r, dif=ALLOY_DK, ao=AO_BASE - 4, rough=R_ARMOR - 6,
         metal=M_ARMOR + 70)
    glow_rect(m, rfrac(r, 0.42, 0.0, 1.0, 1.0), hot=CYAN_HOT, e=1.0, inset=2)

    # spare + hidden faces
    fill(m, L.R_SPARE, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=M_ARMOR)
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=M_ARMOR)


# ── radiator fins ────────────────────────────────────────────────────────

def paint_fins(m):
    # faces: u = radial 0..1, v = height (0 = top of the inner edge, 1 = shelf)
    r = L.R_FIN_FACE
    fill(m, r, dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR + 4, metal=M_ARMOR + 45)
    # a glowing spine just inboard, running the fin's full height
    glow_rect(m, rfrac(r, 0.05, 0.0, 0.13, 1.0), e=0.95, inset=2)
    # cooling striations — tone-on-tone only (each face is ONE quad; the
    # impostor baker flat-shades it from the UV centroid)
    for i in range(1, 11):
        vv = r[1] + (r[3] - r[1]) * i / 11.0
        m.d.line([(r[0] + (r[2] - r[0]) * 0.14, vv), (r[2], vv)],
                 fill=shade(ALLOY, 0.90), width=5)
        m.d.line([(r[0] + (r[2] - r[0]) * 0.14, vv + 5), (r[2], vv + 5)],
                 fill=shade(ALLOY, 1.06), width=2)
    m.d.rectangle(rfrac(r, 0.0, 0.0, 0.05, 1.0), fill=ALLOY_DK)

    # rims: u = profile perimeter (inner / swept top / outer), v = thickness
    r = L.R_FIN_EDGE
    p0, p1, p2, p3 = L.FIN_PERIM
    fill(m, r, dif=ALLOY_LT, ao=AO_BASE - 2, rough=R_ARMOR, metal=M_ARMOR + 50)
    glow_rect(m, rfrac(r, p0, 0.18, p1, 0.82), e=0.9, inset=2)   # hot inner rim
    m.d.rectangle(rfrac(r, p2, 0.0, p3, 1.0), fill=ALLOY)        # outer rim


# ── assemble ─────────────────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_disc(m)
    paint_skirt(m)
    paint_dome(m)
    paint_collar(m)
    paint_core(m)
    paint_crown(m)
    paint_wraps(m)
    paint_fins(m)

    # geological weathering only — dust, soil, scorch. No rust: nothing on
    # this machine was ever bolted.
    from weathering import Weather
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.26)
    wx.mud_band(L.R_SKIRT.rect, 0.72, fade='down', dust=0.30)
    dx0, dy0, dx1, dy1 = L.R_DOME.rect
    _, dv = PL.zone_fns(L.R_DOME)
    wx.mud_band((dx0, dy0, dx1, dy1), 0.34, fade='down', dust=0.34)
    wx.mud_band(L.R_DISC.rect, 0.20, fade=None, spatter=False)
    wx.mud_band(L.R_FIN_FACE, 0.22, fade='down', dust=0.26)
    wx.mud_band(L.R_STUB, 0.34, fade='left', dust=0.20)
    wx.mud_band(L.R_PYLON, 0.24, fade='left', dust=0.22)
    # scorch: the crater floor and the dome's buried skirt
    ax0, ay0, ax1, ay1 = L.R_DISC.rect
    acx, acy = (ax0 + ax1) / 2.0, (ay0 + ay1) / 2.0
    ppm = (ax1 - ax0) / 26.4
    wx.soot_patch((acx - 9.4 * ppm, acy - 9.4 * ppm,
                   acx + 9.4 * ppm, acy + 9.4 * ppm), 0.24)
    wx.soot_patch((dx0, int(dv(0.55)), dx1, dy1), 0.26)
    wx.apply(m)

    # recessed seams read in the normal map, not as geometry
    from normals import HeightMap
    hm = HeightMap()
    _, sv = PL.zone_fns(L.R_DOME)
    ths = [L.DOME_TH_MAX * k / L.DOME_BANDS for k in range(L.DOME_BANDS + 1)]
    for th in ths[1:-1]:
        yy = L.DOME_CY + L.DOME_R * np.sin(th)
        hm.line((dx0 + 2, sv(yy)), (dx1 - 2, sv(yy)), -0.75, width=5)
    hm.crevices_from(m.dif, 0.45)
    hm.weather_from(wx)

    PL.finish(m, L, 'ms_anc_reactor', hm=hm, wx=None, emissive_blur=0.8)


if __name__ == '__main__':
    paint_all()
