"""paint_ms_anc_aqueduct — 2048² PBR set for ms_anc_aqueduct.

ANCIENT REGISTER: one pale monolithic stone, cast not built.  Large
unbroken surfaces cut only by CLEAN RECESSED SEAMS — course lines at the
structural levels, paired tracery grooves up each pier, perfect circles
centred on the pier faces (half at each tile end so chained segments make
whole discs), and precise arch rings struck about the real arch centres.
No rivets, no bolts, no patchwork, no rust: BOLT_LOG is never touched.

Emissive CYAN is the ancient signature and the only emissive on the
model: a pulse line along the channel rim (dashed beats every 2.5 m so it
tiles), a lens at every arch crown, one tracery hairline per pier, a
centreline down every soffit, and faint veins in the broken core stone.
It is ALIVE along the intact run and DEAD across the breached bay, where
scorch smothers it.

Weathering is geological, never mechanical: pale dust drifts on every up
face, soil burial climbing the base course, wind-dust fading up the
elevation, scorch at the breach, and a calcite bloom staining the
elevation under the fossilised flow.  Deterministic seed 90210 (paint.RNG).
"""
from __future__ import annotations
import numpy as np

import ms_anc_aqueduct_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, jit, shade, RNG,
                   AO_BASE, AO_SEAM, AO_DEEP)

W = 2048
STEM = 'ms_anc_aqueduct'

# ── palette: ancient pale cast stone ─────────────────────────────────────
ANC = (171, 169, 159)
ANC_LT = (189, 187, 177)
ANC_DK = (143, 141, 132)
ANC_DEEP = (108, 107, 100)
CORE = (72, 71, 68)               # broken core / undersides
CORE_LT = (94, 93, 89)
CALC = (215, 209, 191)            # fossilised calcite
CALC_DK = (176, 169, 149)
SOIL = (94, 82, 64)
SOIL_LT = (122, 108, 86)
CYAN_HOT = (96, 228, 255)
CYAN_MID = (44, 150, 178)
CYAN_LOW = (20, 74, 92)

R_STONE, M_STONE = 196, 4
R_CALC, M_CALC = 176, 6

eu, ev = PL.zone_fns(L.Z_ELEV)    # world z -> px, world y -> px
PPM = (L.Z_ELEV.rect[2] - L.Z_ELEV.rect[0]) / (L.Z1 - L.Z0)   # px per metre


# ── ancient cut primitives ───────────────────────────────────────────────

def groove_h(m, wz0, wz1, wy, base=ANC, w=3, ao=AO_SEAM):
    y = ev(wy)
    m.d.line([(eu(wz0), y), (eu(wz1), y)], fill=shade(base, 0.80), width=w)
    m.d.line([(eu(wz0), y + w), (eu(wz1), y + w)],
             fill=shade(base, 1.07), width=1)
    m.o.line([(eu(wz0), y), (eu(wz1), y)], fill=(ao, R_STONE + 8, M_STONE),
             width=w)


def groove_v(m, wz, wy0, wy1, base=ANC, w=3, ao=AO_SEAM):
    x = eu(wz)
    m.d.line([(x, ev(wy0)), (x, ev(wy1))], fill=shade(base, 0.80), width=w)
    m.o.line([(x, ev(wy0)), (x, ev(wy1))], fill=(ao, R_STONE + 8, M_STONE),
             width=w)


def arc_groove(m, cz, cy, r, base=ANC, w=3, factor=0.80, ao=AO_SEAM):
    """Struck arc about a real arch centre (the elevation zone is isotropic
    so a circle in metres is a circle in pixels)."""
    rp = r * PPM
    box = [eu(cz) - rp, ev(cy) - rp, eu(cz) + rp, ev(cy) + rp]
    m.d.arc(box, 180, 360, fill=shade(base, factor), width=w)
    m.o.arc(box, 180, 360, fill=(ao, R_STONE + 8, M_STONE), width=w)


def emi_line(m, pts, col, w=2):
    m.e.line(pts, fill=col, width=w)


# ── the elevation: the whole 30 x 30 m face in one isotropic zone ────────

