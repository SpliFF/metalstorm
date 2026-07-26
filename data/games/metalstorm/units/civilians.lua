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
            -- Impostor-first (PLAN-metalstorm-beta-units.md §2.1 roster:
            -- civilian-on-foot ships with no 3D model). Authored sprite:
            -- models/ms_civilians_impostor.ktx2 — deliberately no team mask,
            -- civilians read as neutral population.
            impostor_only = '1', impostor_size = '11',
            -- v2 directional atlas grid (8 yaw × 3 pitch × 1 frame), matching
            -- bake_impostors.py / impostor_convention.py (M3).
            impostor_yaw_bins = '8', impostor_pitch_bins = '3', impostor_frames = '1',
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
            -- Impostor-first like ms_civilians; militia get a team armband
            -- (models/ms_militia_impostor{,_team}.ktx2).
            impostor_only = '1', impostor_size = '11',
            impostor_team_mask = '1',
            -- v2 directional atlas grid (8 yaw × 3 pitch × 1 frame), matching
            -- bake_impostors.py / impostor_convention.py (M3).
            impostor_yaw_bins = '8', impostor_pitch_bins = '3', impostor_frames = '1',
        },
    },
}
