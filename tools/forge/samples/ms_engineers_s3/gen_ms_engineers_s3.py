"""gen_ms_engineers_s3 — 6 m tracked heavy construction rig (engineers s3).

Replaces the humanoid ms_engineers_s3 body with the vehicle its own def has
described since 2026-08: "Heavy construction rig pair", VEH movedef, footprint
3 (units-assets review 2026-09-10). Dozer/grader blade forward, glazed crew
cab, open fabrication deck (gas bottles, crates, tool bin, bench) and a folded
A-frame lifting jib over the tail. Pieces body / tracks_l / tracks_r; no clips.
Run: python3 gen_ms_engineers_s3.py -> out/ms_engineers_s3{,_png}.gltf + .bin
"""
import numpy as np

import ms_engineers_s3_layout as L
from meshlib import Part, chamfer_box, limb, mirror_x, ngon_ring
from gltf_export import export

STEM = 'ms_engineers_s3'
OUT = 'out'


def sides(zone):
    """A zone dict that puts one zone on every face except the underside."""
    return {k: zone for k in ('+x', '-x', '+y', '-y', '+z', '-z')}


def yawed_box(p, center, size, yaw, zones, ch=0.03):
    """chamfer_box yawed about +Y — deck clutter reads as hand-stacked."""
    a = np.radians(yaw)
    ca, sa = np.cos(a), np.sin(a)
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    # cheap yaw: build the box at the origin, rotate its corners by hand
    # through the four upright faces + top (bottom skipped: it sits on deck).
    def pt(sx, sy, sz):
        lx, lz = sx * hx, sz * hz
        return (cx + lx * ca + lz * sa, cy + sy * hy, cz - lx * sa + lz * ca)
    quads = [
        ([pt(-1, 1, -1), pt(-1, 1, 1), pt(1, 1, 1), pt(1, 1, -1)], zones['+y']),
        ([pt(-1, -1, -1), pt(-1, 1, -1), pt(1, 1, -1), pt(1, -1, -1)], zones['-z']),
        ([pt(1, -1, 1), pt(1, 1, 1), pt(-1, 1, 1), pt(-1, -1, 1)], zones['+z']),
        ([pt(1, -1, -1), pt(1, 1, -1), pt(1, 1, 1), pt(1, -1, 1)], zones['+x']),
        ([pt(-1, -1, 1), pt(-1, 1, 1), pt(-1, 1, -1), pt(-1, -1, -1)], zones['-x']),
    ]
    for verts, zone in quads:
        p.add_face(verts, zone=zone)


def bottle(p, cx, cz, r, h, zone_rect):
    """Upright gas bottle: 8-gon body wrap + domed-read cap."""
    base = ngon_ring((cx, 0.0, cz), r, 8, axis='y')
    top = ngon_ring((cx, 0.0, cz), r, 8, axis='y')
    y0, y1 = L.DECK_Y, L.DECK_Y + h
    x0, ry0, x1, ry1 = zone_rect
    n = 8
    for i in range(n):
        j = (i + 1) % n
        a, b = base[i], base[j]
        quad = [(a[0], y0, a[2]), (b[0], y0, b[2]),
                (b[0], y1, b[2]), (a[0], y1, a[2])]
        u0 = (x0 + (x1 - x0) * i / n) / 1024.0
        u1 = (x0 + (x1 - x0) * (i + 1) / n) / 1024.0
        uvs = [(u0, ry1 / 1024.0), (u1, ry1 / 1024.0),
               (u1, ry0 / 1024.0), (u0, ry0 / 1024.0)]
        p.add_face(quad, uvs=uvs)
    cap = [(v[0], y1, v[2]) for v in top]
    uv = [((x0 + (x1 - x0) * (0.5 + 0.4 * np.cos(2 * np.pi * i / n))) / 1024.0,
           (ry0 + (ry1 - ry0) * (0.5 + 0.4 * np.sin(2 * np.pi * i / n))) / 1024.0)
          for i in range(n)]
    p.add_face(cap, uvs=uv)
    # neck + valve
    limb(p, (cx, y1, cz), (cx, y1 + 0.13, cz), 0.05, 0.045, L.TRIM, n=4,
         cap_end=L.TRIM_BOX)


