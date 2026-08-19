-- Bombers — ground attack. Unguided bombs and cruise missiles.
--
-- Aircraft notes (unit-props review 2026-08-20, verified against UnitDef.cpp):
--  * Strafing fixed-wings. maxvelocity is elmos/frame (×30 = e/s); BAR
--    anchors: T1 bomber 250 e/s, T2 strategic ~230–260 e/s. Bombers stay in
--    the ~170–225 e/s band — slower than the fighters — so the builder's
--    slow-down curve is overridden per scale (its s4 value was 107 e/s).
--  * IsBomberAirUnit is decided by weapon slot 1 ONLY (HasBomberWeapon(0):
--    AircraftBomb/torpedo). The bomb must stay first in every loadout — a
--    cruise missile in slot 1 reclassifies the unit as a fighter (wrong
--    strafe/turn behaviour). s4's loadout is ordered for this.
--  * `acceleration` is IGNORED for strafing fighters/bombers — UnitDef.cpp
--    re-reads `maxacc` (default 0.065). BAR bomber ~0.055.
--  * cruisealtitude sets wantedHeight (default 0 = deck-hugging);
--    collide=false per BAR aircraft convention; cantbetransported already
--    defaults TRUE for canfly units.
--  * Bombs get onlytargetcategory so squads never waste a pass trying to
--    line up on aircraft ('LAND SHIP SUB' covers all surface categories in
--    this game — buildings are LAND).
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'bombers', label = 'Bomber',
    category = 'AIR MOBILE',
    canfly = true,
    baseHp = 800, baseMass = 300, baseSpeed = 6.5, baseSquad = 8,
    baseSight = 500,
    baseFootprint = 3, formation = 'line',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_BOMB_S1',
                                    onlytargetcategory = 'LAND SHIP SUB' } },
                maxvelocity = 6.5,   -- 195 e/s
                description = 'Strike drone flight',
                override = { collide = false, cruisealtitude = 140,
                             maxacc = 0.06, maxdec = 0.05,
                             turnradius = 90, airsightdistance = 750 } },
        [2] = { weapons = { [1] = { name = 'MS_BOMB_S2',
                                    onlytargetcategory = 'LAND SHIP SUB' } },
                maxvelocity = 6.2,   -- 186 e/s
                -- fable_bomber (DESIGN-MODEL-BUILDING.md §26): shipped
                -- generated model, "s2 compact bomber" per its own header.
                override = { objectname = 'fable_bomber',
                             collide = false, cruisealtitude = 160,
                             maxacc = 0.058, maxdec = 0.05,
                             turnradius = 100, airsightdistance = 800 } },
        -- s3 tail MG is defensive armament; left unrestricted (it plinks
        -- whatever passes — the bomb in slot 1 drives target choice).
        [3] = { weapons = { [1] = { name = 'MS_BOMB_S3',
                                    onlytargetcategory = 'LAND SHIP SUB' },
                            [2] = { name = 'MS_MG_S2' } },
                maxvelocity = 5.6,   -- 168 e/s — heavy airframe
                override = { collide = false, cruisealtitude = 200,
                             maxacc = 0.052, maxdec = 0.045,
                             turnradius = 120, airsightdistance = 900 } },
        -- s4 strategic platform: bomb FIRST (bomber classification, see
        -- header), cruise missile as the stand-off weapon,         -- point-defence screen (air-only: canattackground=false in the weapon def + AIR category gate here).
        [4] = { weapons = { [1] = { name = 'MS_BOMB_S3',
                                    onlytargetcategory = 'LAND SHIP SUB' },
                            [2] = { name = 'MS_MISSILE_CRUISE_S2',
                                    onlytargetcategory = 'LAND SHIP SUB' },
                            [3] = { name = 'MS_FLAK_S1', onlytargetcategory = 'AIR' } },
                maxvelocity = 7.5,   -- 225 e/s — strategic jets are FAST
                maxdamage = 4500,    -- builder's 6400 was warship-grade
                description = 'Strategic bomber — single high-altitude platform',
                override = { collide = false, cruisealtitude = 300,
                             maxacc = 0.05, maxdec = 0.045,
                             turnradius = 150, airsightdistance = 1000 } },
    },
}
