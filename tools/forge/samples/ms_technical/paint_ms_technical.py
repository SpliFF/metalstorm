"""paint_ms_technical — 1024² PBR set for ms_technical.

Anarchic scrap register: sun-bleached ochre civilian body under
mismatched bolted plates (rust-red, grey-blue, bare gunmetal), crude
weld beads, hand-slit visor glazing, one working headlight (the other
smashed dark), rust blotches breaking through the paint, sooty
exhaust, oily chassis.  NOT formal or uniform — panel colours clash on
purpose and left/right dressing differs.  Team colour ONLY in the team
mask R channel: a resprayed door panel each side + the rag pennant.
Emissive: single warm headlight lamp.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageFilter

import ms_technical_layout as L         # sets meshlib.ATLAS = 1024
import paint as P
P.W = 1024
import weathering
weathering.W = 1024
import normals as NM
NM.W = 1024

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   GLASS, BLACKISH, TEAMGREY, RUBBER, TRACK_MET,
                   STEEL, STEEL_DK,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)

W = 1024
STEM = 'ms_technical'

# ── anarchic palette (sRGB) — clashing on purpose ────────────────────────
OCHRE    = (146, 122, 82)      # bleached body paint
OCHRE_DK = (116, 97, 65)
RUSTRED  = (118, 60, 42)       # scrap plate A
GREYBLUE = (84, 94, 106)       # scrap plate B
GUNMETAL = (108, 105, 98)      # scrap plate C (bare)
RUST     = (96, 52, 30)        # break-through rust blotches
WELD     = (72, 66, 58)        # weld-bead lines
LAMP     = (232, 210, 160)     # warm headlight
TAIL_RED = (140, 32, 24)
WOOD     = (110, 88, 60)       # crate slats


def nbox(x0, y0, x1, y1):
    """Normalised pixel rect — flipped-u zones may hand coords either way."""
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def rust_blotches(m, rect, n, rmin=6, rmax=22):
    """Paint break-through rust blobs (irregular overlapped ellipses)."""
    x0, y0, x1, y1 = rect
    for _ in range(n):
        cx = RNG.uniform(x0 + rmax, x1 - rmax)
        cy = RNG.uniform(y0 + rmax, y1 - rmax)
        for _ in range(3):
            rr = RNG.uniform(rmin, rmax)
            ox, oy = RNG.uniform(-6, 6), RNG.uniform(-6, 6)
            m.d.ellipse([cx + ox - rr, cy + oy - rr * 0.7,
                         cx + ox + rr, cy + oy + rr * 0.7],
                        fill=jit(RUST, 8))
        m.o.rectangle([cx - 4, cy - 4, cx + 4, cy + 4],
                      fill=(AO_BASE - 20, 230, 20))


def weld_line(m, a, b, width=3):
    m.d.line([a, b], fill=WELD, width=width)


def paint_cab_side(m):
    zone = L.CAB_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=OCHRE, ao=AO_BASE - 4, rough=R_ARMOR + 14,
         metal=35)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # hood/cab panel seam + wheel-arch shadow + sill band
    seam_v(m, int(u(-1.25)), int(v(1.30)), int(v(0.45)), OCHRE)
    m.d.rectangle([x0, v(0.55), x1, y1], fill=shade(OCHRE_DK, 0.72))
    m.o.rectangle([x0, v(0.55), x1, y1], fill=(AO_BASE - 35, R_ARMOR, 25))
    # hood side louvres (hacked-in cooling slits)
    gb = nbox(u(-2.25), v(1.12), u(-1.55), v(0.80))
    vent_slots(m, [gb[0] + 2, gb[1] + 2, gb[2] - 2, gb[3] - 2], 4)
    # slit side window (armoured glass strip)
    wb = nbox(u(-1.18), v(1.66), u(-0.70), v(1.42))
    m.d.rectangle(wb, fill=GLASS)
    m.o.rectangle(wb, fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.rectangle(wb, outline=WELD, width=2)
    # door seam + crude handle
    seam_v(m, int(u(-0.42)), int(v(1.62)), int(v(0.58)), OCHRE)
    m.d.rectangle([u(-0.60), v(1.18), u(-0.46), v(1.12)], fill=STEEL_DK)
    # resprayed door panel — TEAM (mask R), grey base in diffuse
    tp = nbox(u(-1.05), v(1.30), u(-0.50), v(0.66))
    m.t.rectangle(tp, fill=(255, 0, 0))
    m.d.rectangle(tp, fill=TEAMGREY)
    m.d.rectangle(tp, outline=shade(OCHRE_DK, 0.6), width=2)
    # weld beads where the scrap was tacked on + bolts along the arch line
    weld_line(m, (u(-2.4), v(1.30)), (u(-1.3), v(1.30)))
    bolts(m, [(u(-2.30 + i * 0.28), v(1.36)) for i in range(5)], base=OCHRE)
    rust_blotches(m, (x0 + 6, y0 + 6, x1 - 6, int(v(0.5))), 7)
    wear_edges(m, (x0, y0, x1, y1), OCHRE, 45)


def paint_bed_side(m):
    zone = L.BED_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=jit(OCHRE, 4), ao=AO_BASE - 5,
         rough=R_ARMOR + 16, metal=35)

    def u(wz):
        return zone.uv((0, 0, wz))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # bed wall top rail + plank seams + sill shadow
    seam_h(m, x0 + 3, x1 - 3, int(v(1.34)), OCHRE)
    for wz in (0.45, 1.05, 1.75):
        seam_v(m, int(u(wz)), int(v(1.34)), int(v(0.92)), OCHRE)
    m.d.rectangle([x0, v(0.55), x1, y1], fill=shade(OCHRE_DK, 0.72))
    m.o.rectangle([x0, v(0.55), x1, y1], fill=(AO_BASE - 35, R_ARMOR, 25))
    # a replaced panel that never got repainted (mismatch read)
    pb = nbox(u(1.30), v(0.90), u(2.05), v(0.58))
    m.d.rectangle(pb, fill=jit(GREYBLUE, 5))
    m.d.rectangle(pb, outline=WELD, width=2)
    # weld tacks along the wall base + bolts on the top rail
    weld_line(m, (u(-0.05), v(0.94)), (u(2.40), v(0.94)))
    bolts(m, [(u(0.05 + i * 0.4), v(1.28)) for i in range(6)], base=OCHRE)
    rust_blotches(m, (x0 + 6, y0 + 6, x1 - 6, int(v(0.5))), 9)
    wear_edges(m, (x0, y0, x1, y1), OCHRE, 50)


def paint_front(m):
    zone = L.FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=OCHRE, ao=AO_BASE - 5, rough=R_ARMOR + 12,
         metal=35)

    def uu(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # windscreen slit under the visor plate (welded frame)
    wb = nbox(uu(-0.55), v(1.52), uu(0.55), v(1.36))
    m.d.rectangle(wb, fill=GLASS)
    m.o.rectangle(wb, fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.rectangle(wb, outline=WELD, width=3)
    # crude cut grille slits
    gb = nbox(uu(-0.55), v(1.02), uu(0.55), v(0.72))
    m.d.rectangle(gb, fill=STEEL_DK)
    vent_slots(m, [gb[0] + 3, gb[1] + 3, gb[2] - 3, gb[3] - 3], 5)
    # headlights: right one works (emissive), left one smashed dark
    hbR = nbox(uu(0.62), v(1.02), uu(0.82), v(0.84))
    m.d.rectangle(hbR, fill=GLASS)
    m.e.rectangle(nbox(uu(0.65), v(0.99), uu(0.79), v(0.87)), fill=LAMP)
    m.o.rectangle(hbR, fill=(AO_SEAM, R_GLASS, M_GLASS))
    hbL = nbox(uu(-0.82), v(1.02), uu(-0.62), v(0.84))
    m.d.rectangle(hbL, fill=(30, 28, 26))
    m.o.rectangle(hbL, fill=(AO_DEEP, 220, 30))
    # lower band + weld beads
    m.d.rectangle([x0, v(0.55), x1, y1], fill=shade(OCHRE_DK, 0.7))
    weld_line(m, (x0 + 4, v(1.30)), (x1 - 4, v(1.30)))
    rust_blotches(m, (x0 + 6, int(v(0.7)), x1 - 6, y1 - 4), 5)
    wear_edges(m, (x0, y0, x1, y1), OCHRE, 45)


def paint_rear(m):
    zone = L.REAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=jit(OCHRE, 3), ao=AO_BASE - 5,
         rough=R_ARMOR + 16, metal=35)

    def uu(wx):
        return zone.uv((wx, 0, 0))[0] * W

    def v(wy):
        return zone.uv((0, wy, 0))[1] * W

    # tailgate outline + crude painted X mark (mirror-safe, non-team)
    tg = nbox(uu(-0.78), v(1.32), uu(0.78), v(0.94))
    m.d.rectangle(tg, outline=WELD, width=2)
    for (a, b) in (((tg[0] + 14, tg[1] + 6), (tg[2] - 14, tg[3] - 6)),
                   ((tg[0] + 14, tg[3] - 6), (tg[2] - 14, tg[1] + 6))):
        m.d.line([a, b], fill=jit(RUSTRED, 6), width=6)
    # chain latches
    for s in (-0.72, 0.72):
        m.d.rectangle(nbox(uu(s - 0.04), v(1.34), uu(s + 0.04), v(0.92)),
                      fill=STEEL_DK)
    # one surviving taillight (left), bare bracket right
    m.d.rectangle(nbox(uu(-0.70), v(0.58), uu(-0.54), v(0.48)),
                  fill=(52, 22, 20))
    m.e.rectangle(nbox(uu(-0.67), v(0.56), uu(-0.57), v(0.50)), fill=TAIL_RED)
    m.d.rectangle(nbox(uu(0.54), v(0.58), uu(0.70), v(0.48)), fill=STEEL_DK)
    m.d.rectangle([x0, v(0.42), x1, y1], fill=shade(OCHRE_DK, 0.65))
    rust_blotches(m, (x0 + 6, y0 + 6, x1 - 6, y1 - 6), 7)
    wear_edges(m, (x0, y0, x1, y1), OCHRE, 55)


def paint_tops(m):
    # hood top: bleached paint, big rust break-through, weld seam
    zone = L.HOOD_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OCHRE, 1.04), ao=AO_BASE - 4,
         rough=R_ARMOR + 18, metal=30)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, OCHRE, hi=False)
    weld_line(m, (x0 + 8, y0 + 20), (x1 - 8, y0 + 20))
    rust_blotches(m, (x0 + 8, y0 + 8, x1 - 8, y1 - 8), 8, rmax=26)
    wear_edges(m, (x0, y0, x1, y1), OCHRE, 40)

    # cab roof: sun-bleached, patched corner
    zone = L.CAB_ROOF
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OCHRE, 1.06), ao=AO_BASE - 4,
         rough=R_ARMOR + 16, metal=30)
    pb = [x0 + 12, y0 + 12, x0 + 78, y0 + 70]
    m.d.rectangle(pb, fill=jit(GUNMETAL, 5))
    m.d.rectangle(pb, outline=WELD, width=2)
    rust_blotches(m, (x0 + 8, y0 + 8, x1 - 8, y1 - 8), 4)
    wear_edges(m, (x0, y0, x1, y1), OCHRE, 35)

    # bed floor: worn deck planks, oil stains, scuffed steel
    zone = L.BED_FLOOR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(OCHRE_DK, 0.85), ao=AO_BASE - 14,
         rough=R_ARMOR + 24, metal=45)
    for fy in np.linspace(0.18, 0.82, 4):
        gy = int(y0 + (y1 - y0) * fy)
        seam_h(m, x0 + 3, x1 - 3, gy, shade(OCHRE_DK, 0.85), hi=False)
    rust_blotches(m, (x0 + 8, y0 + 8, x1 - 8, y1 - 8), 10, rmax=18)
    wear_edges(m, (x0, y0, x1, y1), OCHRE_DK, 60)


def paint_scrap_cells(m):
    """Mismatched plate cells: each a different salvage colour, bolted."""
    for zone, col, met in ((L.SCRAP_A, RUSTRED, 60),
                          (L.SCRAP_B, GREYBLUE, 70),
                          (L.SCRAP_C, GUNMETAL, 150)):
        x0, y0, x1, y1 = zone.rect
        fill(m, (x0, y0, x1, y1), dif=col, ao=AO_BASE - 6,
             rough=R_ARMOR + 10, metal=met)
        m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], outline=WELD,
                      width=3)
        bolts(m, [(x0 + 14 + i * (x1 - x0 - 28) / 3, y0 + 12)
                  for i in range(4)], base=col)
        bolts(m, [(x0 + 14 + i * (x1 - x0 - 28) / 3, y1 - 12)
                  for i in range(4)], base=col)
        rust_blotches(m, (x0 + 8, y0 + 8, x1 - 8, y1 - 8), 4, rmax=14)
        wear_edges(m, (x0, y0, x1, y1), col, 40)


def paint_cells(m):
    # wheels: worn rubber with tread banding
    x0, y0, x1, y1 = L.WHEEL.rect
    fill(m, (x0, y0, x1, y1), dif=RUBBER, ao=AO_BASE - 16, rough=R_RUBBER,
         metal=10)
    for gy in range(y0 + 4, y1 - 2, 10):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(RUBBER, 0.8),
                 width=2)
    # hubs: scavenged steel, 8-fold lug ring (spin-symmetric)
    x0, y0, x1, y1 = L.HUB.rect
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 10, rough=140,
         metal=M_TRACK)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bolts(m, [(cx + np.cos(a) * 15, cy + np.sin(a) * 15)
              for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)],
          base=TRACK_MET)
    # trim: near-black welded steel (ram bar, spikes, pedestal, rails)
    x0, y0, x1, y1 = L.TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_DK, 0.9), ao=AO_BASE - 10,
         rough=R_STEEL + 20, metal=120)
    weld_line(m, (x0 + 4, (y0 + y1) // 2), (x1 - 4, (y0 + y1) // 2))
    wear_edges(m, (x0, y0, x1, y1), STEEL_DK, 35)
    # dark: chassis / undersides / caps
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=205, metal=40)
    # gun: dark gunmetal, hand-stippled receiver seams
    x0, y0, x1, y1 = L.GUN.rect
    fill(m, (x0, y0, x1, y1), dif=shade(GUNMETAL, 0.75), ao=AO_BASE - 8,
         rough=R_STEEL + 10, metal=170)
    seam_h(m, x0 + 4, x1 - 4, y0 + (y1 - y0) // 3, shade(GUNMETAL, 0.75))
    bolts(m, [(x0 + 16 + i * (x1 - x0 - 32) / 4, y1 - 14) for i in range(5)],
          base=shade(GUNMETAL, 0.75))
    wear_edges(m, (x0, y0, x1, y1), shade(GUNMETAL, 0.75), 30)
    # barrel wrap: dark steel, heat-blued then sooty toward the tip
    x0, y0, x1, y1 = L.GUN_BARR
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 12, rough=150,
         metal=190)
    heat = Image.new('RGB', (x1 - x0, y1 - y0), (58, 52, 60))
    grad = Image.new('L', (x1 - x0, 1), 0)
    for gx in range(x1 - x0):
        grad.putpixel((gx, 0), int(120 * (gx / max(1, x1 - x0 - 1)) ** 2.0))
    m.dif.paste(heat, (x0, y0), grad.resize((x1 - x0, y1 - y0)))
    # pole/spike/exhaust wrap: raw dark steel
    x0, y0, x1, y1 = L.POLE
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL_DK, 0.85), ao=AO_BASE - 12,
         rough=170, metal=140)
    # cargo: rough wooden ammo crate with steel strap
    x0, y0, x1, y1 = L.CARGO.rect
    fill(m, (x0, y0, x1, y1), dif=WOOD, ao=AO_BASE - 8, rough=225, metal=8)
    for fy in (0.33, 0.66):
        seam_h(m, x0 + 3, x1 - 3, int(y0 + (y1 - y0) * fy), WOOD, hi=False)
    m.d.rectangle([x0 + (x1 - x0) // 2 - 4, y0 + 3,
                   x0 + (x1 - x0) // 2 + 4, y1 - 3], fill=STEEL_DK)
    # pennant: ragged team-dyed cloth — full cell in the team mask
    x0, y0, x1, y1 = L.PENNANT.rect
    fill(m, (x0, y0, x1, y1), dif=TEAMGREY, ao=AO_BASE - 4, rough=235,
         metal=5)
    m.t.rectangle([x0, y0, x1, y1], fill=(255, 0, 0))
    for gy in range(y0 + 6, y1, 14):        # rag weave/tatter banding
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)],
                 fill=jit(shade(TEAMGREY, 0.88), 5), width=2)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_cab_side(m)
    paint_bed_side(m)
    paint_front(m)
    paint_rear(m)
    paint_tops(m)
    paint_scrap_cells(m)
    paint_cells(m)

    # ── weathering ──
    from weathering import Weather, vertical_rects_of
    wx = Weather(seed=41)
    wx.crevice_grime(m.dif, 0.55)
    wx.mud_band(L.WHEEL.rect, 0.9, fade=None)
    wx.mud_band(L.HUB.rect, 0.55, fade=None)
    wx.mud_band(L.TRIM.rect, 0.5, fade=None)
    wx.mud_band(L.CAB_SIDE.rect, 0.6, fade='down', dust=0.35)
    wx.mud_band(L.BED_SIDE.rect, 0.65, fade='down', dust=0.35)
    wx.mud_band(L.FRONT.rect, 0.55, fade='down', dust=0.3)
    wx.mud_band(L.REAR.rect, 0.65, fade='down', dust=0.35)
    wx.mud_band(L.HOOD_TOP.rect, 0.2, fade=None, spatter=False)
    wx.mud_band(L.CAB_ROOF.rect, 0.15, fade=None, spatter=False)
    wx.mud_band(L.BED_FLOOR.rect, 0.35, fade=None, spatter=False)
    # rust: panel bottoms, logged bolts, streaks under weld lines
    wx.plate_bottom_rust(L.CAB_SIDE.rect, n=6, strength=0.65)
    wx.plate_bottom_rust(L.BED_SIDE.rect, n=8, strength=0.7)
    wx.plate_bottom_rust(L.REAR.rect, n=5, strength=0.6)
    for zr in (L.SCRAP_A, L.SCRAP_B, L.SCRAP_C):
        wx.plate_bottom_rust(zr.rect, n=3, strength=0.6)
    wx.bolt_rust(BOLT_LOG, vertical_rects_of(L), fraction=0.6)
    # oil on the chassis, soot at exhaust/barrel tips (u right = tip)
    wx.oily(L.DARK.rect, 0.5)
    wx.oily(L.BED_FLOOR.rect, 0.3)
    ex0, ey0, ex1, ey1 = L.POLE
    wx.soot_patch((ex0 + (ex1 - ex0) * 0.6, ey0, ex1, ey1), 0.55,
                  fade='right')
    bx0, by0, bx1, by1 = L.GUN_BARR
    wx.soot_patch((bx0 + (bx1 - bx0) * 0.65, by0, bx1, by1), 0.5,
                  fade='right')
    wx.apply(m)

    # ── height → normal map ──
    from normals import HeightMap
    hm = HeightMap()
    for zone in (L.SCRAP_A, L.SCRAP_B, L.SCRAP_C):
        hm.rect([zone.rect[0] + 2, zone.rect[1] + 2,
                 zone.rect[2] - 2, zone.rect[3] - 2], 0.35)
    cz = L.CAB_SIDE                     # door panel proud
    hm.rect(nbox(cz.uv((0, 0, -1.05))[0] * W, cz.uv((0, 1.30, 0))[1] * W,
                 cz.uv((0, 0, -0.50))[0] * W, cz.uv((0, 0.66, 0))[1] * W),
            0.2)
    rz = L.REAR                         # tailgate proud
    hm.rect(nbox(rz.uv((-0.78, 0, 0))[0] * W, rz.uv((0, 1.32, 0))[1] * W,
                 rz.uv((0.78, 0, 0))[0] * W, rz.uv((0, 0.94, 0))[1] * W),
            0.22)
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
