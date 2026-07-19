-- game_start.lua — initial team spawn. STUB default force (PLAN-metalstorm.md
-- §12); yields to a scenario when the room manifest names one.
--
-- TEAM model: one Spring team per side; all of a side's players share it
-- (PLAN-metalstorm.md §2). Spawns one command nexus + a small mixed force.
--
-- Scenario handoff (PLAN-persistence.md §5): a direct-start manifest's
-- "scenario" field reaches Lua as the modoption `scenario`. When set,
-- game_scenario.lua (layer -90, runs first) stages the whole world instead —
-- this gadget's default force would double-spawn on top of it, so it no-ops.

function gadget:GetInfo()
    return {
        name    = "Start Spawn",
        desc    = "Spawns the team start: command nexus + starter force",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = 0,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local START_FORCE = {
    { def = 'ms_command_nexus',  dx = 0,    dz = 0    },
    { def = 'ms_engineers_s2',   dx = 260,  dz = 0    },
    { def = 'ms_soldiers_s1',    dx = -260, dz = 0    },
    { def = 'ms_soldiers_s2',    dx = 0,    dz = 280  },
    { def = 'ms_tanks_s2',       dx = 0,    dz = -300 },
    { def = 'ms_radar_s1',       dx = 180,  dz = 180  },
}

function gadget:GameStart()
    local scenario = Spring.GetModOptions().scenario
    if scenario ~= nil and scenario ~= '' then
        return  -- game_scenario.lua stages the world instead
    end

    local gaia = Spring.GetGaiaTeamID()
    for _, teamID in ipairs(Spring.GetTeamList()) do
        if teamID ~= gaia then
            local x, _, z = Spring.GetTeamStartPosition(teamID)
            if x and x > 0 then
                for _, e in ipairs(START_FORCE) do
                    Spring.CreateUnit(e.def, x + e.dx, 0, z + e.dz, 'south', teamID)
                end
            end
        end
    end
end
