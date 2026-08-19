#!/usr/bin/env python3
"""Tests for the SMT tile quantizer (terragen/dxt1.py, PLAN-maps.md M7 item 1).

    python3 -m unittest discover -s tools/mapgen/tests

Synthetic tiles only, for the reason test_town_planner.py already gives:
`data/maps/` is gitignored, so a clone or a CI checkout has no real map to
cluster. The terrain is faked; the quantizer and the metric are real.

What this pins down:

  * determinism        — same seed, same dictionary, including across processes
  * the lossless path  — budget >= N must not touch the tiles at all, and must
                         leave the bake exactly as continuous as it found it
  * the seam guard     — `cluster_tiles` is a FIDELITY-STANDIN for Spring's
                         exact SMT dedup and it breaks C0 continuity across
                         tile boundaries. That is a known, measured defect, not
                         a regression; this suite exists so it cannot get
                         WORSE unnoticed, and so that a future architectural
                         fix has a number to move.

Measured on the real skerry_reach bake, 2026-08-08 (262144 tiles -> 12288):
seam jump 4.33 against an interior gradient of 0.435, ratio 9.95, where the
unquantized bake reads 0.83. Doubling the budget moved the jump to 4.18
(-3.6%), so the guard below deliberately does NOT treat budget as the lever.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from terragen import dxt1  # noqa: E402

TZ = TX = 48          # 2304 tiles — big enough to cluster, small enough to be quick
LOSSY_BUDGET = 512


def smooth_albedo_tiles(tz: int = TZ, tx: int = TX, seed: int = 3) -> np.ndarray:
    """A bilinearly-upsampled random field, cut into (N, 32, 32, 3) tiles.

    Stands in for a terragen albedo bake: continuous everywhere, with all its
    structure at a scale of a few tiles. That is the signal the real quantizer
    handles worst, and the one whose seams a player actually sees.
    """
    rng = np.random.Generator(np.random.PCG64(seed))
    h, w = tz * 32, tx * 32
    lo = rng.random((tz // 2 + 2, tx // 2 + 2, 3)).astype(np.float32)
    ys = np.linspace(0, lo.shape[0] - 1, h)
    xs = np.linspace(0, lo.shape[1] - 1, w)
    yi = np.clip(ys.astype(int), 0, lo.shape[0] - 2)
    xi = np.clip(xs.astype(int), 0, lo.shape[1] - 2)
    fy = (ys - yi)[:, None, None]
    fx = (xs - xi)[None, :, None]
    img = (lo[yi][:, xi] * (1 - fy) * (1 - fx) + lo[yi + 1][:, xi] * fy * (1 - fx)
           + lo[yi][:, xi + 1] * (1 - fy) * fx + lo[yi + 1][:, xi + 1] * fy * fx)
    img = (60.0 + 120.0 * img).astype(np.uint8)
    return img.reshape(tz, 32, tx, 32, 3).transpose(0, 2, 1, 3, 4).reshape(tz * tx, 32, 32, 3)


class TileQuantizerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tiles = smooth_albedo_tiles()

    def test_seeded_determinism(self):
        a1, r1 = dxt1.cluster_tiles(self.tiles, LOSSY_BUDGET, seed=7)
        a2, r2 = dxt1.cluster_tiles(self.tiles, LOSSY_BUDGET, seed=7)
        np.testing.assert_array_equal(a1, a2)
        np.testing.assert_array_equal(r1, r2)

    def test_different_seeds_give_different_dictionaries(self):
        a1, _ = dxt1.cluster_tiles(self.tiles, LOSSY_BUDGET, seed=7)
        a2, _ = dxt1.cluster_tiles(self.tiles, LOSSY_BUDGET, seed=8)
        self.assertFalse(np.array_equal(a1, a2),
                         "seed is not reaching the clustering")

    def test_budget_at_or_above_tile_count_is_lossless(self):
        n = self.tiles.shape[0]
        assign, reps = dxt1.cluster_tiles(self.tiles, n, seed=7)
        np.testing.assert_array_equal(assign, np.arange(n))
        np.testing.assert_array_equal(reps, self.tiles)

    def test_lossless_path_preserves_seam_continuity_exactly(self):
        """The invariant a fix has to reach: quantized seams == source seams."""
        n = self.tiles.shape[0]
        assign, reps = dxt1.cluster_tiles(self.tiles, n, seed=7)
        sd = dxt1.seam_discontinuity(self.tiles, assign.reshape(TZ, TX), reps, seed=1)
        self.assertAlmostEqual(sd["ratio"], sd["true_ratio"], places=6)
        self.assertLess(sd["true_ratio"], 1.5,
                        "the synthetic bake is supposed to be continuous")

    def test_source_field_is_continuous(self):
        """Negative control: the metric must not call a smooth field seamy."""
        n = self.tiles.shape[0]
        _, reps = dxt1.cluster_tiles(self.tiles, n, seed=7)
        sd = dxt1.seam_discontinuity(
            self.tiles, np.arange(n).reshape(TZ, TX), reps, seed=1)
        self.assertLess(sd["true_jump"], 1.0)
        self.assertLess(sd["true_ratio"], 1.5)

    def test_lossy_quantization_seam_damage_does_not_regress(self):
        """FIDELITY-STANDIN guard, not an endorsement.

        Lossy dedup breaks continuity across tile boundaries; on this fixture
        the ratio measured 21.8 when the guard was written (2026-08-08). The
        bound is deliberately one-sided: any architectural fix drives this
        DOWN and keeps passing, while a change that makes the grid more
        visible trips it.
        """
        assign, reps = dxt1.cluster_tiles(self.tiles, LOSSY_BUDGET, seed=7)
        sd = dxt1.seam_discontinuity(self.tiles, assign.reshape(TZ, TX), reps, seed=1)
        self.assertLess(
            sd["ratio"], 25.0,
            f"tile-seam discontinuity got worse: ratio {sd['ratio']:.2f} "
            f"(jump {sd['jump']:.2f} / interior gradient {sd['grad']:.2f}); "
            f"was 21.8 on 2026-08-08")

    def test_metric_detects_a_dictionary_that_ignores_the_bake(self):
        """Positive control: shuffle the index and the metric must spike.

        Without this, `test_..._does_not_regress` could pass because the metric
        is broken rather than because the quantizer is behaving.
        """
        assign, reps = dxt1.cluster_tiles(self.tiles, LOSSY_BUDGET, seed=7)
        rng = np.random.Generator(np.random.PCG64(11))
        shuffled = rng.permutation(assign).reshape(TZ, TX)
        good = dxt1.seam_discontinuity(self.tiles, assign.reshape(TZ, TX), reps, seed=1)
        bad = dxt1.seam_discontinuity(self.tiles, shuffled, reps, seed=1)
        self.assertGreater(bad["jump"], good["jump"] * 1.5)


if __name__ == "__main__":
    unittest.main()
