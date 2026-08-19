"""paint_ms_shipyard — 2048² PBR set for the naval factory.

Heavy-industry register, not parade-ground navy: grimy industrial
green-greys, corrugated iron cladding, rust and oil, hand-painted
signage on the hall wall, hazard chevrons on the crane and dock edges.
Boot-top + anti-foul straddling Y=0 on every wetted face, oil sheen at
the waterline, weld scorch on the plate stacks.  Emissive is warm/amber
only: hall interior spill, clerestory windows, office windows, and two
lamps deep inside the submarine pen.  Team colour lives ONLY in the
team-mask R channel — ID panels on the hall gable and the crane bridge.
"""
from __future__ import annotations
import os
import numpy as np

import ms_shipyard_layout as L      # sets meshlib.ATLAS = 2048
import paint as P
P.W = 2048
import weathering
weathering.W = 2048
import normals as NM
NM.W = 2048
import paintlib as PL

from paint import (Maps, fill, seam_h, seam_v, bolts, stencil, wear_edges,
                   shade, jit, BOLT_LOG, YELLOW, BLACKISH, STEEL, STEEL_DK,
                   AO_BASE, AO_SEAM, AO_DEEP, R_STEEL, M_STEEL)

STEM = 'ms_shipyard'
OUT = 'out'
RNG = np.random.default_rng(90210)

# ── palette (working yard: industrial greens/greys, rust, oil) ───────────
DECKC = (84, 90, 82)        # deck plate, industrial green-grey
DECK_DK = (66, 71, 65)
HULLG = (94, 99, 96)        # caisson freeboard
HULL_IN = (78, 83, 80)
BOOT = (27, 28, 27)         # boot-top band straddling Y=0
ANTIFOUL = (106, 57, 46)    # anti-foul below the waterline
CLAD = (88, 97, 86)         # corrugated hall cladding
CLAD_DK = (68, 76, 67)
ROOFC = (76, 82, 76)
DOORC = (96, 92, 78)        # sliding leaves, faded ochre-grey
GALV = (138, 145, 146)
DARK = (15, 16, 17)
WARM = (255, 184, 108)
WARM_DIM = (150, 96, 44)
CRANEC = (150, 130, 52)     # crane structural, faded works yellow
OFFICEC = (118, 112, 96)
TEAMBASE = (120, 124, 128)
RUSTC = (118, 68, 42)


def z_fns(zone):
    return PL.zone_fns(zone)


def chevrons(m, box, step=26, lean=10, cols=(YELLOW, BLACKISH)):
    """Leaning hazard chevrons — the dock/crane safety idiom."""
    x0, y0, x1, y1 = PL.nbox(*box)
    n = int((x1 - x0) / step) + 2
    for i in range(n):
        c = cols[i % 2]
        m.d.polygon([(x0 + i * step, y0), (x0 + (i + 1) * step, y0),
                     (x0 + (i + 1) * step - lean, y1),
                     (x0 + i * step - lean, y1)], fill=c)
    m.o.rectangle([x0, y0, x1, y1], fill=(AO_BASE - 10, 190, 40))


