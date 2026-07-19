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

--- Settle (clear) an objective's escrow. outcome = 'complete' | 'expired' | 'failed'.
---   'complete': the caller already folded EscrowTotal into the reward
---     payout (GG.Objectives via GG.Authority.Award) — just clear the
---     ledger, no further transfer. Returns {}.
---   'expired' | 'failed': returns refund instructions
---     `{ {player=playerID, amount=n} | {team=teamID, amount=n}, ... }` —
---     one entry per staker, routed to their player pool if `isPlayerActive`
---     says they're still around, else to their (recorded) team pool.
--- @tparam function isPlayerActive(playerID) -> bool
function M.settle(state, objectiveID, outcome, isPlayerActive)
    local e = state[objectiveID]
    state[objectiveID] = nil
    if not e or outcome == 'complete' then return {} end

    local refunds = {}
    for playerID, entry in pairs(e.byPlayer) do
        if entry.amount > 0 then
            if isPlayerActive and isPlayerActive(playerID) then
                refunds[#refunds + 1] = { player = playerID, amount = entry.amount }
            else
                refunds[#refunds + 1] = { team = entry.team, amount = entry.amount }
            end
        end
    end
    return refunds
end

return M
