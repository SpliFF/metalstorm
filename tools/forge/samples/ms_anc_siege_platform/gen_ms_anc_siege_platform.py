"""gen_ms_anc_siege_platform — assemble ms_anc_siege_platform, export gltf.

ANCIENT siege mortar platform. Piece table:
    0 body    — cantilevered ziggurat platform, sunk circular well, four
                corner pylons, two frozen loading arms + charge shell, and
                three unsupported floating halo arcs.
    1 turret  — rotating ring mount (annular monolith + trunnion cheeks)
    2 barrel  — 8 m bore tube, pivots from the cheeks, rests along -Z
    3 muzzle  — empty at the bore mouth

Run: python3 gen_ms_anc_siege_platform.py -> out/ms_anc_siege_platform{,_png}.gltf
"""
import numpy as np

import ms_anc_siege_platform_layout as F     # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, ngon_ring, limb, tube
from gltf_export import export

STEM = 'ms_anc_siege_platform'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── local primitives (candidates for prefabs/parts.py) ───────────────────

def ring_wall(p, y0, y1, r0, r1, n, rect, outward=True, phase=None):
    """Vertical n-gon wall (radius r0 at y0 -> r1 at y1) with parametric UV:
    u runs around the circumference, v runs down the wall. Winding is fixed
    by a radial test so `outward=False` gives a clean inward-facing bore."""
    a0, b0, a1, b1 = rect
    lo = ngon_ring((0, y0, 0), r0, n=n, axis='y', phase=phase)
    hi = ngon_ring((0, y1, 0), r1, n=n, axis='y', phase=phase)
    for j in range(n):
        k = (j + 1) % n
        u0 = (a0 + (a1 - a0) * j / n) / M.ATLAS
        u1 = (a0 + (a1 - a0) * (j + 1) / n) / M.ATLAS
        quad = [lo[j], lo[k], hi[k], hi[j]]
        uvs = [(u0, b1 / M.ATLAS), (u1, b1 / M.ATLAS),
               (u1, b0 / M.ATLAS), (u0, b0 / M.ATLAS)]
        c = np.mean(np.array(quad, dtype=float), axis=0)
        rad = np.array([c[0], 0.0, c[2]])
        nn = np.cross(np.asarray(quad[1], float) - np.asarray(quad[0], float),
                      np.asarray(quad[3], float) - np.asarray(quad[0], float))
        if np.dot(nn, rad) * (1.0 if outward else -1.0) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)


def annulus(p, y, r_in, r_out, n, zone, up=True, phase=None):
    """Flat n-gon annulus in the XZ plane (planar zone projection)."""
    ri = ngon_ring((0, y, 0), r_in, n=n, axis='y', phase=phase)
    ro = ngon_ring((0, y, 0), r_out, n=n, axis='y', phase=phase)
    for j in range(n):
        k = (j + 1) % n
        quad = [ri[j], ro[j], ro[k], ri[k]]
        nn = np.cross(np.asarray(quad[1], float) - np.asarray(quad[0], float),
                      np.asarray(quad[3], float) - np.asarray(quad[0], float))
        if nn[1] * (1.0 if up else -1.0) < 0:
            quad = quad[::-1]
        p.add_face(quad, zone=zone)


def square_ring_top(p, y, r_hole, half, n, zone, phase=None):
    """Deck top as a square plate with a perfectly circular hole: each of n
    sectors bridges the well rim to the square perimeter. Gives the deck a
    real opening (no quad hiding the well) and spreads UVs radially."""
    inner = ngon_ring((0, y, 0), r_hole, n=n, axis='y', phase=phase)
    ph = (np.pi / n) if phase is None else phase
    outer = []
    for i in range(n):
        a = ph + 2 * np.pi * i / n
        ca, sa = np.cos(a), np.sin(a)
        s = half / max(abs(ca), abs(sa))
        outer.append((s * ca, y, s * sa))
    for j in range(n):
        k = (j + 1) % n
        quad = [inner[j], outer[j], outer[k], inner[k]]
        nn = np.cross(np.asarray(quad[1], float) - np.asarray(quad[0], float),
                      np.asarray(quad[3], float) - np.asarray(quad[0], float))
        if nn[1] < 0:
            quad = quad[::-1]
        p.add_face(quad, zone=zone)


