-- tests/game_ai_guidance_spec.lua — team-scoped guidance store behaviour
-- (PLAN-metalstorm-interaction.md §6, §11). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.parley_mock')
local Wire = require('parley.wire')

local function newWorld()
    local world, gadgetObj = mock.new('./game_ai_guidance.lua')
    world.setPlayer(1, 10)   -- team member
    world.setPlayer(2, 20)   -- a DIFFERENT team
    return world, gadgetObj
end

describe("validated writes (§6.2)", function()
    it("accepts a stance change from a team member", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'aggressive' }), 1)
        assert.are.equal('aggressive', GG.AIGuidance.Get(10).stance)
    end)

    it("rejects a write from a non-team-member (spoofed team)", function()
        local world, gadgetObj = newWorld()
        -- Player 2 is on team 20; RecvLuaMsg derives the acting team from
        -- the PLAYER, so there is no team field to spoof — this proves the
        -- write lands on player 2's OWN team (20), never team 10.
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'aggressive' }), 2)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)   -- unaffected, still default
        assert.are.equal('aggressive', GG.AIGuidance.Get(20).stance)
    end)

    it("rejects a bogus stance value", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'nonsense' }), 1)
        assert.are.equal('balanced', GG.AIGuidance.Get(10).stance)   -- unchanged default
    end)

    it("last-write-wins on region paint, and 'normal' clears the override", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.paint', { regionKey = 'basin_a', value = 'forbidden' }), 1)
        assert.are.equal('forbidden', GG.AIGuidance.Get(10).region_paint.basin_a)

        gadgetObj:RecvLuaMsg(Wire.encode('guidance.paint', { regionKey = 'basin_a', value = 'priority' }), 1)
        assert.are.equal('priority', GG.AIGuidance.Get(10).region_paint.basin_a)

        gadgetObj:RecvLuaMsg(Wire.encode('guidance.paint', { regionKey = 'basin_a', value = 'normal' }), 1)
        assert.is_nil(GG.AIGuidance.Get(10).region_paint.basin_a)
    end)

    it("toggles an asset lock on and off", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.lock', { groupId = 5, locked = '1' }), 1)
        assert.is_true(GG.AIGuidance.Get(10).asset_locks[5])
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.lock', { groupId = 5, locked = '0' }), 1)
        assert.is_nil(GG.AIGuidance.Get(10).asset_locks[5])
    end)

    it("delegates an objective ('Assign to AI')", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.delegate', { objectiveId = 42, delegated = '1' }), 1)
        assert.is_true(GG.AIGuidance.Get(10).delegated[42])
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.delegate', { objectiveId = 42, delegated = '0' }), 1)
        assert.is_nil(GG.AIGuidance.Get(10).delegated[42])
    end)

    it("sets a funding rate cap without requiring a one-shot amount", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { rateCap = 200 }), 1)
        assert.are.equal(200, GG.AIGuidance.Get(10).funding.rateCap)
    end)

    it("sets ROE", function()
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.roe', { value = 'deny_area' }), 1)
        assert.are.equal('deny_area', GG.AIGuidance.Get(10).roe)
    end)
end)

