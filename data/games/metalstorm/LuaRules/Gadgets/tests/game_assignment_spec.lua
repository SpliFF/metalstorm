-- tests/game_assignment_spec.lua — responsibility + rank precedence
-- (PLAN-beta-journey.md §(c)). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
--
-- The whole gadget is one AllowCommand decision plus the bookkeeping that
-- feeds it, so the cases below are about who may ISSUE an order — never about
-- who owns a unit, which nothing here can change.

package.path = './?.lua;' .. package.path

local function noop() end

--- A synced world with game_assignment.lua loaded against it.
local function newWorld()
    local world = {
        frame = 0,
        players = {},            -- playerID -> { team, spectator }
        units = {},              -- unitID -> { team, x, z }
        gameRulesParams = {},
        teamRulesParams = {},
        lowestParticipationByTeam = {},
    }

    function world.setPlayer(playerID, teamID, rank, opts)
        opts = opts or {}
        world.players[playerID] = { team = teamID, spectator = opts.spectator == true }
        if rank ~= nil then world.gameRulesParams['rank_' .. playerID] = rank end
        if opts.mentor ~= nil then world.gameRulesParams['mentor_' .. playerID] = opts.mentor end
    end

    function world.setUnit(unitID, teamID, x, z)
        world.units[unitID] = { team = teamID, x = x or 0, z = z or 0 }
    end

    function world.trp(teamID, key)
        local t = world.teamRulesParams[teamID]
        return t and t[key]
    end

    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        SetTeamRulesParam = function(teamID, key, value)
            world.teamRulesParams[teamID] = world.teamRulesParams[teamID] or {}
            world.teamRulesParams[teamID][key] = value
        end,
        GetTeamRulesParam = function(teamID, key) return world.trp(teamID, key) end,
        -- FLOAT team/player ids, as the engine hands them back (see
        -- spring_mock.lua's note) — an un-floored key build fails here first.
        GetPlayerInfo = function(playerID)
            local p = world.players[playerID]
            if not p then return nil end
            return 'player' .. playerID, true, p.spectator, p.team and (p.team + 0.0) or nil
        end,
        GetTeamUnits = function(teamID)
            local out = {}
            for unitID, u in pairs(world.units) do
                if u.team == teamID then out[#out + 1] = unitID end
            end
            table.sort(out)
            return out
        end,
        GetUnitTeam = function(unitID)
            local u = world.units[unitID]
            return u and u.team
        end,
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            return u.x, 0, u.z
        end,
        ValidUnitID = function(unitID) return world.units[unitID] ~= nil end,
        Echo = noop,
    }
    _G.VFS = {
        Include = function(path) return dofile('./' .. path:gsub('^LuaRules/Gadgets/', '')) end,
    }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    _G.GG = {
        Objectives = {
            LowestParticipationTactical = function(teamID)
                return world.lowestParticipationByTeam[teamID]
            end,
        },
    }

    dofile('./game_assignment.lua')
    return world, _G.gadget
end

--- The AllowCommand argument list, with only the fields this gadget reads.
local function order(g, unitID, unitTeam, playerID)
    return g:AllowCommand(unitID, 1, unitTeam, 10, {}, {}, 0, playerID, false, false)
end

describe("rank precedence (§(c))", function()
    it("refuses a tier-0 player's order on a tier-2 player's assigned unit", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 2)   -- Veteran, responsible
        world.setPlayer(2, 7, 0)   -- Recruit
        world.setUnit(100, 7)
        GG.Assignment.Set(100, 1)

        assert.is_false(order(g, 100, 7, 2))
        assert.is_nil(world.trp(7, 'assign_100_by'))
    end)

    it("allows a tier-2 player's order on a tier-0 player's unit and publishes _by", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 0)   -- Recruit, responsible
        world.setPlayer(2, 7, 2)   -- Veteran
        world.setUnit(100, 7)
        GG.Assignment.Set(100, 1)

        assert.is_true(order(g, 100, 7, 2))
        assert.are.equal(2, world.trp(7, 'assign_100_by'))
        assert.are.equal(1, world.trp(7, 'assign_100'))   -- responsibility unchanged
    end)

    it("clears the superior's mark when the responsible player next orders", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 0)
        world.setPlayer(2, 7, 2)
        world.setUnit(100, 7)
        GG.Assignment.Set(100, 1)
        order(g, 100, 7, 2)
        assert.are.equal(2, world.trp(7, 'assign_100_by'))

        assert.is_true(order(g, 100, 7, 1))
        assert.is_nil(world.trp(7, 'assign_100_by'))
    end)

    it("lets a mentee's mentor through regardless of rank", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 1, { mentor = 2 })   -- mentee
        world.setPlayer(2, 7, 1)                   -- mentor, SAME rank
        world.setUnit(100, 7)
        GG.Assignment.Set(100, 1)

        assert.is_true(order(g, 100, 7, 2))
        assert.are.equal(2, world.trp(7, 'assign_100_by'))
    end)

    it("leaves an equal-rank teammate unmarked", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 1)
        world.setPlayer(2, 7, 1)
        world.setUnit(100, 7)
        GG.Assignment.Set(100, 1)

        assert.is_true(order(g, 100, 7, 2))
        assert.is_nil(world.trp(7, 'assign_100_by'))
    end)

    it("caps a Recruit who holds assignments to their own squads", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 0)
        world.setUnit(100, 7)
        world.setUnit(101, 7)   -- unassigned team squad
        GG.Assignment.Set(100, 1)

        assert.is_true(order(g, 100, 7, 1))
        assert.is_false(order(g, 101, 7, 1))
    end)

    it("is inert with no rank params published (dev launch / old lobby)", function()
        local world, g = newWorld()
        world.setPlayer(1, 7)   -- no rank_ param
        world.setPlayer(2, 7)
        world.setUnit(100, 7)

        assert.are.equal(0, GG.Assignment.CarveForRecruit(1))
        assert.is_true(order(g, 100, 7, 2))
    end)