def arc_bar(p, r, y0, y1, a0, a1, segs, w, h, rect):
    """Rectangular-section bar swept along an arc in XZ, rising y0 -> y1.
    Free-floating ancient halo segment; capped at both ends."""
    x0, py0, x1, py1 = rect
    secs, ctrs = [], []
    for i in range(segs + 1):
        t = i / segs
        a = np.radians(a0 + (a1 - a0) * t)
        yy = y0 + (y1 - y0) * t
        ca, sa = np.cos(a), np.sin(a)
        ri, ro = r - w / 2, r + w / 2
        secs.append([(ri * ca, yy - h / 2, ri * sa), (ro * ca, yy - h / 2, ro * sa),
                     (ro * ca, yy + h / 2, ro * sa), (ri * ca, yy + h / 2, ri * sa)])
        ctrs.append((r * ca, yy, r * sa))
    for i in range(segs):
        s0, s1 = secs[i], secs[i + 1]
        u0 = (x0 + (x1 - x0) * i / segs) / M.ATLAS
        u1 = (x0 + (x1 - x0) * (i + 1) / segs) / M.ATLAS
        ctr = (np.array(ctrs[i], float) + np.array(ctrs[i + 1], float)) / 2.0
        for j in range(4):
            k = (j + 1) % 4
            quad = [s0[j], s0[k], s1[k], s1[j]]
            v0 = (py0 + (py1 - py0) * j / 4) / M.ATLAS
            v1 = (py0 + (py1 - py0) * (j + 1) / 4) / M.ATLAS
            uvs = [(u0, v0), (u0, v1), (u1, v1), (u1, v0)]
            c = np.mean(np.array(quad, float), axis=0)
            nn = np.cross(np.asarray(quad[1], float) - np.asarray(quad[0], float),
                          np.asarray(quad[3], float) - np.asarray(quad[0], float))
            if np.dot(nn, c - ctr) < 0:
                quad, uvs = quad[::-1], uvs[::-1]
            p.add_face(quad, uvs=uvs)
    cap_uv = [(x0 / M.ATLAS, py0 / M.ATLAS), (x1 / M.ATLAS, py0 / M.ATLAS),
              (x1 / M.ATLAS, py1 / M.ATLAS), (x0 / M.ATLAS, py1 / M.ATLAS)]
    for idx, nb in ((0, 1), (len(secs) - 1, len(secs) - 2)):
        sec = secs[idx]
        out = np.array(ctrs[idx], float) - np.array(ctrs[nb], float)
        nn = np.cross(np.asarray(sec[1], float) - np.asarray(sec[0], float),
                      np.asarray(sec[3], float) - np.asarray(sec[0], float))
        p.add_face(sec if np.dot(nn, out) > 0 else sec[::-1], uvs=cap_uv)


# ── body ─────────────────────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # buried plinth (bottom face skipped — it is in the ground)
    x, y, z, w, h, d = F.PLINTH
    chamfer_box(p, (x, y, z), (w, h, d), 0.18,
                {'+y': F.R_PLIN_T, '+x': F.R_PLIN_S, '-x': F.R_PLIN_S,
                 '+z': F.R_PLIN_SF, '-z': F.R_PLIN_SF}, skip=('-y',))

    # mid step (carries the capture panel band)
    x, y, z, w, h, d = F.MID
    chamfer_box(p, (x, y, z), (w, h, d), 0.18,
                {'+y': F.R_MID_T, '-y': F.R_DARK, '+x': F.R_MID_S,
                 '-x': F.R_MID_S, '+z': F.R_MID_SF, '-z': F.R_MID_SF})

    # cantilevered 22 m deck — top face replaced by the pierced square ring
    x, y, z, w, h, d = F.DECK
    chamfer_box(p, (x, y, z), (w, h, d), F.DECK_CH,
                {'-y': F.R_DARK, '+x': F.R_DECK_S, '-x': F.R_DECK_S,
                 '+z': F.R_DECK_SF, '-z': F.R_DECK_SF}, skip=('+y',))
    square_ring_top(p, F.DECK_TOP, F.CURB_R, F.DECK_HALF, F.WELL_N, F.R_DECK)

    # raised curb: a perfect circle standing proud of the deck around the well
    ring_wall(p, F.DECK_TOP, F.CURB_TOP, F.CURB_R, F.CURB_R, F.WELL_N,
              F.R_WELLW)
    annulus(p, F.CURB_TOP, F.WELL_R, F.CURB_R, F.WELL_N, F.R_MID_T)

    # emplacement well: inward-facing wall + floor disc
    ring_wall(p, F.WELL_Y, F.CURB_TOP, F.WELL_R, F.WELL_R, F.WELL_N,
              F.R_WELLW, outward=False)
    p.add_face(ngon_ring((0, F.WELL_Y, 0), F.WELL_R, n=F.WELL_N, axis='y'),
               zone=F.R_WELL_F, flip=True)

    # four corner pylons: square-section monoliths leaning inboard
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (sx * F.PYL_XZ, F.DECK_TOP - 0.2, sz * F.PYL_XZ),
                 (sx * F.PYL_TOP_XZ, F.PYL_TOP_Y, sz * F.PYL_TOP_XZ),
                 F.PYL_R0, F.PYL_R1, F.R_PYLON, n=4,
                 cap_end=F.R_SHELL_C)

    # loading arms, frozen mid-load (two segments each, mirrored)
    for sx in (-1, 1):
        b = (sx * F.ARM_BASE[0], F.ARM_BASE[1] - 0.25, F.ARM_BASE[2])
        m = (sx * F.ARM_MID[0], F.ARM_MID[1], F.ARM_MID[2])
        g = (sx * F.ARM_GRIP[0], F.ARM_GRIP[1], F.ARM_GRIP[2])
        limb(p, b, m, 0.62, 0.46, F.R_ARM, n=6)
        limb(p, m, g, 0.46, 0.30, F.R_ARM, n=6)
        # gripper claw reaching onto the shell
        limb(p, g, (sx * 0.98, F.SHELL_C[1] + 0.05, F.SHELL_C[2] + 0.30),
             0.26, 0.20, F.R_ARM, n=4)

    # the charge shell held between the arms (ovoid, nose toward the breech)
    sc = F.SHELL_C
    sub = Part('_shell')
    tube(sub, F.SHELL_STATIONS, F.R_SHELL, n=F.SHELL_N,
         cap_start=F.R_SHELL_C, cap_end=F.R_SHELL_C)
    _merge(p, sub, sc)

    # three unsupported halo arcs floating above the deck
    for (a0, a1, y0, y1) in F.HALO_ARCS:
        arc_bar(p, F.HALO_R, y0, y1, a0, a1, F.HALO_SEG,
                F.HALO_W, F.HALO_H, F.R_HALO)
    return p


