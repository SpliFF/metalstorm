#!/usr/bin/env python3
"""Tests for road SURFACE classes and the mapinfo terrainTypes shape (roads R1).

    cd tools/mapgen && .venv/bin/python -m unittest tests.test_road_surface

What this pins down, and why each one is here rather than being obvious:

  * **the mapinfo terrainTypes shape is pinned against the C++ that reads it.**
    Before R1 the emitter wrote FLAT `tankspeed = 1.35` keys while
    `CMapInfo::ReadTerrainTypes` reads a NESTED `moveSpeeds` subtable with no
    flat fallback (`SubTable("moveSpeeds").GetFloat("tank", 1.0f)`), so the
    1.35 every terragen map has shipped since the emitter was written was
    parsed by nobody and roads have never been faster than open ground in this
    port. Nothing failed, nothing warned: the map shipped a value and the
    engine took its default. `MapInfoContract` therefore reads the real
    `rts/Map/MapInfo.cpp` and demands the emitter write where it looks — a
    shape test that cannot pass by agreeing with itself.
  * **a sealed road stays sealed across a wet dip.** The mud rule is a terrain
    rule, so without an exception a trunk highway would turn to mud every time
    it crossed a ford. `test_seal_survives_wet_ground` is that exception, and
    `test_unsealed_goes_muddy_in_the_wet` is the same fixture proving the rule
    it excepts from is live.
  * **short runs collapse.** A per-vertex classification of a wandering road
    produces one- and two-vertex flecks wherever a field grazes its threshold,
    which read as texture noise rather than as a bog. The collapse is the
    difference between "the road gets muddy in the hollow" and "the road is
    speckled", and it has to be idempotent or it just moves the flecks.
  * **the class raster cannot disagree with the road mask.** They are grown by
    the same distance transform for exactly this reason; the test asserts the
    mask and distance field are bit-identical to `rasterize_roads`' and that
    the class is non-zero on precisely the deck.
  * **the typemap carries the classes.** A class raster that never reaches the
    SMF is a texture-only feature — `receiveTracks` and the per-move-class
    speeds all key off the typemap value.
"""
import os
import re
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MAPGEN = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(MAPGEN, "..", ".."))
sys.path.insert(0, MAPGEN)

from terragen import bake as bk          # noqa: E402
from terragen import package as pkg      # noqa: E402
from terragen import roads as rd         # noqa: E402


def straight_line(x0, z0, x1, z1, n=64):
    t = np.linspace(0.0, 1.0, n)
    return np.stack([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t], axis=1)


