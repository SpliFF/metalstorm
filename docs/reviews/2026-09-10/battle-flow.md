# battle-flow (lane 12) — deep review 2026-09-10

## STATUS
complete (wrapped early) — transports fixes landed and gate-green; see "Not done" for the rest.

Branch: `worktree-agent-a6d61b5b2f6c4966a` (cut from main `88d257bce2`, merged main tip at start).

## Baseline (before any edit, same session)

Run from the dirs that make them green (`scratchpad/baseline.sh`):

| suite | result |
|---|---|
| Gadgets/tests: transports 64, train 20, teams 34, tick 14, squad_extents 7, defs_reconciled 7, snapshot 25 | all green |
| metalstorm root: scenario briefing 5 / neutral 9 / objectives 13 / population 18 / towns 15, crossing_standoff 18, meridian_basin 11, meridian_basin_soak 6 | all green |
| metalstorm root: `game_scenario_ai_spec` | **RED at baseline** — `units[21]: unknown unit def "ms_timber_yard"` (mock def list at :96 predates the §M4 resource sites in meridian_basin.lua) |
| regions/tests: control 7, cost 5, ownership 10, partition 48 | green |
| civilians/tests: convoy 6, estate_buildings 12, estate 10, estate_venue 10, routines 8, spawn 6, town 20 | green |

## Findings (ranked)

1. **HIGH — transports: no terrain-vs-kind validation** (`game_transports.lua` validateArrival). A `sea` wave with a dry entry was refused by CreateUnit silently (nil, no log); a sea wave with an inland drop zone never "arrived"; an air wave could set infantry down in open water. **FIXED** (commit "transports: terrain-vs-kind…"): `terrainProblem()` refuses at load with a named reason; `Spring.TestMoveOrder` is consulted for the carrier's entry square when the engine offers it.
2. **HIGH — sea arrivals could never unload**: a SHIP needs 12 elmos of water (`gamedata/moveinfo.tdf` minwaterdepth), so the drop zone is necessarily offshore, but the unload radius was the flat 200-elmo `ARRIVE_RADIUS` → `UNLOAD_UNITS` finds no dry ground and is re-issued every 300 frames forever. **FIXED**: `SEA_ARRIVE_RADIUS = 450` default for `kind='sea'`, per-arrival `dropRadius` override (validated positive).
3. **MED — withdrawal value accounting was a head count only.** A squad at 10 % strength counted like a full one. **FIXED**: `ms_withdrawn_<team>_strength` (Σ hp/maxHp of extracted units) published beside `_units`/`_transports`; `GG.Transports.Withdrawn` returns it as a third value; snapshot carries it.
4. **MED — a wave whose entry was blocked stayed in the §7.5 `committed` denominator**, so a side that extracted everything it actually had read `routed`. **FIXED**: blocked waves are subtracted and `ms_committed_<team>` republished.
5. **MED — the HUD events tab had no transport events.** **FIXED**: `GG.WarLog.Emit('transport', …)` on entered / landed / blocked / withdrew / stranded (kind `'transport'` is new — see the shape note below).
6. **MED — civilians: convoy state is NOT in the snapshot** (`civilians/convoy.lua` `activeConvoys`/`nextSpawn` are module locals; `game_civilians.lua` Save/Load never touch them). After hibernate/resume every active convoy vehicle is orphaned (role='convoy' in the registry, never receives its next waypoint) and every route respawns immediately. **PROPOSED**: expose `convoy.save()/load()` returning `{ active, nextSpawn }` and wire into the gadget's Save/Load; spec in `civilians/tests/convoy_spec.lua`.
7. **MED — train: `DecoupleAt` builds the new consist without `breadcrumbs`/`lastLeaderPos`/`deadCars`; if it elects an engine, the next `GameFrame` calls `AddBreadcrumb` on nil → Lua error → the Trains gadget is REMOVED** (`game_train.lua` ~:619-656 vs :1381). **PROPOSED**: initialise the movement fields and call `SetupConsistMovement` for each half that elected a leader.
8. **LOW — train follower heading lerp across the ±π wrap** (`GetBreadcrumbAtArcLength`): `prev.heading + t*(next - prev)` spins a car 180° for one segment when the leader's heading crosses south. **PROPOSED**: shortest-arc interpolation.
9. **LOW — civilians: `stageCivilians` only registers a civilian (and gives it `homePos`) when `role` or `town` is set**; a bare entry gets `spawn.one`'s role='ambient' with no `homePos`, so it takes the between-sites walk (the T4 migration bug) instead of wandering around home. **PROPOSED**: always Register with `homePos = {x,z}`.
10. **LOW — civilians perf**: `routines.findNearestSite` rebuilds the site table per civilian per tick (O(n²) per 150 frames). **PROPOSED**: build once per tick.
11. **LOW — regions ownership floor**: a single 10-hp scout alone in a region flips it after 3 ticks (no presence floor on ownership, only on *contest*). **PROPOSED** `OWN_FLOOR = CONTEST_FLOOR` in `regions/ownership.lua`; design call for the regions plan.
12. **LOW — squad.lua**: the engine's Guard-with-builder path repairs a damaged unit without any AllowCommand (CBuilderCAI guard→repair), bypassing the REPAIR veto. **PROPOSED** (lane 13): `canrepair = false` on engineer defs.
13. **INFO — `game_start.lua` ignores `metalstorm.reachability`**: the default force stages `ms_tanks_s2` on split maps where armour cannot leave its realm. **PROPOSED**: read `mapinfo.lua` via `VFS.Include('mapinfo.lua', nil, VFS.MAP)`; on `split` with VEH in `reachability_classes`, swap the tank entry for `ms_soldiers_s3` and Echo why. Also use `Spring.GetGroundHeight` instead of y=0.
14. **INFO — baseline red**: `tests/game_scenario_ai_spec.lua` fails on `ms_timber_yard`. Fix: add `ms_grain_silo, ms_tank_farm, ms_timber_yard, ms_scout_buggy, ms_supply_truck, ms_technical, fable_airship` to the mock list at :96.

