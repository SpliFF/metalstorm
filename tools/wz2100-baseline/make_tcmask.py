#!/usr/bin/env python3
"""make_tcmask.py — author the team-colour masks for the WZ2100 baseline vehicles.

Why this exists
---------------
`wz_building` (blhq) is PIE4 and ships a `TCMASK` directive, so it team-tints
straight out of the importer. The vehicles do not:

* `drlbod01` / `drhbod09` (the Viper and heavy hulls) are `TYPE 200` — no TCMASK
  flag at all, and the stock `page-14_tcmask.png` has **zero** coverage over the
  UV islands those hulls use;
* the prop/weapon parts *are* flagged (`TYPE 10200` → `iV_IMD_TCMASK`), but
  upstream `page-17_tcmask.png` (weapons) is **entirely black**, and
  `page-16_tcmask.png` (drives) only covers the Viper's wheels.

So the mask cannot be recovered from upstream — it has to be authored. This
script authors it, deterministically, from the geometry the `.pie` parts already
carry: for each selected part it rasterises the UV footprint of every triangle
whose face normal points upward, which is exactly the surface an RTS camera
sees. The result is one mask page per diffuse page, in the diffuse page's own UV
space, so it drops into the existing `*_tcmask` pipeline unchanged
(`.wzasm` `tcmask` map → PIEImporter → modelimporter post-fix →
`SPRINGRTS_team_color.maskTexture` → the renderer's TeamColorPlugin).

The mask value is a blend amount, not a colour: the shader does
`mix(albedo, teamColor, mask.r)`. `STRENGTH` below is deliberately short of 1.0
so the WZ page's panel lines and shading survive under the tint.

Usage
-----
    python3 tools/wz2100-baseline/make_tcmask.py          # write texpages/*_ms_tcmask.png
    python3 tools/wz2100-baseline/make_tcmask.py --report # + coverage stats, no write

`build.sh` bakes whatever lands in `texpages/` to KTX2, and its `*_tcmask` case
already picks the linear transfer function these masks need.
"""