end)

describe("carve for a Recruit (§(c))", function()
    local function teamOfSix(world)
        for i = 1, 6 do world.setUnit(100 + i, 7, i * 100, 0) end
    end

    it("assigns the 2 unassigned squads nearest the lowest-participation objective", function()
        local world = newWorld()
        world.setPlayer(1, 7, 0)
        teamOfSix(world)
        world.lowestParticipationByTeam[7] = 42
        world.gameRulesParams.objective_42_x = 600
        world.gameRulesParams.objective_42_z = 0

        assert.are.equal(2, GG.Assignment.CarveForRecruit(1))
        assert.are.equal(1, GG.Assignment.Of(106))   -- x=600, exact
        assert.are.equal(1, GG.Assignment.Of(105))   -- x=500, next nearest
        assert.is_nil(GG.Assignment.Of(101))
    end)

    it("does not carve from a team with fewer than six live squads", function()
        local world = newWorld()
        world.setPlayer(1, 7, 0)
        for i = 1, 5 do world.setUnit(100 + i, 7, i * 100, 0) end

        assert.are.equal(0, GG.Assignment.CarveForRecruit(1))
    end)

    it("does not carve for a non-Recruit", function()
        local world = newWorld()
        world.setPlayer(1, 7, 1)
        teamOfSix(world)

        assert.are.equal(0, GG.Assignment.CarveForRecruit(1))
    end)
end)

describe("wire verbs (§(c))", function()
    local Wire = require('parley.wire')

    it("lets a Veteran assign squads to a teammate", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 2)   -- Veteran issuer
        world.setPlayer(2, 7, 0)   -- Recruit target
        world.setUnit(100, 7)
        world.setUnit(101, 7)

        g:RecvLuaMsg(Wire.encode('assign.set', { units = { 100, 101 }, player = 2 }), 1)

        assert.are.equal(2, GG.Assignment.Of(100))
        assert.are.equal(2, GG.Assignment.Of(101))
    end)

    it("refuses assign.set from a rank-1 player who is not the mentor", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 1)
        world.setPlayer(2, 7, 0)
        world.setUnit(100, 7)

        g:RecvLuaMsg(Wire.encode('assign.set', { units = { 100 }, player = 2 }), 1)

        assert.is_nil(GG.Assignment.Of(100))
    end)

    it("releases through assign.release and clears the published param", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 2)
        world.setPlayer(2, 7, 0)
        world.setUnit(100, 7)
        GG.Assignment.Set(100, 2)

        g:RecvLuaMsg(Wire.encode('assign.release', { units = { 100 } }), 1)

        assert.is_nil(GG.Assignment.Of(100))
        assert.is_nil(world.trp(7, 'assign_100'))
    end)

    it("ignores units outside the issuer's own team", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 2)
        world.setPlayer(2, 7, 0)
        world.setUnit(200, 9)   -- other team

        g:RecvLuaMsg(Wire.encode('assign.set', { units = { 200 }, player = 2 }), 1)

        assert.is_nil(GG.Assignment.Of(200))
    end)
end)

describe("lifecycle (§(c))", function()
    it("clears an assignment when the unit dies", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 1)
        world.setUnit(100, 7)
        GG.Assignment.Set(100, 1)

        g:UnitDestroyed(100, 1, 7)

        assert.is_nil(GG.Assignment.Of(100))
        assert.are.equal(0, GG.Assignment.CountFor(1))
    end)

    it("releases a leaver's squads back to the team, moving nothing", function()
        local world, g = newWorld()
        world.setPlayer(1, 7, 1)
        world.setUnit(100, 7)
        world.setUnit(101, 7)
        GG.Assignment.Set(100, 1)
        GG.Assignment.Set(101, 1)

        g:PlayerRemoved(1, 'quit')

        assert.is_nil(GG.Assignment.Of(100))
        assert.is_nil(GG.Assignment.Of(101))
        assert.are.equal(7, world.units[100].team)   -- ownership untouched
    end)
end)
