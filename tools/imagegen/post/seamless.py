"""Seamless tiling via a four-way cross-fade.

Why not the classic offset-blend (roll by half, blur the cross)? Because on
real SDXL output the blurred cross is a *visible* soft "+" of lost detail
through the middle of every tile — worse than the seam it hides (seen on the
first comfy_local overlay, 2026-09-17). A pure two-source blend of the
image with its half-rolled copy can't be seamless either: at the four points
where the rolled copy's seam meets the original's border, one of the two is
always discontinuous.

Four sources fix that. With A the original and Ax/Ay/Axy its copies rolled
by half in x / y / both, and plateau weights wx(x), wy(y) that are 1 except
in a `feather`-wide band at each border where they smoothstep to 0:

    out = wx*wy*A + (1-wx)*wy*Ax + wx*(1-wy)*Ay + (1-wx)*(1-wy)*Axy

At an x-border wx=0, so only x-rolled copies (continuous there) contribute;
at the centre column wx=1, so the x-rolled copies (whose seam is there) are
masked out — and symmetrically in y. Every source is continuous wherever it
has non-zero weight, so the result wraps cleanly in both axes. The cost is
a soft double-exposure in the border bands instead of a blurred cross —
the right trade for grime, ground and ripple textures, which is all that
runs through this step. Works on L/RGB/RGBA alike.
"""
from __future__ import annotations
import numpy as np
from PIL import Image


def _plateau(n: int, feather: float) -> np.ndarray:
    t = (np.arange(n) + 0.5) / n
    d = 0.5 - np.abs(t - 0.5)  # distance to the nearest border, in [0, 0.5]
    x = np.clip(d / max(feather, 1e-6), 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)  # smoothstep


def make_seamless(img: Image.Image, feather: float = 0.18) -> Image.Image:
    mode = img.mode
    arr = np.asarray(img).astype(np.float64)
    h, w = arr.shape[:2]
    ax = np.roll(arr, shift=w // 2, axis=1)
    ay = np.roll(arr, shift=h // 2, axis=0)
    axy = np.roll(arr, shift=(h // 2, w // 2), axis=(0, 1))

    wx = _plateau(w, feather)[None, :]
    wy = _plateau(h, feather)[:, None]
    if arr.ndim == 3:
        wx = wx[..., None]
        wy = wy[..., None]

    out = (wx * wy * arr + (1 - wx) * wy * ax
           + wx * (1 - wy) * ay + (1 - wx) * (1 - wy) * axy)
    return Image.fromarray(np.clip(np.rint(out), 0, 255).astype(np.uint8), mode)
