"""Seeded 2D simplex-style gradient noise, vectorized in numpy + numba.

Implements OpenSimplex-flavoured 2D simplex noise with a seeded permutation
table, plus the standard fractal compositions (fBm, ridged multifractal,
billow) and domain warping. Deterministic: same seed + same query points =>
identical output, independent of platform (pure integer hashing + float64
math, no OS randomness) *and independent of thread count* (the numba kernels
below are either single-threaded or, where parallelized, write one output
element per thread with no cross-element accumulation — see the per-pixel
octave loops in `_fbm_kernel`/`_ridged_kernel`/`_billow_kernel`).

All functions take/return numpy arrays and are safe to call on full
2049x2049+ grids at once (memory ~8 bytes/sample/temporary).

Numba port (PLAN-maps.md §2b item 1): the simplex gradient-hash kernel and
the fBm/ridged/billow octave loops are fused into single `@njit` kernels
operating per-pixel (octave loop innermost, matching the original per-pixel
accumulation order exactly) instead of allocating one temporary array per
octave. This is a pure speed port — the arithmetic, operation order, and
integer-hash gradient scheme are unchanged, so output is byte-identical to
the pre-port numpy implementation (verified: see
`tools/mapgen/terragen/_selftest_numba.py`).
"""
from __future__ import annotations

import numpy as np
from numba import njit, prange

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


@njit(cache=True, inline="always")
def _grad_index(i: int, j: int, perm: np.ndarray) -> int:
    return perm[(i & 255) + perm[j & 255]] & 7


@njit(cache=True, inline="always")
def _noise2_scalar(x: float, y: float, perm: np.ndarray, grad: np.ndarray) -> float:
    """Raw simplex noise at one point, in [-1, 1] (approx)."""
    s = (x + y) * _F2
    i = np.int64(np.floor(x + s))
    j = np.int64(np.floor(y + s))
    t = (i + j) * _G2
    x0 = x - (i - t)
    y0 = y - (j - t)

    if x0 > y0:
        i1, j1 = 1, 0
    else:
        i1, j1 = 0, 1

    x1 = x0 - i1 + _G2
    y1 = y0 - j1 + _G2
    x2 = x0 - 1.0 + 2.0 * _G2
    y2 = y0 - 1.0 + 2.0 * _G2

    gi0 = _grad_index(i, j, perm)
    gi1 = _grad_index(i + i1, j + j1, perm)
    gi2 = _grad_index(i + 1, j + 1, perm)

    tt0 = 0.5 - x0 * x0 - y0 * y0
    tt0 = tt0 if tt0 > 0.0 else 0.0
    tt0 *= tt0
    n0 = tt0 * tt0 * (grad[gi0, 0] * x0 + grad[gi0, 1] * y0)

    tt1 = 0.5 - x1 * x1 - y1 * y1
    tt1 = tt1 if tt1 > 0.0 else 0.0
    tt1 *= tt1
    n1 = tt1 * tt1 * (grad[gi1, 0] * x1 + grad[gi1, 1] * y1)

    tt2 = 0.5 - x2 * x2 - y2 * y2
    tt2 = tt2 if tt2 > 0.0 else 0.0
    tt2 *= tt2
    n2 = tt2 * tt2 * (grad[gi2, 0] * x2 + grad[gi2, 1] * y2)

    # 70.14 normalizes classic 2D simplex to roughly [-1, 1]
    return 70.14 * (n0 + n1 + n2)


@njit(cache=True, parallel=True)
def _noise2_kernel(x: np.ndarray, y: np.ndarray, perm: np.ndarray, grad: np.ndarray) -> np.ndarray:
    out = np.empty(x.shape, dtype=np.float64)
    xr = x.reshape(-1)
    yr = y.reshape(-1)
    outr = out.reshape(-1)
    for idx in prange(xr.size):
        outr[idx] = _noise2_scalar(xr[idx], yr[idx], perm, grad)
    return out


