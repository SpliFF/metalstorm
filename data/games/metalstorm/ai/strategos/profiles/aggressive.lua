-- profiles/aggressive.lua — pushes hard, tolerates worse odds (§3.4).
-- Same brain as default; only the weights differ. Reads as a personality,
-- not a difficulty cheat — it still pays authority and lives in the fog.
--
-- Measured differences vs default (tests/scenario_spec.lua): raises ATTACK on
-- enemy-held flank ground the default declines, keeps a thinner garrison, and
-- stays in a war the default has already left.

return {
    id   = 'aggressive',
    role = 'full_side',

    aggression    = 1.6,   -- values enemy ground far above its raw region value
    confidence    = 1.25,  -- optimistic about attacks into the unknown
    pSuccessFloor = 0.45,  -- commits on thinner margins than default's 0.6
    opportunism   = 1.2,   -- grabs bounties eagerly
    pressure      = 1.0,   -- always has an ATTACK on the menu
    deny          = 0.6,   -- raids the enemy's protect town for the denial alone
    garrisonFraction = 0.15,
    withdrawRatio = 0.3,   -- fights on at 2:1 against
    doctrine      = 'armor',
}
