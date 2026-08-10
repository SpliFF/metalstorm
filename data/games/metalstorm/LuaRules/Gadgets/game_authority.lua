-- game_authority.lua — the authority economy (PLAN-metalstorm-authority.md).
--
-- One resource: authority. Earned by completing objectives
-- (game_objectives.lua calls GG.Authority.Award), spent by issuing orders.
-- Spring's metal/energy plumbing is unused.
--
-- TEAM OWNERSHIP MODEL (PLAN-metalstorm.md §2): units belong to the TEAM;
-- any team player commands any team unit. Order costs charge the issuing
-- PLAYER's pool (self-organising command allocation), falling back to the
-- team pool.
--
-- STRUCTURE (§3.2, DECISIONS.md D1/D6): this gadget owns registration,
-- pools, the GG.Authority API (Award/Stake/OrderCost/ChargeOrder), and
-- Initialize — so GG.Authority exists for every other gadget's Initialize.
-- It stays at layer -100 (early). The actual AllowCommand charging callin
-- lives in the separate game_authority_charge.lua at layer +100, so
-- charging runs AFTER every other gadget's veto (a vetoed order must never
-- cost the player — see game_authority_charge.lua's header for the layer-
-- ordering proof). The pure formula/attribution/classification logic lives
-- in authority/*.lua (busted-testable, no Spring/GG mocking), matching the
-- regions/ convention.
--
-- Cost formula (authority/formula.lua, driven by LuaRules/Configs/authority_cost.lua):
--   cost = ceil(base_k × authority_cost_base × regionMod × orderClassMod × costScale)

function gadget:GetInfo()
    return {
        name    = "Authority Economy",
        desc    = "Single-resource economy: earn via objectives, spend on orders",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -100, -- before objectives/regions/teams
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Formula                      = VFS.Include("LuaRules/Gadgets/authority/formula.lua")
local Attribute                    = VFS.Include("LuaRules/Gadgets/authority/attribute.lua")
local Classify                     = VFS.Include("LuaRules/Gadgets/authority/classify.lua")
local Escrow                       = VFS.Include("LuaRules/Gadgets/authority/escrow.lua")
local Ledger                       = VFS.Include("LuaRules/Gadgets/authority/ledger.lua")
local Metrics                      = VFS.Include("LuaRules/Gadgets/authority/metrics.lua")
local CostSpec                     = VFS.Include("LuaRules/Configs/authority_cost.lua")
local Tick                         = VFS.Include("LuaRules/Gadgets/tick.lua")

local STARTING_TEAM_AUTHORITY      = 500
local EVENT_RING_SIZE              = 8
local STIPEND_PERIOD_FRAMES        = 1800 -- 1 minute at GAME_SPEED 30
local LEDGER_PUBLISH_PERIOD_FRAMES = 900 -- 30 s at GAME_SPEED 30 (§1)

-- D15: all three periodic jobs below are skip-safe (see tick.lua). The two that
-- move authority use the ACCRUAL policy — a stipend and an overflow decay are
-- earned by the passage of frames, and a modulo gate let a stalled server take
-- a whole minute's income off every team with nobody noticing. The ledger
-- publish is an observation and collapses.
local stipendGate                  = Tick.new(STIPEND_PERIOD_FRAMES)
local decayGate                    = Tick.new()   -- period comes from CostSpec
local ledgerPublishGate            = Tick.new(LEDGER_PUBLISH_PERIOD_FRAMES)

local costScale                    = 1.0
local joinGrant                    = 100
local teamStipend                  = 0

-- Ledger state (PLAN-metalstorm-economy.md §1): reason-tagged accumulators
-- for long-horizon economy monitoring (gm-tools dashboard, headless validation).
local ledgerState                  = Ledger.newState()

-- Metrics state (§2): health metrics computed from ledger counters (velocity
-- EMA, dead-team time) — feeds gm-tools dashboard.
local metricsState                 = Metrics.newState()

-- Previous ledger snapshot (for delta computation in GameFrame)
local prevLedger                   = {}

GG.Authority                       = GG.Authority or {}

--- Export ledger counters (PLAN-metalstorm-economy.md §1: for stats-dump
--- and game_events hooks). Returns { [teamID] = {mint=N, burn=M, move=K, unmapped=U}, ... }
function GG.Authority.ExportLedger()
    return Ledger.exportAll(ledgerState)
end

--- Export health metrics (§2: for gm-tools dashboard). Returns per-team metrics:
--- { [teamID] = {velocity=V, poolRatio=R, gini=G, deadTimeMin=D}, ... }
--- `typicalArmyCost` is an optional estimate of a mid-size army command cost
--- (defaults to 1000 if not provided); `cheapestOrderCost` is the lowest posture
--- order cost (defaults to 10).
function GG.Authority.ExportMetrics(typicalArmyCost, cheapestOrderCost)
    typicalArmyCost = typicalArmyCost or 1000
    cheapestOrderCost = cheapestOrderCost or 10
    local out = {}
    local gaia = Spring.GetGaiaTeamID()
    for _, teamID in ipairs(Spring.GetTeamList()) do
        if teamID ~= gaia then
            local teamPool = getTeamPool(teamID)
            local playerPools = {}
            local totalPools = teamPool
            for _, playerID in ipairs(Spring.GetPlayerList(teamID)) do
                local pool = getPlayerPool(playerID)
                playerPools[#playerPools + 1] = pool
                totalPools = totalPools + pool
            end
            out[teamID] = {
                velocity = Metrics.velocity(metricsState, teamID),
                poolRatio = Metrics.poolRatio(totalPools, typicalArmyCost),
                gini = Metrics.gini(playerPools),
                deadTimeMin = Metrics.deadTimeMinutes(metricsState, teamID),
            }
        end
    end
    return out
end

--- Check if a player or team pool is overflowing (§2: authority-bar overflow
--- indicator). Returns (isOverflowing, ceiling, excess). `ceiling` and `excess`
--- are nil if overflow decay isn't enabled (constants not yet tuned, §3).
function GG.Authority.IsOverflowing(playerID_or_nil, teamID)
    local econ = CostSpec.economy
    if not econ or not econ.soft_ceiling_C_base then
        return false, nil, nil
    end
    local ceiling
    if playerID_or_nil then
        ceiling = econ
        .soft_ceiling_C_base               -- per-player ceiling (§3: C_base × teamPlayerCount for team, C_base for player)
        local pool = getPlayerPool(playerID_or_nil)
        local excess = pool - ceiling
        return excess > 0, ceiling, excess
    else
        local playerCount = #Spring.GetPlayerList(teamID)
        ceiling = econ.soft_ceiling_C_base * math.max(1, playerCount)
        local pool = getTeamPool(teamID)
        local excess = pool - ceiling
        return excess > 0, ceiling, excess
    end
end

--- Apply reward normalisation (§3.2, Lever 2): scale systemic objective rewards
--- by 1/velocity, clamped to [0.5, 2.0]. Returns the scaled amount. If reward
--- normalisation is disabled, returns the original amount unchanged.
--- `teamID` is the team earning the reward (whose velocity is consulted).
--- NOTE: player-staked bounties must NOT call this — normalisation applies to
--- systemic rewards only (§5 E2).
function GG.Authority.NormaliseReward(teamID, amount)
    local econ = CostSpec.economy
    if not econ or not econ.reward_normalisation_enabled then
        return amount
    end
    local velocity = Metrics.velocity(metricsState, teamID)
    if velocity == 0 then velocity = 1.0 end
    local scale = 1 / velocity
    scale = math.max(econ.reward_scale_min, math.min(econ.reward_scale_max, scale))
    return amount * scale
end

-- ============================================================
-- Optional observer hooks (PLAN-metalstorm-teams.md task 4: the per-player
-- scoreboard needs earned/spent deltas without duplicating pool bookkeeping
-- in game_teams.lua). Empty lists by default — zero overhead when nobody's
-- listening, and this file's own logic never reads them back.
-- ============================================================
local awardHooks = {}
local chargeHooks = {}

--- Register fn(playerID_or_nil, teamID, amount), called once per concrete
--- disbursement after a successful Award — for the split form that's once
--- per weighted player, never for the team-share remainder (no single
--- player to attribute that portion to).
function GG.Authority.OnAward(fn)
    awardHooks[#awardHooks + 1] = fn
end

--- Register fn(playerID, teamID, amount), called after a successful
--- ChargeOrder with `amount` = the portion actually drawn from that
--- player's OWN pool. Never fires for the team-pool portion of a mixed
--- charge (again, no single player to attribute team spend to).
function GG.Authority.OnCharge(fn)
    chargeHooks[#chargeHooks + 1] = fn
end

local function fireAward(playerID, teamID, amount)
    for _, fn in ipairs(awardHooks) do fn(playerID, teamID, amount) end
end

local function fireCharge(playerID, teamID, amount)
    for _, fn in ipairs(chargeHooks) do fn(playerID, teamID, amount) end
end

-- ============================================================
-- Pools (§1). Team pool: teamRulesParam authority_pool. Player pool:
-- teamRulesParam authority_player_<playerID> — NOT gameRulesParam (that
-- streams to enemies too, per Spring.GetGameRulesParams "always readable
-- for all", verified rts/Lua/LuaSyncedRead.cpp). Both published
-- ALLIED-visible ({allied=true}): default (no losAccess table) is
-- RULESPARAMLOS_PRIVATE = readable only by the owning team itself
-- (rts/Lua/LuaRulesParams.h); {allied=true} ORs in RULESPARAMLOS_ALLIED so
-- allied teams see it too (verified LuaSyncedRead.cpp GetTeamRulesParams:
-- same-team reads via the PRIVATE bit, allied reads via the ALLIED bit,
-- enemy reads see neither) — matches "every teammate/ally sees every
-- teammate's pool" (§1) without leaking to enemies. Whoever builds the
-- server->client rulesParams wire producer (currently a dead producer —
-- see field notes) MUST filter per-connection the same way, or this LOS
-- contract is honoured sim-side only.
local ALLIED_LOS = { allied = true }

local function setTeamPool(teamID, v)
    Spring.SetTeamRulesParam(teamID, 'authority_pool', v, ALLIED_LOS)
end
local function getTeamPool(teamID)
    return Spring.GetTeamRulesParam(teamID, 'authority_pool') or 0
end
local function playerTeam(playerID)
    local _, _, _, teamID = Spring.GetPlayerInfo(playerID, false)
    return teamID
end
-- playerID → canonical integer, used for EVERY authority_player_<id> /
-- authority_granted_<id> rulesParam key. CRITICAL (AI3 bugfix): Spring's
-- GetPlayerList() returns player ids as Lua 5.4 FLOATS (0.0, 3.0, ...), while
-- the charge callins (AllowCommand / AllowDirectiveCreate) receive them as
-- INTEGERS from C++. Concatenated raw, a float 0.0 makes key
-- 'authority_player_0.0' but an integer 0 makes 'authority_player_0' — two
-- DIFFERENT keys for the same player. That mismatch meant a pool created by
-- PlayerAdded (float-keyed) was invisible to the charge (int-keyed), so the
-- player silently drained the TEAM pool instead of their own — and made the
-- co-commander own-pool-only invariant unenforceable. Normalising to an
-- integer here is the single fix for both the AI and human paths.
local function pkey(playerID)
    return 'authority_player_' .. math.floor(playerID)
end
local function setPlayerPool(playerID, v)
    local teamID = playerTeam(playerID)
    if not teamID then return end
    Spring.SetTeamRulesParam(teamID, pkey(playerID), v, ALLIED_LOS)
end
local function getPlayerPool(playerID)
    local teamID = playerTeam(playerID)
    if not teamID then return 0 end
    return Spring.GetTeamRulesParam(teamID, pkey(playerID)) or 0
end

-- Own-pool-only flag (AI3 / PLAN-metalstorm-ai.md §5). Stored as a per-player
-- teamRulesParam (allied-scoped, mirrors the pool) so it's the single source of
-- truth AND inspectable by the HUD/tests. When set, debitPools charges the
-- player's own pool ONLY — never the team fallback (Attribute.attribute's
-- ownPoolOnly path). This is the enforceable form of the co-commander invariant
-- "own pool only, never the team fallback": the co-commander AI role sets it on
-- its own virtual playerID via GG.Authority.SetOwnPoolOnly; a full-side AI (and
-- every human) leaves it unset and keeps the normal team-fallback behaviour.
local function setOwnPoolOnly(playerID, flag)
    local teamID = playerTeam(playerID)
    if not teamID then return end
    Spring.SetTeamRulesParam(teamID, pkey(playerID) .. '_own_pool_only',
        flag and 1 or 0, ALLIED_LOS)
end
local function getOwnPoolOnly(playerID)
    if not playerID then return false end
    local teamID = playerTeam(playerID)
    if not teamID then return false end
    return (Spring.GetTeamRulesParam(teamID,
        pkey(playerID) .. '_own_pool_only') or 0) ~= 0
end

--- Public API for the co-commander AI role (PLAN-metalstorm-ai.md §5, task 4):
--- flag a player so its authority charges draw from its OWN pool only, never
--- the team fallback. Called from the AI's role config on its own virtual
--- playerID (the AI knows its id via AI.getPlayerId()). Idempotent; pass a
--- falsy flag to clear (e.g. when a co-commander is promoted to full-side in
--- caretaker mode). Honoured by every charge site through debitPools.
function GG.Authority.SetOwnPoolOnly(playerID, flag)
    setOwnPoolOnly(playerID, flag)
end
function GG.Authority.GetOwnPoolOnly(playerID)
    return getOwnPoolOnly(playerID)
end

-- ============================================================
-- Award/charge event ring (§2, task 4): gameRulesParam `authority_event`
-- (monotonic counter, the "something changed" signal) + `authority_event_<slot>_*`
-- (ring buffer of the last EVENT_RING_SIZE events). Only AWARD-class events
-- (objective rewards, join grants, stipends, stake refunds) and CHARGE
-- REFUSALS are recorded — routine per-order successful charges are not
-- (every move order would otherwise evict real events from an 8-slot ring
-- within seconds; the live pool display already shows ongoing spend).
local eventSeq = 0

local function emitEvent(kind, amount, reason, playerID, teamID)
    eventSeq = eventSeq + 1
    local slot = eventSeq % EVENT_RING_SIZE
    local p = 'authority_event_' .. slot .. '_'
    Spring.SetGameRulesParam(p .. 'kind', kind)
    Spring.SetGameRulesParam(p .. 'amount', amount)
    Spring.SetGameRulesParam(p .. 'reason', reason or '')
    Spring.SetGameRulesParam(p .. 'player', playerID or -1)
    Spring.SetGameRulesParam(p .. 'team', teamID or -1)
    Spring.SetGameRulesParam(p .. 'seq', eventSeq)
    Spring.SetGameRulesParam('authority_event', eventSeq)
end

-- ============================================================
-- GG.Authority API (§2, §3, §6)
-- ============================================================

--- Award authority. target =
---   { player = playerID }
---   | { team = teamID }
---   | { split = { team = teamID, weights = { [playerID] = w, ... }, teamWeight = w0 } }
--- The split form is what objectives use (PLAN-metalstorm-objectives.md
--- §5): weighted direct shares to participating players, the remainder
--- (teamWeight — absent contributors, unattributed work) to the team pool.
--- `team` is REQUIRED in split form (which team's pool absorbs the
--- remainder); this is a concrete refinement of §2's `{ [playerID] =
--- weight, team = weight }` shorthand, chosen because Award has no other
--- way to learn which team's pool the "team" share belongs to — recorded
--- here since the plan text left the shape implicit.
--- True when `teamID` is a team this game actually has.
---
--- Spring.Get/SetTeamRulesParam raise a hard Lua error on an unknown team,
--- and Award is called from inside the Objectives gadget's eval callin — so
--- one award aimed at a team that isn't there does not just lose the payment,
--- it propagates out of the callin and gadgetHandler REMOVES the Objectives
--- gadget. The whole objective system, victory objective included, then stops
--- evaluating for the rest of the match. Observed live on a two-team lobby
--- room whose scenario declared eight ("Removed gadget: Objectives" at frame
--- 5669, PLAN-endtoend.md D10). game_scenario now filters its own staging, so
--- this is the backstop for every other caller — the systemic generator, a
--- bounty on a team that has since been removed, a mid-match team wipe.
local function teamExists(teamID)
    if teamID == nil then return false end
    for _, t in ipairs(Spring.GetTeamList() or {}) do
        if t == teamID then return true end
    end
    return false
end

function GG.Authority.Award(target, amount, reason)
    if amount == nil or amount <= 0 then return end

    if target.player then
        local teamID = playerTeam(target.player)
        setPlayerPool(target.player, getPlayerPool(target.player) + amount)
        emitEvent('award', amount, reason, target.player, teamID)
        fireAward(target.player, teamID, amount)
        Ledger.tagAward(ledgerState, teamID, amount, reason)
        return
    end

    if target.team then
        if not teamExists(target.team) then
            Spring.Echo('[Authority] WARNING: award of ' .. tostring(amount) ..
                        ' to team ' .. tostring(target.team) ..
                        ' ("' .. tostring(reason) .. '") dropped — this game has no such team')
            return
        end
        setTeamPool(target.team, getTeamPool(target.team) + amount)
        emitEvent('award', amount, reason, nil, target.team)
        fireAward(nil, target.team, amount)
        Ledger.tagAward(ledgerState, target.team, amount, reason)
        return
    end

    local spec = target.split
    if spec then
        local totalWeight = spec.teamWeight or 0
        local weights = spec.weights or {}
        for _, w in pairs(weights) do totalWeight = totalWeight + (w or 0) end
        if totalWeight <= 0 then return end

        for playerID, w in pairs(weights) do
            if w and w > 0 then
                local share = amount * w / totalWeight
                local teamID = playerTeam(playerID)
                setPlayerPool(playerID, getPlayerPool(playerID) + share)
                emitEvent('award', share, reason, playerID, teamID)
                fireAward(playerID, teamID, share)
                Ledger.tagAward(ledgerState, teamID, share, reason)
            end
        end
        local teamShare = amount * (spec.teamWeight or 0) / totalWeight
        if teamShare > 0 and teamExists(spec.team) then
            setTeamPool(spec.team, getTeamPool(spec.team) + teamShare)
            emitEvent('award', teamShare, reason, nil, spec.team)
            Ledger.tagAward(ledgerState, spec.team, teamShare, reason)
        end
    end
end

--- Move authority between two existing pools. `src` and `dst` are each
--- `{ player = playerID }` or `{ team = teamID }`. Strictly net-zero: nothing
--- is minted, nothing is destroyed, and the debit NEVER falls back to another
--- pool — if `src` can't cover `amount` in full the whole transfer is refused
--- (returns false, no partial move). Ledger class is therefore `move`, tagged
--- via tagCharge like every other pool-to-pool flow (stake_escrow,
--- leaver_merge, player_fallback).
---
--- This is the primitive an AI-funding control needs and Award/ChargeOrder
--- could not express (PLAN-metalstorm-ai.md §5.2 / endtoend D32). Award MINTS,
--- so "fund the AI" written as Award would inflate the economy by the funded
--- amount; ChargeOrder debits with the ordinary TEAM FALLBACK, so a human
--- funding an AI through it could quietly move team savings into an
--- own-pool-only AI's pocket — the exact drain §5's invariant forbids. Transfer
--- does neither: one named pool loses exactly what another gains.
---
--- The destination side emits an `award` ring event so the client authority bar
--- surfaces incoming funding the same way it surfaces a join grant; the source
--- side does not (a routine debit, and the ring is only 8 slots).
function GG.Authority.Transfer(src, dst, amount, reason)
    if not src or not dst or not amount or amount <= 0 then return false end

    local balance = GG.Authority.PoolOf
    local function credit(ref, delta)
        if ref.player then
            setPlayerPool(ref.player, getPlayerPool(ref.player) + delta)
            return playerTeam(ref.player)
        end
        setTeamPool(ref.team, getTeamPool(ref.team) + delta)
        return ref.team
    end

    local have = balance(src)
    if have == nil or have < amount then return false end
    if balance(dst) == nil then return false end   -- unknown destination team

    credit(src, -amount)
    local dstTeam = credit(dst, amount)
    emitEvent('award', amount, reason, dst.player, dstTeam)
    if dst.player then fireAward(dst.player, dstTeam, amount) end
    -- Tagged once, against the team the authority ends up on.
    Ledger.tagCharge(ledgerState, dstTeam, amount, reason)
    return true
end

--- Current balance of a pool, `{ player = id }` or `{ team = id }`. nil for an
--- unknown team (never 0 — callers must be able to tell "empty" from "not a
--- team", the distinction Award's teamExists guard exists for). Read-only
--- companion to Transfer: a caller splitting one debit across several
--- destinations needs to know it can cover the total BEFORE moving any of it.
function GG.Authority.PoolOf(ref)
    if not ref then return nil end
    if ref.player then return getPlayerPool(ref.player) end
    if ref.team then
        if not teamExists(ref.team) then return nil end
        return getTeamPool(ref.team)
    end
    return nil
end

-- Staked-bounty escrow (§2, §6): player→player/objective delegation.
local escrowState = Escrow.newState()

--- Stake `amount` of `playerID`'s own authority onto `objectiveID`. Debits
--- the player pool immediately (no team fallback — staking is a personal
--- gift, not an order); fails (no-op, returns false) if the player can't
--- cover it.
function GG.Authority.Stake(playerID, objectiveID, amount)
    if not amount or amount <= 0 then return false end
    local pool = getPlayerPool(playerID)
    if pool < amount then return false end
    local teamID = playerTeam(playerID)
    setPlayerPool(playerID, pool - amount)
    Escrow.add(escrowState, objectiveID, playerID, teamID, amount)
    Ledger.tagCharge(ledgerState, teamID, amount, 'stake_escrow')
    return true
end

--- Total currently staked on an objective (for the caller to fold into the
--- reward at completion via Award, then call SettleEscrow('complete')).
function GG.Authority.EscrowTotal(objectiveID)
    return Escrow.total(escrowState, objectiveID)
end

--- Resolve an objective's escrow. outcome = 'complete' | 'expired' | 'failed'.
--- 'complete': caller already awarded EscrowTotal(objectiveID) as part of
---   the reward — this just clears the ledger. 'expired'/'failed': returns
---   each stake to its staker's player pool, or to their team pool if
---   they've since left (§6 "escrow stays on the objective... on
---   resolve, the staker's returned share goes to their team pool").
function GG.Authority.SettleEscrow(objectiveID, outcome)
    local refunds = Escrow.settle(escrowState, objectiveID, outcome, function(playerID)
        local active = select(2, Spring.GetPlayerInfo(playerID, false))
        return active == true
    end)
    for _, r in ipairs(refunds) do
        if r.player then
            local teamID = playerTeam(r.player)
            setPlayerPool(r.player, getPlayerPool(r.player) + r.amount)
            emitEvent('refund', r.amount, 'stake_' .. outcome, r.player, teamID)
            -- Refunds from expired/failed objectives count as 'stake_refund' mint
            -- (return of the player's own staked money — not a new award, but flows
            -- back into the pools so velocity math needs to see it)
            Ledger.tagAward(ledgerState, teamID, r.amount, 'stake_refund')
        elseif r.team then
            setTeamPool(r.team, getTeamPool(r.team) + r.amount)
            emitEvent('refund', r.amount, 'stake_' .. outcome, nil, r.team)
            Ledger.tagAward(ledgerState, r.team, r.amount, 'stake_refund')
        end
    end
end

--- Order cost for `unitID` issuing `cmdID` (§3.1/§3.3). Routed entirely
--- through LuaRules/Configs/authority_cost.lua — base_k and the
--- order_class table are THE shared spec (also exported to
--- authority_cost.json for the client mirror, task 5).
function GG.Authority.OrderCost(unitID, cmdID)
    local udid = Spring.GetUnitDefID(unitID)
    local ud = udid and UnitDefs[udid]
    local base = 1
    if ud and ud.customParams and ud.customParams.authority_cost_base then
        base = tonumber(ud.customParams.authority_cost_base) or 1
    end
    local regionMod = (GG.Regions and GG.Regions.CostModifierAt)
        and GG.Regions.CostModifierAt(unitID) or 1.0
    local class = Classify.orderClass(cmdID)
    local classMod = CostSpec.order_class[class] or 1.0
    return Formula.cost(CostSpec.base_k, base, regionMod, classMod, costScale)
end

--- The pool-debit primitive (§3.2 "Attribution & fallback"): charges
--- `playerID`'s pool first, then `teamID`'s pool for the remainder.
--- Refuses (no debit at all) if neither combination covers `cost`, and
--- records a 'refusal' event so the player sees why. The ONLY writer of
--- pool state during normal play — shared by every charge site
--- (ChargeOrder for AllowCommand, ChargeDirective/ChargeStandingOrder for
--- directive/standing-order create) so pool debit + ledger tagging + hooks
--- never diverge between call sites. `class` tags the ledger entry
--- (authority_cost.lua order_class key — a bookkeeping label; `cost` is
--- already computed by the caller).
local function debitPools(teamID, playerID, cost, class)
    if cost <= 0 then return true end
    local playerPool = playerID and getPlayerPool(playerID) or 0
    local teamPool = getTeamPool(teamID)
    -- AI3 (§5): a player flagged own-pool-only (the co-commander AI) gets NO
    -- team fallback — its own pool must cover the whole cost or the order is
    -- refused. Full-side AIs and humans are unflagged and keep team fallback.
    local ownPoolOnly = getOwnPoolOnly(playerID)
    local allowed, spentFromPlayer, spentFromTeam =
        Attribute.attribute(playerPool, teamPool, cost, ownPoolOnly)
    if not allowed then
        emitEvent('refusal', cost, 'insufficient_authority', playerID, teamID)
        return false
    end
    local totalCharged = spentFromPlayer + spentFromTeam
    if spentFromPlayer > 0 and playerID then
        setPlayerPool(playerID, playerPool - spentFromPlayer)
        fireCharge(playerID, teamID, spentFromPlayer)
    end
    if spentFromTeam > 0 then
        setTeamPool(teamID, teamPool - spentFromTeam)
        -- Tag the team→player subsidy as a 'move' (§1: player_fallback)
        Ledger.tagCharge(ledgerState, teamID, spentFromTeam, 'player_fallback')
    end
    -- Tag the full charge as a burn
    if totalCharged > 0 then
        Ledger.tagCharge(ledgerState, teamID, totalCharged, class)
    end
    return true
end

--- `cmdID` is used to classify the charge reason for ledger tagging.
function GG.Authority.ChargeOrder(unitID, unitTeam, playerID, cost, cmdID)
    return debitPools(unitTeam, playerID, cost, Classify.orderClass(cmdID or 0))
end

--- Σ authority_cost_base over an org group's current roster (mirrors the
--- client's cost-preview.ts/game-processor.ts `gpComputeGroupBaseCost`
--- exactly, incl. its "missing/unresolved → base 1" fallback) — the charge
--- basis for a group-scoped directive create. Reads the LIVE roster via
--- Spring.GetOrgGroups rather than trusting requestedStrength (a demand
--- target, not the actual committed membership).
local function groupMembers(teamID, groupID)
    local groups = Spring.GetOrgGroups(teamID)
    if not groups then return nil end
    for _, g in ipairs(groups) do
        if g.id == groupID then return g.members end
    end
    return nil
end

local function sumGroupBaseCost(teamID, groupID)
    local members = groupMembers(teamID, groupID)
    if not members then return 0 end
    local sum = 0
    for _, unitID in ipairs(members) do
        local udid = Spring.GetUnitDefID(unitID)
        local ud = udid and UnitDefs[udid]
        local base = 1
        if ud and ud.customParams and ud.customParams.authority_cost_base then
            base = tonumber(ud.customParams.authority_cost_base) or 1
        end
        sum = sum + base
    end
    return sum
end

--- PLAN-metalstorm-objectives.md §5 "last_commander notes" (review A7): the
--- directive-create charge stamps `last_commander` onto every member of the
--- group it just charged for. Without it, army-directive play — the INTENDED
--- default — attributes nothing: the decomposed per-squad commands are
--- `fromLua` and free, so `game_authority_charge.lua`'s AllowCommand hook (the
--- only other stamp site) never sees them, and objectives/attribution.lua gets
--- an empty participation map. §5 records this as resolved 2026-07-12; it was
--- decided and not built. Measured live on the player path 2026-08-04: a
--- committed directive charged 2 authority, moved the squad, and left every
--- unit unstamped, so `score_<player>_objectives` could only ever read 0
--- (endtoend D11's third symptom).
---
--- Stamped only on a charge that was ACCEPTED — a refused directive moves
--- nothing, so crediting its author would be attribution for work not done.
---
--- GROUP-SCOPED ONLY, and that is the design, not a gap (objectives §5.1,
--- endtoend D24). A group-scoped directive's cost basis is Σ
--- authority_cost_base over the WHOLE roster, so crediting the whole roster at
--- charge time is crediting exactly what was paid for. A condition/area-scoped
--- directive (groupID 0) has no roster to stamp and pays only a flat
--- administrative fee for a standing intent, so its author is attached per
--- unit at DECOMPOSITION instead — the engine hands the author to
--- GiveCommand and game_authority_charge.lua's AllowCommand hook stamps
--- there. Hence the groupID == 0 early return below: not a missing case, the
--- other case.
local function stampCommander(teamID, groupID, playerID)
    if not playerID or not groupID or groupID == 0 then return end
    for _, unitID in ipairs(groupMembers(teamID, groupID) or {}) do
        Spring.SetUnitRulesParam(unitID, 'last_commander', playerID)
    end
end

--- Charge for creating a macro directive (PLAN-metalstorm-authority.md
--- §3.2/§3.3, A2; PLAN-macro-directives.md §1 "Charge point"). This is the
--- directive-CREATE charge site — distinct from AllowCommand's per-order
--- charge, and charged exactly once (never on Update or on the decomposed
--- per-squad commands, which are fromLua and free by §3.2's table). Called
--- from game_authority_charge.lua's AllowDirectiveCreate, itself hooked to
--- the new engine callin fired by rts/Server/ClientMessageHandler.cpp's
--- GroupDirective-create path.
---
--- Group-scoped (groupID ~= 0): cost basis is Σ authority_cost_base over
--- the org group's CURRENT roster, under the 'directive' order class.
---
--- Condition/area-scoped (groupID == 0 — the "classic standing order" shape
--- sent over the unified GroupDirective wire, macro-directives.md §1):
--- there is no fixed roster at create time (draws from whichever
--- unassigned squads match later, as they idle), so this charges a flat
--- administrative fee (base=1) under the 'standing' class instead of
--- scaling with committed strength.
---
--- SCOPED SIMPLIFICATION (AGENTS.md "never deviate from Recoil silently" —
--- called out explicitly, not silent): regionMod is pinned to 1.0. A
--- per-unit order's regionMod reads the ISSUING UNIT's position
--- (GG.Regions.CostModifierAt(unitID)); a directive has no single
--- position — a group's roster can span regions, and an area-scoped
--- directive's shape (point/circle/polyline) isn't threaded through this
--- callin today. The client cost-preview (cost-preview.ts) makes the exact
--- same simplification for the exact same reason (its own doc comment:
--- "no client-side region-index load wired in this pass") — so server
--- charge and client preview stay in lockstep, which is the actual
--- requirement here; both can gain a real regionMod together later (e.g.
--- from the directive's shape anchor).
function GG.Authority.ChargeDirective(playerID, teamID, groupID, directiveType, requestedStrength)
    local base, class
    if groupID and groupID ~= 0 then
        base = sumGroupBaseCost(teamID, groupID)
        class = 'directive'
    else
        base = 1
        class = 'standing'
    end
    local classMod = CostSpec.order_class[class] or 1.0
    local cost = Formula.cost(CostSpec.base_k, base, 1.0, classMod, costScale)
    -- Return the cost as a second value (existing callers ignore it) so the
    -- charge gate can surface an AI directive's real spend in the intent report.
    local ok = debitPools(teamID, playerID, cost, class)
    if ok then stampCommander(teamID, groupID, playerID) end
    return ok, cost
end

--- Charge for creating a classic (non-directive-wire) standing order
--- (PLAN-metalstorm-authority.md §3.2/A2). Flat administrative fee under
--- the 'standing' class — see GG.Authority.ChargeDirective's condition/
--- area-scoped branch above for why (no fixed roster at create time).
--- Kept as a distinct entry point (rather than routing through
--- ChargeDirective) because the legacy StandingOrderCreate wire message
--- has no groupID/requestedStrength fields to normalise into that call.
---
--- Deliberately does not stamp `last_commander`: like a condition-scoped
--- directive it has no roster at create time, so its author is attached per
--- unit at decomposition (objectives §5.1) — see stampCommander above.
function GG.Authority.ChargeStandingOrder(playerID, teamID, orderType)
    local classMod = CostSpec.order_class.standing or 1.0
    local cost = Formula.cost(CostSpec.base_k, 1, 1.0, classMod, costScale)
    return debitPools(teamID, playerID, cost, 'standing')
end

-- ============================================================
-- Lifecycle
-- ============================================================

function gadget:Initialize()
    -- Read modoptions here too (not just GameStart): Initialize always runs
    -- (cold start + gadget reload), covering test scenes that skip GameStart
    -- — the §6 "authority_cost_scale=0 ... must not even require pools to
    -- exist" guarantee shouldn't depend on GameStart having fired.
    local mo    = Spring.GetModOptions()
    costScale   = tonumber(mo.authority_cost_scale) or 1.0
    joinGrant   = tonumber(mo.authority_join_grant) or 100
    teamStipend = tonumber(mo.authority_team_stipend) or 0

    -- E1 load-time assert (§5): ceiling must be ≥ 2× the priciest single decision
    local econ  = CostSpec.economy
    if econ and econ.soft_ceiling_C_base then
        -- The priciest order = build (orderMod 3.0) × largest unit base × enemy region (regionMod 2.0)
        -- Conservatively estimate largest unit base as ~500 (scale-4 units; real values from defs)
        local maxOrderCost = CostSpec.base_k * 500 * 2.0 * (CostSpec.order_class.build or 3.0) * costScale
        if econ.soft_ceiling_C_base < 2 * maxOrderCost then
            Spring.Log('authority', LOG.ERROR, string.format(
                "E1 ceiling assert FAILED: C_base %d < 2×maxOrderCost %d. "
                .. "A team saving for a scale-4 build will hit the ceiling. Increase C_base.",
                econ.soft_ceiling_C_base, 2 * maxOrderCost
            ))
        end
    end
end

function gadget:GameStart()
    local mo    = Spring.GetModOptions()
    costScale   = tonumber(mo.authority_cost_scale) or 1.0
    joinGrant   = tonumber(mo.authority_join_grant) or 100
    teamStipend = tonumber(mo.authority_team_stipend) or 0

    local gaia  = Spring.GetGaiaTeamID()
    for _, teamID in ipairs(Spring.GetTeamList()) do
        if teamID ~= gaia then
            setTeamPool(teamID, STARTING_TEAM_AUTHORITY)
        end
    end
    for _, playerID in ipairs(Spring.GetPlayerList()) do
        gadget:PlayerAdded(playerID)
    end
end

function gadget:GameFrame(frame)
    -- Stipend distribution (§2)
    -- The gate is stepped unconditionally: short-circuiting it on `teamStipend`
    -- would leave `last` at 0 for a war with no stipend, so enabling one later
    -- (a GM knob, a reload) would bank every period since frame 0 as one lump.
    local stipendPeriods = Tick.count(stipendGate, frame)
    if stipendPeriods > 0 and teamStipend > 0 then
        -- One award per elapsed period, so ten minutes of sim always pays ten
        -- minutes of stipend however badly the machine fell behind. Paid as a
        -- single ledger entry per team: the ledger records what was awarded,
        -- and N identical rows would misreport the cadence as well as spam it.
        local owed = teamStipend * stipendPeriods
        local gaia = Spring.GetGaiaTeamID()
        for _, teamID in ipairs(Spring.GetTeamList()) do
            if teamID ~= gaia then
                setTeamPool(teamID, getTeamPool(teamID) + owed)
                Ledger.tagAward(ledgerState, teamID, owed, 'stipend')
            end
        end
    end

    -- Metrics update (§2): velocity EMA and dead-team time, computed every frame
    local gaia = Spring.GetGaiaTeamID()
    for _, teamID in ipairs(Spring.GetTeamList()) do
        if teamID ~= gaia then
            -- Velocity: compute ledger deltas since last frame
            local curr = Ledger.counters(ledgerState, teamID)
            local prev = prevLedger[teamID] or { mint = 0, burn = 0, move = 0, unmapped = 0 }
            local mintDelta = curr.mint - prev.mint
            local burnDelta = curr.burn - prev.burn
            Metrics.updateVelocity(metricsState, teamID, mintDelta, burnDelta)
            prevLedger[teamID] = curr

            -- Dead-team time: record if team can't afford the cheapest order
            local teamPool = getTeamPool(teamID)
            local totalPools = teamPool
            for _, playerID in ipairs(Spring.GetPlayerList(teamID)) do
                totalPools = totalPools + getPlayerPool(playerID)
            end
            -- Cheapest order = smallest posture cost (orderMod 0.25 × base_k × smallest unit base)
            -- For now, use a conservative estimate (10) — task 3 will pin the real constants
            local cheapestCost = 10
            Metrics.recordDeadFrame(metricsState, teamID, totalPools, cheapestCost)
        end
    end

    -- Overflow decay (§3.1, Lever 1): pools above ceiling decay toward it
    local econ = CostSpec.economy
    if econ and econ.soft_ceiling_C_base and econ.overflow_decay_period then
        local decayPeriods = Tick.count(decayGate, frame, econ.overflow_decay_period)
        if decayPeriods > 0 then
            -- Compounded over the elapsed periods: skipping the decay would
            -- hand a hoarding team free headroom for being on a busy server.
            local decayFactor = (1 - (econ.overflow_decay_pct / 100)) ^ decayPeriods
            for _, teamID in ipairs(Spring.GetTeamList()) do
                if teamID ~= gaia then
                    -- Player pools: decay to team pool first (§3.1: "use it or share it")
                    for _, playerID in ipairs(Spring.GetPlayerList(teamID)) do
                        local pool = getPlayerPool(playerID)
                        local ceiling = econ.soft_ceiling_C_base
                        if pool > ceiling then
                            local excess = pool - ceiling
                            local decayed = ceiling + excess * decayFactor
                            local overflowed = excess - (excess * decayFactor)
                            setPlayerPool(playerID, decayed)
                            setTeamPool(teamID, getTeamPool(teamID) + overflowed)
                        end
                    end
                    -- Team pool: decay to nothing (§3.1)
                    local playerCount = #Spring.GetPlayerList(teamID)
                    local teamCeiling = econ.soft_ceiling_C_base * math.max(1, playerCount)
                    local teamPool = getTeamPool(teamID)
                    if teamPool > teamCeiling then
                        local excess = teamPool - teamCeiling
                        local decayed = teamCeiling + excess * decayFactor
                        setTeamPool(teamID, decayed)
                    end
                end
            end
        end
    end

    -- Ledger publish (§1): every LEDGER_PUBLISH_PERIOD_FRAMES, publish all
    -- counters as teamRulesParam econ_<class> (30 s cadence, same as the
    -- planned scoreboard refresh)
    if Tick.due(ledgerPublishGate, frame) then
        Ledger.publish(ledgerState)
    end
end

-- Drop-in players / re-join guard (§6, coordinated with
-- PLAN-metalstorm-teams.md task 2): grant JOIN_GRANT exactly once per
-- playerID identity, fresh (minted, NOT taken from the team pool — taking
-- it from the team pool would punish teams for receiving help). Reconnects
-- of a known player fire the same PlayerAdded callin with the same
-- playerID — authority_granted_<id> is what distinguishes "fresh join"
-- from "reconnect" (there is no separate engine signal).
function gadget:PlayerAdded(playerID)
    -- Integer-normalised key (AI3 bugfix, see pkey): PlayerAdded receives
    -- playerID from GetPlayerList (a Lua float), so the raw '..' would key the
    -- guard by 'authority_granted_0.0' while any int-keyed lookup misses it.
    local key = 'authority_granted_' .. math.floor(playerID)
    if Spring.GetGameRulesParam(key) then return end
    Spring.SetGameRulesParam(key, 1)
    local teamID = playerTeam(playerID)
    setPlayerPool(playerID, getPlayerPool(playerID) + joinGrant)
    emitEvent('award', joinGrant, 'join_grant', playerID, teamID)
    Ledger.tagAward(ledgerState, teamID, joinGrant, 'join_grant')
end

--- Rejoin restore (PLAN-metalstorm-lobby.md §2.5, task 4). The server calls
--- this when a player comes back to a persistent war inside the brief-absence
--- window, with the pool it captured on the frame before they left.
---
--- TOP-UP, NOT A DEPOSIT, and that is the entire design. Two things make the
--- obvious `pool = pool + amount` wrong, and they pull in the same direction:
---
---  * PlayerRemoved below is supposed to merge a departing player's pool into
---    the TEAM pool, so the saved authority is in the team's hands and may
---    already be spent — adding it back would MINT a second copy.
---  * And in the live build that merge does not actually run (verified
---    2026-08-11: after a real disconnect the ledger shows no `leaver_merge`
---    and the player's pool is untouched — the synced PlayerRemoved callin is
---    not reaching gadgets, which is also why a mid-war joiner never gets a
---    join grant; filed against task 5, whose whole subject is that hook).
---    So a reconnecting player frequently still HOLDS the pool being restored,
---    and a deposit would double it once per reload.
---
--- Restoring to a REMEMBERED LEVEL is right under both: it makes up the
--- shortfall and nothing more, so it is idempotent, un-farmable, and a no-op
--- when the sim never lost the pool in the first place. It is also conserving
--- — the shortfall comes out of the team pool and only as far as the team can
--- fund it, which is the honest answer when the team spent it: a player who
--- left with 400 and returns to a team that burned it through gets what is
--- left, not a refund the war cannot afford.
function GG.Authority.RestorePool(playerID, amount)
    if not playerID or not amount or amount <= 0 then return 0 end
    local teamID = playerTeam(playerID)
    if not teamID then return 0 end
    local shortfall = amount - getPlayerPool(playerID)
    if shortfall <= 0 then return 0 end
    local moved = math.min(shortfall, getTeamPool(teamID))
    if moved <= 0 then return 0 end
    setTeamPool(teamID, getTeamPool(teamID) - moved)
    setPlayerPool(playerID, getPlayerPool(playerID) + moved)
    -- A 'move' in ledger terms (pool-to-pool, net zero — §1), the exact
    -- inverse of the leaver_merge PlayerRemoved records — and tagged ONCE,
    -- like that one: tagCharge IS tagAward (ledger.lua), so tagging both ways
    -- would double-count the class rather than balance it.
    Ledger.tagCharge(ledgerState, teamID, moved, 'rejoin_restore')
    emitEvent('award', moved, 'rejoin_restore', playerID, teamID)
    return moved
end

--- The other half of §2.5: past the brief window the saved pool is stale, and
--- "rejoin re-grants a small onboarding stipend rather than restoring a stale
--- pool". Minted, like the join grant it reuses the size of — a returning
--- player must be able to give an order rather than waiting for the next team
--- payout, and taking it from the team pool would punish the side for having
--- someone come back.
---
--- Deliberately NOT guarded by `authority_granted_<id>`: that guard exists so
--- the once-per-identity JOIN grant cannot be farmed by reconnecting, and this
--- is the opposite case — a player who has been away long enough to lose their
--- pool. Two other things stop it being farmable, and both are needed:
--- the server only calls it past the absence window (measured against the
--- binding's own `last_seen_at`), and it is a TOP-UP like RestorePool above —
--- it mints only the shortfall to `joinGrant`, so a player who still holds a
--- pool gets nothing. Without that second guard, the live build's missing
--- leaver merge (see RestorePool) would have made a reconnect every five
--- minutes an income stream.
function GG.Authority.GrantRejoinStipend(playerID)
    if not playerID then return 0 end
    local teamID = playerTeam(playerID)
    if not teamID then return 0 end
    local minted = joinGrant - getPlayerPool(playerID)
    if minted <= 0 then return 0 end
    setPlayerPool(playerID, getPlayerPool(playerID) + minted)
    emitEvent('award', minted, 'rejoin_stipend', playerID, teamID)
    Ledger.tagAward(ledgerState, teamID, minted, 'rejoin_stipend')
    return minted
end

-- Departing players (§6, every leave reason incl. timeouts — no pool
-- banking through disconnects): pool merges into the team pool, zeroed on
-- the player. Live stakes are untouched here — they stay in escrow and
-- resolve at objective completion/expiry (SettleEscrow routes a departed
-- staker's refund team-ward via the live-active check at settle time, not
-- at leave time).
function gadget:PlayerRemoved(playerID, reason)
    local teamID = playerTeam(playerID)
    if teamID then
        local pool = getPlayerPool(playerID)
        if pool > 0 then
            setTeamPool(teamID, getTeamPool(teamID) + pool)
            -- Leaver merge is a 'move' (pool-to-pool, net zero — §1)
            Ledger.tagCharge(ledgerState, teamID, pool, 'leaver_merge')
        end
        setPlayerPool(playerID, 0)
    end
end
