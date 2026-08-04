-- Metalstorm SoundItems.
-- Native convention: file paths reference .webm (Opus) directly — there is
-- no source-format prune/rename step because nothing is converted
-- (PLAN-metalstorm.md §9; contrast PLAN-bar.md A8).
--
-- FX WIRING (weapon-fx pass): these SoundItem KEYS are what
-- weapons/weapons.lua `soundstart` and effects/weapon-fx.json `fireSound` /
-- `impactSound` resolve to. The .webm files under sounds/ are sourced CC0
-- (Kenney) with a GPL-2.0-or-later WZ2100 fallback for kinetic-weapon reports
-- that had no good CC0 equivalent — see ASSETS.md for the per-file license
-- rows (2026-07-26 SFX sourcing pass). Numbers are plausible placeholders,
-- not a mix.
local SoundItems = {

    -- ── Weapon fire (keyed by weapons.lua soundstart) ──────────────────────
    mg_volley = {
        file = 'sounds/weapons/mg_volley.webm',
        gain = 0.5, pitchmod = 0.08, dopplermod = 1.0, priority = 2,
        maxconcurrent = 6, maxdist = 2600, in3d = true,
    },
    ac_fire = {
        file = 'sounds/weapons/autocannon_fire.webm',
        gain = 0.7, pitchmod = 0.06, dopplermod = 1.0, priority = 4,
        maxconcurrent = 8, maxdist = 3000, in3d = true,
    },
    railgun_fire = {
        file = 'sounds/weapons/railgun_fire.webm',
        gain = 0.9, pitchmod = 0.03, dopplermod = 1.0, priority = 6,
        maxconcurrent = 5, maxdist = 4200, in3d = true,
    },
    mortar_fire = {
        file = 'sounds/weapons/mortar_fire.webm',
        gain = 0.7, pitchmod = 0.07, dopplermod = 1.0, priority = 4,
        maxconcurrent = 6, maxdist = 3200, in3d = true,
    },
    howitzer_fire = {
        file = 'sounds/weapons/howitzer_fire.webm',
        gain = 1.0, pitchmod = 0.04, dopplermod = 1.0, priority = 7,
        maxconcurrent = 5, maxdist = 5200, in3d = true,
    },
    missile_launch = {
        file = 'sounds/weapons/missile_launch.webm',
        gain = 0.8, pitchmod = 0.05, dopplermod = 1.0, priority = 5,
        maxconcurrent = 6, maxdist = 3600, in3d = true,
    },
    cruise_launch = {
        file = 'sounds/weapons/cruise_launch.webm',
        gain = 0.95, pitchmod = 0.03, dopplermod = 1.0, priority = 7,
        maxconcurrent = 4, maxdist = 5000, in3d = true,
    },
    torpedo_launch = {
        file = 'sounds/weapons/torpedo_launch.webm',
        gain = 0.7, pitchmod = 0.05, dopplermod = 1.0, priority = 4,
        maxconcurrent = 5, maxdist = 3000, in3d = true,
    },
    flak_fire = {
        file = 'sounds/weapons/flak_fire.webm',
        gain = 0.75, pitchmod = 0.06, dopplermod = 1.0, priority = 4,
        maxconcurrent = 8, maxdist = 3400, in3d = true,
    },
    bomb_release = {
        file = 'sounds/weapons/bomb_release.webm',
        gain = 0.6, pitchmod = 0.05, dopplermod = 1.0, priority = 3,
        maxconcurrent = 4, maxdist = 2800, in3d = true,
    },
    depthcharge_drop = {
        file = 'sounds/weapons/depthcharge_drop.webm',
        gain = 0.6, pitchmod = 0.05, dopplermod = 1.0, priority = 3,
        maxconcurrent = 4, maxdist = 2600, in3d = true,
    },

    -- ── Impacts / explosions (keyed by weapon-fx.json impactSound) ─────────
    hit_metal_small = {
        file = 'sounds/impacts/hit_metal_small.webm',
        gain = 0.5, pitchmod = 0.10, dopplermod = 1.0, priority = 2,
        maxconcurrent = 8, maxdist = 2400, in3d = true,
    },
    hit_metal_med = {
        file = 'sounds/impacts/hit_metal_med.webm',
        gain = 0.65, pitchmod = 0.08, dopplermod = 1.0, priority = 3,
        maxconcurrent = 8, maxdist = 2800, in3d = true,
    },
    hit_rail = {
        file = 'sounds/impacts/hit_rail.webm',
        gain = 0.8, pitchmod = 0.05, dopplermod = 1.0, priority = 5,
        maxconcurrent = 6, maxdist = 3600, in3d = true,
    },
    blast_small = {
        file = 'sounds/explosions/blast_small.webm',
        gain = 0.7, pitchmod = 0.08, dopplermod = 1.0, priority = 4,
        maxconcurrent = 8, maxdist = 3200, in3d = true,
    },
    blast_med = {
        file = 'sounds/explosions/blast_med.webm',
        gain = 0.85, pitchmod = 0.06, dopplermod = 1.0, priority = 5,
        maxconcurrent = 6, maxdist = 4200, in3d = true,
    },
    blast_large = {
        file = 'sounds/explosions/blast_large.webm',
        gain = 1.0, pitchmod = 0.04, dopplermod = 1.0, priority = 7,
        maxconcurrent = 5, maxdist = 5600, in3d = true,
    },
    blast_huge = {
        file = 'sounds/explosions/blast_huge.webm',
        gain = 1.0, pitchmod = 0.03, dopplermod = 1.0, priority = 9,
        maxconcurrent = 3, maxdist = 8000, in3d = true,
    },
    blast_air = {
        file = 'sounds/explosions/blast_air.webm',
        gain = 0.7, pitchmod = 0.07, dopplermod = 1.0, priority = 4,
        maxconcurrent = 8, maxdist = 3600, in3d = true,
    },
    blast_water = {
        file = 'sounds/explosions/blast_water.webm',
        gain = 0.75, pitchmod = 0.06, dopplermod = 1.0, priority = 4,
        maxconcurrent = 6, maxdist = 3400, in3d = true,
    },
    shield_hit = {
        file = 'sounds/impacts/shield_hit.webm',
        gain = 0.6, pitchmod = 0.08, dopplermod = 1.0, priority = 3,
        maxconcurrent = 6, maxdist = 2800, in3d = true,
    },

    -- ── Unit loop / servo sounds (referenced by bindings.example.json) ─────
    engine_run = {
        file = 'sounds/units/engine_run.webm',
        gain = 0.4, pitchmod = 0.05, dopplermod = 1.0, priority = 1,
        maxconcurrent = 12, maxdist = 2000, in3d = true, loop = true,
    },
    turret_servo = {
        file = 'sounds/units/turret_servo.webm',
        gain = 0.3, pitchmod = 0.04, dopplermod = 1.0, priority = 1,
        maxconcurrent = 8, maxdist = 1600, in3d = true, loop = true,
    },
}
return { SoundItems = SoundItems }
