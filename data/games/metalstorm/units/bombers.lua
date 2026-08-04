-- Bombers — ground attack. Unguided bombs and cruise missiles.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'bombers', label = 'Bomber',
    category = 'AIR MOBILE',
    canfly = true,
    baseHp = 800, baseMass = 300, baseSpeed = 6.5, baseSquad = 8,
    baseFootprint = 3, formation = 'line',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_BOMB_S1' } },
                description = 'Strike drone flight' },
        [2] = { weapons = { [1] = { name = 'MS_BOMB_S2' } },
                -- fable_bomber (DESIGN-MODEL-BUILDING.md §26): shipped
                -- generated model, "s2 compact bomber" per its own header.
                override = { objectname = 'fable_bomber' } },
        [3] = { weapons = { [1] = { name = 'MS_BOMB_S3' },
                            [2] = { name = 'MS_MG_S2' } } },
        [4] = { weapons = { [1] = { name = 'MS_MISSILE_CRUISE_S2' },
                            [2] = { name = 'MS_BOMB_S3' },
                            [3] = { name = 'MS_FLAK_S1' } },
                description = 'Strategic bomber — single high-altitude platform' },
    },
}
