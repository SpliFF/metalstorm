-- Paper Tanks: Scout
-- Very fast recon unit with good sight range
return {
    pt_scout = {
        name = "Scout",
        description = "Fast recon vehicle with excellent sight range",
        objectname = "pt_scout",
        category = "LAND MOBILE",
        maxvelocity = 4.5,
        acceleration = 0.5,
        brakerate = 0.2,
        turnrate = 1200,
        maxdamage = 300,
        mass = 100,
        footprintx = 2,
        footprintz = 2,
        sightdistance = 800,
        movementclass = "TANK2",
        canmove = true,
        canattack = true,
        canpatrol = true,
        canstop = true,
        canguard = true,
        stealth = false,
        weapons = {
            [1] = { def = "PT_MG" },
        },
    },
}
