# Lane 5 — ai-actuation review (2026-09-10)

## STATUS
complete (wrapped early) — coordinator directive; see "Not done".

## Not done
- F13 caretaker timed fuse (`game_ai_caretaker.lua` `requested[team]` should hold a frame and re-arm after ~900 frames when `GG.Teams.AIPlayers(team)` is still empty; the spec mock needs `Spring.GetGameFrame`). Hand-back RULE is documented below and tested AI-side (`main_parley_spec.lua` "hand-back"), not gadget-side.
- ROE (F10) and asset locks (F9): exposed in the Picture, proposals filed below; no core/engine consumer written.
- `docs/ai-actuation.md` reference page not written; everything is in this report + code headers. README status paragraph in `ai/strategos/README.md` still says the parley verbs are stubs (not touched — merge hotspot with lane 4): coordinator may replace that sentence with "parley verbs LIVE over `AI.sendMessage` (2026-09-10)".
- Originate-proposals policy in the pure core (`Planner.originateProposals`) — hook wired in main.lua, absent in planner (lane 4).

Branch: `worktree-agent-ac31eaa93bc09c5f8` (cut from `main` 88d257bce2, merged main tip before work).
Scope: `ai/strategos/{actuators,picture,main,wire,ai.config}.lua` + their specs; `game_ai_guidance.lua`, `game_ai_caretaker.lua`, `game_parley.lua` (AI-facing parts) + `parley/**` + their specs.

Baselines (same session, before edits): strategos `busted tests/` 131/0; gadget specs from `LuaRules/Gadgets/`: caretaker 8/0, guidance 32/0, guidance_wire(fuzz) 15/0, etiquette 13/0, parley 26/0, parley_wire 18/0, `guidance_wire_spec` **56/1 RED at baseline** (stale funding assertion, see F7).

## Findings (ranked)

| # | Sev | Where | What | Status |
|---|---|---|---|---|
| F1 | HIGH | `ai/strategos/picture.lua` readParley | Only kind/from/to/state/deadline were read; `Planner.evaluateOne` prices on `terms.payer/amount/regionKey`. Live proposals reached the planner with `terms == nil`, `terms.payer or 'from'` read a tribute DEMANDED of the AI as money in → the AI would accept paying any tribute. | FIXED 2085f038f4 (+ spec) |
| F2 | HIGH | `game_parley.lua` RecvLuaMsg parley.propose | `innerTerms` was never built from the wire, so `validateDemand` validated `{}` and every wire demand with an inner kind was refused; only a bare, effect-less demand could be sent by a human or an AI. | FIXED 9f692cd1b3 (+ spec) |
| F3 | HIGH | `actuators.lua` respondProposal/propose | Feature-detected no-ops probing `AI.respondProposal`/`AI.propose` that never existed; I1 (`AI.sendMessage`) landed 2026-08-14. Implemented over the funnel with the same wire strings a human's panel sends. | FIXED 92ad089973 |
| F4 | HIGH | `main.lua` onUpdate | A dormant NPC (LOD 3, 1 800-frame period) sleeps through `game_parley.lua`'s 60 s (1 800-frame) response window; no dedupe, so a response could be re-sent every tick while the message drained. Added a 150-frame parley poll that forces a tick, an answered/deferred ledger pruned against the board. | FIXED (this commit) |
| F5 | HIGH (engine) | `rts/Server/OrgGroups.cpp:522` `AIDirectiveConditions` | Hardcodes `idleOnly = false` for EVERY AI directive → a co-commander's area directive can recruit units its human teammate has ordered (contradicts §5.1 "touches only idle force"; the etiquette is only in the planner's package filter). Lua half landed: the spec now carries `idleOnly = role.idleOnly`. | PROPOSED (C++ patch P1) |
| F6 | MED (engine) | `rts/Server/AI/AIScriptContext.cpp:325` `AI.issueCommand` | A per-unit `(unitId, cmdId, params...)` verb is registered on the AI surface. Strategos never calls it (specs assert that), but "no micro verb exists at any layer" (README, manual §10) is false engine-side. | PROPOSED (C++ patch P2) |
| F7 | MED | `tests/guidance_wire_spec.lua:212` | Asserts `#world.chargeLog == 1` for `guidance.fund&amount=250`; the gadget moved to `GG.Authority.Transfer` (D32) and refuses a team with no AI — spec stale, red at baseline. | FIX PENDING |
| F8 | MED | `main.lua` | Tick errors were logged but retried at full cadence forever; a boot failure was retried on every runtime callin; no health surface. Added per-tick pcall with ×2 backoff (cap ×8), boot-retry gate, separate pcall for parley, `ai.health` message. | FIXED (this commit) |
| F9 | MED | `planner.lua:311` (lane 4) | `guidance.assetLocks[pkg.id]` keys on `'pkg:'..regionKey` while `lock_keys` carries org-group ids (explicit + 3-min touch locks) → asset locks are INERT in the core. No group→region view exists on the AI surface (AI2 squad views pending), so this cannot be fixed AI-side today. | PROPOSED (lane 4 / engine) |
| F10 | MED | `roe` guidance | Read into the Picture (`guidance.roe`), published by the gadget, consumed by NOTHING: planner greps clean, the engine stores posture JSON as an opaque string and never reads an ROE field. | PROPOSED (lane 4 + C++) |
| F11 | LOW (engine) | `AIStateSnapshot.cpp:69` | `CopyRulesParams(GetGameParams())` copies every game-scope param regardless of `losAccess`; no gadget publishes a non-public game param today, so no leak, but the "snapshot builder filters to what this AI's team may read" comment is aspirational. | PROPOSED (C++ patch P3) |
| F12 | LOW | `game_parley.lua` publish | A demand's `innerTerms` are not published separately; with F2 they are the same flat field set, so the AI reads them as the outer fields. Documented at both ends. | WONTFIX (by design after F2) |
| F13 | LOW | `game_ai_caretaker.lua` | `requested[team]` is a permanent fuse: if the server's async spawn is refused (team gained an AI meanwhile, then lost it again) no later emptying can re-request. | FIX PENDING (timed fuse) |

