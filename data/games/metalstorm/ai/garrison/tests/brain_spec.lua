-- garrison/tests/brain_spec.lua — the DOCTRINE spec.
--
-- brain.lua is pure (Picture + profile + state → orders), so every rule in
-- its doctrine comment can be stated as a case against a hand-built Picture,
-- with no engine, no fake engine and no timeline. The end-to-end behaviour is
-- tests/smoke_spec.lua's job; the eval harness (tools/ai-eval) scores the same
-- brain over time. This file is the rulebook.
--
-- Run from the plugin root (data/games/metalstorm/ai/garrison):  busted tests/

package.path = './?.lua;' .. package.path

local Brain      = require('brain')
local Regions    = require('lib.regions')
local Directives = require('lib.directives')
local Fix        = require('lib.tests.fixtures.graph')

local T = Directives.Type

--- A Picture with the three-region fixture graph, our team owning
-- north_ridge, and whatever the case overrides. Everything the brain reads is
-- explicit here — that is the point of a pure core.
local function picture(over)
    over = over or {}
    local regions = Regions.load(Fix.regionsJson())
    for key, r in pairs(regions) do
        r.owner = (key == 'north_ridge') and 0 or -1
        r.contested = false
    end
    local p = {
        frame = 1000, teamId = 0, playerId = 7,
        mapWidth = 2048, mapHeight = 2048,
        regions = regions,
        ledger = { north_ridge = { strength = 3, health = 3600, count = 3, idle = 3 } },
        intel = {},
        threat = { north_ridge = { inside = 0, adjacent = 0 } },
        board = {}, economy = { ownPool = 100, teamPool = 0, costScale = 1.0 },
    }
    for k, v in pairs(over) do p[k] = v end
    if over.owner ~= nil then
        for key, r in pairs(p.regions) do r.owner = (key == 'north_ridge') and over.owner or -1 end
    end
    return p
end

local function decide(p, profile, state, ctx)
    ctx = ctx or {}
    if ctx.ttl == nil then ctx.ttl = 300 end
    if ctx.costOf == nil then ctx.costOf = function() return 2 end end
    return Brain.decide(p, profile, state or Brain.newState(), ctx)
end

