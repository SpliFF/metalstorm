"""Vectorized DXT1 (BC1) encoding + SMT tile clustering, pure numpy.

Quality is range-fit (principal-axis endpoints, 4-colour palette) — below a
production encoder like squish/ISPC but visually fine for terrain albedo that
also receives a detail-splat layer on top. Deterministic.

The SMT tile layer is treated as what it is: a deduplicated megatexture.
`cluster_tiles` vector-quantizes the full-map tile set down to a budget via
seeded minibatch k-means so a 16k map ships ~10-20 MB of unique tiles instead
of ~178 MB.
"""
from __future__ import annotations

import numpy as np


def _pack565(rgb: np.ndarray) -> np.ndarray:
    """(..., 3) uint8 -> (...,) uint16 RGB565."""
    r = rgb[..., 0].astype(np.uint16) >> 3
    g = rgb[..., 1].astype(np.uint16) >> 2
    b = rgb[..., 2].astype(np.uint16) >> 3
    return (r << 11) | (g << 5) | b


def _unpack565(c: np.ndarray) -> np.ndarray:
    r = ((c >> 11) & 31).astype(np.float32) * (255.0 / 31.0)
    g = ((c >> 5) & 63).astype(np.float32) * (255.0 / 63.0)
    b = (c & 31).astype(np.float32) * (255.0 / 31.0)
    return np.stack([r, g, b], axis=-1)


def encode_dxt1(img: np.ndarray) -> np.ndarray:
    """Encode an (H, W, 3) uint8 image (H, W multiples of 4) to DXT1 bytes.

    Returns a uint8 array of length H/4 * W/4 * 8 in raster block order.
    """
    H, W, _ = img.shape
    bh, bw = H // 4, W // 4
    # -> (nblocks, 16, 3) float32
    blocks = (
        img.reshape(bh, 4, bw, 4, 3)
        .transpose(0, 2, 1, 3, 4)
        .reshape(bh * bw, 16, 3)
        .astype(np.float32)
    )
    n = blocks.shape[0]

    # Principal axis per block (cheap: use max-variance channel mix — project
    # onto the mean-centred dominant direction approximated by the color range
    # vector, which for terrain is nearly always luminance-ish).
    mn = blocks.min(axis=1)          # (n, 3)
    mx = blocks.max(axis=1)
    axis = mx - mn                   # (n, 3)
    axis_len = np.linalg.norm(axis, axis=1, keepdims=True)
    axis_unit = np.divide(axis, axis_len, out=np.zeros_like(axis), where=axis_len > 0)

    # Project all texels, take endpoints at the projection extremes.
    t = np.einsum("nkc,nc->nk", blocks - mn[:, None, :], axis_unit)  # (n, 16)
    tmin = t.min(axis=1, keepdims=True)
    tmax = t.max(axis=1, keepdims=True)
    c0f = mn + axis_unit * tmax      # endpoint at far extreme
    c1f = mn + axis_unit * tmin

    c0 = _pack565(np.clip(np.round(c0f), 0, 255).astype(np.uint8))
    c1 = _pack565(np.clip(np.round(c1f), 0, 255).astype(np.uint8))

    # DXT1 4-colour mode requires c0 > c1; swap where violated, nudge equals.
    swap = c0 < c1
    c0s = np.where(swap, c1, c0)
    c1s = np.where(swap, c0, c1)
    eq = c0s == c1s
    c0s = np.where(eq & (c0s < 0xFFFF), c0s + 1, c0s)

    # Palette: c0, c1, 2/3c0+1/3c1, 1/3c0+2/3c1
    p0 = _unpack565(c0s)
    p1 = _unpack565(c1s)
    pal = np.stack([p0, p1, (2 * p0 + p1) / 3.0, (p0 + 2 * p1) / 3.0], axis=1)  # (n,4,3)

    d = blocks[:, :, None, :] - pal[:, None, :, :]     # (n, 16, 4, 3)
    idx = np.argmin((d * d).sum(axis=-1), axis=-1)     # (n, 16) values 0..3
    bits = np.zeros(n, dtype=np.uint32)
    for k in range(16):
        bits |= idx[:, k].astype(np.uint32) << np.uint32(2 * k)

    out = np.empty((n, 8), dtype=np.uint8)
    out[:, 0] = c0s & 0xFF
    out[:, 1] = c0s >> 8
    out[:, 2] = c1s & 0xFF
    out[:, 3] = c1s >> 8
    out[:, 4] = bits & 0xFF
    out[:, 5] = (bits >> 8) & 0xFF
    out[:, 6] = (bits >> 16) & 0xFF
    out[:, 7] = (bits >> 24) & 0xFF
    return out.reshape(-1)


def encode_smt_tile(tile32: np.ndarray) -> bytes:
    """One SMT tile record: 32x32 DXT1 + 16x16 + 8x8 + 4x4 mips (680 bytes)."""
    parts = []
    img = tile32
    for size in (32, 16, 8, 4):
        if img.shape[0] != size:
            img = downsample2x(img)
        parts.append(encode_dxt1(img).tobytes())
    return b"".join(parts)


