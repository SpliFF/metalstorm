-- Artillery — long-range indirect fire. Real ballistics at every scale
-- (arcs matter; PLAN-macro-combat.md keeps these on the sim path).
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'artillery', label = 'Artillery',
    category = 'LAND MOBILE ARTILLERY',
    movementclass = 'VEH',
    baseHp = 700, baseMass = 400, baseSpeed = 1.4, baseSquad = 8,
    baseFootprint = 3, formation = 'line',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MORTAR_S2' } },
                description = 'Mortar carrier section' },
        [2] = { weapons = { [1] = { name = 'MS_HOWITZER_S1' } } },
        [3] = { weapons = { [1] = { name = 'MS_HOWITZER_S2' } },
                override = { movementclass = 'HEAVY' } },
        [4] = { weapons = { [1] = { name = 'MS_HOWITZER_S4' } },
                override = { movementclass = 'HEAVY' },
                description = 'Continental gun — single siege piece, hour-glass range' },
    },
}
