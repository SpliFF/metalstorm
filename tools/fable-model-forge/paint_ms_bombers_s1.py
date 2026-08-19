"""paint_ms_bombers_s1 — 1024² PBR set for the s1 strike drone (UB-12).

Strike-line identity per §26: an angular SPLINTER CAMO in a second grey
across every topside (mirror-drawn, since F_TOP is world-projected and
single-sampled) with wedges reaching down the shared flank band — cheap
role identity at zero geometry cost, and what separates the bomber line
from the fighters' clean air-superiority scheme.

Eight of these fly in one squad, so team colour is carried by SMALL
marks only (nose chevron, ruddervator tip flash, tiny wing shoulder
plate) — the impostor baker floods large pale panels — and the visual
accent is amber emissive formation strips instead.  Other cues: dark
radome break wrapped through all three bands, faceted sensor blisters
where a canopy would be, belly bay doors with a red ARM outline, UB-12
drone serial, nozzle heat tint over the tail booms.
"""
from __future__ import annotations
import numpy as np

import ms_bombers_s1_layout as L        # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, shade, jit,
                   stencil, BOLT_LOG, BLACKISH, TEAMGREY, STEEL, STEEL_DK,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_GLASS)

STEM = 'ms_bombers_s1'
W = 1024

# ── palette: strike-grey two-tone (splinter), all tones within ±20% ──
TOPC     = (96, 101, 104)        # upper-surface strike grey
TOPC_LT  = (107, 112, 115)
TOPC_DK  = (80, 85, 89)
SPLINT   = (72, 78, 84)          # the SECOND grey — splinter polygons
SIDEC    = (92, 96, 100)         # chined flank
BOTC     = (108, 112, 116)       # pale grey underside
BOTC_DK  = (94, 98, 102)
GUNMET   = (74, 78, 78)
GUNMET_D = (56, 59, 60)
RADOME   = (78, 74, 78)
EO_GLASS = (28, 32, 36)
AMBER    = (236, 162, 56)
REDL     = (198, 62, 46)

# fuselage stations that get a wrapped panel seam in every band
STATIONS = (-3.00, -2.20, -1.10, 0.30, 1.50, 2.20)

# splinter polygons, authored on the +x half as (z, x) pairs; each is
# drawn once per side with x mirrored (polygons are order-independent, so
# the ±s mirror is safe here — only RECTANGLES need sorted() corners).
SPLINTER = (
    ((-3.30, 0.10), (-2.55, 0.95), (-2.05, 0.35), (-2.70, 0.05)),
    ((-1.95, 0.55), (-0.85, 2.35), (0.05, 1.55), (-1.15, 0.45)),
    ((0.25, 2.15), (1.15, 3.95), (1.30, 2.85), (0.60, 1.65)),
    ((1.70, 0.35), (3.05, 1.30), (3.30, 2.35), (2.05, 1.15)),
)


def wr(u, v, a0, b0, a1, b1):
    """World rect → normalised (sorted) px box."""
    return PL.nbox(u(a0), v(b0), u(a1), v(b1))


