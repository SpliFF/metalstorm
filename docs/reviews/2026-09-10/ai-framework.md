# Review — lane 6 `ai-framework` (2026-09-10)

## STATUS
complete (wrapped early) — ai/lib (63 specs) + ai/garrison (smoke spec) landed; tools/ai-eval and docs/ai-players.md NOT built (see "Not done").

**CLOSED 2026-09-17.** The whole "Not done" queue below was finished in a
later session: `tools/ai-eval` (driver + pure scorer + 5 fixtures + committed
baseline, `make test-ai-eval`), `docs/ai-players.md` (from the census table
below, re-verified against `rts/Server/AI/` and carrying the 2026-09-16 engine
changes), and `garrison/tests/brain_spec.lua` (30 doctrine cases). The
ai-actuation planner asks were carried too (relative-strength
ceasefire/tribute with a real counter, `Planner.originateProposals`). Suites:
ai/lib 63 → 69, garrison 1 → 31, strategos 154 → 175, parley gadget 52 → 54.

What the harness found on its first run, and what remains:
* A dormant garrison took 310 frames to react to being overrun — LOD backoff
  plus no contact callin (F4). Fixed with `lib/scheduler`'s alert path and a
  cheap per-callin poll; both spec'd and now gated by the fixture.
* **Strategos never withdraws and ignores the objective board.** In
  `outmatched-withdrawal` it keeps assaulting enemy-held ground while six
  heavies stand on its own; in `objective-next-door` it pursues its own
  expansion goal and never reads the published objective. Both are lane-4
  (ai-core) work, deliberately NOT encoded as eval expectations — the
  baseline records the behaviour as it is, so that lane can improve it
  without fighting a gate that pins mediocrity in place.
* Every ai-eval fixture is synthetic. A recorded snapshot from a real
  `--headless-run` is the obvious next fixture and is not built.

