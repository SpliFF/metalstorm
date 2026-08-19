#!/usr/bin/env python3
"""Tests for the river-ribbon stage (terragen/rivers.py, PLAN-maps.md §2b item 3).

    python3 -m unittest discover -s tools/mapgen/tests

Synthetic terrain only, for the reason test_town_planner.py already gives:
`data/maps/` is gitignored, so a clone or a CI checkout has no real map to run
against. The terrain is faked; the hydrology, the geometry and every metric are
real — each case runs the shipping `hydrology` routing on the fixture rather
than hand-writing a receiver array, so the tests exercise the same code path a
map generation does.

What this pins down, and why each one is here rather than being obvious:

  * **downstream closure** — the failure mode of a bare slope-area threshold is
    a *dotted* river: a low-gradient reach drops under C and the channel
    disappears for a stretch. Closure is the fix and `test_channel_mask_is_
    downstream_closed` is the only thing that can tell you it still holds.
  * **reach coverage** — reach extraction has to weld at junctions and cover
    every channel edge exactly once. Off-by-one there is invisible in a preview
    (one missing tributary among hundreds) and permanent in the map.
  * **`min` vs lerp** — the carve rule §2b item 3 insists on. The test does not
    just assert the property; it builds the lerp alternative and *shows it
    raising terrain* on the same input, so the assertion is known to be
    discriminating rather than vacuously true.
  * **the junction width rule** — `w^2 = w1^2 + w2^2` is a *consequence* of
    `w = k*sqrt(A)`, not code. If someone swaps the width model for a linear
    one the rule silently stops holding, and confluences stop growing.
  * **lakes are not baked** — the whole reason `water_z` and `terrain` are
    separate arrays. A depression must survive the stage as a depression.

Every metric carries a positive control: a deliberately-wrong construction that
the same assertion must reject. A guard nobody has watched fail is not a guard.
"""

import os
import sys
import unittest

import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from terragen import hydrology as hyd  # noqa: E402
from terragen import rivers as riv  # noqa: E402
from terragen import noise as tn  # noqa: E402

CELL = 8.0


def routed(height: np.ndarray):
    """Run the shipping hydrology stack on a heightfield."""
    filled = hyd.fill_depressions(height)
    routing = hyd.resolve_flats(filled)
    recv = hyd.d8_receivers(routing)
    levels = hyd.topo_levels(recv)
    accum = hyd.flow_accumulation(recv, levels)
    return recv, levels, accum


