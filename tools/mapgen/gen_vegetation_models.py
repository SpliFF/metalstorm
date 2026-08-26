#!/usr/bin/env python3
"""gen_vegetation_models — procedural map-feature models (PLAN-maps.md M6).

Builds the vegetation/rock props terragen's scatter places
(`terragen/vegetation.py` climate palettes — the def names MUST match):

    tree_conifer    stacked skirt cones on a tapered trunk
    tree_broadleaf  bent trunk + displaced icosphere canopy cluster
    bush_scrub      low displaced-icosphere cluster
    rock_boulder    displaced icosphere with a flattened base
    dead_snag       snapped bare trunk, three stripped branches   (arctic/arid)
    cactus_column   fluted column with two elbowed arms           (arid)
    desert_shrub    dry tan lobes over bare twigs                 (arid)
    palm            leaning ringed trunk under seven fronds       (tropical)

`--climate` selects which of them a package gets: a map should carry the
props its placement list names and no others. `temperate` is the original
eleven in the original order, so a regenerated shipped map is byte-identical.

Everything is deterministic (one seed per species, no wall-clock, no
unordered iteration) and authored in **elmos** — map features are drawn at
their raw model scale, unlike unit models which are authored in metres.
Trees land at 60-140 elmos, matching Spring's own tree/rock props (an
authentic `GreyRock1.s3o` measures 150 x 55 x 135).

Style follows tools/fable-model-forge: flat-shaded low poly, one piece per
model (the client's feature renderer thin-instances the *first* mesh with
geometry — `client/src/core/feature-renderer.ts pickPrimaryMesh` — so a
multi-piece prop would render only its first piece), UVs projected into a
palette atlas, exported through the forge's own `gltf_export` (exact
float32 accessor bounds, SPRINGRTS_geometry). Vegetation ships only
diffuse + ORM: features are never team-coloured and never glow.

Outputs per species, into <out>/objects3d/ :

    <name>.gltf  <name>.bin
    <name>_diffuse.ktx2   <name>_orm.ktx2          (+ .png sources)
    <name>_impostor.ktx2  <name>_impostor.json     8-yaw x 3-pitch atlas

Usage:
    .venv/bin/python gen_vegetation_models.py
      [--out content/maps/meridian_basin] [--no-impostors] [--keep-png]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FORGE = os.path.join(REPO_ROOT, "tools", "fable-model-forge")
sys.path.insert(0, FORGE)

import bake_impostors                      # noqa: E402
import gltf_export                         # noqa: E402
from meshlib import Part                   # noqa: E402

sys.path.insert(0, HERE)
from terragen import vegetation as veg     # noqa: E402

# ── palette atlas ───────────────────────────────────────────────────────
# 4x4 grid of 64px swatches in a 256^2 atlas. Every face is UV'd inside one
# swatch, well clear of the borders so mip chains never bleed across cells.
# Colours sit in the fable_* family's desaturated range (paint.py) — the
# greys are literally the armour ramp so rocks read as the same world.
ATLAS = 256
GRID = 4
CELL = ATLAS // GRID
INSET = 15

# name -> (rgb, roughness, ao)
SWATCHES = {
    "bark":        ((88, 72, 57), 205, 226),
    "bark_dk":     ((62, 51, 41), 212, 196),
    "bark_lt":     ((110, 92, 72), 200, 236),
    "needle_dk":   ((37, 57, 43), 224, 190),
    "needle":      ((51, 77, 53), 220, 214),
    "needle_lt":   ((72, 100, 63), 216, 238),
    "leaf_dk":     ((55, 73, 45), 226, 192),
    "leaf":        ((77, 98, 55), 222, 216),
    "leaf_lt":     ((102, 123, 67), 218, 240),
    "scrub_dk":    ((70, 76, 48), 228, 196),
    "scrub":       ((95, 100, 61), 224, 218),
    "scrub_lt":    ((120, 123, 78), 220, 240),
    "rock_dk":     ((66, 69, 73), 190, 194),
    "rock":        ((94, 97, 101), 178, 220),
    "rock_lt":     ((123, 126, 130), 170, 242),
    "moss":        ((71, 86, 55), 230, 206),
}
SWATCH_ORDER = list(SWATCHES)


def swatch_rect(name: str) -> tuple[int, int, int, int]:
    i = SWATCH_ORDER.index(name)
    cx, cy = i % GRID, i // GRID
    return (cx * CELL, cy * CELL, (cx + 1) * CELL, (cy + 1) * CELL)


def paint_atlas(rng: np.random.Generator) -> tuple[Image.Image, Image.Image]:
    """Diffuse (sRGB) + ORM (linear, R=AO G=roughness B=metallic) atlases.
    Each swatch is its base colour plus fine two-octave value noise, so the
    flat facets pick up a little grain instead of reading as vinyl."""
    dif = np.zeros((ATLAS, ATLAS, 3), dtype=np.float64)
    orm = np.zeros((ATLAS, ATLAS, 3), dtype=np.float64)
    for name, (rgb, rough, ao) in SWATCHES.items():
        x0, y0, x1, y1 = swatch_rect(name)
        fine = rng.normal(0.0, 1.0, (CELL, CELL))
        coarse = np.kron(rng.normal(0.0, 1.0, (CELL // 8, CELL // 8)),
                         np.ones((8, 8)))
        n = 0.055 * fine + 0.085 * coarse
        # gentle top-lit gradient so even an unlit facet has some form
        grad = np.linspace(1.06, 0.94, CELL)[:, None]
        f = np.clip((1.0 + n) * grad, 0.6, 1.4)
        dif[y0:y1, x0:x1] = np.clip(np.asarray(rgb) * f[:, :, None], 0, 255)
        orm[y0:y1, x0:x1, 0] = np.clip(ao * (0.94 + 0.06 * coarse), 0, 255)
        orm[y0:y1, x0:x1, 1] = np.clip(rough * (0.97 + 0.05 * fine), 0, 255)
        orm[y0:y1, x0:x1, 2] = 0.0
    return (Image.fromarray(dif.astype(np.uint8)),
            Image.fromarray(orm.astype(np.uint8)))


class Palette:
    """Hands out UV polygons inside a swatch. Each face gets its own small
    rotated polygon so neighbouring facets don't sample identical texels."""

    def __init__(self, rng: np.random.Generator):
        self.rng = rng

    def uvs(self, swatch: str, n: int) -> list[tuple[float, float]]:
        x0, y0, x1, y1 = swatch_rect(swatch)
        cx = (x0 + x1) * 0.5
        cy = (y0 + y1) * 0.5
        rad = (CELL * 0.5 - INSET)
        # jitter the sampling disc's centre a little inside the inset box
        jx = self.rng.uniform(-rad * 0.35, rad * 0.35)
        jy = self.rng.uniform(-rad * 0.35, rad * 0.35)
        r = rad * self.rng.uniform(0.45, 0.65)
        ph = self.rng.uniform(0.0, 2.0 * np.pi)
        out = []
        for i in range(n):
            a = ph + 2.0 * np.pi * i / n
            out.append(((cx + jx + r * np.cos(a)) / ATLAS,
                        (cy + jy + r * np.sin(a)) / ATLAS))
        return out