local function kinds(d)
    local out = {}
    for _, o in ipairs(d.orders) do out[#out + 1] = o.kind end
    return out
end

local function orderOf(d, kind)
    for _, o in ipairs(d.orders) do if o.kind == kind then return o end end
    return nil
end

local SENTINEL = require('profiles.sentinel')
local SKITTISH = require('profiles.skittish')
local STALWART = require('profiles.stalwart')

describe("garrison doctrine — home ground", function()
    it("pins home to the scenario slate when one is published", function()
        local state = Brain.newState()
        local p = picture({ script = { kinds = { 'garrison' }, home = 'south_marsh' } })
        local d = decide(p, SENTINEL, state)
        assert.is_true(d.home.south_marsh)
        assert.is_nil(d.home.north_ridge, 'the slate wins over ownership')
    end)

    it("falls back to owned ground, then to wherever our force stands", function()
        assert.is_true(decide(picture(), SENTINEL).home.north_ridge)
        local p = picture({ owner = -1 })   -- we own nothing; our ledger says north_ridge
        assert.is_true(decide(p, SENTINEL).home.north_ridge)
    end)

    it("does not follow its ground around once home is pinned", function()
        local state = Brain.newState()
        decide(picture(), SENTINEL, state)
        -- Force moves to south_marsh and we lose the ridge: home stays the ridge.
        local p = picture({ owner = -1,
            ledger = { south_marsh = { strength = 3, health = 3600, count = 3, idle = 3 } },
            threat = { south_marsh = { inside = 0, adjacent = 0 } } })
        local d = decide(p, SENTINEL, state)
        assert.is_true(d.home.north_ridge)
        assert.is_nil(d.home.south_marsh)
    end)

    it("says so and orders nothing when it has no ground at all", function()
        local p = picture({ owner = -1, ledger = {}, threat = {} })
        local d = decide(p, SENTINEL)
        assert.are.equal(0, #d.orders)
        assert.are.equal('no home ground', d.notes[1])
    end)
end)

describe("garrison doctrine — hold, brace, front", function()
    it("holds quiet home ground with a low-priority Defend", function()
        local d = decide(picture(), SENTINEL)
        local hold = orderOf(d, 'HOLD')
        assert.is_not_nil(hold)
        assert.are.equal(T.Defend, hold.directive)
        assert.are.equal(100, hold.priority)
        assert.is_true(hold.force, 'the DEFEND floor is always affordable')
    end)

    it("re-states HOLD only once the previous one is half-expired", function()
        local state = Brain.newState()
        local ctx = { ttl = 300 }
        assert.is_not_nil(orderOf(decide(picture({ frame = 1000 }), SENTINEL, state, ctx), 'HOLD'))
        -- 100 frames later: the standing Defend still has 2/3 of its life.
        assert.is_nil(orderOf(decide(picture({ frame = 1100 }), SENTINEL, state, ctx), 'HOLD'),
            'the garrison does not pay 2 authority every tick to stand still')
        -- Past half the ttl: re-state, so the ground is never briefly unheld.
        assert.is_not_nil(orderOf(decide(picture({ frame = 1160 }), SENTINEL, state, ctx), 'HOLD'))
    end)

    it("braces when the enemy is next door", function()
        local p = picture({ threat = { north_ridge = { inside = 0, adjacent = 4 } } })
        local o = orderOf(decide(p, SENTINEL), 'DEFEND')
        assert.is_not_nil(o)
        assert.are.equal(T.Defend, o.directive)
        assert.are.equal(200, o.priority)
        assert.is_true(o.force)
    end)

    it("holds the line when the enemy is inside, or the ground is contested", function()
        local p = picture({ threat = { north_ridge = { inside = 2, adjacent = 0 } } })
        local o = orderOf(decide(p, SENTINEL), 'DEFEND_FRONT')
        assert.is_not_nil(o)
        assert.are.equal(T.DefendFront, o.directive)
        assert.are.equal(250, o.priority)

        local q = picture()
        q.regions.north_ridge.contested = true
        local c = orderOf(decide(q, SENTINEL), 'DEFEND_FRONT')
        assert.is_not_nil(c)
        assert.are.equal('contested', c.reason)
    end)

    it("orders exactly one thing per home region", function()
        local p = picture({ threat = { north_ridge = { inside = 3, adjacent = 5 } },
                            intel = { central_basin = { strength = 3, confidence = 1.0 } } })
        assert.are.same({ 'DEFEND_FRONT' }, kinds(decide(p, SENTINEL)),
            'inside beats adjacent beats hold — never two orders for one region')
    end)
end)

describe("garrison doctrine — withdrawal", function()
    local function overrun()
        return picture({ threat = { north_ridge = { inside = 9, adjacent = 0 } } })
    end

    it("withdraws when the enemy inside outmasses us past the profile's ratio", function()
        local o = orderOf(decide(overrun(), SENTINEL), 'WITHDRAW')
        assert.is_not_nil(o)                         -- 9 > 3 × 1.6
        assert.are.equal(T.Withdraw, o.directive)
        assert.are.equal(255, o.priority)
        assert.is_nil(o.force, 'a withdrawal is paid for like any other order')
    end)

    it("stays withdrawn for withdrawHoldFrames so a mauled garrison does not bounce", function()
        local state = Brain.newState()
        decide(overrun(), SENTINEL, state)
        -- The enemy is gone the very next tick; we are still falling back.
        local calm = picture({ frame = 1600 })
        assert.is_not_nil(orderOf(decide(calm, SENTINEL, state), 'WITHDRAW'))
        -- Past the sticky window, the garrison re-forms on its ground.
        local later = picture({ frame = 1000 + SENTINEL.withdrawHoldFrames + 1 })
        local d = decide(later, SENTINEL, state)
        assert.is_nil(orderOf(d, 'WITHDRAW'))
        assert.is_not_nil(orderOf(d, 'HOLD'))
    end)

    it("withdraws through the published departure zone when there is one", function()
        local p = overrun()
        p.departure = { x = 1900, z = 1900, radius = 500 }
        local o = orderOf(decide(p, SENTINEL), 'WITHDRAW')
        assert.are.same({ x = 1900, z = 1900, radius = 500 }, o.anchor)
    end)

    it("falls back to the nearest map edge when no zone is published (G6)", function()
        local o = orderOf(decide(overrun(), SENTINEL), 'WITHDRAW')
        assert.are.equal(0, o.anchor.x, 'north_ridge centroid is nearest the west edge')
        assert.are.equal(512, o.anchor.z)
    end)

    it("skittish withdraws at parity; sentinel does not", function()
        local p = picture({ threat = { north_ridge = { inside = 4, adjacent = 0 } } })  -- 4 vs 3
        assert.is_not_nil(orderOf(decide(p, SKITTISH), 'WITHDRAW'))   -- 4 > 3 × 1.0
        local q = picture({ threat = { north_ridge = { inside = 4, adjacent = 0 } } })
        assert.is_nil(orderOf(decide(q, SENTINEL), 'WITHDRAW'))       -- 4 < 3 × 1.6
        assert.is_not_nil(orderOf(decide(q, SENTINEL), 'DEFEND_FRONT'))
    end)

    it("stalwart never withdraws — it holds the front at any ratio", function()
        local d = decide(overrun(), STALWART)
        assert.is_nil(orderOf(d, 'WITHDRAW'))
        assert.is_not_nil(orderOf(d, 'DEFEND_FRONT'))
    end)

    it("never withdraws a garrison that has nothing left to withdraw", function()
        local p = picture({ ledger = { north_ridge = { strength = 0, health = 0, count = 0, idle = 0 } },
                            threat = { north_ridge = { inside = 9, adjacent = 0 } } })
        assert.is_nil(orderOf(decide(p, SENTINEL), 'WITHDRAW'))
    end)
end)

describe("garrison doctrine — objectives", function()
    local function withObjective(over)
        local o = { type = 'control', state = 'active', reward = 100, team = -1,
                    region = 'central_basin' }
        for k, v in pairs(over or {}) do o[k] = v end
        return picture({ board = { [1] = o } })
    end

    it("takes a cheap, active, eligible objective in or next to home", function()
        local o = orderOf(decide(withObjective(), SENTINEL), 'OBJECTIVE')
        assert.is_not_nil(o)
        assert.are.equal('central_basin', o.region)
        assert.are.equal(T.Assault, o.directive, 'control/kill objectives are taken, not guarded')
        assert.are.equal('obj:1', o.goalId)
    end)

    it("guards a protect/infra objective instead of assaulting it", function()
        assert.are.equal(T.Defend, orderOf(decide(withObjective({ type = 'protect' }), SENTINEL), 'OBJECTIVE').directive)
        assert.are.equal(T.Defend, orderOf(decide(withObjective({ type = 'infra' }), SENTINEL), 'OBJECTIVE').directive)
    end)

    it("ignores objectives that are far, inactive, someone else's, or not worth it", function()
        local function none(over, profile)
            assert.is_nil(orderOf(decide(withObjective(over), profile or SENTINEL), 'OBJECTIVE'))
        end
        none({ region = 'south_marsh' })      -- two hops out: not our business
        none({ state = 'complete' })
        none({ team = 1 })                    -- another team's objective
        none({ reward = 10 })                 -- below objectiveMinReward
        none(nil, SKITTISH)                   -- a profile that ignores objectives entirely
    end)

    it("does not double-order a region it has already claimed this tick", function()
        local p = withObjective({ region = 'north_ridge' })
        p.intel = { central_basin = { strength = 1, confidence = 1.0 } }   -- nothing to screen
        local d = decide(p, SENTINEL)
        assert.are.same({ 'HOLD' }, kinds(d), 'the HOLD on our own ground already covers it')
    end)

    it("refuses an objective it cannot afford, and one that costs more than the profile allows", function()
        local dear = function() return 6 end
        assert.is_nil(orderOf(decide(withObjective(), SENTINEL, nil, { costOf = dear }), 'OBJECTIVE'),
            'objectiveMaxCost = 4 for a sentinel')
        assert.is_not_nil(orderOf(decide(withObjective(), STALWART, nil, { costOf = dear }), 'OBJECTIVE'),
            'a stalwart will pay up to 8')
        -- Budget exhausted: the DEFEND floor still goes out, the objective does not.
        local broke = decide(withObjective(), SENTINEL, nil, { budget = 0 })
        assert.is_nil(orderOf(broke, 'OBJECTIVE'))
        assert.is_not_nil(orderOf(broke, 'HOLD'), 'the floor is forced, not budgeted')
    end)
end)

describe("garrison doctrine — screening", function()
    local function screenable(over)
        local p = picture(over)
        p.intel = {}          -- nothing known about the neighbours
        return p
    end

    it("looks at one stale neighbour per tick when it has idle force", function()
        local d = decide(screenable(), SENTINEL)
        local o = orderOf(d, 'SCREEN')
        assert.is_not_nil(o)
        assert.are.equal('central_basin', o.region, 'the only neighbour of our home')
        assert.are.equal(T.Screen, o.directive)
        assert.are.equal(1, #(function() local n = {} for _, x in ipairs(d.orders) do
            if x.kind == 'SCREEN' then n[#n + 1] = x end end return n end)(),
            'one screen per tick, however many neighbours are stale')
    end)

    it("does not screen without idle force", function()
        local p = screenable({ ledger = { north_ridge = { strength = 3, health = 3600, count = 3, idle = 0 } } })
        assert.is_nil(orderOf(decide(p, SENTINEL), 'SCREEN'))
    end)

    it("does not re-screen the same region inside screenEveryFrames", function()
        local state = Brain.newState()
        assert.is_not_nil(orderOf(decide(screenable({ frame = 1000 }), SENTINEL, state), 'SCREEN'))
        assert.is_nil(orderOf(decide(screenable({ frame = 1500 }), SENTINEL, state), 'SCREEN'))
        local late = screenable({ frame = 1000 + SENTINEL.screenEveryFrames })
        assert.is_not_nil(orderOf(decide(late, SENTINEL, state), 'SCREEN'))
    end)

    it("does not screen ground it can already see", function()
        local p = screenable()
        p.intel = { central_basin = { strength = 1, confidence = 0.9 } }
        assert.is_nil(orderOf(decide(p, SENTINEL), 'SCREEN'))
        p.intel = { central_basin = { strength = 1, confidence = 0.2 } }
        assert.is_not_nil(orderOf(decide(p, SENTINEL), 'SCREEN'), 'stale intel is worth a look')
    end)

    it("stalwart scouts eagerly, skittish never scouts", function()
        local p = screenable({ ledger = { north_ridge = { strength = 1, health = 1200, count = 1, idle = 1 } } })
        assert.is_not_nil(orderOf(decide(p, STALWART), 'SCREEN'))   -- screenMinIdle 1
        assert.is_nil(orderOf(decide(screenable(), SKITTISH), 'SCREEN'))
    end)
end)

describe("garrison doctrine — budget", function()
    it("keeps the profile's reserve back and may draw the team pool only if allowed", function()
        local p = picture({ economy = { ownPool = 100, teamPool = 40, costScale = 1.0 } })
        assert.are.equal(75, (Brain.budget(p, Brain.settings(SENTINEL))))       -- 100 - 25%
        assert.are.equal(50, (Brain.budget(p, Brain.settings(SKITTISH))))       -- 100 - 50%
        assert.are.equal(126, (Brain.budget(p, Brain.settings(STALWART))))      -- (100+40) - 10%
        local _, pool = Brain.budget(p, Brain.settings(SENTINEL))
        assert.are.equal(100, pool)
    end)

    it("counts only what it must pay for against the budget", function()
        local p = picture({ threat = { north_ridge = { inside = 0, adjacent = 4 } },
                            board = { [1] = { type = 'control', state = 'active', reward = 100,
                                              team = -1, region = 'central_basin' } } })
        local d = decide(p, SENTINEL, nil, { budget = 2 })
        assert.is_not_nil(orderOf(d, 'DEFEND'), 'forced')
        assert.are.equal(2, d.spentPreview, 'only the objective is charged against the budget')
    end)
end)

describe("garrison doctrine — profile merge", function()
    it("lets a profile override defaults and leaves the rest alone", function()
        local s = Brain.settings(STALWART)
        assert.is_true(s.neverWithdraw)
        assert.are.equal(1, s.screenMinIdle)
        assert.are.equal(Brain.DEFAULTS.withdrawHoldFrames, s.withdrawHoldFrames)
        assert.are.equal(Brain.DEFAULTS.holdRestateFraction, s.holdRestateFraction)
    end)

    it("is total on an empty/absent profile", function()
        local d = decide(picture(), nil)
        assert.is_not_nil(orderOf(d, 'HOLD'))
        assert.are.same(Brain.DEFAULTS, Brain.settings(nil))
    end)
end)
