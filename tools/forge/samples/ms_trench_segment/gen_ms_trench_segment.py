"""gen_ms_trench_segment — 8 m revetted field trench, tiles end to end.

Field-engineering piece for the drill-down build menu (units-assets review
2026-09-10). Front spoil parapet with a plank-and-post revetment and a sandbag
firing course, duckboarded floor, lower rear bank, a firing step and a leaning
corrugated sheet for silhouette. ONE piece `body`, no clips, no team surface.
Run: python3 gen_ms_trench_segment.py -> out/ms_trench_segment{,_png}.gltf+.bin
"""
import numpy as np

import ms_trench_segment_layout as L
from meshlib import Part, chamfer_box, limb
from gltf_export import export

STEM = 'ms_trench_segment'
OUT = 'out'
HALF = L.SEG_HALF


def quad_out(p, verts, outward, zone):
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else verts[::-1], zone=zone)


def parapet(p, z_out, z_in, h, batt, out_dir):
    """Spoil bank running along X. `out_dir` is -1 for the front parapet
    (outer face at -Z) and +1 for the rear bank. The outer face batters back
    by `batt` at the crest; the inner face stands vertical (it is revetted).
    Open bottom — the model never dips below Y=0."""
    zo, zi = z_out, z_in
    zc = zo - out_dir * batt          # crest edge above the outer face
    # outer battered face
    quad_out(p, [(-HALF, 0, zo), (HALF, 0, zo), (HALF, h, zc), (-HALF, h, zc)],
             (0, 0.4, out_dir), L.EARTH_F)
    # inner vertical face
    quad_out(p, [(-HALF, 0, zi), (HALF, 0, zi), (HALF, h, zi), (-HALF, h, zi)],
             (0, 0, -out_dir), L.EARTH_F)
    # crest
    quad_out(p, [(-HALF, h, zc), (HALF, h, zc), (HALF, h, zi), (-HALF, h, zi)],
             (0, 1, 0), L.EARTH_TOP)
    # end caps, so a run of segments butts cleanly
    for (x, ox) in ((-HALF, -1), (HALF, 1)):
        quad_out(p, [(x, 0, zo), (x, h, zc), (x, h, zi), (x, 0, zi)],
                 (ox, 0, 0), L.EARTH_Z)


def build_body():
    p = Part('body')
    parapet(p, L.FRONT_Z[0], L.FRONT_Z[1], L.FRONT_H, L.FRONT_BATT, -1)
    parapet(p, L.REAR_Z[1], L.REAR_Z[0], L.REAR_H, L.REAR_BATT, 1)

    # duckboarded floor between the parapets
    z0, z1 = L.FLOOR_Z
    quad_out(p, [(-HALF, L.FLOOR_Y, z0), (HALF, L.FLOOR_Y, z0),
                 (HALF, L.FLOOR_Y, z1), (-HALF, L.FLOOR_Y, z1)],
             (0, 1, 0), L.BOARD)

    # plank revetment on the front parapet's inner face, standing just proud
    zr = L.FRONT_Z[1] + 0.05
    quad_out(p, [(-HALF, 0.02, zr), (HALF, 0.02, zr),
                 (HALF, L.PLANK_TOP, zr), (-HALF, L.PLANK_TOP, zr)],
             (0, 0, 1), L.PLANK)
    quad_out(p, [(-HALF, L.PLANK_TOP, zr), (HALF, L.PLANK_TOP, zr),
                 (HALF, L.PLANK_TOP, L.FRONT_Z[1]),
                 (-HALF, L.PLANK_TOP, L.FRONT_Z[1])], (0, 1, 0), L.TIMBER)
    # retaining posts holding the revetment
    for x in L.POSTS_X:
        limb(p, (x, 0.02, L.POST_Z), (x, L.POST_H, L.POST_Z), 0.075, 0.065,
             L.TIMBER.rect, n=4, cap_end=L.TIMBER)

    # sandbag firing course along the front crest
    bh, bd = L.BAG_SIZE
    for (cx, length) in L.BAGS:
        chamfer_box(p, (cx, L.FRONT_H + bh / 2, L.BAG_Z), (length, bh, bd),
                    0.11, {'+y': L.SAND_TOP, '-z': L.SAND, '+z': L.SAND,
                           '+x': L.SAND, '-x': L.SAND}, skip=('-y',))

    # firing step against the revetment
    sw, sh, sd = L.STEP
    scx, scz = L.STEP_POS
    chamfer_box(p, (scx, sh / 2 + L.FLOOR_Y, scz), (sw, sh, sd), 0.04,
                {'+y': L.BOARD, '-z': L.TIMBER, '+z': L.TIMBER,
                 '+x': L.TIMBER, '-x': L.TIMBER}, skip=('-y',))

    # corrugated sheet leaning against the rear bank (overhead cover, stowed)
    cx, cz, cw, ch = L.SHEET
    quad_out(p, [(cx - cw / 2, 0.03, cz - 0.30), (cx + cw / 2, 0.03, cz - 0.30),
                 (cx + cw / 2, ch, cz + 0.22), (cx - cw / 2, ch, cz + 0.22)],
             (0, 0.5, -1), L.PLANK)
    return p


def build_all():
    return [dict(name='body', parent=-1, offset=(0.0, 0.0, 0.0),
                 part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
