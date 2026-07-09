-- Submarines — underwater attack. Torpedoes; scale 4 carries cruise missiles.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'subs', label = 'Submarine',
    category = 'SUB MOBILE',
    movementclass = 'SUB',
    baseHp = 1600, baseMass = 1000, baseSpeed = 1.8, baseSquad = 4,
    baseFootprint = 3, formation = 'column',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_TORPEDO_S1' } },
                description = 'Coastal sub pack' },
        [2] = { weapons = { [1] = { name = 'MS_TORPEDO_S2' } } },
        [3] = { weapons = { [1] = { name = 'MS_TORPEDO_S3' } },
                description = 'Hunter-killer pair' },
        [4] = { weapons = { [1] = { name = 'MS_TORPEDO_S3' },
                            [2] = { name = 'MS_MISSILE_CRUISE_S2' } },
                description = 'Missile leviathan — single strategic boat' },
    },
}
