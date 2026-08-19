-- Artillery — long-range indirect fire. Real ballistics at every scale
-- (arcs matter; PLAN-macro-combat.md keeps these on the sim path).
--
-- Role tuning vs BAR's arty ladder (armart 620hp/54e-s/394turn r710,
-- armmart 1070/60/270 r820, armmerl 1220/33/520 r1300, bertha r4650):
-- long range, slow, FRAGILE, poor turn. Per-member HP already sits at
-- ~0.5x the tank class per scale (fragile is intentional); speed curve
-- 42→23 e/s is deliberately below the MBT line; turn and accel are
-- overridden low so a flanked battery cannot whip its guns around.
-- Sight is SHORT of weapon range at every scale — artillery relies on
-- spotters/radar for max-range fire, as in BAR.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'artillery', label = 'Artillery',
    category = 'LAND MOBILE ARTILLERY',
    movementclass = 'VEH',
    baseHp = 700, baseMass = 400, baseSpeed = 1.4, baseSquad = 8,
    -- Poor traverse: 500/354/250/177 across the scales (BAR arty is
    -- 270-520 while its MBTs run 400+; the builder's 900 default is a
    -- tank number).
    baseTurn = 500,
    -- Spotter-reliant: 380/460/540/620 sight vs weapon ranges 750-3200.
    baseSight = 380,
    baseFootprint = 3, formation = 'line',
    scales = {
        -- Sluggish accel/brake at every scale — guns limber up slowly.
        [1] = { weapons = { [1] = { name = 'MS_MORTAR_S2' } },
                acceleration = 0.14, brakerate = 0.15,
                description = 'Mortar carrier section' },
        [2] = { weapons = { [1] = { name = 'MS_HOWITZER_S1' } },
                acceleration = 0.12, brakerate = 0.14 },
        [3] = { weapons = { [1] = { name = 'MS_HOWITZER_S2' } },
                acceleration = 0.10, brakerate = 0.12,
                override = { movementclass = 'HEAVY' } },
        [4] = { weapons = { [1] = { name = 'MS_HOWITZER_S4' } },
                -- Crawls: 21 e/s — a siege piece repositions, it does not march.
                maxvelocity = 0.7, acceleration = 0.08, brakerate = 0.1,
                override = { movementclass = 'HEAVY' },
                description = 'Continental gun — single siege piece, hour-glass range' },
    },
}
