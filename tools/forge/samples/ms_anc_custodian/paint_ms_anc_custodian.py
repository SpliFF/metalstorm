"""paint_ms_anc_custodian — 1024² PBR set for ms_anc_custodian.

ANCIENT REGISTER. Nothing here is bolted, riveted or patched. The surface
is one pale, close-toned alloy, broken only by clean recessed seams that
run the full length of a panel and stop dead. Emissive CYAN is the
signature and is reserved for the machine's living tracery: the belly keel
line, the dorsal spine, the four hover emitters, the deck core, the ring
gyro and the tool lenses — ACTIVE, so it flows rather than smoulders.
Weathering is geological: dust drift settled on every up-facing surface,
faint scorch blown out beneath the emitters, grime pressed into the seams.
No rust, no soot streaks, no wear from fasteners that do not exist.
Team colour (CAPTURABLE) lives only in the shoulder-chip mask.
"""
from __future__ import annotations
import numpy as np

import ms_anc_custodian_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import Maps, fill, seam_h, seam_v, shade, jit, RNG

W = 1024
STEM = 'ms_anc_custodian'

# ── ancient palette ─────────────────────────────────────────────────────
ANC_LT   = (192, 195, 190)      # sun-facing alloy
ANC_PALE = (172, 176, 172)      # the body tone
ANC_MID  = (146, 150, 148)
ANC_DK   = (108, 114, 116)      # undersides, deep faces
ANC_DEEP = (58, 64, 68)         # inside a bore
CYAN     = (120, 234, 250)      # emissive signature
CYAN_MID = (52, 132, 150)       # diffuse tint under a live line
CYAN_LOW = (26, 66, 78)
DUSTC    = (158, 146, 124)

AO, AO_S, AO_D = 236, 158, 92
R_ANC, M_ANC = 132, 46          # smooth, half-metallic — not scavenger steel
R_GLOW, M_GLOW = 58, 0


