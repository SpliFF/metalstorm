"""bake_impostors — bake the v2 directional impostor atlases FROM the
generated 3D infantry models (PLAN-metalstorm-impostors.md M2).

The 3D model is the source of truth; the impostor is rendered off it so the
two can never diverge. This is a pure-Python orthographic software
rasterizer over the meshlib geometry the forge already owns (the plan's
first-listed option: "render from meshlib geometry directly … it must
consume the generated model data, not redrawn art") — no browser, no server,
fully deterministic. Diffuse / emissive / team colour are sampled from the
SAME painted atlas the 3D body ships with (paint_infantry.py), so material
parity with the close-range model is automatic.

For each infantry def it renders YAW_BINS × PITCH_BINS views (8 × 3, see
impostor_convention.py) into one atlas and writes, to out/ (same stems the
hand-authored sprites used, so delivery plumbing is untouched):

    <stem>_impostor.png        RGBA diffuse+alpha  (2048 × 768)
    <stem>_impostor_team.png   R8 team mask        (team defs only)
    <stem>_impostor.json       atlas metadata (for M3's serializer plumbing)

and a golden contact sheet + yaw strip under preview/impostor_strips/ for QA.

Lighting is a stable per-view camera-relative key (upper-left of the camera)
so every column reads its facets identically — a directional impostor's
whole value is legibility from any angle, and world-fixed sun on impostors
is deferred fidelity work (the LOD swap happens at ≲20 px where shading
direction is imperceptible). This is a deliberate, documented choice, not a
silent substitute for the plan's "flat lighting matching the forge's facet
shading" — it IS that flat facet shading, keyed to the camera.

Usage:  python3 bake_impostors.py      (then: node encode_sprites.mjs)
"""
from __future__ import annotations
import json
import os
import numpy as np
from PIL import Image

import infantry_layout            # sets meshlib.ATLAS = 512 on import
import paint_infantry             # the shared flat-swatch texture painter
from gen_infantry import MODELS   # {stem: (build_fn, team_bool)}
import impostor_convention as C

OUT = 'out'
STRIPS = 'preview/impostor_strips'
SS = 4                            # supersample factor, box-downscaled to CELL
MARGIN = 14                       # final-px border kept clear around the body
TEX = 512                         # painted atlas size (infantry_layout.ATLAS)

# camera-relative key light (built per view from the screen basis)
AMBIENT = 0.42
KEY = 0.80


# ── material sampling (per triangle, view-independent) ───────────────────

def load_textures():
    """The painted flat-swatch maps the 3D body uses — regenerate to be sure
    the impostor matches the shipped material exactly."""
    paint_infantry.paint_all()
    dif = np.asarray(Image.open(f'{OUT}/{paint_infantry.TEX_STEM}_diffuse.png')
                     .convert('RGB'), dtype=np.float32)
    emi = np.asarray(Image.open(f'{OUT}/{paint_infantry.TEX_STEM}_emissive.png')
                     .convert('RGB'), dtype=np.float32)
    tea = np.asarray(Image.open(f'{OUT}/{paint_infantry.TEX_STEM}_team.png')
                     .convert('RGB'), dtype=np.float32)
    return dif, emi, tea


def tri_arrays(part, dif_tex, emi_tex, tea_tex):
    """Flatten a meshlib Part into per-triangle arrays: world-space vertex
    positions (T,3,3), the flat face normal (T,3), and the material sampled
    at each face's centroid UV — diffuse+emissive RGB (T,3) and a team flag
    (T,) — since every face maps to one solid swatch."""
    pos = np.asarray(part.pos, dtype=np.float64)
    nrm = np.asarray(part.nrm, dtype=np.float64)
    uv = np.asarray(part.uv, dtype=np.float64)
    idx = np.asarray(part.idx, dtype=np.int64).reshape(-1, 3)

    tpos = pos[idx]                                   # (T,3,3)
    tnrm = nrm[idx[:, 0]]                             # flat normal (shared)
    cuv = uv[idx].mean(axis=1)                        # centroid UV (T,2)
    px = np.clip((cuv[:, 0] * TEX).astype(int), 0, TEX - 1)
    py = np.clip((cuv[:, 1] * TEX).astype(int), 0, TEX - 1)
    dif = dif_tex[py, px]                             # (T,3)
    emi = emi_tex[py, px]
    team = tea_tex[py, px, 0] > 127                   # (T,)
    return tpos, tnrm, dif, emi, team


