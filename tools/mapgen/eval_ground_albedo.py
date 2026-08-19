#!/usr/bin/env python3
"""Compare ground-albedo delivery paths against the unquantized bake.

PLAN-maps M7d established that the SMT tile dictionary (`dxt1.cluster_tiles`)
cannot be continuous: a per-position index into a *shared* dictionary has no
per-position data to satisfy a seam with, so tile interiors come out flatter
than truth and the difference lands on the 32-elmo grid as a checkerboard.
This tool measures the proposed replacement — option A, a low-resolution
map-space albedo — against the same ground truth, so the choice is made on
numbers rather than on the argument.

Ground truth is the pre-quantization tile bake a full generator run leaves at
`$TMPDIR/<map_id>_tiles.npy` (805 MB for a 16k map). Both paths are carried
all the way to what the GPU would actually sample:

  V (shipped)  source tiles -> cluster_tiles(budget) -> DXT1 -> decode
  A (option A) source tiles -> box-downsample to R^2 -> DXT1 -> decode
                            -> bilinear upsample back to full res

Reported per path: reconstruction error against the source (channel-mean
absolute levels, plus the tail), and M7d's seam metric — the colour jump
*across* a 32-elmo tile boundary over the gradient just *inside* it, which a
continuous field gives as ~1. Both axes are measured; `seam_discontinuity()`
in dxt1.py samples the x axis only.

Usage:
  .venv/bin/python eval_ground_albedo.py $TMPDIR/skerry_reach_tiles.npy \\
      --seed 20260730 --crops 432,400,16 --crops 192,256,16
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from terragen import dxt1  # noqa: E402

TILE = 32


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# DXT1 decode (dxt1.py only encodes; both paths ship compressed, so the
# comparison has to include the codec or it flatters whichever path has more
# texels per block)
# --------------------------------------------------------------------------

def decode_dxt1(data: np.ndarray, h: int, w: int) -> np.ndarray:
    """Inverse of `dxt1.encode_dxt1` (4-colour mode, which is all it emits)."""
    bh, bw = h // 4, w // 4
    b = data.reshape(bh * bw, 8).astype(np.uint16)
    c0 = b[:, 0] | (b[:, 1] << 8)
    c1 = b[:, 2] | (b[:, 3] << 8)
    bits = (b[:, 4].astype(np.uint32)
            | (b[:, 5].astype(np.uint32) << 8)
            | (b[:, 6].astype(np.uint32) << 16)
            | (b[:, 7].astype(np.uint32) << 24))
    p0, p1 = dxt1._unpack565(c0), dxt1._unpack565(c1)
    pal = np.stack([p0, p1, (2 * p0 + p1) / 3.0, (p0 + 2 * p1) / 3.0], axis=1)
    idx = np.empty((b.shape[0], 16), dtype=np.int64)
    for k in range(16):
        idx[:, k] = (bits >> np.uint32(2 * k)) & np.uint32(3)
    texels = np.take_along_axis(pal, idx[:, :, None], axis=1)
    texels = np.clip(np.round(texels), 0, 255).astype(np.uint8)
    return (texels.reshape(bh, bw, 4, 4, 3)
            .transpose(0, 2, 1, 3, 4).reshape(h, w, 3))


def roundtrip_dxt1(img: np.ndarray) -> np.ndarray:
    h, w, _ = img.shape
    return decode_dxt1(dxt1.encode_dxt1(img), h, w)


# --------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------

class SeamAccum:
    """M7d's metric, accumulated strip-wise so a 16k map never materializes.

    Channel-mean absolute differences, matching `dxt1.seam_discontinuity` so
    the numbers are directly comparable to the ones recorded in PLAN-maps.
    """

    def __init__(self) -> None:
        self.xj = self.xg = self.zj = self.zg = 0.0
        self.xn = self.zn = 0

    def add_strip(self, strip: np.ndarray, prev_rows=None, first_rows=None) -> None:
        f = strip.astype(np.float32)
        bx = np.arange(TILE, f.shape[1], TILE)
        if bx.size:
            jump = np.abs(f[:, bx] - f[:, bx - 1]).mean()
            grad = 0.5 * (np.abs(f[:, bx - 1] - f[:, bx - 2]).mean()
                          + np.abs(f[:, bx + 1] - f[:, bx]).mean())
            n = f.shape[0] * bx.size
            self.xj += float(jump) * n
            self.xg += float(grad) * n
            self.xn += n
        if prev_rows is not None:
            a2, a1 = (r.astype(np.float32) for r in prev_rows)
            b0, b1 = (r.astype(np.float32) for r in first_rows)
            j = np.abs(b0 - a1).mean()
            g = 0.5 * (np.abs(a1 - a2).mean() + np.abs(b1 - b0).mean())
            m = f.shape[1]
            self.zj += float(j) * m
            self.zg += float(g) * m
            self.zn += m

    def result(self) -> dict:
        xj, xg = self.xj / max(self.xn, 1), self.xg / max(self.xn, 1)
        zj, zg = self.zj / max(self.zn, 1), self.zg / max(self.zn, 1)
        return {"x_jump": xj, "x_grad": xg, "x_ratio": xj / max(xg, 1e-9),
                "z_jump": zj, "z_grad": zg, "z_ratio": zj / max(zg, 1e-9)}


class ErrAccum:
    """Absolute reconstruction error vs the source, with its tail."""

    def __init__(self) -> None:
        self.sum = 0.0
        self.n = 0
        self.hist = np.zeros(256, dtype=np.int64)

    def add(self, a: np.ndarray, b: np.ndarray) -> None:
        d = np.abs(a.astype(np.int16) - b.astype(np.int16)).astype(np.uint8)
        self.sum += float(d.sum())
        self.n += d.size
        self.hist += np.bincount(d.ravel(), minlength=256)

    def result(self) -> dict:
        c = np.cumsum(self.hist)
        tot = int(c[-1])
        return {"mad": self.sum / max(self.n, 1),
                "p99": int(np.searchsorted(c, 0.99 * tot)),
                "p999": int(np.searchsorted(c, 0.999 * tot)),
                "max": int(np.flatnonzero(self.hist)[-1]),
                "frac_gt4": float(tot - int(c[4])) / max(tot, 1)}


# --------------------------------------------------------------------------
# resampling
# --------------------------------------------------------------------------

def downsample_map(tiles, side: int, R: int) -> np.ndarray:
    """Box-downsample the tiled source bake to an R x R map-space albedo."""
    W = side * TILE
    f = W // R
    if f < 1 or W % R:
        raise ValueError(f"resolution {R} does not divide {W}")
    out = np.empty((R, R, 3), dtype=np.uint8)
    k = TILE // f
    for tz in range(side):
        strip = (np.asarray(tiles[tz * side:(tz + 1) * side])
                 .transpose(1, 0, 2, 3).reshape(TILE, W, 3))
        out[tz * k:(tz + 1) * k] = (strip.reshape(k, f, R, f, 3)
                                    .astype(np.float32).mean(axis=(1, 3))
                                    .round().astype(np.uint8))
    return out


def _bilinear_coords(lo: int, hi: int, f: int, R: int):
    """align_corners=False sample coords for output texels [lo, hi)."""
    s = (np.arange(lo, hi, dtype=np.float32) + 0.5) / f - 0.5
    i0 = np.clip(np.floor(s), 0, R - 1).astype(np.int32)
    i1 = np.clip(i0 + 1, 0, R - 1)
    return i0, i1, (s - i0).astype(np.float32)


def expand_horizontal(img: np.ndarray, W: int) -> np.ndarray:
    """Bilinearly widen an R x R albedo to R x W, ready for per-strip rows."""
    R = img.shape[0]
    i0, i1, w = _bilinear_coords(0, W, W // R, R)
    w = w[None, :, None]
    return img[:, i0].astype(np.float32) * (1 - w) + img[:, i1].astype(np.float32) * w


def expand_rows(horiz: np.ndarray, z0: int, z1: int, f: int) -> np.ndarray:
    """Finish the bilinear upsample for output rows [z0, z1)."""
    R = horiz.shape[0]
    j0, j1, w = _bilinear_coords(z0, z1, f, R)
    w = w[:, None, None]
    rec = horiz[j0] * (1 - w) + horiz[j1] * w
    return np.clip(np.round(rec), 0, 255).astype(np.uint8)


def crop_optA(horiz: np.ndarray, x0: int, z0: int, n: int, f: int) -> np.ndarray:
    """Option A's reconstruction over an n x n tile window at (x0, z0).

    `horiz` is already expanded along x to full map width, so the window is a
    plain column slice — indexing it with low-res column indices silently
    lifts a different part of the map (it reads as a flat crop of the sea).
    """
    px0, pz0, pw = x0 * TILE, z0 * TILE, n * TILE
    return expand_rows(horiz[:, px0:px0 + pw], pz0, pz0 + pw, f)


# --------------------------------------------------------------------------

def evaluate(tiles_path: str, budget: int, seed: int, resolutions: list[int],
             crops: list[tuple[int, int, int]], crop_dir: str) -> dict:
    t0 = time.time()
    tiles = np.load(tiles_path, mmap_mode="r")
    N = tiles.shape[0]
    side = int(round(N ** 0.5))
    if side * side != N:
        raise ValueError(f"{N} tiles is not a square grid")
    W = side * TILE
    log(f"source: {N} tiles, {side}x{side}, {W}x{W} texels")
    out = {"source_tiles": tiles_path, "map_texels": W, "tile_grid": side,
           "budget": budget, "seed": seed}

    log("path V: clustering (this is the shipped quantizer)...")
    assignments, reps = dxt1.cluster_tiles(np.asarray(tiles), budget, seed=seed)
    reps_rt = np.stack([roundtrip_dxt1(reps[k]) for k in range(reps.shape[0])])
    assign2d = assignments.reshape(side, side)
    out["V"] = {"unique_tiles": int(reps.shape[0]),
                "smt_bytes": int(reps.shape[0] * 680)}
    log(f"  {reps.shape[0]} unique tiles, SMT {out['V']['smt_bytes'] / 1e6:.1f} MB")

    horiz, out["A"] = {}, {}
    for R in resolutions:
        horiz[R] = expand_horizontal(roundtrip_dxt1(downsample_map(tiles, side, R)), W)
        out["A"][str(R)] = {"elmos_per_texel": W // R,
                            "dxt1_bytes": R * R // 2,
                            "dxt1_bytes_with_mips": int(R * R // 2 * 4 / 3)}
        log(f"  path A{R}: {W // R} elmos/texel, "
            f"{out['A'][str(R)]['dxt1_bytes_with_mips'] / 1e6:.1f} MB with mips")

    errV, seamV, seamS = ErrAccum(), SeamAccum(), SeamAccum()
    errA = {R: ErrAccum() for R in resolutions}
    seamA = {R: SeamAccum() for R in resolutions}
    prev = {"S": None, "V": None, **{R: None for R in resolutions}}
    named = {f"{x},{z}": {} for (x, z, _) in crops}

    for tz in range(side):
        src = (np.asarray(tiles[tz * side:(tz + 1) * side])
               .transpose(1, 0, 2, 3).reshape(TILE, W, 3))
        drawn = reps_rt[assign2d[tz]].transpose(1, 0, 2, 3).reshape(TILE, W, 3)
        errV.add(src, drawn)
        seamS.add_strip(src, prev["S"], (src[0], src[1]))
        seamV.add_strip(drawn, prev["V"], (drawn[0], drawn[1]))
        prev["S"] = (src[TILE - 2], src[TILE - 1])
        prev["V"] = (drawn[TILE - 2], drawn[TILE - 1])

        recon = {}
        for R in resolutions:
            rec = expand_rows(horiz[R], tz * TILE, (tz + 1) * TILE, W // R)
            recon[R] = rec
            errA[R].add(src, rec)
            seamA[R].add_strip(rec, prev[R], (rec[0], rec[1]))
            prev[R] = (rec[TILE - 2], rec[TILE - 1])

        for (bx, bz, bn) in crops:
            if bz <= tz < bz + bn:
                d = named[f"{bx},{bz}"]
                sl = slice(bx * TILE, (bx + bn) * TILE)
                for label, fld in (("source", src), ("V", drawn),
                                   *[(f"A{R}", recon[R]) for R in resolutions]):
                    d.setdefault(label, SeamAccum()).add_strip(fld[:, sl])
        if tz % 64 == 0:
            log(f"  scan {tz}/{side}")

    out["V"]["err"], out["V"]["seam"] = errV.result(), seamV.result()
    out["source_seam"] = seamS.result()
    for R in resolutions:
        out["A"][str(R)]["err"] = errA[R].result()
        out["A"][str(R)]["seam"] = seamA[R].result()
    out["crop_seams"] = {k: {lab: sa.result() for lab, sa in v.items()}
                         for k, v in named.items()}

    if crop_dir and crops:
        _write_crops(tiles, side, reps_rt, assign2d, horiz, resolutions,
                     crops, crop_dir)
        out["crop_dir"] = crop_dir
    out["elapsed_s"] = time.time() - t0
    return out


def _write_crops(tiles, side, reps_rt, assign2d, horiz, resolutions,
                 crops, crop_dir) -> None:
    """Dump source / V / A crops, plus 1-99% contrast stretches.

    The stretch is not decoration: the defect is a ~3-level checkerboard on a
    field whose whole range is ~60 levels, so a raw crop can hide it.
    """
    from PIL import Image  # noqa: PLC0415 — optional, only for --crops
    os.makedirs(crop_dir, exist_ok=True)
    W = side * TILE
    for (bx, bz, bn) in crops:
        pw = bn * TILE
        src = np.empty((pw, pw, 3), dtype=np.uint8)
        drw = np.empty((pw, pw, 3), dtype=np.uint8)
        for i, tz in enumerate(range(bz, bz + bn)):
            row = np.asarray(tiles[tz * side + bx: tz * side + bx + bn])
            src[i * TILE:(i + 1) * TILE] = row.transpose(1, 0, 2, 3).reshape(TILE, pw, 3)
            drw[i * TILE:(i + 1) * TILE] = (reps_rt[assign2d[tz, bx:bx + bn]]
                                            .transpose(1, 0, 2, 3).reshape(TILE, pw, 3))
        fields = [("source", src), ("shipped_vq", drw)]
        for R in resolutions:
            fields.append((f"optA_{R}", crop_optA(horiz[R], bx, bz, bn, W // R)))
        for label, img in fields:
            Image.fromarray(img).save(f"{crop_dir}/{bx}_{bz}_{label}.png")
            g = img.astype(np.float32).mean(axis=2)
            lo, hi = np.percentile(g, [1, 99])
            st = np.clip((g - lo) / max(hi - lo, 1e-6), 0, 1) * 255
            Image.fromarray(st.astype(np.uint8)).save(
                f"{crop_dir}/{bx}_{bz}_{label}_stretch.png")
            print(f"  crop {bx},{bz} {label:12s} lum mean {g.mean():6.2f} "
                  f"std {g.std():5.2f}", file=sys.stderr)


def _crop_arg(s: str) -> tuple[int, int, int]:
    parts = s.split(",")
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("--crops wants tileX,tileZ,tiles")
    return tuple(int(p) for p in parts)  # type: ignore[return-value]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tiles", help="path to <map_id>_tiles.npy from a full run")
    ap.add_argument("--budget", type=int, default=12288)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--resolutions", default="1024,2048,4096")
    ap.add_argument("--crops", type=_crop_arg, action="append", default=[],
                    metavar="X,Z,N", help="tile-space crop to render (repeatable)")
    ap.add_argument("--crop-dir", default="")
    ap.add_argument("--json", default="", help="write results here (default stdout)")
    a = ap.parse_args()

    res = evaluate(a.tiles, a.budget, a.seed,
                   [int(r) for r in a.resolutions.split(",")],
                   a.crops, a.crop_dir)
    text = json.dumps(res, indent=2)
    if a.json:
        with open(a.json, "w") as f:
            f.write(text + "\n")
        log(f"wrote {a.json}")
    else:
        print(text)

    v = res["V"]
    print(f"\n  shipped VQ   err {v['err']['mad']:.2f} levels   "
          f"seam ratio {v['seam']['x_ratio']:.2f}   "
          f"{v['smt_bytes'] / 1e6:.1f} MB", file=sys.stderr)
    for R, d in res["A"].items():
        print(f"  option A {R:>4}  err {d['err']['mad']:.2f} levels   "
              f"seam ratio {d['seam']['x_ratio']:.2f}   "
              f"{d['dxt1_bytes_with_mips'] / 1e6:.1f} MB", file=sys.stderr)
    print(f"  source       err 0.00 levels   "
          f"seam ratio {res['source_seam']['x_ratio']:.2f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