# ── mesh primitives ─────────────────────────────────────────────────────

def _ring(centre, radius, n, phase=0.0, wobble=None):
    """Horizontal n-gon ring around +Y at `centre`. `wobble` (optional)
    is a per-vertex radial multiplier array of length n."""
    cx, cy, cz = centre
    pts = []
    for i in range(n):
        a = phase + 2.0 * np.pi * i / n
        r = radius * (1.0 if wobble is None else wobble[i])
        pts.append((cx + r * np.cos(a), cy, cz + r * np.sin(a)))
    return pts


# Winding note: `_ring` walks increasing angle, which Newell resolves to a
# -Y normal — so a ring taken in its natural order caps *downwards*, and
# side quads must run lo[j] -> hi[j] (not lo[j] -> lo[k]) to face outwards.
# `--selftest` asserts the resulting mesh has positive signed volume.

def _skin(part: Part, lo, hi, pal: Palette, swatch: str):
    n = len(lo)
    for j in range(n):
        k = (j + 1) % n
        quad = [lo[j], hi[j], hi[k], lo[k]]
        part.add_face(quad, uvs=pal.uvs(swatch, 4))


def _fan_apex(part: Part, ring, apex, pal: Palette, swatch: str):
    n = len(ring)
    for j in range(n):
        k = (j + 1) % n
        part.add_face([ring[k], ring[j], apex], uvs=pal.uvs(swatch, 3))


def _cap(part: Part, ring, pal: Palette, swatch: str, down: bool):
    """Flat cap over a ring. `down` winds it to face -Y."""
    pts = list(ring) if down else list(ring)[::-1]
    part.add_face(pts, uvs=pal.uvs(swatch, len(pts)))


