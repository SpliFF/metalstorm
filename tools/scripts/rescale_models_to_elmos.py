#!/usr/bin/env python3
"""rescale_models_to_elmos.py — one-shot metre→elmo re-import of a glTF model.

World-scale contract (PLAN-world-scale.md §5, Option A, USER-DECIDED
2026-08-27): **8 elmos = 1 metre**. The metalstorm unit/building corpus was
authored at 1 glTF unit = 1 metre (DESIGN-MODEL-BUILDING.md §4) while the sim
consumes `SPRINGRTS_geometry` extents as elmos, so every native model rendered
and collided at 1/8 size. This tool applies the ×8 conversion to a shipped
`.gltf`+`.bin` pair in place, exactly as if the model had been re-imported
with the scale applied at the write site:

  * every POSITION accessor (incl. morph targets), with exact float32 bounds
  * every node `translation` (and the translation column of a `matrix` node)
  * every animation channel targeting `translation`
  * every skin `inverseBindMatrices` translation column
  * every linear quantity in `extensions.SPRINGRTS_geometry`:
    radius, height, midpos, mins, maxs, piece offset/mins/maxs,
    pieceOverrides (piece `rot` matrices are pure rotation — untouched)

Rotations, scales, normals, UVs and times are dimensionless — untouched.
The factor 8 is a power of two, so the float32 rescale is *exact* (mantissas
unchanged, exponents +3): the operation is lossless and bit-reversible.

After scaling, `SPRINGRTS_geometry.units = "elmos"` is stamped (an additive
field — older readers ignore it, see GeometryExtractor.h). A file already
stamped is skipped, making the tool idempotent: running it twice can never
×64 a model. Map-feature models (content/maps/*/objects3d) are authored in
elmos from the start and must NEVER be run through this tool.

The same constant lives in:
  * tools/modelimporter/GeometryExtractor.h   (kElmosPerMetre, C++ import path)
  * tools/fable-model-forge/gltf_export.py    (ELMOS_PER_METRE, forge writer)

Usage:
    python3 tools/scripts/rescale_models_to_elmos.py <model.gltf> [...]
    python3 tools/scripts/rescale_models_to_elmos.py --dir data/games/metalstorm/models
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import struct
import sys

# 8 elmos = 1 metre — THE world-scale constant (see module docstring).
ELMOS_PER_METRE = 8.0


def _round5(v: float) -> float:
    """Match the writers' 5-significant-ish rounding without introducing
    float-repr noise. ×8 of a short decimal is exact in decimal, so a plain
    round() to 5 decimals keeps the JSON tidy."""
    return round(v, 5)


def _scale_vec(v, s):
    return [_round5(float(x) * s) for x in v]


def rescale_gltf(gltf_path: str, scale: float = ELMOS_PER_METRE,
                 dry_run: bool = False) -> str:
    """Scale one .gltf (+ sidecar .bin) by `scale`. Returns a status string:
    'scaled', 'skipped (already elmos)'. Raises on structural surprises."""
    with open(gltf_path) as f:
        doc = json.load(f)

    ext = doc.get('extensions', {}).get('SPRINGRTS_geometry')
    if ext is None:
        raise ValueError(f'{gltf_path}: no SPRINGRTS_geometry extension')
    if ext.get('units') == 'elmos':
        return 'skipped (already elmos)'

    # ---- load buffers (external .bin sidecars only — no data: URIs here) ----
    buffers = []
    for b in doc.get('buffers', []):
        uri = b.get('uri')
        if uri is None or uri.startswith('data:'):
            raise ValueError(f'{gltf_path}: only external-.bin buffers supported')
        bin_path = os.path.join(os.path.dirname(gltf_path), uri)
        with open(bin_path, 'rb') as bf:
            buffers.append({'path': bin_path, 'data': bytearray(bf.read())})

    accessors = doc.get('accessors', [])
    views = doc.get('bufferViews', [])

    def scale_accessor_f32(idx: int, components: slice):
        """Scale `components` (a slice over the element's floats) of every
        element of float32 accessor `idx`, in place in its buffer."""
        acc = accessors[idx]
        if acc.get('componentType') != 5126:
            raise ValueError(f'{gltf_path}: accessor {idx} not float32')
        if 'sparse' in acc:
            raise ValueError(f'{gltf_path}: sparse accessor {idx} unsupported')
        ncomp = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4,
                 'MAT4': 16}[acc['type']]
        view = views[acc['bufferView']]
        buf = buffers[view.get('buffer', 0)]['data']
        base = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
        stride = view.get('byteStride') or ncomp * 4
        comp_idx = range(*components.indices(ncomp))
        for i in range(acc['count']):
            off = base + i * stride
            for c in comp_idx:
                o = off + c * 4
                (val,) = struct.unpack_from('<f', buf, o)
                struct.pack_into('<f', buf, o, val * scale)
        # exact float32 bounds for fully-scaled vector accessors
        if 'min' in acc and components == slice(None):
            acc['min'] = [float(struct.unpack('<f', struct.pack('<f', float(v) * scale))[0])
                          for v in acc['min']]
            acc['max'] = [float(struct.unpack('<f', struct.pack('<f', float(v) * scale))[0])
                          for v in acc['max']]

    scaled_accessors = set()

    def scale_once(idx: int, components=slice(None)):
        if idx in scaled_accessors:
            return
        scaled_accessors.add(idx)
        scale_accessor_f32(idx, components)

    # ---- mesh POSITION attributes (+ morph targets) ----
    for mesh in doc.get('meshes', []):
        for prim in mesh.get('primitives', []):
            pos = prim.get('attributes', {}).get('POSITION')
            if pos is not None:
                scale_once(pos)
            for target in prim.get('targets', []):
                tpos = target.get('POSITION')
                if tpos is not None:
                    scale_once(tpos)

    # ---- node TRS / matrix translations ----
    for node in doc.get('nodes', []):
        if 'translation' in node:
            node['translation'] = [float(x) * scale for x in node['translation']]
        if 'matrix' in node:
            m = node['matrix']  # column-major; translation = m[12..14]
            for k in (12, 13, 14):
                m[k] = float(m[k]) * scale

    # ---- animation translation channels ----
    for anim in doc.get('animations', []):
        samplers = anim.get('samplers', [])
        for ch in anim.get('channels', []):
            if ch.get('target', {}).get('path') == 'translation':
                out = samplers[ch['sampler']]['output']
                scale_once(out)

    # ---- skins: inverseBindMatrices translation column ----
    for skin in doc.get('skins', []):
        ibm = skin.get('inverseBindMatrices')
        if ibm is not None:
            scale_once(ibm, components=slice(12, 15))

    # ---- SPRINGRTS_geometry ----
    ext['radius'] = _round5(float(ext['radius']) * scale)
    ext['height'] = _round5(float(ext['height']) * scale)
    for key in ('midpos', 'mins', 'maxs'):
        if key in ext:
            ext[key] = _scale_vec(ext[key], scale)
    for piece in ext.get('pieces', []):
        for key in ('offset', 'mins', 'maxs'):
            if key in piece:
                piece[key] = _scale_vec(piece[key], scale)
        # 'rot' is a pure rotation matrix — dimensionless, untouched.
    for name, off in ext.get('pieceOverrides', {}).items():
        ext['pieceOverrides'][name] = _scale_vec(off, scale)
    ext['units'] = 'elmos'

    if dry_run:
        return 'would scale'

    for b in buffers:
        with open(b['path'], 'wb') as bf:
            bf.write(bytes(b['data']))
    with open(gltf_path, 'w') as f:
        json.dump(doc, f, indent=1)
    return 'scaled'


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('models', nargs='*', help='.gltf files to rescale')
    ap.add_argument('--dir', help='rescale every .gltf under this directory')
    ap.add_argument('--scale', type=float, default=ELMOS_PER_METRE,
                    help='override the factor (default: %(default)s — the '
                         '8 elmos = 1 m contract)')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args(argv)

    paths = list(args.models)
    if args.dir:
        paths += sorted(glob.glob(os.path.join(args.dir, '*.gltf')))
    if not paths:
        ap.error('nothing to do — pass .gltf paths or --dir')

    n_scaled = n_skipped = 0
    for p in paths:
        status = rescale_gltf(p, args.scale, args.dry_run)
        if status.startswith('skipped'):
            n_skipped += 1
        else:
            n_scaled += 1
        print(f'{p}: {status}')
    print(f'-- {n_scaled} scaled, {n_skipped} skipped')
    return 0


if __name__ == '__main__':
    sys.exit(main())
