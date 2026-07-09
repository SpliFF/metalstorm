-- Ships — surface naval. Gun batteries, flak screens, cruise missiles.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'ships', label = 'Ship',
    category = 'SHIP MOBILE',
    movementclass = 'SHIP',
    baseHp = 2500, baseMass = 1500, baseSpeed = 2.2, baseSquad = 4,
    baseFootprint = 4, formation = 'column',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_AC_S2' } },
                description = 'Patrol boat flotilla' },
        [2] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_FLAK_S1' },
                            [3] = { name = 'MS_DEPTHCHARGE_S1' } },
                description = 'Destroyer pair' },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S3' },
                            [2] = { name = 'MS_FLAK_S2' },
                            [3] = { name = 'MS_MISSILE_CRUISE_S1' } } },
        [4] = { weapons = { [1] = { name = 'MS_RAILGUN_S4' },
                            [2] = { name = 'MS_HOWITZER_S3' },
                            [3] = { name = 'MS_FLAK_S2' },
                            [4] = { name = 'MS_MISSILE_CRUISE_S2' } },
                description = 'Battleship — single capital hull, many turrets' },
    },
}
