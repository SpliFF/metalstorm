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
}