## rulesParams the AI depends on (censused against producers)

Game scope (public): `region_<key>_team`, `region_<key>_contested` (game_regions.lua:315-316); `objective_count` + `objective_<id>_{type,scope,state,reward,team,team2,progress,phase,stage,expire,region,x,z,r,suggested,source,victory}` (game_objectives.lua PUBLISHED_FIELDS; `completed_by` deliberately unread); `authority_cost_scale` (game_authority.lua:770); `parley_count` + `parley_<id>_{kind,from,to,state,deadline,counterOf,escrow,duration,regionKey,amount,perMinute,payer,corridor,unitClass,objectiveId,split,innerKind,orElse,regionKeys}` (game_parley.lua PUBLISHED_FIELDS); `trust_<lo>_<hi>` (parley/trust.lua).
Team scope (own team, allied LOS unless noted): `authority_pool`, `authority_player_<pid>` (integer pid; game_authority.lua pkey), `team_active_humans` (game_teams.lua:225), `ai_profile_<pid>` / `ai_profile` (game_teams.lua:198, game_scenario.lua:937, game_ai_caretaker.lua:122), `ai_slate_{kinds,home,targets,route,reach}` (game_scenario.lua:941+); PRIVATE: `guidance_<team>_{stance,roe,funding_rateCap,paint_keys,paint_<key>,lock_keys,delegated_keys,veto_keys}` (game_ai_guidance.lua publish()).
All names verified present with the exact spelling/shape in the producer.

## Changes
- 2085f038f4 picture.lua: full parley terms + `Picture.pendingProposals`.
- 9f692cd1b3 game_parley.lua: innerTerms from the flat field set; `counterTerms` alias; `tests/game_parley_ai_spec.lua` (AI virtual player through the human funnel).
- 92ad089973 actuators.lua: real `respondProposal`/`propose`; deference rule; propose rate limit; `idleOnly` on the spec; health counters.
- (this commit) main.lua: parley ledger + poll, originate hook, backoff, boot gate, `ai.health`.

Status updates: F4/F8 FIXED 93d2b921b7 (+ spec a9ff4c2f5d); F7 FIXED 070c2de859; `ai.health` publish landed 070c2de859.

## The rules this lane decided (design of record until overruled)
**Parley deference (co-commander).** A pact binds the whole team (ROE veto on every unit, team-pool tribute, widened objective eligibility). A guidance-bound role (`role.readsGuidance`, i.e. co_commander = humans present) therefore never proposes and never answers — not even reject, which would start the 2 min E6 cooldown in the humans' name. It leaves the proposal pending and narrates the deferral once. Sole exception: ACCEPTING an `intel` offer (the proposer reveals, we owe nothing). Enforced structurally in `Actuators:respondProposal/:propose` (`parleyAuthority()`), not in the core. Bounded response: ≤ 150 frames after the proposal appears on the board (`PARLEY_POLL_FRAMES`) + the AI command drain, regardless of LOD/backoff.
**Caretaker hand-back.** When a human rejoins: (1) `game_teams.lua` republishes `team_active_humans>0` and `SetOwnPoolOnly(ai,true)` in the same PlayerAdded; (2) the AI's next tick derives co_commander (idle-only, guidance-binding, own-pool, parley-deferring; deferred ledger reset), narrated `role -> co_commander`; (3) caretaker directives are mortal (2 tick periods ≤ 10 s at LOD 0) and are never re-stated under the new policy; (4) the human's first directive to a group touch-locks it 3 min (`game_ai_guidance.lua TouchGroup`). Pacts the caretaker made stay in force (synced team state). Engine gap: F5 — until P1 lands an AI directive still recruits non-idle units.

