"""parts.py — reusable parametric assemblies for fable-model-forge generators.

Harvested from the batch-01 generators (watchtower lattice, civkit wheels,
supply-dump clutter, barricade rails, tank-farm cylinders, comms-relay masts).
Every function writes triangles into a caller-supplied meshlib.Part and takes
explicit zone rect(s) from the caller's layout module — prefabs never own
texture layout. All dims in metres, ground plane Y=0, RH -Z forward.

Usage in a generator (workspace file, PYTHONPATH includes toolkit + prefabs):

    import meshlib as M
    from meshlib import Part
    import parts as P

    body = Part('body')
    P.lattice_tower(body, base_y=0.3, top_y=6.0, half_base=1.2, half_top=0.7,
                    leg_zone=F.R_LEG, brace_zone=F.R_TRIM)

Turrets are separate PIECES: turret_parts() returns new Part objects to append
to your piece list (engine aims them via the standard turret/barrel/muzzle
chain). Everything else adds geometry to the Part you pass in.
"""
import math

import numpy as np

import meshlib as M
from meshlib import Part, chamfer_box, limb, tube, ngon_ring

# meshlib contract: chamfer_box takes Zone OBJECTS; limb/tube take raw atlas
# RECTS (x0,y0,x1,y1). Fallbacks below are for smoke tests only — real
# generators pass their layout module's zones/rects.
GREY = M.Zone((0, 0, 32, 32), ('x', 'y'), ((-1.0, 1.0), (-1.0, 1.0)))  # Zone (boxes)
GREYR = (0, 0, 32, 32)                                                  # rect (limb/tube)


# ------------------------------------------------------------ generic helpers

def quad_out(p, verts, outward, zone):
    """Add a quad wound so its normal points along `outward` (a rough
    direction, not necessarily unit). Every batch-1 generator rewrote this."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    n = np.cross(b - a, c - a)
    p.add_face(verts if np.dot(n, np.asarray(outward, float)) > 0
               else verts[::-1], zone=zone)


def box6(p, center, size, zone, ch=0.04, skip=()):
    """chamfer_box with ONE Zone on all six faces — the uniform-box wrapper
    every generator rewrites. skip=('-y',) for grounded boxes."""
    chamfer_box(p, center, size, ch,
                {f: zone for f in ('+x', '-x', '+y', '-y', '+z', '-z')},
                skip=skip)


# ---------------------------------------------------------------- rolling stock

def _ring_solid(p, rings, zone, cap_first=False, cap_last=False, axis='y'):
    """Skin consecutive vertex rings into a solid (flat-shaded quads);
    zone is a meshlib.Zone. Quads are wound OUTWARD (radial check, same
    method as meshlib.tube) so backface culling reads them correctly."""
    ai = 'xyz'.index(axis)
    for r0, r1 in zip(rings, rings[1:]):
        n = len(r0)
        centre = np.mean(np.array(list(r0) + list(r1)), axis=0)
        for j in range(n):
            k = (j + 1) % n
            quad = [r0[j], r0[k], r1[k], r1[j]]
            c = np.mean(np.array(quad), axis=0)
            rad = c - centre
            rad[ai] = 0.0
            fn = np.cross(np.asarray(quad[1], float) - np.asarray(quad[0], float),
                          np.asarray(quad[3], float) - np.asarray(quad[0], float))
            if np.dot(fn, rad) < 0:
                quad = quad[::-1]
            p.add_face(quad, zone=zone)
    if cap_first:
        p.add_face(list(rings[0]), zone=zone, flip=True)
    if cap_last:
        p.add_face(list(rings[-1]), zone=zone, flip=False)



def wheel(p, center, r=0.5, w=0.30, zone=GREY, n=8):
    """One n-gon wheel, axis X. Rest the flats on the ground by placing the
    axle at y = r*cos(pi/n) (see civkit convention)."""
    cx, cy, cz = center
    rings = [ngon_ring((cx - w / 2, cy, cz), r, n=n, axis='x'),
             ngon_ring((cx + w / 2, cy, cz), r, n=n, axis='x')]
    _ring_solid(p, rings, zone, cap_first=True, cap_last=True, axis='x')


def wheel_pair(p, y, z, track=1.3, r=0.5, w=0.30, zone=GREY, n=8):
    wheel(p, (-track / 2 - w / 2, y, z), r, w, zone, n)
    wheel(p, (track / 2 + w / 2, y, z), r, w, zone, n)


def axle_piece(name, z_off, y, track=1.3, r=0.5, w=0.30, zone=GREY, n=8):
    """A spinnable axle piece dict (offset (0, y, z_off)); wheels built about
    the piece origin so the engine's X-spin animates them. Set 'parent' to
    your body's index when assembling the piece table."""
    ax = Part(name)
    wheel_pair(ax, 0.0, 0.0, track, r, w, zone, n)
    return dict(name=name, parent=0, offset=(0.0, y, z_off), part=ax)


