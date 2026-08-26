-- Civilians — unarmed and lightly armed population (PLAN-metalstorm.md §7).
-- Not part of the 4-scale system; run by the environment AI (ai/civilian).
-- Substrate for protect / escort / extract objectives.
return {
    ms_civilians = {
        name = 'Civilians',
        description = 'Unarmed civilian group',
        objectname = 'ms_civilians',
        category = 'LAND MOBILE CIVILIAN',
        movementclass = 'INFANTRY',
        maxdamage = 200, mass = 60,
        maxvelocity = 1.4, acceleration = 0.3, brakerate = 0.3, turnrate = 1500,
        footprintx = 2, footprintz = 2,
        sightdistance = 250,
        canmove = true, canattack = false, canpatrol = true, canstop = true,
        customparams = {
            ms_class = 'civilians', civilian = '1',
            squad_size = '12', formation_type = 'blob', formation_radius = '20',
            -- Member LOD (PLAN-metalstorm-impostors.md M4): 3D body up close
            -- (models/ms_civilians.gltf), baked directional sprite far
            -- (models/ms_civilians_impostor.ktx2 — deliberately no team mask,
            -- civilians read as neutral population).
            -- WORLD-SCALE ×8 2026-08-27 (PLAN-world-scale.md §5 Option A):
            -- size 2.2559→18.0472, centre_y 0.7470→5.9760, distance 260→2080
            -- — see soldiers.lua; checked by tools/scripts/check_model_scale.py.
            impostor_distance = '2080', impostor_size = '18.0472',
            -- The `infantry_v2` atlas convention (impostor_convention.py
            -- INFANTRY_V2), declared per atlas — see _builder.lua for why the
            -- runtime must be told rather than assume. Phase 180 = column 0 is
            -- the FRONT view; the arc is the elevations the rows were baked at.
            impostor_yaw_bins = '8', impostor_pitch_bins = '3', impostor_frames = '1',
            impostor_azimuth_phase = '180', impostor_pitch_degrees = '15,45,80',
            -- Ground-anchor lift = the baker's own `centreY`, i.e. the model's
            -- bbox-centre Y, because each cell is framed centred on that point.
            -- CORRECTED 2026-08-03 (M5 live pass) from 3.6554, which had been
            -- derived from an assumed 11-elmo quad rather than measured off the
            -- shipped sheet. See soldiers.lua.
            -- CORRECTED AGAIN 2026-08-03 (M11 fire 2), 0.9000 -> 0.7470:
            -- measured hover 0.1530 elmos. See _builder.lua.
            -- WORLD-SCALE ×8 2026-08-27: 0.7470→5.9760.
            impostor_centre_y = '5.9760',
        },
    },
    ms_militia = {
        name = 'Militia',
        description = 'Lightly armed civilian volunteers',
        objectname = 'ms_militia',
        category = 'LAND MOBILE CIVILIAN',
        movementclass = 'INFANTRY',
        maxdamage = 300, mass = 70,
        maxvelocity = 1.5, acceleration = 0.3, brakerate = 0.3, turnrate = 1400,
        footprintx = 2, footprintz = 2,
        sightdistance = 300,
        canmove = true, canattack = true, canpatrol = true, canstop = true,
        canguard = true,
        weapons = { [1] = { name = 'MS_MG_S1' } },
        customparams = {
            ms_class = 'civilians', civilian = '1',
            squad_size = '8', formation_type = 'blob', formation_radius = '18',
            -- Member LOD (PLAN-metalstorm-impostors.md M4): 3D body up close
            -- (models/ms_militia.gltf), baked directional sprite far; militia
            -- get a team armband (models/ms_militia_impostor{,_team}.ktx2).
            -- WORLD-SCALE ×8 2026-08-27 (PLAN-world-scale.md §5 Option A):
            -- size 2.3227→18.5816, centre_y 0.7544→6.0352, distance 260→2080
            -- — see soldiers.lua; checked by tools/scripts/check_model_scale.py.
            impostor_distance = '2080', impostor_size = '18.5816',
            impostor_team_mask = '1',
            -- `infantry_v2` convention + size/lift measured off the shipped
            -- sheet (2026-08-03 M5 live pass; was 11 / 3.5050) — see
            -- ms_civilians above and _builder.lua.
            impostor_yaw_bins = '8', impostor_pitch_bins = '3', impostor_frames = '1',
            impostor_azimuth_phase = '180', impostor_pitch_degrees = '15,45,80',
            -- CORRECTED AGAIN 2026-08-03 (M11 fire 2), 0.9075 -> 0.7544:
            -- measured hover 0.1531 elmos. See _builder.lua.
            -- WORLD-SCALE ×8 2026-08-27: 0.7544→6.0352.
            impostor_centre_y = '6.0352',
        },
    },
}
