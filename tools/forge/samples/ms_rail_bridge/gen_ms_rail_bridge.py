"""gen_ms_rail_bridge — 24 m tileable deck-truss rail bridge segment.

Single static `body` piece: deck slab, side girders, kerbs, bottom
chords, truss verticals/diagonals, cross beams, sleepers + 1.5 m gauge
rails on top, two concrete pier footings.  All longitudinal members run
exactly z -12..12 (no end chamfer) so segments tile at 24 m spacing.
No clips, no team colour.  Deterministic (no RNG in geometry).

Usage: $FORGE/venv/bin/python gen_ms_rail_bridge.py
"""
from __future__ import annotations
import numpy as np

import ms_rail_bridge_layout as L   # sets meshlib.ATLAS = 2048
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export

STEM = 'ms_rail_bridge'
OUT = 'out'


def pbox(p, center, size, zones, skip=()):
    """Plain 6-face box (ch=0 chamfer_box: bevel quads degenerate away)."""
    if isinstance(zones, Zone):
        zones = {k: zones for k in ('+y', '-y', '+x', '-x', '+z', '-z')}
    chamfer_box(p, center, size, 0.0, zones, skip=skip)


def build_body():
    p = Part('body')
    zc = (L.SEG_Z0 + L.SEG_Z1) / 2
    zd = L.SEG_Z1 - L.SEG_Z0

    # deck slab (top / bottom / sides; ends painted dark — butt faces)
    pbox(p, (0, (L.DECK_Y0 + L.DECK_Y1) / 2, zc), (L.DECK_W, L.DECK_Y1 - L.DECK_Y0, zd),
         {'+y': L.Z_DECK, '-y': L.Z_UNDER, '+x': L.Z_GIRD, '-x': L.Z_GIRD,
          '+z': L.Z_DARK, '-z': L.Z_DARK})

    # kerb strips along both deck edges
    for sx in (-1, 1):
        pbox(p, (sx * L.KERB_X, L.DECK_Y1 + L.KERB_H / 2, zc),
             (L.KERB_W, L.KERB_H, zd),
             {'+y': L.Z_KERB, '+x': L.Z_KERB, '-x': L.Z_KERB,
              '+z': L.Z_DARK, '-z': L.Z_DARK}, skip=('-y',))

    # side girder webs under the deck edges
    for sx in (-1, 1):
        pbox(p, (sx * L.GIRD_X, (L.GIRD_Y0 + L.GIRD_Y1) / 2, zc),
             (L.GIRD_W, L.GIRD_Y1 - L.GIRD_Y0, zd),
             {'+x': L.Z_GIRD, '-x': L.Z_GIRD, '-y': L.Z_CHORD,
              '+z': L.Z_DARK, '-z': L.Z_DARK}, skip=('+y',))

    # bottom chords
    for sx in (-1, 1):
        pbox(p, (sx * L.CHORD_X, (L.CHORD_Y0 + L.CHORD_Y1) / 2, zc),
             (L.CHORD_W, L.CHORD_Y1 - L.CHORD_Y0, zd),
             {'+x': L.Z_CHORD, '-x': L.Z_CHORD, '+y': L.Z_CHORD,
              '-y': L.Z_CHORD, '+z': L.Z_DARK, '-z': L.Z_DARK})

    # truss verticals + diagonals (both truss planes), cross beams
    vz = L.VERT_Z
    for sx in (-1, 1):
        x = sx * L.CHORD_X
        for z in vz:
            limb(p, (x, L.CHORD_Y1 - 0.05, z), (x, L.GIRD_Y0 + 0.05, z),
                 L.VERT_R, L.VERT_R, L.Z_TRUSS.rect, n=4)
        # diagonals: V pattern between panel points, symmetric about z=0
        for i in range(len(vz) - 1):
            z0, z1 = vz[i], vz[i + 1]
            zm = (z0 + z1) / 2
            if zm < 0:
                a, b = (z0, L.CHORD_Y1 - 0.05), (z1, L.GIRD_Y0 + 0.05)
            else:
                a, b = (z0, L.GIRD_Y0 + 0.05), (z1, L.CHORD_Y1 - 0.05)
            limb(p, (x, a[1], a[0]), (x, b[1], b[0]),
                 L.DIAG_R, L.DIAG_R, L.Z_TRUSS.rect, n=4)
        # end half-diagonals so the tiled pattern continues across joints
        limb(p, (x, L.GIRD_Y0 + 0.05, L.SEG_Z0), (x, L.CHORD_Y1 - 0.05, vz[0]),
             L.DIAG_R, L.DIAG_R, L.Z_TRUSS.rect, n=4)
        limb(p, (x, L.CHORD_Y1 - 0.05, vz[-1]), (x, L.GIRD_Y0 + 0.05, L.SEG_Z1),
             L.DIAG_R, L.DIAG_R, L.Z_TRUSS.rect, n=4)

    # cross beams between bottom chords at each panel point
    bw, bh = L.XBEAM
    for z in vz:
        pbox(p, (0, (L.CHORD_Y0 + L.CHORD_Y1) / 2, z),
             (2 * L.CHORD_X - L.CHORD_W, bh, bw), L.Z_TRUSS,
             skip=('+y',))

    # sleepers on the deck
    for z in L.SLEEP_ZS:
        pbox(p, (0, L.DECK_Y1 + L.SLEEP_H / 2, z),
             (L.SLEEP_W, L.SLEEP_H, L.SLEEP_D), L.Z_SLEEP, skip=('-y',))

    # rails, 1.5 m gauge, full segment length
    for sx in (-1, 1):
        pbox(p, (sx * L.RAIL_X, (L.RAIL_Y0 + L.RAIL_Y1) / 2, zc),
             (L.RAIL_W, L.RAIL_Y1 - L.RAIL_Y0, zd),
             {'+y': L.Z_RAILT, '+x': L.Z_RAIL, '-x': L.Z_RAIL,
              '+z': L.Z_DARK, '-z': L.Z_DARK}, skip=('-y',))

    # pier footings
    pw, ph, pd = L.PIER
    fw, fh, fd = L.FOOT
    for z in L.PIER_Z:
        pbox(p, (0, ph / 2, z), (pw, ph, pd),
             {'+x': L.Z_PIER, '-x': L.Z_PIER, '+z': L.Z_PIER,
              '-z': L.Z_PIER, '+y': L.Z_PIERT}, skip=('-y',))
        pbox(p, (0, fh / 2, z), (fw, fh, fd),
             {'+x': L.Z_PIER, '-x': L.Z_PIER, '+z': L.Z_PIER,
              '-z': L.Z_PIER, '+y': L.Z_PIERT}, skip=('-y',))
    return p


def build_all():
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body())]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=[], normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=[], normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_rail_bridge] total tris: {total}')