def hilly(size: int = 192, seed: int = 7, relief: float = 260.0) -> np.ndarray:
    """A noisy dome: real drainage structure, a coastline, no flat plateaus."""
    n = tn.SimplexNoise(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    u = (xx - size / 2) / (size / 2)
    v = (yy - size / 2) / (size / 2)
    dome = np.clip(1.0 - np.hypot(u, v), -0.4, 1.0)
    detail = tn.fbm(n, xx / 26.0, yy / 26.0, octaves=6)
    return relief * (dome * 0.9 + detail * 0.35)


class ChannelSeeding(unittest.TestCase):
    def setUp(self):
        self.h = hilly()
        self.recv, self.levels, self.accum = routed(self.h)

    def test_seed_fraction_tracks_the_requested_fraction(self):
        """The quantile is solved, so the *seed* count is what was asked for.

        The final mask is larger (closure adds every downstream cell), so this
        checks the seeds themselves, which is the knob a generator actually
        turns.
        """
        p = riv.RiverParams(channel_fraction=0.02)
        land = (self.h > 0.0).ravel()
        area = self.accum * CELL * CELL
        metric = area * riv.slope_area_metric(self.h, self.recv, CELL, p.min_slope)
        _, c = riv.channel_mask(self.h, self.recv, self.levels, self.accum,
                                CELL, 0.0, p)
        seeded = ((metric >= c) & land).sum() / land.sum()
        self.assertAlmostEqual(seeded, 0.02, delta=0.003)

    def test_channel_fraction_is_monotone_in_the_knob(self):
        land = (self.h > 0.0).sum()
        fracs = []
        for f in (0.005, 0.02, 0.06):
            m, _ = riv.channel_mask(self.h, self.recv, self.levels, self.accum,
                                    CELL, 0.0, riv.RiverParams(channel_fraction=f))
            fracs.append(m.sum() / land)
        self.assertLess(fracs[0], fracs[1])
        self.assertLess(fracs[1], fracs[2])

    def test_channel_mask_is_downstream_closed(self):
        """Every channel cell drains into a channel cell (or off the network).

        This is the property that turns a threshold into a network. Its
        positive control is the raw threshold, which must FAIL the same check.
        """
        p = riv.RiverParams(channel_fraction=0.02)
        mask, c = riv.channel_mask(self.h, self.recv, self.levels, self.accum,
                                   CELL, 0.0, p)
        ch = mask.ravel()
        ci = np.flatnonzero(ch)
        down = self.recv[ci]
        land = (self.h > 0.0).ravel()
        broken = ci[(down != ci) & ~ch[down] & land[down]]
        self.assertEqual(broken.size, 0,
                         f"{broken.size} channel cells drain into dry land")

        # positive control: the unclosed threshold really is dotted
        area = self.accum * CELL * CELL
        metric = area * riv.slope_area_metric(self.h, self.recv, CELL, p.min_slope)
        raw = (metric >= c) & land
        ri = np.flatnonzero(raw)
        rdown = self.recv[ri]
        raw_broken = ri[(rdown != ri) & ~raw[rdown] & land[rdown]]
        self.assertGreater(raw_broken.size, 0,
                           "positive control: raw threshold should be dotted")

    def test_sea_cells_are_never_channel(self):
        mask, _ = riv.channel_mask(self.h, self.recv, self.levels, self.accum,
                                   CELL, 0.0, riv.RiverParams())
        self.assertFalse(bool((mask & (self.h <= 0.0)).any()))


class WaterSurface(unittest.TestCase):
    def setUp(self):
        self.h = hilly()
        self.recv, self.levels, self.accum = routed(self.h)

    def test_surface_is_monotone_downstream(self):
        """`w[i] >= w[receiver[i]]` everywhere — water never runs uphill.

        Positive control: the raw ground surface, which violates it wherever
        the DEM has a pit, and does so on this fixture.
        """
        w = riv.water_surface(self.h, self.recv, self.levels, 0.0).ravel()
        idx = np.arange(w.size)
        moving = self.recv != idx
        self.assertTrue(bool(np.all(w[moving] >= w[self.recv[moving]] - 1e-9)))

        raw = np.maximum(self.h.ravel(), 0.0)
        viol = int((raw[moving] < raw[self.recv[moving]] - 1e-9).sum())
        self.assertGreater(viol, 0, "positive control: raw ground should dip")

    def test_surface_never_runs_underground(self):
        w = riv.water_surface(self.h, self.recv, self.levels, 0.0)
        self.assertTrue(bool(np.all(w >= np.maximum(self.h, 0.0) - 1e-9)))

    def test_a_depression_gets_a_surface_above_its_floor(self):
        """A basin fills to its spill level in `water_z` only — the *ground*
        under it is untouched by the water surface calculation."""
        h = np.full((64, 64), 100.0)
        yy, xx = np.mgrid[0:64, 0:64].astype(np.float64)
        h -= np.arange(64)[None, :] * 0.5            # gentle drain to the west
        bowl = np.hypot(xx - 40, yy - 32) < 8
        h[bowl] -= 30.0
        recv, levels, _ = routed(h)
        w = riv.water_surface(h, recv, levels, 0.0)
        self.assertGreater(float((w[bowl] - h[bowl]).max()), 20.0)


class ReachExtraction(unittest.TestCase):
    def setUp(self):
        self.h = hilly()
        self.recv, self.levels, self.accum = routed(self.h)
        self.mask, _ = riv.channel_mask(self.h, self.recv, self.levels,
                                        self.accum, CELL, 0.0, riv.RiverParams())
        self.reaches = riv.extract_reaches(self.mask, self.recv)

    def test_reaches_cover_every_edge_once(self):
        """The reach set is an exact edge decomposition of the channel forest.

        Both halves matter: a missed edge is a river with a gap in it, a
        duplicated edge is a ribbon carved twice (harmless with `min`, but it
        means the junction logic is wrong somewhere).
        """
        ch = self.mask.ravel()
        ci = np.flatnonzero(ch)
        down = self.recv[ci]
        expected = {(int(a), int(b)) for a, b in zip(ci, down)
                    if b != a and ch[b]}

        got: list[tuple[int, int]] = []
        for cells in self.reaches:
            got += [(int(a), int(b)) for a, b in zip(cells[:-1], cells[1:])]

        self.assertEqual(len(got), len(set(got)), "an edge was covered twice")
        self.assertEqual(set(got), expected)

    def test_junctions_are_shared_endpoints(self):
        """A junction ends every inflowing reach and starts exactly one
        outflowing reach, so the ribbons weld instead of abutting.

        "Outflowing" is conditional: a junction sitting on an outlet, or one
        whose receiver is already off the network at the shoreline, has no
        downstream edge to own and correctly starts nothing.
        """
        ch = self.mask.ravel()
        ci = np.flatnonzero(ch)
        down = self.recv[ci]
        donors = np.bincount(down[down != ci], minlength=ch.size)
        junctions = np.flatnonzero(ch & (donors >= 2))
        if junctions.size == 0:
            self.skipTest("fixture produced no confluences")

        starts = [int(c[0]) for c in self.reaches]
        ends = [int(c[-1]) for c in self.reaches]
        terminal = 0
        for j in junctions:
            j = int(j)
            flows_on = self.recv[j] != j and ch[self.recv[j]]
            self.assertEqual(starts.count(j), 1 if flows_on else 0,
                             f"junction {j} starts {starts.count(j)} reaches "
                             f"(flows_on={flows_on})")
            self.assertEqual(ends.count(j), int(donors[j]),
                             f"junction {j} should end {donors[j]} reaches")
            terminal += 0 if flows_on else 1
        self.assertLess(terminal, junctions.size,
                        "every junction was terminal — fixture proves nothing")

    def test_every_reach_flows_downhill_in_the_routing(self):
        for cells in self.reaches:
            self.assertTrue(bool(np.all(self.recv[cells[:-1]] == cells[1:])))

    def test_empty_mask_yields_no_reaches(self):
        empty = np.zeros_like(self.mask)
        self.assertEqual(riv.extract_reaches(empty, self.recv), [])


class CentrelineTreatment(unittest.TestCase):
    def test_douglas_peucker_respects_its_tolerance(self):
        """Max deviation of the simplified line from every dropped vertex is
        within epsilon; endpoints survive."""
        t = np.linspace(0.0, 1.0, 240)
        pts = np.stack([t * 1000.0, np.sin(t * 9.0) * 40.0 + t * 120.0], axis=1)
        eps = 6.0
        k = riv.douglas_peucker(pts, eps)
        self.assertEqual(k[0], 0)
        self.assertEqual(k[-1], len(pts) - 1)
        self.assertLess(len(k), len(pts))

        simple = pts[k]
        worst = 0.0
        for i in range(len(k) - 1):
            a, b = simple[i], simple[i + 1]
            seg = b - a
            L = float(np.hypot(*seg))
            rel = pts[k[i]:k[i + 1] + 1] - a
            d = np.abs(rel[:, 0] * seg[1] - rel[:, 1] * seg[0]) / max(L, 1e-9)
            worst = max(worst, float(d.max()))
        self.assertLessEqual(worst, eps + 1e-6)

    def test_douglas_peucker_keeps_detail_above_the_tolerance(self):
        """Positive control: a zigzag whose amplitude exceeds epsilon must NOT
        be flattened away — otherwise 'it simplified' proves nothing."""
        x = np.arange(0.0, 200.0, 5.0)
        y = np.where(np.arange(len(x)) % 2 == 0, 0.0, 40.0)
        pts = np.stack([x, y], axis=1)
        k = riv.douglas_peucker(pts, 6.0)
        self.assertGreater(len(k), len(pts) * 0.8)

    def test_meander_is_seeded_and_pinned_at_both_ends(self):
        t = np.linspace(0.0, 1.0, 120)
        pts = np.stack([t * 2400.0, np.zeros_like(t)], axis=1)
        w = np.full(len(t), 30.0)

        a = riv.meander(pts, w, seed=11)
        b = riv.meander(pts, w, seed=11)
        c = riv.meander(pts, w, seed=12)
        np.testing.assert_array_equal(a, b)
        self.assertGreater(float(np.abs(a - c).max()), 1.0,
                           "positive control: a different seed must move it")

        np.testing.assert_allclose(a[0], pts[0], atol=1e-9)
        np.testing.assert_allclose(a[-1], pts[-1], atol=1e-9)
        self.assertGreater(float(np.abs(a - pts).max()), 1.0, "nothing moved")

    def test_meander_amplitude_stays_inside_its_budget(self):
        """§2b item 3 says amp 1-2 widths. `meander_amp` is the multiplier and
        the noise is in [-1, 1], so the offset can never exceed amp*width."""
        t = np.linspace(0.0, 1.0, 300)
        pts = np.stack([t * 6000.0, np.zeros_like(t)], axis=1)
        w = np.full(len(t), 25.0)
        p = riv.RiverParams(meander_amp=1.5)
        out = riv.meander(pts, w, seed=5, params=p)
        self.assertLessEqual(float(np.abs(out[:, 1]).max()), 1.5 * 25.0 + 1e-6)

    def test_chaikin_carries_attribute_columns(self):
        """rivers.py smooths (x, z, width, water_z) as one array; the roads
        version used to hard-code 2 columns."""
        from terragen.roads import chaikin_smooth
        pts = np.array([[0.0, 0.0, 10.0, 5.0],
                        [10.0, 20.0, 12.0, 4.0],
                        [30.0, 10.0, 14.0, 3.0],
                        [50.0, 40.0, 16.0, 2.0]])
        out = chaikin_smooth(pts, iterations=2)
        self.assertEqual(out.shape[1], 4)
        np.testing.assert_allclose(out[0], pts[0])
        np.testing.assert_allclose(out[-1], pts[-1])
        # width stays inside the range it was interpolated from
        self.assertGreaterEqual(float(out[:, 2].min()), 10.0 - 1e-9)
        self.assertLessEqual(float(out[:, 2].max()), 16.0 + 1e-9)


class SmoothedAttributes(unittest.TestCase):
    def test_smoothing_preserves_water_surface_monotonicity(self):
        """`build` carries water_z through Douglas-Peucker and Chaikin as an
        extra column, so the monotone sweep's guarantee has to survive both.

        DP subsets indices and Chaikin emits convex combinations of consecutive
        pairs, so neither can introduce a rise — but that is an argument about
        the code, and this is the reading. Widths must stay positive through the
        same treatment.
        """
        h = hilly(size=160, seed=12)
        recv, levels, accum = routed(h)
        net = riv.build(h, recv, levels, accum, CELL, 0.0, seed=4)
        self.assertGreater(len(net.surfaces), 0)
        for s, w in zip(net.surfaces, net.widths):
            self.assertTrue(bool(np.all(np.diff(s) <= 1e-9)),
                            "water surface rose downstream after smoothing")
            self.assertGreater(float(w.min()), 0.0)


class WidthModel(unittest.TestCase):
    def test_junction_width_rule(self):
        """`w = k*sqrt(A)` + areas add => `w_down^2 = w1^2 + w2^2`.

        Positive control: a linear width model `w = k*A`, which does not.
        """
        p = riv.RiverParams(width_min=0.0, width_max=1e9)
        a1, a2 = 4.0e5, 9.0e5
        w1 = float(riv.channel_width(np.array([a1]), p)[0])
        w2 = float(riv.channel_width(np.array([a2]), p)[0])
        wd = float(riv.channel_width(np.array([a1 + a2]), p)[0])
        self.assertAlmostEqual(wd, riv.junction_width(w1, w2), places=9)

        lin = lambda a: 0.001 * a  # noqa: E731
        self.assertNotAlmostEqual(lin(a1 + a2),
                                  float(np.hypot(lin(a1), lin(a2))), places=3)

    def test_width_is_clamped_and_monotone(self):
        p = riv.RiverParams(width_min=12.0, width_max=140.0)
        a = np.array([0.0, 1e3, 1e5, 1e7, 1e12])
        w = riv.channel_width(a, p)
        self.assertTrue(bool(np.all(np.diff(w) >= 0)))
        self.assertGreaterEqual(float(w.min()), 12.0)
        self.assertLessEqual(float(w.max()), 140.0)


class Carve(unittest.TestCase):
    def setUp(self):
        self.h = hilly()
        self.recv, self.levels, self.accum = routed(self.h)

    def build(self, **kw):
        return riv.build(self.h, self.recv, self.levels, self.accum,
                         CELL, 0.0, seed=3, params=riv.RiverParams(**kw))

    def test_carve_only_ever_lowers_terrain(self):
        net = self.build()
        self.assertTrue(bool(np.all(net.terrain <= self.h + 1e-9)))
        self.assertGreater(float((self.h - net.terrain).max()), 1.0,
                           "nothing was carved at all")

    def test_lerp_carve_raises_terrain_min_carve_never_does(self):
        """The positive control for the `min` rule.

        Same bed field, two combination rules. `min` cannot raise ground;
        the lerp §2b item 3 forbids does, on this very fixture — which is what
        makes the assertion above discriminating instead of vacuous.
        """
        net = self.build()
        bed = np.where(np.isfinite(net.dist) & (net.dist < 1e18),
                       np.nan_to_num(net.water_z, nan=np.inf), np.inf)
        wet = np.isfinite(bed)
        if not wet.any():
            self.skipTest("fixture produced no wetted cells")

        w = np.where(wet, 0.6, 0.0)
        lerped = self.h * (1.0 - w) + np.where(wet, bed, self.h) * w
        self.assertGreater(float((lerped - self.h).max()), 1e-6,
                           "positive control: a lerp should raise terrain")
        self.assertLessEqual(float((net.terrain - self.h).max()), 1e-9)

    def test_carve_is_order_independent_and_idempotent(self):
        """Two properties `min` has and a lerp does not, checked directly on
        the shipping carve rather than argued from the code."""
        net = self.build()
        lines, pairs = net.polylines, net.attrs()

        fwd, _, _, _ = riv.carve(self.h, lines, pairs, CELL, 0.0)
        rev, _, _, _ = riv.carve(self.h, lines[::-1], pairs[::-1], CELL, 0.0)
        np.testing.assert_allclose(fwd, rev, atol=1e-9)

        twice, _, _, _ = riv.carve(fwd, lines, pairs, CELL, 0.0)
        np.testing.assert_allclose(fwd, twice, atol=1e-9)

    def test_carve_does_not_mutate_its_input(self):
        before = self.h.copy()
        self.build()
        np.testing.assert_array_equal(self.h, before)

    def test_wetted_cells_sit_below_their_water_surface(self):
        net = self.build()
        wet = net.is_water & np.isfinite(net.water_z)
        self.assertGreater(int(wet.sum()), 0)
        self.assertTrue(bool(np.all(net.terrain[wet] <= net.water_z[wet] + 1e-9)))

    def test_protect_holds_authored_ground_exactly(self):
        """A generator with a gameplay contract (meridian2's ford decks, start
        pads, slope-band regions) must be able to say "not here".

        Positive control: the same run WITHOUT the mask has to carve inside
        that box, or "protected ground is untouched" is trivially true.
        """
        net = self.build()
        cut = self.h - net.terrain
        H, W = self.h.shape
        box = np.zeros(self.h.shape, dtype=bool)
        box[H // 4:3 * H // 4, W // 4:3 * W // 4] = True
        self.assertGreater(float(cut[box].max()), 1.0,
                           "positive control: unprotected box should be carved")

        held = riv.build(self.h, self.recv, self.levels, self.accum, CELL, 0.0,
                         seed=3, params=riv.RiverParams(),
                         protect=box.astype(np.float64))
        np.testing.assert_allclose(held.terrain[box], self.h[box], atol=1e-9)
        # and it is local: the rest of the map is carved exactly as before
        np.testing.assert_allclose(held.terrain[~box], net.terrain[~box], atol=1e-9)
        self.assertFalse(bool((held.is_water & box & (self.h > 0)).any()))

    def test_protect_feathers_without_raising_ground(self):
        net = self.build()
        H, W = self.h.shape
        soft = np.zeros(self.h.shape)
        soft[H // 4:3 * H // 4, W // 4:3 * W // 4] = 0.5
        half = riv.build(self.h, self.recv, self.levels, self.accum, CELL, 0.0,
                         seed=3, params=riv.RiverParams(), protect=soft)
        self.assertTrue(bool(np.all(half.terrain <= self.h + 1e-9)))
        full_cut = (self.h - net.terrain)
        half_cut = (self.h - half.terrain)
        box = soft > 0
        np.testing.assert_allclose(half_cut[box], full_cut[box] * 0.5, atol=1e-9)

    def test_channel_is_wider_where_the_catchment_is_bigger(self):
        """The ribbon has to actually vary in width — a constant-width river is
        the artifact the old log-of-accumulation carve produced."""
        net = self.build()
        allw = np.concatenate(net.widths) if net.widths else np.array([0.0])
        self.assertGreater(float(allw.max() - allw.min()), 5.0)


class BankClampIsAReliefTerm(unittest.TestCase):
    """The relief a map loses between the solver and the package is THIS.

    PLAN-maps M8z FIND 5 recorded the closed-loop relief aim converging on
    the eroded surface while the shipped map stood 1.6-2.7 % lower, and read
    it as "roads and rivers". M9f decomposed it pass by pass on two full-res
    arc arms: start pads spend **0.0**, roads spend **0.0**, the submarine
    sill spends **0.0**, and rivers spend **all** of it (930 -> 909 and
    954 -> 939 elmos at q0.999). Then it split rivers in two, and the halves
    are not the ones the parameter names suggest:

      * the **bed** — `depth_ratio`/`depth_min`/`depth_max`, the thing called
        a river's depth — spends **0.2 of 21.3 elmos** on the real map and
        0.00 here. It only ever cuts inside the wetted width, which is ~1 %
        of land cells and is nowhere near the top of the distribution.
      * the **bank** — `bank_slope` and the reach it grades over, which
        reads like an edge-treatment cosmetic — spends **all** of it, because
        it grades every cell within that reach of a channel down onto a
        surface anchored at the water. On ground steeper than the bank that
        shaves the valley shoulders, and on the pre-M9g arc it covered
        **9.5 % of the map at a mean cut of 21 elmos** (max 153).

    So the bank's reach is a relief knob, not a river-edge detail: pre-M9g,
    `bank_width` 55 -> 110 on the shipped arc cost 44 elmos of q0.999 and 16
    of summit. M9g reshaped the bank and moved that knob (see
    `test_the_reach_dials_move_relief_monotonically`) without touching the
    fact. A test that only asserted "rivers lower the map" would pass with
    the bank deleted, which is why both halves are measured separately here.
    """

    def setUp(self):
        self.h = hilly()
        self.recv, self.levels, self.accum = routed(self.h)
        self.q0 = float(np.quantile(self.h, 0.999))

    def drop(self, **kw):
        """How far the carve moves q0.999 — the aim's own statistic."""
        net = riv.build(self.h, self.recv, self.levels, self.accum, CELL, 0.0,
                        seed=3, params=riv.RiverParams(**kw))
        return self.q0 - float(np.quantile(net.terrain, 0.999))

    def test_the_bed_spends_nothing_and_the_bank_spends_all_of_it(self):
        full = self.drop()
        self.assertGreater(full, 2.0, "the fixture has to lose relief at all")
        # the bed alone: same network, no bank outside the wetted width
        bed = self.drop(bank_width=0.0)
        self.assertLess(bed, 0.1 * full,
                        "the bed is not what spends the aim residual")
        # the bank alone: same ribbon, no bed cut at all
        bank = self.drop(depth_min=0.0, depth_max=0.0)
        self.assertAlmostEqual(bank, full, delta=0.05 * full)

    def test_the_reach_dials_move_relief_monotonically(self):
        """M9g moved the relief knob without moving the relief FACT.

        Pre-M9g the reach was `bank_width` flat, so that one number was the
        dial (55 -> 110 on the arc cost 44 elmos of q0.999). It is now the
        CAP on a width-scaled reach, so on a fixture whose channels sit near
        the width floor it stops biting as soon as it clears that reach —
        10 -> 15 -> 20 elmos still moves the drop 0.29 -> 3.07 -> 3.44 and
        20/45/90 are the same number to the digit. The dials that carry it
        now are `bank_reach_ratio` and `bank_outer_slope`, and each is
        checked here with a factor-2 discrimination so that neutering either
        one is a failure rather than a shrug.
        """
        caps = [0.0, 10.0, 15.0, 20.0, 45.0, 90.0]
        drops = [self.drop(bank_width=w) for w in caps]
        self.assertTrue(all(b >= a - 1e-9 for a, b in zip(drops, drops[1:])),
                        f"not monotone in the cap: {drops}")
        self.assertGreater(drops[3], 2.0 * drops[1],
                           f"the cap does not bite below the reach: {drops}")
        self.assertAlmostEqual(drops[-1], drops[3], delta=0.05 * drops[3])

        ratios = [0.5, 1.6, 3.0, 6.0]
        rd = [self.drop(bank_reach_ratio=r) for r in ratios]
        self.assertTrue(all(b >= a - 1e-9 for a, b in zip(rd, rd[1:])),
                        f"not monotone in bank_reach_ratio: {rd}")
        self.assertGreater(rd[-1], 2.0 * rd[1],
                           f"bank_reach_ratio is not a relief knob here: {rd}")

        # the outer slope is the same dial read the other way: a steeper ramp
        # crosses the hillside sooner, so it spends LESS relief. This is the
        # trade M9g's rim-step floor is paid out of.
        slopes = [0.7, 1.0, 1.4, 2.0]
        sd = [self.drop(bank_outer_slope=o) for o in slopes]
        self.assertTrue(all(b <= a + 1e-9 for a, b in zip(sd, sd[1:])),
                        f"not monotone (down) in bank_outer_slope: {sd}")
        self.assertGreater(sd[0], 2.0 * sd[2],
                           f"bank_outer_slope is not a relief knob here: {sd}")


class BankRibbonIsAValleyForm(unittest.TestCase):
    """The shape the bank authors, pinned AFTER M9g reshaped it.

    Was `BankClampIsNotAValleyForm` — a characterisation of the defect,
    written to fail the day the ribbon was reshaped, with the instruction to
    invert rather than loosen it. This is that inversion; both cases keep the
    pre-M9g shape as a live NEGATIVE control (`legacy()` below), so an
    assertion that has stopped discriminating fails here rather than passing
    quietly.

    What changed and what did not:

      * **the cut used to deepen AWAY from the water** — a plane rising at
        `bank_slope` under ground that rises faster is deepest at the ribbon's
        outer edge (15.1 elmos at 0-10 from the channel against 27.4 at 55-70
        on the shipped arc). The ramp turns that over: the cut peaks
        mid-apron and comes back down, because the bank's slope passes the
        hillside's inside the reach.
      * **it used to stop dead** — `+inf` beyond `half + bank_width` left a
        one-cell step whose height was its own cut (mean 17, p95 51, max 153
        on the arc). The ribbon now ends where the bank CROSSES the ground.
      * **⚠ the crossing still leaves a step, and that is a floor, not a
        residual defect.** A `min` carve against a height-independent field
        is a projection; the cut at its last inside cell is the slope
        difference at the crossing times the cell size. Only a field that
        hugs the terrain tapers to nothing, and a height-referenced field is
        neither idempotent nor order-independent — the two properties the
        whole carve rule exists for. So the guard here is "much smaller than
        the wall, and it cannot be driven to the terrain's own step", and the
        gaussian-smoothed cut is kept as the positive control that shows what
        the unreachable end of that scale looks like.

    Fixture params are the arc's (`bank_width` 55), not the dataclass default
    of 90, so the numbers here are comparable with the shipped map's.
    """

    BW = 55.0
    BANDS = ((0.0, 15.0), (15.0, 40.0), (40.0, 1e9))
    #: the pre-M9g shape: constant reach, no ramp, hard termination.
    LEGACY = {"bank_reach_ratio": 0.0, "bank_outer_slope": 0.0,
              "bank_reach_slack": 1.0}

    def setUp(self):
        self.h = hilly()
        self.recv, self.levels, self.accum = routed(self.h)

    def carve(self, **kw):
        p = riv.RiverParams(**{"bank_width": self.BW, **kw})
        net = riv.build(self.h, self.recv, self.levels, self.accum, CELL, 0.0,
                        seed=3, params=p)
        return self.h - net.terrain, net.dist

    def legacy(self, **kw):
        return self.carve(**{**self.LEGACY, **kw})

    def bands(self, cut, dist):
        """Mean cut in each distance-from-channel band, NaN where empty."""
        hit = cut > 1e-6
        out = []
        for lo, hi in self.BANDS:
            sel = hit & (dist >= lo) & (dist < hi)
            out.append((int(sel.sum()),
                        float(cut[sel].mean()) if sel.any() else float("nan")))
        return out

    @staticmethod
    def rim_step(h0, h1):
        """(steps the pass introduced, steps that were already there).

        A cell inside the ribbon with a 4-neighbour outside it is a rim cell;
        the step is the rise to that neighbour, taken on the carved surface
        and on the natural one at the SAME cells.
        """
        inside = (h0 - h1) > 1e-6
        after = np.zeros_like(h0)
        before = np.zeros_like(h0)
        rim = np.zeros_like(inside)
        for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
            out = inside & ~np.roll(inside, shift, axis=axis)
            rim |= out
            after = np.where(out, np.maximum(after, np.roll(h1, shift, axis=axis) - h1), after)
            before = np.where(out, np.maximum(before, np.roll(h0, shift, axis=axis) - h0), before)
        return after[rim], before[rim]

    def test_the_cut_turns_over_instead_of_deepening_to_the_rim(self):
        got = self.bands(*self.carve())
        means = [m for _, m in got]
        self.assertLessEqual(means[-1], means[-2],
                             f"the ribbon still deepens to its rim: {got}")
        self.assertLess(means[-1], 1.25 * means[0],
                        f"the outer band is still the deep one: {got}")

        # negative control: the pre-M9g plane, on the same terrain, still
        # climbs all the way out — so the assertion above is about the shape
        # and not about this fixture.
        was = self.bands(*self.legacy())
        wm = [m for _, m in was]
        self.assertTrue(all(b > a for a, b in zip(wm, wm[1:])),
                        f"the defect no longer reproduces: {was}")
        self.assertGreater(wm[-1], 1.5 * wm[0], f"{was}")

        # the profile is the BANK's, not the bed's: with the bank off there
        # is no cut beyond the wetted width at all, so nothing to grade.
        bed = self.bands(*self.carve(bank_width=0.0))
        self.assertEqual([n for n, _ in bed[1:]], [0, 0],
                         f"the bed alone reaches past 15 elmos: {bed}")

    def test_the_ribbon_crosses_out_instead_of_ending_in_a_wall(self):
        after, before = self.rim_step(self.h, self.h - self.carve()[0])
        was_after, was_before = self.rim_step(self.h, self.h - self.legacy()[0])

        # the defect still reproduces on the old shape...
        self.assertGreater(was_after.mean(), 3.0 * was_before.mean(),
                           f"legacy rim {was_after.mean():.2f} vs natural "
                           f"{was_before.mean():.2f}")
        self.assertGreater(float(np.quantile(was_after, 0.95)), 20.0,
                           "the tall end of the legacy rim is what showed in "
                           "a hillshade")
        # ...and the crossing is most of it, in the mean and in the tail.
        self.assertLess(after.mean(), 0.7 * was_after.mean(),
                        f"rim {after.mean():.2f} vs legacy "
                        f"{was_after.mean():.2f}")
        self.assertLess(float(np.quantile(after, 0.95)),
                        0.6 * float(np.quantile(was_after, 0.95)),
                        "the tall end of the rim did not come down")

    def test_the_rim_step_is_a_floor_a_steeper_ramp_cannot_beat(self):
        """The trade, asserted: past a point a steeper bank crosses the
        hillside faster and the step it leaves gets TALLER again, while the
        relief it spends keeps falling. There is no setting of this shape
        that reaches the terrain's own step — only a height-referenced field
        does that, and it would cost idempotence.
        """
        rims = []
        for outer in (1.0, 1.4, 2.0, 3.0):
            after, before = self.rim_step(
                self.h, self.h - self.carve(bank_outer_slope=outer)[0])
            rims.append((float(after.mean()), float(before.mean())))
        means = [a for a, _ in rims]
        self.assertGreater(means[-1], min(means),
                           f"a steeper ramp keeps helping: {means}")
        self.assertGreater(min(means), 2.0 * min(b for _, b in rims),
                           f"the floor is gone — re-read the guard: {rims}")

        # positive control, and the unreachable end of the scale: the same cut
        # smoothed to nothing at its edge leaves the terrain's own step.
        cut, _ = self.carve()
        t_after, t_before = self.rim_step(
            self.h, self.h - ndimage.gaussian_filter(cut, 2.0))
        self.assertLess(t_after.mean(), 1.3 * t_before.mean(),
                        f"the guard cannot tell a tapered ribbon from a "
                        f"crossing one: {t_after.mean():.2f} vs "
                        f"{t_before.mean():.2f}")


class LakesAndSeparation(unittest.TestCase):
    def test_a_lake_is_never_baked_into_the_heightmap(self):
        """§2b item 3's hard rule. The basin floor must come out of the stage
        as a basin floor; only `water_z`/`is_water` know there is water in it.
        """
        size = 128
        yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
        h = 240.0 - xx * 1.2                    # a plain draining west
        bowl = np.hypot(xx - 80, yy - 64) < 14
        h = h - np.where(bowl, 40.0, 0.0)
        floor_before = h[bowl].copy()

        recv, levels, accum = routed(h)
        net = riv.build(h, recv, levels, accum, CELL, 0.0, seed=2)

        # the floor may be carved (a channel can run through it) but never
        # raised, and the depression must still be a depression
        self.assertTrue(bool(np.all(net.terrain[bowl] <= floor_before + 1e-9)))
        rim = np.hypot(xx - 80, yy - 64)
        rim_band = (rim > 16) & (rim < 22)
        self.assertLess(float(net.terrain[bowl].mean()),
                        float(net.terrain[rim_band].mean()))

    def test_the_three_fields_are_independent_arrays(self):
        h = hilly(size=128, seed=4)
        recv, levels, accum = routed(h)
        net = riv.build(h, recv, levels, accum, CELL, 0.0, seed=1)
        self.assertIsNot(net.terrain, h)
        self.assertIsNot(net.water_z, net.terrain)
        self.assertEqual(net.terrain.shape, h.shape)
        self.assertEqual(net.water_z.shape, h.shape)
        self.assertEqual(net.is_water.shape, h.shape)
        # water_z is undefined off the network, not silently zero
        self.assertTrue(bool(np.isnan(net.water_z).any()))

    def test_sea_is_water_without_any_channel(self):
        h = np.full((64, 64), -20.0)
        recv, levels, accum = routed(h)
        net = riv.build(h, recv, levels, accum, CELL, 0.0, seed=1)
        self.assertTrue(bool(net.is_water.all()))
        self.assertEqual(net.polylines, [])


class Determinism(unittest.TestCase):
    def test_build_is_deterministic(self):
        h = hilly(size=128, seed=9)
        recv, levels, accum = routed(h)
        a = riv.build(h, recv, levels, accum, CELL, 0.0, seed=17)
        b = riv.build(h, recv, levels, accum, CELL, 0.0, seed=17)
        np.testing.assert_array_equal(a.terrain, b.terrain)
        np.testing.assert_array_equal(a.channel_mask, b.channel_mask)
        self.assertEqual(len(a.polylines), len(b.polylines))
        for x, y in zip(a.polylines, b.polylines):
            np.testing.assert_array_equal(x, y)

    def test_a_different_seed_moves_the_ribbons_but_not_the_network(self):
        """The seed drives meandering only. The channel forest is a property of
        the terrain, so it must NOT move — otherwise the seed is secretly
        re-routing the hydrology."""
        h = hilly(size=128, seed=9)
        recv, levels, accum = routed(h)
        a = riv.build(h, recv, levels, accum, CELL, 0.0, seed=17)
        b = riv.build(h, recv, levels, accum, CELL, 0.0, seed=18)
        np.testing.assert_array_equal(a.channel_mask, b.channel_mask)
        moved = max(float(np.abs(x - y).max())
                    for x, y in zip(a.polylines, b.polylines))
        self.assertGreater(moved, 0.5)


if __name__ == "__main__":
    unittest.main()
