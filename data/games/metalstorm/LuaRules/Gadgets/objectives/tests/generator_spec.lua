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
        scenario = function() return nil end,
        contestedRegions = function() return {} end,
        regionValue = function() return 0 end,
        civilianDistrictsUnderThreat = function() return {} end,
        newConvoys = function() return {} end,
        infraBuildings = function() return {} end,
        -- §10.5's transport floor. Empty by default so every pre-existing
        -- expectation in this file still counts only the objectives its own
        -- rule produced.
        inFlightArrivals = function() return {} end,
        extractableTransports = function() return {} end,
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
        -- Stated against the REAL multiplier table rather than a copy of it:
        -- the density ladder is tuned by the economy harness
        -- (`node tools/economy-validation.js`), so a spec that pinned the
        -- numbers here would go red every time the economy was retuned and say
        -- nothing about whether density still scales anything.
        local function firedAt(density)
            local state = generator.newState()
            local regions = {}
            for i = 1, 10 do regions[i] = 'r' .. i end
            local world = fakeWorld({
                contestedRegions = function() return regions end,
                modOptions = function() return { objective_density = density } end,
            })
            generator.tick(world, state)   -- tick 0: seeds the debounce clock
            world.tick = 1
            generator.tick(world, state)   -- tick 1: fires, capped
            return #world._created
        end
        for _, density in ipairs({ 'sparse', 'normal', 'dense' }) do
            local capMul = generator.DENSITY[density].capMul
            -- 10 candidates on offer, so the cap binds until capMul lifts it
            -- past 10 and the candidate list becomes the limit instead.
            local expected = math.min(10, math.max(1, math.floor(6 * capMul)))
            assert.are.equal(expected, firedAt(density),
                'control rule fired the wrong count at ' .. density)
        end
        assert.is_true(generator.DENSITY.dense.capMul > generator.DENSITY.sparse.capMul)
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

