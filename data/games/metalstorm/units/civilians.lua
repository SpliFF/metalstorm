-- Civilians — unarmed and lightly armed population (PLAN-metalstorm.md §7).
-- Not part of the 4-scale system; run by the environment AI (ai/civilian).
-- Substrate for protect / escort / extract objectives.
return {
    ms_civilians = {
        name = 'Civilians',
        description = 'Unarmed civilian group',
        objectname = 'ms_civilians',
        category = 'LAND MOBILE CIVILIAN',
        movementclass = 'INFANTRY',
        maxdamage = 200, mass = 60,
        maxvelocity = 1.4, acceleration = 0.3, brakerate = 0.3, turnrate = 1500,
        footprintx = 2, footprintz = 2,
        sightdistance = 250,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        customparams = {
            ms_class = 'civilians', civilian = '1',
            squad_size = '12', formation_type = 'blob', formation_radius = '20',
        },
    },
    ms_militia = {
        name = 'Militia',
        description = 'Lightly armed civilian volunteers',
        objectname = 'ms_militia',
        category = 'LAND MOBILE CIVILIAN',
        movementclass = 'INFANTRY',
        maxdamage = 300, mass = 70,
        maxvelocity = 1.5, acceleration = 0.3, brakerate = 0.3, turnrate = 1400,
        footprintx = 2, footprintz = 2,
        sightdistance = 300,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = { [1] = { name = 'MS_MG_S1' } },
        customparams = {
            ms_class = 'civilians', civilian = '1',
            squad_size = '8', formation_type = 'blob', formation_radius = '18',
        },
    },
}
