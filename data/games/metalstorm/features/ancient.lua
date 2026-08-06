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
}
