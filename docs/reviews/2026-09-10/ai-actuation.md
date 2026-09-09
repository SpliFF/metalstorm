# Lane 5 — ai-actuation review (2026-09-10)

## STATUS
in-progress: main.lua parley/health/backoff landed; next = main.lua specs, guidance gadget `ai.health` publish + stale funding spec, caretaker fuse, docs.

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

## Proposed C++ patches (UNCOMPILED — needs a build session)
(see bottom of file; filled in as each is written)

## Out-of-lane findings
(filled in below)

## Assumptions / decisions
(filled in below)

## Next milestones
(filled in below)