# ─────────────────────────────────────────────────────── upper surfaces
def paint_top(m):
    z = L.F_TOP
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=TOPC, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    # splinter camo — the strike-line tell (drawn on BOTH halves)
    for s in (1, -1):
        for poly in SPLINTER:
            m.d.polygon([(u(pz), v(s * px)) for (pz, px) in poly],
                        fill=jit(SPLINT, 3))

    # spine band a hair lighter so the blended body reads from above
    m.d.rectangle(wr(u, v, -3.10, -0.30, 2.70, 0.30), fill=TOPC_LT)
    # nose radome tone break (matched in F_SIDE / F_BOT — §26 note (a))
    m.d.rectangle(wr(u, v, -3.72, -0.42, -3.02, 0.42), fill=RADOME)

    # spanwise panel seams (constant z) — continuous across the wing root
    for wz in STATIONS:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, TOPC)
    # chordwise seams (constant x): wing-root joint + mid-span ribs
    for wx in (-3.15, -2.30, -1.40, -0.50, 0.50, 1.40, 2.30, 3.15):
        seam_h(m, int(u(-1.35)), int(u(1.60)), int(v(wx)), TOPC)

    # dorsal intake mouth + duct roof on the spine
    m.d.rectangle(wr(u, v, -0.94, -0.32, -0.58, 0.32), fill=GUNMET_D)
    m.o.rectangle(wr(u, v, -0.94, -0.32, -0.58, 0.32),
                  fill=(AO_DEEP, R_STEEL, M_STEEL))
    m.d.rectangle(wr(u, v, -0.58, -0.32, 1.32, 0.32), fill=TOPC_DK)
    for wz in (-0.10, 0.45, 1.00):
        m.d.line([(u(wz), v(-0.30)), (u(wz), v(0.30))],
                 fill=shade(TOPC_DK, 0.86), width=2)
    # intake lip warning stripe
    m.d.rectangle(wr(u, v, -1.00, -0.32, -0.94, 0.32), fill=jit(REDL, 10))

    # dorsal sensor-blister deck ring (where a canopy would be — it is NOT)
    m.d.rectangle(wr(u, v, -3.24, -0.26, -1.88, 0.26),
                  outline=shade(TOPC, 0.82), width=2)

    # SMALL team chevron on the nose deck (keep pale team area tiny)
    chev = [(u(-3.34), v(-0.30)), (u(-3.02), v(0.0)), (u(-3.34), v(0.30)),
            (u(-3.18), v(0.30)), (u(-2.86), v(0.0)), (u(-3.18), v(-0.30))]
    m.t.polygon(chev, fill=(255, 0, 0))
    m.d.polygon(chev, fill=TEAMGREY)

    for s in (1, -1):
        # leading-edge wear line along the ~20° swept LE
        m.d.line([(u(-1.30), v(s * 0.50)), (u(-0.02), v(s * 4.00))],
                 fill=(150, 154, 158), width=2)
        # trailing-edge elevon hinge
        m.d.line([(u(1.30), v(s * 0.60)), (u(1.12), v(s * 3.95))],
                 fill=shade(TOPC, 0.74), width=2)
        # wing-root walkway
        m.d.line([(u(-1.05), v(s * 0.56)), (u(1.45), v(s * 0.56))],
                 fill=jit((162, 150, 96), 8), width=2)

        # matte low-vis roundel (world-circular ⇒ elliptical in atlas)
        r = 0.34
        cu, cv = u(0.05), v(s * 2.05)
        ru, rv = abs(u(r) - u(0.0)), abs(v(r) - v(0.0))
        for f, col in ((1.0, shade(TOPC, 0.78)), (0.60, TOPC_LT)):
            m.d.ellipse([cu - ru * f, cv - rv * f, cu + ru * f, cv + rv * f],
                        outline=col, width=2)
        m.d.ellipse([cu - ru * 0.30, cv - rv * 0.30,
                     cu + ru * 0.30, cv + rv * 0.30], fill=shade(TOPC, 0.78))

        # drone serial, spanwise on the outer wing (rotate(-90) reads nose-up)
        stencil(m, (u(0.55) - 11, v(s * 3.35) - 34), L.SERIAL, 17,
                shade(TOPC, 0.72), angle=-90)

        # ── V-TAIL ruddervator: the signature surface ──
        # boom top deck
        bv0, bv1 = sorted((v(s * 0.60), v(s * 1.00)))
        m.d.rectangle([u(1.10), bv0, u(3.42), bv1], fill=TOPC_DK)
        m.d.line([(u(2.00), bv0 + 2), (u(2.00), bv1 - 2)],
                 fill=shade(TOPC_DK, 0.84), width=2)
        # ruddervator LE highlight + hinge line
        m.d.line([(u(1.78), v(s * 0.80)), (u(2.36), v(s * 2.22))],
                 fill=(150, 154, 158), width=2)
        m.d.line([(u(3.05), v(s * 0.80)), (u(3.02), v(s * 2.22))],
                 fill=shade(TOPC, 0.72), width=2)
        # SMALL team flash at the ruddervator tip
        tv0, tv1 = sorted((v(s * 2.02), v(s * 2.22)))
        m.t.rectangle([u(2.45), tv0, u(3.20), tv1], fill=(255, 0, 0))
        m.d.rectangle([u(2.45), tv0, u(3.20), tv1], fill=TEAMGREY)
        # amber emissive formation strip on the ruddervator outer panel
        tz0, tz1, tx0, tx1 = L.TAIL_LIGHT
        strip = PL.nbox(u(tz0), v(s * tx0), u(tz1), v(s * tx1))
        m.d.rectangle(strip, fill=shade(TOPC, 0.62))
        m.e.rectangle([strip[0] + 1, strip[1] + 1, strip[2] - 1, strip[3] - 1],
                      fill=AMBER)
        m.o.rectangle(strip, fill=(AO_BASE, R_GLASS, M_GLASS))

        # access hatches + fasteners on the shoulder
        for wz in (-2.10, -1.40):
            m.d.rectangle(wr(u, v, wz, s * 0.62, wz + 0.42, s * 0.94),
                          outline=shade(TOPC, 0.84), width=2)
        bolts(m, [(u(-2.30 + i * 0.28), v(s * 0.52)) for i in range(4)],
              r=2, base=TOPC)
        # squared-tip band
        m.d.line([(u(-0.02), v(s * 3.90)), (u(1.30), v(s * 3.90))],
                 fill=shade(TOPC, 0.86), width=2)

    wear_edges(m, (x0, y0, x1, y1), TOPC, 32)


