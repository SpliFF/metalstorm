-- slate.lua — the goal slate (PLAN-metalstorm-ai.md §3.1).  PURE.
--
-- Input: a Picture table + the active profile + role.  Output: a flat list of
-- candidate goals for the planner to score and assign.  No engine access, no
-- side effects — `slate.build(picture, profile, role)` is a function of its
-- arguments, which is exactly what makes it busted-testable before any engine
-- ask lands (plan §10 task 2: "most of the plan and none of it is blocked").
--
-- A goal is the smallest strategic unit the AI reasons about:
--   { kind, id, source, region?, echelon, directive, value, meta }
--     kind      DEFEND | SCOUT | EXPAND | BUILD | RESERVE | OBJECTIVE | PARLEY
--     source    'explicit' (board) | 'implicit' (standing need) | 'bounty'
--     directive the macro directive SHAPE to request (never a squad command)
--     value     raw expected value BEFORE pSuccess/cost/travel (planner §3.2)

local Slate = {}

--=============================================================================
-- Explicit goals — eligible objectives from the public board (§3.1).
-- Bounties a teammate staked are literally the human tasking the AI (§5);
-- they carry source='bounty' so the planner's ×3 (co-commander) can find them.
--=============================================================================
local function explicitGoals(picture, role, out)
    for id, o in pairs(picture.board or {}) do
        if o.state == 'active' and (role.explicitMode ~= 'none') then
            -- game_objectives.lua always publishes `team` as `o.forTeam or -1`
            -- (never nil) — -1 means "open to anyone" (matches
            -- ui/lib/objectives.js's own forTeam() convention). `nil` is kept
            -- as an equivalent for hand-built test fixtures / a not-yet-read
            -- board entry.
            local eligible = (o.team == nil) or (o.team == -1) or (o.team == role.teamId)
            if eligible then
                out[#out + 1] = {
                    kind     = 'OBJECTIVE',
                    id       = 'obj:' .. tostring(id),
                    source   = (o.source == 'bounty') and 'bounty' or 'explicit',
                    region   = o.region,
                    echelon  = o.scope == 'strategic' and 'army' or 'platoon',
                    directive = Slate.directiveForObjective(o),
                    value    = (o.reward or 0) + (o.bounty or 0),
                    meta     = { objType = o.type, pos = o.pos, progress = o.progress },
                }
            end
        end
    end
end

--- Map an objective type to the macro directive shape that pursues it.
function Slate.directiveForObjective(o)
    local t = o.type
    if t == 'control'  then return 'TAKE_AND_HOLD' end
    if t == 'protect'  then return 'DEFEND'        end
    if t == 'infra'    then return 'DEFEND'        end
    if t == 'kill'     then return 'ASSAULT'       end
    if t == 'escort'   then return 'ESCORT'        end
    if t == 'extract'  then return 'SECURE'        end
    return 'ASSAULT'
end

--=============================================================================
-- Implicit goals — standing strategic needs the board doesn't express (§3.1
-- table). Each is gated by role.implicitKinds so an NPC raider doesn't EXPAND.
--=============================================================================
local function allow(role, kind)
    local set = role.implicitKinds
    return set == nil or set[kind] == true
end

