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
            -- The `infantry_v2` atlas convention (tools/fable-model-forge/
            -- impostor_convention.py INFANTRY_V2), declared per atlas rather
            -- than assumed globally: two bakers ship in this repo and they
            -- disagree by 180° on what column 0 is and on the elevation arc, so
            -- the runtime must be TOLD (user decision 2026-08-03, option (b)).
            -- Keep these in step with INFANTRY_V2 — a cross-check test pins the
            -- Python and TS sides to each other, but this Lua is the third copy.
            def.customparams.impostor_yaw_bins = '8'
            def.customparams.impostor_pitch_bins = '3'
            def.customparams.impostor_frames = '1'
            -- 180° = column 0 is the unit's FRONT view. (Relative yaw 0 puts
            -- the camera BEHIND a −Z-forward model, so 0 would mean its back —
            -- the exact zero point that let the two bakers drift apart.)
            def.customparams.impostor_azimuth_phase = '180'
            -- Camera elevations above the horizon, top row first.
            def.customparams.impostor_pitch_degrees = '15,45,80'
            -- Sprite quad height/width in elmos (member-scaled — the squad
            -- footprint fallback is way oversized for a single soldier).
            local impostorSize = o.impostorSize or spec.impostorSize
            if impostorSize then
                def.customparams.impostor_size = tostring(impostorSize)
            end
            -- Ground-anchor lift: distance from the unit's ground point up to
            -- the card's CENTRE, in elmos. NOT half the quad height.
            -- It is MEASURED IN-GAME, not derived. The surviving baker
            -- (`bake_impostors.py`) frames each cell on the model's bbox centre
            -- and writes `centreY = centre[1]`, but the four shipped infantry
            -- sheets came from M2's baker, which did NOT survive the collision
            -- (M8 deviation 3) and framed differently — fitting the surviving
            -- baker's ortho framing to the shipped KTX2 alpha leaves a 39 px RMS
            -- residual, so the bbox centre is simply the wrong number for these
            -- sheets. Using it made every infantry sprite hover ~0.155 elmos
            -- above the 3D body it swaps with (M11, 2026-08-03).
            -- Method for a re-measure: force one class to the model tier and
            -- then the sprite tier at an identical camera, and take the
            -- HEAD-TOP pixel offset between the two silhouettes. Two traps,
            -- both of which give a plausible wrong answer:
            --  1. Use the head-top, never the foot line: the model tier casts
            --     a shadow and the sprite tier does not (M3 deviation 2), so
            --     the foot edge is contaminated by ~15 px of shadow bleed.
            --  2. Convert with the IMAGE-PLANE px-per-elmo, (renderHeightPx /
            --     camera.fov) / distance — NOT the projection of a world-Y
            --     unit vector. `infantry_v2` has pitchBins > 1, so
            --     `cardTiltsWithPitch` is true and the card carries the full
            --     camera rotation: `billboardSpritePool` applies the lift along
            --     the CARD's up, i.e. straight up the screen. Using the
            --     world-Y scale inflates the answer by 1/cos(pitch) and the
            --     error hides itself, because it also cancels the row-vs-camera
            --     foreshortening term below.
            -- Subtract that foreshortening term before comparing pitches:
            -- the row is baked at 15/45/80 deg, so at camera elevation tc with
            -- row elevation tr the sprite is short by H*(cos tc - cos tr).
            -- With both corrections the two pitches agree to 0.0003 elmos and
            -- all four classes land on 0.0655 +/- 0.0024 of `impostorSize` —
            -- one framing constant, not four.
            -- Read it off the model, never off an assumed quad height: the
            -- 2026-08-03 live pass found all four defs carrying a lift derived
            -- from a 12-elmo quad the sheets were never baked at.
            local impostorCentreY = o.impostorCentreY or spec.impostorCentreY
            if impostorCentreY then
                def.customparams.impostor_centre_y = string.format('%.4f', impostorCentreY)
            end
            -- Authored `<stem>_impostor_team.ktx2` sidecar exists (R = team
            -- colour blend) — tells the serializer to emit team_mask_uri.
            if o.impostorTeamMask or spec.impostorTeamMask then
                def.customparams.impostor_team_mask = '1'
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
