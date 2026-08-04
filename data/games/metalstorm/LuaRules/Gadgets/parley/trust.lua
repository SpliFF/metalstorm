-- parley/trust.lua — trust ledger arithmetic (PLAN-metalstorm-interaction.md
-- §2 "Trust ledger"). Pure: ONE scalar per UNORDERED team pair (a
-- "diplomatic scoreboard" both sides read the same number from — not two
-- independent directional scores), decaying toward neutral (0) over time.
-- Plain math, no Spring/GG — game_parley.lua owns the trust_<a>_<b>
-- rulesParam and the periodic decay tick; this module is what busted drives
-- directly (§11 "trust arithmetic + decay").
local M = {}

M.NEUTRAL          = 0
M.FULFILLED_DELTA  = 1
M.BREACHED_DELTA   = -3
M.DECAY_PERIOD_FRAMES = 900   -- 30s — matches objectives' EVAL_PERIOD cadence
M.DECAY_FACTOR        = 0.95  -- multiplicative pull toward neutral each period

--- Canonical (lo, hi) team ordering so trust_<a>_<b> and trust_<b>_<a> never
--- both exist as separate params — one relationship, one number.
function M.orderedPair(a, b)
    if a <= b then return a, b end
    return b, a
end

function M.rulesParamKey(a, b)
    local lo, hi = M.orderedPair(a, b)
    return 'trust_' .. lo .. '_' .. hi
end

--- Apply a fulfilled/breached delta onto a current trust value.
function M.adjust(current, delta)
    return (current or M.NEUTRAL) + delta
end

--- Pull `current` a fraction of the way back toward NEUTRAL for each whole
--- DECAY_PERIOD_FRAMES elapsed since the last decay tick. `periods` is the
--- count of elapsed periods (caller does its own per-pair "last decayed"
--- frame bookkeeping); 0/nil periods is a no-op.
function M.decay(current, periods)
    local v = current or M.NEUTRAL
    if not periods or periods <= 0 then return v end
    local factor = M.DECAY_FACTOR ^ periods
    return M.NEUTRAL + (v - M.NEUTRAL) * factor
end

return M