-- ============================================================
-- Scenario gating: the systemic generator must stay out of a scripted
-- tutorial/solo Mission (journey-tutorial found objective_count=2 at frame 0
-- in scenarios/tutorial_01.lua — the generator posting into a Mission whose
-- whole point is a scripted beat list).
-- ============================================================
describe("scenario gating (tutorial/solo)", function()
    it("suppresses every rule when the scenario declares tutorial or solo", function()
        for _, scn in ipairs({ { tutorial = true }, { solo = true } }) do
            local state = generator.newState()
            local world = fakeWorld({
                scenario = function() return scn end,
                contestedRegions = function() return { 'r1' } end,
            })
            generator.tick(world, state)   -- tick 0: would seed the debounce clock
            world.tick = 1
            generator.tick(world, state)   -- tick 1: would fire, but the scenario blocks it
            assert.are.equal(0, #world._created)
        end
    end)

    it("still runs normally when the scenario has no tutorial/solo flag", function()
        local state = generator.newState()
        local world = fakeWorld({
            scenario = function() return { tutorial = false } end,
            contestedRegions = function() return { 'r1' } end,
        })
        generator.tick(world, state)   -- tick 0: seeds the debounce clock
        world.tick = 1
        generator.tick(world, state)   -- tick 1: debounce satisfied, fires
        assert.are.equal(1, #world._created)
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

    -- F13 (2026-09-10 review). A linked pair is TWO objectives sharing ONE
    -- systemicKey and ONE `ruleCounts` increment, and resolving either half
    -- mutually resolves the other — so game_objectives called onResolved twice
    -- per pair and the escort rule's live count fell by 2 each time a convoy
    -- finished. Both cases below need SEVERAL pairs open at once: with only
    -- one live, onResolved's `math.max(0, n - 1)` clamp absorbs the second
    -- decrement and the defect is invisible, which is how it survived.
    local function openPairs(n)
        local state = generator.newState()
        local convoys = {}
        local world = fakeWorld({ newConvoys = function() return convoys end })
        for i = 1, n do
            convoys = { { id = 'c' .. i, benefactorTeam = 2, unitIDs = { 100 + i },
                          destArea = { x = 0, z = 0, r = 50 } } }
            world.frame, world.tick = i * 10000, i
            generator.tick(world, state)
        end
        return state, world
    end

    it("releases exactly one cap slot per pair, however many halves report in", function()
        local state = openPairs(3)
        assert.are.equal(3, state.ruleCounts.escort)

        -- Both halves resolve: the escort completing moots the kill out, and
        -- the kill's own resolution calls back in with the same dedup key.
        generator.onResolved(state, 'escort', 'convoy:c2')
        generator.onResolved(state, 'escort', 'convoy:c2')

        assert.are.equal(2, state.ruleCounts.escort)
        assert.is_nil(state.systemicActive['convoy:c2'])
        -- The other two are untouched — this is a per-key release, not a
        -- blanket decrement.
        assert.is_not_nil(state.systemicActive['convoy:c1'])
        assert.is_not_nil(state.systemicActive['convoy:c3'])
    end)

    it("keeps the rule at its cap as pairs resolve in twos", function()
        -- The escort rule's cap is 4. Four live pairs, each finishing through
        -- both halves: the live count must walk 4-3-2-1-0, not 4-2-0-0-0.
        -- (A refused candidate cannot be retried here — `seenConvoys` is
        -- edge-triggered per convoy id — so the count itself is the gate, and
        -- it is what `fire` reads before deciding to refuse.)
        local state = openPairs(4)
        assert.are.equal(4, state.ruleCounts.escort)

        for i, expected in ipairs({ 3, 2, 1, 0 }) do
            generator.onResolved(state, 'escort', 'convoy:c' .. i)
            generator.onResolved(state, 'escort', 'convoy:c' .. i)
            assert.are.equal(expected, state.ruleCounts.escort)
        end
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

-- ============================================================
-- §10.5's universal floor: the transport rule. These are the only generator
-- tests that need NO map content whatsoever — which is the whole claim.
-- ============================================================
describe("transport rule (the universal generator floor)", function()
    local function arrival(id, team, transportID)
        return { arrivalID = id, team = team, transportID = transportID,
                 dropZone = { x = 1000, z = 2000 } }
    end

    it("pairs an inbound escort with a kill race when a wave is on the map", function()
        local state = generator.newState()
        local world = fakeWorld({
            inFlightArrivals = function() return { arrival('w1', 4, 77) } end,
        })
        generator.tick(world, state)
        assert.are.equal(1, #world._created)
        local pair = world._created[1]
        assert.are.equal('escort', pair.escort.type)
        assert.are.equal(4, pair.escort.forTeam)
        assert.are.equal('inbound', pair.escort.params.direction)
        assert.are.same({ 77 }, pair.escort.params.transportUnitIDs)
        assert.are.equal(1000, pair.escort.params.extractArea.x)
        assert.are.equal('kill', pair.kill.type)
        assert.are.equal(77, pair.kill.params.targetUnitID)
        assert.is_nil(pair.kill.forTeam)          -- open race for everyone else
    end)

    it("edge-triggers per wave: a wave still in flight does not re-fire", function()
        local state = generator.newState()
        local world = fakeWorld({
            inFlightArrivals = function() return { arrival('w1', 4, 77) } end,
        })
        generator.tick(world, state)
        world.frame, world.tick = 100000, 50     -- past any cooldown
        generator.tick(world, state)
        assert.are.equal(1, #world._created)
    end)

    it("forgets a wave once it leaves the in-flight list", function()
        local state = generator.newState()
        local live = { arrival('w1', 4, 77) }
        local world = fakeWorld({ inFlightArrivals = function() return live end })
        generator.tick(world, state)
        assert.is_true(state.seenArrivals['w1'])
        live = {}                                 -- unloaded (or died)
        generator.tick(world, state)
        assert.is_nil(state.seenArrivals['w1'])
    end)

    it("gives every side with a live carrier and an exit a standing outbound escort", function()
        local state = generator.newState()
        local world = fakeWorld({
            extractableTransports = function()
                return {
                    { team = 0, transportUnitIDs = { 11 },
                      extractArea = { x = 10, z = 20, r = 700 } },
                    { team = 1, transportUnitIDs = { 12, 13 },
                      extractArea = { x = 90, z = 80, r = 700 } },
                }
            end,
        })
        generator.tick(world, state)
        assert.are.equal(2, #world._created)
        assert.are.equal('escort', world._created[1].type)
        assert.are.equal('outbound', world._created[1].params.direction)
        assert.are.equal(0, world._created[1].forTeam)
        assert.are.same({ 12, 13 }, world._created[2].params.transportUnitIDs)
        assert.are.equal(700, world._created[2].params.extractArea.r)
    end)

    it("is idempotent per team while that side's escort stays active", function()
        local state = generator.newState()
        local world = fakeWorld({
            extractableTransports = function()
                return { { team = 0, transportUnitIDs = { 11 },
                           extractArea = { x = 10, z = 20, r = 700 } } }
            end,
        })
        generator.tick(world, state)
        world.frame, world.tick = 100000, 50
        generator.tick(world, state)
        assert.are.equal(1, #world._created)
    end)

    it("produces nothing for a side with a carrier but nowhere to take it", function()
        -- extractableTransports is the facade's job to filter; the rule trusts
        -- it. This pins the contract that an empty answer stays empty.
        local state = generator.newState()
        local world = fakeWorld({ extractableTransports = function() return {} end })
        generator.tick(world, state)
        assert.are.equal(0, #world._created)
    end)

    it("keeps the liveness backstop quiet, because the floor already fired", function()
        -- §10.5: "livenessRule's forced-control backstop stays as the last
        -- resort but should rarely fire once the transport rule exists." Here
        -- the starved team has no regions at all, so the backstop could not
        -- have helped it anyway — the transport rule can, on any map.
        local state = generator.newState()
        local world = fakeWorld({
            teams = function() return { 0 } end,
            completableObjectiveCount = function() return 0 end,
            nearestNeutralOrContestedRegion = function() return nil end,
            extractableTransports = function()
                return { { team = 0, transportUnitIDs = { 11 },
                           extractArea = { x = 10, z = 20, r = 700 } } }
            end,
        })
        generator.tick(world, state)
        world.tick = 1
        generator.tick(world, state)
        assert.are.equal(1, #world._created)
        assert.are.equal('escort', world._created[1].type)
    end)
end)

-- ============================================================
-- §10.6: the reward derivation and the per-team concurrency ceiling.
-- ============================================================
describe("the reward derivation (§10.6)", function()
    it("prices a reward off the cost spec's median directive, not a literal", function()
        local spec = {
            base_k = 2.0, median_directive_basis = 7,
            order_class = { directive = 1.5 },
            region_mod_min = 0.5, region_mod_max = 2.0,
        }
        -- geometric centre of [0.5, 2.0] is 1.0: ceil(2 × 7 × 1 × 1.5) = 21
        assert.are.equal(21, generator.rewardUnit(spec))
    end)

    it("takes the GEOMETRIC centre of the region band, not the arithmetic one", function()
        -- The band is multiplicative (halved in friendly ground, doubled in
        -- enemy). Its arithmetic mean is 1.25 and would price every objective
        -- as if every war were fought on the enemy's side of the map.
        local spec = {
            base_k = 1.0, median_directive_basis = 100,
            order_class = { directive = 1.0 },
            region_mod_min = 0.5, region_mod_max = 2.0,
        }
        assert.are.equal(100, generator.rewardUnit(spec))
    end)

    it("pays every rule a whole number of median directives", function()
        local state = generator.newState()
        local world = fakeWorld({
            civilianDistrictsUnderThreat = function()
                return { { districtId = 'd1', districtTeam = 0, unitIDs = { 1 } } }
            end,
        })
        generator.tick(world, state)
        assert.are.equal(generator.DIRECTIVES.district * generator.REWARD_UNIT,
                         world._created[1].reward)
    end)

    it("keeps the design's ranking of the rules", function()
        local D = generator.DIRECTIVES
        assert.is_true(D.infra < D.district)
        assert.is_true(D.district < D.control)
        assert.is_true(D.control < D.escort)
        assert.is_true(D.escort < D.liveness)
        assert.is_true(D.liveness < D.arrival)
        assert.is_true(D.arrival < D.extract)
    end)
end)

describe("the per-team concurrency ceiling", function()
    --- `n` districts, all owned by team 0, all under threat at once: one
    --- team-scoped candidate per district, deduped per district id.
    local function districtWorld(n)
        return fakeWorld({
            teams = function() return { 0, 1 } end,
            civilianDistrictsUnderThreat = function()
                local out = {}
                for i = 1, n do
                    out[i] = { districtId = 'd' .. i, districtTeam = 0, unitIDs = { i } }
                end
                return out
            end,
        })
    end

    it("refuses a rule once the team's board is full", function()
        local state = generator.newState()
        local cap = generator.DENSITY.normal.teamCap
        -- districtRule's own cap is 4, so lift it out of the way: the point of
        -- this test is the TOTAL, which no per-rule cap bounds.
        local ruleCap
        for _, rule in ipairs(generator.rules) do
            if rule.key == 'district' then ruleCap = rule.cap; rule.cap = 1000 end
        end
        local world = districtWorld(cap + 5)
        generator.tick(world, state)
        for _, rule in ipairs(generator.rules) do
            if rule.key == 'district' then rule.cap = ruleCap end
        end
        assert.are.equal(cap, #world._created)
        assert.are.equal(cap, state.teamCounts[0])
        assert.is_nil(state.teamCounts[1])   -- team 1's board is untouched
    end)

    it("frees a slot when the objective resolves", function()
        local state = generator.newState()
        local world = districtWorld(1)
        generator.tick(world, state)
        assert.are.equal(1, state.teamCounts[0])
        generator.onResolved(state, 'district', 'district:d1')
        assert.are.equal(0, state.teamCounts[0])
    end)

    it("frees ONE slot for a linked pair, not two (F13)", function()
        local state = generator.newState()
        local world = fakeWorld({
            teams = function() return { 0, 1 } end,
            newConvoys = function()
                return { { id = 'c1', benefactorTeam = 0, unitIDs = { 101 },
                           destArea = { x = 0, z = 0, r = 50 } } }
            end,
        })
        generator.tick(world, state)
        assert.are.equal(1, state.teamCounts[0])
        generator.onResolved(state, 'escort', 'convoy:c1')   -- the escort half
        generator.onResolved(state, 'escort', 'convoy:c1')   -- the kill half
        assert.are.equal(0, state.teamCounts[0])
    end)

    it("counts an open race against every team — it is on everyone's board", function()
        local state = generator.newState()
        local world = fakeWorld({
            teams = function() return { 0, 1 } end,
            contestedRegions = function() return { 'r1' } end,
        })
        generator.tick(world, state)
        world.tick = 1
        generator.tick(world, state)
        assert.are.equal(1, state.teamCounts[0])
        assert.are.equal(1, state.teamCounts[1])
    end)

    it("never refuses the liveness backstop — a full board is not a starved one", function()
        -- The backstop only fires for a team with NOTHING completable. A
        -- ceiling that could refuse it would deadlock exactly the team it
        -- exists to rescue.
        local state = generator.newState()
        state.teamCounts[0] = 1000
        local world = fakeWorld({
            teams = function() return { 0 } end,
            completableObjectiveCount = function() return 0 end,
            nearestNeutralOrContestedRegion = function() return 'r9' end,
        })
        generator.tick(world, state)   -- tick 0: starts the starvation clock
        world.tick = 1
        generator.tick(world, state)   -- tick 1: two ticks starved, backstop fires
        assert.are.equal(1, #world._created)
        assert.are.equal('r9', world._created[1].params.regionKey)
    end)
end)