def _merge(dst: Part, src: Part, offset):
    """Append src's geometry into dst, translated by offset."""
    base = len(dst.pos)
    ox, oy, oz = offset
    dst.pos.extend([(x + ox, y + oy, z + oz) for (x, y, z) in src.pos])
    dst.nrm.extend(src.nrm)
    dst.uv.extend(src.uv)
    dst.idx.extend([i + base for i in src.idx])


# ── turret: the rotating ring mount ──────────────────────────────────────

def build_turret():
    """Ring-mount local frame: origin on the well floor, +Y up. A seamless
    annular monolith — flared foot, glyph-banded outer wall, bored inner
    wall, flat crown — with two inner cheeks carrying the trunnion bosses."""
    p = Part('turret')
    N = F.RING_N
    # flared foot -> outer wall
    ring_wall(p, 0.0, F.RING_FLARE_H, F.RING_FLARE_R, F.RING_OUT_R, N, F.R_RING_B)
    ring_wall(p, F.RING_FLARE_H, F.RING_TOP, F.RING_OUT_R, F.RING_OUT_R, N, F.R_RING_O)
    # bored inner wall (faces inward) + crown annulus
    ring_wall(p, 0.0, F.RING_TOP, F.RING_IN_R, F.RING_IN_R, N, F.R_RING_I,
              outward=False)
    annulus(p, F.RING_TOP, F.RING_IN_R, F.RING_OUT_R, N, F.R_RING_T)

    # trunnion cheeks: monolithic slab buttresses rising out of the ring's
    # inner face and carrying the elevation pivot 6.30 m above the ground
    for sx in (-1, 1):
        chamfer_box(p, (sx * F.CHEEK_X, 2.25, 0.10), (1.55, 5.30, 4.30), 0.18,
                    {'+y': F.R_CHEEK_F, '+x': F.R_CHEEK_F, '-x': F.R_CHEEK_F,
                     '+z': F.R_CHEEK, '-z': F.R_CHEEK}, skip=('-y',))
        # trunnion boss the barrel pivots on
        limb(p, (sx * 1.95, F.PIVOT_Y, 0.0), (sx * 3.05, F.PIVOT_Y, 0.0),
             0.75, 0.90, F.R_BOSS, n=10, cap_start=F.R_SHELL_C)
    return p


# ── barrel + muzzle ──────────────────────────────────────────────────────

def build_barrel():
    """8 m breech-ring bore tube, authored along -Z (identity rest rotation)
    so the engine's elevation drives it cleanly from the trunnion pivot."""
    p = Part('barrel')
    tube(p, F.BORE_STATIONS, F.R_TUBE, n=F.BARREL_N,
         cap_start=F.R_BREECH, cap_end=F.R_BORE)
    # elevation quadrant plates riding the trunnion bosses (silhouette mass)
    for sx in (-1, 1):
        limb(p, (sx * 1.70, 0.0, 0.40), (sx * 1.70, 0.0, -1.10),
             1.20, 0.82, F.R_BOSS, n=8, cap_start=F.R_SHELL_C,
             cap_end=F.R_SHELL_C)
    return p


def build_all():
    return [
        dict(name='body',   parent=-1, offset=(0, 0, 0),      part=build_body()),
        dict(name='turret', parent=0,  offset=F.RING_OFF,     part=build_turret()),
        dict(name='barrel', parent=1,  offset=(0, F.PIVOT_Y, 0), part=build_barrel()),
        dict(name='muzzle', parent=2,  offset=F.MUZZLE_OFF,   part=Part('muzzle')),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']:<8} {pc['part'].tri_count():>5} tris")
    print(f'{STEM}: {total} tris')
