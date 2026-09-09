-- lib/tests/actuator_spec.lua — rate limit, charge, containment, the floor.
-- Run from data/games/metalstorm/ai.
package.path = './?.lua;' .. package.path

local Actuator  = require('lib.actuator')
local Authority = require('lib.authority')
local D         = require('lib.directives')
local Regions   = require('lib.regions')
local FE        = require('lib.testing.fake_engine')
local Fix       = require('lib.tests.fixtures.graph')

describe("lib.actuator", function()
    local fe, regions
    before_each(function()
        Authority._setSpec(nil)
        fe = FE.new({ teamId = 0, playerId = 7, regions = Fix.regionsJson(),
                      power = Fix.powerJson(), pool = 100 }):install()
        regions = Regions.load(Fix.regionsJson())
    end)
    after_each(function() FE.uninstall(); Authority._setSpec(nil) end)

    it("has no per-unit verb, structurally", function()
        for _, verb in ipairs({ 'command', 'unit', 'move', 'attack', 'issueCommand' }) do
            assert.is_nil(Actuator[verb], verb .. ' must not exist')
        end
        -- No CODE line (comments stripped) may name the per-unit verb.
        for line in io.lines('lib/actuator.lua') do
            local code = line:gsub('%-%-.*$', '')
            assert.is_nil(code:find('issueCommand', 1, true),
                'lib/actuator.lua must never reference issueCommand: ' .. line)
        end
        assert.are.equal(0, #fe.violations)
    end)

    it("issues a directive, charges the real preview, and the drain agrees", function()
        local act = Actuator.new({ name = 't' })
        act:beginTick(150, { budget = 10 })
        local ok, cost = act:directive(D.defend(regions.north_ridge), { goal = 'hold' })
        assert.is_true(ok)
        assert.are.equal(2, cost)
        fe:drain()
        assert.are.equal(1, #fe:directives())
        assert.are.equal(2, fe.spent)
        assert.are.equal(2, act:stats().tick.spent)
        assert.are.equal('hold', act:stats().tick.log[1].meta.goal)
    end)

    it("mirrors the E6 clamp: one directive per area cell per tick", function()
        local act = Actuator.new({ name = 't' })
        act:beginTick(150, {})
        assert.is_true(act:directive(D.defend(regions.north_ridge)))
        local ok, why = act:directive(D.screen(regions.north_ridge))
        assert.is_false(ok); assert.are.equal('rate clamp', why)
        assert.is_true(act:directive(D.screen(regions.south_marsh)))
        act:beginTick(300, {})
        assert.is_true(act:directive(D.screen(regions.north_ridge)))
    end)

    it("refuses what the tick budget cannot pay, unless it is a forced DEFEND floor", function()
        local act = Actuator.new({ name = 't' })
        act:beginTick(150, { budget = 3 })
        assert.is_true(act:directive(D.defend(regions.north_ridge)))          -- 2 of 3
        local ok, why = act:directive(D.screen(regions.south_marsh))           -- would be 4
        assert.is_false(ok); assert.are.equal('over budget', why)
        assert.is_true(act:directive(D.defendFront(regions.south_marsh), nil, { force = true }))
        ok, why = act:directive(D.assault(regions.central_basin), nil, { force = true })
        assert.is_false(ok, 'force is for DEFEND types only')
        assert.are.equal('over budget', why)
    end)

    it("honours a per-tick ceiling", function()
        local act = Actuator.new({ name = 't', maxPerTick = 1 })
        act:beginTick(150, {})
        assert.is_true(act:directive(D.defend(regions.north_ridge)))
        local ok, why = act:directive(D.defend(regions.south_marsh))
        assert.is_false(ok); assert.are.equal('tick ceiling', why)
    end)

    it("makes every directive mortal and applies the tick's ttl", function()
        local act = Actuator.new({ name = 't', ttlFrames = 300 })
        act:beginTick(150, { ttlFrames = 600 })
        local spec = D.defend(regions.north_ridge)
        spec.expiresInFrames = 0
        assert.is_true(act:directive(spec))
        assert.are.equal(600, spec.expiresInFrames)
    end)

    it("contains an engine error instead of wedging the tick", function()
        fe.AI.issueDirective = function() error('boom') end
        local act = Actuator.new({ name = 't' })
        act:beginTick(150, {})
        local ok, why = act:directive(D.defend(regions.north_ridge))
        assert.is_false(ok); assert.are.equal('engine error', why)
        assert.are.equal(1, act:stats().total.errors)
        assert.is_truthy(table.concat(fe.log, '\n'):find('engine error in issueDirective'))
    end)

    it("degrades when the verb is absent (older runtime / busted with no AI)", function()
        FE.uninstall()
        local act = Actuator.new({ name = 't' })
        act:beginTick(0, {})
        local ok, why = act:directive(D.defend(regions.north_ridge))
        assert.is_false(ok); assert.are.equal('verb absent', why)
        assert.is_nil(act:group({ 1, 2 }))
        assert.is_false(act:message('ai.health', { a = 1 }))
    end)

    it("creates groups and sets postures on them through the drain", function()
        local act = Actuator.new({ name = 't' })
        act:beginTick(150, {})
        local h = act:group({ 1, 2, 3 }, D.Echelon.Platoon)
        assert.is_true(type(h) == 'number' and h < 0)
        assert.is_true(act:posture(h, { engagement = 'hold' }))
        local ok, why = act:posture(0, { engagement = 'hold' })
        assert.is_false(ok); assert.are.equal('posture needs a group', why)
        fe:drain()
        assert.are.equal('{"engagement":"hold"}', fe.groups[1].posture)
    end)

    it("encodes messages with the gadget codec and clamps size", function()
        local act = Actuator.new({ name = 't' })
        act:beginTick(150, {})
        assert.is_true(act:message('ai.health', { tick = 1, tier = 0 }))
        fe:drain()
        assert.is_truthy(fe.messages[1].text:find('cmd=ai.health', 1, true))
        local ok, why = act:message('x', { blob = string.rep('a', 3000) })
        assert.is_false(ok); assert.are.equal('message too large', why)
    end)
end)
