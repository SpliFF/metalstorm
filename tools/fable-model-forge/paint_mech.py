"""paint_mech — texture painter for fable_mech (MW-3 Strider).

Same faction language as fable_tank: blue-grey armor family, cyan rail /
sensor emissive, orange exhaust heat, hazard yellow accents, team colour
via mask (chest chevron, pauldron panel, roof wedge). Reuses the shared
painter helpers from paint.py; zones come from mech_layout.py.
"""
import numpy as np
from PIL import Image, ImageFilter, ImageFont

from paint import font
from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   shade, jit, stencil, FONT,
                   ARMOR, ARMOR_LT, ARMOR_DK, LOWER, STEEL, STEEL_DK, RUBBER,
                   TRACK_MET, GLASS, YELLOW, BLACKISH, TEAMGREY, CYAN,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS)
import mech_layout as M

W = 1024


def paint_torso(m):
    for zone, tag in ((M.M_TORSO_FRONT, 'f'), (M.M_TORSO_SIDE, 's'),
                      (M.M_TORSO_REAR, 'r')):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR)
        # armored midriff band below the waist line
        _, wv = zone.uv((0, 0.30, 0)) if zone.axes[1] == 'y' else (0, 0.8)
        wy = int(wv * W)
        m.d.rectangle([x0, wy, x1, y1], fill=LOWER)
        m.o.rectangle([x0, wy, x1, y1], fill=(AO_BASE - 30, R_ARMOR, M_ARMOR))
        seam_h(m, x0 + 2, x1 - 2, wy, ARMOR)
        seam_v(m, (x0 + x1) // 2, y0 + 3, wy, ARMOR)
        wear_edges(m, (x0, y0, x1, wy), ARMOR, 30)
    # front: chest plates + team chevron + hazard strip
    zone = M.M_TORSO_FRONT
    x0, y0, x1, y1 = zone.rect
    for wy in (1.05, 0.72):
        _, v = zone.uv((0, wy, 0))
        seam_h(m, x0 + 2, x1 - 2, int(v * W), ARMOR)
    cu, cv = zone.uv((0.0, 0.62, 0))
    cxp, cyp = cu * W, cv * W
    chev = [(cxp - 42, cyp + 26), (cxp, cyp - 4), (cxp + 42, cyp + 26),
            (cxp + 42, cyp + 44), (cxp, cyp + 14), (cxp - 42, cyp + 44)]
    m.t.polygon(chev, fill=(255, 0, 0))
    m.d.polygon(chev, fill=TEAMGREY)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 5), y0 + 10) for i in range(6)],
          base=ARMOR)
    # rear: access panels + numeral
    zone = M.M_TORSO_REAR
    x0, y0, x1, y1 = zone.rect
    m.d.rectangle([x0 + 24, y0 + 40, x1 - 24, y0 + 96], fill=ARMOR_DK)
    m.o.rectangle([x0 + 24, y0 + 40, x1 - 24, y0 + 96], fill=(AO_BASE - 20, R_ARMOR, M_ARMOR))
    bolts(m, [(x0 + 32 + i * ((x1 - x0 - 64) / 3), y0 + 48) for i in range(4)],
          base=ARMOR_DK)
    f = font(30)
    m.d.text((x1 - 64, y0 + 104), '07', font=f, fill=(188, 192, 196))
    # side: intake slats toward the rear
    zone = M.M_TORSO_SIDE
    x0, y0, x1, y1 = zone.rect
    iu0, iv0 = zone.uv((0, 0.75, 0.18))
    iu1, iv1 = zone.uv((0, 0.48, 0.55))
    ib = [iu0 * W, iv0 * W, iu1 * W, iv1 * W]
    m.d.rectangle(ib, fill=STEEL_DK)
    vent_slots(m, [ib[0] + 3, ib[1] + 3, ib[2] - 3, ib[3] - 3], 3)


