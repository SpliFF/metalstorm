# Lane 15 — onboarding (tutorial, briefing, help, player guide)

## STATUS
in-progress: gadget + spec next, then tutorial_01/02/03 scenarios, tutorial-guide widget, help drawer, player guide, manual wording.

Branch: `worktree-agent-a1df97d2bdf529f06` (cut from main `88d257bce2`, merged main tip at start).

## Findings (ranked)

1. **[HIGH] The tutorial does not exist.** `LuaRules/Gadgets/game_tutorial.lua` is a 36-line stub
   (`enabled = false`, `return false`) and `scenarios/tutorial_01.lua` stages **no units, no sides,
   no objectives** (`units = {}`, `objectives = {}`). Yet `docs/metalstorm-manual.md` §9 says
   "A tutorial (`tutorial_01`) runs on the same map with sequenced beats", PLAN-metalstorm-onboarding
   §7 task 3 is marked "LANDED", and `tools/debug-mcp/scenario-manifest.js:32` calls it a
   "legacy/sideless scenario" — booting `?play=tutorial_01` today seats the player on an EMPTY team
   0 with an AI on team 1 and nothing to do. Status: FIXED (this lane builds the arc).
2. **[HIGH] No lobby entry point to the tutorial.** `client/src/lobby/scenario-picker.ts:145-159`
   excludes tutorials from the war picker "because they have their own boot path", but no lobby
   surface offers that path — `grep -n tutorial client/src/lobby/lobby-ui.ts` is empty. The only
   way in is typing `?play=tutorial_01` by hand. Status: FIXED (help drawer's "Start the tutorial").
3. **[MED] No player-facing help anywhere in the lobby.** The manual is a developer document; the
   briefing splash is per-scenario prose. Status: FIXED (`client/src/ui/help/**`,
   `docs/player-guide.md`).
4. **[MED] Briefing `tips` in `tutorial_01.lua` contradicted the interaction model**: "Orders queue —
   shift-click to chain waypoints instead of micromanaging each leg" teaches micro on a game that
   taxes micro 2× (`authority_cost.lua`), and nothing mentioned authority, objectives or the
   drill-down HUD. Status: FIXED (rewritten tips).
5. **[LOW] `game_tutorial.lua`'s header pointed at `parentId` chaining** — a runtime-id field a
   scenario file cannot author (`docs/scenarios.md` §4.6); the authoring surface is `phases`, and the
   tutorial's sequencing is better served by a beats table (see Changes). Status: FIXED.
6. **[LOW] `docs/metalstorm-manual.md` §7 still says "six widgets ... right rail ... left rail"**;
   `metalstorm.ui.json`'s `_layout` says both rails are empty since U3/U4 and the panels live behind
   the one access point. Status: FIXED (player-facing wording only; lane 9 owns the manifest).

## Changes

(filled in per commit below)

## Proposed C++ patches (UNCOMPILED)

None.

## Out-of-lane findings

- `tools/debug-mcp/scenario-manifest.js:32` and `client/src/lobby/play-boot.ts` (`derivePlaySlots`):
  a scenario with ONE playable side yields `aiSlots = []` — correct for tutorial_01 — but a
  sideless one silently seats a `strategos` AI on an unstaged team 1. Suggest: warn when the
  legacy shape is used for a scenario that declares `tutorial = true`.

## Assumptions / decisions made without asking

- Beats live in the scenario file under a new top-level key `beats` (both parsers ignore unknown
  top-level keys — verified: `game_scenario.lua validate()` checks named keys only,
  `ScenarioDiscovery.cpp` reads fields by name). `tutorial` stays a boolean because the lobby reads
  it with `GetBoolField`.
- Client→gadget messages ride `ctx.sendCommand({ type: 'LuaRulesMsg', data })` (the typed form
  `integration.ts:344` already forwards raw strings), encoded with `parley/wire.lua`'s
  `cmd=…&k=v` shape, so no edit to lane 9's `WIRE_VERB_PREFIXES` is needed.

## Next milestones

(filled in at the end)
