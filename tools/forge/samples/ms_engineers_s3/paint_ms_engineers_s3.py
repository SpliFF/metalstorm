"""paint_ms_engineers_s3 — 1024² PBR set for the engineers-s3 works rig.

Carries the engineer family read (hi-vis orange over olive-drab, hazard
chevrons, tool clutter) from ms_engineers_s4's crawler onto the s3 rig, so a
mixed engineer force reads as one family at strategic zoom. Team colour lives
ONLY in the team-mask R channel (cab door panel, hull ID square). Emissive is
warm/amber only: floodlights, the roof beacon, the cab instrument glow.
Finished through paintlib.finish — paint.enrich's multi-scale mottle runs over
the flat fills (the blue-grey blandness fix) and all five maps are written.
"""
from __future__ import annotations
import numpy as np

import ms_engineers_s3_layout as L
import paint as P
from paint import (Maps, fill, seam_h, seam_v, bolts, wear_edges, jit, shade,
                   BOLT_LOG, ARMOR, ARMOR_DK, LOWER, STEEL, STEEL_DK, GLASS,
                   YELLOW, BLACKISH, TRACK_MET, OXIDE, KHAKI, CANVAS,
                   AO_BASE, AO_SEAM, AO_DEEP, R_ARMOR, R_STEEL, R_RUBBER,
                   M_ARMOR, M_STEEL, M_TRACK)
import paintlib as PL

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_engineers_s3'

HIVIS   = (206, 108, 34)      # hi-vis orange — the engineer family's trim
HIVIS_D = (166, 84, 26)
DECK_C  = (86, 84, 72)        # deck chequer plate
BOTTLE_C = (92, 106, 96)      # industrial gas bottle green
AMBER   = (255, 176, 74)


def hivis_band(m, zone, y0, y1, along=(-99, 99)):
    """A hi-vis stripe across a zone, in that zone's world coords."""
    u, v = PL.zone_fns(zone)
    box = PL.nbox(max(u(along[0]), zone.rect[0]), v(y0),
                  min(u(along[1]), zone.rect[2]), v(y1))
    box[0] = max(box[0], zone.rect[0])
    box[2] = min(box[2], zone.rect[2])
    m.d.rectangle(box, fill=jit(HIVIS, 4))
    m.o.rectangle(box, fill=(AO_BASE - 6, R_ARMOR + 10, M_ARMOR))
    m.d.rectangle(box, outline=shade(HIVIS_D, 0.8), width=2)
    return box


def paint_hull(m):
    zone = L.HULL_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    PL.panel_patchwork(m, (x0, y0 + (y1 - y0) * 0.45, x1, y1),
                       [ARMOR, ARMOR_DK, KHAKI, OXIDE], cols=6, rows=2)
    hivis_band(m, zone, 1.50, 1.32)                 # stripe under the deck lip
    u, v = PL.zone_fns(zone)
    for wz in (-1.9, -0.6, 0.7, 2.0):               # frame ribs
        seam_v(m, int(u(wz)), y0 + 4, y1 - 4, ARMOR)
    bolts(m, [(u(wz), v(0.55)) for wz in np.linspace(-2.5, 2.6, 9)], r=2,
          base=ARMOR)
    z0, ty0, z1, ty1 = L.TEAM_HULL                  # hull ID square
    PL.team_panel(m, (u(z0), v(ty0), u(z1), v(ty1)), outline=STEEL_DK,
                  base=(120, 124, 118))
    d = P.font(30)
    m.d.text((u(-2.35), v(1.25)), 'ENG-03', font=d, fill=shade(KHAKI, 1.15))
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 40)

    for zone2 in (L.HULL_FRONT, L.HULL_REAR):
        x0, y0, x1, y1 = zone2.rect
        fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8, rough=R_ARMOR,
             metal=M_ARMOR)
        u2, v2 = PL.zone_fns(zone2)
        seam_h(m, x0 + 3, x1 - 3, int(v2(0.95)), ARMOR_DK)
        bolts(m, [(u2(wx), v2(0.45)) for wx in (-0.9, -0.3, 0.3, 0.9)], r=2,
              base=ARMOR_DK)
        wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 34)

    zone = L.HULL_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 1.04), ao=AO_BASE - 6,
         rough=R_ARMOR, metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    for wz in (-2.0, -0.4, 1.2, 2.5):
        seam_h(m, x0 + 3, x1 - 3, int(v(wz)), ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 30)


