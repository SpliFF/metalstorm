-- tests/spring_mock.lua — minimal Spring/GG/gadgetHandler/VFS mock so
-- registry_spec.lua can load and drive the real game_objectives.lua gadget
-- file end-to-end. This is a deliberate, documented exception to the
-- codebase's usual "pure modules only get busted tests" convention
-- (authority/regions have no gadget-level tests) — game_objectives.lua's
-- registry (activeList, resolve/award, bounty rollback, linked-pair mutual
-- resolve, phase chaining) is nontrivial orchestration with no equivalent
-- pure-module split (task 1 explicitly keeps it in the gadget), so a
-- from-scratch mock earns its cost here. Not a reusable framework — extend
-- narrowly if another gadget file ever needs the same treatment.

local M = {}

--- Build a fresh mock world + load a fresh game_objectives.lua instance
--- against it. Every spec gets its own instance (globals are process-wide in
--- plain Lua, so tests must not share state across `it` blocks).
function M.new()
    local world = {
        frame = 0,
        rulesParams = {},          -- key -> value (game-scoped; team/unit not modeled, not needed)
        unitRulesParams = {},      -- unitID -> key -> value
        units = {},                -- unitID -> { x, z, team, hp, maxHp, alive, defID }
        players = {},              -- playerID -> { team, active }
        teams = { 1, 2 },
        gaiaTeam = 99,
        modOptions = { authority_reward_scale = '1.0', objective_density = 'normal' },
        regionOwner = {},          -- regionKey -> team
        regionKeys = { 'r1', 'r2' },
        contested = {},            -- regionKey -> true
        regionValue = {},
        orders = {},               -- recorded Spring.GiveOrderToUnit calls
        awards = {},               -- recorded GG.Authority.Award calls
        escrowSettles = {},        -- recorded GG.Authority.SettleEscrow calls
        escrow = {},               -- objectiveID -> total staked
        stakeResult = true,        -- GG.Authority.Stake return value (test-controlled)
        stakes = {},               -- recorded GG.Authority.Stake calls
    }

    function world.setUnit(unitID, opts)
        world.units[unitID] = {
            x = opts.x or 0, z = opts.z or 0, team = opts.team,
            hp = opts.hp or 100, maxHp = opts.maxHp or 100,
            alive = opts.alive ~= false, defID = opts.defID,
        }
    end

    function world.kill(unitID)
        if world.units[unitID] then world.units[unitID].alive = false end
    end

    function world.setPlayer(playerID, team, active)
        world.players[playerID] = { team = team, active = active ~= false }
    end

    function world.setLastCommander(unitID, playerID)
        world.unitRulesParams[unitID] = world.unitRulesParams[unitID] or {}
        world.unitRulesParams[unitID].last_commander = playerID
    end

    function world.rp(id, field)
        return world.rulesParams['objective_' .. id .. '_' .. field]
    end

    -- ---- Spring mock ----
    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        SetGameRulesParam = function(key, value) world.rulesParams[key] = value end,
        GetGameRulesParam = function(key) return world.rulesParams[key] end,
        GetModOptions = function() return world.modOptions end,
        GetAllUnits = function()
            local out = {}
            for unitID, u in pairs(world.units) do
                if u.alive then out[#out + 1] = unitID end
            end
            table.sort(out)
            return out
        end,
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u or not u.alive then return nil end
            return u.x, 0, u.z
        end,
        GetUnitTeam = function(unitID)
            local u = world.units[unitID]
            return u and u.team
        end,
        GetUnitHealth = function(unitID)
            local u = world.units[unitID]
            if not u or not u.alive then return nil end
            return u.hp, u.maxHp
        end,
        ValidUnitID = function(unitID)
            local u = world.units[unitID]
            return u ~= nil and u.alive
        end,
        GetUnitTransporter = function() return nil end,
        GetUnitsInCylinder = function(x, z, r)
            local out = {}
            for unitID, u in pairs(world.units) do
                if u.alive then
                    local dx, dz = u.x - x, u.z - z
                    if dx * dx + dz * dz <= r * r then out[#out + 1] = unitID end
                end
            end
            table.sort(out)
            return out
        end,
        GetUnitRulesParam = function(unitID, key)
            local t = world.unitRulesParams[unitID]
            return t and t[key]
        end,
        SetUnitRulesParam = function(unitID, key, value)
            world.unitRulesParams[unitID] = world.unitRulesParams[unitID] or {}
            world.unitRulesParams[unitID][key] = value
        end,
        GetPlayerInfo = function(playerID, _)
            local p = world.players[playerID]
            if not p then return nil end
            return 'player' .. playerID, p.active, false, p.team
        end,
        GetTeamList = function() return world.teams end,
        GetGaiaTeamID = function() return world.gaiaTeam end,
        GetGroundHeight = function() return 0 end,
        GiveOrderToUnit = function(unitID, cmdID, params, options)
            world.orders[#world.orders + 1] = { unitID = unitID, cmdID = cmdID, params = params }
            return true
        end,
        GetUnitDefID = function(unitID)
            local u = world.units[unitID]
            return u and u.defID
        end,
        Echo = function() end,
    }

    _G.CMD = { MOVE = 1 }
    _G.UnitDefs = {}

    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    -- Resolve "LuaRules/Gadgets/objectives/X.lua" against the real files on
    -- disk (tests run with cwd = LuaRules/Gadgets/objectives). The gadget also
    -- pulls shared modules that live one level up (tick.lua, D15), so a
    -- Gadgets-rooted path resolves to the parent directory.
    _G.VFS = {
        Include = function(path)
            local rel = path:gsub('^LuaRules/Gadgets/objectives/', './')
            if rel == path then rel = path:gsub('^LuaRules/Gadgets/', '../') end
            return dofile(rel)
        end,
    }

    _G.GG = {
        Regions = {
            ControllingTeam = function(key) return world.regionOwner[key] end,
            KeyAt = function(x, z) return world.keyAt and world.keyAt(x, z) or nil end,
            Keys = function() return world.regionKeys end,
            GetContested = function()
                local out = {}
                for key in pairs(world.contested) do out[#out + 1] = key end
                table.sort(out)
                return out
            end,
            Value = function(key) return world.regionValue[key] or 0 end,
        },
        Authority = {
            Award = function(target, amount, reason)
                world.awards[#world.awards + 1] = { target = target, amount = amount, reason = reason }
            end,
            EscrowTotal = function(id) return world.escrow[id] or 0 end,
            SettleEscrow = function(id, outcome)
                world.escrowSettles[#world.escrowSettles + 1] = { id = id, outcome = outcome }
                world.escrow[id] = nil
            end,
            Stake = function(playerID, id, amount)
                world.stakes[#world.stakes + 1] = { playerID = playerID, id = id, amount = amount }
                if world.stakeResult then world.escrow[id] = (world.escrow[id] or 0) + amount end
                return world.stakeResult
            end,
        },
    }

    local gadgetChunk = dofile('../game_objectives.lua')
    -- game_objectives.lua returns nothing when synced; it attaches methods
    -- to the global `gadget` table instead (the real gadget-loader contract).
    return world, _G.gadget
end

return M
