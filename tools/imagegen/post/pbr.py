"""PBR derivation: height (from luminance) -> tangent-space normal, and
luminance -> roughness. The normal bake reuses tools/fable-model-forge's
Sobel HeightMap.to_normal_image (art/STYLE.md's "soft normal maps") instead
of re-deriving the gradient math — we drive its `.h` array directly and
skip its authoring API, since that's sized for the forge's own W=1024
canvas and we want this to work at whatever resolution the job asks for.
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np
from PIL import Image

_FORGE_DIR = Path(__file__).resolve().parents[2] / 'fable-model-forge'


def _height_map_cls():
    if str(_FORGE_DIR) not in sys.path:
        sys.path.insert(0, str(_FORGE_DIR))
    from normals import HeightMap  # type: ignore
    return HeightMap


def height_from_luminance(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert('L'), dtype=np.float32) / 255.0


def normal_from_height(height: np.ndarray, strength: float = 2.2) -> Image.Image:
    hm = _height_map_cls()()
    hm.h = height.astype(np.float32)
    return hm.to_normal_image(strength=strength)


def roughness_from_luminance(img: Image.Image, invert: bool = True) -> Image.Image:
    """Dark/grimy areas read rougher, bright/glossy highlights read smoother —
    a cheap stand-in until real material passes replace it."""
    l = np.asarray(img.convert('L'), dtype=np.float32)
    if invert:
        l = 255.0 - l
    l = l * 0.7 + 255.0 * 0.15  # keep off the 0/255 rails
    return Image.fromarray(np.clip(l, 0, 255).astype(np.uint8), 'L')
