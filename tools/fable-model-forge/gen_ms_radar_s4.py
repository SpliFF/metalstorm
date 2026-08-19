"""gen_ms_radar_s4 — assemble ms_radar_s4 and export .gltf/.bin.

Theatre Surveillance Complex (radar s4, STYLE.md: 11 m): a battered
bunker plinth (blast door, vent stacks, cable trench, sandbag revetment)
carrying a faceted GEODESIC RADOME beside a tall braced lattice mast with
a crow's nest and guy lines.  The mast head carries the `dish` piece — a
long asymmetric SEARCH ARRAY BAR (slotted front, angled reflector spine,
counterweight one end, whip antenna the other) that rotates 360 deg over
14 s on the idle clip.  UNARMED: no turret/barrel/muzzle chain.
Run: python3 gen_ms_radar_s4.py  -> out/ms_radar_s4{,_png}.gltf + .bin
"""
import numpy as np

import ms_radar_s4_layout as F      # sets meshlib.ATLAS = 1024
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb, ngon_ring
import parts as P
from gltf_export import export

STEM = 'ms_radar_s4'
OUT = 'out'
RNG = np.random.default_rng(90210)
ALL = ('+y', '-y', '+x', '-x', '+z', '-z')
SIDES = ('+y', '+x', '-x', '+z', '-z')


# ── helpers ──────────────────────────────────────────────────────────────

def battered(p, y0, y1, hb, ht, z_top, z_f, z_s):
    """Bunker plinth: four battered (inward-sloping) walls + a deck."""
    b = [(-hb, y0, -hb), (hb, y0, -hb), (hb, y0, hb), (-hb, y0, hb)]
    t = [(-ht, y1, -ht), (ht, y1, -ht), (ht, y1, ht), (-ht, y1, ht)]
    P.quad_out(p, [b[0], b[1], t[1], t[0]], (0, 0, -1), z_f)
    P.quad_out(p, [b[2], b[3], t[3], t[2]], (0, 0, 1), z_f)
    P.quad_out(p, [b[1], b[2], t[2], t[1]], (1, 0, 0), z_s)
    P.quad_out(p, [b[3], b[0], t[0], t[3]], (-1, 0, 0), z_s)
    P.quad_out(p, t, (0, 1, 0), z_top)


def cell_rect(idx):
    """Normalised (u0, v0, u1, v1) of dome facet cell `idx`."""
    ox, oy = F.DOME_CELL_ORIGIN
    c = F.DOME_CELL
    col, row = idx % F.DOME_COLS, idx // F.DOME_COLS
    x0, y0 = ox + col * c, oy + row * c
    A = M.ATLAS
    return (x0 / A, y0 / A, (x0 + c) / A, (y0 + c) / A)


def geodesic_dome(p, cx, cz, cy, r, lats, n):
    """Stacked-ring faceted radome; every facet gets its own atlas panel
    cell so seams read at the facet edges and one panel is a mismatched
    replacement."""
    rings = []
    for la in lats:
        a = np.radians(la)
        rings.append(ngon_ring((cx, cy + r * np.sin(a), cz),
                               r * np.cos(a), n, axis='y'))
    ctr = np.array([cx, cy, cz])
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for j in range(n):
            k = (j + 1) % n
            quad = [r0[j], r0[k], r1[k], r1[j]]
            idx = F.DOME_REPAIR_CELL if (i, j) == (1, 4) else (j * 5 + i * 3) % 11
            u0, v0, u1, v1 = cell_rect(idx)
            uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)]
            out = np.mean(np.array(quad), axis=0) - ctr
            nn = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                          np.asarray(quad[3]) - np.asarray(quad[0]))
            if np.dot(nn, out) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            p.add_face(quad, uvs=uvs)
    # crown cap
    top = rings[-1]
    u0, v0, u1, v1 = cell_rect(2)
    mu, mv, rr = (u0 + u1) / 2, (v0 + v1) / 2, (u1 - u0) * 0.46
    uvs = [(mu + rr * np.cos(t), mv + rr * np.sin(t))
           for t in (np.pi / n + 2 * np.pi * np.arange(n) / n)]
    nn = np.cross(np.asarray(top[1]) - np.asarray(top[0]),
                  np.asarray(top[2]) - np.asarray(top[0]))
    if nn[1] < 0:
        top, uvs = top[::-1], uvs[::-1]
    p.add_face(top, uvs=uvs)


