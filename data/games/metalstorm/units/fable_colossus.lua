-- fable_colossus.lua — FW-15 "Fenrir" super-heavy assault walker.
--
-- Third generated-model showcase from tools/fable-model-forge/: a native
-- hand-built glTF authored by Claude Fable 5 in the Cowork sandbox,
-- spawnable via ?scenario=model-viewer&game=metalstorm&def=fable_colossus.
--
-- Model: models/fable_colossus.gltf (+.bin, 5 .ktx2) — 15 m hunched
-- bipedal titan, 5768 tris, 2048² atlas. Human-jointed legs with
-- articulated toes, werewolf lope. Pieces: body / turret(torso) / head /
-- arm_r → barrel(rotary cannon + missiles) → muzzle / arm_l →
-- flamer → muzzle2 / pack / pauldron_l / stack_r / thigh, shin, foot,
-- toes ×2 / exhaust. Clips walk (1.9 s predator lope: pelvis sway+bob,
-- torso counter-yaw, head gaze lock, toe flex), idle (head-led scan),
-- death (3.1 s: knees → forward topple; pauldron_l and stack_r BREAK
-- OFF via animated flights). pauldron_l/stack_r are cosmetic breakoff
-- pieces — keep them out of aim/muzzle logic. forward -Z, 1 u = 1 m,
-- SPRINGRTS_geometry v8, team mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.

return {
    fable_colossus = {
        name = 'FW-15 Fenrir',
        description = 'Fable assault titan — generated-model showcase',
        objectname = 'fable_colossus',
        category = 'LAND MOBILE',
        movementclass = 'HEAVY',
        maxdamage = 14000, mass = 3200,
        maxvelocity = 1.9, acceleration = 0.14, brakerate = 0.16, turnrate = 380,
        footprintx = 5, footprintz = 5,
        sightdistance = 560,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = {
            [1] = { name = 'MS_AC_S3' },        -- arm rotary cannon
            [2] = { name = 'MS_MISSILE_CRUISE_S1' },  -- pack/forearm racks
        },
        customparams = {
            ms_class = 'fable_showcase',
            squad_size = '1',
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
