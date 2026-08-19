"""gen_ms_ships_s3 — build ms_ships_s3 (heavy missile/railgun cruiser).

55 m single-unit ships-row s3.  Waterline at Y=0, bow at -Z.

  * hull: short, angular tumblehome loft (deck edge narrower than the
    waterline beam), wave-piercing raked stem, transom stern;
  * superstructure: ONE monolithic faceted tumblehome pyramid from the
    bridge aft to the mast — NO funnel, no separate deckhouse blocks,
    bridge windows are a single angled belt between two of its levels;
  * flush VLS cell block on the main deck forward of the bridge, 6x4
    lid plates with two hatches flung open (slot 3: bare muzzle3);
  * railgun turret on the fo'c'sle (turret->barrel->muzzle) with cyan
    emissive capacitor rings; CIWS ring on the wedge roof aft
    (turret2->turret2_barrel->muzzle2); pole mast + `radar` bar.

Clip: one seamless 8 s `idle` — the radar bar makes a full Y turn.

Usage: python3 gen_ms_ships_s3.py
"""
from __future__ import annotations
import numpy as np

import ms_ships_s3_layout as S          # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, loft, chamfer_box, ngon_ring, limb
from gltf_export import export
import parts as PT

STEM = 'ms_ships_s3'
OUT = 'out'
RNG = np.random.default_rng(90210)


def box(p, center, size, zone, ch=0.05, skip=()):
    chamfer_box(p, center, size, ch,
                {k: zone for k in ('+x', '-x', '+y', '-y', '+z', '-z')},
                skip=skip)


# ── hull ─────────────────────────────────────────────────────────────────

def hull_ring(sec):
    z, yk, wk, yb, wb, wwl, yd, wd = sec
    return [(wk, yk, z), (wb, yb, z), (wwl, 0.0, z), (wd, yd, z),
            (-wd, yd, z), (-wwl, 0.0, z), (-wb, yb, z), (-wk, yk, z)]


def hull_zone(c, n):
    if n[1] > 0.55:
        return S.S_DECK
    if n[1] < -0.55:
        return S.S_BELLY
    return S.S_HULL_SIDE


def hull_end(p, sec, zone, outward):
    z, yk, wk, yb, wb, wwl, yd, wd = sec
    PT.quad_out(p, [(-wk, yk, z), (wk, yk, z), (wb, yb, z), (-wb, yb, z)],
                outward, zone)
    PT.quad_out(p, [(-wb, yb, z), (wb, yb, z), (wwl, 0.0, z), (-wwl, 0.0, z)],
                outward, zone)
    PT.quad_out(p, [(-wwl, 0.0, z), (wwl, 0.0, z), (wd, yd, z), (-wd, yd, z)],
                outward, zone)


def deck_y_at(z):
    zs = [s[0] for s in S.HULL_SECTIONS]
    ys = [s[6] for s in S.HULL_SECTIONS]
    return float(np.interp(z, zs, ys))


# ── the wedge (monolithic faceted tumblehome superstructure) ─────────────

def plan_ring(y, hx, zf, za, c):
    """Octagon in plan, ordered so the loft's quads face OUTWARD
    (on the +x side the ring runs toward -z)."""
    return [(hx, y, za - c), (hx, y, zf + c), (hx - c, y, zf),
            (-(hx - c), y, zf), (-hx, y, zf + c), (-hx, y, za - c),
            (-(hx - c), y, za), (hx - c, y, za)]


def dh_zone(c, n):
    if n[1] > 0.55:
        return S.S_DH_ROOF
    belt = S.DH_WIN_Y[0] - 0.05 < c[1] < S.DH_WIN_Y[1] + 0.05
    win = belt and c[2] < S.DH_WIN_Z
    if abs(n[2]) > abs(n[0]):
        return S.S_WIN_END if win else S.S_DH_END
    return S.S_WIN_SIDE if win else S.S_DH_SIDE


