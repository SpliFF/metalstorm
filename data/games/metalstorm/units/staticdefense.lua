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
-- Sight on s3/s4 is raised to cover their own gun range; s4's Continental
-- Gun (r3200, the bertha analogue) still relies on spotters beyond that.
local mk = VFS.Include('units/_builder.lua')
return mk{
    class = 'staticdefense', label = 'Defense Battery',
    category = 'LAND BUILDING',
    canmove = false,
    baseHp = 2000, baseMass = 2000, baseSquad = 4,
    baseFootprint = 3, formation = 'blob',
    scales = {
        [1] = { weapons = { [1] = { name = 'MS_MG_S2' } },
                maxdamage = 2800,           -- 700/nest x4 — vs tank squad 1400
                override = { isbuilding = true, buildtime = 90000 },
                description = 'Gun nest cluster' },
        [2] = { weapons = { [1] = { name = 'MS_AC_S3' },
                            [2] = { name = 'MS_FLAK_S1', onlytargetcategory = 'AIR' } },
                maxdamage = 5600,           -- vs tank squad 2800
                override = { isbuilding = true, buildtime = 220000 } },
        [3] = { weapons = { [1] = { name = 'MS_RAILGUN_S3' },
                            [2] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' } },
                maxdamage = 11000,          -- vs tank squad 5600
                sightdistance = 950,        -- covers own railgun range (900)
                override = { isbuilding = true, buildtime = 480000 } },
        [4] = { weapons = { [1] = { name = 'MS_HOWITZER_S4' },
                            [2] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' } },
                maxdamage = 22000,          -- fortress piece; vs dreadnought 11200
                sightdistance = 1050,       -- best static sight; r3200 gun still spotter-fed
                override = { isbuilding = true, buildtime = 1200000 },
                description = 'Bastion gun — single fortress emplacement' },
    },
}
