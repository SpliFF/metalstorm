#!/usr/bin/env python3
"""Tests for the climate fields (terragen/biomes.py, PLAN-maps.md §2b item 4).

    tools/mapgen/.venv/bin/python -m unittest discover -s tools/mapgen/tests

Synthetic terrain only, for the reason test_town_planner.py already gives:
a clone has no generated map to read. The terrain is faked; the model is real.

What this pins down, and why each control is here:

  * rain shadow direction — the lee of a ridge is drier than its windward
    slope, and reversing the wind swaps them. Both models pass this; it is the
    floor, not the point.
  * THE MOISTURE BUDGET — the one property that separates "sweep" from the
    "ridge" running-max it replaced. Behind two identical ridges in series,
    the running max dries the second lee exactly as hard as the first (it has
    no budget: it only ever asks "how far below the highest thing upwind am
    I?"). A real air parcel arrives at the second ridge already wrung out and
    has less left to lose. `test_second_ridge_in_a_series_is_drier_...` is
    checked to FAIL on "ridge" (asserted, so it cannot rot into a tautology).
  * mean preservation — rainfall redistributes moisture; it does not destroy
    it. The "ridge" model only ever subtracted, so `rain_shadow` was a global
    drying knob as well as a contrast knob, and both shipped maps had to be
    re-based when this landed (meridian -0.032, skerry -0.070).
  * the upwind edge — the parcel enters in equilibrium with the ground rather
    than saturated. Saturated entry over a land edge dumped 25.3% of
    meridian_basin's entire rainfall budget into column 0.
  * determinism and no free lunch over water.

mapgen4's [0.2, 0.6, 0.2] across-wind kernel has no test because it is not in
the code: measured against no kernel at all it moved across-wind roughness by
0.2% on meridian and -1.9% on skerry, and feathered a half-width ridge's
shadow edge by 2 rows of 96 that the post-sweep blur covers anyway. It is a
device for mapgen4's irregular Voronoi mesh, not for a regular grid.

Measured on the real shipped heightmaps, 2026-08-08 (windward-minus-lee mean
moisture within 512 elmos of each row's peak):
meridian_basin +0.0061 (ridge) -> +0.0580 (sweep), 9.5x;
skerry_reach   +0.0162 (ridge) -> +0.0946 (sweep), 5.8x,
at matched land-mean moisture (0.4908/0.4908 and 0.6646/0.6665) and a biome
mix within ~1 pp / ~2.3 pp — i.e. the same wetness budget, placed better.
"""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from terragen import biomes as bio  # noqa: E402

CELL = 8.0


def flat(shape=(96, 160), height=100.0):
    return np.full(shape, height, dtype=np.float64)


def ridge_at(cols, shape=(96, 160), base=100.0, peak=900.0, width=6.0):
    """Flat land with one or more across-wind ridges (wind runs along +x)."""
    h = flat(shape, base)
    x = np.arange(shape[1], dtype=np.float64)
    for c in cols:
        h += (peak - base) * np.exp(-0.5 * ((x - c) / width) ** 2)[None, :]
    return h


def centred_ridge(shape=(96, 160), **kw):
    """A ridge on the array's exact mirror axis, so mirror(h) == h.

    Not a detail: with the ridge at column 80 of 160 the terrain is one column
    off centre, and a mirror-symmetry assertion fails by 3% on the terrain
    rather than on the model. That is how this helper came to exist.
    """
    return ridge_at([(shape[1] - 1) / 2.0], shape=shape, **kw)


def params(**kw):
    kw.setdefault("wind_dir", (1.0, 0.0))
    kw.setdefault("moisture_noise", 0.0)   # isolate the orographic term
    kw.setdefault("water_bonus", 0.0)
    kw.setdefault("temp_noise", 0.0)
    return bio.ClimateParams(**kw)


def band_mean(m, lo, hi):
    return float(m[:, lo:hi].mean())


