-- features/ancient.lua — ancient-tech sites (PLAN-metalstorm-model-integration §M3,
-- PLAN-metalstorm-worldbuilding.md "Technology (Ancient)").
--
-- See features/README.md for the load path and the key table.
--
-- These are the map's UNANSWERED QUESTIONS: a sealed vault door in a berm, a
-- spire nobody built, a pit somebody is currently digging. They exist to be
-- pointed at — by scenariogen's named-site layer, by objectives, by the Dynasty
-- faction that keeps the old machines — not to be fought over as materiel.
--
-- POSTURE: indestructible, therefore (by the engine's `reclaimable` default,
-- FeatureDefHandler.cpp:105) NOT reclaimable. That is the intended reading and
-- not an oversight: you do not scrap a monolith, and a scenario that hangs an
-- objective on one must be able to trust it is still there in twenty minutes.
-- They DO block — all three are solid enough to route around, and the
-- chokepoint value is the point of putting a 20 m spire in a pass.
--
-- ============================================================================
-- STATIC v1 — the monolith ring and the dig hoist do not turn. This is a
-- CLIENT limit, not a model one. Both models ship a real `idle` clip
-- (ms_monolith_spire: `ring` orbits; ms_dig_site: `hoist` raises/lowers on a
-- 10 s absolute-translation loop) and both would play if these were units.
-- `FeatureRenderer` thin-instances a single picked mesh per def and has no
-- AnimationGroup path whatsoever — contrast `entity-renderer.ts` +
-- `clip-auto-policy.ts`, which is what drives `idle` on the resource sites in
-- units/buildings_sites.lua. §M3 explicitly permits static as v1.
--
-- The escape hatch, if the motion is ever missed: promote these two to
-- capturable Gaia-team BUILDINGS in units/, exactly as buildings_sites.lua
-- does for the derrick and the headframe — their clips then play for free.
-- That is a smaller change than teaching the feature renderer to animate two
-- props, and it is the reason this file does not try to work around the limit.
-- ============================================================================
--
-- Footprints are full model XZ bounds under the footprint-metres = footprintX
-- x 2 convention (DESIGN-MODEL-BUILDING.md §4).
--
-- ============================================================================
-- THE BATCH-04 WAVE (2026-09-17, units-assets review finding 9)
-- ============================================================================
-- Fourteen more shipped models join the three originals below: the batch-04
-- `ms_anc_*` STATIC sites and batch-03's beached `ms_ancient_hulk`. All were
-- built, licensed and censused, then referenced by nothing — a build queue
-- already paid for. Every one of them is a place, not a thing that moves, so
-- the relic posture fits unchanged: they block, they are permanent, they are
-- unsalvageable, they can be clicked and read.
--
-- WHAT IS DELIBERATELY NOT HERE. The six batch-04 AUTOMATA — ms_anc_titan,
-- ms_anc_warden, ms_anc_custodian, ms_anc_sentinel, ms_anc_barge,
-- ms_anc_harvester — ship `walk`/`idle` clips and were built as UNITS: the
-- worldbuilding plan's "legacy units that can't be built, only discovered"
-- class (PLAN-metalstorm-worldbuilding.md, Technology (Ancient)). That class
-- has no weapon rungs, no discovery flow and no balance sheet yet, and a
-- feature would freeze a war machine into a statue with its walk clip in the
-- glTF. They stay unwired until that class is designed; see
-- docs/reviews/2026-09-10/units-assets.md finding 9's close-out.
--
-- Two of the sites below carry a WEAPON in their brief (lance battery, siege
-- platform) and one is described as "capturable". They are dormant here — a
-- feature cannot fire and cannot change hands. When the legacy-unit class
-- exists, promoting either to a capturable Gaia BUILDING with a real weapon is
-- the same escape hatch the header above describes for the spire and dig site.
--
-- Placement is split by what each site IS, one placer block per def
-- (tools/mapgen): the caches and dormant war machines are PRIZE sites in
-- scenario_templates.ANCIENT_SITES (region centre, guardian band, a control
-- objective hung on the region); the ruins that read as landscape — obelisk
-- field, shield pylon, aqueduct — are town-edge LANDMARKS in
-- town_templates.LANDMARKS; the beached hulk has NO automatic placer, because
-- a 105 m hull half-sunk in a sand berm wants a coast and no coastal placer
-- exists. scenarios/scenario_smoke_test.lua spawns every one of them once.