local function implicitGoals(picture, profile, role, config, out)
    local regions = picture.regions or {}
    local intel   = picture.intel or {}

    for key, r in pairs(regions) do
        local owned   = r.owner == role.teamId
        local neutral = r.owner == nil or r.owner == -1
        local hasAdjacentThreat = Slate.adjacentThreat(key, r, intel)

        -- DEFEND: owned, valuable, threat next door.
        if owned and allow(role, 'DEFEND')
           and (r.value or 0) >= config.DEFEND_VALUE_MIN and hasAdjacentThreat then
            out[#out + 1] = {
                kind = 'DEFEND', id = 'def:' .. key, source = 'implicit',
                region = key, echelon = 'army',
                directive = r.contested and 'DEFEND_FRONT' or 'DEFEND',
                value = (r.value or 1),
                meta = { reason = 'adjacent-threat' },
            }
        end

        -- SCOUT: frontier region whose intel has gone stale.
        if allow(role, 'SCOUT') and Slate.isFrontier(key, r, regions, role)
           and Slate.intelStale(key, intel) then
            out[#out + 1] = {
                kind = 'SCOUT', id = 'scout:' .. key, source = 'implicit',
                region = key, echelon = 'platoon', directive = 'SCREEN',
                value = 0.5 * (r.value or 1),
                meta = { reason = 'stale-intel' },
            }
        end

        -- EXPAND: neutral, valuable, adjacent to us, no visible threat.
        if neutral and allow(role, 'EXPAND') and (r.value or 0) > 0
           and Slate.adjacentToOwned(key, r, regions, role) and not hasAdjacentThreat then
            out[#out + 1] = {
                kind = 'EXPAND', id = 'exp:' .. key, source = 'implicit',
                region = key, echelon = 'army', directive = 'TAKE_AND_HOLD',
                value = (r.value or 1),
                meta = { reason = 'open-ground' },
            }
        end
    end

    -- BUILD: a force-composition gap vs the threat composition + an idle
    -- factory. Needs the counters table (power) + factory state — stubbed
    -- predicate; the goal shape is real.
    if allow(role, 'BUILD') then
        local gap = Slate.compositionGap(picture, profile)
        if gap then
            out[#out + 1] = {
                kind = 'BUILD', id = 'build:' .. gap.class, source = 'implicit',
                region = gap.region, echelon = 'platoon',
                directive = 'BUILD', value = gap.value or 1,
                meta = { class = gap.class, defName = gap.defName },
            }
        end
    end

    -- RESERVE: always present, lowest priority — soaks uncommitted force at
    -- the weighted centroid of owned regions (§3.1). The planner sends any
    -- surplus here rather than trickling it into losing fights.
    out[#out + 1] = {
        kind = 'RESERVE', id = 'reserve', source = 'implicit',
        region = nil, echelon = 'army', directive = 'RALLY',
        value = 0.01, meta = { reason = 'staging' },
    }
end

--=============================================================================
-- Predicate stubs — real logic once the Picture is populated (regions graph,
-- intel, counters table). Written against the final Picture shape so they
-- light up without a rewrite; conservative defaults keep a blind AI calm.
--=============================================================================

function Slate.adjacentThreat(key, region, intel)
    for _, nkey in ipairs(region.neighbors or {}) do
        local m = intel[nkey]
        if m and (m.strength or 0) > 0 then return true end
    end
    return false
end

function Slate.isFrontier(key, region, regions, role)
    for _, nkey in ipairs(region.neighbors or {}) do
        local n = regions[nkey]
        if n and n.owner == role.teamId then return true end
    end
    return false
end

function Slate.adjacentToOwned(key, region, regions, role)
    return Slate.isFrontier(key, region, regions, role)
end

function Slate.intelStale(key, intel)
    local m = intel[key]
    return (m == nil) or ((m.confidence or 0) < 0.5)
end

--- Composition gap vs threat (counters bias from profile doctrine). STUB:
-- returns nil (no gap) — the DATA it would need does not exist yet, so this
-- stays a documented gap rather than a guess:
--   1. picture.lua's ledger[region].byClass / intel[region].byClass are now
--      populated (task 3, keyed off the power-table def→class map), so "own
--      composition" and "enemy composition" per region ARE available.
--   2. There is no counters/effectiveness matrix anywhere in the game data
--      (no `strongVs`/`weakVs`/counter_class on any unit def or in
--      weapondefs.lua) to turn "enemy has lots of class X" into "therefore
--      build class Y" — that relationship doesn't exist to read, only to
--      invent, and CLAUDE.md is explicit: reproduce the game's own data,
--      don't substitute hardcoded balance guesses for it.
--   3. There is no "factory idle" signal on the AI surface either
--      (AI.getOwnUnits returns id/x/z/health/defId only — no build-queue or
--      order state; see rts/Server/AI/AIScriptContext.h).
-- Needs a real counters table (a combat-resolution/game-data ask) and an
-- idle-factory read (an AI-surface ask) before this can be more than a
-- guess; both are engine/game-data gaps, not a Picture-shape problem.
function Slate.compositionGap(picture, profile)
    return nil
end

--=============================================================================
-- Entry point.
--=============================================================================
function Slate.build(picture, profile, role)
    local out = {}
    explicitGoals(picture, role, out)
    implicitGoals(picture, profile, role, picture.config, out)

    -- NPC scripted subset (§5): a scenario may hand the role a fixed slate
    -- (raid / defend home / toll a route). If present, it REPLACES the
    -- generated implicit goals but keeps explicit objectives it's eligible for.
    if role.scriptedSlate then
        role.scriptedSlate(picture, out)
    end
    return out
end

return Slate
