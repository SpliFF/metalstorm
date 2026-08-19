"""paint_ms_engineers_s4 — 2048² PBR set for ms_engineers_s4.

Mobile fabrication platform, ENGINEERS-family s4 read: hi-vis orange
accents + hazard chevrons + tools over patched industrial grey. Warm
emissive only: glazed cab glow, floodlights, amber welding pool in the
open fabrication bay, rotating amber beacon, marker lights. Team colour
as pod-side stripe, cab panel and deck ID square (mask only).
"""
from __future__ import annotations
import os
import numpy as np

import ms_engineers_s4_layout as L    # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, vent_slots, wear_edges,
                   jit, shade, BOLT_LOG,
                   ARMOR, ARMOR_DK, LOWER, STEEL, STEEL_DK, RUBBER, TRACK_MET,
                   GLASS, YELLOW, BLACKISH, TEAMGREY,
                   AO_BASE, AO_SEAM, AO_DEEP,
                   R_ARMOR, R_STEEL, R_RUBBER, R_GLASS,
                   M_ARMOR, M_STEEL, M_TRACK, M_GLASS, RNG)

W = 2048
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
STEM = 'ms_engineers_s4'

DECKG    = (103, 107, 110)
CABG     = (126, 130, 133)
HIVIS    = (222, 122, 26)          # engineering hi-vis orange
HIVIS_D  = (192, 104, 22)
CREAM    = (196, 192, 178)
WOOD     = (118, 100, 72)
CANVAS   = (99, 92, 72)
AMBER    = (255, 165, 45)
WARMGLOW = (235, 180, 105)
WELD     = (255, 160, 55)
LAMPWARM = (250, 215, 150)


def numeral(m, cx, cy, text, size, color=CREAM):
    f = PL.font(size)
    tw = m.d.textlength(text, font=f)
    m.d.text((cx - tw / 2 + 2, cy - size * 0.55 + 2), text, font=f,
             fill=shade(ARMOR_DK, 0.55))
    m.d.text((cx - tw / 2, cy - size * 0.55), text, font=f, fill=color)


# ── deck ────────────────────────────────────────────────────────────────

def paint_deck(m):
    z = L.Z_DECK
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=DECKG)
    u, v = PL.zone_fns(z)
    # plate seams (tone-on-tone; the deck is a huge quad — baker rule)
    for wz in (-8.0, -6.55, -4.6, -2.4, 0.0, 2.8, 4.8, 6.6, 8.4):
        seam_h(m, x0 + 4, x1 - 4, int(v(wz)), DECKG)
    for wx in (-3.4, 0.0, 3.4):
        seam_v(m, int(u(wx)), y0 + 4, y1 - 4, DECKG)
    # walkway strips along both edges
    for wx0, wx1 in ((-5.0, -4.65), (4.65, 5.0)):
        m.d.rectangle(PL.nbox(u(wx0), y0 + 4, u(wx1), y1 - 4),
                      fill=shade(DECKG, 0.92))
    # fabrication bay floor: darker pad + scorch + amber welding pool
    bay = PL.nbox(u(-4.5), v(-4.5), u(4.5), v(2.7))
    m.d.rectangle(bay, fill=shade(DECKG, 0.9))
    m.o.rectangle(bay, fill=(AO_BASE - 15, R_ARMOR + 15, M_ARMOR))
    wu, wv = u(0.3), v(-1.2)
    m.d.ellipse([wu - 44, wv - 52, wu + 44, wv + 52], fill=shade(DECKG, 0.86))
    m.e.ellipse([wu - 26, wv - 30, wu + 26, wv + 30], fill=(120, 66, 18))
    m.e.ellipse([wu - 12, wv - 14, wu + 12, wv + 14], fill=WELD)
    # team ID square (mask only; diffuse held near deck grey)
    sq = PL.nbox(u(3.3), v(-6.3), u(4.6), v(-5.0))
    PL.team_panel(m, sq, outline=DECKG, base=(116, 120, 124))
    numeral(m, (sq[0] + sq[2]) / 2, (sq[1] + sq[3]) / 2 + 12, '04', 34,
            color=shade(DECKG, 0.7))
    # hi-vis dashed tie-down lines beside the bay
    for wx in (-4.55, 4.55):
        for wz in np.arange(-4.2, 2.6, 1.4):
            m.d.rectangle(PL.nbox(u(wx) - 3, v(wz), u(wx) + 3, v(wz + 0.7)),
                          fill=HIVIS_D)
    wear_edges(m, (x0, y0, x1, y1), DECKG, 60)


