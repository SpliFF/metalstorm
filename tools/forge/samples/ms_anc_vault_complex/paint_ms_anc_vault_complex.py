"""paint_ms_anc_vault_complex — 2048² PBR set for the ancient vault complex.

ANCIENT REGISTER: monolithic graphite, large unbroken faces segmented by
clean recessed seams. No rivets, no bolted patches, no scrap. Emissive CYAN
is the only light in the set — ACTIVE on the main door, the bay iris, the
causeway guide lines and the pylon channels; DORMANT (dim embers) on the two
sealed doors and the far wall tracery. Weathering is geological: dust drift,
soil burial at the collapsed -X corner, scorch above the portal — never rust
streaks. No team mask content (--no-team site).

The main door face is drawn with EXACT 8-fold rotational symmetry so the
`open` clip's 3 x 45 deg roll leaves the pose indistinguishable.
"""
from __future__ import annotations
import numpy as np

import ms_anc_vault_complex_layout as L   # sets meshlib.ATLAS = 2048

import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import Maps, fill, seam_h, seam_v, jit, shade, AO_BASE, AO_SEAM, \
    AO_DEEP, RNG

W = 2048
STEM = 'ms_anc_vault_complex'

# ── palette ─────────────────────────────────────────────────────────────
MONO = (98, 102, 110)      # monolith graphite (light enough to read at zoom)
MONO_LT = (114, 118, 126)
MONO_DK = (74, 77, 84)
MONO_DKR = (52, 54, 60)
PALE = (130, 134, 142)     # architrave / collar facing
CHAMBER = (20, 22, 27)     # inside the bay
CYAN = (96, 238, 255)      # ACTIVE emissive
CYAN_MID = (46, 140, 162)
CYAN_DIM = (34, 90, 104)   # cold diffuse tint inside a seam channel
EMBER = (34, 104, 122)     # DORMANT emissive
EARTH = (104, 90, 68)
EARTH_DK = (76, 66, 50)
ROCKG = (98, 94, 87)
ROCK_DK = (72, 70, 64)
DUST = (138, 128, 110)
SCORCH = (40, 36, 32)

ORM_MONO = (AO_BASE, 118, 30)     # ao, roughness, metallic
ORM_STONE = (AO_BASE - 8, 208, 6)
ORM_SEAM = (AO_DEEP, 96, 150)


def band(m, rect, dif, ao, rough, metal):
    fill(m, rect, dif=dif, ao=ao, rough=rough, metal=metal)


# ══════════════════════════════════════════════ wall / architrave fields

