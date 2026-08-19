"""gen_ms_shipyard — the Metalstorm naval factory (floating graving dock).

Two ballast caissons form the dock walls over a flooded wet basin; the
aft half is a covered ribbed ship hall with sliding door leaves, roof
vents and a half-submerged arched SUBMARINE PEN in its aft wall; the
forward half is an open fitting-out basin with railings, a slipway,
plate stacks, gas bottles, cable reels, skips and a site office.  A
travelling gantry crane (`crane`) rides rails along the caisson decks
and traverses the basin in the 12 s `idle` clip.

Waterline at Y = 0.  No weapons, no aim chain.  Tri budget 3400.

Usage: python3 gen_ms_shipyard.py [png]
"""
from __future__ import annotations
import os
import numpy as np

import ms_shipyard_layout as L      # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
import parts as P
from gltf_export import export

STEM = 'ms_shipyard'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
RNG = np.random.default_rng(90210)


# ── helpers ──────────────────────────────────────────────────────────────

def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, float)) > 0
               else verts[::-1], zone=zone)


def box(p, center, size, zone, ch=0.06, skip=()):
    """Uniform-zone box; the -Z face gets the mirrored twin so lettering in
    the cell reads correctly from the front as well as the back."""
    zones = {f: zone for f in ('+x', '-x', '+y', '-y', '+z')}
    zones['-z'] = L.mir(zone)
    chamfer_box(p, center, size, ch, zones, skip=skip)


def obj_zone(cx, cy, half):
    """Per-object window onto the shared clutter cell (world-anchored)."""
    return Zone(L.W_OBJ.rect, ('x', 'y'),
                ((cx - half, cx + half), (cy + half, cy - half)))


# ── body: caissons, hall, pen, deck clutter ──────────────────────────────

def build_caissons(p):
    zc = {'+y': L.W_DECK, '-y': L.W_DARK,
          '+x': L.mir(L.W_CAIS_OUT), '-x': L.W_CAIS_IN,
          '+z': L.W_END, '-z': L.mir(L.W_END)}
    zcm = dict(zc, **{'+x': L.mir(L.W_CAIS_IN), '-x': L.W_CAIS_OUT})
    yc = (L.CAIS_BOT + L.DECK_Y) / 2
    hy = L.DECK_Y - L.CAIS_BOT
    zlen = L.Z_AFT - L.Z_FWD
    zmid = (L.Z_AFT + L.Z_FWD) / 2
    chamfer_box(p, (L.CAIS_XC, yc, zmid), (L.CAIS_W, hy, zlen), 0.18,
                zc, skip=('-y',))
    chamfer_box(p, (-L.CAIS_XC, yc, zmid), (L.CAIS_W, hy, zlen), 0.18,
                zcm, skip=('-y',))

    # seaward gate sill: low submerged caisson closing the basin at -Z
    gz0, gz1 = L.GATE_Z
    chamfer_box(p, (0.0, (L.CAIS_BOT + L.GATE_TOP) / 2, (gz0 + gz1) / 2),
                (2 * L.CAIS_IN, L.GATE_TOP - L.CAIS_BOT, gz1 - gz0), 0.12,
                {'+y': L.W_DECK, '+x': L.W_CAIS_IN, '-x': L.W_CAIS_IN,
                 '+z': L.W_END, '-z': L.mir(L.W_END)}, skip=('-y',))

    # aft cross caisson, split either side of the submarine pen mouth
    az0, az1 = L.XCROSS_Z
    for sx in (-1, 1):
        w = L.CAIS_IN - L.PEN_HW
        cx = sx * (L.PEN_HW + w / 2)
        chamfer_box(p, (cx, yc, (az0 + az1) / 2), (w, hy, az1 - az0), 0.12,
                    {'+y': L.W_DECK, '-y': L.W_DARK,
                     '+x': L.W_PEN if sx < 0 else L.W_END,
                     '-x': L.W_PEN if sx > 0 else L.W_END,
                     '+z': L.W_AFT, '-z': L.W_CAIS_IN}, skip=('-y',))