ICO_T = (1.0 + 5.0 ** 0.5) / 2.0
_ICO_V = np.array([
    (-1, ICO_T, 0), (1, ICO_T, 0), (-1, -ICO_T, 0), (1, -ICO_T, 0),
    (0, -1, ICO_T), (0, 1, ICO_T), (0, -1, -ICO_T), (0, 1, -ICO_T),
    (ICO_T, 0, -1), (ICO_T, 0, 1), (-ICO_T, 0, -1), (-ICO_T, 0, 1),
], dtype=np.float64)
_ICO_F = [
    (0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
    (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
    (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
    (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1),
]


def icosphere(subdiv: int):
    """Unit icosphere as (verts (V,3) on the unit sphere, faces (F,3))."""
    verts = [v / np.linalg.norm(v) for v in _ICO_V]
    faces = list(_ICO_F)
    for _ in range(subdiv):
        cache: dict[tuple[int, int], int] = {}

        def mid(a, b):
            key = (min(a, b), max(a, b))
            if key not in cache:
                m = verts[a] + verts[b]
                verts.append(m / np.linalg.norm(m))
                cache[key] = len(verts) - 1
            return cache[key]

        nf = []
        for (a, b, c) in faces:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = nf
    return np.array(verts), faces


def _lumpy(dirs: np.ndarray, rng: np.random.Generator, amp: float,
           lobes: int = 5) -> np.ndarray:
    """Smooth deterministic radial displacement in [1-amp, 1+amp]: a sum of
    band-limited directional cosines. Cheap stand-in for 3D value noise and
    C-infinity, so the silhouette stays organic without spikes."""
    acc = np.zeros(len(dirs))
    for k in range(lobes):
        axis = rng.normal(size=3)
        axis /= np.linalg.norm(axis)
        freq = rng.uniform(1.4, 3.4)
        phase = rng.uniform(0.0, 2.0 * np.pi)
        acc += np.cos(freq * (dirs @ axis) * np.pi + phase) / (k + 1.0)
    acc /= np.abs(acc).max() or 1.0
    return 1.0 + amp * acc


def _rot(yaw: float, pitch: float) -> np.ndarray:
    """Rotation about +Y by `yaw`, then about the resulting +Z-ish axis by
    `pitch` (tilting the +X axis up). Both are proper rotations, so a mesh
    passed through them keeps its winding — the property `_transform`'s note
    relies on, and what makes `blob(rot=...)` safe."""
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    ry = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]])
    rp = np.array([[cp, -sp, 0.0], [sp, cp, 0.0], [0.0, 0.0, 1.0]])
    return ry @ rp


def blob(part: Part, pal: Palette, rng: np.random.Generator, centre,
         radii, subdiv: int, amp: float, swatches, floor: float | None = None,
         rot: np.ndarray | None = None):
    """Displaced ellipsoid. `swatches` is (lit, mid, shadow) — the facet's
    own normal picks which, so the palette does the tonal work the flat
    normals alone can't. `floor`, if given, clamps world Y (flat base).
    `rot`, if given, is a proper rotation applied after scaling and before
    the translation — how a stretched ellipsoid becomes a palm frond, a
    cactus elbow or a dead branch without hand-winding a swept tube."""
    unit, faces = icosphere(subdiv)
    disp = _lumpy(unit, rng, amp)
    pts = unit * disp[:, None] * np.asarray(radii)
    if rot is not None:
        pts = pts @ np.asarray(rot).T
    pts = pts + np.asarray(centre)
    if floor is not None:
        pts[:, 1] = np.maximum(pts[:, 1], floor)
    lit, mid, dark = swatches
    for (a, b, c) in faces:
        tri = [pts[a], pts[b], pts[c]]
        n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        ln = np.linalg.norm(n)
        if ln < 1e-9:
            continue
        up = (n / ln)[1]
        sw = lit if up > 0.45 else (mid if up > -0.15 else dark)
        part.add_face([tuple(v) for v in tri], uvs=pal.uvs(sw, 3))


def trunk(part: Part, pal: Palette, rng: np.random.Generator, stations,
          n: int, swatch: str, lean=(0.0, 0.0), base=(0.0, 0.0)):
    """Tapered n-gon trunk. `stations` = [(y, radius), ...] bottom-up;
    `lean` is the total (x, z) offset applied at the top, eased in so the
    base stays planted. `base` offsets the whole column in (x, z) — a
    cactus arm is a second column beside the first, not a lean on it."""
    rings = []
    ymin, ymax = stations[0][0], stations[-1][0]
    for (y, r) in stations:
        t = (y - ymin) / max(ymax - ymin, 1e-6)
        wob = 1.0 + rng.uniform(-0.09, 0.09, n)
        c = (base[0] + lean[0] * t * t, y, base[1] + lean[1] * t * t)
        rings.append(_ring(c, r, n, phase=0.2, wobble=wob))
    for i in range(len(rings) - 1):
        _skin(part, rings[i], rings[i + 1], pal, swatch)
    _cap(part, rings[0], pal, swatch, down=True)
    return rings[-1]


# ── species ─────────────────────────────────────────────────────────────

def build_conifer(pal: Palette, rng: np.random.Generator) -> Part:
    """Stacked skirt cones on a tapered trunk. ~118 elmos tall."""
    p = Part("conifer")
    top = trunk(p, pal, rng,
                [(0.0, 4.6), (16.0, 3.6), (40.0, 2.8), (74.0, 2.0), (96.0, 1.3)],
                n=8, swatch="bark")
    _cap(p, top, pal, "bark_lt", down=False)

    tiers = 5
    n = 12
    y = 22.0
    for t in range(tiers):
        f = t / (tiers - 1)
        r_lo = 26.0 * (1.0 - 0.72 * f) + 3.0
        r_hi = r_lo * 0.62
        h_tier = 30.0 * (1.0 - 0.34 * f)
        wob_lo = 1.0 + rng.uniform(-0.13, 0.13, n)
        wob_hi = 1.0 + rng.uniform(-0.10, 0.10, n)
        ph = rng.uniform(0.0, 2.0 * np.pi)
        lo = _ring((0, y, 0), r_lo, n, phase=ph, wobble=wob_lo)
        hi = _ring((0, y + h_tier * 0.42, 0), r_hi, n, phase=ph, wobble=wob_hi)
        apex = (0.0, y + h_tier, 0.0)
        _cap(p, lo, pal, "needle_dk", down=True)
        _skin(p, lo, hi, pal, "needle")
        _fan_apex(p, hi, apex, pal, "needle_lt" if t > 1 else "needle")
        y += h_tier * 0.60
    return p


