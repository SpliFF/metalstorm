"""terragen.selftest — the determinism gate shared by the map generators.

`same inputs => byte-identical map` is the contract every terragen generator
claims in its own docstring. This module is how a generator proves it, via a
`--selftest` flag (see `meridian2.py` / `archipelago.py`).

Two things make a naive determinism check useless here, and both are the
reason this is a shared module rather than three copies of ten lines:

  1. **The erosion disk cache would fake it.** Both shipping generators cache
     the eroded heightmap at `$TMPDIR/<gen>_eroded_<key>.npy`, so a second run
     in the same environment *loads run 1's output* instead of re-eroding.
     Erosion is the longest and most numerically sensitive stage in the
     pipeline; a check that skips it compares two copies of the same array and
     passes no matter how nondeterministic the code is. Every run below
     therefore gets its own isolated `TMPDIR`, exactly as the 2026-08-03 M7
     item-3 verification did by hand.

  2. **Run 2 must not inherit run 1's process.** Module-level caches, RNG
     state and numpy threading settings all persist within a process and can
     hide a seeding bug (or invent one). Each run is a fresh subprocess
     invoked through the generator's own CLI, so the selftest exercises the
     command a person actually types.

The isolation in (1) is itself checked: if a generator stops honouring
`TMPDIR`, its cache lands in the shared `/tmp` again, run 2 goes warm, and the
comparison silently reverts to the useless one. `run_selftest(cache_globs=...)`
fails loudly in that case rather than printing a green result it did not earn.
"""
from __future__ import annotations

import fnmatch
import hashlib
import os
import subprocess
import sys
import tempfile

__all__ = ["hash_file", "hash_tree", "compare_trees", "run_selftest"]


def hash_file(path: str, _chunk: int = 1 << 20) -> str:
    """sha256 of a file, read in chunks (packages contain 100 MB+ SMTs)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(_chunk), b""):
            h.update(block)
    return h.hexdigest()


def hash_tree(root: str) -> dict[str, str]:
    """{path relative to root: sha256} for every regular file underneath.

    The whole package is hashed, not a hand-picked list of outputs: a
    generator that is deterministic in its `.smf` and drifting in its
    `mapinfo.lua` or featureplacer config is still nondeterministic, and a
    curated list is exactly what stops noticing when a new output appears.
    """
    out: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            if os.path.islink(path) or not os.path.isfile(path):
                continue
            out[os.path.relpath(path, root)] = hash_file(path)
    return out


def compare_trees(a: dict[str, str], b: dict[str, str]):
    """(only_in_a, only_in_b, differing) — sorted relative paths."""
    only_a = sorted(set(a) - set(b))
    only_b = sorted(set(b) - set(a))
    differ = sorted(p for p in set(a) & set(b) if a[p] != b[p])
    return only_a, only_b, differ


def _run_once(script: str, out_dir: str, scratch: str, passthrough) -> None:
    """One cold generation: fresh process, fresh TMPDIR, generator's own CLI."""
    env = dict(os.environ)
    # TMPDIR is what the generators read; TMP/TEMP keep tempfile itself (and
    # anything else that consults them) inside the same isolated scratch.
    env["TMPDIR"] = env["TMP"] = env["TEMP"] = scratch
    cmd = [sys.executable, script, "--out", out_dir, *passthrough]
    print(f"  $ TMPDIR={scratch} {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True, env=env)


def _cache_written(scratch: str, cache_globs) -> list[str]:
    """Files under `scratch` matching any of `cache_globs` (recursive)."""
    hits = []
    for dirpath, _dirnames, filenames in os.walk(scratch):
        for name in filenames:
            if any(fnmatch.fnmatch(name, g) for g in cache_globs):
                hits.append(os.path.join(dirpath, name))
    return hits


def run_selftest(script: str, passthrough=(), *, label: str = "",
                 cache_globs=()) -> int:
    """Generate twice into isolated temp dirs; assert identical packages.

    Returns a process exit code: 0 identical, 1 nondeterministic or the
    `TMPDIR` isolation did not take.

    `cache_globs` names the generator's scratch artefacts (e.g.
    ``("meridian2_eroded_*.npy",)``). At least one must appear inside the
    isolated scratch, or the run was not the cold run this test claims to be.
    """
    passthrough = list(passthrough)
    label = label or os.path.basename(script)
    print(f"SELFTEST {label}: two cold runs, isolated TMPDIR per run"
          f"{' — args: ' + ' '.join(passthrough) if passthrough else ''}")

    trees = []
    for i in range(2):
        with tempfile.TemporaryDirectory(prefix=f"selftest_{label}_out{i}_") as out_dir, \
                tempfile.TemporaryDirectory(prefix=f"selftest_{label}_tmp{i}_") as scratch:
            print(f"run {i + 1}/2:", flush=True)
            _run_once(script, out_dir, scratch, passthrough)

            if cache_globs:
                hits = _cache_written(scratch, cache_globs)
                if not hits:
                    print(
                        f"SELFTEST FAILED: run {i + 1} wrote no {'/'.join(cache_globs)} "
                        f"inside its isolated TMPDIR ({scratch}).\n"
                        "  The generator is no longer honouring TMPDIR, so run 2 would\n"
                        "  load run 1's cached erosion and this test would compare a\n"
                        "  cached array against itself. That is a false PASS, so it is\n"
                        "  reported as a failure instead.", file=sys.stderr)
                    return 1
                print(f"  cold: erosion recomputed into {os.path.basename(hits[0])}")

            tree = hash_tree(out_dir)
            if not tree:
                print(f"SELFTEST FAILED: run {i + 1} produced no files in {out_dir}.",
                      file=sys.stderr)
                return 1
            print(f"  {len(tree)} file(s) hashed")
            trees.append(tree)

    only_1, only_2, differ = compare_trees(trees[0], trees[1])
    if not (only_1 or only_2 or differ):
        print(f"SELFTEST OK: {len(trees[0])} file(s) byte-identical across two "
              f"independent cold runs.")
        return 0

    print(f"SELFTEST FAILED: {label} is not deterministic.", file=sys.stderr)
    for path in differ:
        print(f"  differs:      {path}", file=sys.stderr)
    for path in only_1:
        print(f"  only in run1: {path}", file=sys.stderr)
    for path in only_2:
        print(f"  only in run2: {path}", file=sys.stderr)
    return 1
