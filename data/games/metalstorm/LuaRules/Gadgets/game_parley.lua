-- game_parley.lua — synced parley / proposal / pact objects
-- (PLAN-metalstorm-interaction.md §1-5).
--
-- Human<->AI (and human<->human) diplomacy as SYNCED game objects: proposals
-- (ceasefire, tribute, safe passage, joint objective, demand, intel), pacts
-- with enforcement hooks (order veto + damage-based breach detection), and
-- the trust ledger (trust_<a>_<b> rulesParams). Applies to allies, enemies,
-- and the civilian estate (civilians/estate.lua responds as toTeam=Gaia).
--
-- STRUCTURE: registry + lifecycle + publishing mirror game_objectives.lua's
-- shape exactly (activeList/activeIndex, resolve-retention window, a single
-- resolveTerminal() chokepoint) — same author, same reviewer, same shape
-- saves everyone's time. Two pure library modules: parley/wire.lua (the
-- RecvLuaMsg codec — see its header for why this gadget is the wire's first
-- mover) and parley/trust.lua (the ledger arithmetic).
--
-- Proposal/pact records are GAME-scoped rulesParams (parley_<id>_*), same
-- visibility as objective_<id>_* — a negotiation record is public information
-- to both parties and spectators/replays (PLAN-metalstorm-interaction.md
-- "readable by any AI via the rulesParams mirror"). This is DIFFERENT from
-- game_ai_guidance.lua's store, which is deliberately team-PRIVATE.
--
-- LOAD ORDER CONTRACT: layer -45 — after the backbone registries
-- (authority -100/regions -90/teams -95/objectives -50) and before
-- game_civilians (-40). Also sits between squad.lua's AllowCommand veto
-- (-60) and game_authority_charge.lua's charging gate (+100) in
-- ascending-layer AllowCommand iteration order (see that file's header for
-- the proof) — exactly where the ROE order-veto (§2) needs to run: after
-- squad.lua's own vetoes, strictly before any authority charge.
--
-- Engine ask I1 (AI-side sendGameMessage) is NOT needed for this gadget
-- itself — humans call the same GG.Parley API via RecvLuaMsg that this file
-- parses below; I1 only gates the AI VM's own ability to originate the same
-- calls (interaction §7/§9), tracked in ai/strategos/actuators.lua.

