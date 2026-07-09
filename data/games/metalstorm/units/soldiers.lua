-- Soldiers — infantry squads. Kinetic small arms (PLAN-metalstorm.md §6).
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'soldiers', label = 'Infantry',
    category = 'LAND MOBILE INFANTRY',
    movementclass = 'INFANTRY',
    baseHp = 400, baseMass = 90, baseSpeed = 1.8, baseSquad = 16,
    baseFootprint = 2, formation = 'line',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MG_S1' } },
                description = 'Rifle section — numerous and expendable' },
        [2] = { weapons = { [1] = { name = 'MS_MG_S2' } } },
        [3] = { weapons = { [1] = { name = 'MS_AC_S1' },
                            [2] = { name = 'MS_MORTAR_S1' } },
                description = 'Heavy weapons team — autocannon + mortar' },
        [4] = { weapons = { [1] = { name = 'MS_AC_S2' },
                            [2] = { name = 'MS_MISSILE_AA_S1' } },
                description = 'Exo-assault trooper — single powered suit' },
    },
}
