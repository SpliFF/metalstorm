-- Static defenses — emplaced weapons. Immobile; built slowly like all
-- structures (PLAN-metalstorm.md §8). Squad hints model gun batteries
-- (one entity = a battery of N emplacements rendered by the client).
--
-- canmove=false: _builder.lua HARD-FORCES maxvelocity 0 for immobile units
-- (a nonzero maxvelocity with no moveDef SIGSEGVs MoveTypeFactory at
-- GameStart) — verified 2026-08-20: no scale here overrides maxvelocity,
-- so the invariant holds. Do not add a maxvelocity key to any scale.
--
-- HP is deliberately ~2x the same-scale tank SQUAD (fortifications trade
-- mobility for staying power, like BAR's LLT at ~3x a T1 tank's HP).
-- RE-BASED 2026-09-10 (units-assets review): the tank ladder was retuned
-- 2026-08-20 to 2400/7200/13000/30000 and these numbers never followed, so
-- every battery from s2 up had LESS hp than the tank squad it is meant to
-- outlast. s1-s3 are now exactly 2x the tank squad; s4 is 1.5x the
-- dreadnought (2x = 60000 would make one emplacement immune to any single
-- flagship — the s4 tank is a lone hull, not a squad, so the squad ratio does
-- not carry). Weapons untouched.
-- Sight on s3/s4 is raised to cover their own gun range; s4's Continental
-- Gun (r3200, the bertha analogue) still relies on spotters beyond that.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'staticdefense', label = 'Defense Battery',
    category = 'LAND BUILDING',
    canmove = false,
    baseHp = 2000, baseMass = 2000, baseSquad = 4,
    baseFootprint = 3, formation = 'blob',
    -- M2 member spacing (metres). Emplacements do not move, but a scale-1
    -- battery still draws FOUR members and they were stacked. Ground extent
    -- of the shipped emplacement models — revetment, sandbag rim and pit
    -- included, which is why they are 2x the "0.8 x height" guess that was
    -- here (s1 5.5 x 6.0, s2 5.4 x 5.8, s3 5.8 x 7.4, s4 5.9 x 9.4;
    -- units-assets review 2026-09-10).
    sizes = { 6.0, 5.8, 7.4, 9.4 },
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MG_S2' } },
                maxdamage = 4800,           -- 1200/nest x4 — 2x tank squad 2400
                override = { isbuilding = true, buildtime = 90000 },
                description = 'Gun nest cluster' },
        [2] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_FLAK_S1', onlytargetcategory = 'AIR' } },
                maxdamage = 14400,          -- 2x tank squad 7200
                override = { isbuilding = true, buildtime = 220000 } },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S3' },
                            [2] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' } },
                maxdamage = 26000,          -- 2x tank squad 13000
                sightdistance = 950,        -- covers own railgun range (900)
                override = { isbuilding = true, buildtime = 480000 } },
        [4] = { weapons = { [1] = { name = 'MS_HOWITZER_S4' },
                            [2] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' } },
                maxdamage = 45000,          -- fortress piece; 1.5x dreadnought 30000
                sightdistance = 1050,       -- best static sight; r3200 gun still spotter-fed
                override = { isbuilding = true, buildtime = 1200000 },
                description = 'Bastion gun — single fortress emplacement' },
    },
}
