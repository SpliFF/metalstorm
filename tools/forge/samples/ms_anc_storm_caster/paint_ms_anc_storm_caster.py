"""paint_ms_anc_storm_caster — 2048 PBR set, ANCIENT register.

Pale monolithic ceramic-stone, seamless: every division is a clean
RECESSED SEAM, never a rivet, bolt or patched plate. The only emissive is
CYAN — tracery down the vanes and iris petals, the array floor's ring
circuit, the tesla core and its floating halo. Weathering is geological:
dust drift on horizontals, soil burial at the base of the apron and the
vane roots, and a scorched, glassed earth ring — no rust anywhere.
Team colour appears once, on the capture tab of the front vane.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_storm_caster_layout as L   # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, shade, CYAN, TEAMGREY, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLOW, M_ARMOR)

W = 2048

# ── ancient palette ─────────────────────────────────────────────────────
ANC = (170, 174, 171)          # pale monolith
ANC_LT = (194, 197, 192)
ANC_DK = (128, 133, 133)
ANC_DEEP = (66, 72, 76)        # recessed seam / interior shadow
SOIL = (86, 76, 62)
ASH = (104, 99, 92)
SCORCH = (40, 36, 34)
GLASSED = (56, 54, 58)
CY = CYAN
CY_HOT = (198, 248, 255)
CY_DIM = (30, 96, 116)

R_STONE = 176                  # ancient ceramic: rough, non-metallic
M_STONE = 0
ORM_STONE = (AO_BASE, R_STONE, M_STONE)
ORM_GLOW = (AO_BASE, R_GLOW, 0)


# ── helpers ─────────────────────────────────────────────────────────────

def polar(zone):
    x0, y0, x1, y1 = zone.rect
    (a0, a1), _ = zone.win
    return (x0 + x1) / 2.0, (y0 + y1) / 2.0, (x1 - x0) / (a1 - a0)


def pdisc(m, zone, r, dif=None, orm=None, emi=None):
    cx, cy, s = polar(zone)
    rr = r * s
    box = [cx - rr, cy - rr, cx + rr, cy + rr]
    if dif is not None:
        m.d.ellipse(box, fill=dif)
    if orm is not None:
        m.o.ellipse(box, fill=orm)
    if emi is not None:
        m.e.ellipse(box, fill=emi)


def pcircle(m, zone, r, col, width=3, emi=None, orm=None):
    cx, cy, s = polar(zone)
    rr = r * s
    box = [cx - rr, cy - rr, cx + rr, cy + rr]
    m.d.ellipse(box, outline=col, width=width)
    if orm is not None:
        m.o.ellipse(box, outline=orm, width=width)
    if emi is not None:
        m.e.ellipse(box, outline=emi, width=width)


def pradial(m, zone, adeg, r0, r1, col, width=3, emi=None, orm=None):
    cx, cy, s = polar(zone)
    a = np.radians(adeg)
    p0 = (cx + r0 * s * np.cos(a), cy + r0 * s * np.sin(a))
    p1 = (cx + r1 * s * np.cos(a), cy + r1 * s * np.sin(a))
    m.d.line([p0, p1], fill=col, width=width)
    if orm is not None:
        m.o.line([p0, p1], fill=orm, width=width)
    if emi is not None:
        m.e.line([p0, p1], fill=emi, width=width)


def rlerp(rect, fu, fv):
    """Point inside a parametric rect from (u,v) fractions."""
    x0, y0, x1, y1 = rect
    return (x0 + (x1 - x0) * fu, y0 + (y1 - y0) * fv)


def vline(m, rect, fu, f0, f1, col, width=3, emi=None, orm=None):
    a = rlerp(rect, fu, f0)
    b = rlerp(rect, fu, f1)
    m.d.line([a, b], fill=col, width=width)
    if orm is not None:
        m.o.line([a, b], fill=orm, width=width)
    if emi is not None:
        m.e.line([a, b], fill=emi, width=width)


def hline(m, rect, fv, f0, f1, col, width=3, emi=None, orm=None):
    a = rlerp(rect, f0, fv)
    b = rlerp(rect, f1, fv)
    m.d.line([a, b], fill=col, width=width)
    if orm is not None:
        m.o.line([a, b], fill=orm, width=width)
    if emi is not None:
        m.e.line([a, b], fill=emi, width=width)


def seam(m, pts, base=ANC, width=4):
    """A clean recessed seam: dark groove + a thin lit lip below it."""
    m.d.line(pts, fill=shade(base, 0.42), width=width)
    m.o.line(pts, fill=(AO_SEAM, R_STONE, M_STONE), width=width)


def subrect(rect, f0, f1):
    x0, y0, x1, y1 = rect
    return (x0, y0 + (y1 - y0) * f0, x1, y0 + (y1 - y0) * f1)


def grad_v(m, rect, top, bot, steps=32):
    x0, y0, x1, y1 = rect
    for i in range(steps):
        t = i / (steps - 1.0)
        c = tuple(int(top[k] + (bot[k] - top[k]) * t) for k in range(3))
        m.d.rectangle([x0, y0 + (y1 - y0) * i / steps,
                       x1, y0 + (y1 - y0) * (i + 1) / steps + 1], fill=c)


# ── zones ───────────────────────────────────────────────────────────────

def paint_scorch(m):
    """Scorched, glassed earth: the ground remembers every discharge."""
    z = L.R_SCORCH
    fill(m, z.rect, dif=SOIL, ao=AO_BASE - 12, rough=225, metal=0)
    pdisc(m, z, 8.20, dif=ASH, orm=(AO_BASE - 16, 218, 0))
    pdisc(m, z, 7.55, dif=shade(ASH, 0.80))
    pdisc(m, z, 6.40, dif=GLASSED, orm=(AO_BASE - 30, 120, 0))
    pdisc(m, z, 5.05, dif=SCORCH, orm=(AO_DEEP, 96, 0))
    # strike scars radiating from the four vane feet (segment boundaries —
    # never a quad centroid, so the impostor bake stays clean)
    rng = np.random.default_rng(90210)
    for adeg in (0, 90, 180, 270):
        for k in (-1, 0, 1):
            a = adeg + k * 11.25
            pradial(m, z, a, 4.7, 8.1 - abs(k) * 0.9, SCORCH,
                    width=9 if k == 0 else 5)
        for _ in range(5):
            a = adeg + rng.uniform(-22, 22)
            r0 = rng.uniform(5.0, 6.6)
            pradial(m, z, a, r0, r0 + rng.uniform(0.7, 1.8),
                    shade(SCORCH, 1.5), width=3)
    # buried ground-conductor circles — dim, still live after an age
    pcircle(m, z, 4.85, CY_DIM, width=4, emi=(24, 78, 96))
    pcircle(m, z, 6.85, CY_DIM, width=3, emi=(16, 54, 68))


def paint_disc(m):
    """All horizontal faces share one polar cell: apron rim, collar shelf,
    the discharge-array floor, and the core pedestal top."""
    z = L.R_DISC
    fill(m, z.rect, dif=ANC, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    # apron rim shelf 4.06..5.18 (quad centroid r 4.62 -> keep it plain)
    pdisc(m, z, 5.34, dif=ANC_LT, orm=ORM_STONE)
    pcircle(m, z, 5.02, shade(ANC, 0.46), width=5)
    pcircle(m, z, 4.98, CY_DIM, width=2, emi=(20, 70, 86))
    pcircle(m, z, 4.25, shade(ANC, 0.46), width=5)
    pcircle(m, z, 4.21, CY, width=2, emi=(70, 190, 220))
    # collar shelf 3.62..4.06 — shadowed step
    pdisc(m, z, 4.04, dif=ANC_DK, orm=(AO_SEAM, R_STONE, M_STONE))
    pcircle(m, z, 3.70, CY, width=3, emi=(90, 210, 240))
    # discharge-array floor 1.50..3.62 (centroids r 2.03 / 3.09 stay dark)
    pdisc(m, z, 3.60, dif=ANC_DEEP, orm=(AO_DEEP, 130, 0))
    for r, wd, e in ((3.40, 4, (60, 170, 205)), (2.78, 5, (110, 230, 250)),
                     (2.40, 4, (80, 200, 230)), (1.70, 6, (150, 245, 255))):
        pcircle(m, z, r, CY, width=wd, emi=e, orm=ORM_GLOW)
    for i in range(16):
        pradial(m, z, i * 22.5, 1.80, 3.30, shade(ANC_DEEP, 0.55), width=6)
    for i in range(8):
        pradial(m, z, i * 45.0, 1.95, 3.25, CY, width=3,
                emi=(90, 215, 245), orm=ORM_GLOW)
    # pedestal top 0.60..1.44 (centroid r 1.02 -> keep plain stone)
    pdisc(m, z, 1.44, dif=ANC, orm=ORM_STONE)
    pcircle(m, z, 0.80, CY, width=4, emi=(120, 235, 252), orm=ORM_GLOW)
    # column top disc r<=0.42 — the core aperture
    pdisc(m, z, 0.42, dif=CY_HOT, orm=ORM_GLOW, emi=(190, 245, 255))
    # eight radial recessed seams across the stone shelves
    for i in range(8):
        pradial(m, z, i * 45.0, 3.64, 5.32, shade(ANC, 0.44), width=6)


def paint_apron(m):
    r = L.R_APRON_W
    grad_v(m, r, ANC_LT, ANC_DK)
    fill(m, r, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    grad_v(m, r, ANC_LT, shade(ANC_DK, 0.86))
    # eight full-height recessed seams on segment boundaries
    for i in range(8):
        vline(m, r, i / 8.0, 0.0, 1.0, shade(ANC, 0.40), width=7,
              orm=(AO_SEAM, R_STONE, M_STONE))
        vline(m, r, i / 8.0 + 0.004, 0.0, 1.0, shade(ANC_LT, 1.06), width=2)
    # the flare's shadow line and a live tracery groove under the rim
    hline(m, r, 0.16, 0.0, 1.0, shade(ANC, 0.40), width=6,
          orm=(AO_SEAM, R_STONE, M_STONE))
    hline(m, r, 0.24, 0.0, 1.0, CY_DIM, width=3, emi=(34, 108, 130),
          orm=ORM_GLOW)
    hline(m, r, 0.74, 0.0, 1.0, shade(ANC, 0.46), width=5,
          orm=(AO_SEAM, R_STONE, M_STONE))


def paint_collar(m):
    r = L.R_COLLAR_W
    fill(m, r, dif=ANC_DK, ao=AO_SEAM, rough=R_STONE, metal=M_STONE)
    for i in range(8):
        vline(m, r, i / 8.0, 0.0, 1.0, shade(ANC_DK, 0.42), width=6,
              orm=(AO_DEEP, R_STONE, M_STONE))
    hline(m, r, 0.30, 0.0, 1.0, CY, width=4, emi=(96, 220, 246), orm=ORM_GLOW)
    r = L.R_RECESS_W
    fill(m, r, dif=ANC_DEEP, ao=AO_DEEP, rough=140, metal=0)
    hline(m, r, 0.30, 0.0, 1.0, CY, width=5, emi=(140, 238, 254), orm=ORM_GLOW)


def paint_dome_ring(m):
    r = L.R_DRING_O
    grad_v(m, r, ANC_LT, ANC)
    fill(m, r, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    grad_v(m, r, ANC_LT, ANC)
    for i in range(8):
        vline(m, r, i / 8.0, 0.0, 1.0, shade(ANC, 0.40), width=7,
              orm=(AO_SEAM, R_STONE, M_STONE))
    hline(m, r, 0.30, 0.0, 1.0, CY, width=4, emi=(100, 224, 248), orm=ORM_GLOW)
    hline(m, r, 0.86, 0.0, 1.0, shade(ANC, 0.42), width=5,
          orm=(AO_SEAM, R_STONE, M_STONE))
    r = L.R_DRING_T
    fill(m, r, dif=ANC_LT, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    hline(m, r, 0.34, 0.0, 1.0, CY_DIM, width=3, emi=(40, 120, 145),
          orm=ORM_GLOW)
    for i in range(8):
        vline(m, r, i / 8.0, 0.0, 1.0, shade(ANC, 0.44), width=6)
    r = L.R_DRING_I
    fill(m, r, dif=ANC_DEEP, ao=AO_DEEP, rough=130, metal=0)
    hline(m, r, 0.40, 0.0, 1.0, CY, width=6, emi=(150, 240, 255), orm=ORM_GLOW)


def paint_petals(m):
    # ── outer shell: one big unbroken pale surface per petal ──
    r = L.R_PETAL_O
    grad_v(m, r, ANC_LT, ANC)
    fill(m, r, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    grad_v(m, r, ANC_LT, ANC)
    # tone-on-tone plate alternation (+-7%): the shell reads SEGMENTED even
    # under flat shading, without tripping the impostor baker's checker
    for i in range(6):
        if i % 2:
            continue
        sx0, _ = rlerp(r, i / 6.0, 0)
        sx1, _ = rlerp(r, (i + 1) / 6.0, 0)
        grad_v(m, (sx0, r[1], sx1, r[3]), shade(ANC_LT, 0.93), shade(ANC, 0.93))
    # petal-to-petal cut seams (cell edges) — deep, clean
    for fu in (0.0, 1.0):
        vline(m, r, fu, 0.0, 1.0, shade(ANC, 0.34), width=10,
              orm=(AO_SEAM, R_STONE, M_STONE))
    # meridian tracery: cyan runs up the seams between the shell's plates
    for i in (1, 3, 5):
        fu = i / 6.0
        vline(m, r, fu, 0.02, 1.0, shade(ANC, 0.42), width=8,
              orm=(AO_SEAM, R_STONE, M_STONE))
        vline(m, r, fu, 0.10, 0.98, CY, width=3, emi=(96, 218, 246),
              orm=ORM_GLOW)
    for i in (2, 4):
        vline(m, r, i / 6.0, 0.0, 1.0, shade(ANC, 0.50), width=5,
              orm=(AO_SEAM, R_STONE, M_STONE))
    # latitude seams on row boundaries (never a quad centroid)
    for j in (1, 2, 3, 4):
        hline(m, r, j / 5.0, 0.03, 0.97, shade(ANC, 0.46), width=6,
              orm=(AO_SEAM, R_STONE, M_STONE))
    # oculus lip and the equator lip
    hline(m, r, 0.045, 0.0, 1.0, CY, width=5, emi=(150, 240, 255),
          orm=ORM_GLOW)
    hline(m, r, 0.965, 0.0, 1.0, shade(ANC, 0.38), width=8,
          orm=(AO_SEAM, R_STONE, M_STONE))

    # ── inner shell: what the iris hides ──
    r = L.R_PETAL_I
    fill(m, r, dif=ANC_DEEP, ao=AO_DEEP, rough=132, metal=0)
    grad_v(m, r, shade(ANC_DEEP, 0.75), (26, 64, 76))
    fill(m, r, ao=AO_DEEP, rough=132, metal=0)
    grad_v(m, r, shade(ANC_DEEP, 0.75), (26, 64, 76))
    for i in range(1, 6):
        fu = i / 6.0
        vline(m, r, fu, 0.0, 1.0, CY, width=4, emi=(70, 190, 225),
              orm=ORM_GLOW)
    for j in (1, 2, 3, 4):
        hline(m, r, j / 5.0, 0.0, 1.0, shade(ANC_DEEP, 0.55), width=4)
    hline(m, r, 0.94, 0.0, 1.0, CY_HOT, width=8, emi=(190, 248, 255),
          orm=ORM_GLOW)

    # ── cut rims: four stacked strips, cyan biased off-centre ──
    r = L.R_PETAL_E
    fill(m, r, dif=ANC_DEEP, ao=AO_DEEP, rough=140, metal=0)
    for s in range(4):
        sr = subrect(r, s / 4.0, (s + 1) / 4.0)
        hline(m, sr, 0.26, 0.0, 1.0, CY, width=4, emi=(120, 232, 252),
              orm=ORM_GLOW)
        hline(m, sr, 0.0, 0.0, 1.0, shade(ANC_DEEP, 0.5), width=2)


def paint_vanes(m):
    """u = the hexagon's six faces; column 1 = outward broad face,
    column 4 = inward. Tracery is kept off the column mid-lines so the
    impostor baker samples plain stone."""
    r = L.R_VANE
    fill(m, r, dif=ANC, ao=AO_BASE - 4, rough=R_STONE, metal=M_STONE)
    for col, base in ((1, ANC_LT), (4, ANC)):
        sx0, _ = rlerp(r, col / 6.0, 0)
        sx1, _ = rlerp(r, (col + 1) / 6.0, 0)
        grad_v(m, (sx0, r[1], sx1, r[3]), base, shade(base, 0.92))
        m.o.rectangle([sx0, r[1], sx1, r[3]], fill=ORM_STONE)
        grad_v(m, (sx0, r[1], sx1, r[3]), base, shade(base, 0.92))
    # face boundaries = recessed seams
    for i in range(6):
        vline(m, r, i / 6.0, 0.0, 1.0, shade(ANC, 0.44), width=7,
              orm=(AO_SEAM, R_STONE, M_STONE))
    # station seams (row boundaries) + a taper break
    for j in (1, 2, 3, 4):
        hline(m, r, j / 5.0, 0.0, 1.0, shade(ANC, 0.48), width=5,
              orm=(AO_SEAM, R_STONE, M_STONE))
    # outward face: paired tracery, off-centre, brightening toward the tip
    for f in (0.28, 0.72):
        fu = (1.0 + f) / 6.0
        vline(m, r, fu, 0.02, 0.94, shade(ANC_LT, 0.44), width=7,
              orm=(AO_SEAM, R_STONE, M_STONE))
        vline(m, r, fu, 0.02, 0.88, CY, width=3, emi=(90, 214, 246),
              orm=ORM_GLOW)
        vline(m, r, fu, 0.02, 0.30, CY_HOT, width=3, emi=(180, 246, 255),
              orm=ORM_GLOW)
    # inward face: a single dim line
    vline(m, r, (4.0 + 0.3) / 6.0, 0.05, 0.92, CY_DIM, width=3,
          emi=(30, 100, 122), orm=ORM_GLOW)


def paint_tab(m):
    """The one team-owned surface on the model: a capture tab set into the
    front vane, ancient stone framing a resprayable panel."""
    z = L.R_TAB
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 8, rough=R_STONE,
         metal=M_STONE)
    inset = 16
    box = [x0 + inset, y0 + inset, x1 - inset, y1 - inset]
    m.d.rectangle(box, fill=shade(ANC, 0.42))
    m.o.rectangle(box, fill=(AO_SEAM, R_STONE, M_STONE))
    inner = [box[0] + 12, box[1] + 12, box[2] - 12, box[3] - 12]
    PL.team_panel(m, inner, outline=shade(ANC, 0.40), width=3)
    # cyan retaining tracery around the panel
    m.d.rectangle([box[0] - 5, box[1] - 5, box[2] + 5, box[3] + 5],
                  outline=CY, width=3)
    m.e.rectangle([box[0] - 5, box[1] - 5, box[2] + 5, box[3] + 5],
                  outline=(110, 226, 250), width=3)
    m.o.rectangle([box[0] - 5, box[1] - 5, box[2] + 5, box[3] + 5],
                  outline=ORM_GLOW, width=3)
    # a pair of ancient index marks, tone-on-tone
    cxm = (inner[0] + inner[2]) / 2
    for dy in (0.24, 0.76):
        yy = inner[1] + (inner[3] - inner[1]) * dy
        m.d.line([(inner[0] + 10, yy), (cxm - 26, yy)],
                 fill=shade(TEAMGREY, 0.82), width=4)
        m.d.line([(cxm + 26, yy), (inner[2] - 10, yy)],
                 fill=shade(TEAMGREY, 0.82), width=4)


def paint_core(m):
    r = L.R_CORE
    # pedestal (lower 38%) then column (upper 58%)
    ped = subrect(r, 0.62, 1.0)
    col = subrect(r, 0.0, 0.58)
    fill(m, ped, dif=ANC, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    grad_v(m, ped, ANC_LT, ANC_DK)
    fill(m, col, dif=ANC_DK, ao=AO_BASE - 12, rough=R_STONE, metal=M_STONE)
    grad_v(m, col, ANC_DEEP, ANC_DK)
    for f in (0.0, 0.25, 0.5, 0.75):
        vline(m, r, f, 0.0, 1.0, shade(ANC, 0.40), width=6,
              orm=(AO_SEAM, R_STONE, M_STONE))
    hline(m, ped, 0.30, 0.0, 1.0, CY, width=4, emi=(96, 216, 244),
          orm=ORM_GLOW)
    for f in (0.12, 0.38, 0.62, 0.88):
        vline(m, col, f, 0.05, 0.95, CY, width=4, emi=(140, 236, 254),
              orm=ORM_GLOW)

    # crystal: the discharge core itself
    r = L.R_CRYST
    fill(m, r, dif=CY, ao=AO_BASE, rough=R_GLOW, metal=0)
    grad_v(m, subrect(r, 0.0, 0.5), (120, 226, 248), CY_HOT)
    grad_v(m, subrect(r, 0.5, 1.0), CY_HOT, (110, 220, 246))
    m.e.rectangle(r, fill=(150, 236, 255))
    m.e.rectangle(subrect(r, 0.36, 0.64), fill=(226, 252, 255))
    m.o.rectangle(r, fill=ORM_GLOW)
    for i in range(1, 10):
        vline(m, r, i / 10.0, 0.0, 1.0, (44, 150, 186), width=3)
        a = rlerp(r, i / 10.0, 0.0)
        b = rlerp(r, i / 10.0, 1.0)
        m.e.line([a, b], fill=(70, 180, 220), width=3)

    # needle: pale stone shaft, tip alight
    r = L.R_NEEDLE
    fill(m, r, dif=ANC_LT, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    m.d.rectangle(subrect(r, 0.0, 0.34), fill=CY)
    m.e.rectangle(subrect(r, 0.0, 0.34), fill=(170, 242, 255))
    m.o.rectangle(subrect(r, 0.0, 0.34), fill=ORM_GLOW)
    for i in range(6):
        vline(m, r, i / 6.0, 0.34, 1.0, shade(ANC_LT, 0.46), width=4,
              orm=(AO_SEAM, R_STONE, M_STONE))
        vline(m, r, (i + 0.5) / 6.0, 0.40, 1.0, CY_DIM, width=2,
              emi=(28, 92, 112))


def paint_halo(m):
    """Four stacked strips: outer face, underside, inner face, top."""
    r = L.R_HALO
    fill(m, r, dif=ANC_LT, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    out = subrect(r, 0.00, 0.25)
    und = subrect(r, 0.25, 0.50)
    inn = subrect(r, 0.50, 0.75)
    top = subrect(r, 0.75, 1.00)
    m.d.rectangle(out, fill=ANC_LT)
    hline(m, out, 0.15, 0.0, 1.0, CY, width=3, emi=(120, 230, 252),
          orm=ORM_GLOW)
    m.d.rectangle(und, fill=ANC_DK)
    hline(m, und, 0.5, 0.0, 1.0, CY_DIM, width=3, emi=(36, 112, 136))
    m.d.rectangle(inn, fill=CY)
    m.e.rectangle(inn, fill=(178, 244, 255))
    m.o.rectangle(inn, fill=ORM_GLOW)
    m.d.rectangle(top, fill=ANC_LT)
    hline(m, top, 0.5, 0.0, 1.0, shade(ANC, 0.45), width=3)
    for i in range(16):
        vline(m, r, i / 16.0, 0.0, 1.0, shade(ANC, 0.46), width=3)


def paint_dark(m):
    fill(m, L.R_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=180, metal=0)


# ── assembly ────────────────────────────────────────────────────────────

def paint_all():
    P.BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=ANC, ao=AO_BASE, rough=R_STONE, metal=M_STONE)
    paint_scorch(m)
    paint_disc(m)
    paint_apron(m)
    paint_collar(m)
    paint_dome_ring(m)
    paint_petals(m)
    paint_vanes(m)
    paint_tab(m)
    paint_core(m)
    paint_halo(m)
    paint_dark(m)

    # ── geological weathering only: dust drift, soil burial, scorch ──
    from weathering import Weather
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.30)
    wx.mud_band(L.R_SCORCH.rect, 0.62, fade=None, spatter=True)
    wx.soot_patch(L.R_SCORCH.rect, 0.45)
    wx.mud_band(L.R_APRON_W, 0.50, fade='down', dust=0.42)
    wx.mud_band(L.R_VANE, 0.24, fade='down', dust=0.26)
    wx.mud_band(L.R_COLLAR_W, 0.16, fade='down', dust=0.30)
    wx.mud_band(L.R_DRING_O, 0.10, fade='down', dust=0.34)
    wx.mud_band(L.R_PETAL_O, 0.12, fade='down', dust=0.36)
    wx.mud_band(L.R_DISC.rect, 0.14, fade=None, spatter=False, dust=0.30)
    wx.soot_patch(subrect(L.R_VANE, 0.0, 0.16), 0.22)   # scorch at the tips

    from normals import HeightMap
    hm = HeightMap()
    for i in range(8):
        x, _ = rlerp(L.R_APRON_W, i / 8.0, 0)
        hm.line((x, L.R_APRON_W[1]), (x, L.R_APRON_W[3]), -0.7, width=7)
        x, _ = rlerp(L.R_DRING_O, i / 8.0, 0)
        hm.line((x, L.R_DRING_O[1]), (x, L.R_DRING_O[3]), -0.7, width=7)
    for i in range(1, 6):
        x, _ = rlerp(L.R_PETAL_O, i / 6.0, 0)
        hm.line((x, L.R_PETAL_O[1]), (x, L.R_PETAL_O[3]), -0.6, width=7)
    cx, cy, s = polar(L.R_DISC)
    for rr in (1.70, 2.40, 2.78, 3.40, 4.21, 4.98):
        hm.disc(cx, cy, rr * s, -0.35)
        hm.disc(cx, cy, rr * s - 5, 0.0)
    PL.finish(m, L, 'ms_anc_storm_caster', hm=hm, wx=wx, emissive_blur=0.9)


if __name__ == '__main__':
    paint_all()