# ─────────────────────────────────────────────────────── flanks
def paint_side(m):
    z = L.F_SIDE
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=SIDEC, ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)

    # splinter wedges reaching DOWN from the topside into the flank band
    for (za, zb, ylo) in ((-3.00, -1.90, 0.98), (-0.60, 0.90, 0.92),
                          (1.80, 3.10, 1.02)):
        m.d.polygon([(u(za), y0), (u(zb), y0), (u((za + zb) / 2), v(ylo))],
                    fill=SPLINT)

    # below the chine is the pale underside tone
    m.d.rectangle(PL.nbox(x0, v(1.02), x1, y1), fill=BOTC_DK)
    m.d.line([(x0, v(1.02)), (x1, v(1.02))], fill=shade(SIDEC, 0.84), width=2)
    # nose radome break (same station as F_TOP / F_BOT)
    m.d.rectangle(PL.nbox(x0, y0, u(-3.02), v(1.02)), fill=RADOME)

    for wz in STATIONS:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, SIDEC)
    seam_h(m, x0 + 2, x1 - 2, int(v(1.26)), SIDEC)

    # ── belly bay bulge: the class tell in side silhouette ──
    bx, by, bz, bw, bh, bd = L.BAY
    bay = PL.nbox(u(bz - bd / 2), v(by + bh / 2), u(bz + bd / 2),
                  v(by - bh / 2))
    m.d.rectangle(bay, fill=shade(BOTC_DK, 0.92), outline=jit(REDL, 14),
                  width=2)
    m.o.rectangle(bay, fill=(AO_SEAM, R_ARMOR, M_ARMOR))
    for wz in (bz - 0.65, bz + 0.65):
        m.d.line([(u(wz), bay[1] + 3), (u(wz), bay[3] - 3)],
                 fill=shade(BOTC_DK, 0.76), width=2)
    stencil(m, (u(bz - 0.55), v(by + 0.02)), 'ARM', 11, jit(REDL, 8))

    # avionics bay hatch
    m.d.rectangle(PL.nbox(u(-2.05), v(1.28), u(-1.30), v(1.06)),
                  outline=shade(SIDEC, 0.84), width=2)
    bolts(m, [(u(-1.95 + i * 0.20), v(1.22)) for i in range(4)], r=2,
          base=SIDEC)

    # amber formation strips on the flank (the squad accent)
    for (wz0, wz1) in ((-2.80, -2.20), (1.10, 1.80)):
        st = PL.nbox(u(wz0), v(1.20), u(wz1), v(1.12))
        m.d.rectangle(st, fill=(40, 42, 44))
        m.e.rectangle([st[0] + 1, st[1] + 1, st[2] - 1, st[3] - 1], fill=AMBER)
        m.o.rectangle(st, fill=(AO_BASE, R_GLASS, M_GLASS))

    # boom flank + nozzle collar shadow
    m.d.rectangle(PL.nbox(u(2.15), v(1.44), u(3.45), v(1.02)),
                  fill=shade(SIDEC, 0.90))
    m.d.rectangle(PL.nbox(u(2.05), y0, u(2.20), v(1.02)),
                  fill=shade(SIDEC, 0.86))
    wear_edges(m, (x0, y0, x1, y1), SIDEC, 28)


