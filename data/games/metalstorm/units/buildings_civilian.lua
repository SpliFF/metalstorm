-- Civilian buildings (PLAN-metalstorm.md §7–8).
-- Mostly pre-placed by maps/scenarios; objective fodder (protect / capture /
-- keep-running). Owned by the environment (gaia) team in the common case.
local function civbuilding(t)
    t.category   = 'LAND BUILDING CIVILIAN'
    t.isbuilding = true
    t.canmove    = false
    t.canattack  = false
    t.customparams = t.customparams or {}
    t.customparams.ms_class = 'buildings'
    t.customparams.building_family = 'civilian'
    t.customparams.civilian = '1'
    return t
end

return {
    ms_habitat = civbuilding{
        name = 'Habitat Block',
        description = 'Civilian housing — population centre',
        objectname = 'ms_habitat',
        maxdamage = 8000, mass = 15000,
        footprintx = 12, footprintz = 12,
        sightdistance = 200,
        buildtime = 600000,
    },
    ms_transit_hub = civbuilding{
        name = 'Transit Hub',
        description = 'Civilian transport node — keeps a district connected',
        objectname = 'ms_transit_hub',
        maxdamage = 6000, mass = 10000,
        footprintx = 10, footprintz = 14,
        sightdistance = 250,
        buildtime = 420000,
    },
    ms_depot = civbuilding{
        name = 'Supply Depot',
        description = 'Civilian logistics store — convoy origin/destination',
        objectname = 'ms_depot',
        maxdamage = 7000, mass = 12000,
        footprintx = 10, footprintz = 10,
        sightdistance = 220,
        buildtime = 360000,
    },
}
