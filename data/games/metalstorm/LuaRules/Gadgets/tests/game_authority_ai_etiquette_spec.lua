-- tests/game_authority_ai_etiquette_spec.lua — AI3 charge attribution +
-- the co-commander own-pool-only invariant (PLAN-metalstorm-ai.md §5,
-- PLAN-metalstorm-authority.md §3.2). AI slots are real virtual players, so
-- an AI's directive charges its OWN player pool (authority_player_<aiID>) via
-- the same AllowDirectiveCreate path a human takes. A co-commander AI is
-- additionally flagged own-pool-only (GG.Authority.SetOwnPoolOnly) so it can
-- NEVER fall back to the shared team pool — that is the enforceable form of
-- "own pool only, never the team fallback".
--
-- Drives the REAL game_authority.lua + game_authority_charge.lua pair via
-- authority_charge_mock.lua (same harness as game_authority_charge_spec.lua).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.authority_charge_mock')

local TEAM     = 1
local AI       = 7    -- the AI's virtual playerID
local HUMAN    = 3    -- a human teammate sharing the team

local function seed(world, aiPool, teamPool)
    world.setPlayer(AI, TEAM)
    world.teamRulesParams[TEAM] = world.teamRulesParams[TEAM] or {}
    world.teamRulesParams[TEAM]['authority_player_' .. AI] = aiPool
    world.teamRulesParams[TEAM]['authority_pool'] = teamPool
end

-- Group whose Σ base = 40 → a group-scoped directive costs 40.
local function seedGroup(world)
    world.setUnit(10, 40)
    world.setOrgGroup(TEAM, 42, { 10 })
end

