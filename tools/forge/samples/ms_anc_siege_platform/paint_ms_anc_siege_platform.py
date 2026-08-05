"""paint_ms_anc_siege_platform — 2048² PBR set, ANCIENT register.

No rivets, no bolted patches, no rust streaks: the whole read is unbroken
pale monolith cut by clean recessed seams, with emissive CYAN reserved for
the ancient tracery — deck circles, ring charge glyphs, breech core, bore
embers, pylon slits, the free-floating halo arcs and the shell's charge
bands. Weathering is geological: soil burial climbing the plinth, dust
drift across the deck and ledges, muzzle scorch. The only team colour is
the capture panel recessed into the mid skirt (mask R channel only).
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_anc_siege_platform_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, wear_edges, shade,
                   CYAN, TEAMGREY, AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS, M_ARMOR, M_STEEL)

W = 2048

# ── ancient palette (pale monolith, no scavenger tones) ──────────────────
MONO      = (150, 157, 155)
MONO_LT   = (176, 182, 178)
MONO_MD   = (134, 141, 141)
MONO_DK   = (112, 119, 121)
MONO_DEEP = (78, 85, 89)          # recessed seam channel
GLYPH     = (118, 146, 154)       # desaturated blue-grey UNDER the cyan
GLYPH_DK  = (52, 74, 84)
BORE      = (20, 24, 28)
CYAN_DIM  = (34, 96, 116)
SOIL      = (96, 88, 74)

R_ANC, M_ANC = 178, 12            # ancient surface: matte, non-metallic


def anc_fill(m, rect, dif=MONO, ao=AO_BASE, rough=R_ANC, metal=M_ANC):
    fill(m, rect, dif=dif, ao=ao, rough=rough, metal=metal)


def recess(m, pts, col=MONO_DEEP, width=5, closed=False):
    """A clean recessed seam — the ONLY surface break the ancients used."""
    m.d.line(pts + ([pts[0]] if closed else []), fill=col, width=width,
             joint='curve')
    m.o.line(pts + ([pts[0]] if closed else []),
             fill=(AO_SEAM, R_ANC, M_ANC), width=width)


def tracery(m, pts, closed=False, width=5, glow=CYAN, dif=GLYPH):
    """Recessed seam with live cyan in it. Diffuse stays desaturated so the
    impostor baker's per-triangle flat shade never floods a facet cyan."""
    seq = pts + ([pts[0]] if closed else [])
    m.d.line(seq, fill=dif, width=width, joint='curve')
    m.o.line(seq, fill=(AO_SEAM, R_GLASS, M_ANC), width=width)
    m.e.line(seq, fill=glow, width=max(2, width - 2), joint='curve')


# ── platform ─────────────────────────────────────────────────────────────

def paint_deck(m):
    z = L.R_DECK
    x0, y0, x1, y1 = z.rect
    anc_fill(m, (x0, y0, x1, y1), dif=MONO)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    ppm = (x1 - x0) / (2 * L.DECK_HALF)      # atlas px per world metre

    def circ(r, fn, **kw):
        n = 96
        pts = [(cx + r * ppm * np.cos(2 * np.pi * i / n),
                cy + r * ppm * np.sin(2 * np.pi * i / n)) for i in range(n)]
        fn(m, pts, closed=True, **kw)

    # concentric recessed rings — radii chosen to miss the deck sectors'
    # triangle centroids (~8.4 m and ~9.6 m), see FORGE-GUIDE impostor note
    for r in (7.7, 9.0, 10.3):
        circ(r, recess, width=6)
    circ(7.45, tracery, width=7)             # live collar around the curb foot

    # 32 radial seams, every 4th one long (precision, not decoration)
    ph = np.pi / L.WELL_N
    for j in range(L.WELL_N):
        a = ph + 2 * np.pi * j / L.WELL_N
        r0, r1 = (7.35, 10.5) if j % 4 == 0 else (7.35, 9.2)
        recess(m, [(cx + r0 * ppm * np.cos(a), cy + r0 * ppm * np.sin(a)),
                   (cx + r1 * ppm * np.cos(a), cy + r1 * ppm * np.sin(a))],
               width=4)

    # four corner glyph plates (dormant embers, offset from the seams)
    for sx in (-1, 1):
        for sz in (-1, 1):
            gx, gy = cx + sx * 8.9 * ppm, cy + sz * 8.9 * ppm
            s = 0.72 * ppm
            m.d.rectangle([gx - s, gy - s, gx + s, gy + s], fill=MONO_MD)
            m.o.rectangle([gx - s, gy - s, gx + s, gy + s],
                          fill=(AO_SEAM, R_ANC, M_ANC))
            tracery(m, [(gx - s * 0.5, gy), (gx + s * 0.5, gy)], width=6,
                    glow=CYAN_DIM)
            tracery(m, [(gx, gy - s * 0.5), (gx, gy + s * 0.5)], width=6,
                    glow=CYAN_DIM)


