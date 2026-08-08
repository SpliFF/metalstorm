#!/usr/bin/env python3
"""Tests for the arc's tectonic segmentation (PLAN-maps M8t).

    .venv/bin/python -m unittest tests.test_arc_segments

M8s closed the arc's remaining defect as **topological, not textural**: a
converged stream-power solver on a single smooth uplift belt must build one
continuous divide with regular opposing spurs, and `arc_uplift`'s
`smooth_uplift(u, cell, 900.0)` was what guaranteed there was exactly one
belt to build it on. `segmentation` is the answer — cross-strike breaks, an
en-echelon step per segment, and a back-arc high — and what has to be pinned
is what a spectral instrument cannot see:

  * `segmentation=0` is the M8s field **bit-for-bit**, and provably inert to
    every one of the new parameters, so that milestone's cached 450-second
    arm stays the A/B control;
  * a break is a *strait*, not a saddle: it multiplies the submarine ridge
    and the back-arc high too, and the belt above water comes apart into
    separate islands (`uplift.divide_topology`);
  * the back-arc high lands on the **concave** side, which is the one
    geometric fact in the term that a sign error would silently invert;
  * removing uplift makes the relief aim hand back a *larger* rate — the
    same confound class M8r and M8s both found, arriving through a third
    term, so it is pinned rather than re-discovered;
  * the erosion cache keys on it, only when it is on.
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import archipelago as arc                     # noqa: E402
from terragen import uplift as up             # noqa: E402

CELL = 32.0                    # 513^2: the belt's terms are 1000+ elmos wide
N = int(arc.MAP_SIZE / CELL) + 1


def _grid(cell: float = CELL):
    n = int(arc.MAP_SIZE / cell) + 1
    zz, xx = np.mgrid[0:n, 0:n].astype(np.float64) * cell
    return xx, zz


def _uplift(seed: int = arc.SEED_DEFAULT, cell: float = CELL, **kw):
    xx, zz = _grid(cell)
    return arc.arc_uplift(seed, xx, zz, cell, **kw)


class TestSegmentationZeroIsTheShippedField(unittest.TestCase):
    """M8s's arm is a cached 450-second surface; keep it reachable."""

    def setUp(self):
        self.base = _uplift(segmentation=0.0)

    def test_off_is_inert_to_every_new_parameter(self):
        for kw in ({"break_depth": 0.0}, {"break_width": 50.0},
                   {"back_arc": 0.0}, {"back_arc_offset": 900.0},
                   {"back_arc_sig": 200.0}, {"echelon_step": 0.0},
                   {"seg_centres": 3}):
            with self.subTest(**kw):
                np.testing.assert_array_equal(
                    self.base, _uplift(segmentation=0.0, **kw))

    def test_off_is_the_default(self):
        np.testing.assert_array_equal(self.base, _uplift())

    def test_on_actually_changes_the_field(self):
        """The positive control: the assertions above are not vacuous."""
        self.assertGreater(np.abs(_uplift(segmentation=1.0)
                                  - self.base).max(), 0.1)

    def test_it_is_still_normalised_and_deterministic(self):
        u = _uplift(segmentation=1.0)
        self.assertAlmostEqual(float(u.max()), 1.0, places=9)
        self.assertGreaterEqual(float(u.min()), 0.0)
        np.testing.assert_array_equal(u, _uplift(segmentation=1.0))
        self.assertGreater(np.abs(u - _uplift(seed=7, segmentation=1.0)).max(),
                           0.05)


class TestBreaksAreStraitsNotSaddles(unittest.TestCase):
    """The belt has to come apart *above water*, or nothing is segmented."""

    def _platform(self, seg):
        xx, zz = _grid()
        u = arc.arc_uplift(arc.SEED_DEFAULT, xx, zz, CELL, segmentation=seg)
        # arc_platform already puts the waterline at the landmass quantile;
        # the clamp is the one `generate` applies to the seafloor
        h = arc.arc_platform(arc.SEED_DEFAULT, 0.30, u, xx, zz,
                             detail=arc.ARC_DETAIL_DEFAULT)
        return np.maximum(h, -95.0)

    def setUp(self):
        self.off = up.divide_topology(self._platform(0.0), CELL)
        self.on = up.divide_topology(self._platform(1.0), CELL)

    def test_the_unsegmented_belt_is_one_island(self):
        self.assertEqual(self.off.islands, 1)

    def test_segmentation_makes_it_an_archipelago(self):
        self.assertGreaterEqual(self.on.islands, 3)

    def test_the_landmass_contract_survives(self):
        """Breaks remove land; the quantile has to put it back."""
        for r in (self.off, self.on):
            self.assertAlmostEqual(r.land_frac, 0.30, delta=0.01)

    def test_the_break_reaches_below_the_waterline(self):
        """A break that only notched the summits would leave one island."""
        self.assertGreater(self.on.islands, self.off.islands)

    def test_breaks_cut_the_submarine_ridge_too(self):
        """`floor` joins the centres below water; a strait needs it gone."""
        u = _uplift(segmentation=1.0, back_arc=0.0)
        base = _uplift(segmentation=1.0, back_arc=0.0, break_depth=0.0)
        # somewhere along the arc the segmented field is a small fraction of
        # the unbroken one — that cell is inside a break, ridge and all
        self.assertLess(float((u / np.maximum(base, 1e-6)).min()), 0.35)


