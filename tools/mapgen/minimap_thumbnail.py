#!/usr/bin/env python3
"""
minimap_thumbnail.py — produce the `minimap.png` the lobby map card needs.

The lobby's `/api/maps/thumb/<id>` route (rts/Server/GameHttpRoutes.cpp) walks
the map directory for a file whose NAME CONTAINS "minimap" with a `.png`/`.jpg`
extension. It does not look at `.ktx2`. Every processed map ships
`minimap.ktx2` and most ship nothing else, so those maps 404 their thumbnail and
render an empty card — the map is fine, only the card is blank.

This regenerates the PNG from that same `minimap.ktx2`, so the card shows the
real minimap rather than a substitute rendered from the heightmap.

Two wrinkles worth knowing:

* The KTX2 files are UASTC + zstd with `vkFormat = 0`, and their
  `KTXorientation` value is written in the KTX1 style (`S=r,T=d`) where KTX2
  wants `rd`. `ktx extract` rejects them outright on that metadata alone;
  `basisu -unpack` ignores key/value data and reads them fine, so that is what
  this uses. The malformed metadata is a real (harmless-to-Babylon) defect in
  whatever writes these files.
* An SMF minimap is always square with the map stretched to fill it, so for a
  non-square map the raw image is distorted. Output is resized to the map's true
  aspect ratio (long edge 1024) rather than kept square, which is what makes a
  1:2 map like techno_lands read correctly on the card.

Usage:
    minimap_thumbnail.py <map-dir> [<map-dir> ...] [--size 1024] [--force]
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

# basisu emits one PNG per transcode target; these are the RGB outputs worth
# having, best first. BC7 and ASTC are the high-quality targets.
PREFERRED = [
    "minimap_unpacked_rgb_BC7_RGBA_level_0_face_0_layer_0000.png",
    "minimap_unpacked_rgb_ASTC_LDR_4X4_RGBA_level_0_face_0_layer_0000.png",
    "minimap_unpacked_rgb_BC1_RGB_level_0_face_0_layer_0000.png",
    "minimap_unpacked_rgb_ETC2_RGBA_level_0_face_0_layer_0000.png",
]


def map_aspect(map_dir: str):
    """(w, h) in map squares, from the DB if reachable, else the mapinfo."""
    map_id = os.path.basename(map_dir.rstrip("/"))
    repo_root = os.path.abspath(os.path.join(map_dir, "..", "..", ".."))
    db = os.path.join(repo_root, "data", "spring-server.db")
    if os.path.exists(db):
        try:
            import sqlite3
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            row = con.execute(
                "select mapx, mapy from maps where id = ?", (map_id,)).fetchone()
            con.close()
            if row and row[0] and row[1]:
                return int(row[0]), int(row[1])
        except Exception:
            pass
    info = os.path.join(map_dir, "mapinfo.lua")
    if os.path.exists(info):
        text = open(info, encoding="utf-8", errors="replace").read()
        mx = re.search(r"\bmapx\s*=\s*(\d+)", text)
        my = re.search(r"\bmapy\s*=\s*(\d+)", text)
        if mx and my:
            return int(mx.group(1)), int(my.group(1))
    return None


def unpack_minimap(ktx2: str, workdir: str):
    """basisu-unpack a minimap.ktx2 and return the best level-0 RGB PNG."""
    res = subprocess.run(
        ["basisu", "-unpack", "-file", os.path.abspath(ktx2)],
        cwd=workdir, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"basisu failed: {res.stderr.strip()[:400]}")
    for name in PREFERRED:
        p = os.path.join(workdir, name)
        if os.path.exists(p):
            return p
    hits = sorted(glob.glob(os.path.join(workdir, "*rgb*level_0*.png")))
    if hits:
        return hits[0]
    raise RuntimeError("basisu produced no level-0 RGB output")


def build(map_dir: str, size: int, force: bool) -> str | None:
    map_dir = os.path.abspath(map_dir.rstrip("/"))
    map_id = os.path.basename(map_dir)
    out = os.path.join(map_dir, "minimap.png")

    existing = [p for p in glob.glob(os.path.join(map_dir, "**", "*"), recursive=True)
                if "minimap" in os.path.basename(p).lower()
                and os.path.splitext(p)[1].lower() in (".png", ".jpg")]
    if existing and not force:
        print(f"{map_id}: already servable ({os.path.relpath(existing[0], map_dir)}) — skipped")
        return None

    ktx2 = os.path.join(map_dir, "minimap.ktx2")
    if not os.path.exists(ktx2):
        print(f"{map_id}: no minimap.ktx2 — cannot build a thumbnail")
        return None

    from PIL import Image
    work = tempfile.mkdtemp(prefix="minimap-")
    try:
        src = unpack_minimap(ktx2, work)
        im = Image.open(src).convert("RGB")
        w, h = im.size
        aspect = map_aspect(map_dir)
        if aspect:
            mx, my = aspect
            if mx >= my:
                tw, th = size, max(1, round(size * my / mx))
            else:
                tw, th = max(1, round(size * mx / my)), size
        else:
            tw = th = size
        im = im.resize((tw, th), Image.LANCZOS)
        im.save(out, "PNG", optimize=True)
        print(f"{map_id}: {w}x{h} ktx2 -> {tw}x{th} minimap.png "
              f"({os.path.getsize(out) // 1024} KiB)")
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map_dirs", nargs="+")
    ap.add_argument("--size", type=int, default=1024,
                    help="long edge in pixels (default 1024, matching the "
                         "square SMF minimaps already in the tree)")
    ap.add_argument("--force", action="store_true",
                    help="rebuild even when a servable thumbnail already exists")
    args = ap.parse_args(argv)
    for d in args.map_dirs:
        try:
            build(d, args.size, args.force)
        except Exception as e:
            print(f"{os.path.basename(d.rstrip('/'))}: FAILED — {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
