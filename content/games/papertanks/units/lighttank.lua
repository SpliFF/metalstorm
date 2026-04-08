-- Paper Tanks: Light Tank
-- Fast, lightly armoured vehicle
return {
    pt_lighttank = {
        name = "Light Tank",
        description = "Fast scout vehicle with light armour",
        objectname = "pt_lighttank",
        category = "LAND MOBILE TANK",
        maxvelocity = 3.2,
        acceleration = 0.3,
        brakerate = 0.15,
        turnrate = 900,
        maxdamage = 800,
        mass = 200,
        footprintx = 2,
        footprintz = 2,
        sightdistance = 500,
        movementclass = "TANK2",
        canmove = true,
        canattack = true,
        canpatrol = true,
        canstop = true,
        canguard = true,
        leavetracks = true,
        trackwidth = 20,
        trackoffset = 0,
        trackstrength = 5,
        trackstretch = 1,
        tracktype = "StdTank",
        weapons = {
            [1] = { def = "PT_LIGHTCANNON" },
        },
    },
}
