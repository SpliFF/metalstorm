#!/usr/bin/env python3
"""check_model_scale.py — world-scale contract checker (8 elmos = 1 metre).

Asserts the repo's model corpus honours the Option A world-scale decision
(PLAN-world-scale.md §5, USER-DECIDED 2026-08-27; DESIGN-MODEL-BUILDING.md
§4/§12):

  1. UNITS ×8   — every metalstorm unit/building model under
     data/games/metalstorm/models/ carries `SPRINGRTS_geometry.units =
     "elmos"` and its radius/height equal exactly 8× the pre-scale metre
     baseline recorded in world_scale_baseline.json.
  2. FEATURES ×1 — every map-feature model under content/maps/*/objects3d/
     is UNCHANGED against the same baseline (they were always elmos; a
     blanket scale over them is a defect).
  3. GEOMETRY⇄METADATA — for every unit model, the world-space AABB
     recomputed from the actual .bin POSITION data (through the node
     hierarchy) matches the extension's mins/maxs: the mesh and the sim
     metadata were scaled TOGETHER, not just the JSON.
  4. IMPOSTOR RULE — the four infantry impostor defs satisfy the impostor
     lane's numeric rules at the new scale:
       - swap rule: the model is ≲20 px tall at impostor_distance under the
         reference camera (vertical fov 0.8 rad — Babylon's default, which
         rts-camera.ts never overrides — on a 1080 px viewport), and not
         under 4 px (a swap so late the model tier never earns its cost);
       - framing constant: (model bbox-centre Y − impostor_centre_y) /
         impostor_size stays at the measured 0.0655 ± 0.01 — _builder.lua's
         "one framing constant, not four" (scale-invariant: every term is a
         length, PLAN-metalstorm-impostors M11 fire 2);
       - quad sanity: impostor_size / model height within [1.2, 1.35] (the
         band the four shipped sheets were framed at).

Exit 0 all-green, 1 with a FAIL list otherwise. Run from the repo root:
    python3 tools/scripts/check_model_scale.py
"""
from __future__ import annotations

import glob
import json
import math
import os
import re
import struct
import sys

ELMOS_PER_METRE = 8.0

# Reference camera for the swap-pixel rule (see module docstring).
REF_FOV_RAD = 0.8
REF_VIEWPORT_PX = 1080
SWAP_MAX_PX = 20.0
SWAP_MIN_PX = 4.0
FRAMING_CONST = 0.0655
FRAMING_TOL = 0.01
QUAD_RATIO_BAND = (1.2, 1.35)

HERE = os.path.dirname(os.path.abspath(__file__))
BASELINE = os.path.join(HERE, 'world_scale_baseline.json')

fails: list[str] = []
checks = 0


def check(ok: bool, msg: str):
    global checks
    checks += 1
    if not ok:
        fails.append(msg)


def rel_eq(a: float, b: float, rel=1e-4, abs_tol=1e-3) -> bool:
    return abs(a - b) <= max(abs_tol, rel * max(abs(a), abs(b)))


# ---------------------------------------------------------------- gltf math
def _node_local(node):
    """4x4 row-major local transform of a glTF node (TRS or matrix)."""
    if 'matrix' in node:
        m = node['matrix']  # column-major
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = node.get('translation', [0, 0, 0])
    q = node.get('rotation', [0, 0, 0, 1])
    s = node.get('scale', [1, 1, 1])
    x, y, z, w = q
    rot = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    m = [[rot[r][c] * s[c] for c in range(3)] + [t[r]] for r in range(3)]
    m.append([0.0, 0.0, 0.0, 1.0])
    return m


def _mat_mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)]
            for r in range(4)]


def _xform(m, p):
    return [m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3]
            for r in range(3)]


def world_aabb_from_bin(gltf_path, doc):
    """World-space AABB over every mesh-instance POSITION in the scene."""
    bin_cache = {}

    def buffer_data(i):
        if i not in bin_cache:
            uri = doc['buffers'][i]['uri']
            with open(os.path.join(os.path.dirname(gltf_path), uri), 'rb') as f:
                bin_cache[i] = f.read()
        return bin_cache[i]

    lo = [math.inf] * 3
    hi = [-math.inf] * 3

    def visit(node_idx, parent_m):
        node = doc['nodes'][node_idx]
        m = _mat_mul(parent_m, _node_local(node))
        if 'mesh' in node:
            mesh = doc['meshes'][node['mesh']]
            for prim in mesh.get('primitives', []):
                pos = prim.get('attributes', {}).get('POSITION')
                if pos is None:
                    continue
                acc = doc['accessors'][pos]
                view = doc['bufferViews'][acc['bufferView']]
                data = buffer_data(view.get('buffer', 0))
                base = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
                stride = view.get('byteStride') or 12
                for i in range(acc['count']):
                    off = base + i * stride
                    p = struct.unpack_from('<3f', data, off)
                    wp = _xform(m, p)
                    for k in range(3):
                        lo[k] = min(lo[k], wp[k])
                        hi[k] = max(hi[k], wp[k])
        for c in node.get('children', []):
            visit(c, m)

    ident = [[1.0 if r == c else 0.0 for c in range(4)] for r in range(4)]
    scene = doc['scenes'][doc.get('scene', 0)]
    for n in scene['nodes']:
        visit(n, ident)
    return lo, hi


# ------------------------------------------------------------------ 1 + 2
with open(BASELINE) as f:
    baseline = json.load(f)

unit_glob = sorted(glob.glob('data/games/metalstorm/models/*.gltf'))
check(len(unit_glob) >= len(baseline['units']),
      f'unit corpus shrank: {len(unit_glob)} on disk < '
      f'{len(baseline["units"])} in baseline')

