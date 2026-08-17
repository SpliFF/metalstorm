#!/usr/bin/env python3
"""Rewrite tests/fixtures/generated_scenario.lua from the synthetic map.

That fixture is generator output held byte-for-byte, and it is what
tests/test_scenario_discovery.cpp feeds to the lobby's real Lua parser. Run this
after any deliberate change to the emitted format, then re-read the C++ test to
confirm what it asserts is still true:

    python3 tools/mapgen/tests/regen_fixture.py
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import scenariogen as sg              # noqa: E402
from test_scenariogen import wide_flat_map  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(REPO, "tests", "fixtures", "generated_scenario.lua")

with tempfile.TemporaryDirectory() as t:
    lua, meta = sg.generate(wide_flat_map(t, "synth_wide"), seed=11,
                            game_dir=os.path.join(REPO, "data", "games", "metalstorm"))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write(lua)
print(f"wrote {OUT}  ({meta['id']}, {meta['buildings']} buildings)")
