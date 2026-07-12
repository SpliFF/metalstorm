"""meshlib — tiny flat-shaded mesh construction kit for springrts-web models.

Conventions (see DESIGN-MODEL-BUILDING.md):
  forward = -Z, up = +Y, left = +X, ground at Y=0, 1 unit = 1 metre.
  glTF front faces are CCW; every face is emitted with duplicated
  vertices and a single flat normal (flat-shaded low-poly style).

UVs: every face is projected into a named atlas *zone* — a pixel rect
plus a world-coordinate window.  The same zone table drives the texture
painter, so painted panel lines land exactly where the geometry expects
them.  v runs down the image (glTF UV origin = top-left = PIL origin).
"""
from __future__ import annotations
import numpy as np

ATLAS = 1024  # px


class Zone:
    """Planar projection into an atlas rect.

    rect: (x0, y0, x1, y1) in atlas pixels.
    axes: pair from 'x','y','z','-x','-y','-z'; first maps to u, second to v.
    win:  ((a0, a1), (b0, b1)) world-coordinate window along those axes.
    """

    def __init__(self, rect, axes, win):
        self.rect = rect
        self.axes = axes
        self.win = win

    def _coord(self, p, spec):
        s = 1.0
        if spec.startswith('-'):
            s, spec = -1.0, spec[1:]
        return s * p['xyz'.index(spec)]

    def uv(self, p):
        (a0, a1), (b0, b1) = self.win
        x0, y0, x1, y1 = self.rect
        ca = self._coord(p, self.axes[0])
        cb = self._coord(p, self.axes[1])
        fu = 0.0 if a1 == a0 else (ca - a0) / (a1 - a0)
        fv = 0.0 if b1 == b0 else (cb - b0) / (b1 - b0)
        u = (x0 + fu * (x1 - x0)) / ATLAS
        v = (y0 + fv * (y1 - y0)) / ATLAS
        return (u, v)


class Part:
    """One piece's mesh: flat-shaded triangle soup with per-face UV zones."""

    def __init__(self, name):
        self.name = name
        self.pos: list = []
        self.nrm: list = []
        self.uv: list = []
        self.idx: list = []

    def add_face(self, verts, zone: Zone | None = None, uvs=None, flip=False):
        """Add a convex polygon (fan-triangulated) with one flat normal.
        verts: list of (x,y,z). zone: project UVs; or pass explicit uvs."""
        vs = [np.asarray(v, dtype=np.float64) for v in verts]
        if flip:
            vs = vs[::-1]
            if uvs is not None:
                uvs = uvs[::-1]
        # flat normal from the polygon (Newell's method — robust for quads)
        n = np.zeros(3)
        for i in range(len(vs)):
            c, nx = vs[i], vs[(i + 1) % len(vs)]
            n[0] += (c[1] - nx[1]) * (c[2] + nx[2])
            n[1] += (c[2] - nx[2]) * (c[0] + nx[0])
            n[2] += (c[0] - nx[0]) * (c[1] + nx[1])
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            return
        n = n / ln
        base = len(self.pos)
        for i, v in enumerate(vs):
            self.pos.append(tuple(v))
            self.nrm.append(tuple(n))
            if uvs is not None:
                self.uv.append(tuple(uvs[i]))
            elif zone is not None:
                self.uv.append(zone.uv(v))
            else:
                self.uv.append((0.0, 0.0))
        for i in range(1, len(vs) - 1):
            self.idx.extend([base, base + i, base + i + 1])

    def add_quad(self, a, b, c, d, zone=None, uvs=None, flip=False):
        self.add_face([a, b, c, d], zone=zone, uvs=uvs, flip=flip)

    def tri_count(self):
        return len(self.idx) // 3

    def bounds(self):
        if not self.pos:
            z = (0.0, 0.0, 0.0)
            return z, z
        p = np.array(self.pos)
        return tuple(p.min(axis=0)), tuple(p.max(axis=0))


# ── primitives ───────────────────────────────────────────────────────────

def loft(part: Part, rings, zone_of, cap_start=None, cap_end=None,
         close=True, flip_side=False):
    """Skin consecutive vertex rings (each a list of (x,y,z), equal length,
    ordered consistently).  zone_of(face_center, face_normal_hint) -> Zone.
    cap_start/cap_end: Zone for end caps (fan), or None to leave open."""
    nr = len(rings)
    nv = len(rings[0])
    for i in range(nr - 1):
        r0, r1 = rings[i], rings[i + 1]
        m = nv if close else nv - 1
        for j in range(m):
            k = (j + 1) % nv
            quad = [r0[j], r0[k], r1[k], r1[j]]
            c = np.mean(np.array(quad), axis=0)
            # face normal hint from the quad itself
            n = np.cross(np.asarray(r0[k]) - np.asarray(r0[j]),
                         np.asarray(r1[j]) - np.asarray(r0[j]))
            ln = np.linalg.norm(n)
            if ln < 1e-12:
                continue
            n = n / ln
            if flip_side:
                quad = quad[::-1]
                n = -n
            part.add_face(quad, zone=zone_of(c, n))
    if cap_start is not None:
        part.add_face(list(rings[0]), zone=cap_start, flip=not flip_side)
    if cap_end is not None:
        part.add_face(list(rings[-1]), zone=cap_end, flip=flip_side)


