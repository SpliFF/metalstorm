-- profiles/stalwart.lua — a garrison that never leaves: no withdrawal at any
-- ratio, scouts eagerly, takes any nearby objective it can afford, may draw
-- on the team pool. For a last-stand defender or an empty side's caretaker.
return {
    id = 'stalwart',
    neverWithdraw      = true,
    screenMinIdle      = 1,
    screenEveryFrames  = 600,
    objectiveMinReward = 1,
    objectiveMaxCost   = 8,
    reserveFraction    = 0.1,
    teamFallback       = true,
    lodFloor = 0, lodCeil = 2,
}
