"""Climate-scoped vegetation palettes (PLAN-maps M8o).

Three properties, each with a control that is checked to fail:

1. `temperate` is an exact identity — the palette IS `TEMPERATE_SPECIES`,
   `species_for_climate` returns the original eleven models in the original
   order, and `filter_defs_lua` with every name returns the file byte for
   byte. The shipped maps must not move.
2. No layer starves on its own climate. This is the reported defect: an
   arctic map placed 1 716 features against a temperate 17 798, with
   `tree_broadleaf` and `deadwood` warning "suitability covers 0.0000 % of
   the map". The positive control is the old code — `TEMPERATE_SPECIES` +
   `wooded=(FOREST,)` measured against an arctic biome mix, which must fail.
3. Composition follows the climate, not just density. A tropical map made
   of ridge conifers does not starve and is still wrong; before this table
   52 % of meridian's tropical features were conifers.

The biome mixes are the measured ones (`--fast`, land only) from M8n and
M8o, so a preset drifting away from the mix its palette was authored for
shows up here.
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from terragen import biomes as bio          # noqa: E402
from terragen import package as pkg         # noqa: E402
from terragen import placement as pl        # noqa: E402
from terragen import vegetation as veg      # noqa: E402


# Measured land mixes, --fast, archipelago / meridian2 (M8n table + M8o).
# WETLAND is deliberately absent from every row even though the generators
# report a few percent of it: wetland is river margin, and both generators
# exclude the dilated river corridor from placement, so a species that
# survives only on WETLAND does not survive at all. That is exactly how
# `tree_broadleaf` read 0.0000 % on an arctic map whose mix says 4.1 %.
BIOME_MIXES: dict[str, dict[str, dict[int, float]]] = {
    "temperate": {
        "archipelago": {bio.FOREST: 0.635, bio.GRASSLAND: 0.153,
                        bio.ROCK: 0.085, bio.TUNDRA: 0.082, bio.SNOW: 0.007},
        "meridian2": {bio.GRASSLAND: 0.501, bio.FOREST: 0.194,
                      bio.ROCK: 0.178, bio.TUNDRA: 0.073, bio.SNOW: 0.020,
                      bio.DESERT: 0.001},
    },
    "arctic": {
        "archipelago": {bio.SNOW: 0.589, bio.ROCK: 0.224, bio.TUNDRA: 0.146},
        "meridian2": {bio.SNOW: 0.417, bio.TUNDRA: 0.307, bio.ROCK: 0.243},
    },
    "arid": {
        "archipelago": {bio.DESERT: 0.556, bio.GRASSLAND: 0.319,
                        bio.ROCK: 0.060, bio.FOREST: 0.026},
        "meridian2": {bio.DESERT: 0.556, bio.GRASSLAND: 0.257,
                      bio.ROCK: 0.143, bio.FOREST: 0.010},
    },
    "tropical": {
        "archipelago": {bio.FOREST: 0.795, bio.GRASSLAND: 0.097,
                        bio.ROCK: 0.064, bio.TUNDRA: 0.005},
        "meridian2": {bio.GRASSLAND: 0.427, bio.FOREST: 0.368,
                      bio.ROCK: 0.147, bio.DESERT: 0.015, bio.TUNDRA: 0.010},
    },
}

GRID = 256

DEFS_LUA = os.path.join(os.path.dirname(HERE), "vegetation_defs.lua")


def _defs_lua() -> str:
    with open(DEFS_LUA) as f:
        return f.read()


def biome_field(mix: dict[int, float]) -> np.ndarray:
    """A (GRID, GRID) biome map with the given area fractions, laid out in
    contiguous bands so `forest_edge`-style neighbourhood tests still see a
    boundary. Any unassigned remainder is WATER (excluded ground)."""
    ids = np.full((GRID, GRID), bio.WATER, dtype=np.int32)
    row = 0
    for bid, frac in mix.items():
        rows = int(round(frac * GRID))
        ids[row:row + rows] = bid
        row += rows
    return ids


def coverage(sp: veg.Species, ids: np.ndarray) -> float:
    """Fraction of the map a species' density field is non-zero on — the
    same number `placement.run` compares against STARVE_COVERAGE."""
    moist = np.full(ids.shape, 0.5, dtype=np.float32)
    d = veg.build_density_field(sp, ids, moist, cellsize=32.0, seed=7)
    return float((d > 0).mean())


def density_mass(sp: veg.Species, ids: np.ndarray) -> float:
    moist = np.full(ids.shape, 0.5, dtype=np.float32)
    return float(veg.build_density_field(sp, ids, moist, 32.0, 7).sum())


class TestTemperateIdentity(unittest.TestCase):
    """The shipped maps regenerate byte-identically or this milestone is a
    regression, not a feature."""

    def test_temperate_palette_is_the_original_list_object(self):
        self.assertIs(veg.palette_for("temperate").species,
                      veg.TEMPERATE_SPECIES)

    def test_temperate_wooded_is_forest(self):
        self.assertEqual(veg.palette_for("temperate").wooded, (bio.FOREST,))

    def test_temperate_feature_names_are_the_original_eleven(self):
        self.assertEqual(
            veg.feature_names_for("temperate"),
            ("tree_conifer", "tree_broadleaf", "bush_scrub", "rock_boulder",
             "rock_boulder_large", "fallen_log", "tree_stump",
             "standing_stone", "ruin_pillar", "ruin_wall", "log_fence"))

    def test_filter_defs_lua_with_every_name_is_the_identity(self):
        src = _defs_lua()
        every = [ln.strip().split(" =")[0]
                 for ln in src.split("\n") if ln.endswith(" = {")]
        self.assertGreater(len(every), 11)
        self.assertEqual(pkg.filter_defs_lua(src, every), src)

    def test_filter_defs_lua_drops_a_heading_over_nothing(self):
        src = _defs_lua()
        out = pkg.filter_defs_lua(src, veg.feature_names_for("temperate"))
        self.assertNotIn("M8o", out)          # the climate-scoped heading
        self.assertNotIn("cactus_column", out)
        self.assertIn("tree_conifer", out)
        self.assertTrue(out.rstrip().endswith("})"))

    def test_every_climate_gets_defs_for_exactly_its_own_names(self):
        src = _defs_lua()
        for climate in veg.CLIMATE_PALETTES:
            with self.subTest(climate=climate):
                names = veg.feature_names_for(climate)
                out = pkg.filter_defs_lua(src, names)
                got = [ln.strip().split(" =")[0]
                       for ln in out.split("\n") if ln.endswith(" = {")]
                self.assertCountEqual(got, names)


class TestPaletteCoverage(unittest.TestCase):
    """Every climate has a palette, every palette has models."""

    def test_every_climate_preset_has_a_palette(self):
        self.assertEqual(sorted(veg.CLIMATE_PALETTES),
                         sorted(bio.CLIMATE_PRESETS))

    def test_unknown_climate_raises(self):
        with self.assertRaises(ValueError):
            veg.palette_for("martian")

    def test_every_species_has_a_model_builder(self):
        import gen_vegetation_models as gvm
        for climate in veg.CLIMATE_PALETTES:
            with self.subTest(climate=climate):
                for name in veg.feature_names_for(climate):
                    self.assertIn(name, gvm.SPECIES)

    def test_species_for_climate_temperate_is_the_original_order(self):
        import gen_vegetation_models as gvm
        self.assertEqual(list(gvm.species_for_climate("temperate")),
                         list(veg.feature_names_for("temperate")))

    def test_no_duplicate_species_within_a_palette(self):
        for climate, p in veg.CLIMATE_PALETTES.items():
            with self.subTest(climate=climate):
                names = [sp.name for sp in p.species]
                self.assertEqual(len(names), len(set(names)))


class TestNoLayerStarves(unittest.TestCase):
    """The reported defect, as a guard."""

    def test_every_species_covers_its_own_climate(self):
        for climate, maps in BIOME_MIXES.items():
            palette = veg.palette_for(climate)
            for map_name, mix in maps.items():
                ids = biome_field(mix)
                for sp in palette.species:
                    with self.subTest(climate=climate, map=map_name,
                                      species=sp.name):
                        self.assertGreaterEqual(
                            coverage(sp, ids), pl.STARVE_COVERAGE,
                            f"{sp.name} starves on a {climate} {map_name}")

    def test_wooded_biomes_exist_on_their_own_climate(self):
        """`deadwood` keys off the palette's wooded set, not off FOREST."""
        for climate, maps in BIOME_MIXES.items():
            wooded = veg.palette_for(climate).wooded
            for map_name, mix in maps.items():
                with self.subTest(climate=climate, map=map_name):
                    share = sum(mix.get(b, 0.0) for b in wooded)
                    self.assertGreaterEqual(share, 0.01)

    def test_positive_control_the_old_table_fails_on_an_arctic_map(self):
        """The pre-M8o code, measured the same way, must starve — otherwise
        this whole test file proves nothing."""
        ids = biome_field(BIOME_MIXES["arctic"]["archipelago"])
        starved = [sp.name for sp in veg.TEMPERATE_SPECIES
                   if coverage(sp, ids) < pl.STARVE_COVERAGE]
        self.assertIn("tree_broadleaf", starved)
        # and the hard-coded deadwood biome is simply absent
        self.assertEqual(BIOME_MIXES["arctic"]["archipelago"].get(bio.FOREST,
                                                                  0.0), 0.0)


