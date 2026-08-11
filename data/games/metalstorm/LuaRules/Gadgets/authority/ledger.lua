-- authority/ledger.lua — reason-tagged accumulation for long-horizon economy monitoring
-- (PLAN-metalstorm-economy.md §1/§2).
--
-- Every pool mutation flows through GG.Authority.Award or GG.Authority.ChargeOrder
-- with a `reason` (a string), which this module classifies into one of three
-- accounting classes:
--   mint: objective_reward | bounty_escrow_payout | join_grant | stipend | admin_grant
--   burn: order | directive | build | posture | proposal_fee
--   move: stake_escrow | leaver_merge | player_fallback
--
-- Accumulated per-team counters (published as teamRulesParam `econ_<class>` every
-- publish cadence) feed the gm-tools dashboard metrics (velocity, pool ratio, dead-team
-- time) and the headless validation grid — flows that matter over months, invisible in
-- moment-to-moment play.

local M = {}

-- Ledger class taxonomy (§1). Keys are reason strings passed to tag*(); values
-- are the accounting class that reason maps to. Reasons NOT in this table are
-- UNMAPPED and trigger a loud runtime warn (once per distinct unknown).
--
-- (The "reason" strings here are what Award/ChargeOrder actually send; the plan
-- text used *example* labels — the real contract is spelled here.)
local REASON_CLASS = {
    -- mint
    objective_reward = 'mint',
    stake_refund     = 'mint',   -- from SettleEscrow('expired'/'failed')
    join_grant       = 'mint',
    -- PLAN-metalstorm-lobby.md §2.5 (task 4): the grant a player gets on
    -- returning to a war after an absence long enough that their saved pool
    -- is stale. Minted like join_grant, and separate from it so the two are
    -- distinguishable in the ledger — a war full of rejoin_stipend and no
    -- join_grant is a war whose population is churning, not growing.
    rejoin_stipend   = 'mint',
    stipend          = 'mint',
    admin_grant      = 'mint',   -- GM compensation (PLAN-gm-tools.md)

    -- burn
    order            = 'burn',
    directive        = 'burn',
    build            = 'burn',
    posture          = 'burn',
    proposal_fee     = 'burn',
    standing         = 'burn',   -- GG.Authority.ChargeStandingOrder
    -- endtoend D43 census: this is the reason the ORDINARY per-unit order path
    -- actually emits, and it was unmapped. `GG.Authority.ChargeOrder` tags with
    -- `Classify.orderClass(cmdID)`, whose default branch returns 'micro' — not
    -- the 'order' spelled above. So every non-build, non-posture order charge in
    -- every match filed as unmapped: the single most frequent charge in the
    -- game. 'order' is kept because it is the documented name and the class is
    -- identical; see D62 for why the two spellings exist at all.
    micro            = 'burn',

    -- move (net-zero)
    stake_escrow     = 'move',
    leaver_merge     = 'move',
    -- The exact inverse of leaver_merge (task 4): authority moved back OUT of
    -- the team pool into a returning player's own. Net zero by construction —
    -- GG.Authority.RestorePool hands back at most what the team still holds
    -- and mints nothing.
    rejoin_restore   = 'move',
    player_fallback  = 'move',
    -- endtoend D43 census: game_parley.lua's tribute payout (three call sites —
    -- one-shot pre-escrowed, one-shot direct, and the recurring `active` tick).
    -- `move`, not `mint`, for the same reason as leaver_merge: the payee team
    -- gains authority that an existing pool lost, so nothing is created. Note
    -- the payer half of the same transaction does NOT currently balance it —
    -- it goes through ChargeOrder and files as 'micro'/burn (D62).
    tribute          = 'move',
    -- AI funding (PLAN-metalstorm-ai.md §5.2): a human's one-shot gift into a
    -- co-commander's own pool, and the standing per-minute allowance drawn from
    -- the team pool. Both are GG.Authority.Transfer — pool-to-pool, net zero,
    -- nothing minted — so both are `move`, NOT `mint`. `ai_funding` predates
    -- this table and was firing the unmapped warn on every funding attempt.
    ai_funding       = 'move',
    ai_allowance     = 'move',
}

