"""gen_airship — build fable_airship (FT-2 Pelican) + idle clip.

Rigid dirigible transport: 65 m faceted envelope, forward gondola with
skids, four podded props (spin in idle), cruciform tail, ventral cargo
keel with two open cradle bays, winches, grapple hooks and the ZK-style
`link1`/`link2` transport attachment empties.

Usage: python3 gen_airship.py [png]
"""
from __future__ import annotations
import numpy as np

import airship_layout as A         # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'fable_airship'
OUT = 'out'


def ring_ellipse(z, cy, r, n):
    pts = []
    for i in range(n):
        a = np.pi / n + 2 * np.pi * i / n
        pts.append((r * np.cos(a), cy + r * np.sin(a), z))
    return pts


def env_zone(c, n):
    if n[1] > 0.55:
        return A.A_TOP
    if n[1] < -0.55:
        return A.A_BELLY
    return A.A_SIDE


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def spike(p, base_c, base_w, base_d, apex, zone):
    bx, by, bz = base_c
    corners = [(bx - base_w / 2, by, bz - base_d / 2),
               (bx + base_w / 2, by, bz - base_d / 2),
               (bx + base_w / 2, by, bz + base_d / 2),
               (bx - base_w / 2, by, bz + base_d / 2)]
    ap = (bx + apex[0], by + apex[1], bz + apex[2])
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        c = np.mean([a, b, ap], axis=0)
        out = np.asarray(c) - np.asarray([bx, by, bz])
        n = np.cross(np.asarray(b) - np.asarray(a), np.asarray(ap) - np.asarray(a))
        p.add_face([a, b, ap] if np.dot(n, out) > 0 else [b, a, ap], zone=zone)


