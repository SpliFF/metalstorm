#!/usr/bin/env python3
"""Per-map reachability intent — the §2k ruling as a checkable contract.

    .venv/bin/python -m unittest tests.test_reachability_intent

PLAN-maps.md §2k (user ruling 2026-08-16): a split or island map is legal
player content, so `regions_from_map.py --verify` can no longer read "the
starts are in two components" as a verdict. The map declares its intent and the
gate judges the measurement against the declaration — in BOTH directions.

Three failure modes are pinned here, all of them things this lane has actually
shipped before:

1. **A key one side writes and the other never reads** (M8l's road speed
   multiplier, parsed by nobody). The emitter and the parser live in one module
   and are round-tripped against each other, and the real
   `package.emit_mapinfo` output is parsed rather than a hand-built string.
2. **A rule the producer satisfies by construction is inert.** The intent is
   AUTHORED in the generators (`SHIPPED_REACHABILITY` /
   `DECLARED_REACHABILITY`), never measured from the run's own output, and an
   unnamed map id still defaults to the strict reading.
3. **A declaration going stale silently.** `split` on a map that comes out
   connected fails, because otherwise the gate is off for nothing.
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import archipelago                                       # noqa: E402
import meridian2                                         # noqa: E402
import regions_from_map as rfm                           # noqa: E402
from terragen import package as pkg                      # noqa: E402
from terragen import reachability as reach               # noqa: E402

# tests/ -> tools/mapgen -> tools -> repo root
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

# The maps whose `mapinfo.lua` is tracked in git (`content/maps/`), so a
# regeneration that drops the declaration is a diff someone can see.
TRACKED_SPLIT_MAPS = ("meridian_basin", "skerry_reach", "sundered_arc")


class EmitterAndParserAgree(unittest.TestCase):
    def test_round_trip_both_intents(self):
        for intent in reach.INTENTS:
            text = "local mapinfo = {\n" + reach.emit_mapinfo_block(intent) + "}\n"
            self.assertEqual(reach.parse_mapinfo(text), intent)

    def test_prose_in_the_block_does_not_answer_for_it(self):
        """The block documents both values in `--` comments above the key.

        A parser that did not strip comments would read the first word it saw:
        the `"connected"` in the prose, on a map declaring `"split"`.
        """
        block = reach.emit_mapinfo_block(reach.SPLIT)
        self.assertIn('"connected"', block)          # the prose is really there
        self.assertEqual(
            reach.parse_mapinfo("local mapinfo = {\n" + block + "}\n"),
            reach.SPLIT)

    def test_silence_is_the_strict_reading(self):
        self.assertEqual(reach.parse_mapinfo("local mapinfo = { name = 'x' }"),
                         reach.CONNECTED)
        self.assertEqual(reach.DEFAULT_INTENT, reach.CONNECTED)

    def test_a_reachability_key_outside_the_block_is_ignored(self):
        text = 'local mapinfo = {\n  reachability = "split",\n}\n'
        self.assertEqual(reach.parse_mapinfo(text), reach.CONNECTED)

    def test_a_typo_is_an_error_not_a_fallback(self):
        text = 'local mapinfo = {\n metalstorm = { reachability = "spilt" },\n}\n'
        with self.assertRaises(ValueError):
            reach.parse_mapinfo(text)
        with self.assertRaises(ValueError):
            reach.emit_mapinfo_block("spilt")

    def test_the_real_package_emitter_carries_it(self):
        for intent in reach.INTENTS:
            cfg = pkg.MapPackageConfig(map_id="t", display_name="T",
                                       reachability=intent,
                                       start_positions=[(10.0, 10.0)])
            self.assertEqual(reach.parse_mapinfo(pkg.emit_mapinfo(cfg)), intent)

    def test_a_config_that_says_nothing_declares_connected(self):
        cfg = pkg.MapPackageConfig(map_id="t", display_name="T")
        self.assertEqual(reach.parse_mapinfo(pkg.emit_mapinfo(cfg)),
                         reach.CONNECTED)


class TheGateClassIsTheVerifiersClass(unittest.TestCase):
    """A whole-map declaration cannot be true of every movement class.

    Meridian Basin's scarp is 44-75 degrees of side-hill: inside INFANTRY's
    45-degree maxslope, outside VEH's 32 and HEAVY's 24. So the map is CONNECTED
    for infantry and SPLIT for armour, and only the class the gate judges can
    decide a generator's declared-vs-measured verdict.
    """

    def test_the_generator_and_the_verifier_judge_the_same_class(self):
        self.assertIn(rfm.DEFAULT_CLASS, reach.GATE_CLASSES)

    def test_a_non_gate_class_disagreeing_is_not_a_disagreement(self):
        class Reading:
            def __init__(self, cls, groups, stranded=()):
                self.cls, self.groups, self.stranded = cls, groups, list(stranded)

        lines = []
        ok = reach.report([Reading("INFANTRY", {1: [0, 1]}),          # connected
                           Reading("VEH", {1: [0], 2: [1]}),          # split
                           Reading("HEAVY", {1: [0], 2: [1]})],
                          reach.SPLIT, log=lines.append)
        self.assertTrue(ok, lines)
        # M9o / lane queue item 2: a class outside the declared scope is
        # MEASURED, never judged — the old wording called meridian's
        # connected INFANTRY "stale", which is the confusion the scope key
        # exists to remove.
        self.assertTrue(any("outside declared scope" in ln for ln in lines),
                        lines)
        self.assertFalse(any("stale" in ln for ln in lines), lines)

    def test_the_gate_class_disagreeing_is_reported_loudly(self):
        class Reading:
            def __init__(self, cls, groups, stranded=()):
                self.cls, self.groups, self.stranded = cls, groups, list(stranded)

        lines = []
        ok = reach.report([Reading("VEH", {1: [0, 1]})], reach.SPLIT,
                          log=lines.append)
        self.assertFalse(ok)
        self.assertTrue(any("will fail it" in ln for ln in lines), lines)


class TheVerdictNeedsBothSides(unittest.TestCase):
    def test_connected_map_under_each_intent(self):
        groups = {7: [0, 1, 2]}
        ok, msg = reach.verdict(reach.CONNECTED, groups, [])
        self.assertTrue(ok, msg)
        ok, msg = reach.verdict(reach.SPLIT, groups, [])
        self.assertFalse(ok, "a stale split declaration must not pass")
        self.assertIn("stale", msg)

    def test_split_map_under_each_intent(self):
        groups = {7: [0, 1], 9: [2]}
        ok, msg = reach.verdict(reach.SPLIT, groups, [])
        self.assertTrue(ok, msg)
        ok, msg = reach.verdict(reach.CONNECTED, groups, [])
        self.assertFalse(ok)
        self.assertIn("2 disconnected components", msg)

    def test_a_start_on_unusable_ground_is_refused_by_both(self):
        for intent in reach.INTENTS:
            ok, msg = reach.verdict(intent, {7: [0, 1]}, [2])
            self.assertFalse(ok, f"{intent} accepted a stranded start")
            self.assertIn("impassable ground", msg)

    def test_a_single_start_cannot_be_split(self):
        ok, _ = reach.verdict(reach.CONNECTED, {7: [0]}, [])
        self.assertTrue(ok)
        ok, msg = reach.verdict(reach.SPLIT, {7: [0]}, [])
        self.assertFalse(ok)
        self.assertIn("nothing to be split from", msg)


class TheIntentIsAuthoredNotMeasured(unittest.TestCase):
    def test_generators_declare_the_shipped_maps_split(self):
        for map_id in ("sundered_arc", "skerry_reach", "frost_reach",
                       "dune_reach", "verdant_shoals"):
            self.assertEqual(archipelago.SHIPPED_REACHABILITY.get(map_id),
                             reach.SPLIT, map_id)
        self.assertEqual(meridian2.DECLARED_REACHABILITY, reach.SPLIT)

    def test_an_unnamed_map_id_gets_the_strict_default(self):
        """A new map that strands its starts by accident must still fail."""
        self.assertEqual(
            archipelago.SHIPPED_REACHABILITY.get("some_new_map",
                                                 reach.DEFAULT_INTENT),
            reach.CONNECTED)

    def test_the_shipped_packages_in_git_declare_split(self):
        """The declaration is only worth anything if it is in the package.

        This is what catches a regeneration that drops the flag: these three
        `mapinfo.lua` files are tracked, so the ruling lives in git rather than
        in a gitignored `data/maps/` copy nobody else would get.
        """
        for map_id in TRACKED_SPLIT_MAPS:
            path = os.path.join(REPO, "content", "maps", map_id, "mapinfo.lua")
            self.assertTrue(os.path.exists(path), path)
            with open(path, "r", encoding="utf-8") as f:
                self.assertEqual(reach.parse_mapinfo(f.read()), reach.SPLIT,
                                 f"{map_id} lost its §2k declaration")


class TheDeclarationNamesItsScope(unittest.TestCase):
    """`reachability_classes` — M9o's find, executed (lane queue item 2).

    meridian_basin declares "split" and INFANTRY measures connected. That is
    the documented per-class divergence, but a declaration that does not name
    its scope cannot say so — a reader had to know the verifier's default to
    know which classes the claim covered. The scope key writes it down, and a
    package emitted before the key existed still reads as the old scope.
    """

    def test_round_trip_scope(self):
        block = reach.emit_mapinfo_block(reach.SPLIT,
                                         classes=("VEH", "HEAVY"))
        text = "local mapinfo = {\n" + block + "}\n"
        self.assertEqual(reach.parse_mapinfo(text), reach.SPLIT)
        self.assertEqual(reach.parse_mapinfo_classes(text), ("VEH", "HEAVY"))

    def test_an_old_package_reads_as_the_gate_scope(self):
        # a mapinfo written before the key existed — no reachability_classes
        text = ('local mapinfo = {\n metalstorm = { reachability = "split" '
                '},\n}\n')
        self.assertEqual(reach.parse_mapinfo_classes(text),
                         reach.GATE_CLASSES)

    def test_silence_is_the_gate_scope(self):
        self.assertEqual(
            reach.parse_mapinfo_classes("local mapinfo = { name = 'x' }"),
            reach.GATE_CLASSES)

    def test_an_unknown_class_is_an_error_not_a_fallback(self):
        text = ('local mapinfo = {\n metalstorm = { reachability = "split", '
                'reachability_classes = "TANKS" },\n}\n')
        with self.assertRaises(ValueError):
            reach.parse_mapinfo_classes(text)
        with self.assertRaises(ValueError):
            reach.emit_mapinfo_block(reach.SPLIT, classes=())

    def test_known_classes_pin_the_passability_vocabulary(self):
        """reachability.py is stdlib-only and cannot import passability, so
        the vocabulary is duplicated and pinned here instead."""
        from terragen import passability as pas
        self.assertEqual(tuple(pas.DEFAULT_CLASSES), reach.KNOWN_CLASSES)

    def test_the_real_emitter_carries_the_scope(self):
        cfg = pkg.MapPackageConfig(map_id="t", display_name="T",
                                   reachability=reach.SPLIT,
                                   reachability_classes=("VEH", "HEAVY"),
                                   start_positions=[(10.0, 10.0)])
        text = pkg.emit_mapinfo(cfg)
        self.assertEqual(reach.parse_mapinfo_classes(text), ("VEH", "HEAVY"))

    def test_generators_author_a_true_scope(self):
        """meridian is split for armour only; a mounds archipelago is split
        for everything; the arc is split for armour only (M8w/M8x)."""
        self.assertEqual(meridian2.DECLARED_REACHABILITY_CLASSES,
                         ("VEH", "HEAVY"))
        self.assertEqual(
            archipelago.DECLARED_REACHABILITY_CLASSES["mounds"],
            ("INFANTRY", "VEH", "HEAVY"))
        self.assertEqual(
            archipelago.DECLARED_REACHABILITY_CLASSES["arc"],
            ("VEH", "HEAVY"))
        for classes in ([meridian2.DECLARED_REACHABILITY_CLASSES]
                        + list(archipelago.DECLARED_REACHABILITY_CLASSES
                               .values())):
            for c in classes:
                self.assertIn(c, reach.KNOWN_CLASSES)


# --- the verifier's own two checks, over a synthetic mask -------------------
#
# Two 3x3 passable pockets separated by a wall of impassable cells, and a
# region grid coarse enough that ONE rectangle contains both pockets — which is
# how a graph edge chains across an armour split on the real maps.
W = H = 8
E = rfm.ELMOS_PER_SQUARE


def _two_pockets():
    ok = [False] * (W * H)
    comp = [-1] * (W * H)
    for z in range(1, 4):
        for x in range(1, 4):
            ok[z * W + x] = True
            comp[z * W + x] = 1
        for x in range(5, 8):
            ok[z * W + x] = True
            comp[z * W + x] = 2
    return ok, comp


class TheVerifierJudgesAgainstTheDeclaration(unittest.TestCase):
    def setUp(self):
        self.ok, self.comp = _two_pockets()
        self.starts = [(2 * E, 2 * E), (6 * E, 2 * E)]

    def test_split_mask_fails_connected_and_passes_split(self):
        passed, msg, ids = rfm.verify_starts(
            self.ok, self.comp, W, H, self.starts, reach.CONNECTED)
        self.assertFalse(passed, msg)
        passed, msg, ids = rfm.verify_starts(
            self.ok, self.comp, W, H, self.starts, reach.SPLIT)
        self.assertTrue(passed, msg)
        self.assertEqual(sorted(ids.values()), [1, 2])

    def test_one_pocket_passes_connected_and_fails_split(self):
        starts = [(2 * E, 2 * E), (3 * E, 3 * E)]
        passed, _msg, _ids = rfm.verify_starts(
            self.ok, self.comp, W, H, starts, reach.CONNECTED)
        self.assertTrue(passed)
        passed, msg, _ids = rfm.verify_starts(
            self.ok, self.comp, W, H, starts, reach.SPLIT)
        self.assertFalse(passed)
        self.assertIn("stale", msg)

    def test_the_graph_check_fails_a_cross_component_claim(self):
        """A single region spanning both pockets links starts the mask splits.

        This was reported-not-failed while every generated map shipped it (15
        pairs on sundered_arc, 16 on meridian_basin, 28 on each 8-island map).
        M9k made the partition per (rectangle, component), so the count is zero
        by construction on the generator's own output and a non-zero one is a
        defect — the hand-built regions below are what that defect looks like.
        """
        regions = [
            {"key": "west", "_cell": (0, 0), "neighbors": ["mid"]},
            {"key": "mid", "_cell": (1, 0), "neighbors": ["west", "east"]},
            {"key": "east", "_cell": (2, 0), "neighbors": ["mid"]},
        ]
        ids = {0: 1, 1: 2}
        passed, msg, crossed = rfm.verify_graph(
            regions, ids, [(0.0, 0.0), (2 * E * rfm.ELMOS_PER_SQUARE, 0.0)],
            1.0, 1.0, reach.SPLIT)
        self.assertFalse(passed, msg)
        self.assertEqual(crossed, 1)
        self.assertIn("different components", msg)

    def test_the_graph_check_still_fails_a_dropped_real_route(self):
        regions = [
            {"key": "west", "_cell": (0, 0), "neighbors": []},
            {"key": "east", "_cell": (2, 0), "neighbors": []},
        ]
        ids = {0: 1, 1: 1}          # the mask says one component
        passed, msg, crossed = rfm.verify_graph(
            regions, ids, [(0.0, 0.0), (2 * E * rfm.ELMOS_PER_SQUARE, 0.0)],
            1.0, 1.0, reach.SPLIT)
        self.assertFalse(passed, msg)
        self.assertEqual(crossed, 0)
        self.assertIn("same-component", msg)


if __name__ == "__main__":
    unittest.main()
