-- Fighters — air superiority. Guns + AA missiles, no beams.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'fighters', label = 'Fighter',
    category = 'AIR MOBILE',
    canfly = true,
    baseHp = 500, baseMass = 150, baseSpeed = 9.0, baseSquad = 8,
    baseFootprint = 2, formation = 'wedge',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MG_S2' } },
                description = 'Interceptor drone flight' },
        [2] = { weapons = { [1] = { name = 'MS_AC_S1' },
                            [2] = { name = 'MS_MISSILE_AA_S1' } },
                -- fable_fighter (DESIGN-MODEL-BUILDING.md §24): shipped
                -- generated model (PLAN-metalstorm-beta-units.md §2 beta
                -- roster: "Fighter" = ms_fighters_s2).
                override = { objectname = 'fable_fighter' } },
        [3] = { weapons = { [1] = { name = 'MS_AC_S2' },
                            [2] = { name = 'MS_MISSILE_AA_S2' } } },
        [4] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_MISSILE_AA_S3' } },
                description = 'Air-dominance gunship — single heavy frame' },
    },
}