class MapInfoContract(unittest.TestCase):
    """The emitted mapinfo must put move speeds where MapInfo.cpp reads them."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(REPO, "rts", "Map", "MapInfo.cpp")) as f:
            cls.cpp = f.read()
        cls.lua = pkg.emit_mapinfo(pkg.MapPackageConfig(
            map_id="t", display_name="T", start_positions=[(10.0, 10.0)]))

    def test_the_reader_still_wants_a_nested_moveSpeeds_subtable(self):
        # If this fails the ENGINE moved, and the emitter must follow it.
        body = self.cpp.split("void CMapInfo::ReadTerrainTypes()")[1]
        self.assertIn('SubTable("moveSpeeds")', body)
        for key in ("tank", "kbot", "hover", "ship"):
            self.assertRegex(body, r'GetFloat\(\s*"%s"' % key)
        self.assertIn('GetBool("receiveTracks"', body)
        # and it has no flat fallback — the reason the old emitter was silent
        for flat in ("tankspeed", "tankSpeed\"", "kbotspeed"):
            self.assertNotIn('GetFloat("%s"' % flat, body)

    def test_every_terrain_type_writes_the_nested_table(self):
        blocks = re.findall(r"\[(\d+)\]\s*=\s*\{(.*?)\n        \}", self.lua, re.S)
        self.assertGreaterEqual(len(blocks), 4, self.lua)
        for idx, body in blocks:
            self.assertIn("moveSpeeds = {", body, f"terrain type {idx}")
            for key in ("tank", "kbot", "hover", "ship"):
                self.assertRegex(body, r"\b%s\s*=" % key, f"terrain type {idx}")

    def test_no_flat_speed_key_survives_anywhere(self):
        # the exact spelling that shipped inert on every terragen map
        for flat in ("tankspeed", "kbotspeed", "hoverspeed", "shipspeed"):
            self.assertNotIn(flat, self.lua)

    def test_the_typemap_values_are_the_surface_class_ids(self):
        names = dict(re.findall(r"\[(\d+)\]\s*=\s*\{\s*\n\s*name\s*=\s*\"([a-z]+)\"",
                                self.lua))
        self.assertEqual(names.get("0"), "default")
        for cls_id, name in rd.SURFACE_NAMES.items():
            self.assertEqual(names.get(str(cls_id)), name)

    def test_soft_surfaces_receive_tracks_and_sealed_ones_do_not(self):
        blocks = dict((int(i), b) for i, b in
                      re.findall(r"\[(\d+)\]\s*=\s*\{(.*?)\n        \}", self.lua, re.S))
        self.assertIn("receiveTracks = false", blocks[rd.SURF_BITUMEN])
        self.assertIn("receiveTracks = true", blocks[rd.SURF_DIRT])
        self.assertIn("receiveTracks = true", blocks[rd.SURF_MUD])

    def test_the_shipped_speeds_are_the_measured_ladder(self):
        # roads R3 (2026-08-15) woke the multiplier off a measured headless
        # transit on meridian_basin's own deck: over a 512-elmo gated straight
        # one VEH squad took 236 frames on open ground, 172 at dirt's 1.25 and
        # 139 at bitumen's 1.60, with the off-deck control identical in every
        # arm. These are those values; changing one is a gameplay change owed
        # its own measurement (PLAN-maps §2e).
        cfg = pkg.MapPackageConfig(map_id="t", display_name="T")
        self.assertEqual(
            (cfg.bitumen_type_speed, cfg.dirt_type_speed, cfg.mud_type_speed),
            (1.60, 1.25, 1.00))

    def test_the_ladder_is_ordered_and_mud_never_repels(self):
        # The ORDER is the gameplay claim (sealed beats unsealed beats wet) and
        # it must hold whatever the numbers are retuned to. Mud is pinned at or
        # above 1.0 for a measured reason: at 0.85 the unit steers OFF the deck
        # (25 % on-deck over the same straight), and mud sits in the deck's wet
        # dips, so a repelling class pushes convoys toward the water the ford
        # was built to cross.
        cfg = pkg.MapPackageConfig(map_id="t", display_name="T")
        self.assertGreater(cfg.bitumen_type_speed, cfg.dirt_type_speed)
        self.assertGreater(cfg.dirt_type_speed, cfg.mud_type_speed)
        self.assertGreaterEqual(cfg.mud_type_speed, 1.0)

    def test_the_measured_values_reach_the_nested_table(self):
        lua = pkg.emit_mapinfo(pkg.MapPackageConfig(map_id="t", display_name="T"))
        for idx, want in ((1, 1.6), (2, 1.25), (3, 1.0)):
            block = re.search(r"\[%d\]\s*=\s*\{(.*?)\n        \}" % idx, lua, re.S).group(1)
            for key in ("tank", "kbot", "hover"):
                self.assertRegex(block, r"%s\s*=\s*%s\b" % (key, want),
                                 f"terrain type {idx}")
            # ship stays 1.0: a boat is never on a road deck (see the submerged
            # -deck rule in package.write_package).
            self.assertRegex(block, r"ship\s*=\s*1\.0")

    def test_the_typemap_is_what_gates_dynamic_tyre_tracks(self):
        # per-class receiveTracks is only worth writing because the server
        # reads it through the typemap for every track segment it emits; if
        # this gate moves, `receiveTracks = false` on bitumen stops meaning
        # anything and the emitter half of R1 is silently gone.
        with open(os.path.join(REPO, "rts", "Server", "ServerTrackEmitter.cpp")) as f:
            emitter = f.read()
        self.assertIn("GetTypeMapSynced()", emitter)
        self.assertIn("terrainTypes[tt].receiveTracks", emitter)

    def test_a_configured_speed_reaches_the_nested_table(self):
        lua = pkg.emit_mapinfo(pkg.MapPackageConfig(
            map_id="t", display_name="T", bitumen_type_speed=1.4))
        block = re.search(r"\[1\]\s*=\s*\{(.*?)\n        \}", lua, re.S).group(1)
        self.assertRegex(block, r"tank\s*=\s*1\.4")


class Classification(unittest.TestCase):
    def setUp(self):
        self.cell = 8.0
        shape = (128, 128)
        self.height = np.full(shape, 40.0)
        self.moist = np.full(shape, 0.2)

    def test_the_trunk_is_sealed_and_the_branch_is_not(self):
        long_link = straight_line(50.0, 50.0, 950.0, 50.0)
        short_link = straight_line(50.0, 200.0, 200.0, 200.0)
        cls = rd.classify_roads([long_link, short_link], self.moist,
                                self.height, 0.0, self.cell)
        self.assertTrue((cls[0] == rd.SURF_BITUMEN).all())
        self.assertTrue((cls[1] == rd.SURF_DIRT).all())

    def test_the_seal_is_a_LENGTH_budget_not_a_count(self):
        # four links: one long, three short. A median-by-count rule seals two
        # of them (and, because the long one dominates, ~most of the deck);
        # the budget seals only what fits in 40 % of the network's length.
        links = [straight_line(50.0, 50.0, 950.0, 50.0)]
        links += [straight_line(50.0, 100.0 * i, 250.0, 100.0 * i)
                  for i in range(3, 6)]
        cls = rd.classify_roads(links, self.moist, self.height, 0.0, self.cell)
        sealed = [i for i, c in enumerate(cls) if c[0] == rd.SURF_BITUMEN]
        self.assertEqual(sealed, [0])
        # and the budget is honoured, not just "the longest": ask for 90 % and
        # the short links come in too
        s = rd.SurfaceParams(sealed_length_fraction=0.9)
        cls2 = rd.classify_roads(links, self.moist, self.height, 0.0, self.cell, s)
        self.assertGreater(len([c for c in cls2 if c[0] == rd.SURF_BITUMEN]), 1)

    def test_a_lone_link_is_the_trunk(self):
        cls = rd.classify_roads([straight_line(50.0, 50.0, 950.0, 50.0)],
                                self.moist, self.height, 0.0, self.cell)
        self.assertTrue((cls[0] == rd.SURF_BITUMEN).all())

    def test_unsealed_goes_muddy_in_the_wet(self):
        # a long wet band across the middle of the short (unsealed) link
        self.moist[:, 40:80] = 0.9
        long_link = straight_line(50.0, 50.0, 950.0, 50.0)
        short_link = straight_line(50.0, 200.0, 950.0, 200.0)
        # make the short link genuinely shorter so it classifies as a branch
        short_link = short_link[: int(len(short_link) * 0.9)]
        cls = rd.classify_roads([long_link, short_link], self.moist,
                                self.height, 0.0, self.cell)
        self.assertIn(rd.SURF_MUD, set(cls[1].tolist()))
        self.assertIn(rd.SURF_DIRT, set(cls[1].tolist()))

    def test_seal_survives_wet_ground(self):
        self.moist[:, 40:80] = 0.9
        long_link = straight_line(50.0, 50.0, 950.0, 50.0)
        short_link = straight_line(50.0, 200.0, 900.0, 200.0)
        cls = rd.classify_roads([long_link, short_link], self.moist,
                                self.height, 0.0, self.cell)
        self.assertNotIn(rd.SURF_MUD, set(cls[0].tolist()))
        # and the exception is an exception, not the absence of the rule:
        # the same fixture with sealing off puts mud on the trunk
        s = rd.SurfaceParams(seal_survives_wet=False)
        cls2 = rd.classify_roads([long_link, short_link], self.moist,
                                 self.height, 0.0, self.cell, s)
        self.assertIn(rd.SURF_MUD, set(cls2[0].tolist()))

    def test_low_freeboard_is_muddy_even_when_dry(self):
        self.height[:, 40:80] = 1.0        # water table at the surface
        links = [straight_line(50.0, 50.0, 950.0, 50.0),
                 straight_line(50.0, 200.0, 900.0, 200.0)]
        s = rd.SurfaceParams(seal_survives_wet=False)
        cls = rd.classify_roads(links, self.moist, self.height, 0.0, self.cell, s)
        self.assertIn(rd.SURF_MUD, set(cls[0].tolist()))

    def test_short_runs_collapse_and_the_collapse_is_idempotent(self):
        # a two-cell wet fleck: a texture artefact, not a bog
        self.moist[:, 60:62] = 0.9
        link = straight_line(50.0, 200.0, 900.0, 200.0)
        cls = rd.classify_roads([link], self.moist, self.height, 0.0, self.cell,
                                rd.SurfaceParams(seal_survives_wet=False))
        # one link is its own trunk, so the base class here is bitumen; what
        # matters is that the fleck did not survive as a second run
        self.assertEqual(set(cls[0].tolist()), {int(cls[0][0])})
        # neutralising the collapse must let the fleck through, or the test
        # above is passing because the fleck was never there
        loose = rd.SurfaceParams(seal_survives_wet=False, min_run_len=0.0)
        cls2 = rd.classify_roads([link], self.moist, self.height, 0.0, self.cell,
                                 loose)
        self.assertIn(rd.SURF_MUD, set(cls2[0].tolist()))

    def test_classification_is_deterministic(self):
        links = [straight_line(50.0, 50.0, 950.0, 50.0),
                 straight_line(50.0, 200.0, 700.0, 260.0)]
        a = rd.classify_roads(links, self.moist, self.height, 0.0, self.cell)
        b = rd.classify_roads(links, self.moist, self.height, 0.0, self.cell)
        for x, y in zip(a, b):
            np.testing.assert_array_equal(x, y)


class ClassRaster(unittest.TestCase):
    def setUp(self):
        self.cell = 8.0
        self.shape = (128, 128)
        self.p = rd.RoadParams(road_width=48.0)
        self.links = [straight_line(60.0, 300.0, 940.0, 300.0),
                      straight_line(300.0, 60.0, 300.0, 900.0)]
        self.height = np.full(self.shape, 40.0)
        self.moist = np.full(self.shape, 0.2)
        self.cls = rd.classify_roads(self.links, self.moist, self.height,
                                     0.0, self.cell)

    def test_mask_and_distance_are_unchanged_by_classifying(self):
        m0, d0 = rd.rasterize_roads(self.links, self.shape, self.cell, self.p)
        m1, d1, _c = rd.rasterize_roads_classified(
            self.links, self.cls, self.shape, self.cell, self.p)
        np.testing.assert_array_equal(m0, m1)
        np.testing.assert_array_equal(d0, d1)

    def test_the_class_raster_is_exactly_the_deck(self):
        mask, _d, cls = rd.rasterize_roads_classified(
            self.links, self.cls, self.shape, self.cell, self.p)
        np.testing.assert_array_equal(cls != rd.SURF_NONE, mask)
        self.assertTrue(set(np.unique(cls)).issubset(
            {rd.SURF_NONE, rd.SURF_BITUMEN, rd.SURF_DIRT, rd.SURF_MUD}))

    def test_a_plaza_takes_the_commonest_class_arriving_at_it(self):
        _m, _d, cls = rd.rasterize_roads_classified(
            self.links, self.cls, self.shape, self.cell, self.p)
        disc = cls[30:46, 30:46]
        commonest = int(np.bincount(disc[disc != rd.SURF_NONE]).argmax())
        rd.carve_plaza_classes(cls, [(300.0, 300.0)], 85.0, self.cell)
        self.assertEqual(int(cls[38, 38]), commonest)

    def test_a_plaza_with_no_road_arriving_falls_back_to_dirt(self):
        empty = np.zeros(self.shape, dtype=np.uint8)
        rd.carve_plaza_classes(empty, [(300.0, 300.0)], 85.0, self.cell)
        self.assertEqual(int(empty[38, 38]), rd.SURF_DIRT)
        self.assertEqual(int(empty[0, 0]), rd.SURF_NONE)   # only the disc

    def test_a_plaza_over_a_sealed_junction_is_sealed(self):
        _m, _d, cls = rd.rasterize_roads_classified(
            self.links, self.cls, self.shape, self.cell, self.p)
        cls[cls != rd.SURF_NONE] = rd.SURF_BITUMEN
        rd.carve_plaza_classes(cls, [(300.0, 300.0)], 85.0, self.cell)
        self.assertEqual(int(cls[38, 38]), rd.SURF_BITUMEN)


class TypemapAndBake(unittest.TestCase):
    def setUp(self):
        self.cell = 8.0
        self.shape = (129, 129)
        self.p = rd.RoadParams(road_width=48.0)
        # two links so the network has BOTH a sealed trunk and an unsealed
        # branch: with only one, every typemap value is 1 and a typemap built
        # from the plain road mask (0/1) would pass the class test by accident
        self.links = [straight_line(60.0, 500.0, 960.0, 500.0),
                      straight_line(200.0, 800.0, 500.0, 800.0)]
        self.height = np.full(self.shape, 40.0)
        self.moist = np.full(self.shape, 0.2)
        self.cls = rd.classify_roads(self.links, self.moist, self.height,
                                     0.0, self.cell)
        self.mask, self.dist, self.raster = rd.rasterize_roads_classified(
            self.links, self.cls, self.shape, self.cell, self.p)

    def _strip(self, road_class):
        baker = bk.AlbedoBaker(
            self.height, np.zeros(self.shape), np.zeros(self.shape, dtype=np.int32),
            self.moist, self.dist, 0.0, self.cell, seed=3,
            road_width=self.p.road_width, road_class=road_class)
        return baker.bake_strip(480, 64, texel=1.0).astype(np.float32)

    def test_a_class_raster_changes_what_the_deck_bakes_as(self):
        plain = self._strip(None)
        classified = self._strip(self.raster)
        deck = np.abs(plain.astype(int) - classified.astype(int)).sum(axis=-1)
        self.assertGreater(deck.max(), 20.0)

    def test_bitumen_and_mud_do_not_bake_the_same(self):
        bitumen = self._strip(np.where(self.raster != 0, rd.SURF_BITUMEN,
                                       0).astype(np.uint8))
        mud = self._strip(np.where(self.raster != 0, rd.SURF_MUD, 0).astype(np.uint8))
        centre = 500 - 480
        on_deck = np.abs(np.arange(bitumen.shape[1]) - 500) < 20
        b = bitumen[centre][on_deck].mean(axis=0)     # (3,) RGB
        m = mud[centre][on_deck].mean(axis=0)
        # compare the COLOUR, not the luminance: a grey seal and a wet brown
        # track can land at the same brightness and still be different
        # materials, and an earlier version of this test passed on that.
        self.assertGreater(np.abs(b - m).max(), 8.0, (b, m))

    def test_ruts_darken_the_mud_deck_off_its_centreline(self):
        mud = self._strip(np.where(self.raster != 0, rd.SURF_MUD, 0).astype(np.uint8))
        # a lateral cut across the deck, averaged along the road to remove the
        # wander noise; the rut band sits at ~0.42 * half-width from the centre
        lane = mud[:, 480:520].mean(axis=(1, 2))
        centre = lane[500 - 480 - 2: 500 - 480 + 3].mean()
        rut = min(lane[500 - 480 - 12: 500 - 480 - 7].mean(),
                  lane[500 - 480 + 8: 500 - 480 + 13].mean())
        self.assertLess(rut, centre)

    def _typemap_from_write_package(self, road_class):
        """Run the real `write_package` and intercept the typemap it hands the
        SMF writer — the only place the class raster becomes engine data."""
        import tempfile
        from terragen import smf as smf_mod

        seen = {}
        real = smf_mod.write_smf_smt

        def spy(*args, **kwargs):
            seen["typemap"] = np.array(args[8])
            raise _Stop()

        cfg = pkg.MapPackageConfig(map_id="t", display_name="T", tile_budget=64,
                                   start_positions=[(60.0, 60.0)])
        smf_mod.write_smf_smt = spy
        try:
            with tempfile.TemporaryDirectory() as d:
                with self.assertRaises(_Stop):
                    pkg.write_package(
                        d, cfg, self.height, np.zeros(self.shape),
                        np.zeros(self.shape, dtype=np.int32), self.moist,
                        self.dist, self.mask, self.cell, scratch_dir=d,
                        road_class=road_class, progress=lambda *a, **k: None)
        finally:
            smf_mod.write_smf_smt = real
        return seen["typemap"]

    def test_the_typemap_carries_the_classes(self):
        typemap = self._typemap_from_write_package(self.raster)
        values = set(np.unique(typemap).tolist())
        self.assertIn(rd.SURF_BITUMEN, values)
        # SURF_DIRT is the one that cannot come from a 0/1 road mask
        self.assertIn(rd.SURF_DIRT, values)
        self.assertEqual(typemap.dtype, np.uint8)

    def test_a_road_deck_claims_the_rock_detail_channel(self):
        # the runtime splat detail layer is what gives a texel its grain; a
        # dirt track that keeps the grass channel gets grass grain on it
        biome = np.zeros(self.shape, dtype=np.int32)
        args = (biome, np.zeros(self.shape), self.height, 0.0)
        plain = bk.make_splat_distr(*args, size=128)
        roaded = bk.make_splat_distr(*args, size=128, road_class=self.raster)
        self.assertGreater(int(roaded[..., 1].sum()), int(plain[..., 1].sum()))
        # ...and mud does not: its surface is smooth, not granular
        mud_only = np.where(self.raster != rd.SURF_NONE, rd.SURF_MUD,
                            rd.SURF_NONE).astype(np.uint8)
        muddy = bk.make_splat_distr(*args, size=128, road_class=mud_only)
        self.assertEqual(int(muddy[..., 1].sum()), int(plain[..., 1].sum()))

    def test_a_submerged_deck_cell_is_not_road_but_a_ford(self):
        # R3: a ford is not as fast as the road it interrupts — that is the
        # rule, and since 2026-08-19 it is the only reason for it. It used to
        # double as the mitigation for SHIP/SUB being declared in the engine's
        # KBot slot (`speedmodclass = 1`), which had a boat over a submerged
        # deck cell reading the ROAD multiplier; that declaration is now 3
        # (Ship) and boats read `shipSpeed` = 1.0. The behaviour asserted here
        # is unchanged either way.
        # the trunk runs along z = 500 (half-res rows 30-31); flood one x window
        # of it so the SAME link is submerged in one place and dry in another
        self.height[58:70, 80:134] = -5.0
        typemap = self._typemap_from_write_package(self.raster)
        wet = typemap[29:33, 42:64]
        self.assertEqual(set(np.unique(wet).tolist()), {0}, wet)
        # ...and the rule is narrow: the same deck keeps its class where it is
        # dry, so this is not "the trunk lost its class".
        dry = typemap[29:33, 5:35]
        self.assertIn(rd.SURF_BITUMEN, set(np.unique(dry).tolist()))

    def test_a_caller_with_no_class_raster_still_gets_the_old_0_1_typemap(self):
        typemap = self._typemap_from_write_package(None)
        self.assertEqual(set(np.unique(typemap).tolist()), {0, 1})


class _Stop(Exception):
    pass


if __name__ == "__main__":
    unittest.main()
