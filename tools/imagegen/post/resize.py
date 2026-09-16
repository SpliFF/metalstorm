"""Power-of-two resize — GPU texture hygiene for whatever size a backend
(or the artist) actually hands back.
"""
from __future__ import annotations
from PIL import Image


def _lower_pow2(n: int) -> int:
    return 1 if n <= 1 else 1 << (n.bit_length() - 1)


def nearest_pow2(n: int) -> int:
    lower = _lower_pow2(n)
    upper = lower * 2
    return lower if (n - lower) <= (upper - n) else upper


def to_pow2(img: Image.Image, mode: str = 'nearest') -> Image.Image:
    w, h = img.size
    if mode == 'nearest':
        nw, nh = nearest_pow2(w), nearest_pow2(h)
    else:  # 'ceil'
        nw, nh = _lower_pow2(w) * (1 if _lower_pow2(w) == w else 2), \
                 _lower_pow2(h) * (1 if _lower_pow2(h) == h else 2)
    if (nw, nh) == (w, h):
        return img
    return img.resize((nw, nh), Image.LANCZOS)