# ─────────────────────────────────────────────────────── underside
def paint_bot(m):
    z = L.F_BOT
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=BOTC, ao=AO_BASE - 6, rough=R_ARMOR + 8,
         metal=M_ARMOR - 20)
    m.d.rectangle(wr(u, v, -3.72, -0.42, -3.02, 0.42), fill=shade(RADOME, 0.9))
    for wz in STATIONS:
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, BOTC)
    for wx in (-2.30, -1.40, 1.40, 2.30):
        seam_h(m, int(u(-1.30)), int(u(1.55)), int(v(wx)), BOTC)

    # gear doors (nose + wide-track mains)
    for (z0, z1, wx0, wx1) in ((-2.20, -1.50, -0.22, 0.22),
                               (0.55, 1.35, 0.70, 1.40),
                               (0.55, 1.35, -1.40, -0.70)):
        m.d.rectangle(wr(u, v, z0, wx0, z1, wx1),
                      fill=shade(BOTC, 0.94), outline=jit(REDL, 20), width=2)
    # under-wing low-vis roundels
    for s in (1, -1):
        r = 0.34
        cu, cv = u(0.15), v(s * 2.60)
        ru, rv = abs(u(r) - u(0.0)), abs(v(r) - v(0.0))
        m.d.ellipse([cu - ru, cv - rv, cu + ru, cv + rv],
                    outline=shade(BOTC, 0.78), width=2)
    wear_edges(m, (x0, y0, x1, y1), BOTC, 24)


# ─────────────────────────────────────────────────────── bay + small cells
def paint_bay(m):
    """Belly weapons-bay underside: painted doors + red ARM outline, with
    the slot-1 `muzzle` release empty at the centre of this face."""
    z = L.F_BAY
    u, v = PL.zone_fns(z)
    x0, y0, x1, y1 = z.rect
    fill(m, z.rect, dif=shade(BOTC, 0.92), ao=AO_SEAM, rough=R_ARMOR,
         metal=M_ARMOR)
    door = PL.nbox(u(-0.83), v(-0.48), u(1.53), v(0.48))
    m.d.rectangle(door, outline=jit(REDL, 12), width=3)
    # centre split line between the two doors
    m.d.line([(door[0] + 3, v(0.0)), (door[2] - 3, v(0.0))],
             fill=shade(BOTC, 0.66), width=2)
    # hinge seams
    for wz in (-0.10, 0.60, 1.15):
        m.d.line([(u(wz), door[1] + 3), (u(wz), door[3] - 3)],
                 fill=shade(BOTC, 0.78), width=2)
    m.o.rectangle(door, fill=(AO_DEEP, R_ARMOR, M_ARMOR))
    stencil(m, (u(-0.62), v(-0.34)), 'ARM', 12, jit(REDL, 8))
    bolts(m, [(u(-0.70 + i * 0.36), v(0.40)) for i in range(6)], r=2,
          base=BOTC)