def paint_deck_edge(m):
    x0, y0, x1, y1 = L.Z_DECK_EDGE.rect
    fill(m, (x0, y0, x1, y1), dif=HIVIS, ao=AO_BASE - 6)
    # tone-on-tone diagonal hatching (band is one long quad)
    for gx in range(x0 + 10, x1 - 6, 46):
        m.d.line([(gx, y1 - 4), (gx + 22, y0 + 4)], fill=HIVIS_D, width=5)
    seam_h(m, x0 + 2, x1 - 2, y0 + 3, HIVIS)
    bolts(m, [(x0 + 20 + i * ((x1 - x0 - 40) / 15), (y0 + y1) // 2)
              for i in range(16)], base=HIVIS)


def paint_hull_end(m):
    z = L.Z_HULL_END
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=ARMOR_DK)
    u, v = PL.zone_fns(z)
    # radiator grille between the pods (held near the base tone so the
    # belly end faces don't flood dark at their UV centroid in the bake)
    gr = PL.nbox(u(-1.8), v(2.7), u(1.8), v(1.3))
    m.d.rectangle(gr, fill=shade(ARMOR_DK, 0.9))
    for gy in range(int(gr[1]) + 10, int(gr[3]) - 6, 16):
        m.d.line([(gr[0] + 8, gy), (gr[2] - 8, gy)],
                 fill=shade(ARMOR_DK, 0.72), width=4)
    # hazard chevron band along the deck fascia
    PL.hazard_band(m, PL.nbox(x0 + 4, v(3.28), x1 - 4, v(3.02)), step=26)
    # marker lights (warm) at the outer corners
    for wx in (-4.6, 4.6):
        PL.headlight(m, PL.nbox(u(wx) - 14, v(2.5), u(wx) + 14, v(2.2)),
                     lamp=LAMPWARM)
    # tow lugs
    for wx in (-2.6, 2.6):
        m.d.rectangle(PL.nbox(u(wx) - 12, v(1.15), u(wx) + 12, v(0.85)),
                      fill=STEEL_DK)
        m.d.ellipse([u(wx) - 6, v(1.08), u(wx) + 6, v(0.94)], fill=BLACKISH)
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 9), y0 + 10)
              for i in range(10)], base=ARMOR_DK)
    wear_edges(m, (x0, y0, x1, y1), ARMOR_DK, 40)


def paint_belly(m):
    x0, y0, x1, y1 = L.Z_BELLY.rect
    fill(m, (x0, y0, x1, y1), dif=shade(LOWER, 0.85), ao=AO_BASE - 30,
         rough=210, metal=60)
    for gx in range(x0 + 40, x1 - 20, 120):
        seam_v(m, gx, y0 + 3, y1 - 3, shade(LOWER, 0.85))


# ── track pods ──────────────────────────────────────────────────────────