def build_body():
    p = Part('body')

    # hull
    x, y, z, w, h, d = L.HULL
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+x': L.HULL_SIDE, '-x': L.HULL_SIDE, '+y': L.HULL_TOP,
                 '-z': L.HULL_FRONT, '+z': L.HULL_REAR}, skip=('-y',))
    # deck plate over the pods, aft of the cab
    x, y, z, w, h, d = L.DECK_PLATE
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.DECK, '-y': L.DARK, '+x': L.HULL_SIDE,
                 '-x': L.HULL_SIDE, '-z': L.HULL_FRONT, '+z': L.HULL_REAR})

    # crew cab + sun visor + floodlights + beacon
    x, y, z, w, h, d = L.CAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': L.CAB_SIDE, '-x': L.CAB_SIDE, '+y': L.CAB_TOP,
                 '-z': L.CAB_FRONT, '+z': L.CAB_REAR}, skip=('-y',))
    x, y, z, w, h, d = L.CAB_VISOR
    chamfer_box(p, (x, y, z), (w, h, d), 0.02,
                {'+y': L.CAB_TOP, '-y': L.DARK, '+x': L.TRIM_BOX,
                 '-x': L.TRIM_BOX, '-z': L.TRIM_BOX, '+z': L.TRIM_BOX})
    for (fx, fy, fz) in L.FLOODS:
        chamfer_box(p, (fx, fy, fz), L.FLOOD_SIZE, 0.02,
                    {'-z': L.LIGHT, '+z': L.TRIM_BOX, '+y': L.TRIM_BOX,
                     '-y': L.TRIM_BOX, '+x': L.TRIM_BOX, '-x': L.TRIM_BOX})
    bx, by, bz = L.BEACON
    chamfer_box(p, (bx, by, bz), (0.16, 0.20, 0.16), 0.03, sides(L.LIGHT))

    # dozer / grader blade + push arms
    x, y, z, w, h, d = L.BLADE
    chamfer_box(p, (x, y, z), (w, h, d), 0.04,
                {'-z': L.BLADE_F, '+z': L.HAZARD, '+y': L.BLADE_T,
                 '-y': L.BLADE_T, '+x': L.TRIM_BOX, '-x': L.TRIM_BOX})
    x, y, z, w, h, d = L.BLADE_LIP
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'-z': L.BLADE_T, '+z': L.BLADE_T, '+y': L.BLADE_T,
                 '-y': L.DARK, '+x': L.TRIM_BOX, '-x': L.TRIM_BOX})
    for (ax, ay, az, bx2, by2, bz2) in L.ARMS:
        limb(p, (ax, ay, az), (bx2, by2, bz2), 0.085, 0.075, L.TRIM, n=4)

    # fabrication deck: gas bottles, crates, tool bin, bench
    for (cx, cz) in L.BOTTLES:
        bottle(p, cx, cz, L.BOTTLE_R, L.BOTTLE_H, L.BOTTLE)
    for (cx, cz, cw, chh, cd, yaw) in L.CRATES:
        yawed_box(p, (cx, L.DECK_Y + chh / 2, cz), (cw, chh, cd), yaw,
                  {'+y': L.CRATE_T, '-z': L.CRATE_S, '+z': L.CRATE_S,
                   '+x': L.CRATE_S, '-x': L.CRATE_S})
    x, y, z, w, h, d = L.TOOL_BIN
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.BIN_T, '-y': L.DARK, '+x': L.BIN_S, '-x': L.BIN_S,
                 '-z': L.CRATE_S, '+z': L.CRATE_S})
    x, y, z, w, h, d = L.BENCH
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.BIN_T, '-y': L.DARK, '+x': L.BIN_S, '-x': L.BIN_S,
                 '-z': L.CRATE_S, '+z': L.CRATE_S})

    # winch drum + A-frame jib, stowed forward over the deck
    x, y, z, w, h, d = L.WINCH
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+y': L.BIN_T, '-y': L.DARK, '+x': L.TRIM_BOX,
                 '-x': L.TRIM_BOX, '-z': L.BIN_S, '+z': L.BIN_S})
    for foot in L.JIB_FEET:
        limb(p, foot, L.JIB_PEAK, 0.075, 0.055, L.MAST, n=4, cap_end=L.TRIM_BOX)
    fl, fr = L.JIB_FEET
    by = L.JIB_BRACE_Y
    t = (by - fl[1]) / (L.JIB_PEAK[1] - fl[1])
    braceL = tuple(fl[i] + t * (L.JIB_PEAK[i] - fl[i]) for i in range(3))
    braceR = tuple(fr[i] + t * (L.JIB_PEAK[i] - fr[i]) for i in range(3))
    limb(p, braceL, braceR, 0.045, 0.045, L.TRIM, n=4)
    # hoist rope + hook block under the peak
    limb(p, L.JIB_PEAK, (L.HOOK[0], L.HOOK[1] + 0.16, L.HOOK[2]), 0.018, 0.018,
         L.TRIM, n=3)
    hx, hy, hz, hw, hh, hd = L.HOOK
    chamfer_box(p, (hx, hy, hz), (hw, hh, hd), 0.02, sides(L.TRIM_BOX))
    return p


