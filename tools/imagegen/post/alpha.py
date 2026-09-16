"""Alpha derivation for raster backends. `backends/none` renders overlay and
emblem alpha directly (numpy masks it can control exactly); a raster backend
(comfy_local/hosted) has no alpha channel at all — SDXL always returns opaque
RGB. These two steps recover the same *kind* of asset from the pixels the
model actually gave us, so both backends produce usable output:

  overlay_alpha  the overlay prompt asks for stains/streaks "on a neutral
                 mid-grey base for blending" — deviation from that grey base
                 becomes alpha, and the pixels are recoloured to the job's
                 flat tint, matching backends/none._gen_overlay's alpha-from-
                 noise + flat-tint shape.
  key_out_background  the emblem prompt asks for "isolated on transparent
                 background", which SDXL renders as a plain-ish backdrop
                 rather than real transparency. Chroma-key the four corners
                 out to alpha so the badge reads as an isolated icon.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageFilter


def overlay_alpha(img: Image.Image, tint_rgb: tuple[int, int, int], *,
                   mid: float = 128.0, gain: float = 2.4, gamma: float = 1.3) -> Image.Image:
    if img.mode == 'RGBA':
        return img  # backends/none already carries a real alpha mask
    l = np.asarray(img.convert('L'), dtype=np.float64)
    dev = np.abs(l - mid) / 128.0
    a = np.clip(dev * gain, 0.0, 1.0) ** (1.0 / gamma)
    alpha_u8 = np.clip(a * 235, 0, 255).astype(np.uint8)
    h, w = l.shape
    rgb = np.tile(np.array(tint_rgb, dtype=np.uint8), (h, w, 1))
    return Image.fromarray(np.dstack([rgb, alpha_u8]), 'RGBA')


def key_out_background(img: Image.Image, tolerance: float = 28.0, feather: float = 2.0) -> Image.Image:
    if img.mode == 'RGBA' and np.asarray(img)[..., 3].std() > 1:
        return img  # already has real transparency (backends/none)
    rgb = img.convert('RGB')
    arr = np.asarray(rgb, dtype=np.float64)
    h, w = arr.shape[:2]
    corners = np.array([arr[0, 0], arr[0, w - 1], arr[h - 1, 0], arr[h - 1, w - 1]])
    bg = corners.mean(axis=0)
    dist = np.linalg.norm(arr - bg, axis=-1)
    alpha = np.clip((dist - tolerance) / max(feather, 1e-6), 0.0, 1.0)
    alpha_img = Image.fromarray((alpha * 255).astype(np.uint8), 'L')
    if feather > 0:
        alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(feather))
    out = np.dstack([np.asarray(rgb), np.asarray(alpha_img)])
    return Image.fromarray(out.astype(np.uint8), 'RGBA')
