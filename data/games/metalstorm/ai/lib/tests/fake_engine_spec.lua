-- lib/tests/fake_engine_spec.lua — the double must behave like the drain.
-- Run from data/games/metalstorm/ai.
package.path = './?.lua;' .. package.path

local FE  = require('lib.testing.fake_engine')
local Fix = require('lib.tests.fixtures.graph')

local function circle(x, z, extra)
    local spec = { type = 10, priority = 100, shape = 1, params = { x, 0, z, 500 },
                   expiresInFrames = 300 }
    for k, v in pairs(extra or {}) do spec[k] = v end
    return spec
end

describe("lib.testing.fake_engine", function()
    local fe
    before_each(function()
        fe = FE.new({ teamId = 0, playerId = 7, regions = Fix.regionsJson(),
                      power = Fix.powerJson(), pool = 5 }):install()
    end)
    after_each(function() FE.uninstall() end)

    it("exposes the real surface with the real shapes", function()
        for _, name in ipairs({ 'getOwnUnits', 'getVisibleEnemies', 'getRadarBlips', 'issueCommand',
                                'getFrame', 'getMapSize', 'getTeamId', 'getPlayerId', 'getRulesParam',
                                'getMapData', 'getDefExport', 'log', 'nowMs', 'createGroup',
                                'issueDirective', 'setPosture', 'sendMessage' }) do
            assert.are.equal('function', type(AI[name]), name)
        end
        fe:setOwnUnits({ { id = 1, defId = 101, x = 1, z = 2, health = 0.5, hasCommands = true } })
        fe:setEnemies({ { id = 9, defId = 101, x = 3, y = 9, z = 4, health = 1.0, hasCommands = true } })
        local own = AI.getOwnUnits()[1]
        assert.are.same({ id = 1, defId = 101, x = 1, y = 0, z = 2, health = 0.5, hasCommands = true }, own)
        local e = AI.getVisibleEnemies()[1]
        assert.are.same({ id = 9, defId = 101, x = 3, z = 4, health = 1.0 }, e, 'enemies carry no y/hasCommands')
        assert.has_error(function() AI.getMapData('../secret.json') end)
        assert.is_nil(AI.getMapData('missing.json'))
        assert.are.equal('North Ridge', AI.getMapData('regions.json').regions[1].name)
        assert.are.equal(5, AI.getRulesParam('team', 'authority_player_7'))
    end)

    it("resolves same-batch group tokens and drops a directive on a foreign group", function()
        local h = AI.createGroup({ 1, 2 }, 1)
        assert.are.equal(-1, h)
        AI.issueDirective(h, circle(500, 500))
        AI.setPosture(h, '{"engagement":"hold"}')
        AI.issueDirective(42, circle(1500, 500))
        fe:drain()
        assert.are.equal(1, #fe:directives())
        assert.are.equal(1, fe:directives()[1].resolvedGroup)
        assert.are.equal('{"engagement":"hold"}', fe.groups[1].posture)
        assert.are.equal(1, #fe.refused)
        assert.are.equal('foreign or unknown group', fe.refused[1].reason)
    end)

    it("applies the E6 clamp per area cell and the authority veto", function()
        AI.issueDirective(0, circle(500, 500))       -- 2
        AI.issueDirective(0, circle(510, 510))       -- same cell → clamp
        AI.issueDirective(0, circle(1500, 500))      -- 2 → pool 1
        AI.issueDirective(0, circle(1500, 1500))     -- 2 > 1 → veto
        fe:drain()
        assert.are.equal(2, #fe:directives())
        assert.are.equal(4, fe.spent)
        assert.are.equal(1, fe.pool)
        assert.are.equal(1, AI.getRulesParam('team', 'authority_player_7'))
        assert.are.equal('E6 rate clamp', fe.refused[1].reason)
        assert.are.equal('authority veto', fe.refused[2].reason)
    end)

    it("prices a group-scoped directive off the roster's power entries", function()
        fe:setPool(100)
        fe:setOwnUnits({ { id = 1, defId = 103, x = 1, z = 1, health = 1 },
                         { id = 2, defId = 101, x = 1, z = 1, health = 1 } })
        local h = AI.createGroup({ 1, 2 }, 1)
        AI.issueDirective(h, circle(500, 500))
        fe:drain()
        assert.are.equal(4, fe:directives()[1].cost)   -- ceil(1 × (3+1) × 1 × 1.0 × 1)
    end)

    it("budgets LuaMsg deliveries per batch and clamps oversize at push", function()
        assert.is_false(AI.sendMessage(string.rep('x', 3000)))
        for i = 1, 20 do assert.is_true(AI.sendMessage('cmd=x&i=' .. i)) end
        fe:drain()
        assert.are.equal(16, #fe.messages)
        assert.are.equal(4, #fe.refused)
    end)

    it("records a per-unit command as a violation, never as an applied command", function()
        AI.issueCommand(1, 10, 100, 0, 200)
        fe:drain()
        assert.are.equal(1, #fe.violations)
        assert.are.equal(0, #fe.applied)
    end)

    it("steps the clock like AIRuntimePool and contains onUpdate errors", function()
        local calls = {}
        fe:step(35, function(f) calls[#calls + 1] = f; if f == 20 then error('tick boom') end end)
        assert.are.same({ 10, 20, 30 }, calls)
        assert.are.equal(1, #fe.errors)
        assert.are.equal(35, fe.frame)
    end)

    it("marshals idleOnly the way lua_toboolean does", function()
        fe:setPool(50)
        AI.issueDirective(0, circle(300, 300))
        AI.issueDirective(0, circle(900, 300, { idleOnly = true }))
        AI.issueDirective(0, circle(1500, 300, { idleOnly = false }))
        fe:drain()
        local d = fe:directives()
        assert.are.equal(3, #d)
        assert.are.equal(false, d[1].idleOnly, 'absent ⇒ false (the AI drain default)')
        assert.are.equal(true, d[2].idleOnly)
        assert.are.equal(false, d[3].idleOnly)
    end)

    it("withholds non-public game params, the way the snapshot's LOS mask does", function()
        fe:setRulesParam('game', 'region_north_ridge_team', 0)
        fe:setRulesParam('game', 'enemy_secret_plan', 42, 'private')
        assert.are.equal(0, AI.getRulesParam('game', 'region_north_ridge_team'))
        assert.is_nil(AI.getRulesParam('game', 'enemy_secret_plan'),
            'only RULESPARAMLOS_PUBLIC entries cross the side boundary')
        assert.are.equal(42, fe:maskedValue('enemy_secret_plan'))
        -- Our OWN team params are private-readable by their owner.
        fe:setRulesParam('team', 'authority_pool', 120)
        assert.are.equal(120, AI.getRulesParam('team', 'authority_pool'))
    end)

    it("can model the production VM, in which issueCommand is not registered", function()
        FE.uninstall()
        local prod = FE.new({ teamId = 0, playerId = 7, exposeIssueCommand = false }):install()
        assert.is_nil(AI.issueCommand, 'directives are the only actuation path (2026-09-16)')
        assert.are.equal(0, #prod.violations)
        assert.is_function(AI.issueDirective)
    end)

end)
