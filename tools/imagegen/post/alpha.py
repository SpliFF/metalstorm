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
  key_out_background  the emblem prompt asks for a flat backdrop, which SDXL
                 renders as a mottled one rather than real transparency. Key
                 what looks like the corners, fill the badge's holes, keep the
                 one centred component so the badge reads as an isolated icon.
"""
from __future__ import annotations
import numpy as np
from PIL import Image, ImageFilter


def overlay_alpha(img: Image.Image, tint_rgb: tuple[int, int, int], *,
                  span_percentile: float = 97.0, gamma: float = 1.3) -> Image.Image:
    """Alpha = how far each pixel's luminance sits from the sample's *own
    median*, normalised so the `span_percentile`-th deviation is fully
    opaque. The first version measured deviation from a fixed mid-grey; SDXL
    paints the "neutral grey base" at whatever grey it likes (the first oil
    sample's base was L≈150), which gave the whole base ~40% alpha and turned
    the overlay into a flat tint. Median-relative, the base clears and only
    the stains — darker *or* lighter than it — carry alpha."""
    if img.mode == 'RGBA':
        return img  # backends/none already carries a real alpha mask
    l = np.asarray(img.convert('L'), dtype=np.float64)
    dev = np.abs(l - np.median(l))
    span = max(float(np.percentile(dev, span_percentile)), 1.0)
    a = np.clip(dev / span, 0.0, 1.0) ** (1.0 / gamma)
    alpha_u8 = np.clip(a * 235, 0, 255).astype(np.uint8)
    h, w = l.shape
    rgb = np.tile(np.array(tint_rgb, dtype=np.uint8), (h, w, 1))
    return Image.fromarray(np.dstack([rgb, alpha_u8]), 'RGBA')


def _label(mask: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """4-connected component labels of a boolean mask (0 = not in mask)."""
    from collections import deque
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    sizes: list[int] = [0]
    for sy, sx in zip(*np.nonzero(mask)):
        if labels[sy, sx]:
            continue
        lab = len(sizes)
        sizes.append(0)
        q = deque([(sy, sx)])
        labels[sy, sx] = lab
        while q:
            y, x = q.popleft()
            sizes[lab] += 1
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = lab
                    q.append((ny, nx))
    return labels, sizes


def _fill_holes(fg: np.ndarray) -> np.ndarray:
    """Everything not reachable from the image border through non-foreground
    is foreground: the inside of a badge outline, grunge speckle inside a
    stroke, the disc behind a compass."""
    h, w = fg.shape
    border = np.zeros_like(fg)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    labels, _ = _label(~fg)
    outside_labels = np.unique(labels[border & ~fg])
    outside = np.isin(labels, outside_labels[outside_labels > 0])
    return ~outside


def _corner_patches(arr: np.ndarray, size: int) -> np.ndarray:
    h, w = arr.shape[:2]
    size = max(1, min(size, h // 4, w // 4))
    return np.concatenate([arr[:size, :size].reshape(-1, arr.shape[-1]), arr[:size, w - size:].reshape(-1, arr.shape[-1]),
                           arr[h - size:, :size].reshape(-1, arr.shape[-1]), arr[h - size:, w - size:].reshape(-1, arr.shape[-1])])


def key_out_background(img: Image.Image, tolerance: float = 28.0, feather: float = 2.0,
                       patch: int = 32, min_component: float = 0.01,
                       circle: float = 0.5, bright_unsat_is_bg: bool = False) -> Image.Image:
    """Background = "looks like the corners", plus a centred-badge prior.

    SDXL never gives a *flat* backdrop however hard the prompt asks — the
    first real emblem samples (2026-09-17) came back on mottled grey
    concrete, which a plain mean-colour-distance key left fully opaque. So:

    1. colour band: a pixel is background-coloured when its saturation is no
       higher than the corner patches' and its luminance sits inside the
       corner patches' 5th–95th percentile range (padded by `tolerance` on
       the bright side, a quarter of it on the dark side so a badge's black
       strokes on dark-grey concrete survive);
    2. holes: anything enclosed by foreground is foreground (the disc behind
       a compass, black strokes sitting on the luminance boundary);
    3. one centred badge: after a morphological opening only the largest
       component survives, and — since the emblem prompt asks for a centred
       icon filling most of the frame — nothing outside the inscribed
       circle (radius `circle` × the short side, feathered) does either.
       Backdrop mottling brighter than the corner band lives in the corners
       and along the edges; that is what the circle cuts. A job whose badge
       has no pale unsaturated parts can also set `bright_unsat_is_bg`
       (job key `key_bright_unsat`) to drop backdrop highlights anywhere.
    """
    if img.mode == 'RGBA' and np.asarray(img)[..., 3].std() > 1:
        return img  # already has real transparency (backends/none)
    rgb = img.convert('RGB')
    arr = np.asarray(rgb, dtype=np.float64)
    h, w = arr.shape[:2]
    lum = arr @ np.array([0.299, 0.587, 0.114])
    sat = arr.max(axis=-1) - arr.min(axis=-1)
    corners = _corner_patches(np.dstack([lum, sat]), patch)
    lo, hi = np.percentile(corners[:, 0], [5, 95])
    sat_max = np.percentile(corners[:, 1], 95)
    lum_ok = (lum >= lo - tolerance * 0.25) & (lum <= hi + tolerance)
    sat_ok = sat <= sat_max + tolerance
    fg = ~(lum_ok & sat_ok)
    if bright_unsat_is_bg:  # per-job opt-in (job "key_bright_unsat"): a badge with no pale
        fg &= ~((lum > hi) & (sat < 40))  # unsaturated parts can drop every backdrop highlight

    if fg.any():
        fg = _fill_holes(fg)
    r = max(1, min(h, w) // 128)
    eroded = np.asarray(Image.fromarray(fg.astype(np.uint8) * 255, 'L').filter(ImageFilter.MinFilter(2 * r + 1))) > 0
    labels, sizes = _label(eroded)
    if len(sizes) > 1:
        largest = int(np.argmax(sizes[1:])) + 1
        if sizes[largest] >= min_component * h * w:
            core = labels == largest
            grown = np.asarray(Image.fromarray(core.astype(np.uint8) * 255, 'L').filter(ImageFilter.MaxFilter(2 * r + 1))) > 0
            fg = fg & grown

    alpha_f = fg.astype(np.float64)
    if circle > 0:
        yy, xx = np.indices((h, w))
        d = np.hypot((xx + 0.5) - w / 2, (yy + 0.5) - h / 2)
        radius = circle * min(h, w)
        edge = max(2.0, 0.01 * min(h, w))
        alpha_f *= np.clip((radius - d) / edge, 0.0, 1.0)

    alpha_img = Image.fromarray((alpha_f * 255).astype(np.uint8), 'L')
    if feather > 0:
        alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(feather))
    out = np.dstack([np.asarray(rgb), np.asarray(alpha_img)])
    return Image.fromarray(out.astype(np.uint8), 'RGBA')
