-- profiles/sentinel.lua — the default garrison: holds, braces, scouts a
-- little, takes a cheap objective next door, withdraws only when clearly
-- outmassed. Keys override garrison/brain.lua Brain.DEFAULTS; pure data.
return {
    id = 'sentinel',
    withdrawRatio      = 1.6,
    neverWithdraw      = false,
    withdrawHoldFrames = 1800,
    screenMinIdle      = 2,
    screenEveryFrames  = 900,
    objectiveMinReward = 50,
    objectiveMaxCost   = 4,
    reserveFraction    = 0.25,
    teamFallback       = false,
    lodFloor = 0, lodCeil = 3,
}
