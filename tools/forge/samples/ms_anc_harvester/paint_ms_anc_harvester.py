"""paint_ms_anc_harvester — 2048² PBR set for ms_anc_harvester.

ANCIENT REGISTER. This is not scavenger hardware and must never read as it:
no rivets, no bolts, no mismatched plates, no rust streaks. The whole machine
is one pale bone-grey monolith divided by CLEAN RECESSED SEAMS, with ACTIVE
cyan tracery running the seam network — the harvester still works, so the
cyan flows rather than smoulders. Weathering is geological: soil burial up
the skirts, dust drifts on every horizontal ledge, scorch around the cutting
face. The only team colour is the continuous capture band around the hopper.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_harvester_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, shade, jit, BOLT_LOG, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP)

W = 2048
STEM = 'ms_anc_harvester'

# ── ancient palette ─────────────────────────────────────────────────────
ANC     = (150, 148, 139)      # the monolith
ANC_LT  = (174, 172, 162)
ANC_DK  = (116, 115, 108)
ANC_DP  = (76, 76, 73)         # inside a recessed seam
VOID    = (26, 28, 31)
CHAN    = (40, 52, 56)         # diffuse inside a LIT channel
CY      = (86, 226, 255)       # emissive cyan — ancient tech ONLY
CY_MID  = (46, 152, 184)
CY_DIM  = (20, 74, 92)
ORE     = (92, 85, 76)         # graded ore — a lit bin, not a black hole
ORE_LT  = (128, 119, 105)
SOIL    = (94, 80, 62)

R_ANC, M_ANC = 132, 84         # ORM: smooth-ish stone-metal
R_ROUGH, M_ROUGH = 186, 26


# ── ancient surface grammar ─────────────────────────────────────────────

def field(m, rect, base=ANC, bands=6, amp=0.055, horiz=True,
          rough=R_ANC, metal=M_ANC, ao=AO_BASE):
    """A large unbroken surface: flat base plus a very low-contrast tonal
    drift (±6%) so it never reads dead, and never confuses the impostor
    baker (see FORGE-GUIDE: keep large-quad cells tone-on-tone)."""
    x0, y0, x1, y1 = [int(v) for v in rect]
    fill(m, (x0, y0, x1, y1), dif=base, ao=ao, rough=rough, metal=metal)
    for i in range(bands):
        f = 1.0 + amp * float(np.sin(i * 1.9 + 0.6))
        if horiz:
            a = y0 + (y1 - y0) * i / bands
            b = y0 + (y1 - y0) * (i + 1) / bands
            m.d.rectangle([x0, a, x1, b], fill=shade(base, f))
        else:
            a = x0 + (x1 - x0) * i / bands
            b = x0 + (x1 - x0) * (i + 1) / bands
            m.d.rectangle([a, y0, b, y1], fill=shade(base, f))


def rseam(m, box, base=ANC, lit=None, lip=True):
    """Recessed seam channel: a dark cut with a bright lip on one side.
    `lit` = emissive colour to run down its centre (ancient tracery)."""
    x0, y0, x1, y1 = [int(v) for v in box]
    m.d.rectangle([x0, y0, x1, y1], fill=shade(base, 0.52) if lit is None
                  else CHAN)
    m.o.rectangle([x0, y0, x1, y1],
                  fill=(AO_SEAM, min(255, R_ANC + 30), M_ANC))
    if lip:
        if (x1 - x0) >= (y1 - y0):
            m.d.line([(x0, y0 - 1), (x1, y0 - 1)], fill=shade(base, 1.16))
        else:
            m.d.line([(x0 - 1, y0), (x0 - 1, y1)], fill=shade(base, 1.16))
    if lit is not None:
        if (x1 - x0) >= (y1 - y0):
            cy = (y0 + y1) / 2
            m.e.rectangle([x0, cy - 1.5, x1, cy + 1.5], fill=lit)
        else:
            cx = (x0 + x1) / 2
            m.e.rectangle([cx - 1.5, y0, cx + 1.5, y1], fill=lit)


def tracery(m, box, base=ANC, glow=CY, gaps=5, gap=0.035, lit=True):
    """A segmented lit seam — ancient tracery reads as a broken line."""
    x0, y0, x1, y1 = [float(v) for v in box]
    horiz = (x1 - x0) >= (y1 - y0)
    span = (x1 - x0) if horiz else (y1 - y0)
    seg = span * (1.0 - gap * (gaps - 1)) / gaps
    t = 0.0
    for i in range(gaps):
        if horiz:
            rseam(m, (x0 + t, y0, x0 + t + seg, y1), base,
                  lit=glow if lit else None)
        else:
            rseam(m, (x0, y0 + t, x1, y0 + t + seg), base,
                  lit=glow if lit else None)
        t += seg + span * gap


def ring_set(m, cx, cy, rx, ry, base=ANC, lit_at=(0.72,), n_notch=12,
             hub=True):
    """Concentric PERFECT circles with a lit ring and n-fold notches —
    the ancient bearing/core motif. rx/ry let a zone's anisotropic
    projection still produce a true world-space circle."""
    def ell(f, **kw):
        m.d.ellipse([cx - rx * f, cy - ry * f, cx + rx * f, cy + ry * f], **kw)
    ell(1.00, fill=shade(base, 0.80))
    ell(0.90, fill=shade(base, 1.06))
    ell(0.62, fill=shade(base, 0.90))
    for f in (0.98, 0.86, 0.56):
        ell(f, outline=shade(base, 0.48), width=3)
    for f in lit_at:
        m.d.ellipse([cx - rx * f, cy - ry * f, cx + rx * f, cy + ry * f],
                    outline=CHAN, width=7)
        m.e.ellipse([cx - rx * f, cy - ry * f, cx + rx * f, cy + ry * f],
                    outline=CY, width=3)
    for i in range(n_notch):
        a = 2 * np.pi * i / n_notch
        m.d.line([(cx + rx * 0.62 * np.cos(a), cy + ry * 0.62 * np.sin(a)),
                  (cx + rx * 0.86 * np.cos(a), cy + ry * 0.86 * np.sin(a))],
                 fill=shade(base, 0.52), width=5)
    if hub:
        ell(0.30, fill=VOID)
        m.e.ellipse([cx - rx * 0.22, cy - ry * 0.22,
                     cx + rx * 0.22, cy + ry * 0.22], fill=CY)
        m.o.ellipse([cx - rx * 0.30, cy - ry * 0.30,
                     cx + rx * 0.30, cy + ry * 0.30],
                    fill=(AO_DEEP, 90, 40))


# ── hull ────────────────────────────────────────────────────────────────

def paint_hull_top(m):
    z = L.A_HULL_TOP
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    field(m, z.rect, ANC, bands=7, amp=0.05)
    # long unbroken longitudinal seams
    for wx in (-2.45, -1.55, 1.55, 2.45):
        rseam(m, (u(wx) - 4, y0, u(wx) + 4, y1), ANC)
    # transverse breaks
    for wz in (-5.35, -4.55, 4.35, 5.55):
        rseam(m, (x0, v(wz) - 4, x1, v(wz) + 4), ANC)
    # ACTIVE spine tracery fore and aft of the plinth
    tracery(m, (u(-0.09), v(-5.30), u(0.09), v(-4.60)), ANC, gaps=3)
    tracery(m, (u(-0.09), v(4.40), u(0.09), v(5.50)), ANC, gaps=4)
    # plinth collar: a recessed lit rectangle the hopper grows out of
    pb = PL.nbox(u(-2.55), v(-4.40), u(2.55), v(4.00))
    m.d.rectangle(pb, fill=shade(ANC, 0.92))
    rseam(m, (pb[0], pb[1], pb[2], pb[1] + 9), ANC, lit=CY_MID)
    rseam(m, (pb[0], pb[3] - 9, pb[2], pb[3]), ANC, lit=CY_MID)
    rseam(m, (pb[0], pb[1], pb[0] + 9, pb[3]), ANC, lit=CY_MID)
    rseam(m, (pb[2] - 9, pb[1], pb[2], pb[3]), ANC, lit=CY_MID)
    # forward deck: two great inlaid discs flanking the core (paint only)
    for wx in (-1.98, 1.98):
        ring_set(m, u(wx), v(-2.10), abs(u(0.62) - u(0.0)),
                 abs(v(-2.10 + 0.62) - v(-2.10)), ANC, lit_at=(0.74,),
                 n_notch=8)


def paint_hull_side(m):
    z = L.A_HULL_SIDE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    field(m, z.rect, ANC, bands=5, amp=0.05)
    # lower mass reads heavier (and takes the soil burial)
    m.d.rectangle([x0, v(1.62), x1, y1], fill=ANC_DK)
    m.o.rectangle([x0, v(1.62), x1, y1], fill=(AO_BASE - 18, R_ANC + 24, M_ANC))
    rseam(m, (x0, v(1.62) - 4, x1, v(1.62) + 4), ANC)
    rseam(m, (x0, v(2.22) - 5, x1, v(2.22) + 5), ANC)
    # ACTIVE longitudinal tracery just under the shoulder
    tracery(m, (u(-6.30), v(2.44) - 4, u(6.10), v(2.44) + 4), ANC, gaps=6)
    # vertical seam network — clean, evenly spaced, no patches
    for wz in (-4.9, -3.4, -1.9, -0.4, 1.1, 2.6, 4.1, 5.4):
        rseam(m, (u(wz) - 4, v(2.95), u(wz) + 4, v(1.62)), ANC)
    # a great inlaid glyph plate amidships
    gb = [u(-1.5), v(2.90), u(1.9), v(1.75)]
    m.d.rectangle(gb, fill=shade(ANC, 1.05))
    m.d.rectangle(gb, outline=shade(ANC, 0.5), width=4)
    for i in range(4):
        gx = gb[0] + (gb[2] - gb[0]) * (i + 1) / 5.0
        m.d.line([(gx, gb[1] + 10), (gx, gb[3] - 10)],
                 fill=shade(ANC, 0.62), width=4)
        if i % 2 == 0:
            m.e.line([(gx, gb[1] + 14), (gx, gb[3] - 14)], fill=CY_MID,
                     width=2)


def _end_face(m, z, glow_ring, forward):
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    field(m, z.rect, ANC_DK, bands=4, amp=0.05)
    cx = (x0 + x1) / 2
    top, bot = v(2.86), v(1.20)

    def ly(f):                       # 0 = panel bottom, 1 = panel top
        return bot + (top - bot) * f

    # one great recessed panel with a raised centre gable
    poly = [(u(-2.30), ly(0.0)), (u(-2.30), ly(0.82)), (cx, ly(1.0)),
            (u(2.30), ly(0.82)), (u(2.30), ly(0.0))]
    m.d.polygon(poly, fill=shade(ANC_DK, 0.88))
    m.d.line(poly + [poly[0]], fill=shade(ANC_DK, 0.5), width=5)
    if forward:
        for k, f in enumerate((0.0, 0.15, 0.30)):
            ch = [(u(-1.75), ly(0.26 + f)), (cx, ly(0.46 + f)),
                  (u(1.75), ly(0.26 + f))]
            m.d.line(ch, fill=CHAN, width=11)
            m.e.line(ch, fill=CY if k == 0 else CY_MID, width=4)
    else:
        ring_set(m, cx, ly(0.48), abs(u(0.80) - u(0.0)),
                 abs(v(1.20 + 0.80) - v(1.20)), ANC_DK, lit_at=(0.74,),
                 n_notch=12)
    rseam(m, (x0, v(1.30) - 4, x1, v(1.30) + 4), ANC_DK, lit=glow_ring)


def paint_hull_front(m):
    _end_face(m, L.A_HULL_FRONT, CY_MID, forward=True)


def paint_hull_rear(m):
    _end_face(m, L.A_HULL_REAR, CY_MID, forward=False)


# ── sealed track skirts ────────────────────────────────────────────────

def paint_skirt_side(m):
    z = L.A_SKIRT_SIDE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    field(m, z.rect, ANC_DK, bands=5, amp=0.05)
    # the sealed run: one continuous darker band, no wheels, no bogies
    m.d.rectangle([x0, v(1.05), x1, v(0.02)], fill=shade(ANC_DK, 0.91))
    m.o.rectangle([x0, v(1.05), x1, v(0.02)],
                  fill=(AO_BASE - 26, R_ROUGH, 30))
    rseam(m, (x0, v(1.05) - 5, x1, v(1.05) + 5), ANC_DK)
    rseam(m, (x0, v(1.60) - 4, x1, v(1.60) + 4), ANC_DK)
    # ACTIVE guide tracery along the drive line
    tracery(m, (u(-6.20), v(1.36) - 4, u(6.10), v(1.36) + 4), ANC_DK, gaps=7)
    # clean transverse seams — the skirt is segmented, not plated
    for i in range(11):
        wz = -6.0 + i * 1.2
        rseam(m, (u(wz) - 4, v(1.86), u(wz) + 4, v(1.10)), ANC_DK)
    # bow/stern ramps read as one solid casting
    for wz in (-6.20, 6.10):
        m.d.ellipse([u(wz) - 26, v(0.95) - 26, u(wz) + 26, v(0.95) + 26],
                    outline=shade(ANC_DK, 0.5), width=4)


def paint_skirt_wrap(m):
    x0, y0, x1, y1 = L.A_SKIRT_WRAP
    fill(m, (x0, y0, x1, y1), dif=shade(ANC_DK, 0.80), ao=AO_BASE - 30,
         rough=R_ROUGH, metal=24)
    # implied track: low-contrast cleat banding (tone-on-tone, no rivets)
    n = 104
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx, y0, lx + lw * 0.55, y1],
                      fill=shade(ANC_DK, 0.74 + 0.06 * (i % 3)))
    # two sealed guide channels running the whole loop
    for f in (0.26, 0.74):
        gy = y0 + (y1 - y0) * f
        m.d.rectangle([x0, gy - 4, x1, gy + 4], fill=CHAN)
        m.e.rectangle([x0, gy - 1, x1, gy + 1], fill=CY_DIM)


def paint_skirt_top(m):
    z = L.A_SKIRT_TOP
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    field(m, z.rect, ANC_LT, bands=4, amp=0.04)
    rseam(m, (x0, (y0 + y1) / 2 - 5, x1, (y0 + y1) / 2 + 5), ANC_LT)
    tracery(m, (u(-6.20), (y0 + y1) / 2 - 3, u(6.10), (y0 + y1) / 2 + 3),
            ANC_LT, glow=CY_MID, gaps=8)


# ── extraction drum ────────────────────────────────────────────────────

def paint_drum_barrel(m):
    """ONE flute period: crest at u=0 and u=1, valley at u=0.5. Painted
    symmetrically so all 12 flutes are identical under the idle spin."""
    x0, y0, x1, y1 = L.A_DRUM_BARREL
    wpx = x1 - x0
    fill(m, (x0, y0, x1, y1), dif=ANC, ao=AO_BASE - 10, rough=R_ANC + 20,
         metal=M_ANC + 30)
    # smooth crest->valley->crest gradient (the flute's own shading)
    steps = 26
    for i in range(steps):
        f0, f1 = i / steps, (i + 1) / steps
        t = abs(((f0 + f1) / 2) * 2 - 1)          # 1 at crests, 0 at valley
        c = shade(ANC, 0.62 + 0.50 * t)
        m.d.rectangle([x0 + wpx * f0, y0, x0 + wpx * f1 + 1, y1], fill=c)
    # cutting edges: a lit line right at each crest
    for f in (0.0, 1.0):
        cx = x0 + wpx * f
        m.d.rectangle([cx - 7, y0, cx + 7, y1], fill=CHAN)
        m.e.rectangle([cx - 3, y0, cx + 3, y1], fill=CY)
    # tapered end shoulders (v = along the drum axis)
    for a, b in ((y0, y0 + (y1 - y0) * 0.044), (y1 - (y1 - y0) * 0.044, y1)):
        m.d.rectangle([x0, a, x1, b], fill=shade(ANC_DP, 1.0))
    # the raised central collar reads as a lit band
    ca, cb = y0 + (y1 - y0) * 0.425, y0 + (y1 - y0) * 0.575
    m.d.rectangle([x0, ca, x1, cb], fill=shade(ANC, 1.06))
    for gy in (ca + 6, cb - 6):
        m.d.rectangle([x0, gy - 3, x1, gy + 3], fill=CHAN)
        m.e.rectangle([x0, gy - 1, x1, gy + 1], fill=CY_MID)


def paint_drum_cap(m):
    z = L.A_DRUM_CAP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 8, rough=R_ANC,
         metal=M_ANC + 30)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (x1 - x0) / 2 * (1.60 / 1.80)
    ring_set(m, cx, cy, r, r, ANC_DK, lit_at=(0.80, 0.44), n_notch=12)


# ── cantilevered hood ──────────────────────────────────────────────────

def paint_hood(m):
    x0, y0, x1, y1 = L.A_HOOD_OUT           # u = arc (root->lip), v = width
    field(m, (x0, y0, x1, y1), ANC_LT, bands=5, amp=0.045, horiz=False)
    for f in (0.22, 0.46, 0.70):            # transverse recessed seams
        gx = x0 + (x1 - x0) * f
        rseam(m, (gx - 5, y0, gx + 5, y1), ANC_LT)
    # three great chevrons pointing at the cutting face
    for k, f in enumerate((0.42, 0.58, 0.74)):
        ax = x0 + (x1 - x0) * f
        pts = [(ax - 46, y0 + 6), (ax + 46, (y0 + y1) / 2), (ax - 46, y1 - 6)]
        m.d.line(pts, fill=CHAN, width=15)
        m.e.line(pts, fill=(CY if k == 1 else CY_MID), width=6)
    # the lip: a continuous lit edge
    m.d.rectangle([x1 - 26, y0, x1, y1], fill=CHAN)
    m.e.rectangle([x1 - 16, y0, x1 - 4, y1], fill=CY)
    # longitudinal side seams
    for f in (0.06, 0.94):
        gy = y0 + (y1 - y0) * f
        rseam(m, (x0, gy - 4, x1, gy + 4), ANC_LT)

    x0, y0, x1, y1 = L.A_HOOD_IN            # under-hood: dark, drum-lit
    fill(m, (x0, y0, x1, y1), dif=VOID, ao=AO_DEEP, rough=R_ROUGH, metal=20)
    steps = 18
    for i in range(steps):
        f0, f1 = i / steps, (i + 1) / steps
        g = int(38 * (f0 ** 2.2))
        m.e.rectangle([x0 + (x1 - x0) * f0, y0, x0 + (x1 - x0) * f1 + 1, y1],
                      fill=(int(g * 0.35), int(g * 0.9), g))
    for f in (0.30, 0.62):
        gy = y0 + (y1 - y0) * f
        m.d.rectangle([x0, gy - 3, x1, gy + 3], fill=shade(VOID, 1.9))

    x0, y0, x1, y1 = L.A_HOOD_EDGE
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 12, rough=R_ANC,
         metal=M_ANC)
    gy = (y0 + y1) / 2
    m.d.rectangle([x0, gy - 5, x1, gy + 5], fill=CHAN)
    m.e.rectangle([x0, gy - 2, x1, gy + 2], fill=CY_MID)


# ── bearing cantilevers ────────────────────────────────────────────────

def paint_arms(m):
    z = L.A_ARM_OUT                          # the outer bearing face only
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    field(m, z.rect, ANC, bands=4, amp=0.05)
    bx, by, bz = L.BOSS_CTR
    rx = abs(u(bz + L.BOSS_R) - u(bz))
    ry = abs(v(by + L.BOSS_R) - v(by))
    ring_set(m, u(bz), v(by), rx, ry, ANC, lit_at=(0.78, 0.40), n_notch=12)

    z = L.A_ARM_TRIM                         # arm slab + boss rim
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    field(m, z.rect, ANC_DK, bands=4, amp=0.05)
    ax, ay, az, aw, ah, ad = L.ARM_BOX
    ab = PL.nbox(u(az - ad / 2), v(ay + ah / 2), u(az + ad / 2), v(ay - ah / 2))
    m.d.rectangle(ab, fill=shade(ANC_DK, 1.06))
    m.d.rectangle(ab, outline=shade(ANC_DK, 0.5), width=4)
    mid = (ab[1] + ab[3]) / 2
    m.d.rectangle([ab[0] + 8, mid - 5, ab[2] - 8, mid + 5], fill=CHAN)
    m.e.rectangle([ab[0] + 12, mid - 2, ab[2] - 12, mid + 2], fill=CY_MID)


# ── dorsal ore hopper (CAPTURABLE) ─────────────────────────────────────

def _hopper_face(m, z, sort_coords, coord_axis_fn):
    x0, y0, x1, y1 = z.rect
    u, v = coord_axis_fn
    field(m, z.rect, ANC_LT, bands=5, amp=0.05)
    ty0, ty1 = L.HOPPER_TEAM_Y
    # cyan sort-lines: the hopper grades ore behind these channels
    for i, c in enumerate(sort_coords):
        glow = CY if i % 2 == 0 else CY_MID
        rseam(m, (u(c) - 6, v(ty0) - 4, u(c) + 6, v(2.55)), ANC_LT, lit=glow)
    # rim + waist seams
    rseam(m, (x0, v(4.98) - 5, x1, v(4.98) + 5), ANC_LT)
    rseam(m, (x0, v(3.78) - 5, x1, v(3.78) + 5), ANC_LT)
    # CAPTURE BAND — the only team colour on the model
    band = PL.nbox(x0, v(ty1), x1, v(ty0))
    PL.team_panel(m, band)
    m.d.rectangle(band, outline=shade(ANC, 0.45), width=5)
    m.o.rectangle(band, fill=(AO_BASE, R_ANC + 14, M_ANC))
    # keep the band's edges out of the team mask so it reads as inlay
    m.t.rectangle([band[0], band[1], band[2], band[1] + 5], fill=(0, 0, 0))
    m.t.rectangle([band[0], band[3] - 5, band[2], band[3]], fill=(0, 0, 0))
    return band


def paint_hopper(m):
    zs = L.A_HOPPER_SIDE
    u, v = PL.zone_fns(zs)
    band = _hopper_face(m, zs, L.HOPPER_SORT_Z, (u, v))
    # a lit inlay line THROUGH the capture band (mask punched out under it)
    my = (band[1] + band[3]) / 2
    m.d.rectangle([band[0] + 10, my - 4, band[2] - 10, my + 4], fill=CHAN)
    m.t.rectangle([band[0] + 10, my - 4, band[2] - 10, my + 4], fill=(0, 0, 0))
    m.e.rectangle([band[0] + 14, my - 1, band[2] - 14, my + 1], fill=CY_MID)

    for z, flip in ((L.A_HOPPER_FRONT, False), (L.A_HOPPER_REAR, True)):
        u, v = PL.zone_fns(z)
        b = _hopper_face(m, z, (-2.15, -0.75, 0.75, 2.15), (u, v))
        if flip:
            # discharge aperture the chute springs from
            ap = PL.nbox(u(-1.72), v(4.34), u(1.72), v(3.30))
            m.d.rectangle(ap, fill=VOID)
            m.o.rectangle(ap, fill=(AO_DEEP, R_ROUGH, 20))
            m.t.rectangle(ap, fill=(0, 0, 0))
            m.d.rectangle(ap, outline=CHAN, width=9)
            m.e.rectangle([ap[0] + 3, ap[1] + 3, ap[2] - 3, ap[3] - 3],
                          outline=CY, width=4)
        else:
            ring_set(m, (b[0] + b[2]) / 2, v(3.20), abs(u(0.62) - u(0.0)),
                     abs(v(3.20 + 0.62) - v(3.20)), ANC, lit_at=(0.76,),
                     n_notch=8)

    # ore surface inside the hopper — a pale sorting bin holding graded ore
    z = L.A_HOPPER_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ORE, ao=AO_BASE - 40, rough=R_ROUGH,
         metal=40)
    rng = np.random.default_rng(90210)
    for _ in range(260):
        ox = x0 + rng.random() * (x1 - x0)
        oy = y0 + rng.random() * (y1 - y0)
        r = 4 + rng.random() * 16
        m.d.polygon([(ox, oy - r), (ox + r * 0.9, oy), (ox, oy + r * 0.8),
                     (ox - r * 0.85, oy + r * 0.1)],
                    fill=jit(ORE_LT if rng.random() < 0.40 else ORE, 9))
    for _ in range(44):                      # cyan-hot ore in the pile
        ox = x0 + 60 + rng.random() * (x1 - x0 - 120)
        oy = y0 + 60 + rng.random() * (y1 - y0 - 120)
        r = 3 + rng.random() * 6
        m.e.ellipse([ox - r, oy - r, ox + r, oy + r],
                    fill=(int(CY_MID[0] * 0.7), int(CY_MID[1] * 0.7),
                          int(CY_MID[2] * 0.7)))
    # pale sorting-bin rim so the lid never reads as a hole from above
    m.d.rectangle([x0, y0, x1, y1], outline=ANC_LT, width=40)
    m.o.rectangle([x0, y0, x1, y1], outline=(AO_BASE, R_ANC, M_ANC), width=40)
    m.d.rectangle([x0 + 36, y0 + 36, x1 - 36, y1 - 36], outline=CHAN, width=10)
    m.e.rectangle([x0 + 38, y0 + 38, x1 - 38, y1 - 38], outline=CY, width=5)

    # the lit sort-throat (hopper inner rim)
    x0, y0, x1, y1 = L.A_CORE.rect
    fill(m, (x0, y0, x1, y1), dif=CHAN, ao=AO_DEEP, rough=120, metal=60)
    for i in range(10):
        f0, f1 = i / 10, (i + 1) / 10
        g = 60 + int(180 * f0)
        m.e.rectangle([x0, y0 + (y1 - y0) * f0, x1, y0 + (y1 - y0) * f1 + 1],
                      fill=(int(g * 0.34), int(g * 0.88), g))


# ── discharge chute ────────────────────────────────────────────────────

def paint_chute(m):
    z = L.A_CHUTE_IN                        # ore path + wall crowns
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=shade(ORE, 1.15), ao=AO_DEEP,
         rough=R_ROUGH - 30, metal=70)
    for wx in (-0.86, 0.0, 0.86):           # flow tracery down the trough
        m.d.rectangle([u(wx) - 7, y0, u(wx) + 7, y1], fill=CHAN)
        m.e.rectangle([u(wx) - 2, y0, u(wx) + 2, y1], fill=CY_MID)
    for wa, wb in ((-1.70, -1.40), (1.40, 1.70)):    # wall crowns
        cb = PL.nbox(u(wa), y0, u(wb), y1)
        m.d.rectangle(cb, fill=ANC_LT)
        m.o.rectangle(cb, fill=(AO_BASE, R_ANC, M_ANC))
        m.e.rectangle(cb, fill=(0, 0, 0))
        m.d.rectangle([cb[0] + 5, y0, cb[0] + 11, y1], fill=shade(ANC_LT, 0.55))

    z = L.A_CHUTE_OUT                       # underside
    field(m, z.rect, ANC_DK, bands=4, amp=0.05)
    u, v = PL.zone_fns(z)
    for wx in (-0.80, 0.80):
        rseam(m, (u(wx) - 5, z.rect[1], u(wx) + 5, z.rect[3]), ANC_DK)

    z = L.A_CHUTE_SIDE                      # outer flanks
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    field(m, z.rect, ANC, bands=4, amp=0.05)
    rseam(m, (x0, v(0.10) - 5, x1, v(0.10) + 5), ANC)
    tracery(m, (u(0.20), v(-0.55) - 4, u(5.10), v(-0.55) + 4), ANC, gaps=4)
    for wz in (1.1, 2.4, 3.7):
        rseam(m, (u(wz) - 4, v(0.70), u(wz) + 4, v(-1.85)), ANC)

    x0, y0, x1, y1 = L.A_CHUTE_EDGE         # the discharge lip
    fill(m, (x0, y0, x1, y1), dif=CHAN, ao=AO_SEAM, rough=110, metal=60)
    m.e.rectangle([x0 + 4, y0, x1 - 4, y1], fill=CY)


# ── small cells ────────────────────────────────────────────────────────

def paint_cells(m):
    fill(m, L.A_DARK.rect, dif=VOID, ao=AO_DEEP, rough=200, metal=20)
    fill(m, L.A_TRIM, dif=ANC_DK, ao=AO_BASE - 10, rough=R_ANC, metal=M_ANC)

    # forward core disc rim
    x0, y0, x1, y1 = L.A_TRIM_BOX.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 6, rough=R_ANC,
         metal=M_ANC)
    gy = (y0 + y1) / 2
    m.d.rectangle([x0, gy - 6, x1, gy + 6], fill=CHAN)
    m.e.rectangle([x0, gy - 2, x1, gy + 2], fill=CY)

    # forward core disc face — the ancient heart, ACTIVE
    z = L.A_GLYPH
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE, rough=R_ANC,
         metal=M_ANC + 20)
    cx, cy = u(0.0), v(L.CORE_DISC[2])
    rx = abs(u(L.CORE_R) - u(0.0))
    ry = abs(v(L.CORE_DISC[2] + L.CORE_R) - cy)
    ring_set(m, cx, cy, rx, ry, ANC_LT, lit_at=(0.82, 0.50), n_notch=6)
    for i in range(6):                       # six-fold ancient glyph
        a = 2 * np.pi * i / 6 + np.pi / 6
        m.e.line([(cx + rx * 0.24 * np.cos(a), cy + ry * 0.24 * np.sin(a)),
                  (cx + rx * 0.48 * np.cos(a), cy + ry * 0.48 * np.sin(a))],
                 fill=CY, width=5)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()                 # ANCIENT: nothing bolted, ever
    m = Maps()
    paint_hull_top(m)
    paint_hull_side(m)
    paint_hull_front(m)
    paint_hull_rear(m)
    paint_skirt_side(m)
    paint_skirt_wrap(m)
    paint_skirt_top(m)
    paint_drum_barrel(m)
    paint_drum_cap(m)
    paint_hood(m)
    paint_arms(m)
    paint_hopper(m)
    paint_chute(m)
    paint_cells(m)

    # ── weathering: GEOLOGICAL (burial, dust drift, scorch) — no rust ──
    from weathering import Weather
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.42)
    # soil burial climbing the sealed skirts
    wx.mud_band(L.A_SKIRT_SIDE.rect, 0.66, fade='down', dust=0.26)
    wx.mud_band(L.A_SKIRT_WRAP, 0.60, fade=None)
    wx.mud_band(L.A_SKIRT_TOP.rect, 0.42, fade=None, spatter=False)
    # dust drifts on every horizontal ledge
    wx.mud_band(L.A_HULL_TOP.rect, 0.26, fade=None, spatter=False)
    wx.mud_band(L.A_HOOD_OUT, 0.30, fade='left', spatter=False)
    wx.mud_band(L.A_HOPPER_TOP.rect, 0.14, fade=None, spatter=False)
    wx.mud_band(L.A_CHUTE_OUT.rect, 0.34, fade=None, spatter=False)
    wx.mud_band(L.A_SKIRT_TOP.rect, 0.36, fade=None, spatter=False)
    # dry film fading up the vertical faces
    for z in (L.A_HULL_SIDE, L.A_HULL_FRONT, L.A_HULL_REAR):
        wx.mud_band(z.rect, 0.46, fade='down', dust=0.30, spatter=False)
    for z in (L.A_HOPPER_SIDE, L.A_HOPPER_FRONT, L.A_HOPPER_REAR,
              L.A_CHUTE_SIDE, L.A_ARM_OUT, L.A_ARM_TRIM):
        wx.mud_band(z.rect, 0.24, fade='down', dust=0.24, spatter=False)
    # scorch at the cutting face
    wx.soot_patch(L.A_HOOD_IN, 0.55)
    wx.soot_patch(L.A_DRUM_BARREL, 0.34)
    wx.soot_patch(L.A_HULL_FRONT.rect, 0.22)
    wx.soot_patch(L.A_DRUM_CAP.rect, 0.26)
    wx.oily(L.A_CHUTE_IN.rect, 0.30)

    # ── height field: recessed seams cut IN, inlays stand proud ──
    from normals import HeightMap
    hm = HeightMap()
    # batch the authored features into ONE sync (hm.rect syncs per call)
    us, vs = PL.zone_fns(L.A_HOPPER_SIDE)
    hx0, _, hx1, _ = L.A_HOPPER_SIDE.rect
    hm._d.rectangle(PL.nbox(hx0, vs(L.HOPPER_TEAM_Y[1]),
                            hx1, vs(L.HOPPER_TEAM_Y[0])), fill=0.35)
    # the drum flute: crests proud, valley cut
    dx0, dy0, dx1, dy1 = L.A_DRUM_BARREL
    for i in range(24):
        f0, f1 = i / 24, (i + 1) / 24
        t = abs(((f0 + f1) / 2) * 2 - 1)
        hm._d.rectangle([dx0 + (dx1 - dx0) * f0, dy0,
                         dx0 + (dx1 - dx0) * f1, dy1], fill=-0.45 + 0.95 * t)
    # skirt track cleats
    sx0, sy0, sx1, sy1 = L.A_SKIRT_WRAP
    for i in range(104):
        lx = sx0 + (sx1 - sx0) * i / 104
        lw = (sx1 - sx0) / 104
        hm._d.rectangle([lx, sy0, lx + lw * 0.55, sy1 - 1], fill=0.5)
    # hood chevrons cut in
    hox0, hoy0, hox1, hoy1 = L.A_HOOD_OUT
    for f in (0.42, 0.58, 0.74):
        ax = hox0 + (hox1 - hox0) * f
        hm._d.line([(ax - 46, hoy0 + 6), (ax + 46, (hoy0 + hoy1) / 2),
                    (ax - 46, hoy1 - 6)], fill=-0.5, width=13)
    hm._sync_from_img()

    PL.finish(m, L, STEM, hm=hm, wx=wx, emissive_blur=0.9)


if __name__ == '__main__':
    paint_all()