docs = {}
for p in unit_glob:
    name = os.path.basename(p)
    with open(p) as f:
        doc = json.load(f)
    docs[p] = doc
    ext = doc.get('extensions', {}).get('SPRINGRTS_geometry', {})
    check(ext.get('units') == 'elmos',
          f'{name}: units marker is {ext.get("units")!r}, want "elmos"')
    base = baseline['units'].get(name)
    if base is None:
        continue  # model added after the baseline — marker check above applies
    for key in ('radius', 'height'):
        want = base[key] * ELMOS_PER_METRE
        got = float(ext.get(key, float('nan')))
        check(rel_eq(got, want),
              f'{name}: {key} {got} != baseline×8 {want}')

for p, base in baseline['map_features'].items():
    if not os.path.exists(p):
        check(False, f'{p}: map-feature model in baseline is missing')
        continue
    with open(p) as f:
        ext = json.load(f).get('extensions', {}).get('SPRINGRTS_geometry', {})
    for key in ('radius', 'height'):
        got = float(ext.get(key, float('nan')))
        check(rel_eq(got, base[key]),
              f'{p}: {key} {got} changed from baseline {base[key]} '
              f'(map features are already elmos — must be ×1)')

# ---------------------------------------------------------------------- 3
for p, doc in docs.items():
    name = os.path.basename(p)
    ext = doc['extensions']['SPRINGRTS_geometry']
    lo, hi = world_aabb_from_bin(p, doc)
    # The extension may carry authored overrides (sidecar radius etc.), so
    # compare the AABB corners with a loose band: the point is to prove the
    # VERTEX DATA scaled with the metadata, i.e. they agree to ~2 % + 1 elmo,
    # not 8× apart.
    for axis in range(3):
        for got, want, tag in ((lo[axis], ext['mins'][axis], 'mins'),
                               (hi[axis], ext['maxs'][axis], 'maxs')):
            span = max(1.0, abs(hi[axis] - lo[axis]))
            check(abs(got - want) <= max(1.0, 0.02 * span),
                  f'{name}: bin-derived {tag}[{axis}] {got:.3f} vs '
                  f'extension {want} — mesh and metadata disagree')

# ---------------------------------------------------------------------- 4
IMPOSTOR_DEFS = {
    # def file: (model gltf, style) — style 'spec' = impostorSize=1.0 numbers,
    # 'params' = customparams impostor_size='1.0' strings.
    'data/games/metalstorm/units/soldiers.lua':
        [('ms_soldiers_s1', 'spec')],
    'data/games/metalstorm/units/engineers.lua':
        [('ms_engineers_s1', 'spec')],
    'data/games/metalstorm/units/civilians.lua':
        [('ms_civilians', 'params'), ('ms_militia', 'params')],
}


def lua_impostor_numbers(text, style):
    if style == 'spec':
        pat = {
            'distance': r'impostorDistance\s*=\s*([\d.]+)',
            'size': r'impostorSize\s*=\s*([\d.]+)',
            'centre_y': r'impostorCentreY\s*=\s*([\d.]+)',
        }
    else:
        pat = {
            'distance': r"impostor_distance\s*=\s*'([\d.]+)'",
            'size': r"impostor_size\s*=\s*'([\d.]+)'",
            'centre_y': r"impostor_centre_y\s*=\s*'([\d.]+)'",
        }
    out = {}
    for key, rx in pat.items():
        m = re.search(rx, text)
        out[key] = float(m.group(1)) if m else None
    return out


for lua_path, entries in IMPOSTOR_DEFS.items():
    with open(lua_path) as f:
        text = f.read()
    for stem, style in entries:
        if style == 'params':
            # narrow to this def's block
            m = re.search(stem + r'\s*=\s*\{', text)
            block = text[m.start():] if m else text
            nxt = re.search(r'\n    \w+\s*=\s*\{', block[1:])
            if nxt:
                block = block[:nxt.start() + 1]
        else:
            block = text
        nums = lua_impostor_numbers(block, style)
        model = f'data/games/metalstorm/models/{stem}.gltf'
        with open(model) as f:
            height = float(json.load(f)['extensions']['SPRINGRTS_geometry']['height'])
        for key in ('distance', 'size', 'centre_y'):
            check(nums[key] is not None, f'{lua_path}:{stem}: no impostor {key}')
        if None in nums.values():
            continue
        px = height * REF_VIEWPORT_PX / (
            2.0 * nums['distance'] * math.tan(REF_FOV_RAD / 2.0))
        check(SWAP_MIN_PX <= px <= SWAP_MAX_PX,
              f'{stem}: model is {px:.1f} px tall at impostor_distance '
              f'{nums["distance"]} — outside [{SWAP_MIN_PX}, {SWAP_MAX_PX}] px '
              f'swap band')
        framing = (height / 2.0 - nums['centre_y']) / nums['size']
        check(abs(framing - FRAMING_CONST) <= FRAMING_TOL,
              f'{stem}: (height/2 - centre_y)/size {framing:.4f} drifted from '
              f'the measured framing constant {FRAMING_CONST}±{FRAMING_TOL}')
        ratio = nums['size'] / height
        check(QUAD_RATIO_BAND[0] <= ratio <= QUAD_RATIO_BAND[1],
              f'{stem}: impostor_size/model-height {ratio:.3f} outside '
              f'{QUAD_RATIO_BAND}')

# -------------------------------------------------------------------- done
if fails:
    print(f'check_model_scale: {len(fails)} FAIL / {checks} checks')
    for msg in fails:
        print('  FAIL:', msg)
    sys.exit(1)
print(f'check_model_scale: all {checks} checks passed '
      f'({len(docs)} unit models ×8, {len(baseline["map_features"])} '
      f'map features ×1, impostor rules OK)')
