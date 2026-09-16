-- tests/game_authority_field_engineering_spec.lua — the field-engineering
-- gate as WIRED (manual §6/§12; review 2026-09-10): the AllowCommand veto in
-- game_authority.lua (layer -100) and the charge in game_authority_charge.lua
-- (+100), replayed in the handler's order by authority_charge_mock's
-- `world.allowCommand`, plus the AllowUnitCreation backstop and the modoption
-- escape hatch.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
--
-- Every order here is a FABRICATED violation: no shipped scenario issues a
-- factory build, so without these the gate would be a rule nothing exercises.

package.path = './?.lua;' .. package.path

local mock = require('tests.authority_charge_mock')

local TEAM, PLAYER = 1, 7
local FOUNDRY_UNIT = 10        -- a unit that is a factory
local ENGINEER_UNIT = 11       -- a unit that is a builder
local DEF_TANK, DEF_TOWER, DEF_FOUNDRY = 5001, 5002, 5003

local function setup(modOptions)
    local world, gadgetObj = mock.new()
    for k, v in pairs(modOptions or {}) do world.modOptions[k] = v end
    world.setPlayer(PLAYER, TEAM)
    world.teamRulesParams[TEAM] = { ['authority_player_' .. PLAYER] = 1000, authority_pool = 1000 }
    world.setUnit(FOUNDRY_UNIT, 10)
    world.setUnit(ENGINEER_UNIT, 2)
    world.setDef(DEF_TANK,    { name = 'ms_tanks_s2', isBuilding = false })
    world.setDef(DEF_TOWER,   { name = 'ms_watchtower', isBuilding = true,
                                customParams = { building_family = 'support' } })
    world.setDef(DEF_FOUNDRY, { name = 'ms_foundry', isBuilding = true,
                                customParams = { building_family = 'military' } })
    gadgetObj:Initialize()
    return world, gadgetObj
end

local function pools(world)
    return world.trp(TEAM, 'authority_player_' .. PLAYER), world.trp(TEAM, 'authority_pool')
end

describe("field engineering gate — build orders", function()
    it("vetoes a factory producing a tank, and the vetoed order is NEVER charged", function()
        local world = setup()
        local allowed = world.allowCommand(FOUNDRY_UNIT, nil, TEAM, -DEF_TANK, {}, {}, 0,
                                           PLAYER, false, false)
        assert.is_false(allowed)
        local player, team = pools(world)
        assert.are.equal(1000, player)
        assert.are.equal(1000, team)
    end)

    it("vetoes placing a Foundry (base structure), uncharged", function()
        local world = setup()
        assert.is_false(world.allowCommand(ENGINEER_UNIT, nil, TEAM, -DEF_FOUNDRY, {}, {}, 0,
                                           PLAYER, false, false))
        assert.are.equal(1000, (pools(world)))
    end)

    it("allows a watchtower (support tier) and bills it as a build order", function()
        local world = setup()
        assert.is_true(world.allowCommand(ENGINEER_UNIT, nil, TEAM, -DEF_TOWER, {}, {}, 0,
                                          PLAYER, false, false))
        -- cost = ceil(1.0 * base 2 * region 1.0 * build 3.0 * 1.0) = 6
        assert.are.equal(994, (pools(world)))
    end)

    it("leaves non-build orders to the other gadgets (cmdID >= 0 passes through)", function()
        local world = setup()
        assert.is_true(world.allowCommand(ENGINEER_UNIT, nil, TEAM, 10, {}, {}, 0,
                                          PLAYER, false, false))
    end)

    it("vetoes an AI/Lua-issued factory order too (fromLua is free, not exempt)", function()
        local world = setup()
        assert.is_false(world.allowCommand(FOUNDRY_UNIT, nil, TEAM, -DEF_TANK, {}, {}, 0,
                                           PLAYER, false, true))
    end)

    it("lifts the gate under the battle_production modoption, spelled the way Spring spells it", function()
        local world = setup({ battle_production = '1' })
        assert.is_true(world.allowCommand(FOUNDRY_UNIT, nil, TEAM, -DEF_TANK, {}, {}, 0,
                                          PLAYER, false, false))
        assert.are.equal(1, world.gameRulesParams.battle_production)
        -- The lifted build still costs what a build costs.
        assert.are.equal(1000 - 30, (pools(world)))
    end)

    it("publishes the gate's state so a HUD can say it is on", function()
        local world = setup()
        assert.are.equal(0, world.gameRulesParams.battle_production)
    end)

    it("logs a veto once per team+def, not once per click", function()
        local world = setup()
        local echoes = 0
        Spring.Echo = function(msg)
            if msg:find('field engineering only', 1, true) then echoes = echoes + 1 end
        end
        for _ = 1, 5 do
            world.allowCommand(FOUNDRY_UNIT, nil, TEAM, -DEF_TANK, {}, {}, 0, PLAYER, false, false)
        end
        assert.are.equal(1, echoes)
    end)
end)

describe("field engineering gate — AllowUnitCreation backstop", function()
    it("refuses factory output at creation and drops the order", function()
        local world = setup()
        local allow, drop = world.allowUnitCreation(DEF_TANK, FOUNDRY_UNIT, TEAM)
        assert.is_false(allow)
        assert.is_true(drop)
    end)

    it("admits a support building placed by a builder", function()
        local world = setup()
        local allow = world.allowUnitCreation(DEF_TOWER, ENGINEER_UNIT, TEAM, 100, 0, 100, 0)
        assert.is_true(allow)
    end)

    it("refuses a def it cannot classify", function()
        local world = setup()
        assert.is_false(world.allowUnitCreation(999999, FOUNDRY_UNIT, TEAM))
    end)

    it("answers the same question through GG.Authority.MayBuildInBattle", function()
        local world = setup()
        local ok, why = GG.Authority.MayBuildInBattle(DEF_TANK, TEAM)
        assert.is_false(ok)
        assert.are.equal('production', why)
        ok, why = GG.Authority.MayBuildInBattle(DEF_TOWER, TEAM)
        assert.is_true(ok)
        assert.are.equal('field_engineering', why)
    end)
end)
