#!/usr/bin/env python3
"""Tests for the settlement / start-pad placer (terragen/settle.py).

    .venv/bin/python -m unittest tests.test_settle

Synthetic score fields only — the real map packages are gitignored, so a
clone has nothing to run against (same reason test_roads.py gives). The
picker under test is the shipping one.

What this pins down, and why each one is here rather than being obvious:

  * **`min_separation` is a DISTANCE.** The picker used to sterilise an
    axis-aligned box of half-width `min_separation`, which delivers a
    *Chebyshev* constraint: a candidate at exactly the asked separation on a
    diagonal is only `sep/sqrt(2)` away on each axis, so it was rejected.
    `test_two_diagonal_candidates_at_the_asked_separation_both_fit` is that
    case, and it fails on the box — it is M8q's start-pad failure reduced to
    two peaks, which is why it is worth a test rather than a comment.
  * **the box is not merely different, it is stricter.** Whatever a disc
    admits, a box of the same radius admits too, so the disc can only ever
    fit more sites. `test_the_disc_never_fits_fewer_sites_than_the_box`
    sweeps random fields against an inline box picker (a second reading of
    the old rule, not a call into it) and demands that ordering.
  * **the delivered separation is the asked one.** Both directions matter: no
    pair closer than `min_separation` (the constraint holds), and a fixture
    whose only two candidates are exactly `min_separation` apart yields two
    (it is not *over*-delivering — see the exclusion window's ceil).
  * **the window has to contain the disc it tests.** With `int()` truncation
    a separation that is not a whole number of cells leaves an on-axis ring
    inside the radius unswept. `test_a_fractional_separation_still_excludes_
    on_axis` uses cell 32 / sep 3600 (112.5 cells), the `--fast` geometry.
  * **`forbidden` is the gate the road planner uses.** M9a FIND 1 put a town
    where the road cost field could not take one step;
    `test_forbidden_rejects_a_site_rather_than_relocating_the_map` shows a
    forbidden peak is skipped and the next-best taken, not that the whole
    result shifts.

Every metric carries a positive control: the box picker is kept here as a
constructible arm so "the old behaviour was..." has exactly one definition.
"""

import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from terragen import settle as st  # noqa: E402

CELL = 8.0


def pre_m9b_box(score, cellsize, count, params=None, forbidden=None):
    """`pick_sites` exactly as it shipped before M9b: box exclusion.

    A second reading of the old rule rather than a call into it, so the
    "disc admits more" ordering is tested against a definition of the box
    and not against a refactor of the disc.
    """
    p = params or st.SettleParams()
    s = score.copy()
    if forbidden is not None:
        s[forbidden] = 0.0
    H, W = s.shape
    sep_cells = max(1, int(p.min_separation / cellsize))
    sites = []
    for _ in range(count):
        i = int(np.argmax(s))
        if s.flat[i] <= 0.0:
            break
        r, c = divmod(i, W)
        sites.append((c * cellsize, r * cellsize))
        r0, r1 = max(0, r - sep_cells), min(H, r + sep_cells + 1)
        c0, c1 = max(0, c - sep_cells), min(W, c + sep_cells + 1)
        s[r0:r1, c0:c1] = 0.0
    return sites


def peaks(shape, spots, cellsize=CELL):
    """A score field that is zero except for one cell per (row, col, value)."""
    s = np.zeros(shape, dtype=np.float32)
    for r, c, v in spots:
        s[r, c] = v
    return s


def closest_pair(sites):
    if len(sites) < 2:
        return math.inf
    return min(math.hypot(a[0] - b[0], a[1] - b[1])
               for i, a in enumerate(sites) for b in sites[i + 1:])


