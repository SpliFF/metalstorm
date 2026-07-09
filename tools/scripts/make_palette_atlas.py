#!/usr/bin/env python3
"""Generate the Metalstorm shared palette atlas (PLAN-metalstorm-beta-units.md
task 1 / art/STYLE.md). Flat-colour swatch sheet, 4x4 grid of 64px cells
(256x256), one swatch per cell, no gradients.

Usage:
    python3 tools/scripts/make_palette_atlas.py [--out /tmp/atlas_palette.png]
    toktx --encode uastc --zcmp 19 --genmipmap \
        data/games/metalstorm/unittextures/atlas_palette.ktx2 <out>.png

The PNG is a build intermediate, never committed (unittextures/README.md's
".ktx2 only" rule) - only the .ktx2 toktx produces lands in the tree.
"""
import argparse
import struct
import zlib

CELL = 64
COLS = 4
ROWS = 4

# Row, col -> (hex color, label). Matches art/STYLE.md's palette table exactly.
SWATCHES = {
    (0, 0): ("B8BEC4", "hull light"),
    (0, 1): ("8A9096", "hull mid"),
    (0, 2): ("4E5257", "hull dark"),
    (0, 3): ("33363A", "armor plate"),
    (1, 0): ("C9A24B", "neutral accent/trim"),
    (1, 1): ("F2C230", "hazard yellow"),
    (1, 2): ("6B6F73", "worn steel"),
    (1, 3): ("8B4A2B", "rust brown"),
    (2, 0): ("6FA8D8", "canopy/glass blue"),
    (2, 1): ("2FE0D0", "emissive cyan"),
    (2, 2): ("E8763A", "exhaust orange"),
    (2, 3): ("F5F0DC", "muzzle-flash white"),
    (3, 0): ("9C9A93", "concrete grey"),
    (3, 1): ("5B6068", "building steel"),
    (3, 2): ("C6B393", "civilian tan"),
    (3, 3): ("2B2B2C", "ground-contact dark"),
}


def hex_to_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def build_pixels():
    w, h = COLS * CELL, ROWS * CELL
    rows = []
    for y in range(h):
        row = bytearray()
        cell_row = y // CELL
        for x in range(w):
            cell_col = x // CELL
            hexcol, _ = SWATCHES[(cell_row, cell_col)]
            row.extend(hex_to_rgb(hexcol))
        rows.append(bytes(row))
    return w, h, rows


def write_png(path, w, h, rows):
    """Minimal, dependency-free PNG writer (flat RGB8, no filtering needed
    since every scanline is solid blocks - filter type 0 is already optimal
    after zlib compression for flat colour data)."""
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0 (none) per scanline
        raw.extend(row)
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="atlas_palette.png")
    args = ap.parse_args()
    w, h, rows = build_pixels()
    write_png(args.out, w, h, rows)
    print(f"wrote {args.out} ({w}x{h}, {COLS}x{ROWS} swatches)")
    for (r, c), (hexcol, label) in sorted(SWATCHES.items()):
        print(f"  [{r}][{c}] #{hexcol}  {label}")


if __name__ == "__main__":
    main()
