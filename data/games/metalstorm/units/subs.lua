-- Submarines — underwater attack. Torpedoes; scale 4 carries cruise missiles.
--
-- Ballparked against BAR subs (2026-08-20 unitprops pass): armsub
-- 840hp/66e·s⁻¹/sonar 400/waterline 45, armsubk 2350/81/sonar 525,
-- armserp 3550/45. Every scale carries sonardistance — a submerged hull
-- hunts by sonar, not eyeballs — and a `waterline` so the hull rides BELOW
-- the surface (kept under the SUB movedef's minwaterdepth=20 so shallow
-- lanes never ground the boat). Sight is overridden DOWN from the builder
-- curve: periscope depth, not a crow's nest. SUB movedef (moveinfo.tdf) is
-- speedmodclass 3 but does NOT yet set subMarine=1 — proposed in
-- .unitprops/agent-naval.md, owned by the gamedata agent.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'subs', label = 'Submarine',
    category = 'SUB MOBILE',
    movementclass = 'SUB',
    baseHp = 1600, baseMass = 1000, baseSpeed = 1.8, baseSquad = 4,
    baseFootprint = 3, formation = 'column',
    -- M2 member spacing (metres): hull length, DESIGN-GUIDE subs row.
    sizes = { 18, 30, 45, 65 },
    -- Turn rates re-derived 2026-08-29 alongside ships.lua — same cause (the
    -- 2026-08-27 world-scale re-import lengthened every hull 8x and the
    -- 2026-08-20 rates never followed) and the same 1.0 hull-length target:
    --
    --   def   hull   v e/s   old tr   old R    new tr   new R    180 deg
    --   s1    18 m    60      500    0.29 L      145    1.00 L     7.5 s
    --   s2    30 m    54      420    0.19 L       78    1.00 L    14.0 s
    --   s3    45 m    66      400    0.16 L       64    1.00 L    17.1 s
    --   s4    65 m    36      250    0.10 L       24    1.00 L    45.5 s
    --
    -- s4 at 45 s for a 180 is a long time to commit a strategic boat to a course.
    -- That is the point of a leviathan and it is deliberate, but it is the first
    -- number to revisit if the class plays badly.
    turnInPlace = false,
    turnInPlaceSpeedLimitFrac = 1.0,
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_TORPEDO_S1' } },
                -- 4 boats ≈ 700 hp each (BAR armsub 840); builder's 1600
                -- aggregate made each boat half a BAR T1 sub.
                maxdamage = 2800,
                maxvelocity = 2.0, turnrate = 145,
                acceleration = 0.10, brakerate = 0.10,
                sightdistance = 350,
                override = { sonardistance = 500, waterline = 10 },
                description = 'Coastal sub pack' },
        [2] = { weapons = { [1] = { name = 'MS_TORPEDO_S2' } },
                maxvelocity = 1.8, turnrate = 78,
                acceleration = 0.08, brakerate = 0.08,
                sightdistance = 400,
                override = { sonardistance = 600, waterline = 12 },
                description = 'Attack sub pair' },
        [3] = { weapons = { [1] = { name = 'MS_TORPEDO_S3' } },
                -- Hunter-killers are the FAST scale (BAR armsubk 81 e/s beats
                -- both its T1 and the serpent) — the builder curve would have
                -- made them the slowest boats yet. Squad forced to 2: the
                -- description promises a pair but round(4/4) collapses to 1.
                squad = 2,
                maxdamage = 6800,
                maxvelocity = 2.2, turnrate = 64,
                acceleration = 0.09, brakerate = 0.09,
                sightdistance = 450,
                override = { sonardistance = 750, waterline = 14 },
                description = 'Hunter-killer pair' },
        [4] = { weapons = { [1] = { name = 'MS_TORPEDO_S3' },
                            [2] = { name = 'MS_MISSILE_CRUISE_SUB' } },
                -- MS_MISSILE_CRUISE_SUB: waterweapon + firesubmersed, so the
                -- VLS fires from a dived hull (the surface CRUISE_S2 never
                -- would); same range/damage as the S2 bird.
                maxdamage = 14000,
                maxvelocity = 1.2, turnrate = 24,
                acceleration = 0.05, brakerate = 0.06,
                sightdistance = 500,
                override = { sonardistance = 900, waterline = 14 },
                description = 'Missile leviathan — single strategic boat' },
    },
}