# ── framing (uniform scale + ground anchor across all 24 views) ──────────

def view_basis(cam_dir_vec):
    """Screen basis for a camera at `cam_dir_vec` (unit→camera) looking at
    the origin. Returns (f, s_right, s_up): f = camera→target view dir."""
    cam_dir_vec = np.asarray(cam_dir_vec, dtype=np.float64)
    f = -cam_dir_vec / np.linalg.norm(cam_dir_vec)
    world_up = np.array([0.0, 1.0, 0.0])
    s_right = np.cross(world_up, f)
    s_right /= np.linalg.norm(s_right)
    s_up = np.cross(f, s_right)
    s_up /= np.linalg.norm(s_up)
    return f, s_right, s_up


def framing(all_pos):
    """One px-per-metre scale and ground-anchor pixel shared by all views of
    a model, so apparent size is constant and the feet sit at the same row.
    Ground anchor = model origin (feet at Y=0, centred on X=Z=0)."""
    hx = 0.0
    top = 0.0
    bot = 0.0
    for pitch in range(C.PITCH_BINS):
        for col in range(C.YAW_BINS):
            _, sr, su = view_basis(C.cam_dir(col, pitch))
            xs = all_pos @ sr
            ys = all_pos @ su
            hx = max(hx, float(np.abs(xs).max()))
            top = max(top, float(ys.max()))
            bot = min(bot, float(ys.min()))
    usable = C.CELL - 2 * MARGIN
    scale = min((C.CELL / 2 - MARGIN) / max(hx, 1e-6),
                usable / max(top - bot, 1e-6))
    return scale, top, bot


# ── rasteriser ───────────────────────────────────────────────────────────

