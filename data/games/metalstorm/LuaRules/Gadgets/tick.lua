-- tick.lua — frame-skip-safe periodic gates for synced gadgets (D15).
--
-- WHY THIS EXISTS
--
-- Every periodic gadget in this game was written as
--
--     if frame % PERIOD == 0 then ... end
--
-- and that gate is silently unsound on this engine. When the server logs
-- `sim fell behind, skipped N ticks`, `gadget:GameFrame` is *never called* for
-- the skipped frames — they do not arrive late, they do not arrive at all. A
-- modulo gate only fires on exact multiples, so a skip that steps over a
-- multiple drops that tick permanently. Measured (PLAN-endtoend.md D15): at 8x
-- sim speed a control objective accumulated **zero** hold progress over 40 000
-- frames, and fire 31's own diagnostic probe emitted 11 samples in a
-- 24 378-frame war because it stopped hitting `frame % 150 == 0` at f=1500.
-- Under normal speed on a contended machine that fire counted 3 688 skip
-- events in one war, so this is not a fast-forward-only concern.
--
-- The rule: **accrue against `frame - last >= period`, never `frame % period`.**
--
-- TWO POLICIES, AND WHICH ONE A CALLER WANTS
--
-- When k whole periods have elapsed since the last fire, there are two honest
-- answers, and the choice is a property of what the tick *does*:
--
--   * `due()` — collapse. Fire at most once per call. Correct for anything that
--     OBSERVES current state (evaluate objectives, sample region ownership,
--     publish a scoreboard, recompute HP): the world is only observable once,
--     and re-running the same observation k times would invent k samples out of
--     one. The observation happens on schedule in frame terms, which is all
--     D15 asks for.
--   * `count()` — accrue. Fire once per elapsed period. Correct for anything
--     that PAYS OUT a flat or multiplicative amount per period (an authority
--     stipend, an overflow decay, an AI allowance drip): the money was earned
--     by the passage of frames, not by anyone looking, so collapsing it would
--     let a team lose income to machine load — the exact asymmetry D57/D58 were
--     filed to remove from the hold clock.
--
-- The phase grid is preserved across a skip: `last` advances by whole periods,
-- never to the observed frame, so a gate that fired at 90/180/270 keeps firing
-- on multiples of 90 after a skip instead of drifting onto a new offset. With
-- no frames skipped, `due()` fires on exactly the same frames the old modulo
-- gate did — this is a behaviour-preserving change on an unloaded machine, and
-- that is deliberate: it means no existing cadence expectation moves.
--
-- KNOWN, DOCUMENTED CONSEQUENCE (not a defect this module can fix)
--
-- `due()` restores the tick, not the samples. A subsystem that counts *ticks*
-- to measure duration (`regions/ownership.lua`'s FLIP_TICKS / DECAY_TICKS,
-- game_objectives' per-tick participation weight) still advances by one per
-- restored tick, so under sustained overload those windows stretch in frame
-- terms rather than shrinking. That is the conservative direction — a sticky
-- owner keeps its region longer, a defender's clock reads short, never long —
-- and it is strictly better than today, where the tick does not happen at all.
-- Converting those counters to elapsed *frames* is a separate design change
-- with balance consequences; it is not smuggled in here.

local M = {}

--- A gate for one periodic job. `period` is in sim frames and may be nil when
--- the caller only learns it later (a modoption, a cost-spec field) — pass it
--- to due()/count() instead, which also lets a live config change take effect.
--- `last` starts at 0: frame 0 is not due, matching `frame % p == 0`'s only
--- disagreement being a frame the engine does not run gadget logic on anyway.
function M.new(period)
    return { period = period, last = 0 }
end

--- Whole periods elapsed since the last fire, banking them. Returns 0 when the
--- gate is not yet due. `period` overrides (and rebinds) the state's period.
function M.count(state, frame, period)
    local p = period or state.period
    if not p or p <= 0 then return 0 end
    state.period = p
    -- A rewind (gadget reload, a test reusing a state) must not bank a negative
    -- count or strand the gate in the future.
    if frame < state.last then state.last = frame end
    local elapsed = frame - state.last
    if elapsed < p then return 0 end
    local n = math.floor(elapsed / p)
    state.last = state.last + n * p     -- phase-preserving, see the header
    return n
end

--- True when at least one period has elapsed; collapses a multi-period skip to
--- a single fire. See the header for when this is the right policy.
function M.due(state, frame, period)
    return M.count(state, frame, period) > 0
end

-- SNAPSHOT (PLAN-persistence task 1d-b)
--
-- A gate's `last` is an absolute frame stamp, so it is authored state, not
-- derivable: `globals` restores gs->frameNum, and a gate left at the live
-- process's `last` is then either in the future (count()'s rewind clamp fires
-- and the gate re-phases onto the restored frame, silently moving a cadence
-- that D15 went to some trouble to keep on its grid) or far in the past (an
-- accrual gate banks every period between the two frames and pays a team an
-- hour of stipend it never earned). Both are wrong in a way nothing warns
-- about, which is why the six gadgets that hold gates all save theirs.
--
-- `period` is deliberately NOT saved: for the fixed-period gates it is a
-- constant in the gadget, and for the two that take it from a config
-- (authority's decay gate) the LIVE config must win — a snapshot restoring a
-- period from a since-edited cost spec would resurrect the old cadence with
-- nothing to say it had.

function M.save(state)
    return { last = state.last }
end

function M.load(state, saved)
    state.last = (type(saved) == 'table' and tonumber(saved.last)) or 0
end

return M