def paint_wall_front(m, hm):
    z = L.Z_WALL_F
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    band(m, (x0, y0, x1, y1), MONO, *ORM_MONO)

    # cyclopean courses: very large tone-on-tone blocks, clean recessed seams
    vx = (-14.0, -5.0, 4.0, 13.0)
    hy = (5.2, 9.4, 13.0, 15.6)
    xs = [-17.6] + list(vx) + [17.6]
    ys = [0.0] + list(hy) + [17.6]
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            tone = 1.0 + 0.045 * (((i * 3 + j) % 3) - 1)
            m.d.rectangle([u(xs[i]), v(ys[j + 1]), u(xs[i + 1]), v(ys[j])],
                          fill=jit(shade(MONO, tone), 2))
    for sx in vx:
        m.d.line([(u(sx), y0), (u(sx), y1)], fill=MONO_DKR, width=7)
        m.o.line([(u(sx), y0), (u(sx), y1)], fill=ORM_SEAM, width=7)
        hm.line((u(sx), y0), (u(sx), y1), -0.65, width=6)
    for sy in hy:
        m.d.line([(x0, v(sy)), (x1, v(sy))], fill=MONO_DKR, width=7)
        m.o.line([(x0, v(sy)), (x1, v(sy))], fill=ORM_SEAM, width=7)
        hm.line((x0, v(sy)), (x1, v(sy)), -0.65, width=6)

    # pilaster fins read as proud ribs: light edge + shadow edge
    for fx in L.FIN_X:
        m.d.rectangle([u(fx - 0.45), v(13.0), u(fx + 0.45), v(1.0)],
                      fill=jit(MONO_LT, 3))
        m.d.line([(u(fx + 0.45), v(13.0)), (u(fx + 0.45), v(1.0))],
                 fill=MONO_DK, width=5)
        hm.rect((u(fx - 0.45), v(13.0), u(fx + 0.45), v(1.0)), 0.5)

    # ancient tracery — a single dormant circuit reaching in from the far side
    trace = [((13.0, 1.4), (13.0, 13.0)), ((13.0, 13.0), (4.0, 13.0)),
             ((4.0, 13.0), (4.0, 5.2)), ((4.0, 5.2), (-5.0, 5.2)),
             ((-5.0, 5.2), (-5.0, 9.4))]
    for (ax, ay), (bx, by) in trace:
        pa, pb = (u(ax), v(ay)), (u(bx), v(by))
        m.d.line([pa, pb], fill=CYAN_DIM, width=6)
        m.e.line([pa, pb], fill=EMBER, width=4)
    # node discs where the circuit turns
    for (nx, ny) in ((13.0, 13.0), (4.0, 13.0), (4.0, 5.2), (-5.0, 5.2)):
        cx, cy = u(nx), v(ny)
        m.d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], fill=CYAN_DIM)
        m.e.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=EMBER)

    # portal collar frame: pale facing, ACTIVE cyan channel down its centre
    cd = L.COLLAR_D
    jx = (L.PORTAL_CX - L.PORTAL_HW - cd / 2, L.PORTAL_CX + L.PORTAL_HW + cd / 2)
    for sx in jx:
        m.d.rectangle([u(sx - cd / 2), v(L.PORTAL_TOP + cd), u(sx + cd / 2),
                       v(L.PLINTH_Y)], fill=jit(PALE, 3))
        m.d.line([(u(sx), v(L.PORTAL_TOP)), (u(sx), v(L.PLINTH_Y + 0.3))],
                 fill=CYAN_DIM, width=6)
        m.e.line([(u(sx), v(L.PORTAL_TOP)), (u(sx), v(L.PLINTH_Y + 0.3))],
                 fill=CYAN, width=4)
    ly = L.PORTAL_TOP + cd / 2
    m.d.rectangle([u(jx[0] - cd / 2), v(L.PORTAL_TOP + cd), u(jx[1] + cd / 2),
                   v(L.PORTAL_TOP)], fill=jit(PALE, 3))
    m.d.line([(u(jx[0]), v(ly)), (u(jx[1]), v(ly))], fill=CYAN_DIM, width=6)
    m.e.line([(u(jx[0]), v(ly)), (u(jx[1]), v(ly))], fill=CYAN, width=4)

    # architrave band: pale facing with a deep recessed under-shadow
    m.d.rectangle([u(-14.5), v(15.5), u(12.5), v(12.9)], fill=jit(PALE, 3))
    m.d.line([(u(-14.5), v(12.95)), (u(12.5), v(12.95))], fill=MONO_DKR,
             width=8)
    for k in range(9):
        gx = -13.2 + k * 3.2
        m.d.line([(u(gx), v(15.4)), (u(gx), v(13.0))], fill=shade(PALE, 0.86),
                 width=6)
        hm.line((u(gx), v(15.4)), (u(gx), v(13.0)), -0.5, width=5)

    # geology: dust drift along the base, soil burial at the collapsed corner
    for i in range(11):
        t = i / 10.0
        col = tuple(int(a + (b - a) * (1 - t))
                    for a, b in zip(MONO, DUST))
        m.d.rectangle([x0, v(0.4 + 2.4 * t), x1, v(0.0)],
                      fill=jit(col, 3))
    for i in range(9):
        t = i / 8.0
        m.d.polygon([(u(-17.6), v(1.2 + 5.4 * (1 - t))),
                     (u(-15.4), v(1.2 + 6.0 * (1 - t))),
                     (u(-10.4), v(0.4 + 2.2 * (1 - t))),
                     (u(-10.4), v(0.0)), (u(-17.6), v(0.0))],
                    fill=jit(shade(EARTH_DK, 0.8 + 0.05 * i), 4))
    # scorch fan above the portal mouth
    for i, rr in enumerate((5.6, 4.0, 2.6)):
        col = jit(shade(MONO_DK, 0.80 + 0.06 * i), 3)
        m.d.polygon([(u(L.PORTAL_CX - rr), v(L.PORTAL_TOP + 0.1)),
                     (u(L.PORTAL_CX + rr), v(L.PORTAL_TOP + 0.1)),
                     (u(L.PORTAL_CX + rr * 0.55), v(L.PORTAL_TOP + 2.4 + rr * 0.3)),
                     (u(L.PORTAL_CX - rr * 0.55), v(L.PORTAL_TOP + 2.4 + rr * 0.3))],
                    fill=col)


