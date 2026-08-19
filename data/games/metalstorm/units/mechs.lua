-- Mechs — walking weapon platforms; all-terrain mid line.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'mechs', label = 'Mech',
    category = 'LAND MOBILE',
    movementclass = 'VEH',
    baseHp = 900, baseMass = 300, baseSpeed = 2.0, baseSquad = 8,
    baseFootprint = 2, formation = 'wedge',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MG_S2' } },
                description = 'Recon walker pack' },
        [2] = { weapons = { [1] = { name = 'MS_AC_S2' } } },
        [3] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_MISSILE_AA_S2' } } },
        [4] = { weapons = { [1] = { name = 'MS_RAILGUN_S3' },
                            [2] = { name = 'MS_AC_S3' },
                            [3] = { name = 'MS_FLAK_S2' } },
                -- fable_colossus (DESIGN-MODEL-BUILDING.md §20): shipped
                -- generated model, super-heavy assault walker. Only 2
                -- weapon-bearing pieces (arm_r/arm_l) vs 3 weapons here —
                -- the 3rd (FLAK_S2) fires from unit centre, no cosmetic
                -- turret-aim piece; not a rendering defect.
                override = { movementclass = 'HEAVY', objectname = 'fable_colossus' },
                description = 'Siege colossus — single multi-turret walker' },
    },
}
