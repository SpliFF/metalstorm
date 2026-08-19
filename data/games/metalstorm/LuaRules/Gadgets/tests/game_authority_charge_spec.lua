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

-- PLAN-metalstorm-objectives.md §5 "last_commander notes" (review A7).
-- Decided 2026-07-12, recorded as resolved, and never built: measured live on
-- the player path 2026-08-04, a committed directive charged its author and
-- left every unit unstamped, so objectives/attribution.lua saw an empty
-- participation map and `score_<player>_objectives` could only read 0
-- (endtoend D11's third symptom).
describe("directive-create attribution stamp (objectives §5 / A7)", function()
    it("stamps last_commander on every member of the charged group", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 15)
        world.setUnit(11, 25)
        world.setOrgGroup(TEAM, 42, { 10, 11 })
        setPools(world, 100, 100)

        assert.is_true(gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 0))

        assert.are.equal(PLAYER, world.urp(10, 'last_commander'))
        assert.are.equal(PLAYER, world.urp(11, 'last_commander'))
    end)

    it("does not stamp when the charge is refused (no credit for work not done)", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 500)
        world.setOrgGroup(TEAM, 42, { 10 })
        setPools(world, 1, 1)

        assert.is_false(gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 0))
        assert.is_nil(world.urp(10, 'last_commander'))
    end)

    it("re-stamps a group directed by a second commander", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        world.setOrgGroup(TEAM, 42, { 10 })
        setPools(world, 100, 100)
        world.setPlayer(8, TEAM)
        world.teamRulesParams[TEAM]['authority_player_8'] = 100

        assert.is_true(gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 42, 9, 0))
        assert.are.equal(PLAYER, world.urp(10, 'last_commander'))
        assert.is_true(gadgetObj:AllowDirectiveCreate(TEAM, 8, 42, 9, 0))
        assert.are.equal(8, world.urp(10, 'last_commander'))
    end)

    it("stamps nothing for an unattributed directive (playerID -1 -> nil)", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        world.setOrgGroup(TEAM, 42, { 10 })
        setPools(world, 0, 100)

        assert.is_true(gadgetObj:AllowDirectiveCreate(TEAM, -1, 42, 9, 0))
        assert.is_nil(world.urp(10, 'last_commander'))
    end)

    -- endtoend D24: the composer's canned subjects ("Idle infantry") compile to
    -- groupId 0, which has no roster at create time, so the CREATE-time stamp
    -- cannot reach them.
    --
    -- CHANGED DELIBERATELY 2026-08-06 (objectives §5.1). This case previously
    -- asserted only the first half and read as "condition-scoped directives are
    -- unattributable". That is still true AT CREATE — and now it is only half
    -- the story: the author is attached per unit at DECOMPOSITION instead (see
    -- the "decomposition attribution stamp" describe below). Kept, rather than
    -- deleted, because the create-time half is a real and deliberate boundary:
    -- a flat administrative fee buys a standing intent, not a roster.
    it("does not stamp a condition-scoped directive at CREATE (groupID 0) — D24", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        setPools(world, 100, 100)

        assert.is_true(gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 0, 9, 0))
        assert.is_nil(world.urp(10, 'last_commander'))
    end)
end)