def render_cell(tpos, tnrm, tdif, temi, tteam, cam_dir_vec, scale, top):
    """Rasterise one view at CELL*SS then box-downscale to CELL. Returns
    (rgba uint8 CELL×CELL×4, team uint8 CELL×CELL)."""
    S = C.CELL * SS
    f, sr, su = view_basis(cam_dir_vec)
    # stable camera-relative key: upper-left of the camera
    L = -f + 0.8 * su - 0.5 * sr
    L /= np.linalg.norm(L)

    # project every vertex (T,3,3) into screen px + depth
    xs = tpos @ sr
    ys = tpos @ su
    depth = tpos @ f
    sx = (C.CELL / 2 + xs * scale) * SS
    sy = (MARGIN + (top - ys) * scale) * SS

    # per-face lambert shade → colour (premultiplied by later coverage)
    ndotl = np.clip(tnrm @ L, 0.0, None)
    shade = (AMBIENT + KEY * ndotl)[:, None]
    fcol = np.clip(tdif * shade + temi, 0.0, 255.0)   # (T,3)
    facing = tnrm @ f                                 # <0 = faces camera

    color = np.zeros((S, S, 3), dtype=np.float32)
    covered = np.zeros((S, S), dtype=bool)
    teambuf = np.zeros((S, S), dtype=bool)
    zbuf = np.full((S, S), np.inf, dtype=np.float64)

    for t in range(tpos.shape[0]):
        if facing[t] >= 0:                            # back-face cull
            continue
        ax, ay = sx[t, 0], sy[t, 0]
        bx, by = sx[t, 1], sy[t, 1]
        cx, cy = sx[t, 2], sy[t, 2]
        x0 = max(int(np.floor(min(ax, bx, cx))), 0)
        x1 = min(int(np.ceil(max(ax, bx, cx))), S - 1)
        y0 = max(int(np.floor(min(ay, by, cy))), 0)
        y1 = min(int(np.ceil(max(ay, by, cy))), S - 1)
        if x1 < x0 or y1 < y0:
            continue
        area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if abs(area) < 1e-9:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5,
                             np.arange(y0, y1 + 1) + 0.5)
        w0 = ((bx - gx) * (cy - gy) - (cx - gx) * (by - gy)) / area
        w1 = ((cx - gx) * (ay - gy) - (ax - gx) * (cy - gy)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        z = w0 * depth[t, 0] + w1 * depth[t, 1] + w2 * depth[t, 2]
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        win = inside & (z < sub)
        if not win.any():
            continue
        sub[win] = z[win]
        color[y0:y1 + 1, x0:x1 + 1][win] = fcol[t]
        covered[y0:y1 + 1, x0:x1 + 1][win] = True
        teambuf[y0:y1 + 1, x0:x1 + 1][win] = tteam[t]

    # box-downscale SS×SS → coverage = alpha, colour averaged over covered subpx
    def pool(a):
        # (S,S[,ch]) → sum over the SS×SS block, keeping any trailing channel
        if a.ndim == 3:
            return a.reshape(C.CELL, SS, C.CELL, SS, a.shape[2]).sum(axis=(1, 3))
        return a.reshape(C.CELL, SS, C.CELL, SS).sum(axis=(1, 3))
    covf = covered.astype(np.float32)
    csum = pool(covf)
    cov = csum / (SS * SS)
    cprem = pool(color * covered[..., None])
    rgb = np.where(csum[..., None] > 0, cprem / np.maximum(csum[..., None], 1),
                   0.0)
    tmask = pool((teambuf & covered).astype(np.float32)) / (SS * SS)

    rgba = np.zeros((C.CELL, C.CELL, 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    rgba[..., 3] = np.clip(cov * 255, 0, 255).astype(np.uint8)
    team8 = np.clip(tmask * 255, 0, 255).astype(np.uint8)
    return rgba, team8


# ── per-model atlas assembly ─────────────────────────────────────────────

def bake(stem, build_fn, dif_tex, emi_tex, tea_tex):
    part = build_fn()
    tpos, tnrm, tdif, temi, tteam = tri_arrays(part, dif_tex, emi_tex, tea_tex)
    scale, top, _bot = framing(tpos.reshape(-1, 3))

    atlas = Image.new('RGBA', (C.ATLAS_W, C.ATLAS_H), (0, 0, 0, 0))
    team = Image.new('L', (C.ATLAS_W, C.ATLAS_H), 0)
    has_team = bool(tteam.any())

    for pitch in range(C.PITCH_BINS):
        for col in range(C.YAW_BINS):
            rgba, team8 = render_cell(tpos, tnrm, tdif, temi, tteam,
                                      C.cam_dir(col, pitch), scale, top)
            ox, oy = C.cell_origin(col, pitch)
            atlas.paste(Image.fromarray(rgba, 'RGBA'), (ox, oy))
            if has_team:
                team.paste(Image.fromarray(team8, 'L'), (ox, oy))

    atlas.save(f'{OUT}/{stem}_impostor.png')
    if has_team:
        team.save(f'{OUT}/{stem}_impostor_team.png')
    meta = C.metadata()
    meta['stem'] = stem
    meta['team_mask'] = has_team
    json.dump(meta, open(f'{OUT}/{stem}_impostor.json', 'w'), indent=1)

    _golden(stem, atlas)
    print(f'[bake] {stem}: {part.tri_count()} tris → '
          f'{C.YAW_BINS}×{C.PITCH_BINS} atlas {C.ATLAS_W}×{C.ATLAS_H}'
          + (' (+team)' if has_team else ' (no team — gaia)'))


def _golden(stem, atlas):
    """QA artifacts (committed): the full contact sheet on a mid-grey ground
    + a single-row yaw strip at the middle pitch (45°) for a quick per-heading
    read."""
    os.makedirs(STRIPS, exist_ok=True)
    bg = Image.new('RGB', atlas.size, (58, 62, 68))
    bg.paste(atlas, (0, 0), atlas)
    bg.save(f'{STRIPS}/{stem}_atlas.png')
    row = C.PITCH_BINS // 2                            # middle pitch = 45°
    y0 = row * C.CELL
    strip = atlas.crop((0, y0, C.ATLAS_W, y0 + C.CELL))
    sbg = Image.new('RGB', strip.size, (58, 62, 68))
    sbg.paste(strip, (0, 0), strip)
    sbg.save(f'{STRIPS}/{stem}_yaw.png')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    dif_tex, emi_tex, tea_tex = load_textures()
    for stem, (build_fn, _team) in MODELS.items():
        bake(stem, build_fn, dif_tex, emi_tex, tea_tex)
