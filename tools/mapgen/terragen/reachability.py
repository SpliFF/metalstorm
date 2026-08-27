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
#
# Since M9o's find (PLAN-maps lane queue item 2, 2026-08-27) the scope is also
# WRITTEN INTO THE DECLARATION (`reachability_classes`), so a reader of the
# map's own mapinfo.lua no longer has to know this module's default to know
# which classes the claim speaks for. meridian_basin is the case that forced
# it: the map declares "split" and INFANTRY measures connected — which is not
# staleness, it is the documented per-class divergence (§2k; infantry
# outclimbs armour), but a declaration that does not name its scope cannot say
# so. A mapinfo with no `reachability_classes` key (every package emitted
# before this) still reads as GATE_CLASSES.
GATE_CLASSES = ("VEH",)


def emit_mapinfo_block(intent: str, indent: str = "    ",
                       classes=GATE_CLASSES) -> str:
    """The `metalstorm` block for a generated `mapinfo.lua`."""
    check(intent)
    if not classes:
        raise ValueError("reachability declaration needs at least one "
                         "movement class in scope")
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
        f"{i}-- reachability_classes: the movement classes the claim above\n"
        f"{i}--                  speaks for. A class outside the scope may\n"
        f"{i}--                  legally read differently (infantry outclimbs\n"
        f"{i}--                  armour — meridian_basin is split for VEH and\n"
        f"{i}--                  connected for INFANTRY, on purpose).\n"
        f"{i}metalstorm = {{\n"
        f"{i}    reachability = \"{intent}\",\n"
        f"{i}    reachability_classes = \"{' '.join(classes)}\",\n"
        f"{i}}},\n"
    )


# Read with a regex rather than a Lua interpreter for the same reason
# `regions_from_map.read_mapinfo` and `verify_scenario_maps.scenario_facts` do:
# these run on a bare checkout with no Lua, against a single scalar written by
# the emitter above. Anchored on the `metalstorm` block so a `reachability`
# key that turns up anywhere else in the file cannot answer for it.
_BLOCK = re.compile(r"\bmetalstorm\s*=\s*\{(.*?)\}", re.DOTALL)
_KEY = re.compile(r"\breachability\s*=\s*[\"']([a-z]+)[\"']")
_CLASSES_KEY = re.compile(r"\breachability_classes\s*=\s*[\"']([A-Za-z_, ]+)[\"']")

# The movement-class vocabulary the scope key may use. This module is
# stdlib-only on purpose, so it cannot import `terragen.passability`;
# tests/test_reachability_intent.py pins this tuple against
# `passability.DEFAULT_CLASSES` so the two cannot drift.
KNOWN_CLASSES = ("INFANTRY", "VEH", "HEAVY")


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


def parse_mapinfo_classes(text: str) -> tuple[str, ...]:
    """The movement classes the map's reachability claim speaks for.

    A `mapinfo.lua` with no `reachability_classes` key — every package emitted
    before the key existed — reads as `GATE_CLASSES`, which is the scope those
    packages were in fact judged on. An unknown class name is an error for
    `parse_mapinfo`'s reason: a typo'd scope silently widening to the default
    would re-judge the map on classes it never claimed.
    """
    block = _BLOCK.search(_strip_comments(text))
    if not block:
        return GATE_CLASSES
    key = _CLASSES_KEY.search(block.group(1))
    if not key:
        return GATE_CLASSES
    classes = tuple(c for c in re.split(r"[\s,]+", key.group(1)) if c)
    if not classes:
        raise ValueError("reachability_classes is declared but names no "
                         "movement class")
    for c in classes:
        if c not in KNOWN_CLASSES:
            raise ValueError(
                f"unknown movement class {c!r} in reachability_classes — "
                f"expected one of {', '.join(KNOWN_CLASSES)}")
    return classes


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


def measured(groups, stranded) -> str:
    """A plain statement of one class's connectivity reading, with no verdict
    attached — what `report()` prints for classes outside the declared scope."""
    n = len(stranded) + sum(len(v) for v in groups.values())
    if stranded:
        return f"{n} start(s), on impassable ground: {sorted(stranded)}"
    if len(groups) <= 1:
        return f"all {n} start(s) in one component"
    parts = "; ".join(f"component {c}: starts {sorted(v)}"
                      for c, v in sorted(groups.items()))
    return f"{n} starts in {len(groups)} components — {parts}"


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
        gate = r.cls in gate_classes
        if gate:
            passed, msg = verdict(intent, r.groups, r.stranded)
            ok = ok and passed
            tag = "AGREES" if passed else "DISAGREES"
            log(f"  reachability [{intent}] {r.cls} (gate): {tag} — {msg}")
        else:
            # A class outside the declared scope is MEASURED, never judged:
            # the old wording here ran it through verdict() and printed
            # "the declaration is stale" for meridian's INFANTRY, which is
            # the per-class divergence the scope key exists to legitimise
            # (M9o's find, lane queue item 2).
            log(f"  reachability [{intent}] {r.cls} (outside declared scope "
                f"{'/'.join(gate_classes)}): "
                f"{measured(r.groups, r.stranded)}")
    if not ok:
        log(f"  \u26a0 this map declares reachability = \"{intent}\" and its terrain "
            f"does not match for {'/'.join(gate_classes)} — "
            f"`regions_from_map.py --verify` will fail it")
    return ok