def paint_pod_side(m):
    z = L.Z_POD_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(92, 95, 98), ao=AO_BASE - 12)
    u, v = PL.zone_fns(z)
    # upper structural band + hi-vis chevron strip at the top edge
    m.d.rectangle([x0, y0, x1, int(v(2.55))], fill=ARMOR_DK)
    m.o.rectangle([x0, y0, x1, int(v(2.55))], fill=(AO_BASE, R_ARMOR, M_ARMOR))
    for i in range(7):
        sx = x0 + (x1 - x0) * (i + 1) / 8.0
        seam_v(m, int(sx), y0 + 2, int(v(2.55)), ARMOR_DK)
    # drive sprockets (texture-suggested) at both ends
    for wz, rr in ((-8.3, 1.15), (8.3, 1.15)):
        cx, cy = u(wz), v(1.35)
        r = u(wz + rr) - u(wz)
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=TRACK_MET)
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r],
                    fill=(AO_SEAM, R_STEEL, M_TRACK))
        for k in range(8):
            a = k * np.pi / 4
            m.d.ellipse([cx + np.cos(a) * r * 0.62 - 5,
                         cy + np.sin(a) * r * 0.62 * 0.9 - 5,
                         cx + np.cos(a) * r * 0.62 + 5,
                         cy + np.sin(a) * r * 0.62 * 0.9 + 5], fill=BLACKISH)
        m.d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=STEEL_DK)
    # road wheels
    for wz in np.arange(-6.0, 6.1, 1.7):
        cx, cy = u(wz), v(0.85)
        r = u(wz + 0.72) - u(wz)
        m.d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RUBBER)
        r2 = r * 0.62
        m.d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2],
                    fill=jit(TRACK_MET, 3))
        m.o.ellipse([cx - r, cy - r, cx + r, cy + r],
                    fill=(AO_DEEP, R_RUBBER, 30))
        for k in range(6):
            a = k * np.pi / 3 + 0.2
            bolts(m, [(cx + np.cos(a) * r2 * 0.55,
                       cy + np.sin(a) * r2 * 0.55)], r=3, base=TRACK_MET)
    # team stripe on the upper band, forward
    PL.team_panel(m, PL.nbox(u(-7.0), v(2.95), u(-4.6), v(2.6)),
                  outline=ARMOR_DK, base=(120, 124, 128))
    wear_edges(m, (x0, y0, x1, int(v(2.55))), ARMOR_DK, 45)


def paint_pod_wrap(m):
    x0, y0, x1, y1 = L.Z_POD_WRAP
    fill(m, (x0, y0, x1, y1), dif=TRACK_MET, ao=AO_SEAM, rough=R_RUBBER,
         metal=M_TRACK)
    n = 64
    for i in range(n):
        lx = x0 + (x1 - x0) * i / n
        lw = (x1 - x0) / n
        m.d.rectangle([lx + 1, y0, lx + lw - 1, y1], fill=jit(TRACK_MET, 5))
        m.d.line([(lx, y0), (lx, y1)], fill=BLACKISH, width=3)
        m.d.rectangle([lx + lw * 0.38, y0 + 3, lx + lw * 0.62, y1 - 3],
                      fill=RUBBER)


# ── crew cab ────────────────────────────────────────────────────────────

