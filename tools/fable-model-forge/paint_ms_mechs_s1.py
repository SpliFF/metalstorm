"""paint_ms_mechs_s1 — texture set for the RW-1 "Tick" recon walker.

Same faction language as fable_mech / fable_tank: blue-grey armour, orange
vent accents, hazard tips on the gun, soot at the exhaust, rust streaks under
fittings, grime at the feet. Register: LIGHT RECON KIT — thin armour, lots of
visible fasteners, a stowage/aerial box, a hand-stencilled pack numeral.

NO glazing anywhere (this is an unmanned drone — no glass_rect call) and NO
cyan emissive; the only emissive is one small amber status lamp on the head
plus the warm glow inside the head vent louvres.
"""
import numpy as np

import paint as P
P.W = 1024
import weathering                                          # noqa: E402
weathering.W = 1024
import normals as NM                                       # noqa: E402
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots,   # noqa: E402
                   wear_edges, shade, jit, stencil,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK,
                   TRACK_MET, YELLOW, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, M_ARMOR, M_STEEL, M_TRACK)
import paintlib as PL                                      # noqa: E402
import ms_mechs_s1_layout as L                             # noqa: E402

W = 1024
STEM = 'ms_mechs_s1'
TEAM_BASE = (120, 124, 128)     # held near the hull grey (impostor-safe)
AMBER = (238, 150, 44)
EMBER = (128, 52, 16)


# ── chassis ──────────────────────────────────────────────────────────────

def paint_body(m):
    # deck
    z = L.B_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    u, v = PL.zone_fns(z)
    for wz in (-0.15, 0.35, 0.85):
        seam_h(m, x0 + 3, x1 - 3, int(v(wz)), ARMOR)
    for wx in (-0.42, 0.42):
        seam_v(m, int(u(wx)), y0 + 3, y1 - 3, ARMOR)
    # team wedge on the deck (mask only; diffuse held near hull grey)
    PL.team_panel(m, PL.nbox(u(-0.30), v(-0.50), u(0.30), v(0.05)),
                  outline=ARMOR_DK, base=TEAM_BASE)
    # hand-stencilled pack numeral behind it
    stencil(m, (u(-0.26), v(0.20)), 'K-4', 40, (198, 202, 206), bridge=False)
    # armoured deck strip + fasteners along the spine
    bolts(m, [(u(-0.55), v(zz)) for zz in (-0.35, 0.10, 0.55, 1.00)] +
             [(u(0.55), v(zz)) for zz in (-0.35, 0.10, 0.55, 1.00)], base=ARMOR)
    # stowage/aerial box footprint reads darker
    m.d.rectangle(PL.nbox(u(-0.44), v(0.55), u(0.16), v(1.05)), fill=ARMOR_DK)
    m.o.rectangle(PL.nbox(u(-0.44), v(0.55), u(0.16), v(1.05)),
                  fill=(AO_BASE - 22, R_ARMOR, M_ARMOR))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 35)

    # flanks
    z = L.B_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    u, v = PL.zone_fns(z)
    wy = int(v(1.06))
    m.d.rectangle([x0, wy, x1, y1], fill=LOWER)           # thin lower skirt
    m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 28, R_ARMOR, M_ARMOR))
    seam_h(m, x0 + 2, x1 - 2, wy, ARMOR)
    for wz in (-0.15, 0.55):
        seam_v(m, int(u(wz)), y0 + 3, wy, ARMOR)
    # small team flank panel
    PL.team_panel(m, PL.nbox(u(0.62), v(1.38), u(1.10), v(1.12)),
                  outline=ARMOR_DK, base=TEAM_BASE)
    # side louvre strip (engine bay) + bolts
    lb = PL.nbox(u(0.05), v(1.36), u(0.50), v(1.16))
    m.d.rectangle(lb, fill=STEEL_DK)
    vent_slots(m, [lb[0] + 3, lb[1] + 3, lb[2] - 3, lb[3] - 3], 3)
    bolts(m, [(u(zz), v(1.44)) for zz in (-0.55, -0.20, 0.15, 0.50, 0.90, 1.22)],
          base=ARMOR)
    stencil(m, (u(-0.62), v(1.03)), 'RW-1', 16, shade(ARMOR, 1.3), bridge=False)
    wear_edges(m, (x0, y0, x1, wy), ARMOR, 40)

    # nose
    z = L.B_FRONT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    u, v = PL.zone_fns(z)
    seam_h(m, x0 + 3, x1 - 3, int(v(1.06)), ARMOR)
    m.d.rectangle(PL.nbox(u(-0.34), v(1.38), u(0.34), v(1.12)), fill=ARMOR_DK)
    bolts(m, [(u(xx), v(1.42)) for xx in (-0.55, -0.22, 0.22, 0.55)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 45)

    # tail — engine louvres + soot
    z = L.B_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    u, v = PL.zone_fns(z)
    vb = PL.nbox(u(-0.40), v(1.38), u(0.40), v(1.08))
    m.d.rectangle(vb, fill=(60, 56, 54))
    m.o.rectangle(vb, fill=(AO_BASE - 30, 190, 150))
    vent_slots(m, [vb[0] + 4, vb[1] + 4, vb[2] - 4, vb[3] - 4], 4,
               glow=(118, 44, 12))
    m.e.rectangle([vb[0] + 8, vb[1] + 8, vb[2] - 8, vb[3] - 8], fill=(52, 20, 6))
    bolts(m, [(u(xx), v(0.98)) for xx in (-0.5, 0.0, 0.5)], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 40)

    # hip fairings
    z = L.B_SPONSON
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 18)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, ARMOR_DK)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 5), y0 + 14) for i in range(6)],
          base=ARMOR_DK)
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 5), y1 - 14) for i in range(6)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 45)

    fill(m, L.B_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)