class TestOrographicRainfall(unittest.TestCase):
    def test_rainfall_over_water_is_zero(self):
        h = flat(height=-50.0)
        h[:, 80:] = 200.0
        rain = bio.orographic_rainfall(h, 0.0, params(), CELL)
        self.assertTrue(np.all(rain[h <= 0.0] == 0.0))
        self.assertGreater(rain[h > 0.0].sum(), 0.0, "land got no rain at all")

    def test_the_lee_of_a_ridge_is_drier_than_its_windward_slope(self):
        h = ridge_at([80])
        for model in ("ridge", "sweep"):
            m = bio.moisture_field(h, 0.0, params(orographic=model), CELL)
            windward, lee = band_mean(m, 40, 74), band_mean(m, 86, 120)
            self.assertGreater(windward, lee, f"{model}: no rain shadow at all")

    def test_reversing_the_wind_mirrors_the_shadow(self):
        h = centred_ridge()
        fwd = bio.moisture_field(h, 0.0, params(wind_dir=(1.0, 0.0)), CELL)
        rev = bio.moisture_field(h, 0.0, params(wind_dir=(-1.0, 0.0)), CELL)
        self.assertGreater(band_mean(fwd, 40, 74), band_mean(fwd, 86, 120))
        self.assertGreater(band_mean(rev, 86, 120), band_mean(rev, 40, 74))
        np.testing.assert_allclose(fwd, rev[:, ::-1], atol=1e-12)

    def test_a_cross_wind_sweep_shadows_along_z(self):
        """The same ridge rotated 90 degrees with the wind rotated to match."""
        h = ridge_at([80]).T.copy()
        m = bio.moisture_field(h, 0.0, params(wind_dir=(0.0, 1.0)), CELL)
        self.assertGreater(float(m[40:74, :].mean()), float(m[86:120, :].mean()))

    def test_second_ridge_in_a_series_is_drier_because_humidity_is_a_budget(self):
        """The find that motivates the whole item, as an assertion.

        Two identical ridges, evenly spaced. Measure the drop each one causes
        (windward band minus lee band). A model with a moisture budget must
        take LESS at the second ridge, because the parcel arrives already
        wrung out. The running-max model has no budget and takes at least as
        much -- asserted below, so this test cannot quietly stop discriminating.
        """
        h = ridge_at([50, 110])
        drops = {}
        for model in ("ridge", "sweep"):
            m = bio.moisture_field(h, 0.0, params(orographic=model), CELL)
            first = band_mean(m, 20, 44) - band_mean(m, 56, 80)
            second = band_mean(m, 80, 104) - band_mean(m, 116, 140)
            drops[model] = (first, second)

        s_first, s_second = drops["sweep"]
        self.assertGreater(s_first, 0.0, "sweep: first ridge cast no shadow")
        self.assertLess(s_second, s_first * 0.9,
                        f"sweep: second ridge took {s_second:.4f} of a first "
                        f"{s_first:.4f} -- humidity is not behaving as a budget")

        r_first, r_second = drops["ridge"]
        self.assertGreaterEqual(
            r_second, r_first * 0.9,
            "the 'ridge' control now also conserves a budget, so this test no "
            "longer distinguishes the models -- rewrite it before trusting it")

    def test_a_land_upwind_edge_does_not_dump_the_whole_budget(self):
        """The parcel enters in equilibrium with the ground, not saturated.

        Saturated entry over land is instant excess: on meridian_basin, whose
        upwind edge is land, column 0 alone took 25.3% of the map's whole
        rainfall budget. Over water the parcel does still start saturated.
        """
        land_edge = ridge_at([120])                 # land all the way to x=0
        rain = bio.orographic_rainfall(land_edge, 0.0, params(), CELL)
        first = float(rain[:, 0].sum() / max(rain.sum(), 1e-12))
        self.assertLess(first, 0.05,
                        f"upwind column took {100 * first:.1f}% of the budget")

        sea_edge = ridge_at([120])
        sea_edge[:, :20] = -20.0                    # ocean upwind of the ridge
        wet = bio.orographic_rainfall(sea_edge, 0.0, params(), CELL)
        self.assertGreater(wet[sea_edge > 0.0].sum(), rain[land_edge > 0.0].sum(),
                           "an ocean upwind did not make the map any wetter")

    def test_terrain_constant_across_the_wind_gives_rainfall_constant_across_it(self):
        """Negative control: the model must not invent across-wind structure."""
        h = ridge_at([80])                          # varies along x only
        rain = bio.orographic_rainfall(h, 0.0, params(), CELL)
        self.assertLess(float(rain.std(axis=0).max()), 1e-12)

    def test_flat_land_gets_no_shadow_structure(self):
        """Negative control: no relief, so nothing for the model to invent."""
        h = flat()
        rain = bio.orographic_rainfall(h, 0.0, params(), CELL)
        self.assertLess(float(rain.std()), 1e-9)
        m = bio.moisture_field(h, 0.0, params(orographic="sweep"), CELL)
        self.assertLess(float(m.std()), 1e-6, "invented moisture variation")

    def test_deterministic_and_view_independent(self):
        h = ridge_at([80])
        a = bio.orographic_rainfall(h, 0.0, params(), CELL)
        b = bio.orographic_rainfall(h.copy(), 0.0, params(), CELL)
        np.testing.assert_array_equal(a, b)
        # a non-contiguous view of the same data must give the same answer
        wide = np.repeat(h, 2, axis=1)[:, ::2]
        self.assertFalse(wide.flags["C_CONTIGUOUS"])
        np.testing.assert_array_equal(a, bio.orographic_rainfall(wide, 0.0, params(), CELL))


