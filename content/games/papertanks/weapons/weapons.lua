-- Paper Tanks: Weapon Definitions
return {
    PT_LIGHTCANNON = {
        name = "Light Cannon",
        weapontype = "Cannon",
        range = 350,
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
        reloadtime = 0.3,
        accuracy = 150,
        areaofeffect = 8,
        turret = true,
        damage = {
            default = 25,
        },
        soundstart = "mg_burst",
    },

    PT_FLAK = {
        name = "Flak Gun",
        weapontype = "Cannon",
        range = 600,
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