# ---------------------------------------------------------------- structure

def lattice_tower(p, base_y, top_y, half_base, half_top, leg_r=0.11,
                  brace_r=0.05, bands=2, leg_zone=GREYR, brace_zone=GREYR):
    """Four splayed legs + ring/X bracing (watchtower idiom)."""
    def half_at(y):
        t = (y - base_y) / (top_y - base_y)
        return half_base + (half_top - half_base) * t
    for sx in (-1, 1):
        for sz in (-1, 1):
            limb(p, (sx * half_base, base_y, sz * half_base),
                 (sx * half_top, top_y, sz * half_top),
                 leg_r, leg_r * 0.78, leg_zone, n=4)
    ys = [base_y + (top_y - base_y) * (i + 1) / (bands + 1) for i in range(bands)]
    for by in ys:
        hb = half_at(by)
        cs = [(-hb, by, -hb), (hb, by, -hb), (hb, by, hb), (-hb, by, hb)]
        for i in range(4):
            limb(p, cs[i], cs[(i + 1) % 4], brace_r, brace_r, brace_zone, n=4)
    lows = [base_y] + ys
    highs = ys + [top_y]
    for y0, y1 in zip(lows, highs):
        h0, h1 = half_at(y0), half_at(y1)
        faces = [((-h0, y0, -h0), (h0, y0, -h0), (-h1, y1, -h1), (h1, y1, -h1)),
                 ((-h0, y0, h0), (h0, y0, h0), (-h1, y1, h1), (h1, y1, h1)),
                 ((-h0, y0, -h0), (-h0, y0, h0), (-h1, y1, -h1), (-h1, y1, h1)),
                 ((h0, y0, -h0), (h0, y0, h0), (h1, y1, -h1), (h1, y1, h1))]
        for a0, b0, a1, b1 in faces:
            limb(p, a0, b1, brace_r * 0.8, brace_r * 0.8, brace_zone, n=3)
            limb(p, b0, a1, brace_r * 0.8, brace_r * 0.8, brace_zone, n=3)


def ladder(p, base, top, width=0.5, rail_r=0.035, rung_step=0.32, zone=GREYR):
    """Vertical ladder between two points (assumed same x/z plane offset)."""
    bx, by, bz = base
    tx, ty, tz = top
    for s in (-1, 1):
        limb(p, (bx + s * width / 2, by, bz), (tx + s * width / 2, ty, tz),
             rail_r, rail_r, zone, n=3)
    n = max(2, int((ty - by) / rung_step))
    for i in range(n):
        t = (i + 0.5) / n
        y = by + (ty - by) * t
        z = bz + (tz - bz) * t
        x = bx + (tx - bx) * t
        limb(p, (x - width / 2, y, z), (x + width / 2, y, z),
             rail_r * 0.8, rail_r * 0.8, zone, n=3)