class TestComposition(unittest.TestCase):
    """Density was only half the defect: FOREST was FOREST to one table."""

    def test_tropical_forest_is_broadleaf_not_conifer(self):
        for map_name, mix in BIOME_MIXES["tropical"].items():
            ids = biome_field(mix)
            palette = veg.palette_for("tropical")
            by = {sp.name: density_mass(sp, ids) for sp in palette.species}
            with self.subTest(map=map_name):
                self.assertGreater(by["tree_broadleaf"],
                                   4.0 * by["tree_conifer"])

    def test_arid_desert_carries_its_own_species(self):
        for map_name, mix in BIOME_MIXES["arid"].items():
            ids = biome_field(mix)
            desert_only = (ids == bio.DESERT)
            moist = np.full(ids.shape, 0.35, dtype=np.float32)
            names = {sp.name: float(veg.build_density_field(
                sp, ids, moist, 32.0, 7)[desert_only].sum())
                for sp in veg.palette_for("arid").species}
            with self.subTest(map=map_name):
                self.assertGreater(names["desert_shrub"] + names["cactus_column"],
                                   2.0 * names["bush_scrub"])
                # and the old table put next to nothing there
                old = {sp.name: float(veg.build_density_field(
                    sp, ids, moist, 32.0, 7)[desert_only].sum())
                    for sp in veg.TEMPERATE_SPECIES}
                self.assertGreater(names["desert_shrub"],
                                   3.0 * old["bush_scrub"])

    def test_arctic_snow_is_not_empty_ground(self):
        for map_name, mix in BIOME_MIXES["arctic"].items():
            ids = biome_field(mix)
            snow = (ids == bio.SNOW)
            moist = np.full(ids.shape, 0.5, dtype=np.float32)
            on_snow = {sp.name: float(veg.build_density_field(
                sp, ids, moist, 32.0, 7)[snow].sum())
                for sp in veg.palette_for("arctic").species}
            with self.subTest(map=map_name):
                self.assertGreater(on_snow["dead_snag"], 0.0)
                self.assertGreater(sum(on_snow.values()), 0.0)


if __name__ == "__main__":
    unittest.main()