class TestMeanPreservation(unittest.TestCase):
    def test_centred_unit_has_zero_mean_over_the_mask(self):
        rng = np.random.default_rng(3)
        f = rng.random((64, 64))
        mask = np.zeros((64, 64), dtype=bool)
        mask[8:56, 8:56] = True
        u = bio._centred_unit(f, mask)
        self.assertAlmostEqual(float(u[mask].mean()), 0.0, places=12)
        self.assertLessEqual(float(u.max()), 1.0)
        self.assertGreaterEqual(float(u.min()), -1.0)

    def test_centred_unit_survives_a_constant_field(self):
        f = np.full((16, 16), 0.25)
        u = bio._centred_unit(f, np.ones((16, 16), dtype=bool))
        np.testing.assert_array_equal(u, np.zeros((16, 16)))

    def test_sweep_redistributes_moisture_where_ridge_only_removed_it(self):
        h = ridge_at([80])
        land = h > 0.0
        dry = bio.moisture_field(h, 0.0, params(rain_shadow=0.0), CELL)
        base = float(dry[land].mean())
        sweep = float(bio.moisture_field(
            h, 0.0, params(orographic="sweep"), CELL)[land].mean())
        ridge = float(bio.moisture_field(
            h, 0.0, params(orographic="ridge"), CELL)[land].mean())
        self.assertAlmostEqual(sweep, base, places=3)
        self.assertLess(ridge, base - 0.01,
                        "the 'ridge' control has stopped drying the map, so "
                        "the re-based base_moisture in meridian2/archipelago "
                        "is measuring something else now")


class TestClimateParams(unittest.TestCase):
    def test_unknown_orographic_model_is_refused(self):
        h = ridge_at([80])
        with self.assertRaises(ValueError):
            bio.moisture_field(h, 0.0, params(orographic="mapgen4"), CELL)

    def test_no_wind_means_no_orographic_term_at_all(self):
        h = ridge_at([80])
        off = bio.moisture_field(h, 0.0, params(wind_dir=None), CELL)
        zero = bio.moisture_field(h, 0.0, params(rain_shadow=0.0), CELL)
        np.testing.assert_array_equal(off, zero)

    def test_rain_shadow_scales_the_contrast(self):
        h = ridge_at([80])
        contrasts = []
        for amp in (0.1, 0.35, 0.7):
            m = bio.moisture_field(h, 0.0, params(rain_shadow=amp), CELL)
            contrasts.append(band_mean(m, 40, 74) - band_mean(m, 86, 120))
        self.assertLess(contrasts[0], contrasts[1])
        self.assertLess(contrasts[1], contrasts[2])


if __name__ == "__main__":
    unittest.main()