def build_tracks_l():
    p = Part('tracks_l')
    prof = L.TRACK_PROFILE
    w = L.TRACK_HALF_W
    n = len(prof)
    outer = [(w, y, z) for (z, y) in prof]
    inner = [(-w, y, z) for (z, y) in prof]
    p.add_face(outer, zone=L.TRACK_SIDE, flip=True)
    p.add_face(inner, zone=L.TRACK_SIDE)

    x0, y0, x1, y1 = L.TRACK_WRAP
    seg = [np.hypot(prof[(i + 1) % n][0] - prof[i][0],
                    prof[(i + 1) % n][1] - prof[i][1]) for i in range(n)]
    total = sum(seg)
    acc = 0.0
    centroid = np.array([0.0, sum(y for _, y in prof) / n,
                         sum(z for z, _ in prof) / n])
    for i in range(n):
        j = (i + 1) % n
        u0 = (x0 + (x1 - x0) * acc / total) / 1024.0
        acc += seg[i]
        u1 = (x0 + (x1 - x0) * acc / total) / 1024.0
        va, vb = y0 / 1024.0, y1 / 1024.0
        quad = [(w, prof[i][1], prof[i][0]), (-w, prof[i][1], prof[i][0]),
                (-w, prof[j][1], prof[j][0]), (w, prof[j][1], prof[j][0])]
        uvs = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        if np.dot(nrm, ctr - centroid) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        p.add_face(quad, uvs=uvs)

    (fz0, fz1), fy, fh, fw = L.FENDER_SPAN
    chamfer_box(p, (0.0, fy + fh / 2 - 0.02, (fz0 + fz1) / 2),
                (fw, fh, fz1 - fz0), 0.03,
                {'+y': L.FENDER, '+x': L.TRACK_SIDE, '-x': L.TRACK_SIDE,
                 '+z': L.TRACK_SIDE, '-z': L.TRACK_SIDE}, skip=('-y',))
    return p


def build_all():
    tl = build_tracks_l()
    tr = mirror_x(tl, 'tracks_r')
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='tracks_l', parent=0, offset=L.TRACK_OFF, part=tl),
        dict(name='tracks_r', parent=0,
             offset=(-L.TRACK_OFF[0], L.TRACK_OFF[1], L.TRACK_OFF[2]), part=tr),
    ]


if __name__ == '__main__':
    pieces = build_all()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'[gen_{STEM}] total tris: {total}')
