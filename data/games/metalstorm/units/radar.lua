-- Radar — sensors. Immobile; sight/radar radius grows with scale.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'radar', label = 'Sensor Array',
    category = 'LAND BUILDING',
    canmove = false, canattack = false,
    baseHp = 600, baseMass = 500, baseSquad = 1,
    baseFootprint = 2,
    scales = {
        [1] = { override = { isbuilding = true, buildtime = 60000,
                radardistance = 1500 },
                description = 'Field sensor mast' },
        [2] = { override = { isbuilding = true, buildtime = 150000,
                radardistance = 2600 } },
        [3] = { override = { isbuilding = true, buildtime = 360000,
                radardistance = 4200, sonardistance = 2000 } },
        [4] = { override = { isbuilding = true, buildtime = 900000,
                radardistance = 7000, sonardistance = 3500 },
                description = 'Theatre surveillance complex' },
    },
}
