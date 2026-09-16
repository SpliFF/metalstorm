-- Mechs — walking weapon platforms; all-terrain mid line.
--
-- Ballpark anchors (per-member ≈ maxdamage/squad_size, vs BAR bots at this
-- game's ~0.25× HP scale): s1 ≈ Pawn-class recon (370 hp, 87 e/s),
-- s2 ≈ Warrior/Thug line bot (1100–1600 hp, 45 e/s), s3 ≈ Zeus-plus T2
-- heavy, s4 ≈ Korgoth/Bantha territory scaled to this game (tank s4 is
-- 30000 aggregate since the 2026-08-20 retune; the colossus walker sits below it, glass-lighter on
-- armour than the tracked dreadnought would be at equal tonnage).
--
-- Walkers turn on the spot: baseTurn 1200 (BAR bots run 885–1264 vs
-- ~350–600 for tracked hulls) so every scale out-turns its tank peer.
--
-- movementclass: VEH/HEAVY are tank-slot (speedmodclass 0, maxslope 32/24).
-- Walkers really want a KBot-slot class (steeper maxslope, kbot terrain
-- moveSpeeds) — proposed as MECH in .unitprops/agent-mechs.md; do not add it
-- here, gamedata/moveinfo.tdf is owned elsewhere.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'mechs', label = 'Mech',
    category = 'LAND MOBILE MECH',
    movementclass = 'VEH',
    baseHp = 900, baseMass = 300, baseSpeed = 2.0, baseTurn = 1200,
    baseSquad = 8,
    baseFootprint = 2, formation = 'wedge',
    -- M2 member spacing (metres). The DESIGN-GUIDE mechs row is HEIGHT
    -- (3/5/7.5/11 m); a walker's ground extent is its stance, NOT its height —
    -- spacing them by height would leave a squad of light mechs three
    -- body-widths apart.
    -- APPLIED 2026-09-17 (units-assets review 2026-09-10 finding 4): the rows
    -- are the shipped glTF ground extents — s1 2.8 x 3.0 (the old 1.8 had
    -- light mechs walking through each other), s2 2.5 x 2.5, s3 3.4 x 4.1,
    -- s4 fable_colossus 8.8 x 8.3. s2 keeps 3.0 rather than dropping to its
    -- measured 2.5: a heavier walker must never crowd tighter than a lighter
    -- one, or a mixed line reads as a mistake.
    -- Moves the ms_mechs_s1 golden radius pinned by
    -- LuaRules/Gadgets/tests/squad_extents_spec.lua AND
    -- client/squads/member-spacing.test.js — both were re-derived with it.
    sizes = { 3.0, 3.0, 4.5, 8.8 },
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MG_S2' } },
                description = 'Recon walker pack',
                -- Recon role: quick (84 e/s ≈ BAR Pawn) and far-sighted,
                -- paid for with the thinnest per-member HP in the class.
                maxvelocity = 2.8, sightdistance = 550,
                override = { transportsize = 1, transportbyenemy = false } },
        [2] = { weapons = { [1] = { name = 'MS_AC_S2' } },
                override = { transportsize = 2, transportbyenemy = false } },
        [3] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_MISSILE_AA_S2', onlytargetcategory = 'AIR' } },
                -- Own hull since 2026-08-20 (user ruling: purpose-made
                -- ms_mechs_s3.gltf at the DESIGN-GUIDE scale; the fable_mech
                -- objectname override is gone).
                -- transportsize 3 + mass 1200: exactly at the airship's
                -- transportmass cap — the heaviest liftable mech scale.
                override = { transportsize = 3, transportbyenemy = false } },
        [4] = { weapons = { [1] = { name = 'MS_RAILGUN_S3' },
                            [2] = { name = 'MS_AC_S3' },
                            [3] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' } },
                -- Aggregates aligned to the fable_colossus showcase def
                -- (same 15 m model): the builder curve's 7200 hp / 2400 mass
                -- read as a heavy, not a flagship — tank s4 already fields
                -- 30000 aggregate. Slower accel/brake than the curve stub;
                -- turnrate stays walker-quick (BAR Korgoth: 437).
                maxdamage = 14000, mass = 3200,
                maxvelocity = 1.3, acceleration = 0.15, brakerate = 0.15,
                turnrate = 420, sightdistance = 700,
                -- fable_colossus (DESIGN-MODEL-BUILDING.md §20): shipped
                -- generated model, super-heavy assault walker. Only 2
                -- weapon-bearing pieces (arm_r/arm_l) vs 3 weapons here —
                -- the 3rd (FLAK_S2) fires from unit centre, no cosmetic
                -- turret-aim piece; not a rendering defect.
                override = { movementclass = 'HEAVY', objectname = 'fable_colossus',
                             cantbetransported = 1 },
                description = 'Siege colossus — single multi-turret walker' },
    },
}
