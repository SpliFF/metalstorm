#!/usr/bin/env python3
"""Tests for the `--terrain arc` platform's authored grain (PLAN-maps M8r).

    .venv/bin/python -m unittest tests.test_arc_platform

The claim under test is narrow and mechanical, and it is the one M8q's
FIND 4 turned on: `stream_power_erode_multires` carries the *input's*
high-pass residual across its upsample, so whatever fine relief the input
does not have, the solver has to invent — and what it invents is cell-scale
channel texture, which is the hatching the router alone could not remove.
`arc_platform`'s `detail` term is the input side of that, so what has to be
pinned is:

  * it lands in the band the multires pass cannot carry and the acceptance
    instrument reads (15-120 elmos), at the amount the shipped generator
    authors — not merely "some noise was added";
  * it does **not** move the landform. The arc's shape is authored as an
    uplift rate and carved by the solver; a detail term that shifted the
    coarse surface would be re-drawing the map, and the band-vs-structure
    split is exactly what makes it safe to turn on;
  * `detail=0` restores the M8q surface bit-for-bit, so the milestone's
    own A/B arm stays reachable;
  * the generator's erosion cache keys on it, because a cached surface from
    before the term existed is a *different landscape* under the same
    parameters.
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import archipelago as arc                     # noqa: E402
from terragen import erosion as ero           # noqa: E402
from terragen import uplift as up             # noqa: E402

CELL = 8.0          # the shipping grid: the band is defined in elmos, not cells
N = 513             # same sample-count floor note as structural_anisotropy


def _patch(seed: int = arc.SEED_DEFAULT):
    """A 513^2 patch of the real platform at the shipping cell size."""
    zz, xx = np.mgrid[0:N, 0:N].astype(np.float64) * CELL
    # a smooth authored uplift stand-in: arc_uplift over a 4 km patch is one
    # flank of one centre, and what matters here is that it is smooth
    u = np.clip(0.35 + 0.55 * np.sin(xx / 5200.0) * np.cos(zz / 4800.0),
                0.0, 1.0)
    return u, xx, zz


class TestArcPlatformDetail(unittest.TestCase):
    def setUp(self):
        self.u, self.xx, self.zz = _patch()
        self.smooth = arc.arc_platform(arc.SEED_DEFAULT, 0.30, self.u,
                                       self.xx, self.zz, detail=0.0)
        self.grained = arc.arc_platform(arc.SEED_DEFAULT, 0.30, self.u,
                                        self.xx, self.zz)

    def test_the_smooth_platform_has_nothing_to_carry(self):
        """M8q FIND 4, as a test: this is the defect the term exists for."""
        self.assertLess(ero.band_detail(self.smooth).std(), 0.1)

    def test_the_grain_lands_on_the_shipped_generators_amount(self):
        """`mounds` hands erosion 2.27 elmos of high-pass residual."""
        self.assertAlmostEqual(ero.band_detail(self.grained).std(), 2.27,
                               delta=0.35)

    def test_the_grain_is_in_the_band_not_in_the_landform(self):
        """Coarse structure must be untouched — the solver authors that.

        Note what this does *not* claim: the term's coarsest octave (120
        elmos) is representable on the 32-elmo coarse grid, so part of the
        grain does reach the coarse solve. What must not move is the
        landform, which `smooth_uplift` holds at 900 elmos and up.
        """
        diff = self.grained - self.smooth
        self.assertGreater(diff.std(), 3.0)

        n = diff.shape[0]
        f = np.fft.fftshift(np.fft.fft2(diff - diff.mean()))
        power = f.real ** 2 + f.imag ** 2
        freq = np.fft.fftshift(np.fft.fftfreq(n, CELL))
        fz, fx = np.meshgrid(freq, freq, indexing="ij")
        k = np.hypot(fx, fz)
        fine = power[k > 1.0 / 250.0].sum() / power.sum()
        self.assertGreater(fine, 0.9)

        # and at the landform's own scale the two surfaces are the same map.
        # Low-pass, not `_coarsen`: zoom(order=1) interpolates rather than
        # area-averages, and at a 32x factor it aliases the grain straight
        # back in — which reads as a landform change that isn't there.
        lp = up.smooth_uplift(diff, CELL, wavelength_elmos=500.0)
        self.assertLess(lp.std(), 0.02 * self.smooth.std())

    def test_the_grain_is_not_oriented(self):
        """It seeds the solver; it must not hand it a direction to follow."""
        peak, ent = up.structural_anisotropy(self.grained - self.smooth, CELL)
        self.assertLess(peak, 2.0)
        self.assertGreater(ent, 0.99)
        self.assertLess(up.angular_lobes(self.grained - self.smooth, CELL)[0][1],
                        2.0)

    def test_detail_zero_restores_the_m8q_surface_exactly(self):
        again = arc.arc_platform(arc.SEED_DEFAULT, 0.30, self.u, self.xx,
                                 self.zz, detail=0.0)
        self.assertTrue(np.array_equal(self.smooth, again))
        self.assertFalse(np.array_equal(self.smooth, self.grained))

    def test_it_is_deterministic_and_seeded(self):
        again = arc.arc_platform(arc.SEED_DEFAULT, 0.30, self.u, self.xx,
                                 self.zz)
        other = arc.arc_platform(arc.SEED_DEFAULT + 1, 0.30, self.u, self.xx,
                                 self.zz)
        self.assertTrue(np.array_equal(self.grained, again))
        self.assertFalse(np.array_equal(self.grained, other))

    def test_the_landmass_contract_still_holds(self):
        """The waterline is a hard contract, and the grain moves cells across
        it — the quantile has to be taken after the term, not before."""
        for h in (self.smooth, self.grained):
            self.assertAlmostEqual(float((h > 0.0).mean()), 0.30, delta=0.005)


class TestTheAimIsTakenOnTheLandform(unittest.TestCase):
    """Why `generate` aims `scale_uplift_for_relief` at the grain-free
    platform: `Psi` is a sum of `1/sqrt(a)` down a flow path, so cell-scale
    grain gives every path more steep headwater steps and the same target
    comes back as a bigger rate. Measured on the full generator, aiming
    through the grained platform stood 2046 elmos of relief where the smooth
    one stood 1406 — and the surplus relief carries exactly the fine texture
    the grain was added to remove (PLAN-maps M8r).
    """

    def test_grain_inflates_the_rate_the_aim_hands_back(self):
        u, xx, zz = _patch()
        smooth = arc.arc_platform(arc.SEED_DEFAULT, 0.30, u, xx, zz, detail=0.0)
        grained = arc.arc_platform(arc.SEED_DEFAULT, 0.30, u, xx, zz)
        k = np.full(smooth.shape, 0.02)
        s = up.scale_uplift_for_relief(smooth, u, k, 950.0, router="dinf")
        g = up.scale_uplift_for_relief(grained, u, k, 950.0, router="dinf")
        self.assertGreater(g, 1.15 * s)


class TestBandDetailHelper(unittest.TestCase):
    """`band_detail` is the multires pass's own residual, factored out."""

    def setUp(self):
        rng = np.random.default_rng(3)
        g = np.arange(129, dtype=np.float64)
        zz, xx = np.meshgrid(g, g, indexing="ij")
        self.dem = (200.0 * np.sin(xx / 40.0) * np.cos(zz / 35.0)
                    + 4.0 * rng.standard_normal((129, 129)))

    def test_it_is_what_the_multires_pass_adds_back(self):
        with_band = ero.stream_power_erode_multires(
            self.dem, cellsize=32.0, coarse_factor=4, coarse_iterations=3,
            fine_iterations=0, keep_band_detail=True, k_erode=0.02,
            dt=1.4, talus_deg=None)
        without = ero.stream_power_erode_multires(
            self.dem, cellsize=32.0, coarse_factor=4, coarse_iterations=3,
            fine_iterations=0, keep_band_detail=False, k_erode=0.02,
            dt=1.4, talus_deg=None)
        self.assertTrue(np.allclose(with_band - without,
                                    ero.band_detail(self.dem, 4)))

    def test_a_smooth_surface_has_none(self):
        g = np.arange(129, dtype=np.float64)
        zz, xx = np.meshgrid(g, g, indexing="ij")
        smooth = 200.0 * np.sin(xx / 40.0) * np.cos(zz / 35.0)
        self.assertLess(ero.band_detail(smooth, 4).std(),
                        0.25 * ero.band_detail(self.dem, 4).std())


class TestArcDetailKeysTheCache(unittest.TestCase):
    """A cache hit from a run with different grain would be a silent lie."""

    def _path(self, terrain="arc", detail=arc.ARC_DETAIL_DEFAULT):
        return arc.erosion_cache_path(terrain, "dinf", arc.SEED_DEFAULT, 0.30,
                                      9, 950.0, detail, False)

    def test_two_grains_cannot_share_a_cache(self):
        self.assertNotEqual(self._path(detail=0.0), self._path())

    def test_the_arc_key_carries_its_own_revision(self):
        """Everything upstream of the arc's erosion keys through ARC_REV."""
        self.assertIn(f"v{arc.ARC_REV}", os.path.basename(self._path()))

    def test_the_mounds_key_is_unchanged(self):
        """The shipped skerry_reach cache has to stay addressable."""
        p = os.path.basename(self._path(terrain="mounds"))
        self.assertEqual(
            p, f"archipelago_eroded_r{arc.SYNTH_REV}_mounds_dinf_"
               f"{arc.SEED_DEFAULT}_0.3_9_950.0_full.npy")


if __name__ == "__main__":
    unittest.main()