def downsample2x(img: np.ndarray) -> np.ndarray:
    h, w, c = img.shape
    return (
        img.reshape(h // 2, 2, w // 2, 2, c).astype(np.float32).mean(axis=(1, 3))
    ).astype(np.uint8)


def seam_discontinuity(
    tiles: np.ndarray,
    tile_index: np.ndarray,
    reps: np.ndarray,
    sample: int = 20000,
    seed: int = 0,
) -> dict:
    """Measure how much the tile dictionary breaks C0 continuity of the bake.

    For each horizontal tile boundary, compare the colour jump ACROSS the seam
    to the gradient just INSIDE it. A continuous field gives ratio ~1; a
    dictionary that stitches unrelated tiles together gives a hard edge on the
    32-elmo grid, which reads as a checkerboard / banding on smooth ground.

    Returns {'jump', 'grad', 'ratio'} for the drawn (quantized) field and the
    same three for the source field under key prefix 'true_'.
    """
    tz, tx = tile_index.shape
    rng = np.random.Generator(np.random.PCG64(seed))
    n = min(sample, tz * (tx - 1))
    zs = rng.integers(0, tz, size=n)
    xs = rng.integers(0, tx - 1, size=n)

    def stats(left: np.ndarray, right: np.ndarray) -> tuple[float, float]:
        jump = float(np.abs(right[:, :, 0].astype(np.float32)
                            - left[:, :, 31].astype(np.float32)).mean())
        grad = 0.5 * (
            float(np.abs(left[:, :, 31].astype(np.float32)
                         - left[:, :, 30].astype(np.float32)).mean())
            + float(np.abs(right[:, :, 1].astype(np.float32)
                           - right[:, :, 0].astype(np.float32)).mean())
        )
        return jump, grad

    lin = zs * tx + xs
    tj, tg = stats(np.asarray(tiles[lin]), np.asarray(tiles[lin + 1]))
    dj, dg = stats(reps[tile_index[zs, xs]], reps[tile_index[zs, xs + 1]])
    return {
        "jump": dj, "grad": dg, "ratio": dj / max(dg, 1e-9),
        "true_jump": tj, "true_grad": tg, "true_ratio": tj / max(tg, 1e-9),
    }


def cluster_tiles(
    tiles: np.ndarray,
    budget: int,
    seed: int = 0,
    iters: int = 12,
    batch: int = 65536,
) -> tuple[np.ndarray, np.ndarray]:
    """Vector-quantize (N, 32, 32, 3) uint8 tiles down to `budget` clusters.

    Features are 8x8x3 box-downsampled tiles. Returns (assignments (N,) int32,
    representatives (K, 32, 32, 3) uint8) where representative k is the actual
    source tile nearest the cluster centroid (keeps full-res crispness rather
    than averaging tiles together).

    FIDELITY-STANDIN: Spring/Recoil's own map compiler dedupes SMT tiles
    EXACTLY (identical tiles share a slot); this is a *lossy* quantizer, traded
    for an 8.4 MB SMT instead of ~178 MB on a 16k map. The cost is measurable
    and visible: `seam_discontinuity` on skerry_reach reads jump 2.98 / interior
    gradient 0.31 = **ratio 9.7**, where the unquantized bake reads 0.86 (that is
    the whole-map sample this function takes and the build prints; restricted to
    land seams, where a player actually is, it reads 4.33 / 0.435 = 9.95). In
    other words the dictionary moves the terrain's colour variation out of tile
    interiors and onto the 32-elmo tile boundaries, which shows up as a
    checkerboard on smooth ground (worst on the sand plateaus) and as banding at
    strategic zoom. Measured 2026-08-08; see PLAN-maps.md M7 item 1.

    Raising `budget` does NOT fix this — doubling it to 24576 (16.7 MB) moved
    the seam jump only 4.33 -> 4.18 (-3.6%). The effective dimensionality of the
    feature space is ~9, so seam error falls as budget^(-1/9). Continuity needs
    per-position data, which a shared dictionary indexed per position cannot
    provide; the fix is architectural (PLAN-maps.md M7 item 1, options A/B/C).
    """
    N = tiles.shape[0]
    if N <= budget:
        return np.arange(N, dtype=np.int32), tiles

    # features
    f = (
        tiles.reshape(N, 8, 4, 8, 4, 3).astype(np.float32).mean(axis=(2, 4)).reshape(N, -1)
    )  # (N, 192)

    rng = np.random.Generator(np.random.PCG64(seed))
    centroids = f[rng.choice(N, size=budget, replace=False)].copy()

    def assign(chunk):
        # squared distance via ||a||^2 - 2ab + ||b||^2
        d = (
            (chunk * chunk).sum(1)[:, None]
            - 2.0 * chunk @ centroids.T
            + (centroids * centroids).sum(1)[None, :]
        )
        return np.argmin(d, axis=1)

    for _ in range(iters):
        # minibatch update
        sel = rng.choice(N, size=min(batch, N), replace=False)
        a = assign(f[sel])
        for k in np.unique(a):
            pts = f[sel[a == k]]
            centroids[k] = centroids[k] * 0.5 + pts.mean(axis=0) * 0.5

    # final full assignment (chunked)
    assignments = np.empty(N, dtype=np.int32)
    for s in range(0, N, batch):
        assignments[s : s + batch] = assign(f[s : s + batch])

    # representative = source tile nearest each centroid
    reps = np.zeros((budget, 32, 32, 3), dtype=np.uint8)
    used = np.zeros(budget, dtype=bool)
    for k in range(budget):
        members = np.flatnonzero(assignments == k)
        if members.size == 0:
            continue
        d = ((f[members] - centroids[k]) ** 2).sum(axis=1)
        reps[k] = tiles[members[np.argmin(d)]]
        used[k] = True

    # compact away empty clusters
    remap = np.cumsum(used) - 1
    assignments = remap[assignments].astype(np.int32)
    return assignments, reps[used]
