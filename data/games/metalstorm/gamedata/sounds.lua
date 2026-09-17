-- Metalstorm SoundItems.
-- Native convention: file paths reference .webm (Opus) directly — there is
-- no source-format prune/rename step because nothing is converted
-- (PLAN-metalstorm.md §9; contrast PLAN-bar.md A8).
--
-- FX WIRING (weapon-fx pass): these SoundItem KEYS are what
-- weapons/weapons.lua `soundstart` and effects/weapon-fx.json `fireSound` /
-- `impactSound` resolve to.
--
-- CONTENT (2026-09-17 L-AUDIO pass): every file under sounds/ is now
-- self-authored layered synthesis via tools/audiogen (ASSETS.md "## Audio"
-- section has the row for every one, License "Original (...)") — replaces
-- the prior Warzone 2100 GPL + Kenney CC0 placeholder set entirely. This IS
-- the mix: gain/priority/maxdist below are tuned per key, not placeholders.
--
-- CLOSE / _FAR pairs: every weapon key has a `_far` sibling — the same
-- report, low-passed and attenuated by tools/audiogen's derive_far, for
-- distance playback. maxdist=900 on the close variant is deliberate: it is
-- the switch point PLAN-beta-presentation.md's L-AUDIO section specifies
-- ("distance switch at 900 elmos"). client/src/core/sound-events.ts's
-- chooseSoundKey() reads this maxdist at play() time and hands off to the
-- `_far` sibling once the listener is past it (falling back to the close
-- clip — silent beyond its own maxdist — if a key has no `_far` entry).
local SoundItems = {

    -- ── Weapon fire (keyed by weapons.lua soundstart) — close/_far pairs ──
    mg_volley = {
        file = 'sounds/weapons/mg_volley.webm',
        gain = 0.5, pitchmod = 0.08, dopplermod = 1.0, priority = 2,
        maxconcurrent = 6, maxdist = 900, in3d = true,
    },
    mg_volley_far = {
        file = 'sounds/weapons/mg_volley_far.webm',
        gain = 0.3, pitchmod = 0.05, dopplermod = 1.0, priority = 2,
        maxconcurrent = 6, maxdist = 2600, in3d = true,
    },
    ac_fire = {
        file = 'sounds/weapons/autocannon_fire.webm',
        gain = 0.7, pitchmod = 0.06, dopplermod = 1.0, priority = 4,
        maxconcurrent = 8, maxdist = 900, in3d = true,
    },
    ac_fire_far = {
        file = 'sounds/weapons/autocannon_fire_far.webm',
        gain = 0.45, pitchmod = 0.04, dopplermod = 1.0, priority = 4,
        maxconcurrent = 8, maxdist = 3200, in3d = true,
    },
    railgun_fire = {
        file = 'sounds/weapons/railgun_fire.webm',
        gain = 0.9, pitchmod = 0.03, dopplermod = 1.0, priority = 6,
        maxconcurrent = 5, maxdist = 900, in3d = true,
    },
    railgun_fire_far = {
        file = 'sounds/weapons/railgun_fire_far.webm',
        gain = 0.55, pitchmod = 0.02, dopplermod = 1.0, priority = 6,
        maxconcurrent = 5, maxdist = 4600, in3d = true,
    },
    mortar_fire = {
        file = 'sounds/weapons/mortar_fire.webm',
        gain = 0.7, pitchmod = 0.07, dopplermod = 1.0, priority = 4,
        maxconcurrent = 6, maxdist = 900, in3d = true,
    },
    mortar_fire_far = {
        file = 'sounds/weapons/mortar_fire_far.webm',
        gain = 0.45, pitchmod = 0.05, dopplermod = 1.0, priority = 4,
        maxconcurrent = 6, maxdist = 3600, in3d = true,
    },
    howitzer_fire = {
        file = 'sounds/weapons/howitzer_fire.webm',
        gain = 1.0, pitchmod = 0.04, dopplermod = 1.0, priority = 8,
        maxconcurrent = 5, maxdist = 900, in3d = true,
    },
    howitzer_fire_far = {
        file = 'sounds/weapons/howitzer_fire_far.webm',
        gain = 0.65, pitchmod = 0.03, dopplermod = 1.0, priority = 8,
        maxconcurrent = 5, maxdist = 6000, in3d = true,
    },
    missile_launch = {
        file = 'sounds/weapons/missile_launch.webm',
        gain = 0.8, pitchmod = 0.05, dopplermod = 1.0, priority = 5,
        maxconcurrent = 6, maxdist = 900, in3d = true,
    },
    missile_launch_far = {
        file = 'sounds/weapons/missile_launch_far.webm',
        gain = 0.5, pitchmod = 0.03, dopplermod = 1.0, priority = 5,
        maxconcurrent = 6, maxdist = 4200, in3d = true,
    },
    cruise_launch = {
        file = 'sounds/weapons/cruise_launch.webm',
        gain = 0.95, pitchmod = 0.03, dopplermod = 1.0, priority = 7,
        maxconcurrent = 4, maxdist = 900, in3d = true,
    },
    cruise_launch_far = {
        file = 'sounds/weapons/cruise_launch_far.webm',
        gain = 0.6, pitchmod = 0.02, dopplermod = 1.0, priority = 7,
        maxconcurrent = 4, maxdist = 5600, in3d = true,
    },
    torpedo_launch = {
        file = 'sounds/weapons/torpedo_launch.webm',
        gain = 0.7, pitchmod = 0.05, dopplermod = 1.0, priority = 4,
        maxconcurrent = 5, maxdist = 900, in3d = true,
    },
    torpedo_launch_far = {
        file = 'sounds/weapons/torpedo_launch_far.webm',
        gain = 0.45, pitchmod = 0.03, dopplermod = 1.0, priority = 4,
        maxconcurrent = 5, maxdist = 3400, in3d = true,
    },
    flak_fire = {
        file = 'sounds/weapons/flak_fire.webm',
        gain = 0.75, pitchmod = 0.06, dopplermod = 1.0, priority = 4,
        maxconcurrent = 8, maxdist = 900, in3d = true,
    },
    flak_fire_far = {
        file = 'sounds/weapons/flak_fire_far.webm',
        gain = 0.5, pitchmod = 0.04, dopplermod = 1.0, priority = 4,
        maxconcurrent = 8, maxdist = 3800, in3d = true,
    },
    bomb_release = {
        file = 'sounds/weapons/bomb_release.webm',
        gain = 0.6, pitchmod = 0.05, dopplermod = 1.0, priority = 3,
        maxconcurrent = 4, maxdist = 900, in3d = true,
    },
    bomb_release_far = {
        file = 'sounds/weapons/bomb_release_far.webm',
        gain = 0.4, pitchmod = 0.03, dopplermod = 1.0, priority = 3,
        maxconcurrent = 4, maxdist = 3200, in3d = true,
    },
    depthcharge_drop = {
        file = 'sounds/weapons/depthcharge_drop.webm',
        gain = 0.6, pitchmod = 0.05, dopplermod = 1.0, priority = 3,
        maxconcurrent = 4, maxdist = 900, in3d = true,
    },
    depthcharge_drop_far = {
        file = 'sounds/weapons/depthcharge_drop_far.webm',
        gain = 0.4, pitchmod = 0.03, dopplermod = 1.0, priority = 3,
        maxconcurrent = 4, maxdist = 3000, in3d = true,
    },

    -- ── Impacts / explosions (keyed by weapon-fx.json impactSound) ─────
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
    hit_dirt_small = {
        file = 'sounds/impacts/hit_dirt_small.webm',
        gain = 0.45, pitchmod = 0.10, dopplermod = 1.0, priority = 2,
        maxconcurrent = 8, maxdist = 2200, in3d = true,
    },
    hit_dirt_med = {
        file = 'sounds/impacts/hit_dirt_med.webm',
        gain = 0.6, pitchmod = 0.08, dopplermod = 1.0, priority = 3,
        maxconcurrent = 8, maxdist = 2600, in3d = true,
    },
    hit_water_small = {
        file = 'sounds/impacts/hit_water_small.webm',
        gain = 0.5, pitchmod = 0.08, dopplermod = 1.0, priority = 2,
        maxconcurrent = 8, maxdist = 2400, in3d = true,
    },
    hit_water_med = {
        file = 'sounds/impacts/hit_water_med.webm',
        gain = 0.65, pitchmod = 0.06, dopplermod = 1.0, priority = 3,
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

    -- ── Deaths per class (unit-fx.json `byClass[*].death` visual-effect
    -- names for reference — this table has no sound slot for death yet,
    -- see this fire's handoff notes) ────────────────────────────────────
    death_infantry = {
        file = 'sounds/deaths/death_infantry.webm',
        gain = 0.5, pitchmod = 0.10, dopplermod = 1.0, priority = 3,
        maxconcurrent = 8, maxdist = 2200, in3d = true,
    },
    death_vehicle_light = {
        file = 'sounds/deaths/death_vehicle_light.webm',
        gain = 0.7, pitchmod = 0.06, dopplermod = 1.0, priority = 4,
        maxconcurrent = 6, maxdist = 2800, in3d = true,
    },
    death_vehicle_heavy = {
        file = 'sounds/deaths/death_vehicle_heavy.webm',
        gain = 0.9, pitchmod = 0.04, dopplermod = 1.0, priority = 6,
        maxconcurrent = 4, maxdist = 4200, in3d = true,
    },
    death_aircraft = {
        file = 'sounds/deaths/death_aircraft.webm',
        gain = 0.8, pitchmod = 0.05, dopplermod = 1.0, priority = 5,
        maxconcurrent = 5, maxdist = 3800, in3d = true,
    },
    death_ship = {
        file = 'sounds/deaths/death_ship.webm',
        gain = 0.9, pitchmod = 0.04, dopplermod = 1.0, priority = 6,
        maxconcurrent = 3, maxdist = 4400, in3d = true,
    },
    death_building = {
        file = 'sounds/deaths/death_building.webm',
        gain = 0.85, pitchmod = 0.03, dopplermod = 1.0, priority = 5,
        maxconcurrent = 4, maxdist = 3600, in3d = true,
    },

    -- ── Ambience beds (wind / dust gust / distant artillery × 3 biomes).
    -- Non-positional (in3d=false) persistent background layers — the biome
    -- names reuse the audio.ts reverb-preset vocabulary (open/valley/urban)
    -- so a mission's `mapinfo.lua sound.preset` picks both the room tone
    -- AND the matching ambience bed with one string. looptime = the
    -- rendered clip length; nothing currently starts these beds from a map
    -- (see handoff notes) — they exist and resolve, ready to be triggered.
    amb_wind_open = {
        file = 'sounds/ambience/amb_wind_open.webm',
        gain = 0.3, priority = 1, maxconcurrent = 1, in3d = false, looptime = 20.0,
    },
    amb_wind_valley = {
        file = 'sounds/ambience/amb_wind_valley.webm',
        gain = 0.3, priority = 1, maxconcurrent = 1, in3d = false, looptime = 20.0,
    },
    amb_wind_urban = {
        file = 'sounds/ambience/amb_wind_urban.webm',
        gain = 0.3, priority = 1, maxconcurrent = 1, in3d = false, looptime = 20.0,
    },
    amb_dustgust_open = {
        file = 'sounds/ambience/amb_dustgust_open.webm',
        gain = 0.35, priority = 1, maxconcurrent = 1, in3d = false, looptime = 15.0,
    },
    amb_dustgust_valley = {
        file = 'sounds/ambience/amb_dustgust_valley.webm',
        gain = 0.35, priority = 1, maxconcurrent = 1, in3d = false, looptime = 15.0,
    },
    amb_dustgust_urban = {
        file = 'sounds/ambience/amb_dustgust_urban.webm',
        gain = 0.35, priority = 1, maxconcurrent = 1, in3d = false, looptime = 15.0,
    },
    amb_artillery_open = {
        file = 'sounds/ambience/amb_artillery_open.webm',
        gain = 0.4, priority = 2, maxconcurrent = 1, in3d = false, looptime = 30.0,
    },
    amb_artillery_valley = {
        file = 'sounds/ambience/amb_artillery_valley.webm',
        gain = 0.4, priority = 2, maxconcurrent = 1, in3d = false, looptime = 30.0,
    },
    amb_artillery_urban = {
        file = 'sounds/ambience/amb_artillery_urban.webm',
        gain = 0.4, priority = 2, maxconcurrent = 1, in3d = false, looptime = 30.0,
    },

    -- ── UI (open/close/confirm/refuse/notice) — radio-filtered mechanical
    -- readout tone per the art-direction audio brief; non-positional. ──
    ui_open = {
        file = 'sounds/ui/ui_open.webm',
        gain = 0.55, priority = 2, maxconcurrent = 4, in3d = false,
    },
    ui_close = {
        file = 'sounds/ui/ui_close.webm',
        gain = 0.55, priority = 2, maxconcurrent = 4, in3d = false,
    },
    ui_confirm = {
        file = 'sounds/ui/ui_confirm.webm',
        gain = 0.6, priority = 2, maxconcurrent = 4, in3d = false,
    },
    ui_refuse = {
        file = 'sounds/ui/ui_refuse.webm',
        gain = 0.6, priority = 2, maxconcurrent = 4, in3d = false,
    },
    ui_notice = {
        file = 'sounds/ui/ui_notice.webm',
        gain = 0.5, priority = 2, maxconcurrent = 4, in3d = false,
    },

    -- ── Music (music-director.ts playlist keys music_calm|tension|battle;
    -- `calm` is this content pass's name for the wire-protocol Peace state
    -- — see music-director.ts's stateByName alias). Streamed, not routed
    -- through the Web Audio buffer path — gain/priority/in3d are metadata
    -- only for these, kept for consistency with every other entry. ──────
    music_calm = {
        file = 'sounds/music/music_calm.webm',
        gain = 1.0, priority = 1, in3d = false, looptime = 100.0,
    },
    music_tension = {
        file = 'sounds/music/music_tension.webm',
        gain = 1.0, priority = 1, in3d = false, looptime = 100.0,
    },
    music_battle = {
        file = 'sounds/music/music_battle.webm',
        gain = 1.0, priority = 1, in3d = false, looptime = 110.0,
    },

    -- ── Unit loop / servo sounds (referenced by bindings.example.json) ─────
    engine_run = {
        file = 'sounds/units/engine_run.webm',
        gain = 0.4, pitchmod = 0.05, dopplermod = 1.0, priority = 1,
        maxconcurrent = 12, maxdist = 2000, in3d = true, loop = true,
    },
    -- turret_servo: DISABLED (unit props review 2026-08-20) — the asset
    -- sounds/units/turret_servo.webm does not exist (sounds/units/ holds only
    -- engine_run.webm). Only effects/bindings.example.json references the key,
    -- so nothing live breaks; restore this entry when the file is sourced.
    -- turret_servo = {
    --     file = 'sounds/units/turret_servo.webm',
    --     gain = 0.3, pitchmod = 0.04, dopplermod = 1.0, priority = 1,
    --     maxconcurrent = 8, maxdist = 1600, in3d = true, loop = true,
    -- },
}
return { SoundItems = SoundItems }
