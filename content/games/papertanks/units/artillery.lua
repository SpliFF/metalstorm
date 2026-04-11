-- Paper Tanks: Artillery
-- Long-range indirect fire support
return {
    pt_artillery = {
        name = "Artillery",
        description = "Long-range indirect fire unit",
        objectname = "pt_artillery",
        category = "LAND MOBILE TANK",
        maxvelocity = 1.2,
        acceleration = 0.1,
        brakerate = 0.08,
        turnrate = 400,
        maxdamage = 600,
        mass = 350,
        footprintx = 2,
        footprintz = 2,
        sightdistance = 350,
        movementclass = "TANK2",
        canmove = true,
        canattack = true,
        canpatrol = true,
        canstop = true,
        canguard = true,
        hightrajectory = 1,
        weapons = {
            [1] = { name = "PT_ARTY" },
        },
    },
}