Reviewed and found sound: regions hysteresis math (`ownership.lua`), partition grid/graph lookup, publication shape (`region_<key>_team/_contested/_name/_x/_z`, `regions_rev`), `tick.lua`, `game_teams.lua` leaver/drop-in (leader is bookkeeping only; co-commander flag rederived on Load), civilians routines cadence (Tick.due, never `frame % PERIOD`), warlog ring bounds.

### Warlog event shape (for lane 9's events tab)
`warlog_seq` (head, monotonic across hibernate), `warlog_ring` (32), per slot `warlog_<seq % 32>_{kind,subject,detail,team,frame,seq}`; `kind ∈ objective|region|pact|patch|transport`; transport details: `entered|landed|blocked|withdrew|stranded`, subject = arrival id (or `<carrier def> +<n>` for a withdrawal). The ring is PRIVATE (synced + the C++ drain in `rts/Server/WarStateSim.cpp` only); a widget cannot read it. Lane 9 needs either a PUBLIC per-team-filtered mirror or the lobby's `game_events` route.

## Changes

- `data/games/metalstorm/LuaRules/Gadgets/game_transports.lua`: terrain-vs-kind validation (`terrainProblem`), `dropRadius` (+ sea default 450), extracted-strength ledger, blocked-wave committed correction, warlog transport emits; header schema comment updated.
- `tests/transports_mock.lua`: `world.heightAt` / `world.setWater(depth)` hooks. `tests/game_transports_spec.lua`: 3 new cases (+ the existing sea case now stages water). 64 → **67 successes / 0 failures**; `game_snapshot_spec` still 25/0.

## Proposed C++ patches (UNCOMPILED)

None.

## Out-of-lane findings

