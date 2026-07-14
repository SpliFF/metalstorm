-- fable_heavy.lua — FV-20 "Bastion" super-heavy twin railgun tank.
--
-- Second generated-model showcase from tools/fable-model-forge/: a
-- native hand-built glTF authored by Claude Fable 5 in the Cowork
-- sandbox, spawnable via the model-viewer harness
-- (?scenario=model-viewer&game=metalstorm&def=fable_heavy).
--
-- Model: models/fable_heavy.gltf (+.bin, 5 .ktx2) — 2× fable_tank
-- length (20.3 m), 2394 tris, 2048² atlas (texel density matches the
-- 1024² fable_tank, so wear/seams read at the same world scale).
-- Pieces: body / tracks_l / tracks_r / turret / barrel (twin tubes) /
-- muzzle / muzzle_l / muzzle_r / turret2 / barrel2 / muzzle2 / exhaust.
-- turret2 is an INDEPENDENT secondary turret on the front-left sponson
-- — weapon [2] should aim it separately once cosmetic turret aim
-- (DESIGN-MODEL-BUILDING.md §16c) lands. forward -Z, 1 unit = 1 m,
-- SPRINGRTS_geometry v8, SPRINGRTS_team_color mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.

return {
    fable_heavy = {
        name = 'FV-20 Bastion',
        description = 'Fable super-heavy twin railgun tank — generated-model showcase',
        objectname = 'fable_heavy',
        category = 'LAND MOBILE TANK',
        movementclass = 'HEAVY',
        maxdamage = 9000, mass = 2800,
        maxvelocity = 1.4, acceleration = 0.10, brakerate = 0.12, turnrate = 320,
        footprintx = 6, footprintz = 6,
        sightdistance = 520,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = {
            [1] = { name = 'MS_RAILGUN_S4' },   -- twin main tubes (muzzle_l/_r)
            [2] = { name = 'MS_AC_S2' },        -- independent bow turret2
        },
        customparams = {
            ms_class = 'fable_showcase',
            squad_size = '1',            -- land dreadnought: always a single hull
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
