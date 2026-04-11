-- Paper Tanks: Heavy Tank
-- Slow, heavily armoured battle tank
return {
    pt_heavytank = {
        name = "Heavy Tank",
        description = "Slow but powerful main battle tank",
        objectname = "pt_heavytank",
        category = "LAND MOBILE TANK",
        maxvelocity = 1.8,
        acceleration = 0.15,
        brakerate = 0.1,
        turnrate = 500,
        maxdamage = 2500,
        mass = 600,
        footprintx = 3,
        footprintz = 3,
        sightdistance = 400,
        movementclass = "TANK3",
        canmove = true,
        canattack = true,
        canpatrol = true,
        canstop = true,
        canguard = true,
        leavetracks = true,
        trackwidth = 30,
        trackoffset = 0,
        trackstrength = 8,
        trackstretch = 1,
        tracktype = "StdTank",
        weapons = {
            [1] = { name = "PT_HEAVYCANNON" },
        },
    },
}