def build_broadleaf(pal: Palette, rng: np.random.Generator) -> Part:
    """Leaning trunk under a four-lobe canopy. ~92 elmos tall."""
    p = Part("broadleaf")
    lean = (5.0, -3.0)
    top = trunk(p, pal, rng,
                [(0.0, 5.4), (14.0, 4.2), (34.0, 3.4), (50.0, 2.6)],
                n=8, swatch="bark_dk", lean=lean)
    _cap(p, top, pal, "bark", down=False)
    # two boughs continuing the taper into the canopy
    for dx, dz in ((-4.0, 3.0), (6.0, -2.0)):
        trunk(p, pal, rng, [(48.0, 2.4), (60.0, 1.6)], n=6, swatch="bark",
              lean=(lean[0] + dx, lean[1] + dz))

    lobes = [((3.0, 66.0, -1.0), (30.0, 22.0, 28.0), 0.20),
             ((-15.0, 58.0, 9.0), (21.0, 16.0, 20.0), 0.22),
             ((16.0, 56.0, 11.0), (19.0, 15.0, 18.0), 0.22),
             ((1.0, 78.0, -8.0), (18.0, 15.0, 17.0), 0.24)]
    for centre, radii, amp in lobes:
        blob(p, pal, rng, centre, radii, subdiv=1, amp=amp,
             swatches=("leaf_lt", "leaf", "leaf_dk"))
    return p


def build_bush(pal: Palette, rng: np.random.Generator) -> Part:
    """Three-lobe scrub clump, ~22 elmos tall, no trunk to speak of."""
    p = Part("scrub")
    lobes = [((0.0, 10.5, 0.0), (11.5, 9.0, 10.5), 0.26),
             ((-7.5, 7.0, 5.0), (7.5, 6.2, 7.0), 0.28),
             ((6.5, 6.5, -5.5), (7.0, 5.6, 6.6), 0.28)]
    for centre, radii, amp in lobes:
        blob(p, pal, rng, centre, radii, subdiv=1, amp=amp,
             swatches=("scrub_lt", "scrub", "scrub_dk"), floor=0.0)
    return p


def build_boulder(pal: Palette, rng: np.random.Generator) -> Part:
    """Displaced icosphere sheared into a wedge and cut flat at the base,
    so it sits on the terrain instead of hovering. ~26 elmos tall."""
    p = Part("boulder")
    unit, faces = icosphere(2)
    disp = _lumpy(unit, rng, 0.24, lobes=6)
    pts = unit * disp[:, None] * np.array([21.0, 17.0, 18.5])
    # shear: push the upper half back in -Z for an asymmetric profile
    pts[:, 2] += 0.22 * np.maximum(pts[:, 1], 0.0)
    cut = -17.0 * 0.38          # slice off the bottom 38% of the radius
    pts[:, 1] = np.maximum(pts[:, 1], cut)
    pts[:, 1] -= cut            # base to Y=0
    for (a, b, c) in faces:
        tri = [pts[a], pts[b], pts[c]]
        n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        ln = np.linalg.norm(n)
        if ln < 1e-9:
            continue
        up = (n / ln)[1]
        # Moss keys off the facet's own tilt rather than a coin flip, so it
        # forms coherent caps on the flattest tops instead of salt-and-pepper.
        if up > 0.80:
            sw = "moss"
        elif up > 0.45:
            sw = "rock_lt"
        elif up > -0.10:
            sw = "rock"
        else:
            sw = "rock_dk"
        p.add_face([tuple(v) for v in tri], uvs=pal.uvs(sw, 3))
    return p


def _spindle(part: Part, pal: Palette, rng: np.random.Generator, origin,
             yaw: float, pitch: float, length: float, thick: float,
             swatches, subdiv: int = 0, amp: float = 0.18) -> None:
    """A stretched, rotated ellipsoid growing out of `origin` — the cheap
    closed-and-correctly-wound swept tube. Used for bare branches, cactus
    elbows and palm fronds; `subdiv=0` keeps a 1-elmo-thick twig at 20 tris
    instead of the 80 a smooth one would cost for no visible gain."""
    r = _rot(yaw, pitch)
    d = r @ np.array([length * 0.82, 0.0, 0.0])
    blob(part, pal, rng,
         (origin[0] + d[0], origin[1] + d[1], origin[2] + d[2]),
         (length, thick, thick), subdiv=subdiv, amp=amp,
         swatches=swatches, rot=r)


