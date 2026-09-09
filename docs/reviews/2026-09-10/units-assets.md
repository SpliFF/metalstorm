# units-assets review — 2026-09-10 (lane 13)

## STATUS
in-progress: census tool + ASSETS.md fixes committed; next = clearance/balance data fixes, then forge builds (barricade split, trench)

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
   tanks_s4 (26 vs 20.3 — over-reserves a 13-cell footprint). IN PROGRESS.
5. **MEDIUM — staticdefense HP no longer meets its own stated rule** ("~2x the same-scale tank
   squad"): after the 2026-08-20 tank retune (2400/7200/13000/30000) batteries sit at
   2800/5600/11000/22000, i.e. BELOW tanks at s2–s4. IN PROGRESS (table below).
6. LOW — `MS_RAILGUN_S1` is defined but carried by no def. WONTFIX (kept as a family rung).
7. LOW — stale comments cite "tank s4 11200 aggregate" (mechs.lua, staticdefense.lua); tanks s4 is 30000.

## Changes
- `tools/scripts/dump_defs.lua` (new) — VFS-shim def dumper (no deps).
- `tools/scripts/check_unit_defs.py` (new) — the census; `--tables` prints balance/DPS/scale tables.
- `data/games/metalstorm/ASSETS.md` — contiguous table, escaped pipes, duplicates removed.
- `data/games/metalstorm/effects/weapon-fx.json` + README — 2 missing weapon entries.

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

## Next milestones
- (filled in at the end)