def build_wedge(p):
    rings = [plan_ring(*lv) for lv in S.DH_LEVELS]
    loft(p, rings, dh_zone)
    PT.quad_out(p, rings[-1], (0, 1, 0), S.S_DH_ROOF)   # flat roof

    ry = S.DH_ROOF_Y
    _, hx, zf, za, c = S.DH_LEVELS[-1]
    # roof furniture — flush, nothing that breaks the wedge outline
    box(p, (0.0, ry + 0.16, za - 2.0), (2.6, 0.32, 2.2), S.S_GREY, ch=0.05)
    for sx in (1, -1):                                   # uptake grilles
        box(p, (sx * 1.15, ry + 0.22, 6.0), (1.0, 0.44, 3.4), S.S_GREEB,
            ch=0.06)
    box(p, (0.0, ry + 0.30, -2.2), (1.9, 0.60, 1.6), S.S_GREY, ch=0.06)

    # functional greebles on the sloped faces (>= 0.3 m, flush-mounted)
    for sx in (1, -1):
        # boat / liferaft recess, port and starboard
        box(p, (sx * 2.72, 5.55, 3.4), (0.34, 1.5, 4.2), S.S_DARK, ch=0.06)
        # vent louvre stacks aft
        box(p, (sx * 2.42, 6.4, 10.6), (0.30, 2.4, 1.7), S.S_GREEB, ch=0.05)
        # bridge-wing rail plate
        box(p, (sx * 2.62, 9.9, -3.0), (0.28, 0.9, 2.2), S.S_GREY, ch=0.05)
    # nav lights on the bridge wings (red +x / port, green -x / starboard)
    for sx, zn in ((1, S.S_NAV_P), (-1, S.S_NAV_S)):
        box(p, (sx * 2.74, 9.55, -3.6), (0.30, 0.44, 0.34), zn, ch=0.04)
    # aft face access door + ladder run to the roof
    box(p, (0.0, 5.4, 13.55), (1.1, 2.2, 0.24), S.S_DARK, ch=0.05)
    PT.ladder(p, (1.15, S.DECK_Y + 0.1, 13.3), (1.15, S.DH_ROOF_Y - 0.1, 12.7),
              width=0.52, rail_r=0.045, rung_step=0.55, zone=S.R_PIPE)
    # forward face: chin sensor block under the bridge windows
    box(p, (0.0, 7.4, -5.35), (2.4, 0.8, 0.5), S.S_GREEB, ch=0.06)


# ── flush VLS cell block ─────────────────────────────────────────────────

def build_vls(p):
    z0, z1 = S.VLS_Z
    cz, lz = (z0 + z1) / 2.0, (z1 - z0)
    # coaming: low rectangular deck-level box, top left open for lid plates
    chamfer_box(p, (0.0, (3.92 + S.VLS_TOP) / 2, cz),
                (S.VLS_HX * 2, S.VLS_TOP - 3.92, lz), 0.05,
                {'+x': S.S_VLS_SIDE, '-x': S.S_VLS_SIDE,
                 '+z': S.S_VLS_SIDE, '-z': S.S_VLS_SIDE,
                 '+y': S.S_DARK}, skip=('-y',))
    cw = lz / S.VLS_COLS
    ch = (S.VLS_HX * 2) / S.VLS_ROWS
    for i in range(S.VLS_COLS):
        for j in range(S.VLS_ROWS):
            zc = z0 + (i + 0.5) * cw
            xc = -S.VLS_HX + (j + 0.5) * ch
            g = 0.06
            if (i, j) in S.VLS_OPEN:
                # hatch flung open: lid stands on its forward hinge
                chamfer_box(p, (xc, S.VLS_LID + 0.42, zc - cw / 2 + 0.12),
                            (ch - 2 * g, 0.84, 0.10), 0.03,
                            {k: S.S_GREEB for k in
                             ('+x', '-x', '+y', '-y', '+z', '-z')})
                continue
            PT.quad_out(p, [(xc - ch / 2 + g, S.VLS_LID, zc - cw / 2 + g),
                            (xc + ch / 2 - g, S.VLS_LID, zc - cw / 2 + g),
                            (xc + ch / 2 - g, S.VLS_LID, zc + cw / 2 - g),
                            (xc - ch / 2 + g, S.VLS_LID, zc + cw / 2 - g)],
                        (0, 1, 0), S.S_VLS_TOP)


# ── deck furniture ───────────────────────────────────────────────────────