--- Shared ancient-tech posture: solid, permanent, unsalvageable, selectable
--- (these are points of interest a player should be able to click and read).
local function relic(t)
    t.blocking       = true
    t.indestructible = true            -- implies reclaimable = false; see the header
    t.flammable      = false
    t.upright        = true
    t.smokeTime      = 0
    t.metal          = 0               -- unsalvageable by design, not by omission
    t.energy         = 0
    t.customparams   = t.customparams or {}
    t.customparams.ms_feature_kind = 'ancient'
    t.customparams.generator = 'Claude Fable 5 (tools/forge)'
    return t
end

return {
    -- 20.0 x 16.0 m, 11.0 m of it above grade. A monolithic door half-buried in
    -- a rock/earth berm, cyan seam glow, toppled masonry, a conduit running off
    -- into the ground. Sealed — there is no open state and no animation; if it
    -- ever opens, that is a scenario swapping the feature, not a clip.
    --
    -- Authored deeply half-buried (model mins.y = -4.58). Spawn at ground Y and
    -- leave it: the berm IS the model.
    ms_vault_door = relic{
        description = 'Ancient vault door — sealed, half-buried in the berm',
        object      = 'ms_vault_door',
        footprintx  = 10, footprintz = 8,     -- 20 x 16 m
        health      = 20000,                  -- inert while indestructible
        mass        = 24000,
        customparams = { relic_kind = 'vault' },
    },

    -- 8.4 x 8.4 m, 20.15 m tall — the tallest thing in the roster, taller than
    -- the factory stacks, and a deliberate landmark: segmented tapering slabs,
    -- a floating ring collar, cyan tracery, a scorched apron where things that
    -- got too close stopped being things.
    --
    -- The ring is STATIC as a feature (see header). It ships an `idle` orbit.
    ms_monolith_spire = relic{
        description = 'Monolith spire — 20 m, floating ring collar, scorched apron',
        object      = 'ms_monolith_spire',
        footprintx  = 4, footprintz = 4,      -- 8 x 8 m
        health      = 30000,
        mass        = 18000,
        customparams = {
            relic_kind = 'monolith',
            -- Recorded so a future promotion-to-unit (header) knows the clip is
            -- there without re-inspecting the glTF.
            static_clip_unplayed = 'idle',
        },
    },

    -- 12.0 x 12.0 m, 5.1 m of scaffold above a pit that drops to -1.60. Somebody
    -- is working this one RIGHT NOW: timber scaffold, spoil heaps, crates,
    -- survey strings, warm work lights, and a cyan-traced slab at the bottom
    -- that is the actual find. The narrative counterpart to the sealed vault —
    -- this is the question being answered.
    --
    -- The hoist is STATIC as a feature (see header). It ships a 10 s `idle`.
    ms_dig_site = relic{
        description = 'Ancient-tech dig site — scaffold, hoist, cyan-traced slab',
        object      = 'ms_dig_site',
        footprintx  = 6, footprintz = 6,      -- 12 x 12 m
        health      = 4000,
        mass        = 3000,
        customparams = {
            relic_kind = 'dig',
            static_clip_unplayed = 'idle',
        },
    },

    -- ------------------------------------------------------------------
    -- Batch-04 caches — the things an expedition is mounted to TAKE
    -- ------------------------------------------------------------------

    -- 20.2 x 20.2 m, 24.6 m tall. Five leaning monolithic data-stacks around
    -- a sunken court, a floating tilted index ring threading between them
    -- (STATIC as a feature; ships `idle`), cyan glyph-line tracery. The
    -- "intact archive" of the worldbuilding pillar, i.e. the prize that is
    -- information rather than materiel.
    ms_anc_archive = relic{
        description = 'Ancient data archive — five leaning stacks, floating index ring',
        object      = 'ms_anc_archive',
        footprintx  = 10, footprintz = 10,    -- 20 x 20 m
        health      = 30000,
        mass        = 26000,
        customparams = { relic_kind = 'archive', static_clip_unplayed = 'idle' },
    },

    -- 24.0 x 25.6 m, 26.1 m tall, sunk 1.10 m into its crater apron (model
    -- mins.y = -1.10 — spawn at ground Y, the apron IS the model). A
    -- hemispherical containment dome, buttress cage, exposed cyan core column
    -- and two counter-rotating floating gyro rings (STATIC as a feature;
    -- ships `idle`). The "sealed reactor" of the pillar.
    ms_anc_reactor = relic{
        description = 'Ancient geothermal core tap — containment dome, exposed core, gyro rings',
        object      = 'ms_anc_reactor',
        footprintx  = 12, footprintz = 13,    -- 24 x 26 m
        health      = 40000,
        mass        = 36000,
        customparams = { relic_kind = 'reactor', static_clip_unplayed = 'idle' },
    },

    -- 54.0 x 52.6 m, 40 m tall — the largest footprint in the roster by a
    -- wide margin, larger than any building. A stepped ziggurat with
    -- cantilevered casting halls, a breathing cyan core shaft (STATIC as a
    -- feature; ships `idle`), gantries frozen mid-task, slag spill gone to
    -- glass. Reads as a district, and the prize placer treats it as one: it
    -- needs a region whose centre can clear 27 x 26 cells, and on a cramped
    -- map it is simply skipped rather than shoehorned.
    ms_anc_foundry = relic{
        description = 'Ancient automated foundry — stepped ziggurat, casting halls, cyan core shaft',
        object      = 'ms_anc_foundry',
        footprintx  = 27, footprintz = 26,    -- 54 x 52 m
        health      = 60000,
        mass        = 80000,
        customparams = { relic_kind = 'foundry', static_clip_unplayed = 'idle' },
    },

    -- 38.9 x 35.1 m, 17 m tall. A cliff-set facade: cyclopean architrave, a
    -- rolling segmented main vault door flanked by two sealed doors, an
    -- inlaid approach causeway and a collapsed overburden corner. The BIG
    -- sibling of ms_vault_door above; ships an `open` clip that a feature
    -- cannot play, so — like the small door — it is sealed, and opening it is
    -- a scenario swapping the feature, not a clip.
    ms_anc_vault_complex = relic{
        description = 'Ancient vault complex — cliff-set facade, three sealed doors, causeway',
        object      = 'ms_anc_vault_complex',
        footprintx  = 19, footprintz = 18,    -- 38 x 36 m
        health      = 50000,
        mass        = 60000,
        customparams = { relic_kind = 'vault', static_clip_unplayed = 'open' },
    },

    -- 30.6 x 22.7 m, 31.6 m tall, plinth sunk 1.63 m (model mins.y = -1.63;
    -- no lift at spawn). A free-standing circular portal on a stepped
    -- monolithic plinth: seamless segmented ring floating in open cradle arcs
    -- (STATIC as a feature; ships `idle`), dormant cyan tracery, half-buried
    -- conduit stubs. The second-tallest thing on any map after the foundry.
    ms_anc_gate = relic{
        description = 'Ancient ring gate — 30 m floating portal ring on a stepped plinth',
        object      = 'ms_anc_gate',
        footprintx  = 15, footprintz = 11,    -- 30 x 22 m
        health      = 40000,
        mass        = 30000,
        customparams = { relic_kind = 'gate', static_clip_unplayed = 'idle' },
    },

    -- 14.6 x 14.6 m, 26 m tall. A monolithic mast on a soil-buried stepped
    -- dais, cantilever vanes with floating keystones, an unfolding six-blade
    -- petal array and an intense cyan crown lens (STATIC as a feature; ships
    -- `idle`). A landmark visible across a region, which is what a beacon is
    -- for and why the prize placer puts it at a region's centre.
    ms_anc_beacon = relic{
        description = 'Ancient summoning beacon — 26 m mast, petal array, cyan crown lens',
        object      = 'ms_anc_beacon',
        footprintx  = 7, footprintz = 7,      -- 14 x 14 m
        health      = 25000,
        mass        = 16000,
        customparams = { relic_kind = 'beacon', static_clip_unplayed = 'idle' },
    },

    -- ------------------------------------------------------------------
    -- Batch-04 dormant war machines — prizes with a weapon in the brief
    -- ------------------------------------------------------------------
    -- Features cannot fire, cannot change hands and cannot animate, so all
    -- four are inert monuments here (see the header). `relic_kind = 'weapon'`
    -- is published so a scenario or the future legacy-unit lane can find them
    -- without a def list.

    -- 22.1 x 22.1 m, 24.5 m tall, sunk 0.49 m into its dead-zone ash circle
    -- (mins.y = -0.49). Three curved buttress legs cradling a suspended cyan
    -- core, swept by a broken tilted halo antenna (STATIC; ships `idle`).
    ms_anc_interdictor = relic{
        description = 'Ancient EM interdiction emitter — three buttress legs, suspended core, broken halo',
        object      = 'ms_anc_interdictor',
        footprintx  = 11, footprintz = 11,    -- 22 x 22 m
        health      = 30000,
        mass        = 24000,
        customparams = { relic_kind = 'weapon', static_clip_unplayed = 'idle' },
    },

    -- 14.6 x 19.7 m, 13.8 m tall. A monolithic drum emplacement carrying a
    -- floating yoke ring and a 14 m coil-segmented cyan lance (STATIC; ships
    -- `idle`). Modelled with an aim chain; none of it is wired because a
    -- feature has no weapons table. The natural first promotion when an
    -- ancient weapon rung exists — a captured battery is a staticdefense
    -- with a story.
    ms_anc_lance_battery = relic{
        description = 'Ancient particle lance battery — drum emplacement, yoke ring, 14 m lance',
        object      = 'ms_anc_lance_battery',
        footprintx  = 7, footprintz = 10,     -- 14 x 20 m
        health      = 30000,
        mass        = 22000,
        customparams = { relic_kind = 'weapon', static_clip_unplayed = 'idle' },
    },

    -- 22.0 x 22.0 m, 9.9 m tall. A cantilevered monolith carrying a
    -- ring-mounted 8 m breech-ring mortar, loading arms frozen mid-cycle with
    -- a charge shell, floating cyan halo arcs. Its own brief says
    -- "capturable"; that is the escape hatch, not this def.
    ms_anc_siege_platform = relic{
        description = 'Ancient siege mortar platform — ring-mounted breech mortar, frozen loading arms',
        object      = 'ms_anc_siege_platform',
        footprintx  = 11, footprintz = 11,    -- 22 x 22 m
        health      = 30000,
        mass        = 26000,
        customparams = { relic_kind = 'weapon' },
    },

    -- 16.4 x 16.4 m, 10.9 m tall, scorched-earth ring sunk 0.35 m
    -- (mins.y = -0.35). A six-petal iris shell over a cyan tesla core with
    -- four grounded lightning vanes. Ships `open` (the iris) and `idle`; both
    -- STATIC here, the iris shut.
    ms_anc_storm_caster = relic{
        description = 'Ancient arc-projector — six-petal iris over a tesla core, lightning vanes',
        object      = 'ms_anc_storm_caster',
        footprintx  = 8, footprintz = 8,      -- 16 x 16 m
        health      = 25000,
        mass        = 18000,
        customparams = { relic_kind = 'weapon', static_clip_unplayed = 'open' },
    },

    -- ------------------------------------------------------------------
    -- Batch-04 ruins — landscape, not prizes (town-edge landmarks)
    -- ------------------------------------------------------------------

    -- 25.4 x 5.7 m, 9.9 m at the tallest, bases sunk 0.93 m (mins.y = -0.93).
    -- A kit in one model: a 9 m upright, a 6 m leaning and a 4.3 m snapped
    -- obelisk (stump + fallen tip), twisted octagonal monoliths with cyan
    -- resonance channels. The one relic that reads as "a field", which is
    -- why it is a town-edge landmark and not a prize.
    ms_anc_obelisk_field = relic{
        description = 'Ancient resonant obelisks — one upright, one leaning, one snapped',
        object      = 'ms_anc_obelisk_field',
        footprintx  = 13, footprintz = 3,     -- 26 x 6 m
        health      = 15000,
        mass        = 9000,
        customparams = { relic_kind = 'ruin' },
    },

    -- 10.9 x 10.9 m, 18 m tall. A tapering triangular shaft with cyan
    -- charge-lines, three anchor vanes, a focusing corona and a floating,
    -- rotating emitter crystal (STATIC; ships `idle`). The same silhouette
    -- family as the spire, at half the height — a landmark for a town, not a
    -- landmark for a map.
    ms_anc_shield_pylon = relic{
        description = 'Ancient shield-emitter pylon — 18 m triangular shaft, floating emitter crystal',
        object      = 'ms_anc_shield_pylon',
        footprintx  = 5, footprintz = 5,      -- 10 x 10 m
        health      = 20000,
        mass        = 10000,
        customparams = { relic_kind = 'ruin', static_clip_unplayed = 'idle' },
    },

    -- 9.9 x 30.0 m, 30.4 m tall, footings sunk 0.40 m (mins.y = -0.40). A
    -- two-tier arcade carrying a sealed channel, one arch breached with a
    -- fossilised calcite flow. Authored tileable on local Z at exactly
    -- +-15 m; the pitch is published the way features/bridges.lua publishes
    -- the spans' 24, so a scenario can lay a run of arcade with `chain = n`
    -- and never restate the number (game_scenario.lua's featureChainPitch
    -- reads it off any def). It BLOCKS, unlike a span — an aqueduct is a
    -- wall, and a wall across a valley is a chokepoint, which is the point.
    ms_anc_aqueduct = relic{
        description = 'Ancient aqueduct section — two-tier arcade, one breached arch, 30 m tile',
        object      = 'ms_anc_aqueduct',
        footprintx  = 5, footprintz = 15,     -- 10 x 30 m
        health      = 30000,
        mass        = 30000,
        customparams = {
            relic_kind  = 'ruin',
            chain_axis  = 'z',
            chain_pitch = '30',   -- metres between segment centres; measured, exact
        },
    },

    -- ------------------------------------------------------------------
    -- Batch-03 — the beached hulk
    -- ------------------------------------------------------------------

    -- 24.4 x 104.7 m, 22.4 m tall, sunk 5.89 m into its sand berm
    -- (mins.y = -5.89 — the deepest-authored model in the corpus; spawn at
    -- ground Y and leave it). A listed monolithic warship hull with a cyan
    -- tracery flank, a glowing breach chamber and collapsed masts. The
    -- longest thing on any map (a battleship is 80 m). Not a wreck in the
    -- features/wrecks.lua sense: nobody salvages a monolith, and it is
    -- terrain — a 105 m wall with a 12 x 52 cell shadow. NO automatic placer:
    -- it wants a coast, and neither the prize placer (region centres) nor the
    -- town planner (inland lots) can promise one. Hand-authored scenarios
    -- only, until a coastal placer exists.
    ms_ancient_hulk = relic{
        description = 'Beached ancient warship hulk — 105 m listed monolith, glowing breach chamber',
        object      = 'ms_ancient_hulk',
        footprintx  = 12, footprintz = 52,    -- 24 x 104 m
        health      = 80000,
        mass        = 120000,
        customparams = { relic_kind = 'hulk' },
    },
}
