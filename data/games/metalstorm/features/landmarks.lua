-- features/landmarks.lua — civilian landmarks (units-assets review finding 9,
-- 2026-09-17).
--
-- See features/README.md for the load path and the key table. This directory
-- is SCANNED: every .lua here must return a def table, and this one does.
--
-- The third feature family after wrecks, spans and relics: things people
-- BUILT that are neither salvage nor ancient. Scenery with a name, placed the
-- way a relic is placed — to be pointed at — and given the relic's posture
-- (permanent, unsalvageable, blocking, selectable) for the same reason: a
-- scenario that says "hold the lighthouse" must be able to trust it is still
-- there in twenty minutes. They are civilian, so `ms_feature_kind` is
-- 'landmark' and not 'ancient'; nothing that filters relics will find one.
--
-- NO AUTOMATIC PLACER. A lighthouse wants a coast, and neither of the two
-- placer channels can promise one: scenariogen's site/prize layer anchors at
-- region CENTRES and the town planner sites on inland lots. A lighthouse in a
-- valley is a joke, and a placer that has to check "is this a coast" is the
-- coastal placer that does not exist yet (the same gap that leaves
-- ms_ancient_hulk unplaced — see features/ancient.lua). Hand-authored
-- scenarios only; scenarios/scenario_smoke_test.lua spawns it once.
--
-- Footprints are full model XZ bounds under the footprint-metres = footprintX
-- x 2 convention (DESIGN-MODEL-BUILDING.md §4).

local function landmark(t)
    t.blocking       = true
    t.indestructible = true            -- implies reclaimable = false (FeatureDefHandler.cpp:105)
    t.flammable      = false
    t.upright        = true
    t.smokeTime      = 0
    t.metal          = 0
    t.energy         = 0
    t.customparams   = t.customparams or {}
    t.customparams.ms_feature_kind = 'landmark'
    t.customparams.generator = 'Claude Fable 5 (tools/forge)'
    return t
end

return {
    -- 8.6 x 8.6 m, 21.6 m tall. A whitewashed tower on a rock plinth with a
    -- keeper's hut and a rotating lamp. The lamp is STATIC as a feature (the
    -- FeatureRenderer has no animation path — features/ancient.lua's header
    -- has the full argument); it ships an `idle` rotation, recorded below so
    -- a promotion to a Gaia building knows the clip is there.
    ms_lighthouse = landmark{
        description = 'Coastal lighthouse — 22 m whitewashed tower, keeper hut, rotating lamp',
        object      = 'ms_lighthouse',
        footprintx  = 4, footprintz = 4,      -- 8 x 8 m
        health      = 12000,
        mass        = 9000,
        customparams = { landmark_kind = 'lighthouse', static_clip_unplayed = 'idle' },
    },
}
