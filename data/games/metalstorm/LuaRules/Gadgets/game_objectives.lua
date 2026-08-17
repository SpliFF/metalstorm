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
-- PLAN-metalstorm-wars.md §7 task 4: the per-objective war-end disposition
-- rule, pure and tested on its own (objectives/tests/warend_spec.lua). The
-- WALK is here in ExpireAllActive; the RULE is there.
local WarEnd       = VFS.Include("LuaRules/Gadgets/objectives/warend.lua")
local Tick         = VFS.Include("LuaRules/Gadgets/tick.lua")

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

local objectives = {}      -- id -> objective (LIVE only, see the archive below)
local nextId = 1

-- ============================================================
-- Resolved-objective archive (PLAN-long-uptime S4).
--
-- `objectives[id]` used to be write-once-and-keep: resolveObjective removed
-- the id from activeList and queued its rulesParams for clearing, but the
-- objective table itself — participation map, params, phase children, data —
-- stayed reachable for the life of the game. Over the weeks-long campaign
-- this game is aimed at, that is the synced Lua heap growing without bound,
-- and no GC can reclaim it because it is still referenced.
--
-- Policy: a resolved objective moves here once its retention window ends, and
-- this table is ring-capped. Past the cap the oldest resolved objective is
-- dropped for good. Reads that may legitimately name a resolved objective go
-- through `lookupObjective`; every hot path iterates `activeList` and never
-- touches this at all.
--
-- The cap is deliberately far larger than any resolve cascade: archiving only
-- happens RESOLVE_RETENTION_FRAMES (30 s) after resolution, while phase-parent
-- and linked-partner cascades all complete within the tick that resolves the
-- child, so an evicted entry is never one another objective is still reasoning
-- about.
-- ============================================================
local ARCHIVE_CAP = 256
local archive = {}         -- id -> resolved objective, at most ARCHIVE_CAP live
local archiveRing = {}     -- slot -> id, insertion-ordered
local archiveSlot = 0

local function archiveObjective(id)
    local o = objectives[id]
    if not o then return end
    objectives[id] = nil
    archiveSlot = (archiveSlot % ARCHIVE_CAP) + 1
    local evicted = archiveRing[archiveSlot]
    if evicted then archive[evicted] = nil end
    archiveRing[archiveSlot] = id
    archive[id] = o
end

--- Objective by id whether it is still live or recently resolved. Returns nil
--- for an id that was resolved long enough ago to fall out of the archive.
local function lookupObjective(id)
    return objectives[id] or archive[id]
end

-- How many objectives carrying `victory = true` have ever been created.
-- game_gameover.lua reads this to say out loud whether the war it is
-- watching has any terminal condition at all (PLAN-endtoend.md D10). A
-- high-water mark, not a live count: an expired victory objective still
-- means the war was *authored* to be endable, which is the question asked.
local victoryObjectivesCreated = 0
local rewardScale = 1.0
local evalTick = 0
-- D15: the eval cadence is skip-safe (see tick.lua). Observation policy, so a
-- multi-period stall still yields one eval — the control clock loses nothing by
-- it, because D57 made `control.accrue` bank the elapsed interval rather than a
-- fixed period per tick.
local evalGate = Tick.new(EVAL_PERIOD)
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
    'victory', 'completed_by',
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
    -- endtoend D11: WHO completed it, which `team` above cannot carry. `team`
    -- is the ELIGIBILITY field (`o.forTeam or -1`) and ui/lib/objectives.js
    -- filters on it — an open race publishes -1 so both sides see it, and
    -- overwriting that at resolve would hide the result from the loser during
    -- the retention window. So the outcome gets its own key, and an open-race
    -- victory stops reading as "completed by nobody".
    if o.completedBy then
        Spring.SetGameRulesParam(p .. 'completed_by', o.completedBy, PUBLIC)
    end
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
        local c = lookupObjective(cid)
        if c and c.state == 'complete' then done = done + 1 end
    end
    return done / #o.phaseChildren