def paint_elevation(m):
    x0, y0, x1, y1 = L.Z_ELEV.rect
    fill(m, (x0, y0, x1 + 128, y1), dif=ANC, ao=AO_BASE - 2,
         rough=R_STONE, metal=M_STONE)

    # cast variation: broad, very low contrast (impostor-safe)
    for _ in range(26):
        bx = x0 + RNG.random() * (x1 - x0)
        by = y0 + RNG.random() * (y1 - y0)
        r = 90 + RNG.random() * 240
        m.d.ellipse([bx - r, by - r * 0.62, bx + r, by + r * 0.62],
                    fill=jit(shade(ANC, 0.97 + 0.06 * RNG.random()), 3))

    # ── course lines: the clean recessed seams that segment the monolith ──
    for wy in (L.BASE_H, L.IMP_Y0, L.IMP_Y1, L.COR_Y0, L.COR_Y1,
               L.U_TOP, L.RIM_Y0):
        groove_h(m, L.Z0, L.Z1, wy)
    # a finer pair reading the cornice as one cantilevered band
    groove_h(m, L.Z0, L.Z1, L.COR_Y0 + 0.28, w=2, ao=AO_SEAM + 24)
    groove_h(m, L.Z0, L.Z1, L.COR_Y1 - 0.28, w=2, ao=AO_SEAM + 24)

    # ── lower piers: paired tracery grooves + the perfect circle ──
    for zc in L.LP_Z:
        for s in (-1, 1):
            gz = zc + s * 0.55
            groove_v(m, gz, L.BASE_H + 0.25, L.IMP_Y0 - 0.2, w=3)
            groove_v(m, gz, L.IMP_Y1 + 0.2, L.L_SPRING + L.L_R - 0.3, w=3)
        # pier arrises
        for s in (-1, 1):
            groove_v(m, zc + s * L.LP_W / 2, 0.0, L.L_TOP, w=2,
                     ao=AO_SEAM + 20)
        disc(m, zc, L.DISC_Y, L.DISC_R)

    # ── upper piers: single arris grooves ──
    for zc in L.UP_Z:
        for s in (-1, 1):
            groove_v(m, zc + s * L.UP_W / 2, L.U_Y0, L.U_TOP, w=2,
                     ao=AO_SEAM + 20)

    # ── arch rings, struck about the true centres ──
    for zc in L.L_BAYS:
        band(m, zc, L.L_SPRING, L.L_R, 1.15)
    for zc in L.U_BAYS:
        band(m, zc, L.U_SPRING, L.U_R, 0.48)

    # ── channel + rim ──
    groove_h(m, L.Z0, L.Z1, L.CH_Y0 + 0.55, w=2, ao=AO_SEAM + 24)
    groove_h(m, L.Z0, L.Z1, L.RIM_LINE_Y, base=ANC, w=4, ao=AO_SEAM - 20)

    PL_wear(m, (x0, y0, x1, y1))


def band(m, zc, cy, r, ring):
    """Arch ring: a tone-on-tone band between two struck grooves."""
    rp_in, rp_out = r * PPM, (r + ring) * PPM
    box_o = [eu(zc) - rp_out, ev(cy) - rp_out, eu(zc) + rp_out,
             ev(cy) + rp_out]
    m.d.arc(box_o, 180, 360, fill=jit(shade(ANC, 1.035), 2),
            width=int(rp_out - rp_in))
    arc_groove(m, zc, cy, r + ring, factor=0.78, w=3)
    arc_groove(m, zc, cy, r + 0.06, factor=0.86, w=2, ao=AO_SEAM + 20)


def disc(m, zc, cy, r):
    """The perfect circle: a recessed disc with an ancient tracery ring."""
    cu, cv = eu(zc), ev(cy)
    rp = r * PPM
    m.d.ellipse([cu - rp, cv - rp, cu + rp, cv + rp],
                fill=jit(shade(ANC, 0.955), 2))
    m.o.ellipse([cu - rp, cv - rp, cu + rp, cv + rp],
                fill=(AO_BASE - 22, R_STONE + 6, M_STONE))
    m.d.ellipse([cu - rp, cv - rp, cu + rp, cv + rp],
                outline=shade(ANC, 0.74), width=4)
    ri = 0.56 * rp
    m.d.ellipse([cu - ri, cv - ri, cu + ri, cv + ri],
                outline=shade(ANC, 0.80), width=3)
    m.d.ellipse([cu - ri * 0.34, cv - ri * 0.34, cu + ri * 0.34,
                 cv + ri * 0.34], fill=jit(shade(ANC, 0.90), 2))


def PL_wear(m, rect):
    """Geological chipping only at the extreme edges — no mechanical wear."""
    from paint import wear_edges
    wear_edges(m, rect, ANC, 30)


# ── cyan: the ancient signature, emissive only ───────────────────────────