@njit(cache=True, parallel=True)
def _fbm_kernel(
    x: np.ndarray, y: np.ndarray, perm: np.ndarray, grad: np.ndarray,
    octaves: int, lacunarity: float, gain: float, frequency: float,
) -> np.ndarray:
    out = np.empty(x.shape, dtype=np.float64)
    xr = x.reshape(-1)
    yr = y.reshape(-1)
    outr = out.reshape(-1)
    for idx in prange(xr.size):
        xv = xr[idx]
        yv = yr[idx]
        total = 0.0
        amp = 1.0
        freq = frequency
        norm = 0.0
        for _ in range(octaves):
            total += amp * _noise2_scalar(xv * freq, yv * freq, perm, grad)
            norm += amp
            amp *= gain
            freq *= lacunarity
        outr[idx] = total / norm
    return out


@njit(cache=True, inline="always")
def _npy_pow(x: float, y: float) -> float:
    """Matches numpy's float64 power ufunc fast paths bit-for-bit (numpy's
    `npy_pow` special-cases these exponents to plain multiply/divide instead
    of libm `pow`, which numba's generic `**` does not do — needed here so
    `signal ** sharpness` stays byte-identical to the pre-port numpy code for
    the sharpness=2.0 default)."""
    if y == 2.0:
        return x * x
    if y == 1.0:
        return x
    if y == 0.0:
        return 1.0
    if y == -1.0:
        return 1.0 / x
    return x ** y


@njit(cache=True, parallel=True)
def _ridged_kernel(
    x: np.ndarray, y: np.ndarray, perm: np.ndarray, grad: np.ndarray,
    octaves: int, lacunarity: float, gain: float, frequency: float, sharpness: float,
) -> np.ndarray:
    out = np.empty(x.shape, dtype=np.float64)
    xr = x.reshape(-1)
    yr = y.reshape(-1)
    outr = out.reshape(-1)
    for idx in prange(xr.size):
        xv = xr[idx]
        yv = yr[idx]
        total = 0.0
        amp = 0.5
        freq = frequency
        weight = 1.0
        norm = 0.0
        for _ in range(octaves):
            signal = 1.0 - abs(_noise2_scalar(xv * freq, yv * freq, perm, grad))
            signal = _npy_pow(signal, sharpness)
            signal *= weight
            weight = signal * 2.0
            if weight < 0.0:
                weight = 0.0
            elif weight > 1.0:
                weight = 1.0
            total += signal * amp
            norm += amp
            amp *= gain
            freq *= lacunarity
        outr[idx] = total / norm
    return out


@njit(cache=True, parallel=True)
def _billow_kernel(
    x: np.ndarray, y: np.ndarray, perm: np.ndarray, grad: np.ndarray,
    octaves: int, lacunarity: float, gain: float, frequency: float,
) -> np.ndarray:
    out = np.empty(x.shape, dtype=np.float64)
    xr = x.reshape(-1)
    yr = y.reshape(-1)
    outr = out.reshape(-1)
    for idx in prange(xr.size):
        xv = xr[idx]
        yv = yr[idx]
        total = 0.0
        amp = 1.0
        freq = frequency
        norm = 0.0
        for _ in range(octaves):
            total += amp * abs(_noise2_scalar(xv * freq, yv * freq, perm, grad))
            norm += amp
            amp *= gain
            freq *= lacunarity
        outr[idx] = total / norm
    return out


class SimplexNoise:
    """Seeded 2D simplex noise. Instances are cheap; keep one per octave-set."""

    def __init__(self, seed: int):
        self.perm = _perm_table(seed)

    def noise2(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Raw simplex noise in [-1, 1] (approx). x, y broadcastable arrays."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        x, y = np.broadcast_arrays(x, y)
        x = np.ascontiguousarray(x)
        y = np.ascontiguousarray(y)
        return _noise2_kernel(x, y, self.perm, _GRAD)


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
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    x, y = np.broadcast_arrays(x, y)
    x = np.ascontiguousarray(x)
    y = np.ascontiguousarray(y)
    return _fbm_kernel(x, y, noise.perm, _GRAD, octaves, lacunarity, gain, frequency)


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
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    x, y = np.broadcast_arrays(x, y)
    x = np.ascontiguousarray(x)
    y = np.ascontiguousarray(y)
    return _ridged_kernel(x, y, noise.perm, _GRAD, octaves, lacunarity, gain, frequency, sharpness)


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
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    x, y = np.broadcast_arrays(x, y)
    x = np.ascontiguousarray(x)
    y = np.ascontiguousarray(y)
    return _billow_kernel(x, y, noise.perm, _GRAD, octaves, lacunarity, gain, frequency)


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