# ── sensor head (no canopy, no glass) ────────────────────────────────────

def paint_head(m):
    z = L.H_MAIN
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    u, v = PL.zone_fns(z)
    seam_h(m, x0 + 3, x1 - 3, int(v(0.15)), ARMOR_DK)
    seam_h(m, x0 + 3, x1 - 3, int(v(0.44)), ARMOR_DK)
    bolts(m, [(u(xx), v(0.47)) for xx in (-0.30, -0.10, 0.10, 0.30)],
          base=ARMOR_DK)
    stencil(m, (u(-0.30), v(0.24)), 'UNMANNED', 13, YELLOW, bridge=False)
    # the one amber status lamp
    lb = PL.nbox(u(0.30) - 5, v(0.36) - 5, u(0.30) + 5, v(0.36) + 5)
    m.d.rectangle(lb, fill=(72, 52, 30))
    m.e.rectangle(lb, fill=AMBER)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 25)

    z = L.H_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    u, v = PL.zone_fns(z)
    seam_v(m, int(u(-0.10)), y0 + 3, y1 - 3, ARMOR_DK)
    m.d.rectangle(PL.nbox(u(-0.50), v(0.42), u(-0.16), v(0.20)), fill=STEEL_DK)
    bolts(m, [(u(zz), v(0.10)) for zz in (-0.45, -0.20, 0.05, 0.28)],
          base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 28)

    z = L.H_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    u, v = PL.zone_fns(z)
    for wz in (-0.30, 0.05):
        seam_h(m, x0 + 3, x1 - 3, int(v(wz)), ARMOR)
    bolts(m, [(u(-0.30), v(0.24)), (u(0.30), v(0.24)),
              (u(-0.30), v(-0.48)), (u(0.30), v(-0.48))], base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 30)

    # EO/IR optics faces — dark coated glassless apertures, no emissive
    z = L.H_LENS
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(38, 40, 44), ao=AO_DEEP, rough=90, metal=60)
    for cxw in (-0.22, 0.22):
        cx = PL.zone_fns(z)[0](cxw)
        cy = (y0 + y1) / 2
        m.d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], fill=(24, 26, 30))
        m.d.ellipse([cx - 22, cy - 22, cx + 22, cy + 22],
                    outline=shade(STEEL, 1.2), width=3)
        m.o.ellipse([cx - 22, cy - 22, cx + 22, cy + 22],
                    fill=(AO_DEEP - 30, 70, 20))
    wear_edges(m, (x0, y0, x1, y1), STEEL_DK, 20)

    # flat scanner plate — ribbed, tone-on-tone
    z = L.H_PANEL
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 14, rough=140,
         metal=M_STEEL)
    for i in range(9):
        gy = y0 + (y1 - y0) * (i + 0.5) / 9
        m.d.line([(x0 + 8, gy), (x1 - 8, gy)], fill=shade(STEEL, 0.82), width=3)
    m.d.rectangle([x0 + 4, y0 + 4, x1 - 4, y1 - 4],
                  outline=shade(STEEL, 0.6), width=3)

    # head rear vent louvres (the exhaust empty sits here)
    z = L.H_VENT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 30, rough=190,
         metal=160)
    vent_slots(m, [x0 + 8, y0 + 8, x1 - 8, y1 - 8], 4, glow=(120, 44, 12))

    # comms blade / mast
    x0, y0, x1, y1 = L.MAST
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 20, rough=130,
         metal=200)
    for i in range(6):
        sx = x0 + (x1 - x0) * i / 6
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=2)
    # tone-on-tone collar bands only — a bold stripe on a thin mast floods
    # the whole triangle in the impostor bake (baker flat-shades by centroid)
    for f in (0.30, 0.55, 0.80):
        bx = x0 + (x1 - x0) * f
        m.d.rectangle([bx, y0, bx + 8, y1], fill=shade(STEEL_DK, 1.35))