-- PLAN-metalstorm-objectives.md §5.1 (endtoend D24), decided 2026-08-06.
-- The composer offers a fresh player ONLY condition-scoped subjects ("Idle
-- armour", "Idle infantry", ...), which compile to groupId 0 and so have no
-- roster the create-time stamp above can reach. Measured live on a won war:
-- 12/13 units moved, `units_with_last_commander = 0/13`, participation empty,
-- the 300-point victory award paid 100% to the team pool, every
-- `score_*_objectives = 0.0`.
--
-- The fix attaches the author at DECOMPOSITION: the engine's two decomposition
-- sites (OrgGroups.cpp IssueDirectiveCommand, StandingOrders.cpp
-- IssueCommandFor) now issue via GiveCommand(cmd, authorPlayerId, fromSynced,
-- fromLua=true), so the author arrives at this gadget's ordinary AllowCommand
-- hook. These specs drive that hook directly with the argument shape the
-- engine sends.
describe("decomposition attribution stamp (objectives §5.1 / D24)", function()
    -- The engine's AllowCommand signature (LuaHandleSynced.cpp): the last three
    -- args are playerID, fromSynced, fromLua.
    local CMD_FIGHT = 16

    local function allowCommand(gadgetObj, unitID, playerID, fromSynced, fromLua)
        return gadgetObj:AllowCommand(unitID, 0, TEAM, CMD_FIGHT, { 0, 0, 0 }, {}, 0,
                                      playerID, fromSynced, fromLua)
    end

    it("stamps last_commander when a directive moves a unit on its author's behalf", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        setPools(world, 100, 100)

        -- fromSynced + fromLua + a REAL playerNum = a decomposed directive
        -- command. Free (already charged at create) but attributable.
        assert.is_true(allowCommand(gadgetObj, 10, PLAYER, true, true))

        assert.are.equal(PLAYER, world.urp(10, 'last_commander'))
        -- and it cost nothing: the directive create paid, not this command
        assert.are.equal(100, world.trp(TEAM, 'authority_player_' .. PLAYER))
        assert.are.equal(100, world.trp(TEAM, 'authority_pool'))
    end)

    it("closes D24: a condition-scoped directive's units end up attributed", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        world.setUnit(11, 5)
        setPools(world, 100, 100)

        -- Create charges the flat 'standing' fee and stamps nothing...
        assert.is_true(gadgetObj:AllowDirectiveCreate(TEAM, PLAYER, 0, 9, 0))
        assert.are.equal(98, world.trp(TEAM, 'authority_player_' .. PLAYER))
        assert.is_nil(world.urp(10, 'last_commander'))

        -- ...then the evaluator draws two idle squads in and decomposes.
        assert.is_true(allowCommand(gadgetObj, 10, PLAYER, true, true))
        assert.is_true(allowCommand(gadgetObj, 11, PLAYER, true, true))

        assert.are.equal(PLAYER, world.urp(10, 'last_commander'))
        assert.are.equal(PLAYER, world.urp(11, 'last_commander'))
        assert.are.equal(98, world.trp(TEAM, 'authority_player_' .. PLAYER))  -- still just the fee
    end)

    it("does not stamp an ordinary gadget order (fromLua with playerID -1)", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        setPools(world, 100, 100)

        -- Every Spring.GiveOrderToUnit-family call in LuaSyncedCtrl.cpp passes
        -- -1, which is what keeps §5's "free/fromLua commands that are not
        -- directive decompositions still don't reassign credit" true.
        assert.is_true(allowCommand(gadgetObj, 10, -1, true, true))
        assert.is_nil(world.urp(10, 'last_commander'))
    end)

    it("does not stamp an engine-internal order (fromSynced, not fromLua)", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        setPools(world, 100, 100)

        -- The 2-arg GiveCommand form passes the TEAM LEADER's playerNum with
        -- fromLua = false (factory exit moves, transport unloads, ...). A real
        -- playerNum, but nobody decided anything — must not stamp.
        assert.is_true(allowCommand(gadgetObj, 10, PLAYER, true, false))
        assert.is_nil(world.urp(10, 'last_commander'))
    end)

    it("re-stamps when a second directive picks the unit up", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        setPools(world, 100, 100)
        world.setPlayer(8, TEAM)

        assert.is_true(allowCommand(gadgetObj, 10, PLAYER, true, true))
        assert.are.equal(PLAYER, world.urp(10, 'last_commander'))
        -- last_commander is single-valued and last-write-wins: whoever's
        -- directive is moving the unit NOW owns the credit (§5.1 edges).
        assert.is_true(allowCommand(gadgetObj, 10, 8, true, true))
        assert.are.equal(8, world.urp(10, 'last_commander'))
    end)

    it("still charges and stamps a direct player order (unchanged path)", function()
        local world, gadgetObj = mock.new()
        world.setUnit(10, 5)
        setPools(world, 100, 100)

        -- A hand-issued order off the wire: neither fromSynced nor fromLua.
        assert.is_true(allowCommand(gadgetObj, 10, PLAYER, false, false))

        assert.are.equal(PLAYER, world.urp(10, 'last_commander'))
        assert.is_true(world.trp(TEAM, 'authority_player_' .. PLAYER) < 100)
    end)
end)
