"""paint_ms_fighters_s4 — 2048^2 PBR set for ms_fighters_s4.

HERO of the fighter line: a dark low-vis command scheme in the family's
weathered gunmetal/olive, with a lighter dorsal-spine break running the
full length. Squadron crest + kill-tally row on the forward fuselage
flank, dense panel/access-hatch work on the spine and gun bay, heat-stain
gradients around all four nozzles with a soot fan aft, scorched blast
staining around the chin gun trough, anti-glare panel forward of the
tandem canopy, red-outlined rescue/eject markings at the canopy sill,
live-round bands on the dorsal AA rounds, and generous team-mask panels
on the wing upper shoulders, the spine and both fins.
"""
from __future__ import annotations
import numpy as np
from PIL import ImageFilter

import ms_fighters_s4_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

W = 2048
STEM = 'ms_fighters_s4'

# family palette: weathered gunmetal with an olive cast, one stop DARKER
# than the s2/s3 interceptors — this is the low-vis command airframe.
GUN      = (86, 90, 92)          # low-vis gunmetal (flanks, wing upper)
GUN_LT   = (104, 108, 108)       # dorsal spine break
GUN_DK   = (68, 72, 75)
BELLY    = (74, 78, 82)
OLIVE    = (86, 90, 70)          # olive disruptive patches
OLIVE_DK = (66, 70, 54)
RADOME   = (58, 60, 63)
DKST     = (44, 46, 50)          # dark structure / intake shadow
SOOT     = (36, 36, 38)
HEAT_A   = (128, 106, 88)        # nozzle heat stain (near)
HEAT_B   = (96, 82, 84)
HEAT_C   = (72, 68, 78)
RED      = (168, 48, 38)
REDBR    = (206, 62, 44)
WHITE_MK = (196, 200, 202)
GOLD     = (128, 110, 66)        # canopy tint
FORM     = (68, 146, 98)         # formation-light strip
NAV_R    = (200, 40, 30)
NAV_G    = (50, 190, 80)
LIVE_BR  = (176, 130, 44)        # live-round band (brown/yellow)

RNG = np.random.default_rng(90210)


