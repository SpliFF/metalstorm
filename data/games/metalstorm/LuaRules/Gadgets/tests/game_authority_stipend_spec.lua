-- tests/game_authority_stipend_spec.lua — the periodic team stipend (§2), and
-- specifically that a server which fell behind cannot take it away (D15).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.authority_charge_mock')

local STIPEND_PERIOD = 1800    -- game_authority.lua's STIPEND_PERIOD_FRAMES

-- The player exists so team 0 does (GetTeamList is derived from the roster) and
-- is registered as NOT ARRIVED: GameStart seeds a join grant into every ACTIVE
-- player, and this file's subject is the team stipend, so an arrived player
-- would put 100 minted authority into every ledger assertion below.
local function stipendWorld(perMinute)
    local world, gadgetObj = mock.new()
    world.setPlayer(1, 0, false)
    world.modOptions.authority_team_stipend = perMinute
    gadgetObj:GameStart()
    return world, gadgetObj
end

describe("team stipend (§2)", function()
    it("is opt-in: no stipend modoption pays nothing", function()
        local world, gadgetObj = mock.new()
        world.setPlayer(1, 0, false)   -- see stipendWorld
        gadgetObj:GameStart()
        local before = world.trp(0, 'authority_pool')
        gadgetObj:GameFrame(STIPEND_PERIOD)
        assert.are.equal(before, world.trp(0, 'authority_pool'))
    end)

    it("pays once per minute of sim", function()
        local world, gadgetObj = stipendWorld(25)
        local before = world.trp(0, 'authority_pool')
        gadgetObj:GameFrame(STIPEND_PERIOD)
        assert.are.equal(before + 25, world.trp(0, 'authority_pool'))
        gadgetObj:GameFrame(STIPEND_PERIOD * 2)
        assert.are.equal(before + 50, world.trp(0, 'authority_pool'))
    end)

    it("pays nothing before the first minute is up", function()
        local world, gadgetObj = stipendWorld(25)
        local before = world.trp(0, 'authority_pool')
        gadgetObj:GameFrame(1)
        gadgetObj:GameFrame(900)
        gadgetObj:GameFrame(STIPEND_PERIOD - 1)
        assert.are.equal(before, world.trp(0, 'authority_pool'))
    end)

    -- D15: the gate was `frame % STIPEND_PERIOD_FRAMES == 0`. When the server
    -- logs `sim fell behind, skipped N ticks` the engine never calls GameFrame
    -- for the skipped frames, so the exact multiple simply never arrives and a
    -- whole minute's income vanished — a team losing what it had earned to
    -- machine load, which is the same asymmetry D57/D58 removed from the hold
    -- clock. Income accrues per elapsed period now, not per multiple hit.
    it("still pays the minute whose boundary frame was skipped", function()
        local world, gadgetObj = stipendWorld(25)
        local before = world.trp(0, 'authority_pool')
        gadgetObj:GameFrame(STIPEND_PERIOD + 1)          -- 1800 never arrived
        assert.are.equal(before + 25, world.trp(0, 'authority_pool'))
        gadgetObj:GameFrame(STIPEND_PERIOD + 2)          -- and does not pay twice
        assert.are.equal(before + 25, world.trp(0, 'authority_pool'))
    end)

    it("pays every minute a long stall stepped over", function()
        local world, gadgetObj = stipendWorld(25)
        local before = world.trp(0, 'authority_pool')
        gadgetObj:GameFrame(STIPEND_PERIOD * 5 + 7)      -- five minutes, one call
        assert.are.equal(before + 125, world.trp(0, 'authority_pool'))
    end)

    it("records the catch-up as one ledger award, not N", function()
        local world, gadgetObj = stipendWorld(25)
        gadgetObj:GameFrame(STIPEND_PERIOD * 4 + 3)
        -- The ledger publishes minted authority by class; a four-minute
        -- catch-up must show up as 100 minted, whatever the row count.
        gadgetObj:GameFrame(STIPEND_PERIOD * 4 + 900)    -- force a ledger publish
        assert.are.equal(100, world.trp(0, 'econ_mint'))
    end)
end)