import argparse
import json
import math
import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - operator-facing
    sys.exit("error: Pillow required — pip install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
PIE_DIR = os.path.join(HERE, "pie")
TEX_DIR = os.path.join(HERE, "texpages")

# Assemblies whose parts get an authored mask, and which of their part nodes
# take it. Tracks and wheels are deliberately excluded — they read as dark
# rubber/steel, and tinting them costs the silhouette its contrast.
ASSEMBLIES = ["wz_tank.wzasm", "wz_wheeled.wzasm"]
TEAM_NODES = {"body", "turret"}

# A triangle is team-coloured when its face normal points up by at least this
# much. 0.1 takes the deck, the glacis and the sloped upper side panels while
# leaving the vertical flanks and the whole underside alone.
UP_MIN = 0.1

# Blend amount written into the mask (0..1). Below 1.0 so the diffuse page's
# panel detail still reads through the team colour.
STRENGTH = 0.8

# Mask page resolution. Independent of the diffuse page (it is a separate
# texture sampled with the same UVs), but matching it keeps texel density sane.
SIZE = 1024

# Grow the rasterised footprint by this many texels. UV islands on the WZ pages
# are padded, so a single texel closes bilinear/mip seams at island edges
# without bleeding onto a neighbouring island.
DILATE = 1

# Authored mask pages are named after the diffuse page they mask, with an `_ms`
# marker so they never collide with (or get mistaken for) the upstream GPL
# `page-N_tcmask.png` art. The `_tcmask` tail is load-bearing: build.sh keys the
# linear transfer function off it, and modelimporter's post-fix keys the
# `SPRINGRTS_team_color` relocation off it.
def mask_name_for(page):
    return os.path.splitext(page)[0] + "_ms_tcmask.png"


def parse_pie(path):
    """Return (texture page, [(positions, uvs), ...]) for LEVEL 1 of a .pie.

    UVs come out normalised: PIE2 stores them in the declared page's pixel
    space, PIE3+ already normalised — the same rule PIEImporter applies.
    """
    lines = open(path).read().split("\n")
    i, tex, dims, ver, points = 0, None, (256.0, 256.0), 2, []
    while i < len(lines):
        t = lines[i].split()
        if not t:
            i += 1
            continue
        kw = t[0].upper()
        if kw == "PIE":
            ver = int(t[1])
        elif kw == "TEXTURE":
            tex = t[2]
            if len(t) >= 5 and float(t[3]) > 0:
                dims = (float(t[3]), float(t[4]))
        elif kw == "POINTS":
            n = int(t[1])
            points = [tuple(map(float, lines[i + 1 + k].split()[:3])) for k in range(n)]
            i += n
        elif kw == "NORMALS":
            i += int(t[1])
        elif kw == "POLYGONS":
            n, tris = int(t[1]), []
            for _ in range(n):
                i += 1
                f = lines[i].split()
                npts = int(f[1])
                idx = [int(x) for x in f[2:2 + npts]]
                raw = [float(x) for x in f[2 + npts:2 + npts * 3]]
                uvs = []
                for j in range(npts):
                    u, v = raw[2 * j], raw[2 * j + 1]
                    if ver <= 2:
                        u /= dims[0]
                        v /= dims[1]
                    uvs.append((u, v))
                # Fan-triangulate, same as the importer.
                for k in range(1, npts - 1):
                    tris.append((
                        [points[idx[0]], points[idx[k]], points[idx[k + 1]]],
                        [uvs[0], uvs[k], uvs[k + 1]],
                    ))
            return tex, tris
        i += 1
    return tex, []


def face_normal(p):
    a, b, c = p
    u = [b[j] - a[j] for j in range(3)]
    v = [c[j] - a[j] for j in range(3)]
    n = [u[1] * v[2] - u[2] * v[1],
         u[2] * v[0] - u[0] * v[2],
         u[0] * v[1] - u[1] * v[0]]
    m = math.sqrt(sum(x * x for x in n)) or 1.0
    return [x / m for x in n]


def raster_tri(buf, uv, value, size=SIZE):
    """Fill one UV triangle into a bytearray mask, keeping the brightest value.

    Image row 0 is V=0: the `.pie` UV origin is top-left, and both the diffuse
    page and this mask are baked by the same toktx call, so writing the mask in
    the diffuse page's own orientation is what makes them line up.
    """
    xs = [u * size for u, _ in uv]
    ys = [v * size for _, v in uv]
    x0 = max(0, int(math.floor(min(xs))))
    x1 = min(size - 1, int(math.ceil(max(xs))))
    y0 = max(0, int(math.floor(min(ys))))
    y1 = min(size - 1, int(math.ceil(max(ys))))
    ax, ay = xs[0], ys[0]
    bx, by = xs[1], ys[1]
    cx, cy = xs[2], ys[2]
    det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(det) < 1e-9:
        return 0
    painted = 0
    for py in range(y0, y1 + 1):
        for px in range(x0, x1 + 1):
            fx, fy = px + 0.5, py + 0.5
            l0 = ((by - cy) * (fx - cx) + (cx - bx) * (fy - cy)) / det
            l1 = ((cy - ay) * (fx - cx) + (ax - cx) * (fy - cy)) / det
            l2 = 1.0 - l0 - l1
            if l0 < -1e-4 or l1 < -1e-4 or l2 < -1e-4:
                continue
            o = py * size + px
            if buf[o] < value:
                buf[o] = value
                painted += 1
    return painted


def dilate(buf, size=SIZE, rounds=DILATE):
    for _ in range(rounds):
        src = bytes(buf)
        for y in range(size):
            row = y * size
            for x in range(size):
                if src[row + x]:
                    continue
                best = 0
                for dy in (-1, 0, 1):
                    yy = y + dy
                    if yy < 0 or yy >= size:
                        continue
                    for dx in (-1, 0, 1):
                        xx = x + dx
                        if 0 <= xx < size:
                            v = src[yy * size + xx]
                            if v > best:
                                best = v
                if best:
                    buf[row + x] = best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true",
                    help="print coverage stats and write nothing")
    args = ap.parse_args()

    value = max(0, min(255, round(STRENGTH * 255)))
    pages = {}      # diffuse page -> mask bytearray
    stats = []

    for wzasm in ASSEMBLIES:
        spec = json.load(open(os.path.join(HERE, wzasm)))
        pie_dir = os.path.join(HERE, spec.get("pie_dir", "pie"))
        for part in spec["parts"]:
            if part.get("node") not in TEAM_NODES:
                continue
            tex, tris = parse_pie(os.path.join(pie_dir, part["pie"]))
            if not tex:
                continue
            buf = pages.setdefault(tex, bytearray(SIZE * SIZE))
            picked = painted = 0
            for pos, uv in tris:
                if face_normal(pos)[1] < UP_MIN:
                    continue
                picked += 1
                painted += raster_tri(buf, uv, value)
            stats.append((spec["name"], part["node"], part["pie"], tex,
                          picked, len(tris), painted))

    if not pages:
        sys.exit("error: no parts selected — check ASSEMBLIES / TEAM_NODES")

    for name, node, pie, tex, picked, total, painted in stats:
        print(f"  {name:11s} {node:7s} {pie:14s} -> {tex:24s} "
              f"{picked}/{total} tris, {painted} texels")

    if args.report:
        for tex, buf in sorted(pages.items()):
            nz = sum(1 for b in buf if b)
            print(f"  {mask_name_for(tex):38s} coverage {100.0 * nz / (SIZE * SIZE):5.2f}%")
        return

    os.makedirs(TEX_DIR, exist_ok=True)
    for tex, buf in sorted(pages.items()):
        dilate(buf)
        img = Image.frombytes("L", (SIZE, SIZE), bytes(buf)).convert("RGBA")
        out = os.path.join(TEX_DIR, mask_name_for(tex))
        img.save(out)
        nz = sum(1 for b in buf if b)
        print(f"wrote {out} ({100.0 * nz / (SIZE * SIZE):.2f}% coverage)")


if __name__ == "__main__":
    main()
