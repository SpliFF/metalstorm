-- game_ai_guidance.lua — team-scoped AI guidance store
-- (PLAN-metalstorm-interaction.md §6).
--
-- Cooperative human->AI guiding as a SYNCED, team-scoped store the strategic
-- AI treats as BINDING: stance, region paint, asset locks, objective
-- delegation, funding, ROE, veto. This gadget owns the store + validation;
-- the AI planner reads it (never writes — ai/strategos/planner.lua's
-- guidanceExcludes/expectedValue/sourceWeight already implement the §6.2
-- effects table against this shape), the ai-command-panel widget and the
-- command composer write into it via RecvLuaMsg (parley/wire.lua codec —
-- same first-mover convention game_parley.lua uses, see that file's header).
--
-- PRIVACY (engine ask I2, §9): published with NO losAccess override, i.e.
-- Spring's default RULESPARAMLOS_PRIVATE (rts/Lua/LuaRulesParams.h) —
-- readable ONLY by the owning team itself, not even allies. This is a
-- DELIBERATE divergence from game_authority.lua's pool params (which use
-- {allied=true} so teammates/allies see each other's pools) — guidance is
-- "how I'm steering MY OWN AI", which the plan frames as private even from
-- allies ("private scope so enemies can't read your AI's orders" plus the
-- store being keyed one-per-team, never one-per-alliance). VERIFIED (I2,
-- interaction §9): the sim-side LOS bitmask in rts/Lua/LuaRulesParams.h /
-- LuaSyncedRead.cpp GetTeamRulesParams correctly restricts PRIVATE-scope
-- params to the owning team — confirmed by reading that code directly. What
-- is NOT yet verified live is the *streaming* path: client/src/core/
-- lua-ui-host.ts's handleRulesParamUpdate has no producer anywhere in the
-- server (grepped rts/Server/*.cpp, protocol.fbs — none constructs a
-- rulesParamUpdate message at all, for ANY scope, public or private). This
-- is the SAME pre-existing, game-wide gap already flagged in
-- game_authority.lua/game_objectives.lua's field notes — not a guidance-
-- specific hole, and not something this gadget can fix (a different file
-- surface: C++ StateStreamer + client worker decode). Sim-side privacy is
-- correct; end-to-end privacy is unverifiable until that wire lands.
--
-- LOAD ORDER CONTRACT: layer -44 — with the interaction pair (parley -45),
-- before civilians (-40).

function gadget:GetInfo()
    return {
        name    = "AI Guidance",
        desc    = "Team-scoped synced guidance store: stance, paint, locks, delegation, funding, veto",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -44,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Wire = VFS.Include("LuaRules/Gadgets/parley/wire.lua")

GG.AIGuidance = GG.AIGuidance or {}

local VETO_TTL_FRAMES   = 9000   -- 5 min (§6.3 "blacklists that goal for 5 min")
local CHANGE_RING_SIZE  = 8      -- mirrors authority/parley event rings

-- §5.1 "a group a human directed within the last 3 min is untouchable — tracked
-- from directive events". The touch lock is a TIMED asset lock: a human issuing
-- a directive to a group locks it against the co-commander for this window, then
-- it frees naturally (swept in GameFrame). This is the formal engine expression
-- of the 3-min rule the plan describes; a widget's explicit lock
-- (guidance.lock) is the permanent counterpart, and both publish through the
-- SAME lock_keys the AI reads (picture.lua assetLocks).
local TOUCH_LOCK_TTL_FRAMES = 5400   -- 3 min @ 30 Hz (= INTEL_DECAY_FRAMES)

-- Intent report (§6.3 "what my AI is doing"): a short, rolling window of the
-- AI's most-recent charged directives, published for ai-command-panel.js. Each
-- entry expires so the panel reflects CURRENT intent, not a growing history.
local INTENT_MAX        = 8      -- ai-command-panel renders the most recent N
local INTENT_TTL_FRAMES = 600    -- 20 s ≈ 4 strategic ticks — stale intent clears

local STANCES = { defensive = true, balanced = true, aggressive = true }
local PAINTS  = { priority = true, normal = true, forbidden = true }
local ROES    = { free = true, observed_only = true, deny_area = true }

local stores = {}       -- teamID -> guidance table
local changeSeq = {}     -- teamID -> last emitted change seq

local function playerTeam(playerID)
    if not playerID then return nil end
    local _, _, _, teamID = Spring.GetPlayerInfo(playerID, false)
    return teamID
end

local function storeFor(teamID)
    local s = stores[teamID]
    if not s then
        s = { stance = 'balanced', regionPaint = {}, assetLocks = {},
              delegated = {}, funding = {}, roe = 'free', veto = {},
              touchLocks = {},  -- groupId -> expiry frame (§5.1 3-min human-touched)
              intent = {} }     -- rolling list of recent AI directives (§6.3), newest first
        stores[teamID] = s
    end
    return s
end

-- ============================================================
-- Publish (team-PRIVATE — see header). Flattened as comma-joined key lists
-- rather than dynamic per-entry param names, so nothing needs tracking to
-- clear a stale key when an entry is removed (E1-safe: republish is total).
-- ============================================================
local function publish(teamID)
    local s = storeFor(teamID)
    local p = 'guidance_' .. teamID .. '_'

    Spring.SetTeamRulesParam(teamID, p .. 'stance', s.stance)
    Spring.SetTeamRulesParam(teamID, p .. 'roe', s.roe)
    Spring.SetTeamRulesParam(teamID, p .. 'funding_rateCap', s.funding.rateCap or -1)

    local paintKeys, lockKeys, delegKeys, vetoKeys = {}, {}, {}, {}
    local seenLock = {}
    for key, value in pairs(s.regionPaint) do
        paintKeys[#paintKeys + 1] = key
        Spring.SetTeamRulesParam(teamID, p .. 'paint_' .. key, value)
    end
    -- Explicit (permanent) + touch (timed 3-min) locks both feed lock_keys —
    -- the AI reads one merged set; dedup so a group with both isn't listed twice.
    for groupId in pairs(s.assetLocks) do
        if not seenLock[groupId] then seenLock[groupId] = true; lockKeys[#lockKeys + 1] = tostring(groupId) end
    end
    for groupId in pairs(s.touchLocks) do
        if not seenLock[groupId] then seenLock[groupId] = true; lockKeys[#lockKeys + 1] = tostring(groupId) end
    end
    for objId in pairs(s.delegated) do delegKeys[#delegKeys + 1] = tostring(objId) end
    for goalId in pairs(s.veto) do vetoKeys[#vetoKeys + 1] = tostring(goalId) end

    Spring.SetTeamRulesParam(teamID, p .. 'paint_keys', table.concat(paintKeys, ','))
    Spring.SetTeamRulesParam(teamID, p .. 'lock_keys', table.concat(lockKeys, ','))
    Spring.SetTeamRulesParam(teamID, p .. 'delegated_keys', table.concat(delegKeys, ','))
    Spring.SetTeamRulesParam(teamID, p .. 'veto_keys', table.concat(vetoKeys, ','))
end

-- Intent report publish (§6.3). ai-command-panel.js reads
-- guidance_<team>_intent_count + intent_<i>_{goal,group,spend}. Team-PRIVATE,
-- same losAccess as the rest of the guidance store (default → owning team only).
local function publishIntent(teamID)
    local s = storeFor(teamID)
    local p = 'guidance_' .. teamID .. '_'
    local n = math.min(#s.intent, INTENT_MAX)
    Spring.SetTeamRulesParam(teamID, p .. 'intent_count', n)
    for i = 1, n do
        local e = s.intent[i]
        local ip = p .. 'intent_' .. (i - 1) .. '_'
        Spring.SetTeamRulesParam(teamID, ip .. 'goal', e.goal)
        Spring.SetTeamRulesParam(teamID, ip .. 'group', e.group)
        Spring.SetTeamRulesParam(teamID, ip .. 'spend', e.spend)
    end
end

--- Change feed (§6.2 "a change feed (who set what) so conflicting humans
--- resolve it socially") — an 8-slot ring per team, same shape as
--- game_authority.lua's award/charge ring.
local function recordChange(teamID, field, value, playerID)
    local seq = (changeSeq[teamID] or 0) + 1
    changeSeq[teamID] = seq
    local slot = seq % CHANGE_RING_SIZE
    local p = 'guidance_' .. teamID .. '_change_' .. slot .. '_'
    Spring.SetTeamRulesParam(teamID, p .. 'field', field)
    Spring.SetTeamRulesParam(teamID, p .. 'value', tostring(value))
    Spring.SetTeamRulesParam(teamID, p .. 'player', playerID or -1)
    Spring.SetTeamRulesParam(teamID, p .. 'frame', Spring.GetGameFrame())
    Spring.SetTeamRulesParam(teamID, p .. 'seq', seq)
    Spring.SetTeamRulesParam(teamID, 'guidance_' .. teamID .. '_change', seq)
end

-- ============================================================
-- GG.AIGuidance API — read-only for the planner; writes only via the
-- validated RecvLuaMsg handlers below (never called directly by other
-- gadgets, matching §6.2 "the AI planner reads it, never writes").
-- ============================================================

--- Snapshot for same-VM synced readers (busted tests, other gadgets). The
--- AI VM itself reads via the rulesParams mirror above (separate Lua state,
--- engine ask I2/AI1), never this function.
function GG.AIGuidance.Get(teamID)
    local s = storeFor(teamID)
    return {
        stance = s.stance,
        region_paint = s.regionPaint,
        asset_locks = s.assetLocks,
        delegated = s.delegated,
        funding = s.funding,
        roe = s.roe,
        veto = s.veto,
    }
end

-- Directive type (engine OrgGroups.h enum, mirrored in ai/strategos/
-- actuators.lua) → a human-legible label for the intent report. Keyed by the
-- numeric directiveType the charge callin carries.
local DIRECTIVE_LABEL = {
    [0] = 'Defend area', [1] = 'Patrol', [2] = 'Rally', [3] = 'Fall back',
    [4] = 'Reinforce', [5] = 'Screen', [6] = 'Supply', [7] = 'Build base',
    [8] = 'Move', [9] = 'Assault', [10] = 'Defend', [11] = 'Overwatch',
    [12] = 'Withdraw', [13] = 'Escort', [14] = 'Hold the front',
}

--- Record one AI directive as intent (§6.3), so ai-command-panel.js shows what
--- the co-commander is doing + its authority spend (spend is socially visible,
--- §5.1). Called from the authority charge path when an AI virtual player's
--- directive is charged — NOT by the AI VM (separate Lua state, can't write
--- synced). `group` 0 = an area-scoped directive (no fixed roster). Newest-first
--- rolling window; entries expire (GameFrame sweep) so the panel stays current.
function GG.AIGuidance.RecordIntent(teamID, directiveType, group, spend)
    if not teamID then return end
    local s = storeFor(teamID)
    table.insert(s.intent, 1, {
        goal  = DIRECTIVE_LABEL[directiveType] or ('Directive ' .. tostring(directiveType)),
        group = group or 0,
        spend = math.floor(spend or 0),
        frame = Spring.GetGameFrame(),
    })
    while #s.intent > INTENT_MAX do s.intent[#s.intent] = nil end
    publishIntent(teamID)
end

--- Timed "human-touched" asset lock (§5.1). A human directing a group makes it
--- untouchable by the co-commander for TOUCH_LOCK_TTL_FRAMES (3 min). Called
--- from the authority charge path when a HUMAN's directive targets a real group.
--- Re-touching extends the window (the human is actively steering it).
function GG.AIGuidance.TouchGroup(teamID, groupID, frame)
    if not teamID or not groupID or groupID == 0 then return end
    local s = storeFor(teamID)
    s.touchLocks[groupID] = (frame or Spring.GetGameFrame()) + TOUCH_LOCK_TTL_FRAMES
    publish(teamID)
end

-- ============================================================
-- Validated writers. Every entry point takes (teamID, playerID, ...) and
-- checks the writer is actually a member of teamID (§6.2 "validated writes")
-- before mutating anything — the first gadget in this codebase to validate
-- an inbound RecvLuaMsg payload (see parley/wire.lua header).
-- ============================================================
local function requireMember(teamID, playerID)
    return playerTeam(playerID) == teamID
end

local function setStance(teamID, playerID, value)
    if not requireMember(teamID, playerID) or not STANCES[value] then return false end
    storeFor(teamID).stance = value
    recordChange(teamID, 'stance', value, playerID)
    publish(teamID)
    return true
end

local function setPaint(teamID, playerID, regionKey, value)
    if not requireMember(teamID, playerID) or not regionKey then return false end
    local s = storeFor(teamID)
    if value == nil or value == 'normal' then
        s.regionPaint[regionKey] = nil   -- 'normal' = no override, don't publish clutter
    elseif PAINTS[value] then
        s.regionPaint[regionKey] = value
    else
        return false
    end
    recordChange(teamID, 'paint:' .. regionKey, value or 'normal', playerID)
    publish(teamID)
    return true
end

local function setLock(teamID, playerID, groupId, locked)
    if not requireMember(teamID, playerID) or not groupId then return false end
    local s = storeFor(teamID)
    if locked then s.assetLocks[groupId] = true else s.assetLocks[groupId] = nil end
    recordChange(teamID, 'lock:' .. tostring(groupId), locked and 1 or 0, playerID)
    publish(teamID)
    return true
end

local function setDelegate(teamID, playerID, objectiveId, delegated)
    if not requireMember(teamID, playerID) or not objectiveId then return false end
    local s = storeFor(teamID)
    if delegated then s.delegated[objectiveId] = true else s.delegated[objectiveId] = nil end
    recordChange(teamID, 'delegate:' .. tostring(objectiveId), delegated and 1 or 0, playerID)
    publish(teamID)
    return true
end

--- Funding (§6.2): a rate cap is pure guidance state (consumed directly by
--- the planner's governor, ai/strategos/planner.lua governor()). A one-shot
--- `amount` performs a REAL transfer today, but — flagged, not silently
--- faked — it can only land in the TEAM pool: this backbone has no distinct
--- "AI player" identity/pool anywhere yet (no gadget reserves an AI
--- playerID; ai/strategos/main.lua's co-commander role reads
--- picture.economy.ownPool but nothing publishes a per-AI pool). Until an
--- AI player slot exists, "fund the AI" and "donate to the team pool" are
--- the same operation; this is called out here rather than pretended away.
local function setFunding(teamID, playerID, amount, rateCap)
    if not requireMember(teamID, playerID) then return false end
    local s = storeFor(teamID)
    if rateCap ~= nil then s.funding.rateCap = rateCap end
    if amount and amount > 0 then
        if not GG.Authority.ChargeOrder(nil, teamID, playerID, amount) then
            return false, 'insufficient_authority'
        end
        GG.Authority.Award({ team = teamID }, amount, 'ai_funding')
    end
    recordChange(teamID, 'funding', rateCap or amount or 0, playerID)
    publish(teamID)
    return true
end

local function setRoe(teamID, playerID, value)
    if not requireMember(teamID, playerID) or not ROES[value] then return false end
    storeFor(teamID).roe = value
    recordChange(teamID, 'roe', value, playerID)
    publish(teamID)
    return true
end

--- Veto blacklist (§6.3): vetoing a goal blacklists it for VETO_TTL_FRAMES
--- (5 min), then the planner is free to re-propose it. Sweep of expired
--- entries happens in GameFrame below.
local function setVeto(teamID, playerID, goalId)
    if not requireMember(teamID, playerID) or not goalId then return false end
    local s = storeFor(teamID)
    s.veto[goalId] = Spring.GetGameFrame() + VETO_TTL_FRAMES
    recordChange(teamID, 'veto:' .. tostring(goalId), 1, playerID)
    publish(teamID)
    return true
end

-- ============================================================
-- Wire
-- ============================================================
function gadget:RecvLuaMsg(msg, playerID)
    local cmd, fields = Wire.decode(msg)
    if not cmd then return end
    local teamID = playerTeam(playerID)
    if not teamID then return end

    if cmd == 'guidance.stance' then
        setStance(teamID, playerID, fields.value)
    elseif cmd == 'guidance.paint' then
        setPaint(teamID, playerID, fields.regionKey, fields.value)
    elseif cmd == 'guidance.lock' then
        setLock(teamID, playerID, Wire.num(fields.groupId), fields.locked == '1')
    elseif cmd == 'guidance.delegate' then
        setDelegate(teamID, playerID, Wire.num(fields.objectiveId), fields.delegated ~= '0')
    elseif cmd == 'guidance.fund' then
        setFunding(teamID, playerID, Wire.num(fields.amount), Wire.num(fields.rateCap))
    elseif cmd == 'guidance.roe' then
        setRoe(teamID, playerID, fields.value)
    elseif cmd == 'guidance.veto' then
        setVeto(teamID, playerID, Wire.num(fields.goalId))
    end
end

function gadget:GameFrame(frame)
    for teamID, s in pairs(stores) do
        local swept = false
        for goalId, expiresAt in pairs(s.veto) do
            if frame >= expiresAt then
                s.veto[goalId] = nil
                swept = true
            end
        end
        -- §5.1: expire human-touched locks so a group the human hasn't steered
        -- in 3 min frees for the co-commander again.
        for groupId, expiresAt in pairs(s.touchLocks) do
            if frame >= expiresAt then
                s.touchLocks[groupId] = nil
                swept = true
            end
        end
        if swept then publish(teamID) end
        -- Expire stale intent so the panel reflects only what the AI is doing NOW.
        if #s.intent > 0 then
            local kept = {}
            for _, e in ipairs(s.intent) do
                if (frame - (e.frame or frame)) < INTENT_TTL_FRAMES then kept[#kept + 1] = e end
            end
            if #kept ~= #s.intent then s.intent = kept; publishIntent(teamID) end
        end
    end
end
