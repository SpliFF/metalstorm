"""paint_ms_dress_dynasty — 1024² PBR set for the Dynasty dressing kit.

Opulent-salvage register: gilt (high-metal warm gold, tone-on-tone wear)
laid over worn field steel. Banner FIELD is team colour (team mask R only,
TEAMGREY diffuse) inside a gilt border, with a gold heraldic star (mask
cleared under it) and a fringe row. Crest plaque: gilt frame, quartered
burgundy/charcoal shield, gold star. Lanterns: dark bronze frames, warm
amber emissive panes (functional light — the only emissive). Cowl wrap:
worn steel, soot toward the mouth, gilt lip band. All large-quad generic
cells stay tone-on-tone (impostor-baker flat-shading quirk).
"""
from __future__ import annotations
import numpy as np

import ms_dress_dynasty_layout as L
import paintlib as PL
from paint import (Maps, fill, seam_h, bolts, wear_edges, jit, shade,
                   BOLT_LOG, TEAMGREY, BLACKISH,
                   AO_BASE, AO_SEAM, AO_DEEP, R_STEEL, M_STEEL)

RNG = np.random.default_rng(90210)
W = 1024
STEM = 'ms_dress_dynasty'

GOLD_C   = (176, 140, 66)     # worn gilt
GOLD_DK  = (140, 108, 48)
STEEL_C  = (88, 86, 82)       # worn field steel
BRONZE   = (72, 58, 42)       # lantern frames
BURGUNDY = (96, 38, 42)       # crest quarters
CHARCOAL = (54, 52, 55)
AMBER    = (226, 158, 66)     # lantern glass (diffuse)
AMBER_E  = (255, 172, 82)     # lantern glow (emissive, warm)
CREAM    = (208, 196, 168)    # crest scroll band


def star(m, cx, cy, r, col, clear_team=False):
    """Five-point stencil star; optionally clears the team mask under it."""
    pts = []
    for i in range(10):
        a = -np.pi / 2 + i * np.pi / 5
        rr = r if i % 2 == 0 else r * 0.42
        pts.append((cx + rr * np.cos(a), cy + rr * np.sin(a)))
    m.d.polygon(pts, fill=col)
    if clear_team:
        m.t.polygon(pts, fill=(0, 0, 0))


def gilt_cell(m, rect, tone=GOLD_C, streaks=10):
    """Tone-on-tone worn gilt (±15% — baker-safe on large quads)."""
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=tone, ao=AO_BASE - 6, rough=118, metal=214)
    for _ in range(streaks):
        sx = RNG.uniform(x0, x1)
        sy0 = RNG.uniform(y0, y1 - 8)
        m.d.line([(sx, sy0), (sx + RNG.uniform(-3, 3), sy0 + RNG.uniform(6, 18))],
                 fill=jit(shade(tone, RNG.uniform(0.88, 1.12)), 5), width=2)
    wear_edges(m, rect, tone, 26)


def steel_cell(m, rect, tone=STEEL_C):
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=tone, ao=AO_BASE - 8, rough=188, metal=142)
    for _ in range(14):
        sx = RNG.uniform(x0, x1 - 10)
        sy = RNG.uniform(y0, y1)
        m.d.line([(sx, sy), (sx + RNG.uniform(4, 12), sy + RNG.uniform(-2, 2))],
                 fill=jit(shade(tone, RNG.uniform(0.86, 1.1)), 4))
    wear_edges(m, rect, tone, 30)


