"""checker — zone-tinted UV-checker texture stub for blockout review.

Usage: python3 checker.py <layout_module> <stem>
Writes out/<stem>_{diffuse,orm,emissive,team,normals}.png where the
diffuse is a grid + per-zone tint pulled from the layout module's Zone
attributes (parametric rects get tints too).
"""
import importlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

mod = importlib.import_module(sys.argv[1])
stem = sys.argv[2]
import meshlib
W = meshlib.ATLAS

img = Image.new('RGB', (W, W), (40, 40, 44))
d = ImageDraw.Draw(img)
for g in range(0, W, 32):
    d.line([(g, 0), (g, W)], fill=(70, 70, 76), width=1)
for g in range(0, W, 128):
    d.line([(g, 0), (g, W)], fill=(110, 110, 118), width=1)
    d.line([(0, g), (W, g)], fill=(110, 110, 118), width=1)

rng = np.random.default_rng(7)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 22)
except OSError:
    font = ImageFont.load_default()

for name in dir(mod):
    v = getattr(mod, name)
    rect = None
    if isinstance(v, meshlib.Zone):
        rect = v.rect
    elif (isinstance(v, tuple) and len(v) == 4
          and all(isinstance(x, (int, float)) for x in v) and name.isupper()
          and v[2] <= W and v[3] <= W and v[0] < v[2] and v[1] < v[3]):
        rect = v
    if rect is None:
        continue
    tint = tuple(int(c) for c in rng.integers(70, 220, 3))
    overlay = Image.new('RGB', (int(rect[2] - rect[0]), int(rect[3] - rect[1])), tint)
    img.paste(Image.blend(img.crop([int(x) for x in rect]), overlay, 0.55),
              (int(rect[0]), int(rect[1])))
    d.rectangle([int(x) for x in rect], outline=(255, 255, 255), width=2)
    d.text((rect[0] + 6, rect[1] + 4), name, fill=(255, 255, 255), font=font)

img.save(f'out/{stem}_diffuse.png')
Image.new('RGB', (W, W), (232, 168, 28)).save(f'out/{stem}_orm.png')
Image.new('RGB', (W, W), (0, 0, 0)).save(f'out/{stem}_emissive.png')
Image.new('RGB', (W, W), (0, 0, 0)).save(f'out/{stem}_team.png')
Image.new('RGB', (W, W), (128, 128, 255)).save(f'out/{stem}_normals.png')
print(f'[checker] {stem}: UV-checker set written to out/ ({W}px)')