def paint_steps(m):
    # cantilevered deck fascia: one deep seam + a live tracery line
    for z in (L.R_DECK_S, L.R_DECK_SF):
        x0, y0, x1, y1 = z.rect
        anc_fill(m, (x0, y0, x1, y1), dif=MONO_MD)
        u, v = PL.zone_fns(z)
        recess(m, [(x0, v(2.92)), (x1, v(2.92))], width=6)
        tracery(m, [(x0, v(2.52)), (x1, v(2.52))], width=7)
        for f in np.linspace(0.0, 1.0, 9)[1:-1]:
            recess(m, [(x0 + (x1 - x0) * f, y0 + 4),
                       (x0 + (x1 - x0) * f, y1 - 4)], width=4)
        wear_edges(m, z.rect, MONO_MD, density=14)

    # mid step: the capture band — team panel recessed between two seams
    for z, ax in ((L.R_MID_S, 'z'), (L.R_MID_SF, 'x')):
        x0, y0, x1, y1 = z.rect
        anc_fill(m, (x0, y0, x1, y1), dif=MONO)
        u, v = PL.zone_fns(z)
        recess(m, [(x0, v(2.02)), (x1, v(2.02))], width=5)
        recess(m, [(x0, v(1.28)), (x1, v(1.28))], width=5)
        # three capture panels per face: centre + two flanking
        for wc in (-5.6, 0.0, 5.6):
            box = PL.nbox(u(wc - 2.05), v(1.92), u(wc + 2.05), v(1.40))
            PL.team_panel(m, box, outline=MONO_DEEP, width=3)
            tracery(m, [(box[0] - 8, box[1] - 6), (box[2] + 8, box[1] - 6)],
                    width=5, glow=CYAN_DIM)
            tracery(m, [(box[0] - 8, box[3] + 6), (box[2] + 8, box[3] + 6)],
                    width=5, glow=CYAN_DIM)

    # buried plinth
    for z in (L.R_PLIN_S, L.R_PLIN_SF):
        x0, y0, x1, y1 = z.rect
        anc_fill(m, (x0, y0, x1, y1), dif=MONO_DK)
        u, v = PL.zone_fns(z)
        recess(m, [(x0, v(1.02)), (x1, v(1.02))], width=6)
        for f in np.linspace(0.0, 1.0, 13)[1:-1]:
            recess(m, [(x0 + (x1 - x0) * f, v(1.02)), (x0 + (x1 - x0) * f, y1)],
                   width=4)

    # exposed ledges (dust collects here)
    for z, col in ((L.R_MID_T, MONO_LT), (L.R_PLIN_T, MONO_MD)):
        x0, y0, x1, y1 = z.rect
        anc_fill(m, (x0, y0, x1, y1), dif=col)
        for f in (0.25, 0.5, 0.75):
            recess(m, [(x0, y0 + (y1 - y0) * f), (x1, y0 + (y1 - y0) * f)], width=4)
            recess(m, [(x0 + (x1 - x0) * f, y0), (x0 + (x1 - x0) * f, y1)], width=4)

    # R_MID_T is shared with the curb crown (annulus r 6.30-7.20): lay a live
    # tracery circle exactly down the middle of that band
    z = L.R_MID_T
    x0, y0, x1, y1 = z.rect
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    ppm = (x1 - x0) / 19.4
    for r, fn, kw in ((6.75, tracery, dict(width=6)),
                      (6.36, recess, dict(width=4)),
                      (7.14, recess, dict(width=4))):
        n = 96
        fn(m, [(cx + r * ppm * np.cos(2 * np.pi * i / n),
                cy + r * ppm * np.sin(2 * np.pi * i / n)) for i in range(n)],
           closed=True, **kw)

    fill(m, L.R_DARK.rect, dif=(46, 49, 52), ao=AO_DEEP, rough=R_ANC + 20,
         metal=M_ANC)