def paint_cab_side(m):
    z = L.Z_CAB_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CABG)
    u, v = PL.zone_fns(z)
    # hi-vis skirt band
    m.d.rectangle(PL.nbox(x0 + 2, v(4.15), x1 - 2, y1 - 2), fill=HIVIS)
    for gx in range(x0 + 8, x1 - 8, 40):
        m.d.line([(gx, int(v(3.35))), (gx + 18, int(v(4.1)))],
                 fill=HIVIS_D, width=4)
    # side window strip (warm glow)
    win = PL.nbox(u(-9.2), v(6.9), u(-7.5), v(6.1))
    PL.glass_rect(m, win, outline=CABG)
    m.e.rectangle([win[0] + 5, win[1] + 5, win[2] - 5, win[3] - 5],
                  fill=(120, 88, 48))
    # crew door aft
    door = PL.nbox(u(-7.35), v(6.2), u(-6.75), v(3.6))
    m.d.rectangle(door, outline=shade(CABG, 0.55), width=3)
    m.d.rectangle([door[0] + 8, door[1] + 10, door[2] - 8, door[1] + 44],
                  fill=GLASS)
    m.o.rectangle([door[0] + 8, door[1] + 10, door[2] - 8, door[1] + 44],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    m.d.rectangle([door[0] + 6, (door[1] + door[3]) / 2 - 4, door[0] + 20,
                   (door[1] + door[3]) / 2 + 4], fill=STEEL_DK)
    # unit lettering + team square
    numeral(m, u(-8.35), v(5.35), 'ENG-04', 46)
    PL.team_panel(m, PL.nbox(u(-9.25), v(4.9), u(-8.55), v(4.35)),
                  outline=CABG, base=(138, 142, 146))
    # panel seams + bolts
    seam_v(m, int(u(-7.45)), y0 + 4, int(v(4.2)), CABG)
    bolts(m, [(x0 + 10 + i * ((x1 - x0 - 20) / 7), y0 + 10)
              for i in range(8)], base=CABG)
    wear_edges(m, (x0, y0, x1, y1), CABG, 35)


def paint_cab_front(m):
    z = L.Z_CAB_FRONT
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CABG)
    u, v = PL.zone_fns(z)
    # twin windshield panes with warm interior glow
    for wx0, wx1 in ((-3.0, -0.3), (0.3, 3.0)):
        pane = PL.nbox(u(wx0), v(7.0), u(wx1), v(5.6))
        PL.glass_rect(m, pane, outline=CABG)
        m.e.rectangle([pane[0] + 6, pane[1] + 6, pane[2] - 6, pane[3] - 6],
                      fill=WARMGLOW)
    # centre mullion + grab rails
    seam_v(m, int(u(0)), int(v(7.05)), int(v(5.5)), CABG)
    # headlights
    for wx in (-2.5, 2.5):
        PL.headlight(m, PL.nbox(u(wx) - 20, v(4.75), u(wx) + 20, v(4.35)),
                     lamp=LAMPWARM)
    # grille
    gr = PL.nbox(u(-1.2), v(5.0), u(1.2), v(4.3))
    m.d.rectangle(gr, fill=STEEL_DK)
    vent_slots(m, [gr[0] + 6, gr[1] + 6, gr[2] - 6, gr[3] - 6], 4)
    # hi-vis chevron bumper band
    PL.hazard_band(m, PL.nbox(x0 + 4, v(4.0), x1 - 4, v(3.4)), step=30)
    wear_edges(m, (x0, y0, x1, y1), CABG, 35)


def paint_cab_rear(m):
    z = L.Z_CAB_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=CABG)
    u, v = PL.zone_fns(z)
    door = PL.nbox(u(-0.5), v(6.4), u(0.5), v(3.5))
    m.d.rectangle(door, outline=shade(CABG, 0.55), width=3)
    m.d.rectangle([door[0] + 8, door[1] + 8, door[2] - 8, door[1] + 36],
                  fill=GLASS)
    m.o.rectangle([door[0] + 8, door[1] + 8, door[2] - 8, door[1] + 36],
                  fill=(AO_BASE, R_GLASS, M_GLASS))
    numeral(m, u(2.1), v(5.6), 'ENG-04', 34)
    # cabin vents
    vr = PL.nbox(u(-3.0), v(6.6), u(-1.4), v(5.9))
    m.d.rectangle(vr, fill=STEEL_DK)
    vent_slots(m, [vr[0] + 6, vr[1] + 6, vr[2] - 6, vr[3] - 6], 4)
    m.d.rectangle(PL.nbox(x0 + 2, v(4.0), x1 - 2, y1 - 2), fill=HIVIS)
    wear_edges(m, (x0, y0, x1, y1), CABG, 30)


def paint_cab_top(m):
    z = L.Z_CAB_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=shade(CABG, 0.96))
    u, v = PL.zone_fns(z)
    for wz in (-9.0, -8.2, -7.4):
        seam_h(m, x0 + 4, x1 - 4, int(v(wz)), CABG)
    # roof hatch
    m.d.rectangle(PL.nbox(u(-0.4), v(-8.4), u(0.4), v(-7.6)),
                  outline=shade(CABG, 0.6), width=3)
    # hi-vis perimeter
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y0 + 10], fill=HIVIS_D)
    m.d.rectangle([x0 + 2, y1 - 10, x1 - 2, y1 - 2], fill=HIVIS_D)
    wear_edges(m, (x0, y0, x1, y1), CABG, 30)