def build_pen(p):
    """Half-submerged arched submarine pen: dark throat behind the aft wall."""
    az0, az1 = L.XCROSS_Z
    hw, y0, y1 = L.PEN_HW, L.PEN_SILL, L.DECK_Y
    zb = L.PEN_BACK
    # throat side walls (dark) running forward from the mouth
    for sx in (-1, 1):
        quad_out(p, [(sx * hw, y0, az1), (sx * hw, y1, az1),
                     (sx * hw, y1, zb), (sx * hw, y0, zb)],
                 (-sx, 0, 0), L.W_PEN)
    # soffit over the throat + dark back wall with deep lamps
    quad_out(p, [(-hw, y1, az1), (hw, y1, az1), (hw, y1, zb), (-hw, y1, zb)],
             (0, -1, 0), L.W_PEN)
    quad_out(p, [(-hw, y0, zb), (hw, y0, zb), (hw, y1, zb), (-hw, y1, zb)],
             (0, 0, 1), L.W_PEN)
    # arch springing: chamfer facets at the mouth's top corners
    for sx in (-1, 1):
        quad_out(p, [(sx * hw, 2.0, az1), (sx * (hw - 1.7), y1, az1),
                     (sx * (hw - 1.7), y1, az1 - 0.9),
                     (sx * hw, 2.0, az1 - 0.9)], (0, 1, 1), L.W_PEN)


def build_hall(p):
    hz0, hz1 = L.HALL_Z
    zc = (hz0 + hz1) / 2
    zd = hz1 - hz0
    yc = (L.DECK_Y + L.EAVE_Y) / 2
    yh = L.EAVE_Y - L.DECK_Y
    for sx in (1, -1):
        zones = {'+y': L.W_ROOF, '-y': L.W_DARK,
                 '+x': L.mir(L.W_WALL if sx > 0 else L.W_WALL_IN),
                 '-x': L.W_WALL_IN if sx > 0 else L.W_WALL,
                 '+z': L.W_AFT, '-z': L.mir(L.W_GABLE)}
        chamfer_box(p, (sx * L.CAIS_XC, yc, zc), (L.CAIS_W, yh, zd), 0.14,
                    zones, skip=('-y',))
    # aft wall above the deck (spans the full beam) + aft gable
    box(p, (0.0, yc, (L.XCROSS_Z[0] + L.XCROSS_Z[1]) / 2),
        (2 * L.CAIS_OUT, yh, L.XCROSS_Z[1] - L.XCROSS_Z[0]),
        L.W_AFT, ch=0.12, skip=('-y',))
    za = L.XCROSS_Z[1]
    quad_out(p, [(-L.CAIS_OUT, L.EAVE_Y, za), (L.CAIS_OUT, L.EAVE_Y, za),
                 (0.0, L.RIDGE_Y, za)], (0, 0, 1), L.W_AFT)
    # forward gable triangle over the hall mouth
    quad_out(p, [(-L.CAIS_OUT, L.EAVE_Y, hz0), (L.CAIS_OUT, L.EAVE_Y, hz0),
                 (0.0, L.RIDGE_Y, hz0)], (0, 0, -1), L.mir(L.W_GABLE))
    # header beam across the hall mouth
    chamfer_box(p, (0.0, L.EAVE_Y - 0.45, hz0 + 0.1),
                (2 * L.CAIS_OUT, 0.9, 1.1), 0.08,
                {'+y': L.W_GABLE, '-y': L.W_GABLE, '+x': L.W_GABLE,
                 '-x': L.W_GABLE, '+z': L.W_GABLE,
                 '-z': L.mir(L.W_GABLE)})

    # roof: two low-pitch slopes with a lit clerestory strip below the ridge
    rz0, rz1 = hz0 - L.ROOF_OVER, hz1 + L.ROOF_OVER
    xe, ye, yr = L.CAIS_OUT + L.ROOF_OVER, L.EAVE_Y - 0.2, L.RIDGE_Y
    for sx in (-1, 1):
        top = [(sx * xe, ye, rz0), (0.0, yr, rz0), (0.0, yr, rz1),
               (sx * xe, ye, rz1)]
        quad_out(p, top, (sx * 0.26, 1, 0), L.W_ROOF)
        und = [(v[0], v[1] - 0.42, v[2]) for v in top]
        quad_out(p, und, (-sx * 0.26, -1, 0), L.W_ROOF_IN)
        # eave fascia
        quad_out(p, [(sx * xe, ye, rz0), (sx * xe, ye, rz1),
                     (sx * xe, ye - 0.42, rz1), (sx * xe, ye - 0.42, rz0)],
                 (sx, 0, 0), L.W_ROOF)
        # gable-end roof edges
        for z, o in ((rz0, -1), (rz1, 1)):
            quad_out(p, [(sx * xe, ye, z), (0.0, yr, z),
                         (0.0, yr - 0.42, z), (sx * xe, ye - 0.42, z)],
                     (0, 0, o), L.W_ROOF)
    # ridge cap
    box(p, (0.0, yr + 0.18, (rz0 + rz1) / 2), (1.5, 0.5, rz1 - rz0),
        L.W_ROOF, ch=0.08)
    # ribs across the slopes
    for z in L.RIB_Z:
        for sx in (-1, 1):
            limb(p, (sx * xe, ye + 0.16, z), (0.0, yr + 0.16, z),
                 0.17, 0.17, L.W_RIB, n=4)
    # extract stacks + a roof vent hood per bay
    for z in L.STACK_Z:
        limb(p, (2.4, yr - 0.4, z), (2.4, L.STACK_TOP, z), 0.42, 0.36,
             L.W_STACK, n=6, cap_end=L.W_DARK)
        box(p, (-4.0, yr - 1.15, z), (2.2, 0.7, 1.6), L.W_ROOF, ch=0.08)

    # sliding door leaves parked either side of the hall mouth
    d0, d1 = L.DOOR_HW
    for sx in (-1, 1):
        chamfer_box(p, (sx * (d0 + d1) / 2,
                        (L.DECK_Y + L.DOOR_TOP) / 2, hz0 - 0.55),
                    (d1 - d0, L.DOOR_TOP - L.DECK_Y, 0.55), 0.07,
                    {'+y': L.W_DOOR, '-y': L.W_DOOR, '+x': L.W_DOOR,
                     '-x': L.W_DOOR, '+z': L.W_DOOR,
                     '-z': L.mir(L.W_DOOR)})