def paint_deck(m):
    """Chequer-plate working deck, scuffed down the middle, hazard-edged."""
    zone = L.DECK
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=DECK_C, ao=AO_BASE - 10, rough=R_ARMOR + 20,
         metal=M_STEEL - 40)
    for gy in range(y0, y1, 12):                    # chequer texture
        off = 6 if (gy // 12) % 2 else 0
        for gx in range(x0 + off, x1, 12):
            m.d.line([(gx, gy), (gx + 5, gy + 5)], fill=shade(DECK_C, 1.16))
            m.d.line([(gx, gy + 5), (gx + 5, gy)], fill=shade(DECK_C, 0.8))
    u, v = PL.zone_fns(zone)
    for wz in (0.25, 2.70):                         # hi-vis deck edges
        m.d.rectangle(PL.nbox(x0, v(wz), x1, v(wz + 0.12)), fill=jit(HIVIS, 4))
    wear_edges(m, (x0, y0, x1, y1), DECK_C, 45)


def paint_cab(m):
    zone = L.CAB_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    PL.glass_rect(m, (u(-2.42), v(2.58), u(-1.72), v(2.02)), outline=STEEL_DK)
    m.e.rectangle(PL.nbox(u(-2.38), v(2.20), u(-1.78), v(2.06)),
                  fill=(120, 74, 26))               # instrument glow
    z0, ty0, z1, ty1 = L.TEAM_CAB                   # door panel
    PL.team_panel(m, (u(z0), v(ty0), u(z1), v(ty1)), outline=STEEL_DK,
                  base=(120, 124, 118))
    hivis_band(m, zone, 1.60, 1.44)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 36)

    zone = L.CAB_FRONT
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR, ao=AO_BASE - 6, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    PL.glass_rect(m, (u(-0.74), v(2.62), u(0.74), v(1.92)), outline=STEEL_DK)
    for wx in (-0.30, 0.30):                        # wiper arms
        m.d.line([(u(wx), v(1.96)), (u(wx + 0.22), v(2.34))],
                 fill=STEEL_DK, width=3)
    hivis_band(m, zone, 1.80, 1.62)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 34)

    zone = L.CAB_REAR
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    PL.glass_rect(m, (u(-0.52), v(2.58), u(0.52), v(2.12)), outline=STEEL_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 30)

    zone = L.CAB_TOP
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=shade(ARMOR, 1.06), ao=AO_BASE - 6,
         rough=R_ARMOR, metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    # hi-vis roof marking kept OFF the zone centre: the impostor baker
    # flat-shades a face from its UV centroid, and a patch over the middle
    # of this big single-quad cell floods the whole cab roof orange.
    m.d.rectangle(PL.nbox(u(-0.80), v(-2.50), u(0.80), v(-2.30)),
                  fill=jit(HIVIS, 4), outline=shade(HIVIS_D, 0.8))
    bolts(m, [(u(wx), v(-2.40)) for wx in (-0.6, 0.0, 0.6)], r=2, base=ARMOR)
    wear_edges(m, (x0, y0, x1, y1), ARMOR, 28)


def paint_tracks(m):
    zone = L.TRACK_SIDE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_DK, ao=AO_BASE - 14, rough=R_STEEL,
         metal=M_TRACK)
    u, v = PL.zone_fns(zone)
    for wz in np.linspace(-2.1, 2.3, 6):            # road wheels, painted
        cx, cy = u(wz), v(0.46)
        r = 26
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=shade(TRACK_MET, 0.9),
                    outline=shade(TRACK_MET, 0.6), width=3)
        m.d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=STEEL_DK)
        bolts(m, [(cx + np.cos(a) * 15, cy + np.sin(a) * 15)
                  for a in np.linspace(0.3, 2 * np.pi + 0.3, 6, endpoint=False)],
              r=2, base=TRACK_MET)
    wear_edges(m, (x0, y0, x1, y1), STEEL_DK, 44)

    x0, y0, x1, y1 = L.TRACK_WRAP                   # track-plate wrap
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_BASE - 18, rough=R_RUBBER,
         metal=M_TRACK)
    for gx in range(x0, x1, 9):
        m.d.line([(gx, y0), (gx, y1)], fill=shade(TRACK_MET, 0.62), width=3)
        m.d.line([(gx + 4, y0), (gx + 4, y1)], fill=shade(TRACK_MET, 1.2))

    zone = L.FENDER
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK, ao=AO_BASE - 10, rough=R_ARMOR,
         metal=M_ARMOR)
    u, v = PL.zone_fns(zone)
    for wz in np.linspace(-2.3, 2.4, 7):
        seam_h(m, x0 + 2, x1 - 2, int(u(wz)) if False else int(v(0)), ARMOR_DK,
               hi=False)
        seam_v(m, int(u(wz)), y0 + 2, y1 - 2, ARMOR_DK, hi=False)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)


