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
                -- Member LOD (PLAN-metalstorm-impostors.md M4): 3D body up close
                -- (models/ms_engineers_s1.gltf), baked directional sprite far
                -- (models/ms_engineers_s1_impostor{,_team}.ktx2). See soldiers.lua.
                -- Size + ground-anchor lift measured off the SHIPPED sheet
                -- (2026-08-03 M5 live pass) — see soldiers.lua for the method
                -- and for what the old 12 / 4.0109 pair got wrong.
                impostorDistance = 260, impostorSize = 2.3056,
                impostorCentreY = 0.9175,
                impostorTeamMask = true },
        [2] = { override = { workertime = 120 } },
        [3] = { override = { workertime = 300,
                description = 'Heavy construction rig pair' } },
        [4] = { override = { workertime = 800,
                description = 'Mobile fabrication platform — single vast crawler' } },
    },
}
