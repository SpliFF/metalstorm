-- authority/escrow.lua — staked-bounty escrow ledger (PLAN-metalstorm-authority.md
-- §2 "Staked bounties", §6 "Player leaves with staked bounty live").
--
-- Pure bookkeeping, no Spring/GG API: the caller (game_authority.lua) is
-- responsible for actually debiting a player's pool before calling `add`
-- (and for not calling it if the debit failed), and for applying the
-- refund instructions `settle` returns via Award. Escrow lives here (a
-- private table keyed by objectiveID), NOT as a rulesParam pool — it's
-- accounting, not spendable state anyone reads directly.

local M = {}

function M.newState()
    return {}   -- objectiveID -> { total = n, byPlayer = { [playerID] = {amount, team} } }
end

--- Stake `amount` from `playerID` (on team `teamID`, recorded so `settle`
--- can route an inactive staker's refund team-ward without a live Spring
--- lookup) onto `objectiveID`.
function M.add(state, objectiveID, playerID, teamID, amount)
    local e = state[objectiveID]
    if not e then
        e = { total = 0, byPlayer = {} }
        state[objectiveID] = e
    end
    e.total = e.total + amount
    local prev = e.byPlayer[playerID]
    e.byPlayer[playerID] = { amount = (prev and prev.amount or 0) + amount, team = teamID }
end

function M.total(state, objectiveID)
    local e = state[objectiveID]
    return e and e.total or 0
end

--- The war-end outcome (PLAN-metalstorm-wars.md §7 `resolving`, task 4). Kept
--- distinct from 'expired' because the two dispose differently, and the
--- difference is the review's §B escrow gap: an ordinary expiry hands a stake
--- back to the staker who is still sitting there to spend it, while at war end
--- there is nothing left to spend it on and §7 requires the stake to land in
--- the TEAM pool — "not to individuals — team-owns-everything". See
--- `M.refundsTeamward`.
M.WAR_END = 'war_end'

--- True when `outcome` routes every refund team-ward regardless of who is
--- still connected. One predicate rather than an `== 'war_end'` test repeated
--- at each site, so adding a second war-end-shaped outcome later cannot land
--- half of them.
function M.refundsTeamward(outcome)
    return outcome == M.WAR_END
end

--- Settle (clear) an objective's escrow.
--- outcome = 'complete' | 'expired' | 'failed' | 'war_end'.
---   'complete': the caller already folded EscrowTotal into the reward
---     payout (GG.Objectives via GG.Authority.Award) — just clear the
---     ledger, no further transfer. Returns {}.
---   'expired' | 'failed': returns refund instructions
---     `{ {player=playerID, amount=n} | {team=teamID, amount=n}, ... }` —
---     one entry per staker, routed to their player pool if `isPlayerActive`
---     says they're still around, else to their (recorded) team pool.
---   'war_end': every refund goes to the staker's recorded TEAM pool, whether
---     or not they are connected (wars §7). `isPlayerActive` is not consulted
---     at all, so a war-end settlement is a pure function of the ledger and
---     cannot depend on who happened to be logged in when the war ended.
---
--- **Deterministic order.** The refund list is sorted by playerID rather than
--- returned in `pairs` order. This is synced code and the caller adds each
--- refund into a pool one at a time, so `pairs`' unspecified traversal order
--- makes the pool's final value depend on hash layout — floating-point
--- addition is not associative, and two clients settling the same escrow could
--- land on values that differ in the last bit. It also fixes the order of the
--- `refund` events the client renders, which is the visible half of the same
--- problem.
--- @tparam function isPlayerActive(playerID) -> bool
function M.settle(state, objectiveID, outcome, isPlayerActive)
    local e = state[objectiveID]
    state[objectiveID] = nil
    if not e or outcome == 'complete' then return {} end

    local stakers = {}
    for playerID, entry in pairs(e.byPlayer) do
        if entry.amount > 0 then stakers[#stakers + 1] = playerID end
    end
    table.sort(stakers)

    local teamward = M.refundsTeamward(outcome)
    local refunds = {}
    for _, playerID in ipairs(stakers) do
        local entry = e.byPlayer[playerID]
        if not teamward and isPlayerActive and isPlayerActive(playerID) then
            refunds[#refunds + 1] = { player = playerID, amount = entry.amount }
        else
            refunds[#refunds + 1] = { team = entry.team, amount = entry.amount }
        end
    end
    return refunds
end

return M