def paint_flag(m):
    z = L.FLAG
    x0, y0, x1, y1 = z.rect
    u, v = PL.zone_fns(z)
    # gilt border all round, then the team-colour field inside it
    gilt_cell(m, z.rect, streaks=6)
    fx0, fy0 = u(-0.36), v(-0.09)
    fx1, fy1 = u(0.36), v(-1.32)
    PL.team_panel(m, PL.nbox(fx0, fy0, fx1, fy1), outline=GOLD_DK)
    fill(m, PL.nbox(fx0, fy0, fx1, fy1), ao=AO_BASE - 4, rough=236, metal=6)
    m.t.rectangle(PL.nbox(fx0, fy0, fx1, fy1), fill=(255, 0, 0))
    # cloth mottle on the field (subtle, tone-on-tone on TEAMGREY)
    for _ in range(120):
        sx = RNG.uniform(min(fx0, fx1), max(fx0, fx1) - 4)
        sy = RNG.uniform(min(fy0, fy1), max(fy0, fy1) - 4)
        m.d.point((sx, sy), fill=jit(TEAMGREY, 9))
    # heraldic gold star, upper third — mask cleared so it stays gold
    star(m, (fx0 + fx1) / 2, v(-0.48), (x1 - x0) * 0.155, GOLD_C,
         clear_team=True)
    # gold chevron bar below the star (mask cleared)
    bx0, bx1 = u(-0.30), u(0.30)
    by0, by1 = v(-0.86), v(-0.95)
    m.d.rectangle(PL.nbox(bx0, by0, bx1, by1), fill=GOLD_C)
    m.t.rectangle(PL.nbox(bx0, by0, bx1, by1), fill=(0, 0, 0))
    # fringe row: gold dashes along the bottom border
    fyA, fyB = v(-1.36), v(-1.50)
    step = 12
    for gx in range(int(x0) + 6, int(x1) - 6, step):
        m.d.rectangle([gx, fyA, gx + 6, fyB], fill=jit(GOLD_C, 8))
    m.o.rectangle([x0, fyA, x1, fyB], fill=(AO_BASE - 10, 150, 190))


def paint_crest(m):
    z = L.CREST_F
    u, v = PL.zone_fns(z)
    gilt_cell(m, z.rect, streaks=8)                 # frame ring
    # shield: pentagon field, quartered burgundy/charcoal
    sx0, sx1 = u(-0.34), u(0.34)
    sy0, sy1 = v(0.94), v(0.46)
    syp = v(0.22)                                    # shield point
    cx = (sx0 + sx1) / 2
    shield = [(sx0, sy0), (sx1, sy0), (sx1, sy1), (cx, syp), (sx0, sy1)]
    m.d.polygon(shield, fill=CHARCOAL)
    m.o.polygon(shield, fill=(AO_BASE - 8, 200, 40))
    cy = (sy0 + sy1) / 2
    m.d.polygon([(sx0, sy0), (cx, sy0), (cx, cy), (sx0, cy)], fill=BURGUNDY)
    m.d.polygon([(cx, cy), (sx1, cy), (sx1, sy1), (cx, sy1)], fill=BURGUNDY)
    m.d.line([(sx0, cy), (sx1, cy)], fill=GOLD_DK, width=2)
    m.d.line([(cx, sy0), (cx, syp)], fill=GOLD_DK, width=2)
    m.d.polygon(shield, outline=GOLD_C)
    star(m, cx, cy, (sx1 - sx0) * 0.17, GOLD_C)
    # scroll band under the shield point
    bx0, bx1 = u(-0.28), u(0.28)
    by0, by1 = v(0.20), v(0.10)
    m.d.rectangle(PL.nbox(bx0, by0, bx1, by1), fill=CREAM,
                  outline=GOLD_DK)
    m.o.rectangle(PL.nbox(bx0, by0, bx1, by1), fill=(AO_BASE - 6, 210, 20))
    # corner rivets in the gilt frame
    bolts(m, [(u(-0.46), v(1.10)), (u(0.46), v(1.10)),
              (u(-0.46), v(0.10)), (u(0.46), v(0.10))], r=3, base=GOLD_C)
    gilt_cell(m, L.CREST_S.rect, streaks=4)


