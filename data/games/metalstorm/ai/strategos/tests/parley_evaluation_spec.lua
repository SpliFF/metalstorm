-- tests/parley_evaluation_spec.lua — AI proposal/demand evaluation
-- (PLAN-metalstorm-interaction.md §6.2, §11). Run from the plugin root:
-- busted tests/ (cwd = ai/strategos/).
--
-- PURE, same discipline as planner_spec.lua: hand-built fixture Pictures,
-- no engine/AI1/AI2/running game.

package.path = './?.lua;' .. package.path

local Planner = require('planner')
local profile = require('profiles.default')

local function role(teamId)
    return { teamId = teamId }
end

local function makePicture(over)
    local p = {
        frame = 1000,
        ledger = {},
        intel = {},
        parley = { proposals = {}, trust = {} },
    }
    for k, v in pairs(over or {}) do p[k] = v end
    return p
end

local function decisionFor(id, results)
    for _, r in ipairs(results) do if r.id == id then return r.decision end end
    return nil
end

describe("evaluateProposals — addressing filter", function()
    it("only evaluates proposals addressed to our own team, pending state", function()
        local picture = makePicture({
            parley = { trust = {}, proposals = {
                { id = 1, kind = 'intel', fromTeam = 5, toTeam = 0, state = 'offered' },
                { id = 2, kind = 'intel', fromTeam = 5, toTeam = 9, state = 'offered' },   -- not us
                { id = 3, kind = 'intel', fromTeam = 5, toTeam = 0, state = 'active' },     -- not pending
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal(1, #results)
        assert.are.equal(1, results[1].id)
    end)
end)

describe("evaluateProposals — intel is always free", function()
    it("always accepts an intel proposal (no downside)", function()
        local picture = makePicture({
            parley = { trust = { [5] = -10 }, proposals = {
                { id = 1, kind = 'intel', fromTeam = 5, toTeam = 0, state = 'offered' },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('accept', decisionFor(1, results))
    end)
end)

describe("evaluateProposals — ceasefire weighted by trust + aggression", function()
    it("accepts a ceasefire from a trusted team", function()
        local picture = makePicture({
            parley = { trust = { [5] = 10 }, proposals = {
                { id = 1, kind = 'ceasefire', fromTeam = 5, toTeam = 0, state = 'offered' },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('accept', decisionFor(1, results))
    end)

    it("rejects a ceasefire when trust is deeply negative", function()
        local picture = makePicture({
            parley = { trust = { [5] = -20 }, proposals = {
                { id = 1, kind = 'ceasefire', fromTeam = 5, toTeam = 0, state = 'offered' },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('reject', decisionFor(1, results))
    end)
end)

describe("evaluateProposals — tribute direction", function()
    it("always accepts tribute paid TO us", function()
        local picture = makePicture({
            parley = { trust = { [5] = -20 }, proposals = {
                { id = 1, kind = 'tribute', fromTeam = 5, toTeam = 0, state = 'offered',
                  terms = { amount = 500, payer = 'from' } },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('accept', decisionFor(1, results))
    end)

    it("rejects paying a large tribute to a distrusted team", function()
        local picture = makePicture({
            parley = { trust = { [5] = -5 }, proposals = {
                { id = 1, kind = 'tribute', fromTeam = 5, toTeam = 0, state = 'offered',
                  terms = { amount = 500, payer = 'to' } },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('reject', decisionFor(1, results))
    end)
end)

describe("evaluateProposals — demand credibility (reuses the pSuccess shape)", function()
    it("rejects a demand with no visible enemy strength (not credible)", function()
        local picture = makePicture({
            intel = {}, ledger = {},
            parley = { trust = {}, proposals = {
                { id = 1, kind = 'demand', fromTeam = 5, toTeam = 0, state = 'offered',
                  terms = { regionKey = 'r1' } },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('reject', decisionFor(1, results))
    end)

    it("accepts a demand backed by overwhelming adjacent enemy strength", function()
        local picture = makePicture({
            intel = { r1 = { strength = 1000, confidence = 1.0 } },
            ledger = { r1 = { strength = 10 } },
            parley = { trust = {}, proposals = {
                { id = 1, kind = 'demand', fromTeam = 5, toTeam = 0, state = 'offered',
                  terms = { regionKey = 'r1' } },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('accept', decisionFor(1, results))
    end)

    it("rejects a demand when our own defence at the region is dominant", function()
        local picture = makePicture({
            intel = { r1 = { strength = 10, confidence = 1.0 } },
            ledger = { r1 = { strength = 1000 } },
            parley = { trust = {}, proposals = {
                { id = 1, kind = 'demand', fromTeam = 5, toTeam = 0, state = 'offered',
                  terms = { regionKey = 'r1' } },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('reject', decisionFor(1, results))
    end)
end)

describe("evaluateProposals — unknown kind never silently accepted", function()
    it("rejects an unrecognised proposal kind", function()
        local picture = makePicture({
            parley = { trust = { [5] = 50 }, proposals = {
                { id = 1, kind = 'bogus_kind', fromTeam = 5, toTeam = 0, state = 'offered' },
            } },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('reject', decisionFor(1, results))
    end)
end)
