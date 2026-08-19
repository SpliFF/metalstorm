-- Fighters — air superiority. Guns + AA missiles, no beams.
--
-- Aircraft notes (unit-props review 2026-08-20, verified against UnitDef.cpp):
--  * These are strafing fixed-wings (canfly, no hoverattack) except s4.
--  * maxvelocity is elmos/frame (×30 = e/s). BAR anchors: T1 fighter ~289 e/s,
--    T2 fighter ~358 e/s — fighters get FASTER up-scale, so the builder's
--    generic slow-down curve is overridden at every scale.
--  * `acceleration` is IGNORED for strafing fighters/bombers: UnitDef.cpp
--    re-reads `maxacc` (default 0.065) for IsFighter/IsBomberAirUnit, so the
--    engine-power knob is `maxacc` in the override (BAR fighter ~0.18).
--    `brakerate`/`maxdec` still applies normally.
--  * cruisealtitude sets wantedHeight; without it aircraft default to 0 and
--    hug the deck. collide=false per BAR aircraft convention (squad members
--    would otherwise grind on each other in tight wedges).
--  * cantbetransported needs no key: UnitDef.cpp defaults it TRUE for any
--    canfly unit (!RequireMoveDef()).
--  * airsightdistance: air units spot air far beyond ground sight (BAR
--    fighters: 950–1100 vs sight 430); engine default is only 1.5×sight.
--  * turnradius: engine default 500 is a lumbering arc; BAR fighters use 64.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'fighters', label = 'Fighter',
    category = 'AIR MOBILE',
    canfly = true,
    baseHp = 500, baseMass = 150, baseSpeed = 9.0, baseSquad = 8,
    baseSight = 550,
    baseFootprint = 2, formation = 'wedge',
    scales = {
        -- s1 interceptor drones: 62 hp/member — expendable airframes. The MG
        -- alone cannot reliably engage air, so the flight carries the light
        -- AA pod too (fighters must be AA-capable at every scale).
        [1] = { weapons = { [1] = { name = 'MS_MG_S2' },
                            [2] = { name = 'MS_MISSILE_AA_S1',
                                    onlytargetcategory = 'AIR' } },
                maxvelocity = 9.0,   -- 270 e/s
                description = 'Interceptor drone flight',
                override = { collide = false, cruisealtitude = 110,
                             maxacc = 0.19, maxdec = 0.075,
                             turnradius = 60, airsightdistance = 900 } },
        [2] = { weapons = { [1] = { name = 'MS_AC_S1' },
                            [2] = { name = 'MS_MISSILE_AA_S1',
                                    onlytargetcategory = 'AIR' } },
                maxvelocity = 9.6,   -- 288 e/s ≈ BAR T1 fighter
                -- Own hull since 2026-08-20 (user ruling: purpose-made
                -- ms_fighters_s2.gltf at the DESIGN-GUIDE 9 m span; the
                -- fable_fighter objectname override is gone).
                override = { collide = false, cruisealtitude = 125,
                             maxacc = 0.18, maxdec = 0.075,
                             turnradius = 64, airsightdistance = 950 } },
        [3] = { weapons = { [1] = { name = 'MS_AC_S2' },
                            [2] = { name = 'MS_MISSILE_AA_S2',
                                    onlytargetcategory = 'AIR' } },
                maxvelocity = 10.6,  -- 318 e/s ≈ BAR T2 air-sup fighter
                override = { collide = false, cruisealtitude = 150,
                             maxacc = 0.16, maxdec = 0.07,
                             turnradius = 70, airsightdistance = 1050 } },
        -- s4 is a GUNSHIP, not a strafer: hoverattack so the single heavy
        -- frame holds station and tracks targets (BAR Brawler pattern).
        -- Hovering air is NOT IsFighterAirUnit, so `acceleration` applies
        -- normally here — no maxacc override needed.
        [4] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_MISSILE_AA_S3',
                                    onlytargetcategory = 'AIR' } },
                maxvelocity = 7.0,   -- 210 e/s — slower, holds station
                turnrate = 700,      -- hover air steers by turnrate
                maxdamage = 3200,    -- builder's 4000 was warship-grade
                description = 'Air-dominance gunship — single heavy frame',
                override = { collide = false, hoverattack = true,
                             cruisealtitude = 160,
                             airsightdistance = 1150 } },
    },
}
