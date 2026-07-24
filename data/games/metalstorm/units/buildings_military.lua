-- Military buildings (PLAN-metalstorm.md §8).
-- Construction is a strategic commitment: buildtime values are tuned so a
-- factory takes 1+ hour of real time at nominal build power
-- (buildtime 360000 / workertime 100 ≈ 1 h; build_time_scale modoption
-- rescales for testing). Footprints are large — buildings are correctly
-- scaled to the units they produce.
local function building(t)
    t.category   = 'LAND BUILDING'
    t.isbuilding = true
    t.canmove    = false
    t.canattack  = t.canattack or false
    t.customparams = t.customparams or {}
    t.customparams.ms_class = 'buildings'
    t.customparams.building_family = 'military'
    return t
end

return {
    ms_command_nexus = building{
        name = 'Command Nexus',
        description = 'Team command centre — strategic coordination hub',
        objectname = 'ms_command_nexus',
        maxdamage = 30000, mass = 50000,
        footprintx = 12, footprintz = 12,
        yardmap = string.rep(string.rep('o', 12) .. ' ', 12),
        sightdistance = 900,
        buildtime = 1800000,           -- ~5 h: a campaign decision
    },
    ms_foundry = building{
        name = 'Foundry',
        description = 'Ground forces factory — mechs, tanks, artillery',
        -- fable_factory (DESIGN-MODEL-BUILDING.md §21): shipped generated
        -- model, authored explicitly as a 'military' building_family
        -- factory (see units/fable_factory.lua customparams).
        objectname = 'fable_factory',
        maxdamage = 18000, mass = 30000,
        footprintx = 16, footprintz = 20,    -- dwarfs the scale-3 tanks it builds
        sightdistance = 500,
        buildtime = 480000,            -- ~80 min
        builder = true, canbeassisted = true,
        buildoptions = {
            'ms_mechs_s1', 'ms_mechs_s2', 'ms_mechs_s3', 'ms_mechs_s4',
            'ms_tanks_s1', 'ms_tanks_s2', 'ms_tanks_s3', 'ms_tanks_s4',
            'ms_artillery_s1', 'ms_artillery_s2', 'ms_artillery_s3', 'ms_artillery_s4',
            'ms_engineers_s1', 'ms_engineers_s2',
        },
    },
    ms_garrison = building{
        name = 'Garrison',
        description = 'Infantry muster — soldiers and engineers',
        objectname = 'ms_garrison',
        maxdamage = 12000, mass = 20000,
        footprintx = 10, footprintz = 10,
        sightdistance = 450,
        buildtime = 360000,            -- ~1 h
        builder = true, canbeassisted = true,
        buildoptions = {
            'ms_soldiers_s1', 'ms_soldiers_s2', 'ms_soldiers_s3', 'ms_soldiers_s4',
            'ms_engineers_s1', 'ms_engineers_s2', 'ms_engineers_s3', 'ms_engineers_s4',
        },
    },
    ms_airbase = building{
        name = 'Airbase',
        description = 'Air forces factory — fighters and bombers',
        objectname = 'ms_airbase',
        maxdamage = 15000, mass = 25000,
        footprintx = 20, footprintz = 14,
        sightdistance = 600,
        buildtime = 540000,            -- ~90 min
        builder = true, canbeassisted = true,
        buildoptions = {
            'ms_fighters_s1', 'ms_fighters_s2', 'ms_fighters_s3', 'ms_fighters_s4',
            'ms_bombers_s1', 'ms_bombers_s2', 'ms_bombers_s3', 'ms_bombers_s4',
        },
    },
    ms_shipyard = building{
        name = 'Shipyard',
        description = 'Naval factory — ships and submarines',
        objectname = 'ms_shipyard',
        maxdamage = 20000, mass = 35000,
        footprintx = 18, footprintz = 24,
        sightdistance = 550,
        buildtime = 720000,            -- ~2 h
        builder = true, canbeassisted = true,
        floater = true,
        buildoptions = {
            'ms_ships_s1', 'ms_ships_s2', 'ms_ships_s3', 'ms_ships_s4',
            'ms_subs_s1', 'ms_subs_s2', 'ms_subs_s3', 'ms_subs_s4',
        },
    },
}
