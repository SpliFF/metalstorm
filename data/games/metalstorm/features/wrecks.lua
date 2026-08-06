-- features/wrecks.lua — battlefield hulks (PLAN-metalstorm-model-integration §M3).
--
-- Metalstorm's first featuredefs. See features/README.md for the load path
-- (this directory is SCANNED — every .lua here must return a def table) and
-- for the full list of keys the engine actually reads.
--
-- Wrecks are the one feature family that is fully "gameplay live": they BLOCK
-- (chokepoints, cover, the reason a valley is a valley) and they RECLAIM. They
-- are not death-features of any unit — nothing chains into them via
-- `featureDead` — because Metalstorm units die into nothing today. They are
-- PLACED: scenariogen's terrain layer and the town planner drop them as
-- history, the same way the named-site layer drops resource sites.
--
-- SALVAGE VALUES ARE PLACEHOLDERS, and deliberately so. Metalstorm's income is
-- Authority, not metal (PLAN-metalstorm-worldbuilding decision 3 — the same
-- reason units/buildings_sites.lua carries no metalMake): nothing in the game
-- currently spends or accrues the `metal` these yield, and `squad.lua` vetoes
-- CMD_RECLAIM for squad units outright, so the only plausible reclaimer today
-- is a non-squad engineer. The numbers below are therefore chosen to be
-- *legible* rather than balanced — metal = half the donor unit's `mass`, so a
-- colossus hulk is worth ~4.5 tank wrecks, which is the relationship a salvage
-- economy would want to preserve when one is designed. Revisit as a set.
--
-- Footprints are the model's full XZ bounds under the footprint-metres =
-- footprintX x 2 convention (DESIGN-MODEL-BUILDING.md §4), measured off the
-- shipped glTF. Full bounds, not just the hull: the debris field, thrown track
-- and spilled cargo are part of why a wreck is an obstacle.

--- Shared wreck posture. Every hulk blocks, burns, can be shot apart and can be
--- salvaged; only the numbers differ. `reclaimable` is left to default from
--- `destructable` (true) rather than restated, so the two can never drift apart.
local function wreck(t)
    t.blocking       = true
    t.flammable      = true            -- fuel and ammunition still in there
    t.indestructible = false           -- a wreck in a chokepoint can be blasted clear
    t.upright        = true            -- these are authored resting on the ground plane
    t.smokeTime      = 0               -- cold hulks, not fresh kills
    t.energy         = 0               -- salvage is scrap, never fuel
    t.customparams   = t.customparams or {}
    t.customparams.ms_feature_kind = 'wreck'
    t.customparams.salvage_placeholder = '1'   -- see the header: values are unbalanced by design
    t.customparams.generator = 'Claude Fable 5 (tools/forge)'
    return t
end

return {
    -- 17.5 x 12.8 m, 7.8 m tall. A fallen FW-15 on its side with a torn-off
    -- leg and a scattered breakoff field; the furnace chest still has embers
    -- in it. The single biggest thing that can sit on a map without being a
    -- building — it reads as terrain, and is meant to.
    --
    -- Authored half-buried (model mins.y = -1.20): it settled into the ground
    -- where it fell. Do NOT lift it to y=0 at spawn.
    ms_colossus_wreck = wreck{
        description  = 'Fallen colossus — FW-15 hulk, furnace still warm',
        object       = 'ms_colossus_wreck',
        footprintx   = 9, footprintz = 6,     -- 18 x 12 m
        health       = 1400,                  -- fable_colossus maxdamage/10
        mass         = 3200,                  -- the donor's own mass; crushResistance follows
        metal        = 1600,                  -- mass/2, see header
        reclaimTime  = 3000,                  -- 100 s; the default (metal*6) would be 320 s
    },

    -- 8.9 x 10.8 m, 2.8 m tall. Burned-out fable_tank: turret dismounted and
    -- half-slid off the ring, barrel bent, one track thrown clear. The
    -- workhorse of the family — cheap enough to scatter a dozen along a road.
    ms_tank_wreck = wreck{
        description  = 'Burned-out tank — turret off the ring, track thrown',
        object       = 'ms_tank_wreck',
        footprintx   = 4, footprintz = 5,     -- 8 x 10 m
        health       = 200,                   -- fable_tank maxdamage/10
        mass         = 700,
        metal        = 350,
        reclaimTime  = 900,                   -- 30 s
    },

    -- 13.1 x 20.5 m, 7.3 m tall. A derailed cargo car tipped off a torn-up
    -- track section, crates spilled, side plates buckled. Pairs with the rail
    -- bridge and with fable_train's own routes — a wreck here says the line
    -- was cut, which is exactly the story scenariogen wants to tell.
    --
    -- Also authored slightly sunken (mins.y = -0.69) where the ballast gave.
    ms_train_wreck = wreck{
        description  = 'Derailed cargo car — spilled crates, torn-up track',
        object       = 'ms_train_wreck',
        footprintx   = 7, footprintz = 10,    -- 14 x 20 m
        health       = 950,                   -- fable_train cargo car maxdamage/10
        mass         = 1700,
        metal        = 850,
        reclaimTime  = 1800,                  -- 60 s
    },
}
