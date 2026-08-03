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
            impostor_distance = '900', impostor_size = '11',
            -- The `infantry_v2` atlas convention (impostor_convention.py
            -- INFANTRY_V2), declared per atlas — see _builder.lua for why the
            -- runtime must be told rather than assume. Phase 180 = column 0 is
            -- the FRONT view; the arc is the elevations the rows were baked at.
            impostor_yaw_bins = '8', impostor_pitch_bins = '3', impostor_frames = '1',
            impostor_azimuth_phase = '180', impostor_pitch_degrees = '15,45,80',
            -- Ground-anchor lift (0.3323 x the quad), measured off the shipped
            -- .gltf through the M2 baker's framing(); half the quad would
            -- hover the sprite ~1.8 elmos above the terrain.
            impostor_centre_y = '3.6554',
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
            impostor_distance = '900', impostor_size = '11',
            impostor_team_mask = '1',
            -- `infantry_v2` convention + measured ground-anchor lift (0.3186 x
            -- the quad) — see ms_civilians above and _builder.lua.
            impostor_yaw_bins = '8', impostor_pitch_bins = '3', impostor_frames = '1',
            impostor_azimuth_phase = '180', impostor_pitch_degrees = '15,45,80',
            impostor_centre_y = '3.5050',
        },
    },
}
