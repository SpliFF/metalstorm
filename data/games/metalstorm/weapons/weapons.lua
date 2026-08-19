-- Metalstorm weapon definitions — kinetic sci-fi (PLAN-metalstorm.md §6):
-- explosive/projectile weapons dominate, no beam weapons in the base set.
-- Families × scale variants generated from one spec table.
--
-- customparams.resolution (PLAN-metalstorm-combat-resolution.md §1; the engine
-- also accepts the legacy key `combat_model` as an alias):
--   "statistical" → Model 1 per-volley resolution, no projectile spawned
--   "ballistic"   → full projectile sim (arcs / interception matter); the
--                   engine maps this legacy value onto the faithful "sim" path
-- Statistical families may also set (customparams, all optional):
--   stat_base_accuracy, stat_accuracy_falloff, stat_move_penalty,
--   stat_height_bonus, min_volley_damage (E6 damage floor),
--   skip_fire_strength (E6 hold-fire below this strength fraction; 0 = off),
--   targeting_cadence,
--   stat_min_fire_chance (hold-fire floor, default 0.05 — a volley whose
--     computed hit chance is below this is NOT fired at all: no sound, no
--     tracer/FX, no reload cycle, no resource spend, target and aim kept, fire
--     resumes by itself once the chance climbs back. Kills the max-range
--     plinking stalemate. Set 0 to disable the gate for a weapon, e.g. if it
--     is ever meant to lay deliberate suppression fire.
--     PLAN-metalstorm-combat-fixes.md §A).
-- STUB QUALITY: placeholder numbers, not balance.

local defs = {
    -- Engine fallback for units without an explicit death explosion.
    NOWEAPON = {
        name = 'No Weapon', weapontype = 'Cannon',
        range = 10, reloadtime = 1, damage = { default = 0 },
        areaofeffect = 0, soundstart = '', noexplode = 1,
    },
}

local function family(prefix, base, scales)
    for s, o in ipairs(scales) do
        local w = {}
        for k, v in pairs(base) do w[k] = v end
        for k, v in pairs(o) do w[k] = v end
        w.damage = { default = o.dmg or 50 }
        w.dmg = nil
        w.customparams = w.customparams or {}
        w.customparams.resolution = w.customparams.resolution
            or base.customparams.resolution
        defs[prefix .. '_S' .. s] = w
    end
end

-- Machine guns — squad small arms. Statistical volleys.
family('MS_MG', {
    weapontype = 'Cannon', weaponvelocity = 800, turret = true,
    accuracy = 150, areaofeffect = 8, soundstart = 'mg_volley',
    customparams = { resolution = 'statistical', min_volley_damage = 5, skip_fire_strength = 0 },
}, {
    { name = 'Light MG',  range = 300, reloadtime = 0.8, dmg = 40  },
    { name = 'Heavy MG',  range = 380, reloadtime = 1.0, dmg = 90  },
})

-- Autocannons — the kinetic workhorse.
family('MS_AC', {
    weapontype = 'Cannon', weaponvelocity = 650, turret = true,
    accuracy = 110, areaofeffect = 24, soundstart = 'ac_fire',
    customparams = { resolution = 'statistical', min_volley_damage = 10, skip_fire_strength = 0 },
}, {
    { name = 'Light Autocannon',  range = 380, reloadtime = 1.2, dmg = 110 },
    { name = 'Autocannon',        range = 440, reloadtime = 1.6, dmg = 220 },
    { name = 'Heavy Autocannon',  range = 520, reloadtime = 2.2, dmg = 420 },
})

-- Railguns — kinetic sci-fi flagship guns. Flat, fast, armour-piercing.
family('MS_RAILGUN', {
    weapontype = 'Cannon', weaponvelocity = 1800, turret = true,
    accuracy = 40, areaofeffect = 16, soundstart = 'railgun_fire',
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'Light Railgun',     range = 600,  reloadtime = 3.0, dmg = 500  },
    { name = 'Railgun',           range = 750,  reloadtime = 4.0, dmg = 900  },
    { name = 'Heavy Railgun',     range = 900,  reloadtime = 5.5, dmg = 1600 },
    { name = 'Dreadnought Rail',  range = 1200, reloadtime = 8.0, dmg = 3200 },
})