def paint_lantern(m):
    for z in (L.LANT_X, L.LANT_Z):
        u, v = PL.zone_fns(z)
        x0, y0, x1, y1 = z.rect
        fill(m, z.rect, dif=BRONZE, ao=AO_BASE - 8, rough=170, metal=160)
        # amber pane with a centre mullion, warm emissive core
        px0, px1 = u(-0.10), u(0.10)
        py0, py1 = v(0.41), v(0.13)
        pane = PL.nbox(px0, py0, px1, py1)
        m.d.rectangle(pane, fill=AMBER)
        m.o.rectangle(pane, fill=(AO_SEAM, 60, 0))
        m.e.rectangle([pane[0] + 3, pane[1] + 3, pane[2] - 3, pane[3] - 3],
                      fill=AMBER_E)
        mx = (pane[0] + pane[2]) / 2
        m.d.line([(mx, pane[1]), (mx, pane[3])], fill=GOLD_DK, width=3)
        m.e.line([(mx, pane[1]), (mx, pane[3])], fill=(0, 0, 0), width=3)
        m.d.rectangle(pane, outline=GOLD_DK, width=2)
        # gilt sill + header trim
        m.d.rectangle([x0, v(0.44), x1, v(0.41)], fill=GOLD_DK)
        m.d.rectangle([x0, v(0.13), x1, v(0.09)], fill=GOLD_DK)
        wear_edges(m, z.rect, BRONZE, 24)
    gilt_cell(m, L.LANT_TOP.rect, streaks=5)


def paint_cowl(m):
    """Wrap: u (rect x) runs base→mouth, v around. Worn steel body,
    soot building toward the mouth, gilt lip band at the very mouth."""
    x0, y0, x1, y1 = L.COWL_WRAP
    steel_cell(m, L.COWL_WRAP)
    # rib bands (tone-on-tone) at the collar stations
    for fx in (0.50, 0.68):
        rx = x0 + (x1 - x0) * fx
        m.d.rectangle([rx - 3, y0, rx + 3, y1], fill=shade(STEEL_C, 0.86))
    # gilt trumpet lip: last 8% before the mouth
    lip0 = x0 + (x1 - x0) * 0.92
    gilt_cell(m, (int(lip0), y0, x1, y1), streaks=3)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, W, W), dif=STEEL_C, ao=AO_BASE - 8, rough=185, metal=140)
    paint_flag(m)
    paint_crest(m)
    paint_lantern(m)
    paint_cowl(m)
    gilt_cell(m, L.GOLD.rect)
    gilt_cell(m, L.GOLD_TOP.rect, tone=shade(GOLD_C, 0.94))
    steel_cell(m, L.STEEL.rect)
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=215, metal=30)

    # ── weathering + finish (writes all five maps incl. normals) ──
    wx = PL.standard_weather(m, L, ground_rects=(), side_zones=(),
                             seed=90210, grime=0.4)
    # soot creeping from the cowl mouth back down the wrap
    x0, y0, x1, y1 = L.COWL_WRAP
    wx.soot_patch((int(x0 + (x1 - x0) * 0.55), y0,
                   int(x0 + (x1 - x0) * 0.92), y1), strength=0.7,
                  fade='right')
    # dust on the banner cloth toward the free end (rect bottom)
    wx.mud_band(L.FLAG.rect, 0.22, fade='down', spatter=False)
    # rust bleed at steel stanchion/pole cell bottoms
    wx.plate_bottom_rust(L.STEEL.rect, n=5, band=6, strength=0.5)

    from normals import HeightMap
    hm = HeightMap()
    u, v = PL.zone_fns(L.CREST_F)
    hm.rect(PL.nbox(u(-0.34), v(0.94), u(0.34), v(0.46)), 0.3)
    u, v = PL.zone_fns(L.FLAG)
    hm.rect(PL.nbox(u(-0.36), v(-0.09), u(0.36), v(-1.32)), 0.15)
    PL.finish(m, L, STEM, hm=hm, wx=wx)


if __name__ == '__main__':
    paint_all()
