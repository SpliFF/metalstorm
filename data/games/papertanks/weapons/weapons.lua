-- Paper Tanks: Weapon Definitions
return {
    -- A silent no-op "death explosion" used by any unit that doesn't
    -- define its own `explodeAs` / `selfDestructAs`. Spring's engine
    -- looks up a weapon called NOWEAPON as the fallback for missing
    -- explode weapons; without a definition here (or an explicit
    -- explodeAs on every unit) every unit def logs an error at load
    -- time. Games are free to override this with something flashier.
    NOWEAPON = {
        name        = "No Weapon",
        weapontype  = "Cannon",
        range       = 10,
        reloadtime  = 1,
        damage      = { default = 0 },
        areaofeffect = 0,
        soundstart  = "",
        noexplode   = 1,
    },

    PT_LIGHTCANNON = {
        name = "Light Cannon",
        weapontype = "Cannon",
        range = 350,
        -- weaponVelocity is REQUIRED for Cannon weapons. Without it
        -- the ballistic range calculator returns 0 and auto-target
        -- rejects every candidate as out-of-range.
        weaponvelocity = 500,
        reloadtime = 1.5,
        accuracy = 100,
        areaofeffect = 32,
        turret = true,
        damage = {
            default = 120,
        },
        soundstart = "cannon_light",
    },

    PT_HEAVYCANNON = {
        name = "Heavy Cannon",
        weapontype = "Cannon",
        range = 450,
        weaponvelocity = 600,
        reloadtime = 3.0,
        accuracy = 80,
        areaofeffect = 64,
        turret = true,
        damage = {
            default = 350,
        },
        soundstart = "cannon_heavy",
    },

    PT_ARTY = {
        name = "Artillery Shell",
        weapontype = "Cannon",
        range = 900,
        weaponvelocity = 400,
        reloadtime = 5.0,
        accuracy = 200,
        areaofeffect = 96,
        turret = true,
        hightrajectory = 1,
        damage = {
            default = 250,
        },
        soundstart = "cannon_arty",
    },

    PT_MG = {
        name = "Machine Gun",
        weapontype = "Cannon",
        range = 250,
        weaponvelocity = 700,
        reloadtime = 0.3,
        accuracy = 150,
        areaofeffect = 8,
        turret = true,
        damage = {
            default = 25,
        },
        soundstart = "mg_burst",
    },

    -- Metalstorm Model-1 statistical-combat test vector
    -- (PLAN-metalstorm-combat-resolution.md §8 task 6). Spawns NO projectile:
    -- the volley is rolled server-side at fire time, damage applied at
    -- resolve frame, and a VolleyOutcome event streamed to the client (which
    -- invents tracers + impacts). Long range (> the stat tank's 500 sight)
    -- so a firer outside the target team's LOS trips the counterbattery
    -- red-blip reveal. The `resolution = "statistical"` customParam is the
    -- opt-in flag; the rest of customParams are StatCombat::Tuning knobs.
    PT_STATCANNON = {
        name = "Statistical Cannon",
        weapontype = "Cannon",
        range = 900,
        -- weaponVelocity still required for the ballistic RANGE calc even
        -- though no projectile is spawned; also sets the resolve-frame flight
        -- time (dist / velocity, clamped to 2s).
        weaponvelocity = 400,
        reloadtime = 2.0,
        accuracy = 100,
        areaofeffect = 48,
        turret = true,
        damage = {
            default = 100,
        },
        soundstart = "cannon_arty",
        customparams = {
            resolution            = "statistical",
            stat_base_accuracy    = "0.7",  -- ~70% hits point-blank -> visible hit/miss mix
            stat_accuracy_falloff = "1.0",
            stat_move_penalty     = "0.5",
            stat_height_bonus     = "0.15",
        },
    },

    PT_FLAK = {
        name = "Flak Gun",
        weapontype = "Cannon",
        range = 600,
        weaponvelocity = 650,
        reloadtime = 0.8,
        accuracy = 200,
        areaofeffect = 48,
        turret = true,
        canattackground = false,
        damage = {
            default = 80,
        },
        soundstart = "flak_burst",
    },
}