def groove_h(m, x0, x1, y, base, w=5):
    """A clean recessed seam. Tone-on-tone: the read comes from the normal
    map and the AO, not from a black line (large quads flood in the bake)."""
    m.d.line([(x0, y), (x1, y)], fill=shade(base, 0.78), width=w)
    m.d.line([(x0, y - w // 2 - 1), (x1, y - w // 2 - 1)],
             fill=shade(base, 1.08), width=1)
    m.o.line([(x0, y), (x1, y)], fill=(AO_S, R_ANC, M_ANC), width=w)


def groove_v(m, x, y0, y1, base, w=5):
    m.d.line([(x, y0), (x, y1)], fill=shade(base, 0.78), width=w)
    m.d.line([(x - w // 2 - 1, y0), (x - w // 2 - 1, y1)],
             fill=shade(base, 1.08), width=1)
    m.o.line([(x, y0), (x, y1)], fill=(AO_S, R_ANC, M_ANC), width=w)


def tracery_h(m, x0, x1, y, w=4):
    """A live cyan channel: dark recess in diffuse, light in emissive."""
    m.d.line([(x0, y), (x1, y)], fill=CYAN_LOW, width=w + 4)
    m.d.line([(x0, y), (x1, y)], fill=CYAN_MID, width=w)
    m.o.line([(x0, y), (x1, y)], fill=(AO_S, R_GLOW, M_GLOW), width=w + 4)
    m.e.line([(x0, y), (x1, y)], fill=CYAN, width=w)


def tracery_v(m, x, y0, y1, w=4):
    m.d.line([(x, y0), (x, y1)], fill=CYAN_LOW, width=w + 4)
    m.d.line([(x, y0), (x, y1)], fill=CYAN_MID, width=w)
    m.o.line([(x, y0), (x, y1)], fill=(AO_S, R_GLOW, M_GLOW), width=w + 4)
    m.e.line([(x, y0), (x, y1)], fill=CYAN, width=w)


def tonal_drift(m, rect, base, n=7, amp=0.94):
    """Very low-contrast slabs so a huge quad never reads as dead flat."""
    x0, y0, x1, y1 = rect
    for i in range(n):
        bx = x0 + RNG.random() * (x1 - x0) * 0.7
        by = y0 + RNG.random() * (y1 - y0) * 0.7
        bw = (x1 - x0) * (0.18 + RNG.random() * 0.3)
        bh = (y1 - y0) * (0.16 + RNG.random() * 0.34)
        f = amp if i % 2 else (2.0 - amp)
        m.d.rectangle([bx, by, min(bx + bw, x1), min(by + bh, y1)],
                      fill=shade(base, f))


def ring_set(m, rect, base, rings=(0.88, 0.66, 0.44), width=3):
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
    for f in rings:
        m.d.ellipse([cx - rx * f, cy - ry * f, cx + rx * f, cy + ry * f],
                    outline=shade(base, 0.80), width=width)
    return cx, cy, rx, ry


# ── hull ────────────────────────────────────────────────────────────────

def paint_top(m):
    z = L.A_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_PALE, ao=AO, rough=R_ANC, metal=M_ANC)
    tonal_drift(m, (x0, y0, x1, y1), ANC_PALE)
    u, v = PL.zone_fns(z)
    # the deck is one plate: four transverse seams, nothing else
    for wz in (-1.55, -0.55, 0.55, 1.95):
        groove_h(m, x0 + 8, x1 - 8, int(v(wz)), ANC_PALE, w=6)
    # two long seams following the wedge flanks, stopping dead
    for wx in (-0.62, 0.62):
        groove_v(m, int(u(wx)), int(v(-1.40)), int(v(2.05)), ANC_PALE, w=5)
    # dorsal spine line — ACTIVE tracery, prow to tail
    cu = int(u(0.0))
    tracery_v(m, cu, int(v(-2.05)), int(v(0.95)), w=5)
    tracery_v(m, cu, int(v(1.90)), int(v(2.18)), w=5)
    # a small ancient index mark near the prow (symmetric, no lettering)
    mx, my = cu, int(v(-1.85))
    m.d.polygon([(mx, my - 16), (mx + 13, my), (mx, my + 16), (mx - 13, my)],
                fill=shade(ANC_PALE, 0.86))
    m.e.polygon([(mx, my - 8), (mx + 7, my), (mx, my + 8), (mx - 7, my)],
                fill=shade(CYAN, 0.75))


def paint_belly(m):
    z = L.A_BELLY
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO - 28, rough=R_ANC + 14,
         metal=M_ANC)
    tonal_drift(m, (x0, y0, x1, y1), ANC_DK, n=5)
    u, v = PL.zone_fns(z)
    # two live under-lines flanking the keel + a transverse ring seam
    for wx in (-0.46, 0.46):
        tracery_v(m, int(u(wx)), int(v(-1.30)), int(v(1.95)), w=4)
    for wz in (-1.45, 0.30, 2.00):
        groove_h(m, int(u(-1.05)), int(u(1.05)), int(v(wz)), ANC_DK, w=5)
    for wx in (-0.92, 0.92):
        groove_v(m, int(u(wx)), int(v(-1.10)), int(v(2.05)), ANC_DK, w=4)


def paint_side(m):
    z = L.A_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_PALE, ao=AO, rough=R_ANC, metal=M_ANC)
    tonal_drift(m, (x0, y0, x1, y1), ANC_PALE)
    u, v = PL.zone_fns(z)
    # one full-length seam and one that stops — the ancient signature
    groove_h(m, x0 + 4, x1 - 4, int(v(1.12)), ANC_PALE, w=7)
    groove_h(m, int(u(-1.10)), int(u(2.10)), int(v(1.56)), ANC_PALE, w=5)
    for wz in (-1.05, 0.35, 1.62):
        groove_v(m, int(u(wz)), int(v(1.86)), int(v(0.78)), ANC_PALE, w=5)
    # a live flank channel running back from the prow
    tracery_h(m, int(u(-2.05)), int(u(-0.30)), int(v(1.34)), w=4)
    # lower band a touch darker so the hull reads as floating, not sitting
    m.d.rectangle([x0, int(v(0.98)), x1, y1], fill=shade(ANC_PALE, 0.88))
    m.o.rectangle([x0, int(v(0.98)), x1, y1], fill=(AO - 24, R_ANC + 8, M_ANC))


def paint_front(m):
    z = L.A_FRONT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_MID, ao=AO - 14, rough=R_ANC, metal=M_ANC)
    cx = (x0 + x1) // 2
    groove_v(m, cx, y0 + 6, y1 - 6, ANC_MID, w=5)
    for fy in (0.34, 0.62):
        groove_h(m, x0 + 10, x1 - 10, int(y0 + (y1 - y0) * fy), ANC_MID, w=4)
    # forward sensor slit — live
    sy = int(y0 + (y1 - y0) * 0.46)
    m.d.rectangle([cx - 30, sy - 4, cx + 30, sy + 4], fill=CYAN_LOW)
    m.e.rectangle([cx - 28, sy - 3, cx + 28, sy + 3], fill=CYAN)
    m.o.rectangle([cx - 30, sy - 4, cx + 30, sy + 4],
                  fill=(AO_S, R_GLOW, M_GLOW))