# ── chin MG ──────────────────────────────────────────────────────────────

def paint_gun(m):
    z = L.G_BODY
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 12)
    u, v = PL.zone_fns(z)
    seam_v(m, int(u(0.06)), y0 + 3, y1 - 3, ARMOR_DK)
    m.d.rectangle(PL.nbox(u(0.08), v(0.16), u(0.34), v(-0.06)), fill=STEEL_DK)
    m.o.rectangle(PL.nbox(u(0.08), v(0.16), u(0.34), v(-0.06)),
                  fill=(AO_BASE - 20, R_STEEL, M_STEEL))
    for i in range(7):               # ammo belt links on the feed box
        by = v(0.14) + i * 6
        m.d.rectangle([u(0.10), by, u(0.32), by + 3], fill=TRACK_MET)
    bolts(m, [(u(-0.02), v(-0.16)), (u(0.16), v(-0.16)), (u(0.28), v(-0.18))],
          base=ARMOR_DK)
    stencil(m, (u(-0.40), v(0.18)), 'MG', 18, shade(ARMOR, 1.25), bridge=False)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)

    # MG tube + perforated flash shroud
    x0, y0, x1, y1 = L.G_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 12, rough=120,
         metal=205)
    for i in range(8):
        sy = y0 + (y1 - y0) * i / 8
        m.d.line([(x0, sy), (x1, sy)], fill=shade(STEEL_DK, 0.7), width=2)
    # cooling perforations toward the muzzle end (u runs breech -> muzzle)
    for c in range(9):
        px = x0 + (x1 - x0) * (0.52 + c * 0.05)
        for r in range(4):
            py = y0 + (y1 - y0) * (0.15 + r * 0.23)
            m.d.ellipse([px - 3, py - 3, px + 3, py + 3], fill=BLACKISH)
    PL.hazard_band(m, (x1 - 34, y0, x1, y1), step=10)

    z = L.G_TIP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 24, rough=120,
         metal=205)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], fill=BLACKISH)
    m.o.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], fill=(AO_DEEP - 40, 220, 0))


# ── legs ─────────────────────────────────────────────────────────────────

