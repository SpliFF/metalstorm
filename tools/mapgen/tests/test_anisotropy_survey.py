#!/usr/bin/env python3
"""Tests for the pooled anisotropy survey (terragen/uplift.py, PLAN-maps M8v).

    python3 -m unittest tests.test_anisotropy_survey

Why this file exists, and why each case is here rather than being obvious:

  * **the reading has to read null on null.** `anisotropy_survey`'s whole
    claim over `anisotropy_bands` is that its floor is matched to the
    *pooling*, not to one crop — pooling `n` histograms lowers the peak an
    isotropic field can show, and by an amount that depends on how much the
    tiles overlap, so a single-crop floor over-divides and a floor built
    from `n` independent fields under-divides (M8v measured 1.42 against
    1.70 on the same surface for that second mistake). The control is a
    **held-out** isotropic field — a seed the null never drew — which must
    survey to 1.0 in every band.

  * **and it has to read a comb as a comb.** The positive control is a
    grating: excess far above the null, with the lead lobe on the grating's
    own axis, and the lobe following the grating when it is rotated 90°.
    Without it the first test passes on a function that returns 1.0.

  * **pooling is what buys the headroom.** The pooled floor sits below the
    single-crop floor of the same tile size at the coarse end, which is the
    documented reason the survey can see a 300-800 elmo effect the crop
    reading buries. Pinned so a future change to the null cannot quietly
    give it back.

  * **the refactor guard.** `_angular_power_bands` computes a whole band
    ladder off one transform and `_angular_power` is now a wrapper over it;
    the two must agree bit for bit or every historical number in the
    docstrings silently changes meaning.

  * **tile selection is part of the reading**, so it is pinned: sea-heavy
    windows are dropped, a grid smaller than one tile still returns a
    reading, and an all-sea grid falls back to every window rather than
    raising.
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from terragen import uplift as up   # noqa: E402

CELL = 8.0
N = 513          # test grid
TILE = 257
STRIDE = 128
SEEDS = 3
BANDS = up.ANISOTROPY_BANDS


def survey(dem, **kw):
    kw.setdefault("tile", TILE)
    kw.setdefault("stride", STRIDE)
    kw.setdefault("seeds", SEEDS)
    return up.anisotropy_survey(dem, CELL, **kw)


def land(field):
    """Lift a field clear of zero so every window counts as land."""
    return field - field.min() + 1.0


def grating(period_elmos, degrees, n=N, cell=CELL, seed=5):
    """Parallel ridges of one wavelength, plus a little broadband noise."""
    z, x = np.mgrid[0:n, 0:n] * cell
    th = np.radians(degrees)
    proj = x * np.cos(th) + z * np.sin(th)
    rng = np.random.default_rng(seed)
    return (np.sin(2 * np.pi * proj / period_elmos) * 40.0
            + rng.normal(scale=1.0, size=(n, n)))


class SurveyNull(unittest.TestCase):
    def test_held_out_isotropic_field_surveys_to_one(self):
        """The null reads null — on a seed the null itself never drew."""
        f = land(up._isotropic_field((N, N), 12345))
        for r in survey(f):
            self.assertAlmostEqual(
                r.excess, 1.0, delta=0.25,
                msg=f"{r.lo:.0f}-{r.hi:.0f} elmos read {r.excess:.2f} on a "
                    "field with no structure")

    def test_pooled_floor_is_below_the_single_crop_floor(self):
        """Pooling lowers what noise alone can score — that IS the headroom.

        Asserted where the property is worth something: the two coarse
        bands, whose floor is nearly all tile-count. The 32-120 row is a
        tie at this grid and this many replicates (1.452 against 1.441 at
        3 seeds, 1.409 against 1.642 at 8) — overlap costs about what
        pooling buys once a band holds plenty of spectral samples — so it
        is pinned only as "no worse", not as a win.
        """
        pos, tile = up.survey_tiles(np.ones((N, N)), TILE, STRIDE, 0.25)
        self.assertGreater(len(pos), 1)
        pooled = up._survey_floor((N, N), CELL, pos, tile, BANDS, 90, SEEDS)
        single = up.anisotropy_floor((tile, tile), CELL, BANDS, 90, SEEDS)
        for (lo, hi), p, s in zip(BANDS, pooled, single):
            self.assertLess(p, s * 1.1,
                            f"{lo:.0f}-{hi:.0f}: pooled floor {p:.2f} is above "
                            f"the single-crop {s:.2f}")
        for i in (2, 3):
            self.assertLess(pooled[i], single[i] * 0.8,
                            f"{BANDS[i][0]:.0f}-{BANDS[i][1]:.0f} is where "
                            "pooling has to pay and it did not")

    def test_reading_is_deterministic(self):
        f = land(up._isotropic_field((N, N), 99))
        a = [r.excess for r in survey(f)]
        b = [r.excess for r in survey(f)]
        self.assertEqual(a, b)


class SurveySignal(unittest.TestCase):
    def test_a_grating_reads_far_above_the_null(self):
        g = land(grating(64.0, 30.0))
        null = land(up._isotropic_field((N, N), 12345))
        band = 1                       # 32-120 elmos, where the ridges live
        got = survey(g)[band].excess
        self.assertGreater(got, 3.0 * survey(null)[band].excess,
                           f"a pure comb surveyed {got:.2f}")

    def test_the_lead_lobe_follows_the_grating(self):
        """Rotating the ridges 90 deg rotates the reading 90 deg."""
        band = 1
        a = survey(land(grating(64.0, 30.0)))[band].lobes[0][0]
        b = survey(land(grating(64.0, 120.0)))[band].lobes[0][0]
        sep = abs((a - b) % 180.0)
        self.assertAlmostEqual(min(sep, 180.0 - sep), 90.0, delta=8.0,
                               msg=f"lobes {a:.0f} and {b:.0f} deg")

    def test_tile_spread_brackets_the_pooled_reading(self):
        """`tile_lo`/`tile_hi` are the raw per-tile scatter, not an error bar."""
        for r in survey(land(grating(64.0, 30.0))):
            self.assertLessEqual(r.tile_lo, r.tile_hi)
            self.assertGreaterEqual(r.tiles, 4)


class TileSelection(unittest.TestCase):
    def test_sea_heavy_windows_are_dropped(self):
        dem = np.full((N, N), -50.0)
        dem[:TILE, :TILE] = 10.0                  # one land quadrant
        pos, tile = up.survey_tiles(dem, TILE, STRIDE, 0.25)
        self.assertEqual(tile, TILE)
        self.assertLess(len(pos), 9)
        self.assertIn((0, 0), pos)
        for z, x in pos:
            self.assertGreaterEqual(float((dem[z:z + TILE, x:x + TILE] > 0).mean()),
                                    0.25)

    def test_all_sea_falls_back_to_every_window(self):
        pos, _ = up.survey_tiles(np.full((N, N), -50.0), TILE, STRIDE, 0.25)
        self.assertEqual(len(pos), 9)

    def test_grid_smaller_than_a_tile_still_reads(self):
        small = land(up._isotropic_field((129, 129), 3))
        pos, tile = up.survey_tiles(small, TILE, STRIDE, 0.25)
        self.assertEqual((pos, tile), ([(0, 0)], 129))
        self.assertEqual(survey(small, seeds=1)[0].tiles, 1)


class RefactorGuard(unittest.TestCase):
    def test_band_ladder_matches_the_single_band_entry_point(self):
        f = land(up._isotropic_field((TILE, TILE), 7))
        ladder = up._angular_power_bands(f, CELL, BANDS, 90)
        for (lo, hi), got in zip(BANDS, ladder):
            want = up._angular_power(f, CELL, lo, hi, 90)
            np.testing.assert_array_equal(got, want)

    def test_lobes_of_matches_angular_lobes(self):
        f = land(grating(64.0, 30.0, n=TILE))
        want = up.angular_lobes(f, CELL, 32.0, 120.0, 90, 3)
        got = up._lobes_of(up._angular_power(f, CELL, 32.0, 120.0, 90), 3, 2)
        self.assertEqual(got, want)


if __name__ == "__main__":
    unittest.main()
