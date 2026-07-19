-- Paper Tanks: Statistical Tank
-- Metalstorm Model-1 statistical-combat test vector
-- (PLAN-metalstorm-combat-resolution.md §8 task 6). Identical hull to the
-- light tank but armed with PT_STATCANNON (resolution = "statistical"), so it
-- exercises the whole Model-1 path at runtime: server-side per-volley roll,
-- VolleyOutcome streaming, client-invented tracers/impacts, counterbattery
-- reveal (900 range > 500 sight), and derived-morale retreat/flee. Low
-- maxdamage so a test can drive it below the 10%/20% morale thresholds
-- quickly. Reuses the pt_lighttank model (objectname) — no new asset needed.
return {
    pt_stattank = {
        name = "Statistical Tank",
        description = "Model-1 statistical-combat test unit",
        objectname = "pt_lighttank",
        category = "LAND MOBILE TANK",
        maxvelocity = 3.2,
        acceleration = 0.3,
        brakerate = 0.15,
        turnrate = 900,
        maxdamage = 300,
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
        tracktype = "StdTank",
        weapons = {
            [1] = { name = "PT_STATCANNON" },
        },
    },
}
