"""Palette grade: pull a raster backend's sample onto DIRECTION.md's register.

SDXL renders "dust-khaki sand" as bright, saturated tan (first comfy_local
desert sample, 2026-09-17: mean RGB ≈ (185,160,125) against the job's
palette mean of (102,92,71)). A terrain diffuse that bright breaks the
direction's exposure/contrast budget before lighting even touches it. The
grade is a per-channel *gain* (never a shift) toward the mean of the job's
`colors`, so black cracks stay black, the surface lands on the register,
and the sample's own grit/contrast is preserved. `strength` blends the gain
in; 1.0 lands exactly on the palette mean.
"""
from __future__ import annotations
import numpy as np
from PIL import Image


def palette_mean(colors: list[str]) -> tuple[float, float, float]:
    rgb = np.array([[int(c.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)] for c in colors], dtype=np.float64)
    m = rgb.mean(axis=0)
    return float(m[0]), float(m[1]), float(m[2])


def grade_to_palette(img: Image.Image, colors: list[str], strength: float = 1.0) -> Image.Image:
    if not colors:
        return img
    mode = img.mode
    src = img.convert('RGBA') if mode == 'RGBA' else img.convert('RGB')
    arr = np.asarray(src).astype(np.float64)
    rgb = arr[..., :3]
    cur = rgb.reshape(-1, 3).mean(axis=0)
    target = np.array(palette_mean(colors))
    gain = np.where(cur > 1e-6, target / np.maximum(cur, 1e-6), 1.0)
    gain = 1.0 + (gain - 1.0) * strength
    out = arr.copy()
    out[..., :3] = np.clip(rgb * gain, 0, 255)
    return Image.fromarray(np.rint(out).astype(np.uint8), src.mode).convert(mode)