describe("AI3 charge attribution (AI directive debits its OWN pool)", function()
    it("charges authority_player_<aiID>, never the team pool, when the AI can cover it", function()
        local world, g = mock.new()
        seedGroup(world)
        seed(world, 100, 500)

        local allowed = g:AllowDirectiveCreate(TEAM, AI, 42, 9, 0)

        assert.is_true(allowed)
        -- cost 40 drawn entirely from the AI's own pool; team pool untouched.
        assert.are.equal(60,  world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(500, world.trp(TEAM, 'authority_pool'))
    end)
end)

describe("co-commander own-pool-only invariant (§5)", function()
    it("SetOwnPoolOnly is reflected by GetOwnPoolOnly", function()
        local world, g = mock.new()
        seed(world, 100, 500)
        assert.is_false(_G.GG.Authority.GetOwnPoolOnly(AI))
        _G.GG.Authority.SetOwnPoolOnly(AI, true)
        assert.is_true(_G.GG.Authority.GetOwnPoolOnly(AI))
        _G.GG.Authority.SetOwnPoolOnly(AI, false)
        assert.is_false(_G.GG.Authority.GetOwnPoolOnly(AI))
    end)

    it("REFUSES (no team fallback) when the flagged AI's own pool can't cover the cost", function()
        local world, g = mock.new()
        seedGroup(world)
        seed(world, 10, 500)                 -- AI has 10, team has plenty
        _G.GG.Authority.SetOwnPoolOnly(AI, true)

        local allowed = g:AllowDirectiveCreate(TEAM, AI, 42, 9, 0)

        assert.is_false(allowed)             -- cost 40 > own pool 10, no fallback
        -- No debit at all — neither the AI pool nor the team pool moved.
        assert.are.equal(10,  world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(500, world.trp(TEAM, 'authority_pool'))
    end)

    it("still allows a flagged AI to spend within its OWN pool", function()
        local world, g = mock.new()
        seedGroup(world)
        seed(world, 100, 500)
        _G.GG.Authority.SetOwnPoolOnly(AI, true)

        local allowed = g:AllowDirectiveCreate(TEAM, AI, 42, 9, 0)

        assert.is_true(allowed)
        assert.are.equal(60,  world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(500, world.trp(TEAM, 'authority_pool'))
    end)
end)

describe("full-side AI (unflagged) keeps the normal team fallback", function()
    it("drains its own pool then draws the remainder from the team pool", function()
        local world, g = mock.new()
        seedGroup(world)
        seed(world, 10, 500)                 -- unflagged: fallback allowed

        local allowed = g:AllowDirectiveCreate(TEAM, AI, 42, 9, 0)

        assert.is_true(allowed)
        -- cost 40: own pool 10 → 0, team pays 30.
        assert.are.equal(0,   world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(470, world.trp(TEAM, 'authority_pool'))
    end)
end)

--=============================================================================
-- GG.Authority.Transfer / PoolOf — the primitive AI funding is built on
-- (PLAN-metalstorm-ai.md §5.2, endtoend D32). Against the REAL gadget, because
-- the whole point of these is what they refuse to do, and a permissive mock
-- would hide exactly that.
--=============================================================================
describe("GG.Authority.Transfer (net-zero pool moves, §5.2)", function()
    it("moves a human's own authority into an AI's own pool", function()
        local world, g = mock.new()
        seed(world, 0, 500)
        world.setPlayer(HUMAN, TEAM)
        world.teamRulesParams[TEAM]['authority_player_' .. HUMAN] = 100

        assert.is_true(_G.GG.Authority.Transfer(
            { player = HUMAN }, { player = AI }, 40, 'ai_funding'))

        assert.are.equal(60,  world.trp(TEAM, 'authority_player_' .. HUMAN))
        assert.are.equal(40,  world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(500, world.trp(TEAM, 'authority_pool'))   -- untouched
    end)

    it("REFUSES rather than partially moving when the source can't cover it", function()
        local world, g = mock.new()
        seed(world, 0, 500)
        world.setPlayer(HUMAN, TEAM)
        world.teamRulesParams[TEAM]['authority_player_' .. HUMAN] = 30

        assert.is_false(_G.GG.Authority.Transfer(
            { player = HUMAN }, { player = AI }, 40, 'ai_funding'))

        -- No team fallback: this is the whole difference from ChargeOrder, and
        -- it is what stops a funding control from laundering team savings into
        -- an own-pool-only AI.
        assert.are.equal(30,  world.trp(TEAM, 'authority_player_' .. HUMAN))
        assert.are.equal(0,   world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(500, world.trp(TEAM, 'authority_pool'))
    end)

    it("drips the team pool into an AI pool (the standing allowance)", function()
        local world, g = mock.new()
        seed(world, 0, 500)

        assert.is_true(_G.GG.Authority.Transfer(
            { team = TEAM }, { player = AI }, 50, 'ai_allowance'))

        assert.are.equal(50,  world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(450, world.trp(TEAM, 'authority_pool'))
    end)

    it("mints nothing — the pair of pools sums to the same total", function()
        local world, g = mock.new()
        seed(world, 10, 500)
        _G.GG.Authority.Transfer({ team = TEAM }, { player = AI }, 50, 'ai_allowance')
        assert.are.equal(510, world.trp(TEAM, 'authority_player_' .. AI)
                            + world.trp(TEAM, 'authority_pool'))
    end)

    it("refuses a non-positive amount and an unknown team", function()
        local world, g = mock.new()
        seed(world, 10, 500)
        assert.is_false(_G.GG.Authority.Transfer({ team = TEAM }, { player = AI }, 0, 'x'))
        assert.is_false(_G.GG.Authority.Transfer({ team = TEAM }, { player = AI }, -5, 'x'))
        assert.is_false(_G.GG.Authority.Transfer({ team = 99 }, { player = AI }, 5, 'x'))
        assert.are.equal(10,  world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(500, world.trp(TEAM, 'authority_pool'))
    end)

    it("PoolOf reads both pool kinds and returns nil (not 0) for a non-team", function()
        local world, g = mock.new()
        seed(world, 10, 500)
        assert.are.equal(10,  _G.GG.Authority.PoolOf({ player = AI }))
        assert.are.equal(500, _G.GG.Authority.PoolOf({ team = TEAM }))
        assert.is_nil(_G.GG.Authority.PoolOf({ team = 99 }))
        assert.is_nil(_G.GG.Authority.PoolOf(nil))
    end)

    it("a funded co-commander can spend again — the D32 loop, end to end", function()
        local world, g = mock.new()
        seedGroup(world)
        seed(world, 0, 500)                       -- AI is broke, as measured live
        _G.GG.Authority.SetOwnPoolOnly(AI, true)
        world.setPlayer(HUMAN, TEAM)
        world.teamRulesParams[TEAM]['authority_player_' .. HUMAN] = 100

        -- Broke and own-pool-only: the directive is refused. This is the state
        -- both AIs sat in from ~frame 4700 ("Insufficient authority (needed 2)").
        assert.is_false(g:AllowDirectiveCreate(TEAM, AI, 42, 9, 0))

        _G.GG.Authority.Transfer({ player = HUMAN }, { player = AI }, 40, 'ai_funding')

        -- Funded, it plays again — which is what the panel's control never did.
        assert.is_true(g:AllowDirectiveCreate(TEAM, AI, 42, 9, 0))
        assert.are.equal(0,   world.trp(TEAM, 'authority_player_' .. AI))
        assert.are.equal(500, world.trp(TEAM, 'authority_pool'))   -- never drained
    end)
end)

describe("own-pool-only is per-player (the human teammate is unaffected)", function()
    it("a co-commander flag on the AI does not restrict a human's team fallback", function()
        local world, g = mock.new()
        seedGroup(world)
        seed(world, 100, 500)
        world.setPlayer(HUMAN, TEAM)
        world.teamRulesParams[TEAM]['authority_player_' .. HUMAN] = 10
        _G.GG.Authority.SetOwnPoolOnly(AI, true)     -- only the AI is flagged

        local allowed = g:AllowDirectiveCreate(TEAM, HUMAN, 42, 9, 0)

        assert.is_true(allowed)                      -- human keeps fallback
        assert.are.equal(0,   world.trp(TEAM, 'authority_player_' .. HUMAN))
        assert.are.equal(470, world.trp(TEAM, 'authority_pool'))
    end)
end)