def paint_well(m):
    z = L.R_WELL_F
    x0, y0, x1, y1 = z.rect
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_DK, ao=AO_BASE - 26)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    ppm = (x1 - x0) / (2 * L.WELL_R)
    for r in (2.4, 4.6):
        n = 72
        pts = [(cx + r * ppm * np.cos(2 * np.pi * i / n),
                cy + r * ppm * np.sin(2 * np.pi * i / n)) for i in range(n)]
        tracery(m, pts, closed=True, width=6, glow=CYAN_DIM)
    for j in range(16):
        a = 2 * np.pi * j / 16
        recess(m, [(cx + 1.2 * ppm * np.cos(a), cy + 1.2 * ppm * np.sin(a)),
                   (cx + 6.0 * ppm * np.cos(a), cy + 6.0 * ppm * np.sin(a))],
               width=5)

    # well wall: vertical fluting, u around / v down
    x0, y0, x1, y1 = L.R_WELLW
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_MD, ao=AO_BASE - 18)
    for j in range(L.WELL_N):
        gx = x0 + (x1 - x0) * (j + 0.5) / L.WELL_N
        recess(m, [(gx, y0 + 3), (gx, y1 - 3)], width=5)
    tracery(m, [(x0, y1 - 12), (x1, y1 - 12)], width=6, glow=CYAN_DIM)


# ── ring mount (turret) ──────────────────────────────────────────────────

def paint_ring(m):
    # outer wall: the charge glyph band. Diffuse stays tone-on-tone; the
    # cyan lives in the emissive so the impostor bake cannot checker it.
    x0, y0, x1, y1 = L.R_RING_O
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_LT)
    h = y1 - y0
    recess(m, [(x0, y0 + h * 0.16), (x1, y0 + h * 0.16)], width=6)
    recess(m, [(x0, y1 - h * 0.16), (x1, y1 - h * 0.16)], width=6)
    # two live bands at mid-height (facet centroids sit at v≈1/3 and 2/3,
    # so a narrow centre band is never sampled — deliberate)
    tracery(m, [(x0, y0 + h * 0.46), (x1, y0 + h * 0.46)], width=7)
    tracery(m, [(x0, y0 + h * 0.56), (x1, y0 + h * 0.56)], width=7)
    # 32 charge glyphs, one per ring facet, straddling the live bands
    for j in range(L.RING_N):
        gx = x0 + (x1 - x0) * (j + 0.5) / L.RING_N
        cw = (x1 - x0) / L.RING_N * 0.30
        recess(m, [(gx, y0 + h * 0.22), (gx, y1 - h * 0.22)], width=5)
        bar = (h * 0.10) if j % 2 == 0 else (h * 0.06)
        tracery(m, [(gx - cw, y0 + h * 0.51 - bar), (gx - cw, y0 + h * 0.51 + bar)],
                width=6)
        tracery(m, [(gx + cw, y0 + h * 0.51 - bar), (gx + cw, y0 + h * 0.51 + bar)],
                width=6)

    # base flare + bored inner wall
    x0, y0, x1, y1 = L.R_RING_B
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_MD)
    for j in range(L.RING_N):
        recess(m, [(x0 + (x1 - x0) * (j + 0.5) / L.RING_N, y0 + 3),
                   (x0 + (x1 - x0) * (j + 0.5) / L.RING_N, y1 - 3)], width=4)

    x0, y0, x1, y1 = L.R_RING_I
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_DK, ao=AO_BASE - 30)
    tracery(m, [(x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)], width=7,
            glow=CYAN_DIM)

    # crown annulus: concentric seams + eight lens cells on the ring axis
    z = L.R_RING_T
    x0, y0, x1, y1 = z.rect
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_LT)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    ppm = (x1 - x0) / (2 * L.RING_OUT_R)
    for r in (4.35, 5.15):
        n = 72
        pts = [(cx + r * ppm * np.cos(2 * np.pi * i / n),
                cy + r * ppm * np.sin(2 * np.pi * i / n)) for i in range(n)]
        recess(m, pts, closed=True, width=6)
    for j in range(8):
        a = np.pi / 8 + 2 * np.pi * j / 8
        lx, ly = cx + 4.75 * ppm * np.cos(a), cy + 4.75 * ppm * np.sin(a)
        rr = 0.30 * ppm
        m.d.ellipse([lx - rr, ly - rr, lx + rr, ly + rr], fill=GLYPH,
                    outline=MONO_DEEP, width=4)
        m.o.ellipse([lx - rr, ly - rr, lx + rr, ly + rr],
                    fill=(AO_SEAM, R_GLASS, M_ANC))
        m.e.ellipse([lx - rr * 0.62, ly - rr * 0.62, lx + rr * 0.62,
                     ly + rr * 0.62], fill=CYAN)

    # trunnion cheeks + bosses
    for z in (L.R_CHEEK, L.R_CHEEK_F):
        x0, y0, x1, y1 = z.rect
        anc_fill(m, (x0, y0, x1, y1), dif=MONO)
        recess(m, [(x0 + 10, y0 + (y1 - y0) * 0.30),
                   (x1 - 10, y0 + (y1 - y0) * 0.30)], width=6)
        tracery(m, [(x0 + 10, y0 + (y1 - y0) * 0.52),
                    (x1 - 10, y0 + (y1 - y0) * 0.52)], width=7)
        wear_edges(m, z.rect, MONO, density=12)

    x0, y0, x1, y1 = L.R_BOSS
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_DK)
    tracery(m, [(x0 + (x1 - x0) * 0.5, y0 + 3), (x0 + (x1 - x0) * 0.5, y1 - 3)],
            width=8)


