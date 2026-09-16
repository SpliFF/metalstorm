-- tests/profile_parley_spec.lua — the PROFILE proposal handler
-- (Planner.evaluateProposals' `profile.evaluateProposal` hook, ai-eval).
--
-- The strategos could not answer a proposal at all until the snapshot carried
-- game_parley.lua's `parley_*` params (rts/Server/AI/AIStateSnapshot.cpp, and
-- tests/test_ai_snapshot_params.cpp beside it). This spec covers the other
-- half: given a board it CAN see, which way does each profile answer?
--
-- PURE, same discipline as parley_evaluation_spec.lua: hand-built fixture
-- Pictures and plans, no engine/AI1/AI2/running game.

package.path = './?.lua;' .. package.path

local Planner = require('planner')
local defaultProfile = require('profiles.default')
local mentorProfile  = require('profiles.mentor')

local function role(teamId) return { teamId = teamId } end

-- A board where team 5 offers us (team 0) peace, and a map where team 5 owns
-- region 'r_enemy'. Trust is neutral throughout so the shared valuation's
-- own verdict on an ordinary ceasefire is 'accept' — every difference below
-- is the handler's doing, not the trust ledger's.
local function makePicture(kind)
    return {
        frame = 1000,
        ledger = {},
        intel = {},
        regions = {
            r_home  = { owner = 0 },
            r_enemy = { owner = 5 },
        },
        parley = { trust = {}, proposals = {
            { id = 1, kind = kind or 'ceasefire', fromTeam = 5, toTeam = 0,
              state = 'offered' },
        } },
    }
end

local attackPlan   = { intent = { { goal = 'atk:r_enemy', kind = 'ATTACK', region = 'r_enemy' } } }
local defendPlan   = { intent = { { goal = 'def:r_home',  kind = 'DEFEND', region = 'r_home'  } } }

local function decisionFor(results, id)
    for _, r in ipairs(results) do if r.id == id then return r.decision end end
    return nil
end

describe("attackIntentTeams", function()
    it("names the owner of every region an ATTACK/DENY line points at", function()
        local teams = Planner.attackIntentTeams(makePicture(), attackPlan, 0)
        assert.is_true(teams[5])
    end)

    it("ignores DEFEND lines, our own ground, and a missing plan", function()
        assert.is_nil(Planner.attackIntentTeams(makePicture(), defendPlan, 0)[5])
        assert.is_nil(Planner.attackIntentTeams(makePicture(), defendPlan, 0)[0])
        assert.are.same({}, Planner.attackIntentTeams(makePicture(), nil, 0))
    end)
end)

describe("default profile — peace with a side we are about to hit", function()
    it("declines a ceasefire from a team this tick's plan attacks", function()
        local results = Planner.evaluateProposals(makePicture('ceasefire'),
            defaultProfile, role(0), attackPlan)
        assert.are.equal('reject', decisionFor(results, 1))
    end)

    it("declines a scenario-authored 'pact' the same way", function()
        local results = Planner.evaluateProposals(makePicture('pact'),
            defaultProfile, role(0), attackPlan)
        assert.are.equal('reject', decisionFor(results, 1))
    end)

    it("accepts a ceasefire from a team we are not pointed at", function()
        local results = Planner.evaluateProposals(makePicture('ceasefire'),
            defaultProfile, role(0), defendPlan)
        assert.are.equal('accept', decisionFor(results, 1))
    end)

    it("accepts a 'pact' from a team we are not pointed at (not 'unknown kind')", function()
        local results = Planner.evaluateProposals(makePicture('pact'),
            defaultProfile, role(0), defendPlan)
        assert.are.equal('accept', decisionFor(results, 1))
    end)

    it("leaves non-peace kinds entirely to the shared valuation", function()
        -- Tribute paid TO us is pure upside and stays an accept even while we
        -- are attacking the payer: the handler must not touch it.
        local picture = makePicture('tribute')
        picture.parley.proposals[1].terms = { amount = 500, payer = 'from' }
        local results = Planner.evaluateProposals(picture, defaultProfile, role(0), attackPlan)
        assert.are.equal('accept', decisionFor(results, 1))
    end)
end)

describe("mentor profile — the lesson ends in a handshake", function()
    it("accepts a ceasefire even from a team it is attacking", function()
        local results = Planner.evaluateProposals(makePicture('ceasefire'),
            mentorProfile, role(0), attackPlan)
        assert.are.equal('accept', decisionFor(results, 1))
    end)

    it("accepts a 'pact' from a team it is attacking", function()
        local results = Planner.evaluateProposals(makePicture('pact'),
            mentorProfile, role(0), attackPlan)
        assert.are.equal('accept', decisionFor(results, 1))
    end)

    it("still refuses an uncredible demand (falls through to the valuation)", function()
        local picture = makePicture('demand')
        picture.parley.proposals[1].terms = { regionKey = 'r_home' }
        local results = Planner.evaluateProposals(picture, mentorProfile, role(0), defendPlan)
        assert.are.equal('reject', decisionFor(results, 1))
    end)
end)

describe("a profile with no handler is unaffected", function()
    it("evaluates with the shared valuation when the hook is absent", function()
        local bare = { id = 'bare', aggression = 1.0, confidence = 1.0 }
        local results = Planner.evaluateProposals(makePicture('ceasefire'), bare,
            role(0), attackPlan)
        assert.are.equal('accept', decisionFor(results, 1))
    end)
end)
