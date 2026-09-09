# Lane 11 — objectives-authority — deep review 2026-09-10

## STATUS

in-progress: authority-side fixes + field-engineering gate committed; next = game_objectives.lua fixes (expiry-vs-completion, escrow with no payee, linked/phase war-end outcome, live bounty cap, dying-unit ctx, reward scale at Initialize), generator cap fix, gameover Tick, economy harness, two gameplay rules.

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

(filled in per commit below)

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
