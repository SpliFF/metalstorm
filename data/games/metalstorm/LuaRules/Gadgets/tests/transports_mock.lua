-- tests/transports_mock.lua — minimal Spring/GG/gadgetHandler mock so
-- game_transports_spec.lua can load and drive the real game_transports.lua
-- gadget file end-to-end. Same deliberate exception as game_teams_spec.lua's
-- spring_mock.lua and train_mock.lua (see those headers for why gadget-level
-- mocking earns its cost): game_transports.lua IS the callin sequencing —
-- validate at GameStart, spawn at eta, unload at the drop zone, depart at the
-- zone, publish at GameOver — with no pure-module split to exercise instead.
-- Narrowly scoped to this gadget's Spring surface, not a shared framework.
--
-- The unit defs below are the REAL shipped values (units/fable_airship.lua,
-- units/transports.lua, units/_builder.lua's ms_scale) rather than in-range
-- placeholders, for the same reason train_mock.lua uses real footprints: the
-- §7.7 slot arithmetic is only an honest guard if the numbers it divides are
-- the ones the game ships.

local M = {}

-- Def ids. Carriers first, then cargo at each scale tier.
M.AIRSHIP      = 2001   -- fable_airship:   capacity 2, is_transport
M.LANDING_SHIP = 2002   -- ms_landing_ship: capacity 4, is_transport
M.TROOP_CAR    = 2003   -- fable_train_troop: capacity 4, is_transport
M.SOLDIERS_S1  = 2010   -- ms_scale 1
M.TANK_S2      = 2011   -- ms_scale 2
M.MECH_S3      = 2012   -- ms_scale 3
M.BUNKER       = 2013   -- speed 0: a building, never "committed force"

M.NAME = {
    [M.AIRSHIP]      = 'fable_airship',
    [M.LANDING_SHIP] = 'ms_landing_ship',
    [M.TROOP_CAR]    = 'fable_train_troop',
    [M.SOLDIERS_S1]  = 'ms_soldiers_s1',
    [M.TANK_S2]      = 'ms_tank_s2',
    [M.MECH_S3]      = 'ms_mech_s3',
    [M.BUNKER]       = 'ms_staticdefense_s2',
}

M.MAP_X, M.MAP_Z = 16384, 16384

local function buildUnitDefs()
    local defs = {}
    local function def(id, opts)
        defs[id] = {
            id = id, name = M.NAME[id],
            speed = opts.speed or 0,
            transportCapacity = opts.capacity or 0,
            customParams = opts.cp or {},
        }
    end
    def(M.AIRSHIP, { speed = 60, capacity = 2,
                     cp = { is_transport = '1', transport_links = 'link1,link2' } })
    def(M.LANDING_SHIP, { speed = 60, capacity = 4,
                          cp = { is_transport = '1', transport_links = 'link1,link2,link3,link4' } })
    def(M.TROOP_CAR, { speed = 54, capacity = 4, cp = { is_transport = '1' } })
    def(M.SOLDIERS_S1, { speed = 40, cp = { ms_scale = '1' } })
    def(M.TANK_S2, { speed = 50, cp = { ms_scale = '2' } })
    def(M.MECH_S3, { speed = 45, cp = { ms_scale = '3' } })
    def(M.BUNKER, { speed = 0, cp = { ms_scale = '2' } })
    return defs
end

--- Build a fresh mock world + load a fresh game_transports.lua instance
--- against it. Every spec gets its own instance (globals are process-wide in
--- plain Lua, so tests must not share state across `it` blocks).
function M.new(scenario)
    local world = {
        frame = 0,
        units = {},                 -- unitID -> { defID, team, x, z, vx, vz, dead }
        transporting = {},          -- transportID -> { cargoID... }
        transporterOf = {},         -- cargoID -> transportID
        teams = { [0] = { leader = 0 }, [1] = { leader = 1 } },
        gaiaTeam = 99,
        orders = {},                -- recorded GiveOrderToUnit calls
        attaches = {},              -- recorded UnitAttach calls
        destroyed = {},             -- recorded DestroyUnit calls
        echoes = {},
        gameRulesParams = {},
        teamRulesParams = {},
        nextUnitID = 100,
        createFails = {},           -- defName -> true: make CreateUnit return nil
    }

    function world.rp(key) return world.gameRulesParams[key] end
    function world.trp(team, key)
        local t = world.teamRulesParams[team]
        return t and t[key]
    end

    function world.setTeam(teamID, leader)
        world.teams[teamID] = { leader = leader }
    end

    --- Put a unit on the board directly (the staged force game_scenario would
    --- have created before this gadget's GameStart runs).
    function world.spawn(defID, team, x, z)
        local id = world.nextUnitID
        world.nextUnitID = id + 1
        world.units[id] = { defID = defID, team = team, x = x or 0, z = z or 0,
                            vx = 0, vz = 0 }
        return id
    end

    function world.kill(id, gadgetObj)
        local u = world.units[id]
        if not u then return end
        world.units[id] = nil
        if gadgetObj and gadgetObj.UnitDestroyed then
            gadgetObj:UnitDestroyed(id, u.defID, u.team)
        end
    end

    function world.moveTo(id, x, z)
        local u = world.units[id]
        if u then u.x, u.z = x, z end
    end

    --- Load `cargoID` onto `transportID` the way a player LOAD order would.
    function world.load(transportID, cargoID)
        local list = world.transporting[transportID] or {}
        list[#list + 1] = cargoID
        world.transporting[transportID] = list
        world.transporterOf[cargoID] = transportID
    end

    --- Advance to `frame`, driving gadget:GameFrame for every frame in between
    --- (the gadget's own tick gate decides what actually runs).
    function world.run(gadgetObj, toFrame)
        for f = world.frame + 1, toFrame do
            world.frame = f
            gadgetObj:GameFrame(f)
        end
    end

    function world.ordersFor(unitID)
        local out = {}
        for _, o in ipairs(world.orders) do
            if o.unitID == unitID then out[#out + 1] = o end
        end
        return out
    end

    function world.echoed(needle)
        for _, msg in ipairs(world.echoes) do
            if msg:find(needle, 1, true) then return true end
        end
        return false
    end

    -- ---- globals the gadget reads ----
    _G.UnitDefs = buildUnitDefs()
    _G.Game = { mapSizeX = M.MAP_X, mapSizeZ = M.MAP_Z }
    -- Real engine values (rts/Sim/Units/CommandAI/Command.h), pinned on the
    -- client side by client/src/core/command-constants.test.ts. Spelled out
    -- here rather than defaulted, because UNLOAD_UNITS/UNLOAD_UNIT being
    -- swapped is exactly the bug T0 fixed and this mock must not re-hide it.
    _G.CMD = { STOP = 0, MOVE = 10, PATROL = 15, FIGHT = 16, ATTACK = 20,
               GUARD = 25, LOAD_UNITS = 75, LOAD_ONTO = 76,
               UNLOAD_UNITS = 80, UNLOAD_UNIT = 81 }

    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        GetGaiaTeamID = function() return world.gaiaTeam end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
        GetGroundHeight = function() return 0 end,

        GetTeamList = function()
            local out = {}
            for teamID in pairs(world.teams) do out[#out + 1] = teamID end
            table.sort(out)
            return out
        end,
        GetTeamInfo = function(teamID)
            local t = world.teams[teamID]
            -- Mirrors the engine: leader is -1 for a materialised-but-empty
            -- filler team, >= 0 for one with a player or an AI.
            return 'team' .. tostring(teamID), t and t.leader or -1
        end,
        GetTeamUnits = function(teamID)
            local out = {}
            for id, u in pairs(world.units) do
                if u.team == teamID then out[#out + 1] = id end
            end
            table.sort(out)
            return out
        end,

        GetUnitDefID = function(id)
            local u = world.units[id]
            return u and u.defID or nil
        end,
        GetUnitTeam = function(id)
            local u = world.units[id]
            return u and u.team or nil
        end,
        GetUnitPosition = function(id)
            local u = world.units[id]
            if not u then return nil end
            return u.x, 0, u.z
        end,
        GetUnitVelocity = function(id)
            local u = world.units[id]
            if not u then return nil end
            return u.vx, 0, u.vz
        end,
        GetUnitIsTransporting = function(id)
            -- A FRESH table, as the real binding builds: a gadget that
            -- destroys passengers while walking this list must not have the
            -- list mutate underneath it.
            local out = {}
            for i, cid in ipairs(world.transporting[id] or {}) do out[i] = cid end
            return out
        end,
        GetUnitTransporter = function(id) return world.transporterOf[id] end,
        GetUnitPieceMap = function(id)
            local u = world.units[id]
            if not u then return {} end
            local defs = _G.UnitDefs[u.defID]
            local links = defs and defs.customParams.transport_links
            if not links then return {} end
            local map, n = {}, 0
            for name in links:gmatch('[^,%s]+') do
                n = n + 1
                map[name] = n
            end
            return map
        end,
        GetUnitsInCylinder = function(x, z, radius, allegiance)
            local out = {}
            for id, u in pairs(world.units) do
                if allegiance == nil or u.team == allegiance then
                    local dx, dz = u.x - x, u.z - z
                    if dx * dx + dz * dz <= radius * radius then out[#out + 1] = id end
                end
            end
            table.sort(out)
            return out
        end,

        CreateUnit = function(defName, x, _y, z, _facing, team)
            if world.createFails[defName] then return nil end
            local defID
            for id, name in pairs(M.NAME) do
                if name == defName then defID = id end
            end
            if not defID then return nil end
            return world.spawn(defID, team, x, z)
        end,
        DestroyUnit = function(id, selfd, reclaimed)
            world.destroyed[#world.destroyed + 1] =
                { unitID = id, selfd = selfd, reclaimed = reclaimed }
            local t = world.transporterOf[id]
            if t and world.transporting[t] then
                for i, cid in ipairs(world.transporting[t]) do
                    if cid == id then table.remove(world.transporting[t], i) break end
                end
            end
            world.transporterOf[id] = nil
            for _, cid in ipairs(world.transporting[id] or {}) do
                world.transporterOf[cid] = nil
            end
            world.transporting[id] = nil
            world.units[id] = nil
        end,
        UnitAttach = function(transportID, cargoID, piece)
            world.attaches[#world.attaches + 1] =
                { transportID = transportID, cargoID = cargoID, piece = piece }
            world.load(transportID, cargoID)
        end,
        UnitDetach = function(cargoID)
            local t = world.transporterOf[cargoID]
            if t and world.transporting[t] then
                for i, cid in ipairs(world.transporting[t]) do
                    if cid == cargoID then table.remove(world.transporting[t], i) break end
                end
            end
            world.transporterOf[cargoID] = nil
        end,
        GiveOrderToUnit = function(unitID, cmdID, params, opts)
            world.orders[#world.orders + 1] =
                { unitID = unitID, cmdID = cmdID, params = params, opts = opts }
        end,

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
    }

    -- game_transports.lua pulls the shared skip-safe tick gate (D15) through
    -- the real gadget loader's VFS, so the mock has to answer that call. Same
    -- mapping the other gadget mocks use: busted's cwd is LuaRules/Gadgets/.
    _G.VFS = {
        Include = function(path)
            return dofile('./' .. path:gsub('^LuaRules/Gadgets/', ''))
        end,
    }

    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    -- game_scenario.lua (layer -90) has already run by the time this gadget's
    -- GameStart fires; GG.Scenario.data is what it publishes.
    _G.GG = { Scenario = { name = 'spec', data = scenario or {} } }

    -- game_transports.lua lives directly in Gadgets/ (no subfolder nesting),
    -- and busted runs with cwd = the invocation directory (Gadgets/, per the
    -- game_teams_spec.lua convention), so the path is './game_transports.lua'.
    dofile('./game_transports.lua')
    -- It returns nothing when synced; it attaches methods to the global
    -- `gadget` table and to GG.Transports (the real gadget-loader contract
    -- plus §3.3's programmatic seam).
    return world, _G.gadget, _G.GG
end

return M
