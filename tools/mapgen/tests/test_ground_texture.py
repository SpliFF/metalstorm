#!/usr/bin/env python3
"""Tests for the map-space ground albedo (PLAN-maps §2n ruling 1, M7f option A).

    python3 -m unittest discover -s tools/mapgen/tests

M7f priced the delivery paths and the user ruled in option A at 2048², opt-in
per map. This suite pins the three things the ruling turns into code:

  * the reduction is an exact BOX average of the same full-resolution bake the
    SMT dictionary is clustered from — not a resample of the quantized tiles,
    which is the mistake that would silently ship the VQ error the whole
    exercise exists to remove;
  * no output texel straddles a tile boundary (the factor divides 32), which
    is what makes "the two paths carry the same pixels" true rather than
    approximately true;
  * the opt-in is real in both directions — a package that does not ask for a
    ground texture declares no `groundtex` and ships no file, so a real Spring
    map's exactly-deduped SMT is never displaced.

Synthetic tiles only, for test_tile_quantization.py's reason: `data/maps/` is
gitignored, so a clone has no real map to bake.
"""

import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from terragen import bake as bk        # noqa: E402
from terragen import package as pkg    # noqa: E402


def synth_tiles(tiles_x: int, tiles_z: int, seed: int = 7) -> np.ndarray:
    """(N, 32, 32, 3) tile-major bake of a smooth field + fine grain — the
    shape `bake.bake_tiles` produces."""
    rng = np.random.RandomState(seed)
    full = tiles_x * 32
    y, x = np.mgrid[0:full, 0:full].astype(np.float32)
    field = (110 + 60 * np.sin(x / 700.0) * np.cos(y / 520.0))[..., None]
    img = np.clip(field + rng.normal(0, 6, (full, full, 3)), 0, 255).astype(np.uint8)
    return (img.reshape(tiles_z, 32, tiles_x, 32, 3)
               .transpose(0, 2, 1, 3, 4)
               .reshape(tiles_z * tiles_x, 32, 32, 3)), img


class GroundTextureReduction(unittest.TestCase):
    def test_shape_and_dtype(self):
        tiles, _ = synth_tiles(8, 8)
        out = bk.ground_texture_from_tiles(tiles, 8, 8, 64)
        self.assertEqual(out.shape, (64, 64, 3))
        self.assertEqual(out.dtype, np.uint8)

    def test_is_an_exact_box_average_of_the_source_bake(self):
        """The whole claim of option A is that it delivers the SAME pixels at a
        lower resolution. Checked against a straight box mean of the full-res
        image the tiles were cut from — no tolerance beyond the 8-bit rounding
        the output format itself imposes."""
        tiles, img = synth_tiles(8, 8)
        size, full = 64, 256
        f = full // size
        want = np.rint(img.reshape(size, f, size, f, 3).mean(axis=(1, 3)))
        got = bk.ground_texture_from_tiles(tiles, 8, 8, size).astype(np.float64)
        self.assertLessEqual(float(np.abs(got - want).max()), 0.0)

    def test_reduction_never_straddles_a_tile(self):
        """A factor that does not divide 32 would average across a tile seam,
        which is exactly the coupling the SMT path has and this one does not.
        Rejected loudly rather than silently approximated."""
        tiles, _ = synth_tiles(8, 8)
        with self.assertRaises(ValueError):
            bk.ground_texture_from_tiles(tiles, 8, 8, 4)     # 64x reduction
        with self.assertRaises(ValueError):
            bk.ground_texture_from_tiles(tiles, 8, 8, 100)   # not a divisor
        with self.assertRaises(ValueError):
            bk.ground_texture_from_tiles(tiles, 8, 8, 0)

    def test_position_is_preserved(self):
        """A transpose bug here reads as a plausible terrain (M7f's crop trap),
        so the corners are checked against the source's own corners."""
        tiles, img = synth_tiles(8, 8)
        out = bk.ground_texture_from_tiles(tiles, 8, 8, 64)
        for (oy, ox) in ((0, 0), (0, 63), (63, 0), (63, 63)):
            want = np.rint(img[oy * 4:oy * 4 + 4, ox * 4:ox * 4 + 4]
                           .mean(axis=(0, 1)))
            self.assertTrue(np.array_equal(out[oy, ox].astype(np.float64), want),
                            f"corner ({oy},{ox}) moved")

    def test_a_low_resolution_delivery_is_continuous_across_tile_seams(self):
        """The defect M7f measured: the tile dictionary's seam jump is many
        times the interior gradient. The map-space texture has no tile grid at
        all, so on a smooth field its 32-elmo-boundary jump is the same size as
        the gradient beside it."""
        tiles, _ = synth_tiles(16, 16, seed=3)
        out = bk.ground_texture_from_tiles(tiles, 16, 16, 128).astype(np.float32)
        # The BILINEAR reconstruction is what the GPU samples, and it is the
        # half that buys the continuity: a nearest upsample would put the whole
        # first difference on one column and read like a seam. Metric taken on
        # 32-texel (one-tile) boundaries, as `dxt1.seam_discontinuity` does.
        from PIL import Image
        up = np.asarray(Image.fromarray(out.astype(np.uint8)).resize(
            (512, 512), Image.BILINEAR), dtype=np.float32)
        bx = np.arange(32, up.shape[1], 32)
        jump = np.abs(up[:, bx] - up[:, bx - 1]).mean()
        grad = 0.5 * (np.abs(up[:, bx - 1] - up[:, bx - 2]).mean()
                      + np.abs(up[:, bx + 1] - up[:, bx]).mean())
        self.assertLess(jump, max(grad, 0.5) * 2.0,
                        f"seam jump {jump:.3f} vs interior gradient {grad:.3f}")


