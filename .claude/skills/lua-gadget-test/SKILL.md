---
name: lua-gadget-test
description: Run and write the headless busted suites for Metalstorm's Lua gadgets and AI modules. Use when changing anything under LuaRules/Gadgets or ai/, or when a busted run is red and you need to know whether that is your change or the cwd.
when_to_use: Use for headless Lua testing with busted — which suite to run, from which directory, and what green looks like. NOT for testing against a running game (that is spring-test), and NOT for the TypeScript client suites (that is client-gate).
user-invocable: false
---

# Lua gadget + AI suites (busted, headless)

These suites run with **no engine, no lobby, no server** — pure Lua against
fakes. They are the fast gate for gadget work and they should be the thing you
run after every edit.

**The one rule that explains every confusing result: the suite you can run is
decided by the directory you run it from.** Specs resolve their
`dofile`/`require` targets relative to the cwd, and the tree has two mutually
exclusive conventions in it. Running everything from one place is always red,
and it is red by construction, not because anything is broken.

## The partition (baselines verified 2026-09-17)

Run each of these from the directory named. `<game>` is
`data/games/metalstorm`.

| cwd | Command | Green |
|-----|---------|-------|
| `<game>/LuaRules/Gadgets/authority` | `busted .` | 91 / 0 / 0 |
| `<game>/LuaRules/Gadgets/objectives` | `busted tests/` | 198 / 0 / 0 |
| `<game>/LuaRules/Gadgets/regions` | `busted tests/` | 70 / 0 / 0 |
| `<game>/LuaRules/Gadgets/civilians` | `busted tests/` | 72 / 0 / 0 |
| `<game>/LuaRules/Gadgets/parley` | `busted tests/` | 17 / 0 / 0 |
| `<game>/ai/strategos` | `busted tests/` | 182 / 0 / 0 |
| `<game>/LuaRules/Gadgets` | `busted --exclude-pattern=scenario tests/` | 568 / 0 / **33 errors** |
| `<game>` | `busted LuaRules/Gadgets/tests/game_landmarks_spec.lua LuaRules/Gadgets/tests/game_tutorial_spec.lua` | 33 / 0 / 0 |
| `<game>` | `busted --pattern=scenario LuaRules/Gadgets/tests/` | 112 / **3 failures / 1 error** |

Two rows need explaining, and both are expected:

**The 33 errors from `Gadgets/`** are exactly `game_landmarks_spec` and
`game_tutorial_spec` — two specs that read game files by path and therefore
need the **game root** as cwd. Run them from `<game>` (the row below) and they
are 33/33. Together the non-scenario partition is **601 assertions, zero
failures**.

**The 3 failures + 1 error in the scenario partition** are the retired
`meridian_basin` scenario naming unit defs that no longer exist
(`ms_grain_silo`, `ms_tank_farm`, `ms_timber_yard`, …) in
`game_scenario_ai_spec.lua` at :296, :330, :359, :375. This is a **standing
red owned by the scenarios lane**, not your change. Confirm it is still only
those four before assuming anything.

## Before you conclude a run is red

```bash
export PATH="/opt/homebrew/bin:$PATH"   # a stripped PATH means no busted at all
cd data/games/metalstorm/LuaRules/Gadgets
busted --exclude-pattern=scenario tests/ 2>&1 | grep -E 'successes|Error ->|Failure ->'
```

Ask, in order:

1. **Am I in the right directory?** Compare against the table. A wholesale
   error count (dozens of `Error ->` lines, near-zero successes) is the cwd,
   not the code. From `<game>` the whole-tree run is 40 successes / 136 errors
   — that number is the signature of running it from the wrong place.
2. **Are the failures the known standing reds?** The four `meridian_basin`
   cases above are the only ones as of 2026-09-17.
3. **Is the error `cannot open file`?** That is a path resolution failure —
   step 1 again — not a logic failure.

## Writing a spec

Follow the conventions already in the directory you are adding to; they differ
between subtrees on purpose and the local ones win. Two that hold everywhere:

- **Specs read real game files.** `game_tutorial_spec` and `game_landmarks_spec`
  assert against gadget source on disk, which is why they need the game root.
  A spec that greps source is a legitimate and used pattern here — it is how
  architectural rules get enforced rather than merely documented.
- **The frame-gate rule has a test.** `game_tutorial_spec` asserts that
  `game_tutorial.lua` never gates on `frame % PERIOD`. See below.

## The `frame % PERIOD` rule

`LuaRules/Gadgets/tick.lua` exists because `if frame % PERIOD == 0 then` is
**silently unsound on this engine**: when the server logs
`sim fell behind, skipped N ticks`, `gadget:GameFrame` is never called for the
skipped frames — they do not arrive late, they do not arrive at all — so a
modulo gate that steps over a multiple drops that tick permanently. Measured:
at 8x sim speed a control objective accumulated **zero** hold progress over
40 000 frames.

The rule is **accrue against `frame - last >= period`, never `frame % period`**,
and `tick.lua` provides two policies (`due()` collapses to at most one fire per
call, for anything that OBSERVES current state; the other replays each elapsed
period, for anything that ACCRUES). Read its header before using either.

As of 2026-09-17 the census is clean — the only `frame % PERIOD == 0` left in
`LuaRules/` is the example inside `tick.lua`'s own header comment. Keep it that
way:

```bash
grep -rnE 'frame % [A-Z_]+ *== *0' data/games/metalstorm/LuaRules/ --include=*.lua | grep -v tests/
```

## What this skill does NOT cover

- **Testing against a running game** — spawning units, giving orders, watching
  combat: the **spring-test** skill. These suites never boot an engine.
- **The TypeScript client and tooling suites** — the **client-gate** skill.
- **Scenario authoring and validation** — `validate_scenario` / `write_scenario`
  in **spring-debug**; a scenario's *content* is checked there, not here.
- **Whether a gadget is loaded in a live game** — `list_gadgets`, spring-debug.