-- Mortars — short-range indirect. Ranges sit ABOVE the same-scale railgun
-- (600/750) on purpose: artillery must outrange direct fire at its own scale
-- (unit props review 2026-08-20 — they used to tie exactly). Statistical, so
-- weaponvelocity is cosmetic only (no projectile is spawned).
family('MS_MORTAR', {
    weapontype = 'Cannon', weaponvelocity = 320, turret = true,
    highTrajectory = 1, accuracy = 220, areaofeffect = 64,
    soundstart = 'mortar_fire',
    customparams = { resolution = 'statistical', min_volley_damage = 15, skip_fire_strength = 0 },
}, {
    { name = 'Mortar',       range = 680, reloadtime = 4.0, dmg = 180 },
    { name = 'Heavy Mortar', range = 860, reloadtime = 5.0, dmg = 320 },
})

-- Howitzers — long arcing artillery. Always real ballistics (arcs matter).
-- weaponvelocity is PER SCALE because these are real projectiles: a ballistic
-- Cannon's absolute max range is v^2/g (45 deg arc) and the maps ship no
-- gravity override (engine default 130 e/s^2). The old family-wide 420 capped
-- reach at ~1357 elmos — S2 (1500), S3 (1900) and S4 (3200) could never land
-- a shell at their declared range (unit props review 2026-08-20).
family('MS_HOWITZER', {
    weapontype = 'Cannon', weaponvelocity = 420, turret = true,
    highTrajectory = 1, accuracy = 260, areaofeffect = 110,
    soundstart = 'howitzer_fire',
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'Field Howitzer',   range = 1100, reloadtime = 6.0,  dmg = 420  },
    { name = 'Siege Howitzer',   range = 1500, reloadtime = 8.0,  dmg = 800,  weaponvelocity = 500 },
    { name = 'Naval Battery',    range = 1900, reloadtime = 10.0, dmg = 1400, weaponvelocity = 560 },
    { name = 'Continental Gun',  range = 3200, reloadtime = 20.0, dmg = 3000, areaofeffect = 220, weaponvelocity = 750 },
})

-- AA missiles — guided, interceptable.
-- AA gating (unit props review 2026-08-20): this engine has NO `toairweapon`
-- key (zero hits in rts/) — the old tag was dead. What it DOES read is the
-- weapondef `canattackground` (WeaponDef.cpp WEAPONTAG) and a per-unit-weapon
-- `onlytargetcategory` (UnitDef.cpp, BAR-style — belongs in the UNIT's
-- weapons table, proposed in .unitprops/agent-systems.md, not here).
-- turnrate raised 18000 -> 45000: at 1.7 rad/s the old value could not track
-- a 270 e/s fighter squad crossing at close range (BAR AA missiles run
-- 40k-63k). flighttime stays unset: 0 auto-computes a sane ttl from range
-- (MissileLauncher.cpp:65).
family('MS_MISSILE_AA', {
    weapontype = 'MissileLauncher', weaponvelocity = 900, turret = true,
    tracks = true, turnrate = 45000, areaofeffect = 32,
    soundstart = 'missile_launch', canattackground = false,
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'AA Missile Pod',    range = 700,  reloadtime = 3.0, dmg = 220 },
    { name = 'AA Missile Rack',   range = 950,  reloadtime = 4.0, dmg = 420 },
    { name = 'Theatre AA Battery',range = 1300, reloadtime = 5.0, dmg = 800 },
})

-- Cruise missiles — strategic guided strike; interception gameplay.
-- `trajectoryHeight` replaces the old `cruisealt` tag, which this engine
-- never read as a weapon key (cruiseAlt is a UNITDEF aircraft key,
-- UnitDef.cpp:502). 0.35 = arc peaks at ~35% of target distance
-- (WeaponDef.cpp trajectoryHeight, Missile only) — gives the high strike
-- profile the interception gameplay wants.
family('MS_MISSILE_CRUISE', {
    weapontype = 'MissileLauncher', weaponvelocity = 500,
    tracks = true, turnrate = 6000, areaofeffect = 160,
    soundstart = 'cruise_launch', trajectoryHeight = 0.35,
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'Cruise Missile',       range = 2400, reloadtime = 25.0, dmg = 1800 },
    { name = 'Heavy Cruise Missile', range = 3600, reloadtime = 45.0, dmg = 3600 },
})