- lane 13: `fable_train_troop` is `transportcapacity=4, transportsize=1` (`units/fable_train.lua:103`) — cannot carry any squad (footprint ≥ 2); a `kind='train'` arrival always lands empty. Fix: `transportsize = 3`.
- lane 13: engineer defs' `canrepair` (finding 12).
- lane 11: `objectives/generator.lua` transportRule already mints the inbound escort/kill pair and a standing outbound escort per side with a carrier + extract area — a scenario authoring its own transport escort would duplicate them; dedup on `transportUnitIDs`.
- lane 9: warlog is private (shape note above).

## Assumptions / decisions made without asking

- `data/maps` is untracked and absent from this worktree; every map fact was read from the MAIN checkout's `data/maps/**` (read-only) and sampled from `heightmap.bin` (uint16 LE, (mapx+1)×(mapy+1), `minheight..maxheight` from mapinfo).
- "Rail platform at the entry" for train arrivals cannot be validated: the map data carries no rail network (`roads.lua` classes are highway/road/track only). Documented in the gadget header as the author's job.

## Not done (wrapped early on the coordinator's directive)

- Fixes for findings 6-10, 13, 14 (each small; file:line above).
- Task 2 — the new showcase scenario. Design complete and map-verified: **"Hollow Dell — The Landing"** on `pelagic_expanse` (reachability `connected` for INFANTRY/VEH/HEAVY; sea + roads; 123-region graph). Compact garrison (team 0, home, not expeditionary) at Ash Ridge (start 0 at 5648,3160; town/hall ≈ 5300,3000 h≈20; static defence on the causeway ≈ 6100,4000 h 7) vs Union expedition (team 1, `expeditionary`, departure at sea 9900,5200 r=500) staged-as-arrived on the Hollow Dell beach (8250-8450, 4400-4900, h 1-19; parked `ms_landing_ship` at 9300,4400 depth 23; parked `fable_airship` 8700,4800). Arrivals: `sea` (`ms_landing_ship`, entry 9900,4300 depth 23, drop 9000,4400 depth 13, cargo tanks_s2×1 + soldiers_s1×2 = 7/8 slots, eta 2700), `air` (`fable_airship`, entry 9900,6000, drop east_crossing 8640,5344 h 56, soldiers_s1×2, eta 4200), second sea wave eta 8100. Victory: open-race control of `raven_watch` (7824,5408, chokepoint crossroads), notBefore 5400 / hold 5400; tactical control `hollow_dell`, `quarry_bluff`, `ash_ridge`; protect (team 0) Ash Ridge civilians, (team 1) Hollow Dell village civilians; authored escort = evacuate Ash Ridge civilians to the inland hall; kill = the defender's radar. Sequel: "The Counter-Landing", roles flipped (union garrison at hollow_dell, compact expedition from Storm Moor by sea/air). Plus `manifests/pelagic_landing_direct.json` and a docs/scenarios.md design note.
- Task 3 — `tests/scenario_references_spec.lua`: load every non-retired `scenarios/*.lua` bare; build the def universe by `dofile`-ing `units/*.lua` + `features/*.lua` with a stub `VFS.Include` (verified offline: all 110 unit + 8 feature defs enumerate); check every unit/feature/cargo/hall def, CMD names, `world.map`, region keys against `data/maps/<map>/mapdata/regions.lua` (resolve via `../../../data/maps` or `$SPRINGRTS_MAPS_DIR`, pending when absent), and carrier slot arithmetic (`footprintx` vs `transportsize`/`transportcapacity`).
- `game_scenario.lua`: add `transportUnitIDs = 'plural'` to `POPULATE_INTO` so a scenario can author the escort transport form.

## Next milestones

- Land findings 6 and 7 first (both silent gadget-killers under real play), then 13 and 14.
- Author the pelagic_expanse pair; validate with `tools/debug-mcp` `runScenarioValidation` against the MAIN checkout's baked def cache.
- Scenario reference sweep spec (Task 3) as the regression net for lanes 11/13.
- A PUBLIC, per-team warlog mirror for the HUD events tab (with lane 9).
- T7 navigable-water audit for every map that ships water, now that the validator can refuse a dry sea wave.