def paint_cyan(m):
    dead0, dead1 = L.BREACH_BAY - 3.6, L.BREACH_BAY + 4.2   # killed run

    def alive(wz):
        return not (dead0 <= wz <= dead1)

    # rim pulse line, drawn in tiling 0.25 m steps so the break is exact
    y = ev(L.RIM_LINE_Y)
    z = L.Z0
    while z < L.Z1 - 1e-6:
        z2 = min(z + 0.25, L.Z1)
        if alive(0.5 * (z + z2)):
            emi_line(m, [(eu(z), y), (eu(z2), y)], CYAN_MID, w=3)
        z = z2
    # pulse beats every 2.5 m (30 / 2.5 = 12 -> tiles seamlessly)
    for wz in np.arange(L.Z0, L.Z1 + 0.01, 2.5):
        if not alive(wz):
            continue
        u = eu(wz)
        m.e.ellipse([u - 7, y - 7, u + 7, y + 7], fill=CYAN_HOT)
        m.d.ellipse([u - 6, y - 6, u + 6, y + 6],
                    fill=jit(shade(ANC, 1.06), 2))

    # arch-crown lenses
    for zc in L.L_BAYS:
        lens(m, zc, L.L_SPRING + L.L_R + 0.72, 0.44)
    for zc in L.U_BAYS:
        if abs(zc - L.BREACH_BAY) < 1e-6:
            continue
        lens(m, zc, L.U_SPRING + L.U_R + 0.30, 0.26)

    # one tracery hairline per pier (off-centre: keeps the big pier quads'
    # UV centroid on clean stone for the impostor baker)
    for zc in L.LP_Z:
        u = eu(zc - 0.55)
        emi_line(m, [(u, ev(L.BASE_H + 0.25)), (u, ev(L.IMP_Y0 - 0.2))],
                 CYAN_LOW, w=2)
        emi_line(m, [(u, ev(L.IMP_Y1 + 0.2)),
                     (u, ev(L.L_SPRING + L.L_R - 0.3))], CYAN_LOW, w=2)
        # tracery ring inside the perfect circle
        cu, cv = eu(zc), ev(L.DISC_Y)
        ri = 0.56 * L.DISC_R * PPM
        m.e.ellipse([cu - ri, cv - ri, cu + ri, cv + ri],
                    outline=CYAN_MID, width=3)


def lens(m, zc, wy, r):
    cu, cv = eu(zc), ev(wy)
    rp = r * PPM
    m.d.ellipse([cu - rp, cv - rp, cu + rp, cv + rp],
                fill=jit(shade(ANC, 0.88), 2))
    m.o.ellipse([cu - rp, cv - rp, cu + rp, cv + rp],
                fill=(AO_BASE - 30, 120, M_STONE))
    m.e.ellipse([cu - rp * 0.78, cv - rp * 0.78, cu + rp * 0.78,
                 cv + rp * 0.78], fill=CYAN_HOT)
    m.e.ellipse([cu - rp, cv - rp, cu + rp, cv + rp],
                outline=CYAN_MID, width=2)


# ── the calcite stain washing down the elevation ─────────────────────────

def paint_stain(m):
    path = [(2.60, 26.4, 2.0), (2.35, 24.0, 1.8), (2.05, 21.6, 1.7),
            (1.60, 19.4, 1.7), (1.05, 16.0, 1.8), (0.60, 12.6, 1.9),
            (0.30, 8.5, 2.0), (0.15, 4.5, 2.2), (0.00, 0.6, 2.6)]
    left = [(eu(z - w), ev(y)) for (z, y, w) in path]
    right = [(eu(z + w), ev(y)) for (z, y, w) in path][::-1]
    m.d.polygon(left + right, fill=jit(shade(CALC, 0.86), 4))
    inner = [(eu(z - w * 0.42), ev(y)) for (z, y, w) in path] + \
            [(eu(z + w * 0.42), ev(y)) for (z, y, w) in path][::-1]
    m.d.polygon(inner, fill=jit(CALC, 4))
    for i in range(len(path) - 1):
        z0, y0, w0 = path[i]
        z1, y1, _ = path[i + 1]
        for f in np.linspace(0.1, 0.9, 4):
            yy = y0 + (y1 - y0) * f
            zz = z0 + (z1 - z0) * f
            m.d.arc([eu(zz - w0), ev(yy) - 6, eu(zz + w0), ev(yy) + 6],
                    0, 180, fill=shade(CALC, 0.80), width=2)


# ── the remaining cells ──────────────────────────────────────────────────

