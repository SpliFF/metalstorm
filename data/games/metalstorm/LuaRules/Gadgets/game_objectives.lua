-- game_objectives.lua — missions & objectives (PLAN-metalstorm.md §3). STUB.
--
-- Objectives are the game: the only primary authority income, both strategic
-- (large/long-lived) and tactical (small/short-lived). Six v0 types:
--   control   — hold a region for a duration
--   kill      — destroy a named unit/building
--   escort    — convoy reaches destination intact
--   protect   — keep target alive for a duration
--   extract   — reach point, hold, evacuate payload
--   infra     — keep/capture civilian infrastructure running
--
-- Sources: scripted scenario content, systemic generation from world state,
-- and TEAM-CREATED (a commander stakes own authority as a bounty — the
-- player→player delegation mechanism).
--
-- State is mirrored to clients via rulesParams (objective_<id>_*) so the JS
-- objectives panel (ui/widgets/objectives-panel.js) can render without a
-- dedicated wire — replace with a proper stream when the directive protocol
-- lands (PLAN-macro-orders.md §5).

function gadget:GetInfo()
    return {
        name    = "Objectives",
        desc    = "Mission/objective registry — the authority income source",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -50,             -- after authority, before regions consumers
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

GG.Objectives = GG.Objectives or {}

local objectives = {}      -- id → objective
local nextId = 1
local rewardScale = 1.0

--[[ objective = {
    id, type,              -- 'control'|'kill'|'escort'|'protect'|'extract'|'infra'
    scope,                 -- 'strategic'|'tactical'
    forTeam,               -- eligible team (nil = any team may complete)
    reward,                -- authority on completion (scaled by modoption)
    bounty,                -- additional pre-staked authority (team-created)
    params,                -- type-specific: region, targetUnitID, route, duration…
    state,                 -- 'active'|'complete'|'failed'|'expired'
    expiresAtFrame,        -- nil = no expiry
    contributors = {},     -- playerID → participation weight (attribution stub)
} ]]

local function publish(o)
    local p = 'objective_' .. o.id .. '_'
    Spring.SetGameRulesParam(p .. 'type',   o.type)
    Spring.SetGameRulesParam(p .. 'scope',  o.scope)
    Spring.SetGameRulesParam(p .. 'state',  o.state)
    Spring.SetGameRulesParam(p .. 'reward', o.reward + (o.bounty or 0))
    Spring.SetGameRulesParam(p .. 'team',   o.forTeam or -1)
    Spring.SetGameRulesParam('objective_count', nextId - 1)
end

function GG.Objectives.Create(def)
    local o = {
        id = nextId,
        type = def.type, scope = def.scope or 'tactical',
        forTeam = def.forTeam,
        reward = (def.reward or 50) * rewardScale,
        bounty = def.bounty or 0,
        params = def.params or {},
        state = 'active',
        expiresAtFrame = def.expiresAtFrame,
        contributors = {},
    }
    nextId = nextId + 1
    objectives[o.id] = o
    publish(o)
    return o.id
end

function GG.Objectives.Complete(id, completingTeam)
    local o = objectives[id]
    if not o or o.state ~= 'active' then return end
    o.state = 'complete'
    publish(o)
    -- Attribution stub (PLAN-metalstorm.md §10.5): until per-player
    -- participation tracking exists, the whole reward goes to the team pool.
    GG.Authority.Award({ team = completingTeam }, o.reward + (o.bounty or 0),
                       'objective_' .. o.type)
end

function GG.Objectives.Fail(id)
    local o = objectives[id]
    if not o or o.state ~= 'active' then return end
    o.state = 'failed'
    publish(o)
end

function gadget:GameStart()
    rewardScale = tonumber(Spring.GetModOptions().authority_reward_scale) or 1.0
    -- TODO systemic generation (density via modoption objective_density):
    -- contested region → control objective; civilian district under threat →
    -- protect/extract; convoy schedule → escort. For now scenarios/tests
    -- create objectives via GG.Objectives.Create.
end

function gadget:GameFrame(frame)
    if frame % 90 ~= 0 then return end     -- 3 s cadence is plenty
    -- TODO evaluate completion conditions per type:
    --   control: GG.Regions.ControllingTeam(params.region) held for duration
    --   kill:    target dead (see UnitDestroyed)
    --   escort/extract: payload at destination
    --   protect: survives until expiry
    for id, o in pairs(objectives) do
        if o.state == 'active' and o.expiresAtFrame and frame >= o.expiresAtFrame then
            o.state = (o.type == 'protect') and 'complete' or 'expired'
            publish(o)
        end
    end
end

function gadget:UnitDestroyed(unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam)
    for id, o in pairs(objectives) do
        if o.state == 'active' then
            if o.type == 'kill' and o.params.targetUnitID == unitID then
                if attackerTeam then GG.Objectives.Complete(id, attackerTeam) end
            elseif (o.type == 'protect' or o.type == 'escort' or o.type == 'extract')
                   and o.params.targetUnitID == unitID then
                GG.Objectives.Fail(id)
            end
        end
    end
end
