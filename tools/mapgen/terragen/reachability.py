"""Per-map reachability INTENT — is this map's armour split on purpose?

PLAN-maps.md §2k (user ruling 2026-08-16, restated 2026-08-18): a map whose
start positions lie in several disconnected components of the passability mask
is **legal player content**. Archipelagos are the obvious case; a basin walled
by a scarp is the same fact with different geology. So the reading
`regions_from_map.py --verify` takes stopped being a verdict on its own: the
measurement says "split", and only the map can say whether that was the plan.

This module is that declaration, and it is deliberately one file for all three
jobs — the vocabulary, the emitter, and the parser — because the failure mode
here is a key one side writes and the other never reads (PLAN-maps M8l shipped
exactly that with terragen's road speed multiplier). `test_reachability_intent
.py` round-trips emitter → parser so the pair cannot drift.

WHERE THE DECLARATION LIVES: the map package's own `mapinfo.lua`, under a
`metalstorm` block that the engine's `CMapInfo` never looks at. Not a CLI flag
on the verifier, and not a registry beside it:

  * A flag on `--verify` is per-INVOCATION, so the sweep over every map
    (`verify_scenario_maps.py`) would have to blanket-allow splits — which is
    the same as deleting the check.
  * The declaration has to travel with the map, because the verifier is handed
    a map directory and nothing else.
  * It must be written by the tracked GENERATOR, never hand-edited into a map
    dir: `data/maps/` is gitignored (`.gitignore:75`), so a hand edit there is
    invisible to everyone else — M9i lost an item to exactly that (a texture
    re-authoring nobody but that checkout would ever get). `content/maps/`
    tracks the three shipped packages' `mapinfo.lua`, so a generator-emitted
    declaration is in git for the maps that ship.

WHAT IT DOES NOT COVER: a start position on ground nothing can stand on
(`component -1`). That is refused under both intents — it is not a map shape,
it is a placement on unusable ground, and no transport fixes it. Same split as
`scenariogen.gate_reachability`, which refuses `component -1` in both modes and
only relaxes MUTUAL reachability.
"""

from __future__ import annotations

import re

# The two things a map may say about itself. `connected` is the default for a
# map that says nothing, so a generator that strands its starts by accident
# still fails the gate — silence is not consent.
CONNECTED = "connected"
SPLIT = "split"
INTENTS = (CONNECTED, SPLIT)
DEFAULT_INTENT = CONNECTED

# The movement class(es) the gate judges, mirroring
# `regions_from_map.DEFAULT_CLASS`. Only these decide a generator's
# declared-vs-measured verdict, because a whole-map declaration cannot be true
# of every class at once — see `report()`. Pinned against the verifier in
# tests/test_reachability_intent.py so the two cannot drift.
GATE_CLASSES = ("VEH",)


def emit_mapinfo_block(intent: str, indent: str = "    ") -> str:
    """The `metalstorm` block for a generated `mapinfo.lua`."""
    check(intent)
    i = indent
    return (
        f"{i}-- Metalstorm extension block. `CMapInfo` never reads this; it is\n"
        f"{i}-- the map's own statement about itself, for tools.\n"
        f"{i}-- reachability: does armour reach every start from every other?\n"
        f"{i}--   \"connected\" — yes, and `regions_from_map.py --verify` fails\n"
        f"{i}--                  this map if it ever stops being true.\n"
        f"{i}--   \"split\"     — no, ON PURPOSE (PLAN-maps.md §2k): the starts\n"
        f"{i}--                  sit in several armour realms and the crossing\n"
        f"{i}--                  is a transport problem, not a defect. `--verify`\n"
        f"{i}--                  then fails this map if it comes out CONNECTED,\n"
        f"{i}--                  because the declaration would be stale.\n"
        f"{i}metalstorm = {{\n"
        f"{i}    reachability = \"{intent}\",\n"
        f"{i}}},\n"
    )


# Read with a regex rather than a Lua interpreter for the same reason
# `regions_from_map.read_mapinfo` and `verify_scenario_maps.scenario_facts` do:
# these run on a bare checkout with no Lua, against a single scalar written by
# the emitter above. Anchored on the `metalstorm` block so a `reachability`
# key that turns up anywhere else in the file cannot answer for it.
_BLOCK = re.compile(r"\bmetalstorm\s*=\s*\{(.*?)\}", re.DOTALL)
_KEY = re.compile(r"\breachability\s*=\s*[\"']([a-z]+)[\"']")