def build_dead_snag(pal: Palette, rng: np.random.Generator) -> Part:
    """Bare standing deadwood — a snapped, stripped trunk with three
    branches left. ~72 elmos. The arctic and arid palettes' way of saying
    trees stood here, on ground whose living cover is a treeline or a
    wash."""
    p = Part("dead_snag")
    top = trunk(p, pal, rng,
                [(0.0, 4.2), (18.0, 3.2), (42.0, 2.4), (62.0, 1.5)],
                n=7, swatch="bark_dk", lean=(2.4, -1.6))
    # snapped crown: a ragged spike, not a sawn cap
    _fan_apex(p, top, (3.2, 72.0, -2.2), pal, "bark_lt")
    for yaw, pitch, y, ln in ((0.42, 0.50, 44.0, 16.0),
                              (2.65, 0.30, 32.0, 13.0),
                              (4.40, 0.72, 54.0, 11.0)):
        _spindle(p, pal, rng, (1.0, y, -0.6), yaw, pitch, ln, 1.5,
                 ("bark_lt", "bark", "bark_dk"))
    return p


def build_cactus(pal: Palette, rng: np.random.Generator) -> Part:
    """Columnar cactus: a fluted 8-gon trunk with two arms that elbow out
    and turn back up. ~54 elmos. The flutes are free — they are the ring
    wobble `trunk()` already applies."""
    p = Part("cactus_column")
    top = trunk(p, pal, rng,
                [(0.0, 5.6), (10.0, 6.2), (30.0, 5.6), (46.0, 4.4)],
                n=8, swatch="needle")
    _fan_apex(p, top, (0.0, 54.0, 0.0), pal, "needle_lt")
    for yaw, reach, y0, h in ((0.90, 13.0, 20.0, 24.0),
                              (3.85, 12.0, 27.0, 17.0)):
        ax, az = reach * np.cos(yaw), reach * np.sin(yaw)
        # elbow: half-length `reach*0.52` puts the spindle's far tip at
        # 1.82x that — i.e. on the arm's axis, so the two overlap instead of
        # leaving the arm hanging in the air beside the trunk
        _spindle(p, pal, rng, (0.0, y0, 0.0), yaw, 0.50, reach * 0.52, 3.4,
                 ("needle_lt", "needle", "needle_dk"), subdiv=1, amp=0.14)
        atop = trunk(p, pal, rng,
                     [(y0 + reach * 0.22, 3.4), (y0 + h * 0.6, 3.2),
                      (y0 + h, 2.4)],
                     n=7, swatch="needle", base=(ax, az))
        _fan_apex(p, atop, (ax, y0 + h + 4.0, az), pal, "needle_lt")
    return p


def build_desert_shrub(pal: Palette, rng: np.random.Generator) -> Part:
    """Half-dead dry shrub, ~14 elmos: mostly bare twigs with three small
    tufts caught in them. Deliberately NOT a scaled-down `bush_scrub` — the
    first attempt was, and it read as a mossy boulder, because a dry shrub
    is defined by the gaps in it. Tan rather than green: the existing atlas
    already carries the range (`scrub_dk` + `bark_*`), so no swatch is
    added and every shipped model keeps its UVs."""
    p = Part("desert_shrub")
    for yaw, pitch, ln in ((0.35, 1.05, 9.5), (1.55, 1.25, 8.0),
                           (2.70, 0.95, 8.8), (3.95, 1.20, 7.2),
                           (5.15, 1.00, 8.2)):
        _spindle(p, pal, rng, (0.0, 1.2, 0.0), yaw, pitch, ln, 0.65,
                 ("bark_lt", "bark", "bark_dk"), amp=0.22)
    for centre, radii, amp in (((1.4, 9.6, -1.0), (4.2, 3.0, 3.8), 0.34),
                               ((-4.4, 6.2, 3.0), (3.4, 2.4, 3.2), 0.36),
                               ((4.2, 5.0, 3.4), (3.0, 2.2, 2.9), 0.36)):
        blob(p, pal, rng, centre, radii, subdiv=1, amp=amp,
             swatches=("scrub_lt", "scrub_dk", "bark_dk"), floor=0.0)
    return p


def build_palm(pal: Palette, rng: np.random.Generator) -> Part:
    """Leaning palm: a ringed trunk under seven fronds, ~81 elmos. Fronds
    alternate between held-up and drooping so the crown reads as a crown
    from the side and not as a flat starburst from above."""
    p = Part("palm")
    lean = (9.0, -5.0)
    top = trunk(p, pal, rng,
                [(0.0, 4.4), (16.0, 3.6), (38.0, 3.0), (58.0, 2.6), (70.0, 2.4)],
                n=7, swatch="bark_lt", lean=lean)
    _cap(p, top, pal, "bark", down=False)
    crown = (lean[0], 71.0, lean[1])
    for i in range(7):
        yaw = 2.0 * np.pi * i / 7 + 0.31
        pitch = (0.34, 0.05, -0.14)[i % 3]
        r = _rot(yaw, pitch)
        d = r @ np.array([20.0, 0.0, 0.0])
        blob(p, pal, rng,
             (crown[0] + d[0], crown[1] + d[1], crown[2] + d[2]),
             (24.0, 2.0, 6.5), subdiv=1, amp=0.22,
             swatches=("leaf_lt", "leaf", "leaf_dk"), rot=r)
    # crownshaft / nut cluster where the fronds meet the trunk
    blob(p, pal, rng, crown, (5.2, 4.6, 5.2), subdiv=1, amp=0.20,
         swatches=("bark_lt", "bark", "bark_dk"))
    return p


