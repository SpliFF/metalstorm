"""gen_ms_dress_order — Order dressing kit (accessory attachment pieces).

Four elements as separate ROOT pieces in one glTF (spec: dressing kit):
  applique (root)  three uniform applique plates in a display row
  staff (root)     pennant staff; child `flag` waves via seamless `idle`
                   clip (rigid Y-rotation about the staff axis)
  lightbar (root)  formation light bar on two stubs (emissive lenses)
  stowage (root)   regimented stowage rack: tray + posts + rails + crates
Deterministic: geometry from ms_dress_order_layout constants only.
Run: python3 gen_ms_dress_order.py → out/ms_dress_order{,_png}.gltf + .bin
"""
import numpy as np

import ms_dress_order_layout as L
import parts as P
from meshlib import Part, chamfer_box, limb
from gltf_export import export

STEM = 'ms_dress_order'
OUT = 'out'


def plate(p, cx, cy, w, h):
    chamfer_box(p, (cx, cy, 0.0), (w, h, L.PLATE_T), L.PLATE_CH,
                {'-z': L.PLATES_F, '+z': L.PLATES_F, '+y': L.TRIM,
                 '-y': L.TRIM, '+x': L.TRIM, '-x': L.TRIM})


def build_applique():
    p = Part('applique')
    for (cx, cy, w, h) in (L.PLATE_SIDE, L.PLATE_GLACIS, L.PLATE_ID):
        plate(p, cx, cy, w, h)
    return p


def build_staff():
    p = Part('staff')
    # base mount flange, pole, finial
    fw, fh, fd = L.FLANGE
    chamfer_box(p, (0.0, fh / 2, 0.0), (fw, fh, fd), 0.015,
                {'+y': L.TRIM, '+x': L.TRIM, '-x': L.TRIM,
                 '+z': L.TRIM, '-z': L.TRIM}, skip=('-y',))
    limb(p, (0.0, fh, 0.0), (0.0, L.STAFF_H, 0.0), L.STAFF_R0, L.STAFF_R1,
         L.TRIM.rect, n=6)
    nw, nh, nd = L.FINIAL
    chamfer_box(p, (0.0, L.STAFF_H + nh / 2, 0.0), (nw, nh, nd), 0.02,
                {'+y': L.TRIM, '-y': L.TRIM, '+x': L.TRIM, '-x': L.TRIM,
                 '+z': L.TRIM, '-z': L.TRIM})
    return p


def build_flag():
    p = Part('flag')
    # swallow-read pennant: hoist panel + tapering tip panel, planar cloth,
    # both sides explicit (front -Z → PEN_F, back +Z → PEN_B)
    hx, kx, tx = L.PEN_HOIST_X, L.PEN_KINK, L.PEN_TIP
    hh, ht = L.PEN_HH, L.PEN_HT
    panels = [
        [(hx, hh, 0.0), (kx, hh, 0.0), (kx, -hh, 0.0), (hx, -hh, 0.0)],
        [(kx, hh, 0.0), (tx, ht, 0.0), (tx, -ht, 0.0), (kx, -hh, 0.0)],
    ]
    for quad in panels:
        P.quad_out(p, quad, (0, 0, -1), L.PEN_F)
        P.quad_out(p, quad, (0, 0, 1), L.PEN_B)
    return p


def build_lightbar():
    p = Part('lightbar')
    bw, bh, bd = L.BAR_SIZE
    chamfer_box(p, (0.0, L.BAR_CY, 0.0), (bw, bh, bd), 0.02,
                {'-z': L.BAR_F, '+z': L.BAR_TOP, '+y': L.BAR_TOP,
                 '-y': L.DARK, '+x': L.TRIM, '-x': L.TRIM})
    for sx in (-1, 1):
        limb(p, (sx * L.BAR_STUB_X, 0.0, 0.0),
             (sx * L.BAR_STUB_X, L.BAR_CY - bh / 2 + 0.02, 0.0),
             L.BAR_STUB_R, L.BAR_STUB_R, L.TRIM.rect, n=4)
    return p


def build_stowage():
    p = Part('stowage')
    tw, th, td = L.TRAY_SIZE
    chamfer_box(p, (0.0, th / 2, 0.0), (tw, th, td), 0.02,
                {'+y': L.TRAY, '+x': L.TRIM, '-x': L.TRIM,
                 '+z': L.TRIM, '-z': L.TRIM}, skip=('-y',))
    px, pz = L.POST_XZ
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (sx * px, th, sz * pz), (sx * px, L.POST_H, sz * pz),
                 L.POST_R, L.POST_R, L.TRIM.rect, n=4)
        # side rails run along X at RAIL_Y (regimented tie-down rail)
    for sz in (-1, 1):
        limb(p, (-px, L.RAIL_Y, sz * pz), (px, L.RAIL_Y, sz * pz),
             L.RAIL_R, L.RAIL_R, L.TRIM.rect, n=4)
    for cx in L.CRATE_XS:
        P.crate(p, (cx, L.CRATE_Y, 0.0), L.CRATE_S, L.CRATE)
    return p


# ── clips ───────────────────────────────────────────────────────────────

def qy(deg):
    r = np.radians(deg) / 2
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def build_clips():
    # `idle`: pennant waves about the staff axis; seamless loop
    # (last key repeats the first).
    keys = [(0.0, qy(0.0)), (0.6, qy(11.0)), (1.2, qy(4.0)),
            (1.8, qy(14.0)), (2.4, qy(0.0))]
    return [{'name': 'idle', 'channels': [('flag', 'rotation', keys)]}]


def build_all():
    return [
        dict(name='applique', parent=-1, offset=L.APPLIQUE_OFF,
             part=build_applique()),
        dict(name='staff', parent=-1, offset=L.STAFF_OFF,
             part=build_staff()),
        dict(name='flag', parent=1, offset=L.FLAG_OFF, part=build_flag()),
        dict(name='lightbar', parent=-1, offset=L.LIGHTBAR_OFF,
             part=build_lightbar()),
        dict(name='stowage', parent=-1, offset=L.STOWAGE_OFF,
             part=build_stowage()),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips,
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips,
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_dress_order] total tris: {total} tris')
