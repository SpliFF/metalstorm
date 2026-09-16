-- profiles/default.lua — the balanced brain (PLAN-metalstorm-ai.md §3.4).
--
-- A profile is ONE tunable table per AI instance: strategic weights + the
-- role it deploys as. Difficulty = profile + LOD tier + optional handicap
-- (a bigger JOIN_GRANT), NEVER fog or cost exemptions (plan §3.4/§5). These
-- are the levers playtests move; the file is pure data.
--
-- Every knob below has a measured behavioural consequence asserted in
-- tests/scenario_spec.lua ("profile differentiation") — a knob no spec can
-- tell apart from the default is a knob that does not exist.

-- Peace-shaped proposal kinds. `pact` is not a kind game_parley.lua issues —
-- it is the umbrella word the tutorial director waits on (`wait kind = pact`)
-- and it turns up on the board of hand-written scenarios, so answer it the
-- same way rather than dropping it into "unrecognised kind → reject".
local PEACE = { ceasefire = true, safe_passage = true, pact = true }

return {
    id   = 'default',
    role = 'full_side',

    -- Value multiplier on enemy-owned regions (want-it-more). 1.0 = neutral.
    aggression   = 1.0,
    -- pSuccess prior multiplier for attacks into the unknown (caution's twin).
    confidence   = 1.0,
    -- pSuccess floor for non-DEFEND goals (REPLACES Config.PSUCCESS_FLOOR).
    pSuccessFloor = 0.6,
    -- Bounty weight bias (opportunism): how hard staked bounties pull.
    opportunism  = 1.0,
    -- Implicit ATTACK weight on adjacent enemy-held ground (0 = never raise one).
    pressure     = 0.6,
    -- Worth of denying an enemy-only objective, as a fraction of its reward.
    deny         = 0.3,
    -- Share of the anchor region's package held back as a garrison.
    garrisonFraction = 0.25,
    -- own/enemy ratio below which the side withdraws to its departure zone.
    withdrawRatio = 0.5,
    -- Composition doctrine: biases the counters table in BUILD/composition gap.
    doctrine     = 'balanced',

    --- Proposal handler (Planner.evaluateProposals' profile hook, ai-eval).
    -- One opinion, and only one: a ceasefire with a side THIS tick's plan is
    -- about to hit is a ceasefire that throws away the attack we just paid to
    -- plan, so decline it — `ctx.attacking` is read off the plan's own
    -- ATTACK/DENY intent lines, which is the only honest way for a pure core
    -- to say "currently fighting with intent to attack".
    --
    -- Not pointed at them → return nil, and the shared valuation in
    -- planner.lua answers: it accepts an ordinary (neutral-trust) ceasefire
    -- and still declines the two cases the relative-strength gate exists for
    -- — we are clearly winning, or the counterparty is deeply distrusted. Overriding
    -- those with a blanket accept would undo "negotiate from strength"; this
    -- handler adds a reason to say no, it does not replace the reasons to.
    -- Every non-peace kind falls through untouched.
    evaluateProposal = function(p, ctx)
        if not PEACE[p.kind] then return nil end
        if ctx.attacking[p.fromTeam] then return 'reject' end
        return nil
    end,
}
