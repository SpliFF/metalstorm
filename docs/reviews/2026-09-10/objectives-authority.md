# Lane 11 — objectives-authority — deep review 2026-09-10

## STATUS

**CLOSED 2026-09-17.** Commit `2155f33cd8` was the authority-side work (field-engineering
gate, velocity metric, decay rate, metrics publish). Everything under "Not done" below has
since landed on `taskherd/objectives-econ`:

| Commit | What |
|---|---|
| `6332d1cd95` | items 1-4 — the seven objectives fixes (F6-F14) + the gameover Tick gate |
| `95f134b032` | item 5 — the economy harness (`authority/economy_sim.lua`) |
| `2fee2c78d8` | item 6 — the chain rule and the comeback valve |
| `e4e595e929` | item 7 — the manual's §11/§12 corrections |

Every site was re-verified against the tree before editing; all seven were still exactly as
described here. Gates after: `authority/` 91 (was 71), `objectives/` 198 (was 139), plus the
eleven gadget suites, the three AI suites and the ui/ vitest root — all green.

**What the harness found on its first run** (the one thing here that is new information
rather than a closed item): with all six generator rules running together, the generator
mints far more than a team can spend — pool ratio 18-215x against the design's max of 8, and
velocity through the 0.6 floor at dense density. Adding the two new gameplay rules amplifies
it (dense: mint 379 -> 610/min, pool ratio 215 -> 412, velocity 0.50 -> 0.32). This is also
the concrete case for leaving reward normalisation OFF, which is where the cost spec has it:
at velocity 0.32 the 1/velocity scale clamps at x2.0 and would DOUBLE every systemic reward,
making the oversupply worse. Tuning the generator's reward literals is §10.6's open task
(derive them from the cost spec's median directive cost) and is a balance decision, not a
defect — it was not taken here.

## What was not done (in priority order, all with the fix designed — see the finding text)

*Historical: this is the list as it stood on 2026-09-10. Every item is now landed; kept for
the design rationale each entry carries.*

1. `game_objectives.lua` — six fixes, none applied:
   - **completion beats expiry on the same tick** (F6): on the expiry tick call `module.check`
     first; only if it answers nil fall through to `onExpire`/'expired'. Mirrors the war-end sweep.
   - **completion with no payee destroys stakes** (F7): `awardObjective` returns early when
     `completingTeam or o.forTeam` is nil, but `SettleEscrow(id,'complete')` still clears the
     escrow → staked authority vanishes for a scoped type authored without `forTeam`. Fix:
     settle as 'expired' (refund) + Echo, skip the award.
   - **linked partner ignores the war-end escrow outcome** (F8): `resolveObjective(partner,
     'expired', nil, ctx)` should pass `escrowOutcome` through; the sweep's snapshot then skips the
     partner as already resolved, so its stakes went to connected stakers, not team pools.
   - **a parent that expires/fails leaves phase children active** (F9): after the linked block,
     expire every still-active `o.phaseChildren` entry with the same `escrowOutcome`.
   - **bounty cap counts lifetime, not LIVE, bounties** (F10): record `o.bountyPlayer` in
     `CreateBounty`, decrement `bountyCountByPlayer` in `resolveObjective` for `source=='bounty'`.
   - **`authority_reward_scale` ignored for scripted objectives** (F11): `game_scenario` (layer
     -90) stages from its GameStart before objectives' (-50) reads the modoption. Add
     `gadget:Initialize()` reading it too (same pattern as game_authority.lua).
   - **UnitDestroyed sees the dying unit as alive** (F12): `buildCtx(frame, dyingUnitID)` and
     `unitAlive` returns false for it — every module's "immediate re-evaluation" is otherwise ≤3 s
     late. Safe for outbound escorts: game_transports increments the withdrawal counter before
     `DestroyUnit` (:579-589).
   - **reward normalisation is dead code**: `GG.Authority.NormaliseReward` is never called. Apply
     it in `awardObjective`/`awardPeriodic` for `o.source=='systemic'` only, to `o.reward` (never
     the escrow). Keep the lever OFF until F1's fixed velocity is validated by a harness.
2. `objectives/generator.lua` — **linked pair double-decrements the rule cap** (F13): both halves
   share a `systemicKey` and both call `onResolved` → `ruleCounts` drops by 2 per pair. Make
   `onResolved` a no-op when `state.systemicActive[dedupKey]` is already nil.
3. `objectives/{escort,protect,extract,infra}.lua` — **quorum unvalidated** (F14): 0/negative makes
   protect/infra unfailable, > roster makes them unwinnable. Add `validQuorum(q, n)` (whole number
   in 1..n) to each `validateParams`. Spec already written and left UNTRACKED (red until the modules
   change): `objectives/tests/quorum_spec.lua`.
4. `game_gameover.lua:` `frame % FOOTHOLD_PERIOD` violates ARCHITECTURE "never gate on frame %
   PERIOD" — replace with `Tick.due(footholdGate, frame)`, save/load the gate, add a `_G.VFS` mock
   to `tests/game_gameover_spec.lua`'s `load()` (it has none; `tests/game_snapshot_spec.lua:161`
   already carries one to copy).
