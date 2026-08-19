#!/usr/bin/env python3
"""What a `meridian2.py --id` variant package must carry (PLAN-maps M9h).

    .venv/bin/python -m unittest tests.test_meridian2

A real run is ~20 minutes, so nothing here generates terrain. What is real
is the part of the generator that is *not* terrain:

  * the 24-region contract and the civilian sites/convoys are derived from
    `meridian_layout.json` alone — no seed, no heightfield. That is exactly
    why a variant can carry them, and it is only true as long as nobody
    reaches into the terrain from those emitters, so it is pinned against
    the checked-in `content/maps/meridian_basin/mapdata/*.lua` byte for
    byte. If a future edit makes either emitter seed- or terrain-dependent,
    this file fails before a variant ships a contract that does not match
    its own map.
  * the SMF height ceiling, whose failure mode is silence: `quantize_
    heightmap` clips, so a surface over `max_height` ships as a flat mesa
    with no error (PLAN-maps M8w FIND 1). `meridian2`'s hard-coded 1500 is
    now the FLOOR of `smf.height_ceiling`, which pins the shipped
    `meridian_basin` bytes (its 1305.4-elmo summit derives 1400, under the
    floor) while a taller seed lifts the ceiling instead of clipping.
"""
from __future__ import annotations

import json
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import civilians_gen as civ                              # noqa: E402
import meridian as m1                                    # noqa: E402
import meridian2 as m2                                   # noqa: E402
from terragen import smf                                 # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SHIPPED = os.path.join(REPO, "content", "maps", "meridian_basin", "mapdata")


def layout():
    with open(m2.LAYOUT_PATH) as f:
        return json.load(f)


class TestLayoutOnlyContract(unittest.TestCase):
    """The two files a variant package has to bring with it."""

    def test_regions_lua_reproduces_the_shipped_file(self):
        path = os.path.join(SHIPPED, "regions.lua")
        if not os.path.exists(path):
            self.skipTest("content/maps/meridian_basin not present")
        with open(path) as f:
            self.assertEqual(m1.build_regions_lua(layout()), f.read())

    def test_civilians_lua_reproduces_the_shipped_file(self):
        path = os.path.join(SHIPPED, "civilians.lua")
        if not os.path.exists(path):
            self.skipTest("content/maps/meridian_basin not present")
        with open(path) as f:
            lua, n_sites, n_convoys = civ.build_civilians_lua(layout())
            self.assertEqual(lua, f.read())
        self.assertGreater(n_sites, 0)
        self.assertGreater(n_convoys, 0)

    def test_both_emitters_take_the_layout_and_nothing_else(self):
        """The whole premise: same bytes for any seed, so a variant is a
        complete package rather than one that borrows meridian_basin's."""
        lay = layout()
        self.assertEqual(m1.build_regions_lua(lay), m1.build_regions_lua(lay))
        a, _, _ = civ.build_civilians_lua(lay)
        b, _, _ = civ.build_civilians_lua(lay)
        self.assertEqual(a, b)
        for text in (m1.build_regions_lua(lay), a):
            self.assertNotIn(str(m2.SEED_DEFAULT), text)


class TestVariantIdentity(unittest.TestCase):
    def test_the_default_id_is_the_shipped_map(self):
        """A default anywhere else re-ships meridian_basin under a new name,
        or writes the variant over it."""
        import inspect
        params = inspect.signature(m2.generate).parameters
        self.assertEqual(params["map_id"].default, "meridian_basin")
        self.assertEqual(params["display_name"].default, "Meridian Basin")


class TestHeightCeiling(unittest.TestCase):
    """M8w FIND 1, audited on meridian2 by M9h."""

    def test_the_shipped_meridian_basin_ceiling_does_not_move(self):
        """Its packaged summit is 1305.4 elmos, which derives 1400 — under
        the 1500 the package already ships, so the floor holds it there."""
        self.assertEqual(smf.height_ceiling(1305.4, floor=m2.MAX_HEIGHT), 1500.0)
        self.assertEqual(m2.MAX_HEIGHT, 1500.0)

    def test_a_seed_that_would_have_clipped_lifts_the_ceiling_instead(self):
        """The clearance was never designed: the surface handed to erosion
        tops out at 1522.6 elmos — already over the 1500 — and only the
        x0.898 that 30 iterations happen to take off brings it under."""
        self.assertGreater(smf.height_ceiling(1522.6, floor=m2.MAX_HEIGHT), 1522.6)
        self.assertEqual(smf.height_ceiling(1522.6, floor=m2.MAX_HEIGHT), 1600.0)

    def test_the_ceiling_clears_every_summit_it_is_given(self):
        for top in (600.0, 1500.0, 1522.6, 1900.0, 4000.0):
            with self.subTest(top=top):
                got = smf.height_ceiling(top, floor=m2.MAX_HEIGHT)
                self.assertGreater(got, top)
                self.assertEqual(got % 100.0, 0.0)

    def test_the_clip_reports_itself(self):
        """The silence was the defect. `quantize_heightmap` now says so on
        stderr — assert that, or the next silent mesa ships the same way."""
        import contextlib
        import io
        h = np.array([[-200.0, 600.0], [1600.0, 1205.0]])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            smf.quantize_heightmap(h, -120.0, 1500.0)
        msg = err.getvalue()
        self.assertIn("flat top", msg)
        self.assertIn("flat floor", msg)

        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            smf.quantize_heightmap(h, -220.0, 1700.0)
        self.assertEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
