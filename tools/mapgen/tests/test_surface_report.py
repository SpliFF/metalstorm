#!/usr/bin/env python3
"""Which surface the generator's readings are taken on (PLAN-maps M8z).

    .venv/bin/python -m unittest tests.test_surface_report

The defect this module exists to remove is a *reporting* one, and it cost the
lane five milestones of ranking: `archipelago.generate` printed `divides:`,
`aim:` and `texture:` at step 3, straight off the solver, and nothing said so.
Roads, rivers and the sill carve then rewrite that surface — the shipped arc's
16-32 elmo band goes **1.59 → 1.11** — so every arm M8q-M8v compared on the
`texture:` line was compared on a surface no player ever drives (M8x FIND 5).

Two things are pinned here, because both are one careless edit from coming
back:

1. **Every reading carries the name of the surface it was read on.**
   `report_surface` tags all three lines with its `label`, and returns them,
   so a caller can diff two surfaces rather than eyeball two runs.
2. **`generate` reads both, and the shipped one reads LAST** — after
   `flatten_under_roads`, after `rivers.build`, after `connect_starts`, and
   before anything that consumes the heightmap. Ordering is the whole
   content of the fix, so it is asserted against the source rather than
   trusted to a comment (the same reason `test_passability` asserts the two
   grading tables agree).

The premise under both is pinned as well — that steps 6-7b are *not* neutral
to the readings — on a fixture small enough to run in the suite. Only the
non-neutrality: the shipped numbers belong to the shipped map, not to a
synthetic island, and this lane has already been burned once by an instrument
measured on the wrong surface.
"""
from __future__ import annotations

import ast
import inspect
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import archipelago as arch                                # noqa: E402
from terragen import hydrology as hyd                     # noqa: E402
from terragen import rivers as riv                        # noqa: E402
from terragen import noise as tn                          # noqa: E402
from terragen import roads as rd                          # noqa: E402
from terragen import uplift as up                         # noqa: E402


CELL = 8.0
N = 384


def _grated_island(wavelength: float = 24.0, amp: float = 6.0) -> np.ndarray:
    """A round island, fBm-roughened, with a fine E-W comb on it.

    The comb sits at 24 elmos, i.e. inside the 16-32 band roads and rivers
    were measured to rewrite on the shipped arc. The fBm is not decoration:
    a *pure* grating has a peak-over-mean ratio that no uniform re-scaling
    of it can move, so on that fixture every terrain pass reads neutral for
    a reason that has nothing to do with terrain. Real ground is broadband
    with a bias, and so is this.
    """
    z, x = np.mgrid[0:N, 0:N].astype(np.float64) * CELL
    c = N * CELL * 0.5
    r = np.hypot(x - c, z - c)
    dome = 260.0 * np.clip(1.0 - (r / (N * CELL * 0.44)) ** 2, 0.0, 1.0)
    grain = tn.fbm(tn.SimplexNoise(3), x, z, octaves=6,
                   frequency=1.0 / 240.0) * 40.0
    comb = amp * np.sin(2 * np.pi * x / wavelength)
    return dome + (grain + comb) * (dome > 0.0)


