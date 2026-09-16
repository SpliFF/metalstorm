#!/usr/bin/env python3
"""Build docs/reviews/beta/imagegen-contact.png — one tile per generated PNG
in art/gen/manifest.json (plus a 2×2 tiled preview for every tileable
class, since seams are the thing a single tile can't show), labelled with
job id, backend and file. Alpha assets are composited over DIRECTION.md's
worn-steel so overlays/emblems read the way they will in-game.

    tools/imagegen/.venv/bin/python tools/imagegen/contact.py
"""
from __future__ import annotations
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
MANIFEST = REPO_ROOT / 'data' / 'games' / 'metalstorm' / 'art' / 'gen' / 'manifest.json'
OUT = REPO_ROOT / 'docs' / 'reviews' / 'beta' / 'imagegen-contact.png'
TILE = 160
LABEL_H = 30
COLS = 6
STEEL = (0x2b, 0x2e, 0x31, 255)
TILEABLE = {'biome', 'overlay', 'water_normal'}


def _over_steel(img: Image.Image) -> Image.Image:
    img = img.convert('RGBA')
    bg = Image.new('RGBA', img.size, STEEL)
    return Image.alpha_composite(bg, img).convert('RGB')


def _fit(img: Image.Image, size: int) -> Image.Image:
    img = img.copy()
    img.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new('RGB', (size, size), (0x1a, 0x1c, 0x1e))
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2))
    return canvas


def _tiled_2x2(img: Image.Image) -> Image.Image:
    w, h = img.size
    sheet = Image.new('RGB', (w * 2, h * 2))
    for x in (0, w):
        for y in (0, h):
            sheet.paste(img, (x, y))
    return sheet


def build(manifest_path: Path = MANIFEST, out_path: Path = OUT) -> tuple[Path, int]:
    manifest = json.loads(manifest_path.read_text())
    tiles: list[tuple[Image.Image, str, str]] = []
    for job_id in sorted(manifest):
        entry = manifest[job_id]
        backend = entry['backend'] + (' (pinned)' if entry.get('backend_pinned') else '')
        for out_rel in entry['outputs']:
            if not out_rel.endswith('.png'):
                continue
            path = REPO_ROOT / out_rel
            if not path.is_file():
                continue
            img = _over_steel(Image.open(path))
            tiles.append((_fit(img, TILE), f'{job_id} [{backend}]', Path(out_rel).name))
            if entry['class'] in TILEABLE and '_normal' not in out_rel and '_roughness' not in out_rel:
                tiles.append((_fit(_tiled_2x2(img), TILE), f'{job_id} 2x2 tiled', 'seam check'))

    rows = (len(tiles) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * TILE, rows * (TILE + LABEL_H)), (0x12, 0x13, 0x14))
    draw = ImageDraw.Draw(sheet)
    for i, (tile, line1, line2) in enumerate(tiles):
        x = (i % COLS) * TILE
        y = (i // COLS) * (TILE + LABEL_H)
        sheet.paste(tile, (x, y))
        draw.text((x + 4, y + TILE + 2), line1[:34], fill=(0xd8, 0xdc, 0xd6))
        draw.text((x + 4, y + TILE + 15), line2[:34], fill=(0x8a, 0x7f, 0x6a))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, optimize=True)
    return out_path, len(tiles)


if __name__ == '__main__':
    path, n = build()
    print(f'{path.relative_to(REPO_ROOT)}: {n} tiles, {path.stat().st_size // 1024} KB')
    sys.exit(0)