def build_deck(p):
    """Forward fitting-out basin: railings, slipway, clutter, office."""
    rz0, rz1 = L.RAIL_Z
    for sx in (-1, 1):
        P.railing(p, (sx * L.RAIL_X, L.DECK_Y, rz0),
                  (sx * L.RAIL_X, L.DECK_Y, rz1), h=L.RAIL_H,
                  post_step=3.2, r=0.055, zone=L.W_RAIL)
    # gantry rails on both caisson decks
    for sx in (-1, 1):
        box(p, (sx * L.CRANE_RAIL_X, L.DECK_Y + 0.09, (L.Z_FWD + 1.2) / 2),
            (0.5, 0.18, L.Z_FWD * -1 + 1.2), L.W_DECK, ch=0.04,
            skip=('-y',))

    # slipway ramp on the starboard caisson, dipping into the basin
    sx0, sx1 = L.SLIP_X
    sz0, sz1 = L.SLIP_Z
    sy0, sy1 = L.SLIP_Y
    top = [(sx0, sy0, sz0), (sx1, sy0, sz0), (sx1, sy1, sz1), (sx0, sy1, sz1)]
    quad_out(p, top, (0, 1, -0.35), L.W_DECK)
    quad_out(p, [(v[0], v[1] - 0.35, v[2]) for v in top],
             (0, -1, 0.35), L.W_DARK)
    for sxv, o in ((sx0, -1), (sx1, 1)):
        quad_out(p, [(sxv, sy0, sz0), (sxv, sy1, sz1),
                     (sxv, sy1 - 0.35, sz1), (sxv, sy0 - 0.35, sz0)],
                 (o, 0, 0), L.W_CAIS_IN)

    # site office cabin (port deck) with a shallow lean-to roof
    ox, oz, (ow, oh, od) = L.OFFICE
    zo = {'+y': L.W_OFFICE, '-y': L.W_OFFICE, '+x': L.W_OFFICE,
          '-x': L.W_OFFICE, '+z': L.W_OFFICE, '-z': L.mir(L.W_OFFICE)}
    chamfer_box(p, (ox, L.DECK_Y + oh / 2, oz), (ow, oh, od), 0.07, zo,
                skip=('-y',))
    chamfer_box(p, (ox, L.DECK_Y + oh + 0.12, oz),
                (ow + 0.45, 0.24, od + 0.45), 0.05, zo)
    P.antenna(p, (ox - 1.1, L.DECK_Y + oh + 0.24, oz), h=2.3, r=0.05,
              zone=L.W_RAIL)

    # stacked plate steel
    for (px, pz, (pw, ph, pd)) in L.PLATES:
        for i in range(3):
            cy = L.DECK_Y + ph * (i + 0.5)
            box(p, (px + (i % 2) * 0.16, cy, pz - i * 0.14),
                (pw - i * 0.22, ph, pd - i * 0.2),
                obj_zone(px, cy, 2.1), ch=0.03, skip=('-y',))
    # skips
    for (kx, kz, (kw, kh, kd)) in L.SKIPS:
        cy = L.DECK_Y + kh / 2
        box(p, (kx, cy, kz), (kw, kh, kd), obj_zone(kx, cy, 1.6), ch=0.06,
            skip=('-y',))
    # welding gas bottle racks: frame + bottles
    for (rx, rz) in L.RACKS:
        cy = L.DECK_Y + 0.85
        box(p, (rx, cy, rz), (1.9, 1.7, 0.85), obj_zone(rx, cy, 1.3),
            ch=0.05, skip=('-y',))
        for i in range(4):
            bx = rx - 0.62 + i * 0.42
            limb(p, (bx, L.DECK_Y + 0.05, rz - 0.02),
                 (bx, L.DECK_Y + 1.55, rz - 0.02), 0.16, 0.14,
                 L.W_LAMP, n=5, cap_end=L.W_DARK)
    # cable reels (drum on axis X)
    for (cx, cz) in L.REELS:
        cy = L.DECK_Y + 0.95
        limb(p, (cx - 0.55, cy, cz), (cx + 0.55, cy, cz), 0.92, 0.92,
             L.W_REEL, n=8, cap_start=L.W_DARK, cap_end=L.W_DARK)

    # outboard-face fittings: fenders, bollards, chain stubs, ladders
    for sx in (-1, 1):
        for fz in L.FENDER_Z:
            limb(p, (sx * 17.25, 1.3, fz), (sx * 17.25, -1.3, fz),
                 0.36, 0.36, L.W_FENDER, n=6, cap_start=L.W_DARK,
                 cap_end=L.W_DARK)
        for bz in L.BOLLARD_Z:
            limb(p, (sx * 16.95, 2.35, bz), (sx * 17.55, 2.35, bz),
                 0.24, 0.20, L.W_CHAIN, n=5, cap_end=L.W_DARK)
        for cz in L.CHAIN_Z:
            limb(p, (sx * 17.05, 0.9, cz), (sx * 17.55, -1.4, cz + 0.5),
                 0.13, 0.11, L.W_CHAIN, n=4, cap_end=L.W_DARK)
        for lz in L.LADDER_Z:
            P.ladder(p, (sx * 17.1, -0.9, lz), (sx * 17.1, L.DECK_Y, lz),
                     width=0.52, rail_r=0.055, rung_step=0.5, zone=L.W_RAIL)