def paint_wall_sides(m):
    z = L.Z_WALL_S
    x0, y0, x1, y1 = z.rect
    band(m, (x0, y0, x1, y1), MONO_DK, *ORM_MONO)
    u, v = PL.zone_fns(z)
    for sy in (5.2, 9.4, 13.0, 15.6):
        m.d.line([(x0, v(sy)), (x1, v(sy))], fill=MONO_DKR, width=6)
        m.o.line([(x0, v(sy)), (x1, v(sy))], fill=ORM_SEAM, width=6)
    for sz in (-4.0, 0.0, 4.0, 10.0):
        m.d.line([(u(sz), y0), (u(sz), y1)], fill=MONO_DKR, width=5)
    for i in range(9):
        t = i / 8.0
        col = tuple(int(a + (b - a) * (1 - t)) for a, b in zip(MONO_DK, DUST))
        m.d.rectangle([x0, v(0.3 + 2.0 * t), x1, v(0.0)], fill=jit(col, 3))


def paint_wall_top(m):
    z = L.Z_WALL_T
    x0, y0, x1, y1 = z.rect
    # monolith crowns, with wind-blown soil drifted into the courses
    band(m, (x0, y0, x1, y1), MONO_DK, *ORM_MONO)
    u, v = PL.zone_fns(z)
    for _ in range(90):
        bx = x0 + RNG.random() * (x1 - x0 - 60)
        by = y0 + (0.25 + 0.75 * RNG.random()) * (y1 - y0 - 34)
        c = jit(EARTH_DK, 7) if RNG.random() < 0.6 else jit(ROCK_DK, 7)
        m.d.polygon([(bx, by + 12), (bx + 24 + RNG.random() * 40, by),
                     (bx + 52 + RNG.random() * 34, by + 16),
                     (bx + 18, by + 28)], fill=c)
    m.d.rectangle([x0, v(4.0), x1, v(15.0)], fill=jit(EARTH_DK, 6))
    for sx in (-14.0, -5.0, 4.0, 13.0):
        m.d.line([(u(sx), y0), (u(sx), y1)], fill=MONO_DKR, width=6)
    m.d.rectangle([x0, v(-6.4), x1, v(-4.6)], fill=jit(MONO_LT, 4))


def paint_bay(m, hm):
    z = L.Z_BAY
    x0, y0, x1, y1 = z.rect
    band(m, (x0, y0, x1, y1), CHAMBER, AO_DEEP, 150, 60)
    u, v = PL.zone_fns(z)
    cx, cy = u(L.PORTAL_CX), v(L.PLINTH_Y + L.DOOR_R)
    sx = (x1 - x0) / (z.win[0][1] - z.win[0][0])          # px per metre (u)
    sy = (y1 - y0) / abs(z.win[1][1] - z.win[1][0])
    # concentric cyan rings — the iris the door uncovers
    for rr, wd, col in ((L.IRIS_R - 0.22, 12, CYAN),
                        (2.9, 7, CYAN_MID), (2.1, 5, CYAN_MID),
                        (1.2, 4, CYAN)):
        m.d.ellipse([cx - rr * sx, cy - rr * sy, cx + rr * sx, cy + rr * sy],
                    outline=CYAN_DIM, width=wd + 4)
        m.e.ellipse([cx - rr * sx, cy - rr * sy, cx + rr * sx, cy + rr * sy],
                    outline=col, width=wd)
    for k in range(8):
        a = 2 * np.pi * k / 8 + np.pi / 8
        p0 = (cx + 1.25 * sx * np.cos(a), cy - 1.25 * sy * np.sin(a))
        p1 = (cx + 3.6 * sx * np.cos(a), cy - 3.6 * sy * np.sin(a))
        m.d.line([p0, p1], fill=CYAN_DIM, width=6)
        m.e.line([p0, p1], fill=CYAN_MID, width=4)
    m.e.ellipse([cx - 0.55 * sx, cy - 0.55 * sy,
                 cx + 0.55 * sx, cy + 0.55 * sy], fill=CYAN)
    hm.disc(cx, cy, 0.55 * sx, 0.5)

    for zz, ax in ((L.Z_BAY_S, 'v'), (L.Z_BAY_C, 'h')):
        a0, b0, a1, b1 = zz.rect
        band(m, (a0, b0, a1, b1), shade(CHAMBER, 1.5), AO_DEEP, 140, 70)
        if ax == 'v':
            m.d.line([(a0 + 14, b0), (a0 + 14, b1)], fill=CYAN_DIM, width=8)
            m.e.line([(a0 + 14, b0), (a0 + 14, b1)], fill=CYAN_MID, width=5)
        else:
            m.d.line([(a0, b0 + 12), (a1, b0 + 12)], fill=CYAN_DIM, width=8)
            m.e.line([(a0, b0 + 12), (a1, b0 + 12)], fill=CYAN_MID, width=5)