def paint_cells(m):
    # generic gunmetal trim (wing/tail edges, blade antenna, body caps)
    fill(m, L.F_TRIM.rect, dif=GUNMET, ao=AO_BASE - 12, rough=R_STEEL,
         metal=M_STEEL)
    tx0, ty0, tx1, ty1 = L.F_TRIM.rect
    for i in range(5):
        m.d.line([(tx0, ty0 + 12 + i * 18), (tx1, ty0 + 12 + i * 18)],
                 fill=shade(GUNMET, 0.90), width=2)

    # dark cell: intake throat, boom mouths, wheel treads
    fill(m, L.F_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=R_RUBBER, metal=40)

    # gear: steel struts + hubs
    fill(m, L.F_GEAR.rect, dif=STEEL, ao=AO_SEAM, rough=R_STEEL, metal=M_STEEL)
    gx0, gy0, gx1, gy1 = L.F_GEAR.rect
    m.d.ellipse([gx0 + 34, gy0 + 30, gx1 - 34, gy1 - 30], fill=STEEL_DK)
    bolts(m, [(gx0 + 46 + i * 12, (gy0 + gy1) // 2) for i in range(3)], r=2,
          base=STEEL_DK)

    # nozzle wrap: ringed heat-stained metal
    nx0, ny0, nx1, ny1 = L.F_NOZZLE
    fill(m, L.F_NOZZLE, dif=GUNMET_D, ao=AO_BASE - 24, rough=R_STEEL - 20,
         metal=M_STEEL)
    for i in range(7):
        rx = nx0 + (nx1 - nx0) * (i + 0.5) / 7
        m.d.line([(rx, ny0), (rx, ny1)], fill=shade(GUNMET_D, 1.18), width=3)
    m.d.rectangle([nx0, ny0, nx0 + (nx1 - nx0) * 0.24, ny1],
                  fill=shade(GUNMET_D, 0.76))

    # burner cap: sooted throat with a faint amber core
    bx0, by0, bx1, by1 = L.F_BURNER.rect
    fill(m, L.F_BURNER.rect, dif=(34, 32, 31), ao=AO_DEEP, rough=200, metal=60)
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    m.d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=(20, 19, 19))
    m.e.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=shade(AMBER, 0.40))

    # ── faceted sensor blisters (NO canopy glass anywhere on this model) ──
    z = L.F_BLIST
    u, v = PL.zone_fns(z)
    fill(m, z.rect, dif=shade(TOPC, 0.94), ao=AO_BASE, rough=R_ARMOR,
         metal=M_ARMOR)
    bx0, by0, bx1, by1 = z.rect
    # dorsal member: faceted fairing + a slim dark aperture band
    win = PL.nbox(u(-3.00), v(1.42), u(-2.10), v(1.26))
    m.d.rectangle(win, fill=EO_GLASS, outline=GUNMET_D, width=2)
    m.o.rectangle(win, fill=(AO_SEAM, R_GLASS, M_GLASS))
    m.d.line([(bx0, v(1.20)), (bx1, v(1.20))], fill=shade(TOPC, 0.84), width=2)
    bolts(m, [(u(-3.02 + i * 0.26), v(1.50)) for i in range(4)], r=2,
          base=TOPC)
    # chin member: EO window
    win2 = PL.nbox(u(-3.00), v(0.90), u(-2.14), v(0.72))
    m.d.rectangle(win2, fill=EO_GLASS, outline=GUNMET_D, width=2)
    m.o.rectangle(win2, fill=(AO_SEAM, R_GLASS, M_GLASS))
    m.d.line([(bx0, v(0.96)), (bx1, v(0.96))], fill=shade(TOPC, 0.86),
             width=2)


# ─────────────────────────────────────────────────────── assembly
def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_top(m)
    paint_side(m)
    paint_bot(m)
    paint_bay(m)
    paint_cells(m)

    # ── weathering: thin deck dust, exhaust soot over the booms, bay grime ──
    wx = PL.standard_weather(m, L, ground_rects=(L.F_GEAR.rect,),
                             side_zones=(L.F_SIDE,), seed=57,
                             mud=0.26, grime=0.45, rust_fraction=0.35)
    u, v = PL.zone_fns(L.F_TOP)
    ub, vb = PL.zone_fns(L.F_BOT)
    us, vs = PL.zone_fns(L.F_SIDE)
    # nozzle heat wash on the tail deck between the booms
    wx.soot_patch(PL.nbox(u(2.10), v(-0.58), u(3.40), v(0.58)), 0.45)
    wx.soot_patch(PL.nbox(us(2.10), vs(1.50), us(3.45), vs(1.05)), 0.35)
    wx.soot_patch(L.F_NOZZLE, 0.6)
    # bay-seam grime
    wx.soot_patch(L.F_BAY.rect, 0.30)
    wx.soot_patch(PL.nbox(ub(-0.90), vb(-0.55), ub(1.60), vb(0.55)), 0.22)
    # dust film on the upper surfaces — thin (8 of these fly together)
    wx.mud_band(L.F_TOP.rect, 0.15, fade=None, spatter=False)

    from normals import HeightMap
    hm = HeightMap()
    # proud fittings: intake duct roof, blister deck ring, boom decks
    hm.rect(PL.nbox(u(-0.58), v(-0.32), u(1.32), v(0.32)), 0.35)
    hm.rect(PL.nbox(u(-3.24), v(-0.26), u(-1.88), v(0.26)), 0.30)
    for s in (1, -1):
        hm.rect(PL.nbox(u(1.10), v(s * 0.60), u(3.42), v(s * 1.00)), 0.25)
    hm.rect(PL.nbox(*L.F_BAY.rect), 0.40)
    nx0, ny0, nx1, ny1 = L.F_NOZZLE
    for i in range(7):
        rx = nx0 + (nx1 - nx0) * (i + 0.5) / 7
        hm.line((rx, ny0), (rx, ny1), 0.45, width=3)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
