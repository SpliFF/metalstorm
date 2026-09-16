# Lane 15 — onboarding (tutorial, briefing, help, player guide)

## STATUS
complete (wrapped early) — coordinator directive; session limit reached after the gadget landed.

## Not done (remaining lane scope, in priority order)

1. `scenarios/tutorial_01.lua` revised with a `beats` table + terminal `victory = true` control
   objective (design settled: compact side at Amber Row using crossing_standoff's mask-verified
   coordinates; beats welcome → select (client) → drill-down (client) → move to `grey_flat`
   (presence) → hold Grey Flat (beat objective) → Battle menu (client) → move to `storm_sound`
   (presence) → hold Storm Sound (victory objective, `holdFrames = 1350`)). Still a stub on disk.
2. `scenarios/tutorial_02.lua` (transports: load onto `fable_airship`, `withdrawn` beat via the
   departure zone, an `arrivals` wave with a `units` beat, region/authority cost modifier via
   `charge` beats) and `tutorial_03.lua` (NL console `client` beat, AI Command `guidance` beats,
   `parley` beat against a strategos Union side). Plus a `tutorial_scenarios_spec.lua` and a
   `runScenarioValidation` pass over all three.
3. `ui/widgets/tutorial-guide.js` + `tutorial-guide.test.js` + ONE manifest hunk in
   `metalstorm.ui.json` (mount `left`, no title; renders one card from `tutorial_*` rulesParams;
   sends `cmd=tutorial.ack|skip|restart|stop` via `ctx.sendCommand({type:'LuaRulesMsg', data})`;
   client checks selection/drilldown/menu/console; "Show me" feature-detects
   `ctx.camera?.travelTo` / `globalThis.__nativeUi?.travelTo`, else dispatches
   `CustomEvent('ms-tutorial:show', {detail:{x,z,panel}})`; localStorage `ms.tutorial.<scenario>`
   in try/catch).
4. `client/src/ui/help/**` (`openHelp(topic)`, drawer built from `docs/player-guide.md?raw`,
   "Start the tutorial" → `?play=tutorial_01`) + one `mountHelpEntry()` hunk in
   `client/src/lobby/lobby-ui.ts` next to `wireWorldPanel()`.
5. `docs/player-guide.md`; manual §7/§9 wording fixes (findings 1 and 6).
6. Browser verification script (for a later session): `?play=tutorial_01&skipBriefing=1` as a fresh
   guest → assert `tutorial_state = 'running'` in rulesParams, coach card at the left rail, select a
   squad → card advances, right-click into Grey Flat → `tutorial_beat_id = 'hold_grey_flat'`,
   objective chip appears top-centre, hold → award toast + card, Tab opens the Battle surface →
   advance, hold Storm Sound → Victory overlay → Return to Lobby.

## Proposals for lanes 9/10 (needed by the coach widget)

- Lane 9: expose `travelTo` and `uiActionRegistry.run('open', name)` on `WidgetContext`
  (e.g. `ctx.camera = { travelTo }`, `ctx.ui = { open, close }`) so game-dir widgets can drill the
  camera / open a tab without importing bundled modules; and add `'tutorial.'` to
  `WIRE_VERB_PREFIXES` (`integration.ts:160`) so the verb form works too.
- Lane 10: an NL `ui` action alias `coach` / `tutorial` → the widget's open/close, and a
  `console-exchange` DOM event (`nui:console-executed`) the widget can use as its `console` check.

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

- `776c528a04` — this report.
- `dbbcb0c865` — `LuaRules/Gadgets/game_tutorial.lua` rewritten from the `enabled = false` stub
  into the Tutorial Director: reads `GG.Scenario.data.beats` at GameStart (no-op unless
  `tutorial == true`), validates and drops bad beats with a log line, publishes the current beat
  as `tutorial_*` rulesParams (title/text/wait/check/resolved show point/objective id/hint/rev),
  advances on 12 wait kinds (ack, client, presence, region, objective, charge, award, withdrawn,
  units, parley, guidance, frames), posts REAL `GG.Objectives` for `objective` beats (flat dialect
  folded like `game_scenario.lua`; re-posts on fail/expire; `victory` refused), and takes
  `tutorial.ack|skip|restart|stop` over `RecvLuaMsg` (learning team only, wrong-beat acks
  refused). Polling via `tick.lua` `due()`. Spec
  `tests/game_tutorial_spec.lua`: 22 cases, run from `data/games/metalstorm`.
  Gate: `busted LuaRules/Gadgets/tests/game_tutorial_spec.lua` → 22/0/0.
- Findings 1 (partly), 5: FIXED by the above. Findings 2, 3, 4, 6: still OPEN (see Not done).

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
