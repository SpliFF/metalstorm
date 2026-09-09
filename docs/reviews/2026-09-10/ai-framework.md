# Review — lane 6 `ai-framework` (2026-09-10)

## STATUS
in-progress: ai/lib landed with specs; next = ai/garrison second AI, tools/ai-eval, docs/ai-players.md

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

## Next milestones
(filled at the end)
