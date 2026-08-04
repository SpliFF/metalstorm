-- game_objectives.lua — missions & objectives (PLAN-metalstorm-objectives.md).
--
-- Objectives are the game: the only primary authority income, both strategic
-- (large/long-lived) and tactical (small/short-lived). Six v0 types, one
-- library module each under objectives/ (control/kill/escort/protect/
-- extract/infra) implementing validateParams/init/check/progress/
-- onUnitDestroyed/onExpire/income/participants against a Spring-free `ctx`
-- facade this gadget builds each eval tick — the type modules never call
-- Spring/GG directly, which is what keeps them busted-testable (§9).
--
-- STRUCTURE (task 1): registry, publishing, expiry, participation scanning,
-- and reward split all live HERE (not extracted to a library module — the
-- task explicitly keeps this in the gadget). objectives/generator.lua owns
-- systemic generation (§3.2); objectives/attribution.lua owns the pure
-- participation-split math (§5).
--
-- Sources: scripted scenario content (GG.Objectives.Create), systemic
-- generation from world state (objectives/generator.lua), and team-created
-- bounties (GG.Objectives.CreateBounty — a commander stakes own authority as
-- a delegation mechanism, §3.3).
--
-- State is mirrored to clients via rulesParams (objective_<id>_*) so the JS
-- objectives panel (ui/widgets/objectives-panel.js) can render without a
-- dedicated wire — replace with a proper stream when the directive protocol
-- lands (PLAN-macro-orders.md §5). NOTE (cross-cutting, not fixed here):
-- the server->client rulesParams wire producer does not exist yet
-- (client/src/core/lua-ui-host.ts's handleRulesParamUpdate is a dead
-- consumer) — this gadget's output is correct-by-inspection but
-- unverifiable live until that lands (see PLAN-metalstorm-authority.md
-- field notes for the full writeup; the gap is game-wide, not objectives-
-- specific).

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

local Control      = VFS.Include("LuaRules/Gadgets/objectives/control.lua")
local Kill         = VFS.Include("LuaRules/Gadgets/objectives/kill.lua")
local Escort       = VFS.Include("LuaRules/Gadgets/objectives/escort.lua")
local Protect      = VFS.Include("LuaRules/Gadgets/objectives/protect.lua")
local Extract      = VFS.Include("LuaRules/Gadgets/objectives/extract.lua")
local Infra        = VFS.Include("LuaRules/Gadgets/objectives/infra.lua")
local Generator    = VFS.Include("LuaRules/Gadgets/objectives/generator.lua")
local Attribution  = VFS.Include("LuaRules/Gadgets/objectives/attribution.lua")

local TYPES = {
    control = Control, kill = Kill, escort = Escort,
    protect = Protect, extract = Extract, infra = Infra,
}

GG.Objectives = GG.Objectives or {}

-- Optional observer hooks (PLAN-metalstorm-teams.md task 4: the per-player
-- "objectives completed" scoreboard counter needs a resolve-time signal
-- without duplicating the participation scan in game_teams.lua). Empty by
-- default — this file's own logic never reads it back.
local completeHooks = {}

