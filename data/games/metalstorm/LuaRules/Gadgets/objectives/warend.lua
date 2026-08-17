-- objectives/warend.lua — how ONE unresolved objective disposes when the war
-- ends (PLAN-metalstorm-wars.md §7 `resolving`, task 4).
--
-- Pure: no Spring, no GG, no objective mutation. `game_objectives.lua`'s
-- `ExpireAllActive` walks the active list, asks each objective's own `check()`
-- for a final answer, and hands that answer here to find out what to do with
-- it. The walk is the impure half and stays there; the RULE is here, because
-- the rule is the whole of what §7 specifies and it is three branches that are
-- easy to get subtly wrong and impossible to see wrong in a log.
--
-- ── The two rules §7 states, and why the second is not the first ───────────
--
--   * **met-but-unpaid objectives settle normally.** The eval loop runs every
--     90 frames (3 s) and the wind-down grace is 300, so an objective whose
--     criteria are satisfied inside the last eval window has been *earned* and
--     never evaluated. Sweeping it as expired would refund the bounty that was
--     just won and pay nobody the reward — a final push landing two seconds
--     before the end would be silently unwound, which is the exact opposite of
--     what a grace period is for.
--   * **everything else expires, with its stakes routed to the STAKERS' TEAM
--     pools.** Not `failed` — the objectives were not lost, the war stopped —
--     and not the ordinary `expired` escrow rule either, which routes a stake
--     back to the staker personally when they happen to still be connected.
--     §7's rule is "never to individuals, never to the enemy", so a war-end
--     expiry carries its own escrow outcome (`authority/escrow.lua`'s
--     `WAR_END`) rather than reusing one whose answer depends on who had a
--     browser tab open at the final frame.
--
-- ── The third branch, which is neither ────────────────────────────────────
-- A module's `check()` may answer with a terminal state that is not
-- `complete`: a `protect` whose ward died answers `failed`. That is the
-- objective's own honest ending and it is recorded as such — overriding it
-- with `expired` would write the wrong history into the archive. Its escrow
-- still disposes war-end-ward, because the war is what stopped, not the
-- accounting rule.

local M = {}

--- Decide the disposition of one still-active objective at war end.
---
--- @param checkState   the first return of the objective module's `check()`,
---                     or nil when it is still unresolved / was not asked (a
---                     phase-chained parent has no predicate of its own, and a
---                     predicate that threw is deliberately treated the same
---                     as "no answer" — a content bug in one objective must not
---                     strand every other objective's escrow).
--- @param warEndOutcome the escrow outcome for a war-end expiry
---                     (`GG.Authority.ESCROW_WAR_END`). Passed in rather than
---                     required here so authority keeps sole ownership of the
---                     escrow vocabulary.
--- @return a table `{ state, escrowOutcome, paid }` where
---           `state`         is the state to resolve the objective into,
---           `escrowOutcome` is what to hand `SettleEscrow` (nil = use
---                           `state`, the ordinary path — completion folds the
---                           escrow into the reward),
---           `paid`          is true when this disposition pays a reward out,
---                           which is the number the war-end log line and the
---                           archive report separately from the write-offs.
function M.dispose(checkState, warEndOutcome)
    if checkState == 'complete' then
        -- The ordinary award path: reward + EscrowTotal, split by
        -- participation, OnComplete hooks. escrowOutcome stays nil so
        -- SettleEscrow gets 'complete' and merely clears the ledger — the
        -- stake has already been paid out as part of the reward, and routing
        -- it team-ward as well would pay it twice.
        return { state = 'complete', escrowOutcome = nil, paid = true }
    end
    if checkState then
        return { state = checkState, escrowOutcome = warEndOutcome, paid = false }
    end
    return { state = 'expired', escrowOutcome = warEndOutcome, paid = false }
end

--- Should this objective be asked for a final answer at all?
---
--- A phase-chained parent's resolution is driven entirely by its children's
--- cascade and it has no predicate of its own — the same asymmetry the eval
--- loop already has. Asking `check()` for one would run a type predicate the
--- ordinary loop never runs, so a parent could complete at war end by a route
--- that does not exist during play.
function M.shouldAsk(objective)
    return objective ~= nil and objective.phaseDefs == nil
end

return M
