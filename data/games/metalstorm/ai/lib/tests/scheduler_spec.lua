-- lib/tests/scheduler_spec.lua — run from data/games/metalstorm/ai.
package.path = './?.lua;' .. package.path

local Scheduler = require('lib.scheduler')

describe("lib.scheduler", function()
    it("ticks immediately, then at the base period", function()
        local s = Scheduler.new({ base = 150 })
        assert.is_true(s:due(10))
        assert.is_false(s:due(100))
        assert.is_false(s:due(159))
        assert.is_true(s:due(160))
        assert.are.equal(2, s.ticks)
    end)

    it("maps contact hops to tiers", function()
        assert.are.equal(0, Scheduler.tierForHops(0))
        assert.are.equal(1, Scheduler.tierForHops(1))
        assert.are.equal(2, Scheduler.tierForHops(2))
        assert.are.equal(3, Scheduler.tierForHops(3))
        assert.are.equal(3, Scheduler.tierForHops(nil))
    end)

    it("escalates instantly and de-escalates one tier per dwell window", function()
        local s = Scheduler.new({ base = 150, floor = 0, ceil = 3 })
        assert.are.equal(0, s:observe(0, { hops = 0 }))
        assert.are.equal(150, s:period())
        -- quiet: wants dormant, must wait 150 frames before leaving tier 0
        assert.are.equal(0, s:observe(150, { hops = nil }))
        assert.are.equal(0, s:observe(250, { hops = nil }))
        assert.are.equal(1, s:observe(300, { hops = nil }))
        -- the next step's dwell (300 at tier 1) counts from the first quiet
        -- observation AFTER the step, so a dormant faction's descent is
        -- 5 s + 10 s + 30 s of CONTINUOUS quiet as observed, never faster
        assert.are.equal(1, s:observe(450, { hops = nil }))
        assert.are.equal(1, s:observe(700, { hops = nil }))
        assert.are.equal(2, s:observe(750, { hops = nil }))
        assert.are.equal(600, s:period())
        assert.are.equal(2, s:observe(800, { hops = nil }))
        assert.are.equal(3, s:observe(1700, { hops = nil }))
        assert.are.equal(1800, s:period())
        -- contact: straight back to full
        assert.are.equal(0, s:observe(1710, { hops = 0 }))
    end)

    it("contested own ground pins tier 0 whatever the hops say", function()
        local s = Scheduler.new({})
        s.tierNow = 3
        assert.are.equal(0, s:observe(0, { hops = nil, contested = true }))
    end)

    it("clamps into the role's band", function()
        local s = Scheduler.new({ floor = 0, ceil = 1 })
        s:observe(0, { hops = nil })
        s:observe(5000, { hops = nil })
        s:observe(9000, { hops = nil })
        assert.are.equal(1, s:tier())
    end)

    it("defers to an engine-provided tier when one exists", function()
        local s = Scheduler.new({})
        assert.are.equal(2, s:observe(0, { hops = 0, engineTier = 2 }))
        assert.are.equal(600, s:period())
    end)
end)
