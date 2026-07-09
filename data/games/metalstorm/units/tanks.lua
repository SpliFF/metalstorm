-- Tanks — armoured line. Kinetic main guns.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'tanks', label = 'Tank',
    category = 'LAND MOBILE TANK',
    movementclass = 'VEH',
    baseHp = 1400, baseMass = 500, baseSpeed = 2.6, baseSquad = 8,
    baseFootprint = 2, formation = 'wedge',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_AC_S1' } },
                description = 'Tankette pack — fast, thin-skinned' },
        [2] = { weapons = { [1] = { name = 'MS_AC_S3' } },
                description = 'Main battle tank troop' },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S2' },
                            [2] = { name = 'MS_MG_S2' } },
                override = { movementclass = 'HEAVY' } },
        [4] = { weapons = { [1] = { name = 'MS_RAILGUN_S4' },
                            [2] = { name = 'MS_HOWITZER_S2' },
                            [3] = { name = 'MS_FLAK_S2' } },
                override = { movementclass = 'HEAVY' },
                description = 'Land dreadnought — single tracked fortress' },
    },
}