def _transform(part: Part, fn) -> None:
    """Apply a point transform to every vertex in-place. Proper rotations
    (det=+1) preserve winding; the selftest volume check guards the rest."""
    part.pos = [tuple(fn(np.asarray(v, dtype=np.float64))) for v in part.pos]


def _box(part: Part, pal: Palette, x0, x1, y0, y1, z0, z1,
         swatches=("rock_lt", "rock", "rock_dk")):
    """Axis-aligned box with outward winding. swatches = (top, side, bottom)."""
    top, side, bottom = swatches
    part.add_face([(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)],
                  uvs=pal.uvs(top, 4))
    part.add_face([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
                  uvs=pal.uvs(bottom, 4))
    part.add_face([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)],
                  uvs=pal.uvs(side, 4))
    part.add_face([(x0, y0, z1), (x0, y1, z1), (x0, y1, z0), (x0, y0, z0)],
                  uvs=pal.uvs(side, 4))
    part.add_face([(x1, y0, z1), (x1, y1, z1), (x0, y1, z1), (x0, y0, z1)],
                  uvs=pal.uvs(side, 4))
    part.add_face([(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)],
                  uvs=pal.uvs(side, 4))


def build_fallen_log(pal: Palette, rng: np.random.Generator) -> Part:
    """Windthrown trunk lying along +X, ~36 elmos, one sawn/snapped end.
    Built vertically with trunk() (known-good winding) then rotated flat."""
    p = Part("fallen_log")
    top = trunk(p, pal, rng,
                [(0.0, 3.6), (12.0, 3.1), (24.0, 2.7), (36.0, 2.2)],
                n=8, swatch="bark_dk")
    # snapped end: jagged fan instead of a flat cap
    apex = (rng.uniform(-1.0, 1.0), 38.5, rng.uniform(-1.0, 1.0))
    _fan_apex(p, top, apex, pal, "bark_lt")
    # lay it down: proper rotation about Z (+Y -> +X, det=+1), then a roll
    # about the new axis, then sink slightly into the ground
    roll = rng.uniform(0.0, 2.0 * np.pi)
    cr, sr = np.cos(roll), np.sin(roll)
    _transform(p, lambda v: (v[1],
                             (-v[0]) * cr - v[2] * sr + 2.6,
                             (-v[0]) * sr + v[2] * cr))
    return p


def build_stump(pal: Palette, rng: np.random.Generator) -> Part:
    """Low cut/snapped stump, ~11 elmos, jagged top."""
    p = Part("stump")
    top = trunk(p, pal, rng,
                [(0.0, 5.0), (4.0, 4.3), (8.0, 4.0)],
                n=9, swatch="bark_dk")
    apex = (rng.uniform(-1.5, 1.5), 11.0 + rng.uniform(0.0, 2.0),
            rng.uniform(-1.5, 1.5))
    _fan_apex(p, top, apex, pal, "bark_lt")
    return p


def build_standing_stone(pal: Palette, rng: np.random.Generator) -> Part:
    """Weathered monolith, ~32 elmos: tapered pentagonal shaft with a lean."""
    p = Part("standing_stone")
    top = trunk(p, pal, rng,
                [(0.0, 7.2), (9.0, 6.3), (20.0, 5.2), (29.0, 3.6)],
                n=5, swatch="rock", lean=(rng.uniform(-3, 3), rng.uniform(-3, 3)))
    apex = (rng.uniform(-1.0, 1.0), 33.0, rng.uniform(-1.0, 1.0))
    _fan_apex(p, top, apex, pal, "rock_lt")
    return p


def build_ruin_pillar(pal: Palette, rng: np.random.Generator) -> Part:
    """Broken column on a square plinth, ~20 elmos: dressed-stone drums
    snapped at an uneven height."""
    p = Part("ruin_pillar")
    _box(p, pal, -6.2, 6.2, 0.0, 2.6, -6.2, 6.2)          # plinth
    h_break = rng.uniform(14.0, 24.0)
    top = trunk(p, pal, rng,
                [(2.4, 4.4), (8.0, 4.1), (h_break, 3.8)],
                n=10, swatch="rock_lt")
    apex = (rng.uniform(-1.6, 1.6), h_break + rng.uniform(1.5, 3.5),
            rng.uniform(-1.6, 1.6))
    _fan_apex(p, top, apex, pal, "rock")
    return p


def build_ruin_wall(pal: Palette, rng: np.random.Generator) -> Part:
    """Collapsed wall fragment, ~30 elmos long: a run of stone courses with
    a broken, uneven top line and a fallen block at one end."""
    p = Part("ruin_wall")
    x = -15.0
    for _ in range(5):
        w = rng.uniform(4.5, 6.5)
        h = rng.uniform(6.0, 13.0)
        zoff = rng.uniform(-0.5, 0.5)
        _box(p, pal, x, x + w - 0.15, 0.0, h, -1.9 + zoff, 1.9 + zoff)
        x += w
    # toppled block in front of the wall line
    _box(p, pal, rng.uniform(6.0, 10.0), rng.uniform(12.0, 15.0),
         0.0, 2.8, 4.5, 8.2, swatches=("rock", "rock_dk", "rock_dk"))
    return p


