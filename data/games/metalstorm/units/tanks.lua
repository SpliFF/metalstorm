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
                description = 'Main battle tank troop',
                -- fable_tank (DESIGN-MODEL-BUILDING.md §18): shipped
                -- generated model, hull/turret/barrel/muzzle pieces.
                override = { objectname = 'fable_tank' } },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S2' },
                            [2] = { name = 'MS_MG_S2' } },
                override = { movementclass = 'HEAVY' } },
        [4] = { weapons = { [1] = { name = 'MS_RAILGUN_S4' },
                            [2] = { name = 'MS_HOWITZER_S2' },
                            [3] = { name = 'MS_FLAK_S2' } },
                -- fable_heavy (DESIGN-MODEL-BUILDING.md §19): shipped
                -- generated model, twin-turret super-heavy tank. Only 2
                -- turret pieces (turret/turret2) vs 3 weapons here — the
                -- 3rd weapon (FLAK_S2) gets no cosmetic turret-aim piece
                -- and fires from unit centre; not a rendering defect.
                override = { movementclass = 'HEAVY', objectname = 'fable_heavy' },
                description = 'Land dreadnought — single tracked fortress' },
    },
}
