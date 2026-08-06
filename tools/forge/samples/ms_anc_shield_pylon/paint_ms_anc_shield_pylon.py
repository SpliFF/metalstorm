"""paint_ms_anc_shield_pylon — 2048² PBR set for ms_anc_shield_pylon.

ANCIENT register: monolithic, precise, seamless. Large unbroken basalt-alloy
surfaces segmented ONLY by clean recessed seams — no rivets, no bolted
patches, no scrap plates. Emissive CYAN is the signature: charge-lines
climbing the three corner edges, the vane crests, the corona lens nodes,
the focus-plate rim and the floating crystal core — ACTIVE, so the cyan
flows. Weathering is geological: soil burial at the base, dust drift, a
faint scorch halo — never rust streaks.

One concession to the scavenger present: a small inlaid TEAM panel on the
forward anchor vane (capturable defense infrastructure). Team colour lives
only in the team-mask R channel.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_shield_pylon_layout as L   # sets meshlib.ATLAS = 2048
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
STEM = 'ms_anc_shield_pylon'

ALLOY = (86, 94, 103)        # pale basalt-alloy — the ancient body colour.
ALLOY_LT = (106, 115, 124)   # kept light enough to block-read at zoom, which
ALLOY_DK = (64, 71, 79)      # a near-black monolith never does.
ALLOY_XD = (42, 47, 53)
CYAN = (72, 240, 255)
CYAN_MID = (46, 172, 194)
CYAN_DIM = (30, 112, 128)
SOIL = (92, 78, 62)
SCORCH = (34, 32, 29)

RNG = np.random.default_rng(90210)


# ── shaft strips ────────────────────────────────────────────────────────

def sx(rect, fu, y):
    return L.shaft_px(rect, fu, y)


def paint_flanks(m):
    """Three broad unbroken flanks: one tall strip, tone-on-tone only."""
    x0, y0, x1, y1 = L.R_FACE
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR + 45)

    segs = [(0.45, L.SH_GROOVES[0])]
    for i, gy in enumerate(L.SH_GROOVES):
        top = L.SH_GROOVES[i + 1] if i + 1 < len(L.SH_GROOVES) else L.SH_Y1
        segs.append((gy + L.GROOVE_H, top))

    # segment tone-on-tone: alternate +-6% so the monolith reads as stacked
    # blocks without ever breaking the surface (baker-safe on large quads)
    for i, (a, b) in enumerate(segs):
        pa, pb = sx(L.R_FACE, 0.0, b), sx(L.R_FACE, 1.0, a)
        m.d.rectangle([pa[0], pa[1], pb[0], pb[1]],
                      fill=shade(ALLOY, 1.0 + (0.085 if i % 2 else -0.07)))

    # the recessed seams themselves: deep shadow, a bright inner lip
    for gy in L.SH_GROOVES:
        pa = sx(L.R_FACE, 0.0, gy + L.GROOVE_H)
        pb = sx(L.R_FACE, 1.0, gy)
        fill(m, (pa[0], pa[1], pb[0], pb[1]), dif=ALLOY_XD, ao=AO_DEEP,
             rough=R_ARMOR + 20, metal=M_ARMOR + 20)
        lip = sx(L.R_FACE, 0.0, gy + L.GROOVE_H)
        m.d.line([(pa[0], lip[1] + 1), (pb[0], lip[1] + 1)],
                 fill=shade(ALLOY_LT, 1.05), width=3)

    # inlaid tracery: kept OFF the u=0.5 quad centroid so the impostor
    # baker never floods a whole flank with it
    for fu in (0.20, 0.80):
        for (a, b) in segs:
            pa, pb = sx(L.R_FACE, fu, b + 0.0), sx(L.R_FACE, fu, a)
            m.d.line([(pa[0], pa[1] + 6), (pb[0], pb[1] - 6)],
                     fill=CYAN_DIM, width=5)
            m.e.line([(pa[0], pa[1] + 6), (pb[0], pb[1] - 6)],
                     fill=shade(CYAN, 0.55), width=3)

    # one large inscribed glyph ring per segment, off-centre (u = 0.20)
    for (a, b) in segs[1:]:
        cy = (a + b) / 2
        if b - a < 1.6:
            continue
        cx_, cyy = sx(L.R_FACE, 0.20, cy)
        rx, ry = 42, 26
        m.d.ellipse([cx_ - rx, cyy - ry, cx_ + rx, cyy + ry],
                    outline=CYAN_DIM, width=5)
        m.e.ellipse([cx_ - rx, cyy - ry, cx_ + rx, cyy + ry],
                    outline=shade(CYAN, 0.5), width=3)

    # geological base: soil creep and a faint scorch lick, no rust
    top = sx(L.R_FACE, 0.0, 1.45)
    bot = sx(L.R_FACE, 1.0, 0.45)
    fill(m, (top[0], top[1], bot[0], bot[1]), dif=shade(ALLOY_DK, 0.86),
         ao=AO_SEAM, rough=R_ARMOR + 26, metal=M_ARMOR)


def paint_edges(m):
    """The three corner edges — cyan charge-lines climbing to the corona."""
    x0, y0, x1, y1 = L.R_EDGE
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 8, rough=R_ARMOR - 6,
         metal=M_ARMOR + 60)
    # recessed channel down the middle of the chamfer
    ca = sx(L.R_EDGE, 0.28, L.SH_Y1)
    cb = sx(L.R_EDGE, 0.72, 0.45)
    fill(m, (ca[0], ca[1], cb[0], cb[1]), dif=ALLOY_XD, ao=AO_DEEP,
         rough=R_ARMOR + 10, metal=M_ARMOR + 20)

    # the charge-line itself: continuous, with nodes that tighten upward
    ta = sx(L.R_EDGE, 0.50, 15.15)
    tb = sx(L.R_EDGE, 0.50, 0.70)
    m.d.line([ta, tb], fill=CYAN_DIM, width=13)
    m.e.line([ta, tb], fill=shade(CYAN, 0.80), width=9)

    n_nodes = 17
    for i in range(n_nodes):
        # exponent < 1 -> the nodes bunch up as they climb
        y = 0.90 + 14.05 * (i / (n_nodes - 1)) ** 0.72
        na = sx(L.R_EDGE, 0.30, y + 0.09)
        nb = sx(L.R_EDGE, 0.70, y - 0.09)
        m.d.rectangle([na[0], na[1], nb[0], nb[1]], fill=CYAN_MID)
        m.e.rectangle([na[0], na[1], nb[0], nb[1]], fill=CYAN)

    # buried foot
    ba = sx(L.R_EDGE, 0.0, 1.25)
    bb = sx(L.R_EDGE, 1.0, 0.45)
    m.d.rectangle([ba[0], ba[1], bb[0], bb[1]], fill=shade(ALLOY_XD, 0.9))


# ── base pad, plinth, vanes ────────────────────────────────────────────

def paint_base(m):
    z = L.R_PAD_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(SOIL, 0.85), ao=AO_BASE - 12,
         rough=R_ARMOR + 30, metal=M_ARMOR)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    ppm = (x1 - x0) / (2 * (L.PAD_R + 0.05))          # px per metre

    # the pad itself is largely swallowed by soil; concentric recessed
    # rings surface where the drift is thin
    for rr, col in ((5.30, ALLOY_DK), (4.95, ALLOY_XD), (4.55, ALLOY),
                    (3.55, ALLOY_DK), (3.20, ALLOY_XD), (2.90, ALLOY)):
        r = rr * ppm
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    # inlaid cyan conduit ring feeding the vanes
    r = 3.05 * ppm
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CYAN_DIM, width=9)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade(CYAN, 0.45),
                width=5)
    # soil drift lobes (geological, not mechanical)
    for a in RNG.uniform(0, 2 * np.pi, 13):
        rr = RNG.uniform(3.2, 5.4) * ppm
        w = RNG.uniform(0.9, 1.9) * ppm
        m.d.ellipse([cx + rr * np.cos(a) - w, cy + rr * np.sin(a) - w,
                     cx + rr * np.cos(a) + w, cy + rr * np.sin(a) + w],
                    fill=shade(SOIL, RNG.uniform(0.92, 1.08)))
    # faint scorch halo under the emitter axis
    r = 1.9 * ppm
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SCORCH)

    fill(m, L.R_PAD_SIDE, dif=shade(SOIL, 0.7), ao=AO_SEAM,
         rough=R_ARMOR + 34, metal=M_ARMOR)

    # plinth top: clean, unbroken, one big inlaid ring glyph in the annulus
    z = L.R_PLINTH_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ALLOY, 0.96), ao=AO_BASE,
         rough=R_ARMOR - 4, metal=M_ARMOR + 50)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    ppm = (x1 - x0) / (2 * (L.PLINTH_R + 0.05))
    for rr, wdt, col in ((2.20, 6, ALLOY_DK), (1.86, 5, ALLOY_DK)):
        r = rr * ppm
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=wdt)
    r = 2.03 * ppm
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CYAN_DIM, width=7)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade(CYAN, 0.5),
                width=4)

    # plinth side: shallow flutes on the facet boundaries only (their
    # centroids stay on base tone, so the impostor keeps a clean drum)
    x0, y0, x1, y1 = L.R_PLINTH_SIDE
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR + 45)
    for j in range(L.NGON_BASE + 1):
        px = x0 + (x1 - x0) * j / L.NGON_BASE
        m.d.line([(px, y0), (px, y1)], fill=ALLOY_XD, width=4)
    m.d.rectangle([x0, y1 - 22, x1, y1], fill=shade(SOIL, 0.8))


def paint_vane(m, rect, team=False):
    x0, y0, x1, y1 = rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 2, rough=R_ARMOR,
         metal=M_ARMOR + 45)

    def px(r, y):
        return L.vane_px(rect, r, y)

    # recessed inner outline echoing the buttress profile (seamless inlay)
    poly = [px(r * 0.90 + 0.30, yy * 0.86 + 0.18) for (r, yy) in L.VANE_PROFILE]
    m.d.polygon(poly, outline=ALLOY_XD, width=6)
    m.d.polygon([(a + 3, b + 2) for (a, b) in poly],
                outline=shade(ALLOY_LT, 1.03), width=2)

    # cyan spine: charge running from the shaft down into the ground
    spine = [px(0.98, 4.10), px(1.90, 3.35), px(3.10, 1.95), px(4.35, 0.55),
             px(4.60, 0.18)]
    m.d.line(spine, fill=CYAN_DIM, width=9, joint='curve')
    m.e.line(spine, fill=shade(CYAN, 0.6), width=5, joint='curve')
    for pt in (px(2.35, 2.86), px(3.60, 1.50)):
        m.d.ellipse([pt[0] - 22, pt[1] - 8, pt[0] + 22, pt[1] + 8],
                    fill=CYAN_MID)
        m.e.ellipse([pt[0] - 22, pt[1] - 8, pt[0] + 22, pt[1] + 8], fill=CYAN)

    if team:
        # capture socket: a small inlaid team panel in a cyan-lipped recess
        a, b = px(1.55, 3.10), px(2.35, 2.30)
        fr = PL.nbox(a[0] - 10, a[1] - 7, b[0] + 10, b[1] + 7)
        m.d.rectangle(fr, fill=ALLOY_XD)
        m.d.rectangle(fr, outline=CYAN_DIM, width=4)
        m.e.rectangle(fr, outline=shade(CYAN, 0.45), width=2)
        PL.team_panel(m, PL.nbox(a[0], a[1], b[0], b[1]), outline=ALLOY_XD)

    # soil burial along the foot
    g = px(L.VANE_R0, 0.62)
    m.d.rectangle([x0, g[1], x1, y1], fill=shade(SOIL, 0.78))


def paint_vane_edges(m):
    x0, y0, x1, y1 = L.R_VANE_EDGE
    h = y1 - y0
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR + 50)
    # bevel bands catch light; the middle rim band is the true edge
    m.d.rectangle([x0, y0, x1, y0 + h / 6], fill=ALLOY_LT)
    m.d.rectangle([x0, y0 + h / 3, x1, y0 + h / 2], fill=ALLOY_LT)
    # crest charge-line: profile edges 0..2 are the swept top of the vane
    ca, cb = x0, x0 + (x1 - x0) * 0.5
    m.d.rectangle([ca, y0 + h / 5, cb, y0 + h / 3.2], fill=CYAN_DIM)
    m.e.rectangle([ca, y0 + h / 5, cb, y0 + h / 3.2], fill=shade(CYAN, 0.65))
    # ground-contact edge (profile edge 4) buried in soil
    ga, gb = x0 + (x1 - x0) * 4 / 6, x0 + (x1 - x0) * 5 / 6
    m.d.rectangle([ga, y0, gb, y0 + h / 2], fill=shade(SOIL, 0.75))


# ── corona, plate, cap, crystal ────────────────────────────────────────

def paint_upper(m):
    # arms
    x0, y0, x1, y1 = L.R_ARM
    h = y1 - y0
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR - 6,
         metal=M_ARMOR + 55)
    for fv in (1 / 12, 7 / 12):
        yy = y0 + h * fv
        m.d.rectangle([x0, yy - 5, x1, yy + 5], fill=CYAN_DIM)
        m.e.rectangle([x0, yy - 3, x1, yy + 3], fill=shade(CYAN, 0.6))
    m.d.rectangle([x1 - 40, y0, x1, y1], fill=CYAN_MID)     # arm tip collar
    m.e.rectangle([x1 - 40, y0, x1, y1], fill=shade(CYAN, 0.75))

    # corona lens nodes — dark block with a glowing equator
    x0, y0, x1, y1 = L.R_NODE.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR + 50)
    mid = (y0 + y1) / 2
    m.d.rectangle([x0, mid - 15, x1, mid + 15], fill=CYAN_MID)
    fill(m, (x0, mid - 15, x1, mid + 15), rough=R_GLOW, metal=M_GLASS)
    m.e.rectangle([x0, mid - 12, x1, mid + 12], fill=CYAN)

    # focus plate: dark disc, hot rim
    x0, y0, x1, y1 = L.R_PLATE
    h = y1 - y0
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 4, rough=R_ARMOR,
         metal=M_ARMOR + 55)
    m.d.rectangle([x0, y0 + h * 0.42, x1, y0 + h * 0.58], fill=CYAN_DIM)
    m.e.rectangle([x0, y0 + h * 0.44, x1, y0 + h * 0.56],
                  fill=shade(CYAN, 0.85))

    z = L.R_PLATE_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY, ao=AO_BASE - 4, rough=R_ARMOR - 4,
         metal=M_ARMOR + 55)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    ppm = (x1 - x0) / 3.0
    for rr in (1.20, 0.92):
        r = rr * ppm
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ALLOY_XD, width=5)
    r = 1.06 * ppm
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CYAN_DIM, width=6)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], outline=shade(CYAN, 0.55),
                width=4)

    # shaft cap: the levitation socket the crystal hangs over
    z = L.R_CAP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ALLOY_XD, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR + 40)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    ppm = (x1 - x0) / 1.24
    r = 0.34 * ppm
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CYAN_MID)
    fill(m, (cx - r, cy - r, cx + r, cy + r), rough=R_GLASS, metal=M_GLASS)
    m.e.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CYAN)
    r2 = 0.50 * ppm
    m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], outline=CYAN_DIM, width=5)
    m.e.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], outline=shade(CYAN, 0.5),
                width=3)


def paint_crystal(m):
    x0, y0, x1, y1 = L.R_EMIT
    h = y1 - y0
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 6, rough=R_ARMOR - 20,
         metal=M_ARMOR + 70)
    # v runs bottom tip -> top tip; the waist bands are the lit core
    m.d.rectangle([x0, y0 + h / 3, x1, y0 + 2 * h / 3], fill=CYAN_MID)
    fill(m, (x0, y0 + h / 3, x1, y0 + 2 * h / 3), ao=AO_BASE, rough=R_GLOW,
         metal=M_GLASS)
    m.e.rectangle([x0, y0 + h / 3 + 6, x1, y0 + 2 * h / 3 - 6], fill=CYAN)
    # facet seams (u boundaries) so the crystal keeps hard edges
    for j in range(7):
        px = x0 + (x1 - x0) * j / 6
        m.d.line([(px, y0), (px, y1)], fill=ALLOY_XD, width=4)
    # tip gradients
    m.d.rectangle([x0, y0, x1, y0 + h / 12], fill=ALLOY_XD)
    m.d.rectangle([x0, y1 - h / 12, x1, y1], fill=ALLOY_XD)

    x0, y0, x1, y1 = L.R_SHARD
    fill(m, (x0, y0, x1, y1), dif=ALLOY_DK, ao=AO_BASE - 6, rough=R_ARMOR - 10,
         metal=M_ARMOR + 60)
    n = 26
    for i in range(n):                                    # u = along the shard
        a = x0 + (x1 - x0) * i / n
        b = x0 + (x1 - x0) * (i + 1) / n
        f = (i + 0.5) / n
        col = tuple(int(p + (q - p) * f ** 1.6)
                    for p, q in zip(ALLOY_DK, CYAN_MID))
        m.d.rectangle([a, y0, b, y1], fill=col)
        if f > 0.45:
            m.e.rectangle([a, y0, b, y1], fill=shade(CYAN, 0.25 + 0.75 * f))

    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_ARMOR + 20,
         metal=M_ARMOR)


# ── assemble ───────────────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_flanks(m)
    paint_edges(m)
    paint_base(m)
    paint_vane(m, L.R_VANE0, team=True)
    paint_vane(m, L.R_VANE, team=False)
    paint_vane_edges(m)
    paint_upper(m)
    paint_crystal(m)

    # ancient tech is seamless: geological weathering ONLY — soil burial,
    # dust drift, crevice grime. No bolt rust, no patch streaks.
    from weathering import Weather
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.22)
    wx.mud_band(L.R_PAD_SIDE, 0.85, fade=None)
    wx.mud_band(L.R_PAD_TOP.rect, 0.55, fade=None)
    wx.mud_band(L.R_PLINTH_SIDE, 0.60, fade='down', dust=0.35)
    for rect in (L.R_VANE0, L.R_VANE):
        wx.mud_band(rect, 0.45, fade='down', dust=0.3)
    lo = L.shaft_px(L.R_FACE, 0.0, 2.10)
    wx.mud_band((L.R_FACE[0], lo[1], L.R_FACE[2], L.R_FACE[3]), 0.32,
                fade='down', dust=0.28)
    lo = L.shaft_px(L.R_EDGE, 0.0, 1.60)
    wx.mud_band((L.R_EDGE[0], lo[1], L.R_EDGE[2], L.R_EDGE[3]), 0.28,
                fade='down', dust=0.25)
    wx.soot_patch(L.R_PAD_TOP.rect, 0.30)

    hm = NM.HeightMap()
    # recessed seams are real geometry AND real normal-map grooves
    for gy in L.SH_GROOVES:
        for rect in (L.R_FACE, L.R_EDGE):
            a = L.shaft_px(rect, 0.0, gy + L.GROOVE_H)
            b = L.shaft_px(rect, 1.0, gy)
            hm.rect([a[0], a[1], b[0], b[1]], -0.7)
    a = L.shaft_px(L.R_EDGE, 0.28, L.SH_Y1)
    b = L.shaft_px(L.R_EDGE, 0.72, 0.45)
    hm.rect([a[0], a[1], b[0], b[1]], -0.55)
    for rect in (L.R_VANE0, L.R_VANE):
        poly = [L.vane_px(rect, r * 0.90 + 0.30, y * 0.86 + 0.18)
                for (r, y) in L.VANE_PROFILE]
        for i in range(len(poly)):
            hm.line(poly[i], poly[(i + 1) % len(poly)], -0.6, width=5)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
