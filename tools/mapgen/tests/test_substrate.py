#!/usr/bin/env python3
"""Tests for the mid-scale substrate term and the band ladder (PLAN-maps M8s).

    .venv/bin/python -m unittest tests.test_substrate

M8r put authored grain in the 15-120 elmo band and took the arc's reading
there to shipped-equivalent — and the map was still wrong, because what the
eye was refusing had never been in that band. Two things follow, and they
are what this file pins:

  * **the instrument has to be a ladder.** `uplift.anisotropy_bands` reads
    every band of one surface in one call, so "32-120 passes" can no longer
    be mistaken for "the terrain passes". It must agree exactly with the two
    single-band functions it composes, or it is a second opinion rather than
    the same reading.
  * **the substrate knob does what it says, even though what it says was
    not the fix.** `archipelago.substrate_hardness`'s `detail` term is
    defaulted to 0 on every path because two full arms measured it negative
    (see its docstring) — so what these tests pin is that it is *off*, and
    that if anyone turns it on it still behaves: variation in the 200-800
    elmo band, the coarse substrate's mean left alone (it is an erodibility;
    shifting the mean is a global erosion-rate change wearing a texture's
    clothes), `K` never driven to zero, and — the trap — the *relief aim*
    kept out of it, because `1/K` is convex and a zero-mean perturbation of
    `K` raises `Psi`. That is M8r FIND 1's confound reaching the same place
    through a different term.

Plus the two contracts every generator knob in this file carries: `detail=0`
is bit-for-bit the shipped field, and the erosion cache keys on it.
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import archipelago as arc                     # noqa: E402
from terragen import noise as tn              # noqa: E402
from terragen import uplift as up             # noqa: E402

SEED = 20260730


def _grid(n: int, cell: float):
    zz, xx = np.mgrid[0:n, 0:n].astype(np.float64) * cell
    return xx, zz


class TestSubstrateHardness(unittest.TestCase):
    """The erodibility field's new mid-scale term."""

    @classmethod
    def setUpClass(cls):
        cls.xx, cls.zz = _grid(257, 32.0)

    def test_it_is_off_by_default_on_every_path(self):
        """Measured negative — nothing may pick it up silently (M8s)."""
        self.assertEqual(arc.ARC_HARDNESS_DETAIL, 0.0)

    def test_detail_zero_is_the_shipped_field_bit_for_bit(self):
        """The `mounds` path must not move — it ships `skerry_reach`."""
        shipped = 0.016 + 0.020 * (0.5 + 0.5 * tn.fbm(
            tn.SimplexNoise(SEED + 2), self.xx / 3400.0, self.zz / 3400.0,
            octaves=3))
        got = arc.substrate_hardness(SEED, self.xx, self.zz, detail=0.0)
        self.assertTrue(np.array_equal(shipped, got))

    def test_mean_is_preserved(self):
        """A zero-mean perturbation, not a global erosion-rate change."""
        base = arc.substrate_hardness(SEED, self.xx, self.zz, 0.0)
        for d in (0.004, 0.008, 0.012):
            k = arc.substrate_hardness(SEED, self.xx, self.zz, d)
            self.assertAlmostEqual(float(k.mean()), float(base.mean()),
                                   delta=0.02 * float(base.mean()),
                                   msg=f"detail={d} shifted the mean K")

    def test_k_stays_positive_and_floored(self):
        """Zero erodibility is an unerodible cell — a hole in the solver."""
        for d in (0.008, 0.030):
            k = arc.substrate_hardness(SEED, self.xx, self.zz, d)
            self.assertGreaterEqual(float(k.min()), arc.HARDNESS_FLOOR)

    def test_detail_raises_contrast(self):
        """More dose, more spread — the term is a dose knob, not a switch."""
        spreads = [float(arc.substrate_hardness(
            SEED, self.xx, self.zz, d).std()) for d in (0.0, 0.004, 0.008)]
        self.assertLess(spreads[0], spreads[1])
        self.assertLess(spreads[1], spreads[2])

    def test_the_variation_lands_in_the_200_800_band(self):
        """The point of the term: the coarse field has nothing below 850.

        Read as radially-binned spectral power of the perturbation alone,
        the added energy has to sit inside 200-800 elmos rather than above
        it (where the coarse field already varies) or below it (where M8r's
        surface grain already works).
        """
        xx, zz = _grid(512, 8.0)
        base = arc.substrate_hardness(SEED, xx, zz, 0.0)
        pert = arc.substrate_hardness(SEED, xx, zz, 0.008) - base
        n = pert.shape[0]
        w = np.hanning(n)
        f = np.fft.fftshift(np.fft.fft2((pert - pert.mean())
                                        * w[:, None] * w[None, :]))
        power = f.real ** 2 + f.imag ** 2
        freq = np.fft.fftshift(np.fft.fftfreq(n, 8.0))
        fz, fx = np.meshgrid(freq, freq, indexing="ij")
        k = np.hypot(fx, fz)

        def band(lo, hi):
            m = (k > 1.0 / hi) & (k < 1.0 / lo)
            return float(power[m].sum())

        total = float(power[k > 0].sum())
        self.assertGreater(band(150.0, 900.0) / total, 0.7)
        self.assertLess(band(16.0, 150.0) / total, 0.15)


