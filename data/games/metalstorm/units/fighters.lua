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
                            [2] = { name = 'MS_MISSILE_AA_S1' } } },
        [3] = { weapons = { [1] = { name = 'MS_AC_S2' },
                            [2] = { name = 'MS_MISSILE_AA_S2' } } },
        [4] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_MISSILE_AA_S3' } },
                description = 'Air-dominance gunship — single heavy frame' },
    },
}