def build_body():
    p = Part('body')
    build_caissons(p)
    build_pen(p)
    build_hall(p)
    build_deck(p)
    return p


# ── crane piece (PIECE-LOCAL coords; offset places it) ───────────────────

def build_crane():
    p = Part('crane')
    yb, yt = L.CR_BRIDGE_Y, L.CR_TOP
    # face zoning: ±x/±y read along z, ±z read along x
    zl = {'+x': L.W_CRANE, '-x': L.W_CRANE, '+y': L.W_CRANE, '-y': L.W_CRANE,
          '+z': L.W_CRANE_F, '-z': L.mir(L.W_CRANE_F)}
    for sx in (-1, 1):
        x = sx * L.CR_LEG_X
        # sill beam + bogies riding the rail
        chamfer_box(p, (x, 0.45, 0.0), (1.5, 0.9, 3.4), 0.09, zl)
        for dz in (-1.15, 1.15):
            chamfer_box(p, (x, 0.22, dz), (1.7, 0.5, 0.9), 0.05, zl)
        # A-legs splaying inboard to the girder
        for dz in (-1.05, 1.05):
            limb(p, (x, 0.9, dz), (x - sx * 0.85, yb - 0.75, dz * 0.42),
                 0.33, 0.26, L.W_GIRDER, n=4)
        # portal cross-brace + diagonal
        limb(p, (x, 4.4, -1.05), (x, 4.4, 1.05), 0.16, 0.16, L.W_GIRDER, n=4)
        limb(p, (x, 1.1, -1.0), (x - sx * 0.6, 7.6, 0.7), 0.13, 0.13,
             L.W_GIRDER, n=4)
    # box girder bridge across the basin
    chamfer_box(p, (0.0, yb, 0.0), (2 * L.CR_SPAN, 1.6, 2.1), 0.1,
                {'+y': L.W_CR_TOP, '-y': L.W_CR_TOP,
                 '+x': L.W_CRANE, '-x': L.W_CRANE,
                 '+z': L.W_CRANE_F, '-z': L.mir(L.W_CRANE_F)})
    # machinery house + walkway rail on top of the girder
    chamfer_box(p, (-9.5, yb + 1.35, 0.0), (4.2, 1.3, 2.0), 0.09, zl)
    for dz in (-1.0, 1.0):
        limb(p, (-L.CR_SPAN + 0.6, yt - 1.1, dz),
             (L.CR_SPAN - 0.6, yt - 1.1, dz), 0.09, 0.09, L.W_RAIL, n=3)
    # trolley + hook block on ropes
    chamfer_box(p, (2.6, L.CR_TROLLEY_Y, 0.0), (3.0, 1.0, 2.3), 0.07, zl)
    for dx in (-0.75, 0.75):
        limb(p, (2.6 + dx, L.CR_TROLLEY_Y - 0.5, 0.0),
             (2.6 + dx, L.CR_HOOK_Y + 0.35, 0.0), 0.05, 0.05, L.W_ROPE, n=3)
    chamfer_box(p, (2.6, L.CR_HOOK_Y, 0.0), (1.5, 0.7, 0.8), 0.06, zl)
    limb(p, (2.6, L.CR_HOOK_Y - 0.35, 0.0), (2.6, L.CR_HOOK_Y - 1.0, 0.25),
         0.16, 0.12, L.W_CHAIN, n=4, cap_end=L.W_DARK)
    return p