def paint_torso_top(m):
    zone = M.M_TORSO_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    for _ in range(4):
        bx = x0 + np.random.default_rng(11).integers(0, 60)
        pass
    for wz in (-0.25, 0.2):
        _, v = zone.uv((0, 0, wz))
        seam_h(m, x0 + 3, x1 - 3, int(v * W), ARMOR)
    for wx in (-0.4, 0.4):
        u, _ = zone.uv((wx, 0, 0))
        seam_v(m, int(u * W), y0 + 3, y1 - 3, ARMOR)
    # roof numeral (reads for the player camera) + team wedge
    nu, nv = zone.uv((0.0, 0, 0.42))
    f = font(42)
    tw = m.d.textlength('07', font=f)
    m.d.text((nu * W - tw / 2 + 2, nv * W - 20 + 2), '07', font=f,
             fill=shade(ARMOR_DK, 0.55))
    m.d.text((nu * W - tw / 2, nv * W - 20), '07', font=f, fill=(196, 200, 204))
    fu0, fv0 = zone.uv((-0.22, 0, -0.62))
    fu1, fv1 = zone.uv((0.22, 0, -0.30))
    m.t.polygon([(fu0 * W, fv1 * W), ((fu0 + fu1) / 2 * W, fv0 * W),
                 (fu1 * W, fv1 * W)], fill=(255, 0, 0))
    m.d.polygon([(fu0 * W, fv1 * W), ((fu0 + fu1) / 2 * W, fv0 * W),
                 (fu1 * W, fv1 * W)], fill=TEAMGREY)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 35)


def paint_pelvis_and_dark(m):
    r = M.M_DARK.rect
    fill(m, r, dif=BLACKISH, ao=AO_DEEP, rough=200, metal=40)
    zone = M.M_PELVIS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=LOWER, ao=AO_BASE - 25)
    seam_h(m, x0 + 2, x1 - 2, (y0 + y1) // 2, LOWER)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 4), y0 + 12) for i in range(5)],
          base=LOWER)
    m.d.rectangle([x0 + 8, y1 - 22, x1 - 8, y1 - 12], fill=STEEL_DK)
    m.o.rectangle([x0 + 8, y1 - 22, x1 - 8, y1 - 12], fill=(AO_DEEP, R_STEEL, M_STEEL))


def paint_head(m):
    zone = M.M_HEAD
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    # wraparound sensor visor band (emissive) — deliberately shows on all faces
    _, v0 = zone.uv((0, 1.14, 0))
    _, v1 = zone.uv((0, 1.05, 0))
    m.d.rectangle([x0 + 4, v0 * W, x1 - 4, v1 * W], fill=GLASS)
    m.o.rectangle([x0 + 4, v0 * W, x1 - 4, v1 * W], fill=(AO_BASE, R_GLASS, M_GLASS))
    m.e.rectangle([x0 + 8, v0 * W + 3, x1 - 8, v1 * W - 3], fill=(46, 130, 148))
    m.e.rectangle([x0 + 8, (v0 * W + v1 * W) / 2 - 2, x0 + 56,
                   (v0 * W + v1 * W) / 2 + 2], fill=CYAN)
    seam_h(m, x0 + 3, x1 - 3, int(zone.uv((0, 0.96, 0))[1] * W), ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 25)


def paint_limbs(m):
    # thigh / shin wraps: u along limb, v around
    for rect, tag in ((M.M_THIGH, 'thigh'), (M.M_SHIN, 'shin')):
        x0, y0, x1, y1 = rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 10)
        # dark gasket bands at both joints
        m.d.rectangle([x0, y0, x0 + 14, y1], fill=STEEL_DK)
        m.d.rectangle([x1 - 14, y0, x1, y1], fill=STEEL_DK)
        m.o.rectangle([x0, y0, x0 + 14, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
        m.o.rectangle([x1 - 14, y0, x1, y1], fill=(AO_DEEP, R_STEEL, M_STEEL))
        # front armor facet stripe (v-bands 3+4 face forward-ish)
        bh = (y1 - y0) / 8
        m.d.rectangle([x0 + 18, y0 + 3 * bh, x1 - 18, y0 + 5 * bh],
                      fill=jit(ARMOR, 3))
        seam_v(m, int((x0 + x1) / 2), y0 + 2, y1 - 2, ARMOR_DK)
        if tag == 'shin':  # piston highlight
            m.d.rectangle([x0 + 20, y0 + int(0.5 * bh), x1 - 30, y0 + int(1.5 * bh)],
                          fill=(150, 155, 160))
            m.o.rectangle([x0 + 20, y0 + int(0.5 * bh), x1 - 30, y0 + int(1.5 * bh)],
                          fill=(AO_BASE, 90, 230))
        wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)
    # joint stubs: ribbed gasket + bolted cap
    x0, y0, x1, y1 = M.M_JOINT
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 25, rough=140, metal=190)
    for i in range(8):
        sx = x0 + (x1 - x0) * i / 8
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=2)
    r = M.M_JOINT_CAP.rect
    fill(m, r, dif=TRACK_MET, ao=AO_BASE - 15, rough=130, metal=M_TRACK)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    m.d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=STEEL_DK)
    bolts(m, [(cx + np.cos(a) * 16, cy + np.sin(a) * 16)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 6, endpoint=False)],
          base=TRACK_MET)
    # feet
    zone = M.M_FOOT_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 20)
    u, _ = zone.uv((0, 0, -0.30))
    seam_v(m, int(u * W), y0 + 2, y1 - 2, LOWER)   # toe armor segment
    u2, _ = zone.uv((0, 0, 0.10))
    seam_v(m, int(u2 * W), y0 + 2, y1 - 2, LOWER)
    wear_edges(m, (x0, y0, x1, y1), LOWER, 40)
    x0, y0, x1, y1 = M.M_FOOT_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER, metal=M_TRACK)
    for i in range(10):
        sx = x0 + (x1 - x0) * i / 10
        m.d.line([(sx, y0), (sx, y1)], fill=BLACKISH, width=2)


