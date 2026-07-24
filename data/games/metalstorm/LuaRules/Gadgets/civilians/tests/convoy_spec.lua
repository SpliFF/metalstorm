-- civilians/tests/convoy_spec.lua — convoy system tests.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/civilians && busted tests/
package.path = './?.lua;' .. package.path

local function freshWorld()
    local world = {
        units = {},           -- unitID -> { defName, x, z, team, destroyed }
        nextUnitID = 2001,
        frame = 0,
        logMessages = {},
        orders = {},          -- unitID -> { { cmd, params, options } }
    }

    _G.Spring = {
        GetGroundHeight = function(x, z) return 0 end,
        CreateUnit = function(defName, x, y, z, facing, teamID)
            local unitID = world.nextUnitID
            world.nextUnitID = world.nextUnitID + 1
            world.units[unitID] = { defName = defName, x = x, z = z, team = teamID, destroyed = false }
            return unitID
        end,
        ValidUnitID = function(unitID)
            return world.units[unitID] and not world.units[unitID].destroyed
        end,
        GetUnitPosition = function(unitID)
            if not world.units[unitID] or world.units[unitID].destroyed then
                return nil
            end
            local u = world.units[unitID]
            return u.x, 0, u.z
        end,
        DestroyUnit = function(unitID, _, _)
            if world.units[unitID] then
                world.units[unitID].destroyed = true
            end
        end,
        GiveOrderToUnit = function(unitID, cmd, params, options)
            world.orders[unitID] = world.orders[unitID] or {}
            table.insert(world.orders[unitID], { cmd = cmd, params = params, options = options })
        end,
        Log = function(section, level, msg)
            world.logMessages[#world.logMessages + 1] = { section = section, level = level, msg = msg }
        end,
    }

    _G.CMD = { MOVE = 10 }
    _G.LOG = { INFO = 'INFO', WARNING = 'WARNING' }

    return world
end

describe("convoy.lua", function()
    local convoy

    before_each(function()
        convoy = dofile("convoy.lua")
    end)

    describe("convoy.tick", function()
        it("spawns convoy vehicles at intervals", function()
            local world = freshWorld()
            local civ = {
                gaiaTeam = 99,
                population = {},
                convoyRoutes = {
                    {
                        id = 'test_convoy',
                        waypoints = {
                            { x = 1000, z = 1000 },
                            { x = 2000, z = 1000 },
                            { x = 3000, z = 1000 },
                        },
                        defName = 'civ_truck',
                        intervalSec = 60,
                    },
                },
            }

            -- First tick should schedule a spawn (with random delay 0-1800)
            convoy.tick(civ, 0)
            assert.equals(0, #world.logMessages)

            -- Advance to frame 1801 (past max initial delay)
            convoy.tick(civ, 1801)
            assert.equals(1, #world.logMessages)
            assert.truthy(world.logMessages[1].msg:match("Spawned convoy vehicle"))

            -- Check that vehicle was spawned (use next() since population is a hash table)
            local unitID = next(civ.population)
            assert.truthy(unitID)
            assert.equals('ms_civtruck', world.units[unitID].defName)
            assert.equals('convoy', civ.population[unitID].role)
            assert.equals('test_convoy', civ.population[unitID].route)

            -- Next spawn should be intervalSec frames later (60s * 30fps = 1800 frames)
            world.logMessages = {}
            convoy.tick(civ, 1802)
            assert.equals(0, #world.logMessages)  -- No new spawn yet

            convoy.tick(civ, 3601)  -- 1801 + 1800
            assert.equals(1, #world.logMessages)
            assert.truthy(world.logMessages[1].msg:match("Spawned convoy vehicle"))
        end)

        it("moves convoy vehicles along waypoints", function()
            local world = freshWorld()
            local civ = {
                gaiaTeam = 99,
                population = {},
                convoyRoutes = {
                    {
                        id = 'test_convoy',
                        waypoints = {
                            { x = 1000, z = 1000 },
                            { x = 2000, z = 1000 },
                            { x = 3000, z = 1000 },
                        },
                        defName = 'civ_truck',
                        intervalSec = 60,
                    },
                },
            }

            -- Initialize spawn timer
            convoy.tick(civ, 0)

            -- Spawn a convoy (spawned at waypoint 1, heading to waypoint 2)
            convoy.tick(civ, 1801)
            local unitID = next(civ.population)

            -- Should get a move order to waypoint 2
            convoy.tick(civ, 1802)
            assert.truthy(world.orders[unitID])
            assert.equals(CMD.MOVE, world.orders[unitID][1].cmd)
            assert.equals(2000, world.orders[unitID][1].params[1])

            -- Move unit to waypoint 2
            world.units[unitID].x = 2000
            world.units[unitID].z = 1000
            world.orders[unitID] = {}

            -- Should advance to waypoint 3 (final)
            convoy.tick(civ, 1803)
            assert.truthy(world.orders[unitID])
            assert.equals(CMD.MOVE, world.orders[unitID][1].cmd)
            assert.equals(3000, world.orders[unitID][1].params[1])

            -- Move unit to final waypoint
            world.units[unitID].x = 3000
            world.units[unitID].z = 1000

            -- Should destroy unit when route complete
            convoy.tick(civ, 1804)
            assert.truthy(world.units[unitID].destroyed)
        end)

        it("handles empty convoy routes gracefully", function()
            local world = freshWorld()
            local civ = {
                gaiaTeam = 99,
                population = {},
                convoyRoutes = {},
            }

            -- Should not crash
            convoy.tick(civ, 0)
            convoy.tick(civ, 1000)
            assert.equals(0, #world.logMessages)
        end)

        it("maps legacy def names correctly", function()
            local world = freshWorld()
            local civ = {
                gaiaTeam = 99,
                population = {},
                convoyRoutes = {
                    {
                        id = 'test_bus',
                        waypoints = { { x = 1000, z = 1000 } },
                        defName = 'civ_bus',
                        intervalSec = 60,
                    },
                },
            }

            -- Initialize spawn timer
            convoy.tick(civ, 0)

            convoy.tick(civ, 1801)
            local unitID = next(civ.population)
            assert.truthy(unitID)
            assert.equals('ms_civbus', world.units[unitID].defName)
        end)
    end)
end)
