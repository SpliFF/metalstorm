-- Radar — sensors. Immobile; sight/radar radius grows with scale.
--
-- Intel ballpark vs BAR (T1 radar 2100, adv 3500) scaled to Metalstorm's
-- shorter engagement envelope (max weapon range 3200 vs BAR bertha 4650,
-- ~0.7x): s1 1500 ≈ 0.71x BAR T1, s2 2600 ≈ 0.74x BAR adv — the shipped
-- radar ladder is already well-scaled and is kept; s3/s4 extend the curve
-- (theatre assets). Sonar arrives at s3 (coastal) per SHIP/SUB support.
--
-- Sight: sensor stations see further than line units (BAR radar sight 680
-- vs ~400 for units) — overridden up from the builder's 450+80/s default.
-- HP: soft targets — a sensor mast is a raid magnet, not a fort (BAR radar
-- 180 hp vs 2500 for an MBT). Halved from the builder curve.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'radar', label = 'Sensor Array',
    category = 'LAND BUILDING',
    canmove = false, canattack = false,
    baseHp = 600, baseMass = 500, baseSquad = 1,
    baseFootprint = 2,
    scales = {
        [1] = { maxdamage = 300, sightdistance = 600,
                override = { isbuilding = true, buildtime = 60000,
                radardistance = 1500 },
                description = 'Field sensor mast' },
        [2] = { maxdamage = 600, sightdistance = 750,
                override = { isbuilding = true, buildtime = 150000,
                radardistance = 2600 } },
        [3] = { maxdamage = 1200, sightdistance = 900,
                override = { isbuilding = true, buildtime = 360000,
                radardistance = 4200, sonardistance = 2000 } },
        [4] = { maxdamage = 2400, sightdistance = 1100,
                override = { isbuilding = true, buildtime = 900000,
                radardistance = 7000, sonardistance = 3500 },
                description = 'Theatre surveillance complex' },
    },
}
