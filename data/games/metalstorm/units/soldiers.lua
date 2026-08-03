-- Soldiers — infantry squads. Kinetic small arms (PLAN-metalstorm.md §6).
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'soldiers', label = 'Infantry',
    category = 'LAND MOBILE INFANTRY',
    movementclass = 'INFANTRY',
    baseHp = 400, baseMass = 90, baseSpeed = 1.8, baseSquad = 16,
    baseFootprint = 2, formation = 'line',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MG_S1' } },
                description = 'Rifle section — numerous and expendable',
                -- Member LOD (PLAN-metalstorm-impostors.md M4): a real low-poly
                -- 3D body (models/ms_soldiers_s1.gltf) draws each squad member
                -- up close; beyond impostorDistance the baked directional
                -- sprite (models/ms_soldiers_s1_impostor{,_team}.ktx2) takes
                -- over. No longer impostorOnly — the sprite is the FAR tier,
                -- not the only tier.
                -- CORRECTED 2026-08-03 (M5 live pass): size/centreY were 12 /
                -- 3.8457, derived from an assumed 12-elmo quad rather than
                -- measured. Both are now read off the SHIPPED sheet: the cell
                -- covers 2.3615 elmos of world (mean over 6 cells, spread 1%),
                -- and the baker centres each cell on the model's bbox centre,
                -- so centreY IS that centre's Y (0.9225). The old numbers drew
                -- the sprite ~5x the 1.845-elmo 3D body it swaps with.
                -- centreY CORRECTED AGAIN 2026-08-03 (M11 fire 2), 0.9225 ->
                -- 0.7650: the bbox-centre value made the sprite hover 0.1575
                -- elmos above the model it swaps with. Measured in-game at two
                -- camera pitches (20 deg, 45 deg), which agree to 0.0003; then
                -- confirmed by re-measuring the residual after the edit landed.
                -- See _builder.lua for the method and its two traps.
                impostorDistance = 260, impostorSize = 2.3615,
                impostorCentreY = 0.7650,
                impostorTeamMask = true },
        [2] = { weapons = { [1] = { name = 'MS_MG_S2' } } },
        [3] = { weapons = { [1] = { name = 'MS_AC_S1' },
                            [2] = { name = 'MS_MORTAR_S1' } },
                description = 'Heavy weapons team — autocannon + mortar' },
        [4] = { weapons = { [1] = { name = 'MS_AC_S2' },
                            [2] = { name = 'MS_MISSILE_AA_S1' } },
                description = 'Exo-assault trooper — single powered suit' },
    },
}
