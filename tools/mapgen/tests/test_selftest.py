#!/usr/bin/env python3
"""Tests for the generator determinism harness (terragen/selftest.py).

    python3 -m unittest discover -s tools/mapgen/tests

The harness is tested against *fake* generators — tiny scripts that write a
few files and, optionally, a scratch cache — for the same reason the rest of
this suite fakes its terrain: a real run of meridian2.py/archipelago.py is
minutes long and needs numpy/scipy/PIL. What is real here is the harness:
the hashing, the comparison, and the cache-isolation guard.

The controls that make this suite worth having:

  * a POSITIVE control — a generator that writes one random byte must be
    reported as nondeterministic. A determinism check that cannot fail is
    the failure mode this whole file exists to prevent.
  * a CACHE-ISOLATION control — a generator that writes its erosion cache to
    a fixed path instead of `$TMPDIR` must be reported as a failure, not
    quietly passed. That regression is invisible in the result otherwise:
    run 2 goes warm, skips erosion, and the packages match trivially.
"""

import os
import sys
import textwrap
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from terragen import selftest  # noqa: E402


def write_fake_generator(tmpdir, body):
    """A minimal generator CLI: --out DIR plus whatever `body` does."""
    path = os.path.join(tmpdir, "fake_gen.py")
    with open(path, "w") as f:
        f.write(textwrap.dedent("""\
            import argparse, os, sys
            ap = argparse.ArgumentParser()
            ap.add_argument("--out", required=True)
            ap.add_argument("--seed", type=int, default=1)
            ap.add_argument("--fast", action="store_true")
            args = ap.parse_args()
            os.makedirs(args.out, exist_ok=True)
        """) + textwrap.dedent(body))
    return path


DETERMINISTIC = """
    with open(os.path.join(args.out, "map.smf"), "wb") as f:
        f.write(bytes(range(args.seed % 7, 200)))
    os.makedirs(os.path.join(args.out, "mapconfig"), exist_ok=True)
    with open(os.path.join(args.out, "mapconfig", "info.lua"), "w") as f:
        f.write("return { fast = %s }\\n" % args.fast)
"""

# The cache write mirrors what the real generators do: erode, save to
# $TMPDIR, and load it back on a warm run.
CACHE_TO_TMPDIR = """
    cache = os.path.join(os.environ.get("TMPDIR", "/tmp"), "fake_eroded_1.npy")
    if not os.path.exists(cache):
        open(cache, "wb").write(b"eroded")
""" + DETERMINISTIC


class HashTreeTest(unittest.TestCase):
    def test_hashes_every_file_recursively(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "sub", "deep"))
            open(os.path.join(d, "a.txt"), "w").write("a")
            open(os.path.join(d, "sub", "b.txt"), "w").write("b")
            open(os.path.join(d, "sub", "deep", "c.txt"), "w").write("c")
            tree = selftest.hash_tree(d)
        self.assertEqual(
            sorted(tree),
            ["a.txt", os.path.join("sub", "b.txt"),
             os.path.join("sub", "deep", "c.txt")])
        self.assertEqual(len(set(tree.values())), 3)

    def test_compare_trees_reports_all_three_kinds(self):
        a = {"same": "1", "moved": "2", "gone": "3"}
        b = {"same": "1", "moved": "9", "new": "4"}
        only_a, only_b, differ = selftest.compare_trees(a, b)
        self.assertEqual((only_a, only_b, differ), (["gone"], ["new"], ["moved"]))


class RunSelftestTest(unittest.TestCase):
    def _run(self, body, **kw):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            script = write_fake_generator(d, body)
            return selftest.run_selftest(script, ["--seed", "3"],
                                         label="fake", **kw)

    def test_deterministic_generator_passes(self):
        self.assertEqual(self._run(DETERMINISTIC), 0)

    def test_nondeterministic_generator_fails(self):
        """Positive control: one random byte must be caught."""
        body = DETERMINISTIC + """
    with open(os.path.join(args.out, "drift.bin"), "wb") as f:
        f.write(os.urandom(16))
"""
        self.assertEqual(self._run(body), 1)

    def test_generator_producing_nothing_fails(self):
        self.assertEqual(self._run("    pass\n"), 1)

    def test_crashing_generator_raises(self):
        with self.assertRaises(Exception):
            self._run("    sys.exit(2)\n")

    def test_cache_written_into_isolated_tmpdir_is_accepted(self):
        self.assertEqual(
            self._run(CACHE_TO_TMPDIR, cache_globs=("fake_eroded_*.npy",)), 0)

    def test_cache_outside_tmpdir_is_a_failure_not_a_pass(self):
        """The regression guard.

        A generator that stops honouring TMPDIR still produces two identical
        packages — because run 2 loads run 1's cache and never re-erodes. The
        harness must call that out rather than award the pass.
        """
        body = """
    cache = os.path.join("/tmp", "fake_gen_not_isolated.npy")
    if not os.path.exists(cache):
        open(cache, "wb").write(b"eroded")
""" + DETERMINISTIC
        try:
            self.assertEqual(self._run(body, cache_globs=("fake_eroded_*.npy",)), 1)
        finally:
            if os.path.exists("/tmp/fake_gen_not_isolated.npy"):
                os.remove("/tmp/fake_gen_not_isolated.npy")

    def test_isolation_check_is_the_only_thing_that_differs(self):
        """Same body, no cache_globs: it passes. So the failure above is the
        guard firing, not the fake generator being broken."""
        body = """
    cache = os.path.join("/tmp", "fake_gen_not_isolated.npy")
    if not os.path.exists(cache):
        open(cache, "wb").write(b"eroded")
""" + DETERMINISTIC
        try:
            self.assertEqual(self._run(body), 0)
        finally:
            if os.path.exists("/tmp/fake_gen_not_isolated.npy"):
                os.remove("/tmp/fake_gen_not_isolated.npy")


class GeneratorWiringTest(unittest.TestCase):
    """The two shipping generators must actually expose the flag.

    Parsed out of the source rather than run: `--help` needs numpy/scipy/PIL
    and this suite is meant to run in a bare checkout.
    """

    def _source(self, name):
        path = os.path.join(os.path.dirname(__file__), "..", name)
        with open(path) as f:
            return f.read()

    def test_shipping_generators_declare_selftest(self):
        for name, glob in (("meridian2.py", "meridian2_eroded_*.npy"),
                           ("archipelago.py", "archipelago_eroded_*.npy")):
            src = self._source(name)
            with self.subTest(generator=name):
                self.assertIn('"--selftest"', src)
                self.assertIn("run_selftest", src)
                self.assertIn(glob, src)
                # The glob must name the file the generator really writes, or
                # the isolation guard watches for something that never appears
                # and every selftest fails for the wrong reason. The stem has
                # to occur twice: once building the cache path, once here.
                stem = glob.split("*")[0]
                self.assertGreaterEqual(
                    src.count(stem), 2,
                    f"{name}: cache glob {glob} does not match the erosion "
                    f"cache path the generator builds")


if __name__ == "__main__":
    unittest.main()
