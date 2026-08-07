#!/usr/bin/env python3
"""verify_scenario_maps.py — the gate PLAN-metalstorm-wars.md §7.6 asks for:
**every map an offerable war targets must pass `regions_from_map.py --verify`.**

WHY THIS EXISTS. §7.6 is a decision that cannot be enforced by reading a
scenario file, because the fact it depends on lives in a heightmap. A war
declares `world.map`; whether that map's start positions are in one connected
component of the passability mask is a measurement. Without a gate, the failure
mode is what endtoend D20 actually was: a war ships on a map whose two armies
cannot reach each other, the match ends uncontested at a deterministic frame,
and three fires' worth of diagnosis go into pacing, orders and the AI before
anybody floods the heightmap.

WHAT IS CHECKED, and what is deliberately not:

  * Offerable wars only — a scenario the lobby will default a room to or offer
    in the Create Game picker (ScenarioDiscovery::DefaultForMap /
    scenario-picker.ts `scenariosForMap`). Concretely: `tutorial = true` and
    `retired = true` are skipped, and so is a scenario with no `world.map`.

  * `tutorial` is exempt because a tutorial is a scripted single-player
    sequence with no opposing army to meet, and it boots through `?direct=`
    rather than through a map choice. `retired` is exempt because that flag
    means "not offered" — `meridian_basin.lua` is retired precisely BECAUSE it
    fails this gate, and the gate must not then fail on it.

  * A map named by a scenario but absent from `data/maps/` is a FAIL, not a
    skip: the war is offerable and cannot be staged.

Usage:
    python3 tools/mapgen/verify_scenario_maps.py [--game metalstorm] [--class VEH]

Exit codes: 0 = every offerable war's map crosses; 1 = at least one does not
(or is missing); 2 = nothing to check (no scenarios found — a wiring error,
because a repo with no wars is not a passing state).
"""

import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))


def scenario_facts(path):
    """The three fields this gate needs out of a scenario file.

    Read with regexes rather than a Lua interpreter on purpose: this runs in
    CI and on a bare checkout, where no Lua is guaranteed, and the fields are
    single scalars at file scope. A field we cannot parse degrades to the
    STRICTER reading (offerable, no map) so a malformed file fails the gate
    loudly instead of skipping it silently.
    """
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    # Strip comments so the header prose ("-- ... retired = true ...") cannot
    # be mistaken for a declaration. Long-bracket comments are not used in
    # these files; line comments are.
    body = re.sub(r"--[^\n]*", "", src)

    def boolean(field):
        m = re.search(r"\b%s\s*=\s*(true|false)\b" % field, body)
        return m is not None and m.group(1) == "true"

    m = re.search(r"\bmap\s*=\s*['\"]([^'\"]+)['\"]", body)
    return {
        "tutorial": boolean("tutorial"),
        "retired": boolean("retired"),
        "map": m.group(1) if m else "",
    }


def verify_map(map_dir, mclass):
    """Run regions_from_map.py --verify. Returns (ok, one-line detail).

    A ZERO exit is not on its own a pass, and this is the trap that cost this
    gate its first negative-arm check. `regions_from_map.py` reads start
    positions out of `data/spring-server.db`, and with no DB (a fresh checkout,
    or a repo root it resolved differently) it finds none, verifies nothing and
    exits 0 with `starts: 0` — the same "silently skipped the one check it
    exists to run" failure its own module docstring warns about, one level up.
    So a pass here requires a positive start count as well.
    """
    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, "regions_from_map.py"),
         map_dir, "--verify", "--class", mclass],
        capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
    detail = next((ln for ln in lines if "FAIL" in ln), lines[-1] if lines else "")

    m = re.search(r"\bstarts:\s*(\d+)", out)
    starts = int(m.group(1)) if m else 0
    if starts == 0:
        return False, ("no start positions were measured (is data/"
                       "spring-server.db present, and is this map in it?) — "
                       "--verify exits 0 on an unmeasured map")
    return proc.returncode == 0, detail


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", default="metalstorm")
    ap.add_argument("--class", dest="mclass", default="VEH",
                    help="movement class to grade on (default VEH, the "
                         "reference class regions_from_map.py uses — grading "
                         "on INFANTRY reproduces exactly the Meridian miss)")
    args = ap.parse_args(argv)

    scen_dir = os.path.join(REPO, "data", "games", args.game, "scenarios")
    if not os.path.isdir(scen_dir):
        print(f"no scenarios directory at {scen_dir}")
        return 2

    offerable, skipped = [], []
    for name in sorted(os.listdir(scen_dir)):
        if not name.endswith(".lua"):
            continue
        path = os.path.join(scen_dir, name)
        facts = scenario_facts(path)
        sid = name[:-len(".lua")]
        if facts["tutorial"]:
            skipped.append((sid, "tutorial — no opposing army to meet"))
        elif facts["retired"]:
            skipped.append((sid, "retired — not offered (§7.6)"))
        elif not facts["map"]:
            skipped.append((sid, "declares no world.map — never auto-applied"))
        else:
            offerable.append((sid, facts["map"]))

    if not offerable:
        print(f"{args.game}: no offerable wars found in {scen_dir}")
        for sid, why in skipped:
            print(f"  skipped {sid}: {why}")
        return 2

    # One --verify run per distinct map, reported per war.
    verdicts = {}
    failures = []
    for sid, map_id in offerable:
        if map_id not in verdicts:
            map_dir = os.path.join(REPO, "data", "maps", map_id)
            if not os.path.isdir(map_dir):
                verdicts[map_id] = (False, f"no such map under data/maps/{map_id}")
            else:
                verdicts[map_id] = verify_map(map_dir, args.mclass)
        ok, detail = verdicts[map_id]
        print(f"  {'PASS' if ok else 'FAIL'}  {sid} -> {map_id}: {detail}")
        if not ok:
            failures.append((sid, map_id, detail))

    for sid, why in skipped:
        print(f"  skip  {sid}: {why}")

    print(f"{args.game}: {len(offerable)} offerable war(s) over "
          f"{len(verdicts)} map(s), class {args.mclass}: "
          f"{len(failures)} failing")

    if failures:
        print("\nPLAN-metalstorm-wars.md §7.6: a war is authored on a map its "
              "armies can cross. Either fix the map, re-site the war, or mark "
              "the scenario `retired = true` (which removes it from the "
              "lobby's offer, not from the repo).")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
