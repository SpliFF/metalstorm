"""paint_infantry — shared 512² flat-swatch PBR set for the infantry family.

The four bodies (gen_infantry.py) are flat-shaded, so each material region
is just one solid swatch — the engine's per-face lighting supplies the
shading. This writes the four maps (diffuse sRGB, ORM linear, emissive,
team R-mask) by walking `infantry_layout.SWATCHES`. Each cell is filled a
hair larger than its zone rect so mip minification never bleeds a
neighbour's colour into a face.

Usage: python3 paint_infantry.py   (then `node encode.mjs fable_infantry`)
"""
from __future__ import annotations
from PIL import Image, ImageDraw, ImageFilter

import infantry_layout as L

W = L.ATLAS
TEX_STEM = 'fable_infantry'
BLEED = 5          # over-fill past the zone rect to survive mip minification


def paint_all():
    dif = Image.new('RGB', (W, W), (18, 19, 22))
    orm = Image.new('RGB', (W, W), (232, 200, 20))
    emi = Image.new('RGB', (W, W), (0, 0, 0))
    tea = Image.new('RGB', (W, W), (0, 0, 0))
    dd, od, ed, td = (ImageDraw.Draw(im) for im in (dif, orm, emi, tea))

    for sw in L.SWATCHES:
        x0, y0, x1, y1 = sw['rect']
        box = [x0 - BLEED, y0 - BLEED, x1 + BLEED, y1 + BLEED]
        dd.rectangle(box, fill=sw['dif'])
        od.rectangle(box, fill=(sw['ao'], sw['rough'], sw['metal']))
        if sw['emis']:
            ed.rectangle(box, fill=sw['emis'])
        if sw['team']:
            td.rectangle(box, fill=(255, 0, 0))

    emi = emi.filter(ImageFilter.GaussianBlur(0.5))
    import os
    os.makedirs('out', exist_ok=True)
    dif.save(f'out/{TEX_STEM}_diffuse.png')
    orm.save(f'out/{TEX_STEM}_orm.png')
    emi.save(f'out/{TEX_STEM}_emissive.png')
    tea.save(f'out/{TEX_STEM}_team.png')
    n = len(L.SWATCHES)
    n_team = sum(1 for s in L.SWATCHES if s['team'])
    print(f'[paint_infantry] {n} swatches ({n_team} team) → out/{TEX_STEM}_*.png')


if __name__ == '__main__':
    paint_all()
