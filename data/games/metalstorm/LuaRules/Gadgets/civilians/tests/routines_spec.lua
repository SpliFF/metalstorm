-- civilians/tests/routines_spec.lua — ambient civilian wander/flee cadence
-- (PLAN-metalstorm-regions.md §4 civilian consumer contract; PLAN-metalstorm-
-- interaction.md §3 credible-threat model). Run from the plugin root:
-- cd data/games/metalstorm/LuaRules/Gadgets/civilians && busted tests/
package.path = './?.lua;' .. package.path

local CMD_MOVE = 10

local function freshWorld()
    local world = {
        units = {},          -- unitID -> { x, z, commands }
        regionAt = {},       -- "x,z" -> regionKey
        regionOwners = {},   -- regionKey -> teamID
        contested = {},      -- list of regionKey
        neighbors = {},      -- regionKey -> list of regionKey
        moveOrders = {},
    }

    function world.setUnit(unitID, x, z, commands)
        world.units[unitID] = { x = x, z = z, commands = commands or {} }
    end
    function world.setRegionAt(x, z, key) world.regionAt[x .. ',' .. z] = key end
    function world.setRegionOwner(key, teamID) world.regionOwners[key] = teamID end
    function world.setContested(keys) world.contested = keys end
    function world.setNeighbors(key, keys) world.neighbors[key] = keys end

    _G.CMD = { MOVE = CMD_MOVE }
    _G.Spring = {
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            return u.x, 0, u.z
        end,
        GetUnitCommands = function(unitID)
            local u = world.units[unitID]
            return u and u.commands or {}
        end,
        GetGroundHeight = function() return 0 end,
        GiveOrderToUnit = function(unitID, cmdID, params)
            world.moveOrders[#world.moveOrders + 1] = { unitID = unitID, cmdID = cmdID, params = params }
        end,
    }

    _G.GG = {
        Regions = {
            KeyAt = function(x, z) return world.regionAt[x .. ',' .. z] end,
            ControllingTeam = function(key) return world.regionOwners[key] end,
            GetContested = function() return world.contested end,
            Neighbors = function(key) return world.neighbors[key] or {} end,
            Keys = function()
                local out = {}
                for key in pairs(world.regionOwners) do out[#out + 1] = key end
                return out
            end,
        },
    }

    package.loaded['routines'] = nil
    local routines = dofile('./routines.lua')
    return world, routines
end

describe("routines.tick — wander (safe regions)", function()
    it("issues a wander order to an idle civilian in an unowned (gaia/wilds) region", function()
        local world, routines = freshWorld()
        world.setUnit(1, 0, 0)
        world.setUnit(2, 500, 0)   -- second civilian, gives findNearestSite a site to target
        world.setRegionAt(0, 0, 'wilds')
        world.setRegionAt(500, 0, 'wilds')
        local civ = {
            gaiaTeam = 99,
            population = {
                [1] = { role = 'ambient' },
                [2] = { role = 'ambient', site = 'other_site' },
            },
        }

        math.randomseed(1)
        -- deterministic: force both the 50% wander roll and the angle/radius rolls
        local calls = { 0.1, 0.1, 0.1 }
        local i = 0
        math.random = function() i = i + 1; return calls[i] or 0.1 end

        routines.tick(civ, 150)

        assert.are.equal(1, #world.moveOrders)
        assert.are.equal(1, world.moveOrders[1].unitID)
        assert.are.equal(CMD_MOVE, world.moveOrders[1].cmdID)
    end)

    it("REGRESSION (2026-07-26): a district peacefully owned by a non-gaia team but NOT " ..
       "contested is still safe to wander — home-district ownership from scenario start " ..
       "is not itself a threat (matches estate.lua's credible-threat model)", function()
        local world, routines = freshWorld()
        world.setUnit(1, 0, 0)
        world.setUnit(2, 500, 0)
        world.setRegionAt(0, 0, 'ash_habitat')
        world.setRegionAt(500, 0, 'ash_habitat')
        world.setRegionOwner('ash_habitat', 0)   -- owned by team 0, e.g. the scenario's home faction
        world.setContested({})                   -- no active fighting
        local civ = {
            gaiaTeam = 99,
            population = {
                [1] = { role = 'ambient' },
                [2] = { role = 'ambient', site = 'other_site' },
            },
        }

        math.random = function() return 0.1 end   -- always take the 50% wander branch

        routines.tick(civ, 150)

        assert.are.equal(1, #world.moveOrders)
        assert.are.equal(CMD_MOVE, world.moveOrders[1].cmdID)
    end)

    it("does not re-order a civilian that already has queued commands", function()
        local world, routines = freshWorld()
        world.setUnit(1, 0, 0, { { id = CMD_MOVE } })
        world.setRegionAt(0, 0, 'wilds')
        local civ = { gaiaTeam = 99, population = { [1] = { role = 'ambient' } } }

        math.random = function() return 0.1 end

        routines.tick(civ, 150)

        assert.are.equal(0, #world.moveOrders)
    end)

    it("skips non-ambient roles (convoy/payload civilians)", function()
        local world, routines = freshWorld()
        world.setUnit(1, 0, 0)
        world.setRegionAt(0, 0, 'wilds')
        local civ = { gaiaTeam = 99, population = { [1] = { role = 'convoy' } } }

        math.random = function() return 0.1 end

        routines.tick(civ, 150)

        assert.are.equal(0, #world.moveOrders)
    end)
end)

describe("routines.tick — flee (contested regions)", function()
    it("flees toward homePos when the current region is contested", function()
        local world, routines = freshWorld()
        world.setUnit(1, 0, 0)
        world.setRegionAt(0, 0, 'ash_habitat')
        world.setRegionOwner('ash_habitat', 0)
        world.setContested({ 'ash_habitat' })
        world.setNeighbors('ash_habitat', { 'wilds' })
        world.setRegionAt(0, 0, 'ash_habitat')   -- KeyAt of homePos resolves too (same key here)
        local civ = {
            gaiaTeam = 99,
            population = { [1] = { role = 'ambient', homePos = { x = 200, z = 300 } } },
        }

        routines.tick(civ, 150)

        assert.are.equal(1, #world.moveOrders)
        assert.are.equal(1, world.moveOrders[1].unitID)
        assert.are.same({ 200, 0, 300 }, world.moveOrders[1].params)
    end)
end)

describe("routines.tick — wander anchors on HOME, not on the next town", function()

    it("REGRESSION (town-planner T4, found in the browser): a resident with a " ..
       "homePos wanders around it and does not commute to another district", function()
        -- WHAT WENT WRONG. `findNearestSite` returns the nearest site that is
        -- NOT this unit's own — a commute. That is harmless when a map's
        -- authored sites are a few hundred elmos apart, and a mass migration
        -- when they are TOWNS four kilometres apart: on a generated
        -- techno_lands scenario, two of the map's three districts had emptied
        -- themselves into the third within four minutes of sim.
        local world, routines = freshWorld()
        world.setUnit(1, 1000, 1000)
        world.setUnit(2, 5000, 5000)            -- another town, far away
        world.setRegionAt(1000, 1000, 'home_town')
        world.setRegionAt(5000, 5000, 'far_town')
        local civ = {
            gaiaTeam = 99,
            population = {
                [1] = { role = 'ambient', homePos = { x = 1000, z = 1000 } },
                [2] = { role = 'ambient', site = 'far_town' },
            },
        }

        math.random = function() return 0.1 end

        routines.tick(civ, 150)

        assert.are.equal(1, #world.moveOrders)
        local p = world.moveOrders[1].params
        local dx, dz = p[1] - 1000, p[3] - 1000
        local dist = math.sqrt(dx * dx + dz * dz)
        assert.is_true(dist < 200,
            'wandered ' .. math.floor(dist) .. ' elmos from home — that is a commute')
    end)

    it("still walks a civilian with no home toward another site", function()
        -- The old behaviour is the fallback, not a casualty: map-authored
        -- population that records no home keeps the between-sites walk.
        local world, routines = freshWorld()
        world.setUnit(1, 0, 0)
        world.setUnit(2, 500, 0)
        world.setRegionAt(0, 0, 'wilds')
        world.setRegionAt(500, 0, 'wilds')
        local civ = {
            gaiaTeam = 99,
            population = {
                [1] = { role = 'ambient' },
                [2] = { role = 'ambient', site = 'other_site' },
            },
        }

        math.random = function() return 0.1 end

        routines.tick(civ, 150)

        assert.are.equal(1, #world.moveOrders)
        local p = world.moveOrders[1].params
        assert.is_true(math.abs(p[1] - 500) < 200, 'did not head for the other site')
    end)

    it("never moves a `garrison` civilian at all", function()
        -- The militia a planned town posts on its gateways. `ambient` is the
        -- only role this module manages, and a guard that strolls off the
        -- gateway it was posted to is not a guard.
        local world, routines = freshWorld()
        world.setUnit(1, 1000, 1000)
        world.setRegionAt(1000, 1000, 'home_town')
        local civ = {
            gaiaTeam = 99,
            population = {
                [1] = { role = 'garrison', homePos = { x = 1000, z = 1000 } },
            },
        }

        math.random = function() return 0.1 end

        routines.tick(civ, 150)

        assert.are.equal(0, #world.moveOrders)
    end)
end)
