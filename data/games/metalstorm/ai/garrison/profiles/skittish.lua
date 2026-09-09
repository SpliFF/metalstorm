-- profiles/skittish.lua — a nervous garrison: withdraws at parity, stays
-- withdrawn longer, never scouts, ignores objectives. For "the militia
-- melts away" scenario beats.
return {
    id = 'skittish',
    withdrawRatio      = 1.0,
    neverWithdraw      = false,
    withdrawHoldFrames = 3600,
    screenMinIdle      = 99,      -- effectively never
    objectiveMinReward = 1e9,     -- effectively never
    reserveFraction    = 0.5,
    teamFallback       = false,
    lodFloor = 0, lodCeil = 3,
}
