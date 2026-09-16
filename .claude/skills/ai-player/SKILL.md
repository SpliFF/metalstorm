---
name: ai-player
description: Seat, steer and diagnose the Metalstorm AI players (strategos, garrison) and the natural-language command path. Use when an AI will not spawn, is not acting, ignores a guidance order, or when an utterance resolves to the wrong place.
when_to_use: Use when the subject is an AI seated in a game, the guidance verbs a human sends it, or how an NL utterance parses. NOT for authoring AI Lua modules or their busted suites (that is lua-gadget-test), and NOT for the world layer between battles (that is world-layer).
user-invocable: false
---

# AI players and the command language

Two plugins ship, discovered from `<game>/ai/<plugin>/ai.config.lua` — the
folder name is the plugin id:

| Plugin | id | What it is |
|--------|-----|-----------|
| Metalstorm Strategos | `strategos` | the full brain — one brain, three deployment roles (full side / co-commander / NPC), selected at instantiation by profile |
| Metalstorm Garrison | `garrison` | the small one |

Strategos profiles are `data/games/metalstorm/ai/strategos/profiles/`:
`default`, `aggressive`, `mentor`, `caretaker`, `npc_raider`.

**The diagnosis order, and it is almost always this order:**

```
ai_list        # is an AI actually seated on that team?
ai_health      # did its brain ever start? which rulesParams are MISSING?
ai_directives  # is it emitting engine directives?
ai_context     # what does it think the world looks like?
```

`ai_list` first, every time. An AI that failed to spawn shows up as **a team
with no AI rows**, not as an error anywhere — so "the AI is doing nothing" and
"there is no AI" look identical until you ask.

## Tools

All five take `roomId` (omit it to auto-pick the single live room) and an
optional `team` (omit for every team).

| Tool | What it does |
|------|-------------|
| `ai_list` | Who is playing and which of them are AIs: per team, the full player roster with AI virtual players flagged, each AI's profile and authority pool, active-human count, leader, team profile and pool, `allyTeam`/`side`/`dead`. |
| `ai_health` | Vitals per AI-seating team: which rulesParams the brain has written and **which are missing by name**, the guidance in force, directive and org-group counts. |
| `ai_directives` | Engine directives in flight (type, params, conditions) plus org groups with members and current directive. `includeGroups:false` to skip the groups. |
| `ai_guidance` | Send ONE guidance order as a player seated on the team. `op` (required), plus the fields that op needs. |
| `ai_context` | The NL context payload built from the SIM — places, org groups, enemies, objectives, class counts, authority. |

`ai_health` composes its answer: there is no single `ai_health` rulesParam in
the tree. It feature-detects these team params — `ai_profile`,
`team_active_humans`, `team_leader`, `authority_pool`, `ai_slate_kinds`,
`ai_slate_home`, `ai_slate_targets`, `ai_slate_route`, `ai_slate_reach` — and
per AI, `ai_profile_<pid>`, `authority_player_<pid>`,
`authority_player_<pid>_own_pool_only`. **A brain that never started leaves the
whole list missing, and that absence is the diagnosis.**

## Seating an AI

| Path | How |
|------|-----|
| Scenario launch | `launch_scenario {ai:'strategos'}` |
| Raw manifest | `launch_direct` with `aiSlots: [{aiId, team, startPos, profile}]` |
| Lobby room | `POST /api/rooms/ai/add {ai_id, name?, team?}`, then `POST /api/rooms/ai/profile {slot_index, profile}` |
| Headless batch | `aiSlots[]` in the fixture |
| Scenario file | `ai = {team, profile, slate, stipend}` |
| Caretaker | the `ai_caretaker` modoption → `Spring.SpawnAIPlayer` |

A scenario's `slate.kinds` must be a non-empty subset of
**`garrison`, `raid`, `toll`** — `validate_scenario` enforces it, and an empty
`kinds` table is an error rather than "no slate" (absent and present-but-empty
are different states and the validator makes you say which). `slate.home`,
`slate.targets` and `slate.route` are region KEYS; a key the map's graph does
not declare is a warning, not an error.

## Steering it