def parse_mapinfo(text: str) -> str:
    """The intent a `mapinfo.lua` declares, or `DEFAULT_INTENT` if it is silent.

    An unrecognised value is an error, not a fallback: a typo'd
    `reachability = "spilt"` reading as "connected" would fail the map for the
    thing it just declared, and the message would be about terrain.
    """
    block = _BLOCK.search(_strip_comments(text))
    if not block:
        return DEFAULT_INTENT
    key = _KEY.search(block.group(1))
    if not key:
        return DEFAULT_INTENT
    return check(key.group(1))


def _strip_comments(text: str) -> str:
    """Drop `--` line comments — the emitted block documents the vocabulary in
    prose, and the word `reachability = "connected"` appears there twice."""
    return re.sub(r"--[^\n]*", "", text)


def check(intent: str) -> str:
    if intent not in INTENTS:
        raise ValueError(
            f"unknown reachability intent {intent!r} — expected one of "
            f"{', '.join(INTENTS)}")
    return intent


def verdict(intent: str, groups, stranded) -> tuple[bool, str]:
    """(passed, message) for one movement class's connectivity reading.

    `groups` maps component label -> the start indices in it; `stranded` lists
    the starts with no passable ground near them at all. Both intents refuse
    `stranded`. Otherwise the intent decides, in BOTH directions — a map that
    declares a split it does not have is as wrong as one that has a split it
    did not declare, and the stale declaration is the more dangerous of the two
    because it silences the gate.
    """
    check(intent)
    n_starts = len(stranded) + sum(len(v) for v in groups.values())
    if stranded:
        return False, f"start positions on impassable ground: {sorted(stranded)}"
    if n_starts < 2:
        if intent == SPLIT:
            return False, (
                f"declares reachability = \"split\" but has {n_starts} start "
                f"position(s) — nothing to be split from")
        return True, f"{n_starts} start position(s) — nothing to connect"
    parts = "; ".join(f"component {c}: starts {sorted(v)}"
                      for c, v in sorted(groups.items()))
    if len(groups) <= 1:
        if intent == SPLIT:
            return False, (
                f"declares reachability = \"split\" but all {n_starts} start "
                f"positions are in ONE component — the declaration is stale "
                f"(remove it, or the gate it disables is off for nothing)")
        return True, f"all {n_starts} start positions in one component"
    if intent == SPLIT:
        return True, (f"declared split: {len(groups)} disconnected components, "
                      f"as intended — {parts}")
    return False, (f"start positions split across {len(groups)} disconnected "
                   f"components — {parts}")


def report(readings, intent: str, gate_classes=GATE_CLASSES, log=print) -> bool:
    """Print the declared-vs-measured verdict for a generator run.

    `readings` is what `passability.read_all` returns — one reading per
    movement class, each with `.cls`, `.groups` and `.stranded`.

    ⚠ **The declaration is per MAP; reachability is per CLASS.** Meridian Basin
    is the case that makes this explicit: its severing scarp is 44-75 degrees of
    side-hill, which is inside INFANTRY's 45-degree `maxslope` and outside
    VEH's 32 and HEAVY's 24 — so the same map is CONNECTED for infantry and
    SPLIT for armour, and a `split` declaration cannot be true of every class at
    once. That is not a defect, it is the reason `regions_from_map.py` grades on
    VEH by default: "infantry can cross terrain no vehicle can, so grading on
    infantry would reproduce exactly the Meridian failure". So only
    `gate_classes` — the classes the gate actually judges — decide the return
    value; the others are printed as information.

    This is a REPORT, not a gate: a generator that refused to write a package
    whose terrain disagreed with its declaration would be unusable for exactly
    the tuning runs that discover the map's shape. The gate is
    `regions_from_map.py --verify`, on the packaged bytes, which is the reading
    a war and the AI actually inherit.
    """
    ok = True
    for r in readings:
        passed, msg = verdict(intent, r.groups, r.stranded)
        gate = r.cls in gate_classes
        if gate:
            ok = ok and passed
            tag = "AGREES" if passed else "DISAGREES"
            log(f"  reachability [{intent}] {r.cls} (gate): {tag} — {msg}")
        else:
            tag = "agrees" if passed else "differs, not judged"
            log(f"  reachability [{intent}] {r.cls}: {tag} — {msg}")
    if not ok:
        log(f"  \u26a0 this map declares reachability = \"{intent}\" and its terrain "
            f"does not match for {'/'.join(gate_classes)} — "
            f"`regions_from_map.py --verify` will fail it")
    return ok