def paint_top(m):
    x0, y0, x1, y1 = L.Z_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_LT, ao=AO_BASE, rough=R_STONE + 10,
         metal=M_STONE)
    for _ in range(40):
        bx = x0 + RNG.random() * (x1 - x0 - 120)
        by = y0 + RNG.random() * (y1 - y0 - 40)
        m.d.ellipse([bx, by, bx + 60 + RNG.random() * 90,
                     by + 18 + RNG.random() * 22],
                    fill=jit(shade(ANC_LT, 0.97), 3))
    tu, tv = PL.zone_fns(L.Z_TOP)
    for wx in (-2.2, 2.2):                       # rim arrises
        m.d.line([(x0, tv(wx)), (x1, tv(wx))], fill=shade(ANC_LT, 0.84),
                 width=3)
        m.o.line([(x0, tv(wx)), (x1, tv(wx))],
                 fill=(AO_SEAM, R_STONE, M_STONE), width=3)


def paint_stone(m):
    x0, y0, x1, y1 = L.Z_STONE.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 22,
         rough=R_STONE + 4, metal=M_STONE)
    su, sv = PL.zone_fns(L.Z_STONE)
    for wy in (L.BASE_H, L.IMP_Y0, L.IMP_Y1, L.COR_Y0, L.COR_Y1, L.U_TOP):
        yy = sv(wy)
        m.d.line([(x0, yy), (x1, yy)], fill=shade(ANC_DK, 0.80), width=3)
        m.o.line([(x0, yy), (x1, yy)], fill=(AO_SEAM, R_STONE, M_STONE),
                 width=3)
    for _ in range(18):
        bx = x0 + RNG.random() * (x1 - x0 - 60)
        by = y0 + RNG.random() * (y1 - y0 - 60)
        m.d.ellipse([bx, by, bx + 40 + RNG.random() * 60,
                     by + 30 + RNG.random() * 60],
                    fill=jit(shade(ANC_DK, 0.97), 3))


def paint_core(m):
    x0, y0, x1, y1 = L.Z_CORE.rect
    fill(m, (x0, y0, x1, y1), dif=CORE, ao=AO_DEEP + 6, rough=R_STONE + 14,
         metal=M_STONE)
    # crystalline core: faceted tone-on-tone shards, cyan veins in emissive
    for _ in range(48):
        bx = x0 + 8 + RNG.random() * (x1 - x0 - 48)
        by = y0 + 8 + RNG.random() * (y1 - y0 - 48)
        pts = [(bx, by), (bx + 14 + RNG.random() * 22, by + 4),
               (bx + 10 + RNG.random() * 26, by + 16 + RNG.random() * 18),
               (bx - 4, by + 12 + RNG.random() * 14)]
        m.d.polygon(pts, fill=jit(shade(CORE_LT, 0.92 + 0.16 * RNG.random()),
                                  3))
    for _ in range(14):
        bx = x0 + 10 + RNG.random() * (x1 - x0 - 20)
        by = y0 + 10 + RNG.random() * (y1 - y0 - 20)
        pts = [(bx, by)]
        for _s in range(3):
            bx += (RNG.random() - 0.5) * 60
            by += (RNG.random() - 0.5) * 40
            pts.append((bx, by))
        m.e.line(pts, fill=CYAN_LOW, width=2)
        m.d.line(pts, fill=shade(CORE_LT, 1.06), width=1)


def paint_soffit(m):
    x0, y0, x1, y1 = L.Z_SOFF.rect
    fill(m, (x0, y0, x1, y1), dif=ANC_DK, ao=AO_BASE - 34,
         rough=R_STONE + 6, metal=M_STONE)
    # transverse joints across the arc (u = arc parameter)
    for f in np.linspace(0.0, 1.0, 17):
        xx = x0 + (x1 - x0) * f
        m.d.line([(xx, y0), (xx, y1)], fill=shade(ANC_DK, 0.82), width=3)
        m.o.line([(xx, y0), (xx, y1)], fill=(AO_SEAM - 10, R_STONE, M_STONE),
                 width=3)
    # ancient centreline down the crown of every soffit
    yc = (y0 + y1) // 2
    m.d.line([(x0, yc), (x1, yc)], fill=shade(ANC_DK, 0.86), width=4)
    m.e.line([(x0, yc), (x1, yc)], fill=CYAN_LOW, width=3)


