#!/usr/bin/env python3
"""gen_vegetation_models — procedural map-feature models (PLAN-maps.md M6).

Builds the four vegetation/rock props terragen's scatter places
(`terragen/vegetation.py` TEMPERATE_SPECIES — the def names MUST match):

    tree_conifer    stacked skirt cones on a tapered trunk
    tree_broadleaf  bent trunk + displaced icosphere canopy cluster
    bush_scrub      low displaced-icosphere cluster
    rock_boulder    displaced icosphere with a flattened base

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


def blob(part: Part, pal: Palette, rng: np.random.Generator, centre,
         radii, subdiv: int, amp: float, swatches, floor: float | None = None):
    """Displaced ellipsoid. `swatches` is (lit, mid, shadow) — the facet's
    own normal picks which, so the palette does the tonal work the flat
    normals alone can't. `floor`, if given, clamps world Y (flat base)."""
    unit, faces = icosphere(subdiv)
    disp = _lumpy(unit, rng, amp)
    pts = unit * disp[:, None] * np.asarray(radii) + np.asarray(centre)
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
          n: int, swatch: str, lean=(0.0, 0.0)):
    """Tapered n-gon trunk. `stations` = [(y, radius), ...] bottom-up;
    `lean` is the total (x, z) offset applied at the top, eased in so the
    base stays planted."""
    rings = []
    ymin, ymax = stations[0][0], stations[-1][0]
    for (y, r) in stations:
        t = (y - ymin) / max(ymax - ymin, 1e-6)
        wob = 1.0 + rng.uniform(-0.09, 0.09, n)
        c = (lean[0] * t * t, y, lean[1] * t * t)
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


SPECIES = {
    # name -> (builder, seed)   names MUST match terragen/vegetation.py
    "tree_conifer":   (build_conifer,  0xC0F1),
    "tree_broadleaf": (build_broadleaf, 0xB2EA),
    "bush_scrub":     (build_bush,     0x5C2B),
    "rock_boulder":   (build_boulder,  0x0B0D),
}


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
    ap.add_argument("--selftest", action="store_true",
                    help="build every species, check winding/extents, "
                         "write nothing")
    args = ap.parse_args()

    out_dir = os.path.join(args.out, "objects3d")
    if not args.selftest:
        os.makedirs(out_dir, exist_ok=True)

    for name, (builder, seed) in SPECIES.items():
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
        gltf_export.export(pieces, name, texmode="ktx2", outdir=out_dir,
                           texture_maps=("diffuse", "orm"))

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
        print(f"[veg] selftest OK ({len(SPECIES)} species)")
    else:
        print(f"[veg] wrote {len(SPECIES)} species -> {out_dir}")


if __name__ == "__main__":
    main()