class TestAimIsTakenOnTheCoarseSubstrate(unittest.TestCase):
    """M8r FIND 1's confound, arriving through `K` instead of the surface."""

    def test_perturbing_k_inflates_psi(self):
        """`1/K` is convex, so zero-mean grain in `K` raises the path sum.

        This is the reason `generate` aims on the coarse field: aim through
        the perturbed one and the same `--relief-target` hands back less
        uplift, so a substrate A/B would really be a relief A/B.
        """
        xx, zz = _grid(129, 64.0)
        u = arc.arc_uplift(SEED, xx, zz, 64.0)
        h = arc.arc_platform(SEED, 0.30, u, xx, zz, detail=0.0)
        smooth = arc.substrate_hardness(SEED, xx, zz, 0.0)
        rough = arc.substrate_hardness(SEED, xx, zz, 0.012)
        s_smooth = up.scale_uplift_for_relief(h, u, smooth, 950.0,
                                              router="dinf")
        s_rough = up.scale_uplift_for_relief(h, u, rough, 950.0,
                                             router="dinf")
        self.assertLess(s_rough, s_smooth)


class TestErosionCacheKey(unittest.TestCase):
    """A cached surface from before the term existed is a different map."""

    def test_hardness_detail_is_in_the_key(self):
        a = arc.erosion_cache_path("arc", "dinf", SEED, 0.30, 9, 950.0, 17.0,
                                   False, 0.0)
        b = arc.erosion_cache_path("arc", "dinf", SEED, 0.30, 9, 950.0, 17.0,
                                   False, 0.008)
        c = arc.erosion_cache_path("arc", "dinf", SEED, 0.30, 9, 950.0, 17.0,
                                   False, 0.012)
        self.assertNotEqual(a, b)
        self.assertNotEqual(b, c)

    def test_zero_detail_keeps_the_old_key_addressable(self):
        """M8r's own converged arms must stay reachable at their key."""
        p = arc.erosion_cache_path("arc", "dinf", SEED, 0.30, 9, 950.0, 17.0,
                                   False, 0.0)
        self.assertNotIn("_k", os.path.basename(p))
        self.assertTrue(os.path.basename(p).endswith("_a17.0v2_full.npy"))