--=============================================================================
-- AI funding (§6.2 funding row; decided in PLAN-metalstorm-ai.md §5.2).
-- Regression gate for endtoend D32: a co-commanded Strategos spent its opening
-- allocation and the panel's FUNDING control could not revive it, because the
-- one-shot awarded the TEAM pool that an own_pool_only AI may never spend.
--=============================================================================
describe("AI funding — the one-shot gift (§5.2, D32)", function()
    -- Team 10: one human funder (1) and one AI co-commander (8).
    local function fundedWorld()
        local world, gadgetObj = newWorld()
        world.setAIPlayer(8, 10)
        world.setPlayerPool(1, 100)
        world.setTeamPool(10, 600)
        return world, gadgetObj
    end

    it("credits the AI's OWN pool, not the team pool", function()
        local world, gadgetObj = fundedWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        -- This is the exact live measurement D32 recorded, with the one number
        -- that was wrong put right: the human still pays 100 → 60, but the 40
        -- lands on the AI instead of on authority_pool (which stays at 600).
        assert.are.equal(60,  world.playerPools[1])
        assert.are.equal(40,  world.playerPools[8])
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("is tagged ai_funding so the ledger classes it as a move, not a mint", function()
        local world, gadgetObj = fundedWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(1, #world.transferLog)
        assert.are.equal('ai_funding', world.transferLog[1].reason)
        -- Never Award: Award mints, and funding must be net-zero.
        assert.are.equal(0, #world.awardLog)
    end)

    it("takes the funder's OWN pool only — no team fallback", function()
        local world, gadgetObj = fundedWorld()
        world.setPlayerPool(1, 30)               -- team pool has 600 to spare
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        -- Routing this through ChargeOrder would have let the human draw 10
        -- from the team pool and hand it to an own_pool_only AI — rejected
        -- option (c) via the back door. Nothing moves.
        assert.are.equal(30,  world.playerPools[1])
        assert.are.equal(0,   world.playerPools[8] or 0)
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("refuses when the team has no AI instead of donating to the team pool", function()
        local world, gadgetObj = newWorld()       -- no AI on team 10
        world.setPlayerPool(1, 100)
        world.setTeamPool(10, 600)
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(100, world.playerPools[1])   -- charged nothing
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("splits evenly across several AIs on the team", function()
        local world, gadgetObj = fundedWorld()
        world.setAIPlayer(9, 10)                  -- a second co-commander
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(60, world.playerPools[1])
        assert.are.equal(20, world.playerPools[8])
        assert.are.equal(20, world.playerPools[9])
    end)

    it("a split the funder can't cover in full pays NOTHING (no half-success)", function()
        local world, gadgetObj = fundedWorld()
        world.setAIPlayer(9, 10)
        world.setPlayerPool(1, 30)                -- covers AI #1's share, not both
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(30, world.playerPools[1])
        assert.are.equal(0,  world.playerPools[8] or 0)
        assert.are.equal(0,  world.playerPools[9] or 0)
    end)

    it("says so in the log when it refuses (never a silent no-op)", function()
        local world, gadgetObj = fundedWorld()
        world.setPlayerPool(1, 5)
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(1, #world.echoes)
        assert.is_truthy(world.echoes[1]:find('insufficient_authority', 1, true))
    end)

    it("ignores AI slots on other teams", function()
        local world, gadgetObj = fundedWorld()
        world.setAIPlayer(9, 20)                  -- someone else's AI
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { amount = 40 }), 1)
        assert.are.equal(40, world.playerPools[8])
        assert.are.equal(0,  world.playerPools[9] or 0)
    end)
end)

describe("AI funding — the standing allowance drip (§5.2 option d)", function()
    local function cappedWorld(cap)
        local world, gadgetObj = newWorld()
        world.setAIPlayer(8, 10)
        world.setTeamPool(10, 600)
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.fund', { rateCap = cap }), 1)
        return world, gadgetObj
    end

    it("moves rateCap from the team pool to the AI once a game-minute", function()
        local world, gadgetObj = cappedWorld(50)
        gadgetObj:GameFrame(1800)
        assert.are.equal(50,  world.playerPools[8])
        assert.are.equal(550, world.authorityPools[10])
        gadgetObj:GameFrame(3600)
        assert.are.equal(100, world.playerPools[8])
        assert.are.equal(500, world.authorityPools[10])
    end)

    it("does nothing before its first full period has elapsed", function()
        local world, gadgetObj = cappedWorld(50)
        gadgetObj:GameFrame(1)
        gadgetObj:GameFrame(900)
        gadgetObj:GameFrame(1799)
        assert.are.equal(0,   world.playerPools[8] or 0)
        assert.are.equal(600, world.authorityPools[10])
    end)

    -- D15: this used to assert the opposite — that frame 1801 drips nothing,
    -- because the gate was `frame % 1800 == 0`. On a server that logs
    -- `sim fell behind, skipped N ticks` the exact multiple is never delivered,
    -- so that contract silently rationed the AI below the cap its team was
    -- paying for. The drip is now owed per elapsed period, not per multiple hit.
    it("still pays the minute whose boundary frame was skipped", function()
        local world, gadgetObj = cappedWorld(50)
        gadgetObj:GameFrame(1801)              -- 1800 never arrived
        assert.are.equal(50,  world.playerPools[8])
        assert.are.equal(550, world.authorityPools[10])
        gadgetObj:GameFrame(1802)              -- and does not pay twice
        assert.are.equal(50,  world.playerPools[8])
    end)

    it("pays every minute a long stall stepped over, not just one", function()
        local world, gadgetObj = cappedWorld(50)
        gadgetObj:GameFrame(9000)              -- five minutes in one call
        assert.are.equal(250, world.playerPools[8])
        assert.are.equal(350, world.authorityPools[10])
    end)

    it("is opt-in: no cap set drips nothing", function()
        local world, gadgetObj = newWorld()
        world.setAIPlayer(8, 10)
        world.setTeamPool(10, 600)
        gadgetObj:GameFrame(1800)
        assert.are.equal(0,   world.playerPools[8] or 0)
        assert.are.equal(600, world.authorityPools[10])
    end)

    it("pays what the team pool has when it can't cover the full cap", function()
        local world, gadgetObj = cappedWorld(50)
        world.setTeamPool(10, 20)
        gadgetObj:GameFrame(1800)
        -- Partial, deliberately: an allowance that silently stopped when the
        -- team got poor would starve the AI exactly when it matters most.
        assert.are.equal(20, world.playerPools[8])
        assert.are.equal(0,  world.authorityPools[10])
    end)

    it("splits the allowance across several AIs and tags it ai_allowance", function()
        local world, gadgetObj = cappedWorld(50)
        world.setAIPlayer(9, 10)
        gadgetObj:GameFrame(1800)
        assert.are.equal(25, world.playerPools[8])
        assert.are.equal(25, world.playerPools[9])
        assert.are.equal('ai_allowance', world.transferLog[#world.transferLog].reason)
    end)
end)

describe("change feed (§6.2 'who set what')", function()
    it("records field/player/frame for each write", function()
        local world, gadgetObj = newWorld()
        world.frame = 123
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'defensive' }), 1)
        assert.are.equal('stance', world.trp(10, 'guidance_10_change_1_field'))
        assert.are.equal(1, world.trp(10, 'guidance_10_change_1_player'))
        assert.are.equal(123, world.trp(10, 'guidance_10_change_1_frame'))
        assert.are.equal(1, world.trp(10, 'guidance_10_change'))
    end)
end)

describe("veto blacklist (§6.3)", function()
    it("blacklists a goal for 5 minutes then clears it", function()
        local world, gadgetObj = newWorld()
        world.frame = 0
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.veto', { goalId = 99 }), 1)
        assert.is_number(GG.AIGuidance.Get(10).veto[99])

        world.frame = 8999
        gadgetObj:GameFrame(world.frame)
        assert.is_number(GG.AIGuidance.Get(10).veto[99])   -- still blacklisted

        world.frame = 9000
        gadgetObj:GameFrame(world.frame)
        assert.is_nil(GG.AIGuidance.Get(10).veto[99])   -- expired
    end)
end)

--=============================================================================
-- AI intent correlation — PLAN-ai-synced-write.md §2.5 (SG1 task 2).
--
-- The AI (a virtual player, playerID 8 here) pushes an `ai.intent` LuaMsg
-- naming the planner goal, then immediately issues the directive it describes;
-- both drain in push order in the same frame, so the charge path's
-- RecordIntent can attach the goalId. The intent line stays AUTHORITATIVE —
-- it exists only for a directive that actually charged — and the tag is the
-- annotation, which is why every test below asserts on the published
-- intent_0_goal_id rather than on the tag store.
--
-- RecordIntent is called directly here because the caller lives in a
-- different gadget (game_authority_charge.lua's AllowDirectiveCreate) and the
-- mock loads exactly one gadget file per world; that call site's own contract
-- — only on `allowed`, with the raw playerID — is covered in
-- game_authority_charge_spec.lua.
--=============================================================================
describe("AI intent correlation (PLAN-ai-synced-write §2.5)", function()
    local function aiWorld()
        local world, gadgetObj = newWorld()
        world.setAIPlayer(8, 10)     -- co-commander on team 10
        world.setAIPlayer(9, 20)     -- an AI on a DIFFERENT team
        return world, gadgetObj
    end

    local function tag(gadgetObj, playerID, goalId)
        gadgetObj:RecvLuaMsg(Wire.encode('ai.intent', { goalId = goalId, dt = 9, region = 'basin_a' }), playerID)
    end

    it("attaches the planner goalId to the directive that follows it", function()
        local world, gadgetObj = aiWorld()
        tag(gadgetObj, 8, 'def:basin_a')
        GG.AIGuidance.RecordIntent(10, 9, 3, 25, 8)
        assert.are.equal('def:basin_a', world.trp(10, 'guidance_10_intent_0_goal_id'))
        assert.are.equal('Assault', world.trp(10, 'guidance_10_intent_0_goal'))
    end)

    it("rejects a tag from a HUMAN — intent lines are not injectable", function()
        local world, gadgetObj = aiWorld()
        tag(gadgetObj, 1, 'def:basin_a')          -- player 1 is a human on team 10
        GG.AIGuidance.RecordIntent(10, 9, 3, 25, 1)
        -- The line still exists (the directive charged); it just carries no
        -- goalId, so the panel renders no Veto button for it.
        assert.are.equal(1, world.trp(10, 'guidance_10_intent_count'))
        assert.are.equal('', world.trp(10, 'guidance_10_intent_0_goal_id'))
    end)

    it("rejects a tag from an AI on another team", function()
        local world, gadgetObj = aiWorld()
        tag(gadgetObj, 9, 'def:basin_a')          -- AI 9 is on team 20
        -- Team 10 asks FIRST, so the tag is still there to be stolen: it must
        -- not annotate team 10's directive even though the charge path handed
        -- RecordIntent this player. (Asking team 20 first would consume the
        -- tag and make this assertion pass for the wrong reason.)
        GG.AIGuidance.RecordIntent(10, 9, 3, 25, 9)
        assert.are.equal('', world.trp(10, 'guidance_10_intent_0_goal_id'))
        -- And the tag survives the refusal, for its own team's directive.
        GG.AIGuidance.RecordIntent(20, 9, 3, 25, 9)
        assert.are.equal('def:basin_a', world.trp(20, 'guidance_20_intent_0_goal_id'))
    end)

    it("consumes the tag EXACTLY once — the second directive is unannotated", function()
        local world, gadgetObj = aiWorld()
        tag(gadgetObj, 8, 'def:basin_a')
        GG.AIGuidance.RecordIntent(10, 9, 3, 25, 8)
        GG.AIGuidance.RecordIntent(10, 1, 4, 10, 8)   -- same frame, no new tag
        -- Newest-first: slot 0 is the second directive.
        assert.are.equal('',            world.trp(10, 'guidance_10_intent_0_goal_id'))
        assert.are.equal('def:basin_a', world.trp(10, 'guidance_10_intent_1_goal_id'))
    end)

    it("expires the tag at frame end, so a dropped directive leaves no phantom", function()
        local world, gadgetObj = aiWorld()
        world.frame = 100
        tag(gadgetObj, 8, 'def:basin_a')
        -- The directive this tag described was vetoed by authority / dropped by
        -- the E6 clamp: RecordIntent is never reached, so there is no line...
        assert.are.equal(nil, world.trp(10, 'guidance_10_intent_count'))
        gadgetObj:GameFrame(100)
        assert.are.equal(1, GG.AIGuidance.PendingCount())   -- still live this frame
        world.frame = 101
        gadgetObj:GameFrame(101)
        -- ...the tag is dropped rather than accumulating for an AI whose
        -- directives keep getting refused...
        assert.are.equal(0, GG.AIGuidance.PendingCount())
        -- ...and it must not annotate the NEXT frame's directive, which
        -- belongs to a different goal.
        GG.AIGuidance.RecordIntent(10, 9, 3, 25, 8)
        assert.are.equal('', world.trp(10, 'guidance_10_intent_0_goal_id'))
    end)

    it("closes the veto loop: a published goal_id is a valid veto key", function()
        local world, gadgetObj = aiWorld()
        tag(gadgetObj, 8, 'def:basin_a')
        GG.AIGuidance.RecordIntent(10, 9, 3, 25, 8)
        local published = world.trp(10, 'guidance_10_intent_0_goal_id')
        -- This is exactly what ai-command-panel.js sends back from data-goal.
        -- Wire.num() used to coerce it to nil and the write silently refused,
        -- so the loop could only close for a synthetic numeric goal id.
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.veto', { goalId = published }), 1)
        assert.is_number(GG.AIGuidance.Get(10).veto['def:basin_a'])
        assert.are.equal('def:basin_a', world.trp(10, 'guidance_10_veto_keys'))
    end)
end)

describe("privacy (§9 engine ask I2)", function()
    it("publishes with no losAccess override (default private scope)", function()
        -- The mock's SetTeamRulesParam signature only takes (teamID, key,
        -- value) — game_ai_guidance.lua must never pass a 4th losAccess
        -- argument (that would be the {allied=true} pattern game_authority.lua
        -- uses instead); this test simply exercises a write and confirms it
        -- reads back correctly through the plain (teamID, key) contract.
        local world, gadgetObj = newWorld()
        gadgetObj:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'aggressive' }), 1)
        assert.are.equal('aggressive', world.trp(10, 'guidance_10_stance'))
    end)
end)