class Separation(unittest.TestCase):
    def test_two_diagonal_candidates_at_the_asked_separation_both_fit(self):
        """M8q's failure, reduced: two peaks exactly `sep` apart, diagonally.

        Chebyshev distance here is sep/sqrt(2) = 2546 elmos, so the box
        rejects the second; the constraint as written admits it.
        """
        sep = 3600.0
        # ceil, so the pair is at or just outside the radius rather than just
        # inside it — 319 cells on each axis is 3 609 elmos apart
        d = int(math.ceil(sep / math.sqrt(2.0) / CELL))
        s = peaks((900, 900), [(200, 200, 1.0), (200 + d, 200 + d, 0.9)])
        p = st.SettleParams(min_separation=sep)

        got = st.pick_sites(s, CELL, 2, p)
        self.assertEqual(len(got), 2, "the disc must admit the diagonal pair")
        self.assertGreaterEqual(closest_pair(got), sep - 1e-6)

        # positive control: the rule this replaced rejects exactly this pair
        self.assertEqual(len(pre_m9b_box(s, CELL, 2, p)), 1,
                         "if the box also admits it the fixture proves nothing")

    def test_the_disc_never_fits_fewer_sites_than_the_box(self):
        """A box of radius r excludes everything a disc of radius r does.

        So over any field the disc's yield is >= the box's. This is the
        property that makes the change safe to make on maps that already fit
        their sites, and it is swept rather than argued.
        """
        rng = np.random.default_rng(20260809)
        strictly_more = 0
        for _ in range(24):
            s = rng.random((240, 240)).astype(np.float32)
            p = st.SettleParams(min_separation=rng.uniform(200.0, 900.0))
            a = len(pre_m9b_box(s, CELL, 12, p))
            b = len(st.pick_sites(s, CELL, 12, p))
            self.assertGreaterEqual(b, a)
            strictly_more += b > a
        self.assertGreater(strictly_more, 0,
                           "no field in the sweep separated the two rules — "
                           "the sweep is not exercising the difference")

    def test_no_pair_is_closer_than_the_asked_separation(self):
        rng = np.random.default_rng(7)
        for sep in (160.0, 640.0, 1500.0):
            s = rng.random((300, 300)).astype(np.float32)
            got = st.pick_sites(s, CELL, 20, st.SettleParams(min_separation=sep))
            self.assertGreater(len(got), 1)
            self.assertGreaterEqual(closest_pair(got), sep - 1e-6,
                                    f"separation {sep} not delivered")

    def test_a_pair_exactly_at_the_separation_is_admitted(self):
        """Not over-delivering: `min` separation means the boundary is legal."""
        sep = 800.0
        d = int(round(sep / CELL))
        s = peaks((200, 200), [(50, 50, 1.0), (50, 50 + d, 0.9)])
        got = st.pick_sites(s, CELL, 2, st.SettleParams(min_separation=sep))
        self.assertEqual(len(got), 2)
        self.assertAlmostEqual(closest_pair(got), sep, places=6)

    def test_a_fractional_separation_still_excludes_on_axis(self):
        """cell 32 / sep 3600 is 112.5 cells — the `--fast` geometry.

        Truncating the window to 112 leaves the ring at 3 584..3 600 elmos
        unswept, so a candidate inside the radius survives on-axis.
        """
        cell = 32.0
        sep = 3600.0
        d = 112                                  # 3 584 elmos: inside the radius
        s = peaks((300, 300), [(100, 100, 1.0), (100, 100 + d, 0.9)])
        got = st.pick_sites(s, cell, 2, st.SettleParams(min_separation=sep))
        self.assertEqual(len(got), 1,
                         "a candidate 3 584 elmos away is inside a 3 600 "
                         "separation and must not survive the sweep")

    def test_zero_separation_still_takes_one_cell_per_site(self):
        """`max(1, ...)` — a site must not be pickable twice."""
        s = peaks((60, 60), [(10, 10, 1.0), (10, 11, 0.5)])
        got = st.pick_sites(s, CELL, 3, st.SettleParams(min_separation=0.0))
        self.assertEqual(len(got), 2)
        self.assertEqual(len(set(got)), 2)


class Contract(unittest.TestCase):
    def test_ordering_is_best_score_first_and_deterministic(self):
        rng = np.random.default_rng(11)
        s = rng.random((200, 200)).astype(np.float32)
        p = st.SettleParams(min_separation=500.0)
        a = st.pick_sites(s, CELL, 9, p)
        b = st.pick_sites(s, CELL, 9, p)
        self.assertEqual(a, b)
        vals = [s[int(z / CELL), int(x / CELL)] for x, z in a]
        self.assertEqual(vals, sorted(vals, reverse=True))

    def test_zero_and_negative_score_is_never_picked(self):
        s = np.full((80, 80), -1.0, dtype=np.float32)
        s[40, 40] = 0.0
        s[10, 10] = 0.25
        got = st.pick_sites(s, CELL, 5, st.SettleParams(min_separation=100.0))
        self.assertEqual(got, [(10 * CELL, 10 * CELL)])

    def test_the_input_score_field_is_not_mutated(self):
        rng = np.random.default_rng(3)
        s = rng.random((120, 120)).astype(np.float32)
        before = s.copy()
        st.pick_sites(s, CELL, 6, st.SettleParams(min_separation=400.0))
        np.testing.assert_array_equal(s, before)

    def test_forbidden_rejects_a_site_rather_than_relocating_the_map(self):
        """The gate M9a FIND 1 wanted: a site the planner cannot use is skipped.

        The next-best candidate is taken in its place and every other pick is
        unchanged, so forbidding ground is a rejection, not a re-plan.
        """
        s = peaks((300, 300), [(20, 20, 1.0), (150, 150, 0.9), (280, 40, 0.8)])
        p = st.SettleParams(min_separation=400.0)
        free = st.pick_sites(s, CELL, 2, p)
        self.assertEqual(free, [(20 * CELL, 20 * CELL), (150 * CELL, 150 * CELL)])

        bad = np.zeros(s.shape, bool)
        bad[150, 150] = True
        gated = st.pick_sites(s, CELL, 2, p, forbidden=bad)
        self.assertEqual(gated, [(20 * CELL, 20 * CELL), (40 * CELL, 280 * CELL)])


if __name__ == "__main__":
    unittest.main()
