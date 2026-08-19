-- Ships — surface naval. Gun batteries, flak screens, cruise missiles.
--
-- Ballparked against BAR naval (2026-08-20 unitprops pass): patrol boat
-- (armpt 780hp/93e·s⁻¹) → destroyer (armroy 3700/67) → cruiser (armcrus
-- 5600/60) → battleship (armbats 9800/58, epoch 50000/54). maxvelocity is
-- elmos/FRAME (×30 = e/s). The builder's generic speed/turn curves produce
-- car-like handling, so every scale overrides accel/brake/turn: ships are
-- heavy and slow to answer the helm, and the ladder steepens with scale.
-- SHIP movedef (gamedata/moveinfo.tdf) carries minwaterdepth=12 and
-- speedmodclass 3, so hulls stay in navigable water — no per-def key needed.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'ships', label = 'Ship',
    category = 'SHIP MOBILE',
    movementclass = 'SHIP',
    baseHp = 2500, baseMass = 1500, baseSpeed = 2.2, baseSquad = 4,
    baseFootprint = 4, formation = 'column',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_AC_S2' } },
                -- Fast attack craft: quickest hulls afloat (BAR armpt 93 e/s).
                maxvelocity = 3.0, turnrate = 540,
                acceleration = 0.15, brakerate = 0.15,
                description = 'Patrol boat flotilla' },
        [2] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_FLAK_S1', onlytargetcategory = 'AIR' },
                            [3] = { name = 'MS_DEPTHCHARGE_S1' } },
                -- 2×3700-class hulls (BAR armroy); the builder's 5000 undersold
                -- the pair. Sonar so the depth-charge rack can actually SEE
                -- subs — a waterweapon without sonar never gets a target.
                maxdamage = 7500,
                maxvelocity = 2.2, turnrate = 300,
                acceleration = 0.09, brakerate = 0.09,
                override = { sonardistance = 450 },
                description = 'Destroyer pair' },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S3' },
                            [2] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' },
                            [3] = { name = 'MS_MISSILE_CRUISE_S1' } },
                maxvelocity = 2.0, turnrate = 250,
                acceleration = 0.06, brakerate = 0.07,
                -- Cruisers are the fleet's picket: surface radar + sonar.
                override = { radardistance = 1000, sonardistance = 500 },
                description = 'Heavy cruiser' },
        [4] = { weapons = { [1] = { name = 'MS_RAILGUN_S4' },
                            [2] = { name = 'MS_HOWITZER_S3' },
                            [3] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' },
                            [4] = { name = 'MS_MISSILE_CRUISE_S2' } },
                -- Between BAR bats (9800) and epoch (50000); matches the
                -- fable_battleship showcase def so the two s4 hulls agree.
                maxdamage = 24000,
                maxvelocity = 1.8, turnrate = 160,
                acceleration = 0.045, brakerate = 0.06,
                -- fable_battleship (DESIGN-MODEL-BUILDING.md §22): shipped
                -- generated model, 4 turret chains matching the 4 weapons
                -- here (fore/aft/superfiring/PDC). Mast radar on the model
                -- justifies the flagship's long radar reach.
                override = { objectname = 'fable_battleship',
                             radardistance = 1400, sonardistance = 600 },
                description = 'Battleship — single capital hull, many turrets' },
    },
}