class TestBackArcIsOnTheConcaveSide(unittest.TestCase):
    """One sign, silently invertible, so measure which side the mass is on."""

    def test_the_high_lands_towards_the_chord(self):
        with_bk = _uplift(segmentation=1.0, break_depth=0.0)
        without = _uplift(segmentation=1.0, break_depth=0.0, back_arc=0.0)
        added = np.maximum(with_bk - without, 0.0)
        self.assertGreater(added.sum(), 0.0)
        xx, zz = _grid()
        cz = float((added * zz).sum() / added.sum())
        cx = float((added * xx).sum() / added.sum())
        ax, az = arc.arc_centreline()
        # the arc bows away from its chord towards -z; the concave side is
        # therefore +z of the arc at the same x
        near = np.argmin(np.abs(ax - cx))
        self.assertGreater(cz, float(az[near]))


class TestTheAimRespondsToRemovedUplift(unittest.TestCase):
    """`scale_uplift_for_relief` sums U down a flow path, so a term that
    changes how much uplift there *is* moves the rate the aim hands back —
    the confound class M8r found in the platform grain and M8s in the
    erodibility field, arriving here through a third term.

    Measured on this 513^2 fixture: breaks alone **+5.0 %**, back-arc high
    alone **-1.2 %**, both together **+3.3 %** — i.e. the two halves of one
    knob push the aim in opposite directions and nearly cancel, which is why
    the terms are pinned separately rather than through their sum.
    """

    def _rate(self, **kw):
        xx, zz = _grid()
        k = arc.substrate_hardness(arc.SEED_DEFAULT, xx, zz)
        u = arc.arc_uplift(arc.SEED_DEFAULT, xx, zz, CELL, **kw)
        h = arc.arc_platform(arc.SEED_DEFAULT, 0.30, u, xx, zz, detail=0.0)
        return up.scale_uplift_for_relief(h, u, k, 950.0, router="dinf")

    def setUp(self):
        self.off = self._rate()

    def test_breaks_raise_the_rate(self):
        self.assertGreater(self._rate(segmentation=1.0, back_arc=0.0),
                           self.off * 1.03)

    def test_the_back_arc_high_lowers_it(self):
        self.assertLess(self._rate(segmentation=1.0, break_depth=0.0),
                        self.off)

    def test_together_they_nearly_cancel(self):
        both = self._rate(segmentation=1.0)
        self.assertGreater(both, self.off)
        self.assertLess(both, self.off * 1.10)


class TestSegmentationKeysTheCache(unittest.TestCase):
    def _path(self, terrain="arc", segmentation=0.0):
        return arc.erosion_cache_path(terrain, "dinf", arc.SEED_DEFAULT, 0.30,
                                      9, 950.0, arc.ARC_DETAIL_DEFAULT, False,
                                      0.0, segmentation)

    def test_two_segmentations_cannot_share_a_cache(self):
        self.assertNotEqual(self._path(segmentation=1.0), self._path())

    def test_off_appends_nothing(self):
        """Every pre-M8t surface stays addressable at its own name."""
        self.assertNotIn("_g", os.path.basename(self._path()))

    def test_the_key_carries_its_own_revision(self):
        self.assertIn(f"v{arc.SEG_REV}",
                      os.path.basename(self._path(segmentation=1.0)))

    def test_the_mounds_key_is_unchanged(self):
        p = os.path.basename(self._path(terrain="mounds", segmentation=1.0))
        self.assertEqual(
            p, f"archipelago_eroded_r{arc.SYNTH_REV}_mounds_dinf_"
               f"{arc.SEED_DEFAULT}_0.3_9_950.0_full.npy")


if __name__ == "__main__":
    unittest.main()
