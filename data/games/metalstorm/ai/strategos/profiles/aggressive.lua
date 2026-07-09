-- profiles/aggressive.lua — pushes hard, tolerates worse odds (§3.4).
-- Same brain as default; only the weights differ. Reads as a personality,
-- not a difficulty cheat — it still pays authority and lives in the fog.

return {
    id   = 'aggressive',
    role = 'full_side',

    aggression    = 1.6,   -- values enemy ground far above its raw region value
    confidence    = 1.25,  -- optimistic about attacks into the unknown
    pSuccessFloor = 0.0,   -- no extra caution — will commit on thinner margins
    opportunism   = 1.2,   -- grabs bounties eagerly
    doctrine      = 'armor',
}