# ── barrel ───────────────────────────────────────────────────────────────

def paint_barrel(m):
    x0, y0, x1, y1 = L.R_TUBE
    anc_fill(m, (x0, y0, x1, y1), dif=MONO)
    zs = [s[0] for s in L.BORE_STATIONS]
    zmax, zmin = max(zs), min(zs)

    def ux(wz):
        return x0 + (x1 - x0) * (zmax - wz) / (zmax - zmin)

    # breech ring shoulder + reinforcement bands (constant-u = circumferential)
    for wz in (1.14, 0.20, 0.04):
        recess(m, [(ux(wz), y0), (ux(wz), y1)], width=7)
    # three live charge rings on the breech ring itself
    for wz in (0.95, 0.68, 0.41):
        tracery(m, [(ux(wz), y0), (ux(wz), y1)], width=9)
    for wz in (-1.2, -2.8, -4.3, -5.6):
        recess(m, [(ux(wz), y0), (ux(wz), y1)], width=6)
    # muzzle collar: dormant embers
    tracery(m, [(ux(-6.34), y0), (ux(-6.34), y1)], width=8, glow=CYAN_DIM)
    # tone-on-tone facet banding along the bore (v rows = tube facets)
    for j in range(0, L.BARREL_N, 2):
        yy = y0 + (y1 - y0) * (j + 0.5) / L.BARREL_N
        m.d.line([(ux(-0.05), yy), (ux(-6.24), yy)], fill=shade(MONO, 0.94),
                 width=3)

    # breech cap: sealed core
    z = L.R_BREECH
    x0, y0, x1, y1 = z.rect
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_MD)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    rr = (x1 - x0) * 0.30
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=GLYPH,
                outline=MONO_DEEP, width=5)
    m.o.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(AO_SEAM, R_GLASS, M_ANC))
    m.e.ellipse([cx - rr * 0.7, cy - rr * 0.7, cx + rr * 0.7, cy + rr * 0.7],
                fill=CYAN)

    # bore mouth: deep dark with a ring of embers down the rifling
    z = L.R_BORE
    x0, y0, x1, y1 = z.rect
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_DK)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    rr = (x1 - x0) * 0.36
    m.d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=BORE,
                outline=MONO_DEEP, width=6)
    m.o.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(AO_DEEP, R_ANC, M_ANC))
    m.e.ellipse([cx - rr * 0.78, cy - rr * 0.78, cx + rr * 0.78, cy + rr * 0.78],
                outline=CYAN_DIM, width=7)


# ── dressing: arms, shell, pylons, halo ──────────────────────────────────