5. Economy harness (task 3): not started. Design: pure-Lua `authority/economy_sim.lua` driving the
   real `formula/metrics/escrow` + generator DENSITY constants over scripted outcomes for six types
   × three densities; `tools/economy-validation.js` becomes a thin runner (spawn `lua`, print the
   table, exit on bands: velocity ∈ [0.6,1.5], escrow float 0 at war end, time-to-broke > 10 min);
   replace `scenarios/economy_validation_grid.json` with a pointer stub (its map/AI ids are dead —
   PLAN-economy-grid.md autopsy B1–B7 all still true).
6. Gameplay rules (task 4): not started. Designed: (a) **chain rule** in the generator — a
   completed `control` spawns a follow-up control for the same team on a `GG.Regions.Neighbors`
   region it does not own, +25 % reward, 3-min expiry, dedup `chain:<region>`; (b) **comeback
   valve** — `world.deficit(team)` from owned-region counts scales team-scoped systemic rewards
   ×(1 + deficit) clamped ≤ 1.5 and drops the trailing team's liveness threshold to 1 tick;
   publish `objective_comeback_<team>`.
7. Manual proposed text (lane 3/15): §12 first bullet becomes "**Enforced** since 2026-09-10:
   `LuaRules/Configs/field_engineering.lua` + `game_authority.lua` veto factory production and
   non-support structures (`AllowCommand` on build orders, `AllowUnitCreation` backstop);
   modoption `battle_production` lifts it for playtests." §11 adds `battle_production`. §3 decay
   line is now true as written (2 %/min).

Branch: `worktree-agent-ac47314f74f5a4b8f` (cut from `main` `88d257bce2`, merged to tip before work).

Baseline (before any edit, same session): `authority/` 50/0/0, `objectives/` 139/0/0,
`Gadgets/tests`: charge 22, cost_scale 4, roster_seed 3, stipend 6, ai_etiquette 13,
gameover 42, objectives_publication 7, snapshot 25, teams 34, parley 26 — all green;
`game_scenario_objectives_spec` 13/0 from the game root (cwd trap, known).

## Findings (ranked)

### F1 — HIGH — economy velocity metric could only ever decay to 0 (`authority/metrics.lua`)
`updateVelocity` sampled `burn/mint` only on frames with a mint (where burn is ~always 0)
and fed the EMA its own value on every other frame, so burn-only frames — all the spending —
were never measured. With `reward_normalisation_enabled` this clamps `1/velocity` at ×2 and
doubles every systemic reward permanently. **FIXED** (separate per-minute rate EMAs, ratio at
read time, 5-minute warm-up returns 1.0, `Metrics.rates()` for telemetry, coarse-sampler
`frames` argument). Spec: `authority/tests/metrics_spec.lua` (new).

### F2 — HIGH — `GG.Authority.ExportMetrics` / `IsOverflowing` raised on first call (`game_authority.lua`)
Both referenced `getTeamPool`/`getPlayerPool`, declared as `local function` further down the
file — globals (nil) at call time. Nobody called them yet, which is how it hid.
**FIXED** with forward declarations; spec `tests/game_authority_decay_spec.lua`.

