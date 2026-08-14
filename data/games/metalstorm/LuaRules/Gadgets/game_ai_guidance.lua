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
local Tick = VFS.Include("LuaRules/Gadgets/tick.lua")

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

-- Funding rate cap = authority per game-MINUTE (PLAN-metalstorm-ai.md §5.2).
-- Same period game_authority.lua's team stipend uses, and the unit the
-- planner's governor clamps in.
local ALLOWANCE_PERIOD_FRAMES = 1800  -- 1 min @ GAME_SPEED 30
-- D15: skip-safe, ACCRUAL policy (see tick.lua) — the drip is a per-minute
-- rate a human typed into the panel, so a stalled server must not quietly
-- ration the AI below the cap its team is paying for.
local allowanceGate = Tick.new(ALLOWANCE_PERIOD_FRAMES)

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

-- Pending intent tags (PLAN-ai-synced-write.md §2.5). An AI sends `ai.intent`
-- immediately BEFORE the AI.issueDirective it describes; both drain in push
-- order in the same TickAI batch on the sim thread, so the tag is consumed by
-- the charge path in the same frame it was stored. playerID -> {goalId, team,
-- frame}. Deliberately a same-frame transient: a tag whose directive never
-- charged (E6 clamp, group-resolve failure, authority veto) must NOT annotate
-- some later directive, so anything not consumed this frame is dropped in
-- GameFrame. One slot per player — an AI that sends two tags before one
-- directive keeps only the newest, which is the one its next directive means.
local pendingGoal = {}

local function playerTeam(playerID)
    if not playerID then return nil end
    local _, _, _, teamID = Spring.GetPlayerInfo(playerID, false)
    return teamID
end

--- isAI is surfaced ONLY through GetPlayerInfo's player-options table
--- (getPlayerOpts=true, 11th return): opts.isAI == "1" for a virtual AI
--- player. Same test game_teams.lua and game_authority_charge.lua use — a
--- subtle one, so it is spelled the same way in all three.
local function isAIPlayer(playerID)
    if not playerID then return false end
    local opts = select(11, Spring.GetPlayerInfo(playerID, true))
    return type(opts) == 'table' and opts.isAI == '1'
end