def paint_dressing(m):
    # loading arms
    x0, y0, x1, y1 = L.R_ARM
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_MD)
    for f in (0.22, 0.5, 0.78):
        recess(m, [(x0, y0 + (y1 - y0) * f), (x1, y0 + (y1 - y0) * f)], width=5)
    tracery(m, [(x0 + 20, y0 + (y1 - y0) * 0.36),
                (x1 - 20, y0 + (y1 - y0) * 0.36)], width=6, glow=CYAN_DIM)

    # corner pylons: one live tracery slit up a face, dust at the foot
    x0, y0, x1, y1 = L.R_PYLON
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_LT)
    for f in (0.17, 0.5, 0.84):
        recess(m, [(x0, y0 + (y1 - y0) * f), (x1, y0 + (y1 - y0) * f)], width=5)
    tracery(m, [(x0 + 40, y0 + (y1 - y0) * 0.66),
                (x1 - 30, y0 + (y1 - y0) * 0.66)], width=7)

    # charge shell: banded ovoid, hot (it is loaded and live)
    x0, y0, x1, y1 = L.R_SHELL
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_LT)
    for f in (0.30, 0.44, 0.58, 0.72):
        tracery(m, [(x0 + (x1 - x0) * f, y0), (x0 + (x1 - x0) * f, y1)], width=9)
    for f in (0.20, 0.84):
        recess(m, [(x0 + (x1 - x0) * f, y0), (x0 + (x1 - x0) * f, y1)], width=6)

    z = L.R_SHELL_C
    x0, y0, x1, y1 = z.rect
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_MD)

    # floating halo arcs — v rows are bottom / outer / top / inner
    x0, y0, x1, y1 = L.R_HALO
    h = y1 - y0
    anc_fill(m, (x0, y0, x1, y1), dif=MONO_LT)
    fill(m, (x0, y0 + h * 0.25, x1, y0 + h * 0.50), dif=MONO, ao=AO_BASE,
         rough=R_ANC, metal=M_ANC)
    fill(m, (x0, y0 + h * 0.75, x1, y1), dif=MONO_MD, ao=AO_BASE - 14,
         rough=R_ANC, metal=M_ANC)
    tracery(m, [(x0, y0 + h * 0.875), (x1, y0 + h * 0.875)], width=10)  # inner
    tracery(m, [(x0, y0 + h * 0.375), (x1, y0 + h * 0.375)], width=6,
            glow=CYAN_DIM)                                              # outer
    for j in range(1, L.HALO_SEG):
        gx = x0 + (x1 - x0) * j / L.HALO_SEG
        recess(m, [(gx, y0 + 2), (gx, y1 - 2)], width=4)


# ── assemble ─────────────────────────────────────────────────────────────

def paint_all():
    P.BOLT_LOG.clear()          # ancient tech has no bolts — keep it empty
    m = Maps()
    paint_deck(m)
    paint_steps(m)
    paint_well(m)
    paint_ring(m)
    paint_barrel(m)
    paint_dressing(m)

    from weathering import Weather
    wx = Weather(seed=90210 % 1000)
    wx.crevice_grime(m.dif, 0.42)
    # geological burial: soil climbing the plinth and pooling on the ledges
    wx.mud_band(L.R_PLIN_S.rect, 0.82, fade='down', spatter=True)
    wx.mud_band(L.R_PLIN_SF.rect, 0.82, fade='down', spatter=True)
    wx.mud_band(L.R_PLIN_T.rect, 0.55, fade=None, spatter=True)
    wx.mud_band(L.R_MID_S.rect, 0.30, fade='down', dust=0.34)
    wx.mud_band(L.R_MID_SF.rect, 0.30, fade='down', dust=0.34)
    wx.mud_band(L.R_MID_T.rect, 0.34, fade=None, spatter=True)
    # dust drift across the deck and down the fascia
    wx.mud_band(L.R_DECK.rect, 0.26, fade=None, spatter=False, dust=0.42)
    wx.mud_band(L.R_DECK_S.rect, 0.14, fade='down', dust=0.30)
    wx.mud_band(L.R_DECK_SF.rect, 0.14, fade='down', dust=0.30)
    wx.mud_band(L.R_WELL_F.rect, 0.30, fade=None, spatter=True)
    wx.mud_band(L.R_PYLON, 0.26, fade='left', dust=0.24)
    wx.mud_band(L.R_ARM, 0.20, fade='left', dust=0.22)
    # scorch: the muzzle end of the bore, the mouth cap, and the deck arc
    # the blast sweeps over
    wx.soot_patch(L.R_TUBE, 0.62, fade='right')
    wx.soot_patch(L.R_BORE.rect, 0.55)
    wx.soot_patch((L.R_RING_O[0], L.R_RING_O[1], L.R_RING_O[2],
                   L.R_RING_O[1] + 26), 0.30)
    wx.apply(m)

    from normals import HeightMap
    hm = HeightMap()
    # the recessed seams are the only relief on an ancient surface
    hm.crevices_from(m.dif, 0.62)
    hm.weather_from(wx)
    hm.to_normal_image(strength=3.4).save('out/ms_anc_siege_platform_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(1.1))
    m.dif.save('out/ms_anc_siege_platform_diffuse.png')
    m.orm.save('out/ms_anc_siege_platform_orm.png')
    m.emi.save('out/ms_anc_siege_platform_emissive.png')
    m.tea.save('out/ms_anc_siege_platform_team.png')
    print('[paint_ms_anc_siege_platform] 2048 texture set written to out/')


if __name__ == '__main__':
    paint_all()
