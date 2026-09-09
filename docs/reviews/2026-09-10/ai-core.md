# ai-core (lane 4) — strategos pure core review, 2026-09-10

## STATUS
complete (wrapped early) — core defects fixed + threat/posture/withdraw/travel
built and green (131/131 busted, run.lua 39/39, smoke OK); new dedicated specs,
scenario fixtures, perf number and README refresh NOT done (see "Not done").

## Findings (ranked)

1. **Cost mirror was fiction (HIGH).** `config.lua` predicted
   `Σstrength × regionMod(0.5/1/2) × orderMod(0.5 platoon / 0.35 army)`. The
   actuator issues every directive AND every posture **area-scoped**
   (`actuators.lua` `_issueTagged` → `issueDirective(0, spec)`), and
   `game_authority.lua:ChargeDirective` charges an area-scoped create a flat
   `ceil(base_k × 1 × 1.0 × order_class.standing(1.2) × scale)` = 2, with
   regionMod pinned to 1.0. Postures are charged the same (they are Defend
   directives), not 0. `orderMod.build` was 2.0 vs real 3.0, `micro` 1.0 vs
   2.0. FIXED: `config.lua` now carries `authority_cost.lua` verbatim
   (`base_k`, `order_class`), `Config.formulaCost` mirrors `formula.lua`
   incl. the `costScale ≤ 0 → 0` path, and `predictDirectiveCost` predicts
   the area fee by default / the group formula for `scope='group'`.
   Intent `spend` for postures is now honest. A `mirror_spec` that LOADS the
   two synced files and diffs them is proposed (not written — see Not done).
2. **Co-commander idle etiquette was inert (HIGH).** `planner.lua`
   `idle = (bucket.idle ~= nil) and bucket.idle or true` is the and/or
   footgun: `idle=false` reads `true`. The existing spec passed only because
   the busy package lost on score. FIXED (explicit nil test). picture.lua
   never sets `idle` — lane 5 ask below.
3. **Every profile's `pSuccessFloor` was inert (MED).** `max(0.6, profile)`
   with profiles at 0.0–0.15. FIXED: the profile floor REPLACES the default
   (`floorFor`); aggressive 0.45. Mentor's `confidence 0.9` also put every
   unknown-ground move (0.585) under the 0.6 floor — it could never suggest
   one; set to 1.0.
4. **Travel penalty was a stub returning 0 (MED) → no reachability at all.**
   On a split-reachability map the planner would send an armour package at
   ground it cannot enter, forever. FIXED: per-(goal region, movement kind)
   BFS memoised per plan, `nil` hops = not a candidate, value discounted
   `1/(1+0.15×hops)`; `Graph.passableFor('armour'|'ground', config)` from
   region tags (`GROUND_BLOCKED_TAGS`, `ARMOUR_BLOCKED_TAGS`); package kind
   from `byClass` share. Expiring objectives out of reach in time
   (`HOP_TRAVEL_FRAMES`) are refused.
5. **DEFEND ignored the enemy standing IN the region (MED).**
   `adjacentThreat` only read neighbours. FIXED via the threat map
   (`enemyNear` = in-region + 0.5 × neighbours), used by slate and planner
   pSuccess alike.
6. **Non-deterministic across processes (LOW).** Goals/packages came from
   `pairs()`; the RNG tie-break is drawn in that order and Lua seeds string
   hashing per process. FIXED: slate sorted by id, packages by region key,
   components/regionAt iterate sorted keys.
7. **Commitments recorded for directives the budget then refused (LOW).**
   FIXED: `commitEmitted` records only what went out.
8. `expire` was read into the board but never used; protect objectives had
   `region=nil` (x/z/r only) so the actuator skipped them silently. FIXED:
   `Graph.regionAt` resolves pos → region; expiry urgency multiplier.
9. Aggression never mattered: no implicit goal targeted enemy ground. FIXED:
   `ATTACK` (profile `pressure`) on enemy-held ground 1 hop away, `DENY`
   (profile `deny`) on enemy-only protect/escort/extract objectives.
10. LOD hysteresis, graph BFS, RNG: reviewed, no defect found.

## Changes
- `threat.lua` (NEW, pure): per-region enemy/own/near/front/pressure/hops,
  totals, `anchor` (departure region, else sole owned region), `losing`,
  `pSuccessAt`. Memoised on `picture.threat`.
- `graph.lua`: `passable` predicate on `hops`/`minHops`, `components`,
  `reachable`, `passableFor`, `regionAt` (PIP), `hasTagIn`.
- `slate.lua`: threat-driven DEFEND, ATTACK, DENY, arrival-cover DEFEND and
  WITHDRAW (multi-package, rank above victory) from an optional
  `picture.transports`; objective urgency + region resolution; sorted output.
- `planner.lua`: posture floor — anchor bucket split into `pkg:<r>` and
  `pkg:<r>:garrison` (holdOnly: DEFEND own region only; profile
  `garrisonFraction`); travel/reachability; threat pSuccess; profile floor;
  multi-assign; commitments on emit; `plan.garrison/withdrawing/threat`.
- `config.lua`: exact mirror; THREAT/GARRISON/WITHDRAW/EXPIRY/ARRIVAL/DENY/
  passability tunables. `profiles/*`: `pressure, deny, garrisonFraction,
  withdrawRatio`, real floors.
- Specs adjusted to the new cost model / garrison split (planner_spec ×4,
  tick_wiring_spec cap 3600→2700 — lane 5 file, flagged).

## Proposed C++ patches (UNCOMPILED)
None.

## Out-of-lane findings / asks for lane 5 (actuators/picture/main)
- picture.lua never sets `ledger[r].idle`; `AI.getOwnUnits` exposes
  `hasCommands` — set `idle = (units without commands) / units > 0.5`.
- Add `ledger[r].baseSum` = Σ power.scale (authority_cost_base) so the
  group-scoped cost prediction is exact when directives become group-scoped.
- Populate `picture.transports = { departure={x,z,radius,region}, stranded,
  arrivals={ {id,team,eta,dropZone,region} } }`; needs lane 12 to publish
  `ms_departure_<team>_{x,z,r}` and `war_arrival_<id>_{team,eta,x,z}`
  rulesParams (nothing publishes the schedule today). Actuator already maps
  `WITHDRAW` → `DirectiveType.Withdraw`.
- Consider group-scoped directives (createGroup + issueDirective(handle)) so
  cost scales with force as designed; the mirror's `scope='group'` is ready.

## Assumptions
- Mirror truth = what `ChargeDirective` charges today, not the plan's
  intended force-scaled formula.
- Posture floor anchor = departure region if known, else the sole owned
  region; no floor when several regions are owned.
- `ford`/`infantry_only` tags block armour; water tags block all ground.

## Not done (wrapped early)
- tests/mirror_spec.lua (load ../../LuaRules/Configs/authority_cost.lua +
  formula.lua, diff against Config), threat_spec, graph split-map spec.
- tests/fixtures/{crossing_standoff,tutorial,split_reach}.lua + scenario_spec
  ("assaults raven_basin within N ticks, home never empty", profile diffs).
- perf_bench: add threat build; re-measure and document the number.
- README module map/status refresh for threat.lua and the new goal kinds.

## Next milestones
- The four items above; then a `memory.strengthHistory` trend feed (main.lua
  must pass `memory` to the planner) for commit/withdraw hysteresis.
- Per-class adjacency from mapgen instead of tag heuristics.
