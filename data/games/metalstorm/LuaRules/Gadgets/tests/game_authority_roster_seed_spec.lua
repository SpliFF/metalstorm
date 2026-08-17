-- tests/game_authority_roster_seed_spec.lua — GameStart's roster seed, and
-- specifically the `activeOnly` filter on it (PLAN-metalstorm-wars.md §8.1).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
--
-- Why this file exists: a war is spawned with Σ slotCap EMPTY player slots so a
-- dynamic joiner has a seat to land on. Those rows are in the player list from
-- frame 0 with nobody in them. Seeding them at GameStart mints one JOIN_GRANT
-- per empty chair into a pool nobody can spend, and tags the team ledger with
-- awards no player ever received — invisible until a war has real drop-ins,
-- which is exactly the kind of regression a reverted `true` argument would
-- reintroduce silently.

package.path = './?.lua;' .. package.path

local mock = require('tests.authority_charge_mock')

local JOIN_GRANT = 100          -- game_authority.lua's default authority_join_grant

describe("GameStart roster seed (§6, wars §8.1)", function()
    it("grants a join grant to a player who has actually arrived", function()
        local world, gadgetObj = mock.new()
        world.setPlayer(0, 0)                   -- active by default
        gadgetObj:GameStart()

        assert.are.equal(1, world.gameRulesParams['authority_granted_0'])
        assert.are.equal(JOIN_GRANT, world.trp(0, 'authority_player_0'))
    end)

    it("pays nothing into a pre-allocated seat nobody has arrived on", function()
        local world, gadgetObj = mock.new()
        world.setPlayer(0, 0)                   -- a player
        world.setPlayer(1, 0, false)            -- a seat held for a joiner
        world.setPlayer(2, 0, false)            -- and another
        gadgetObj:GameStart()

        -- The arrived player is paid exactly once...
        assert.are.equal(1, world.gameRulesParams['authority_granted_0'])
        assert.are.equal(JOIN_GRANT, world.trp(0, 'authority_player_0'))
        -- ...and the empty chairs earn nothing, and are not even marked as
        -- granted — so the real joiner still gets paid when they land.
        assert.is_nil(world.gameRulesParams['authority_granted_1'])
        assert.is_nil(world.gameRulesParams['authority_granted_2'])
        assert.is_nil(world.trp(0, 'authority_player_1'))
        assert.is_nil(world.trp(0, 'authority_player_2'))
    end)

    it("still pays the joiner when they land on their pre-allocated seat", function()
        local world, gadgetObj = mock.new()
        world.setPlayer(0, 0)
        world.setPlayer(1, 0, false)
        gadgetObj:GameStart()
        assert.is_nil(world.gameRulesParams['authority_granted_1'])

        -- The server delivers PlayerAdded on the authenticated join
        -- (PlayerOnboarding.h) — the same call GameStart's loop makes.
        world.setPlayer(1, 0, true)
        gadgetObj:PlayerAdded(1)

        assert.are.equal(1, world.gameRulesParams['authority_granted_1'])
        assert.are.equal(JOIN_GRANT, world.trp(0, 'authority_player_1'))
    end)
end)