def paint_gun(m):
    x0, y0, x1, y1 = M.M_GUN_WRAP
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=115, metal=210)
    heat_w = int((x1 - x0) * 0.3)
    heat = Image.new('RGB', (heat_w, y1 - y0), (74, 52, 50))
    grad = Image.new('L', (heat_w, 1), 0)
    for gx in range(heat_w):
        grad.putpixel((gx, 0), int(110 * (gx / max(1, heat_w - 1)) ** 1.6))
    m.dif.paste(heat, (x1 - heat_w, y0), grad.resize((heat_w, y1 - y0)))
    for band in (3, 7):  # rail-glow slits on ±X facets
        by0 = y0 + (y1 - y0) * band / 8 + 2
        by1 = y0 + (y1 - y0) * (band + 1) / 8 - 2
        m.e.rectangle([x0 + (x1 - x0) * 0.15, by0, x1 - 4, by1], fill=(30, 80, 92))
    m.e.rectangle([x1 - 5, y0, x1, y1], fill=CYAN)

    zone = M.M_RAIL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 10, rough=110, metal=215)
    midy = (y0 + y1) / 2
    m.e.rectangle([x0 + 4, midy - 2, x1 - 4, midy + 2], fill=CYAN)
    m.d.rectangle([x0 + 4, midy - 2, x1 - 4, midy + 2], fill=(46, 70, 76))
    m.e.rectangle([x0, y0, x1, y0 + 4], fill=(26, 70, 80))
    m.e.rectangle([x0, y1 - 4, x1, y1], fill=(26, 70, 80))
    stencil(m, (x0 + 10, y0 + 5), 'DANGER — RAIL', 12, YELLOW, bridge=False)

    zone = M.M_RECEIVER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 12)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2 + 8, ARMOR_DK)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 4), y1 - 12) for i in range(5)],
          base=ARMOR_DK)
    stencil(m, (x0 + 12, y0 + 10), 'MW-3', 20, shade(ARMOR, 1.25), bridge=False)
    m.d.rectangle([x1 - 42, y0 + 8, x1 - 10, y0 + 22], fill=YELLOW)
    m.d.text((x1 - 39, y0 + 9), 'HV', font=font(12),
             fill=BLACKISH)

    zone = M.M_MUZZLE_CELL
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 20, rough=120, metal=205)
    for i in range(int((x1 - x0) / 12) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.polygon([(x0 + i * 12, y1 - 18), (x0 + 12 + i * 12, y1 - 18),
                     (x0 + 6 + i * 12, y1 - 6), (x0 - 6 + i * 12, y1 - 6)], fill=c)
    cx, cy = (x0 + x1) / 2, y0 + (y1 - y0) * 0.4
    m.d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=BLACKISH)
    m.o.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=(AO_DEEP - 40, 220, 0))


def paint_shoulder_vents(m):
    zone = M.M_SHOULDER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR)
    panel = [x0 + 12, y0 + 10, x1 - 12, y1 - 18]
    m.t.rectangle(panel, fill=(255, 0, 0))
    m.d.rectangle(panel, fill=TEAMGREY)
    m.d.rectangle(panel, outline=shade(ARMOR, 0.5), width=2)
    # mask-cutout chevron inside the team panel (survives team paint)
    cxp = (panel[0] + panel[2]) / 2
    ph = panel[3] - panel[1]
    chev = [(cxp - 20, panel[1] + ph * 0.62), (cxp, panel[1] + ph * 0.25),
            (cxp + 20, panel[1] + ph * 0.62), (cxp + 20, panel[1] + ph * 0.80),
            (cxp, panel[1] + ph * 0.43), (cxp - 20, panel[1] + ph * 0.80)]
    m.t.polygon(chev, fill=(0, 0, 0))
    m.d.polygon(chev, fill=(44, 48, 52))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 25)

    zone = M.M_VENTS
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=(60, 56, 54), ao=AO_BASE - 30, rough=190, metal=160)
    vent_slots(m, [x0 + 8, y0 + 10, x1 - 8, y1 - 10], 4, glow=(120, 44, 12))