def paint_legs(m):
    for rect, tag in ((L.M_THIGH, 'thigh'), (L.M_SHIN, 'shin')):
        x0, y0, x1, y1 = rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 10)
        m.d.rectangle([x0, y0, x0 + 12, y1], fill=STEEL_DK)
        m.d.rectangle([x1 - 12, y0, x1, y1], fill=STEEL_DK)
        m.o.rectangle([x0, y0, x0 + 12, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
        m.o.rectangle([x1 - 12, y0, x1, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
        bh = (y1 - y0) / 8
        m.d.rectangle([x0 + 16, y0 + 3 * bh, x1 - 16, y0 + 5 * bh],
                      fill=jit(ARMOR, 3))
        seam_v(m, int((x0 + x1) / 2), y0 + 2, y1 - 2, ARMOR_DK)
        if tag == 'shin':      # actuator rod highlight
            m.d.rectangle([x0 + 18, y0 + int(0.5 * bh), x1 - 26,
                           y0 + int(1.4 * bh)], fill=(150, 155, 160))
            m.o.rectangle([x0 + 18, y0 + int(0.5 * bh), x1 - 26,
                           y0 + int(1.4 * bh)], fill=(AO_BASE, 90, 230))
        wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 32)

    x0, y0, x1, y1 = L.M_JOINT
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 25, rough=140,
         metal=190)
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=2)
    r = L.M_JOINT_CAP.rect
    fill(m, r, dif=TRACK_MET, ao=AO_BASE - 15, rough=130, metal=M_TRACK)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=STEEL_DK)
    bolts(m, [(cx + np.cos(a) * 15, cy + np.sin(a) * 15)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 5, endpoint=False)],
          base=TRACK_MET)

    z = L.M_FOOT_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 20)
    u, v = PL.zone_fns(z)
    seam_v(m, int(u(-0.28)), y0 + 2, y1 - 2, LOWER)
    seam_v(m, int(u(0.08)), y0 + 2, y1 - 2, LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 45)
    x0, y0, x1, y1 = L.M_FOOT_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    for i in range(10):
        sx = x0 + (x1 - x0) * i / 10
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=2)


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    from paint import BOLT_LOG
    BOLT_LOG.clear()
    m = Maps()
    paint_body(m)
    paint_head(m)
    paint_gun(m)
    paint_legs(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=(L.M_FOOT_WRAP, L.M_FOOT_SIDE.rect),
        side_zones=(L.B_SIDE, L.B_FRONT, L.B_REAR, L.B_SPONSON),
        seed=47, mud=0.55, grime=0.6, rust_fraction=0.55)
    # grime climbs the legs, dies out at the deck
    wx.mud_band(L.M_SHIN, 0.8, fade='right')
    wx.mud_band(L.M_THIGH, 0.45, fade='right')
    wx.mud_band(L.M_JOINT, 0.3, fade=None, spatter=False)
    wx.mud_band(L.B_TOP.rect, 0.14, fade=None, spatter=False)
    wx.mud_band(L.H_MAIN.rect, 0.12, fade=None, spatter=False)
    wx.mud_band(L.H_SIDE.rect, 0.14, fade='down', spatter=False)
    wx.mud_band(L.H_TOP.rect, 0.10, fade=None, spatter=False)
    wx.mud_band(L.G_BODY.rect, 0.22, fade=None, spatter=False)
    wx.plate_bottom_rust(L.B_SIDE.rect, n=5, strength=0.6)
    wx.plate_bottom_rust(L.B_SPONSON.rect, n=5, strength=0.7)
    wx.plate_bottom_rust(L.M_FOOT_SIDE.rect, n=7, band=12, strength=0.8)
    wx.oily(L.M_JOINT, 0.55)
    wx.oily(L.M_JOINT_CAP.rect, 0.5)
    gx0, gy0, gx1, gy1 = L.G_WRAP
    wx.soot_patch((gx0 + (gx1 - gx0) * 0.6, gy0, gx1, gy1), 0.55, fade='right')
    wx.soot_patch(L.G_TIP.rect, 0.6)
    wx.soot_patch(L.H_VENT.rect, 0.55)
    bvx0, bvy0, bvx1, bvy1 = L.B_REAR.rect
    wx.soot_patch((bvx0 + 30, bvy0 + 10, bvx1 - 30, bvy0 + 80), 0.45)

    hm = NM.HeightMap()
    fx0, fy0, fx1, fy1 = L.M_FOOT_WRAP
    for i in range(10):
        lx = fx0 + (fx1 - fx0) * i / 10
        hm.rect((lx + 2, fy0 + 2, lx + (fx1 - fx0) / 10 - 2, fy1 - 2), 0.6)
    jx0, jy0, jx1, jy1 = L.M_JOINT
    for i in range(8):
        sx = jx0 + (jx1 - jx0) * i / 8
        hm.line((sx, jy0), (sx, jy1), -0.5, width=2)
    r = L.M_JOINT_CAP.rect
    hm.disc((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 8, 0.6)
    px0, py0, px1, py1 = L.H_PANEL.rect
    for i in range(9):
        gy = py0 + (py1 - py0) * (i + 0.5) / 9
        hm.line((px0 + 8, gy), (px1 - 8, gy), -0.45, width=3)
    sx0, sy0, sx1, sy1 = L.M_SHIN
    bh = (sy1 - sy0) / 8
    hm.rect((sx0 + 18, sy0 + int(0.5 * bh), sx1 - 26, sy0 + int(1.4 * bh)), 0.5)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