# ═════════════════════════════════════════════════════ the MAIN vault door

DCX, DCY = 360.0, 1420.0
DPXM = 720.0 / 10.8
SEG = 8


def _pol(r, a, cx=DCX, cy=DCY, s=DPXM):
    return (cx + r * s * np.cos(a), cy - r * s * np.sin(a))


def paint_door(m, hm):
    z = L.Z_DOORF
    x0, y0, x1, y1 = z.rect
    band(m, (x0, y0, x1, y1), MONO_DKR, *ORM_MONO)
    R, RB, RH = L.DOOR_R, L.DOOR_RB, L.DOOR_RH

    def ell(r, **kw):
        m.d.ellipse([DCX - r * DPXM, DCY - r * DPXM,
                     DCX + r * DPXM, DCY + r * DPXM], **kw)

    def ell_e(r, **kw):
        m.e.ellipse([DCX - r * DPXM, DCY - r * DPXM,
                     DCX + r * DPXM, DCY + r * DPXM], **kw)

    def ell_o(r, **kw):
        m.o.ellipse([DCX - r * DPXM, DCY - r * DPXM,
                     DCX + r * DPXM, DCY + r * DPXM], **kw)

    # outer disc field — 8 tone-on-tone wedges (baker-safe low contrast)
    for k in range(SEG):
        a0 = 2 * np.pi * k / SEG + np.pi / SEG
        a1 = 2 * np.pi * (k + 1) / SEG + np.pi / SEG
        pts = [(DCX, DCY)] + [_pol(R, a0 + (a1 - a0) * t / 8)
                              for t in range(9)]
        m.d.polygon(pts, fill=jit(shade(MONO, 1.0 + 0.04 * ((k % 2) * 2 - 1)),
                                  2))
        m.o.polygon(pts, fill=ORM_MONO)
    ell(R, outline=MONO_DKR, width=9)

    # boss tier + hub tier as flat rings (the geometry steps them proud)
    ell(RB, fill=jit(shade(MONO, 1.06), 2))
    ell_o(RB, fill=(AO_BASE, 112, 40))
    ell(RH, fill=jit(shade(MONO, 0.86), 2))
    ell_o(RH, fill=(AO_BASE - 10, 104, 60))

    # 8 radial seam channels, hub -> rim, ACTIVE cyan
    for k in range(SEG):
        a = 2 * np.pi * k / SEG + np.pi / SEG
        pa, pb = _pol(RH + 0.12, a), _pol(R - 0.14, a)
        m.d.line([pa, pb], fill=CYAN_DIM, width=13)
        m.o.line([pa, pb], fill=ORM_SEAM, width=13)
        m.e.line([_pol(RH + 0.2, a), _pol(R - 0.22, a)], fill=CYAN, width=7)
        hm.line(pa, pb, -0.7, width=11)
    # concentric seam rings (tier edges + one mid ring)
    for rr, ew in ((R - 0.16, 7), (RB + 0.10, 8), (RH + 0.08, 6), (2.45, 5)):
        ell(rr, outline=CYAN_DIM, width=11)
        ell_o(rr, outline=ORM_SEAM, width=11)
        ell_e(rr, outline=CYAN, width=ew)
        segs = 64
        for s in range(segs):
            hm.line(_pol(rr, 2 * np.pi * s / segs),
                    _pol(rr, 2 * np.pi * (s + 1) / segs), -0.7, width=9)

    # 8 wedge glyph blocks on the boss ring (etched, dim)
    for k in range(SEG):
        a = 2 * np.pi * k / SEG
        for j, rr in enumerate((2.75, 3.05, 3.30)):
            half = 0.16 - 0.03 * j
            p0, p1 = _pol(rr, a - half), _pol(rr, a + half)
            m.d.line([p0, p1], fill=shade(MONO, 0.78), width=9)
            hm.line(p0, p1, -0.45, width=8)
        p0, p1 = _pol(1.75, a), _pol(2.35, a)
        m.d.line([p0, p1], fill=CYAN_DIM, width=7)
        m.e.line([p0, p1], fill=CYAN_MID, width=4)

    # hub rosette + core — the brightest cyan on the site
    for k in range(SEG):
        a = 2 * np.pi * k / SEG
        p0, p1 = _pol(0.52, a), _pol(1.20, a)
        m.d.line([p0, p1], fill=CYAN_DIM, width=10)
        m.e.line([p0, p1], fill=CYAN, width=6)
    ell(0.5, fill=CYAN_DIM)
    ell_e(0.42, fill=CYAN)
    ell_o(0.5, fill=(AO_BASE, 60, 210))
    hm.disc(DCX, DCY, 0.5 * DPXM, 0.6)

    # rim wraps: 8-period so the roll stays seamless
    for rect, glow, dif in ((L.R_RIM_D, CYAN, MONO_DK),
                            (L.R_RIM_B, CYAN_MID, shade(MONO, 0.94)),
                            (L.R_RIM_H, CYAN_MID, shade(MONO, 0.82))):
        a0, b0, a1, b1 = rect
        band(m, rect, dif, AO_BASE - 12, 110, 150)
        yy = (b0 + b1) // 2
        m.d.line([(a0 + 2, yy), (a1 - 2, yy)], fill=CYAN_DIM, width=6)
        m.e.line([(a0 + 2, yy), (a1 - 2, yy)], fill=glow, width=3)
        for k in range(SEG):
            sx = a0 + (a1 - a0) * (k + 0.5) / SEG
            m.d.line([(sx, b0 + 2), (sx, b1 - 2)], fill=MONO_DKR, width=5)


