-- fable_carrier.lua — FCV-8 "Bastion" fleet carrier.
--
-- Eighth generated-model showcase from tools/fable-model-forge/: native
-- hand-built glTF authored by Claude Fable 5 in the Cowork sandbox,
-- spawnable via ?scenario=model-viewer&game=metalstorm&def=fable_carrier.
--
-- Model: models/fable_carrier.gltf (+.bin, 5 .ktx2) — ~102 m sci-fi
-- fleet carrier (a shade over the s4 ship row: it operates the 15 m
-- FA-6), 2038 tris, 2048² atlas. Full flight deck: TWO EM catapult
-- lanes with glowing rails + jet blast deflectors at the bow, ~2°
-- angled recovery strip with arrestor wires aft, painted parking for
-- 2 fighters (herringbone), 1 compact bomber and 4 helo spads. Twin
-- starboard islands (navigation + flyco), rotating `radar`, aimable
-- PDC chain turret/barrel/muzzle on the bow sponson. The port
-- deck-edge `elevator` is a separate piece carrying a deck-park
-- fighter — it cycles down past the recessed hangar mouth to the
-- hangar deck and back in the 16 s idle clip.
--
-- Air-base contract: pad empties pad1–pad7 sit at the painted parking
-- spots (4 helo, 2 fighter, 1 bomber). Engine-side, landing pads are
-- game-Lua driven (ZK unit_air_pads pattern): the unit script's
-- QueryLandingPad returns pad pieces and customparams.pad_count
-- advertises capacity (see zk shipcarrier.lua). Keel Y=0 (SHIP
-- movedef handles draft), painted boot-top. forward -Z, 1 u = 1 m,
-- SPRINGRTS_geometry v8, team mask on materials[0].
-- Licensing: see the Generated rows in ../ASSETS.md.

return {
    fable_carrier = {
        name = 'FCV-8 Bastion',
        description = 'Fable fleet carrier — generated-model showcase',
        objectname = 'fable_carrier',
        category = 'SHIP MOBILE',
        movementclass = 'SHIP',
        maxdamage = 26000, mass = 7000,
        maxvelocity = 1.4, acceleration = 0.04, brakerate = 0.05, turnrate = 150,
        footprintx = 16, footprintz = 16,
        sightdistance = 750, airsightdistance = 900,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = {
            [1] = { name = 'MS_FLAK_S2' },           -- PDC chain (bow)
            [2] = { name = 'MS_MISSILE_AA_S2' },     -- point defence
        },
        customparams = {
            ms_class = 'fable_showcase',
            squad_size = '1',
            pad_count = '7',                          -- pad1..pad7 empties
            pad_pieces = 'pad1,pad2,pad3,pad4,pad5,pad6,pad7',
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
