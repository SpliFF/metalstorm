#!/usr/bin/env python3
"""A generated map ships its own region graph — M-track M9l.

    .venv/bin/python -m unittest tests.test_region_emission

Every terragen map except Meridian Basin shipped no `mapdata/regions.lua`, and
`game_regions.lua` answers a missing file with the 2048-elmo GRID provider,
whose regions carry no neighbours at all — so the strategic AI had no movement
graph on any of them (M9k FIND 2). `archipelago.py` now derives one at
generation time.

What is pinned here:

1. **The generator derives from the surface that SHIPS.** The map goes out
   through the SMF's uint16, so `smf.shipped_heights` must reproduce, exactly,
   what a reader gets back out of the packaged bytes. Deriving from the float
   surface instead would put the generator's graph one quantisation step away
   from the tool's.
2. **One derivation, two callers.** `archipelago.build_region_graph` and
   `regions_from_map.derive_graph` must produce a byte-identical file for the
   same map, because both are used on the same map: the generator writes it,
   and `regions_from_map.py` is routinely re-run over installed maps
   afterwards. Two implementations would drift, and drift renames region keys —
   which is a dead scenario at GameStart (see `check_generator_ownership`).
3. **The file the generator writes is the file the toolchain expects.** The
   ownership guard must not refuse to regenerate it, and `scenariogen`'s reader
   must parse back the same keys — it addresses regions by the key the map on
   disk ships.
"""
from __future__ import annotations

import math
import os
import struct
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import archipelago as arch                                # noqa: E402
import regions_from_map as rfm                            # noqa: E402
import scenariogen as sg                                  # noqa: E402
from terragen import reachability as reach                # noqa: E402
from terragen import smf                                  # noqa: E402

LO, HI = -120.0, 400.0


def _quiet(_line):
    """The derivation reports to stdout; a unit test does not need the report."""


def _fixture(W=129):
    """A two-island map: land either side of a channel too deep to wade."""
    h = np.full((W, W), -60.0, dtype=np.float64)
    xs = np.arange(W)
    for z in range(W):
        for x in range(W):
            # two plateaus, a 10-sample sea channel down the middle
            if x < W // 2 - 5 or x > W // 2 + 5:
                h[z, x] = 40.0 + 4.0 * np.sin(xs[x] / 9.0) + 3.0 * np.cos(z / 7.0)
    starts = [(8 * 10, 8 * 10), (8 * (W - 12), 8 * (W - 12))]
    return h, starts


def _derive_from_packaged_bytes(h, starts, map_id, log=lambda _l: None):
    """What `regions_from_map.py` sees after the map is written and read back."""
    raw = smf.quantize_heightmap(h, LO, HI)
    count = len(raw) // 2
    vals = struct.unpack(f"<{count}H", raw)
    scale = (HI - LO) / 65535.0
    hs = [LO + scale * v for v in vals]
    H, W = h.shape
    return rfm.derive_graph(hs, W, H, starts, map_id, intent=reach.SPLIT,
                            log=log)


class GeneratorEmitsTheGraph(unittest.TestCase):
    def setUp(self):
        self.h, self.starts = _fixture()

    def test_shipped_heights_is_exactly_what_the_bytes_read_back_as(self):
        raw = smf.quantize_heightmap(self.h, LO, HI)
        vals = struct.unpack(f"<{len(raw) // 2}H", raw)
        scale = (HI - LO) / 65535.0
        want = [LO + scale * v for v in vals]
        got = smf.shipped_heights(self.h, LO, HI).ravel().tolist()
        self.assertEqual(got, want)

    def test_shipped_heights_is_not_the_float_surface(self):
        # The property above is only worth pinning because quantisation moves
        # the surface. If this ever fails, the test above has gone vacuous.
        got = smf.shipped_heights(self.h, LO, HI)
        self.assertFalse(np.array_equal(got, self.h))

    def test_quantisation_can_flip_a_passability_verdict(self):
        """Why point 1 is load-bearing, and not merely tidy.

        The uint16 step is ~0.008 elmos over a 520-elmo range, which sounds
        like nothing until it lands on a threshold: VEH tops out at 32 deg,
        i.e. a rise of 4.99895 elmos between two samples 8 elmos apart. A pair
        just OVER that in the generator's float surface can quantise to just
        UNDER it in the bytes that ship — the sample is impassable to the
        generator and passable to everything downstream. It flips one way here;
        rounding sends other pairs the other way. (The 129-sample fixture below
        happens not to contain such a pair, so the file-equality test would
        pass either way — this is the case that fails if the generator ever
        goes back to deriving from its own floats.)
        """
        rise = math.tan(math.radians(rfm.MOVE_CLASSES["VEH"][0])) * \
            rfm.ELMOS_PER_SQUARE
        pair = np.array([[0.0, rise + 1e-5]])
        shipped = smf.shipped_heights(pair, LO, HI).ravel()
        self.assertGreater(pair[0, 1] - pair[0, 0], rise)      # float: too steep
        self.assertLessEqual(shipped[1] - shipped[0], rise)    # shipped: drivable

    def test_generator_and_tool_derive_the_same_file(self):
        gen = arch.build_region_graph(self.h, LO, HI, self.starts,
                                      "fixture_reach", reach.SPLIT, log=_quiet)
        tool = _derive_from_packaged_bytes(self.h, self.starts, "fixture_reach")
        self.assertEqual(gen.lua, tool.lua)
        self.assertEqual(gen.json, tool.json)

    def test_the_graph_is_not_empty_and_never_crosses_a_component(self):
        g = arch.build_region_graph(self.h, LO, HI, self.starts,
                                    "fixture_reach", reach.SPLIT, log=_quiet)
        self.assertGreater(len(g.regions), 1)
        self.assertTrue(g.graph_ok, "\n".join(g.messages))
        comp = {r["key"]: r["_c"]["comp"] for r in g.regions}
        for r in g.regions:
            for n in r["neighbors"]:
                self.assertEqual(comp[r["key"]], comp[n],
                                 f"edge {r['key']}-{n} leaves its component")

    def test_the_written_file_is_regenerable_and_readable(self):
        g = arch.build_region_graph(self.h, LO, HI, self.starts,
                                    "fixture_reach", reach.SPLIT, log=_quiet)
        with tempfile.TemporaryDirectory() as d:
            mapdata = os.path.join(d, "mapdata")
            os.makedirs(mapdata)
            path = os.path.join(mapdata, "regions.lua")
            with open(path, "w", encoding="utf-8") as f:
                f.write(g.lua)
            # the tool must not treat the generator's file as foreign content
            rfm.check_generator_ownership(path, force=False)
            keys = [r["key"] for r in sg.read_region_graph(d)]
        self.assertEqual(keys, [r["key"] for r in g.regions])


if __name__ == "__main__":
    unittest.main()
