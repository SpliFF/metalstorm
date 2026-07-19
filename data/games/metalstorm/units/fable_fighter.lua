-- fable_fighter.lua — FA-6 "Shrike" air-superiority fighter.
--
-- Seventh generated-model showcase from tools/fable-model-forge/: native
-- hand-built glTF authored by Claude Fable 5 in the Cowork sandbox,
-- spawnable via ?scenario=model-viewer&game=metalstorm&def=fable_fighter.
--
-- Model: models/fable_fighter.gltf (+.bin, 5 .ktx2) — s3 fighter per
-- art/STYLE.md: 12 m wingspan, ~15 m nose-to-nozzle, 1255 tris,
-- 2048² atlas. Chined hex-loft fuselage, gold canopy, shoulder wings
-- over boxy intakes, underwing pylon + wingtip rail AA missiles, twin
-- canted fins, twin afterburner nozzles (emissive burner). Landing
-- gear ships as separate pieces gear_n / gear_l / gear_r so a future
-- unit script can Hide() them once airborne (same forward-compat
-- pattern as the airship's link pieces). `muzzle` sits at the chin
-- autocannon, `muzzle2` at the port pylon missile tip. Rests on its
-- wheels at Y=0; forward -Z, 1 u = 1 m, SPRINGRTS_geometry v8, team
-- mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.

return {
    fable_fighter = {
        name = 'FA-6 Shrike',
        description = 'Fable air-superiority fighter — generated-model showcase',
        objectname = 'fable_fighter',
        category = 'AIR MOBILE',
        canfly = true,                 -- fixedwing: no hoverattack, strafes
        collide = false,
        cruisealtitude = 180,
        maxdamage = 900, mass = 220,
        maxvelocity = 9.0, acceleration = 0.9, brakerate = 0.3, turnrate = 900,
        footprintx = 4, footprintz = 4,
        sightdistance = 650,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = {
            [1] = { name = 'MS_AC_S2' },          -- chin autocannon
            [2] = { name = 'MS_MISSILE_AA_S2' },  -- wing AA missiles
        },
        customparams = {
            ms_class = 'fable_showcase',
            squad_size = '1',
            gear_pieces = 'gear_n,gear_l,gear_r',  -- Hide() when airborne
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
