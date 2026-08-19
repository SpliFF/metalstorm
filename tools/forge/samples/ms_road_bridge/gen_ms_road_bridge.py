"""gen_ms_road_bridge — build ms_road_bridge (24 m tileable road bridge).

Riveted steel through-truss road bridge segment: concrete deck slab
(cracked slabs in the paint) with kerbs, Pratt-style truss walls on both
sides (bottom/top chords + verticals + diagonals), overhead sway braces,
floor beams under the deck, two concrete pier footings.  TILEABLE: deck
spans exactly z -12 .. +12 at full width at both ends; truss end posts
sit just inside the ends so chained segments pair posts cleanly.

Single static `body` piece, no clips, no team.  Forward -Z, up +Y,
1 u = 1 m.  Deterministic (no RNG in geometry).  Shipped with y = 0 AT
THE DECK (PLAN-maps.md §2j option A) — build_all() applies the shift.

Usage: python3 gen_ms_road_bridge.py
"""
from __future__ import annotations
import numpy as np

import ms_road_bridge_layout as L    # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, chamfer_box, limb
from gltf_export import export

STEM = 'ms_road_bridge'
OUT = 'out'


def pbox(p, center, size, zones, skip=()):
    """Plain 6-face box (ch=0 chamfer_box: bevel quads degenerate away)."""
    if isinstance(zones, Zone):
        zones = {k: zones for k in ('+y', '-y', '+x', '-x', '+z', '-z')}
    chamfer_box(p, center, size, 0.0, zones, skip=skip)


def build_body():
    p = Part('body')

    # ── deck slab: exactly Z0..Z1, full width at both ends (tileable) ──
    dy = (L.DECK_TOP + L.DECK_BOT) / 2
    dh = L.DECK_TOP - L.DECK_BOT
    pbox(p, (0.0, dy, 0.0), (L.DECK_W + 0.7, dh, L.Z1 - L.Z0),
         {'+y': L.Z_DECK, '-y': L.Z_DECKB, '+x': L.Z_DECKS,
          '-x': L.Z_DECKS, '+z': L.Z_DARK, '-z': L.Z_DARK})

    # ── kerbs (full length so the roadway edge chains too) ──
    kh = L.KERB_TOP - L.DECK_TOP
    for sx in (-1, 1):
        kx = sx * (L.DECK_W / 2 - L.KERB_W / 2 + 0.15)
        pbox(p, (kx, L.DECK_TOP + kh / 2, 0.0),
             (L.KERB_W, kh, L.Z1 - L.Z0),
             {'+y': L.Z_KERB, '+x': L.Z_KERB, '-x': L.Z_KERB,
              '+z': L.Z_DARK, '-z': L.Z_DARK}, skip=('-y',))

    # ── truss walls, both sides ──
    bcx, bcy = L.BC_SZ
    tcx, tcy = L.TC_SZ
    for sx in (-1, 1):
        tx = sx * L.TRUSS_X
        # bottom chord (full length: chains with the next segment)
        chamfer_box(p, (tx, L.BC_Y, 0.0), (bcx, bcy, L.Z1 - L.Z0), 0.03,
                    {'+y': L.Z_STEEL, '-y': L.Z_STEEL, '+x': L.Z_CHORD,
                     '-x': L.Z_CHORD, '+z': L.Z_DARK, '-z': L.Z_DARK})
        # top chord
        chamfer_box(p, (tx, L.TC_Y, 0.0), (tcx, tcy, L.Z1 - L.Z0), 0.03,
                    {'+y': L.Z_STEEL, '-y': L.Z_STEEL, '+x': L.Z_CHORD,
                     '-x': L.Z_CHORD, '+z': L.Z_DARK, '-z': L.Z_DARK})
        # verticals
        for pz in L.POSTS_Z:
            r0 = 0.14 if abs(pz) > 11.0 else 0.11
            limb(p, (tx, L.POST_Y0, pz), (tx, L.POST_Y1, pz),
                 r0, r0 - 0.02, L.Z_STEEL.rect, n=4)
        # diagonals (Pratt: lean toward mid-span)
        for i in range(len(L.POSTS_Z) - 1):
            za, zb = L.POSTS_Z[i], L.POSTS_Z[i + 1]
            if (za + zb) / 2 < 0:
                lo, hi = za, zb          # rise toward +z
            else:
                lo, hi = zb, za          # rise toward -z
            limb(p, (tx, L.POST_Y0 + 0.05, lo), (tx, L.POST_Y1 - 0.05, hi),
                 0.09, 0.07, L.Z_STEEL.rect, n=4)

    # ── overhead sway braces between the top chords ──
    for bz in L.SWAYS_Z:
        pbox(p, (0.0, L.SWAY_Y, bz),
             (L.TRUSS_X * 2 - 0.1, 0.26, 0.30), L.Z_STEEL)
        for sx in (-1, 1):               # knee braces into the posts
            limb(p, (sx * (L.TRUSS_X - 0.15), L.POST_Y1 - 0.55, bz),
                 (sx * (L.TRUSS_X - 1.35), L.SWAY_Y - 0.08, bz),
                 0.06, 0.05, L.Z_STEEL.rect, n=4)

    # ── floor beams under the deck (read from the side / below) ──
    fby, fbz = L.FLOORB_SZ
    for bz in L.FLOORB_Z:
        pbox(p, (0.0, L.DECK_BOT - fby / 2, bz),
             (L.TRUSS_X * 2 + 0.1, fby, fbz), L.Z_STEEL)

    # ── pier footings ──
    pw, ph, pd = L.PIER_SZ
    for pz in L.PIERS_Z:
        chamfer_box(p, (0.0, ph / 2, pz), (pw, ph, pd), 0.05,
                    {'+y': L.Z_PIER, '+x': L.Z_PIER, '-x': L.Z_PIER,
                     '+z': L.Z_PIER, '-z': L.Z_PIER}, skip=('-y',))
    return p


def build_all():
    body = build_body()
    # Origin at the deck, not the pier base — see L.DECK_ORIGIN_Y. Applied
    # here, after build_body() has assigned every UV from the atlas zones
    # (which project world y), so the shift moves geometry ONLY: the .bin's
    # UV and normal blocks come out byte-identical to the pier-base export.
    body.pos = [(x, y - L.DECK_ORIGIN_Y, z) for x, y, z in body.pos]
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=body)]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=[],
           normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=[],
           normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_road_bridge] total tris: {total}')
