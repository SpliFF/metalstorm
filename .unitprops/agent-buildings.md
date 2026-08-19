# agent-buildings — summary & proposals

Files reviewed: buildings_civilian.lua, buildings_military.lua,
buildings_sites.lua, buildings_support.lua, fable_factory.lua.

## Changes made

1. **maxvelocity = 0 on every immobile def** (SIGSEGV rule). The civilian and
   military helpers and fable_factory did NOT set it — engine default for
   `maxVelocity` is 0.0 (UnitDef.cpp:424) so they were latently safe, but the
   rule is now explicit everywhere. Sites/support already had it.
2. **Factory yardmaps** (buildings_military.lua): foundry/garrison/airbase/
   shipyard had no yardmap → fully blocked footprints. Factory.cpp only opens
   `YARDMAP_YARD` ('c') cells while producing, so anything the world layer
   rolls off the line would spawn trapped. All four now carry all-'c' yardmaps
   sized exactly to their footprints ('c' blocks like 'o' when the yard is
   closed). In-battle non-production stays by design (field engineering only).
3. **Civilian HP trimmed to "fragile"**: habitat 8000→5000, transit hub
   6000→4000, depot 7000→4500 — keeps all civilians below the garrison (12000)
   and in line with the forge trio (meeting hall 4000 / shanty 2200 / market 900).
4. **ms_barricade_set 3000→6000** (buildings_support.lua): fortification walls
   should soak fire; now above civic structures, below factories.

## Verified, no change needed

- Yardmap dimensions all match footprints: nexus 12×12=144, fable_factory
  15×12=180, rail_platform 6×12=72 (and its 'o'/'u' column split matches the
  layout comment; 'u' is a valid engine char — YARDMAP_UNBUILDABLE).
- Category tokens: this game's convention is `BUILDING` (not `STATIC`) paired
  with `MOBILE` on units — consistent across all five files (LAND BUILDING
  [+CIVILIAN|SITE]). weapons.lua currently declares NO onlytarget/badtarget
  categories at all, so tokens are inert today (see proposal below).
- No building in my files carries a weapon — bunkers/towers live in
  staticdefense.lua (not mine). Nothing to check against weapons.lua.
- Support intel is role-appropriate and calibrated against radar.lua:
  comms_relay radardistance 2400 ≈ radar s2 (2600); command_post 900;
  watchtower sight 950 (its whole point); field_workshop has
  canrepair/canreclaim/canassist + workertime 80 / builddistance 300 and
  deliberately NO buildoptions — correct per its comment.
- Site HP band (2500–5000) sensible for capturable industry; `capturable=true`
  explicit; buildtimes irrelevant (pre-placed) but harmless.
- fable_factory (showcase, no buildoptions) keeps its all-'o' yardmap — it
  produces nothing, blocking is correct.

## Brief premise correction

The brief calls buildings_sites.lua "construction sites — check staged-HP/
progress customparams". The file is actually **capturable Gaia resource sites**
(silos/derricks/cranes; PLAN-metalstorm-worldbuilding decision 3) — there are
no staged-HP or progress customparams anywhere in it, and none are expected.
Nothing to reconcile; flagging so the coordinator doesn't wait on it.

## Proposals (not edited — shared files)

1. **weapons/weapons.lua target categories**: no weapon declares
   `onlytargetcategory`/`badtargetcategory`. At minimum AA families should get
   `onlytargetcategory = 'AIR'`, and torpedo families `onlytargetcategory =
   'SHIP SUB'`. Whoever owns weapons.lua should add per-family keys, e.g.:
   `MS_AA_S2 = { ..., onlytargetcategory = 'AIR', ... }`.
2. **Factory exit lanes**: the all-'c' yardmaps are the safe minimum. If unit
   exit behaviour ever looks wrong at the world layer, refine to 'o' perimeter
   walls + 'c' hall + open gate row on the model's -Z (gate) side — needs the
   per-model gate orientation, so left for a model-aware pass.
3. **ms_barricade_set individual pieces**: unchanged standing deviation — the
   kit sheet renders corner+wall+gate as one 25 m run; town-planner §T3 stays
   gated on piece visibility or three re-exported forge models.
4. **Civilian capturability**: civilians rely on the engine default
   `capturable=true` (implicit); sites set it explicitly. If capture-the-town
   objectives land, consider making it explicit in civbuilding() too.
