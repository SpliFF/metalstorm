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

    it("answers an alert early, but never closer together than minGap", function()
        -- A faction that has already stretched all the way out (nothing in
        -- contact for long enough to have walked the dwell ladder down).
        local s = Scheduler.new({ base = 150, minGap = 30, floor = 3 })
        s:observe(0, { hops = nil })
        assert.is_true(s:due(0))
        assert.are.equal(1800, s:period(), 'a faction nobody is fighting thinks once a minute')
        -- Without an alert, the next tick is a minute away: the whole reason
        -- tools/ai-eval measured a garrison reacting to an overrun 310 frames
        -- late, with no contact callin to wake it (F4).
        assert.is_false(s:due(600))
        assert.is_true(s:due(600, true), 'a cheap poll noticed something; think NOW')
        assert.are.equal(1, s.alerts)
        -- An alert storm cannot turn the AI into a per-frame thinker on the
        -- sim thread: minGap is the floor.
        assert.is_false(s:due(610, true))
        assert.is_false(s:due(629, true))
        assert.is_true(s:due(630, true))
    end)

    it("still ticks on period when no alert ever comes", function()
        local s = Scheduler.new({ base = 150 })
        assert.is_true(s:due(0))
        assert.is_false(s:due(100, false))
        assert.is_true(s:due(150, false))
        assert.are.equal(0, s.alerts, 'a scheduled tick is not an alert')
    end)

end)
