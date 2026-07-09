-- profiles/caretaker.lua — the co-commander / caretaker steward (§5.1).
--
-- Deploys as co_commander: delegation-first scoring, own-pool-only charging,
-- touches only idle force, obeys the (binding) guidance store. When all
-- humans leave it silently upgrades to the full-side slate (role
-- caretakerUpgrade); when one rejoins, back to etiquette. Conservative by
-- design — a steward should not gamble the team's savings.

return {
    id   = 'caretaker',
    role = 'co_commander',

    aggression    = 0.9,   -- slightly defensive; holds what the humans built
    confidence    = 1.0,
    pSuccessFloor = 0.10,  -- extra caution: won't throw idle force into bad odds
    opportunism   = 1.5,   -- leans into teammate bounties (delegation-first)
    doctrine      = 'balanced',
}