-- endtoend D13. game_objectives.lua's distributeAward does NOT send
-- 'objective_reward' — it sends `'objective_' .. o.type` ('objective_control',
-- 'objective_escort', …) and `'objective_' .. o.type .. '_income'` for the
-- periodic infra payout. Every objective payout in every match therefore
-- landed in `unmapped` and fired the warn, which is why the terminal
-- objective's 300 authority looked like it had gone nowhere. Matched by
-- PREFIX rather than enumerated because the reason is built from the type
-- registry at the call site: adding an objective type must not silently add
-- an unmapped reason. Objective payouts are new authority → mint, same class
-- as the 'objective_reward' entry above (kept: it is the documented name and
-- other callers may still use it).
local REASON_PREFIX_CLASS = {
    { prefix = 'objective_', class = 'mint' },
}

-- One-time warn for unmapped reasons (§1 "loud runtime warn (once per distinct
-- unknown)") — so a misspelled reason fires visibly but doesn't spam.
local unmappedWarned = {}

--- Classify a reason string → accounting class. Returns (class, unmapped_flag).
--- unmapped_flag is true if the reason wasn't in REASON_CLASS (caller should warn).
function M.classify(reason)
    local cls = REASON_CLASS[reason]
    if cls then return cls, false end
    if type(reason) == 'string' then
        for _, rule in ipairs(REASON_PREFIX_CLASS) do
            if reason:sub(1, #rule.prefix) == rule.prefix then
                return rule.class, false
            end
        end
    end
    if not unmappedWarned[reason] then
        unmappedWarned[reason] = true
        Spring.Log('authority', LOG.WARNING, string.format(
            "UNMAPPED ledger reason '%s' — classify() returned 'unmapped'. Add to authority/ledger.lua REASON_CLASS.",
            tostring(reason)
        ))
    end
    return 'unmapped', true
end

--- Create a new ledger state (per-team counters, keyed by teamID then class).
function M.newState()
    return {
        teams = {},   -- [teamID][class] = cumulative integer
    }
end

--- Tag an award: increment counters[teamID][class] by amount (integer only).
--- reason = the string passed to Award (e.g. 'objective_reward', 'join_grant').
function M.tagAward(state, teamID, amount, reason)
    if not teamID or amount <= 0 then return end
    local cls = M.classify(reason)
    local team = state.teams[teamID]
    if not team then
        team = {}
        state.teams[teamID] = team
    end
    team[cls] = (team[cls] or 0) + math.floor(amount)
end

--- Tag a charge: same as tagAward but the reason is typically 'order'/'directive'/etc.
function M.tagCharge(state, teamID, amount, reason)
    M.tagAward(state, teamID, amount, reason)
end

--- Get cumulative counters for a team (returns a table {mint=N, burn=M, move=K, unmapped=U}).
function M.counters(state, teamID)
    local team = state.teams[teamID] or {}
    return {
        mint     = team.mint     or 0,
        burn     = team.burn     or 0,
        move     = team.move     or 0,
        unmapped = team.unmapped or 0,
    }
end

--- Publish all teams' counters as teamRulesParam `econ_<class>` (allied-visible).
function M.publish(state)
    local ALLIED_LOS = { allied = true }
    for teamID, team in pairs(state.teams) do
        for cls, value in pairs(team) do
            Spring.SetTeamRulesParam(teamID, 'econ_' .. cls, value, ALLIED_LOS)
        end
    end
end

--- Export all teams' counters as a Lua table (for stats-dump/game_events hooks).
--- Returns { [teamID] = {mint=N, burn=M, move=K, unmapped=U}, ... }
function M.exportAll(state)
    local out = {}
    for teamID, _ in pairs(state.teams) do
        out[teamID] = M.counters(state, teamID)
    end
    return out
end

return M