def railing(p, a, b, h=1.0, post_step=1.6, r=0.04, zone=GREYR):
    """Posts + top rail between two ground points (barricade/wharf idiom)."""
    ax, ay, az = a
    bx, by, bz = b
    length = math.dist((ax, az), (bx, bz))
    n = max(2, int(length / post_step) + 1)
    for i in range(n):
        t = i / (n - 1)
        x, y, z = ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t
        limb(p, (x, y, z), (x, y + h, z), r, r, zone, n=3)
    limb(p, (ax, ay + h, az), (bx, by + h, bz), r, r, zone, n=3)


def stairs(p, base, top, width=1.0, tread_zone=GREY, side_zone=GREY):
    """Straight stair of chamfer-box treads from base to top (run along z)."""
    bx, by, bz = base
    tx, ty, tz = top
    steps = max(2, int((ty - by) / 0.24))
    for i in range(steps):
        t = (i + 0.5) / steps
        y = by + (ty - by) * t
        z = bz + (tz - bz) * t
        x = bx + (tx - bx) * t
        depth = abs(tz - bz) / steps + 0.04
        chamfer_box(p, (x, y, z), (width, 0.08, depth), 0.015,
                    {'+y': tread_zone, '+x': side_zone, '-x': side_zone,
                     '+z': side_zone, '-z': side_zone}, skip=('-y',))


# ---------------------------------------------------------------- clutter

def crate(p, center, size=1.0, zone=GREY):
    s = size
    chamfer_box(p, center, (s, s, s), s * 0.04,
                {k: zone for k in ('+x', '-x', '+y', '+z', '-z')}, skip=('-y',))


def crate_stack(p, origin, rows=2, cols=2, tiers=2, size=1.0, jitter=0.07,
                zone=GREY, rng=None):
    """Supply-dump crate block with deterministic jitter (pass a seeded rng)."""
    rng = rng or np.random.default_rng(90210)
    ox, oy, oz = origin
    for ty in range(tiers):
        for i in range(rows - (ty % 2)):
            for j in range(cols - (ty % 2)):
                jx, jz = (rng.random() - 0.5) * jitter, (rng.random() - 0.5) * jitter
                r = rng.random() * 0.12 - 0.06
                cx = ox + (i - rows / 2 + 0.5) * size * 1.06 + jx
                cz = oz + (j - cols / 2 + 0.5) * size * 1.06 + jz
                cy = oy + (ty + 0.5) * size
                crate(p, (cx + r, cy, cz - r), size, zone)


def drum(p, center, r=0.32, h=0.95, zone=GREY, n=8):
    cx, cy, cz = center
    rings = [ngon_ring((cx, cy, cz), r, n=n, axis='y'),
             ngon_ring((cx, cy + h, cz), r, n=n, axis='y')]
    _ring_solid(p, rings, zone, cap_last=True)


def drum_row(p, origin, count=4, r=0.32, h=0.95, zone=GREY, n=8):
    ox, oy, oz = origin
    for i in range(count):
        drum(p, (ox + i * (r * 2.15), oy, oz), r, h, zone, n)


def tarp_over(p, center, size, sag=0.18, zone=GREY):
    """Draped tarp shell over a footprint (supply-dump idiom): a low chamfer
    box with a slightly larger skirt reads as lashed canvas at game zoom."""
    cx, cy, cz = center
    w, h, d = size
    chamfer_box(p, (cx, cy + h / 2, cz), (w, h, d), min(w, d) * 0.10,
                {k: zone for k in ('+x', '-x', '+y', '+z', '-z')}, skip=('-y',))
    chamfer_box(p, (cx, cy + h - sag, cz), (w * 1.06, sag, d * 1.06), sag * 0.4,
                {k: zone for k in ('+x', '-x', '+y', '+z', '-z')}, skip=('-y',))


def pipe_run(p, points, r=0.12, zone=GREYR, n=6):
    """Pipework through waypoints (tank-farm/water-works idiom)."""
    for a, b in zip(points, points[1:]):
        limb(p, a, b, r, r, zone, n=n)


