# units-assets review — 2026-09-10 (lane 13)

## STATUS
complete (wrapped early) — commits 5bd996a88a, c5fb1957c6; gates green (census 0 FAIL, busted 14/14, manifest vitest 20/20, check_model_scale 1277/1277)

## Findings (ranked)

1. **HIGH — the "no row, no merge" manifest gate was inert.** `client/src/core/assets-manifest.ts`
   `parseAssetsManifest` ends the table at the first non-table line; ASSETS.md had an HTML
   comment at row 2 (line 33), so the client licence gate parsed ONE row (the palette atlas).
   It also scans `objects3d/*.glb` (an empty dir) rather than `models/*.gltf`, so even a full
   parse checks nothing. Four rows (fighters_s3, bombers_s3, pontoon_wharf, shipyard) carried
   unescaped `|x|`/`|z|` inside a cell and would have thrown once parsed.
   FIXED (data side): table made contiguous, comments moved to a prose section, pipes escaped,
   stale duplicate fable_tank/fable_mech rows (49–52) removed. New `tools/scripts/check_unit_defs.py`
   asserts `models/` coverage with the brace/`(+.bin, 5 .ktx2)` conventions expanded.
   PROPOSED (client, out of lane): scan `models/` — see Out-of-lane.
2. **MEDIUM — reconciliation census (new tool) baseline: 0 dead references.** 110 defs / 32 weapons /
   8 features / 22 SoundItems: every `objectname` resolves (0 placeholder defs — the memory note
   "6 families lack objectname" is stale), every weapon/sound/effect reference resolves,
   `check_model_scale.py` 1277/1277. Remaining WARNs are scale/clearance drift (below).
3. **MEDIUM — weapon-fx.json lacked entries for MS_AC_TECHNICAL and MS_MISSILE_CRUISE_SUB**
   (fell to the weapontype default: wrong impact FX + sound for both). FIXED.
4. **MEDIUM — `sizes` clearance rows disagree with shipped hulls** (member_clearance < model
   extent ⇒ members interpenetrate; the exact defect M2 was written to fix): engineers_s4
   (0.95 m vs 19.9 m crawler), mechs_s1 (1.8 vs 3.0), mechs_s4 (6.6 vs 8.8), soldiers_s3
   (0.8 vs 1.0), staticdefense s1–s4 (2.4/3.6/4.8/6.4 vs 6.0/5.8/7.4/9.4), tanks_s2 (8.5 vs 9.9),
   tanks_s4 (26 vs 20.3 — over-reserves a 13-cell footprint).
   FIXED (c5fb1957c6) for engineers_s4 + staticdefense s1–s4 (unpinned). PROPOSED for
   tanks/mechs/soldiers: their golden radii are pinned in `tests/squad_extents_spec.lua` AND
   `client/squads/member-spacing.test.js` (client lane) — the corrected rows are written as
   PROPOSED comments next to each `sizes` line; apply with both golden tables at once.