# ── fabrication bay ─────────────────────────────────────────────────────

def paint_roof(m):
    z = L.Z_ROOF_TOP
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(110, 113, 115))
    # corrugation (tone-on-tone; roof is a big quad)
    for gy in range(y0 + 8, y1 - 4, 18):
        m.d.line([(x0 + 4, gy), (x1 - 4, gy)], fill=(101, 104, 106), width=3)
    m.d.rectangle([x0 + 2, y0 + 2, x1 - 2, y0 + 12], fill=HIVIS_D)
    m.d.rectangle([x0 + 2, y1 - 12, x1 - 2, y1 - 2], fill=HIVIS_D)
    wear_edges(m, (x0, y0, x1, y1), (110, 113, 115), 40)

    # underside: dark + dim amber welding wash
    x0, y0, x1, y1 = L.Z_ROOF_BOT.rect
    fill(m, (x0, y0, x1, y1), dif=(58, 60, 62), ao=AO_DEEP, rough=210,
         metal=40)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m.e.ellipse([cx - 70, cy - 55, cx + 70, cy + 55], fill=(96, 56, 18))

    x0, y0, x1, y1 = L.Z_ROOF_EDGE.rect
    fill(m, (x0, y0, x1, y1), dif=HIVIS, ao=AO_BASE - 8)
    for gx in range(x0 + 8, x1 - 6, 38):
        m.d.line([(gx, y1 - 3), (gx + 16, y0 + 3)], fill=HIVIS_D, width=4)


def paint_work(m):
    for z in (L.Z_WORK, L.Z_WORK_TOP):
        x0, y0, x1, y1 = z.rect
        fill(m, (x0, y0, x1, y1), dif=(74, 76, 80), ao=AO_BASE - 15,
             rough=170, metal=140)
        for gy in range(y0 + 12, y1 - 6, 30):
            seam_h(m, x0 + 4, x1 - 4, gy, (74, 76, 80))
    # hot weld seam on the top face
    x0, y0, x1, y1 = L.Z_WORK_TOP.rect
    my = (y0 + y1) // 2
    m.e.line([(x0 + 10, my), (x1 - 10, my)], fill=WELD, width=4)
    m.e.ellipse([x1 - 34, my - 8, x1 - 18, my + 8], fill=(255, 210, 120))
    m.d.line([(x0 + 10, my), (x1 - 10, my)], fill=(96, 80, 66), width=4)


# ── crane ───────────────────────────────────────────────────────────────

