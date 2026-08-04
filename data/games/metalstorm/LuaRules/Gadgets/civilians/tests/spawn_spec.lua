-- civilians/tests/spawn_spec.lua — civilian spawn/seed tests.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/civilians && busted tests/
package.path = './?.lua;' .. package.path

local function freshWorld()
    local world = {
        units = {},           -- unitID -> { defName, x, z, team }
        nextUnitID = 1001,
        vfsData = nil,        -- mock mapdata/civilians.lua content
        logMessages = {},
    }

    function world.setMapData(data)
        world.vfsData = data
    end

    _G.Spring = {
        GetGroundHeight = function(x, z) return 0 end,
        CreateUnit = function(defName, x, y, z, facing, teamID)
            local unitID = world.nextUnitID
            world.nextUnitID = world.nextUnitID + 1
            world.units[unitID] = { defName = defName, x = x, z = z, team = teamID }
            return unitID
        end,
        Log = function(section, level, msg)
            world.logMessages[#world.logMessages + 1] = { section = section, level = level, msg = msg }
        end,
    }

    _G.LOG = { INFO = 'INFO', WARNING = 'WARNING' }

    -- Real footprints (xsize/zsize already encode footprint*2, per Spring
    -- convention) so the scatter-radius test below matches production math.
    _G.UnitDefNames = {
        ms_habitat = { xsize = 24, zsize = 24 },
        ms_depot = { xsize = 20, zsize = 20 },
        ms_transit_hub = { xsize = 20, zsize = 28 },
    }

    _G.VFS = {
        MAP = 'MAP',
        Include = function(path, _, mode)
            if path == "mapdata/civilians.lua" and mode == VFS.MAP then
                if world.vfsData then
                    return world.vfsData
                else
                    error("VFS: file not found: " .. path)
                end
            end
            error("VFS: unexpected path: " .. path)
        end,
    }

    return world
end

describe("spawn.lua", function()
    local spawn

    before_each(function()
        spawn = dofile("spawn.lua")
    end)

    describe("spawn.one", function()
        it("creates a unit and registers it in population", function()
            local world = freshWorld()
            local civ = { gaiaTeam = 99, population = {} }

            local unitID = spawn.one(civ, 'ms_civilians', 1000, 2000, 'north')

            assert.is_not_nil(unitID)
            assert.equals(1001, unitID)
            assert.is_not_nil(civ.population[unitID])
            assert.equals('ambient', civ.population[unitID].role)
            assert.equals('ms_civilians', world.units[unitID].defName)
            assert.equals(1000, world.units[unitID].x)
            assert.equals(2000, world.units[unitID].z)
            assert.equals(99, world.units[unitID].team)
        end)
    end)

    describe("spawn.seed", function()
        it("handles missing mapdata/civilians.lua gracefully", function()
            local world = freshWorld()
            local civ = { gaiaTeam = 99, population = {}, convoyRoutes = nil }
            -- Don't set world.vfsData — VFS.Include will error

            spawn.seed(civ)

            -- Should log and return without crashing
            assert.is_true(#world.logMessages > 0)
            assert.equals('Civilians', world.logMessages[1].section)
        end)

        it("rejects unsupported version", function()
            local world = freshWorld()
            world.setMapData({ version = 2, sites = {} })
            local civ = { gaiaTeam = 99, population = {} }

            spawn.seed(civ)

            -- Should log warning
            local warningFound = false
            for _, msg in ipairs(world.logMessages) do
                if msg.level == 'WARNING' and string.find(msg.msg, 'version') then
                    warningFound = true
                end
            end
            assert.is_true(warningFound)
        end)

        it("spawns buildings and civilians from site data", function()
            local world = freshWorld()
            world.setMapData({
                version = 1,
                sites = {
                    {
                        key = 'test_habitat',
                        region = 'region_a',
                        kind = 'habitat',
                        pos = { x = 1000, z = 2000 },
                        population = 5,
                        defPool = { 'civ_person', 'civ_vehicle' },
                    },
                    {
                        key = 'test_depot',
                        region = 'region_b',
                        kind = 'depot',
                        pos = { x = 3000, z = 4000 },
                        population = 0,
                        defPool = {},
                    },
                },
                convoys = {},
            })
            local civ = { gaiaTeam = 99, population = {} }

            spawn.seed(civ)

            -- Should have spawned 2 buildings + 5 civilians
            assert.equals(7, world.nextUnitID - 1001)

            -- Check habitat building spawned
            local habitatFound = false
            for unitID, unit in pairs(world.units) do
                if unit.defName == 'ms_habitat' then
                    habitatFound = true
                    assert.equals(1000, unit.x)
                    assert.equals(2000, unit.z)
                    assert.equals('test_habitat', civ.population[unitID].site)
                    assert.equals('habitat', civ.population[unitID].kind)
                end
            end
            assert.is_true(habitatFound)

            -- Check depot building spawned
            local depotFound = false
            for unitID, unit in pairs(world.units) do
                if unit.defName == 'ms_depot' then
                    depotFound = true
                    assert.equals(3000, unit.x)
                    assert.equals(4000, unit.z)
                end
            end
            assert.is_true(depotFound)

            -- Check civilians spawned (should be ms_civilians and ms_civtruck from the pool)
            local civilianCount = 0
            for unitID, unit in pairs(world.units) do
                if unit.defName == 'ms_civilians' or unit.defName == 'ms_civtruck' then
                    civilianCount = civilianCount + 1
                    assert.equals('test_habitat', civ.population[unitID].site)
                    assert.is_not_nil(civ.population[unitID].homePos)
                    -- Check scattered around site, clear of the habitat's
                    -- footprint at every angle: half-extent 96 elmos (xsize
                    -- 24 * 4) on each axis, corner (half-diagonal) ~135.76,
                    -- + the 40-elmo SCATTER_MARGIN = ~175.76 minimum radius.
                    local dx = unit.x - 1000
                    local dz = unit.z - 2000
                    local dist = math.sqrt(dx * dx + dz * dz)
                    assert.is_true(dist >= 175 and dist <= 227,
                        "Civilian should clear the habitat footprint's corner (got " .. dist .. ")")
                end
            end
            assert.equals(5, civilianCount)
        end)

        it("clears a non-square building footprint at every scatter angle (regression: civilian idle-tail, 2026-07-26)", function()
            -- transit_hub's footprint (10x14 -> runtime xsize/zsize 20x28) is
            -- NOT square, so a flat circular radius that only clears the
            -- shorter axis can still land inside the longer axis's blocked
            -- box on a near-diagonal angle. Live-verified on Meridian: ~10%
            -- of scattered civilians spawned inside/on the site building's
            -- yardmap and got a permanently empty command queue (GiveOrder
            -- succeeds but the pathfinder can never leave a blocked start
            -- square). Assert directly against the axis-aligned blocked box
            -- (half-extents 80/112 elmos) rather than a distance bound, so
            -- this catches the actual failure mode regardless of the
            -- clearance formula's constants.
            local world = freshWorld()
            world.setMapData({
                version = 1,
                sites = {
                    {
                        key = 'test_hub',
                        region = 'region_c',
                        kind = 'transit_hub',
                        pos = { x = 5000, z = 6000 },
                        population = 40,
                        defPool = { 'civ_person' },
                    },
                },
                convoys = {},
            })
            local civ = { gaiaTeam = 99, population = {} }

            spawn.seed(civ)

            local halfX, halfZ = 80, 112 -- transit_hub's blocked yardmap half-extents
            for unitID, unit in pairs(world.units) do
                if unit.defName == 'ms_civilians' then
                    local dx = math.abs(unit.x - 5000)
                    local dz = math.abs(unit.z - 6000)
                    assert.is_true(dx > halfX or dz > halfZ,
                        string.format("civilian %d at dx=%.0f dz=%.0f overlaps the transit_hub footprint", unitID, dx, dz))
                end
            end
        end)

        it("stashes convoy routes for convoy.lua", function()
            local world = freshWorld()
            world.setMapData({
                version = 1,
                sites = {},
                convoys = {
                    { id = 'route_a', waypoints = { {x=1,z=2}, {x=3,z=4} } },
                },
            })
            local civ = { gaiaTeam = 99, population = {} }

            spawn.seed(civ)

            assert.is_not_nil(civ.convoyRoutes)
            assert.equals(1, #civ.convoyRoutes)
            assert.equals('route_a', civ.convoyRoutes[1].id)
        end)
    end)
end)