def lattice(p, mx, mz, y0, y1, hb, ht, leg_rect, brace_rect, bands=2):
    """Tapered four-leg lattice mast centred on (mx, mz)."""
    def half_at(y):
        return hb + (ht - hb) * (y - y0) / (y1 - y0)
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (mx + sx * hb, y0, mz + sz * hb),
                 (mx + sx * ht, y1, mz + sz * ht), 0.10, 0.06, leg_rect, n=4)
    ys = [y0 + (y1 - y0) * (i + 1) / (bands + 1) for i in range(bands)]
    for by in ys:
        h = half_at(by)
        cs = [(mx - h, by, mz - h), (mx + h, by, mz - h),
              (mx + h, by, mz + h), (mx - h, by, mz + h)]
        for i in range(4):
            limb(p, cs[i], cs[(i + 1) % 4], 0.045, 0.045, brace_rect, n=3)
    for ya, yb in zip([y0] + ys, ys + [y1]):
        ha, hb2 = half_at(ya), half_at(yb)
        for sa, sb in ((0, 1), (1, 2), (2, 3), (3, 0)):
            def corner(k, y, h):
                sx = (-1, 1, 1, -1)[k]
                sz = (-1, -1, 1, 1)[k]
                return (mx + sx * h, y, mz + sz * h)
            limb(p, corner(sa, ya, ha), corner(sb, yb, hb2), 0.032, 0.032,
                 brace_rect, n=3)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # battered bunker plinth + cap slab (the deck)
    battered(p, 0.0, F.PL_H, F.PL_HALF_B, F.PL_HALF_T,
             F.R_PL_TOP, F.R_PL_F, F.R_PL_S)
    chamfer_box(p, (0, F.PL_CAP_Y, 0), (2 * F.PL_HALF_T + 0.16, 0.16,
                                        2 * F.PL_HALF_T + 0.16), 0.05,
                {'+y': F.R_PL_TOP, '+x': F.R_PL_S, '-x': F.R_PL_S,
                 '+z': F.R_PL_F, '-z': F.R_PL_F}, skip=('-y',))

    # blast door on the -Z batter
    chamfer_box(p, (-0.82, 0.80, -3.06), (1.50, 1.50, 0.34), 0.05,
                {k: F.R_DOOR for k in ALL}, skip=('-y',))

    # sandbag revetment flanking the door
    P.sandbag_wall(p, (0.35, 0.0, -3.50), (2.55, 0.0, -3.50), h=0.62,
                   zone=F.R_BAG)

    # two vent stacks at the back of the deck
    for vx in (-0.55, 0.25):
        limb(p, (vx, F.PL_TOP - 0.05, 2.45), (vx, F.PL_TOP + 0.95, 2.45),
             0.23, 0.20, F.R_VENT, n=6, cap_end=F.R_DARK)

    # cable trench cover, mast base -> radome skirt
    chamfer_box(p, ((F.MAST_X + F.DOME_X) / 2, F.PL_TOP + 0.09, 1.45),
                (2.30, 0.18, 0.62), 0.05,
                {'+y': F.R_CONC, '+x': F.R_CONC, '-x': F.R_CONC,
                 '+z': F.R_CONC, '-z': F.R_CONC}, skip=('-y',))

    # geodesic radome: canvas-over-frame skirt band + faceted dome (STATIC)
    limb(p, (F.DOME_X, F.PL_TOP - 0.04, F.DOME_Z),
         (F.DOME_X, F.DOME_SKIRT_TOP, F.DOME_Z),
         F.DOME_R * 1.02, F.DOME_R, F.R_SKIRT, n=F.DOME_N)
    geodesic_dome(p, F.DOME_X, F.DOME_Z, F.DOME_SKIRT_TOP, F.DOME_R,
                  F.DOME_LATS, F.DOME_N)

    # braced lattice mast
    lattice(p, F.MAST_X, F.MAST_Z, F.PL_TOP, F.MAST_TOP,
            F.MAST_HB, F.MAST_HT, F.R_MAST, F.R_TRIM, bands=2)

    # crow's-nest platform
    chamfer_box(p, (F.MAST_X, F.NEST_Y, F.MAST_Z), (1.34, 0.10, 1.34), 0.03,
                {k: F.R_NEST for k in ALL})
    for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        limb(p, (F.MAST_X + sx * 0.6, F.NEST_Y + 0.05, F.MAST_Z + sz * 0.6),
             (F.MAST_X + sx * 0.6, F.NEST_Y + 0.85, F.MAST_Z + sz * 0.6),
             0.035, 0.035, F.R_TRIM, n=3)
    cs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for i in range(4):
        a, b = cs[i], cs[(i + 1) % 4]
        limb(p, (F.MAST_X + a[0] * 0.6, F.NEST_Y + 0.85, F.MAST_Z + a[1] * 0.6),
             (F.MAST_X + b[0] * 0.6, F.NEST_Y + 0.85, F.MAST_Z + b[1] * 0.6),
             0.030, 0.030, F.R_TRIM, n=3)

    # access ladder deck -> nest
    P.ladder(p, (F.MAST_X + 0.50, F.PL_TOP, F.MAST_Z - 0.52),
             (F.MAST_X + 0.20, F.NEST_Y, F.MAST_Z - 0.20),
             width=0.46, rung_step=0.52, zone=F.R_TRIM)

    # four guy lines, mast collar -> deck corners
    for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        gx = min(max(F.MAST_X + sx * F.GUY_R, -2.85), 2.85)
        gz = min(max(F.MAST_Z + sz * F.GUY_R, -2.85), 2.85)
        limb(p, (gx, F.PL_TOP + 0.02, gz), (F.MAST_X, F.GUY_Y, F.MAST_Z),
             0.022, 0.022, F.R_GUY, n=3)

    # amber lamps: mast head warning lamp on a bracket + two deck lamps
    limb(p, (F.MAST_X, F.LAMP_Y - 0.02, F.MAST_Z),
         (F.MAST_X + 0.34, F.LAMP_Y, F.MAST_Z), 0.035, 0.035, F.R_TRIM, n=3)
    chamfer_box(p, (F.MAST_X + 0.40, F.LAMP_Y + 0.08, F.MAST_Z),
                (0.24, 0.24, 0.24), 0.04, {k: F.R_LIGHT for k in ALL})
    for lx, lz in ((-2.70, -2.70), (2.70, -2.70)):
        limb(p, (lx, F.PL_TOP, lz), (lx, F.PL_TOP + 0.42, lz), 0.05, 0.05,
             F.R_TRIM, n=3)
        chamfer_box(p, (lx, F.PL_TOP + 0.54, lz), (0.20, 0.20, 0.20), 0.03,
                    {k: F.R_LIGHT for k in SIDES}, skip=('-y',))
    return p