def paint_rear(m):
    z = L.A_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_MID, ao=AO - 14, rough=R_ANC, metal=M_ANC)
    cx, cy, rx, ry = ring_set(m, (x0 + 10, y0 + 8, x1 - 10, y1 - 8), ANC_MID,
                              rings=(0.92, 0.70), width=4)
    m.d.ellipse([cx - rx * 0.44, cy - ry * 0.44, cx + rx * 0.44,
                 cy + ry * 0.44], fill=CYAN_LOW)
    m.e.ellipse([cx - rx * 0.38, cy - ry * 0.38, cx + rx * 0.38,
                 cy + ry * 0.38], outline=CYAN, width=5)
    m.o.ellipse([cx - rx * 0.44, cy - ry * 0.44, cx + rx * 0.44,
                 cy + ry * 0.44], fill=(AO_S, R_GLOW, M_GLOW))
    groove_h(m, x0 + 6, x1 - 6, y1 - 14, ANC_MID, w=4)


def paint_keel(m):
    z = L.A_SPINE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO - 30, rough=R_ANC, metal=M_ANC)
    tracery_v(m, (x0 + x1) // 2, y0 + 6, y1 - 6, w=6)
    for fy in np.linspace(0.12, 0.88, 6):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.line([(x0 + 4, yy), (x1 - 4, yy)], fill=shade(ANC_DK, 0.8), width=2)


# ── emitters, core, halo ────────────────────────────────────────────────

def paint_emitters(m):
    # collar bands (emitter skirts + core well walls)
    x0, y0, x1, y1 = L.A_EMIT
    fill(m, (x0, y0, x1, y1), dif=ANC_MID, ao=AO - 40, rough=R_ANC,
         metal=M_ANC + 30)
    for i in range(24):
        fx = x0 + (x1 - x0) * i / 24
        m.d.line([(fx, y0), (fx, y1)], fill=shade(ANC_MID, 0.90), width=3)
    m.d.rectangle([x0, y1 - 10, x1, y1], fill=CYAN_LOW)
    m.e.rectangle([x0, y1 - 8, x1, y1 - 2], fill=shade(CYAN, 0.7))

    # emitter lip annulus
    x0, y0, x1, y1 = L.A_EMIT_F
    fill(m, (x0, y0, x1, y1), dif=ANC_MID, ao=AO - 30, rough=R_ANC,
         metal=M_ANC)
    cx, cy, rx, ry = ring_set(m, (x0, y0, x1, y1), ANC_MID,
                              rings=(0.92, 0.74), width=4)
    m.d.ellipse([cx - rx * 0.60, cy - ry * 0.60, cx + rx * 0.60,
                 cy + ry * 0.60], fill=CYAN_LOW)
    m.e.ellipse([cx - rx * 0.60, cy - ry * 0.60, cx + rx * 0.60,
                 cy + ry * 0.60], outline=CYAN, width=6)
    for a in np.linspace(0, 2 * np.pi, 12, endpoint=False):
        m.d.line([(cx + np.cos(a) * rx * 0.66, cy + np.sin(a) * ry * 0.66),
                  (cx + np.cos(a) * rx * 0.92, cy + np.sin(a) * ry * 0.92)],
                 fill=shade(ANC_MID, 0.78), width=3)

    # free-floating emitter disc — this is the hover field, full cyan
    x0, y0, x1, y1 = L.A_LENS
    fill(m, (x0, y0, x1, y1), dif=CYAN_LOW, ao=AO_S, rough=R_GLOW,
         metal=M_GLOW)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (x1 - x0) / 2
    m.e.ellipse([cx - r * 0.96, cy - r * 0.96, cx + r * 0.96, cy + r * 0.96],
                fill=shade(CYAN, 0.55))
    for f in (0.74, 0.50, 0.26):
        m.e.ellipse([cx - r * f, cy - r * f, cx + r * f, cy + r * f],
                    outline=CYAN, width=4)
    m.d.ellipse([cx - r * 0.30, cy - r * 0.30, cx + r * 0.30, cy + r * 0.30],
                fill=CYAN_MID)


def paint_core(m):
    # deck core well: pale annulus with radial index ticks
    x0, y0, x1, y1 = L.A_CORE.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO, rough=R_ANC, metal=M_ANC)
    cx, cy, rx, ry = ring_set(m, (x0, y0, x1, y1), ANC_LT,
                              rings=(0.94, 0.62), width=4)
    for a in np.linspace(0, 2 * np.pi, 16, endpoint=False):
        m.d.line([(cx + np.cos(a) * rx * 0.66, cy + np.sin(a) * ry * 0.66),
                  (cx + np.cos(a) * rx * 0.92, cy + np.sin(a) * ry * 0.92)],
                 fill=shade(ANC_LT, 0.80), width=3)
    m.e.ellipse([cx - rx * 0.60, cy - ry * 0.60, cx + rx * 0.60,
                 cy + ry * 0.60], outline=shade(CYAN, 0.8), width=4)

    # the floating lens that caps it
    x0, y0, x1, y1 = L.A_CORE_L.rect
    fill(m, (x0, y0, x1, y1), dif=CYAN_LOW, ao=AO_S, rough=R_GLOW,
         metal=M_GLOW)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
    m.e.ellipse([cx - rx * 0.94, cy - ry * 0.94, cx + rx * 0.94,
                 cy + ry * 0.94], fill=shade(CYAN, 0.62))
    for f in (0.72, 0.46, 0.22):
        m.e.ellipse([cx - rx * f, cy - ry * f, cx + rx * f, cy + ry * f],
                    outline=CYAN, width=4)
    m.d.ellipse([cx - rx * 0.55, cy - ry * 0.55, cx + rx * 0.55,
                 cy + ry * 0.55], fill=CYAN_MID)