def build_deck_gear(p):
    dy = deck_y_at(S.BREAKWATER_Z)
    # raked breakwater plate ahead of the VLS
    PT.quad_out(p, [(-2.95, dy, S.BREAKWATER_Z - 0.55),
                    (2.95, dy, S.BREAKWATER_Z - 0.55),
                    (2.55, dy + 0.75, S.BREAKWATER_Z + 0.25),
                    (-2.55, dy + 0.75, S.BREAKWATER_Z + 0.25)],
                (0, 0.6, -1), S.S_HAZ)
    PT.quad_out(p, [(-2.95, dy, S.BREAKWATER_Z - 0.55),
                    (-2.55, dy + 0.75, S.BREAKWATER_Z + 0.25),
                    (2.55, dy + 0.75, S.BREAKWATER_Z + 0.25),
                    (2.95, dy, S.BREAKWATER_Z - 0.55)],
                (0, -0.6, 1), S.S_GREY)

    # bollards / fairleads at the deck edge
    for bz in S.BOLLARD_Z:
        by = deck_y_at(bz)
        bx = np.interp(bz, [s[0] for s in S.HULL_SECTIONS],
                       [s[7] for s in S.HULL_SECTIONS]) - 0.45
        for sx in (1, -1):
            limb(p, (sx * bx, by - 0.05, bz), (sx * bx, by + 0.55, bz),
                 0.15, 0.15, S.R_MAST, n=4)

    # windlass + hawse block on the fo'c'sle
    box(p, (0.0, deck_y_at(-25.0) + 0.35, -25.0), (1.7, 0.7, 1.3),
        S.S_GREEB, ch=0.06)
    # capstan and deck locker aft
    cx, cz = S.CAPSTAN
    limb(p, (cx, deck_y_at(cz), cz), (cx, deck_y_at(cz) + 0.55, cz),
         0.55, 0.42, S.R_MAST, n=8)
    lx, lz = S.LOCKER
    box(p, (lx, deck_y_at(lz) + 0.45, lz), (3.2, 0.9, 2.4), S.S_GREY, ch=0.07)
    for sx in (1, -1):                       # stern towing/replen posts
        limb(p, (sx * 2.3, deck_y_at(22.0), 22.0),
             (sx * 2.3, deck_y_at(22.0) + 1.6, 22.0), 0.13, 0.10,
             S.R_MAST, n=4)

    # railings fore and aft (the waist is filled by the wedge)
    for (rz0, rz1) in (S.RAIL_FWD, S.RAIL_AFT):
        for sx in (1, -1):
            rx0 = np.interp(rz0, [s[0] for s in S.HULL_SECTIONS],
                            [s[7] for s in S.HULL_SECTIONS]) - 0.18
            rx1 = np.interp(rz1, [s[0] for s in S.HULL_SECTIONS],
                            [s[7] for s in S.HULL_SECTIONS]) - 0.18
            PT.railing(p, (sx * rx0, deck_y_at(rz0), rz0),
                       (sx * rx1, deck_y_at(rz1), rz1), h=0.85,
                       post_step=3.2, r=0.045, zone=S.R_RAIL)


# ── mast ─────────────────────────────────────────────────────────────────

def build_mast(p):
    z = S.MAST_Z
    limb(p, (0, S.MAST_BASE_Y - 0.4, z), (0, S.MAST_TOP_Y, z),
         0.36, 0.20, S.R_MAST, n=6)
    for sx in (1, -1):                       # tripod legs into the roof
        limb(p, (sx * 0.95, S.MAST_BASE_Y - 0.1, z + 1.5),
             (sx * 0.12, S.MAST_YARD_Y - 1.4, z), 0.13, 0.10, S.R_MAST, n=4)
    limb(p, (-S.MAST_YARD_HX, S.MAST_YARD_Y, z),
         (S.MAST_YARD_HX, S.MAST_YARD_Y, z), 0.09, 0.09, S.R_MAST, n=4)
    for sx in (1, -1):                       # yardarm ESM pods
        box(p, (sx * (S.MAST_YARD_HX - 0.12), S.MAST_YARD_Y + 0.35, z),
            (0.42, 0.7, 0.42), S.S_GREEB, ch=0.05)
    box(p, (0.0, S.MAST_YARD_Y + 1.55, z), (1.1, 1.1, 1.1), S.S_GREY,
        ch=0.09)                             # mast-top equipment box
    box(p, (0.0, S.MAST_TOP_Y + 0.06, z), (0.7, 0.16, 0.7), S.S_DARK,
        ch=0.03)                             # radar pedestal cap


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')
    rings = [hull_ring(s) for s in S.HULL_SECTIONS]
    loft(p, rings, hull_zone)
    hull_end(p, S.HULL_SECTIONS[0], S.S_BOW, (0, 0, -1))
    hull_end(p, S.HULL_SECTIONS[-1], S.S_STERN, (0, 0, 1))
    build_wedge(p)
    build_vls(p)
    build_deck_gear(p)
    build_mast(p)
    return p


