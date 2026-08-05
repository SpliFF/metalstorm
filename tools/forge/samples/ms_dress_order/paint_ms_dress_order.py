"""paint_ms_dress_order — 1024² PBR set for the Order dressing kit.

Clean formal register (Order: uniform panels, numbered stencils): one
matched parade-slate panel tone with tone-on-tone frames (large quads stay
low-contrast for the impostor baker), white stencil numerals, dark steel
fittings, matched olive crates with tie-down straps. Team colour ONLY in
the team mask R channel: the pennant field + the ID applique panel.
Emissive = the four amber formation-bar lenses, nothing else. Weathering
kept light — Order kit is maintained, not scrap.
"""
from __future__ import annotations
import numpy as np

import ms_dress_order_layout as L
import paintlib as PL
from paint import (Maps, fill, seam_h, bolts, jit, shade, BOLT_LOG,
                   TEAMGREY, BLACKISH, AO_BASE, AO_DEEP)

RNG = np.random.default_rng(90210)
STEM = 'ms_dress_order'

PANEL   = (90, 96, 100)     # parade slate — uniform Order panel tone
STEEL_D = (64, 66, 70)      # fittings / staff / rack
HOUSING = (44, 46, 49)      # light-bar housing
OLIVE   = (89, 87, 68)      # matched stowage crates
STENCIL = (222, 222, 214)   # formal white stencil


def stencil_text(m, xy, text, size, fill_col=STENCIL, cut_team=False):
    f = PL.font(size)
    m.d.text(xy, text, font=f, fill=fill_col, anchor='mm')
    if cut_team:
        m.t.text(xy, text, font=f, fill=(0, 0, 0), anchor='mm')


def paint_plates(m):
    zone = L.PLATES_F
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=PANEL, ao=AO_BASE - 6, rough=178,
         metal=120)
    u, v = PL.zone_fns(zone)
    for (cx, cy, w, h) in (L.PLATE_SIDE, L.PLATE_GLACIS, L.PLATE_ID):
        b = PL.nbox(u(cx - w / 2), v(cy + h / 2), u(cx + w / 2),
                    v(cy - h / 2))
        m.d.rectangle(b, fill=jit(PANEL, 3))
        # tone-on-tone frame (±12%) + corner bolts — formal, low contrast
        m.d.rectangle([b[0] + 4, b[1] + 4, b[2] - 4, b[3] - 4],
                      outline=shade(PANEL, 0.88), width=3)
        m.d.rectangle([b[0] + 9, b[1] + 9, b[2] - 9, b[3] - 9],
                      outline=shade(PANEL, 1.10), width=1)
        bolts(m, [(b[0] + 14, b[1] + 14), (b[2] - 14, b[1] + 14),
                  (b[0] + 14, b[3] - 14), (b[2] - 14, b[3] - 14)],
              r=3, base=PANEL)
    # side plate: pinstripe + regiment number
    scx, scy, sw, sh = L.PLATE_SIDE
    m.d.line([(u(scx - sw / 2 + 0.14), v(scy + sh / 2 - 0.14)),
              (u(scx + sw / 2 - 0.14), v(scy + sh / 2 - 0.14))],
             fill=shade(PANEL, 1.16), width=2)
    stencil_text(m, (u(scx + sw / 2 - 0.38), v(scy - 0.08)), '07', 42)
    # glacis plate: small stencil star (military formal)
    gcx, gcy, gw, gh = L.PLATE_GLACIS
    PL.roundel_star(m, u(gcx), v(gcy + 0.08), 26, STENCIL, ring=False)
    stencil_text(m, (u(gcx), v(gcy - gh / 2 + 0.16)), 'ORD', 20)
    # ID panel: team band on the upper half, numeral below (mask cut so
    # the numeral stays white over the team respray)
    icx, icy, iw, ih = L.PLATE_ID
    PL.team_panel(m, (u(icx - iw / 2 + 0.06), v(icy + ih / 2 - 0.06),
                      u(icx + iw / 2 - 0.06), v(icy + 0.06)),
                  outline=PANEL)
    stencil_text(m, (u(icx), v(icy - ih / 4 - 0.02)), '07', 46)