## Not done
* `tools/ai-eval/**` (task 4) — not started. Design settled: node `run-eval.mjs` spawns `lua driver.lua --ai <dir> --fixture <json>` one process per (AI, fixture) so two `onUpdate` globals never share a state; driver installs `ai/lib/testing/fake_engine.lua`, applies a fixture timeline (units/enemies/rulesParam patches at frames, synthetic `contact` events), calls `onUpdate` every 10 frames, drains, and prints JSON (directives, authority spent via the drain's real charge, reaction latency = frames from event to first directive anchored in/next to the event region); node compares against `baseline.json` with tolerance, exit 2 on regression, `node --test` for the pure compare. Strategos runs unmodified through the same driver (its `main.lua` + `dofile` works against the fake engine exactly as `tests/tick_wiring_spec.lua` does), so the strategos-vs-garrison comparison needs no strategos edit.
* `docs/ai-players.md` (task 1) — not written. The census is complete and lives in this report (surface table below) — turn it into the doc: manifest (`ai.config.lua`: name/entry/description/version/author; folder name = id; `content/engine/ai/` then `<game>/ai/`, game shadows engine; `luaai.lua` registry entries have no runtime), seating (`--ai id:team[:pos[:profile]]` repeatable; headless manifest `aiSlots[]`; lobby `RoomAddAI` → `room_ai_slots` → `--ai`; `Spring.SpawnAIPlayer(team, id)` mid-game via `game_ai_caretaker.lua`; each AI = real `CPlayer` with `isAI`, its own `authority_player_<n>` pool minted by `PlayerAdded`), profile transport (`--ai` 4th field → modoption `ai_profile_player<n>` → `game_teams.lua` republishes team rulesParam `ai_profile_<n>`; scenario `ai` section publishes `ai_profile` + `ai_slate_*`), callins (ONLY `onUpdate(frame)` every 10 frames, synchronous on the sim thread; no onInit — boot on first update), reads/writes table, costs (F1), fog (LOS full detail / radar blip position-only / own team params only), forbidden (`AI.issueCommand`, any cross-team read), LOD etiquette (≤ 2 ms/tick, self-throttle), headless testing (`busted` + fake engine; `spring-server --headless-run` with `aiSlots`).
* Garrison: only a smoke spec; `brain_spec.lua` (pure doctrine cases: objectives, screen rate limit, hold re-state, profile overrides, neverWithdraw) not written.
* Roadmap (task 5) — compressed under "Next milestones".

## Engine surface census (the table for docs/ai-players.md)
| `AI.` verb | args → returns | notes |
|---|---|---|
| `getFrame()` | → frame | snapshot frame |
| `getMapSize()` | → w, h (elmos) | |
| `getTeamId()` / `getPlayerId()` | → int | playerId -1 = unattributed (tests) |
| `getRulesParam(scope,key)` | 'game'|'team', key → number|string|nil | team = OWN team only; bools arrive as 1/0 |
| `getMapData(name)` / `getDefExport(name)` | flat leaf name → decoded JSON table | nil when unconfigured/missing; error on `..`/separators/bad JSON; `regions.json`, `power.json` (`defs[id] = {name,dps,hp,class?,scale?}`) |
| `getOwnUnits()` | → [{id,defId,x,y,z,health(0-1 ratio),hasCommands}] | `isMoving`/`maxHealth` in snapshot, not exposed |
| `getVisibleEnemies()` | → [{id,defId,x,z,health}] | LOS only |
| `getRadarBlips()` | → [{id,x,z}] | radar, not LOS |
| `log(msg)` | → nil | NOTICE level, the AI's log section |
| `nowMs()` | → monotonic ms | self-timing |
| `createGroup(unitIds, echelon?)` | → NEGATIVE token handle | free; resolved in the same drain batch |
| `issueDirective(handle, spec)` | spec {type,priority,shape,params,requestedStrength(HITPOINTS),expiresInFrames,within{x,z,radius}} → true | charged via AllowDirectiveCreate (F1); E6 clamp 1/group-or-256-cell/batch; idleOnly=false |
| `setPosture(handle, json)` | → true | needs a real group; uncharged |
| `sendMessage(str)` | → bool | ≤2048 B, ≤16/batch, lands in `gadget:RecvLuaMsg(msg, playerID)` |
| `issueCommand(unitId, cmdId, ...)` | → nil | per-unit micro, FORBIDDEN by design law but registered (F2) |
| `require(name)` | plugin-folder-scoped module loader | no `..`, dotted → path; only base/table/string/math/utf8 libs |
Not present (gaps): `getAlliedUnits`, `getLODLevel`, event callins, composition counters, factory/idle state, departure zones (P7), team-private param privacy over the stream (I2).

Branch: `worktree-agent-a21205077b4e41e95` (cut from main `88d257bce2`, merged main tip at start).

## Findings (ranked)

### F1 — strategos' authority-cost mirror does not match what the sim charges (HIGH, PROPOSED)
`ai/strategos/config.lua:74-106` predicts a directive at `Σstrength × regionMod(0.5/1/2) × orderMod(0.5 platoon / 0.35 army)` and a posture at `× 0.25`. The sim (`LuaRules/Gadgets/game_authority.lua:668-710` `ChargeDirective`, reached from the AI drain through the same `AllowDirectiveCreate` a human hits) charges:
* area-scoped directive (`groupHandle 0` — the ONLY shape `actuators.lua` ever issues, `_issueTagged` passes 0): flat `base 1 × class 'standing' (1.2) × base_k × costScale` = **2** at scale 1, independent of force;
* group-scoped: `Σ authority_cost_base` over the LIVE roster × class `directive` (1.0);
* regionMod pinned to 1.0 for directives (called out in the gadget);
* `setPosture` / `createGroup` / `sendMessage`: **no charge callin at all** on the AI drain (`StateStreamer::ApplyAICommands`).
So the planner's governor prices a 14-unit package at 7 (neutral) / 14 (enemy) and is charged 2; DEFEND "postures" it prices at ~3.5 cost 2 as well (they are Defend directives). The README's "risk 4: mirror drift" is real. `ai/lib/authority.lua` mirrors the true formula (vendored byte-identical originals + drift spec). Refactor proposal for lane 4 (ai-core): replace `Config.predictDirectiveCost/predictPostureCost` bodies with `Authority.directiveCost{scope='area'}` semantics (flat 2×scale) until strategos issues group-scoped directives; keep the signatures.

### F2 — the per-unit micro verb `AI.issueCommand` is registered in EVERY AI VM (MEDIUM, PROPOSED C++)
`rts/Server/AI/AIScriptContext.cpp:325` registers `issueCommand` unconditionally; the drain applies it (`StateStreamer.cpp` `UnitCommand` case, ownership-checked only). The strategic floor ("no micro verbs — a design law") is therefore enforced only by discipline in game Lua (`actuators.lua` has no wrapper). A third-party plugin folder dropped into `ai/` could micro freely and bypass authority (per-unit `AllowCommand` is not fired from that path either — `unit->commandAI->GiveCommand(simCmd)` directly). See "Proposed C++ patches" P1. `ai/lib` refuses it structurally and `fake_engine` records any call as a violation.

### F3 — a shared AI library cannot be `require`d across plugins (MEDIUM, WORKED AROUND + PROPOSED C++)
`AIScriptContext::l_require` resolves only under the plugin's own folder and rejects `..`. `ai/lib/` is unreachable from `ai/garrison/`. Worked around with a relative symlink `ai/garrison/lib -> ../lib` (git-tracked symlink; `l_require` opens through it since it checks the NAME, not the resolved path). Proper fix: P3 (a second search root `<gamePath>/ai/lib`). Side effect today: AIDiscovery logs `skipping .../ai/lib: no ai.config.lua` once per lobby boot (harmless).

### F4 — event callins are documented but never dispatched (LOW, DOC)
`content/engine/ai/null/main.lua` and strategos `main.lua:395-406` define `onUnitCreated/onUnitDestroyed/onRelease`; `AIScriptContext::WantsEvent` accepts only `GameFrame` and `HandleEvent` is a no-op. Only `onUpdate(frame)` ever fires. Documented in `docs/ai-players.md`; proposal P5.

### F5 — snapshot fields not exposed to Lua (LOW, PROPOSED C++)
`AIStateSnapshot` carries `alliedUnits`, `isMoving`, `maxHealth`, `lodLevel`; none reach `AI.*` (`l_getOwnUnits` emits id/defId/x/y/z/health/hasCommands only). P6.

### F6 — AI ticks run synchronously on the sim thread (INFO)
`AIRuntimePool::Tick` builds the snapshot and calls `ProcessSnapshot` inline ("Phase 6 will move this to worker threads"), every 10 frames. An AI's `onUpdate` cost is sim-thread cost; the §6 2 ms budget is a sim-thread budget. Documented.

### F7 — lobby profile dropdown is hard-coded to strategos (LOW, OUT-OF-LANE)
`client/src/lobby/lobby-ui.ts:185-200, 3400-3409`: `STRATEGOS_PROFILES` and `slot.aiId !== 'strategos' ? ''`. A second AI with profiles gets no selector. Proposal: `ai.config.lua` `profiles = {...}` → `AIDiscovery::AIInfo.profiles` → `/api/ai/<game>` JSON + `AIListUpdate` → generic dropdown. Garrison's manifest already declares `profiles` for that day.

## Changes (what was built)

* `data/games/metalstorm/ai/lib/**` — reusable AI-player library (engine-agnostic, feature-detecting):
  `engine.lua` (guarded reads + caps), `regions.lua` (graph/geometry, mirrors ui/lib/regions.js), `picture.lua` (regions/board/economy/ledger/intel decay/threat), `authority.lua` (cost preview = the sim's own formula; prefers `authority_cost.json` export, falls back to vendored copies), `directives.lua` (enums + builders, mortal by default), `actuator.lua` (rate-limited/charged/contained writer, NO unit verb), `scheduler.lua` (tick + contact LOD w/ dwell), `reporter.lua` (health lines + `ai.health` message), `testing/fake_engine.lua` (AI VM double incl. drain semantics: token resolution, E6 clamp, authority veto, LuaMsg budget, violations), `vendor/{formula,authority_cost,wire}.lua` (byte-identical copies + `tests/vendor_drift_spec.lua`). Specs: `lib/tests/*_spec.lua`.

## Proposed C++ patches (UNCOMPILED — needs a build session)

### P1 — make the per-unit verb opt-in per plugin
`rts/Server/AI/AIDiscovery.cpp` LoadOne: read `cfg->GetBool("unitCommands", false)` into a new `AIInfo::unitCommands`; thread it through `ResolvedAIPlugin` → `AIRuntimePool::AddAI` → `AIScriptContext` ctor (`bool allowUnitCommands`). In `RegisterAPI()`:
```cpp
-    lua_pushcfunction(L, l_issueCommand);
-    lua_setfield(L, -2, "issueCommand");
+    if (allowUnitCommands) {            // strategic floor: off unless the manifest opts in
+        lua_pushcfunction(L, l_issueCommand);
+        lua_setfield(L, -2, "issueCommand");
+    }
```
and in `StateStreamer::ApplyAICommands` `case UnitCommand:` route through `eventHandler.AllowCommand`-equivalent charging (today it bypasses authority entirely).

### P3 — shared library root for `require`
`AIScriptContext::l_require`: after the plugin-folder probe fails, probe `<gamePath>/ai/lib/<rel>.lua` when `name` begins with `lib.`; needs `gamePath` (already in `AISpawnEnv`) passed to the ctor. Removes the symlink workaround.

### P6 — expose what the snapshot already carries
`l_getOwnUnits`: add `isMoving`, `maxHealth`; new `l_getAlliedUnits` (same shape as own); `l_getLODLevel` returning `currentSnapshot.lodLevel` (BuildAISnapshot already takes it; AIRuntimePool passes none — default 0).

## Out-of-lane findings
* F7 (client lobby-ui.ts hard-coded strategos profiles).
* `ai/strategos/README.md:13` status block still says parley verbs are stubs; correct. `ai/strategos/config.lua` cost mirror — F1 (lane 4).
* `game_transports.lua` never publishes a side's departure zone (`departureZones[team]` is gadget-local); an AI cannot know where "withdraw through departure" is. Proposal P7: publish `ms_departure_<team>_{x,z,r}` team rulesParams (ALLIED_LOS) at GameStart in `game_transports.lua` where `departureZones` is filled. `lib/picture.lua` already reads those keys and falls back to the nearest map edge (the gadget's own default).

## Assumptions / decisions made without asking
* Vendored copies (formula/authority_cost/wire) with a byte-identity drift spec are the repo's established pattern (`ai/strategos/wire.lua`); chosen over a hand mirror because the sandbox cannot `require` LuaRules and no JSON export exists yet.
* `power.json` has no `authority_cost_base`; `scale` is used as the base (units/_builder.lua derives base from scale unless overridden) and flagged approximate.
* Symlink `ai/garrison/lib` for the engine path; busted runs use `package.path`.

## Changes (cont.)
* `data/games/metalstorm/ai/garrison/**` — second AI player (manifest, pure `brain.lua`, `main.lua`, three profiles, `lib` symlink, `tests/smoke_spec.lua`).

## Next milestones (prioritised roadmap)
1. Build `tools/ai-eval` per the design above; store a baseline; add strategos-vs-garrison on shared fixtures (contact reaction, outmatched withdrawal, broke-AI behaviour).
2. Write `docs/ai-players.md` from the census table; land P7 (publish departure zones) and P3 (shared `ai/lib` require root) — both small.
3. Ranked engine asks: P1 (unregister `issueCommand` unless the manifest opts in, and charge it) > P3 > P6 (allied units, isMoving, LOD level) > P5 (event callins: unit destroyed / enemy spotted, fog-filtered) > `authority_cost.json` export (A3) > per-def `authority_cost_base` in power.json > composition counters/idle-factory state.
4. Strategos adoption of ai/lib (proposal): replace `config.lua` cost mirror with `lib.authority` (F1); replace `wire.lua` copy with `lib.vendor.wire`; `actuators.lua` → `lib.actuator` (gains budget/E6 mirror/containment); `graph.lua` → `lib.regions`. Each is a drop-in with identical outputs; do it behind the existing specs.
5. Next AIs on the lib: `raider` (roams between scenario targets, Assault + Withdraw), `caravan` (Escort along a route — the civilian-AI C1 `transport` slate), then the civilian town faction (PLAN-metalstorm-civilian-ai C1–C4) as a profile family on garrison rather than strategos.
6. Tournament/eval ideas: headless `--headless-run` manifests seating two AIs per side on `meridian_basin` with `stopAt.frame`, scored on `ms_outcome_*` + authority burn; an ELO ladder over profiles; a "no-op AI" control in every eval so the fixture itself is not the signal.
