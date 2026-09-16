-- tests/game_authority_decay_spec.lua — the soft ceiling with overflow decay
-- (PLAN-metalstorm-economy.md §3 lever 1) and the metrics exports/publish.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
--
-- Pins two 2026-09-10 review findings: the decay applied its PER-MINUTE
-- percentage on every 30 s period (double the documented rate), and
-- GG.Authority.ExportMetrics / IsOverflowing referenced pool accessors that
-- were declared as locals further down the file — globals at call time, nil.

package.path = './?.lua;' .. package.path

local mock = require('tests.authority_charge_mock')

local PERIOD  = 900        -- authority_cost.lua economy.overflow_decay_period
local CEILING = 6000       -- economy.soft_ceiling_C_base
local PCT     = 2          -- economy.overflow_decay_pct, PER MINUTE
local PER_PERIOD = PCT / 100 * PERIOD / 1800   -- 1 % per 30 s tick

local TEAM, PLAYER = 0, 1

local function world(playerPool, teamPool)
    local w, g = mock.new()
    w.setPlayer(PLAYER, TEAM)
    w.teamRulesParams[TEAM] = { ['authority_player_' .. PLAYER] = playerPool, authority_pool = teamPool }
    g:Initialize()
    return w, g
end

describe("overflow decay", function()
    it("decays a player's excess at the documented rate per MINUTE, sharing it team-ward", function()
        local w, g = world(CEILING + 2000, 0)
        g:GameFrame(PERIOD)
        -- 1 % of the 2000 excess per 30 s period = 20, floored to integers.
        local expected = CEILING + math.floor(2000 * (1 - PER_PERIOD))
        assert.are.equal(expected, w.trp(TEAM, 'authority_player_' .. PLAYER))
        assert.are.equal((CEILING + 2000) - expected, w.trp(TEAM, 'authority_pool'))
        -- Nothing was minted or destroyed on the player side: a `move`.
        assert.are.equal((CEILING + 2000) - expected, w.trp(TEAM, 'econ_move') or
            (function() g:GameFrame(PERIOD * 2) return w.trp(TEAM, 'econ_move') end)())
    end)

    it("destroys a team's excess above its own ceiling (the sink of last resort)", function()
        local w, g = world(0, CEILING + 1000)
        g:GameFrame(PERIOD)
        local expected = CEILING + math.floor(1000 * (1 - PER_PERIOD))
        assert.are.equal(expected, w.trp(TEAM, 'authority_pool'))
    end)

    it("leaves pools under the ceiling untouched", function()
        local w, g = world(500, 4000)
        g:GameFrame(PERIOD * 3)
        assert.are.equal(500, w.trp(TEAM, 'authority_player_' .. PLAYER))
        assert.are.equal(4000, w.trp(TEAM, 'authority_pool'))
    end)

    it("compounds over periods a stalled server stepped over", function()
        local w, g = world(0, CEILING + 1000)
        g:GameFrame(PERIOD * 4)
        local expected = CEILING + math.floor(1000 * (1 - PER_PERIOD) ^ 4)
        assert.are.equal(expected, w.trp(TEAM, 'authority_pool'))
    end)

    it("keeps every pool an integer", function()
        local w, g = world(CEILING + 333, CEILING + 777)
        g:GameFrame(PERIOD * 7)
        local p, t = w.trp(TEAM, 'authority_player_' .. PLAYER), w.trp(TEAM, 'authority_pool')
        assert.are.equal(p, math.floor(p))
        assert.are.equal(t, math.floor(t))
    end)
end)

describe("metrics exports", function()
    it("ExportMetrics returns a row per staffed team without raising", function()
        local w = world(100, 500)
        local out = GG.Authority.ExportMetrics()
        assert.is_table(out[TEAM])
        assert.are.equal(1.0, out[TEAM].velocity)
        assert.are.equal(0.6, out[TEAM].poolRatio)
        assert.are.equal(0, out[TEAM].deadTimeMin)
    end)

    it("IsOverflowing reports the excess for a player and a team", function()
        local w = world(CEILING + 50, CEILING * 2 + 10)
        local over, ceiling, excess = GG.Authority.IsOverflowing(PLAYER, TEAM)
        assert.is_true(over)
        assert.are.equal(CEILING, ceiling)
        assert.are.equal(50, excess)
        over, ceiling, excess = GG.Authority.IsOverflowing(nil, TEAM)
        assert.is_true(over)
        assert.are.equal(CEILING, ceiling)          -- one player on the team
        assert.are.equal(CEILING + 10, excess)
    end)

    it("publishes econ_velocity / econ_pool_ratio / econ_dead_frames on the ledger cadence", function()
        local w, g = world(100, 500)
        g:GameFrame(900)
        assert.are.equal(1.0, w.trp(TEAM, 'econ_velocity'))
        assert.are.equal(0.6, w.trp(TEAM, 'econ_pool_ratio'))
        assert.are.equal(0, w.trp(TEAM, 'econ_dead_frames'))
        assert.are.equal(0, w.trp(TEAM, 'econ_mint_rate'))
    end)
end)