def corrugate(m, rect, base, step=13, along='v'):
    """Corrugated iron: alternating light/dark ribs, low contrast."""
    x0, y0, x1, y1 = rect
    if along == 'v':
        for i, x in enumerate(range(int(x0), int(x1), step)):
            c = shade(base, 1.08 if i % 2 == 0 else 0.88)
            m.d.rectangle([x, y0, x + step // 2, y1], fill=c)
    else:
        for i, y in enumerate(range(int(y0), int(y1), step)):
            c = shade(base, 1.08 if i % 2 == 0 else 0.88)
            m.d.rectangle([x0, y, x1, y + step // 2], fill=c)


def waterline_strip(m, zone, rect, above=HULLG, seams=14, draft=True):
    """Freeboard grey / boot-top / anti-foul on a ('*','y') zone."""
    _, v = z_fns(zone)
    x0, y0, x1, y1 = rect
    fill(m, rect, dif=above, ao=AO_BASE - 10, rough=176, metal=150)
    m.d.rectangle([x0, v(0.20), x1, v(-0.18)], fill=BOOT)
    m.o.rectangle([x0, v(0.20), x1, v(-0.18)], fill=(AO_BASE - 16, 198, 60))
    m.d.rectangle([x0, v(-0.18), x1, y1], fill=ANTIFOUL)
    m.o.rectangle([x0, v(-0.18), x1, y1], fill=(AO_BASE - 22, 208, 40))
    # plate seams + a rub strake near deck level
    for fx in np.linspace(0.03, 0.97, seams):
        sx = int(x0 + (x1 - x0) * fx)
        seam_v(m, sx, int(y0 + 3), int(v(0.25)), above, hi=False)
    m.d.rectangle([x0, v(2.45), x1, v(2.28)], fill=shade(above, 0.7))
    m.d.rectangle([x0, v(1.35), x1, v(1.18)], fill=shade(above, 0.66))
    if draft:
        for fx in (0.06, 0.5, 0.94):
            tx = x0 + (x1 - x0) * fx
            for wy in (0.5, 1.0, 1.5, 2.0):
                m.d.rectangle([tx, v(wy) - 2, tx + 16, v(wy) + 2],
                              fill=(198, 200, 196))


# ── deck tops ────────────────────────────────────────────────────────────

def paint_deck(m):
    zone = L.W_DECK
    u, v = z_fns(zone)
    x0, y0, x1, y1 = zone.rect
    fill(m, zone.rect, dif=DECK_DK, ao=AO_BASE - 16, rough=186, metal=130)
    for sx in (-1, 1):
        db = [x0, v(sx * 12.0), x1, v(sx * 17.0)]
        db = PL.nbox(*db)
        m.d.rectangle(db, fill=DECKC)
        m.o.rectangle(db, fill=(AO_BASE - 8, 180, 145))
        # transverse plate seams every 3 m, two longitudinals
        for wz in np.arange(-22.0, 23.0, 3.0):
            seam_v(m, int(u(wz)), int(db[1]) + 2, int(db[3]) - 2, DECKC,
                   hi=False)
        for wx in (13.4, 15.6):
            seam_h(m, x0 + 2, x1 - 2, int(v(sx * wx)), DECKC, hi=False)
        # crane rail run (two rails + sleeper ticks)
        for dx in (-0.26, 0.26):
            m.d.rectangle(PL.nbox(u(-23.0), v(sx * (16.0 + dx)) - 3,
                                  u(1.2), v(sx * (16.0 + dx)) + 3),
                          fill=GALV)
        for wz in np.arange(-22.0, 1.2, 1.6):
            m.d.rectangle(PL.nbox(u(wz) - 3, v(sx * 15.4), u(wz) + 3,
                                  v(sx * 16.6)), fill=shade(DECKC, 0.7))
        # hazard chevrons along the basin edge (inboard)
        eb = PL.nbox(u(-23.0), v(sx * 12.05), u(23.0), v(sx * 12.85))
        chevrons(m, eb, step=30, lean=12)
        # anti-slip walkway stripe on the working side
        wb = PL.nbox(u(-22.0), v(sx * 13.2) - 5, u(1.0), v(sx * 13.2) + 5)
        m.d.rectangle(wb, fill=shade(DECKC, 0.74))
        # bollard doubler pads on the outboard edge
        for bz in L.BOLLARD_Z:
            pad = PL.nbox(u(bz - 0.7), v(sx * 16.4), u(bz + 0.7),
                          v(sx * 17.0))
            m.d.rectangle(pad, fill=STEEL_DK)
            bolts(m, [(pad[0] + 8, pad[1] + 8), (pad[2] - 8, pad[3] - 8)],
                  base=STEEL_DK)
        # hatch covers + scuttle rings
        for hz in (-20.5, -6.5, 8.0, 18.0):
            hb = PL.nbox(u(hz - 0.9), v(sx * 14.6), u(hz + 0.9),
                         v(sx * 15.9))
            m.d.rectangle(hb, fill=shade(DECKC, 0.82),
                          outline=shade(DECKC, 0.58), width=3)
            bolts(m, [(hb[0] + 7, hb[1] + 7), (hb[2] - 7, hb[1] + 7),
                      (hb[0] + 7, hb[3] - 7), (hb[2] - 7, hb[3] - 7)],
                  base=DECKC)
    # slipway ramp plate (starboard, sampled from this zone) — tread bars
    rb = PL.nbox(u(L.SLIP_Z[0]), v(L.SLIP_X[0]), u(L.SLIP_Z[1]),
                 v(L.SLIP_X[1]))
    m.d.rectangle(rb, fill=shade(DECKC, 0.86))
    for wz in np.arange(L.SLIP_Z[0] + 0.3, L.SLIP_Z[1], 0.55):
        m.d.rectangle([u(wz) - 3, rb[1] + 4, u(wz) + 3, rb[3] - 4],
                      fill=shade(DECKC, 0.62))
    # yard identity, painted big on the port deck
    f = PL.font(84)
    m.d.text((u(-19.0) + 3, v(14.0) + 3), 'YARD 04', font=f,
             fill=shade(DECKC, 0.5))
    m.d.text((u(-19.0), v(14.0)), 'YARD 04', font=f, fill=(186, 190, 182))
    stencil(m, (u(-10.5), v(-15.4)), 'NO LOAD', 44, shade(DECKC, 0.52),
            bridge=False)
    wear_edges(m, zone.rect, DECKC, 90)


# ── caisson faces ────────────────────────────────────────────────────────

def paint_caissons(m):
    u, v = z_fns(L.W_CAIS_OUT)
    waterline_strip(m, L.W_CAIS_OUT, L.W_CAIS_OUT.rect, above=HULLG, seams=22)
    x0, y0, x1, y1 = L.W_CAIS_OUT.rect
    # fender strake line + fender pads
    for fz in L.FENDER_Z:
        pad = PL.nbox(u(fz - 0.55), v(1.6), u(fz + 0.55), v(-1.6))
        m.d.rectangle(pad, fill=(38, 39, 40))
    # ladder cage shadows
    for lz in L.LADDER_Z:
        m.d.rectangle(PL.nbox(u(lz - 0.35), v(3.0), u(lz + 0.35), v(-1.0)),
                      fill=shade(HULLG, 0.78))
    # hand-painted yard signage low on the hull
    stencil(m, (u(-8.0), v(2.05)), 'METALSTORM NAVAL YARD 04', 46,
            (198, 194, 176), bridge=False)
    stencil(m, (u(6.0), v(1.15)), 'DRY DOCK  CAP 8000 T', 32,
            (176, 172, 156), bridge=False)
    # mooring chain hawse rings
    for cz in L.CHAIN_Z:
        m.d.ellipse([u(cz) - 16, v(1.05) - 14, u(cz) + 16, v(1.05) + 14],
                    fill=(44, 41, 38), outline=shade(HULLG, 0.55), width=3)
    wear_edges(m, L.W_CAIS_OUT.rect, HULLG, 90)

    # inner (basin) faces: grimier, oil-stained, no signage
    waterline_strip(m, L.W_CAIS_IN, L.W_CAIS_IN.rect, above=HULL_IN, seams=18,
                    draft=False)
    ui, vi = z_fns(L.W_CAIS_IN)
    xi0, yi0, xi1, yi1 = L.W_CAIS_IN.rect
    for wz in np.arange(-21.0, 22.0, 2.0):     # dock step ledges
        m.d.rectangle([ui(wz) - 4, vi(2.9), ui(wz) + 4, vi(2.2)],
                      fill=shade(HULL_IN, 0.68))
    m.d.rectangle([xi0, vi(2.98), xi1, vi(2.82)], fill=YELLOW)
    for hz in np.arange(-20.0, 22.0, 4.0):     # flood culverts
        m.d.rectangle(PL.nbox(ui(hz - 0.45), vi(-0.6), ui(hz + 0.45),
                              vi(-1.5)), fill=(20, 21, 22))
    wear_edges(m, L.W_CAIS_IN.rect, HULL_IN, 60)

    # end faces + gate sill
    waterline_strip(m, L.W_END, L.W_END.rect, above=HULLG, seams=10,
                    draft=False)
    ue, ve = z_fns(L.W_END)
    xe0, ye0, xe1, ye1 = L.W_END.rect
    chevrons(m, PL.nbox(ue(-12.0), ve(0.6), ue(12.0), ve(0.05)), step=28)
    stencil(m, (ue(-4.0), ve(2.6)), 'SY-04', 52, (190, 192, 186), bridge=False)


# ── hall ─────────────────────────────────────────────────────────────────

def paint_hall(m):
    u, v = z_fns(L.W_WALL)
    x0, y0, x1, y1 = L.W_WALL.rect
    fill(m, L.W_WALL.rect, dif=CLAD, ao=AO_BASE - 8, rough=190, metal=110)
    corrugate(m, L.W_WALL.rect, CLAD, step=14, along='v')
    # base plinth + eaves gutter
    m.d.rectangle([x0, v(3.7), x1, v(2.8)], fill=shade(CLAD_DK, 0.8))
    m.d.rectangle([x0, v(9.8), x1, v(9.25)], fill=shade(CLAD, 0.66))
    # clerestory window band (lit)
    for wz in np.arange(3.0, 21.0, 2.4):
        wb = PL.nbox(u(wz), v(8.9), u(wz + 1.5), v(7.6))
        PL.glass_rect(m, wb, outline=CLAD_DK)
        m.e.rectangle([wb[0] + 4, wb[1] + 4, wb[2] - 4, wb[3] - 4],
                      fill=WARM_DIM)
    # personnel door + louvre bank
    db = PL.nbox(u(5.0), v(5.6), u(6.1), v(2.9))
    m.d.rectangle(db, fill=shade(CLAD_DK, 0.75), outline=BLACKISH, width=3)
    for i in range(6):
        ly = v(7.0) + i * 9
        m.d.rectangle([u(14.0), ly, u(17.4), ly + 5], fill=shade(CLAD, 0.6))
    # hand-painted signage across the cladding
    stencil(m, (u(8.0), v(6.9)), 'HULL SHOP', 74, (206, 198, 172),
            bridge=False)
    stencil(m, (u(8.2), v(5.6)), 'BERTHS 1-4 / PEN A', 34, (168, 162, 142),
            bridge=False)
    wear_edges(m, L.W_WALL.rect, CLAD, 80)

    # interior walls: near-black with warm spill low down
    ui, vi = z_fns(L.W_WALL_IN)
    fill(m, L.W_WALL_IN.rect, dif=DARK, ao=AO_DEEP, rough=205, metal=60)
    xi0, yi0, xi1, yi1 = L.W_WALL_IN.rect
    for wz in np.arange(2.5, 21.5, 2.6):       # gantry lamps inside the hall
        m.d.rectangle([ui(wz) - 8, vi(8.6), ui(wz) + 8, vi(8.2)],
                      fill=(60, 52, 40))
        m.e.rectangle([ui(wz) - 7, vi(8.55), ui(wz) + 7, vi(8.25)], fill=WARM)
    m.d.rectangle([xi0, vi(4.4), xi1, vi(2.8)], fill=(44, 38, 30))
    m.e.rectangle([xi0, vi(3.9), xi1, vi(2.9)], fill=WARM_DIM)

    # roof: corrugated, low contrast (impostor-safe), rusted seams
    fill(m, L.W_ROOF.rect, dif=ROOFC, ao=AO_BASE - 14, rough=196, metal=100)
    corrugate(m, L.W_ROOF.rect, ROOFC, step=15, along='h')
    ur, vr = z_fns(L.W_ROOF)
    rx0, ry0, rx1, ry1 = L.W_ROOF.rect
    for wz in np.arange(3.0, 22.0, 3.5):       # purlin seam lines
        m.d.rectangle([ur(wz) - 3, ry0, ur(wz) + 3, ry1],
                      fill=shade(ROOFC, 0.78))
    for wx in (-17.0, 17.0):                   # eave edge trim
        m.d.rectangle([rx0, vr(wx) - 5, rx1, vr(wx) + 5],
                      fill=shade(ROOFC, 0.66))
    # roof-light strips flanking the ridge
    for wx in (-2.4, 2.4):
        m.d.rectangle([ur(2.5), vr(wx) - 7, ur(20.5), vr(wx) + 7],
                      fill=(120, 122, 112))
    fill(m, L.W_ROOF_IN.rect, dif=DARK, ao=AO_DEEP, rough=210, metal=50)

    # forward gable: signage, big team ID panels, header hazard band
    ug, vg = z_fns(L.W_GABLE)
    gx0, gy0, gx1, gy1 = L.W_GABLE.rect
    fill(m, L.W_GABLE.rect, dif=CLAD, ao=AO_BASE - 8, rough=190, metal=110)
    corrugate(m, L.W_GABLE.rect, CLAD, step=14, along='v')
    chevrons(m, PL.nbox(ug(-17.0), vg(9.6), ug(17.0), vg(8.85)), step=30)
    stencil(m, (ug(-6.4), vg(12.6)), 'SHIPYARD', 78, (208, 200, 174),
            bridge=False)
    for sx in (-1, 1):
        PL.team_panel(m, PL.nbox(ug(sx * 9.6 - 2.0), vg(12.0),
                                 ug(sx * 9.6 + 2.0), vg(10.2)),
                      outline=CLAD_DK, base=TEAMBASE)
    wear_edges(m, L.W_GABLE.rect, CLAD, 70)

    # aft wall: cladding above, wet caisson below, the pen arch surround
    ua, va = z_fns(L.W_AFT)
    ax0, ay0, ax1, ay1 = L.W_AFT.rect
    fill(m, L.W_AFT.rect, dif=CLAD, ao=AO_BASE - 8, rough=190, metal=110)
    corrugate(m, L.W_AFT.rect, CLAD, step=14, along='v')
    m.d.rectangle([ax0, va(3.0), ax1, ay1], fill=HULLG)
    m.d.rectangle([ax0, va(0.2), ax1, va(-0.18)], fill=BOOT)
    m.d.rectangle([ax0, va(-0.18), ax1, ay1], fill=ANTIFOUL)
    m.o.rectangle([ax0, va(3.0), ax1, ay1], fill=(AO_BASE - 18, 200, 90))
    # arch surround: concrete-grey ring stepped around the pen mouth
    m.d.rectangle(PL.nbox(ua(-6.4), va(4.4), ua(6.4), va(-2.8)),
                  fill=(74, 76, 72))
    m.d.pieslice(PL.nbox(ua(-6.4), va(7.2), ua(6.4), va(1.6)), 180, 360,
                 fill=(74, 76, 72))
    m.d.pieslice(PL.nbox(ua(-5.0), va(6.0), ua(5.0), va(0.0)), 180, 360,
                 fill=DARK)
    m.d.rectangle(PL.nbox(ua(-5.0), va(3.0), ua(5.0), va(-2.8)), fill=DARK)
    m.o.rectangle(PL.nbox(ua(-5.4), va(3.4), ua(5.4), va(-2.8)),
                  fill=(AO_DEEP, 215, 20))
    stencil(m, (ua(-3.2), va(5.4)), 'PEN A', 46, (196, 190, 168),
            bridge=False)
    for sx in (-1, 1):                          # arch lamps
        m.e.ellipse([ua(sx * 5.9) - 7, va(4.0) - 7,
                     ua(sx * 5.9) + 7, va(4.0) + 7], fill=WARM)
    stencil(m, (ua(-15.5), va(7.0)), 'FITTING OUT', 40, (170, 166, 148),
            bridge=False)
    wear_edges(m, L.W_AFT.rect, CLAD, 70)

    # pen interior: black with two warm lamps deep inside
    fill(m, L.W_PEN.rect, dif=DARK, ao=AO_DEEP, rough=212, metal=40)
    up, vp = z_fns(L.W_PEN)
    for sx in (-1, 1):
        m.e.rectangle([up(sx * 3.0) - 9, vp(2.5) - 5,
                       up(sx * 3.0) + 9, vp(2.5) + 5], fill=WARM_DIM)
    m.d.rectangle([up(-6.0), vp(0.15), up(6.0), vp(-0.15)], fill=(30, 30, 28))

    # sliding door leaves
    fill(m, L.W_DOOR.rect, dif=DOORC, ao=AO_BASE - 10, rough=198, metal=100)
    corrugate(m, L.W_DOOR.rect, DOORC, step=16, along='v')
    ud, vd = z_fns(L.W_DOOR)
    dx0, dy0, dx1, dy1 = L.W_DOOR.rect
    m.d.rectangle([dx0, vd(9.2), dx1, vd(8.75)], fill=shade(DOORC, 0.62))
    chevrons(m, PL.nbox(dx0, vd(3.9), dx1, vd(2.95)), step=26)
    for wx in (-11.0, 11.0):                    # edge posts
        m.d.rectangle(PL.nbox(ud(wx - 0.35), vd(9.2), ud(wx + 0.35),
                              vd(2.9)), fill=shade(DOORC, 0.55))
    stencil(m, (ud(-2.4), vd(7.4)), 'KEEP CLEAR', 40, shade(DOORC, 0.45),
            bridge=False)
    wear_edges(m, L.W_DOOR.rect, DOORC, 60)


# ── crane ────────────────────────────────────────────────────────────────

def paint_crane(m):
    # leg / house sides (crane-local ('z','y'))
    u, v = z_fns(L.W_CRANE)
    x0, y0, x1, y1 = L.W_CRANE.rect
    fill(m, L.W_CRANE.rect, dif=CRANEC, ao=AO_BASE - 6, rough=168, metal=90)
    chevrons(m, PL.nbox(x0, v(1.5), x1, v(-0.6)), step=30)
    chevrons(m, PL.nbox(x0, v(13.6), x1, v(12.9)), step=30)
    for fx in np.linspace(0.08, 0.92, 7):       # frame ribs
        sx = int(x0 + (x1 - x0) * fx)
        seam_v(m, sx, int(y0 + 3), int(y1 - 3), CRANEC, hi=False)
    wb = PL.nbox(u(-1.4), v(12.4), u(1.4), v(11.6))
    PL.glass_rect(m, wb, outline=shade(CRANEC, 0.5))
    m.e.rectangle([wb[0] + 5, wb[1] + 5, wb[2] - 5, wb[3] - 5], fill=WARM_DIM)
    for sz in (-2.4, 2.4):                      # work floods on the sills
        m.e.rectangle([u(sz) - 8, v(1.2), u(sz) + 8, v(0.85)], fill=WARM)
    wear_edges(m, L.W_CRANE.rect, CRANEC, 70)

    # girder side faces (crane-local ('x','y')) — the long band
    uf, vf = z_fns(L.W_CRANE_F)
    fx0, fy0, fx1, fy1 = L.W_CRANE_F.rect
    fill(m, L.W_CRANE_F.rect, dif=CRANEC, ao=AO_BASE - 6, rough=168, metal=90)
    m.d.rectangle([fx0, vf(11.75), fx1, vf(11.4)], fill=shade(CRANEC, 0.66))
    m.d.rectangle([fx0, vf(10.3), fx1, vf(10.1)], fill=shade(CRANEC, 0.66))
    for wx in np.arange(-16.0, 16.1, 2.0):      # girder stiffeners
        m.d.rectangle([uf(wx) - 3, vf(11.7), uf(wx) + 3, vf(10.25)],
                      fill=shade(CRANEC, 0.8))
    for sx in (-1, 1):                          # chevrons on the legs
        chevrons(m, PL.nbox(uf(sx * 17.4), vf(9.0), uf(sx * 14.6), vf(0.0)),
                 step=24)
    stencil(m, (uf(-6.0), vf(11.35)), 'YARD 04  GANTRY  60 T', 34,
            shade(CRANEC, 0.42), bridge=False)
    wear_edges(m, L.W_CRANE_F.rect, CRANEC, 60)

    # girder top walkway: tread plate, hazard kerbs, team ID panels
    ut, vt = z_fns(L.W_CR_TOP)
    tx0, ty0, tx1, ty1 = L.W_CR_TOP.rect
    fill(m, L.W_CR_TOP.rect, dif=shade(CRANEC, 0.86), ao=AO_BASE - 10,
         rough=176, metal=95)
    for wx in np.arange(-17.0, 17.1, 1.0):
        m.d.rectangle([ut(wx) - 2, ty0 + 3, ut(wx) + 2, ty1 - 3],
                      fill=shade(CRANEC, 0.66))
    m.d.rectangle([tx0, ty0, tx1, ty0 + 6], fill=BLACKISH)
    m.d.rectangle([tx0, ty1 - 6, tx1, ty1], fill=BLACKISH)
    for sx in (-1, 1):
        PL.team_panel(m, PL.nbox(ut(sx * 8.0 - 2.6), ty0 + 12,
                                 ut(sx * 8.0 + 2.6), ty1 - 12),
                      outline=shade(CRANEC, 0.5), base=TEAMBASE)


# ── deck clutter cells + parametric wraps ────────────────────────────────

def paint_clutter(m):
    # shared object cell: scorched, weld-spattered plate steel
    x0, y0, x1, y1 = L.W_OBJ.rect
    fill(m, L.W_OBJ.rect, dif=(96, 92, 84), ao=AO_BASE - 12, rough=196,
         metal=140)
    for i in range(5):
        fy = y0 + (y1 - y0) * (i + 0.5) / 5
        m.d.rectangle([x0 + 4, fy - 4, x1 - 4, fy + 3],
                      fill=shade((96, 92, 84), 0.7))
    for _ in range(26):                          # weld spatter / scorch
        px = float(RNG.uniform(x0 + 6, x1 - 6))
        py = float(RNG.uniform(y0 + 6, y1 - 6))
        r = float(RNG.uniform(2.5, 7.0))
        m.d.ellipse([px - r, py - r, px + r, py + r], fill=(52, 46, 40))
    bolts(m, [(x0 + 14, y0 + 14), (x1 - 14, y0 + 14),
              (x0 + 14, y1 - 14), (x1 - 14, y1 - 14)], base=(96, 92, 84))
    stencil(m, (x0 + 14, (y0 + y1) // 2 - 16), 'SY04', 34, (58, 54, 48),
            bridge=False)

    # site office cabin: painted cabin with lit windows
    uo, vo = z_fns(L.W_OFFICE)
    ox0, oy0, ox1, oy1 = L.W_OFFICE.rect
    fill(m, L.W_OFFICE.rect, dif=OFFICEC, ao=AO_BASE - 8, rough=188,
         metal=90)
    corrugate(m, L.W_OFFICE.rect, OFFICEC, step=13, along='v')
    cx, cy = L.OFFICE[0], L.DECK_Y
    for dx in (-0.75, 0.35):
        wb = PL.nbox(uo(cx + dx), vo(cy + 2.05), uo(cx + dx + 0.62),
                     vo(cy + 1.35))
        PL.glass_rect(m, wb, outline=shade(OFFICEC, 0.5))
        m.e.rectangle([wb[0] + 4, wb[1] + 4, wb[2] - 4, wb[3] - 4], fill=WARM)
    db = PL.nbox(uo(cx + 1.15), vo(cy + 2.1), uo(cx + 1.75), vo(cy + 0.1))
    m.d.rectangle(db, fill=shade(OFFICEC, 0.62), outline=BLACKISH, width=3)
    m.d.rectangle([ox0, vo(cy + 2.75), ox1, vo(cy + 2.55)],
                  fill=shade(OFFICEC, 0.55))
    stencil(m, (uo(cx - 1.9), vo(cy + 2.5)), 'DOCK OFFICE', 26,
            (52, 50, 44), bridge=False)
    wear_edges(m, L.W_OFFICE.rect, OFFICEC, 45)

    # parametric wraps
    def wrap(rect, dif, ao, rough, metal):
        fill(m, rect, dif=dif, ao=ao, rough=rough, metal=metal)

    wrap(L.W_GIRDER, CRANEC, AO_BASE - 8, 168, 90)      # ribs / A-legs
    gx0, gy0, gx1, gy1 = L.W_GIRDER
    for fx in np.linspace(0.1, 0.9, 6):
        sx = gx0 + (gx1 - gx0) * fx
        m.d.rectangle([sx - 3, gy0, sx + 3, gy1], fill=shade(CRANEC, 0.62))
    m.d.rectangle([gx1 - 34, gy0, gx1, gy1], fill=BLACKISH)

    wrap(L.W_RAIL, GALV, AO_BASE - 8, 160, 175)         # railings / ladders
    rx0, ry0, rx1, ry1 = L.W_RAIL
    m.d.rectangle([rx0, (ry0 + ry1) // 2 - 2, rx1, (ry0 + ry1) // 2 + 2],
                  fill=shade(GALV, 0.78))

    wrap(L.W_FENDER, (34, 35, 36), AO_BASE - 22, 220, 0)   # rubber fenders
    ax0, ay0, ax1, ay1 = L.W_FENDER
    for fx in np.linspace(0.1, 0.9, 6):
        sx = ax0 + (ax1 - ax0) * fx
        m.d.rectangle([sx - 4, ay0, sx + 4, ay1], fill=(58, 58, 58))

    wrap(L.W_CHAIN, (58, 60, 55), AO_BASE - 18, 150, 175)  # bollards/chain/ribs
    cx0, cy0, cx1, cy1 = L.W_CHAIN
    for fx in np.linspace(0.08, 0.92, 8):
        sx = cx0 + (cx1 - cx0) * fx
        m.d.rectangle([sx - 2, cy0, sx + 2, cy1], fill=(38, 39, 35))

    wrap(L.W_ROPE, (72, 70, 64), AO_BASE - 16, 190, 60)    # hoist ropes
    wrap(L.W_LAMP, (72, 96, 84), AO_BASE - 10, 165, 120)   # gas bottles
    lx0, ly0, lx1, ly1 = L.W_LAMP
    m.d.rectangle([lx1 - 22, ly0, lx1, ly1], fill=(178, 148, 40))
    m.d.rectangle([lx0, ly0, lx0 + 12, ly1], fill=(48, 52, 48))

    wrap(L.W_STACK, (62, 60, 58), AO_BASE - 16, 200, 110)  # extract stacks
    sx0, sy0, sx1, sy1 = L.W_STACK
    m.d.rectangle([sx1 - 40, sy0, sx1, sy1], fill=(28, 26, 25))
    for fx in np.linspace(0.15, 0.75, 3):
        px = sx0 + (sx1 - sx0) * fx
        m.d.rectangle([px - 3, sy0, px + 3, sy1], fill=(44, 42, 40))

    wrap(L.W_REEL, (86, 82, 72), AO_BASE - 14, 200, 80)    # cable reels
    ex0, ey0, ex1, ey1 = L.W_REEL
    for fy in np.linspace(0.12, 0.88, 8):
        py = ey0 + (ey1 - ey0) * fy
        m.d.rectangle([ex0, py - 2, ex1, py + 2], fill=(40, 38, 34))

    fill(m, L.W_DARK.rect, dif=(18, 19, 20), ao=AO_DEEP, rough=208, metal=40)


# ── assembly ─────────────────────────────────────────────────────────────

def paint_all():
    BOLT_LOG.clear()
    m = Maps()
    paint_deck(m)
    paint_caissons(m)
    paint_hall(m)
    paint_crane(m)
    paint_clutter(m)

    # ── weathering: a working yard, not a parade ground ──
    wx = PL.standard_weather(m, L, ground_rects=(),
                             side_zones=(L.W_CAIS_OUT, L.W_CAIS_IN, L.W_WALL,
                                         L.W_GABLE, L.W_AFT, L.W_DOOR),
                             seed=41, mud=0.34, grime=0.6,
                             rust_fraction=0.6)
    ud, vd = z_fns(L.W_DECK)
    # deck: traffic grime, oil around the crane rails and the plate stages
    wx.mud_band(L.W_DECK.rect, 0.3, fade=None, spatter=True)
    for sx in (-1, 1):
        wx.oily((int(ud(-22.0)), int(min(vd(sx * 15.4), vd(sx * 16.6))),
                 int(ud(1.0)), int(max(vd(sx * 15.4), vd(sx * 16.6)))), 0.45)
        for wz in np.arange(-21.0, 22.0, 4.5):
            wx.rust_blotch(ud(wz), vd(sx * 12.4), 12, strength=0.55)
    for (px, pz, _s) in L.PLATES:
        wx.oily((int(ud(pz - 2.0)), int(min(vd(px - 1.8), vd(px + 1.8))),
                 int(ud(pz + 2.0)), int(max(vd(px - 1.8), vd(px + 1.8)))),
                0.5)

    # caissons: oil sheen + growth at the waterline, scupper streaks
    for zone in (L.W_CAIS_OUT, L.W_CAIS_IN):
        u, v = z_fns(zone)
        x0, y0, x1, y1 = zone.rect
        wx.mud_band((x0, int(v(0.55)), x1, int(v(-1.4))), 0.8, fade=None,
                    spatter=True)
        wx.oily((x0, int(v(0.9)), x1, int(v(-0.4))), 0.55)
        for fx in np.linspace(0.03, 0.97, 24):
            wx.rust_streak(x0 + (x1 - x0) * fx, v(2.9),
                           50 + (int(fx * 100) * 11) % 70, width=3.2,
                           strength=0.5)
        wx.plate_bottom_rust((x0, y0, x1, int(v(0.3))), n=14, strength=0.55)
    ue, ve = z_fns(L.W_END)
    ex0, ey0, ex1, ey1 = L.W_END.rect
    wx.mud_band((ex0, int(ve(0.55)), ex1, int(ve(-1.4))), 0.75, fade=None)

    # hall: rust weeping from the eaves, soot around the extract stacks
    uw, vw = z_fns(L.W_WALL)
    wx0, wy0, wx1, wy1 = L.W_WALL.rect
    for fx in np.linspace(0.02, 0.98, 22):
        wx.rust_streak(wx0 + (wx1 - wx0) * fx, wy0 + 8,
                       60 + (int(fx * 100) * 13) % 90, width=3.4,
                       strength=0.55)
    wx.plate_bottom_rust(L.W_WALL.rect, n=12, strength=0.5)
    ur, vr = z_fns(L.W_ROOF)
    for z in L.STACK_Z:
        wx.rust_blotch(ur(z), vr(2.4), 26, strength=0.7)
    wx.mud_band(L.W_ROOF.rect, 0.42, fade=None, spatter=True)
    ug, vg = z_fns(L.W_GABLE)
    wx.plate_bottom_rust(L.W_GABLE.rect, n=10, strength=0.5)
    wx.plate_bottom_rust(L.W_DOOR.rect, n=10, strength=0.6)
    ua, va = z_fns(L.W_AFT)
    ax0, ay0, ax1, ay1 = L.W_AFT.rect
    wx.mud_band((ax0, int(va(0.6)), ax1, int(va(-1.5))), 0.8, fade=None)
    wx.oily((ax0, int(va(1.0)), ax1, int(va(-0.5))), 0.5)

    # crane: work grime, grease down the legs
    wx.mud_band(L.W_CRANE.rect, 0.3, fade='down', spatter=False)
    wx.mud_band(L.W_CRANE_F.rect, 0.26, fade='down')
    wx.mud_band(L.W_CR_TOP.rect, 0.4, fade=None, spatter=True)
    wx.oily(L.W_GIRDER, 0.4)
    wx.oily(L.W_ROPE, 0.6)
    # clutter cells
    wx.rust_blotch((L.W_OBJ.rect[0] + L.W_OBJ.rect[2]) / 2,
                   (L.W_OBJ.rect[1] + L.W_OBJ.rect[3]) / 2, 40, strength=0.7)
    wx.mud_band(L.W_OFFICE.rect, 0.3, fade='down', dust=0.35)

    # ── relief ──
    from normals import HeightMap
    hm = HeightMap()
    # deck: seams recessed, rails and chevron kerbs proud
    dx0, dy0, dx1, dy1 = L.W_DECK.rect
    for sx in (-1, 1):
        for dx in (-0.26, 0.26):
            hm.rect((ud(-23.0), vd(sx * (16.0 + dx)) - 3, ud(1.2),
                     vd(sx * (16.0 + dx)) + 3), 0.7)
        hm.rect(PL.nbox(ud(-23.0), vd(sx * 12.05), ud(23.0),
                        vd(sx * 12.85)), 0.3)
        for wz in np.arange(-22.0, 23.0, 3.0):
            hm.line((ud(wz), min(vd(sx * 12.0), vd(sx * 17.0))),
                    (ud(wz), max(vd(sx * 12.0), vd(sx * 17.0))), -0.4,
                    width=3)
    # corrugated cladding + roof ribs
    for rect, step, along in ((L.W_WALL.rect, 14, 'v'),
                              (L.W_GABLE.rect, 14, 'v'),
                              (L.W_AFT.rect, 14, 'v'),
                              (L.W_DOOR.rect, 16, 'v'),
                              (L.W_ROOF.rect, 15, 'h')):
        x0, y0, x1, y1 = rect
        if along == 'v':
            for x in range(int(x0), int(x1), step):
                hm.rect((x, y0, x + step // 2, y1), 0.45)
        else:
            for y in range(int(y0), int(y1), step):
                hm.rect((x0, y, x1, y + step // 2), 0.45)
    # caisson plate seams + boot-top ridge
    for zone in (L.W_CAIS_OUT, L.W_CAIS_IN):
        u, v = z_fns(zone)
        x0, y0, x1, y1 = zone.rect
        for fx in np.linspace(0.03, 0.97, 24):
            hm.line((x0 + (x1 - x0) * fx, y0 + 3),
                    (x0 + (x1 - x0) * fx, v(0.3)), -0.35, width=2)
        hm.rect((x0, v(0.22), x1, v(0.18)), 0.3)
    # fender ribs
    fx0, fy0, fx1, fy1 = L.W_FENDER
    for fx in np.linspace(0.1, 0.9, 6):
        sx = fx0 + (fx1 - fx0) * fx
        hm.rect((sx - 4, fy0, sx + 4, fy1), 0.6)

    PL.finish(m, L, STEM, hm=hm, wx=wx, outdir=OUT)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    paint_all()
