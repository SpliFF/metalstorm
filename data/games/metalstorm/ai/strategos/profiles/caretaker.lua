-- profiles/caretaker.lua — the co-commander / caretaker steward (§5.1).
--
-- Deploys as co_commander: delegation-first scoring, own-pool-only charging,
-- touches only idle force, obeys the (binding) guidance store. When all
-- humans leave it silently upgrades to the full-side slate (role
-- caretakerUpgrade); when one rejoins, back to etiquette. Conservative by
-- design — a steward should not gamble the team's savings.
--
-- Measured differences vs default (tests/scenario_spec.lua): never raises an
-- ATTACK of its own, keeps the thickest garrison, leaves a losing war first.

return {
    id   = 'caretaker',
    role = 'co_commander',

    aggression    = 0.9,   -- slightly defensive; holds what the humans built
    confidence    = 1.0,
    -- Same floor as default: the no-intel prior is 0.65 × confidence, so a
    -- floor above it would freeze a steward out of every unknown region
    -- (measured: the bounty/suggested delegation specs stopped firing at 0.7).
    -- Its caution lives in pressure/deny/garrison/withdraw below instead.
    pSuccessFloor = 0.6,
    opportunism   = 1.5,   -- leans into teammate bounties (delegation-first)
    pressure      = 0.0,   -- pushes only where the board or the humans say
    deny          = 0.0,
    garrisonFraction = 0.4,
    withdrawRatio = 0.6,
    doctrine      = 'balanced',
}
