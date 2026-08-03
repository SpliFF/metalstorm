"""Determinism regression guard for the numba-ported terragen kernels
(PLAN-maps.md §2b item 1: noise.py's fBm/ridged/billow, hydrology.py's
resolve_flats/d8_receivers, erosion.py's stream-power solve + thermal
erosion).

Two checks, mirroring the project's existing `--selftest` philosophy
(regenerate twice, hash equal — see `meridian.py --selftest`):

1. **Double-run determinism**: run the full kernel set twice from the same
   seed/inputs in this process and hash both. Catches accidental use of
   uninitialized memory, dict/set iteration order, or anything else that
   isn't a pure function of its inputs.
2. **Thread-count independence**: run the same kernels in subprocesses with
   `NUMBA_NUM_THREADS` set to 1, 2, 4, 8 and hash each. The parallel (prange)
   kernels here are all embarrassingly parallel (every output element is
   written by exactly one iteration, no cross-thread accumulation), so
   output must be identical regardless of thread count — this is the hard
   determinism requirement from PLAN-maps.md (the integer-hash gradient
   scheme must stay thread-count-independent).

This does NOT compare against the pre-numba-port implementation — that
one-time verification was done manually against the git history at port
time (noise2/fbm/ridged/billow/domain_warp, resolve_flats, d8_receivers,
thermal_erode, and full stream_power_erode all confirmed byte-identical,
including with uplift + non-uniform erodibility + deliberately-flat
regions). This script is the ongoing guard against future regressions.

Usage: .venv/bin/python terragen/_selftest_numba.py
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys

REPO_TOOLS_MAPGEN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run_kernels_hash() -> str:
    import numpy as np

    from terragen import erosion as ero
    from terragen import noise as tn

    n = tn.SimplexNoise(20260727)
    x = np.linspace(-300.0, 300.0, 257)
    xx, yy = np.meshgrid(x, x)

    h = hashlib.sha256()
    h.update(tn.fbm(n, xx / 113.0, yy / 113.0, octaves=8).tobytes())
    h.update(tn.ridged(tn.SimplexNoise(20260728), xx / 97.0, yy / 97.0, octaves=6).tobytes())
    h.update(tn.billow(tn.SimplexNoise(20260729), xx / 61.0, yy / 61.0, octaves=6).tobytes())

    dem = tn.fbm(n, xx / 40.0, yy / 40.0, octaves=6) * 200.0
    dem[60:68, 60:68] = 50.0  # deliberate flat plateau exercises resolve_flats' BFS
    eroded = ero.stream_power_erode(
        dem, cellsize=8.0, iterations=6, dt=1.4, k_erode=0.02,
        m_exp=0.5, talus_deg=33.0, thermal_rate=0.35,
    )
    h.update(eroded.tobytes())
    return h.hexdigest()


def _double_run_check() -> bool:
    a = _run_kernels_hash()
    b = _run_kernels_hash()
    print(f"[selftest] double-run: {a} vs {b} -> {'OK' if a == b else 'MISMATCH'}")
    return a == b


def _thread_count_check() -> bool:
    hashes = {}
    for threads in (1, 2, 4, 8):
        env = dict(os.environ, NUMBA_NUM_THREADS=str(threads))
        out = subprocess.run(
            [sys.executable, "-c",
             "from terragen._selftest_numba import _run_kernels_hash; "
             "print(_run_kernels_hash())"],
            cwd=REPO_TOOLS_MAPGEN, env=env, capture_output=True, text=True, check=True,
        )
        digest = out.stdout.strip()
        hashes[threads] = digest
        print(f"[selftest] NUMBA_NUM_THREADS={threads}: {digest}")
    ok = len(set(hashes.values())) == 1
    print(f"[selftest] thread-count independence: {'OK' if ok else 'MISMATCH'}")
    return ok


def main() -> int:
    sys.path.insert(0, REPO_TOOLS_MAPGEN)
    ok = _double_run_check() & _thread_count_check()
    if not ok:
        print("[selftest] FAILED", file=sys.stderr)
        return 1
    print("[selftest] all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
