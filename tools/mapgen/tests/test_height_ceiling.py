#!/usr/bin/env python3
"""Tests for the packaged SMF height ceiling (PLAN-maps M8w).

    .venv/bin/python -m unittest tests.test_height_ceiling

`smf.quantize_heightmap` **clips** to [min_height, max_height]. That is a
silent failure mode, not a loud one: a summit above the ceiling does not
overflow and does not raise — it ships as a flat mesa, and the only way to
notice is to look at the map. `archipelago.generate` shipped a fixed 1200,
which `mounds` never approached (553 elmos) and the arc exceeds by
construction, because the arc's relief is aimed at a *quantile* and its
summit runs 1.24-1.37x that (PLAN-maps M8u).

So two things are pinned here: that the ceiling actually clears the surface
it is derived from, and that the shipped `mounds` value does not move.
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import archipelago as arc                               # noqa: E402
from terragen import smf                                # noqa: E402


class TestHeightCeiling(unittest.TestCase):
    def test_the_shipped_mounds_ceiling_does_not_move(self):
        """skerry_reach tops out at 553 elmos and must stay on 1200."""
        self.assertEqual(arc.height_ceiling(553.0), 1200.0)
        self.assertEqual(arc.height_ceiling(0.0), 1200.0)
        # ...and anything the floor already clears keeps it
        self.assertEqual(arc.height_ceiling(1142.0), 1200.0)

    def test_the_arc_summit_clears_the_ceiling(self):
        """950 asked stands 1212 on the shipped arc — 1200 would clip it."""
        self.assertEqual(arc.height_ceiling(1212.0), 1300.0)

    def test_the_ceiling_clears_every_summit_it_is_given(self):
        for top in (600.0, 1200.0, 1201.0, 1212.0, 1900.0, 4000.0):
            with self.subTest(top=top):
                self.assertGreater(arc.height_ceiling(top), top)

    def test_the_ceiling_is_a_hundred_elmo_step(self):
        for top in (1212.0, 1900.0, 4000.0):
            with self.subTest(top=top):
                self.assertEqual(arc.height_ceiling(top) % 100.0, 0.0)

    def test_a_clipped_summit_quantises_to_a_mesa(self):
        """The defect itself, so nobody has to take the docstring on trust."""
        h = np.array([[0.0, 600.0], [1212.0, 1205.0]])

        def codes(max_h):
            return np.frombuffer(smf.quantize_heightmap(h, -120.0, max_h),
                                 dtype="<u2")

        # both summits land on the SAME code — that is the flat top
        clipped = codes(1200.0)
        self.assertEqual(clipped[2], clipped[3])
        cleared = codes(arc.height_ceiling(1212.0))
        self.assertGreater(cleared[2], cleared[3])


if __name__ == "__main__":
    unittest.main()