function gadget:GetInfo()
    return {
        name    = "Parley",
        desc    = "Synced proposals, pacts + enforcement, trust ledger",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -45,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Wire  = VFS.Include("LuaRules/Gadgets/parley/wire.lua")
local Trust = VFS.Include("LuaRules/Gadgets/parley/trust.lua")

GG.Parley = GG.Parley or {}

-- ============================================================
-- Observer hooks (mirrors game_authority.lua's OnAward/OnCharge pattern) —
-- civilians/estate.lua uses this to auto-respond to proposals addressed to
-- the civilian estate (toTeam == Gaia) without game_parley.lua needing to
-- know civilians exist at all.
-- ============================================================
local proposeHooks = {}

--- Register fn(proposal), called once right after a new proposal is
--- created and published (offered state, before anyone has responded).
function GG.Parley.OnPropose(fn)
    proposeHooks[#proposeHooks + 1] = fn
end

local function firePropose(p)
    for _, fn in ipairs(proposeHooks) do fn(p) end
end

-- ============================================================
-- Tunables
-- ============================================================
local PROPOSE_FEE               = 15     -- flat spam-guard fee (§1, modoption parley_propose_fee)
local PROPOSAL_TTL_FRAMES        = 1800   -- 60s default response window (offered/countered)
local MAX_LIVE_OUTGOING          = 4      -- E6: per-team cap of PENDING outgoing proposals
local REJECT_COOLDOWN_FRAMES     = 3600   -- E6: 2 min, per (fromTeam,toTeam) pair after a rejection
local WITHDRAWAL_NOTICE_FRAMES   = 900    -- E5: 30s published notice before active->fulfilled
local TRIBUTE_PAY_PERIOD_FRAMES  = 1800   -- 1 min, mirrors authority's STIPEND_PERIOD_FRAMES
local RESOLVE_RETENTION_FRAMES   = 900    -- 30s, mirrors objectives' retention window
local EVENT_RING_SIZE            = 8      -- mirrors authority's award/breach toast ring
local TRUST_DECAY_TICK_FRAMES    = Trust.DECAY_PERIOD_FRAMES

-- ============================================================
-- Registry state
-- ============================================================
local proposals    = {}      -- id -> proposal (LIVE only, see the archive below)
local nextId       = 1

-- Resolved-proposal archive (PLAN-long-uptime S4/S3). Same defect and same
-- policy as game_objectives.lua: the retention loop below cleared a resolved
-- proposal's rulesParams and left `proposals[id]` itself referenced forever,
-- so every offer, counter and pact a campaign ever saw stayed on the synced
-- heap. Resolved proposals move to a ring-capped archive when their retention
-- window ends; `lookupProposal` reads across both.
local ARCHIVE_CAP   = 256
local archive       = {}      -- id -> resolved proposal, at most ARCHIVE_CAP live
local archiveRing   = {}      -- slot -> id
local archiveSlot   = 0

local function archiveProposal(id)
    local p = proposals[id]
    if not p then return end
    proposals[id] = nil
    archiveSlot = (archiveSlot % ARCHIVE_CAP) + 1
    local evicted = archiveRing[archiveSlot]
    if evicted then archive[evicted] = nil end
    archiveRing[archiveSlot] = id
    archive[id] = p
end

--- Proposal by id whether live or recently resolved; nil once it has aged out
--- of the archive.
local function lookupProposal(id)
    return proposals[id] or archive[id]
end

local activeList    = {}      -- ids in {offered,countered,active} — walked each tick
local activeIndex   = {}
local pendingClear  = {}      -- ids awaiting resolve-retention param clearing

local rejectCooldown    = {}  -- "fromTeam_toTeam" -> frame of last rejection
local liveOutgoingCount = {}  -- fromTeam -> count of offered/countered proposals

local trustLastDecay = {}    -- rulesParamKey -> frame last decayed (lazy, per-pair)

local eventSeq = 0

--[[ proposal = {
    id, kind,                 -- 'ceasefire'|'tribute'|'safe_passage'|'joint_objective'|'demand'|'intel'
    fromTeam, fromPlayer,     -- proposer (attribution)
    toTeam,                   -- counterparty teamID (Gaia teamID for civilians)
    terms,                    -- kind-specific
    deadline,                 -- frame; unanswered -> expired
    state,                    -- offered|countered|active|rejected|expired|fulfilled|breached
    counterOf,                -- id chain for counter-offers
    escrow,                   -- amount staked via GG.Authority (tribute 'pay' direction only)
    createdFrame, acceptedFrame, resolvedFrame,
    expiresAtFrame,           -- duration-based pacts (ceasefire/safe_passage/tribute)
    withdrawing, withdrawNoticeUntil,   -- E5
    data,                     -- kind-specific working state (tribute pay schedule, intel result)
} ]]

-- ============================================================
-- activeList helpers (mirrors game_objectives.lua exactly)
-- ============================================================
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
-- Shared helpers
-- ============================================================
local function playerTeam(playerID)
    if not playerID then return nil end
    local _, _, _, teamID = Spring.GetPlayerInfo(playerID, false)
    return teamID
end

local function cooldownKey(a, b) return tostring(a) .. '_' .. tostring(b) end

local function cooldownActive(fromTeam, toTeam, frame)
    local last = rejectCooldown[cooldownKey(fromTeam, toTeam)]
    return last ~= nil and (frame - last) < REJECT_COOLDOWN_FRAMES
end

local function unitClassOf(unitID)
    local udid = Spring.GetUnitDefID(unitID)
    local ud = udid and UnitDefs[udid]
    return ud and ud.customParams and ud.customParams.ms_class or nil
end

local function regionAt(unitID)
    if not GG.Regions then return nil end
    local x, _, z = Spring.GetUnitPosition(unitID)
    if not x then return nil end
    return GG.Regions.KeyAt(x, z)
end

-- ============================================================
-- Event ring (breach/fulfil toasts) — mirrors game_authority.lua's ring.
-- ============================================================
local function emitEvent(kind, proposalId, teamA, teamB, attackerTeam)
    eventSeq = eventSeq + 1
    local slot = eventSeq % EVENT_RING_SIZE
    local p = 'parley_event_' .. slot .. '_'
    Spring.SetGameRulesParam(p .. 'kind', kind)
    Spring.SetGameRulesParam(p .. 'proposal', proposalId)
    Spring.SetGameRulesParam(p .. 'teamA', teamA)
    Spring.SetGameRulesParam(p .. 'teamB', teamB)
    Spring.SetGameRulesParam(p .. 'attacker', attackerTeam or -1)
    Spring.SetGameRulesParam(p .. 'seq', eventSeq)
    Spring.SetGameRulesParam('parley_event', eventSeq)
end

-- ============================================================
-- Trust ledger (§2, task 3) — thin Spring-facing shell over parley/trust.lua.
-- ============================================================
function GG.Parley.Trust(a, b)
    return Spring.GetGameRulesParam(Trust.rulesParamKey(a, b)) or Trust.NEUTRAL
end

local function adjustTrust(a, b, delta)
    local key = Trust.rulesParamKey(a, b)
    local current = Spring.GetGameRulesParam(key) or Trust.NEUTRAL
    Spring.SetGameRulesParam(key, Trust.adjust(current, delta))
    trustLastDecay[key] = trustLastDecay[key] or Spring.GetGameFrame()
end

-- Lazily decays every trust pair that has ever been touched. Cheap: only
-- iterates the (small) set of pairs with recorded history, not all C(n,2)
-- team pairs, and only advances whole elapsed periods (§2 "decays toward
-- neutral over ~30 min").
local function decayTrustTick(frame)
    for key, lastFrame in pairs(trustLastDecay) do
        local periods = math.floor((frame - lastFrame) / TRUST_DECAY_TICK_FRAMES)
        if periods > 0 then
            local current = Spring.GetGameRulesParam(key) or Trust.NEUTRAL
            Spring.SetGameRulesParam(key, Trust.decay(current, periods))
            trustLastDecay[key] = lastFrame + periods * TRUST_DECAY_TICK_FRAMES
        end
    end
end

-- ============================================================
-- Publishing (mirrors game_objectives.lua's publish()/clearPublished()).
-- ============================================================
local PUBLISHED_FIELDS = {
    'kind', 'from', 'to', 'state', 'deadline', 'counterOf', 'escrow',
    'duration', 'regionKey', 'amount', 'perMinute', 'payer', 'corridor',
    'unitClass', 'objectiveId', 'split', 'innerKind', 'orElse', 'regionKeys',
    'intelRegions', 'intelStrengths',
}

local function clearPublished(p)
    local prefix = 'parley_' .. p.id .. '_'
    for _, field in ipairs(PUBLISHED_FIELDS) do
        Spring.SetGameRulesParam(prefix .. field, nil)
    end
end

local function publish(p)
    local prefix = 'parley_' .. p.id .. '_'
    Spring.SetGameRulesParam(prefix .. 'kind', p.kind)
    Spring.SetGameRulesParam(prefix .. 'from', p.fromTeam)
    Spring.SetGameRulesParam(prefix .. 'to', p.toTeam)
    Spring.SetGameRulesParam(prefix .. 'state', p.state)
    Spring.SetGameRulesParam(prefix .. 'deadline', p.deadline)
    if p.counterOf then Spring.SetGameRulesParam(prefix .. 'counterOf', p.counterOf) end
    Spring.SetGameRulesParam(prefix .. 'escrow', p.escrow or 0)

    local t = p.terms or {}
    if t.duration then Spring.SetGameRulesParam(prefix .. 'duration', t.duration) end
    if t.regionKey then Spring.SetGameRulesParam(prefix .. 'regionKey', t.regionKey) end
    if t.amount then Spring.SetGameRulesParam(prefix .. 'amount', t.amount) end
    if t.perMinute ~= nil then Spring.SetGameRulesParam(prefix .. 'perMinute', t.perMinute and 1 or 0) end
    if t.payer then Spring.SetGameRulesParam(prefix .. 'payer', t.payer) end
    if t.corridor then Spring.SetGameRulesParam(prefix .. 'corridor', table.concat(t.corridor, ',')) end
    if t.unitClass then Spring.SetGameRulesParam(prefix .. 'unitClass', t.unitClass) end
    if t.objectiveId then Spring.SetGameRulesParam(prefix .. 'objectiveId', t.objectiveId) end
    if t.split then Spring.SetGameRulesParam(prefix .. 'split', t.split) end
    if t.innerKind then Spring.SetGameRulesParam(prefix .. 'innerKind', t.innerKind) end
    if t.orElse then Spring.SetGameRulesParam(prefix .. 'orElse', t.orElse) end
    if t.regionKeys then Spring.SetGameRulesParam(prefix .. 'regionKeys', table.concat(t.regionKeys, ',')) end
    if p.data and p.data.intelRegions then
        Spring.SetGameRulesParam(prefix .. 'intelRegions', table.concat(p.data.intelRegions, ','))
        Spring.SetGameRulesParam(prefix .. 'intelStrengths', table.concat(p.data.intelStrengths, ','))
    end

    Spring.SetGameRulesParam('parley_count', nextId - 1)
end

-- ============================================================
-- Terms validation per kind (§1 table). Each returns ok[, err].
-- ============================================================
local function validateCeasefire(t)
    if type(t.duration) ~= 'number' or t.duration <= 0 then return false, 'duration required' end
    return true
end

local function validateSafePassage(t)
    if type(t.corridor) ~= 'table' or #t.corridor == 0 then return false, 'corridor required' end
    if type(t.duration) ~= 'number' or t.duration <= 0 then return false, 'duration required' end
    return true
end

local function validateTribute(t)
    if type(t.amount) ~= 'number' or t.amount <= 0 then return false, 'amount required' end
    if t.perMinute and (type(t.duration) ~= 'number' or t.duration <= 0) then
        return false, 'duration required for per-minute tribute'
    end
    if t.payer and t.payer ~= 'from' and t.payer ~= 'to' then return false, 'bad payer' end
    return true
end

local function validateIntel(t)
    if type(t.regionKeys) ~= 'table' or #t.regionKeys == 0 then return false, 'regionKeys required' end
    return true
end

local function validateJointObjective(t)
    if not t.objectiveId then return false, 'objectiveId required' end
    if not GG.Objectives then return false, 'objectives system unavailable' end
    local o = GG.Objectives.Get(t.objectiveId)
    if not o or o.state ~= 'active' then return false, 'objective not active' end
    if t.split ~= nil and (type(t.split) ~= 'number' or t.split < 0 or t.split > 1) then
        return false, 'split must be 0..1'
    end
    return true
end

local KIND_VALIDATORS  -- forward decl (demand needs to reference the table)

local function validateDemand(t)
    if t.innerKind then
        local validator = KIND_VALIDATORS[t.innerKind]
        if not validator then return false, 'unknown inner kind' end
        local ok, err = validator(t.innerTerms or {})
        if not ok then return false, err end
    end
    return true
end

KIND_VALIDATORS = {
    ceasefire       = validateCeasefire,
    safe_passage    = validateSafePassage,
    tribute         = validateTribute,
    intel           = validateIntel,
    joint_objective = validateJointObjective,
    demand          = validateDemand,
}

-- ============================================================
-- Enforcement lookup (§2 ROE veto + breach detection share this).
-- ============================================================
--- The single active ceasefire/safe_passage pact currently in force between
--- teamA and teamB (either direction — a mutual pact blocks both ways), or
--- nil. A pact still inside its withdrawal-notice window (E5) still counts
--- ("distinct from breach" — enforcement holds until the notice expires).
local function findEnforceablePact(teamA, teamB)
    for _, id in ipairs(activeList) do
        local p = proposals[id]
        if p and p.state == 'active' and (p.kind == 'ceasefire' or p.kind == 'safe_passage') then
            if (p.fromTeam == teamA and p.toTeam == teamB)
                or (p.fromTeam == teamB and p.toTeam == teamA) then
                return p
            end
        end
    end
    return nil
end

--- Does an in-force pact actually cover `unitID` right now (region scope /
--- unit-class filter)? Map-wide ceasefire (no regionKey) always covers.
local function pactCoversUnit(p, unitID)
    if p.kind == 'ceasefire' then
        if not p.terms.regionKey then return true end
        return regionAt(unitID) == p.terms.regionKey
    end
    -- safe_passage: must be inside the corridor, and (if set) match class.
    local region = regionAt(unitID)
    if not region then return false end
    local inCorridor = false
    for _, key in ipairs(p.terms.corridor) do
        if key == region then inCorridor = true; break end
    end
    if not inCorridor then return false end
    if p.terms.unitClass and unitClassOf(unitID) ~= p.terms.unitClass then return false end
    return true
end

-- ============================================================
-- Trust + terminal transitions
-- ============================================================
local function resolveTerminal(p, state, attackerTeam)
    if p.state ~= 'active' then return end
    p.state = state
    p.resolvedFrame = Spring.GetGameFrame()
    removeFromActive(p.id)
    pendingClear[#pendingClear + 1] = p.id

    if state == 'fulfilled' then
        adjustTrust(p.fromTeam, p.toTeam, Trust.FULFILLED_DELTA)
        emitEvent('fulfil', p.id, p.fromTeam, p.toTeam, nil)
    elseif state == 'breached' then
        adjustTrust(p.fromTeam, p.toTeam, Trust.BREACHED_DELTA)
        emitEvent('breach', p.id, p.fromTeam, p.toTeam, attackerTeam)
    end
    publish(p)
end

-- ============================================================
-- Accept-time kind effects (§1/§2). Returns ok[, err] — an accept that
-- can't be honoured (e.g. tribute the payer can't afford) fails the WHOLE
-- accept transactionally; the proposal stays in its prior pending state so
-- the parties can try again, rather than fabricating a broken pact.
-- ============================================================
local applyAccept  -- forward decl (demand recurses into it)

local function applyAcceptCeasefireOrSafePassage(p, frame)
    p.state = 'active'
    p.acceptedFrame = frame
    p.expiresAtFrame = frame + p.terms.duration
    return true
end

local function applyAcceptTribute(p, frame)
    local t = p.terms
    local payer = t.payer or 'from'
    local payerTeam = (payer == 'to') and p.toTeam or p.fromTeam
    local payeeTeam = (payerTeam == p.fromTeam) and p.toTeam or p.fromTeam

    if t.perMinute then
        p.state = 'active'
        p.acceptedFrame = frame
        p.expiresAtFrame = frame + t.duration
        p.data = { payerTeam = payerTeam, payeeTeam = payeeTeam,
                   nextPayFrame = frame + TRIBUTE_PAY_PERIOD_FRAMES }
        return true
    end

    -- One-shot. 'pay'-direction proposals from a real player were already
    -- escrowed at PROPOSE time (see GG.Parley.Propose) — fold that stake
    -- into the payout.
    if payer == 'from' and p.escrow and p.escrow > 0 then
        local total = GG.Authority.EscrowTotal(p.id)
        GG.Authority.Award({ team = payeeTeam }, total, 'tribute')
        GG.Authority.SettleEscrow(p.id, 'complete')
        p.state = 'fulfilled'
        p.acceptedFrame = frame
        return true
    end

    -- Not pre-escrowed (a 'to'-direction demand, or a system-originated
    -- 'pay' offer with no player to stake it): charge the payer's team pool
    -- directly at accept time.
    if not GG.Authority.ChargeOrder(nil, payerTeam, nil, t.amount) then
        return false, 'insufficient_authority'
    end
    GG.Authority.Award({ team = payeeTeam }, t.amount, 'tribute')
    p.state = 'fulfilled'
    p.acceptedFrame = frame
    return true
end

local function applyAcceptIntel(p, frame)
    local regions, strengths = {}, {}
    for _, key in ipairs(p.terms.regionKeys) do
        local total = 0
        for _, unitID in ipairs(Spring.GetTeamUnits(p.fromTeam)) do
            if regionAt(unitID) == key then
                total = total + (Spring.GetUnitHealth(unitID) or 0)
            end
        end
        regions[#regions + 1] = key
        strengths[#strengths + 1] = tostring(math.floor(total))
    end
    p.data = { intelRegions = regions, intelStrengths = strengths }
    p.state = 'fulfilled'
    p.acceptedFrame = frame
    return true
end

--- §1 "gap flagged, not silently faked": widens WHO can complete the
--- existing objective (real, enforced by game_objectives.lua's own check()
--- gates) so both sides race/cooperate for it. A team-vs-team reward SPLIT
--- (terms.split) is NOT enforced — game_objectives.lua's distributeAward
--- only ever pays whichever single team's check() reports as completingTeam,
--- then splits AMONG THAT TEAM's own players (objectives §5); there is no
--- cross-team payout split mechanism to hook into without a deeper change to
--- that gadget's award path. terms.split is stored/published for the UI and
--- for a future objectives-side change, not acted on here.
local function applyAcceptJointObjective(p, frame)
    local o = GG.Objectives.Get(p.terms.objectiveId)
    if not o or o.state ~= 'active' then return false, 'objective_gone' end
    if o.forTeam == p.fromTeam then
        GG.Objectives.WidenEligibility(o.id, p.toTeam)
    elseif o.forTeam == p.toTeam then
        GG.Objectives.WidenEligibility(o.id, p.fromTeam)
    end
    -- else: forTeam is nil (open race) or a third team — nothing sensible to
    -- widen; the accept still succeeds (E1-style: a stale precondition
    -- shouldn't hard-fail an otherwise-valid diplomatic act).
    p.state = 'fulfilled'
    p.acceptedFrame = frame
    return true
end

local function applyAcceptDemand(p, frame)
    if not p.terms.innerKind then
        p.state = 'fulfilled'
        p.acceptedFrame = frame
        return true
    end
    -- Recurse through the SAME dispatch with a view onto the inner terms —
    -- a demand's acceptance behaves exactly like its wrapped kind (§4: a
    -- demand is just an offered proposal; once accepted it IS that pact).
    local inner = { id = p.id, fromTeam = p.fromTeam, toTeam = p.toTeam,
                    terms = p.terms.innerTerms or {}, escrow = p.escrow }
    local ok, err = applyAccept(p.terms.innerKind, inner, frame)
    if not ok then return false, err end
    p.state = inner.state
    p.expiresAtFrame = inner.expiresAtFrame
    p.data = inner.data
    return true
end

local ACCEPT_HANDLERS = {
    ceasefire       = applyAcceptCeasefireOrSafePassage,
    safe_passage    = applyAcceptCeasefireOrSafePassage,
    tribute         = applyAcceptTribute,
    intel           = applyAcceptIntel,
    joint_objective = applyAcceptJointObjective,
    demand          = applyAcceptDemand,
}

applyAccept = function(kind, p, frame)
    local handler = ACCEPT_HANDLERS[kind]
    if not handler then return false, 'unknown_kind' end
    return handler(p, frame)
end

-- ============================================================
-- GG.Parley API (§1)
-- ============================================================

--- Create a proposal. fromPlayer may be nil (system/estate-originated).
--- Returns id, or nil + reason on rejection (fee/caps/validation/cooldown).
function GG.Parley.Propose(fromTeam, fromPlayer, toTeam, kind, terms)
    if toTeam == 'civ' then toTeam = Spring.GetGaiaTeamID() end
    if not fromTeam or not toTeam then return nil, 'team_required' end
    if fromTeam == toTeam then return nil, 'self_target' end
    if not KIND_VALIDATORS[kind] then return nil, 'unknown_kind' end

    local frame = Spring.GetGameFrame()
    if (liveOutgoingCount[fromTeam] or 0) >= MAX_LIVE_OUTGOING then return nil, 'cap_reached' end
    if cooldownActive(fromTeam, toTeam, frame) then return nil, 'cooldown' end

    terms = terms or {}
    local ok, err = KIND_VALIDATORS[kind](terms)
    if not ok then return nil, err end

    -- §1 spam-guard fee: reuses ChargeOrder as a generic player-then-team
    -- pool debit (it never touches its unitID argument — see
    -- game_authority.lua:276 — so nil is a legitimate call here, not a
    -- unit-order charge; "the free-list logic inverted" — proposing would
    -- otherwise be free like any non-order action, this imposes a cost).
    if not GG.Authority.ChargeOrder(nil, fromTeam, fromPlayer, PROPOSE_FEE) then
        return nil, 'insufficient_authority'
    end

    local id = nextId
    nextId = nextId + 1
    local p = {
        id = id, kind = kind, fromTeam = fromTeam, fromPlayer = fromPlayer,
        toTeam = toTeam, terms = terms,
        deadline = frame + PROPOSAL_TTL_FRAMES,
        state = 'offered', escrow = 0, createdFrame = frame,
    }

    -- Tribute 'pay'-direction escrow (§1 "escrow via the authority API"):
    -- stake the proposer's OWN funds now, refundable on reject/expiry
    -- (identical stake/return semantics to a staked bounty).
    if kind == 'tribute' and (terms.payer or 'from') == 'from' and not terms.perMinute
        and fromPlayer and GG.Authority.Stake(fromPlayer, id, terms.amount) then
        p.escrow = terms.amount
    end

    proposals[id] = p
    addToActive(id)
    liveOutgoingCount[fromTeam] = (liveOutgoingCount[fromTeam] or 0) + 1
    publish(p)
    firePropose(p)
    return id
end

local function decLiveOutgoing(fromTeam)
    liveOutgoingCount[fromTeam] = math.max(0, (liveOutgoingCount[fromTeam] or 0) - 1)
end

local function rejectProposal(p, frame)
    p.state = 'rejected'
    p.resolvedFrame = frame
    removeFromActive(p.id)
    pendingClear[#pendingClear + 1] = p.id
    decLiveOutgoing(p.fromTeam)
    rejectCooldown[cooldownKey(p.fromTeam, p.toTeam)] = frame
    if p.escrow and p.escrow > 0 then
        GG.Authority.SettleEscrow(p.id, 'expired')
    end
    publish(p)
end

--- Respond to a pending proposal. byTeam must be the proposal's toTeam.
--- decision: 'accept' | 'reject' | 'counter'. `extra` for 'counter' is
--- { kind?, terms? } (defaults to the same kind/terms, reversed direction).
function GG.Parley.Respond(id, byTeam, byPlayer, decision, extra)
    local p = proposals[id]
    if not p then return false, 'not_found' end
    if p.toTeam ~= byTeam then return false, 'not_your_proposal' end
    if p.state ~= 'offered' and p.state ~= 'countered' then return false, 'not_pending' end

    local frame = Spring.GetGameFrame()
    if decision == 'reject' then
        rejectProposal(p, frame)
        return true
    elseif decision == 'accept' then
        local ok, err = applyAccept(p.kind, p, frame)
        if not ok then return false, err end
        decLiveOutgoing(p.fromTeam)
        removeFromActive(p.id)
        if p.state == 'active' then
            addToActive(p.id)   -- stays live for enforcement/GameFrame ticks
        else
            pendingClear[#pendingClear + 1] = p.id
            if p.state == 'fulfilled' then adjustTrust(p.fromTeam, p.toTeam, Trust.FULFILLED_DELTA) end
        end
        publish(p)
        return true
    elseif decision == 'counter' then
        p.state = 'countered'   -- terminal — the counter is a NEW proposal
        p.resolvedFrame = frame
        removeFromActive(p.id)
        pendingClear[#pendingClear + 1] = p.id
        decLiveOutgoing(p.fromTeam)
        publish(p)

        extra = extra or {}
        local newId = GG.Parley.Propose(byTeam, byPlayer, p.fromTeam, extra.kind or p.kind, extra.terms or p.terms)
        if newId then proposals[newId].counterOf = id; publish(proposals[newId]) end
        return newId ~= nil
    end
    return false, 'bad_decision'
end

--- End an active pact cleanly (E5): either party may withdraw. Enforcement
--- stays live during the published notice window — withdrawal completes to
--- 'fulfilled' (not 'breached') once the window elapses.
function GG.Parley.Withdraw(id, byTeam)
    local p = proposals[id]
    if not p then return false, 'not_found' end
    if p.state ~= 'active' then return false, 'not_active' end
    if byTeam ~= p.fromTeam and byTeam ~= p.toTeam then return false, 'not_a_party' end
    if p.withdrawing then return true end
    p.withdrawing = true
    p.withdrawNoticeUntil = Spring.GetGameFrame() + WITHDRAWAL_NOTICE_FRAMES
    publish(p)
    return true
end

function GG.Parley.Get(id)
    -- Falls through to the S4 archive, so a just-resolved proposal is still
    -- readable for as long as the archive holds it.
    return lookupProposal(id)
end

-- ============================================================
-- Enforcement: ROE order veto (§2) — layer -45, runs after squad.lua (-60)
-- and before game_authority_charge.lua (+100).
-- ============================================================
function gadget:AllowCommand(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions, cmdTag, playerID, fromSynced, fromLua)
    if cmdID ~= CMD.ATTACK then return true end
    -- Only single-target attack orders are vetoed (E5: an area/ground attack
    -- has no partner unit to check and is accepted-cost "peaceful invasion"
    -- scouting territory; a partner unit caught in the blast is still a
    -- breach via UnitDamaged below).
    if not cmdParams or #cmdParams ~= 1 then return true end
    local targetID = cmdParams[1]
    if not Spring.ValidUnitID(targetID) then return true end
    local targetTeam = Spring.GetUnitTeam(targetID)
    if not targetTeam or targetTeam == unitTeam then return true end

    local pact = findEnforceablePact(unitTeam, targetTeam)
    if not pact then return true end
    if not pactCoversUnit(pact, targetID) then return true end
    return false   -- vetoed BEFORE game_authority_charge (+100) ever charges
end

-- ============================================================
-- Enforcement: breach detection off damage events (§2, E2 fire-frame rule).
-- ============================================================
local fireFrameOf = {}   -- projectileID -> frame it was created

function gadget:ProjectileCreated(proID)
    fireFrameOf[proID] = Spring.GetGameFrame()
end

function gadget:ProjectileDestroyed(proID)
    fireFrameOf[proID] = nil
end

function gadget:UnitDamaged(unitID, unitDefID, unitTeam, damage, paralyzer, weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam)
    if not attackerTeam or attackerTeam == unitTeam then return end
    if not damage or damage <= 0 then return end

    local pact = findEnforceablePact(attackerTeam, unitTeam)
    if not pact then return end

    -- E2: a real projectile in flight when the truce landed doesn't break
    -- it — check the FIRE frame (when the shot was loosed), not the frame
    -- damage actually resolves. Weapons with no tracked projectile
    -- (instant-hit/melee, projectileID absent or unknown) have no travel
    -- gap, so "now" IS the fire frame for them.
    local fireFrame = (projectileID and projectileID ~= 0 and fireFrameOf[projectileID]) or Spring.GetGameFrame()
    if fireFrame < (pact.acceptedFrame or 0) then return end

    if not pactCoversUnit(pact, unitID) then return end

    resolveTerminal(pact, 'breached', attackerTeam)
end

-- ============================================================
-- Lifecycle
-- ============================================================
function gadget:Initialize()
    local mo = Spring.GetModOptions()
    PROPOSE_FEE = tonumber(mo.parley_propose_fee) or PROPOSE_FEE
end

function gadget:RecvLuaMsg(msg, playerID)
    local cmd, fields = Wire.decode(msg)
    if not cmd then return end
    local fromTeam = playerTeam(playerID)
    if not fromTeam then return end

    if cmd == 'parley.propose' then
        local terms = {
            duration = Wire.num(fields.duration),
            regionKey = fields.regionKey,
            amount = Wire.num(fields.amount),
            perMinute = fields.perMinute == '1',
            payer = fields.payer,
            corridor = fields.corridor and Wire.list(fields.corridor) or nil,
            unitClass = fields.unitClass,
            objectiveId = Wire.num(fields.objectiveId),
            split = Wire.num(fields.split),
            innerKind = fields.innerKind,
            orElse = fields.orElse,
            regionKeys = fields.regionKeys and Wire.list(fields.regionKeys) or nil,
        }
        GG.Parley.Propose(fromTeam, playerID, Wire.num(fields.toTeam) or fields.toTeam, fields.kind, terms)
    elseif cmd == 'parley.respond' then
        GG.Parley.Respond(Wire.num(fields.id), fromTeam, playerID, fields.decision,
            fields.kind and { kind = fields.kind } or nil)
    elseif cmd == 'parley.withdraw' then
        GG.Parley.Withdraw(Wire.num(fields.id), fromTeam)
    end
end

-- ─────────────── Snapshot state (PLAN-persistence task 1d-b, §7.1d) ───────────────
--
-- A parley is a promise between two teams, and a promise is authored — nothing
-- about the restored board says a ceasefire was ever offered, let alone
-- accepted. The registry mirrors game_objectives' shape and so does this
-- census; the differences are the interesting part.
--
-- CAPTURED — `proposals`, `nextId`, `archive`, `archiveRing`, `archiveSlot`,
-- `activeList`, `activeIndex`, `pendingClear`. Same reasoning as objectives:
-- `lookupProposal` reads across live + archive, the ring needs its cursor, a
-- reset `nextId` re-issues a live id onto a live rulesParam prefix, and an id
-- dropped from `pendingClear` never has its params cleared and never gets
-- archived.
--
-- CAPTURED — `liveOutgoingCount`. It is E6's per-team cap on PENDING outgoing
-- proposals, and it is a counter incremented and decremented against
-- `activeList`, not read off it. Restore the proposals without it and either
-- the cap reads zero (a team that has hit its limit may spam four more) or a
-- decrement underflows a team permanently below it.
--
-- CAPTURED — `rejectCooldown`. Absolute frame stamps, keyed by team pair: the
-- 2-minute cooldown after a rejection. Dropping it lets a team re-propose the
-- instant a rollback lands, which turns a restore into a way to bypass E6.
--
-- CAPTURED — `trustLastDecay`. This is a per-pair cursor into a LAZY decay: the
-- trust values themselves are game rules params (restored by the `gameRules`
-- section), but `decayTrustTick` computes how many periods to apply from
-- `frame - lastFrame`. A cursor left where the live process had it applies the
-- decay between two different worlds' frames in a single tick — and unlike a
-- Tick gate this one has no rewind clamp, so restoring backwards yields a
-- negative period count and simply stops decaying that pair.
--
-- CAPTURED — `eventSeq`, for the same reason as authority's: the toast ring's
-- slots are restored rulesParams, so a reset cursor overwrites the newest one.
--
-- DROPPED, and it is the one real drop here — `fireFrameOf`. It is keyed by
-- projectileID, and in-flight projectiles are §7's named deliberate loss (they
-- are not in the section table and never will be). Keeping the map would leave
-- entries for projectiles that no longer exist, and ProjectileDestroyed can
-- never fire for them, so it would leak one entry per in-flight round per
-- restore forever. Cleared, not preserved — the E2 fire-frame rule can only
-- speak about projectiles that exist.
--
-- RE-DERIVED, not captured — `PROPOSE_FEE` (a modoption, re-read in
-- Initialize) and `proposeHooks`.
function gadget:Save(state)
    state.proposals = proposals
    state.nextId = nextId
    state.archive = archive
    state.archiveRing = archiveRing
    state.archiveSlot = archiveSlot
    state.activeList = activeList
    state.activeIndex = activeIndex
    state.pendingClear = pendingClear
    state.rejectCooldown = rejectCooldown
    state.liveOutgoingCount = liveOutgoingCount
    state.trustLastDecay = trustLastDecay
    state.eventSeq = eventSeq
end

function gadget:Load(state)
    proposals    = state.proposals or {}
    nextId       = tonumber(state.nextId) or 1
    archive      = state.archive or {}
    archiveRing  = state.archiveRing or {}
    archiveSlot  = tonumber(state.archiveSlot) or 0
    activeList   = state.activeList or {}
    activeIndex  = state.activeIndex or {}
    pendingClear = state.pendingClear or {}
    rejectCooldown    = state.rejectCooldown or {}
    liveOutgoingCount = state.liveOutgoingCount or {}
    trustLastDecay    = state.trustLastDecay or {}
    eventSeq     = tonumber(state.eventSeq) or 0
    -- See the census: the projectiles these ids name are gone by construction.
    fireFrameOf = {}
end

function gadget:GameFrame(frame)
    -- Snapshot: resolution mutates activeList mid-iteration.
    local snapshot = {}
    for i, id in ipairs(activeList) do snapshot[i] = id end

    for _, id in ipairs(snapshot) do
        local p = proposals[id]
        if p then
            if (p.state == 'offered' or p.state == 'countered') and frame >= p.deadline then
                p.state = 'expired'
                p.resolvedFrame = frame
                removeFromActive(id)
                pendingClear[#pendingClear + 1] = id
                decLiveOutgoing(p.fromTeam)
                if p.escrow and p.escrow > 0 then GG.Authority.SettleEscrow(id, 'expired') end
                publish(p)
            elseif p.state == 'active' then
                if p.withdrawing and frame >= p.withdrawNoticeUntil then
                    resolveTerminal(p, 'fulfilled', nil)
                elseif p.data and p.data.nextPayFrame and frame >= p.data.nextPayFrame then
                    -- Recurring tribute payment tick.
                    if GG.Authority.ChargeOrder(nil, p.data.payerTeam, nil, p.terms.amount) then
                        GG.Authority.Award({ team = p.data.payeeTeam }, p.terms.amount, 'tribute')
                        p.data.nextPayFrame = frame + TRIBUTE_PAY_PERIOD_FRAMES
                    else
                        resolveTerminal(p, 'breached', p.data.payerTeam)
                    end
                elseif p.expiresAtFrame and frame >= p.expiresAtFrame then
                    resolveTerminal(p, 'fulfilled', nil)
                end
            end
        end
    end

    decayTrustTick(frame)

    for i = #pendingClear, 1, -1 do
        local id = pendingClear[i]
        local p = proposals[id]
        if not p or (frame - (p.resolvedFrame or frame)) >= RESOLVE_RETENTION_FRAMES then
            -- S4: clearing the params was only half of it — archive the
            -- proposal itself so the heap stops holding every resolved offer.
            if p then
                clearPublished(p)
                archiveProposal(id)
            end
            table.remove(pendingClear, i)
        end
    end
end
