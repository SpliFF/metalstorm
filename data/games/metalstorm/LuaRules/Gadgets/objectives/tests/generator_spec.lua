-- tests/generator_spec.lua — systemic generator: dedup, cooldown, cap,
-- density, liveness (§3.2, §9 "systemic dedup ... liveness rule").
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local generator = require('generator')

local function fakeWorld(overrides)
    local created = {}
    local nextId = 1
    local w = {
        frame = 0, tick = 0,
        contestedRegions = function() return {} end,
        regionValue = function() return 0 end,
        civilianDistrictsUnderThreat = function() return {} end,
        newConvoys = function() return {} end,
        infraBuildings = function() return {} end,
        teams = function() return {} end,
        completableObjectiveCount = function() return 1 end,
        nearestNeutralOrContestedRegion = function() return nil end,
        modOptions = function() return {} end,
        create = function(def)
            local id = nextId; nextId = nextId + 1
            created[#created + 1] = def
            return id
        end,
        createLinkedPair = function(escortDef, killDef)
            local id = nextId; nextId = nextId + 1
            created[#created + 1] = { escort = escortDef, kill = killDef }
            return id
        end,
        _created = created,
    }
    for k, v in pairs(overrides or {}) do w[k] = v end
    return w
end

describe("control rule (contested region)", function()
    it("does not fire before the debounce window elapses", function()
        local state = generator.newState()
        local world = fakeWorld({ contestedRegions = function() return { 'r1' } end })
        generator.tick(world, state)   -- tick 0: first seen contested
        assert.are.equal(0, #world._created)
    end)

    it("fires once the region has been contested for >= 2 eval ticks", function()
        local state = generator.newState()
        local world = fakeWorld({ contestedRegions = function() return { 'r1' } end })
        generator.tick(world, state)          -- tick 0
        world.tick = 1
        generator.tick(world, state)          -- tick 1: debounce satisfied
        assert.are.equal(1, #world._created)
        assert.are.equal('control', world._created[1].type)
        assert.are.equal('r1', world._created[1].params.regionKey)
    end)

    it("is idempotent per region key while the objective stays active", function()
        local state = generator.newState()
        local world = fakeWorld({ contestedRegions = function() return { 'r1' } end })
        generator.tick(world, state)   -- tick 0: seeds the debounce clock
        world.tick = 1
        generator.tick(world, state)   -- tick 1: fires
        generator.tick(world, state)   -- same tick again — already booked, no-op
        assert.are.equal(1, #world._created)
    end)

    it("re-fires once the tagged objective resolves and clears the dedup key", function()
        local state = generator.newState()
        local world = fakeWorld({ contestedRegions = function() return { 'r1' } end, frame = 0, tick = 0 })
        generator.tick(world, state)   -- tick 0: seeds the debounce clock
        world.tick = 1
        generator.tick(world, state)   -- tick 1: fires
        assert.are.equal(1, #world._created)
        generator.onResolved(state, 'control', 'control:r1')
        world.frame = 10000; world.tick = 2   -- past the cooldown window
        generator.tick(world, state)
        assert.are.equal(2, #world._created)
    end)

    it("respects the cooldown after resolve, before it elapses", function()
        local state = generator.newState()
        local world = fakeWorld({ contestedRegions = function() return { 'r1' } end, frame = 0, tick = 0 })
        generator.tick(world, state)   -- tick 0: seeds the debounce clock
        world.tick = 1
        generator.tick(world, state)   -- tick 1: fires
        generator.onResolved(state, 'control', 'control:r1')
        world.frame = 1; world.tick = 2   -- cooldown (1800 * densityMul) not elapsed
        generator.tick(world, state)
        assert.are.equal(1, #world._created)
    end)

    it("respects the per-rule cap", function()
        local state = generator.newState()
        local regions = {}
        for i = 1, 10 do regions[i] = 'r' .. i end
        local world = fakeWorld({ contestedRegions = function() return regions end })
        generator.tick(world, state)   -- tick 0: seeds the debounce clock for all 10
        world.tick = 1
        generator.tick(world, state)   -- tick 1: fires, capped
        assert.are.equal(6, #world._created)   -- controlRule.cap = 6 at normal density
    end)

    it("scales cap and cooldown by objective_density", function()
        local state = generator.newState()
        local regions = {}
        for i = 1, 10 do regions[i] = 'r' .. i end
        local world = fakeWorld({
            contestedRegions = function() return regions end,
            modOptions = function() return { objective_density = 'sparse' } end,
        })
        generator.tick(world, state)   -- tick 0: seeds the debounce clock
        world.tick = 1
        generator.tick(world, state)   -- tick 1: fires, capped at sparse density
        assert.are.equal(3, #world._created)   -- 6 * 0.5 capMul, floored
    end)

    it("does not book a candidate the sim rejected (Create returned nil, E1)", function()
        local state = generator.newState()
        local world = fakeWorld({
            contestedRegions = function() return { 'r1' } end,
            create = function() return nil end,
        })
        generator.tick(world, state)   -- tick 0: seeds the debounce clock
        world.tick = 1
        generator.tick(world, state)   -- tick 1: would fire, but Create rejects it
        assert.is_nil(state.systemicActive['control:r1'])
    end)
end)

describe("liveness rule", function()
    it("does not fire for a team with a completable objective", function()
        local state = generator.newState()
        local world = fakeWorld({
            teams = function() return { 1 } end,
            completableObjectiveCount = function() return 1 end,
            nearestNeutralOrContestedRegion = function() return 'r1' end,
        })
        generator.tick(world, state)
        assert.are.equal(0, #world._created)
    end)

    it("force-generates a control objective for a starved team after 2 ticks", function()
        local state = generator.newState()
        local world = fakeWorld({
            teams = function() return { 1 } end,
            completableObjectiveCount = function() return 0 end,
            nearestNeutralOrContestedRegion = function() return 'r1' end,
        })
        generator.tick(world, state)   -- tick 0
        world.tick = 1
        generator.tick(world, state)   -- tick 1: starved for 2 ticks
        assert.are.equal(1, #world._created)
        assert.are.equal(1, world._created[1].forTeam)
    end)

    it("does nothing if there is no reachable region to grant", function()
        local state = generator.newState()
        local world = fakeWorld({
            teams = function() return { 1 } end,
            completableObjectiveCount = function() return 0 end,
            nearestNeutralOrContestedRegion = function() return nil end,
        })
        world.tick = 1
        generator.tick(world, state)
        assert.are.equal(0, #world._created)
    end)

    it("resets the starved clock once the team gets a completable objective", function()
        local state = generator.newState()
        local completable = 0
        local world = fakeWorld({
            teams = function() return { 1 } end,
            completableObjectiveCount = function() return completable end,
            nearestNeutralOrContestedRegion = function() return 'r1' end,
        })
        generator.tick(world, state)   -- tick 0, starved
        completable = 1
        world.tick = 1
        generator.tick(world, state)   -- no longer starved, clock reset
        completable = 0
        world.tick = 2
        generator.tick(world, state)   -- starved again, but clock restarted at tick 2
        assert.are.equal(0, #world._created)
    end)
end)

describe("linked-pair rule (escort + kill)", function()
    it("routes a linkedPair candidate through createLinkedPair, tagging both halves", function()
        local state = generator.newState()
        local world = fakeWorld({
            newConvoys = function()
                return { { id = 'c1', benefactorTeam = 2, unitIDs = { 101 }, destArea = { x = 0, z = 0, r = 50 } } }
            end,
        })
        generator.tick(world, state)
        assert.are.equal(1, #world._created)
        local pair = world._created[1]
        assert.are.equal('escort', pair.escort.type)
        assert.are.equal('kill', pair.kill.type)
        assert.are.equal('convoy:c1', pair.escort.systemicKey)
        assert.are.equal('convoy:c1', pair.kill.systemicKey)
    end)

    it("only creates one pair per convoy id (edge-triggered)", function()
        local state = generator.newState()
        local world = fakeWorld({
            newConvoys = function()
                return { { id = 'c1', benefactorTeam = 2, unitIDs = { 101 }, destArea = { x = 0, z = 0, r = 50 } } }
            end,
        })
        generator.tick(world, state)
        generator.tick(world, state)
        assert.are.equal(1, #world._created)
    end)
end)

describe("infra damage rule", function()
    it("fires on a health drop between ticks, not on first sight", function()
        local state = generator.newState()
        local frac = 1.0
        local world = fakeWorld({
            infraBuildings = function() return { { unitID = 5, ownerTeam = 1, healthFrac = frac } } end,
        })
        generator.tick(world, state)   -- first sighting, no prior fraction to compare
        assert.are.equal(0, #world._created)
        frac = 0.6
        generator.tick(world, state)
        assert.are.equal(1, #world._created)
        assert.are.equal(1, world._created[1].forTeam)
    end)
end)