def build_log_fence(pal: Palette, rng: np.random.Generator) -> Part:
    """Broken split-rail fence segment, ~18 elmos: two posts, one full rail,
    one snapped half-rail. Placed along roads by the along_paths sampler."""
    p = Part("log_fence")
    for px in (-8.0, 8.0):
        top = trunk(p, pal, rng, [(0.0, 1.15), (6.8, 0.95)], n=5,
                    swatch="bark_dk", lean=(rng.uniform(-0.5, 0.5),
                                            rng.uniform(-0.5, 0.5)))
        _cap(p, top, pal, "bark_lt", down=False)
    _box(p, pal, -9.0, 9.0, 4.6, 5.6, -0.5, 0.5,
         swatches=("bark_lt", "bark", "bark_dk"))
    _box(p, pal, -9.0, rng.uniform(-1.0, 3.0), 2.3, 3.2, -0.5, 0.5,
         swatches=("bark_lt", "bark", "bark_dk"))
    return p


def build_boulder_large(pal: Palette, rng: np.random.Generator) -> Part:
    """Craggy outcrop-scale boulder (~40 elmos tall, ~85 wide): a main
    displaced icosphere plus two shouldered companion rocks, all base-cut to
    Y=0. Placed by the placement.py boulder layers (clusters + lone erratics)."""
    p = Part("boulder_large")

    def rock(centre, radii, amp, lobes, shear):
        unit, faces = icosphere(2)
        disp = _lumpy(unit, rng, amp, lobes=lobes)
        pts = unit * disp[:, None] * np.array(radii)
        pts[:, 2] += shear * np.maximum(pts[:, 1], 0.0)
        cut = -radii[1] * 0.36
        pts[:, 1] = np.maximum(pts[:, 1], cut)
        pts[:, 1] -= cut
        pts += np.array(centre)
        for (a, b, c) in faces:
            tri = [pts[a], pts[b], pts[c]]
            n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
            ln = np.linalg.norm(n)
            if ln < 1e-9:
                continue
            up = (n / ln)[1]
            if up > 0.82:
                sw = "moss"
            elif up > 0.45:
                sw = "rock_lt"
            elif up > -0.10:
                sw = "rock"
            else:
                sw = "rock_dk"
            p.add_face([tuple(v) for v in tri], uvs=pal.uvs(sw, 3))

    rock((0.0, 0.0, 0.0), (34.0, 27.0, 30.0), 0.27, 7, 0.20)
    rock((-27.0, 0.0, 14.0), (16.0, 12.0, 14.0), 0.24, 5, 0.12)
    rock((22.0, 0.0, -19.0), (13.0, 9.5, 12.0), 0.26, 5, -0.15)
    return p


SPECIES = {
    # name -> (builder, seed)   names MUST match the feature defs referenced
    # by terragen placement layers (vegetation.py palettes + placement.py).
    # Each entry has its own seed and its own Palette, so appending to this
    # table cannot perturb an existing model — which is what lets a climate
    # bring new props without moving a shipped map's bytes.
    "tree_conifer":   (build_conifer,  0xC0F1),
    "tree_broadleaf": (build_broadleaf, 0xB2EA),
    "bush_scrub":     (build_bush,     0x5C2B),
    "rock_boulder":   (build_boulder,  0x0B0D),
    "rock_boulder_large": (build_boulder_large, 0xB16B),
    "fallen_log":     (build_fallen_log, 0xF411),
    "tree_stump":     (build_stump,     0x57B9),
    "standing_stone": (build_standing_stone, 0x57A2),
    "ruin_pillar":    (build_ruin_pillar, 0x9111),
    "ruin_wall":      (build_ruin_wall,  0x9A11),
    "log_fence":      (build_log_fence,  0xFE2C),
    # climate-scoped (PLAN-maps M8o) — never referenced by the temperate
    # palette, so `--climate temperate` writes exactly the eleven above
    "dead_snag":      (build_dead_snag,  0xD5A6),
    "cactus_column":  (build_cactus,     0xCAC7),
    "desert_shrub":   (build_desert_shrub, 0xD53B),
    "palm":           (build_palm,       0x9A1E),
}


def species_for_climate(climate: str) -> dict:
    """The subset of SPECIES a map on `climate` actually references.

    A map package should carry the props its placement list names and no
    others: every extra species is ~5 files and a manifest entry the client
    downloads and never draws. `temperate` resolves to the original eleven,
    in the original order, so a regenerated shipped map is byte-identical.
    """
    want = veg.feature_names_for(climate)
    missing = [n for n in want if n not in SPECIES]
    if missing:
        raise SystemExit(
            f"climate {climate!r} references feature defs with no model "
            f"builder: {missing}")
    return {n: SPECIES[n] for n in SPECIES if n in want}


