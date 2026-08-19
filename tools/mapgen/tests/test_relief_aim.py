#!/usr/bin/env python3
"""Tests for the relief aim's acceptance reading and its closed loop (M8u).

    .venv/bin/python -m unittest tests.test_relief_aim

M8t recorded the arc's aim as +65 % out, and M8u found that most of that
number was the *reading*: `scale_uplift_for_relief` puts a **quantile** of
the steady-state relief on the target, and every arm had been judged by the
surface's **maximum**. On the full-res arc the un-segmented belt stood 953.8
against a 950 aim (+0.4 %) with a summit at 1 206 (+27 %); the segmented one
stood 1 218 (+28 %) with a summit at 1 570 (+65 %). So there are two claims
to pin, and they fail differently:

  * **the reading.** `relief_reading` reports both statistics and takes the
    residual against the aimed one. The summit-over-quantile gap is a
    property of eroded landscapes (1.24-1.37x on every full-res surface the
    archipelago generator has written, the shipped `mounds` map included),
    so a test that only showed the gap existing would pass on any surface —
    the control here is a flat-topped field where the two statistics agree,
    which is what makes the eroded case evidence.

  * **the loop.** The first-order aim is out because `Psi` is read on the
    drainage the *platform* has and the solver builds a different one. That
    is not a bad estimator waiting for a better one — M8u measured four
    candidate ratios and each aimed one arc arm and missed the other by
    11-28 % — so what is pinned is that measuring what stood and rescaling
    by `target/stood` converges, and that it beats the first-order aim it
    starts from.

  * **the cache contract.** Pass 0 keeps the pre-M8u key, or the loop's
    first pass is a 450-second re-run of a surface already on disk.
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import archipelago as arch                    # noqa: E402
from terragen import erosion as ero           # noqa: E402
from terragen import uplift as up             # noqa: E402


class TestReliefReading(unittest.TestCase):
    """Judge a quantile aim by the quantile, and say so out loud."""

    def test_residual_is_taken_against_the_aimed_statistic(self):
        rng = np.random.default_rng(3)
        h = rng.random((200, 200)) * 100.0
        r = up.relief_reading(h, 90.0)
        self.assertEqual(r.aimed, 90.0)
        self.assertAlmostEqual(r.stood, float(np.quantile(h, 0.999)))
        self.assertAlmostEqual(r.summit, float(h.max()))
        self.assertAlmostEqual(r.residual, r.stood / 90.0 - 1.0)
        self.assertEqual(r.quantile, up.AIM_QUANTILE)

    def test_the_aim_quantile_is_the_one_the_aim_uses(self):
        """One constant, or the reading and the aim drift apart silently."""
        g = np.linspace(-1.0, 1.0, 65)
        zz, xx = np.meshgrid(g, g, indexing="ij")
        u = np.exp(-((xx / 0.3) ** 2 + (zz / 0.3) ** 2))
        rng = np.random.default_rng(5)
        dem = 5.0 * rng.random((65, 65))
        s = up.scale_uplift_for_relief(dem, u, 0.02, 400.0)
        psi = up.steady_state_relief_from_dem(dem, u * s, 0.02)
        # the aim's own definition of "hit": the AIM_QUANTILE of Psi is the
        # target, so the same quantile is what an achieved reading must take
        self.assertAlmostEqual(float(np.quantile(psi, up.AIM_QUANTILE)),
                               400.0, places=6)

    def test_the_summit_overreads_an_eroded_surface(self):
        """The gap M8t read as aim error — with the control that makes it
        evidence rather than arithmetic."""
        g = np.linspace(-1.0, 1.0, 97)
        zz, xx = np.meshgrid(g, g, indexing="ij")
        u = np.exp(-((xx / 0.30) ** 2 + (zz / 0.30) ** 2))
        u[0, :] = u[-1, :] = u[:, 0] = u[:, -1] = 0.0
        rng = np.random.default_rng(7)
        h = ero.stream_power_erode(5.0 * rng.random((97, 97)), cellsize=32.0,
                                   iterations=900, dt=1.4, k_erode=0.02,
                                   m_exp=0.5, uplift=u, talus_deg=None)
        eroded = up.relief_reading(h - h.min(), 1.0)
        self.assertGreater(eroded.summit / eroded.stood, 1.15)

        # control: a plateau reads the same at both statistics, so the test
        # above is about the landscape and not about `max` being >= `q999`
        flat = np.full((97, 97), 500.0)
        flat[0, 0] = 501.0
        plateau = up.relief_reading(flat, 1.0)
        self.assertLess(plateau.summit / plateau.stood, 1.01)


class TestClosedLoopAim(unittest.TestCase):
    """One correction pass beats the first-order aim it starts from."""

    S = 97

    def setUp(self):
        g = np.linspace(-1.0, 1.0, self.S)
        zz, xx = np.meshgrid(g, g, indexing="ij")
        self.u = np.exp(-((xx / 0.30) ** 2 + (zz / 0.30) ** 2))
        self.u[0, :] = self.u[-1, :] = self.u[:, 0] = self.u[:, -1] = 0.0
        rng = np.random.default_rng(7)
        self.h0 = 5.0 * rng.random((self.S, self.S))
        self.K = 0.02

    def _stood(self, uplift, target):
        h = ero.stream_power_erode(self.h0, cellsize=32.0, iterations=1200,
                                   dt=1.4, k_erode=self.K, m_exp=0.5,
                                   uplift=uplift, talus_deg=None)
        return up.relief_reading(h - h.min(), target)

    def test_one_pass_of_the_loop_closes_the_first_order_residual(self):
        target = 400.0
        u = self.u * up.scale_uplift_for_relief(self.h0, self.u, self.K,
                                                target)
        first = self._stood(u, target)
        self.assertGreater(abs(first.residual), 0.02,
                           "fixture no longer exercises a first-order miss")
        second = self._stood(u * (target / first.stood), target)
        self.assertLess(abs(second.residual), abs(first.residual))
        self.assertLess(abs(second.residual), 0.05)

    def test_the_correction_is_the_ratio_the_generator_applies(self):
        """Relief is linear enough in U for `target/stood` to be the whole
        correction — the property the loop's single pass rests on."""
        target = 400.0
        u = self.u * up.scale_uplift_for_relief(self.h0, self.u, self.K,
                                                target)
        a = self._stood(u, target)
        b = self._stood(u * 2.0, target)
        self.assertAlmostEqual(b.stood / a.stood, 2.0, delta=0.15)


class TestAimCacheKey(unittest.TestCase):
    """The loop must not cost two passes on a machine that has pass 0."""

    KW = dict(terrain="arc", router="dinf", seed=20260730, landmass=0.30,
              islands=9, relief_target=950.0, arc_detail=17.0, fast=False,
              hardness_detail=0.0, segmentation=1.0)

    def test_pass_zero_is_the_pre_m8u_key(self):
        self.assertEqual(arch.erosion_cache_path(**self.KW, aim_pass=0),
                         arch.erosion_cache_path(**self.KW))

    def test_later_passes_get_their_own_key(self):
        k0 = arch.erosion_cache_path(**self.KW, aim_pass=0)
        k1 = arch.erosion_cache_path(**self.KW, aim_pass=1)
        self.assertNotEqual(k0, k1)
        self.assertTrue(os.path.basename(k1).endswith("_i1_full.npy"))

    def test_the_mounds_key_never_grows_an_aim_suffix(self):
        """`mounds` draws its heights and is not aimed at all."""
        k = arch.erosion_cache_path("mounds", "d8", 20260730, 0.34, 9, 950.0,
                                    17.0, False)
        self.assertNotIn("_i", os.path.basename(k))


if __name__ == "__main__":
    unittest.main()
