-- fable_bomber.lua — FB-9 "Petrel" compact strike bomber.
--
-- Ninth generated-model showcase from tools/fable-model-forge/: native
-- hand-built glTF authored by Claude Fable 5 in the Cowork sandbox,
-- spawnable via ?scenario=model-viewer&game=metalstorm&def=fable_bomber.
--
-- Model: models/fable_bomber.gltf (+.bin, 5 .ktx2) — s2 compact bomber
-- per art/STYLE.md: 12 m wingspan, ~11 m long, 945 tris, 2048² atlas.
-- The airframe the FCV-8 carrier's bomber spot was sized for: blended
-- flattened fuselage, wide side-by-side canopy, twin dorsal intakes,
-- cranked delta wings with wing-mounted canted fins, two chunky finned
-- bombs on pylons, closed belly bomb bay (painted doors, `muzzle`
-- release empty at its centre), over-tail nozzles with burner glow.
-- Landing gear ships as hideable pieces gear_n/gear_l/gear_r (§24
-- pattern). Rests on its wheels at Y=0; forward -Z, 1 u = 1 m,
-- SPRINGRTS_geometry v8, team mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.

return {
    fable_bomber = {
        name = 'FB-9 Petrel',
        description = 'Fable compact strike bomber — generated-model showcase',
        objectname = 'fable_bomber',
        category = 'AIR MOBILE',
        canfly = true,                 -- fixedwing bombing runs
        collide = false,
        cruisealtitude = 160,          -- was 200: matches ms_bombers_s2 band
        maxdamage = 1100, mass = 300,
        -- Strafing bombers IGNORE `acceleration` — UnitDef.cpp re-reads
        -- `maxacc` (default 0.065) for IsBomberAirUnit; the old 0.5 was
        -- never applied. BAR T1 bomber anchors: maxacc 0.0575 / maxdec 0.05.
        maxvelocity = 6.2, maxacc = 0.058, maxdec = 0.05,
        turnradius = 100,              -- engine doubles the 500 default for bombers
        footprintx = 4, footprintz = 4,
        sightdistance = 600,
        airsightdistance = 800,        -- engine default is only 1.5×sight
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = {
            [1] = { name = 'MS_BOMB_S2',          -- belly bay
                    onlytargetcategory = 'LAND SHIP SUB' },
        },
        customparams = {
            ms_class = 'fable_showcase',
            squad_size = '1',
            gear_pieces = 'gear_n,gear_l,gear_r',  -- Hide() when airborne
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
