-- profiles/npc_raider.lua — an environment-scale raider NPC (§5, §5.1 NPC col).
--
-- Deploys as npc: scripted slate subset (raid / defend home region / toll a
-- route), no EXPAND/BUILD, LOD by player proximity (dormant when far), a small
-- scenario stipend rather than objective income. The raider "personality" is
-- the greedy planner biting off nearby weak targets — emergent, not scripted
-- micro.

return {
    id   = 'npc_raider',
    role = 'npc',

    aggression    = 1.3,   -- opportunistic aggression toward weak neighbours
    confidence    = 1.1,
    pSuccessFloor = 0.0,
    opportunism   = 0.5,   -- indifferent to the team bounty economy
    doctrine      = 'raider',

    -- A scenario can attach a fixed slate here (installed onto the role at
    -- boot). Shape: function(picture, out) that appends scripted goals —
    -- e.g. raid the nearest civilian district, toll the transit spine.
    -- Left nil in the skeleton; scenarios provide it (PLAN-metalstorm.md §3).
    scriptedSlate = nil,
}
