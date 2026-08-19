-- fable_battleship.lua — FNS "Sovereign" capital railgun battleship.
--
-- Fifth generated-model showcase from tools/fable-model-forge/: native
-- hand-built glTF authored by Claude Fable 5 in the Cowork sandbox,
-- spawnable via ?scenario=model-viewer&game=metalstorm&def=fable_battleship.
--
-- Model: models/fable_battleship.gltf (+.bin, 5 .ktx2) — s4 ship per
-- art/STYLE.md: 80 m hull, beam 12 m, mast radar 19.4 m. 6498 tris,
-- 2048² atlas. THREE aimable triple-railgun turret chains:
-- turret/barrel/muzzle (+muzzle_l/_r) fore, turret3/barrel3/muzzle3
-- superfiring, turret2/barrel2/muzzle2 aft (geometry baked facing +Z —
-- rest rotation stays identity per §2). `radar` spins in the looping
-- idle clip. Keel at Y=0; painted boot-top waterline at 1.35–1.95 m
-- (SHIP movedef handles draft in water). forward -Z, 1 u = 1 m,
-- SPRINGRTS_geometry v8, team mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.

return {
    fable_battleship = {
        name = 'FNS Sovereign',
        description = 'Fable capital battleship — generated-model showcase',
        objectname = 'fable_battleship',
        category = 'SHIP MOBILE',
        movementclass = 'SHIP',
        -- Stats aligned with ms_ships_s4 (2026-08-20 unitprops pass) so the
        -- showcase hull and the roster battleship agree: between BAR bats
        -- (9800) and epoch (50000). Mass matches the roster s4 (1500×8).
        maxdamage = 24000, mass = 12000,
        maxvelocity = 1.8, acceleration = 0.045, brakerate = 0.06, turnrate = 160,
        footprintx = 14, footprintz = 14,
        sightdistance = 700,
        -- The model's spinning mast radar is real intel, not set dressing;
        -- sonar so the capital ship is not blind to the torpedoes' shooters.
        radardistance = 1400, sonardistance = 600,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = {
            [1] = { name = 'MS_RAILGUN_S4' },        -- A turret
            [2] = { name = 'MS_RAILGUN_S3' },        -- C turret (aft)
            [3] = { name = 'MS_HOWITZER_S3' },       -- B superfiring
            [4] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' },           -- PDC screen
            [5] = { name = 'MS_MISSILE_CRUISE_S2' }, -- VLS
        },
        customparams = {
            ms_class = 'fable_showcase',
            squad_size = '1',
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
