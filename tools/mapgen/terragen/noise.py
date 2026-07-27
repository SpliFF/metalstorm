"""Seeded 2D simplex-style gradient noise, vectorized in numpy.

Implements OpenSimplex-flavoured 2D simplex noise with a seeded permutation
table, plus the standard fractal compositions (fBm, ridged multifractal,
billow) and domain warping. Deterministic: same seed + same query points =>
identical output, independent of platform (pure integer hashing + float64
math, no OS randomness).

All functions take/return numpy arrays and are safe to call on full
2049x2049+ grids at once (memory ~8 bytes/sample/temporary).
"""
from __future__ import annotations

import numpy as np

# Skewing factors for 2D simplex grid
_F2 = 0.5 * (np.sqrt(3.0) - 1.0)
_G2 = (3.0 - np.sqrt(3.0)) / 6.0

# 8 unit-ish gradients (simplex classic set)
_GRAD = np.array(
    [
        (1, 1), (-1, 1), (1, -1), (-1, -1),
        (1, 0), (-1, 0), (0, 1), (0, -1),
    ],
    dtype=np.float64,
)


def _perm_table(seed: int) -> np.ndarray:
    """256-entry permutation table from a seeded PCG64 — deterministic."""
    rng = np.random.Generator(np.random.PCG64(seed))
    p = np.arange(256, dtype=np.int64)
    rng.shuffle(p)
    return np.concatenate([p, p])  # doubled to skip masking on the second lookup


class SimplexNoise:
    """Seeded 2D simplex noise. Instances are cheap; keep one per octave-set."""

    def __init__(self, seed: int):
        self.perm = _perm_table(seed)

    def _grad_index(self, i: np.ndarray, j: np.ndarray) -> np.ndarray:
        return self.perm[(i & 255) + self.perm[j & 255]] & 7

    def noise2(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Raw simplex noise in [-1, 1] (approx). x, y broadcastable arrays."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)

        s = (x + y) * _F2
        i = np.floor(x + s).astype(np.int64)
        j = np.floor(y + s).astype(np.int64)
        t = (i + j) * _G2
        x0 = x - (i - t)
        y0 = y - (j - t)

        # Which simplex triangle are we in?
        upper = x0 > y0
        i1 = np.where(upper, 1, 0)
        j1 = np.where(upper, 0, 1)

        x1 = x0 - i1 + _G2
        y1 = y0 - j1 + _G2
        x2 = x0 - 1.0 + 2.0 * _G2
        y2 = y0 - 1.0 + 2.0 * _G2

        gi0 = self._grad_index(i, j)
        gi1 = self._grad_index(i + i1, j + j1)
        gi2 = self._grad_index(i + 1, j + 1)

        def corner(gx: np.ndarray, cx: np.ndarray, cy: np.ndarray) -> np.ndarray:
            tt = 0.5 - cx * cx - cy * cy
            tt = np.maximum(tt, 0.0)
            tt *= tt
            g = _GRAD[gx]
            return tt * tt * (g[..., 0] * cx + g[..., 1] * cy)

        n = corner(gi0, x0, y0) + corner(gi1, x1, y1) + corner(gi2, x2, y2)
        # 70.14 normalizes classic 2D simplex to roughly [-1, 1]
        return 70.14 * n


def fbm(
    noise: SimplexNoise,
    x: np.ndarray,
    y: np.ndarray,
    octaves: int = 8,
    lacunarity: float = 2.0,
    gain: float = 0.5,
    frequency: float = 1.0,
) -> np.ndarray:
    """Fractional Brownian motion in ~[-1, 1]."""
    total = np.zeros(np.broadcast(x, y).shape, dtype=np.float64)
    amp = 1.0
    freq = frequency
    norm = 0.0
    for _ in range(octaves):
        total += amp * noise.noise2(x * freq, y * freq)
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / norm


def ridged(
    noise: SimplexNoise,
    x: np.ndarray,
    y: np.ndarray,
    octaves: int = 6,
    lacunarity: float = 2.0,
    gain: float = 0.5,
    frequency: float = 1.0,
    sharpness: float = 2.0,
) -> np.ndarray:
    """Ridged multifractal in [0, 1] — sharp crests, good for mountain spines.

    Per-octave: 1 - |noise|, raised to `sharpness`, amplitude modulated by the
    previous octave's value (classic Musgrave weighting) so ridges compound
    along crests instead of everywhere.
    """
    shape = np.broadcast(x, y).shape
    total = np.zeros(shape, dtype=np.float64)
    amp = 0.5
    freq = frequency
    weight = np.ones(shape, dtype=np.float64)
    norm = 0.0
    for _ in range(octaves):
        signal = 1.0 - np.abs(noise.noise2(x * freq, y * freq))
        signal = signal**sharpness
        signal *= weight
        weight = np.clip(signal * 2.0, 0.0, 1.0)
        total += signal * amp
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / norm


def billow(
    noise: SimplexNoise,
    x: np.ndarray,
    y: np.ndarray,
    octaves: int = 6,
    lacunarity: float = 2.0,
    gain: float = 0.5,
    frequency: float = 1.0,
) -> np.ndarray:
    """Billowy (|noise|) fBm in ~[0, 1] — rounded hills / dune shapes."""
    total = np.zeros(np.broadcast(x, y).shape, dtype=np.float64)
    amp = 1.0
    freq = frequency
    norm = 0.0
    for _ in range(octaves):
        total += amp * np.abs(noise.noise2(x * freq, y * freq))
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / norm


def domain_warp(
    noise: SimplexNoise,
    x: np.ndarray,
    y: np.ndarray,
    strength: float,
    frequency: float = 1.0,
    octaves: int = 3,
) -> tuple[np.ndarray, np.ndarray]:
    """Warp query coordinates by two decorrelated fBm fields.

    Returns (wx, wy) to feed into a subsequent noise/fbm call. Large offsets
    (1000+) decorrelate the two channels through the same permutation table.
    """
    dx = fbm(noise, x + 1731.0, y + 517.0, octaves=octaves, frequency=frequency)
    dy = fbm(noise, x - 933.0, y + 2711.0, octaves=octaves, frequency=frequency)
    return x + strength * dx, y + strength * dy
