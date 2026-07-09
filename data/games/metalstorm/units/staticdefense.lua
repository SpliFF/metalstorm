-- Static defenses — emplaced weapons. Immobile; built slowly like all
-- structures (PLAN-metalstorm.md §8). Squad hints model gun batteries
-- (one entity = a battery of N emplacements rendered by the client).
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'staticdefense', label = 'Defense Battery',
    category = 'LAND BUILDING',
    canmove = false,
    baseHp = 2000, baseMass = 2000, baseSquad = 4,
    baseFootprint = 3, formation = 'blob',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MG_S2' } },
                override = { isbuilding = true, buildtime = 90000 },
                description = 'Gun nest cluster' },
        [2] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_FLAK_S1' } },
                override = { isbuilding = true, buildtime = 220000 } },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S3' },
                            [2] = { name = 'MS_FLAK_S2' } },
                override = { isbuilding = true, buildtime = 480000 } },
        [4] = { weapons = { [1] = { name = 'MS_HOWITZER_S4' },
                            [2] = { name = 'MS_FLAK_S2' } },
                override = { isbuilding = true, buildtime = 1200000 },
                description = 'Bastion gun — single fortress emplacement' },
    },
}