# ── slot 1: railgun (turret -> barrel -> muzzle) ─────────────────────────

def build_turret():
    """Piece-local: origin on the barbette ring at deck level, yaw axis Y."""
    p = Part('turret')
    rings = [ngon_ring((0, 0.0, 0), 1.62, n=8, axis='y'),
             ngon_ring((0, 0.30, 0), 1.58, n=8, axis='y')]
    PT._ring_solid(p, rings, S.S_TUR_SIDE)
    # faceted sloped-armour shell (two plan rings — angular, not rounded)
    a = plan_ring(0.30, 1.62, -1.95, 1.95, 0.62)
    b = plan_ring(1.95, 1.16, -1.38, 1.48, 0.46)
    loft(p, [a, b], lambda c, n: S.S_TUR if n[1] > 0.55 else S.S_TUR_SIDE)
    PT.quad_out(p, b, (0, 1, 0), S.S_TUR)
    # gun-slot brow over the trunnions
    box(p, (0.0, 1.32, -1.92), (1.5, 0.85, 0.44), S.S_DARK, ch=0.05)
    # rangefinder ears + roof hatch
    for sx in (1, -1):
        box(p, (sx * 1.05, 1.62, 0.45), (0.5, 0.45, 1.0), S.S_GREEB, ch=0.05)
    box(p, (0.0, 2.02, 0.9), (0.8, 0.16, 0.8), S.S_GREY, ch=0.03)
    return p


def build_barrel():
    """Piece-local: origin at the trunnion, tube runs to -Z (pitch axis X)."""
    p = Part('barrel')
    box(p, (0.0, 0.0, 0.62), (1.36, 1.05, 1.5), S.S_TUR, ch=0.07)   # breech
    limb(p, (0, 0, 0.10), (0, 0, -S.BARREL_LEN), 0.31, 0.20, S.R_BARREL, n=8)
    for sx in (1, -1):                        # the two accelerator rails
        limb(p, (sx * 0.29, 0.0, -0.20), (sx * 0.19, 0.0, -S.BARREL_LEN + 0.1),
             0.075, 0.055, S.R_BARREL, n=4)
    for cz in S.CAP_RINGS:                    # CYAN emissive capacitor rings
        limb(p, (0, 0, cz + 0.09), (0, 0, cz - 0.09), 0.48, 0.48,
             S.R_CAP, n=8)
    box(p, (0.0, 0.0, -S.BARREL_LEN + 0.22), (0.60, 0.60, 0.55),
        S.S_DARK, ch=0.05)                    # muzzle shroud
    return p


# ── slot 2: CIWS (turret2 -> turret2_barrel -> muzzle2) ──────────────────

def build_turret2():
    p = Part('turret2')
    rings = [ngon_ring((0, 0.0, 0), 1.05, n=8, axis='y'),
             ngon_ring((0, 0.38, 0), 0.98, n=8, axis='y')]
    PT._ring_solid(p, rings, S.S_TUR2)
    a = plan_ring(0.38, 0.98, -0.98, 0.98, 0.34)
    b = plan_ring(1.14, 0.72, -0.72, 0.86, 0.26)
    loft(p, [a, b], lambda c, n: S.S_TUR2)
    PT.quad_out(p, b, (0, 1, 0), S.S_TUR2)
    box(p, (0.0, 0.92, 0.72), (0.9, 0.7, 0.5), S.S_GREEB, ch=0.05)  # tracker
    return p


