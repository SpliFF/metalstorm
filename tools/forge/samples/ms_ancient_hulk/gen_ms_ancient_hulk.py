"""gen_ms_ancient_hulk — beached ancient warship hulk (terrain feature).

~100 m monolithic ancient-tech warship: segmented hull loft with a
breach funnel + glowing chamber on the -x flank, swept fin, broken deck
spine, collapsed masts. Authored upright, then the permanent list
(roll -13°) + bow-up pitch (+3.5°) + sink (-2.2 m) is baked into the
single static `body` piece; sand berm, bow plough mound and hull shards
are added afterwards in world frame so they rest on ground Y=0.

Usage: python3 gen_ms_ancient_hulk.py
"""
from __future__ import annotations
import numpy as np

import ms_ancient_hulk_layout as S   # sets meshlib.ATLAS = 2048
from meshlib import Part, chamfer_box, limb
from gltf_export import export

STEM = 'ms_ancient_hulk'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── helpers ──────────────────────────────────────────────────────────────

def ring_from_section(sec):
    z, yk, ybl, ym, yt, yd, yc, wbl, wm, wt, wd = sec
    return [(0.0, yk, z), (wbl, ybl, z), (wm, ym, z), (wt, yt, z),
            (wd, yd, z), (0.0, yc, z), (-wd, yd, z), (-wt, yt, z),
            (-wm, ym, z), (-wbl, ybl, z)]


def hull_zone(c, n):
    if n[1] < -0.6:
        return S.S_BELLY
    if n[1] > 0.55:
        return S.S_DECK
    if n[0] > 0.35:
        return S.S_HULL_LO
    if n[0] < -0.35:
        return S.S_HULL_HI
    return S.S_HULL_HI if c[0] < 0 else S.S_HULL_LO


def loft_skip(part, rings, zone_of, skip=frozenset(), cap_start=None,
              cap_end=None):
    """meshlib.loft with a (gap_index, face_index) skip set (breach hole)."""
    nv = len(rings[0])
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for j in range(nv):
            if (i, j) in skip:
                continue
            k = (j + 1) % nv
            quad = [r0[j], r0[k], r1[k], r1[j]]
            c = np.mean(np.array(quad), axis=0)
            n = np.cross(np.asarray(r0[k]) - np.asarray(r0[j]),
                         np.asarray(r1[j]) - np.asarray(r0[j]))
            ln = np.linalg.norm(n)
            if ln < 1e-12:
                continue
            part.add_face(quad, zone=zone_of(c, n / ln))
    if cap_start is not None:
        part.add_face(list(rings[0]), zone=cap_start, flip=True)
    if cap_end is not None:
        part.add_face(list(rings[-1]), zone=cap_end)


