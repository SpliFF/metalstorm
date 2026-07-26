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
