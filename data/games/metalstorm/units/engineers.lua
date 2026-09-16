-- Engineers — construction/repair squads. Unarmed; accelerate building
-- (construction is time-gated, engineers speed it up — PLAN-metalstorm.md §8).
-- Battles get FIELD ENGINEERING only (trenches/barricades/towers/repairs) —
-- engineers carry NO buildoptions: they assist/repair what sites and factories
-- stage, they do not open a build menu. squad.lua's AllowCommand gates their
-- REPAIR to build-assist (buildProgress < 1) and forbids RECLAIM outright, so
-- canreclaim is deliberately absent here.
local mk = VFS.Include('units/_builder.lua')

-- Every scale is a working builder: `workertime` alone does nothing without
-- builder = true, and the engine needs a builddistance for the assist reach
-- (the field workshop in buildings_support.lua is the static reference:
-- workertime 80, builddistance 300).
local function crew(workertime, builddistance, extra)
    local t = {
        builder = true, workertime = workertime,
        builddistance = builddistance,
        canrepair = true, canassist = true,
        transportbyenemy = false,
    }
    for k, v in pairs(extra or {}) do t[k] = v end
    return t
end

return mk{
    class = 'engineers', label = 'Engineer',
    category = 'LAND MOBILE INFANTRY',
    movementclass = 'INFANTRY',
    canattack = false,
    -- baseSpeed 1.4 e/f = 42 e/s at s1 — same walking-pace fix as soldiers.lua.
    baseHp = 300, baseMass = 80, baseSpeed = 1.4, baseSquad = 8,
    baseFootprint = 2,
    -- s1-s2 share the soldiers body plan (gen_infantry.py) — same ground
    -- extent, plus a hard hat and a wrench. See soldiers.lua for the
    -- derivation. NEITHER s3 NOR s4 is a person: ms_engineers_s4.gltf is a
    -- 10.5 x 19.9 m tracked fabrication crawler (2026-08-20) and, since
    -- 2026-09-17, ms_engineers_s3.gltf is a 3.1 x 5.9 m tracked works rig —
    -- the model the s3 override has described ("rig pair", VEH, footprint 3)
    -- since it was written. Both clearances are the measured hull, not the
    -- infantry stance: the old 0.95 gave a 20 m crawler a 4-elmo clearance
    -- and a 10 m footprint, and the old 0.8 packed two 6 m rigs into a metre
    -- of ground (units-assets review 2026-09-10 finding 4).
    sizes = { 0.7, 0.75, 5.9, 19.9 },
    scales = {
        [1] = { -- 60 HP per member × 8 (builder default 300 gave 37.5/member).
                maxdamage = 480,
                override = crew(50, 120,
                    { description = 'Field engineer team — repairs and light works' }),
                -- Member LOD (PLAN-metalstorm-impostors.md M4): 3D body up close
                -- (models/ms_engineers_s1.gltf), baked directional sprite far
                -- (models/ms_engineers_s1_impostor{,_team}.ktx2). See soldiers.lua.
                -- Size + ground-anchor lift measured off the SHIPPED sheet
                -- (2026-08-03 M5 live pass) — see soldiers.lua for the method
                -- and for what the old 12 / 4.0109 pair got wrong.
                -- centreY CORRECTED AGAIN 2026-08-03 (M11 fire 2), 0.9175 ->
                -- 0.7759: measured hover 0.1416 elmos (20 deg / 45 deg).
                -- RE-CALIBRATED 2026-08-20 (texture-enrichment rebake) — see
                -- soldiers.lua for the pixel-derivation; quad from the new
                -- bake's json, lift from the pitch-15 ground rows.
                -- WORLD-SCALE ×8 2026-08-27 (PLAN-world-scale.md §5 Option A)
                -- applied on the re-calibrated values: size 1.9990→15.9920,
                -- centreY 0.9370→7.4960, distance 260→2080 — see soldiers.lua.
                impostorDistance = 2080, impostorSize = 15.9920,
                impostorCentreY = 7.4960,
                impostorTeamMask = true },
        [2] = { -- footprint 2, not the builder's 3: still a foot squad, and it
                -- must fit the landing ship's transportsize (3).
                footprint = 2,
                override = crew(120, 140) },
        [3] = { -- A rig PAIR is vehicles, not infantry: VEH movedef (24° slope,
                -- real crush) instead of the 45°-slope foot class. One squad
                -- MEMBER is one rig (models/ms_engineers_s3.gltf, 2026-09-17:
                -- blade, glazed cab, fabrication deck, stowed A-frame jib);
                -- the def's squad of two is the "pair". No impostor sheet —
                -- it is a vehicle tier now, not one of the four infantry
                -- bodies the impostor lane bakes.
                footprint = 3,
                override = crew(300, 180, {
                    description = 'Heavy construction rig pair',
                    movementclass = 'VEH',
                    category = 'LAND MOBILE VEHICLE' }) },
        [4] = { -- Single vast crawler: HEAVY movedef, and too big to lift
                -- (footprint 5 exceeds every carrier's transportsize anyway).
                override = crew(800, 240, {
                    description = 'Mobile fabrication platform — single vast crawler',
                    movementclass = 'HEAVY',
                    category = 'LAND MOBILE VEHICLE',
                    cantbetransported = true }) },
    },
}
