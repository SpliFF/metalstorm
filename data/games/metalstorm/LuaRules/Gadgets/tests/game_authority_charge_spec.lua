-- tests/game_authority_charge_spec.lua — directive/standing-order CREATE
-- charging (PLAN-metalstorm-authority.md §3.2/A2, PLAN-macro-directives.md
-- §1 "Charge point"). Drives the real AllowDirectiveCreate/
-- AllowStandingOrderCreate callins (game_authority_charge.lua) against the
-- real GG.Authority.ChargeDirective/ChargeStandingOrder (game_authority.lua)
-- via authority_charge_mock.lua.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.authority_charge_mock')

local TEAM = 1
local PLAYER = 7

local function setPools(world, playerPool, teamPool)
    world.setPlayer(PLAYER, TEAM)
    world.teamRulesParams[TEAM] = world.teamRulesParams[TEAM] or {}
    world.teamRulesParams[TEAM]['authority_player_' .. PLAYER] = playerPool
    world.teamRulesParams[TEAM]['authority_pool'] = teamPool
end

describe("group-scoped directive create (groupID ~= 0)", function()
    it("charges ceil(Σ member base * 1.0 * directive(1.0) * 1.0) from the player pool", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 15)
        world.setUnit(11, 25)
        world.setOrgGroup(TEAM, 42, { 10, 11 })
        setPools(world, 100, 100)

        local allowed = gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 0)

        assert.is_true(allowed)
        -- Σ base = 15 + 25 = 40; cost = ceil(1.0 * 40 * 1.0 * 1.0 * 1.0) = 40
        assert.are.equal(60, world.trp(TEAM, 'authority_player_' .. PLAYER))
        assert.are.equal(100, world.trp(TEAM, 'authority_pool'))  -- untouched, player pool covered it
    end)

    it("falls back to the team pool when the player pool alone can't cover it", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 40)
        world.setOrgGroup(TEAM, 42, { 10 })
        setPools(world, 10, 100)

        local allowed = gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 0)

        assert.is_true(allowed)
        -- cost = 40; player has 10 -> drains to 0, team pays the remaining 30
        assert.are.equal(0, world.trp(TEAM, 'authority_player_' .. PLAYER))
        assert.are.equal(70, world.trp(TEAM, 'authority_pool'))
    end)

    it("refuses (no debit at all) when neither pool combination covers the cost", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 40)
        world.setOrgGroup(TEAM, 42, { 10 })
        setPools(world, 5, 5)

        local allowed = gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 0)

        assert.is_false(allowed)
        assert.are.equal(5, world.trp(TEAM, 'authority_player_' .. PLAYER))
        assert.are.equal(5, world.trp(TEAM, 'authority_pool'))
    end)

    it("sums the LIVE roster, not requestedStrength", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 15)
        world.setUnit(11, 25)
        world.setOrgGroup(TEAM, 42, { 10, 11 })
        setPools(world, 100, 100)

        -- requestedStrength (2000) must not leak into the cost basis.
        gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 2000)

        assert.are.equal(60, world.trp(TEAM, 'authority_player_' .. PLAYER))
    end)

    it("costs (and charges) nothing for an unresolved/empty group id", function()
        local world, gadgetObj = mock.new()
        setPools(world, 100, 100)

        local allowed = gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 999, 9, 0)

        assert.is_true(allowed)
        assert.are.equal(100, world.trp(TEAM, 'authority_player_' .. PLAYER))
    end)

    it("defaults an unknown unit's base to 1, same as OrderCost's single-unit resolution", function()
        local world, gadgetObj = mock.new()
        -- Unit 10 registered with the group but never given a customParams
        -- entry (world.setUnit not called for it) — GetUnitDefID returns nil.
        world.setOrgGroup(TEAM, 42, { 10 })
        setPools(world, 100, 100)

        gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 0)

        -- base falls back to 1 -> cost = ceil(1 * 1.0 * 1.0 * 1.0) = 1
        assert.are.equal(99, world.trp(TEAM, 'authority_player_' .. PLAYER))
    end)
end)

describe("condition/area-scoped directive create (groupID == 0)", function()
    it("charges a flat base=1 fee under the 'standing' class, not scaled by strength", function()
        local world, gadgetObj = mock.new()
        setPools(world, 100, 100)

        local allowed = gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 0, 0, 5000)

        assert.is_true(allowed)
        -- cost = ceil(1.0 * 1 * 1.0 * 1.2 * 1.0) = 2 (order_class.standing = 1.2)
        assert.are.equal(98, world.trp(TEAM, 'authority_player_' .. PLAYER))
    end)
end)

describe("classic StandingOrderCreate wire (legacy path)", function()
    it("charges the same flat 'standing' fee as a condition-scoped directive", function()
        local world, gadgetObj = mock.new()
        setPools(world, 100, 100)

        local allowed = gadgetObj:AllowStandingOrderCreate(TEAM, PLAYER, 0)

        assert.is_true(allowed)
        assert.are.equal(98, world.trp(TEAM, 'authority_player_' .. PLAYER))
    end)

    it("refuses when both pools are broke", function()
        local world, gadgetObj = mock.new()
        setPools(world, 1, 0)

        local allowed = gadgetObj:AllowStandingOrderCreate(TEAM, PLAYER, 0)

        assert.is_false(allowed)
        assert.are.equal(1, world.trp(TEAM, 'authority_player_' .. PLAYER))
    end)
end)

describe("unknown playerID (-1 sentinel for a missing clientPlayerNum entry)", function()
    it("charges the team pool only, same as a nil playerID", function()
        local world, gadgetObj = mock.new()
        setPools(world, 0, 100)

        local allowed = gadgetObj:AllowDirectiveCreate(TEAM, -1, 0, 0, 0)

        assert.is_true(allowed)
        assert.are.equal(98, world.trp(TEAM, 'authority_pool'))
    end)
end)

describe("defensive: GG.Authority not yet Initialized", function()
    it("allows everything without touching pools (matches AllowCommand's own guard)", function()
        local world, gadgetObj = mock.new()
        _G.GG.Authority = nil
        setPools(world, 100, 100)

        assert.is_true(gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 0))
        assert.is_true(gadgetObj:AllowStandingOrderCreate(TEAM, PLAYER, 0))
        assert.are.equal(100, world.trp(TEAM, 'authority_player_' .. PLAYER))
    end)
end)
