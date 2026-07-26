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
--   targeting_cadence.
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

-- Mortars — short-range indirect.
family('MS_MORTAR', {
    weapontype = 'Cannon', weaponvelocity = 280, turret = true,
    highTrajectory = 1, accuracy = 220, areaofeffect = 64,
    soundstart = 'mortar_fire',
    customparams = { resolution = 'statistical', min_volley_damage = 15, skip_fire_strength = 0 },
}, {
    { name = 'Mortar',       range = 600, reloadtime = 4.0, dmg = 180 },
    { name = 'Heavy Mortar', range = 750, reloadtime = 5.0, dmg = 320 },
})

-- Howitzers — long arcing artillery. Always real ballistics (arcs matter).
family('MS_HOWITZER', {
    weapontype = 'Cannon', weaponvelocity = 420, turret = true,
    highTrajectory = 1, accuracy = 260, areaofeffect = 110,
    soundstart = 'howitzer_fire',
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'Field Howitzer',   range = 1100, reloadtime = 6.0,  dmg = 420  },
    { name = 'Siege Howitzer',   range = 1500, reloadtime = 8.0,  dmg = 800  },
    { name = 'Naval Battery',    range = 1900, reloadtime = 10.0, dmg = 1400 },
    { name = 'Continental Gun',  range = 3200, reloadtime = 20.0, dmg = 3000, areaofeffect = 220 },
})

-- AA missiles — guided, interceptable.
family('MS_MISSILE_AA', {
    weapontype = 'MissileLauncher', weaponvelocity = 900, turret = true,
    tracks = true, turnrate = 18000, areaofeffect = 32,
    soundstart = 'missile_launch', toairweapon = true,
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'AA Missile Pod',    range = 700,  reloadtime = 3.0, dmg = 220 },
    { name = 'AA Missile Rack',   range = 950,  reloadtime = 4.0, dmg = 420 },
    { name = 'Theatre AA Battery',range = 1300, reloadtime = 5.0, dmg = 800 },
})

-- Cruise missiles — strategic guided strike; interception gameplay.
family('MS_MISSILE_CRUISE', {
    weapontype = 'MissileLauncher', weaponvelocity = 500,
    tracks = true, turnrate = 6000, areaofeffect = 160,
    soundstart = 'cruise_launch', cruisealt = 300,
    customparams = { resolution = 'ballistic' },
}, {
    { name = 'Cruise Missile',       range = 2400, reloadtime = 25.0, dmg = 1800 },
    { name = 'Heavy Cruise Missile', range = 3600, reloadtime = 45.0, dmg = 3600 },
})

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

-- Flak — proximity-burst AA screens.
family('MS_FLAK', {
    weapontype = 'Cannon', weaponvelocity = 1000, turret = true,
    accuracy = 200, areaofeffect = 96, soundstart = 'flak_fire',
    toairweapon = true, burnblow = true,
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