--- Register fn(o, completingTeam), called once after an objective resolves
--- 'complete' — never for 'failed'/'expired' (a scoreboard counts real wins
--- only). Fires with the SAME o.participation table used for the reward
--- split, so a listener can apply its own threshold without re-scanning.
function GG.Objectives.OnComplete(fn)
    completeHooks[#completeHooks + 1] = fn
end

local EVAL_PERIOD = 90                  -- frames (3s) — strategic-tempo objects, no per-frame checks (§2)
local RESOLVE_RETENTION_FRAMES = 900    -- 30s: resolved objectives keep params for the UI's resolve animation (§1)
local BOUNTY_CAP_PER_PLAYER = 4         -- spam guard (§3.3)
local PARTICIPATION_TICK_WEIGHT = 1.0   -- §5 "ordering units... 1.0 per eval tick per squad"
local PARTICIPATION_PRESENCE_WEIGHT = 2.0   -- §5 "presence at completion... 2.0 per squad"

local objectives = {}      -- id -> objective
local nextId = 1
-- How many objectives carrying `victory = true` have ever been created.
-- game_gameover.lua reads this to say out loud whether the war it is
-- watching has any terminal condition at all (PLAN-endtoend.md D10). A
-- high-water mark, not a live count: an expired victory objective still
-- means the war was *authored* to be endable, which is the question asked.
local victoryObjectivesCreated = 0
local rewardScale = 1.0
local evalTick = 0
local genState = Generator.newState()
local bountyCountByPlayer = {}

--[[ objective = {
    id, type,            -- 'control'|'kill'|'escort'|'protect'|'extract'|'infra'
    scope,                -- 'strategic'|'tactical'
    forTeam,              -- eligible team (nil = open race, any team may complete)
    reward, bounty,       -- base authority + staked escrow (authority §2)
    params,                -- type-specific
    state,                -- 'active'|'complete'|'failed'|'expired'
    progress,              -- 0..1
    phase,                 -- chain phase index (§4.7), nil if not chained
    phaseDefs, phaseIdx, phaseChildren,  -- chaining internals (only on a phase parent)
    parentId,              -- strategic parent for chained tacticals
    linkedId,               -- mutual-resolve partner (E4)
    expiresAtFrame,
    participation = {},    -- playerID -> weight (§5)
    victory,               -- true = terminal; completing it ends the war (wars §7.1)
    createdFrame, source,   -- 'scripted'|'systemic'|'bounty'
    systemicKey, systemicRule,  -- generator dedup bookkeeping (nil for non-systemic objectives)
    resolvedFrame,           -- frame it left 'active' (retention window)
    data,                     -- per-type internal working state (opaque to this file)
} ]]

-- ============================================================
-- activeList: O(1) add/remove so the eval tick never walks resolved
-- history (task 1 "activeList optimisation").
-- ============================================================
local activeList = {}
local activeIndex = {}     -- id -> index in activeList
local pendingClear = {}    -- ids awaiting resolve-retention param clearing

local function addToActive(id)
    activeList[#activeList + 1] = id
    activeIndex[id] = #activeList
end

local function removeFromActive(id)
    local idx = activeIndex[id]
    if not idx then return end
    local lastIdx = #activeList
    local lastId = activeList[lastIdx]
    activeList[idx] = lastId
    activeIndex[lastId] = idx
    activeList[lastIdx] = nil
    activeIndex[id] = nil
end

-- ============================================================
-- Shared helpers (mirror game_authority.lua's team/player lookups)
-- ============================================================
local function playerTeam(playerID)
    local _, _, _, teamID = Spring.GetPlayerInfo(playerID, false)
    return teamID
end

local function isPlayerActive(playerID)
    local _, active = Spring.GetPlayerInfo(playerID, false)
    return active == true
end

-- ============================================================
-- ctx facade (Spring-backed) handed to type modules. Built once per eval
-- tick / per discrete event so the per-region unit index is computed once,
-- not once per objective (§6 perf note: O(units) per eval tick, matching
-- game_regions.lua's own gatherUnits() cost, not O(units * objectives)).
-- ============================================================
local function resolvedUnitPos(unitID)
    local x, y, z = Spring.GetUnitPosition(unitID)
    if x then return x, y, z end
    -- E5: a loaded/garrisoned payload counts at the transport's position.
    local transporter = Spring.GetUnitTransporter(unitID)
    if transporter then return Spring.GetUnitPosition(transporter) end
    return nil
end

local function regionExists(key)
    if not GG.Regions then return false end
    for _, k in ipairs(GG.Regions.Keys()) do
        if k == key then return true end
    end
    return false
end

local function buildCtx(frame)
    local unitsByRegion = {}
    if GG.Regions then
        for _, unitID in ipairs(Spring.GetAllUnits()) do
            local x, _, z = Spring.GetUnitPosition(unitID)
            if x then
                local key = GG.Regions.KeyAt(x, z)
                if key then
                    local list = unitsByRegion[key]
                    if not list then list = {}; unitsByRegion[key] = list end
                    list[#list + 1] = unitID
                end
            end
        end
    end

    return {
        frame = frame,
        evalPeriodFrames = EVAL_PERIOD,
        regionOwner = function(key)
            return GG.Regions and GG.Regions.ControllingTeam(key) or nil
        end,
        regionExists = regionExists,
        unitsInRegion = function(key) return unitsByRegion[key] or {} end,
        unitAlive = function(unitID)
            return Spring.ValidUnitID(unitID) and Spring.GetUnitHealth(unitID) ~= nil
        end,
        unitPos = resolvedUnitPos,
        unitTeam = function(unitID) return Spring.GetUnitTeam(unitID) end,
        unitsInArea = function(x, z, r) return Spring.GetUnitsInCylinder(x, z, r) end,
        teamStrengthInArea = function(x, z, r, team)
            if not team then return 0 end
            local total = 0
            for _, unitID in ipairs(Spring.GetUnitsInCylinder(x, z, r)) do
                if Spring.GetUnitTeam(unitID) == team then
                    total = total + (Spring.GetUnitHealth(unitID) or 0)
                end
            end
            return total
        end,
        -- "Running" = alive and (if the def carries the rulesParam) operational
        -- (§4.6); a building with no such rulesParam is always operational.
        isOperational = function(unitID)
            local v = Spring.GetUnitRulesParam(unitID, 'operational')
            return v == nil or v ~= 0
        end,
        -- §4.5: extract phase-1->2 move orders, issued through the objectives
        -- gadget directly (fromLua, free — no authority charge).
        issueMove = function(unitIDs, x, z)
            local y = Spring.GetGroundHeight(x, z)
            for _, unitID in ipairs(unitIDs) do
                Spring.GiveOrderToUnit(unitID, CMD.MOVE, { x, y, z }, {})
            end
        end,
        lastCommander = function(unitID)
            local v = Spring.GetUnitRulesParam(unitID, 'last_commander')
            return v and math.floor(v) or nil
        end,
    }
end

-- ============================================================
-- Publishing v2 (task 7): progress/phase/stage/position hints,
-- resolve-retention window, objective_count high-water contract.
-- ============================================================
local function positionHint(o, ctx)
    if o.type == 'control' then
        return nil, nil, nil, o.params.regionKey
    elseif o.type == 'kill' then
        local x, _, z = ctx.unitPos(o.params.targetUnitID)
        return x, z, nil, nil
    elseif o.type == 'escort' then
        local d = o.params.destArea
        return d and d.x, d and d.z, d and d.r, nil
    elseif o.type == 'extract' then
        local a = (o.data and o.data.phase == 'evac') and o.params.extractArea or o.params.pickupArea
        return a and a.x, a and a.z, a and a.r, nil
    elseif o.type == 'protect' or o.type == 'infra' then
        local ids = o.params.targetUnitIDs or o.params.buildingUnitIDs
        local first = ids and ids[1]
        if not first then return nil end
        local x, _, z = ctx.unitPos(first)
        return x, z, nil, nil
    end
    return nil
end

local PUBLISHED_FIELDS = {
    'type', 'scope', 'state', 'reward', 'team', 'team2', 'progress',
    'phase', 'stage', 'expire', 'region', 'x', 'z', 'r', 'suggested', 'source',
    'victory',
}

-- Objectives are the shared strategic board (PLAN-metalstorm §"Objectives are
-- the game"): every player sees the full set and the panel filters/labels by
-- `objective_<id>_team`. Published PUBLIC so the params stream to browser
-- clients — game rules params default to RULESPARAMLOS_PRIVATE (synced-only),
-- which is why the objectives panel showed "No active objectives" until now.
local PUBLIC = { public = true }

local function clearPublished(o)
    local p = 'objective_' .. o.id .. '_'
    for _, field in ipairs(PUBLISHED_FIELDS) do
        Spring.SetGameRulesParam(p .. field, nil)
    end
end

local function publish(o, ctx)
    local p = 'objective_' .. o.id .. '_'
    Spring.SetGameRulesParam(p .. 'type', o.type, PUBLIC)
    Spring.SetGameRulesParam(p .. 'scope', o.scope, PUBLIC)
    Spring.SetGameRulesParam(p .. 'state', o.state, PUBLIC)
    Spring.SetGameRulesParam(p .. 'reward', o.reward + (GG.Authority.EscrowTotal(o.id) or 0), PUBLIC)
    Spring.SetGameRulesParam(p .. 'team', o.forTeam or -1, PUBLIC)
    -- PLAN-metalstorm-interaction.md §1 joint_objective: the widened
    -- co-eligible team, if any (GG.Objectives.WidenEligibility).
    if o.forTeam2 then Spring.SetGameRulesParam(p .. 'team2', o.forTeam2, PUBLIC) end
    Spring.SetGameRulesParam(p .. 'progress', o.progress or 0, PUBLIC)
    -- PLAN-metalstorm-teams.md §3.3: joiner onboarding hint, set via
    -- GG.Objectives.SuggestFor. The panel renders this as "yours to take".
    if o.suggestedFor then Spring.SetGameRulesParam(p .. 'suggested', o.suggestedFor, PUBLIC) end
    -- source ∈ 'scripted'|'systemic'|'bounty' (§3.3). A staked bounty is
    -- publicly known (a commander visibly stakes authority on the objective),
    -- so surfacing the flag is fog-honest — it lets the co-commander AI apply
    -- its ×3 bounty weighting (PLAN-metalstorm-ai §3.2/§5) to a teammate's
    -- tasking, exactly as it already sees the `suggested` soft-hint. Only the
    -- categorical flag ships; the stake amount stays folded into `reward`.
    if o.source then Spring.SetGameRulesParam(p .. 'source', o.source, PUBLIC) end
    -- wars §7.1: the scenario's terminal objective. Public so the panel can
    -- mark "winning this ends the war" — everyone can see the war's win
    -- condition, it is not fog-gated intel.
    if o.victory then Spring.SetGameRulesParam(p .. 'victory', 1, PUBLIC) end
    if o.phase then Spring.SetGameRulesParam(p .. 'phase', o.phase, PUBLIC) end
    if o.type == 'extract' and o.data and o.data.phase then
        Spring.SetGameRulesParam(p .. 'stage', o.data.phase, PUBLIC)
    end
    if o.expiresAtFrame then Spring.SetGameRulesParam(p .. 'expire', o.expiresAtFrame, PUBLIC) end

    local x, z, r, region = positionHint(o, ctx)
    if region then
        Spring.SetGameRulesParam(p .. 'region', region, PUBLIC)
    elseif x then
        Spring.SetGameRulesParam(p .. 'x', x, PUBLIC)
        Spring.SetGameRulesParam(p .. 'z', z, PUBLIC)
        if r then Spring.SetGameRulesParam(p .. 'r', r, PUBLIC) end
    end
    Spring.SetGameRulesParam('objective_count', nextId - 1, PUBLIC)
end

-- ============================================================
-- Reward attribution (§5) — filters participation to completingTeam's own
-- players first (an enemy commander who wandered near a contested objective
-- must never receive a share of the winning side's reward), then defers the
-- active/inactive split to attribution.lua.
-- ============================================================
local function distributeAward(amount, participation, completingTeam, reason)
    if not amount or amount <= 0 or not completingTeam then return end
    local ownTeamOnly = {}
    for playerID, w in pairs(participation) do
        if playerTeam(playerID) == completingTeam then ownTeamOnly[playerID] = w end
    end
    if Attribution.isEmpty(ownTeamOnly) then
        -- §5 "zero-participation completions... pay 100% to the team pool".
        GG.Authority.Award({ team = completingTeam }, amount, reason)
        return
    end
    local weights, teamWeight = Attribution.splitWeights(ownTeamOnly, isPlayerActive)
    GG.Authority.Award({ split = { team = completingTeam, weights = weights, teamWeight = teamWeight } },
                        amount, reason)
end

local function awardObjective(o, completingTeam)
    completingTeam = completingTeam or o.forTeam
    local amount = o.reward + (GG.Authority.EscrowTotal(o.id) or 0)
    distributeAward(amount, o.participation, completingTeam, 'objective_' .. o.type)
    GG.Authority.SettleEscrow(o.id, 'complete')
end

local function awardPeriodic(o, amount)
    if not o.forTeam then return end
    distributeAward(amount, o.participation, o.forTeam, 'objective_' .. o.type .. '_income')
end

-- ============================================================
-- Phase chaining (§4.7, task 6)
-- ============================================================
local function parentProgress(o)
    if not o.phaseChildren or #o.phaseChildren == 0 then return 0 end
    local done = 0
    for _, cid in ipairs(o.phaseChildren) do
        local c = objectives[cid]
        if c and c.state == 'complete' then done = done + 1 end
    end
    return done / #o.phaseChildren
end

local spawnPhase   -- forward decl (mutually recursive with GG.Objectives.Create)
local resolveObjective

local function onChildResolved(child, ctx)
    if not child.parentId then return end
    local parent = objectives[child.parentId]
    if not parent or parent.state ~= 'active' then return end

    if child.state ~= 'complete' then
        -- A failed/expired phase child fails the whole chain (documented
        -- simplification — the plan doesn't specify partial-phase recovery).
        resolveObjective(parent, 'failed', nil, ctx)
        return
    end

    for playerID, w in pairs(child.participation) do
        Attribution.credit(parent.participation, playerID, w)
    end

    for _, cid in ipairs(parent.phaseChildren) do
        local c = objectives[cid]
        if c and c.state == 'active' then return end   -- phase not fully resolved yet
    end

    parent.phaseIdx = parent.phaseIdx + 1
    if parent.phaseIdx > #parent.phaseDefs then
        resolveObjective(parent, 'complete', parent.forTeam, ctx)
        return
    end

    parent.phase = parent.phaseIdx
    spawnPhase(parent, parent.phaseIdx, ctx)
    if #parent.phaseChildren == 0 then
        -- Next phase had nothing valid to spawn — fail rather than soft-lock
        -- the parent forever with no children to ever call back.
        resolveObjective(parent, 'failed', nil, ctx)
    else
        publish(parent, ctx)
    end
end

-- ============================================================
-- Terminal resolution — the single place any objective leaves 'active'.
-- ============================================================
function resolveObjective(o, state, completingTeam, ctx)
    if o.state ~= 'active' then return end
    o.state = state
    o.resolvedFrame = ctx.frame
    removeFromActive(o.id)
    pendingClear[#pendingClear + 1] = o.id

    if state == 'complete' then
        awardObjective(o, completingTeam)
        for _, fn in ipairs(completeHooks) do fn(o, completingTeam) end
    else
        GG.Authority.SettleEscrow(o.id, state)   -- 'failed' | 'expired' -> refund stakers
    end

    if o.systemicKey then
        Generator.onResolved(genState, o.systemicRule, o.systemicKey)
    end

    -- E4: mutual resolve — a still-active linked partner is mooted out.
    if o.linkedId then
        local partner = objectives[o.linkedId]
        if partner and partner.state == 'active' then
            resolveObjective(partner, 'expired', nil, ctx)
        end
    end

    if o.parentId then
        onChildResolved(o, ctx)
    end

    publish(o, ctx)
end

-- ============================================================
-- GG.Objectives API
-- ============================================================

--- Create an objective. Returns the new id, or nil if params/init
--- validation rejected the def (E1 "Create returns nil on stale input") —
--- callers (scenario scripts, the generator, CreateBounty) must treat nil
--- as "no objective was created", not an error to propagate.
function GG.Objectives.Create(def)
    local module = def and TYPES[def.type]
    if not module then return nil end

    local ok, err = module.validateParams(def.params or {})
    if not ok then
        Spring.Echo('[Objectives] rejected ' .. tostring(def.type) .. ' create: ' .. tostring(err))
        return nil
    end

    local frame = Spring.GetGameFrame()
    local id = nextId
    nextId = nextId + 1

    local o = {
        id = id, type = def.type, scope = def.scope or 'tactical',
        forTeam = def.forTeam, forTeam2 = def.forTeam2,
        reward = (def.reward or 0) * rewardScale,
        bounty = def.bounty or 0,
        params = def.params or {},
        state = 'active', progress = 0,
        phase = def.phase, parentId = def.parentId, linkedId = def.linkedId,
        expiresAtFrame = def.expiresAtFrame,
        participation = Attribution.newParticipation(),
        createdFrame = frame, source = def.source or 'scripted',
        systemicKey = def.systemicKey, systemicRule = def.systemicRule,
        victory = def.victory or nil,
    }

    local ctx = buildCtx(frame)
    if module.init then
        local initOk, initErr = module.init(o, ctx)
        if not initOk then
            Spring.Echo('[Objectives] rejected ' .. tostring(def.type) .. ' init: ' .. tostring(initErr))
            return nil   -- id is burned (monotonic), never reused — objective_count stays a high-water mark
        end
    end

    objectives[id] = o
    addToActive(id)
    if o.victory then victoryObjectivesCreated = victoryObjectivesCreated + 1 end

    if def.phases and #def.phases > 0 then
        o.phaseDefs = def.phases
        o.phaseIdx = 1
        o.phase = 1
        spawnPhase(o, 1, ctx)
        if #o.phaseChildren == 0 then
            -- Phase 1 had nothing valid to spawn — treat like any other
            -- stale/invalid def (E1): never publish, never book the id.
            objectives[id] = nil
            removeFromActive(id)
            return nil
        end
    end

    publish(o, ctx)
    return id
end

--- Spawn one phase's children under `parent`, tagging parentId/forTeam.
--- Copies each childDef (never mutates the caller's def.phases table — the
--- same def could in principle be reused across multiple Create calls).
function spawnPhase(parent, idx, ctx)
    parent.phaseChildren = {}
    for _, childDef in ipairs(parent.phaseDefs[idx] or {}) do
        local child = {}
        for k, v in pairs(childDef) do child[k] = v end
        child.parentId = parent.id
        child.forTeam = child.forTeam or parent.forTeam
        local cid = GG.Objectives.Create(child)
        if cid then parent.phaseChildren[#parent.phaseChildren + 1] = cid end
    end
end

--- Create a mutually-resolving pair (E4 — e.g. generator's escort+kill
--- race): if either half fails validation, the whole pair is rolled back
--- rather than left half-created. Returns the escort/first id (used only as
--- a dedup-bookkeeping handle by callers), or nil.
function GG.Objectives.CreateLinkedPair(defA, defB)
    local idA = GG.Objectives.Create(defA)
    if not idA then return nil end
    local idB = GG.Objectives.Create(defB)
    if not idB then
        local a = objectives[idA]
        clearPublished(a)
        removeFromActive(idA)
        objectives[idA] = nil
        return nil
    end
    objectives[idA].linkedId = idB
    objectives[idB].linkedId = idA
    return idA
end

--- Team-created bounty (§3.3): validates the cap + the stake, escrows it,
--- creates the objective with source='bounty' and reward=0 (the escrow IS
--- the reward). Returns the objective id, or nil (cap hit, stake unaffordable,
--- or the def itself failed Create's own validation).
function GG.Objectives.CreateBounty(playerID, def, stakeAmount)
    if (bountyCountByPlayer[playerID] or 0) >= BOUNTY_CAP_PER_PLAYER then return nil end
    local team = playerTeam(playerID)
    if not team then return nil end

    local bountyDef = {}
    for k, v in pairs(def) do bountyDef[k] = v end
    bountyDef.source = 'bounty'
    bountyDef.forTeam = def.forTeam or team
    bountyDef.reward = 0

    local id = GG.Objectives.Create(bountyDef)
    if not id then return nil end

    if not GG.Authority.Stake(playerID, id, stakeAmount) then
        local o = objectives[id]
        clearPublished(o)
        removeFromActive(id)
        objectives[id] = nil
        return nil
    end

    bountyCountByPlayer[playerID] = (bountyCountByPlayer[playerID] or 0) + 1
    local o = objectives[id]
    o.bounty = stakeAmount
    publish(o, buildCtx(Spring.GetGameFrame()))
    return id
end

--- Read-only accessor for scenario scripts/tests. Do not mutate the result.
function GG.Objectives.Get(id)
    return objectives[id]
end

--- How many `victory = true` objectives this war has ever staged
--- (PLAN-endtoend.md D10). Zero means game_gameover.lua has nothing to
--- watch and the war cannot end — which used to be the silent outcome of
--- creating a room through the lobby instead of a direct manifest.
function GG.Objectives.VictoryObjectiveCount()
    return victoryObjectivesCreated
end

--- `teamID`'s lowest-participation active tactical objective
--- (PLAN-metalstorm-teams.md §3.3 joiner onboarding hint — "point the
--- joiner at real team work"). "Lowest participation" = smallest sum of
--- credited weight (untouched work first); ties broken by lowest id
--- (deterministic, oldest first). Only considers objectives scoped
--- specifically to `teamID` (forTeam == teamID) — an open-race objective
--- (forTeam == nil) isn't "the team's" to suggest. Returns nil if none are
--- eligible.
function GG.Objectives.LowestParticipationTactical(teamID)
    local bestId, bestWeight
    for _, id in ipairs(activeList) do
        local o = objectives[id]
        if o and o.scope == 'tactical' and o.forTeam == teamID then
            local w = 0
            for _, pw in pairs(o.participation) do w = w + (pw or 0) end
            if not bestWeight or w < bestWeight or (w == bestWeight and id < bestId) then
                bestId, bestWeight = id, w
            end
        end
    end
    return bestId
end

--- Mark an objective as "suggested for" a joining player — a rulesParam
--- hint (§3.3) the panel renders as "yours to take". No-op on an
--- unknown/non-active id (E1: a joiner might land in the same eval window
--- as the objective resolving).
function GG.Objectives.SuggestFor(id, playerID)
    local o = objectives[id]
    if not o or o.state ~= 'active' then return end
    o.suggestedFor = playerID
    publish(o, buildCtx(Spring.GetGameFrame()))
end

--- Widen a scoped (forTeam-gated) objective to a second eligible team
--- (PLAN-metalstorm-interaction.md §1 joint_objective — game_parley.lua
--- calls this on accept). No-op on an unknown/non-active/unscoped
--- (forTeam == nil, already-open-race) objective, or on a type that has no
--- eligibility gate to widen in the first place (only `control` currently
--- gates completion by forTeam — kill/escort/protect/extract/infra either
--- have no gate at all (kill: whoever lands the kill) or are inherently
--- single-team missions where "eligibility" isn't a meaningful concept, so
--- forTeam2 is harmless bookkeeping there, not a silent gap).
function GG.Objectives.WidenEligibility(id, teamID)
    local o = objectives[id]
    if not o or o.state ~= 'active' or not o.forTeam or not teamID then return false end
    if teamID == o.forTeam then return false end
    o.forTeam2 = teamID
    publish(o, buildCtx(Spring.GetGameFrame()))
    return true
end

--- Manual scripted abort (mission scripts cancelling a no-longer-relevant
--- objective). There is deliberately no public Complete() — completion
--- must come from the type's own predicate so completingTeam/participation
--- are attributed correctly; forcing it would bypass §5 entirely.
function GG.Objectives.Fail(id)
    local o = objectives[id]
    if not o or o.state ~= 'active' then return end
    resolveObjective(o, 'failed', nil, buildCtx(Spring.GetGameFrame()))
end

--- War-end sweep (PLAN-metalstorm-wars.md §7 `resolving`, called by
--- game_gameover.lua): every still-active objective resolves 'expired', which
--- routes through the one terminal path above and so refunds each staked
--- bounty via SettleEscrow — "no authority is destroyed or awarded to the
--- enemy by war end". Deliberately NOT 'failed': the objectives weren't lost,
--- the war stopped. Returns the number swept.
---
--- Iterates a snapshot of activeList because resolveObjective mutates it
--- (removeFromActive swap-pops, and a linked partner / phase parent can
--- resolve a second entry re-entrantly) — walking the live list would skip.
function GG.Objectives.ExpireAllActive()
    local snapshot = {}
    for i = 1, #activeList do snapshot[i] = activeList[i] end
    local ctx = buildCtx(Spring.GetGameFrame())
    local n = 0
    for _, id in ipairs(snapshot) do
        local o = objectives[id]
        if o and o.state == 'active' then
            resolveObjective(o, 'expired', nil, ctx)
            n = n + 1
        end
    end
    return n
end

-- ============================================================
-- Participation scanning (§5)
-- ============================================================
local function creditParticipation(o, ctx, weight)
    local module = TYPES[o.type]
    if not module.participants then return end
    for _, unitID in ipairs(module.participants(o, ctx)) do
        Attribution.credit(o.participation, ctx.lastCommander(unitID), weight)
    end
end

-- ============================================================
-- World facade for the systemic generator (Spring/GG-backed; the generator
-- itself is pure and fake-testable, §9).
-- ============================================================
local function buildWorld(frame, tick, ctx)
    return {
        frame = frame, tick = tick,
        contestedRegions = function()
            return GG.Regions and GG.Regions.GetContested() or {}
        end,
        regionValue = function(key)
            return GG.Regions and GG.Regions.Value(key) or 0
        end,
        -- Civilian district threat detection is real
        -- (civilians/estate.lua's threatenedDistricts(), PLAN-metalstorm-
        -- interaction.md §3/§10 task 5) but civilians/spawn.lua's placement
        -- seeding is still a stub (no map-authored district data) — so this
        -- yields nothing until that separate, pre-existing civilians
        -- backlog item lands; nothing here needs to change when it does.
        -- convoy scheduling (civilians/convoy.lua) is likewise still a stub.
        civilianDistrictsUnderThreat = function()
            return GG.Civilians and GG.Civilians.ThreatenedDistricts and GG.Civilians.ThreatenedDistricts() or {}
        end,
        newConvoys = function() return {} end,
        -- No unit def currently sets the `objective_infra` customParams tag
        -- (mirrors game_authority.lua's `authority_cost_base` convention) —
        -- same "ready, awaiting content" status as the civilian rules.
        infraBuildings = function()
            local out = {}
            for _, unitID in ipairs(Spring.GetAllUnits()) do
                local udid = Spring.GetUnitDefID(unitID)
                local ud = udid and UnitDefs[udid]
                if ud and ud.customParams and ud.customParams.objective_infra then
                    local hp, maxHp = Spring.GetUnitHealth(unitID)
                    if hp and maxHp and maxHp > 0 then
                        out[#out + 1] = {
                            unitID = unitID, ownerTeam = Spring.GetUnitTeam(unitID),
                            healthFrac = hp / maxHp,
                        }
                    end
                end
            end
            return out
        end,
        teams = function()
            local out = {}
            local gaia = Spring.GetGaiaTeamID()
            for _, teamID in ipairs(Spring.GetTeamList()) do
                if teamID ~= gaia then out[#out + 1] = teamID end
            end
            return out
        end,
        completableObjectiveCount = function(team)
            local n = 0
            for _, id in ipairs(activeList) do
                local o = objectives[id]
                if o and (o.forTeam == nil or o.forTeam == team) then n = n + 1 end
            end
            return n
        end,
        -- No spatial "nearest" index is available without a full unit scan;
        -- any neutral/non-owned region satisfies the liveness backstop's
        -- contract ("a reachable objective exists"), not specifically the
        -- closest one — deterministic (Keys() order), good enough for a
        -- dead-game backstop.
        nearestNeutralOrContestedRegion = function(team)
            if not GG.Regions then return nil end
            for _, key in ipairs(GG.Regions.Keys()) do
                local owner = GG.Regions.ControllingTeam(key)
                if owner == nil or owner ~= team then return key end
            end
            return nil
        end,
        modOptions = function() return Spring.GetModOptions() end,
        create = function(def) return GG.Objectives.Create(def) end,
        createLinkedPair = function(defA, defB) return GG.Objectives.CreateLinkedPair(defA, defB) end,
    }
end

-- ============================================================
-- Lifecycle
-- ============================================================

function gadget:GameStart()
    rewardScale = tonumber(Spring.GetModOptions().authority_reward_scale) or 1.0
end

function gadget:GameFrame(frame)
    if frame % EVAL_PERIOD ~= 0 then return end
    evalTick = evalTick + 1
    local ctx = buildCtx(frame)

    -- Snapshot: resolveObjective mutates activeList mid-iteration (removals,
    -- phase-chain cascades), so walk a copy.
    local snapshot = {}
    for i, id in ipairs(activeList) do snapshot[i] = id end

    for _, id in ipairs(snapshot) do
        local o = objectives[id]
        if o and o.state == 'active' then
            if o.phaseDefs then
                -- Phase-chained parent (§4.7): resolution is driven entirely
                -- by onChildResolved's phase cascade, not by the parent's own
                -- type predicate — running both would race two independent
                -- completion mechanisms against each other. Documented
                -- simplification (the plan doesn't specify how a parent's own
                -- check() should interact with phase children); expiry still
                -- applies (a timed-out mission fails regardless of phase).
                if o.expiresAtFrame and frame >= o.expiresAtFrame then
                    resolveObjective(o, 'expired', nil, ctx)
                else
                    o.progress = parentProgress(o)
                    publish(o, ctx)
                end
            else
                local module = TYPES[o.type]
                if o.expiresAtFrame and frame >= o.expiresAtFrame then
                    local outcome, team
                    if module.onExpire then
                        outcome, team = module.onExpire(o, ctx)
                    else
                        outcome = 'expired'
                    end
                    resolveObjective(o, outcome, team, ctx)
                else
                    local state, team = module.check(o, ctx)
                    if state then
                        resolveObjective(o, state, team, ctx)
                    else
                        o.progress = (module.progress and module.progress(o, ctx)) or o.progress

                        if module.income then
                            local amount = module.income(o, ctx)
                            if amount and amount > 0 then awardPeriodic(o, amount) end
                        end

                        creditParticipation(o, ctx, PARTICIPATION_TICK_WEIGHT)
                        publish(o, ctx)
                    end
                end
            end
        end
    end

    -- Stop generating once the war leaves 'active' (game_gameover.lua's §7
    -- chain: winding_down → resolving → over). Existing objectives keep being
    -- evaluated above — a final push during the grace window still resolves —
    -- but new ones must not appear. During wind-down they are unwinnable by
    -- construction (10 s left) and `resolve()` expires them again seconds
    -- later; the generator was seen growing a settled Meridian board from 9
    -- objectives to 34 on 2026-08-03, when the server was still simulating
    -- past the declared win. The sim freeze (PostGamePolicy.h) is what stops
    -- this after the result lands; this gate covers the grace window before
    -- it, and does not depend on the freeze to be correct.
    --
    -- nil means "no gameover gadget in this game" → active, generate.
    if (GG.WarState or 'active') == 'active' then
        Generator.tick(buildWorld(frame, evalTick, ctx), genState)
    end

    -- Resolve-retention: clear rulesParams for objectives past the 30s window.
    for i = #pendingClear, 1, -1 do
        local id = pendingClear[i]
        local o = objectives[id]
        if not o or (frame - o.resolvedFrame) >= RESOLVE_RETENTION_FRAMES then
            if o then clearPublished(o) end
            table.remove(pendingClear, i)
        end
    end
end

function gadget:UnitDestroyed(unitID, unitDefID, unitTeam, attackerID, attackerDefID, attackerTeam)
    local ctx = buildCtx(Spring.GetGameFrame())

    -- §5 presence-at-completion bonus: credit whoever's nearby a beat before
    -- dispatching onUnitDestroyed, so a kill/protect-fail landing this exact
    -- tick still reflects who was actually there when it happened.
    local snapshot = {}
    for i, id in ipairs(activeList) do snapshot[i] = id end

    for _, id in ipairs(snapshot) do
        local o = objectives[id]
        -- Phase-chained parents (§4.7) never resolve via their own type's
        -- callbacks — see the GameFrame note. Skip them here too.
        if o and o.state == 'active' and not o.phaseDefs then
            local module = TYPES[o.type]
            if module.onUnitDestroyed then
                local state, team = module.onUnitDestroyed(o, unitID, attackerTeam, ctx)
                if state then
                    creditParticipation(o, ctx, PARTICIPATION_PRESENCE_WEIGHT)
                    resolveObjective(o, state, team, ctx)
                end
            end
        end
    end
end
