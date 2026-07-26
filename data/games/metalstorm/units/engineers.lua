-- Engineers — construction/repair squads. Unarmed; accelerate building
-- (construction is time-gated, engineers speed it up — PLAN-metalstorm.md §8).
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'engineers', label = 'Engineer',
    category = 'LAND MOBILE',
    movementclass = 'INFANTRY',
    canattack = false,
    baseHp = 300, baseMass = 80, baseSpeed = 1.8, baseSquad = 8,
    baseFootprint = 2,
    scales = {
        [1] = { override = { workertime = 50,
                description = 'Field engineer team — repairs and light works' },
                -- Impostor-first per PLAN-metalstorm-beta-units.md §2.1.
                -- Authored sprite: models/ms_engineers_s1_impostor{,_team}.ktx2.
                impostorOnly = true, impostorSize = 12,
                impostorTeamMask = true },
        [2] = { override = { workertime = 120 } },
        [3] = { override = { workertime = 300,
                description = 'Heavy construction rig pair' } },
        [4] = { override = { workertime = 800,
                description = 'Mobile fabrication platform — single vast crawler' } },
    },
}