def quad_out(p, verts, outward, zone):
    """Add a polygon wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, dtype=float)) > 0
               else list(verts)[::-1], zone=zone)


def box(p, center, size, zone, ch=0.06, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


# ── breach: funnel + glowing chamber behind the -x skin ──────────────────

def build_breach(p):
    i0 = S.BREACH_GAP
    A = ring_from_section(S.HULL_SECTIONS[i0])
    B = ring_from_section(S.HULL_SECTIONS[i0 + 1])
    # hole rim: verts 6..8 (-x deck edge -> shoulder -> mid chine) at both
    # bounding stations, walked as a hexagon around the opening
    rim = [A[6], B[6], B[7], B[8], A[8], A[7]]
    cy, cz = S.CHAMBER_C
    mouth, back = [], []
    for (x, y, z) in rim:
        jy = float(RNG.uniform(-0.45, 0.45))
        jz = float(RNG.uniform(-0.6, 0.6))
        my = cy + (y - cy) * 0.48 + jy
        mz = cz + (z - cz) * 0.42 + jz
        mouth.append((S.MOUTH_X, my, mz))
        back.append((S.BACK_X, cy + (my - cy) * 0.85, cz + (mz - cz) * 0.8))
    for i in range(6):
        k = (i + 1) % 6
        q = [rim[i], rim[k], mouth[k], mouth[i]]
        fc = np.mean(np.array(q), axis=0)
        quad_out(p, q, np.array([fc[0], cy, cz]) - fc, S.S_CHAMBER)
        q2 = [mouth[i], mouth[k], back[k], back[i]]
        fc2 = np.mean(np.array(q2), axis=0)
        quad_out(p, q2, np.array([fc2[0], cy, cz]) - fc2, S.S_CHAMBER)
    quad_out(p, back, (-1, 0, 0), S.S_CHAMBER)
    # glowing core block floating in the chamber
    box(p, S.CORE_C, S.CORE_SZ, S.S_CORE, ch=0.08)


# ── fin (swept monolith blade) ───────────────────────────────────────────

def build_fin(p):
    rings = []
    for (z, yt, ym, wf) in S.FIN_SECTIONS:
        yb = S.FIN_BASE_Y
        # same rotational direction as the hull ring (CCW seen from +z)
        rings.append([(0.0, yt, z), (-wf, ym, z), (-wf * 0.75, yb, z),
                      (wf * 0.75, yb, z), (wf, ym, z)])
    loft_skip(p, rings, lambda c, n: S.S_FIN,
              cap_start=S.S_FIN, cap_end=S.S_FIN)
    (a, b, r0, r1) = S.FIN_TIP
    limb(p, a, b, r0, r1, S.S_MAST, n=5, cap_start=S.S_DK, cap_end=S.S_DK)


# ── deck dressing (upright frame) ────────────────────────────────────────

def build_deck_gear(p):
    for (c, sz) in S.SPINES:
        box(p, c, sz, S.S_DECK, ch=0.15, skip=('-y',))
    for (a, b, r0, r1) in S.STUMPS:
        limb(p, a, b, r0, r1, S.S_MAST, n=6, cap_end=S.S_DK)
    for (a, b, r0, r1) in S.SPARS:
        limb(p, a, b, r0, r1, S.S_MAST, n=6, cap_start=S.S_DK,
             cap_end=S.S_DK)


# ── pose bake: roll (list) -> pitch (bow-up) -> sink ─────────────────────

def apply_hulk_xform(part):
    th = np.radians(S.ROLL_DEG)
    ph = np.radians(S.PITCH_DEG)
    Rz = np.array([[np.cos(th), -np.sin(th), 0.0],
                   [np.sin(th),  np.cos(th), 0.0],
                   [0.0, 0.0, 1.0]])
    Rx = np.array([[1.0, 0.0, 0.0],
                   [0.0, np.cos(ph), -np.sin(ph)],
                   [0.0, np.sin(ph),  np.cos(ph)]])
    Mx = Rx @ Rz
    t = np.array([0.0, -S.SINK, 0.0])
    part.pos = [tuple(Mx @ np.asarray(v) + t) for v in part.pos]
    part.nrm = [tuple(Mx @ np.asarray(n)) for n in part.nrm]


# ── world-frame dressing: berm, plough mound, shed hull shards ───────────

def add_world_dressing(p):
    crest = []
    for (z, xc, yc, xt) in S.BERM:
        crest.append((z, xc, max(0.15, yc + float(RNG.uniform(-0.25, 0.25))),
                      xt))
    for i in range(len(crest) - 1):
        z0, xc0, yc0, xt0 = crest[i]
        z1, xc1, yc1, xt1 = crest[i + 1]
        quad_out(p, [(xc0, yc0, z0), (xc1, yc1, z1),
                     (xt1, 0.0, z1), (xt0, 0.0, z0)], (1.0, 0.7, 0.0),
                 S.S_BERM)
    ax, az, r = S.MOUND_BASE
    ring = [(ax + r * np.cos(a), 0.0, az + r * np.sin(a))
            for a in np.linspace(0, 2 * np.pi, S.MOUND_N, endpoint=False)]
    for i in range(S.MOUND_N):
        k = (i + 1) % S.MOUND_N
        tri = [S.MOUND_APEX, ring[i], ring[k]]
        fc = np.mean(np.array(tri), axis=0)
        quad_out(p, tri, fc - np.array([ax, -2.0, az]), S.S_BERM)
    for (a, b, r0, r1) in S.SHARDS:
        limb(p, a, b, r0, r1, S.S_SHARD, n=5, cap_start=S.S_DK,
             cap_end=S.S_DK)


# ── assembly ─────────────────────────────────────────────────────────────

def build_all():
    p = Part('body')
    rings = [ring_from_section(s) for s in S.HULL_SECTIONS]
    skip = {(S.BREACH_GAP, 6), (S.BREACH_GAP, 7)}
    loft_skip(p, rings, hull_zone, skip=skip,
              cap_start=S.S_BOW, cap_end=S.S_STERN)
    build_breach(p)
    build_fin(p)
    build_deck_gear(p)
    apply_hulk_xform(p)
    add_world_dressing(p)
    return [dict(name='body', parent=-1, offset=(0, 0, 0), part=p)]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_ms_ancient_hulk] total {total} tris')
