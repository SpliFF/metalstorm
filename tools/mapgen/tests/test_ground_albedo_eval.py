"""Tests for eval_ground_albedo.py — the harness that decided PLAN-maps M7d.

The failure mode this guards is the same one M7e found in `--selftest`: a
comparison harness that cannot distinguish the two things it compares still
prints numbers. So every metric here gets a positive control (a field that
must score badly) alongside the negative one.
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import eval_ground_albedo as ev  # noqa: E402
from terragen import dxt1  # noqa: E402

TILE = ev.TILE


class TestDxt1Decode(unittest.TestCase):
    """The comparison includes the codec, so the decoder has to be real."""

    def test_flat_block_survives_565_and_nothing_more(self):
        flat = np.full((16, 16, 3), 77, np.uint8)
        rt = ev.roundtrip_dxt1(flat)
        # 77 -> 5-bit red/blue: (77>>3)*255/31 = 74.03 -> 74, i.e. 3 levels.
        self.assertLessEqual(int(np.abs(rt.astype(int) - 77).max()), 3)
        self.assertEqual(rt.shape, flat.shape)

    def test_gradient_roundtrip_is_close(self):
        g = np.tile(np.linspace(40, 200, 64, dtype=np.float32)[None, :, None],
                    (64, 1, 3)).astype(np.uint8)
        rt = ev.roundtrip_dxt1(g)
        self.assertLess(float(np.abs(rt.astype(int) - g.astype(int)).mean()), 3.0)

    def test_decode_inverts_a_known_encode(self):
        rng = np.random.default_rng(3)
        img = (rng.random((32, 32, 3)) * 60 + 90).astype(np.uint8)
        once = ev.roundtrip_dxt1(img)
        twice = ev.roundtrip_dxt1(once)
        # A decoded block is already representable, so re-encoding is a no-op.
        # If decode were wrong this would keep drifting.
        self.assertLessEqual(int(np.abs(once.astype(int) - twice.astype(int)).max()), 1)


class TestSeamAccum(unittest.TestCase):
    """M7d's metric: jump across a 32-texel boundary / gradient inside it."""

    @staticmethod
    def _ratio(field: np.ndarray) -> float:
        acc = ev.SeamAccum()
        prev = None
        for z in range(0, field.shape[0], TILE):
            strip = field[z:z + TILE]
            acc.add_strip(strip, prev, (strip[0], strip[1]))
            prev = (strip[TILE - 2], strip[TILE - 1])
        return acc.result()["x_ratio"]

    def test_continuous_ramp_reads_about_one(self):
        # exactly one level per texel, so uint8 rounding adds no staircase of
        # its own — a ramp of 0.78 levels/texel reads 1.4 purely from rounding
        w = 256
        ramp = np.arange(w, dtype=np.float32)
        field = np.repeat(np.tile(ramp[None, :], (w, 1))[:, :, None], 3, axis=2)
        self.assertAlmostEqual(self._ratio(field.astype(np.uint8)), 1.0, delta=0.05)

    def test_tile_quantized_field_reads_far_above_one(self):
        """Positive control: flatten each tile's interior and the metric must
        catch it. This is exactly what cluster_tiles does to the bake."""
        w = 256
        ramp = np.arange(w, dtype=np.float32)
        field = np.repeat(np.tile(ramp[None, :], (w, 1))[:, :, None], 3, axis=2)
        blocky = field.reshape(w // TILE, TILE, w // TILE, TILE, 3)
        blocky = np.repeat(np.repeat(
            blocky.mean(axis=(1, 3))[:, None, :, None, :], TILE, axis=1),
            TILE, axis=3).reshape(w, w, 3)
        self.assertGreater(self._ratio(blocky.astype(np.uint8)), 8.0)

    def test_both_axes_are_measured(self):
        """dxt1.seam_discontinuity samples x only; a z-only defect must not
        read as clean here."""
        w = TILE * 8
        field = np.zeros((w, w, 3), dtype=np.uint8)
        for z in range(0, w, TILE):
            field[z:z + TILE] = 40 + (z // TILE) * 12
        acc = ev.SeamAccum()
        prev = None
        for z in range(0, w, TILE):
            strip = field[z:z + TILE]
            acc.add_strip(strip, prev, (strip[0], strip[1]))
            prev = (strip[TILE - 2], strip[TILE - 1])
        r = acc.result()
        self.assertEqual(r["x_jump"], 0.0)
        self.assertGreater(r["z_jump"], 5.0)


class TestResample(unittest.TestCase):

    def test_downsample_then_upsample_recovers_a_smooth_field(self):
        side, R = 4, 32          # 4x4 tiles = 128 texels -> 32 (4 texels/texel)
        w = side * TILE
        yy, xx = np.mgrid[0:w, 0:w].astype(np.float32)
        field = (100 + 40 * np.sin(xx / 60.0) + 30 * np.cos(yy / 70.0))
        field = np.repeat(field[:, :, None], 3, axis=2).astype(np.uint8)
        tiles = (field.reshape(side, TILE, side, TILE, 3)
                 .transpose(0, 2, 1, 3, 4).reshape(side * side, TILE, TILE, 3))
        lo = ev.downsample_map(tiles, side, R)
        self.assertEqual(lo.shape, (R, R, 3))
        horiz = ev.expand_horizontal(lo, w)
        rec = np.concatenate([ev.expand_rows(horiz, z, z + TILE, w // R)
                              for z in range(0, w, TILE)], axis=0)
        self.assertEqual(rec.shape, field.shape)
        self.assertLess(float(np.abs(rec.astype(int) - field.astype(int)).mean()), 2.0)

    def test_upsample_is_seamless_on_the_tile_grid(self):
        """The whole point of option A: continuity is by construction, so a
        reconstruction must not know where the 32-elmo boundaries are."""
        side, R = 8, 64
        w = side * TILE
        rng = np.random.default_rng(11)
        lo = (rng.random((R, R, 3)) * 80 + 80).astype(np.uint8)
        horiz = ev.expand_horizontal(lo, w)
        acc = ev.SeamAccum()
        prev = None
        for z in range(0, w, TILE):
            strip = ev.expand_rows(horiz, z, z + TILE, w // R)
            acc.add_strip(strip, prev, (strip[0], strip[1]))
            prev = (strip[TILE - 2], strip[TILE - 1])
        r = acc.result()
        self.assertLess(r["x_ratio"], 1.6)
        self.assertLess(r["z_ratio"], 1.6)

    def test_upsample_is_exactly_continuous_before_8bit_rounding(self):
        """Why the measured ratio is ~1.2 and not 1.0, stated as a test.

        A bilinear upsample has no discontinuity at all — its first difference
        is constant across a low-res texel span, so jump == grad exactly. What
        pushes the measured ratio above 1 is rounding the reconstruction back
        to uint8 when the true gradient is a fraction of a level: the staircase
        that creates is phase-locked to the resample grid. So option A's seam
        number is an 8-bit quantization floor, not a seam.
        """
        R, w = 64, 512
        yy, xx = np.mgrid[0:R, 0:R].astype(np.float32)
        lo = np.repeat(np.clip(110 + 25 * np.sin(xx / 16.0)
                               + 20 * np.cos(yy / 14.0), 0, 255)
                       .astype(np.uint8)[:, :, None], 3, axis=2)
        horiz = ev.expand_horizontal(lo, w)
        acc_f, acc_u = ev.SeamAccum(), ev.SeamAccum()
        pf = pu = None
        for z in range(0, w, TILE):
            j0, j1, wt = ev._bilinear_coords(z, z + TILE, w // R, R)
            wt = wt[:, None, None]
            f = horiz[j0] * (1 - wt) + horiz[j1] * wt
            u = np.clip(np.round(f), 0, 255).astype(np.uint8)
            acc_f.add_strip(f, pf, (f[0], f[1]))
            acc_u.add_strip(u, pu, (u[0], u[1]))
            pf, pu = (f[TILE - 2], f[TILE - 1]), (u[TILE - 2], u[TILE - 1])
        self.assertAlmostEqual(acc_f.result()["x_ratio"], 1.0, places=5)
        self.assertAlmostEqual(acc_f.result()["z_ratio"], 1.0, places=5)
        self.assertGreater(acc_u.result()["x_ratio"], 1.2)   # the rounding floor

    def test_crop_window_matches_the_full_map_reconstruction(self):
        """A crop is evidence in a decision, so it has to be the same pixels
        the metrics were computed from. The bug this caught indexed the
        already-widened field with low-res column indices, which quietly
        rendered a different (flat, sea-coloured) part of the map — the crop
        looked plausible and the numbers underneath it were unaffected.
        """
        side, R = 16, 64
        w = side * TILE
        f = w // R
        rng = np.random.default_rng(17)
        lo = (rng.random((R, R, 3)) * 120 + 60).astype(np.uint8)
        horiz = ev.expand_horizontal(lo, w)
        full = np.concatenate([ev.expand_rows(horiz, z, z + TILE, f)
                               for z in range(0, w, TILE)], axis=0)
        for (x0, z0, n) in ((0, 0, 4), (8, 2, 4), (3, 11, 5)):
            crop = ev.crop_optA(horiz, x0, z0, n, f)
            want = full[z0 * TILE:(z0 + n) * TILE, x0 * TILE:(x0 + n) * TILE]
            np.testing.assert_array_equal(crop, want)

    def test_indivisible_resolution_is_rejected(self):
        tiles = np.zeros((4, TILE, TILE, 3), dtype=np.uint8)
        with self.assertRaises(ValueError):
            ev.downsample_map(tiles, 2, 48)


class TestErrAccum(unittest.TestCase):

    def test_identical_fields_score_zero(self):
        a = np.full((16, 16, 3), 120, np.uint8)
        acc = ev.ErrAccum()
        acc.add(a, a)
        r = acc.result()
        self.assertEqual(r["mad"], 0.0)
        self.assertEqual(r["frac_gt4"], 0.0)

    def test_tail_is_reported_not_just_the_mean(self):
        """A path that is right almost everywhere and badly wrong on 1% of the
        map has a fine MAD; the decision needs the tail."""
        a = np.full((100, 100, 3), 120, np.uint8)
        b = a.copy()
        b[:1] = 220                       # 1% of rows, 100 levels off
        acc = ev.ErrAccum()
        acc.add(a, b)
        r = acc.result()
        self.assertLess(r["mad"], 1.5)
        self.assertEqual(r["max"], 100)
        self.assertAlmostEqual(r["frac_gt4"], 0.01, places=3)


class TestEndToEnd(unittest.TestCase):
    """A small synthetic map through the real entry point, checking that the
    harness reproduces the M7d ordering: VQ seamy, option A continuous."""

    def test_evaluate_ranks_the_two_paths(self):
        import tempfile
        side = 16                       # 16x16 tiles = 512 texels
        w = side * TILE
        yy, xx = np.mgrid[0:w, 0:w].astype(np.float32)
        # smooth ground with a little grain — the case that defeats the VQ
        rng = np.random.default_rng(5)
        field = (110 + 25 * np.sin(xx / 130.0) + 20 * np.cos(yy / 110.0)
                 + rng.normal(0, 1.5, (w, w)))
        field = np.repeat(np.clip(field, 0, 255)[:, :, None], 3, axis=2).astype(np.uint8)
        tiles = (field.reshape(side, TILE, side, TILE, 3)
                 .transpose(0, 2, 1, 3, 4).reshape(side * side, TILE, TILE, 3))
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "synthetic_tiles.npy")
            np.save(p, tiles)
            res = ev.evaluate(p, budget=24, seed=1, resolutions=[64],
                              crops=[], crop_dir="")
        # A 512-texel synthetic is far milder than a 16k map (which reads 15.7
        # for V); what must hold is the ordering, not the magnitude. Compare on
        # the absolute jump — on a fixture this smooth, option A's *ratio* is
        # dominated by the 8-bit rounding floor above, not by any real seam.
        self.assertGreater(res["V"]["seam"]["x_ratio"], 2.5)
        self.assertGreater(res["V"]["seam"]["x_jump"],
                           3.0 * res["A"]["64"]["seam"]["x_jump"])
        self.assertLess(res["A"]["64"]["err"]["mad"], res["V"]["err"]["mad"])
        self.assertAlmostEqual(res["source_seam"]["x_ratio"], 1.0, delta=0.5)


class TestAgainstShippedHelper(unittest.TestCase):
    """The x-axis numbers must agree with dxt1.seam_discontinuity, which is
    what the map build prints — otherwise this tool and the build disagree
    about the same map."""

    def test_x_ratio_matches_seam_discontinuity(self):
        side = 12
        w = side * TILE
        rng = np.random.default_rng(9)
        yy, xx = np.mgrid[0:w, 0:w].astype(np.float32)
        field = np.repeat((100 + 30 * np.sin(xx / 90.0) + 20 * np.cos(yy / 80.0)
                           + rng.normal(0, 1.0, (w, w)))[:, :, None], 3, axis=2)
        field = np.clip(field, 0, 255).astype(np.uint8)
        tiles = (field.reshape(side, TILE, side, TILE, 3)
                 .transpose(0, 2, 1, 3, 4).reshape(side * side, TILE, TILE, 3))
        assign, reps = dxt1.cluster_tiles(tiles, 20, seed=2)
        idx = assign.reshape(side, side)
        helper = dxt1.seam_discontinuity(tiles, idx, reps, sample=100000, seed=0)

        acc = ev.SeamAccum()
        for tz in range(side):
            acc.add_strip(reps[idx[tz]].transpose(1, 0, 2, 3).reshape(TILE, w, 3))
        mine = acc.result()
        # The helper samples random seams; this sweeps all of them. Same field,
        # same definition, so the ratios must land close.
        self.assertAlmostEqual(mine["x_ratio"], helper["ratio"],
                               delta=0.25 * helper["ratio"])


if __name__ == "__main__":
    unittest.main()