def paint_all():
    from paint import BOLT_LOG
    BOLT_LOG.clear()
    m = Maps()
    paint_pelvis_and_dark(m)
    paint_torso(m)
    paint_torso_top(m)
    paint_head(m)
    paint_limbs(m)
    paint_gun(m)
    paint_shoulder_vents(m)
    # ── weathering pass: mud rises from the feet, grease on joints ──
    from weathering import Weather, vertical_rects_of
    from paint import BOLT_LOG as _bolts
    from paint import enrich
    enrich(m)
    wx = Weather(seed=63)
    wx.crevice_grime(m.dif, 0.65)
    # ground contact: feet heaviest, fading up the legs (u runs hip->foot)
    wx.mud_band(M.M_FOOT_SIDE.rect, 0.85, fade='down')
    wx.mud_band(M.M_FOOT_WRAP, 0.7, fade=None)
    wx.mud_band(M.M_SHIN, 0.8, fade='right')
    wx.mud_band(M.M_THIGH, 0.45, fade='right')
    wx.mud_band(M.M_JOINT, 0.3, fade=None, spatter=False)
    wx.mud_band(M.M_PELVIS.rect, 0.5, fade='down', dust=0.3)
    # torso: dust film + light grade, almost clean up top
    for z in (M.M_TORSO_FRONT, M.M_TORSO_SIDE, M.M_TORSO_REAR):
        wx.mud_band(z.rect, 0.32, fade='down', spatter=False, dust=0.3)
        wx.plate_bottom_rust(z.rect, n=4, strength=0.5)
    wx.mud_band(M.M_TORSO_TOP.rect, 0.15, fade=None, spatter=False)
    wx.mud_band(M.M_HEAD.rect, 0.12, fade=None, spatter=False)
    wx.mud_band(M.M_SHOULDER.rect, 0.3, fade='down', spatter=False)
    wx.mud_band(M.M_RECEIVER.rect, 0.25, fade=None, spatter=False)
    wx.plate_bottom_rust(M.M_PELVIS.rect, n=5, strength=0.65)
    wx.plate_bottom_rust(M.M_FOOT_SIDE.rect, n=8, band=14, strength=0.8)
    wx.bolt_rust(_bolts, vertical_rects_of(M), fraction=0.55, seed_extra=9)
    # grease where metal articulates; soot where energy leaves
    wx.oily(M.M_JOINT, 0.55)
    wx.oily(M.M_JOINT_CAP.rect, 0.5)
    gx0, gy0, gx1, gy1 = M.M_GUN_WRAP
    wx.soot_patch((gx0 + (gx1 - gx0) * 0.7, gy0, gx1, gy1), 0.5, fade='right')
    wx.soot_patch(M.M_MUZZLE_CELL.rect, 0.65)
    wx.soot_patch(M.M_VENTS.rect, 0.55)
    wx.apply(m)

    # ── height → normal map: sole treads, joint ribs, piston ──
    from normals import HeightMap
    hm = HeightMap()
    fx0, fy0, fx1, fy1 = M.M_FOOT_WRAP
    for i in range(10):  # discrete sole tread blocks
        lx = fx0 + (fx1 - fx0) * i / 10
        lw = (fx1 - fx0) / 10
        hm.rect((lx + 2, fy0 + 2, lx + lw - 2, fy1 - 2), 0.6)
    jx0, jy0, jx1, jy1 = M.M_JOINT
    for i in range(8):   # joint gasket ribs
        sx = jx0 + (jx1 - jx0) * i / 8
        hm.line((sx, jy0), (sx, jy1), -0.5, width=2)
    r = M.M_JOINT_CAP.rect
    hm.disc((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 8, 0.6)
    sx0, sy0, sx1, sy1 = M.M_SHIN
    bh = (sy1 - sy0) / 8
    hm.rect((sx0 + 20, sy0 + int(0.5 * bh), sx1 - 30, sy0 + int(1.5 * bh)), 0.5)
    hm.crevices_from(m.dif, 0.6)
    from paint import BOLT_LOG as _blog
    hm.bolts_from(_blog, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.5).save('out/fable_mech_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save('out/fable_mech_diffuse.png')
    m.orm.save('out/fable_mech_orm.png')
    m.emi.save('out/fable_mech_emissive.png')
    m.tea.save('out/fable_mech_team.png')
    print('[paint_mech] full texture set written to out/')


if __name__ == '__main__':
    paint_all()
