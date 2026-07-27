"""SMF/SMT container writer (numpy-fast, general).

Layout matches rts/Server/MapProcessor.cpp's reader (header offsets, section
pointers) and Spring's SMF v1. Heightmap is float elmos in, uint16 quantized
against [min_height, max_height]. The tile layer accepts an arbitrary unique
tile set + per-position index (see dxt1.cluster_tiles).
"""
from __future__ import annotations

import struct

import numpy as np

from . import dxt1

SQUARE_SIZE = 8


def quantize_heightmap(hm: np.ndarray, min_h: float, max_h: float) -> bytes:
    scale = 65535.0 / (max_h - min_h)
    q = np.clip((np.clip(hm, min_h, max_h) - min_h) * scale + 0.5, 0, 65535).astype("<u2")
    return q.tobytes()


def encode_minimap_dxt1(minimap_rgb: np.ndarray) -> bytes:
    """1024x1024x3 uint8 -> DXT1 with the 9-level mip chain SMF expects
    (1024..4; MINIMAP_SIZE in Spring = 699048 bytes)."""
    assert minimap_rgb.shape[:2] == (1024, 1024)
    parts = []
    img = minimap_rgb
    size = 1024
    while size >= 4:
        if img.shape[0] != size:
            img = dxt1.downsample2x(img)
        parts.append(dxt1.encode_dxt1(img).tobytes())
        size //= 2
    # Spring's MINIMAP_SIZE includes levels down to 1x1 stored as 4x4 blocks
    # (8 bytes each for 2x2 and 1x1). Pad with the last 4x4 block repeated.
    total = b"".join(parts)
    target = 699048
    if len(total) < target:
        total += parts[-1][:8] * ((target - len(total)) // 8)
    return total[:target]


def write_smf_smt(
    smf_path: str,
    smt_path: str,
    smt_name: str,
    heightmap: np.ndarray,          # (mapy+1, mapx+1) float elmos
    min_height: float,
    max_height: float,
    tile_index: np.ndarray,         # (tilesZ, tilesX) int32 into unique tiles
    unique_tiles: np.ndarray,       # (K, 32, 32, 3) uint8
    typemap: np.ndarray,            # (mapy/2, mapx/2) uint8
    metalmap: np.ndarray,           # (mapy/2, mapx/2) uint8
    minimap_rgb: np.ndarray,        # (1024, 1024, 3) uint8
) -> None:
    hm_h, hm_w = heightmap.shape
    mapx, mapy = hm_w - 1, hm_h - 1

    heightmap_bytes = quantize_heightmap(heightmap, min_height, max_height)
    typemap_bytes = typemap.astype(np.uint8).tobytes()
    metalmap_bytes = metalmap.astype(np.uint8).tobytes()
    minimap_bytes = encode_minimap_dxt1(minimap_rgb)

    tile_file_name = smt_name.encode() + b"\0"
    num_tiles = int(unique_tiles.shape[0])
    tiles_section = struct.pack("<ii", 1, num_tiles)
    tiles_section += struct.pack("<i", num_tiles) + tile_file_name
    tiles_section += tile_index.astype("<i4").tobytes()

    header_size = 76
    heightmap_ptr = header_size
    typemap_ptr = heightmap_ptr + len(heightmap_bytes)
    tiles_ptr = typemap_ptr + len(typemap_bytes)
    minimap_ptr = tiles_ptr + len(tiles_section)
    metalmap_ptr = minimap_ptr + len(minimap_bytes)
    feature_ptr = metalmap_ptr + len(metalmap_bytes)

    header = bytearray(header_size)
    header[0:16] = b"spring map file\0"
    struct.pack_into("<i", header, 16, 1)
    struct.pack_into("<i", header, 20, 0)
    struct.pack_into("<i", header, 24, mapx)
    struct.pack_into("<i", header, 28, mapy)
    struct.pack_into("<i", header, 32, SQUARE_SIZE)
    struct.pack_into("<i", header, 36, SQUARE_SIZE)
    struct.pack_into("<i", header, 40, 32)
    struct.pack_into("<f", header, 44, min_height)
    struct.pack_into("<f", header, 48, max_height)
    struct.pack_into("<i", header, 52, heightmap_ptr)
    struct.pack_into("<i", header, 56, typemap_ptr)
    struct.pack_into("<i", header, 60, tiles_ptr)
    struct.pack_into("<i", header, 64, minimap_ptr)
    struct.pack_into("<i", header, 68, metalmap_ptr)
    struct.pack_into("<i", header, 72, feature_ptr)

    with open(smf_path, "wb") as f:
        f.write(bytes(header))
        f.write(heightmap_bytes)
        f.write(typemap_bytes)
        f.write(tiles_section)
        f.write(minimap_bytes)
        f.write(metalmap_bytes)
        f.write(struct.pack("<ii", 0, 0))  # features live in featureplacer config

    smt_header = bytearray(32)
    smt_header[0:16] = b"spring tilefile\0"
    struct.pack_into("<i", smt_header, 16, 1)
    struct.pack_into("<i", smt_header, 20, num_tiles)
    with open(smt_path, "wb") as f:
        f.write(bytes(smt_header))
        for k in range(num_tiles):
            f.write(dxt1.encode_smt_tile(unique_tiles[k]))