# ── driver ──────────────────────────────────────────────────────────────

def signed_volume(part: Part) -> float:
    """6V of the triangle soup. glTF front faces are CCW, so a closed shell
    with outward normals integrates positive — the cheapest possible catch
    for an inside-out ring/fan winding, which otherwise only shows up as a
    prop that renders hollow under backface culling."""
    p = np.array(part.pos)
    i = np.array(part.idx).reshape(-1, 3)
    a, b, c = p[i[:, 0]], p[i[:, 1]], p[i[:, 2]]
    return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6.0)


def encode_ktx2(png_path: str, ktx_path: str, srgb: bool) -> None:
    subprocess.run(
        ["node", os.path.join(FORGE, "encode_maps.mjs"), ktx_path, png_path,
         "srgb" if srgb else "linear"],
        cwd=FORGE, check=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(
        REPO_ROOT, "content", "maps", "meridian_basin"),
        help="map package root; models land in <out>/objects3d/")
    ap.add_argument("--cell", type=int, default=128,
                    help="impostor atlas cell size in px")
    ap.add_argument("--no-impostors", action="store_true")
    ap.add_argument("--keep-png", action="store_true",
                    help="keep the intermediate PNG sources next to the ktx2")
    ap.add_argument("--climate", default="temperate",
                    choices=sorted(veg.CLIMATE_PALETTES),
                    help="write only the props this climate's vegetation "
                         "palette references (terragen/vegetation.py); "
                         "'temperate' is the original eleven, unchanged")
    ap.add_argument("--selftest", action="store_true",
                    help="build every species, check winding/extents, "
                         "write nothing")
    args = ap.parse_args()

    out_dir = os.path.join(args.out, "objects3d")
    if not args.selftest:
        os.makedirs(out_dir, exist_ok=True)

    # --selftest checks every builder; a real run writes one climate's set
    species = SPECIES if args.selftest else species_for_climate(args.climate)

    for name, (builder, seed) in species.items():
        rng = np.random.default_rng(seed)
        pal = Palette(rng)
        part = builder(pal, rng)
        vol = signed_volume(part)
        mn, mx = part.bounds()
        print(f"[veg] {name}: {part.tri_count()} tris, "
              f"h={mx[1]:.1f} w={mx[0] - mn[0]:.1f} elmos, 6V={vol:.0f}")
        if vol <= 0.0:
            raise SystemExit(f"{name}: inside-out winding (signed volume "
                             f"{vol:.1f} <= 0)")
        if args.selftest:
            continue
        pieces = [dict(name=part.name, parent=-1, offset=(0.0, 0.0, 0.0),
                       part=part)]
        # units='elmo': vegetation authors directly on the engine's scale
        # (1 unit = 1 elmo) — the metre→elmo world-scale conversion
        # (gltf_export.ELMOS_PER_METRE) must NOT apply here.
        gltf_export.export(pieces, name, texmode="ktx2", outdir=out_dir,
                           texture_maps=("diffuse", "orm"), units="elmo")

        # Textures: one atlas per species (identical content, but each glTF
        # references its own stem — the forge convention, and it keeps a
        # species editable in isolation).
        dif, orm = paint_atlas(np.random.default_rng(seed ^ 0x5EED))
        dif_png = os.path.join(out_dir, f"{name}_diffuse.png")
        orm_png = os.path.join(out_dir, f"{name}_orm.png")
        dif.save(dif_png)
        orm.save(orm_png)
        encode_ktx2(dif_png, os.path.join(out_dir, f"{name}_diffuse.ktx2"), True)
        encode_ktx2(orm_png, os.path.join(out_dir, f"{name}_orm.ktx2"), False)

        if not args.no_impostors:
            png = bake_impostors.bake(
                os.path.join(out_dir, f"{name}.gltf"), diffuse_png=dif_png,
                out_dir=out_dir, cell=args.cell)
            encode_ktx2(png, os.path.join(out_dir, f"{name}_impostor.ktx2"),
                        True)
            if not args.keep_png:
                os.remove(png)

        if not args.keep_png:
            os.remove(dif_png)
            os.remove(orm_png)

    if args.selftest:
        print(f"[veg] selftest OK ({len(species)} species)")
        return

    if not args.no_impostors:
        # One manifest for the whole package: the client resolves a feature
        # type's atlas from this in a single request, and it carries each
        # species' own swap distance (a 20-elmo fence post has no business
        # staying a full mesh as far out as a 137-elmo conifer).
        bake_impostors.write_manifest(out_dir, list(species))
        # ...and immediately check it back against the models and the pixels
        # just baked. write_manifest() hand-picks the fields it copies out of
        # each sidecar, which is exactly how `azimuthPhaseDegrees` once went
        # missing; `centreY` going the same way would silently hover every
        # prop rather than raising anything. Cheap, and it fails the run.
        if not bake_impostors.verify_manifest(out_dir):
            raise SystemExit("[veg] impostors.json does not describe the "
                             "atlases that were just baked")
    print(f"[veg] wrote {len(species)} species ({args.climate}) -> {out_dir}")


if __name__ == "__main__":
    main()