end

local spawnPhase   -- forward decl (mutually recursive with GG.Objectives.Create)
local resolveObjective

local function onChildResolved(child, ctx)
    if not child.parentId then return end
    local parent = lookupObjective(child.parentId)
    if not parent or parent.state ~= 'active' then return end
    -- A parent created WITHOUT `phases` has no phaseDefs/phaseIdx/phaseChildren
    -- — reachable from content now that scenarios forward `parentId` verbatim,
    -- and every line below would raise on nil (inside resolveObjective, which
    -- gadgetHandler answers by removing this gadget: one bad scenario field
    -- would kill the whole objectives evaluator). It simply takes no part in
    -- its self-declared child's resolution.
    if not parent.phaseDefs then return end

    if child.state ~= 'complete' then
        -- A failed/expired phase child fails the whole chain (documented
        -- simplification — the plan doesn't specify partial-phase recovery).
        resolveObjective(parent, 'failed', nil, ctx)
        return
    end

    for playerID, w in pairs(child.participation) do
        Attribution.credit(parent.participation, playerID, w)
    end

    for _, cid in ipairs(parent.phaseChildren or {}) do
        local c = lookupObjective(cid)
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
--- @param escrowOutcome  optional override for the outcome handed to
---   `GG.Authority.SettleEscrow`. Defaults to `state`, which is right for every
---   ordinary resolution. The war-end sweep passes `Escrow.WAR_END` so the
---   stakes route team-ward (wars §7) while the OBJECTIVE still records the
---   honest 'expired' — the two are different vocabularies and conflating them
---   would publish an objective in a state no reader knows and no
---   `resolvedStates` list contains.
function resolveObjective(o, state, completingTeam, ctx, escrowOutcome)
    if o.state ~= 'active' then return end
    o.state = state
    o.resolvedFrame = ctx.frame
    removeFromActive(o.id)
    pendingClear[#pendingClear + 1] = o.id

    if state == 'complete' then
        -- endtoend D11. The eval loop resolves INSTEAD of recomputing progress
        -- on the completing tick, so a finished objective published whatever
        -- the previous tick measured — the victory objective froze at
        -- `progress = 0.89999` and read as unfinished. Completion IS 1.
        o.progress = 1
        o.completedBy = completingTeam or o.forTeam
        awardObjective(o, completingTeam)
        for _, fn in ipairs(completeHooks) do fn(o, completingTeam) end
    else
        -- 'failed' | 'expired' -> refund stakers; 'war_end' -> refund the
        -- stakers' TEAM pools (wars §7).
        GG.Authority.SettleEscrow(o.id, escrowOutcome or state)
    end

    -- The while-you-were-away digest (PLAN-persistence task 4b). Emitted HERE
    -- rather than from the `completeHooks` list a scoreboard uses, because a
    -- digest has to carry the failures too: "the extraction you left running
    -- expired" is the single most useful line a returning player can be shown,
    -- and OnComplete fires only for wins by design.
    if GG.WarLog then
        GG.WarLog.Emit('objective', o.type, state, o.completedBy or o.forTeam or -1)
    end

    if o.systemicKey then
        Generator.onResolved(genState, o.systemicRule, o.systemicKey)
    end

    -- E4: mutual resolve — a still-active linked partner is mooted out.
    if o.linkedId then
        local partner = lookupObjective(o.linkedId)
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
    -- Falls through to the S4 archive so a resolved objective stays readable
    -- for as long as the archive holds it (ARCHIVE_CAP resolutions).
    return lookupObjective(id)
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
--- game_gameover.lua). §7's requirement is that **every unresolved objective
--- with staked authority disposes deterministically**, and that is two rules,
--- not one:
---
---   * **met-but-unpaid objectives settle normally.** The eval loop runs every
---     `EVAL_PERIOD` (90 frames / 3 s) and the wind-down grace is 300 frames,
---     so an objective whose criteria are met inside the last eval window has
---     been *earned* and never evaluated. Expiring it would refund the bounty
---     that was just won and pay nobody the reward — a final push that lands in
---     the last two seconds of the war would be silently unwound. So the sweep
---     asks each objective's own `check()` ONE more time first, and anything
---     that answers 'complete' resolves through the ordinary award path
---     (reward + escrow folded in, participation split, OnComplete hooks).
---   * **everything else expires with its stakes routed team-ward.** Not
---     'failed' — the objectives were not lost, the war stopped — and not the
---     ordinary 'expired' escrow rule either: `Escrow.WAR_END` sends every
---     stake to the staker's team pool whether or not they are connected,
---     which is §7's "not to individuals" and the gap §7.2 left open. No
---     authority is destroyed and none is awarded to the enemy.
---
--- `check()` is the same predicate the eval loop calls and is pure with
--- respect to objective state, so asking it here cannot complete an objective
--- the ordinary loop would not have completed one tick later. A module that
--- reports a non-'complete' terminal state (a `protect` whose ward just died)
--- is honoured too: that is the objective's own answer, and overriding it with
--- 'expired' would record the wrong ending for it.
---
--- Phase-chained parents have no `check()` of their own (their resolution is
--- driven by the cascade), so they are swept without being asked — the same
--- asymmetry the eval loop already has.
---
--- The escrow outcome comes from `GG.Authority` rather than from a literal
--- here: authority owns the escrow vocabulary and one spelling of `war_end` is
--- the point. A missing export is LOUD rather than silent, because the quiet
--- fallback ('expired') is precisely the behaviour §7 says is wrong, and it
--- would look identical in the log to a correct sweep.
local function warEndOutcome()
    local w = GG.Authority and GG.Authority.ESCROW_WAR_END
    if w then return w end
    Spring.Echo('[objectives] WARNING: GG.Authority.ESCROW_WAR_END missing — ' ..
                'war-end stakes will refund per the ordinary expiry rule ' ..
                '(to connected stakers), not to team pools. See wars §7.')
    return 'expired'
end

--- Returns `completed, expired`. The old single-count return is the sum, and
--- both numbers are published: "settled 6" told nobody whether the war paid
--- out or wrote everything off.
---
--- Iterates a snapshot of activeList because resolveObjective mutates it
--- (removeFromActive swap-pops, and a linked partner / phase parent can
--- resolve a second entry re-entrantly) — walking the live list would skip.
function GG.Objectives.ExpireAllActive()
    local snapshot = {}
    for i = 1, #activeList do snapshot[i] = activeList[i] end
    local ctx = buildCtx(Spring.GetGameFrame())
    local warEnd = warEndOutcome()
    local completed, expired = 0, 0
    for _, id in ipairs(snapshot) do
        local o = objectives[id]
        if o and o.state == 'active' then
            local state, team
            if WarEnd.shouldAsk(o) then
                local module = TYPES[o.type]
                if module and module.check then
                    -- A content bug in one objective's predicate must not
                    -- abort the sweep and strand every remaining escrow: the
                    -- war is ending and this is the last chance to dispose of
                    -- them. A throw is treated as "no answer" and falls through
                    -- to the expiry branch.
                    local ok, s, t = pcall(module.check, o, ctx)
                    if ok then state, team = s, t end
                end
            end
            local d = WarEnd.dispose(state, warEnd)
            resolveObjective(o, d.state, d.paid and team or nil, ctx, d.escrowOutcome)
            if d.paid then completed = completed + 1
            else            expired = expired + 1 end
        end
    end
    return completed, expired
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
    if not Tick.due(evalGate, frame) then return end
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

    -- Resolve-retention: clear rulesParams for objectives past the 30s window,
    -- then move the objective itself into the ring-capped archive
    -- (PLAN-long-uptime S4). Clearing the params was only ever half the job —
    -- the wire stopped carrying the objective, the heap kept holding it.
    for i = #pendingClear, 1, -1 do
        local id = pendingClear[i]
        local o = objectives[id]
        if not o or (frame - o.resolvedFrame) >= RESOLVE_RETENTION_FRAMES then
            if o then
                clearPublished(o)
                archiveObjective(id)
            end
            table.remove(pendingClear, i)
        end
    end
end

-- ─────────────── Snapshot state (PLAN-persistence task 1d-b, §7.1d) ───────────────
--
-- The objective board is the game (PLAN-metalstorm), and essentially all of it
-- is authored: an objective is CREATED by a scenario, a generator rule or a
-- player bounty, and nothing about the restored world says it should exist.
--
-- CAPTURED — `objectives`, `archive`, `archiveRing`, `archiveSlot`, `nextId`.
-- The archive travels with the live table for a reason its own header spells
-- out: `lookupObjective` reads across BOTH, so a resolved objective a phase
-- parent or a linked partner still names is only reachable through the
-- archive. Dropping it would turn "resolved 20 s ago" into "never existed".
-- `archiveSlot` and `archiveRing` are the ring's cursor and contents — without
-- the cursor the next eviction drops the wrong entry.
--
-- `nextId` matters for the same reason the manager id counters in task 1b did:
-- restore a board of 40 objectives with the counter back at 1 and the next
-- Create() re-issues a LIVE id, so two objectives share a rulesParam prefix.
--
-- CAPTURED — `activeList` + `activeIndex`. They are the O(1) index into
-- `objectives`, and they are derivable in principle (walk the table, keep the
-- `state == 'active'` ones) — but not in a way that reproduces the ARRAY
-- ORDER, and the order is observable: the eval walk, and therefore the order
-- in which a cascade of same-tick resolutions fires, follows it. Recomputing
-- would hand a resumed war a different resolution order than the one it was
-- captured mid-way through. `activeIndex` is written alongside so the pair
-- cannot disagree.
--
-- CAPTURED — `pendingClear`. Ids in their 30 s retention window: an id dropped
-- from here is never archived and never has its params cleared, so it leaks
-- both a heap entry (the leak PLAN-long-uptime S4 exists to close) and a stale
-- objective on the client's board, permanently.
--
-- CAPTURED — `genState`. The generator's dedup and debounce bookkeeping:
-- `systemicActive`, `cooldownUntil` (absolute frames), `contestedSince` and
-- `starvedSince` (tick stamps), `seenConvoys`/`seenInfraHealth` edge-trigger
-- memories. Dropping it re-fires every edge trigger the war has ever seen and
-- re-generates objectives that already exist — the exact duplicate-board
-- failure the dedup key exists to prevent.
--
-- CAPTURED — `evalTick` (the generator's clock, and what `contestedSince` /
-- `starvedSince` are measured in — a reset makes every stored stamp read as
-- far in the future), `victoryObjectivesCreated` (a high-water mark
-- game_gameover reads to say whether the war can end at all), and the eval
-- gate's phase.
--
-- RE-DERIVED, not captured — `rewardScale` (a modoption) and `completeHooks`
-- (re-registered by game_teams' Initialize).
--
-- CAPTURED, and it is the one judgement call here — `bountyCountByPlayer`. A
-- per-player spam guard is arguably the live process's business rather than
-- the payload's, but the alternative is a rollback that hands every player
-- their four bounty slots back, which makes the cap a function of how often
-- the war is restored. Capturing it is the conservative reading.
--
-- NOT REPUBLISHED — the `objective_*` game rules params ride the `gameRules`
-- section, applied immediately before this call. That section is the reason
-- this gadget needs no republish pass at all: publish() is per-objective and
-- clearPublished() is the only thing that removes a key, so a republish could
-- add the restored board's keys but never take away the keys of an objective
-- that was created after the captured frame.
function gadget:Save(state)
    state.objectives = objectives
    state.nextId = nextId
    state.archive = archive
    state.archiveRing = archiveRing
    state.archiveSlot = archiveSlot
    state.activeList = activeList
    state.activeIndex = activeIndex
    state.pendingClear = pendingClear
    state.genState = genState
    state.evalTick = evalTick
    state.victoryObjectivesCreated = victoryObjectivesCreated
    state.bountyCountByPlayer = bountyCountByPlayer
    state.evalGate = Tick.save(evalGate)
end

function gadget:Load(state)
    objectives   = state.objectives or {}
    nextId       = tonumber(state.nextId) or 1
    archive      = state.archive or {}
    archiveRing  = state.archiveRing or {}
    archiveSlot  = tonumber(state.archiveSlot) or 0
    activeList   = state.activeList or {}
    activeIndex  = state.activeIndex or {}
    pendingClear = state.pendingClear or {}
    genState     = state.genState or Generator.newState()
    evalTick     = tonumber(state.evalTick) or 0
    victoryObjectivesCreated = tonumber(state.victoryObjectivesCreated) or 0
    bountyCountByPlayer = state.bountyCountByPlayer or {}
    Tick.load(evalGate, state.evalGate)
end

-- ============================================================
-- The defs moved under a resumed war (PLAN-def-reconciliation task 4, §2 step 5)
--
-- The engine reconciled every def reference IT owns before the world was
-- rebuilt. What it could not do is decide what an objective MEANS after its
-- subject stopped existing, and one case here is not repairable by any amount of
-- remapping: a unit whose def was removed from the game never reached the
-- restored world at all. No UnitDestroyed fired for it — there was no death,
-- the object simply was not created — so `delta.droppedUnits` is the only notice
-- this gadget gets, and without it a kill objective would sit active for the
-- rest of the war waiting for a target that cannot be killed because it is not
-- there. Same for protect (its quorum can never be met), escort/extract (a
-- payload that cannot arrive) and infra (a building that cannot run).
--
-- EXPIRED, NOT FAILED, and the difference is authority. `failed` is a verdict on
-- a team — it is what the war's record shows and what a player reads as their
-- own doing. Nobody lost these objectives; a balance patch dissolved their
-- subject between two sessions. Both dispositions refund the staked escrow, so
-- the only thing choosing `failed` would buy is blaming a player for a content
-- edit. (`kill.onUnitDestroyed` already reaches for `expired` on exactly the
-- same reasoning when a target dies with no killer to credit.)
--
-- PARTIAL removal expires the objective too: an escort of four payloads with one
-- def deleted is no longer the objective anybody agreed to, and its quorum was
-- authored against a roster that no longer exists.
function gadget:DefsReconciled(delta)
    local dropped = delta and delta.droppedUnits
    if not dropped or #dropped == 0 then return end

    local gone = {}
    for _, unitID in ipairs(dropped) do gone[unitID] = true end

    local ctx = buildCtx(Spring.GetGameFrame())
    -- Snapshot the list: resolveObjective removes from activeList as it goes,
    -- and a linked partner or a phase parent can resolve out from under us.
    local snapshot = {}
    for i, id in ipairs(activeList) do snapshot[i] = id end

    local expired = 0
    for _, id in ipairs(snapshot) do
        local o = objectives[id]
        -- Phase-chained parents resolve only through their children (§4.7), the
        -- same exclusion UnitDestroyed makes.
        if o and o.state == 'active' and not o.phaseDefs then
            local module = TYPES[o.type]
            local refs = module and module.unitRefs and module.unitRefs(o)
            if refs then
                for _, ref in ipairs(refs) do
                    if gone[ref] then
                        -- resolveObjective emits the digest line itself
                        -- ('objective' / 'expired'), which is the note §6 asks
                        -- for; a second line here would double-report it.
                        resolveObjective(o, 'expired', nil, ctx)
                        expired = expired + 1
                        break
                    end
                end
            end
        end
    end

    if expired > 0 then
        Spring.Log('objectives', LOG.WARNING, string.format(
            'defs reconciled: %d objective(s) expired — their subject units left '
            .. 'the world with their def (%d unit(s) dropped)', expired, #dropped))
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