def paint_crane(m):
    # house sides (shared rect with mirror twin)
    z = L.Z_CRANE_SIDE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=HIVIS, ao=AO_BASE - 5)
    u, v = PL.zone_fns(z)
    for wz in (-0.6, 0.6, 1.6):
        seam_v(m, int(u(wz)), y0 + 4, y1 - 4, HIVIS)
    # pedestal band at the zone bottom (drum wrap samples v≈low y)
    m.d.rectangle(PL.nbox(x0 + 2, v(0.5), x1 - 2, y1 - 2), fill=STEEL_DK)
    m.o.rectangle(PL.nbox(x0 + 2, v(0.5), x1 - 2, y1 - 2),
                  fill=(AO_BASE - 20, R_STEEL, M_STEEL))
    numeral(m, u(0.3), v(1.7), '04', 52, color=(52, 46, 40))
    PL.team_panel(m, PL.nbox(u(-1.5), v(2.2), u(-0.9), v(1.7)),
                  outline=HIVIS_D, base=(206, 118, 34))
    bolts(m, [(x0 + 12 + i * ((x1 - x0 - 24) / 6), int(v(0.55)) - 8)
              for i in range(7)], base=HIVIS)
    wear_edges(m, (x0, y0, x1, int(v(0.5))), HIVIS, 35)

    # operator glazing (front face)
    z = L.Z_CRANE_FACE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=HIVIS, ao=AO_BASE - 5)
    u, v = PL.zone_fns(z)
    pane = PL.nbox(u(-0.9), v(2.15), u(0.9), v(1.25))
    PL.glass_rect(m, pane, outline=HIVIS_D)
    m.e.rectangle([pane[0] + 6, pane[1] + 6, pane[2] - 6, pane[3] - 6],
                  fill=(130, 96, 52))
    PL.hazard_band(m, PL.nbox(x0 + 4, v(0.55), x1 - 4, v(0.2)), step=24)
    wear_edges(m, (x0, y0, x1, y1), HIVIS, 30)

    # rear/counterweight face
    z = L.Z_CRANE_REAR
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=HIVIS_D, ao=AO_BASE - 8)
    u, v = PL.zone_fns(z)
    PL.hazard_band(m, PL.nbox(x0 + 4, v(1.05), x1 - 4, v(0.6)), step=24)
    numeral(m, u(0), v(1.8), '04', 40, color=(52, 46, 40))
    bolts(m, [(x0 + 14 + i * ((x1 - x0 - 28) / 5), y0 + 12)
              for i in range(6)], base=HIVIS_D)
    wear_edges(m, (x0, y0, x1, y1), HIVIS_D, 30)

    # house roof
    x0, y0, x1, y1 = L.Z_CRANE_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=jit(HIVIS, 4), ao=AO_BASE - 4)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, HIVIS)
    wear_edges(m, (x0, y0, x1, y1), HIVIS, 30)


def paint_cells(m):
    # boom wrap: hi-vis with tone-on-tone banding (large quads — no bold
    # stripes per the baker rule)
    x0, y0, x1, y1 = L.Z_BOOM
    fill(m, (x0, y0, x1, y1), dif=HIVIS, ao=AO_BASE - 6, rough=R_STEEL,
         metal=120)
    for gx in range(x0 + 18, x1 - 8, 56):
        m.d.rectangle([gx, y0 + 2, gx + 22, y1 - 2], fill=HIVIS_D)
    # trim / mast / hook steel cells
    fill(m, L.Z_TRIM, dif=STEEL_DK, ao=AO_BASE - 10, rough=R_STEEL,
         metal=M_STEEL)
    fill(m, L.Z_MAST, dif=STEEL, ao=AO_BASE - 6, rough=R_STEEL, metal=M_STEEL)
    x0, y0, x1, y1 = L.Z_MAST
    for gy in range(y0 + 16, y1, 26):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(STEEL, 0.86),
                 width=2)
    x0, y0, x1, y1 = L.Z_HOOK.rect
    fill(m, (x0, y0, x1, y1), dif=(88, 90, 94), ao=AO_BASE - 12, rough=160,
         metal=170)
    seam_h(m, x0 + 4, x1 - 4, (y0 + y1) // 2, (88, 90, 94))
    # exhaust wrap
    fill(m, L.Z_EXH, dif=(60, 56, 54), ao=AO_BASE - 25, rough=195, metal=150)
    x0, y0, x1, y1 = L.Z_EXH
    m.d.rectangle([x0, y0, x1, y0 + 14], fill=BLACKISH)
    # dark cell
    fill(m, L.Z_DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=205, metal=40)
    # floodlight heads: glass + warm emissive
    x0, y0, x1, y1 = L.Z_FLOOD.rect
    fill(m, (x0, y0, x1, y1), dif=GLASS, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    m.e.rectangle([x0 + 6, y0 + 6, x1 - 6, y1 - 6], fill=LAMPWARM)
    # rotating beacon: amber, fully emissive
    x0, y0, x1, y1 = L.Z_LIGHT.rect
    fill(m, (x0, y0, x1, y1), dif=AMBER, ao=AO_BASE, rough=R_GLASS,
         metal=M_GLASS)
    m.e.rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 2], fill=shade(AMBER, 0.85))