class GroundTextureOptIn(unittest.TestCase):
    def test_mapinfo_declares_groundtex_only_when_asked(self):
        on = pkg.emit_mapinfo(pkg.MapPackageConfig(
            map_id="m", display_name="M", ground_texture_size=2048))
        off = pkg.emit_mapinfo(pkg.MapPackageConfig(map_id="m", display_name="M"))
        self.assertIn('groundtex = "ground.png"', on)
        self.assertNotIn("groundtex", off)
        # the splat resources are untouched either way
        for s in (on, off):
            self.assertIn('splatdistrtex = "splat_distr.png"', s)

    def test_default_is_off_so_nothing_is_retrofitted(self):
        self.assertEqual(pkg.MapPackageConfig(map_id="m", display_name="M")
                         .ground_texture_size, 0)


class GroundTextureFileEmission(unittest.TestCase):
    """`write_package`'s ground-texture branch, driven on a tiny synthetic map:
    the file lands beside the SMT (which is still written) or does not exist."""

    def _write(self, size: int, out_dir: str) -> None:
        n = 65                       # 64 cells * 32 elmos = 2048-elmo map
        cell = 32.0
        rng = np.random.RandomState(11)
        h = (20 + 4 * np.sin(np.mgrid[0:n, 0:n][0] / 5.0)).astype(np.float32)
        slope = np.zeros((n, n), np.float32)
        biome = np.zeros((n, n), np.int32)
        moist = np.full((n, n), 0.4, np.float32)
        rdist = np.full((n, n), 1e6, np.float32)
        rmask = np.zeros((n, n), np.uint8)
        del rng
        with tempfile.TemporaryDirectory() as scratch:
            pkg.write_package(
                out_dir,
                pkg.MapPackageConfig(map_id="t", display_name="T",
                                     tile_budget=64, seed=5,
                                     ground_texture_size=size),
                h, slope, biome, moist, rdist, rmask, cell,
                scratch_dir=scratch, progress=lambda *a, **k: None)

    def test_ships_a_square_texture_at_the_requested_size(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as out:
            self._write(64, out)
            p = os.path.join(out, "maps", "ground.png")
            self.assertTrue(os.path.exists(p))
            with Image.open(p) as im:
                self.assertEqual(im.size, (64, 64))
            # the SMT is still written: it is the SMF's own format, and a
            # client that never learns about ground.png still renders the map
            self.assertTrue(os.path.exists(os.path.join(out, "maps", "t.smt")))
            self.assertIn("groundtex",
                          open(os.path.join(out, "mapinfo.lua")).read())

    def test_no_file_and_no_declaration_when_off(self):
        with tempfile.TemporaryDirectory() as out:
            self._write(0, out)
            self.assertFalse(os.path.exists(os.path.join(out, "maps", "ground.png")))
            self.assertNotIn("groundtex",
                             open(os.path.join(out, "mapinfo.lua")).read())

    def test_oversized_request_ships_lossless_not_an_error(self):
        """The default request (4096 since the M8 streaming-v2 resolution
        raise) exceeds this 2048-texel bake: the package must clamp to the
        bake's own resolution and ship, not die in ground_texture_from_tiles'
        divisibility gate."""
        from PIL import Image
        with tempfile.TemporaryDirectory() as out:
            self._write(bk.GROUND_TEXTURE_SIZE_DEFAULT, out)
            p = os.path.join(out, "maps", "ground.png")
            self.assertTrue(os.path.exists(p))
            with Image.open(p) as im:
                self.assertEqual(im.size, (2048, 2048))   # bake edge, lossless


class GroundTextureSizeFor(unittest.TestCase):
    """`ground_texture_size_for` — the request-to-valid-edge rounding that
    makes the configured size a REQUEST rather than a constraint the caller
    has to know the bake geometry to satisfy (M8 streaming v2 step 4: the
    default rose to 4096, and small maps must keep shipping)."""

    def test_exact_sizes_pass_through(self):
        for size in (16384, 8192, 4096, 2048, 1024, 512):
            self.assertEqual(bk.ground_texture_size_for(size, 16384), size)

    def test_between_two_valid_edges_rounds_down(self):
        # never finer than asked: 3000 on a 16384 bake -> 2048, not 4096
        self.assertEqual(bk.ground_texture_size_for(3000, 16384), 2048)

    def test_at_or_above_the_bake_is_lossless(self):
        self.assertEqual(bk.ground_texture_size_for(16384, 16384), 16384)
        self.assertEqual(bk.ground_texture_size_for(99999, 16384), 16384)

    def test_below_the_coarsest_reduction_returns_the_coarsest(self):
        # 32x is the hardest reduction the 32-texel tile can express
        self.assertEqual(bk.ground_texture_size_for(100, 16384), 512)

    def test_nonpositive_request_is_loud(self):
        with self.assertRaises(ValueError):
            bk.ground_texture_size_for(0, 16384)

    def test_default_reaches_finer_pages_than_the_ruling_measured(self):
        """The raise itself, pinned: on a 16 384-elmo map the default source
        now carries 4 elmos/texel (page pyramid level 2), where the §2n
        ruling's 2048 stopped at 8 (level 3). A future default change should
        have to look at this."""
        self.assertEqual(bk.GROUND_TEXTURE_SIZE_DEFAULT, 4096)
        self.assertEqual(
            bk.ground_texture_size_for(bk.GROUND_TEXTURE_SIZE_DEFAULT, 16384),
            4096)


if __name__ == "__main__":
    unittest.main()
