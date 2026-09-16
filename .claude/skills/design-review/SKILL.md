---
name: design-review
description: Review a Metalstorm change against the game's standing design rules — squad-only command, no reclaim/heal/resurrect, declarative UI, no silent divergence from Recoil. Use when reviewing or writing gameplay, gadget or UI content and you need to know which rules are structural and how to check one mechanically.
when_to_use: Use when the question is "does this change violate a design rule this project has already decided?" — each rule below comes with the command that answers it. NOT a code-quality or correctness review (use /code-review), and NOT a way to decide a NEW design question (that is a human decision).
user-invocable: false
---

# Metalstorm design review

Metalstorm has design rules that are already decided and are enforced
structurally rather than by memory. This skill is the census: each rule, what
it forbids, and the **command that answers whether a change broke it**. Run the
commands — the whole point is that none of these are judgement calls.

The governing rule above all of them is `AGENTS.md`: **never deviate from
Recoil silently.** A divergence may be the right call, but it must be called
out in the response, in a code comment, and in the relevant plan. An
unannounced divergence is the defect, even when the behaviour is good.

## The rules, and how to check each one

### 1. No reclaim, repair, resurrect or capture

Metalstorm has no healing, no reclaim, no resurrect, and no reinforcement into
an existing squad. These are vetoed in one place, with the reasoning recorded
there: raising squad strength would force the client to re-add a dead member,
and doing that faithfully would require the sim to track per-member identities
and wreck locations.

```bash
sed -n '25,45p' data/games/metalstorm/LuaRules/Gadgets/squad.lua
```

A change that introduces any of these commands must go through that veto, not
around it.

### 2. Buildoptions live in four files only

```bash
grep -rl buildoptions data/games/metalstorm/units
```

Expected, and **exactly**, these four: `units/buildings_sites.lua`,
`units/engineers.lua`, `units/buildings_military.lua`,
`units/buildings_support.lua`. A fifth file with `buildoptions` means the build
tree has grown a second home and the menus will disagree with each other.

### 3. The AI never issues unit commands directly

`ai/strategos/actuators.lua` has no `moveSquad`, no `attackTarget`, no
`issueCommand` — the AI expresses intent and the sim decides. This is enforced
*structurally*: the module simply has no such function.

```bash
grep -nE 'moveSquad|attackTarget|issueCommand' data/games/metalstorm/ai/strategos/actuators.lua
```

The only hit should be the header comment that says the module has none. A real
definition is a violation.

### 4. No `frame % PERIOD` gating

```bash
grep -rnE 'frame % [A-Z_]+ *== *0' data/games/metalstorm/LuaRules/ --include=*.lua | grep -v tests/
```

The census is clean as of 2026-09-17 — the only hit is the example inside
`LuaRules/Gadgets/tick.lua`'s own header. The rule is **accrue against
`frame - last >= period`**, because skipped sim ticks never arrive and a modulo
gate drops them permanently. `game_tutorial_spec` asserts this for one gadget;
the grep is the general check. Full reasoning: the **lua-gadget-test** skill.

### 5. Unit creation is centralised

```bash
grep -rlE 'Spring\.CreateUnit' data/games/metalstorm/LuaRules/Gadgets/*.lua \
    data/games/metalstorm/LuaRules/Gadgets/*/*.lua
```

Expected creators: `game_authority`, `game_scenario`, `game_start`,
`game_transports`, `civilians/convoy`, `civilians/spawn` (plus
`tests/game_features_spec`). A new gadget calling `Spring.CreateUnit` should
almost always be routed through one of those instead.

### 6. The UI is declarative

Widgets are declared in `data/games/metalstorm/ui/metalstorm.ui.json` — 12 as
of 2026-09-17. The keys actually in use are:

`id`, `entry`, `mount`, `title`, `subscribes`, `nlAliases`, `builtin`,
`hideForSpectator`, `collapsed`, `_replaces`, `_chrome`, `_builtin_note`.

Two notes that catch people out:

- **`_chrome` is a prose string**, not an object — it is the design note
  explaining the widget's frame and drill-down behaviour, and nothing reads it
  at runtime. Do not try to put configuration in it.
- **`collapsed` IS declarative** (`scoreboard-panel`, `parley-panel` and
  `ai-command-panel` each declare `collapsed: true`). A widget that manages its
  own default-collapsed state in code is duplicating a manifest key.

A widget that mounts without a manifest entry, or a manifest entry with
`builtin: true` and no registry entry, silently does nothing — see the
**client-gate** and **game-browser-test** skills for how that shows up.

### 7. Standins are labelled

```bash
grep -rl FIDELITY-STANDIN rts/ | wc -l    # 12 as of 2026-09-17
```

A `FIDELITY-STANDIN` marker is a deliberate, labelled departure from Recoil
fidelity. Adding a standin is allowed; adding one **without the marker** is the
silent divergence the top-level rule forbids. When reviewing, check that any
new simplification in `rts/` carries one.

## How to use this in a review

1. Run the checks in the sections your change touches. They are cheap and they
   are the reason this skill exists.
2. For anything that fails, look for the divergence note — comment, response,
   plan entry. A rule broken *and* announced is a design conversation; a rule
   broken silently is a defect.
3. Read `ARCHITECTURE.md` (Directory Map, HTTP Routes, Data Flow) and
   `AGENTS.md` (Squad-Based Design, Resolved Design Decisions) when the change
   is in an area these seven rules do not cover. Those two files are the
   standing record; a PLAN file is a proposal, not a decision.

## What this skill does NOT cover

- **Correctness or code quality** — use `/code-review`. This skill only asks
  whether standing design rules were broken.
- **Deciding a new design question.** These rules were decided by a human. A
  genuinely new question is escalated, not resolved here.
- **Whether it looks right in the browser** — **game-browser-test**.
- **Whether the suites pass** — **lua-gadget-test**, **client-gate**.
