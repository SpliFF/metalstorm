-- units/_builder.lua — shared 4-scale unit def generator.
--
-- Every Metalstorm unit class ships in 4 scales (PLAN-metalstorm.md §5):
--   s1 light/swarm (big squads) → s4 super-heavy (single unit).
-- Squad size goes DOWN as scale goes up. The squad is the sim atom
-- (PLAN-macro-squads.md): squad_size / formation_* are CLIENT fan-out hints,
-- maxdamage is aggregate squad strength.
--
-- Usage (units/<class>.lua):
--   local mk = VFS.Include('units/_builder.lua')
--   return mk{ class = 'tanks', label = 'Tank', ... , scales = { [1]={...}, ... } }
--
-- Returns { ms_<class>_s1 = def, ..., ms_<class>_s4 = def }.
-- STUB QUALITY: numbers are placeholder curves, not balance. RH coordinates.

local function round(x) return math.floor(x + 0.5) end

local SCALE_WORDS = { 'Light', 'Line', 'Heavy', 'Super-heavy' }

local function mk(spec)
    local defs = {}
    for s = 1, 4 do
        local o = (spec.scales and spec.scales[s]) or {}
        local name = 'ms_' .. spec.class .. '_s' .. s
        local growth = 2 ^ (s - 1)        -- generic per-scale growth curve

        local def = {
            name        = (o.label or (SCALE_WORDS[s] .. ' ' .. spec.label)),
            description = o.description or
                (spec.label .. ' — scale ' .. s .. ' (' .. SCALE_WORDS[s]:lower() .. ')'),
            objectname  = name,            -- objects3d/<name>.glb (native, RH)
            category    = spec.category or 'LAND MOBILE',

            -- Aggregate squad strength; squads shrink as units grow.
            maxdamage   = o.maxdamage or round((spec.baseHp or 400) * growth),
            mass        = o.mass or round((spec.baseMass or 100) * growth),

            -- Immobile units (radar, buildings; canmove=false) MUST have speed 0.
            -- A nonzero maxvelocity with no moveDef trips MoveTypeFactory::GetMoveType's
            -- IsImmobileUnit() assertion → hard SIGSEGV at GameStart.
            maxvelocity  = (spec.canmove == false) and 0
                or o.maxvelocity or (spec.baseSpeed or 2.0) * (1 - 0.15 * (s - 1)),
            acceleration = o.acceleration or 0.25,
            brakerate    = o.brakerate or 0.2,
            turnrate     = o.turnrate or round((spec.baseTurn or 900) / growth ^ 0.5),

            footprintx  = o.footprint or (spec.baseFootprint or 2) + (s - 1),
            footprintz  = o.footprint or (spec.baseFootprint or 2) + (s - 1),
            sightdistance = o.sightdistance or (spec.baseSight or 450) + 80 * (s - 1),

            movementclass = spec.movementclass,   -- nil for aircraft/buildings
            canfly      = spec.canfly,
            canmove     = (spec.canmove ~= false),
            canattack   = (spec.canattack ~= false),
            canpatrol   = (spec.canmove ~= false),
            canstop     = true,
            canguard    = (spec.canmove ~= false),

            weapons     = o.weapons or spec.weapons,

            customparams = {
                ms_class         = spec.class,
                ms_scale         = tostring(s),
                -- Client fan-out hints (PLAN-macro-squads.md):
                squad_size       = tostring(o.squad or
                                     math.max(1, round((spec.baseSquad or 8) / growth))),
                formation_type   = o.formation or spec.formation or 'line',
                formation_radius = tostring(o.formationRadius or
                                     round((spec.baseFormationRadius or 24) * growth ^ 0.5)),
                -- Authority economy hint (PLAN-metalstorm.md §4): order cost
                -- scales with unit strength; game_authority.lua reads this.
                authority_cost_base = tostring(o.authorityCost or s),
            },
        }

        -- Impostor LOD opt-in (PLAN-metalstorm-beta-units.md §2.1, engine ask
        -- B1). impostorOnly units (infantry/civilians per the beta roster)
        -- have no 3D model at all — the billboard impostor IS their normal
        -- render, so the engine defaults the switch distance to near-zero
        -- when none is given explicitly.
        local impostorOnly = o.impostorOnly or spec.impostorOnly
        local impostorDistance = o.impostorDistance or spec.impostorDistance
        if impostorOnly or impostorDistance then
            def.customparams.impostor_distance = tostring(impostorDistance or 1)
            if impostorOnly then
                def.customparams.impostor_only = '1'
            end
        end

        -- Scale 4 = single super-heavy unit: multi-piece, cosmetic turrets
        -- (the "one synced entity, cosmetic sub-parts" pattern).
        if s == 4 then
            def.customparams.squad_size = '1'
            def.customparams.multi_piece = '1'
        end

        -- Per-scale free-form overrides win over everything above.
        if o.override then
            for k, v in pairs(o.override) do def[k] = v end
        end

        defs[name] = def
    end
    return defs
end

return mk