The seven guidance verbs are LuaRulesMsgs on the wire, normally sent by a
seated team member from the browser. `ai_guidance` encodes one exactly as the
browser would and delivers it through `gadgetHandler` as a player on the team
(a human is preferred; pass `playerId` to choose):

| `op` | Fields | Means |
|------|--------|-------|
| `stance` | `value`: defensive / balanced / aggressive | |
| `roe` | `value`: free / observed_only / deny_area | |
| `paint` | `regionKey` + `value`: priority / normal / forbidden | the region KEY, not its display name |
| `lock` | `groupId`, `value`: on / off | |
| `delegate` | `objectiveId`, `value`: on / off | |
| `fund` | `amount` and/or `rateCap` | one-shot gift from the SENDER's own pool; `rateCap` is a standing per-minute team allowance |
| `veto` | `goalId` such as `def:basin_a` or `obj:12` | holds 5 minutes |

**Read the `applied` field.** `applied:false` means the gadget *rejected* the
order — the change sequence did not move. That is frequently the answer you
were looking for, not a failure of the tool.

From outside the MCP, the same wire is reachable with
`node client/wire/run-wire-client.mjs --wire-command guidance.veto --wire-field goalId=…`
(the `make test-ai-veto-loop` arm drives it that way).

Read the effect back with `ai_directives`, or in Lua with
`Spring.GetDirectives(team)` and the `guidance_<t>_intent_count` /
`intent_<i>_goal_id` / `authority_player_<id>` rulesParams. Logs:
`get_logs {section:'ai'}`.

## Natural language

`nl_command` **parses and does not execute**. It returns the intent envelope a
client would then run — nothing in the sim changes. That is the whole design:
the envelope is the contract, and seeing it is how you find out whether an
utterance resolved to the place, group and verb you meant.

```
nl_command {utterance:'send the tanks to the north ridge', team:1}
```

With no `context`, one is built from the sim for `team` — the same payload
`ai_context` returns. **So a parse that picks the wrong region is usually a
context problem, not a model problem**: call `ai_context` on its own and look at
what the parser was actually told before blaming the parse. Pass `focus` to
reproduce what a specific player was looking at (a browser sends its camera and
selection focus; there is none without one), `history` for follow-ups like "now
send them north" (at most 4), and `revealContext:true` to see the payload that
went (it is large).

`nl_command` refuses with `nl-disabled` (503) when that game server has no API
key configured. That is configuration, not breakage.

**To actually run an utterance** there is `window.test.nl(utterance)` in a
connected browser — the command console's own path, same envelope and same
executor as typing the sentence — reachable through `client_eval` or
`browser_test`. The console widget registers it on init, so the hook exists only
while the console widget is mounted.

## Traps

- **`health` is a 0-1 RATIO, not hitpoints.** The runtime's `unit.health` and
  everything summed from it (the planner's `strength` is Σ of 0-1 ratios) is a
  fraction. Reading it as HP makes a healthy army look nearly dead.
- **A human on the AI's team flips it to `co_commander` with pool 0.** The AI
  then does nothing because it cannot pay for anything — `ai_guidance
  {op:'fund', amount:…}` it first. This is by far the most common "the AI is
  broken".
- **Launch with `--player` and wait for `firing GameStart`** before asserting
  anything about an AI; a brain that has not started has not written its params.
- **`stopAt.luaCondition` is polled once per game-second**, so a condition that
  is true for less than a second can be missed entirely.
- **The AI VM has no `require` / `VFS.Include`** and loads ONE entry buffer, so
  strategos's multi-file layout is not yet wired into the runtime (engine ask
  AI0-loader, recorded in its `ai.config.lua`). The pure modules are testable
  headless today; the runtime wiring is not there yet. If an AI seats but never
  acts, check this before debugging its logic.

## What this skill does NOT cover

- **Writing or testing the AI's Lua modules** — `ai/strategos/**` has its own
  busted suite; that is the **lua-gadget-test** skill.
- **The world layer** that decides which wars exist at all — **world-layer**.
- **Generic game driving** (launching, waiting, ending, logs) — **spring-debug**.
- **Client-side NL UI work** — the console widget is client code; see
  **client-gate** for how its suites are run.
