"""gen_ms_obs_balloon — assemble ms_obs_balloon and export .gltf/.bin.

Tethered observation aerostat: ground winch trailer (`body`, plus
spinnable `wheel1`/`wheel2` pieces), tether (`cable`, pivoting at the
A-frame fairlead) and a small finned envelope with slung sensor gondola
riding at ~22 m (`envelope`, child of `cable`). The raised balloon is
the intel tell — envelope silhouette reads at extreme distance.
Idle clip: slow conical tether sway + envelope bob and pitch.
Run: python3 gen_ms_obs_balloon.py → out/ms_obs_balloon{,_png}.gltf + .bin
"""
from __future__ import annotations
import numpy as np

import ms_obs_balloon_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, loft, chamfer_box, tube, ngon_ring, limb
from gltf_export import export

STEM = 'ms_obs_balloon'
OUT = 'out'


def box(p, center, size, zone, ch=0.04, skip=()):
    chamfer_box(p, center, size, ch,
                {'+y': zone, '-y': zone, '+x': zone, '-x': zone,
                 '+z': zone, '-z': zone}, skip=skip)


def quad_out(p, verts, outward, zone):
    """Add a quad wound so its normal points along `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward)) > 0 else verts[::-1],
               zone=zone)


# ── body: winch trailer ──────────────────────────────────────────────────

def build_body():
    p = Part('body')

    # flatbed
    x, y, z, w, h, d = F.BED
    chamfer_box(p, (x, y, z), (w, h, d), 0.06,
                {'+y': F.Z_BED_TOP, '-y': F.Z_DARK,
                 '+x': F.Z_BED_SIDE, '-x': F.Z_BED_SIDE,
                 '-z': F.Z_BED_F, '+z': F.Z_BED_F})

    # control/equipment cabinet at the front of the bed
    x, y, z, w, h, d = F.CAB
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': F.Z_CAB, '-x': F.Z_CAB, '-z': F.Z_CAB_F,
                 '+z': F.Z_CAB_F, '+y': F.Z_CAB_T}, skip=('-y',))

    # axle
    (x0w, yw, zw), (x1w, _, _) = F.WHEEL_POS
    limb(p, (x0w, yw, zw), (x1w, yw, zw), 0.07, 0.07, F.Z_FRAME, n=6)

    # winch drum + cradle + motor
    cx, cy, cz = F.DRUM_C
    limb(p, (cx - F.DRUM_HL, cy, cz), (cx + F.DRUM_HL, cy, cz),
         F.DRUM_R, F.DRUM_R, F.Z_DRUM, n=8,
         cap_start=F.Z_DARK, cap_end=F.Z_DARK)
    x, y, z, w, h, d = F.CRADLE
    chamfer_box(p, (x, y, z), (w, h, d), 0.03,
                {'+x': F.Z_TRIM, '-x': F.Z_TRIM, '+z': F.Z_TRIM,
                 '-z': F.Z_TRIM, '+y': F.Z_TRIM}, skip=('-y',))
    x, y, z, w, h, d = F.MOTOR
    box(p, (x, y, z), (w, h, d), F.Z_TRIM, ch=0.03)

    # A-frame mast guiding the tether off the drum
    ax, ay, az = F.APEX
    for (lx, ly, lz) in F.AFRAME:
        limb(p, (lx, ly, lz), (ax * 1.0 + (0.06 if lx < 0 else -0.06), ay, az),
             0.07, 0.055, F.Z_FRAME, n=4)
    limb(p, (-0.45, 2.15, 0.9), (0.45, 2.15, 0.9), 0.04, 0.04, F.Z_FRAME, n=4)
    x, y, z, w, h, d = F.FAIRLEAD
    box(p, (x, y, z), (w, h, d), F.Z_TRIM, ch=0.04)
    # static cable run: drum top → fairlead
    limb(p, (0.0, F.DRUM_C[1] + F.DRUM_R, F.DRUM_C[2]), (0.0, 3.05, 0.42),
         0.045, 0.045, F.Z_CABLEW, n=4)

    # outrigger jacks (deployed — the winch is anchored)
    for (ox, oz) in F.OUTRIGGERS:
        limb(p, (ox, F.BED[1] - 0.2, oz), (ox, 0.02, oz), 0.055, 0.10,
             F.Z_FRAME, n=4, cap_end=F.Z_DARK)

    # drawbar + tow hitch
    hx, hy, hz, w, h, d = F.HITCH
    for (dx, dy, dz) in F.DRAWBAR:
        limb(p, (dx, dy, dz), (hx, hy + 0.08, hz + 0.12), 0.06, 0.05,
             F.Z_FRAME, n=4)
    box(p, (hx, hy, hz), (w, h, d), F.Z_TRIM, ch=0.03)
    return p


def build_wheel(name):
    p = Part(name)
    limb(p, (-F.WHEEL_W / 2, 0, 0), (F.WHEEL_W / 2, 0, 0),
         F.WHEEL_R, F.WHEEL_R, F.Z_TIRE, n=8,
         cap_start=F.Z_WHEEL, cap_end=F.Z_WHEEL)
    return p


# ── cable: tether (pivots at the fairlead; envelope rides its tip) ──────

def build_cable():
    p = Part('cable')
    limb(p, (0.0, -0.05, 0.0), (0.0, F.CABLE_LEN + 0.55, 0.0),
         0.05, 0.038, F.Z_CABLEW, n=4)
    return p


# ── envelope: aerostat hull + fins + gondola ─────────────────────────────

def ring_hull(z, r):
    pts = []
    for i in range(F.ENV_N):
        a = np.pi / F.ENV_N + 2 * np.pi * i / F.ENV_N
        pts.append((r * np.cos(a), F.ENV_CY + r * np.sin(a), z))
    return pts


def env_zone(c, n):
    if n[1] > 0.55:
        return F.Z_ENV_TOP
    if n[1] < -0.55:
        return F.Z_ENV_BELLY
    return F.Z_ENV_SIDE


def fin(p, d):
    """Tapered tail fin along radial direction d=(dx,dy), root buried."""
    dx, dy = d
    px_, py_ = -dy, dx                       # in-plane perpendicular
    zr0, zr1 = F.FIN_ZR
    zt0, zt1 = F.FIN_ZT

    def V(r, s, z):
        t = (r - F.FIN_RIN) / (F.FIN_ROUT - F.FIN_RIN)
        th = F.FIN_TH[0] * (1 - t) + F.FIN_TH[1] * t
        return (dx * r + px_ * s * th / 2,
                F.ENV_CY + dy * r + py_ * s * th / 2, z)

    r0p, r0m = V(F.FIN_RIN, 1, zr0), V(F.FIN_RIN, -1, zr0)
    r1p, r1m = V(F.FIN_RIN, 1, zr1), V(F.FIN_RIN, -1, zr1)
    t0p, t0m = V(F.FIN_ROUT, 1, zt0), V(F.FIN_ROUT, -1, zt0)
    t1p, t1m = V(F.FIN_ROUT, 1, zt1), V(F.FIN_ROUT, -1, zt1)
    quad_out(p, [r0p, r1p, t1p, t0p], (px_, py_, 0), F.Z_FIN)
    quad_out(p, [r0m, r1m, t1m, t0m], (-px_, -py_, 0), F.Z_FIN)
    quad_out(p, [r0p, r0m, t0m, t0p], (0, 0, -1), F.Z_FIN)   # leading edge
    quad_out(p, [r1p, r1m, t1m, t1p], (0, 0, 1), F.Z_FIN)    # trailing edge
    quad_out(p, [t0p, t0m, t1m, t1p], (dx, dy, 0), F.Z_FIN)  # tip cap


def build_envelope():
    p = Part('envelope')
    rings = [ring_hull(z, r) for (z, r) in F.ENV_SECTIONS]
    loft(p, rings, env_zone, cap_start=F.Z_DARK, cap_end=F.Z_DARK)

    for d in F.FIN_DIRS:
        fin(p, d)

    # slung sensor gondola + camera ball
    x, y, z, w, h, d = F.GONDOLA
    chamfer_box(p, (x, y, z), (w, h, d), 0.05,
                {'+x': F.Z_GONDOLA, '-x': F.Z_GONDOLA, '-z': F.Z_GONDOLA_F,
                 '+z': F.Z_GONDOLA_F, '+y': F.Z_GONDOLA_F,
                 '-y': F.Z_GONDOLA_F})
    sx, sy, sz, ss = F.SENSOR
    box(p, (sx, sy, sz), (ss, ss, ss), F.Z_SENS, ch=0.06)
    # gondola suspension straps into the belly
    for gx in (-0.25, 0.25):
        limb(p, (gx, -0.06, -0.9), (gx * 1.3, 0.35, -0.9), 0.035, 0.03,
             F.Z_FRAME, n=4)

    # rigging: confluence → belly patch points
    for (rx, ry, rz) in F.RIGGING:
        limb(p, (0.0, -0.02, 0.0), (rx, ry, rz), 0.022, 0.022,
             F.Z_CABLEW, n=4)

    # anti-collision beacon on the spine
    bx, by, bz, w, h, d = F.BEACON
    box(p, (bx, by, bz), (w, h, d), F.Z_LIGHT, ch=0.02)
    return p


# ── idle clip: conical tether sway + envelope bob/pitch ─────────────────

def q_tilt(theta_deg, phi):
    """Tilt by theta around the horizontal axis (cos φ, 0, sin φ)."""
    h = np.radians(theta_deg) / 2
    return (float(np.sin(h) * np.cos(phi)), 0.0,
            float(np.sin(h) * np.sin(phi)), float(np.cos(h)))


def qx(deg):
    h = np.radians(deg) / 2
    return (float(np.sin(h)), 0.0, 0.0, float(np.cos(h)))


def build_clips():
    T = 16.0
    # cable: 1.4° conical sway, one slow precession per loop
    sway = [(T * i / 8, q_tilt(1.4, 2 * np.pi * i / 8)) for i in range(9)]
    # envelope: gentle bob (±0.28 m, two cycles per loop) — ABSOLUTE
    # node translation = rest offset + delta
    bob = [(T * i / 16,
            (0.0, F.CABLE_LEN + 0.28 * float(np.sin(2 * np.pi * i / 8)), 0.0))
           for i in range(17)]
    # envelope: nose pitch hunting (±2°), one cycle per loop
    pitch = [(T * i / 8, qx(2.0 * float(np.sin(2 * np.pi * i / 8))))
             for i in range(9)]
    return [{'name': 'idle', 'channels': [
        ('cable', 'rotation', sway),
        ('envelope', 'translation', bob),
        ('envelope', 'rotation', pitch),
    ]}]


def build_all():
    return [
        dict(name='body', parent=-1, offset=(0, 0, 0), part=build_body()),   # 0
        dict(name='wheel1', parent=0, offset=F.WHEEL_POS[0],
             part=build_wheel('wheel1')),                                    # 1
        dict(name='wheel2', parent=0, offset=F.WHEEL_POS[1],
             part=build_wheel('wheel2')),                                    # 2
        dict(name='cable', parent=0, offset=F.CABLE_OFF, part=build_cable()),  # 3
        dict(name='envelope', parent=3, offset=F.ENV_OFF,
             part=build_envelope()),                                         # 4
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    print(f'{STEM}: {total} tris')
