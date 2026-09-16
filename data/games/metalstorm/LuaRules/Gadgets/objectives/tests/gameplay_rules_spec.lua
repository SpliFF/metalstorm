-- tests/gameplay_rules_spec.lua — the two gameplay rules the 2026-09-10
-- review designed (task 4): the control CHAIN and the COMEBACK VALVE.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/
--
-- Both are balance levers, and balance levers need their SHAPE pinned even
-- though their numbers will move: what a rule refuses to do is the half that
-- silently stops being true. The chain must not offer a region the team
-- already holds (an objective that completes on the tick it is created is a
-- free reward, not a push); the valve must not scale an open race (that pays
-- the leader extra for winning one) and must not exceed its cap however far a
-- side falls behind. Magnitudes are asserted only where the magnitude IS the
-- rule — the +25 % and the ×1.5 ceiling.

package.path = './?.lua;' .. package.path

local generator = require('generator')

local function emptyList() return {} end

--- A world with a region graph and an ownership map. `regions` is
--- `{ key = ownerTeamOrNil }`; `neighbors` is `{ key = { keys } }`.
local function fakeWorld(overrides)
    local created = {}
    local nextId = 1
    local w = {
        frame = 0, tick = 0,
        regions = {}, neighbors = {},
        contestedRegions = emptyList,
        regionValue = function() return 0 end,
        civilianDistrictsUnderThreat = emptyList,
        newConvoys = emptyList,
        infraBuildings = emptyList,
        inFlightArrivals = emptyList,
        extractableTransports = emptyList,
        teams = function() return { 0, 1 } end,
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
    w.regionNeighbors = function(key) return w.neighbors[key] or {} end
    w.regionOwner = function(key) return w.regions[key] end
    w.ownedRegionCount = function(team)
        local n = 0
        for _, owner in pairs(w.regions) do if owner == team then n = n + 1 end end
        return n
    end
    for k, v in pairs(overrides or {}) do w[k] = v end
    return w
end

--- A completed control objective, as game_objectives hands it to onCompleted.
local function completedControl(team, regionKey, reward)
    return {
        type = 'control', completedBy = team, reward = reward or 100,
        params = { regionKey = regionKey },
    }
end

-- ============================================================
-- Gameplay rule (a) — the control chain
-- ============================================================
describe("the control chain", function()
    local function worldWithGraph()
        local w = fakeWorld()
        w.regions = { a = 0, b = nil, c = nil }
        w.neighbors = { a = { 'b', 'c' }, b = { 'a' }, c = { 'a' } }
        return w
    end

    it("offers the adjacent region after a control completes", function()
        local state = generator.newState()
        local w = worldWithGraph()
        generator.onCompleted(state, completedControl(0, 'a'))
        generator.tick(w, state)

        assert.are.equal(1, #w._created)
        local def = w._created[1]
        assert.are.equal('control', def.type)
        assert.are.equal('b', def.params.regionKey)
    end)

    it("scopes it to the completing team, never an open race", function()
        -- An open race here would pay the side that just LOST the fight for
        -- taking ground it was pushed off.
        local state = generator.newState()
        local w = worldWithGraph()
        generator.onCompleted(state, completedControl(1, 'a'))
        generator.tick(w, state)
        assert.are.equal(1, w._created[1].forTeam)
    end)

    it("pays 25% over the objective that spawned it", function()
        local state = generator.newState()
        local w = worldWithGraph()
        generator.onCompleted(state, completedControl(0, 'a', 200))
        generator.tick(w, state)
        assert.are.equal(250, w._created[1].reward)
    end)

    it("carries a three-minute clock", function()
        local state = generator.newState()
        local w = worldWithGraph()
        w.frame = 9000
        generator.onCompleted(state, completedControl(0, 'a'))
        generator.tick(w, state)
        assert.are.equal(9000 + 5400, w._created[1].expiresAtFrame)
    end)

    it("skips a neighbour the team already owns", function()
        -- Otherwise the chain is a free reward: a control objective on a
        -- region you hold completes on the tick it is created.
        local state = generator.newState()
        local w = fakeWorld()
        w.regions = { a = 0, b = 0, c = nil }
        w.neighbors = { a = { 'b', 'c' } }
        generator.onCompleted(state, completedControl(0, 'a'))
        generator.tick(w, state)
        assert.are.equal(1, #w._created)
        assert.are.equal('c', w._created[1].params.regionKey)
    end)

    it("produces nothing when every neighbour is already held", function()
        local state = generator.newState()
        local w = fakeWorld()
        w.regions = { a = 0, b = 0 }
        w.neighbors = { a = { 'b' } }
        generator.onCompleted(state, completedControl(0, 'a'))
        generator.tick(w, state)
        assert.are.equal(0, #w._created)
    end)

    it("chains once per completed control, not once per neighbour", function()
        local state = generator.newState()
        local w = worldWithGraph()
        generator.onCompleted(state, completedControl(0, 'a'))
        generator.tick(w, state)
        assert.are.equal(1, #w._created)
    end)

    it("dedups on the TARGET region across teams", function()
        -- Two sides completing controls that share a neighbour must not both
        -- be handed an objective on the same ground.
        local state = generator.newState()
        local w = fakeWorld()
        w.regions = { a = 0, b = nil, d = 1 }
        w.neighbors = { a = { 'b' }, d = { 'b' } }
        generator.onCompleted(state, completedControl(0, 'a'))
        generator.onCompleted(state, completedControl(1, 'd'))
        generator.tick(w, state)
        assert.are.equal(1, #w._created)
    end)

    it("ignores a completed objective of any other type", function()
        local state = generator.newState()
        local w = worldWithGraph()
        generator.onCompleted(state, { type = 'kill', completedBy = 0, params = {} })
        generator.tick(w, state)
        assert.are.equal(0, #w._created)
    end)

    it("ignores a completion with no team to chain for", function()
        local state = generator.newState()
        local w = worldWithGraph()
        generator.onCompleted(state, { type = 'control', params = { regionKey = 'a' } })
        generator.tick(w, state)
        assert.are.equal(0, #w._created)
    end)

    it("drains its queue — a completion chains once, not every tick", function()
        local state = generator.newState()
        local w = worldWithGraph()
        generator.onCompleted(state, completedControl(0, 'a'))
        generator.tick(w, state)
        w.frame, w.tick = 100000, 50
        generator.tick(w, state)
        assert.are.equal(1, #w._created)
    end)

    it("does nothing at all without a region graph", function()
        -- No GG.Regions -> regionNeighbors answers empty. The rule disables
        -- itself rather than raising, like every other content-dependent rule.
        local state = generator.newState()
        local w = fakeWorld({ regionNeighbors = emptyList })
        generator.onCompleted(state, completedControl(0, 'a'))
        generator.tick(w, state)
        assert.are.equal(0, #w._created)
    end)
end)

-- ============================================================
-- Gameplay rule (b) — the comeback valve
-- ============================================================
describe("the comeback valve", function()
    --- `owned` is `{ [team] = count }`; regions are named so the counts come out.
    local function worldOwning(owned)
        local w = fakeWorld()
        local n = 0
        for team, count in pairs(owned) do
            for _ = 1, count do
                n = n + 1
                w.regions['r' .. n] = team
            end
        end
        return w
    end

    describe("the multiplier", function()
        it("is 1.0 for a team that is level", function()
            local w = worldOwning({ [0] = 5, [1] = 5 })
            assert.are.equal(1.0, generator.comebackScale(w, 0))
            assert.are.equal(1.0, generator.comebackScale(w, 1))
        end)

        it("is 1.0 for the leader", function()
            local w = worldOwning({ [0] = 8, [1] = 2 })
            assert.are.equal(1.0, generator.comebackScale(w, 0))
        end)

        it("rises with the gap for the trailing team", function()
            -- 6 vs 4 of 10 regions: gap 0.2 of the map -> x1.2.
            local w = worldOwning({ [0] = 6, [1] = 4 })
            assert.are.equal(1.2, generator.comebackScale(w, 1))
        end)

        it("rises further as the gap widens", function()
            local near = worldOwning({ [0] = 6, [1] = 4 })
            local far  = worldOwning({ [0] = 7, [1] = 3 })
            assert.is_true(generator.comebackScale(far, 1) > generator.comebackScale(near, 1))
        end)

        it("never exceeds 1.5, however far behind a team falls", function()
            for _, split in ipairs({ { 9, 1 }, { 19, 1 }, { 99, 1 } }) do
                local w = worldOwning({ [0] = split[1], [1] = split[2] })
                assert.is_true(generator.comebackScale(w, 1) <= 1.5)
            end
        end)

        it("is 1.0 when nobody owns anything yet", function()
            local w = fakeWorld()
            assert.are.equal(1.0, generator.comebackScale(w, 0))
        end)

        it("is 1.0 without a region layer at all", function()
            local w = fakeWorld({ ownedRegionCount = nil })
            assert.are.equal(1.0, generator.comebackScale(w, 0))
        end)
    end)

    describe("what it scales", function()
        local function behindWorld()
            local w = worldOwning({ [0] = 8, [1] = 2 })
            w.neighbors = {}
            return w
        end

        it("scales a team-scoped systemic reward", function()
            local state = generator.newState()
            local w = behindWorld()
            w.civilianDistrictsUnderThreat = function()
                return { { districtId = 'd1', districtTeam = 1, unitIDs = { 1 } } }
            end
            generator.tick(w, state)
            assert.are.equal(1, #w._created)
            -- districtRule authors reward 40; team 1 is behind.
            assert.is_true(w._created[1].reward > 40)
            assert.is_true(w._created[1].reward <= math.floor(40 * 1.5))
        end)

        it("leaves the leader's reward alone", function()
            local state = generator.newState()
            local w = behindWorld()
            w.civilianDistrictsUnderThreat = function()
                return { { districtId = 'd1', districtTeam = 0, unitIDs = { 1 } } }
            end
            generator.tick(w, state)
            assert.are.equal(40, w._created[1].reward)
        end)

        it("leaves an open race alone — there is no behind team to price it for", function()
            -- controlRule's objective has no forTeam: it is a race. Scaling it
            -- would pay the LEADER extra for winning one.
            local state = generator.newState()
            local w = behindWorld()
            w.contestedRegions = function() return { 'contested' } end
            generator.tick(w, state)     -- tick 0 seeds the debounce
            w.tick = 1
            generator.tick(w, state)
            assert.are.equal(1, #w._created)
            assert.is_nil(w._created[1].forTeam)
            assert.are.equal(50, w._created[1].reward)   -- 50 × (1 + value 0)
        end)

        it("scales the team-scoped half of a linked pair only", function()
            local state = generator.newState()
            local w = behindWorld()
            w.newConvoys = function()
                return { { id = 'c1', benefactorTeam = 1, unitIDs = { 101 },
                           destArea = { x = 0, z = 0, r = 50 } } }
            end
            generator.tick(w, state)
            local pair = w._created[1]
            assert.is_true(pair.escort.reward > 60)   -- team 1 is behind
            assert.are.equal(60, pair.kill.reward)    -- the open race against it
        end)
    end)

    describe("the liveness threshold", function()
        --- A world where `team` has an empty board and something to be sent at.
        local function starvedWorld(owned)
            local w = worldOwning(owned)
            w.completableObjectiveCount = function() return 0 end
            w.nearestNeutralOrContestedRegion = function() return 'neutral' end
            return w
        end

        it("makes a level team wait two ticks", function()
            local state = generator.newState()
            local w = starvedWorld({ [0] = 5, [1] = 5 })
            generator.tick(w, state)
            assert.are.equal(0, #w._created)
            w.tick = 1
            generator.tick(w, state)
            assert.are.equal(2, #w._created)   -- both teams, on their second tick
        end)

        it("gives a trailing team its backstop on the first tick", function()
            local state = generator.newState()
            local w = starvedWorld({ [0] = 8, [1] = 2 })
            generator.tick(w, state)
            assert.are.equal(1, #w._created)
            assert.are.equal(1, w._created[1].forTeam)   -- the team that is behind
        end)
    end)
end)