def paint_pennant(m):
    for zone in (L.PEN_F, L.PEN_B):
        x0, y0, x1, y1 = zone.rect
        # team field over the whole cloth + dark hem at the hoist edge
        PL.team_panel(m, (x0, y0, x1, y1))
        m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 4, 225, 10))
        u, v = PL.zone_fns(zone)
        hem = PL.nbox(u(L.PEN_HOIST_X), y0, u(L.PEN_HOIST_X + 0.06), y1)
        m.d.rectangle(hem, fill=STEEL_D)
        m.t.rectangle(hem, fill=(0, 0, 0))
        # numeral near the hoist — mask cut, reads correctly both sides
        stencil_text(m, (u(0.28), v(0.0)), '7', 62, cut_team=True)
        m.d.line([(u(L.PEN_KINK), v(0.15)), (u(L.PEN_KINK), v(-0.15))],
                 fill=shade(TEAMGREY, 0.85), width=2)


def paint_lightbar(m):
    zone = L.BAR_F
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=HOUSING, ao=AO_BASE - 8, rough=165,
         metal=150)
    u, v = PL.zone_fns(zone)
    for lx in L.LENS_XS:
        box = PL.nbox(u(lx - L.LENS_W / 2), v(L.BAR_CY + L.LENS_H / 2),
                      u(lx + L.LENS_W / 2), v(L.BAR_CY - L.LENS_H / 2))
        PL.headlight(m, box, on=True)
    x0, y0, x1, y1 = L.BAR_TOP.rect
    fill(m, (x0, y0, x1, y1), dif=shade(HOUSING, 1.08), ao=AO_BASE - 8,
         rough=170, metal=150)
    seam_h(m, x0 + 3, x1 - 3, (y0 + y1) // 2, HOUSING, hi=False)


def paint_stowage(m):
    # matched crates: three identical cells, plank lines tone-on-tone,
    # dark strap verticals, small supply stencil per crate
    zone = L.CRATE
    x0, y0, x1, y1 = zone.rect
    fill(m, (x0, y0, x1, y1), dif=OLIVE, ao=AO_BASE - 8, rough=215,
         metal=25)
    u, v = PL.zone_fns(zone)
    for cx in L.CRATE_XS:
        b = PL.nbox(u(cx - L.CRATE_S / 2), v(L.CRATE_Y + L.CRATE_S / 2),
                    u(cx + L.CRATE_S / 2), v(L.CRATE_Y - L.CRATE_S / 2))
        m.d.rectangle(b, fill=jit(OLIVE, 3),
                      outline=shade(OLIVE, 0.8), width=2)
        for fy in (0.33, 0.66):
            yy = b[1] + (b[3] - b[1]) * fy
            m.d.line([(b[0] + 2, yy), (b[2] - 2, yy)],
                     fill=shade(OLIVE, 0.88), width=2)
        for fx in (0.22, 0.78):
            xx = b[0] + (b[2] - b[0]) * fx
            m.d.line([(xx, b[1] + 2), (xx, b[3] - 2)],
                     fill=shade(STEEL_D, 0.9), width=3)
        stencil_text(m, ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2 + 14),
                     'SUP·07', 15, fill_col=shade(STENCIL, 0.9))
    # tray: steel with anti-slip ribs (tone-on-tone)
    x0, y0, x1, y1 = L.TRAY.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 10, rough=180,
         metal=145)
    for gx in range(x0 + 10, x1, 24):
        m.d.line([(gx, y0 + 3), (gx, y1 - 3)], fill=shade(STEEL_D, 1.10),
                 width=2)


def paint_cells(m):
    x0, y0, x1, y1 = L.TRIM.rect
    fill(m, (x0, y0, x1, y1), dif=STEEL_D, ao=AO_BASE - 12, rough=170,
         metal=150)
    for fx in (0.3, 0.65):
        xx = int(x0 + (x1 - x0) * fx)
        m.d.line([(xx, y0 + 2), (xx, y1 - 2)], fill=shade(STEEL_D, 0.9))
    fill(m, L.DARK.rect, dif=BLACKISH, ao=AO_DEEP, rough=210, metal=40)


def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    fill(m, (0, 0, 1024, 1024), dif=shade(PANEL, 0.95), ao=AO_BASE - 10,
         rough=185, metal=120)
    paint_plates(m)
    paint_pennant(m)
    paint_lightbar(m)
    paint_stowage(m)
    paint_cells(m)
    # light, maintained-kit weathering (Order register)
    wx = PL.standard_weather(m, L, ground_rects=(L.TRAY.rect,),
                             side_zones=(L.PLATES_F,), seed=90210,
                             mud=0.3, grime=0.4, rust_fraction=0.3)
    PL.finish(m, L, STEM, wx=wx)


if __name__ == '__main__':
    paint_all()
