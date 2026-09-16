"""Seamless tiling via the classic offset-blend: roll the image by half its
size (the original border seam becomes a cross through the middle), then
blend a blurred copy over that cross so the discontinuity disappears. Works
on L/RGB/RGBA alike.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageFilter


def make_seamless(img: Image.Image, feather: float = 0.12) -> Image.Image:
    mode = img.mode
    arr = np.asarray(img).astype(np.float64)
    h, w = arr.shape[:2]
    offset = np.roll(arr, shift=(h // 2, w // 2), axis=(0, 1))

    offset_img = Image.fromarray(np.clip(offset, 0, 255).astype(np.uint8), mode)
    sigma = max(2.0, min(h, w) * 0.02)
    blurred = np.asarray(offset_img.filter(ImageFilter.GaussianBlur(sigma))).astype(np.float64)

    yy, xx = np.indices((h, w))
    dy = np.abs(yy - h / 2) / h
    dx = np.abs(xx - w / 2) / w
    d = np.minimum(dy, dx)
    band = np.clip(1 - d / feather, 0, 1)
    if arr.ndim == 3:
        band = band[..., None]

    out = offset * (1 - band) + blurred * band
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode)
