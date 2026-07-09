-- profiles/default.lua — the balanced brain (PLAN-metalstorm-ai.md §3.4).
--
-- A profile is ONE tunable table per AI instance: strategic weights + the
-- role it deploys as. Difficulty = profile + LOD tier + optional handicap
-- (a bigger JOIN_GRANT), NEVER fog or cost exemptions (plan §3.4/§5). These
-- are the levers playtests move; the file is pure data.

return {
    id   = 'default',
    role = 'full_side',

    -- Value multiplier on enemy-owned regions (want-it-more). 1.0 = neutral.
    aggression   = 1.0,
    -- pSuccess prior multiplier for attacks into the unknown (caution's twin).
    confidence   = 1.0,
    -- Extra pSuccess floor above the global one (higher = more cautious).
    pSuccessFloor = 0.0,
    -- Bounty weight bias (opportunism): how hard staked bounties pull.
    opportunism  = 1.0,
    -- Composition doctrine: biases the counters table in BUILD/composition gap.
    doctrine     = 'balanced',
}
