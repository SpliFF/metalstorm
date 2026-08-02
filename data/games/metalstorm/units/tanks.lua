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
                description = 'Tankette pack — fast, thin-skinned',
                -- wz_wheeled (units/wz_baseline.lua): the Viper light
                -- wheeled hull + cannon turret — the closest shipped model
                -- to a tankette, and visually distinct from the s2 tracked
                -- MBT beside it. Without an override this def claimed a
                -- nonexistent `ms_tanks_s1.gltf` and every member rendered
                -- as a proxy capsule (the Basin Reavers' whole armour
                -- contingent in scenarios/meridian_basin.lua).
                --
                -- Team colour: wz_wheeled/wz_tank now carry a TCMASK wired to
                -- `SPRINGRTS_team_color`, so they tint like any other unit.
                -- The hull/turret mask is AUTHORED (tools/wz2100-baseline/
                -- make_tcmask.py) — upstream ships none that covers these
                -- hulls — and the wheels/tracks use the stock WZ page-16 mask.
                override = { objectname = 'wz_wheeled' } },
        [2] = { weapons = { [1] = { name = 'MS_AC_S3' } },
                description = 'Main battle tank troop',
                -- fable_tank (DESIGN-MODEL-BUILDING.md §18): shipped
                -- generated model, hull/turret/barrel/muzzle pieces.
                override = { objectname = 'fable_tank' } },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S2' },
                            [2] = { name = 'MS_MG_S2' } },
                -- wz_tank (units/wz_baseline.lua): the heavier tracked WZ
                -- hull, one step up from the s1 Viper. Same reason as s1 —
                -- no `ms_tanks_s3.gltf` exists.
                override = { movementclass = 'HEAVY', objectname = 'wz_tank' } },
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
