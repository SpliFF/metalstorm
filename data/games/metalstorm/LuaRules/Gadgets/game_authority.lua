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
        layer   = -100,            -- before objectives/regions/teams
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Formula   = VFS.Include("LuaRules/Gadgets/authority/formula.lua")
local Attribute = VFS.Include("LuaRules/Gadgets/authority/attribute.lua")
local Classify  = VFS.Include("LuaRules/Gadgets/authority/classify.lua")
local Escrow    = VFS.Include("LuaRules/Gadgets/authority/escrow.lua")
local CostSpec  = VFS.Include("LuaRules/Configs/authority_cost.lua")

local STARTING_TEAM_AUTHORITY = 500
local EVENT_RING_SIZE = 8
local STIPEND_PERIOD_FRAMES = 1800     -- 1 minute at GAME_SPEED 30

local costScale  = 1.0
local joinGrant  = 100
local teamStipend = 0

GG.Authority = GG.Authority or {}

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
local function setPlayerPool(playerID, v)
    local teamID = playerTeam(playerID)
    if not teamID then return end
    Spring.SetTeamRulesParam(teamID, 'authority_player_' .. playerID, v, ALLIED_LOS)
end
local function getPlayerPool(playerID)
    local teamID = playerTeam(playerID)
    if not teamID then return 0 end
    return Spring.GetTeamRulesParam(teamID, 'authority_player_' .. playerID) or 0
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
function GG.Authority.Award(target, amount, reason)
    if amount == nil or amount <= 0 then return end

    if target.player then
        setPlayerPool(target.player, getPlayerPool(target.player) + amount)
        emitEvent('award', amount, reason, target.player, playerTeam(target.player))
        return
    end

    if target.team then
        setTeamPool(target.team, getTeamPool(target.team) + amount)
        emitEvent('award', amount, reason, nil, target.team)
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
                setPlayerPool(playerID, getPlayerPool(playerID) + share)
                emitEvent('award', share, reason, playerID, playerTeam(playerID))
            end
        end
        local teamShare = amount * (spec.teamWeight or 0) / totalWeight
        if teamShare > 0 then
            setTeamPool(spec.team, getTeamPool(spec.team) + teamShare)
            emitEvent('award', teamShare, reason, nil, spec.team)
        end
    end
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
    setPlayerPool(playerID, pool - amount)
    Escrow.add(escrowState, objectiveID, playerID, playerTeam(playerID), amount)
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
            setPlayerPool(r.player, getPlayerPool(r.player) + r.amount)
            emitEvent('refund', r.amount, 'stake_' .. outcome, r.player, playerTeam(r.player))
        elseif r.team then
            setTeamPool(r.team, getTeamPool(r.team) + r.amount)
            emitEvent('refund', r.amount, 'stake_' .. outcome, nil, r.team)
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
--- `playerID`'s pool first, then `unitTeam`'s pool for the remainder.
--- Refuses (no debit at all) if neither combination covers `cost`, and
--- records a 'refusal' event so the player sees why. The ONLY writer of
--- pool state during normal play — game_authority_charge.lua (+100) is the
--- sole caller, after every other gadget's AllowCommand veto has run.
function GG.Authority.ChargeOrder(unitID, unitTeam, playerID, cost)
    if cost <= 0 then return true end
    local playerPool = playerID and getPlayerPool(playerID) or 0
    local teamPool = getTeamPool(unitTeam)
    local allowed, spentFromPlayer, spentFromTeam = Attribute.attribute(playerPool, teamPool, cost)
    if not allowed then
        emitEvent('refusal', cost, 'insufficient_authority', playerID, unitTeam)
        return false
    end
    if spentFromPlayer > 0 and playerID then
        setPlayerPool(playerID, playerPool - spentFromPlayer)
    end
    if spentFromTeam > 0 then
        setTeamPool(unitTeam, teamPool - spentFromTeam)
    end
    return true
end

-- ============================================================
-- Lifecycle
-- ============================================================

function gadget:Initialize()
    -- Read modoptions here too (not just GameStart): Initialize always runs
    -- (cold start + gadget reload), covering test scenes that skip GameStart
    -- — the §6 "authority_cost_scale=0 ... must not even require pools to
    -- exist" guarantee shouldn't depend on GameStart having fired.
    local mo = Spring.GetModOptions()
    costScale   = tonumber(mo.authority_cost_scale) or 1.0
    joinGrant   = tonumber(mo.authority_join_grant) or 100
    teamStipend = tonumber(mo.authority_team_stipend) or 0
end

function gadget:GameStart()
    local mo = Spring.GetModOptions()
    costScale   = tonumber(mo.authority_cost_scale) or 1.0
    joinGrant   = tonumber(mo.authority_join_grant) or 100
    teamStipend = tonumber(mo.authority_team_stipend) or 0

    local gaia = Spring.GetGaiaTeamID()
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
    if teamStipend <= 0 then return end
    if frame % STIPEND_PERIOD_FRAMES ~= 0 then return end
    local gaia = Spring.GetGaiaTeamID()
    for _, teamID in ipairs(Spring.GetTeamList()) do
        if teamID ~= gaia then
            setTeamPool(teamID, getTeamPool(teamID) + teamStipend)
        end
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
    local key = 'authority_granted_' .. playerID
    if Spring.GetGameRulesParam(key) then return end
    Spring.SetGameRulesParam(key, 1)
    setPlayerPool(playerID, getPlayerPool(playerID) + joinGrant)
    emitEvent('award', joinGrant, 'join_grant', playerID, playerTeam(playerID))
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
        end
        setPlayerPool(playerID, 0)
    end
end