def build_turret2_barrel():
    """Multi-barrel gatling cluster, modelled on this one pitching piece."""
    p = Part('turret2_barrel')
    box(p, (0.0, 0.0, 0.28), (0.78, 0.7, 0.7), S.S_TUR2, ch=0.06)
    for i in range(6):
        a = np.pi / 6 + 2 * np.pi * i / 6
        bx, by = 0.19 * np.cos(a), 0.19 * np.sin(a)
        limb(p, (bx, by, 0.02), (bx, by, -S.GAT_LEN), 0.062, 0.055,
             S.R_GAT, n=4)
    limb(p, (0, 0, -S.GAT_LEN + 0.18), (0, 0, -S.GAT_LEN + 0.02), 0.27, 0.25,
         S.R_GAT, n=8)                        # muzzle clamp
    return p


# ── radar bar (the only animated piece) ──────────────────────────────────

def build_radar():
    p = Part('radar')
    box(p, (0.0, -0.05, 0.0), (0.62, 0.42, 0.62), S.S_GREY, ch=0.05)
    box(p, (0.0, 0.40, 0.0), (S.RADAR_SPAN, 0.86, 0.24), S.S_RADAR, ch=0.05)
    for sx in (1, -1):                        # end plates / IFF stubs
        box(p, (sx * (S.RADAR_SPAN / 2 - 0.10), 0.40, 0.0),
            (0.20, 1.00, 0.42), S.S_GREY, ch=0.04)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def build_clips():
    """One seamless 8 s turn of the radar bar about Y, 90-degree keys.

    Keys are pre-negated where needed so consecutive quaternions keep a
    positive dot product — Babylon's Quaternion.Slerp takes the shortest
    arc, and a raw 270deg->360deg pair would otherwise run backwards.
    The final key (0,0,0,-1) is the same ORIENTATION as the first, so the
    loop is seamless.
    """
    s = float(np.sqrt(0.5))
    keys = [(0.0, (0.0, 0.0, 0.0, 1.0)),
            (2.0, (0.0, s, 0.0, s)),
            (4.0, (0.0, 1.0, 0.0, 0.0)),
            (6.0, (0.0, s, 0.0, -s)),
            (8.0, (0.0, 0.0, 0.0, -1.0))]
    return [{'name': 'idle', 'channels': [('radar', 'rotation', keys)]}]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    body = build_body()
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=body),          # 0
        dict(name='turret', parent=0, offset=S.TUR_MOUNT,
             part=build_turret()),                                          # 1
        dict(name='barrel', parent=1, offset=S.TUR_PIVOT,
             part=build_barrel()),                                          # 2
        dict(name='muzzle', parent=2, offset=(0, 0, -S.BARREL_LEN - 0.10),
             part=None),                                                    # 3
        dict(name='turret2', parent=0, offset=S.TUR2_MOUNT,
             part=build_turret2()),                                         # 4
        dict(name='turret2_barrel', parent=4, offset=S.TUR2_PIVOT,
             part=build_turret2_barrel()),                                  # 5
        dict(name='muzzle2', parent=5, offset=(0, 0, -S.GAT_LEN - 0.08),
             part=None),                                                    # 6
        dict(name='muzzle3', parent=0, offset=S.MUZZLE3, part=None),        # 7
        dict(name='radar', parent=0, offset=S.RADAR_OFF,
             part=build_radar()),                                           # 8
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)

    lo = np.array([1e9, 1e9, 1e9])
    hi = -lo
    for pc in pieces:
        if not pc['part'] or not pc['part'].pos:
            continue
        off = np.array(pc['offset'], dtype=float)
        par = pc['parent']
        while par >= 0:
            off = off + np.array(pieces[par]['offset'], dtype=float)
            par = pieces[par]['parent']
        b0, b1 = pc['part'].bounds()
        lo = np.minimum(lo, np.array(b0) + off)
        hi = np.maximum(hi, np.array(b1) + off)
    print(f'[gen_{STEM}] extents  x {lo[0]:.2f}..{hi[0]:.2f}  '
          f'y {lo[1]:.2f}..{hi[1]:.2f}  z {lo[2]:.2f}..{hi[2]:.2f}')
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'TOTAL {total} tris')
