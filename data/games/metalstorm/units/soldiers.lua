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
                -- not the only tier. 900 elmos ≈ where a ~1.8 m body is ≲20 px
                -- tall at 1080p (tune by eye in the Meridian pass).
                -- Ground-anchor lift: 0.3205 x the quad (measured off the
                -- shipped .gltf through the M2 baker's own framing()) — see
                -- _builder.lua. Half the quad would hover it ~2.1 elmos.
                impostorDistance = 900, impostorSize = 12,
                impostorCentreY = 3.8457,
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
