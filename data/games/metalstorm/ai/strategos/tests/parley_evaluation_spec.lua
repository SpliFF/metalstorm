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

--=============================================================================
-- Relative strength + origination (ai-actuation, lane-4 asks).
--=============================================================================

local function extraFor(id, results)
    for _, r in ipairs(results) do if r.id == id then return r.extra end end
    return nil
end

local function ceasefire(over)
    local p = makePicture(over)
    p.parley.proposals = { { id = 1, kind = 'ceasefire', fromTeam = 5, toTeam = 0, state = 'offered' } }
    return p
end

describe("ceasefire — relative strength decides before trust does", function()
    it("refuses to stand down while we are clearly winning", function()
        local picture = ceasefire({
            ledger = { r1 = { strength = 20 } },
            intel  = { r2 = { strength = 5, confidence = 1.0 } },
            parley = { trust = { [5] = 50 }, proposals = {} },   -- excellent trust
        })
        assert.are.equal('reject', decisionFor(1, Planner.evaluateProposals(picture, profile, role(0))),
            'a pause only lets a beaten enemy re-form')
    end)

    it("takes the pause when we are clearly losing, whatever the trust says", function()
        local picture = ceasefire({
            ledger = { r1 = { strength = 4 } },
            intel  = { r2 = { strength = 20, confidence = 1.0 } },
            parley = { trust = { [5] = -50 }, proposals = {} },  -- we do not even like them
        })
        assert.are.equal('accept', decisionFor(1, Planner.evaluateProposals(picture, profile, role(0))))
    end)

    it("weighs enemy strength by confidence — we negotiate from what we know", function()
        -- Same remembered number, a third of the confidence: no longer dominant
        -- over us, so the trust/aggression valuation decides instead.
        local picture = ceasefire({
            ledger = { r1 = { strength = 8 } },
            intel  = { r2 = { strength = 20, confidence = 0.3 } },
            parley = { trust = { [5] = 0 }, proposals = {} },
        })
        assert.are.equal('accept', decisionFor(1, Planner.evaluateProposals(picture, profile, role(0))))
    end)

    it("falls back to the trust valuation when it knows of no enemy at all", function()
        -- Blind is not dominant: an empty intel memory must not read as "we are
        -- winning" and refuse every ceasefire in the game.
        local picture = ceasefire({ ledger = { r1 = { strength = 20 } },
                                    parley = { trust = { [5] = 50 }, proposals = {} } })
        assert.are.equal('accept', decisionFor(1, Planner.evaluateProposals(picture, profile, role(0))))
    end)

    it("prefers the threat map the planner already built this tick", function()
        local picture = ceasefire({
            threat = { totals = { own = 30, enemy = 5 } },
            ledger = { r1 = { strength = 1 } },              -- stale, and ignored
            intel  = { r2 = { strength = 50, confidence = 1.0 } },
            parley = { trust = { [5] = 50 }, proposals = {} },
        })
        assert.are.equal('reject', decisionFor(1, Planner.evaluateProposals(picture, profile, role(0))))
    end)
end)