def tank_cylinder(p, center, r=2.0, h=4.0, zone=GREY, cap_zone=None, n=12):
    """Vertical storage tank with domed-read top cap."""
    cx, cy, cz = center
    rings = [ngon_ring((cx, cy, cz), r, n=n, axis='y'),
             ngon_ring((cx, cy + h * 0.92, cz), r, n=n, axis='y'),
             ngon_ring((cx, cy + h, cz), r * 0.62, n=n, axis='y')]
    _ring_solid(p, rings, zone)
    p.add_face(list(rings[-1]), zone=cap_zone or zone, flip=False)


def sandbag_wall(p, a, b, h=0.9, zone=GREY):
    """Sandbag revetment between two points: two offset courses of rounded
    boxes (command-post idiom)."""
    ax, ay, az = a
    bx, by, bz = b
    length = math.dist((ax, az), (bx, bz))
    courses = max(2, int(h / 0.30))
    bags = max(2, int(length / 0.55))
    ux, uz = (bx - ax) / length, (bz - az) / length
    for c in range(courses):
        off = 0.5 if c % 2 else 0.0
        for i in range(bags - (1 if c % 2 else 0)):
            t = (i + off + 0.5) / bags
            x, z = ax + (bx - ax) * t, az + (bz - az) * t
            chamfer_box(p, (x, ay + (c + 0.5) * 0.30, z), (0.55, 0.30, 0.45),
                        0.10, {k: zone for k in ('+x', '-x', '+y', '+z', '-z')},
                        skip=('-y',))


# ---------------------------------------------------------------- fittings

def antenna(p, base, h=2.2, r=0.03, zone=GREYR):
    bx, by, bz = base
    limb(p, (bx, by, bz), (bx, by + h, bz), r, r * 0.4, zone, n=3)


def beacon(p, center, size=0.14, glow_zone=GREY):
    """Small emissive-zoned beacon box — paint the zone in the emissive map."""
    chamfer_box(p, center, (size, size, size), size * 0.2,
                {k: glow_zone for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))


def turret_parts(body_index, mount=(0, 1.0, 0), ring_r=0.55, barrel_len=2.4,
                 barrel_r=0.09, twin=False, body_zone=GREY, barrel_rect=GREYR,
                 prefix='turret'):
    """Standard aimable chain — returns three piece DICTS (turret, barrel,
    muzzle) ready to extend() onto your piece table. Engine yaws `turret`,
    pitches `barrel`, spawns from `muzzle` (empty). Pass the body's index in
    the table as body_index; the trio parents itself correctly relative to
    where you append it? No — parents are ABSOLUTE table indices, so append
    the trio contiguously and pass base=len(pieces) via assemble:

        t = P.turret_parts(body_index=0, mount=(0, 1.4, -0.5))
        base = len(pieces)
        t[1]['parent'] = base       # barrel under turret
        t[2]['parent'] = base + 1   # muzzle under barrel
        pieces.extend(t)
    """
    tur = Part(prefix)
    rings = [ngon_ring((0, 0, 0), ring_r, n=8, axis='y'),
             ngon_ring((0, 0.18, 0), ring_r, n=8, axis='y')]
    _ring_solid(tur, rings, body_zone, cap_last=True)
    chamfer_box(tur, (0, 0.42, 0.05), (ring_r * 1.7, 0.5, ring_r * 2.0), 0.05,
                {k: body_zone for k in ('+x', '-x', '+y', '+z', '-z')},
                skip=('-y',))

    bar = Part('barrel' if prefix == 'turret' else prefix + '_barrel')
    xs = (-barrel_r * 1.4, barrel_r * 1.4) if twin else (0,)
    for x in xs:
        limb(bar, (x, 0, 0), (x, 0, -barrel_len), barrel_r, barrel_r * 0.85,
             barrel_rect, n=6)

    muz = Part('muzzle' if prefix == 'turret' else prefix + '_muzzle')
    return [dict(name=tur.name, parent=body_index, offset=mount, part=tur),
            dict(name=bar.name, parent=-1, offset=(0, 0.45, -ring_r * 0.6), part=bar),
            dict(name=muz.name, parent=-1, offset=(0, 0, -barrel_len), part=muz)]