-- Sub-launched strategic missile (ms_subs_s4 VLS). Same bird as
-- MS_MISSILE_CRUISE_S2 but launchable from a submerged hull:
-- `firesubmersed` (WeaponDef.cpp:101, requires waterweapon) is the engine's
-- submerged-fire key; without it a dived boat's VLS never fires.
defs.MS_MISSILE_CRUISE_SUB = {
    name = 'Sub-launched Cruise Missile', weapontype = 'MissileLauncher',
    weaponvelocity = 500, tracks = true, turnrate = 6000,
    areaofeffect = 160, soundstart = 'cruise_launch', trajectoryHeight = 0.35,
    range = 3600, reloadtime = 45.0, damage = { default = 3600 },
    waterweapon = true, firesubmersed = true,
    customparams = { resolution = 'ballistic' },
}

-- Torpedoes — underwater kinetic.
family('MS_TORPEDO', {
    weapontype = 'TorpedoLauncher', weaponvelocity = 220, turret = false,
    tracks = true, turnrate = 5000, areaofeffect = 48,
    soundstart = 'torpedo_launch', waterweapon = true,
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'Light Torpedo', range = 700,  reloadtime = 6.0,  dmg = 600  },
    { name = 'Torpedo',       range = 950,  reloadtime = 8.0,  dmg = 1100 },
    { name = 'Heavy Torpedo', range = 1300, reloadtime = 11.0, dmg = 2000 },
})

-- Flak — proximity-burst AA screens. `canattackground = false` replaces the
-- dead `toairweapon` tag (see MS_MISSILE_AA note; BAR's armflak/corflak use
-- exactly this pair: canattackground=false + onlytargetcategory on the unit).
family('MS_FLAK', {
    weapontype = 'Cannon', weaponvelocity = 1000, turret = true,
    accuracy = 200, areaofeffect = 96, soundstart = 'flak_fire',
    canattackground = false, burnblow = true,
    customparams = { resolution = 'statistical', min_volley_damage = 10, skip_fire_strength = 0 },
}, {
    { name = 'Flak Gun',     range = 600, reloadtime = 1.5, dmg = 120 },
    { name = 'Flak Battery', range = 800, reloadtime = 2.0, dmg = 240 },
})

-- Bombs — unguided gravity drops.
family('MS_BOMB', {
    weapontype = 'AircraftBomb', areaofeffect = 120,
    soundstart = 'bomb_release',
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'Light Bombs',  range = 100, reloadtime = 8.0,  dmg = 400  },
    { name = 'Bombs',        range = 120, reloadtime = 10.0, dmg = 900  },
    { name = 'Heavy Bombs',  range = 140, reloadtime = 14.0, dmg = 1800, areaofeffect = 180 },
})

-- Irregular one-offs — outside the family curves on purpose.
--
-- The Anarchic technical's bed gun (units/irregulars.lua). Deliberately NOT
-- MS_AC_S1: a bolted-on ring mount, so it is shorter-ranged and wilder than
-- the family's light autocannon, and cycles faster so it still reads as a
-- raider's weapon rather than a downgrade.
-- BALLISTIC, unlike the MS_AC family it is named after. The technical is a
-- SINGLE unit with a visible gun, not a squad abstraction, and the cosmetic
-- turret-aim controller engages off ProjectileFired events — a `statistical`
-- volley spawns no projectile (Sim/Weapons/StatisticalCombat.h), so the bed
-- gun would fire while the turret stared straight ahead. Same reasoning as
-- fable_tank's MS_RAILGUN_S2. Verified live 2026-08-06: statistical → no aim.
defs.MS_AC_TECHNICAL = {
    name = 'Scrap Autocannon', weapontype = 'Cannon', weaponvelocity = 600,
    turret = true, accuracy = 190, areaofeffect = 20,
    range = 330, reloadtime = 0.9, damage = { default = 70 },
    soundstart = 'ac_fire',
    customparams = { resolution = 'ballistic' },
}

-- Depth charges — anti-sub.
family('MS_DEPTHCHARGE', {
    weapontype = 'TorpedoLauncher', weaponvelocity = 150,
    areaofeffect = 80, soundstart = 'depthcharge_drop',
    waterweapon = true, burnblow = true,
    customparams = { resolution = 'statistical', min_volley_damage = 40, skip_fire_strength = 0 },
}, {
    { name = 'Depth Charges', range = 350, reloadtime = 5.0, dmg = 500 },
})

return defs
