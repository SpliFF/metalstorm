-- fable_mech.lua — MW-3 "Strider" reverse-joint recon walker.
--
-- Second generated-model PoC (the mech half of the tank+mech gate,
-- PLAN-metalstorm-beta-units.md §1): native hand-built glTF authored by
-- Claude Fable 5 in the Cowork sandbox (tools/fable-model-forge/), sized
-- to exactly fable_tank's height (3.18 m) for side-by-side judging.
--
-- Model: models/fable_mech.gltf (+.bin, 4 .ktx2) — pieces body /
-- turret(torso yaw) / barrel(arm railgun) / muzzle / exhaust +
-- thigh/shin/foot ×2 (reverse-joint, pivots at the joints), 854 tris,
-- SPRINGRTS_geometry v8. Ships AUTHORED CLIPS: walk (1.2 s loop, classic
-- contact/down/passing/up cycle), idle (3.6 s scan), death (1.8 s
-- backward collapse, holds final frame) — playable from the model-viewer
-- clip buttons (task 6). Licensing: Generated rows in ../ASSETS.md.

return {
    fable_mech = {
        name = 'MW-3 Strider',
        description = 'Fable recon walker — generated-model showcase (authored clips)',
        objectname = 'fable_mech',
        category = 'LAND MOBILE MECH',   -- MECH type token, matches units/mechs.lua
        movementclass = 'VEH',   -- tank-slot stand-in; see the MECH moveclass
                                 -- proposal in .unitprops/agent-mechs.md
        maxdamage = 800, mass = 240,
        -- Recon-walker ballpark (≈ BAR Pawn at this game's HP scale):
        -- 78 e/s, walker-quick turn. Sits beside ms_mechs_s1 (84 e/s).
        maxvelocity = 2.6, acceleration = 0.3, brakerate = 0.28, turnrate = 1200,
        footprintx = 2, footprintz = 2,
        sightdistance = 550,   -- recon role: sees further than it shoots
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        -- Liftable by airship/landing ship (both carry transportsize 3).
        transportsize = 2, transportbyenemy = false,
        weapons = { [1] = { name = 'MS_AC_S2' } },
        customparams = {
            ms_class = 'fable_showcase',
            squad_size = '1',
            generator = 'Claude Fable 5 (tools/fable-model-forge)',
        },
    },
}
