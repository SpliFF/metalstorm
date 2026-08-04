-- tests/authority_charge_mock.lua — minimal Spring/GG/VFS mock so
-- game_authority_charge_spec.lua can load and drive the REAL
-- game_authority.lua + game_authority_charge.lua gadget pair end-to-end
-- (PLAN-metalstorm-authority.md §3.2/A2 directive/standing-order create
-- charge sites). Same deliberate exception as tests/spring_mock.lua
-- (game_teams.lua) and objectives/tests/spring_mock.lua: the thing under
-- test IS the callin wiring across the two gadget files (Charge* dispatch,
-- pool debit, refusal), not a pure formula — narrowly built for this file
-- pair, not a shared framework.

local M = {}

--- Build a fresh mock world + load fresh game_authority.lua +
--- game_authority_charge.lua instances against it, sharing one `gadget`
--- table exactly as the real gadget handler shares one `GG` namespace
--- across gadget files. Every spec gets its own instance (globals are
--- process-wide in plain Lua).
function M.new()
    local world = {
        teamRulesParams = {},   -- teamID -> key -> value
        gameRulesParams = {},   -- key -> value
        modOptions = {},
        unitDefs = {},          -- unitDefID -> { customParams = {...} }
        unitDefIdByUnit = {},   -- unitID -> unitDefID
        orgGroups = {},         -- teamID -> { {id=.., members={...}}, ... }
        players = {},           -- playerID -> teamID
        unitRulesParams = {},   -- unitID -> key -> value
    }

    function world.trp(teamID, key)
        local t = world.teamRulesParams[teamID]
        return t and t[key]
    end

    --- objectives §5's `last_commander` attribution stamp.
    function world.urp(unitID, key)
        local u = world.unitRulesParams[unitID]
        return u and u[key]
    end

    --- Register a player's team so playerTeam()/getPlayerPool() (which read
    --- it via Spring.GetPlayerInfo) can resolve it.
    function world.setPlayer(playerID, teamID)
        world.players[playerID] = teamID
    end

    --- Seed a unit's authority_cost_base via a fake unitDefID (auto-assigned).
    function world.setUnit(unitID, baseCost)
        local defID = unitID + 100000  -- arbitrary, unique, never collides with unitID
        world.unitDefIdByUnit[unitID] = defID
        world.unitDefs[defID] = { customParams = { authority_cost_base = baseCost } }
    end

    --- Register an org group's current roster for a team.
    function world.setOrgGroup(teamID, groupID, memberUnitIDs)
        world.orgGroups[teamID] = world.orgGroups[teamID] or {}
        table.insert(world.orgGroups[teamID], { id = groupID, members = memberUnitIDs })
    end

    -- ---- Spring mock ----
    _G.Spring = {
        GetModOptions = function() return world.modOptions end,
        GetGaiaTeamID = function() return 999 end,
        GetTeamList = function() return {} end,          -- GameStart not exercised here
        GetPlayerList = function() return {} end,
        GetPlayerInfo = function(playerID, _)
            local teamID = world.players[playerID]
            if not teamID then return nil end
            return 'player' .. playerID, true, false, teamID
        end,
        SetTeamRulesParam = function(teamID, key, value, _los)
            world.teamRulesParams[teamID] = world.teamRulesParams[teamID] or {}
            world.teamRulesParams[teamID][key] = value
        end,
        GetTeamRulesParam = function(teamID, key)
            local t = world.teamRulesParams[teamID]
            return t and t[key]
        end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        GetUnitDefID = function(unitID) return world.unitDefIdByUnit[unitID] end,
        GetOrgGroups = function(teamID) return world.orgGroups[teamID] or {} end,
        SetUnitRulesParam = function(unitID, key, value)
            world.unitRulesParams[unitID] = world.unitRulesParams[unitID] or {}
            world.unitRulesParams[unitID][key] = value
        end,
        GetUnitRulesParam = function(unitID, key) return world.urp(unitID, key) end,
        Log = function() end,
    }
    _G.UnitDefs = world.unitDefs
    _G.LOG = { ERROR = 'ERROR', WARNING = 'WARNING' }

    _G.VFS = {
        Include = function(path)
            -- cwd during `busted tests/` is LuaRules/Gadgets/ (this file's
            -- own header instructions) — map the VFS-rooted path onto that.
            local rel = path:gsub('^LuaRules/', '')
            rel = rel:gsub('^Gadgets/', './')
            if not rel:match('^%./') then rel = '../' .. rel end
            return dofile(rel)
        end,
    }

    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    _G.GG = {}

    dofile('./game_authority.lua')
    dofile('./game_authority_charge.lua')

    return world, _G.gadget
end

return M
