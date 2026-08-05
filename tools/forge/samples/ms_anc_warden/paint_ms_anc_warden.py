"""paint_ms_anc_warden — 2048² PBR set for ms_anc_warden (Warden automaton).

ANCIENT REGISTER, ACTIVE.  Pale alloy-stone monoliths, unbroken, cut only
by clean recessed seams; the seams carry the cyan tracery and every glow
lives in the EMISSIVE map (diffuse stays tone-on-tone so the impostor
baker cannot flood a big quad).  No bolts are ever logged, so no bolt
rust: weathering is geological — dust drift on every up-facing surface,
soil caked at the feet, scorch at the lance emitter.  Team colour appears
ONLY as the capture sigil on the sensor cowl.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_warden_layout as L        # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048

import paintlib as PL
from paint import (Maps, fill, shade, jit, BOLT_LOG, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP, RNG)

W = 2048
STEM = 'ms_anc_warden'

# ── ancient palette ─────────────────────────────────────────────────────
ANC        = (150, 152, 145)     # alloy-stone, the whole body's tone
ANC_LT     = (170, 172, 164)     # sun-faced planes
ANC_DK     = (122, 125, 120)     # shaded / rear planes
ANC_DEEP   = (80, 84, 82)        # recessed seam channel
ANC_BLACK  = (40, 44, 46)        # undersides, glass, sockets
CYAN_HOT   = (176, 252, 255)
CYAN_MID   = (74, 214, 240)
CYAN_LOW   = (30, 118, 142)
CYAN_DIF   = (26, 62, 70)        # diffuse under a glowing channel
DUSTC      = (178, 166, 140)
TEAMDARK   = (46, 50, 54)

R_ANC, M_ANC = 132, 96           # smooth ancient alloy, semi-metallic
R_DEEP, M_DEEP = 168, 60


# ── cell primitives ─────────────────────────────────────────────────────

def cell(m, rect, dif=ANC, ao=AO_BASE, rough=R_ANC, metal=M_ANC):
    fill(m, rect, dif=dif, ao=ao, rough=rough, metal=metal)


def grain(m, rect, n=5, amt=6, tone=None):
    """Very low-contrast tonal drift over a big plane (tone-on-tone ±4%),
    so a monolith never reads as a dead flat swatch."""
    x0, y0, x1, y1 = rect
    base = tone or ANC
    for _ in range(n):
        bx = x0 + RNG.random() * (x1 - x0) * 0.7
        by = y0 + RNG.random() * (y1 - y0) * 0.7
        bw = (x1 - x0) * (0.18 + RNG.random() * 0.30)
        bh = (y1 - y0) * (0.18 + RNG.random() * 0.30)
        m.d.rectangle([bx, by, bx + bw, by + bh], fill=jit(base, amt))


def bevel(m, rect, base=ANC, pad=5):
    """Light catch along the cell border — stands in for the chamfer."""
    x0, y0, x1, y1 = rect
    m.d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=shade(base, 1.12),
                  width=pad)
    m.o.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(AO_BASE, R_ANC - 24,
                                                     M_ANC + 30), width=pad)


def _chan(m, box, glow, w):
    """Recessed channel + optional cyan core (glow 0..1)."""
    x0, y0, x1, y1 = box
    m.d.rectangle([x0, y0, x1, y1], fill=ANC_DEEP)
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_SEAM, R_DEEP, M_DEEP))
    if glow > 0:
        c = max(2.0, w * 0.28)
        cx0, cy0 = x0 + (0 if x1 - x0 > y1 - y0 else c), \
                   y0 + (c if x1 - x0 > y1 - y0 else 0)
        cx1, cy1 = x1 - (0 if x1 - x0 > y1 - y0 else c), \
                   y1 - (c if x1 - x0 > y1 - y0 else 0)
        m.d.rectangle([cx0, cy0, cx1, cy1], fill=CYAN_DIF)
        m.e.rectangle([cx0, cy0, cx1, cy1],
                      fill=tuple(int(v * glow) for v in CYAN_MID))


def hseam(m, rect, fy, glow=0.0, w=9, f0=0.03, f1=0.97):
    x0, y0, x1, y1 = rect
    y = y0 + (y1 - y0) * fy
    _chan(m, [x0 + (x1 - x0) * f0, y - w / 2, x0 + (x1 - x0) * f1, y + w / 2],
          glow, w)


def vseam(m, rect, fx, glow=0.0, w=9, f0=0.03, f1=0.97):
    x0, y0, x1, y1 = rect
    x = x0 + (x1 - x0) * fx
    _chan(m, [x - w / 2, y0 + (y1 - y0) * f0, x + w / 2,
              y0 + (y1 - y0) * f1], glow, w)


def iris(m, rect, glow=1.0, rings=(0.46, 0.33, 0.20), core=0.10,
         base=ANC_DK):
    """Concentric ancient lens/disc face; only the core is bright."""
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    s = min(x1 - x0, y1 - y0)
    for f in rings:
        r = s * f
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r],
                    outline=shade(base, 0.72), width=max(3, int(s * 0.016)))
    r = s * core
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CYAN_DIF)
    if glow > 0:
        m.e.ellipse([cx - r, cy - r, cx + r, cy + r],
                    fill=tuple(int(v * glow) for v in CYAN_MID))
        m.e.ellipse([cx - r * 0.45, cy - r * 0.45, cx + r * 0.45,
                     cy + r * 0.45], fill=CYAN_HOT)


def glyph(m, rect, cx, cy, r, col):
    """Mirror-safe ancient mark: ring + inscribed square + centre bar."""
    m.d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col,
                width=max(3, int(r * 0.14)))
    k = r * 0.52
    m.d.rectangle([cx - k, cy - k, cx + k, cy + k], outline=col,
                  width=max(3, int(r * 0.12)))
    m.d.rectangle([cx - r * 0.20, cy - k * 0.42, cx + r * 0.20,
                   cy + k * 0.42], fill=col)


def team_sigil(m, rect, r_frac=0.34):
    """The capture mark: full team mask across the plate with a dark
    ancient glyph punched out of it."""
    x0, y0, x1, y1 = rect
    PL.team_panel(m, [x0 + 4, y0 + 4, x1 - 4, y1 - 4], outline=ANC_DK)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = min(x1 - x0, y1 - y0) * r_frac
    glyph(m, rect, cx, cy, r, TEAMDARK)
    m.t.ellipse([cx - r * 1.06, cy - r * 1.06, cx + r * 1.06, cy + r * 1.06],
                outline=(0, 0, 0), width=max(3, int(r * 0.16)))


# ── torso monolith ──────────────────────────────────────────────────────

def paint_torso(m):
    z = L.A_TORSO_F
    r = z.rect
    u, v = PL.zone_fns(z)
    cell(m, r, ANC)
    grain(m, r)
    # two full-height tracery channels flanking the core, off-centre so a
    # big quad's UV centroid never lands in one
    for wx in (-0.62, 0.62):
        vseam(m, r, (u(wx) - r[0]) / (r[2] - r[0]), glow=0.9, w=11,
              f0=0.08, f1=0.86)
    hseam(m, r, (v(0.72) - r[1]) / (r[3] - r[1]), glow=0.0, w=13)
    hseam(m, r, (v(2.44) - r[1]) / (r[3] - r[1]), glow=0.35, w=9)
    # shoulder shadow blocks (the pauldrons overhang here)
    m.d.rectangle([r[0] + 6, r[1] + 6, u(-1.30), v(1.95)], fill=ANC_DK)
    m.d.rectangle([u(1.30), r[1] + 6, r[2] - 6, v(1.95)], fill=ANC_DK)
    # recessed halo around the chest boss
    cx, cy = u(L.LENS_C[0]), v(L.LENS_C[1])
    rr = abs(u(L.LENS_R * 1.55) - u(0.0))
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                outline=ANC_DEEP, width=10)
    bevel(m, r)

    z = L.A_TORSO_B
    r = z.rect
    u, v = PL.zone_fns(z)
    cell(m, r, ANC_DK)
    grain(m, r, tone=ANC_DK)
    vseam(m, r, 0.5, glow=0.55, w=13, f0=0.08, f1=0.92)
    hseam(m, r, 0.28, w=9)
    hseam(m, r, 0.74, w=9)
    bevel(m, r, ANC_DK)

    z = L.A_TORSO_S
    r = z.rect
    u, v = PL.zone_fns(z)
    cell(m, r, ANC)
    grain(m, r)
    hseam(m, r, (v(1.06) - r[1]) / (r[3] - r[1]), glow=0.0, w=13)
    hseam(m, r, (v(2.20) - r[1]) / (r[3] - r[1]), glow=0.7, w=9)
    vseam(m, r, 0.22, w=9, f0=0.10, f1=0.90)
    # lower flank falls away into shadow
    m.d.rectangle([r[0], v(0.62), r[2], r[3]], fill=ANC_DEEP)
    m.o.rectangle([r[0], v(0.62), r[2], r[3]], fill=(AO_DEEP, R_DEEP, M_DEEP))
    bevel(m, r)

    for rr, tone in ((L.A_TORSO_T.rect, ANC_LT), (L.A_TORSO_BT.rect, ANC_BLACK),
                     (L.A_DARK.rect, ANC_BLACK)):
        cell(m, rr, tone, ao=AO_BASE if tone is ANC_LT else AO_DEEP)
    r = L.A_TORSO_T.rect
    grain(m, r, tone=ANC_LT)
    u, v = PL.zone_fns(L.A_TORSO_T)
    cx, cy = u(0.0), v(0.0)
    for k in (0.30, 0.20):
        rr = (r[2] - r[0]) * k
        m.d.ellipse([cx - rr, cy - rr * 0.8, cx + rr, cy + rr * 0.8],
                    outline=ANC_DEEP, width=8)
    hseam(m, r, 0.20, glow=0.4, w=8)
    bevel(m, r, ANC_LT)

    # chest core lens
    cell(m, L.A_LENS, ANC_DK)
    iris(m, L.A_LENS, glow=1.0, rings=(0.44, 0.31), core=0.15, base=ANC)


def paint_shoulders(m):
    r = L.A_PAULD_S
    cell(m, r, ANC_LT)
    grain(m, r, tone=ANC_LT)
    hseam(m, r, 0.22, glow=0.0, w=13)
    hseam(m, r, 0.80, glow=0.85, w=9)
    vseam(m, r, 0.18, w=9, f0=0.06, f1=0.94)
    bevel(m, r, ANC_LT)

    r = L.A_PAULD_T
    cell(m, r, ANC_LT)
    grain(m, r, tone=ANC_LT)
    vseam(m, r, 0.26, glow=0.0, w=12)
    vseam(m, r, 0.78, glow=0.6, w=8)
    bevel(m, r, ANC_LT)

    r = L.A_BOOM
    cell(m, r, ANC_DK)
    grain(m, r, tone=ANC_DK)
    hseam(m, r, 0.26, w=10)
    hseam(m, r, 0.72, glow=0.9, w=10)
    bevel(m, r, ANC_DK)


# ── gyro-sphere hip + halo rings ────────────────────────────────────────

def paint_hip(m):
    for z, back in ((L.A_HIP_F, False), (L.A_HIP_B, True)):
        r = z.rect
        u, v = PL.zone_fns(z)
        cell(m, r, ANC_DK if back else ANC)
        grain(m, r, n=6, tone=ANC_DK if back else ANC)
        cx, cy = u(0.0), v(L.HIP_Y)
        s = (r[2] - r[0])
        # latitude bands, tone-on-tone
        for f, tone in ((0.47, 0.94), (0.36, 1.05), (0.22, 0.97)):
            rr = s * f
            m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                        outline=shade(ANC_DEEP, 1.5), width=7)
        # cyan equator + two meridians
        rr = s * 0.47
        m.d.rectangle([cx - rr, cy - 6, cx + rr, cy + 6], fill=CYAN_DIF)
        m.e.rectangle([cx - rr, cy - 4, cx + rr, cy + 4], fill=CYAN_MID)
        for fx in (-0.24, 0.24):
            m.d.rectangle([cx + s * fx - 5, cy - rr * 0.9, cx + s * fx + 5,
                           cy + rr * 0.9], fill=CYAN_DIF)
            m.e.rectangle([cx + s * fx - 3, cy - rr * 0.86, cx + s * fx + 3,
                           cy + rr * 0.86],
                          fill=tuple(int(c * 0.55) for c in CYAN_MID))
        # polar caps read darker
        m.d.ellipse([cx - s * 0.13, cy - rr - 14, cx + s * 0.13, cy - rr + 26],
                    fill=ANC_DEEP)
        m.d.ellipse([cx - s * 0.13, cy + rr - 26, cx + s * 0.13, cy + rr + 14],
                    fill=ANC_DEEP)

    r = L.A_HIP_CAP.rect
    cell(m, r, ANC_DK)
    iris(m, r, glow=0.5, rings=(0.42, 0.28), core=0.09, base=ANC_DK)


def paint_halo(m):
    r = L.A_RING_O
    cell(m, r, ANC_LT)
    hseam(m, r, 0.5, glow=0.0, w=10, f0=0.0, f1=1.0)
    m.d.rectangle([r[0], r[1], r[2], r[1] + 5], fill=shade(ANC_LT, 1.1))
    m.d.rectangle([r[0], r[3] - 5, r[2], r[3]], fill=shade(ANC_LT, 1.1))

    r = L.A_RING_I
    cell(m, r, ANC_DEEP, ao=AO_SEAM, rough=R_DEEP, metal=M_DEEP)
    # continuous tracery stripe (uniform along u so the ring never checkers)
    h = r[3] - r[1]
    m.d.rectangle([r[0], r[1] + h * 0.34, r[2], r[1] + h * 0.66],
                  fill=CYAN_DIF)
    m.e.rectangle([r[0], r[1] + h * 0.36, r[2], r[1] + h * 0.64],
                  fill=CYAN_MID)
    m.e.rectangle([r[0], r[1] + h * 0.46, r[2], r[1] + h * 0.54],
                  fill=CYAN_HOT)

    r = L.A_RING_E
    cell(m, r, ANC_DK)
    h = r[3] - r[1]
    m.d.rectangle([r[0], r[1] + h * 0.10, r[2], r[1] + h * 0.16],
                  fill=CYAN_DIF)
    m.e.rectangle([r[0], r[1] + h * 0.11, r[2], r[1] + h * 0.15],
                  fill=tuple(int(c * 0.6) for c in CYAN_MID))
    m.d.rectangle([r[0], r[1] + h * 0.60, r[2], r[1] + h * 0.66],
                  fill=CYAN_DIF)
    m.e.rectangle([r[0], r[1] + h * 0.61, r[2], r[1] + h * 0.65],
                  fill=tuple(int(c * 0.6) for c in CYAN_MID))

    # pylon crowns
    r = L.A_CYAN
    cell(m, r, CYAN_DIF, ao=AO_BASE, rough=90, metal=20)
    m.e.rectangle([r[0] + 8, r[1] + 8, r[2] - 8, r[3] - 8], fill=CYAN_MID)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    k = min(r[2] - r[0], r[3] - r[1]) * 0.22
    m.e.ellipse([cx - k, cy - k, cx + k, cy + k], fill=CYAN_HOT)


# ── joints, wraps, trim ─────────────────────────────────────────────────

def paint_joints(m):
    for r in (L.A_JOINT, L.A_JOINT2):
        cell(m, r, ANC_DK, rough=R_ANC - 18, metal=M_ANC + 60)
        h = r[3] - r[1]
        for f in (0.16, 0.50, 0.84):
            m.d.rectangle([r[0], r[1] + h * f - 4, r[2], r[1] + h * f + 4],
                          fill=ANC_DEEP)
    for r, g in ((L.A_JCAP, 0.9), (L.A_JCAP2, 0.7)):
        cell(m, r, ANC)
        iris(m, r, glow=g, rings=(0.45, 0.34, 0.22), core=0.08, base=ANC)

    r = L.A_TRIM
    cell(m, r, ANC_DK, rough=R_ANC - 10, metal=M_ANC + 40)
    h = r[3] - r[1]
    for f in (0.24, 0.62):
        m.d.rectangle([r[0], r[1] + h * f - 5, r[2], r[1] + h * f + 5],
                      fill=ANC_DEEP)
    m.d.rectangle([r[0], r[1] + h * 0.86 - 3, r[2], r[1] + h * 0.86 + 3],
                  fill=CYAN_DIF)
    m.e.rectangle([r[0], r[1] + h * 0.86 - 2, r[2], r[1] + h * 0.86 + 2],
                  fill=tuple(int(c * 0.7) for c in CYAN_MID))

    r = L.A_WAIST
    cell(m, r, ANC_DEEP, ao=AO_DEEP, rough=R_DEEP, metal=M_DEEP)
    h = r[3] - r[1]
    for f in (0.30, 0.55, 0.80):
        m.d.rectangle([r[0], r[1] + h * f - 4, r[2], r[1] + h * f + 4],
                      fill=ANC_BLACK)

    r = L.A_SPARE
    cell(m, r, ANC_DK)


# ── sensor cowl ─────────────────────────────────────────────────────────

def paint_cowl(m):
    r = L.A_COWL_S
    cell(m, r, ANC)
    grain(m, r)
    hseam(m, r, 0.24, glow=0.0, w=12)
    hseam(m, r, 0.76, glow=0.8, w=9)
    # capture sigil on the cheek (mirror-safe: symmetric glyph, centred u)
    s = min(r[2] - r[0], r[3] - r[1]) * 0.30
    cx, cy = (r[0] + r[2]) / 2, r[1] + (r[3] - r[1]) * 0.50
    team_sigil(m, [cx - s, cy - s, cx + s, cy + s], r_frac=0.34)
    bevel(m, r)

    r = L.A_COWL_F
    cell(m, r, ANC_DK)
    grain(m, r, tone=ANC_DK)
    vseam(m, r, 0.24, glow=0.0, w=12)
    vseam(m, r, 0.76, glow=0.55, w=9)
    bevel(m, r, ANC_DK)

    r = L.A_COWL_T
    cell(m, r, ANC_LT)
    grain(m, r, tone=ANC_LT)
    hseam(m, r, 0.20, glow=0.0, w=12)
    hseam(m, r, 0.82, glow=0.5, w=9)
    bevel(m, r, ANC_LT)

    r = L.A_CREST
    cell(m, r, ANC_DK)
    grain(m, r, tone=ANC_DK)
    hseam(m, r, 0.18, glow=1.0, w=11)
    vseam(m, r, 0.70, w=9, f0=0.24, f1=0.94)
    bevel(m, r, ANC_DK)

    # visor slit — diffuse near-black, all the light in the emissive map
    r = L.A_VISOR
    cell(m, r, ANC_BLACK, ao=AO_DEEP, rough=70, metal=20)
    h, w_ = r[3] - r[1], r[2] - r[0]
    m.e.rectangle([r[0] + 10, r[1] + h * 0.40, r[2] - 10, r[1] + h * 0.60],
                  fill=CYAN_MID)
    m.e.rectangle([r[0] + 10, r[1] + h * 0.46, r[2] - 10, r[1] + h * 0.54],
                  fill=CYAN_HOT)
    for f in np.linspace(0.10, 0.90, 9):
        m.d.rectangle([r[0] + w_ * f - 4, r[1] + h * 0.34,
                       r[0] + w_ * f + 4, r[1] + h * 0.66], fill=(14, 18, 20))

    team_sigil(m, L.A_SIGIL, r_frac=0.36)


# ── limbs + feet ────────────────────────────────────────────────────────

def paint_limbs(m):
    for r, tone in ((L.A_LIMB_TH, ANC), (L.A_LIMB_SH, ANC)):
        cell(m, r, tone)
        h, w_ = r[3] - r[1], r[2] - r[0]
        # circumferential collars (vertical bands: u runs along the limb)
        for f in (0.10, 0.44, 0.88):
            m.d.rectangle([r[0] + w_ * f - 7, r[1], r[0] + w_ * f + 7, r[3]],
                          fill=ANC_DEEP)
            m.o.rectangle([r[0] + w_ * f - 7, r[1], r[0] + w_ * f + 7, r[3]],
                          fill=(AO_SEAM, R_DEEP, M_DEEP))
        # one longitudinal tracery line running the column's length
        m.d.rectangle([r[0], r[1] + h * 0.30 - 5, r[2], r[1] + h * 0.30 + 5],
                      fill=CYAN_DIF)
        m.e.rectangle([r[0], r[1] + h * 0.30 - 3, r[2], r[1] + h * 0.30 + 3],
                      fill=CYAN_MID)
        m.d.rectangle([r[0], r[1] + h * 0.72 - 4, r[2], r[1] + h * 0.72 + 4],
                      fill=ANC_DEEP)

    for r in (L.A_PLATE_S, L.A_PLATE_F):
        cell(m, r, ANC_LT)
        grain(m, r, tone=ANC_LT)
        vseam(m, r, 0.28, glow=0.85, w=11, f0=0.10, f1=0.90)
        hseam(m, r, 0.18, w=10)
        hseam(m, r, 0.84, w=10)
        bevel(m, r, ANC_LT)


def paint_feet(m):
    z = L.A_FOOT_S
    r = z.rect
    u, v = PL.zone_fns(z)
    cell(m, r, ANC)
    grain(m, r)
    # instep tracery, kept high so the caked-soil band below stays clean
    hseam(m, r, (v(-0.20) - r[1]) / (r[3] - r[1]), glow=0.75, w=11)
    vseam(m, r, 0.30, w=10, f0=0.06, f1=0.60)
    # buried lower third: soil-toned, matte
    m.d.rectangle([r[0], v(-0.86), r[2], r[3]], fill=shade(ANC_DEEP, 1.0))
    m.o.rectangle([r[0], v(-0.86), r[2], r[3]], fill=(AO_DEEP, 210, 30))
    bevel(m, r)

    r = L.A_FOOT_W
    cell(m, r, ANC_DEEP, ao=AO_DEEP, rough=200, metal=40)
    w_ = r[2] - r[0]
    for f in np.linspace(0.06, 0.94, 10):
        m.d.rectangle([r[0] + w_ * f - 5, r[1], r[0] + w_ * f + 5, r[3]],
                      fill=ANC_BLACK)

    r = L.A_FOOT_T
    cell(m, r, ANC_LT)
    grain(m, r, tone=ANC_LT)
    vseam(m, r, 0.24, glow=0.0, w=12)
    vseam(m, r, 0.80, glow=0.7, w=9)
    bevel(m, r, ANC_LT)


# ── lance ───────────────────────────────────────────────────────────────

def paint_lance(m):
    r = L.A_LANCE_W
    cell(m, r, ANC)
    h, w_ = r[3] - r[1], r[2] - r[0]
    for f in (0.08, 0.30, 0.55, 0.78, 0.94):     # circumferential collars
        m.d.rectangle([r[0] + w_ * f - 8, r[1], r[0] + w_ * f + 8, r[3]],
                      fill=ANC_DEEP)
        m.o.rectangle([r[0] + w_ * f - 8, r[1], r[0] + w_ * f + 8, r[3]],
                      fill=(AO_SEAM, R_DEEP, M_DEEP))
    for f in (0.22, 0.72):                        # longitudinal tracery
        m.d.rectangle([r[0], r[1] + h * f - 5, r[2], r[1] + h * f + 5],
                      fill=CYAN_DIF)
        m.e.rectangle([r[0], r[1] + h * f - 3, r[2], r[1] + h * f + 3],
                      fill=tuple(int(c * 0.8) for c in CYAN_MID))
    m.d.rectangle([r[2] - w_ * 0.05, r[1], r[2], r[3]], fill=ANC_BLACK)

    r = L.A_LANCE_S
    cell(m, r, ANC_DK)
    hseam(m, r, 0.26, w=10)
    hseam(m, r, 0.74, glow=0.8, w=10)
    bevel(m, r, ANC_DK)

    r = L.A_LANCE_T
    cell(m, r, ANC_DEEP, ao=AO_SEAM, rough=R_DEEP, metal=M_DEEP)
    h = r[3] - r[1]
    m.d.rectangle([r[0], r[1] + h * 0.30, r[2], r[1] + h * 0.70],
                  fill=CYAN_DIF)
    m.e.rectangle([r[0], r[1] + h * 0.33, r[2], r[1] + h * 0.67],
                  fill=CYAN_MID)
    m.e.rectangle([r[0], r[1] + h * 0.45, r[2], r[1] + h * 0.55],
                  fill=CYAN_HOT)

    r = L.A_BREECH
    cell(m, r, ANC_DK)
    grain(m, r, tone=ANC_DK)
    vseam(m, r, 0.24, glow=0.0, w=12)
    hseam(m, r, 0.80, glow=0.9, w=10)
    bevel(m, r, ANC_DK)

    r = L.A_EMIT
    cell(m, r, ANC_BLACK, ao=AO_DEEP, rough=80, metal=30)
    iris(m, r, glow=1.0, rings=(0.44, 0.30), core=0.20, base=ANC_DEEP)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    k = min(r[2] - r[0], r[3] - r[1]) * 0.30
    m.e.ellipse([cx - k, cy - k, cx + k, cy + k], fill=CYAN_LOW)
    k *= 0.55
    m.e.ellipse([cx - k, cy - k, cx + k, cy + k], fill=CYAN_HOT)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()                 # ancient register: nothing is bolted
    m = Maps()
    fill(m, (0, 0, W, W), dif=ANC, ao=AO_BASE, rough=R_ANC, metal=M_ANC)
    paint_torso(m)
    paint_shoulders(m)
    paint_hip(m)
    paint_halo(m)
    paint_joints(m)
    paint_cowl(m)
    paint_limbs(m)
    paint_feet(m)
    paint_lance(m)

    # ── weathering: geological, not mechanical (no rust, no bolt streaks)
    from weathering import Weather
    wx = Weather(seed=90210)
    wx.crevice_grime(m.dif, 0.42)
    # dust drift on every up-facing plane
    for rect, s in ((L.A_TORSO_T.rect, 0.34), (L.A_PAULD_T, 0.36),
                    (L.A_COWL_T, 0.30), (L.A_FOOT_T, 0.42),
                    (L.A_HIP_CAP.rect, 0.30), (L.A_RING_E, 0.20),
                    (L.A_LANCE_T, 0.16), (L.A_BOOM, 0.20)):
        wx.mud_band(rect, s, fade=None, spatter=True)
    # thin dry film fading down the vertical monoliths
    for rect, s in ((L.A_TORSO_F.rect, 0.26), (L.A_TORSO_B.rect, 0.30),
                    (L.A_TORSO_S.rect, 0.28), (L.A_HIP_F.rect, 0.26),
                    (L.A_HIP_B.rect, 0.30), (L.A_COWL_S, 0.20),
                    (L.A_COWL_F, 0.22), (L.A_CREST, 0.22),
                    (L.A_PAULD_S, 0.24), (L.A_PLATE_S, 0.40),
                    (L.A_PLATE_F, 0.40), (L.A_BREECH, 0.24)):
        wx.mud_band(rect, s, fade='down', spatter=False, dust=0.45)
    # limb columns: u runs along the limb, so gravity fades toward u=1 (down)
    for rect in (L.A_LIMB_TH, L.A_LIMB_SH):
        wx.mud_band(rect, 0.48, fade='right', spatter=False, dust=0.4)
    # soil caked at ground contact
    wx.mud_band(L.A_FOOT_S.rect, 0.86, fade='down')
    wx.mud_band(L.A_FOOT_W, 0.80, fade=None)
    # scorch: the emitter and the muzzle third of the lance
    wx.soot_patch(L.A_EMIT, 0.7)
    wx.soot_patch(L.A_LANCE_W, 0.5, fade='right')
    wx.apply(m)

    # ── height -> normals ──
    from normals import HeightMap
    hm = HeightMap()
    for rect in (L.A_PAULD_S, L.A_PAULD_T, L.A_PLATE_S, L.A_PLATE_F,
                 L.A_FOOT_T, L.A_SIGIL, L.A_COWL_T):
        hm.rect((rect[0] + 8, rect[1] + 8, rect[2] - 8, rect[3] - 8), 0.28)
    hm.rect((L.A_VISOR[0], L.A_VISOR[1], L.A_VISOR[2], L.A_VISOR[3]), -0.55)
    hm.rect(L.A_WAIST, -0.30)
    r = L.A_RING_I
    hm.rect((r[0], r[1] + (r[3] - r[1]) * 0.34, r[2],
             r[1] + (r[3] - r[1]) * 0.66), -0.45)
    for r in (L.A_JCAP, L.A_JCAP2, L.A_LENS, L.A_EMIT):
        cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
        s = min(r[2] - r[0], r[3] - r[1])
        hm.disc(cx, cy, s * 0.46, 0.22)
        hm.disc(cx, cy, s * 0.16, -0.40)
    PL.finish(m, L, STEM, hm=hm, wx=None, emissive_blur=1.1)


if __name__ == '__main__':
    paint_all()