--- teamID → canonical integer for EVERY `guidance_<team>_*` rulesParam key.
--- Same AI3 bugfix as game_authority.lua's pkey and game_teams.lua's
--- publishAIProfiles: Spring hands team/player ids back as Lua-5.4 FLOATS on
--- some paths and integers on others, and `'guidance_' .. 4.0` makes
--- 'guidance_4.0_' where `'guidance_' .. 4` makes 'guidance_4_'. Both families
--- were being published live — measured in a real match: 25 float-keyed params
--- on team 4 alongside 21 integer-keyed ones, holding DIFFERENT intent lists
--- (8 entries vs 7), because whichever path published last only refreshed its
--- own family. ai-command-panel.js reads the integer form, so a float-path
--- publish silently left the panel stale. Table keys need no such care —
--- Lua normalises t[4.0] to t[4] — so `stores` is safe as-is; only the string
--- key is at risk.
local function teamKey(teamID)
    return math.floor(teamID)
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
    local p = 'guidance_' .. teamKey(teamID) .. '_'

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
-- guidance_<team>_intent_count + intent_<i>_{goal,group,spend,goal_id}.
-- Team-PRIVATE, same losAccess as the rest of the guidance store (default →
-- owning team only).
--
-- `goal_id` (PLAN-ai-synced-write.md §2.5 step 4) is the PLANNER's goal id —
-- a string like 'def:basin_a' or 'obj:12' (ai/strategos/slate.lua) — and it
-- is what closes the veto loop: the panel's Veto button sends it back through
-- `guidance.veto`, picture.lua reads it out of veto_keys, planner.lua:239
-- skips that goal. It is published as '' rather than omitted when the entry
-- has no tag, because republish is total (E1-safe): a shorter list must not
-- leave slot i's goal_id from a previous publish sitting there for the panel
-- to attach a Veto button to the wrong directive.
local function publishIntent(teamID)
    local s = storeFor(teamID)
    local p = 'guidance_' .. teamKey(teamID) .. '_'
    local n = math.min(#s.intent, INTENT_MAX)
    Spring.SetTeamRulesParam(teamID, p .. 'intent_count', n)
    for i = 1, n do
        local e = s.intent[i]
        local ip = p .. 'intent_' .. (i - 1) .. '_'
        Spring.SetTeamRulesParam(teamID, ip .. 'goal', e.goal)
        Spring.SetTeamRulesParam(teamID, ip .. 'group', e.group)
        Spring.SetTeamRulesParam(teamID, ip .. 'spend', e.spend)
        Spring.SetTeamRulesParam(teamID, ip .. 'goal_id', e.goalId or '')
    end
end

--- Change feed (§6.2 "a change feed (who set what) so conflicting humans
--- resolve it socially") — an 8-slot ring per team, same shape as
--- game_authority.lua's award/charge ring.
local function recordChange(teamID, field, value, playerID)
    local seq = (changeSeq[teamID] or 0) + 1
    changeSeq[teamID] = seq
    local slot = seq % CHANGE_RING_SIZE
    local p = 'guidance_' .. teamKey(teamID) .. '_change_' .. slot .. '_'
    Spring.SetTeamRulesParam(teamID, p .. 'field', field)
    Spring.SetTeamRulesParam(teamID, p .. 'value', tostring(value))
    Spring.SetTeamRulesParam(teamID, p .. 'player', playerID or -1)
    Spring.SetTeamRulesParam(teamID, p .. 'frame', Spring.GetGameFrame())
    Spring.SetTeamRulesParam(teamID, p .. 'seq', seq)
    Spring.SetTeamRulesParam(teamID, 'guidance_' .. teamKey(teamID) .. '_change', seq)
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

--- Live count of un-consumed intent tags (§2.5). Exists because the frame-end
--- sweep is otherwise unobservable: consumption already refuses a tag from an
--- earlier frame, so the sweep's job is purely to keep `pendingGoal` bounded
--- for an AI whose directives keep getting dropped — a property with no other
--- witness. Read-only; the store itself is never exported.
function GG.AIGuidance.PendingCount()
    local n = 0
    for _ in pairs(pendingGoal) do n = n + 1 end
    return n
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
--- `playerID` is the AI virtual player that issued the directive; it is what
--- correlates this line with the `ai.intent` tag that player pushed
--- immediately before it (§2.5 step 3). The tag is consumed EXACTLY ONCE and
--- only if it was stamped this frame by a player on this team — so the intent
--- list stays authoritative (a line exists only for a directive that really
--- charged) while the goalId is an annotation that may legitimately be absent
--- (a scripted-slate directive, or an AI that predates task 3's actuator).
function GG.AIGuidance.RecordIntent(teamID, directiveType, group, spend, playerID)
    if not teamID then return end
    local s = storeFor(teamID)
    local goalId
    local tag = playerID and pendingGoal[playerID]
    if tag and tag.frame == Spring.GetGameFrame() and tag.team == teamID then
        goalId = tag.goalId
        pendingGoal[playerID] = nil
    end
    table.insert(s.intent, 1, {
        goal   = DIRECTIVE_LABEL[directiveType] or ('Directive ' .. tostring(directiveType)),
        group  = group or 0,
        spend  = math.floor(spend or 0),
        goalId = goalId,
        frame  = Spring.GetGameFrame(),
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

--- The team's AI players — the funding recipients. Both funding paths split
--- evenly across them because guidance is TEAM-scoped and the panel has no
--- per-AI selector (PLAN-metalstorm-ai.md §5.2; a selector is a panel change,
--- not a rule change). GG.Teams.AIPlayers filters to PRESENT AI players, so a
--- departed slot never absorbs a share.
local function fundingRecipients(teamID)
    if not (GG.Teams and GG.Teams.AIPlayers) then return {} end
    return GG.Teams.AIPlayers(teamID) or {}
end

--- Funding (§6.2, decided in PLAN-metalstorm-ai.md §5.2 — endtoend D32).
---
--- Two deliberately different transfers, both net-zero moves via
--- GG.Authority.Transfer:
---   * one-shot `amount` — a PERSONAL GIFT. Debited from the funder's OWN pool
---     only and credited to the AI's own pool. No team fallback, following
---     GG.Authority.Stake's precedent ("a personal gift, not an order"); routing
---     this through ChargeOrder instead would let a human draw the TEAM pool via
---     the ordinary fallback and hand it to an own-pool-only AI, which is the
---     shared-savings drain §5's invariant exists to forbid, just with extra
---     clicks.
---   * `rateCap` — a STANDING TEAM ALLOWANCE, dripped per game-minute from the
---     team pool by the GameFrame sweep below. It stays guidance state too: the
---     planner's governor (ai/strategos/planner.lua governor()) clamps its
---     spend to the same number, so the cap means one thing in both consumers.
---
--- WAS (and this is the whole of D32): the one-shot called
--- `Award({ team = teamID }, ...)` — it charged the human and paid the TEAM
--- pool, which an `own_pool_only` co-commander may not spend, so the player's
--- only lever took their authority and delivered nothing. The comment here
--- justified that with "no gadget reserves an AI playerID", which was true when
--- written and was made false by AI3: every AI slot is a real virtual player
--- with a live `authority_player_<id>` pool. Measured live before the fix
--- (fire 11): human 100 → 60, `authority_pool` 600 → 640, `authority_player_0`
--- unmoved at 0.0.
---
--- A team with NO AI now REFUSES the funding instead of silently converting it
--- into a team donation.
local function setFunding(teamID, playerID, amount, rateCap)
    if not requireMember(teamID, playerID) then return false end
    local s = storeFor(teamID)
    -- Refusals are ECHOED, not just returned. RecvLuaMsg discards handler return
    -- values (there is no refusal channel back to the widget yet), so a silent
    -- `return false` here would look exactly like the D32 bug it replaces:
    -- press Send, nothing happens, nothing to grep. Same trap D28 hit twice.
    local function refuse(why)
        Spring.Echo('[AIGuidance] funding refused (' .. why .. '): team ' ..
                    tostring(teamID) .. ', player ' .. tostring(playerID) ..
                    ', amount ' .. tostring(amount))
        return false, why
    end
    if amount and amount > 0 then
        local ais = fundingRecipients(teamID)
        if #ais == 0 then return refuse('no_ai_on_team') end
        -- All-or-nothing. Every share leaves the SAME pool, so checking the
        -- funder can cover the total up front is what stops a multi-AI split
        -- from half-succeeding (paying AI #1, refusing AI #2, and reporting
        -- failure while the money is gone).
        local src = { player = playerID }
        if (GG.Authority.PoolOf(src) or 0) < amount then
            return refuse('insufficient_authority')
        end
        local share = amount / #ais
        for _, aiID in ipairs(ais) do
            GG.Authority.Transfer(src, { player = aiID }, share, 'ai_funding')
        end
    end
    if rateCap ~= nil then s.funding.rateCap = rateCap end
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
--- Pending intent tag (§2.5 step 2) — the ONE writer on this gadget whose
--- sender must be an AI. Two checks, both required:
---   * `isAI` — a human must not be able to inject intent lines / attach a
---     goalId to somebody else's directive. This is a *hostile-wire* check,
---     unlike the ordinary guidance writers, because a human client speaks the
---     same RecvLuaMsg channel the AI's engine-side LuaMsg lands on.
---   * team membership — NOT checked here, deliberately: teamID derives from
---     the sender and never from a wire field (same as every other command in
---     this gadget), so a `requireMember` call here is true by construction
---     and no test could ever fail it. The check that does work is at
---     CONSUMPTION, where the team comes from the charge path instead: an AI
---     on team 20 can never annotate team 10's directive.
local function setPendingGoal(teamID, playerID, goalId)
    if not goalId or goalId == '' then return false end
    if not isAIPlayer(playerID) then return false end
    pendingGoal[playerID] = { goalId = goalId, team = teamID, frame = Spring.GetGameFrame() }
    return true
end

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
        -- Planner goal ids are STRINGS ('def:basin_a', 'obj:12' — see
        -- ai/strategos/slate.lua); a bare Wire.num() coerced every one of them
        -- to nil, so the veto write silently refused for every real goal and
        -- the loop could only ever close for a synthetic numeric id. Keep the
        -- numeric form when it IS numeric (the store's existing keys, and
        -- picture.lua's `tonumber(key) or key` read, are both number-first).
        setVeto(teamID, playerID, Wire.num(fields.goalId) or fields.goalId)
    elseif cmd == 'ai.intent' then
        setPendingGoal(teamID, playerID, fields.goalId)
    end
end

--- Standing allowance drip (§6.2 rate cap, PLAN-metalstorm-ai.md §5.2). Once a
--- game-minute, move up to `rateCap` from the TEAM pool into the team's AI
--- pools, split evenly. This is what keeps a co-commander playing: it is
--- `own_pool_only`, so every source of team income — stipend, objective payouts
--- — is money it may never spend, and without a drip it goes inert the moment
--- its one-off join grant is gone (endtoend D32, measured: both AIs at 0.0 from
--- ~frame 4700 while the team pool climbed 500 → 1285).
---
--- This is NOT the team fallback §5 forbids, and the difference is the whole
--- point: the fallback is silent, unbounded and automatic, whereas this is a
--- number a human typed into the panel, capped per minute, attributed in the
--- change feed and tagged `ai_allowance` in the ledger. Opt-in — no cap set, or
--- a cap of 0, drips nothing, so this changes nothing for a team that never
--- touches the control.
---
--- Partial drips are fine (unlike the one-shot's all-or-nothing gift): a team
--- pool that can only cover part of the allowance pays what it has, because the
--- alternative is an allowance that silently stops when the team gets poor,
--- which is exactly when the AI most needs to know it is on rations.
local function dripAllowances(frame)
    local periods = Tick.count(allowanceGate, frame)
    if periods == 0 then return end
    if not (GG.Authority and GG.Authority.Transfer) then return end
    for teamID, s in pairs(stores) do
        local cap = (tonumber(s.funding and s.funding.rateCap) or 0) * periods
        if cap > 0 then
            local ais = fundingRecipients(teamID)
            if #ais > 0 then
                local src = { team = teamID }
                local available = math.min(cap, GG.Authority.PoolOf(src) or 0)
                if available > 0 then
                    local share = available / #ais
                    for _, aiID in ipairs(ais) do
                        GG.Authority.Transfer(src, { player = aiID }, share, 'ai_allowance')
                    end
                end
            end
        end
    end
end

-- ─────────────── Snapshot state (PLAN-persistence task 1d-b, §7.1d) ───────────────
--
-- CAPTURED — `stores`. The whole guidance store is *typed by a human*: stance,
-- ROE, region paint, explicit asset locks, delegated objectives, the funding
-- rate cap. None of it is a function of the board, so none of it is derivable.
-- Two of its members are timed and are captured for the same reason a fuse is
-- state: `veto[goalId]` and `touchLocks[groupId]` hold ABSOLUTE expiry frames,
-- and `globals` restores the frame number they are measured against — dropping
-- them would silently unblock a goal a human vetoed thirty seconds ago, and
-- silently hand the co-commander a group the human is actively steering.
-- `intent` carries its own `frame` stamps and is swept the same way.
--
-- CAPTURED — `changeSeq`. It is the change feed's monotonic cursor; the ring
-- entries themselves are team rulesParams (restored by the `teams` section), so
-- a restored ring with a reset cursor would overwrite the newest slot next and
-- publish a `_change` value the panel has already seen.
--
-- CAPTURED — the allowance gate's phase. This one is an ACCRUAL gate, which is
-- the case where losing it costs real money: `Tick.count` banks every whole
-- period between `last` and the current frame, so a gate left at a live
-- process's `last` after a restore to a much later frame pays the AI pools
-- every minute in between at once, out of the team pool, tagged
-- `ai_allowance` — a mint the ledger would faithfully record and nobody
-- authorised.
--
-- NOT CAPTURED — `pendingGoal`. It is the only piece of state here that is
-- not a fuse but a *within-frame* correlation token: it is written by an AI's
-- LuaMsg and consumed by the charge path in the same frame's drain, and
-- GameFrame drops whatever is left. A snapshot is taken at a frame boundary,
-- so a captured tag could only ever be one that already expired.
--
-- NOT REPUBLISHED — every `guidance_*` key is a team rulesParam and rides the
-- `teams` section.
function gadget:Save(state)
    state.stores = stores
    state.changeSeq = changeSeq
    state.allowanceGate = Tick.save(allowanceGate)
end

function gadget:Load(state)
    stores = state.stores or {}
    changeSeq = state.changeSeq or {}
    Tick.load(allowanceGate, state.allowanceGate)
end

function gadget:GameFrame(frame)
    dripAllowances(frame)
    -- §2.5: a pending intent tag lives for exactly the frame it was pushed in.
    -- GameFrame runs after that frame's command drain + charge sequence, so
    -- anything still here describes a directive that never landed.
    for playerID, tag in pairs(pendingGoal) do
        if tag.frame ~= frame then pendingGoal[playerID] = nil end
    end
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