## Proposed C++ patches (UNCOMPILED — needs a build session)
**P1 — honour `spec.idleOnly` (F5).** `rts/Server/AI/AICommandCodec.h`/`AICommandQueue.h`: add `bool idleOnly = false;` to `AICommand`. `AIScriptContext.cpp` `l_issueDirective`, after `expiresInFrames`: `lua_getfield(L, 2, "idleOnly"); cmd.idleOnly = lua_toboolean(L, -1) != 0; lua_pop(L, 1);`. `OrgGroups.h/.cpp` `AIDirectiveConditions(float withinX, float withinZ, float withinRadius, bool idleOnly)` → `conds.idleOnly = idleOnly;`. `StateStreamer.cpp:831`: pass `cmd.idleOnly`. `test_ai_runtime.cpp`: a co-commander spec with `idleOnly=true` must not recruit a unit with a non-empty queue.
**P2 — retire `AI.issueCommand` (F6).** `AIScriptContext.cpp:325-326`: delete the two `l_issueCommand` registration lines (keep the function or delete it + `AICommandKind` per-unit drain in `StateStreamer::TickAI`). The manual's "strategic floor is structural" then holds engine-side. `tests/test_ai_runtime.cpp`: assert `AI.issueCommand == nil`.
**P3 — LOS-filter game params in the snapshot (F11).** `AIStateSnapshot.cpp` `CopyRulesParams`: take the AI's allyTeam and skip entries whose `p.los` is not public / not readable by that allyteam (mirror `LuaRulesParams` mask semantics used by `LuaSyncedRead` GetGameRulesParams). No behaviour change today (all game params are PUBLIC), closes the "no cheating channel" comment.

## Out-of-lane findings
- lane 4 `planner.lua:311` (F9): `guidance.assetLocks[pkg.id]` can never match (`'pkg:'..regionKey` vs group ids). Suggest: until AI2 squad views exist, treat a lock as "exclude the region containing the locked group" via a new Picture field the engine would have to supply (group→centroid), OR drop the dead lookup and document locks as synced-only (they are not enforced synced-side either — `game_authority_charge.lua` only records touch locks).
- lane 4 `planner.lua` (F10): `guidance.roe` unread. Proposal: `observed_only` excludes ASSAULT/TAKE_AND_HOLD/SECURE goals outside regions we own or painted priority; `deny_area` restricts them to painted-priority regions; `free` = today. Report the exclusion reason like `veto`.
- lane 4 `planner.lua evaluateOne`: ceasefire/safe_passage ignore relative strength; add `ledger` vs `intel` totals (reject standing down when we dominate ≥ 2:1, accept when ≤ 1:2) and a `counter` decision for tribute above `amount > trust*TRUST_VALUE_WEIGHT` (counter with the affordable amount; main.lua passes `r.extra` through).
- lane 4 `planner.lua`: `Planner.originateProposals(picture, profile, role)` hook is wired (main.lua handleParley) but absent.
- lane 11 `game_authority_charge.lua:151-163`: touch locks are recorded but nothing synced-side refuses an AI directive that recruits a locked group's units (relies on P1 + the planner).
- ARCHITECTURE.md "Macro directives" hunk (coordinator, if wanted): "AI directives now state `idleOnly` on the spec; the engine ignores it until P1."

## Assumptions / decisions
- Deference keys on `role.readsGuidance` (not the role id) so a future guidance-bound role inherits it; roles.lua is lane 4's, no field added.
- `ai.health` is allied-LOS (a status label), unlike the private guidance store.
- A demand's inner terms = the outer flat field set (F2/F12) — chosen over a second `inner_*` field family; both ends documented.
- `idleOnly` is emitted on the spec today although the engine ignores it (documented at the call site).
- Deferred proposals are left to EXPIRE if the humans never act (their decision by omission), not rejected.

## Next milestones
1. Build session: P1 (idleOnly) — the real hand-back protection; then P2.
2. lane 4: relative-strength + counter in `evaluateOne`, `originateProposals` (tribute-for-peace when losing, ceasefire when both bleeding), ROE exclusions.
3. HUD/MCP: read `ai_health_<pid>_*` (an "AI status" drill-down chip; `get_game_state` tool field).
4. Caretaker timed fuse (F13) + gadget-side hand-back spec.
5. Live verification on the player path: a human offers a ceasefire to a headless full-side AI and sees the answer within 5 s; a co-commander leaves it pending.