describe("tribute demanded of us — counter rather than slam the door", function()
    local function tribute(amount, over)
        local p = makePicture(over)
        p.parley.proposals = { { id = 1, kind = 'tribute', fromTeam = 5, toTeam = 0,
                                 state = 'offered',
                                 terms = { payer = 'to', amount = amount, duration = 900 } } }
        return p
    end

    it("accepts what the trust is worth", function()
        local picture = tribute(40, { parley = { trust = { [5] = 10 }, proposals = {} } })
        assert.are.equal('accept', decisionFor(1, Planner.evaluateProposals(picture, profile, role(0))))
    end)

    it("counters at what we can actually pay when the ask is too dear", function()
        local picture = tribute(500, {
            parley = { trust = { [5] = 10 }, proposals = {} },   -- worth 50
            economy = { teamPool = 400 },                        -- a quarter is 100
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('counter', decisionFor(1, results))
        local extra = extraFor(1, results)
        assert.are.equal('tribute', extra.kind)
        assert.are.equal(50, extra.terms.amount, 'the lesser of the trust value and a quarter of the pool')
        assert.are.equal('to', extra.terms.payer, 'we are still the payer — a counter is not a reversal')
        assert.are.equal(900, extra.terms.duration)
    end)

    it("is capped by the pool, not just by the goodwill", function()
        local picture = tribute(600, {
            parley = { trust = { [5] = 100 }, proposals = {} },  -- worth 500
            economy = { teamPool = 160 },                        -- a quarter is 40
        })
        assert.are.equal(40, extraFor(1, Planner.evaluateProposals(picture, profile, role(0))).terms.amount)
    end)

    it("rejects outright when even the counter would be an insult", function()
        local picture = tribute(500, {
            parley = { trust = { [5] = 1 }, proposals = {} },
            economy = { teamPool = 40 },
        })
        local results = Planner.evaluateProposals(picture, profile, role(0))
        assert.are.equal('reject', decisionFor(1, results))
        assert.is_nil(extraFor(1, results))
    end)

    it("still takes free money", function()
        local picture = tribute(500, { parley = { trust = { [5] = -5 }, proposals = {} } })
        picture.parley.proposals[1].terms.payer = 'from'
        assert.are.equal('accept', decisionFor(1, Planner.evaluateProposals(picture, profile, role(0))))
    end)
end)

describe("originateProposals", function()
    local function board(over)
        local p = makePicture(over)
        p.regions = p.regions or {
            home  = { owner = 0, neighbors = { 'front' } },
            front = { owner = 5, neighbors = { 'home' } },
        }
        return p
    end
    local function kindsOf(list)
        local out = {}
        for _, o in ipairs(list) do out[#out + 1] = o.kind end
        return out
    end

    it("says nothing when it knows of no enemy", function()
        assert.are.same({}, Planner.originateProposals(board({ ledger = { home = { strength = 3 } } }),
            profile, role(0)))
    end)

    it("buys time with a tribute when it is losing badly", function()
        local p = board({
            ledger = { home = { strength = 4, count = 4 } },
            intel  = { front = { strength = 30, confidence = 1.0 } },
            economy = { teamPool = 400 },
        })
        local out = Planner.originateProposals(p, profile, role(0))
        assert.are.same({ 'tribute' }, kindsOf(out))
        assert.are.equal(5, out[1].toTeam, 'the team holding the ground next to ours')
        assert.are.equal('from', out[1].terms.payer, 'WE pay — that is the point')
        assert.are.equal(100, out[1].terms.amount)
    end)

    it("does not offer a bribe it cannot fund", function()
        local p = board({
            ledger = { home = { strength = 4, count = 4 } },
            intel  = { front = { strength = 30, confidence = 1.0 } },
            economy = { teamPool = 40 },        -- a quarter is 10, below MIN_TRIBUTE
        })
        assert.are.same({}, Planner.originateProposals(p, profile, role(0)))
    end)

    it("offers a ceasefire at rough parity when our force is bleeding", function()
        local p = board({
            ledger = { home = { strength = 5, count = 10 } },   -- mean health 0.5
            intel  = { front = { strength = 6, confidence = 1.0 } },
            economy = { teamPool = 400 },
        })
        assert.are.same({ 'ceasefire' }, kindsOf(Planner.originateProposals(p, profile, role(0))))
    end)

    it("stays quiet at parity while the force is healthy", function()
        local p = board({
            ledger = { home = { strength = 10, count = 10 } },  -- mean health 1.0
            intel  = { front = { strength = 12, confidence = 1.0 } },
        })
        assert.are.same({}, Planner.originateProposals(p, profile, role(0)))
    end)

    it("an aggressive profile would rather bleed than ask for peace", function()
        local p = board({
            ledger = { home = { strength = 5, count = 10 } },
            intel  = { front = { strength = 6, confidence = 1.0 } },
        })
        local aggressive = {}
        for k, v in pairs(profile) do aggressive[k] = v end
        aggressive.aggression = 2.0
        assert.are.same({}, Planner.originateProposals(p, aggressive, role(0)))
    end)

    it("never opens a second conversation with a team we are already talking to", function()
        local p = board({
            ledger = { home = { strength = 4, count = 4 } },
            intel  = { front = { strength = 30, confidence = 1.0 } },
            economy = { teamPool = 400 },
        })
        p.parley.proposals = { { id = 7, kind = 'ceasefire', fromTeam = 0, toTeam = 5, state = 'offered' } }
        assert.are.same({}, Planner.originateProposals(p, profile, role(0)))
    end)

    it("addresses a team it has only ever met on the parley board", function()
        -- No shared border at all: the trust ledger is the other honest source
        -- of "who is there to talk to".
        local p = makePicture({
            regions = { home = { owner = 0, neighbors = {} } },
            ledger = { home = { strength = 4, count = 4 } },
            intel  = { far = { strength = 30, confidence = 1.0 } },
            economy = { teamPool = 400 },
            parley = { trust = { [9] = 0 }, proposals = {} },
        })
        local out = Planner.originateProposals(p, profile, role(0))
        assert.are.equal(9, out[1].toTeam)
    end)

    it("is deterministic when two counterparties are equally close", function()
        local p = makePicture({
            regions = {
                home  = { owner = 0, neighbors = { 'a', 'b' } },
                a = { owner = 5, neighbors = { 'home' } },
                b = { owner = 3, neighbors = { 'home' } },
            },
            ledger = { home = { strength = 4, count = 4 } },
            intel  = { a = { strength = 30, confidence = 1.0 } },
            economy = { teamPool = 400 },
        })
        local first = Planner.originateProposals(p, profile, role(0))[1].toTeam
        assert.are.equal(first, Planner.originateProposals(p, profile, role(0))[1].toTeam)
        assert.are.equal(3, first, 'ties break on team id, not on table order')
    end)
end)
