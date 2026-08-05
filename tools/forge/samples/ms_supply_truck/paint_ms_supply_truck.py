"""paint_ms_supply_truck — 1024² PBR set for ms_supply_truck.

Military logistics read, deliberately apart from ms_civtruck's white/
teal civilian livery: olive-drab armour, bolted standoff plates with a
mirror-safe white star roundel, slit cab glazing with an armoured
visor, louvred grille + brush-guarded headlights, double rear doors
with hinge rows / hazard band / 'SUP 07' stencil, canvas tarp roll,
stowage bins.  Weathering: wheel/skirt mud, plate-bottom rust, hinge
streaks, exhaust soot, chassis oil.  Team mask (R channel): cab door
panels, box-front stripe, rear ID square, roof ID panel — never baked
into diffuse.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

import ms_supply_truck_layout as L      # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   GLASS, YELLOW, BLACKISH, TEAMGREY, RUBBER, TRACK_MET,
                   STEEL, STEEL_DK,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)

W = 1024
STEM = 'ms_supply_truck'

# ── military palette (sRGB) ──────────────────────────────────────────────
OLIVE    = (88, 95, 70)
OLIVE_DK = (70, 76, 56)
OLIVE_LT = (103, 110, 82)
CANVAS   = (112, 105, 82)
STAR     = (196, 192, 180)
LAMP     = (222, 226, 210)
TAIL_RED = (150, 34, 26)


def _font(size):
    for path in (P.FONT,
                 '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                 '/System/Library/Fonts/Supplemental/Courier New Bold.ttf'):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def star(d, cx, cy, r, col):
    pts = []
    for i in range(10):
        a = -np.pi / 2 + i * np.pi / 5
        rr = r if i % 2 == 0 else r * 0.42
        pts.append((cx + rr * np.cos(a), cy + rr * np.sin(a)))
    d.polygon(pts, fill=col)


def nbox(x0, y0, x1, y1):
    """Normalised pixel rect — flipped-u zones (front/rear faces) may hand
    coordinates in either order."""
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def glass_rect(m, x0, y0, x1, y1):
    b = nbox(x0, y0, x1, y1)
    m.d.rectangle(b, fill=GLASS)
    m.o.rectangle(b, fill=(AO_BASE, R_GLASS, M_GLASS))


def paint_box_side(m):
    zone = L.BOX_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 4, rough=R_ARMOR + 10,
         metal=40)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # box body seams above/below the applique band + roof line
    seam_h(m, int(u(-1.5)), int(u(3.4)), int(v(3.0)), OLIVE)
    seam_h(m, int(u(-1.5)), int(u(3.4)), int(v(1.1)), OLIVE)
    # dark lower band (box bottom / gap shadow)
    m.d.rectangle([x0, v(0.95), x1, y1], fill=shade(OLIVE_DK, 0.7))
    m.o.rectangle([x0, v(0.95), x1, y1], fill=(AO_BASE - 40, R_ARMOR, 30))
    # standoff applique plate band (geometry z -1.3..3.2, y 1.475..2.725)
    pb = [u(-1.3), v(2.725), u(3.2), v(1.475)]
    m.d.rectangle(pb, fill=jit(OLIVE_DK, 3))
    m.o.rectangle(pb, fill=(AO_BASE - 8, R_ARMOR + 18, 34))
    for wz in (-0.4, 0.5, 1.4, 2.3):
        seam_v(m, int(u(wz)), int(pb[1]) + 2, int(pb[3]) - 2, OLIVE_DK)
    bolts(m, [(u(-1.15 + i * 0.35), pb[1] + 8) for i in range(13)],
          base=OLIVE_DK)
    bolts(m, [(u(-1.15 + i * 0.35), pb[3] - 8) for i in range(13)],
          base=OLIVE_DK)
    # mirror-safe white star roundel on the plate band
    scx, scy = u(1.9), (pb[1] + pb[3]) / 2
    m.d.ellipse([scx - 34, scy - 34, scx + 34, scy + 34],
                outline=STAR, width=3)
    star(m.d, scx, scy, 26, STAR)
    # team stripe on the box front section
    ts = [u(-1.48), v(2.72), u(-1.02), v(1.48)]
    m.t.rectangle(ts, fill=(255, 0, 0))
    m.d.rectangle(ts, fill=TEAMGREY)
    m.d.rectangle(ts, outline=shade(OLIVE_DK, 0.6), width=2)
    wear_edges(m, (x0, y0, x1, int(v(1.0))), OLIVE, 45)


def paint_cab_side(m):
    zone = L.CAB_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 4, rough=R_ARMOR + 8,
         metal=40)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # armoured slit window
    glass_rect(m, u(-3.2), v(2.55), u(-2.72), v(2.15))
    m.d.rectangle([u(-3.2), v(2.55), u(-2.72), v(2.15)],
                  outline=shade(OLIVE_DK, 0.65), width=2)
    # door seam + handle + team panel on the door
    seam_v(m, int(u(-2.45)), int(v(2.7)), int(v(1.1)), OLIVE)
    m.d.rectangle([u(-2.62), v(1.95), u(-2.5), v(1.88)], fill=STEEL_DK)
    tp = [u(-2.38), v(2.05), u(-2.0), v(1.45)]
    m.t.rectangle(tp, fill=(255, 0, 0))
    m.d.rectangle(tp, fill=TEAMGREY)
    m.d.rectangle(tp, outline=shade(OLIVE_DK, 0.6), width=2)
    # cab step + lower shadow band
    m.d.rectangle([x0, v(1.05), x1, y1], fill=shade(OLIVE_DK, 0.72))
    m.d.rectangle([u(-2.7), v(0.85), u(-2.2), v(0.72)], fill=BLACKISH)
    m.o.rectangle([u(-2.7), v(0.85), u(-2.2), v(0.72)],
                  fill=(AO_DEEP, R_STEEL, M_STEEL))
    bolts(m, [(u(-3.55), v(2.6 - i * 0.35)) for i in range(5)], base=OLIVE)
    wear_edges(m, (x0, y0, x1, int(v(1.0))), OLIVE, 30)


def paint_cab_front(m):
    zone = L.CAB_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 4, rough=R_ARMOR + 8,
         metal=40)

    def uu(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # split armoured windshield under the visor
    for (a, b) in ((-1.05, -0.10), (0.10, 1.05)):
        wb = nbox(uu(a), v(2.60), uu(b), v(2.08))
        glass_rect(m, *wb)
        m.d.rectangle(wb, outline=shade(OLIVE_DK, 0.6), width=2)
        # wiper
        m.d.line([(wb[0] + 10, wb[3] - 4), (wb[0] + 34, wb[1] + 6)],
                 fill=BLACKISH, width=2)
    seam_h(m, x0 + 4, x1 - 4, int(v(2.72)), OLIVE)
    # louvred grille
    gb = nbox(uu(-0.8), v(1.78), uu(0.8), v(1.3))
    m.d.rectangle(gb, fill=STEEL_DK)
    vent_slots(m, [gb[0] + 3, gb[1] + 3, gb[2] - 3, gb[3] - 3], 4)
    # headlights on the bumper face (behind the brush guard)
    for s in (-0.85, 0.85):
        hb = nbox(uu(s - 0.16), v(1.06), uu(s + 0.16), v(0.9))
        he = nbox(uu(s - 0.12), v(1.03), uu(s + 0.12), v(0.93))
        m.d.rectangle(hb, fill=GLASS)
        m.e.rectangle(he, fill=LAMP)
        m.o.rectangle(hb, fill=(AO_SEAM, R_GLASS, M_GLASS))
    # bumper: dark band + hazard stripe row
    m.d.rectangle([x0, v(1.13), x1, v(0.57)], fill=shade(OLIVE_DK, 0.8))
    for s in (-0.85, 0.85):   # redraw lights over the band
        m.d.rectangle(nbox(uu(s - 0.16), v(1.06), uu(s + 0.16), v(0.9)),
                      fill=GLASS)
    step = 14
    for i in range(int((x1 - x0) / step) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0 + i * step, v(0.72), x0 + (i + 1) * step, v(0.6)],
                      fill=c)
    bolts(m, [(x0 + 12 + i * (x1 - x0 - 24) / 5, v(2.8)) for i in range(6)],
          base=OLIVE)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 35)


def paint_box_rear(m):
    zone = L.BOX_REAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=jit(OLIVE, 3), ao=AO_BASE - 5,
         rough=R_ARMOR + 12, metal=40)

    def uu(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # double door outline + centre seam + latch bars
    m.d.rectangle(nbox(uu(1.1), v(2.95), uu(-1.1), v(1.1)),
                  outline=shade(OLIVE_DK, 0.6), width=2)
    seam_v(m, int(uu(0.0)), int(v(2.95)), int(v(1.1)), OLIVE)
    for wy in (2.5, 1.5):
        lb = nbox(uu(0.35), v(wy + 0.05), uu(-0.35), v(wy - 0.05))
        m.d.rectangle(lb, fill=STEEL_DK)
        m.o.rectangle(lb, fill=(AO_SEAM, R_STEEL, M_STEEL))
    # hinge rows
    hb = []
    for s in (1.14, -1.14):
        for wy in (2.75, 2.0, 1.3):
            hb.append((uu(s), v(wy)))
    bolts(m, hb, r=3, base=OLIVE_DK)
    # stencil + team ID square
    f = _font(30)
    tw = m.d.textlength('SUP 07', font=f)
    m.d.text(((uu(0.0)) - tw / 2, v(2.9)), 'SUP 07', font=f,
             fill=(188, 186, 170))
    ts = nbox(uu(1.25), v(3.2), uu(0.85), v(3.0))
    m.t.rectangle(ts, fill=(255, 0, 0))
    m.d.rectangle(ts, fill=TEAMGREY)
    # taillights + hazard band + mudflap shadows
    for s in (-1.08, 1.08):
        m.d.rectangle(nbox(uu(s - 0.1), v(1.0), uu(s + 0.1), v(0.88)),
                      fill=(52, 22, 20))
        m.e.rectangle(nbox(uu(s - 0.07), v(0.98), uu(s + 0.07), v(0.9)),
                      fill=TAIL_RED)
    step = 14
    for i in range(int((x1 - x0) / step) + 1):
        c = YELLOW if i % 2 == 0 else BLACKISH
        m.d.rectangle([x0 + i * step, v(0.78), x0 + (i + 1) * step, v(0.64)],
                      fill=c)
    m.d.rectangle([x0, v(0.62), x1, y1], fill=shade(OLIVE_DK, 0.6))
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 40)


def paint_roofs(m):
    # cargo-box roof
    zone = L.BOX_ROOF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE, 0.95), ao=AO_BASE - 6,
         rough=R_ARMOR + 18, metal=35)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def vx(wx):
        return zone.uv((wx, 0, 0))[1] * W

    for wz in (-0.6, 0.7, 2.0):                 # cross seams
        seam_v(m, int(u(wz)), y0 + 3, y1 - 3, OLIVE)
    for wx in (-0.85, 0.85):                    # longitudinal rib seams
        seam_h(m, x0 + 3, x1 - 3, int(vx(wx)), OLIVE, hi=False)
    # roof team ID panel (clear band between spare wheel and hatch —
    # reads top-down at strategic zoom)
    tp = [u(-0.3), vx(-0.75), u(0.55), vx(0.75)]
    m.t.rectangle(tp, fill=(255, 0, 0))
    m.d.rectangle(tp, fill=TEAMGREY)
    m.d.rectangle(tp, outline=shade(OLIVE_DK, 0.6), width=2)
    # white star roundel aft of the hatch
    scx, scy = u(2.65), (vx(-0.0))
    star(m.d, scx, scy, 30, STAR)
    # hatch ring + spare-wheel shadow disc are geometry-anchored
    m.d.ellipse([u(1.25), vx(0.25), u(1.95), vx(0.95)],
                outline=shade(OLIVE_DK, 0.7), width=3)
    m.d.ellipse([u(-1.4) - 0, vx(-1.12), u(-0.4), vx(-0.12)],
                outline=shade(OLIVE_DK, 0.7), width=2)
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 40)

    # cab roof
    zone = L.CAB_ROOF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE, 0.97), ao=AO_BASE - 5,
         rough=R_ARMOR + 14, metal=35)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, OLIVE, hi=False)
    m.d.rectangle([x0 + 20, y0 + 16, x0 + 60, y0 + 44],
                  fill=shade(OLIVE_DK, 0.9))
    wear_edges(m, (x0, y0, x1, y1), OLIVE, 20)


def paint_cells(m):
    # wheels: near-black rubber, faint tread banding
    x0, y0, x1, y1 = L.WHEEL.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 16, rough=R_RUBBER,
         metal=10)
    for gy in range(y0 + 4, y1 - 2, 10):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(RUBBER, 0.8),
                 width=2)
    # hubs: steel disc with 8 spokes + lug bolts
    x0, y0, x1, y1 = L.HUB.rect
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 10, rough=140,
         metal=M_TRACK)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rr = (x1 - x0) / 2 - 10
    for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        m.d.line([(cx + np.cos(a) * rr * 0.2, cy + np.sin(a) * rr * 0.2),
                  (cx + np.cos(a) * rr * 0.85, cy + np.sin(a) * rr * 0.85)],
                 fill=shade(TRACK_MET, 0.6), width=4)
    m.d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=STEEL_DK)
    bolts(m, [(cx + np.cos(a) * 15, cy + np.sin(a) * 15)
              for a in np.linspace(0.3, 2 * np.pi + 0.3, 6, endpoint=False)],
          base=TRACK_MET)
    # trim: dark olive-steel (bumpers, guards, fenders, skirts, hatch)
    x0, y0, x1, y1 = L.TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OLIVE_DK, 0.85), ao=AO_BASE - 8,
         rough=R_ARMOR + 20, metal=70)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2, OLIVE_DK, hi=False)
    wear_edges(m, (x0, y0, x1, y1), OLIVE_DK, 25)
    # dark: chassis / undersides / caps
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=205, metal=40)
    # stowage bins: olive with latch line + strap
    x0, y0, x1, y1 = L.STOW.rect
    fill(m, (x0, y0, x1, y1), dif=jit(OLIVE_DK, 3), ao=AO_BASE - 8,
         rough=R_ARMOR + 16, metal=50)
    seam_h(m, x0 + 4, x1 - 4, y0 + (y1 - y0) // 3, OLIVE_DK)
    for fx in (0.3, 0.7):
        m.d.rectangle([x0 + (x1 - x0) * fx - 3, y0 + 4,
                       x0 + (x1 - x0) * fx + 3, y1 - 4], fill=STEEL_DK)
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14)], base=OLIVE_DK)
    # tarp: canvas with cinch straps + fold shading
    x0, y0, x1, y1 = L.TARP.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 6, rough=225, metal=5)
    for fx in np.linspace(0.15, 0.85, 5):
        m.d.rectangle([x0 + (x1 - x0) * fx - 3, y0 + 2,
                       x0 + (x1 - x0) * fx + 3, y1 - 2],
                      fill=shade(CANVAS, 0.62))
    for gy in range(y0 + 8, y1, 16):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=jit(shade(CANVAS, 0.9), 3),
                 width=1)
    # exhaust wrap: heat-stained steel (u runs base→tip)
    x0, y0, x1, y1 = L.EXH
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 12, rough=150,
         metal=190)
    heat = Image.new('RGB', (x1 - x0, y1 - y0), (76, 56, 48))
    grad = Image.new('L', (x1 - x0, 1), 0)
    for gx in range(x1 - x0):
        grad.putpixel((gx, 0), int(110 * (gx / max(1, x1 - x0 - 1)) ** 1.8))
    m.dif.paste(heat, (x0, y0), grad.resize((x1 - x0, y1 - y0)))


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_box_side(m)
    paint_cab_side(m)
    paint_cab_front(m)
    paint_box_rear(m)
    paint_roofs(m)
    paint_cells(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.55)
    wx.mud_band(L.WHEEL.rect, 0.85, fade=None)
    wx.mud_band(L.HUB.rect, 0.5, fade=None)
    wx.mud_band(L.TRIM.rect, 0.45, fade=None)
    wx.mud_band(L.STOW.rect, 0.35, fade=None, spatter=False)
    wx.mud_band(L.TARP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.BOX_SIDE.rect, 0.55, fade='down', dust=0.3)
    wx.mud_band(L.CAB_SIDE.rect, 0.5, fade='down', dust=0.3)
    wx.mud_band(L.CAB_FRONT.rect, 0.45, fade='down', dust=0.25)
    wx.mud_band(L.BOX_REAR.rect, 0.6, fade='down', dust=0.3)
    wx.mud_band(L.BOX_ROOF.rect, 0.15, fade=None, spatter=False)
    wx.mud_band(L.CAB_ROOF.rect, 0.15, fade=None, spatter=False)
    # rust: plate bottoms + logged bolts; hinge streaks on the rear doors
    wx.plate_bottom_rust(L.BOX_SIDE.rect, n=8, strength=0.6)
    wx.plate_bottom_rust(L.CAB_SIDE.rect, n=5, strength=0.5)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.5)
    rz = L.BOX_REAR
    for s in (1.14, -1.14):
        bx = rz.uv((s, 0, 0))[0] * W
        by = rz.uv((0, 2.0, 0))[1] * W
        wx.rust_streak(bx, by, 30, width=2.4, strength=0.4)
    # oil on the chassis cell, soot at the stack tip (u right = tip)
    wx.oily(L.DARK.rect, 0.45)
    ex0, ey0, ex1, ey1 = L.EXH
    wx.soot_patch((ex0 + (ex1 - ex0) * 0.55, ey0, ex1, ey1), 0.6,
                  fade='right')
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    zone = L.BOX_SIDE
    pb = [zone.uv((0, 0, -1.3))[0] * W, zone.uv((0, 2.725, 0))[1] * W,
          zone.uv((0, 0, 3.2))[0] * W, zone.uv((0, 1.475, 0))[1] * W]
    hm.rect(pb, 0.35)                              # applique plates proud
    rz = L.BOX_REAR
    hm.rect(nbox(rz.uv((1.1, 0, 0))[0] * W, rz.uv((0, 2.95, 0))[1] * W,
                 rz.uv((-1.1, 0, 0))[0] * W, rz.uv((0, 1.1, 0))[1] * W), 0.22)
    x0, y0, x1, y1 = L.TARP.rect                   # tarp cinch straps bite
    for fx in np.linspace(0.15, 0.85, 5):
        hm.line((x0 + (x1 - x0) * fx, y0 + 2), (x0 + (x1 - x0) * fx, y1 - 2),
                -0.4, width=3)
    hm.crevices_from(m.dif, 0.55)
    hm.bolts_from(BOLT_LOG, 0.5)
    hm.weather_from(wx)
    hm.to_normal_image(strength=4.2).save(f'out/{STEM}_normals.png')

    m.emi = m.emi.filter(ImageFilter.GaussianBlur(0.6))
    m.dif.save(f'out/{STEM}_diffuse.png')
    m.orm.save(f'out/{STEM}_orm.png')
    m.emi.save(f'out/{STEM}_emissive.png')
    m.tea.save(f'out/{STEM}_team.png')
    print(f'[paint_{STEM}] full 1024 texture set written to out/')


if __name__ == '__main__':
    paint_all()