# ── clips ────────────────────────────────────────────────────────────────

def build_clips():
    """idle (12 s): the gantry dwells at the seaward end, traverses aft
    over the basin, dwells, and returns.  ABSOLUTE node translations;
    last key repeats the first."""
    ox, oy, _ = L.CRANE_OFF
    z0, z1 = L.CRANE_Z0, L.CRANE_Z1
    keys = [(0.0, (ox, oy, z0)), (2.2, (ox, oy, z0)),
            (5.6, (ox, oy, z1)), (7.8, (ox, oy, z1)),
            (12.0, (ox, oy, z0))]
    return [{'name': 'idle', 'channels': [('crane', 'translation', keys)]}]


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='crane', parent=0, offset=L.CRANE_OFF, part=build_crane()),
    ]


if __name__ == '__main__':
    import sys
    pieces = build_all()
    clips = build_clips()
    modes = ['png'] if 'png' in sys.argv[1:] else ['ktx2', 'png']
    os.makedirs(OUT, exist_ok=True)
    for mode in modes:
        export(pieces, STEM, texmode=mode, outdir=OUT, clips=clips,
               normal_map=True)
    allv = np.array([v for pc in pieces if pc['part']
                     for v in pc['part'].pos])
    off = np.array(L.CRANE_OFF)
    cv = np.array(pieces[1]['part'].pos) + off
    bv = np.array(pieces[0]['part'].pos)
    ext = np.vstack([bv, cv,
                     np.array(pieces[1]['part'].pos) + [0, L.DECK_Y, L.CRANE_Z0],
                     np.array(pieces[1]['part'].pos) + [0, L.DECK_Y, L.CRANE_Z1]])
    print(f'[gen] extents x {ext[:,0].min():.2f}..{ext[:,0].max():.2f}  '
          f'y {ext[:,1].min():.2f}..{ext[:,1].max():.2f}  '
          f'z {ext[:,2].min():.2f}..{ext[:,2].max():.2f}')
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        if pc['part']:
            print(f"  {pc['name']}: {pc['part'].tri_count()} tris")
    print(f'TOTAL {total} tris')