class TestAnisotropyBands(unittest.TestCase):
    """The ladder instrument — M8r FIND 2's lesson made mechanical."""

    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(7)
        cls.dem = rng.normal(size=(256, 256))

    def test_it_reads_every_band_in_order(self):
        rows = up.anisotropy_bands(self.dem, 8.0, floor_seeds=0)
        self.assertEqual(len(rows), len(up.ANISOTROPY_BANDS))
        self.assertEqual([(r.lo, r.hi) for r in rows],
                         [(float(a), float(b)) for a, b in up.ANISOTROPY_BANDS])

    def test_it_agrees_exactly_with_the_functions_it_composes(self):
        """One reading read two ways, never a second opinion."""
        for r in up.anisotropy_bands(self.dem, 8.0, floor_seeds=0):
            self.assertEqual(
                r.peak, up.structural_anisotropy(self.dem, 8.0, r.lo, r.hi)[0])
            self.assertEqual(r.lobes,
                             up.angular_lobes(self.dem, 8.0, r.lo, r.hi))

    def test_excess_is_peak_over_the_matched_floor(self):
        rows = up.anisotropy_bands(self.dem, 8.0, floor_seeds=4)
        floors = up.anisotropy_floor(self.dem.shape, 8.0, seeds=4)
        for r, fl in zip(rows, floors):
            self.assertEqual(r.floor, fl)
            self.assertAlmostEqual(r.excess, r.peak / fl, places=12)

    def test_floor_seeds_zero_leaves_the_raw_peak(self):
        for r in up.anisotropy_bands(self.dem, 8.0, floor_seeds=0):
            self.assertEqual(r.floor, 1.0)
            self.assertEqual(r.excess, r.peak)

    def test_each_band_reports_its_own_structure_not_its_neighbours(self):
        """The ladder has to localise, or it is one number again.

        Two ridge sets at right angles, one coarse and one fine: the
        300-800 row must name the coarse one's direction and the 32-120 row
        the fine one's. This is the property the single-band reading cannot
        give and the whole reason M8s needed a ladder — the arc's 32-120 was
        shipped-equivalent while 300-800 sat at 3.84 across the strike.

        (Read the *direction*, not the magnitude: a band whose only content
        is spectral leakage from one direction still reads a high peak/mean,
        because peak/mean is normalised inside its own band.)
        """
        n, cell = 512, 8.0
        zz, xx = np.mgrid[0:n, 0:n].astype(np.float64) * cell
        # varying along x -> wavevector at 0 deg; along z -> 90 deg
        dem = np.sin(2.0 * np.pi * xx / 500.0) + np.sin(2.0 * np.pi * zz / 64.0)
        lead = {(r.lo, r.hi): r.lobes[0][0] for r in
                up.anisotropy_bands(dem, cell, floor_seeds=0)}
        self.assertAlmostEqual(lead[(300.0, 800.0)], 0.0, delta=6.0)
        self.assertAlmostEqual(lead[(32.0, 120.0)], 90.0, delta=6.0)


class TestAnisotropyFloor(unittest.TestCase):
    """The control M8p's docstring named and nobody had run per band."""

    SHAPE = (256, 256)

    def test_the_floor_rises_with_the_band(self):
        """Coarser band, fewer spectral samples, higher chance peak.

        This ordering is the whole finding: a raw 300-800 reading is not
        comparable with a raw 16-32 one, so the ladder had to be divided
        by it before any of M8r's four rows meant anything.
        """
        fl = up.anisotropy_floor(self.SHAPE, 8.0, seeds=6)
        self.assertEqual(len(fl), len(up.ANISOTROPY_BANDS))
        for a, b in zip(fl, fl[1:]):
            self.assertLess(a, b)

    def test_an_isotropic_field_reads_about_one_excess(self):
        """The definition, checked against a field the floor never saw."""
        f = up._isotropic_field(self.SHAPE, seed=999)
        for r in up.anisotropy_bands(f, 8.0, floor_seeds=6):
            self.assertLess(r.excess, 2.0,
                            msg=f"{r.lo}-{r.hi} read {r.excess:.2f}x floor "
                                "on a field with no structure in it")

    def test_a_comb_still_clears_the_floor_by_a_mile(self):
        """The floor must not blunt the signal it was added to calibrate.

        M8p's herringbone read 5.27 at 32-120 against a floor near 1.4 —
        the correction is a rescaling of the axis, not a suppression of it.
        """
        n, cell = 256, 8.0
        zz, xx = np.mgrid[0:n, 0:n].astype(np.float64) * cell
        comb = np.sin(2.0 * np.pi * (xx + zz) / 64.0)
        rows = {(r.lo, r.hi): r.excess for r in
                up.anisotropy_bands(comb, cell, floor_seeds=6)}
        self.assertGreater(rows[(32.0, 120.0)], 10.0)

    def test_it_is_cached_per_grid(self):
        up.anisotropy_floor(self.SHAPE, 8.0, seeds=6)
        a = up.anisotropy_floor(self.SHAPE, 8.0, seeds=6)
        b = up.anisotropy_floor(self.SHAPE, 8.0, seeds=6)
        self.assertEqual(a, b)
        self.assertNotEqual(a, up.anisotropy_floor((128, 128), 8.0, seeds=6))


if __name__ == "__main__":
    unittest.main()