def stencil(m, xy, text, size, color, bridge=True, angle=0):
    """paint.stencil with a portable font (toolkit paint.FONT is a Linux
    path and raises OSError on macOS — this is the workaround)."""
    from PIL import Image, ImageDraw
    f = PL.font(size)
    tmp = Image.new('L', (size * max(1, len(text)), int(size * 1.5)), 0)
    td = ImageDraw.Draw(tmp)
    td.text((2, 2), text, font=f, fill=255)
    if bridge:
        bb = tmp.getbbox()
        if bb:
            for fx in (0.32, 0.62):
                yy = bb[1] + (bb[3] - bb[1]) * fx
                td.line([(0, yy), (tmp.width, yy)], fill=0,
                        width=max(2, size // 14))
    if angle:
        tmp = tmp.rotate(angle, expand=True)
    m.dif.paste(Image.new('RGB', tmp.size, color),
                (int(xy[0]), int(xy[1])), tmp)


STATIONS = [z for (z, *_) in L.FUS_SECTIONS[1:-1]]


def flat(m, zone, col, rough=R_ARMOR, metal=M_ARMOR, ao=AO_BASE):
    fill(m, zone.rect if hasattr(zone, 'rect') else zone, dif=col, ao=ao,
         rough=rough, metal=metal)


# ── fuselage flanks ─────────────────────────────────────────────────────

def paint_side(m):
    z = L.F_SIDE
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    flat(m, z, GUN)

    # frame stations + stringers
    for wz in STATIONS:
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, GUN, hi=False)
    for wz in np.arange(-8.4, 8.4, 0.95):
        m.d.line([(u(wz), v(3.55)), (u(wz), v(1.15))], fill=shade(GUN, 0.93))
    for wy in (1.30, 2.05, 2.92):
        seam_h(m, int(u(-8.6)), int(u(8.4)), int(v(wy)), GUN, hi=False)

    # radome / nose tone break (dark low-vis nose)
    m.d.rectangle([x0, y0, u(-7.25), y1], fill=RADOME)
    m.d.line([(u(-7.25), y0 + 2), (u(-7.25), y1 - 2)], fill=shade(RADOME, 0.7),
             width=3)
    # belly shade below the chine
    m.d.rectangle([x0, v(1.95), x1, y1], fill=BELLY)
    # lighter dorsal spine break (the full-length weapons/avionics spine)
    m.d.rectangle([u(-4.65), v(3.70), u(7.35), v(2.78)], fill=GUN_LT)
    m.d.line([(u(-4.65), v(2.80)), (u(7.35), v(2.80))],
             fill=shade(GUN_LT, 0.72), width=3)
    # spine access-hatch density
    for i, wz in enumerate(np.arange(-4.2, 7.0, 0.86)):
        m.d.rectangle([u(wz), v(3.58), u(wz + 0.62), v(3.02)],
                      fill=jit(shade(GUN_LT, 0.96), 4),
                      outline=shade(GUN_LT, 0.76))
        if i % 3 == 0:
            bolts(m, [(u(wz + 0.08), v(3.52)), (u(wz + 0.54), v(3.08))],
                  base=GUN_LT)
    # olive disruptive patches (family cue)
    for (a, b, c, d) in ((-6.6, 2.55, -5.2, 2.05), (0.4, 2.30, 3.1, 1.75),
                         (4.8, 2.85, 6.6, 2.35)):
        m.d.polygon([(u(a), v(b)), (u(c), v(b - 0.10)), (u(c), v(d)),
                     (u(a), v(d + 0.14))], fill=OLIVE)

    # shoulder-intake mouth shadow + lip warning ring
    m.d.rectangle([u(-2.58), v(3.30), u(-2.40), v(2.60)], fill=jit(RED, 12))
    m.d.rectangle([u(-2.40), v(3.30), u(-2.05), v(2.60)], fill=DKST)
    m.d.rectangle([u(-1.48), v(3.22), u(-1.30), v(2.58)], fill=jit(RED, 12))
    m.d.rectangle([u(-1.30), v(3.22), u(-0.95), v(2.58)], fill=DKST)

    # gun bay: dense hatches + scorched blast staining round the trough
    m.d.rectangle([u(-7.10), v(1.92), u(-4.85), v(1.20)],
                  fill=shade(RADOME, 0.88), outline=shade(RADOME, 0.65))
    for wz in np.arange(-7.0, -4.9, 0.42):
        m.d.line([(u(wz), v(1.90)), (u(wz), v(1.24))], fill=shade(DKST, 1.15))
    for (rr, cc) in ((1.55, shade(SOOT, 1.9)), (1.05, shade(SOOT, 1.4)),
                     (0.62, SOOT)):
        m.d.ellipse([u(-7.55) - rr * 60, v(1.55) - rr * 46,
                     u(-6.10) + rr * 60, v(1.55) + rr * 46], fill=cc)
    m.d.ellipse([u(-7.62) - 10, v(1.48) - 10, u(-7.62) + 10, v(1.48) + 10],
                fill=(18, 18, 20))
    stencil(m, (u(-6.6), v(1.16)), 'DANGER  GUN GAS', 22, REDBR)

    # anti-glare panel forward of the canopy + canopy sill
    m.d.polygon([(u(-8.60), v(2.42)), (u(-7.10), v(2.62)),
                 (u(-7.10), v(2.20)), (u(-8.60), v(2.16))], fill=(30, 32, 34))
    m.d.rectangle([u(-7.30), v(2.86), u(-4.35), v(2.62)], fill=(32, 34, 36))
    # red-outlined rescue / eject markings at the sill
    for (za, zb) in ((-6.95, -6.15), (-5.65, -4.85)):
        m.d.rectangle([u(za), v(2.60), u(zb), v(2.36)], outline=REDBR, width=4)
        stencil(m, (u(za) + 8, v(2.56)), 'RESCUE', 20, REDBR)
        m.d.polygon([(u(zb) - 26, v(2.54)), (u(zb) - 6, v(2.46)),
                     (u(zb) - 26, v(2.38))], fill=REDBR)

    # squadron crest + kill tally row, forward fuselage flank
    cx, cy = u(-4.05), v(2.30)
    m.d.ellipse([cx - 44, cy - 44, cx + 44, cy + 44], fill=shade(GUN, 0.72),
                outline=WHITE_MK, width=3)
    PL.roundel_star(m, cx, cy, 26, WHITE_MK, ring=False)
    m.d.ellipse([cx - 44, cy - 44, cx + 44, cy + 44], outline=REDBR, width=2)
    stencil(m, (u(-4.55), v(1.98)), 'GS-04  IRONCROWN', 24, WHITE_MK)
    for i in range(11):                    # kill tally row
        kx = u(-3.55) + i * 17
        col = WHITE_MK if i < 8 else REDBR
        m.d.rectangle([kx, v(2.66), kx + 11, v(2.44)], fill=col)

    # formation-light strips (emissive) + national code
    for (za, zb) in ((-7.0, -6.0), (3.4, 5.6)):
        m.d.rectangle([u(za), v(2.14), u(zb), v(2.04)], fill=(38, 56, 46))
        m.e.rectangle([u(za) + 3, v(2.13), u(zb) - 3, v(2.05)], fill=FORM)
    stencil(m, (u(5.1), v(1.86)), 'MS-1140', 26, shade(WHITE_MK, 0.78))

    # heat wash + soot fan on the aft flank (four buried engines)
    for (za, col) in ((6.10, HEAT_C), (6.80, HEAT_B), (7.55, HEAT_A)):
        m.d.rectangle([u(za), v(2.62), u(8.45), v(1.62)], fill=col)
    m.d.rectangle([u(7.95), v(2.55), u(8.45), v(1.70)], fill=SOOT)
    wear_edges(m, (x0, y0, x1, int(v(1.10))), GUN, 55)


# ── upper surfaces (fuselage top, spine crown, wings, tail deck) ────────

def paint_top(m):
    z = L.F_TOP
    x0, y0, x1, y1 = z.rect
    u, vx = PL.zone_fns(z)
    flat(m, z, GUN)

    for wz in STATIONS:
        seam_v(m, int(u(wz)), int(vx(-8.2)), int(vx(8.2)), GUN, hi=False)
    # spanwise wing panel seams (they run straight across the wing/body blend)
    for wxs in (-6.6, -5.2, -3.8, -2.6, 2.6, 3.8, 5.2, 6.6):
        m.d.line([(u(-4.0), vx(wxs)), (u(6.6), vx(wxs))], fill=shade(GUN, 0.92),
                 width=2)
    # cranked-arrow leading edge drawn as a wear/erosion line, both sides
    for s in (1, -1):
        pts = [(u(zle), vx(s * sx)) for (sx, _y, zle, _t, _th) in L.WING]
        m.d.line(pts, fill=shade(GUN_DK, 0.85), width=5)
        m.d.line([(px, py + 4 * s) for (px, py) in pts],
                 fill=shade(GUN, 1.10), width=2)

    # nose radome break wraps over the top
    m.d.rectangle([x0, vx(-0.95), u(-7.25), vx(0.95)], fill=RADOME)
    # anti-glare panel, top half
    m.d.polygon([(u(-9.2), vx(-0.24)), (u(-7.15), vx(-0.62)),
                 (u(-7.15), vx(0.62)), (u(-9.2), vx(0.24))], fill=(30, 32, 34))

    # lighter dorsal spine crown + hatch/panel density
    m.d.rectangle([u(-4.70), vx(-0.99), u(7.30), vx(0.99)], fill=GUN_LT)
    for wz in np.arange(-4.3, 7.0, 0.72):
        m.d.line([(u(wz), vx(-0.95)), (u(wz), vx(0.95))],
                 fill=shade(GUN_LT, 0.78), width=2)
    for i, wz in enumerate(np.arange(-4.1, 6.6, 1.44)):
        m.d.rectangle([u(wz), vx(-0.72), u(wz + 0.98), vx(-0.10)],
                      fill=jit(shade(GUN_LT, 0.95), 4),
                      outline=shade(GUN_LT, 0.74))
        m.d.rectangle([u(wz + 0.14), vx(0.14), u(wz + 0.86), vx(0.70)],
                      fill=jit(shade(GUN_LT, 1.03), 4),
                      outline=shade(GUN_LT, 0.74))
        if i % 2 == 0:
            bolts(m, [(u(wz + 0.06), vx(-0.66)), (u(wz + 0.92), vx(-0.16))],
                  base=GUN_LT)
    # dorsal mount ring seat
    m.d.ellipse([u(0.16), vx(-1.02), u(2.04), vx(1.02)], fill=shade(GUN_LT, 0.80),
                outline=shade(GUN_LT, 0.62), width=3)
    stencil(m, (u(3.0), vx(-0.62)), 'NO STEP', 20, shade(WHITE_MK, 0.7))

    # olive disruptive blotches over the wing shoulders
    for s in (1, -1):
        m.d.polygon([(u(-1.6), vx(s * 1.5)), (u(1.4), vx(s * 2.2)),
                     (u(4.4), vx(s * 3.0)), (u(3.6), vx(s * 4.6)),
                     (u(0.2), vx(s * 3.4))], fill=OLIVE)
        m.d.polygon([(u(2.2), vx(s * 5.0)), (u(4.2), vx(s * 5.4)),
                     (u(3.4), vx(s * 6.8)), (u(2.4), vx(s * 6.4))],
                    fill=OLIVE_DK)

    # TEAM: generous panels on both wing upper shoulders + the spine
    for s in (1, -1):
        PL.team_panel(m, PL.nbox(u(1.2), vx(s * 2.95), u(3.4), vx(s * 4.60)),
                      outline=GUN_DK, width=4)
        PL.roundel_star(m, (u(1.2) + u(3.4)) / 2,
                        (vx(s * 2.95) + vx(s * 4.60)) / 2, 34, shade(GUN_DK, 0.7))
    PL.team_panel(m, PL.nbox(u(4.30), vx(-0.92), u(6.40), vx(0.92)),
                  outline=GUN_DK, width=3)

    # shoulder intake roofs / boundary-layer splitter shadow
    for s in (1, -1):
        for (cx_, _cy, cz_, sx_, _sy, sz_) in L.INTAKES:
            m.d.rectangle(PL.nbox(u(cz_ - sz_ / 2), vx(s * (cx_ - sx_ / 2)),
                                  u(cz_ - sz_ / 2 + 0.30),
                                  vx(s * (cx_ + sx_ / 2))), fill=DKST)
            m.d.rectangle(PL.nbox(u(cz_ - sz_ / 2 + 0.30),
                                  vx(s * (cx_ - sx_ / 2)),
                                  u(cz_ + sz_ / 2), vx(s * (cx_ + sx_ / 2))),
                          outline=shade(GUN, 0.72), width=2)

    # aft deck: heat stain around all four nozzles + soot fan
    for (za, col) in ((6.30, HEAT_C), (7.05, HEAT_B), (7.70, HEAT_A)):
        m.d.rectangle([u(za), vx(-2.10), u(8.70), vx(2.10)], fill=col)
    for s in (1, -1):
        for nx_ in L.NOZZLE_XS:
            m.d.rectangle(PL.nbox(u(7.55), vx(s * nx_ - 0.42), u(8.70),
                                  vx(s * nx_ + 0.42)), fill=SOOT)
    for i in range(90):                       # soot fan streaming aft
        zz = RNG.uniform(6.0, 8.7)
        xx = RNG.uniform(-2.4, 2.4)
        ln = RNG.uniform(0.2, 0.9)
        m.d.line([(u(zz), vx(xx)), (u(zz + ln), vx(xx))],
                 fill=shade(SOOT, RNG.uniform(1.2, 2.4)),
                 width=int(RNG.integers(2, 6)))
    # wing codes, spanwise
    stencil(m, (u(1.6), vx(-6.2)), 'GS-04', 34, shade(WHITE_MK, 0.72))
    stencil(m, (u(1.6), vx(5.6)), 'GS-04', 34, shade(WHITE_MK, 0.72))


def paint_bot(m):
    z = L.F_BOT
    x0, y0, x1, y1 = z.rect
    u, vx = PL.zone_fns(z)
    flat(m, z, BELLY, ao=AO_BASE - 6)
    m.d.rectangle([x0, vx(-0.95), u(-7.25), vx(0.95)], fill=RADOME)
    for wz in STATIONS:
        seam_v(m, int(u(wz)), int(vx(-8.2)), int(vx(8.2)), BELLY, hi=False)
    for wxs in (-5.0, -3.0, 3.0, 5.0):
        m.d.line([(u(-3.4), vx(wxs)), (u(6.4), vx(wxs))],
                 fill=shade(BELLY, 0.92), width=2)
    # weapons-bay / avionics access runs down the centreline
    for wz in np.arange(-3.6, 6.2, 1.15):
        m.d.rectangle([u(wz), vx(-1.20), u(wz + 0.80), vx(1.20)],
                      fill=jit(shade(BELLY, 0.95), 4), outline=shade(BELLY, 0.76))
    # gun trough scorch on the belly
    for (rr, cc) in ((1.0, shade(SOOT, 1.9)), (0.6, SOOT)):
        m.d.ellipse([u(-7.8), vx(-1.1 * rr), u(-5.0), vx(1.1 * rr)], fill=cc)
    # gear sponson bays + gear-bay oil staining
    for s in (1, -1):
        (gx, gy, gz), (sx, sy, sz) = L.SPONSON
        m.d.rectangle(PL.nbox(u(gz - sz / 2), vx(s * (gx - sx / 2)),
                              u(gz + sz / 2), vx(s * (gx + sx / 2))),
                      fill=shade(BELLY, 0.84), outline=shade(BELLY, 0.66),
                      width=3)
        for i in range(26):
            zz = RNG.uniform(gz - sz / 2, gz + sz / 2)
            m.d.line([(u(zz), vx(s * gx)), (u(zz), vx(s * gx) + 26)],
                     fill=shade((44, 38, 32), RNG.uniform(0.8, 1.5)), width=3)
    # nose-gear bay
    m.d.rectangle([u(-6.5), vx(-0.62), u(-4.7), vx(0.62)],
                  fill=shade(BELLY, 0.80), outline=shade(BELLY, 0.62), width=3)
    # heat / soot aft
    for (za, col) in ((6.6, HEAT_C), (7.4, HEAT_B)):
        m.d.rectangle([u(za), vx(-2.10), u(8.70), vx(2.10)], fill=col)
    m.d.rectangle([u(7.9), vx(-2.10), u(8.70), vx(2.10)], fill=SOOT)
    stencil(m, (u(2.0), vx(-4.4)), 'GS-04', 30, shade(WHITE_MK, 0.55))


# ── canopy, fins, cells ─────────────────────────────────────────────────

def paint_canopy(m):
    z = L.F_CANOPY
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    fill(m, z.rect, dif=GOLD, ao=AO_BASE, rough=R_GLASS, metal=M_GLASS)
    # frame: nose bow, the split between the two bows, and the sill
    m.d.rectangle([x0, y0, u(-7.02), y1], fill=GUN_DK)
    m.d.rectangle([u(-5.92), y0, u(-5.66), y1], fill=GUN_DK)   # centre bow
    m.d.rectangle([u(-4.62), y0, x1, y1], fill=GUN_DK)
    m.d.rectangle([x0, v(2.92), x1, y1], fill=GUN_DK)          # sill
    # glazing tint bands + reflection streaks
    for (za, zb) in ((-7.00, -5.94), (-5.64, -4.64)):
        m.d.rectangle([u(za), v(3.56), u(zb), v(2.94)], fill=GLASS)
        m.o.rectangle([u(za), v(3.56), u(zb), v(2.94)],
                      fill=(AO_BASE, R_GLASS, M_GLASS))
        m.d.polygon([(u(za) + 12, v(3.52)), (u(zb) - 10, v(3.34)),
                     (u(zb) - 10, v(3.20)), (u(za) + 12, v(3.36))],
                    fill=shade(GOLD, 1.35))
        m.d.line([(u(za) + 6, v(3.02)), (u(zb) - 6, v(3.02))],
                 fill=shade(GUN_DK, 1.4), width=3)
    # instrument glow inside each bow (functional light, warm)
    for zc in (-6.42, -5.16):
        m.e.rectangle([u(zc) - 26, v(3.06), u(zc) + 26, v(2.96)],
                      fill=(96, 70, 24))
    stencil(m, (u(-6.95), v(2.90)), 'EJECT', 18, REDBR)


def paint_fin(m):
    z = L.F_FIN
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    flat(m, z, GUN)
    for wz in np.arange(2.8, 6.5, 0.55):
        m.d.line([(u(wz), y0), (u(wz), y1)], fill=shade(GUN, 0.92), width=2)
    m.d.rectangle([x0, v(5.15), x1, v(4.55)], fill=GUN_LT)     # tip cap band
    PL.team_panel(m, PL.nbox(u(3.55), v(4.45), u(6.35), v(3.10)),
                  outline=GUN_DK, width=3)
    stencil(m, (u(4.45), v(2.95)), 'GS-04', 26, shade(WHITE_MK, 0.7))
    # rudder hinge line + static wick
    m.d.line([(u(6.10), y0), (u(6.10), v(2.40))], fill=shade(GUN, 0.66),
             width=4)
    m.d.rectangle([u(6.36), v(4.90), u(6.52), v(4.80)], fill=(30, 30, 32))
    wear_edges(m, (x0, y0, x1, y1), GUN, 30)


def paint_cells(m):
    # parametric nozzle wrap: petal seams + heat gradient (aft = u low)
    r = L.F_NOZZLE
    x0, y0, x1, y1 = r
    fill(m, r, dif=GUN_DK, ao=AO_BASE - 6, rough=R_STEEL, metal=M_STEEL + 40)
    for i, col in enumerate((SOOT, HEAT_A, HEAT_B, HEAT_C, GUN_DK)):
        xa = x0 + (x1 - x0) * i / 5.0
        m.d.rectangle([xa, y0, x0 + (x1 - x0) * (i + 1) / 5.0, y1], fill=col)
    for j in range(1, 12):                    # petal seams around
        yy = y0 + (y1 - y0) * j / 12.0
        m.d.line([(x0, yy), (x1, yy)], fill=shade(GUN_DK, 0.6), width=2)

    fill(m, L.F_BURNER.rect, dif=(26, 24, 26), ao=AO_DEEP, rough=R_STEEL,
         metal=M_STEEL)
    b = L.F_BURNER.rect
    m.e.rectangle([b[0] + 26, b[1] + 22, b[2] - 26, b[3] - 22], fill=(72, 30, 12))

    fill(m, L.F_MISSILE, dif=(122, 124, 118), ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)
    fill(m, L.F_TRIM.rect, dif=GUN_DK, ao=AO_SEAM, rough=R_ARMOR, metal=M_ARMOR + 30)
    fill(m, L.F_DARK.rect, dif=(22, 22, 24), ao=AO_DEEP, rough=R_STEEL, metal=M_STEEL)
    fill(m, L.F_GEAR.rect, dif=(126, 130, 132), ao=AO_BASE - 8, rough=R_STEEL,
         metal=M_STEEL + 40)
    fill(m, L.F_INTK.rect, dif=DKST, ao=AO_SEAM, rough=R_ARMOR, metal=M_ARMOR)
    fill(m, L.F_TAIL.rect, dif=shade(SOOT, 1.5), ao=AO_DEEP, rough=R_STEEL,
         metal=M_STEEL)
    for (zr, col) in ((L.F_NAVP, NAV_R), (L.F_NAVS, NAV_G)):
        fill(m, zr.rect, dif=shade(col, 0.35), ao=AO_BASE, rough=R_GLASS,
             metal=M_GLASS)
        q = zr.rect
        m.e.rectangle([q[0] + 20, q[1] + 16, q[2] - 20, q[3] - 16], fill=col)


# ── dorsal AA mount (piece-local zones) ─────────────────────────────────

def paint_mount(m):
    zt, zs = L.T_TOP, L.T_SIDE
    ut, vtx = PL.zone_fns(zt)
    us, vs = PL.zone_fns(zs)
    flat(m, zt, GUN_LT)
    flat(m, zs, GUN)

    # ring mount: turntable teeth + a hazard rotation band
    m.d.ellipse([ut(-0.88), vtx(-0.88), ut(0.88), vtx(0.88)],
                outline=shade(GUN_LT, 0.68), width=5)
    for a in np.linspace(0, 2 * np.pi, 24, endpoint=False):
        cx_, cy_ = (ut(0.0) + ut(0.0)) / 2, (vtx(0.0) + vtx(0.0)) / 2
        rr = abs(ut(0.80) - ut(0.0))
        m.d.line([(cx_ + rr * 0.86 * np.cos(a), cy_ + rr * 0.86 * np.sin(a)),
                  (cx_ + rr * np.cos(a), cy_ + rr * np.sin(a))],
                 fill=shade(GUN_LT, 0.6), width=3)
    PL.team_panel(m, PL.nbox(ut(-0.30), vtx(-0.62), ut(0.55), vtx(0.62)),
                  outline=GUN_DK, width=3)

    # rail-box flanks: elevation quadrant, hatches, warning stencil
    m.d.rectangle([us(-1.80), vs(0.26), us(0.52), vs(-0.22)],
                  fill=shade(GUN, 0.90), outline=shade(GUN, 0.70), width=2)
    for wz in np.arange(-1.70, 0.45, 0.32):
        m.d.line([(us(wz), vs(0.24)), (us(wz), vs(-0.20))],
                 fill=shade(GUN, 0.80), width=2)
    PL.hazard_band(m, PL.nbox(us(0.10), vs(0.44), us(0.60), vs(0.30)), step=11)
    stencil(m, (us(-1.70), vs(-0.28)), 'AA-S3', 20, REDBR)
    bolts(m, [(us(-1.5), vs(0.30)), (us(-0.8), vs(0.30)), (us(-0.1), vs(0.30))],
          base=GUN)

    # live-round bands on the dorsal AA rounds (parametric wrap)
    r = L.T_RAIL
    x0, y0, x1, y1 = r
    fill(m, r, dif=(120, 122, 116), ao=AO_BASE, rough=R_ARMOR, metal=M_ARMOR)
    m.d.rectangle([x0, y0, x0 + (x1 - x0) * 0.10, y1], fill=GUN_DK)   # tail
    for (a, b) in ((0.16, 0.22), (0.62, 0.70)):
        m.d.rectangle([x0 + (x1 - x0) * a, y0, x0 + (x1 - x0) * b, y1],
                      fill=LIVE_BR)
    m.d.rectangle([x0 + (x1 - x0) * 0.78, y0, x0 + (x1 - x0) * 0.88, y1],
                  fill=REDBR)
    m.d.rectangle([x0 + (x1 - x0) * 0.93, y0, x1, y1], fill=(58, 60, 64))
    for j in range(1, 6):
        yy = y0 + (y1 - y0) * j / 6.0
        m.d.line([(x0, yy), (x1, yy)], fill=shade((120, 122, 116), 0.78),
                 width=2)
    fill(m, L.T_DARK.rect, dif=(22, 22, 24), ao=AO_DEEP, rough=R_STEEL, metal=M_STEEL)
    fill(m, L.T_TRIM.rect, dif=GUN_DK, ao=AO_SEAM, rough=R_ARMOR, metal=M_ARMOR + 30)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    m = Maps()
    paint_side(m)
    paint_top(m)
    paint_bot(m)
    paint_canopy(m)
    paint_fin(m)
    paint_cells(m)
    paint_mount(m)

    u, _v = PL.zone_fns(L.F_BOT)
    _u2, vx = PL.zone_fns(L.F_BOT)
    ground = [(int(u(1.0)), int(vx(-2.6)), int(u(3.4)), int(vx(2.6))),
              L.F_GEAR.rect]
    wx = PL.standard_weather(m, L, ground_rects=ground,
                             side_zones=(L.F_SIDE,), seed=41, mud=0.30,
                             grime=0.55, rust_fraction=0.35)
    # exhaust soot aft + gun-gas soot forward
    us, vs = PL.zone_fns(L.F_SIDE)
    wx.soot_patch((int(us(6.2)), int(vs(2.8)), int(us(8.6)), int(vs(1.5))), 0.75)
    wx.soot_patch((int(us(-7.9)), int(vs(2.0)), int(us(-5.6)), int(vs(1.1))),
                  0.55)
    ut, vtop = PL.zone_fns(L.F_TOP)
    wx.soot_patch((int(ut(6.2)), int(vtop(-2.4)), int(ut(8.7)), int(vtop(2.4))),
                  0.70)
    wx.soot_patch(L.F_TAIL.rect, 0.85)
    wx.soot_patch(L.F_BURNER.rect, 0.9)

    from normals import HeightMap
    hm = HeightMap()
    for wz in STATIONS:                       # frame stations stand proud
        hm.line((us(wz), L.F_SIDE.rect[1]), (us(wz), L.F_SIDE.rect[3]),
                -0.6, width=3)
    for wz in np.arange(-4.1, 7.0, 0.72):     # spine hatch seams
        hm.line((ut(wz), vtop(-0.95)), (ut(wz), vtop(0.95)), -0.7, width=3)
    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
