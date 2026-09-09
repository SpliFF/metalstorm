-- Tanks — armoured line. Kinetic main guns.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'tanks', label = 'Tank',
    category = 'LAND MOBILE TANK',
    movementclass = 'VEH',
    baseHp = 1400, baseMass = 500, baseSpeed = 2.6, baseSquad = 8,
    baseFootprint = 2, formation = 'wedge',
    -- M2 member spacing (metres): hull LENGTH per the DESIGN-GUIDE tanks row,
    -- used as a circumscribed circle so two hulls never interpenetrate at any
    -- relative heading. s1/s3 are the measured forge models (4.5 m tankette,
    -- 12 m tracked heavy); s2/s4 are the table.
    -- PROPOSED (units-assets review 2026-09-10, not applied): the shipped
    -- hulls measure 4.8 / 9.9 / 13.2 / 20.3 m, so s2 members clip and s4
    -- over-reserves a 13-cell footprint. Changing these moves the golden
    -- radii pinned by tests/squad_extents_spec.lua AND
    -- client/squads/member-spacing.test.js — update both ports together.
    sizes = { 4.5, 8.5, 12, 26 },
    -- Turn RATES are left alone: at 8 elmos = 1 m the four scales already turn
    -- in 0.6-1.3 hull lengths, which is right for a tracked vehicle. What was
    -- wrong is that they BRAKED to do it, so the radius they actually drove was
    -- a fraction of that.
    --
    -- MEASURED IN GAME 2026-08-29 (ms_tanks_s2, flat map, settled straight leg,
    -- then a hard 90): the hull turned at 1.081 rad/s — its def rate, correct —
    -- but slowed from 75 e/s to 32 e/s through the turn, so the driven radius
    -- was 20 elmos = 2.5 m against a 9 m hull. 0.28 hull lengths is a pivot,
    -- not an arc, and it is what the user reported.
    --
    -- The lever is NOT turnInPlaceAngleLimit. That key is only read on the
    -- `turnInPlace == true` branch (GroundMoveType.cpp:1187), where it merely
    -- picks WHICH turns brake — a 90 exceeds any sane angle limit, so it braked
    -- anyway. Verified in game: with turnInPlaceAngleLimit = 45 the 90 still
    -- drove a 2.5 m radius. Only the `turnInPlace == false` branch (line 1185)
    -- carries a speed FLOOR, and a floor is the whole point.
    --
    -- 0.8 keeps a tank at >= 60 e/s through any turn: R = 60 / 1.093 = 55 elmos
    -- = 6.9 m, 0.76 hull lengths — a visible arc — while still letting it shed
    -- some speed for the sharpest ones. BALANCE-VISIBLE, both ways: a column
    -- crosses turning ground markedly faster than before, and a tank can no
    -- longer spin on the spot to bring its front armour round.
    turnInPlace = false,
    turnInPlaceSpeedLimitFrac = 0.8,
    -- Ballparks (unit props review 2026-08-20): per-member HP ≈ maxdamage /
    -- squad_size, compared against BAR vehicle lines (flash 730hp/101e/s,
    -- stumpy 1800/75, bull 4650/62, goliath 7800/39). maxvelocity is
    -- elmos/frame (×30 = e/s). The builder's generic ×2 HP curve left every
    -- member paper-thin (s2 member 700hp vs stumpy 1800) and gave heavies
    -- scout-grade turn rates, so all four scales carry explicit numbers.
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_AC_S1' } },
                description = 'Tankette pack — fast, thin-skinned',
                -- Raider tier: 8 × 300hp members (thinner than a BAR flash),
                -- raider speed 93 e/s — the builder's 78 e/s was MBT speed.
                maxdamage = 2400, maxvelocity = 3.1,
                acceleration = 0.35, brakerate = 0.3,
                -- ms_tanks_s1 (tools/forge, 2026-08-27): native wheeled
                -- tankette — 4.5 m lofted hull, spinnable axle_f/axle_r,
                -- turret/barrel/muzzle autocannon chain. Replaces the
                -- WZ2100 `wz_wheeled` placeholder this def borrowed while
                -- no `ms_tanks_s1.gltf` existed; the builder's default
                -- objectname (= def name) now resolves, so no override.
                override = { transportbyenemy = false } },
        [2] = { weapons = { [1] = { name = 'MS_AC_S3' } },
                description = 'Main battle tank troop',
                -- Line tier: 4 × 1800hp members (BAR stumpy anchor),
                -- 75 e/s, MBT turn rate (builder gave a scouty 636).
                maxdamage = 7200, mass = 1600,
                maxvelocity = 2.5, turnrate = 380, sightdistance = 480,
                -- fable_tank (DESIGN-MODEL-BUILDING.md §18): shipped
                -- generated model, hull/turret/barrel/muzzle pieces.
                override = { objectname = 'fable_tank',
                             transportbyenemy = false } },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S2' },
                            [2] = { name = 'MS_MG_S2' } },
                description = 'Heavy tank platoon',
                -- Heavy tier: 2 × 6500hp members (between BAR bull 4650 and
                -- goliath 7800), goliath-grade speed/turn (45 e/s / 200).
                maxdamage = 13000, mass = 3600,
                maxvelocity = 1.5, acceleration = 0.15, brakerate = 0.15,
                turnrate = 200, sightdistance = 560,
                -- ms_tanks_s3 (tools/forge, 2026-08-27): native heavy
                -- tracked tank — 12 m hull, tracks_l/tracks_r pods, railgun
                -- turret/barrel/muzzle + MG turret2/barrel2/muzzle2 (the
                -- scriptless slot-N piece-name convention, Weapon.cpp
                -- ResolveFallbackWeaponPieces). Replaces the WZ2100
                -- `wz_tank` placeholder; builder default objectname
                -- (= def name) now resolves, so no override.
                override = { movementclass = 'HEAVY',
                             transportbyenemy = false } },
        [4] = { weapons = { [1] = { name = 'MS_RAILGUN_S4' },
                            [2] = { name = 'MS_HOWITZER_S2' },
                            [3] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' } },
                -- Flagship tier: single 30000hp hull (T3/experimental band),
                -- 33 e/s crawl, dreadnought turn/accel — the builder curve
                -- would have given it half the HP and double the agility.
                maxdamage = 30000, mass = 9000,
                maxvelocity = 1.1, acceleration = 0.06, brakerate = 0.08,
                turnrate = 140, sightdistance = 700,
                -- fable_heavy (DESIGN-MODEL-BUILDING.md §19): shipped
                -- generated model, twin-turret super-heavy tank. Only 2
                -- turret pieces (turret/turret2) vs 3 weapons here — the
                -- 3rd weapon (FLAK_S2) gets no cosmetic turret-aim piece
                -- and fires from unit centre; not a rendering defect.
                -- No lift moves a dreadnought: cantbetransported, and no
                -- captured hull rides an enemy transport either.
                override = { movementclass = 'HEAVY', objectname = 'fable_heavy',
                             cantbetransported = true,
                             transportbyenemy = false },
                description = 'Land dreadnought — single tracked fortress' },
    },
}