### F3 — MEDIUM — overflow decay ran at double the documented rate (`game_authority.lua` GameFrame)
`overflow_decay_pct` (2, documented "per minute", manual §3) was applied on every
900-frame (30 s) period → ~4 %/min. Pools also became floats. **FIXED**: per-period fraction
= pct/100 × period/1800; integer pools; ledger reasons `overflow_share` (move) and
`overflow_decay` (burn) added so the sink is visible in `econ_*`. Spec: decay spec.

### F4 — HIGH (design gap, manual §12 first bullet) — field engineering was a convention
Nothing vetoed factory production or base-structure placement. **FIXED**: pure policy
`authority/field_engineering.lua` + data `LuaRules/Configs/field_engineering.lua` (keyed by the
existing `customparams.building_family` tag; `support` is the tier) + two callins in
`game_authority.lua` (layer -100): `AllowCommand` on build orders (cmdID < 0) and
`AllowUnitCreation` (backstop, drops the order). A vetoed build is never charged (the +100
charge gate runs after). Modoption `battle_production` (default off) is the playtest escape
hatch, published as `battle_production` game rulesParam. `GG.Authority.MayBuildInBattle(defID,
team)` exposed. Specs: `authority/tests/field_engineering_spec.lua` (fabricated violating input)
and `tests/game_authority_field_engineering_spec.lua` (veto-before-charge ordering proof).

### F5 — LOW — metrics were computed every frame and published nowhere
PLAN-economy-grid T3 asked for `econ_velocity` etc. **FIXED**: published at the 30 s ledger site
(`econ_velocity`, `econ_mint_rate`, `econ_burn_rate`, `econ_pool_ratio`, `econ_dead_frames`, allied LOS).

## Changes (by commit)

`2155f33cd8` — authority: field-engineering gate, velocity metric, decay rate, metrics publish.
Files: `LuaRules/Gadgets/game_authority.lua`, `authority/{metrics,ledger,field_engineering}.lua`,
`authority/ledger_spec.lua`, `authority/tests/{field_engineering,metrics}_spec.lua`,
`LuaRules/Configs/{field_engineering,authority_cost}.lua`, `modoptions.lua`,
`tests/authority_charge_mock.lua`, `tests/game_authority_{field_engineering,decay}_spec.lua`.
Gates after: `authority/` 71/0/0 (was 50), `objectives/` 139/0/0, charge 22, cost_scale 4,
roster_seed 3, stipend 6, ai_etiquette 13, field_engineering 12 (new), decay 8 (new),
snapshot 25, gameover 42, publication 7, teams 34, parley 26, scenario_objectives 13 — all green.

Uncommitted, deliberately: `objectives/tests/quorum_spec.lua` (red until Not-done item 3 lands).

## Proposed C++ patches (UNCOMPILED)

None so far.

## Out-of-lane findings

- **Strategos cost mirror has drifted from the spec** — `ai/strategos/config.lua:75-84`
  `Config.authorityCost.orderMod` says micro 1.0 / build 2.0 / directivePlatoon 0.5 /
  directiveArmy 0.35; `LuaRules/Configs/authority_cost.lua` (the source of truth, version 1)
  says micro 2.0 / build 3.0 / directive 1.0 / standing 1.2 and has no platoon/army split.
  The AI under-predicts every directive by 2–3×. Suggested fix (lane 4): load
  `authority_cost.json` (already exported) or copy the four numbers and assert `version`.

## Assumptions / decisions made without asking

- The field-engineering callins live in `game_authority.lua` rather than a new gadget:
  `LuaRules/main.lua`'s `GADGET_ALLOWLIST` is outside this lane, and the spend gate already
  owns order classification (the `build` class it prices at 3.0× is the class vetoed here).
  If the coordinator prefers a dedicated `game_field_engineering.lua`, the move is mechanical
  plus one allow-list line.
- Tier key = existing `customparams.building_family == 'support'`; no unit-def edit needed.
  Proposal to lane 13: none required; optionally tag future field-works with the same family.

## Next milestones

(filled in at the end)