5. **MEDIUM — staticdefense HP no longer meets its own stated rule** ("~2x the same-scale tank
   squad"): after the 2026-08-20 tank retune (2400/7200/13000/30000) batteries sit at
   2800/5600/11000/22000, i.e. BELOW tanks at s2–s4. FIXED (c5fb1957c6):
   | scale | tank squad HP | static old | static new | ratio | rationale |
   |---|---:|---:|---:|---:|---|
   | s1 | 2400 | 2800 | 4800 | 2.0 | file's stated rule |
   | s2 | 7200 | 5600 | 14400 | 2.0 | file's stated rule |
   | s3 | 13000 | 11000 | 26000 | 2.0 | file's stated rule |
   | s4 | 30000 | 22000 | 45000 | 1.5 | lone dreadnought is not a squad; 2x would be flagship-immune |
8. LOW — `ms_landing_ship` footprint 4×8 (16 m) for a 34.3 m hull, `ms_civbus` 2×3 for a 10.7 m bus.
   FIXED (c5fb1957c6): 4×17 and 2×5 under the cells×2 = metres single-hull rule (ms_ships_s3 carries 28).
9. INFO — `wz_*` models are referenced only by the `wz_baseline.lua` harness fixtures; no roster def
   uses them. Task 2(b) has nothing left to replace. 30 shipped models (`ms_anc_*`, civilian hulls,
   `ms_dreadnought`…) are referenced by no def or feature — a build queue already paid for.
6. LOW — `MS_RAILGUN_S1` is defined but carried by no def. WONTFIX (kept as a family rung).
7. LOW — stale comments cite "tank s4 11200 aggregate" (mechs.lua, staticdefense.lua); tanks s4 is 30000.

## Changes
- `tools/scripts/dump_defs.lua` (new) — VFS-shim def dumper (no deps).
- `tools/scripts/check_unit_defs.py` (new) — the census; `--tables` prints balance/DPS/scale tables.
- `data/games/metalstorm/ASSETS.md` — contiguous table, escaped pipes, duplicates removed.
- `data/games/metalstorm/effects/weapon-fx.json` + README — 2 missing weapon entries.
- `units/{staticdefense,engineers,transports,civvehicles,tanks,mechs,soldiers}.lua` — see findings 4/5/8.

## Weapons per class (DPS / range) — from `check_unit_defs.py --tables`
| family | S1 | S2 | S3 | S4 |
|---|---|---|---|---|
| MG (stat.) | 50 dps / 300 | 90 / 380 | | |
| Autocannon (stat.) | 92 / 380 | 138 / 440 | 191 / 520 | |
| Railgun (ballistic) | 167 / 600 (unused) | 225 / 750 | 291 / 900 | 400 / 1200 |
| Mortar (stat.) | 45 / 680 | 64 / 860 | | |
| Howitzer (ballistic) | 70 / 1100 | 100 / 1500 | 140 / 1900 | 150 / 3200 |
| AA missile | 73 / 700 | 105 / 950 | 160 / 1300 | |
| Cruise | 72 / 2400 | 80 / 3600 (+SUB twin) | | |
| Torpedo | 100 / 700 | 138 / 950 | 182 / 1300 | |
| Flak (AA only) | 80 / 600 | 120 / 800 | | |
| Bomb | 50 / 100 | 90 / 120 | 129 / 140 | |
| Depth charge | 100 / 350 | | | |
All 32 resolve to a SoundItem with a file on disk and to a weapon-fx entry; all ballistic
Cannons satisfy v²/g ≥ range. Per-scale HP/speed/DPS for the 11×4 classes: run
`python3 tools/scripts/check_unit_defs.py --tables`.

## Proposed C++ patches (UNCOMPILED)
- none so far.

## Out-of-lane
- `client/src/core/assets-manifest.ts` `validateAssets`: scans `objects3d/*.glb`; the corpus is
  `models/*.gltf` (+ `.bin`, `_{diffuse,orm,emissive,team,normals}.ktx2`, `_impostor{,_team}.ktx2`).
  Proposed edit: add a `models` pass mirroring the objects3d loop with the row-convention
  expansion from `check_unit_defs.py::manifest_coverage`, or simply call that script from CI.
- `docs/metalstorm-manual.md` §5 says "`fable_*` showcase set (26 defs)"; the census counts 22
  (fable_tank ×5, fable_heavy ×5, fable_train ×4, 8 singles). Lane 15 owns the manual.

## Assumptions / decisions
- Clearance (`sizes`) rows are set to the SHIPPED hull's measured extent, not the DESIGN-GUIDE
  target, wherever the two differ: the player sees the hull, and M2's contract is "two of them
  never interpenetrate".
- The unit-def/asset census lives in `tools/scripts/` (Python + a Lua dumper) rather than in
  `defs_reconciled_spec.lua`, which is about the balance-patch DELTA digest, not def truth.

## Not done (wrapped early on coordinator directive)
> CLOSED 2026-09-17 by the forge run on this lane: the three barricade split
> models, `ms_trench_segment` and the `ms_engineers_s3` rig are built, wired and
> censused, and the pinned tanks/mechs/soldiers `sizes` corrections are applied
> with both golden tables re-derived. Still open from this list: wiring the 30
> orphan models as defs/features. See the lane's 2026-09-17 commit.

- Task 2(c) forge builds: none built. Queue with stems/budgets: `ms_barricade_wall` /
  `ms_barricade_corner` / `ms_barricade_gate` (split the `ms_barricade_set` sample with root offsets
  zeroed, ≤400 tris each, 1024², pieces body[/gate]) — unblocks town-planner §T3;
  `ms_trench_segment` (8 m, ≤300 tris, --no-team, pattern ms_supply_dump); `ms_engineers_s3` rig
  (def says VEH "rig pair", model is a 1.9 m person — ≤2000 tris, pattern ms_command_s2).
  Transports per kind already exist (fable_train_*, ms_landing_ship, fable_airship).
  Recipe: `source $MAIN/tools/forge/bin/env.sh` (venv + node_modules live only in the main
  checkout), `bash $FORGE/bin/new-workspace.sh <ws> <stem> <sample>`, `build.sh` → copy
  out/*.gltf,*.bin,*.ktx2 into models/, ASSETS.md row, `check_unit_defs.py` + `check_model_scale.py`.
- tanks/mechs/soldiers `sizes` corrections (PROPOSED comments in the files; need both golden tables).
- Wiring the 30 orphan models (naval civilians, `ms_anc_*`) as defs/features (lane 12 features?).

## Next milestones
- Make `check_unit_defs.py` a CI step next to `check_model_scale.py`; port the models/ scan into
  `assets-manifest.ts` so the licence gate is real again.
- Apply the pinned clearance corrections with a single golden-table update on both ports.
- Barricade split + trench segment (drill-down build menu content), then orphan-model wiring.
- Decide `ms_engineers_s3`: either a rig model or revert the def to INFANTRY.
- `MS_RAILGUN_S1`: wire to a def (ms_tanks_s2 alt?) or drop.
