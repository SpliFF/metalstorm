-- profiles/mentor.lua — the mentor co-commander (PLAN-metalstorm-onboarding.md §3).
--
-- A co-commander profile that SUGGESTS instead of acts: it runs the full
-- picture→slate→planner loop but its actuators post suggestions (chat cards
-- / suggested objectives / marker pings) rather than spending authority on
-- real orders. New players see what a good commander WOULD do and stay in
-- control. Same profile-shape as default.lua (pure data).

-- Peace-shaped proposal kinds. `pact` is not a kind game_parley.lua issues —
-- it is the umbrella word the tutorial director waits on (`wait kind = pact`)
-- and it turns up on the board of hand-written scenarios, so answer it the
-- same way rather than dropping it into "unrecognised kind → reject".
local PEACE = { ceasefire = true, safe_passage = true, pact = true }

return {
    id   = 'mentor',
    role = 'co_commander',

    -- Suggest-only: actuators emit advice, never charged commands
    -- (PLAN-metalstorm-onboarding §3; actuator gating in
    -- ai/strategos/actuators.lua).
    suggest_only = true,

    -- Conservative brain — advice should be safe, legible moves.
    aggression    = 0.8,
    -- 1.0, not 0.9: the no-intel prior is 0.65 × confidence and the floor is
    -- 0.6, so 0.9 put every move into unknown ground under the floor and the
    -- mentor could never suggest one (a pre-existing inertness, see review).
    confidence    = 1.0,
    pSuccessFloor = 0.6,
    opportunism   = 0.8,
    pressure      = 0.3,   -- will suggest a push when the odds are plainly good
    deny          = 0.0,
    garrisonFraction = 0.4,
    withdrawRatio = 0.6,
    doctrine      = 'balanced',

    -- Mentor pacing: at most one suggestion per this many seconds; don't
    -- flood a learner (tunable; onboarding §3).
    suggest_period_sec = 45,

    --- Proposal handler (see default.lua's). The mentor is a teacher, not a
    -- negotiator: it takes a ceasefire from anyone, whatever its own plan was
    -- about to do, so that a learner's Diplomacy Mission ends in the handshake
    -- the lesson is about instead of in a shrug. Every other kind falls
    -- through to the shared valuation — a mentor that accepted an arbitrary
    -- demand would be teaching the wrong lesson.
    evaluateProposal = function(p, _ctx)
        if PEACE[p.kind] then return 'accept' end
        return nil
    end,
}
