"""bake_impostors — 8-yaw x 3-pitch impostor atlas baker for forge models.

Renders a forge-emitted `.gltf` (+ sibling `.bin` and `_diffuse.png`) from
the RTS camera's arc and packs the frames into one atlas PNG:

    <stem>_impostor.png     cols = yaw  (8, CCW from +Z), rows = pitch (3)
    <stem>_impostor.json    quad size + cell layout for the client LOD tier

Layout is the v2 convention owned by `client/src/core/impostor-atlas.ts`
(`AtlasLayout`), and the emitted `_impostor.json` uses its field names so the
runtime can read the manifest verbatim:

  - column = camera azimuth relative to the instance, matching the runtime's
    `atan2(toCamX, toCamZ) - heading` — so column 0 is the camera sitting at
    the instance's +Z, and column yawBins/4 at its +X;
  - row 0 is the TOP row of the image and the LOWEST elevation, ascending
    downward (`selectPitchRow` orders bin centres the same way);
  - `frames` is 1 — static props have no walk cycle, so the rows buy vertical
    parallax across the RTS zoom range instead of animation.

The rasterizer is pure Python/numpy (orthographic, z-buffered, 3x
supersampled, flat per-face shading sampled from the diffuse atlas), so the
forge keeps its "no GPU, no external binaries" property. Alpha is the
coverage mask; the client alpha-tests at ~0.4.

Usage:
    python3 bake_impostors.py out/tree_conifer.gltf [--cell 128] [--out DIR]
                              [--diffuse PATH]
then encode `<stem>_impostor.png` -> `.ktx2` (encode_sprites.mjs, or
tools/textureconverter --encoding uastc).
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
from PIL import Image

# Camera arc: 8 yaws x 3 pitches. Pitches are degrees above the horizon,
# chosen to bracket the playable camera range (near-ground chase, default
# RTS tilt, strategic top-down).
YAWS = 8
PITCHES = (18.0, 42.0, 68.0)
SUPERSAMPLE = 3
# Key/fill so the baked frames read like the lit model rather than a flat
# cutout. Direction is in world space (sun from the upper front-left, the
# same convention docs/lighting.md uses for the default map sun).
SUN_DIR = np.array([-0.42, 0.80, 0.43])
SUN_DIR = SUN_DIR / np.linalg.norm(SUN_DIR)
AMBIENT = 0.42


# ── glTF reading ────────────────────────────────────────────────────────

_COMP = {5126: ('<f4', 4), 5125: ('<u4', 4), 5123: ('<u2', 2)}
_NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def _accessor(gltf, blob, idx):
    acc = gltf['accessors'][idx]
    view = gltf['bufferViews'][acc['bufferView']]
    dt, sz = _COMP[acc['componentType']]
    n = _NCOMP[acc['type']]
    off = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count'] * n
    arr = np.frombuffer(blob, dtype=np.dtype(dt), count=count, offset=off)
    return arr.reshape(acc['count'], n) if n > 1 else arr


def load_model(gltf_path: str):
    """Flatten a forge .gltf into (positions, normals, uvs, indices) in
    world space. Node translations are applied (forge models use TRS with
    translation-only rests); scale/rotation on a rest node would need the
    full matrix walk, which no forge model uses."""
    with open(gltf_path) as f:
        gltf = json.load(f)
    base = os.path.dirname(os.path.abspath(gltf_path))
    blob = open(os.path.join(base, gltf['buffers'][0]['uri']), 'rb').read()

    # node index -> accumulated world translation
    parent = {}
    for i, nd in enumerate(gltf['nodes']):
        for c in nd.get('children', []):
            parent[c] = i

    def world_t(i):
        t = np.zeros(3)
        while True:
            t = t + np.asarray(gltf['nodes'][i].get('translation', [0, 0, 0]),
                               dtype=float)
            if i not in parent:
                return t
            i = parent[i]

    P, N, T, I = [], [], [], []
    for i, nd in enumerate(gltf['nodes']):
        if 'mesh' not in nd:
            continue
        off = world_t(i)
        for prim in gltf['meshes'][nd['mesh']]['primitives']:
            a = prim['attributes']
            pos = _accessor(gltf, blob, a['POSITION']).astype(np.float64) + off
            nrm = _accessor(gltf, blob, a['NORMAL']).astype(np.float64)
            uv = (_accessor(gltf, blob, a['TEXCOORD_0']).astype(np.float64)
                  if 'TEXCOORD_0' in a else np.zeros((len(pos), 2)))
            idx = _accessor(gltf, blob, prim['indices']).astype(np.int64)
            I.append(idx.reshape(-1, 3) + sum(len(p) for p in P))
            P.append(pos)
            N.append(nrm)
            T.append(uv)
    return (np.concatenate(P), np.concatenate(N),
            np.concatenate(T), np.concatenate(I))


# ── rasterizer ──────────────────────────────────────────────────────────

def _face_colors(pos, nrm, uv, idx, tex: np.ndarray) -> np.ndarray:
    """Flat lit colour per triangle: diffuse texel at the UV centroid,
    modulated by a fixed key light. Returns (F, 3) float in [0, 255]."""
    h, w = tex.shape[:2]
    cuv = uv[idx].mean(axis=1)
    tx = np.clip((cuv[:, 0] * w).astype(np.int64), 0, w - 1)
    ty = np.clip((cuv[:, 1] * h).astype(np.int64), 0, h - 1)
    base = tex[ty, tx, :3].astype(np.float64)
    fn = nrm[idx].mean(axis=1)
    ln = np.linalg.norm(fn, axis=1, keepdims=True)
    fn = np.where(ln > 1e-9, fn / np.maximum(ln, 1e-9), fn)
    lam = np.clip(fn @ SUN_DIR, 0.0, 1.0)
    return np.clip(base * (AMBIENT + (1.0 - AMBIENT) * lam)[:, None], 0, 255)


def _render_cell(pos, idx, fcol, right, up, fwd, centre, half, res):
    """Orthographic z-buffered render of one cell. `half` is the half-extent
    of the framed square in world units. Returns (rgb uint8, alpha uint8)."""
    rel = pos - centre
    sx = (rel @ right) / half            # [-1, 1]
    sy = (rel @ up) / half
    sz = rel @ fwd                       # depth, larger = further from cam
    px = (sx * 0.5 + 0.5) * res
    py = (0.5 - sy * 0.5) * res

    rgb = np.zeros((res, res, 3), dtype=np.float64)
    depth = np.full((res, res), np.inf)

    tri_px = px[idx]
    tri_py = py[idx]
    tri_z = sz[idx]
    # Back-face reject in screen space (CCW front faces after projection).
    area = ((tri_px[:, 1] - tri_px[:, 0]) * (tri_py[:, 2] - tri_py[:, 0])
            - (tri_px[:, 2] - tri_px[:, 0]) * (tri_py[:, 1] - tri_py[:, 0]))
    keep = area < -1e-9        # screen Y is flipped, so front faces are < 0

    for t in np.nonzero(keep)[0]:
        x0, x1, x2 = tri_px[t]
        y0, y1, y2 = tri_py[t]
        lo_x = max(int(np.floor(min(x0, x1, x2))), 0)
        hi_x = min(int(np.ceil(max(x0, x1, x2))) + 1, res)
        lo_y = max(int(np.floor(min(y0, y1, y2))), 0)
        hi_y = min(int(np.ceil(max(y0, y1, y2))) + 1, res)
        if lo_x >= hi_x or lo_y >= hi_y:
            continue
        xs = np.arange(lo_x, hi_x) + 0.5
        ys = np.arange(lo_y, hi_y) + 0.5
        gx, gy = np.meshgrid(xs, ys)
        d = area[t]
        w0 = ((x1 - gx) * (y2 - gy) - (x2 - gx) * (y1 - gy)) / d
        w1 = ((x2 - gx) * (y0 - gy) - (x0 - gx) * (y2 - gy)) / d
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        z = w0 * tri_z[t, 0] + w1 * tri_z[t, 1] + w2 * tri_z[t, 2]
        sub = depth[lo_y:hi_y, lo_x:hi_x]
        win = inside & (z < sub)
        if not win.any():
            continue
        sub[win] = z[win]
        rgb[lo_y:hi_y, lo_x:hi_x][win] = fcol[t]

    alpha = np.where(np.isfinite(depth), 255.0, 0.0)
    return rgb, alpha


def bake(gltf_path: str, diffuse_png: str | None = None,
         out_dir: str | None = None, cell: int = 128) -> str:
    stem = os.path.splitext(os.path.basename(gltf_path))[0]
    base = os.path.dirname(os.path.abspath(gltf_path))
    out_dir = out_dir or base
    diffuse_png = diffuse_png or os.path.join(base, f'{stem}_diffuse.png')

    pos, nrm, uv, idx = load_model(gltf_path)
    tex = np.asarray(Image.open(diffuse_png).convert('RGB'))
    fcol = _face_colors(pos, nrm, uv, idx, tex)

    mins, maxs = pos.min(axis=0), pos.max(axis=0)
    centre = np.array([(mins[0] + maxs[0]) / 2, (mins[1] + maxs[1]) / 2,
                       (mins[2] + maxs[2]) / 2])
    # One framing for every cell so the quad size is a single constant the
    # renderer can scale by: the bounding sphere, plus 2% breathing room.
    half = float(np.linalg.norm(maxs - centre)) * 1.02

    res = cell * SUPERSAMPLE
    atlas = Image.new('RGBA', (YAWS * cell, len(PITCHES) * cell), (0, 0, 0, 0))
    for r, pitch in enumerate(PITCHES):
        cp, sp = np.cos(np.radians(pitch)), np.sin(np.radians(pitch))
        for c in range(YAWS):
            yaw = 2 * np.pi * c / YAWS
            # Camera sits along +fwd_back from the model, looking down -it.
            fwd = np.array([-np.sin(yaw) * cp, -sp, -np.cos(yaw) * cp])
            right = np.cross(fwd, np.array([0.0, 1.0, 0.0]))
            right /= np.linalg.norm(right)
            up = np.cross(right, fwd)
            rgb, alpha = _render_cell(pos, idx, fcol, right, up, fwd,
                                      centre, half, res)
            img = Image.fromarray(
                np.dstack([rgb, alpha]).astype(np.uint8), 'RGBA')
            atlas.paste(img.resize((cell, cell), Image.LANCZOS),
                        (c * cell, r * cell))

    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, f'{stem}_impostor.png')
    atlas.save(png)
    # Field names match client/src/core/impostor-atlas.ts `AtlasLayout` so the
    # runtime can consume this manifest verbatim (normalizeAtlasLayout).
    meta = dict(yawBins=YAWS, pitchBins=len(PITCHES), frames=1,
                pitchDegrees=list(PITCHES), cell=cell,
                # Quad the client should draw, in world units. The frame is
                # square and centred on the model's bounding-sphere centre,
                # which sits `centreY` above the model origin (ground).
                width=2 * half, height=2 * half,
                centreY=float(centre[1]))
    with open(os.path.join(out_dir, f'{stem}_impostor.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    print(f'[impostor] {stem}_impostor.png {YAWS}x{len(PITCHES)} cells '
          f'@{cell}px, quad {2 * half:.1f} elmos')
    return png


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('gltf')
    ap.add_argument('--diffuse', default=None)
    ap.add_argument('--out', default=None)
    ap.add_argument('--cell', type=int, default=128)
    a = ap.parse_args()
    bake(a.gltf, a.diffuse, a.out, a.cell)