class ReportSurfaceTest(unittest.TestCase):
    def _report(self, h, label, terrain="arc"):
        lines: list[str] = []
        rep = arch.report_surface(h, CELL, label, terrain=terrain,
                                  relief_target=260.0, log=lines.append)
        return rep, lines

    def test_every_line_names_the_surface_it_was_read_on(self):
        rep, lines = self._report(_grated_island(), "eroded")
        self.assertEqual(rep.label, "eroded")
        self.assertEqual(len(lines), 3)                 # divides, aim, texture
        for line in lines:
            self.assertIn("[eroded]", line,
                          f"untagged reading — the M8x FIND 5 defect: {line}")
        self.assertTrue(lines[0].startswith("divides[eroded]:"))
        self.assertTrue(lines[1].startswith("aim[eroded]:"))
        self.assertTrue(lines[2].startswith("texture[eroded]:"))

    def test_the_readings_come_back_as_values_not_just_text(self):
        rep, _ = self._report(_grated_island(), "shipped")
        self.assertEqual(len(rep.texture), len(up.ANISOTROPY_BANDS))
        self.assertGreater(rep.divides.land_frac, 0.0)
        self.assertAlmostEqual(rep.relief, float(np.ptp(_grated_island())),
                               places=6)
        self.assertIsNotNone(rep.aim)

    def test_the_aim_line_is_arc_only(self):
        # `mounds` has no relief target to aim at — it is a noise field
        # calibrated by landmass — so quoting a residual there would be
        # inventing one.
        rep, lines = self._report(_grated_island(), "eroded", terrain="mounds")
        self.assertIsNone(rep.aim)
        self.assertEqual(len(lines), 2)
        self.assertFalse(any(l.startswith("aim[") for l in lines))

    def test_the_terrain_passes_are_not_neutral_to_the_fine_band(self):
        """Why reading one surface and quoting it as both is a defect.

        The premise under the whole two-report change is that steps 6-7b
        move the reading. Here it is on a fixture small enough to run in the
        suite: a combed island, then the real road grading and the real
        river carve.

        ⚠ **Only the non-neutrality is asserted, not a direction or a size.**
        The shipped arc's **1.59 → 1.11** is measured on the shipped arc
        (M8z), and this fixture is not it. Two things it does show, and they
        are the reason the assertion is worded this way:

        * `flatten_under_roads` **alone reads as neutral here** (55.59 →
          55.55). Grading is close to a uniform down-scale of whatever it
          covers, and a peak-over-mean ratio divides a uniform scale out. On
          the real map roads still matter — they are what closes six of the
          eight VEH splits (M8x FIND 1) — but the band moves because new
          structure is written, not because old structure is flattened.
        * The river carve is what moves it (55.59 → 36.79, 755 reaches):
          dendritic channels at 9-48 elmos write **into** the 16-32 band, in
          directions of their own, and dilute whatever the solver combed.
        """
        h = _grated_island()
        _z, x = np.mgrid[0:N, 0:N].astype(np.float64) * CELL
        # N-S corridors at the arc's own road width, spaced so the graded
        # band (half-width + `flatten_blend`) covers most of the island
        road_dist = np.full(h.shape, 1e6)
        for cx in np.arange(300.0, N * CELL, 300.0):
            road_dist = np.minimum(road_dist, np.abs(x - cx))
        graded = rd.flatten_under_roads(h, road_dist, CELL,
                                        rd.RoadParams(road_width=44.0))

        filled = hyd.fill_depressions(graded)
        recv = hyd.d8_receivers(hyd.resolve_flats(filled))
        levels = hyd.topo_levels(recv)
        accum = hyd.flow_accumulation(recv, levels)
        net = riv.build(graded, recv, levels, accum, CELL, 0.0, 7,
                        riv.RiverParams(channel_fraction=0.03,
                                        width_coef=0.05, width_min=9.0,
                                        width_max=48.0, depth_max=6.0,
                                        bank_width=55.0),
                        np.zeros(h.shape))

        band = up.ANISOTROPY_BANDS[0]                   # 16-32 elmos
        before = up.anisotropy_bands(h, CELL, bands=(band,))[0].excess
        after = up.anisotropy_bands(net.terrain, CELL, bands=(band,))[0].excess
        self.assertGreater(abs(after - before) / before, 0.05,
                           f"roads + rivers left the fine band where they "
                           f"found it ({before:.2f} -> {after:.2f}) — if that "
                           f"is real, the two reports are redundant and M8x "
                           f"FIND 5 needs re-reading")
        # ...and the island is still an island: this is a re-texturing of the
        # surface, not its destruction
        self.assertGreater(float((net.terrain > 0.0).mean()),
                           0.8 * float((h > 0.0).mean()))