def quad_out(p, verts, outward, zone):
    """Add a quad wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, outward) > 0 else verts[::-1], zone=zone)


def fin(p, axis, root, tip, flat_zone):
    """Tapered tail fin: root section buried in the envelope, swept tip.
    axis 'x' → horizontal fin (thickness along y, centred on env axis);
    axis 'y' → vertical fin (thickness along x)."""
    thr, tht = A.FIN_TH
    zr0, zr1 = A.FIN_Z - A.CHORD_ROOT / 2, A.FIN_Z + A.CHORD_ROOT / 2
    zt0 = A.FIN_Z + A.FIN_SWEEP - A.CHORD_TIP / 2
    zt1 = A.FIN_Z + A.FIN_SWEEP + A.CHORD_TIP / 2

    def V(span, off, z):
        return (span, 9.2 + off, z) if axis == 'x' else (off, span, z)

    r0p, r0m = V(root, thr / 2, zr0), V(root, -thr / 2, zr0)
    r1p, r1m = V(root, thr / 2, zr1), V(root, -thr / 2, zr1)
    t0p, t0m = V(tip, tht / 2, zt0), V(tip, -tht / 2, zt0)
    t1p, t1m = V(tip, tht / 2, zt1), V(tip, -tht / 2, zt1)
    up = (0, 1, 0) if axis == 'x' else (1, 0, 0)
    dn = tuple(-c for c in up)
    out = np.zeros(3)
    out['xy'.index(axis)] = 1.0 if tip > root else -1.0
    quad_out(p, [r0p, r1p, t1p, t0p], up, flat_zone)
    quad_out(p, [r0m, r1m, t1m, t0m], dn, flat_zone)
    quad_out(p, [r0p, r0m, t0m, t0p], (0, 0, -1), A.A_TRIM)   # leading edge
    quad_out(p, [r1p, r1m, t1m, t1p], (0, 0, 1), A.A_TRIM)    # trailing edge
    quad_out(p, [t0p, t0m, t1m, t1p], out, A.A_TRIM)          # tip cap


def build_body():
    p = Part('body')
    rings = [ring_ellipse(z, cy, r, A.ENV_N) for (z, cy, r) in A.ENV_SECTIONS]
    loft(p, rings, env_zone, cap_start=A.A_DARK, cap_end=A.A_DARK)
    # nose mooring cone
    mx, my, mz = A.MOOR_TIP
    tube(p, [(mz + 1.3, 0.55, my), (mz + 0.2, 0.2, my)], A.A_MOOR, n=8,
         cap_end=A.A_DARK)
    # dorsal spine walkway + antenna masts
    box(p, (0.0, 16.35, -2.0), (0.9, 0.35, 34.0), A.A_TOP, ch=0.03)
    for az_ in (-14.0, 2.0, 16.0):
        limb(p, (0, 16.5, az_), (0, 17.9, az_), 0.06, 0.045, A.A_TRIM.rect, n=4)
    # gondola + window band + skids
    x, y, z, w, h, d = A.GONDOLA
    chamfer_box(p, (x, y, z), (w, h, d), 0.10,
                {'+x': A.A_GONDOLA, '-x': A.A_GONDOLA, '-z': A.A_GONDOLA_F,
                 '+z': A.A_GONDOLA_F, '+y': A.A_GONDOLA, '-y': A.A_GONDOLA})
    for (sx, sz) in A.SKIDS:
        box(p, (sx, 0.35, sz), (0.3, 0.5, 1.6), A.A_TRIM, ch=0.03)
    # struts tying the gondola into the envelope
    for (sx, sz) in ((-2.0, -22.0), (2.0, -22.0), (-2.0, -14.5), (2.0, -14.5)):
        limb(p, (sx, 3.8, sz), (sx * 1.4, 6.5, sz + 1.0), 0.09, 0.08,
             A.A_TRIM.rect, n=4)
    # ventral cargo keel + two cradle bays
    box(p, (0.0, 2.35, 1.0), (2.4, 0.8, 22.0), A.A_CRADLE, ch=0.06)
    for bz in A.BAYS:
        for sx in (-1.9, 1.9):     # side rails
            box(p, (sx, 1.75, bz), (0.35, 0.5, A.BAY_LEN), A.A_CRADLE,
                ch=0.03)
        for dz in (-A.BAY_LEN / 2, A.BAY_LEN / 2):   # cross beams
            box(p, (0.0, 1.85, bz + dz), (4.1, 0.45, 0.5), A.A_CRADLE,
                ch=0.03)
        # winch drums + cables + grapple hooks
        for (sx, dz) in ((-1.2, -2.6), (1.2, -2.6), (-1.2, 2.6), (1.2, 2.6)):
            box(p, (sx, 2.15, bz + dz), (0.55, 0.5, 0.55), A.A_WINCH, ch=0.03)
            box(p, (sx, 1.55, bz + dz), (0.07, 0.8, 0.07), A.A_TRIM, ch=0.01)
            spike(p, (sx, 1.18, bz + dz), 0.26, 0.26, (0.0, -0.34, 0.12),
                  A.A_WINCH)
        # bay floodlights
        box(p, (0.0, 2.0, bz), (0.4, 0.3, 0.4), A.A_LIGHT, ch=0.02)
    # nacelles: pylon + pod (props are separate pieces)
    for (nx, ny, nz) in A.NACELLES:
        limb(p, (nx * 0.72, ny + 1.6, nz + 0.3), (nx, ny, nz + 0.4), 0.14,
             0.11, A.A_TRIM.rect, n=4)
        tube(p, [(nz - A.POD_LEN / 2, A.POD_R, ny), (nz + A.POD_LEN / 2 - 0.7,
                 A.POD_R, ny), (nz + A.POD_LEN / 2, A.POD_R * 0.55, ny)],
             A.A_NACELLE, n=8, xoff=nx, cap_start=A.A_DARK, cap_end=A.A_DARK)
    # cruciform tail — tapered fins, roots buried in the envelope
    for s in (1, -1):                     # horizontal pair (flat faces up/down)
        fin(p, axis='x', root=s * A.FIN_H_ROOT, tip=s * A.FIN_H_TIP,
            flat_zone=A.A_FIN_H)
    fin(p, axis='y', root=A.FIN_VT_ROOT, tip=A.FIN_VT_TIP,
        flat_zone=A.A_FIN)                # dorsal
    fin(p, axis='y', root=A.FIN_VB_ROOT, tip=A.FIN_VB_TIP,
        flat_zone=A.A_FIN)                # ventral
    # nav light housings (own cells: port red / starboard green)
    box(p, (7.1, 9.2, -6.0), (0.28, 0.28, 0.5), A.A_NAVP, ch=0.02)
    box(p, (-7.1, 9.2, -6.0), (0.28, 0.28, 0.5), A.A_NAVS, ch=0.02)
    return p


def build_prop(name):
    p = Part(name)
    ring_f = ngon_ring((0, 0, -0.03), A.PROP_R, n=10, axis='z')
    ring_b = ngon_ring((0, 0, 0.03), A.PROP_R, n=10, axis='z')
    p.add_face(list(ring_f), zone=A.A_PROP, flip=True)
    p.add_face(list(ring_b), zone=A.A_PROP)
    hub = ngon_ring((0, 0, -0.09), 0.2, n=8, axis='z')
    p.add_face(list(hub), zone=A.A_DARK, flip=True)
    return p


def qz(deg):
    r = np.radians(deg) / 2
    return (0.0, 0.0, float(np.sin(r)), float(np.cos(r)))


def build_clips():
    T = 6.0
    keys = [(T * i / 12, qz(90.0 * i)) for i in range(13)]
    idle = {
        'name': 'idle',
        'channels': [(f'prop{i + 1}', 'rotation', keys) for i in range(4)],
    }
    return [idle]


def build_all():
    pieces = [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),    # 0
    ]
    for i, (nx, ny, nz) in enumerate(A.NACELLES):
        pieces.append(dict(name=f'prop{i + 1}', parent=0,
                           offset=(nx, ny, nz - A.POD_LEN / 2 - 0.12),
                           part=build_prop(f'prop{i + 1}')))
    pieces.append(dict(name='link1', parent=0, offset=A.LINKS[0], part=None))
    pieces.append(dict(name='link2', parent=0, offset=A.LINKS[1], part=None))
    pieces.append(dict(name='exhaust', parent=0, offset=A.EXHAUST_OFF,
                       part=None))
    return pieces


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_airship] total tris: {total}')
