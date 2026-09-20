#!/usr/bin/env python3
"""validate.py — the audio gate (PLAN-beta-presentation.md L-AUDIO):

  1. manifest.json is well-formed and internally consistent (unique keys,
     unique outputs, every category known, every synthesis entry names a
     real recipes.py function).
  2. every synthesis-entry output file (and its derived _far sibling)
     exists on disk.
  3. every entry (and _far derivative) has a matching ASSETS.md row.
  4. gamedata/sounds.lua parses under a real Lua interpreter ("loads").
  5. every weapon-fx.json fireSound/impactSound name resolves to a
     sounds.lua SoundItems key.

Exit 0 / prints "OK" on success; exit 1 and prints every violation
otherwise. No test framework dependency (pytest is broken in this
environment — see README.md) — run directly with `python3 validate.py`.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import recipes  # noqa: E402
from build import GAME_ROOT, MANIFEST_PATH, expand_entries, load_manifest  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_MD = GAME_ROOT / "ASSETS.md"
WEAPON_FX = GAME_ROOT / "effects" / "weapon-fx.json"
SOUNDS_LUA = GAME_ROOT / "gamedata" / "sounds.lua"


def check_manifest(manifest: dict) -> list[str]:
    errors = []
    keys = set()
    outputs = set()
    for e in manifest["entries"]:
        if e["key"] in keys:
            errors.append(f"duplicate manifest key: {e['key']}")
        keys.add(e["key"])
        if e["output"] in outputs:
            errors.append(f"duplicate manifest output: {e['output']}")
        outputs.add(e["output"])
        if e["source"] == "synthesis" and not hasattr(recipes, e["recipe"]):
            errors.append(f"{e['key']}: recipes.{e['recipe']} does not exist")
        if "category" not in e or not e["category"]:
            errors.append(f"{e['key']}: missing category")
    for r in manifest.get("reserved_sonniss", []):
        if "pack" not in r or "use" not in r:
            errors.append(f"reserved_sonniss entry missing pack/use: {r}")
    return errors


def check_files_exist(entries: list[dict]) -> list[str]:
    errors = []
    for e in entries:
        if e["source"] != "synthesis":
            continue
        p = GAME_ROOT / e["output"]
        if not p.exists():
            errors.append(f"{e['key']}: expected output missing: {p}")
    return errors


def check_assets_md_rows(entries: list[dict]) -> list[str]:
    errors = []
    text = ASSETS_MD.read_text()
    for e in entries:
        if e["source"] != "synthesis":
            continue
        if e["output"] not in text:
            errors.append(f"{e['key']}: no ASSETS.md row for {e['output']}")
    return errors


def check_sounds_lua_loads() -> tuple[list[str], set[str]]:
    errors = []
    keys: set[str] = set()
    lua_script = (
        f"local t = dofile('{SOUNDS_LUA}')\n"
        "if type(t) ~= 'table' or type(t.SoundItems) ~= 'table' then "
        "error('sounds.lua did not return {SoundItems=...}') end\n"
        "for k, v in pairs(t.SoundItems) do print(k) end\n"
    )
    try:
        proc = subprocess.run(["lua", "-e", lua_script], capture_output=True, text=True, check=True)
    except FileNotFoundError:
        errors.append("`lua` interpreter not found on PATH — cannot verify sounds.lua loads")
        return errors, keys
    except subprocess.CalledProcessError as exc:
        errors.append(f"sounds.lua failed to load: {exc.stderr.strip()}")
        return errors, keys
    keys = {line.strip() for line in proc.stdout.splitlines() if line.strip()}
    if not keys:
        errors.append("sounds.lua loaded but SoundItems is empty")
    return errors, keys


def check_weapon_fx_resolves(sound_keys: set[str]) -> list[str]:
    errors = []
    if not sound_keys:
        return ["skipped weapon-fx resolution check (sounds.lua didn't load)"]
    data = json.loads(WEAPON_FX.read_text())
    fire_sounds: set[str] = set()
    impact_sounds: set[str] = set()

    def walk(o):
        if isinstance(o, dict):
            if o.get("fireSound"):
                fire_sounds.add(o["fireSound"])
            if o.get("impactSound"):
                impact_sounds.add(o["impactSound"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    for name in sorted(fire_sounds):
        if name not in sound_keys:
            errors.append(f"weapon-fx.json fireSound '{name}' has no sounds.lua SoundItem")
    for name in sorted(impact_sounds):
        if name not in sound_keys:
            errors.append(f"weapon-fx.json impactSound '{name}' has no sounds.lua SoundItem")
    return errors


def main() -> int:
    manifest = load_manifest()
    entries = expand_entries(manifest)

    all_errors: list[str] = []
    all_errors += check_manifest(manifest)
    all_errors += check_files_exist(entries)
    all_errors += check_assets_md_rows(entries)

    lua_errors, sound_keys = check_sounds_lua_loads()
    all_errors += lua_errors
    all_errors += check_weapon_fx_resolves(sound_keys)

    if all_errors:
        print(f"FAIL — {len(all_errors)} violation(s):")
        for e in all_errors:
            print(f"  - {e}")
        return 1

    print(f"OK — {len(entries)} manifest entries, {len(sound_keys)} SoundItems, "
          "weapon-fx.json fireSound/impactSound all resolve, sounds.lua loads.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