def paint_blade_and_cells(m):
    zone = L.BLADE_F                                # blade face: worn steel
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL, ao=AO_BASE - 8, rough=110,
         metal=M_STEEL + 40)
    u, v = PL.zone_fns(zone)
    m.d.rectangle(PL.nbox(x0, v(0.35), x1, v(0.05)),
                  fill=shade(STEEL, 1.35))          # polished cutting edge
    for wx in np.linspace(-1.25, 1.25, 7):          # bolt row on the mouldboard
        bolts(m, [(u(wx), v(0.72))], r=3, base=STEEL)
    hivis_band(m, zone, 1.06, 0.92)
    wear_edges(m, (x0, y0, x1, y1), STEEL, 60)

    x0, y0, x1, y1 = L.BLADE_T.rect                 # blade top/back edges
    fill(m, (x0, y0, x1, y1), dif=shade(STEEL, 0.86), ao=AO_BASE - 10,
         rough=130, metal=M_STEEL)

    x0, y0, x1, y1 = L.HAZARD.rect                  # chevrons, blade rear
    step = 26
    for i in range(int((x1 - x0) / step) + 1):
        m.d.polygon([(x0 + i * step, y1), (x0 + i * step + step * 0.5, y1),
                     (x0 + i * step + step, y0), (x0 + i * step + step * 0.5, y0)],
                    fill=YELLOW if i % 2 == 0 else BLACKISH)
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 6, 150, 60))

    x0, y0, x1, y1 = L.BOTTLE                       # gas bottles
    fill(m, (x0, y0, x1, y1), dif=BOTTLE_C, ao=AO_BASE - 8, rough=140,
         metal=M_STEEL)
    m.d.rectangle([x0, y0, x1, y0 + (y1 - y0) * 0.16], fill=jit(HIVIS, 4))
    m.d.rectangle([x0, y1 - (y1 - y0) * 0.10, x1, y1],
                  fill=shade(BOTTLE_C, 0.6))
    for gx in range(x0, x1, 16):
        m.d.line([(gx, y0), (gx, y1)], fill=shade(BOTTLE_C, 0.84))

    x0, y0, x1, y1 = L.CRATE_S.rect                 # timber crates
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 10, rough=228, metal=0)
    for gy in range(y0, y1, 14):
        m.d.line([(x0, gy), (x1, gy)], fill=shade(CANVAS, 0.8), width=2)
    m.d.line([(x0, y0), (x1, y1)], fill=shade(CANVAS, 0.74), width=3)
    x0, y0, x1, y1 = L.CRATE_T.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CANVAS, 1.08), ao=AO_BASE - 8,
         rough=228, metal=0)
    for gy in range(y0, y1, 16):
        m.d.line([(x0, gy), (x1, gy)], fill=shade(CANVAS, 0.82), width=2)

    for zone2, tone in ((L.BIN_S, KHAKI), (L.BIN_T, shade(KHAKI, 1.08))):
        x0, y0, x1, y1 = zone2.rect                 # tool bin / bench
        fill(m, (x0, y0, x1, y1), dif=tone, ao=AO_BASE - 8, rough=R_ARMOR + 20,
             metal=M_ARMOR)
        seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, tone, hi=False)
        bolts(m, [(x0 + 8, y0 + 8), (x1 - 8, y0 + 8), (x0 + 8, y1 - 8),
                  (x1 - 8, y1 - 8)], r=2, base=tone)

    for rect in (L.MAST, L.TRIM):                   # jib legs, small parts
        x0, y0, x1, y1 = rect
        fill(m, (x0, y0, x1, y1), dif=jit(HIVIS, 3), ao=AO_BASE - 8,
             rough=R_ARMOR, metal=M_ARMOR)
        for gy in range(y0 + 10, y1, 28):           # black bands up the legs
            m.d.rectangle([x0, gy, x1, gy + 9], fill=BLACKISH)

    x0, y0, x1, y1 = L.LIGHT.rect                   # lamp / beacon glass
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_SEAM, rough=60, metal=0)
    m.e.rectangle([x0 + 4, y0 + 4, x1 - 4, y1 - 4], fill=AMBER)
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=ARMOR, ao=AO_BASE - 8, rough=R_ARMOR,
         metal=M_ARMOR)
    paint_hull(m)
    paint_deck(m)
    paint_cab(m)
    paint_tracks(m)
    paint_blade_and_cells(m)

    # a works rig lives in spoil: mud up the running gear, dust down the hull
    wx = PL.standard_weather(m, L,
                             ground_rects=(L.TRACK_WRAP, L.TRACK_SIDE.rect),
                             side_zones=(L.HULL_SIDE, L.CAB_SIDE, L.BLADE_F),
                             seed=90210, mud=0.6, grime=0.5, rust_fraction=0.5)
    wx.mud_band(L.FENDER.rect, 0.5, fade=None)
    wx.mud_band(L.DECK.rect, 0.35, fade=None, spatter=True)
    wx.mud_band(L.BLADE_F.rect, 0.65, fade='down')
    wx.oily(L.BIN_S.rect, 0.3)
    zx0, zy0, zx1, _ = L.HULL_SIDE.rect
    for fx in np.linspace(0.1, 0.9, 8):
        wx.rust_streak(zx0 + (zx1 - zx0) * fx, zy0 + 20,
                       int(RNG.uniform(16, 34)), width=2.2, strength=0.35)

    from normals import HeightMap
    hm = HeightMap()
    u, v = PL.zone_fns(L.HULL_SIDE)
    hm.rect(PL.nbox(zx0, v(1.50), zx1, v(1.32)), 0.3)      # hi-vis stripe lip
    for gx in range(L.TRACK_WRAP[0], L.TRACK_WRAP[2], 9):  # track plates
        hm.line((gx, L.TRACK_WRAP[1]), (gx, L.TRACK_WRAP[3]), 0.4, width=3)
    hm.rect(L.DECK.rect, 0.12)

    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