def paint_stowage(m):
    # crates: weathered timber
    x0, y0, x1, y1 = L.Z_CRATE.rect
    fill(m, (x0, y0, x1, y1), dif=WOOD, ao=AO_BASE - 12, rough=225, metal=0)
    for gy in range(y0 + 10, y1 - 4, 22):
        m.d.line([(x0 + 2, gy), (x1 - 2, gy)], fill=shade(WOOD, 0.82),
                 width=3)
    seam_v(m, (x0 + x1) // 2, y0 + 4, y1 - 4, WOOD)
    # tarp bundle
    x0, y0, x1, y1 = L.Z_TARP.rect
    fill(m, (x0, y0, x1, y1), dif=CANVAS, ao=AO_BASE - 10, rough=230, metal=0)
    for gx in range(x0 + 14, x1 - 8, 30):
        m.d.line([(gx, y0 + 4), (gx - 8, y1 - 4)], fill=shade(CANVAS, 0.8),
                 width=2)
    # gas bottles: grey body, cream shoulder, dark valve collar band
    z = L.Z_BOTTLE
    x0, y0, x1, y1 = z.rect
    fill(m, (x0, y0, x1, y1), dif=(140, 143, 146), ao=AO_BASE - 8, rough=130,
         metal=190)
    u, v = PL.zone_fns(z)
    m.d.rectangle(PL.nbox(x0 + 2, v(4.85), x1 - 2, v(4.45)), fill=CREAM)
    m.d.rectangle(PL.nbox(x0 + 2, y0 + 2, x1 - 2, v(4.85)), fill=STEEL_DK)
    m.d.rectangle(PL.nbox(x0 + 2, v(3.6), x1 - 2, v(3.35)),
                  fill=shade((140, 143, 146), 0.85))
    wear_edges(m, (x0, y0, x1, y1), (140, 143, 146), 30)


# ── assemble ────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_deck(m)
    paint_deck_edge(m)
    paint_hull_end(m)
    paint_belly(m)
    paint_pod_side(m)
    paint_pod_wrap(m)
    paint_cab_side(m)
    paint_cab_front(m)
    paint_cab_rear(m)
    paint_cab_top(m)
    paint_roof(m)
    paint_work(m)
    paint_crane(m)
    paint_cells(m)
    paint_stowage(m)

    wx = PL.standard_weather(
        m, L,
        ground_rects=[L.Z_POD_WRAP],
        side_zones=[L.Z_CAB_SIDE, L.Z_CAB_FRONT, L.Z_CAB_REAR, L.Z_HULL_END,
                    L.Z_BELLY, L.Z_CRANE_SIDE, L.Z_CRANE_FACE,
                    L.Z_CRANE_REAR],
        seed=41, mud=0.5)
    # extras: track mud, pod rust, exhaust soot, light deck dust
    wx.mud_band(L.Z_POD_SIDE.rect, 0.45, fade='down')
    tx0, ty0, tx1, ty1 = L.Z_POD_SIDE.rect
    wx.plate_bottom_rust((tx0, ty0, tx1, ty1), n=10, band=8, strength=0.45)
    for i in range(8):
        sx = tx0 + (tx1 - tx0) * (i + 0.5) / 8.0
        wx.rust_streak(sx, ty0 + 30, 20, strength=0.35)
    wx.mud_band(L.Z_DECK_EDGE.rect, 0.35, fade=None)
    wx.mud_band(L.Z_DECK.rect, 0.14, fade=None, spatter=False)
    wx.mud_band(L.Z_ROOF_TOP.rect, 0.12, fade=None, spatter=False)
    wx.soot_patch(L.Z_EXH, 0.7)
    wx.soot_patch(L.Z_WORK_TOP.rect, 0.4)

    PL.finish(m, L, STEM, wx=wx, outdir=OUT)


if __name__ == '__main__':
    paint_all()