def paint_halo(m):
    x0, y0, x1, y1 = L.A_HALO
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO, rough=R_ANC - 20,
         metal=M_ANC + 40)
    m.d.rectangle([x0, y0 + (y1 - y0) // 2 - 3, x1,
                   y0 + (y1 - y0) // 2 + 3], fill=CYAN_LOW)
    m.e.rectangle([x0, y0 + (y1 - y0) // 2 - 2, x1,
                   y0 + (y1 - y0) // 2 + 2], fill=shade(CYAN, 0.8))

    x0, y0, x1, y1 = L.A_HALO_F.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO, rough=R_ANC - 20,
         metal=M_ANC + 40)
    cx, cy, rx, ry = ring_set(m, (x0, y0, x1, y1), ANC_LT,
                              rings=(0.86, 0.70), width=3)
    for a in np.linspace(0, 2 * np.pi, 12, endpoint=False):
        m.d.line([(cx + np.cos(a) * rx * 0.62, cy + np.sin(a) * ry * 0.62),
                  (cx + np.cos(a) * rx * 0.94, cy + np.sin(a) * ry * 0.94)],
                 fill=shade(ANC_LT, 0.82), width=3)


# ── the ring gyro ───────────────────────────────────────────────────────

def paint_dish(m):
    for rect, base, lit in ((L.A_DISH_F, ANC_LT, True),
                            (L.A_DISH_B, ANC_MID, False)):
        x0, y0, x1, y1 = rect
        fill(m, (x0, y0, x1, y1), dif=base, ao=AO, rough=R_ANC, metal=M_ANC)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
        for f in (0.93, 0.80, 0.72):
            m.d.ellipse([cx - rx * f, cy - ry * f, cx + rx * f, cy + ry * f],
                        outline=shade(base, 0.88), width=4)
        n = 16 if lit else 8
        for a in np.linspace(0, 2 * np.pi, n, endpoint=False):
            m.d.line([(cx + np.cos(a) * rx * 0.70, cy + np.sin(a) * ry * 0.70),
                      (cx + np.cos(a) * rx * 0.92, cy + np.sin(a) * ry * 0.92)],
                     fill=shade(base, 0.87), width=4)
        if lit:
            f = 0.865
            m.d.ellipse([cx - rx * f, cy - ry * f, cx + rx * f, cy + ry * f],
                        outline=CYAN_LOW, width=9)
            m.e.ellipse([cx - rx * f, cy - ry * f, cx + rx * f, cy + ry * f],
                        outline=CYAN, width=6)
            for a in np.linspace(0, 2 * np.pi, 4, endpoint=False):
                m.e.line([(cx + np.cos(a) * rx * 0.72,
                           cy + np.sin(a) * ry * 0.72),
                          (cx + np.cos(a) * rx * 0.95,
                           cy + np.sin(a) * ry * 0.95)], fill=CYAN, width=5)

    # ring rim wrap
    x0, y0, x1, y1 = L.A_DISH_R
    fill(m, (x0, y0, x1, y1), dif=ANC_MID, ao=AO - 20, rough=R_ANC,
         metal=M_ANC + 30)
    for i in range(16):
        fx = x0 + (x1 - x0) * i / 16
        m.d.line([(fx, y0), (fx, y1)], fill=shade(ANC_MID, 0.94), width=2)
    m.e.line([(x0, (y0 + y1) // 2), (x1, (y0 + y1) // 2)],
             fill=shade(CYAN, 0.55), width=3)

    # the gyro's free-floating core lens
    x0, y0, x1, y1 = L.A_LENS_D
    fill(m, (x0, y0, x1, y1), dif=CYAN_LOW, ao=AO_S, rough=R_GLOW,
         metal=M_GLOW)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = (x1 - x0) / 2
    m.e.ellipse([cx - r * 0.95, cy - r * 0.95, cx + r * 0.95, cy + r * 0.95],
                fill=shade(CYAN, 0.60))
    for f in (0.76, 0.52, 0.28):
        m.e.ellipse([cx - r * f, cy - r * f, cx + r * f, cy + r * f],
                    outline=CYAN, width=5)
    m.d.ellipse([cx - r * 0.34, cy - r * 0.34, cx + r * 0.34, cy + r * 0.34],
                fill=CYAN_MID)


# ── arms, chips, trim ───────────────────────────────────────────────────

def paint_arms(m):
    x0, y0, x1, y1 = L.A_ARM
    fill(m, (x0, y0, x1, y1), dif=ANC_MID, ao=AO - 18, rough=R_ANC,
         metal=M_ANC + 20)
    for fy in (0.28, 0.72):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.line([(x0, yy), (x1, yy)], fill=shade(ANC_MID, 0.80), width=4)
    m.e.line([(x0, (y0 + y1) // 2), (x1, (y0 + y1) // 2)],
             fill=shade(CYAN, 0.45), width=3)

    # shoulder hub cap
    x0, y0, x1, y1 = L.A_ARM_C.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO, rough=R_ANC, metal=M_ANC)
    cx, cy, rx, ry = ring_set(m, (x0, y0, x1, y1), ANC_LT,
                              rings=(0.90, 0.64, 0.38), width=4)
    m.d.ellipse([cx - rx * 0.20, cy - ry * 0.20, cx + rx * 0.20,
                 cy + ry * 0.20], fill=CYAN_LOW)
    m.e.ellipse([cx - rx * 0.17, cy - ry * 0.17, cx + rx * 0.17,
                 cy + ry * 0.17], fill=CYAN)

    # tool head
    x0, y0, x1, y1 = L.A_TOOL.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO - 30, rough=R_ANC,
         metal=M_ANC + 40)
    groove_h(m, x0 + 6, x1 - 6, (y0 + y1) // 2, ANC_DK, w=5)
    m.e.rectangle([x0 + 10, y1 - 18, x1 - 10, y1 - 12], fill=shade(CYAN, 0.7))

    # pure-cyan cell (tool tip lenses)
    x0, y0, x1, y1 = L.A_GLOW.rect
    fill(m, (x0, y0, x1, y1), dif=CYAN_MID, ao=AO_S, rough=R_GLOW,
         metal=M_GLOW)
    m.e.rectangle([x0, y0, x1, y1], fill=CYAN)


def paint_chip(m):
    """CAPTURABLE marker: the one place team colour is allowed."""
    x0, y0, x1, y1 = L.A_CHIP.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_MID, ao=AO - 10, rough=R_ANC,
         metal=M_ANC)
    PL.team_panel(m, [x0 + 10, y0 + 12, x1 - 10, y1 - 12],
                  outline=shade(ANC_MID, 0.7))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for f in (0.30, 0.18):
        m.t.ellipse([cx - (x1 - x0) * f, cy - (y1 - y0) * f,
                     cx + (x1 - x0) * f, cy + (y1 - y0) * f],
                    outline=(0, 0, 0), width=4)
        m.d.ellipse([cx - (x1 - x0) * f, cy - (y1 - y0) * f,
                     cx + (x1 - x0) * f, cy + (y1 - y0) * f],
                    outline=shade(ANC_MID, 0.62), width=4)
    m.e.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=shade(CYAN, 0.8))


def paint_trim(m):
    x0, y0, x1, y1 = L.A_TRIM
    fill(m, (x0, y0, x1, y1), dif=ANC_MID, ao=AO - 16, rough=R_ANC,
         metal=M_ANC + 30)
    for fy in np.linspace(0.18, 0.82, 4):
        yy = int(y0 + (y1 - y0) * fy)
        m.d.line([(x0, yy), (x1, yy)], fill=shade(ANC_MID, 0.86), width=3)
    fill(m, L.A_DARK.rect, dif=ANC_DEEP, ao=AO_D, rough=180, metal=30)


# ── assembly ────────────────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_top(m)
    paint_belly(m)
    paint_side(m)
    paint_front(m)
    paint_rear(m)
    paint_keel(m)
    paint_emitters(m)
    paint_core(m)
    paint_halo(m)
    paint_dish(m)
    paint_arms(m)
    paint_chip(m)
    paint_trim(m)

    # ── weathering: geological, never mechanical ──
    from weathering import Weather
    wx = Weather(seed=90)
    wx.crevice_grime(m.dif, 0.42)
    # dust drift settles on every up-facing plane; none of it is mud
    for r in (L.A_TOP.rect, L.A_CORE.rect, L.A_HALO_F.rect, L.A_DISH_F):
        wx.mud_band(r, 0.30, fade=None, spatter=False, dust=0.75)
    # the flanks catch a thin windward film that fades upward
    for r in (L.A_SIDE.rect, L.A_FRONT.rect, L.A_REAR.rect):
        wx.mud_band(r, 0.26, fade='down', spatter=False, dust=0.55)
    # the hover field scorches whatever it hangs over
    bx0, by0, bx1, by1 = L.A_BELLY.rect
    wx.soot_patch((bx0, by0, bx1, by1), 0.30)
    wx.soot_patch(L.A_EMIT, 0.34)
    ex0, ey0, ex1, ey1 = L.A_EMIT_F
    wx.soot_patch((ex0, ey0 + (ey1 - ey0) * 0.55, ex1, ey1), 0.30)

    # ── height → normals: the seams are the whole surface story ──
    from normals import HeightMap
    hm = HeightMap()
    u, v = PL.zone_fns(L.A_TOP)
    tx0, ty0, tx1, ty1 = L.A_TOP.rect
    for wz in (-1.55, -0.55, 0.55, 1.95):
        hm.line((tx0 + 8, v(wz)), (tx1 - 8, v(wz)), -0.55, width=6)
    for wx_ in (-0.62, 0.62):
        hm.line((u(wx_), v(-1.40)), (u(wx_), v(2.05)), -0.5, width=5)
    hm.line((u(0.0), v(-2.05)), (u(0.0), v(0.95)), -0.7, width=6)
    su, sv = PL.zone_fns(L.A_SIDE)
    sx0, sy0, sx1, sy1 = L.A_SIDE.rect
    hm.line((sx0 + 4, sv(1.12)), (sx1 - 4, sv(1.12)), -0.65, width=7)
    hm.line((su(-1.10), sv(1.56)), (su(2.10), sv(1.56)), -0.5, width=5)
    for wz in (-1.05, 0.35, 1.62):
        hm.line((su(wz), sv(1.86)), (su(wz), sv(0.78)), -0.5, width=5)
    ku0, kv0, ku1, kv1 = L.A_SPINE.rect
    hm.line(((ku0 + ku1) / 2, kv0 + 6), ((ku0 + ku1) / 2, kv1 - 6), -0.8,
            width=7)
    for rect, rings in ((L.A_DISH_F, (0.93, 0.80, 0.72)),
                        (L.A_DISH_B, (0.93, 0.80, 0.72)),
                        (L.A_CORE.rect, (0.94, 0.62)),
                        (L.A_EMIT_F, (0.92, 0.74)),
                        (L.A_HALO_F.rect, (0.86, 0.70)),
                        (L.A_ARM_C.rect, (0.90, 0.64, 0.38))):
        x0, y0, x1, y1 = rect
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rr = (x1 - x0) / 2
        for f in rings:
            hm.disc(cx, cy, rr * f, 0.16)
    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