def chamfer_box(part: Part, center, size, ch, zones, skip=()):
    """Axis-aligned box with chamfered edges/corners.
    zones: dict face-key -> Zone for '+x','-x','+y','-y','+z','-z'
           (chamfer facets borrow the nearest main face's zone).
    skip: face keys to omit entirely (e.g. a face flush against a hull)."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2.0, size[1] / 2.0, size[2] / 2.0
    c = min(ch, hx * 0.9, hy * 0.9, hz * 0.9)

    def P(sx, sy, sz, ax):
        """corner vertex pulled inward by chamfer on all axes except ax"""
        x = cx + sx * (hx - (0 if ax == 'x' else c))
        y = cy + sy * (hy - (0 if ax == 'y' else c))
        z = cz + sz * (hz - (0 if ax == 'z' else c))
        return (x, y, z)

    S = [(sx, sy, sz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]

    def face(key, corners_signs, ax):
        if key in skip or key not in zones:
            return
        vs = [P(sx, sy, sz, ax) for (sx, sy, sz) in corners_signs]
        part.add_face(vs, zone=zones[key])

    # main faces (inset by chamfer), wound CCW seen from outside
    face('+y', [(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)], 'y')
    face('-y', [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)], 'y')
    face('+x', [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)], 'x')
    face('-x', [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)], 'x')
    face('-z', [(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)], 'z')
    face('+z', [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)], 'z')

    def zfor(key):
        return zones.get(key) or next(iter(zones.values()))

    # 12 edge bevels
    edges = [
        # (axis along edge, sign pair on the other two axes)
        ('z', ('+x', '+y')), ('z', ('+x', '-y')), ('z', ('-x', '+y')), ('z', ('-x', '-y')),
        ('x', ('+y', '+z')), ('x', ('+y', '-z')), ('x', ('-y', '+z')), ('x', ('-y', '-z')),
        ('y', ('+x', '+z')), ('y', ('+x', '-z')), ('y', ('-x', '+z')), ('y', ('-x', '-z')),
    ]
    for ax, (ka, kb) in edges:
        if ka in skip and kb in skip:
            continue
        sa = 1 if ka[0] == '+' else -1
        sb = 1 if kb[0] == '+' else -1
        aax, bax = ka[1], kb[1]
        # two edge endpoints run along `ax` from -1 to +1
        quad = []
        for t, pull in ((-1, aax), (-1, bax), (1, bax), (1, aax)):
            s = {ax: t, aax: sa, bax: sb}
            quad.append(P(s['x'], s['y'], s['z'], pull))
        # ensure outward winding: check against outward dir
        out = np.zeros(3)
        out['xyz'.index(aax)] = sa
        out['xyz'.index(bax)] = sb
        n = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                     np.asarray(quad[3]) - np.asarray(quad[0]))
        if np.dot(n, out) < 0:
            quad = quad[::-1]
        part.add_face(quad, zone=zfor(ka if ka not in skip else kb))

    # 8 corner triangles
    for (sx, sy, sz) in S:
        keys = [('%s%s' % ('+' if s > 0 else '-', a))
                for s, a in ((sx, 'x'), (sy, 'y'), (sz, 'z'))]
        if all(k in skip for k in keys):
            continue
        tri = [P(sx, sy, sz, 'x'), P(sx, sy, sz, 'y'), P(sx, sy, sz, 'z')]
        out = np.array([sx, sy, sz], dtype=float)
        n = np.cross(np.asarray(tri[1]) - np.asarray(tri[0]),
                     np.asarray(tri[2]) - np.asarray(tri[0]))
        if np.dot(n, out) < 0:
            tri = tri[::-1]
        zkey = next((k for k in keys if k not in skip and k in zones), None)
        part.add_face(tri, zone=zones.get(zkey) or zfor(keys[0]))


def ngon_ring(center, radius, n=8, axis='z', phase=None):
    """Vertex ring of an n-gon around `axis` at `center`. Flat-top phase."""
    cx, cy, cz = center
    ph = (np.pi / n) if phase is None else phase
    pts = []
    for i in range(n):
        a = ph + 2 * np.pi * i / n
        if axis == 'z':
            pts.append((cx + radius * np.cos(a), cy + radius * np.sin(a), cz))
        elif axis == 'y':
            pts.append((cx + radius * np.cos(a), cy, cz + radius * np.sin(a)))
        else:
            pts.append((cx, cy + radius * np.cos(a), cz + radius * np.sin(a)))
    return pts


def tube(part: Part, stations, zone_rect, n=8, cap_start=None, cap_end=None,
         axis='z', vspan=None, phase=None, xoff=0.0):
    """Octagonal (n-gon) tube along -Z (or axis) with parametric UVs.
    stations: list of (z, radius, [ycenter_offset]) from breech (z max)
    to muzzle (z min). UVs: u = along-length param, v = around param,
    mapped into zone_rect pixels. xoff shifts the whole tube in X (twin
    barrels). Returns ring list for reuse."""
    x0, y0, x1, y1 = zone_rect
    rings = []
    zs = [s[0] for s in stations]
    zmin, zmax = min(zs), max(zs)
    for (z, r, *rest) in stations:
        yoff = rest[0] if rest else 0.0
        rings.append(ngon_ring((xoff, yoff, z), r, n=n, axis=axis, phase=phase))
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        z0, z1 = stations[i][0], stations[i + 1][0]
        u0 = (x0 + (x1 - x0) * (zmax - z0) / (zmax - zmin)) / ATLAS
        u1 = (x0 + (x1 - x0) * (zmax - z1) / (zmax - zmin)) / ATLAS
        for j in range(n):
            k = (j + 1) % n
            va = (y0 + (y1 - y0) * j / n) / ATLAS
            vb = (y0 + (y1 - y0) * (j + 1) / n) / ATLAS
            quad = [r0[j], r0[k], r1[k], r1[j]]
            quaduv = [(u0, va), (u0, vb), (u1, vb), (u1, va)]
            # outward winding (radial)
            c = np.mean(np.array(quad), axis=0)
            rad = np.array([c[0] - xoff, c[1] - (stations[i][2] if len(stations[i]) > 2 else 0.0), 0.0])
            n_ = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                          np.asarray(quad[3]) - np.asarray(quad[0]))
            if np.dot(n_, rad) < 0:
                quad, quaduv = quad[::-1], quaduv[::-1]
            part.add_face(quad, uvs=quaduv)
    if cap_start is not None:
        part.add_face(list(rings[0]), zone=cap_start, flip=False)
    if cap_end is not None:
        part.add_face(list(rings[-1]), zone=cap_end, flip=True)
    return rings


def mirror_x(src: Part, name) -> Part:
    """Mirrored copy across X=0 (winding + normals fixed)."""
    dst = Part(name)
    dst.pos = [(-x, y, z) for (x, y, z) in src.pos]
    dst.nrm = [(-x, y, z) for (x, y, z) in src.nrm]
    dst.uv = list(src.uv)
    for i in range(0, len(src.idx), 3):
        a, b, c = src.idx[i:i + 3]
        dst.idx.extend([a, c, b])
    return dst

def limb(part: Part, p0, p1, r0, r1, zone_rect, n=8, cap_start=None,
         cap_end=None, twist=0.0):
    """Angled n-gon prism from joint p0 to joint p1 (piece-local), radii
    r0->r1 — the mech-limb primitive. Parametric UV into zone_rect px
    (u along the limb, v around). Rest rotation stays identity: the slant
    is baked into the geometry, so animation pivots stay clean."""
    p0 = np.asarray(p0, dtype=float)
    p1 = np.asarray(p1, dtype=float)
    d = p1 - p0
    ln = np.linalg.norm(d)
    if ln < 1e-9:
        return
    d = d / ln
    ref = np.array([1.0, 0.0, 0.0]) if abs(d[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    u = np.cross(d, ref)
    u = u / np.linalg.norm(u)
    v = np.cross(d, u)
    x0, y0, x1, y1 = zone_rect
    rings = []
    for (p, r) in ((p0, r0), (p1, r1)):
        ring = []
        for i in range(n):
            a = twist + np.pi / n + 2 * np.pi * i / n
            ring.append(tuple(p + u * (r * np.cos(a)) + v * (r * np.sin(a))))
        rings.append(ring)
    for j in range(n):
        k = (j + 1) % n
        ua = (x0 + (x1 - x0) * 0.0) / ATLAS
        ub = (x0 + (x1 - x0) * 1.0) / ATLAS
        va = (y0 + (y1 - y0) * j / n) / ATLAS
        vb = (y0 + (y1 - y0) * (j + 1) / n) / ATLAS
        quad = [rings[0][j], rings[0][k], rings[1][k], rings[1][j]]
        uvs = [(ua, va), (ua, vb), (ub, vb), (ub, va)]
        nrm = np.cross(np.asarray(quad[1]) - np.asarray(quad[0]),
                       np.asarray(quad[3]) - np.asarray(quad[0]))
        ctr = np.mean(np.array(quad), axis=0)
        axis_pt = p0 + d * np.dot(ctr - p0, d)
        if np.dot(nrm, ctr - axis_pt) < 0:
            quad, uvs = quad[::-1], uvs[::-1]
        part.add_face(quad, uvs=uvs)
    if cap_start is not None:
        part.add_face(list(rings[0]), zone=cap_start,
                      flip=(np.dot(np.cross(
                          np.asarray(rings[0][1]) - np.asarray(rings[0][0]),
                          np.asarray(rings[0][2]) - np.asarray(rings[0][0])), -d) < 0))
    if cap_end is not None:
        part.add_face(list(rings[1]), zone=cap_end,
                      flip=(np.dot(np.cross(
                          np.asarray(rings[1][1]) - np.asarray(rings[1][0]),
                          np.asarray(rings[1][2]) - np.asarray(rings[1][0])), d) < 0))