def paint_small_doors(m, hm):
    a0, b0, a1, b1 = L.SD_RECT
    cx, cy = (a0 + a1) / 2.0, (b0 + b1) / 2.0
    s = (a1 - a0) / (2.0 * L.SD_WIN_HW)      # px per metre
    band(m, (a0, b0, a1, b1), MONO_DK, *ORM_MONO)

    def ring(r, **kw):
        m.d.ellipse([cx - r * s, cy - r * s, cx + r * s, cy + r * s], **kw)

    def ring_e(r, **kw):
        m.e.ellipse([cx - r * s, cy - r * s, cx + r * s, cy + r * s], **kw)

    ring(L.SD_R + L.SD_COLLAR, fill=jit(PALE, 3))          # collar
    ring(L.SD_R, fill=jit(MONO, 2))                        # door face
    ring(L.SD_RH, fill=jit(shade(MONO, 0.84), 2))          # hub
    # collar joints — precise megalithic, 8-fold
    for k in range(SEG):
        a = 2 * np.pi * k / SEG + np.pi / SEG
        p0 = (cx + (L.SD_R + 0.02) * s * np.cos(a),
              cy - (L.SD_R + 0.02) * s * np.sin(a))
        p1 = (cx + (L.SD_R + L.SD_COLLAR) * s * np.cos(a),
              cy - (L.SD_R + L.SD_COLLAR) * s * np.sin(a))
        m.d.line([p0, p1], fill=shade(PALE, 0.82), width=6)
        hm.line(p0, p1, -0.5, width=5)
    # DORMANT: seams are cold, embers only
    for k in range(SEG):
        a = 2 * np.pi * k / SEG
        p0 = (cx + (L.SD_RH + 0.06) * s * np.cos(a),
              cy - (L.SD_RH + 0.06) * s * np.sin(a))
        p1 = (cx + (L.SD_R - 0.08) * s * np.cos(a),
              cy - (L.SD_R - 0.08) * s * np.sin(a))
        m.d.line([p0, p1], fill=CYAN_DIM, width=8)
        m.e.line([p0, p1], fill=shade(EMBER, 0.75), width=4)
        hm.line(p0, p1, -0.6, width=7)
    ring(L.SD_R - 0.05, outline=CYAN_DIM, width=7)
    ring_e(L.SD_R - 0.05, outline=shade(EMBER, 0.6), width=3)
    ring(0.22, fill=CYAN_DIM)
    ring_e(0.18, fill=EMBER)
    # dust wash over the lower half (both are half-buried / long shut)
    for i in range(9):
        t = i / 8.0
        col = tuple(int(a + (b - a) * (1 - t)) for a, b in zip(MONO, DUST))
        m.d.rectangle([a0, b1 - (b1 - b0) * 0.46 * t, a1, b1],
                      fill=jit(col, 4))
    x0, y0, x1, y1 = L.R_RIM_S
    band(m, L.R_RIM_S, shade(MONO, 0.8), AO_BASE - 14, 120, 140)
    m.d.line([(x0 + 2, (y0 + y1) // 2), (x1 - 2, (y0 + y1) // 2)],
             fill=CYAN_DIM, width=5)


# ═══════════════════════════════════════════ causeway / pylons / geology

def paint_deck(m, hm):
    z = L.Z_DECK
    x0, y0, x1, y1 = z.rect
    band(m, (x0, y0, x1, y1), MONO, *ORM_MONO)
    u, v = PL.zone_fns(z)
    # paving: huge slabs, tone-on-tone
    zs = np.linspace(-22.6, -3.9, 8)
    xs = (-9.7, -5.6, -1.0, 3.6, 7.7)
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            tone = 1.0 + 0.04 * (((i + j) % 3) - 1)
            m.d.rectangle([u(xs[i]), v(zs[j]), u(xs[i + 1]), v(zs[j + 1])],
                          fill=jit(shade(MONO, tone), 2))
    for sx in xs[1:-1]:
        m.d.line([(u(sx), y0), (u(sx), y1)], fill=MONO_DKR, width=6)
        hm.line((u(sx), y0), (u(sx), y1), -0.55, width=5)
    for sz in zs[1:-1]:
        m.d.line([(x0, v(sz)), (x1, v(sz))], fill=MONO_DKR, width=6)
        hm.line((x0, v(sz)), (x1, v(sz)), -0.55, width=5)
    # inlaid ACTIVE guide lines running the length of the approach
    for gx in (-3.6, 1.6):
        m.d.line([(u(gx), y0), (u(gx), y1)], fill=CYAN_DIM, width=11)
        m.o.line([(u(gx), y0), (u(gx), y1)], fill=ORM_SEAM, width=11)
        m.e.line([(u(gx), y0), (u(gx), y1)], fill=CYAN, width=6)
        hm.line((u(gx), y0), (u(gx), y1), -0.6, width=9)
    for sz in np.linspace(-21.4, -5.0, 9):
        m.d.line([(u(-3.6), v(sz)), (u(1.6), v(sz))], fill=CYAN_DIM, width=5)
        m.e.line([(u(-3.0), v(sz)), (u(1.0), v(sz))], fill=CYAN_MID, width=3)
    # dust drift creeping in from both edges
    for i in range(9):
        t = i / 8.0
        col = tuple(int(a + (b - a) * (1 - t)) for a, b in zip(MONO, DUST))
        m.d.rectangle([x0, y0, u(-9.7 + 1.9 * t), y1], fill=jit(col, 4))
        m.d.rectangle([u(7.7 - 1.9 * t), y0, x1, y1], fill=jit(col, 4))

    for zz in (L.Z_STEP, L.Z_STEP_S):
        a0, b0, a1, b1 = zz.rect
        band(m, (a0, b0, a1, b1), MONO_DK, *ORM_MONO)
        for k in range(9):
            sxx = a0 + (a1 - a0) * (k + 0.5) / 9
            m.d.line([(sxx, b0), (sxx, b1)], fill=MONO_DKR, width=5)
        for i in range(7):
            t = i / 6.0
            col = tuple(int(a + (b - a) * (1 - t))
                        for a, b in zip(MONO_DK, DUST))
            m.d.rectangle([a0, b1 - (b1 - b0) * 0.42 * t, a1, b1],
                          fill=jit(col, 4))


def paint_pylons(m, hm):
    for rect, vertical in ((L.PYL_FRECT, True), (L.Z_PYL_S.rect, True)):
        a0, b0, a1, b1 = rect
        band(m, rect, MONO, *ORM_MONO)
        # three clean recessed courses
        for f in (0.30, 0.52, 0.74):
            yy = b0 + (b1 - b0) * f
            m.d.line([(a0, yy), (a1, yy)], fill=MONO_DKR, width=7)
            hm.line((a0, yy), (a1, yy), -0.6, width=6)
        # full-height ACTIVE cyan channel
        cxx = (a0 + a1) / 2.0
        m.d.line([(cxx, b0 + 12), (cxx, b1 - 20)], fill=CYAN_DIM, width=13)
        m.o.line([(cxx, b0 + 12), (cxx, b1 - 20)], fill=ORM_SEAM, width=13)
        m.e.line([(cxx, b0 + 20), (cxx, b1 - 30)], fill=CYAN, width=7)
        hm.line((cxx, b0 + 12), (cxx, b1 - 20), -0.7, width=11)
        for f in (0.30, 0.52, 0.74):
            yy = b0 + (b1 - b0) * f
            m.d.ellipse([cxx - 15, yy - 15, cxx + 15, yy + 15], fill=CYAN_DIM)
            m.e.ellipse([cxx - 10, yy - 10, cxx + 10, yy + 10], fill=CYAN)
        # dust at the foot
        for i in range(8):
            t = i / 7.0
            col = tuple(int(c + (d - c) * (1 - t))
                        for c, d in zip(MONO, DUST))
            m.d.rectangle([a0, b1 - (b1 - b0) * 0.14 * t, a1, b1],
                          fill=jit(col, 4))


def paint_track(m):
    z = L.Z_TRACK
    x0, y0, x1, y1 = z.rect
    band(m, (x0, y0, x1, y1), MONO_DKR, AO_BASE - 16, 96, 190)
    yy = (y0 + y1) // 2
    m.d.line([(x0, yy), (x1, yy)], fill=CYAN_DIM, width=9)
    m.e.line([(x0, yy), (x1, yy)], fill=CYAN, width=5)
    for k in range(26):
        sx = x0 + (x1 - x0) * (k + 0.5) / 26
        m.d.line([(sx, y0 + 2), (sx, y1 - 2)], fill=shade(MONO_DKR, 0.72),
                 width=5)


def paint_geology(m):
    # collapsed overburden fan
    z = L.Z_RUBBLE
    x0, y0, x1, y1 = z.rect
    band(m, (x0, y0, x1, y1), EARTH_DK, *ORM_STONE)
    for _ in range(150):
        bx = x0 + RNG.random() * (x1 - x0 - 46)
        by = y0 + RNG.random() * (y1 - y0 - 26)
        c = jit(ROCKG, 9) if RNG.random() < 0.45 else jit(EARTH, 8)
        m.d.polygon([(bx, by + 10), (bx + 20 + RNG.random() * 30, by),
                     (bx + 40 + RNG.random() * 26, by + 13),
                     (bx + 15, by + 22)], fill=c)
    m.d.rectangle([x0, y1 - 34, x1, y1], fill=jit(EARTH, 5))

    # fallen ancient blocks: precise stone, chipped edges, no rust
    x0, y0, x1, y1 = L.ROCK_RECT
    band(m, L.ROCK_RECT, PALE, *ORM_STONE)
    for _ in range(46):
        bx = x0 + RNG.random() * (x1 - x0 - 60)
        by = y0 + RNG.random() * (y1 - y0 - 40)
        m.d.line([(bx, by), (bx + 20 + RNG.random() * 44,
                             by + 10 + RNG.random() * 26)],
                 fill=shade(PALE, 0.82), width=3)
    for f in (0.28, 0.60, 0.84):
        yy = y0 + (y1 - y0) * f
        m.d.rectangle([x0, yy - 7, x1, yy + 7], fill=shade(PALE, 0.86))
    for i in range(9):
        t = i / 8.0
        col = tuple(int(a + (b - a) * (1 - t)) for a, b in zip(PALE, DUST))
        m.d.rectangle([x0, y1 - (y1 - y0) * 0.4 * t, x1, y1], fill=jit(col, 4))

    # rear talus
    z = L.Z_TALUS
    x0, y0, x1, y1 = z.rect
    band(m, (x0, y0, x1, y1), ROCK_DK, *ORM_STONE)
    for _ in range(170):
        bx = x0 + RNG.random() * (x1 - x0 - 44)
        by = y0 + RNG.random() * (y1 - y0 - 26)
        c = jit(ROCKG, 10) if RNG.random() < 0.55 else jit(EARTH_DK, 8)
        m.d.polygon([(bx, by + 9), (bx + 18 + RNG.random() * 28, by),
                     (bx + 38 + RNG.random() * 24, by + 12),
                     (bx + 13, by + 20)], fill=c)
    m.d.rectangle([x0, y1 - 40, x1, y1], fill=jit(EARTH_DK, 5))


# ═══════════════════════════════════════════════════════════════ assemble

def paint_all():
    m = Maps()
    hm = NM.HeightMap()

    paint_wall_front(m, hm)
    paint_wall_sides(m)
    paint_wall_top(m)
    paint_bay(m, hm)
    paint_door(m, hm)
    paint_small_doors(m, hm)
    paint_deck(m, hm)
    paint_pylons(m, hm)
    paint_track(m)
    paint_geology(m)

    # ── weathering: geological only — dust, burial, scorch. No rust. ──
    from weathering import Weather
    wx = Weather(seed=90210 % 997)
    wx.crevice_grime(m.dif, 0.30)
    wf = L.Z_WALL_F.rect
    wx.mud_band((wf[0], int(wf[1] + (wf[3] - wf[1]) * 0.80), wf[2], wf[3]),
                0.55, fade='up', dust=0.55)
    wx.mud_band((wf[0], wf[1], int(wf[0] + (wf[2] - wf[0]) * 0.22), wf[3]),
                0.40, fade=None, dust=0.5)
    wx.soot_patch((int(wf[0] + (wf[2] - wf[0]) * 0.34), wf[1],
                   int(wf[0] + (wf[2] - wf[0]) * 0.62),
                   int(wf[1] + (wf[3] - wf[1]) * 0.42)), 0.35)
    wx.mud_band(L.Z_WALL_S.rect, 0.45, fade='down', dust=0.45)
    wx.mud_band(L.Z_WALL_T.rect, 0.35, fade=None, dust=0.35)
    wx.mud_band(L.Z_TALUS.rect, 0.45, fade=None, dust=0.35)
    wx.mud_band(L.Z_RUBBLE.rect, 0.60, fade=None, dust=0.5)
    wx.mud_band(L.ROCK_RECT, 0.45, fade='down', dust=0.4)
    dk = L.Z_DECK.rect
    wx.mud_band(dk, 0.30, fade=None, dust=0.45)
    wx.soot_patch((dk[0], int(dk[1] + (dk[3] - dk[1]) * 0.55), dk[2], dk[3]),
                  0.28)
    wx.mud_band(L.Z_STEP.rect, 0.45, fade='down', dust=0.4)
    wx.mud_band(L.Z_STEP_S.rect, 0.45, fade='down', dust=0.4)
    wx.mud_band(L.Z_TRACK.rect, 0.35, fade=None, dust=0.35)
    # only the buried lower arc of the main door takes a dust film
    dz = L.Z_DOORF.rect
    wx.mud_band((dz[0], int(dz[1] + (dz[3] - dz[1]) * 0.78), dz[2], dz[3]),
                0.35, fade='up', dust=0.35)
    sd = L.SD_RECT
    wx.mud_band((sd[0], int(sd[1] + (sd[3] - sd[1]) * 0.5), sd[2], sd[3]),
                0.55, fade='up', dust=0.5)

    PL.finish(m, L, STEM, hm=hm, wx=wx, outdir='out')


if __name__ == '__main__':
    paint_all()
