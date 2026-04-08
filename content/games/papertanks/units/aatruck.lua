-- Paper Tanks: AA Truck
-- Anti-air mobile unit
return {
    pt_aatruck = {
        name = "AA Truck",
        description = "Mobile anti-air platform",
        objectname = "pt_aatruck",
        category = "LAND MOBILE",
        maxvelocity = 2.5,
        acceleration = 0.25,
        brakerate = 0.12,
        turnrate = 800,
        maxdamage = 500,
        mass = 180,
        footprintx = 2,
        footprintz = 2,
        sightdistance = 600,
        movementclass = "TANK2",
        canmove = true,
        canattack = true,
        canpatrol = true,
        canstop = true,
        canguard = true,
        weapons = {
            [1] = { def = "PT_FLAK", onlytargetcategory = "AIR" },
        },
    },
}