class GenerateOrderTest(unittest.TestCase):
    """Where the two calls sit in `generate`, read off the source.

    A runtime assertion would need a 2049^2 solve; the contract is purely an
    ordering one, so parse it. `ast` rather than a regex, so a mention in a
    comment or docstring cannot satisfy it.
    """

    @staticmethod
    def _generate_node():
        """The `ast` node of `archipelago.generate`, from the module source."""
        tree = ast.parse(inspect.getsource(arch))
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == "generate":
                return node
        raise AssertionError("archipelago.generate not found")

    @classmethod
    def _calls(cls):
        """[(lineno, name)] for every call in `generate`, in source order.

        `name` is the dotted callee (`rd.flatten_under_roads`) plus, for
        `report_surface`, its label argument (`report_surface:shipped`).
        """
        out = []
        for node in ast.walk(cls._generate_node()):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
                name = f"{f.value.id}.{f.attr}"
            elif isinstance(f, ast.Name):
                name = f.id
            else:
                continue
            if name == "report_surface" and len(node.args) >= 3 and \
                    isinstance(node.args[2], ast.Constant):
                name += f":{node.args[2].value}"
            out.append((node.lineno, name))
        return sorted(out)

    def setUp(self):
        self.calls = self._calls()
        self.at = {name: line for line, name in self.calls}

    def test_generate_reports_exactly_two_surfaces(self):
        labels = [n for _, n in self.calls if n.startswith("report_surface")]
        self.assertEqual(labels,
                         ["report_surface:eroded", "report_surface:shipped"])

    # The road step's terrain mover was renamed by roads R2: archipelago now
    # calls `rd.flatten_network` (one pass over a per-class field) instead of
    # `rd.flatten_under_roads`. This guard names its movers by CALLEE, so the
    # rename made it fail — which is the guard working: a renamed mover is
    # exactly the change that could silently move terrain after the report.
    # Both spellings are accepted because `flatten_under_roads` is still the
    # single-class entry point and a generator may legitimately use either.
    ROAD_MOVERS = ("rd.flatten_network", "rd.flatten_under_roads")

    def _road_mover(self):
        for name in self.ROAD_MOVERS:
            if name in self.at:
                return name
        self.fail(f"no road terrain-mover in generate (looked for "
                  f"{self.ROAD_MOVERS}) — re-check that the shipped report "
                  f"is still last")

    def test_the_shipped_report_runs_after_every_pass_that_moves_terrain(self):
        shipped = self.at["report_surface:shipped"]
        for mover in (self._road_mover(), "riv.build", "pas.connect_starts"):
            self.assertIn(mover, self.at,
                          f"{mover} vanished from generate — re-check that "
                          f"the shipped report is still last")
            self.assertLess(self.at[mover], shipped,
                            f"{mover} runs AFTER the shipped report, so the "
                            f"report is not of the shipped surface")

    def test_the_eroded_report_runs_before_them(self):
        eroded = self.at["report_surface:eroded"]
        self.assertLess(eroded, self.at[self._road_mover()])
        self.assertLess(eroded, self.at["report_surface:shipped"])

    def test_nothing_moves_the_heightmap_after_the_shipped_report(self):
        """The claim the `[shipped]` label makes, checked against the source.

        Everything downstream of 7c reads `h`; the only writer left is the
        16-bit quantization inside `write_package`, which was measured to
        move the survey by less than 0.005 in every band (M8z: the packaged
        `.smf` re-reads the generator's own `[shipped]` line exactly).
        """
        shipped = self.at["report_surface:shipped"]
        writers = []
        for node in ast.walk(self._generate_node()):
            targets = []
            if isinstance(node, ast.Assign):
                targets = node.targets
            elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
                targets = [node.target]
            for t in targets:
                if isinstance(t, ast.Name) and t.id == "h" and \
                        node.lineno > shipped:
                    writers.append(node.lineno)
                if isinstance(t, ast.Subscript) and \
                        isinstance(t.value, ast.Name) and t.value.id == "h" \
                        and node.lineno > shipped:
                    writers.append(node.lineno)
        self.assertEqual(writers, [],
                         "the heightmap is written after the [shipped] "
                         f"report (source lines {writers}) — that report is "
                         "no longer of the surface that ships")


if __name__ == "__main__":
    unittest.main()
