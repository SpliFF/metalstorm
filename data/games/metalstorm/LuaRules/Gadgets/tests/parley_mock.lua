-- tests/parley_mock.lua — Spring/GG mock for game_parley.lua and
-- game_ai_guidance.lua gadget-level specs. Separate from spring_mock.lua
-- (that one is narrowly scoped to game_teams.lua's needs per its own
-- header) — parley/guidance need a materially different surface: unit
-- position/team/health queries, AllowCommand/UnitDamaged/ProjectileCreated/
-- ProjectileDestroyed callins, CMD constants, VFS.Include, and full
-- GG.Authority/GG.Objectives/GG.Regions mocks. Narrowly built for these two
-- files, not a shared framework.

local M = {}

--- Build a fresh mock world + load a fresh instance of ONE gadget file
--- against it (`gadgetFile`, relative to Gadgets/ — e.g. './game_parley.lua').
--- Every spec gets its own instance (globals are process-wide in plain
--- Lua); loading only one gadget file per world avoids two files' colon
--- methods colliding on the shared global `gadget` table.
function M.new(gadgetFile)
    local world = {
        frame = 0,
        players = {},            -- playerID -> { team }
        gameRulesParams = {},
        teamRulesParams = {},    -- teamID -> key -> value
        units = {},              -- unitID -> { team, x, y, z, health, defId }
        unitRegions = {},        -- unitID -> regionKey
        regionOwners = {},       -- regionKey -> teamID
        authorityPools = {},     -- teamID -> pool
        playerPools = {},        -- playerID -> pool
        chargeLog = {},
        awardLog = {},
        stakes = {},             -- id -> { total, entries = {{playerID, amount}} }
        objectives = {},         -- id -> { state, forTeam, forTeam2 }
        widenCalls = {},
        moveOrders = {},         -- recorded GiveOrderToUnit(MOVE) calls
    }

    function world.setPlayer(playerID, teamID) world.players[playerID] = { team = teamID } end
    function world.setUnit(unitID, teamID, x, z, health, defId)
        world.units[unitID] = { team = teamID, x = x, y = 0, z = z, health = health or 100, defId = defId }
    end
    function world.setRegionOwner(regionKey, teamID) world.regionOwners[regionKey] = teamID end
    function world.setUnitRegion(unitID, regionKey) world.unitRegions[unitID] = regionKey end
    function world.setTeamPool(teamID, v) world.authorityPools[teamID] = v end
    function world.setPlayerPool(playerID, v) world.playerPools[playerID] = v end
    function world.trp(teamID, key)
        local t = world.teamRulesParams[teamID]
        return t and t[key]
    end
    function world.rp(key) return world.gameRulesParams[key] end

    _G.CMD = { ATTACK = 20, MOVE = 10 }
    _G.UnitDefs = setmetatable({}, { __index = function() return nil end })

    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        GetModOptions = function() return {} end,
        GetPlayerInfo = function(playerID)
            local p = world.players[playerID]
            if not p then return nil end
            -- teamID as a FLOAT, mirroring the engine (same note as
            -- spring_mock.lua): a rulesParam key built as `'guidance_' .. teamID`
            -- from this value becomes 'guidance_10.0_', which no reader asks
            -- for. Returning an integer here is what let that ship.
            return 'player' .. playerID, true, false, p.team and (p.team + 0.0) or p.team
        end,
        GetGaiaTeamID = function() return 99 end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        SetTeamRulesParam = function(teamID, key, value)
            world.teamRulesParams[teamID] = world.teamRulesParams[teamID] or {}
            world.teamRulesParams[teamID][key] = value
        end,
        GetTeamRulesParam = function(teamID, key)
            local t = world.teamRulesParams[teamID]
            return t and t[key]
        end,
        ValidUnitID = function(unitID) return world.units[unitID] ~= nil end,
        GetUnitTeam = function(unitID) local u = world.units[unitID]; return u and u.team end,
        GetUnitDefID = function(unitID) local u = world.units[unitID]; return u and u.defId end,
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            return u.x, u.y, u.z
        end,
        GetUnitHealth = function(unitID) local u = world.units[unitID]; return u and u.health end,
        GetGroundHeight = function() return 0 end,
        GetTeamUnits = function(teamID)
            local out = {}
            for unitID, u in pairs(world.units) do
                if u.team == teamID then out[#out + 1] = unitID end
            end
            table.sort(out)
            return out
        end,
        GiveOrderToUnit = function(unitID, cmdID, params)
            world.moveOrders[#world.moveOrders + 1] = { unitID = unitID, cmdID = cmdID, params = params }
        end,
    }

    -- VFS.Include resolves from the plugin's real VFS root
    -- (LuaRules/Gadgets/...); busted's cwd here is LuaRules/Gadgets/ (this
    -- file's own header instructions), so strip the common prefix.
    _G.VFS = {
        Include = function(path)
            return dofile('./' .. path:gsub('^LuaRules/Gadgets/', ''))
        end,
    }

    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    _G.GG = {}

    _G.GG.Regions = {
        KeyAt = function(x, z)
            for unitID, u in pairs(world.units) do
                if u.x == x and u.z == z then return world.unitRegions[unitID] end
            end
            return nil
        end,
        ControllingTeam = function(key) return world.regionOwners[key] end,
    }

    _G.GG.Objectives = {
        Get = function(id) return world.objectives[id] end,
        WidenEligibility = function(id, teamID)
            world.widenCalls[#world.widenCalls + 1] = { id = id, teamID = teamID }
            local o = world.objectives[id]
            if o then o.forTeam2 = teamID end
            return true
        end,
    }

    _G.GG.Authority = {
        ChargeOrder = function(unitID, unitTeam, playerID, cost)
            if not cost or cost <= 0 then return true end
            world.chargeLog[#world.chargeLog + 1] = { unitTeam = unitTeam, playerID = playerID, cost = cost }
            local playerPool = playerID and (world.playerPools[playerID] or 0) or 0
            local teamPool = world.authorityPools[unitTeam] or 0
            if playerPool >= cost then
                if playerID then world.playerPools[playerID] = playerPool - cost end
                return true
            end
            local remaining = cost - playerPool
            if teamPool >= remaining then
                if playerID then world.playerPools[playerID] = 0 end
                world.authorityPools[unitTeam] = teamPool - remaining
                return true
            end
            return false
        end,
        Award = function(target, amount, reason)
            world.awardLog[#world.awardLog + 1] = { target = target, amount = amount, reason = reason }
            if target.team then
                world.authorityPools[target.team] = (world.authorityPools[target.team] or 0) + amount
            elseif target.player then
                world.playerPools[target.player] = (world.playerPools[target.player] or 0) + amount
            end
        end,
        Stake = function(playerID, id, amount)
            local pool = world.playerPools[playerID] or 0
            if pool < amount then return false end
            world.playerPools[playerID] = pool - amount
            world.stakes[id] = world.stakes[id] or { total = 0, entries = {} }
            world.stakes[id].total = world.stakes[id].total + amount
            local entries = world.stakes[id].entries
            entries[#entries + 1] = { playerID = playerID, amount = amount }
            return true
        end,
        EscrowTotal = function(id)
            local e = world.stakes[id]
            return e and e.total or 0
        end,
        SettleEscrow = function(id, outcome)
            local e = world.stakes[id]
            world.stakes[id] = nil
            if not e or outcome == 'complete' then return end
            for _, entry in ipairs(e.entries) do
                world.playerPools[entry.playerID] = (world.playerPools[entry.playerID] or 0) + entry.amount
            end
        end,
    }

    local gadgetChunk = dofile('./' .. gadgetFile)
    return world, _G.gadget
end

return M