def paint_calcite(m):
    x0, y0, x1, y1 = L.Z_CALC.rect
    fill(m, (x0, y0, x1, y1), dif=CALC, ao=AO_BASE - 26, rough=R_CALC,
         metal=M_CALC)
    # flowstone banding: lines of constant u = rings around the drape
    xx = x0 + 4
    while xx < x1 - 4:
        step = 6 + RNG.random() * 22
        m.d.line([(xx, y0), (xx, y1)],
                 fill=jit(shade(CALC, 0.88 + 0.14 * RNG.random()), 4),
                 width=int(2 + RNG.random() * 4))
        xx += step
    for _ in range(60):                       # nodular lumps
        bx = x0 + RNG.random() * (x1 - x0 - 40)
        by = y0 + RNG.random() * (y1 - y0 - 40)
        r = 6 + RNG.random() * 20
        m.d.ellipse([bx, by, bx + r * 2, by + r],
                    fill=jit(shade(CALC, 1.03), 4))
    for _ in range(24):                       # dirt trapped in the layers
        bx = x0 + RNG.random() * (x1 - x0 - 60)
        m.d.line([(bx, y0), (bx, y1)], fill=jit(CALC_DK, 5), width=2)


def paint_soil(m):
    x0, y0, x1, y1 = L.Z_SOIL.rect
    fill(m, (x0, y0, x1, y1), dif=SOIL, ao=AO_BASE - 30, rough=224,
         metal=2)
    for _ in range(160):
        bx = x0 + RNG.random() * (x1 - x0 - 60)
        by = y0 + RNG.random() * (y1 - y0 - 30)
        r = 8 + RNG.random() * 34
        m.d.ellipse([bx, by, bx + r * 2, by + r],
                    fill=jit(shade(SOIL_LT, 0.85 + 0.35 * RNG.random()), 6))
    su, sv = PL.zone_fns(L.Z_SOIL)
    m.d.rectangle([x0, y0, x1, sv(1.7)], fill=jit(SOIL_LT, 6))


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_core(m)
    paint_stone(m)
    paint_soffit(m)
    paint_calcite(m)
    paint_soil(m)
    paint_top(m)
    paint_elevation(m)
    paint_stain(m)
    paint_cyan(m)

    # ── geological weathering: dust, burial, scorch — no rust, no bolts ──
    from weathering import Weather
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.34)
    ex0, ey0, ex1, ey1 = L.Z_ELEV.rect
    # wind dust fading up the whole elevation
    wx.mud_band((ex0, ey0, ex1, ey1), 0.16, fade='down', spatter=False,
                dust=0.30)
    # soil burial climbing the base course
    wx.mud_band((ex0, ev(4.2), ex1, ey1), 0.68, fade='down', spatter=True)
    # dust drifts on every up-face and in the soil cell
    wx.mud_band(L.Z_TOP.rect, 0.42, fade=None, spatter=True, dust=0.35)
    wx.mud_band(L.Z_SOIL.rect, 0.85, fade=None, spatter=True)
    wx.mud_band(L.Z_STONE.rect, 0.30, fade='down', spatter=False, dust=0.28)
    wx.mud_band(L.Z_CORE.rect, 0.24, fade='down', spatter=False, dust=0.22)
    wx.mud_band(L.Z_CALC.rect, 0.22, fade='right', spatter=True, dust=0.18)
    # scorch at the breach — also smothers the cyan run beneath it
    wx.soot_patch((eu(-2.0), ev(L.RIM_Y1), eu(8.0), ev(L.COR_Y0)), 0.44)
    wx.soot_patch((eu(-1.0), ev(L.U_TOP), eu(6.6), ev(L.U_Y0)), 0.62)
    wx.soot_patch((L.Z_CORE.rect[0], L.Z_CORE.rect[1],
                   L.Z_CORE.rect[0] + 90, L.Z_CORE.rect[3]), 0.4)

    # ── authored relief ──
    from normals import HeightMap
    hm = HeightMap()
    for zc in L.LP_Z:                        # the perfect circles
        cu, cv = eu(zc), ev(L.DISC_Y)
        hm.disc(cu, cv, L.DISC_R * PPM, -0.42)
    hm.rect((L.Z_ELEV.rect[0], ev(L.COR_Y1), L.Z_ELEV.rect[2],
             ev(L.COR_Y0)), 0.5)             # cornice stands proud
    hm.rect((L.Z_ELEV.rect[0], ev(L.RIM_Y1), L.Z_ELEV.rect[2],
             ev(L.RIM_Y0)), 0.4)             # rim stands proud
    hm.line((L.Z_ELEV.rect[0], ev(L.RIM_LINE_Y)),
            (L.Z_ELEV.rect[2], ev(L.RIM_LINE_Y)), -0.55, width=4)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
