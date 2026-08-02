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

    -- The scripted slate itself is the `npc` ROLE's (roles.lua binds
    -- scripted.lua's builders); a scenario drives it with data — home region,
    -- raid targets, tolled route — published as team rulesParams by
    -- game_scenario.lua's `ai` section. See scenarios/meridian_basin.lua's
    -- Basin Reavers for a shipped example.
    --
    -- A profile MAY still override with its own function(picture, out, role,
    -- profile) -> bool if a faction needs behaviour no scenario data can
    -- express; main.lua installs it onto the role at boot. Nil = use the role's.
    scriptedSlate = nil,
}