# ── dish (search array bar) ──────────────────────────────────────────────

def build_dish():
    p = Part('dish')
    # slew collar on the mast head
    limb(p, (0, -0.18, 0), (0, 0.34, 0), 0.26, 0.22, F.R_COLLAR, n=8,
         cap_end=F.R_DARK)

    # main beam: long, narrow, slotted front face (-Z)
    cx = (F.BAR_X0 + F.BAR_X1) / 2
    w = F.BAR_X1 - F.BAR_X0
    chamfer_box(p, (cx, F.BAR_Y, 0.0), (w, F.BAR_H, F.BAR_D), 0.035,
                {'-z': F.R_BAR_F, '+z': F.R_BAR_B, '+y': F.R_BAR_T,
                 '-y': F.R_BAR_U, '+x': F.R_BAR_E, '-x': F.R_BAR_E})

    # angled reflector spine along the back, on three stand-off struts
    sz0, sz1 = 0.16, 0.62
    y0, y1 = F.BAR_Y + 0.20, F.BAR_Y - 0.16
    a = (F.BAR_X0, y0, sz0)
    b = (F.BAR_X1, y0, sz0)
    c = (F.BAR_X1, y1, sz1)
    d = (F.BAR_X0, y1, sz1)
    p.add_face([a, b, c, d], zone=F.R_SPINE)
    p.add_face([a, b, c, d], zone=F.R_SPINE, flip=True)
    for sx in (F.BAR_X0 + 0.35, cx, F.BAR_X1 - 0.35):
        limb(p, (sx, F.BAR_Y, 0.15), (sx, y1 + 0.02, sz1 - 0.04),
             0.045, 0.035, F.R_TRIM, n=3)

    # counterweight block at the short end
    chamfer_box(p, (F.CW_X, F.BAR_Y, 0.0), (0.62, 0.68, 0.52), 0.06,
                {k: F.R_CW for k in ALL})
    limb(p, (F.BAR_X0 + 0.04, F.BAR_Y, 0.0), (F.CW_X + 0.28, F.BAR_Y, 0.0),
         0.10, 0.10, F.R_TRIM, n=4)

    # whip antenna off the long array end
    limb(p, (F.WHIP_X, F.BAR_Y + 0.22, 0.0), (F.WHIP_X, F.WHIP_TOP, 0.0),
         0.035, 0.014, F.R_TRIM, n=3)
    return p


# ── clip ─────────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    T = 14.0
    keys = [(T * i / 6, qy(60.0 * i)) for i in range(7)]
    return [{'name': 'idle', 'channels': [('dish', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='dish', parent=0, offset=F.DISH_OFF, part=build_dish()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    lo = np.array([1e9, 1e9, 1e9])
    hi = -lo
    for pc in pieces:
        if not pc['part'].pos:
            continue
        o = np.array(pc['offset'], dtype=float)
        a, b = pc['part'].bounds()
        lo = np.minimum(lo, np.array(a) + o)
        hi = np.maximum(hi, np.array(b) + o)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
    print(f'bbox  min={tuple(round(v,3) for v in lo)} '
          f'max={tuple(round(v,3) for v in hi)} '
          f'size={tuple(round(v,3) for v in (hi-lo))}')
