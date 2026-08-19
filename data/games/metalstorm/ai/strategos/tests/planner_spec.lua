-- tests/planner_spec.lua — the pure decision core, tested headless.
--
-- Run from the plugin root:  busted tests/
--
-- This is the plan's whole thesis in one file (PLAN-metalstorm-ai.md §10 task
-- 2, §11): slate + planner are PURE functions of a Picture table, so the brain
-- is testable with NO engine, NO AI1/AI2, NO running game. We hand-build
-- fixture Pictures (bypassing the engine-coupled picture.lua) and assert
-- decisions.

package.path = './?.lua;' .. package.path

local Config  = require('config')
local Slate   = require('slate')
local Planner = require('planner')
local Roles   = require('roles')
local profile = require('profiles.default')
local caretakerProfile = require('profiles.caretaker')

--=============================================================================
-- Fixture helpers
--=============================================================================
local function fullSideRole()
    local role = Roles.resolve('full_side', Config)
    role.teamId = 0
    return role
end

local function coCommanderRole()
    local role = Roles.resolve('co_commander', Config)
    role.teamId = 0
    return role
end

local function makePicture(over)
    local p = {
        frame    = 1000,
        config   = Config,
        regions  = {},
        board    = {},
        ledger   = {},
        intel    = {},
        economy  = { ownPool = 0, teamPool = 0, costScale = 1.0 },
        guidance = { regionPaint = {}, assetLocks = {}, delegated = {}, veto = {} },
        parley   = { proposals = {}, trust = {} },
        power    = {},
    }
    for k, v in pairs(over or {}) do p[k] = v end
    return p
end

local function plan(picture, commitments, prof)
    prof = prof or profile
    return Planner.plan({
        picture     = picture,
        slate       = Slate.build(picture, prof, picture._role),
        profile     = prof,
        role        = picture._role,
        commitments = commitments or {},
        rng         = Config.makeRNG(42),
        config      = Config,
    })
end

local function hasKind(list, kind)
    for _, g in ipairs(list) do if g.kind == kind then return true end end
    return false
end

local function countType(directives, t)
    local n = 0
    for _, d in ipairs(directives) do if d.type == t then n = n + 1 end end
    return n
end

--=============================================================================
describe("slate generation", function()
    it("always includes a RESERVE goal", function()
        local role = fullSideRole()
        local p = makePicture({ _role = role })
        local slate = Slate.build(p, profile, role)
        assert.is_true(hasKind(slate, 'RESERVE'))
    end)

    it("raises DEFEND for an owned, valuable region under adjacent threat", function()
        local role = fullSideRole()
        local p = makePicture({
            _role = role,
            regions = {
                home  = { owner = 0, value = 1.5, neighbors = { 'front' } },
                front = { owner = 1, value = 1.0, neighbors = { 'home' } },
            },
            intel = { front = { strength = 500, confidence = 1.0, lastSeenFrame = 1000 } },
        })
        local slate = Slate.build(p, profile, role)
        local defend
        for _, g in ipairs(slate) do
            if g.kind == 'DEFEND' and g.region == 'home' then defend = g end
        end
        assert.is_truthy(defend)
        assert.are.equal('DEFEND', defend.directive)
    end)
end)

--=============================================================================
describe("budget governor", function()
    -- A fixture with a defend need AND an expansion opportunity, plus two
    -- force packages so both can be assigned when the economy allows.
    local function economyFixture(ownPool)
        local role = fullSideRole()
        return makePicture({
            _role = role,
            regions = {
                home  = { owner = 0, value = 1.5, neighbors = { 'front', 'basin' } },
                front = { owner = 1, value = 1.0, neighbors = { 'home' } },
                basin = { owner = nil, value = 2.0, neighbors = { 'home' } },
            },
            intel  = { front = { strength = 500, confidence = 1.0, lastSeenFrame = 1000 } },
            ledger = { home = { strength = 1000 }, staging = { strength = 800 } },
            economy = { ownPool = ownPool, teamPool = 0, costScale = 1.0 },
        })
    end

    it("a rich AI issues real directives (not just postures)", function()
        local out = plan(economyFixture(1000))
        assert.is_false(out.posturesOnly)
        assert.is_true(countType(out.directives, 'directive') >= 1)
    end)

    -- D68: the planner has to hand the actuator BOTH scales. The head count is
    -- what it reasons and narrates in; the hitpoint figure is the only one the
    -- engine's demand cap can read, and a directive emitted without it is
    -- uncapped-or-broken at the boundary.
    it("every emitted directive carries the package's hitpoint figure (D68)", function()
        local role = fullSideRole()
        local p = makePicture({
            _role = role,
            regions = {
                home  = { owner = 0, value = 1.5, neighbors = { 'front', 'basin' } },
                front = { owner = 1, value = 1.0, neighbors = { 'home' } },
                basin = { owner = nil, value = 2.0, neighbors = { 'home' } },
            },
            intel  = { front = { strength = 5, confidence = 1.0, lastSeenFrame = 1000 } },
            -- The real shape a Picture produces: a head count AND its price.
            ledger = { home = { strength = 6, health = 7200 } },
            economy = { ownPool = 1000, teamPool = 0, costScale = 1.0 },
        })
        local out = plan(p)

        local seen = 0
        for _, d in ipairs(out.directives) do
            if d.type == 'directive' or d.type == 'posture' then
                seen = seen + 1
                assert.are.equal(6, d.strength)
                assert.are.equal(7200, d.healthStrength)
            end
        end
        assert.is_true(seen >= 1)
    end)

    -- A ledger bucket with no price (a Picture from before D68, or a blind one)
    -- must emit 0 rather than nil: the actuator turns 0 into "no cap", and nil
    -- into an arithmetic error on a live tick.
    it("a bucket with no hitpoint figure emits 0, never nil (D68)", function()
        local role = fullSideRole()
        local out = plan(makePicture({
            _role = role,
            regions = {
                home  = { owner = 0, value = 1.5, neighbors = { 'front' } },
                front = { owner = 1, value = 1.0, neighbors = { 'home' } },
            },
            intel  = { front = { strength = 5, confidence = 1.0, lastSeenFrame = 1000 } },
            ledger = { home = { strength = 6 } },     -- no `health`
            economy = { ownPool = 1000, teamPool = 0, costScale = 1.0 },
        }))
        for _, d in ipairs(out.directives) do
            if d.type == 'directive' or d.type == 'posture' then
                assert.are.equal(0, d.healthStrength)
            end
        end
    end)

    it("a broke AI turtles — only DEFEND postures go out", function()
        local out = plan(economyFixture(0))
        assert.is_true(out.posturesOnly)
        assert.are.equal(0, countType(out.directives, 'directive'))
        assert.is_true(countType(out.directives, 'posture') >= 1)
    end)

    -- The guidance funding rate cap (interaction §6.2) is quoted per game-MINUTE
    -- — that is what the panel's control means and what game_ai_guidance.lua's
    -- allowance drip actually pays out — while this budget is per strategic
    -- TICK. PLAN-metalstorm-ai.md §5.2.
    it("prorates the funding rate cap from per-minute to per-tick", function()
        local p = economyFixture(1000)
        p.economy.fundingRateCap = 120            -- 120/min
        local out = plan(p)
        -- 150-frame tick = 1/12 of a minute, so 10 per tick. Unscaled (the bug)
        -- this read 120 — twelve times the income the cap authorises, which is
        -- why the cap barely bound anything.
        assert.are.equal(10, out.budget)
    end)

    it("gives a coarser-LOD AI a proportionally larger slice of the same cap", function()
        local p = economyFixture(1000)
        p.economy.fundingRateCap = 120
        p._role.tickFrames = 600                  -- thinking 4× less often
        local out = plan(p)
        assert.are.equal(40, out.budget)          -- same 120/min, four ticks' worth
    end)

    it("the cap only ever clamps down — a rich cap doesn't raise the budget", function()
        local p = economyFixture(100)             -- pool 100, reserve 25 → budget 75
        p.economy.fundingRateCap = 100000
        local out = plan(p)
        assert.are.equal(75, out.budget)
    end)
end)

--=============================================================================
describe("commitment hysteresis (anti-thrash)", function()
    -- One DEFEND goal, two packages. Package B scores higher raw, but a fresh
    -- commitment to A must survive unless B clears current × 1.4 (§3.3).
    local function twoPackageFixture()
        local role = fullSideRole()
        return makePicture({
            _role = role,
            regions = {
                home  = { owner = 0, value = 1.5, neighbors = { 'front' } },
                front = { owner = 1, value = 1.0, neighbors = { 'home' } },
            },
            intel   = { front = { strength = 500, confidence = 1.0, lastSeenFrame = 1000 } },
            ledger  = { home = { strength = 1000 }, staging = { strength = 800 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
    end

    it("keeps the current package when the challenger doesn't clear the bar", function()
        local commitments = {
            ['def:home'] = { packageId = 'pkg:home', sinceFrame = 1000, score = 145 },
        }
        local out = plan(twoPackageFixture(), commitments)
        assert.are.equal('pkg:home', commitments['def:home'].packageId)
        -- The emitted DEFEND posture targets the retained package.
        local groupId
        for _, d in ipairs(out.directives) do
            if d.goalId == 'def:home' then groupId = d.groupId end
        end
        assert.are.equal('pkg:home', groupId)
    end)

    it("flips when the challenger clears current × 1.4", function()
        local commitments = {
            ['def:home'] = { packageId = 'pkg:home', sinceFrame = 1000, score = 100 },
        }
        plan(twoPackageFixture(), commitments)
        assert.are.equal('pkg:staging', commitments['def:home'].packageId)
    end)
end)

--=============================================================================
describe("force floor (mass or skip, §3.3)", function()
    local function assaultFixture(packageStrength)
        local role = fullSideRole()
        return makePicture({
            _role = role,
            regions = { ridge = { owner = 1, value = 1.0, neighbors = {} } },
            board = {
                ['1'] = { type = 'control', scope = 'strategic', state = 'active',
                          team = nil, reward = 500, region = 'ridge', source = 'systemic' },
            },
            intel   = { ridge = { strength = 5000, confidence = 1.0, lastSeenFrame = 1000 } },
            ledger  = { ridge = { strength = packageStrength } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
    end

    local function hasObjectiveDirective(out)
        for _, d in ipairs(out.directives) do
            if type(d.goalId) == 'string' and d.goalId:sub(1, 4) == 'obj:' then
                return true
            end
        end
        return false
    end

    it("skips an undersized package against a defended objective", function()
        local out = plan(assaultFixture(200))    -- pSuccess ≈ 0.002 < 0.6
        assert.is_false(hasObjectiveDirective(out))
    end)

    it("commits once the package is massed", function()
        local out = plan(assaultFixture(20000))   -- pSuccess ≈ 0.94 ≥ 0.6
        assert.is_true(hasObjectiveDirective(out))
    end)
end)

--=============================================================================
describe("EXPAND (rich AI takes open ground, §11)", function()
    it("issues a TAKE_AND_HOLD directive into open neutral ground when rich", function()
        local role = fullSideRole()
        local p = makePicture({
            _role = role,
            regions = {
                home   = { owner = 0, value = 1.5, neighbors = { 'plains' } },
                plains = { owner = nil, value = 2.0, neighbors = { 'home' } },
            },
            ledger  = { home = { strength = 1000 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
        local out = plan(p)
        local expand
        for _, d in ipairs(out.directives) do
            if d.goalId == 'exp:plains' then expand = d end
        end
        assert.is_truthy(expand)
        assert.are.equal('directive', expand.type)
        assert.are.equal('TAKE_AND_HOLD', expand.directive)
    end)
end)

--=============================================================================
describe("DEFEND outranks EXPAND on a threatened high-value region (§11)", function()
    it("the one available package defends home, not the open ground next door", function()
        local role = fullSideRole()
        local p = makePicture({
            _role = role,
            regions = {
                home   = { owner = 0, value = 3.0, neighbors = { 'front', 'plains' } },
                front  = { owner = 1, value = 1.0, neighbors = { 'home' } },
                plains = { owner = nil, value = 2.0, neighbors = { 'home' } },
            },
            intel   = { front = { strength = 500, confidence = 1.0, lastSeenFrame = 1000 } },
            ledger  = { home = { strength = 1000 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
        local out = plan(p)
        local defendGroup, expandSeen
        for _, d in ipairs(out.directives) do
            if d.goalId == 'def:home' then defendGroup = d.groupId end
            if d.goalId == 'exp:plains' then expandSeen = true end
        end
        assert.are.equal('pkg:home', defendGroup)
        assert.is_falsy(expandSeen)
    end)
end)

--=============================================================================
describe("bounty ×3 weighting flips a marginal choice (co-commander, §11)", function()
    -- One package, two claimants: open ground (EXPAND) scores higher raw than
    -- a modest staked bounty. A full-side AI (no delegation weighting) takes
    -- the ground; a co-commander's delegation-first ×3 (plus opportunism)
    -- flips the same fixture toward the bounty a teammate tasked it with.
    local function biddingFixture(role)
        return {
            _role = role,
            regions = {
                home   = { owner = 0, value = 1.0, neighbors = { 'plains' } },
                plains = { owner = nil, value = 2.0, neighbors = { 'home' } },
            },
            board = {
                ['1'] = { type = 'kill', scope = 'strategic', state = 'active',
                          team = nil, source = 'bounty', reward = 150 },
            },
            ledger  = { home = { strength = 1000 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        }
    end

    local function winners(out)
        local expandWon, bountyWon = false, false
        for _, d in ipairs(out.directives) do
            if d.goalId == 'exp:plains' then expandWon = true end
            if d.goalId == 'obj:1' then bountyWon = true end
        end
        return expandWon, bountyWon
    end

    it("a full-side AI prefers the open ground over the modest bounty", function()
        local role = fullSideRole()
        local out = plan(makePicture(biddingFixture(role)))
        local expandWon, bountyWon = winners(out)
        assert.is_true(expandWon)
        assert.is_false(bountyWon)
    end)

    it("a co-commander's ×3 bounty weighting flips it to the bounty", function()
        local role = coCommanderRole()
        local out = plan(makePicture(biddingFixture(role)), nil, caretakerProfile)
        local expandWon, bountyWon = winners(out)
        assert.is_true(bountyWon)
        assert.is_false(expandWon)
    end)
end)

--=============================================================================
describe("dead-goal cleanup (E1, §11)", function()
    it("drops a commitment whose goal vanished from the slate and frees its package", function()
        local role = fullSideRole()
        local p = makePicture({
            _role = role,
            regions = {
                home   = { owner = 0, value = 1.5, neighbors = { 'plains' } },
                plains = { owner = nil, value = 2.0, neighbors = { 'home' } },
            },
            ledger  = { home = { strength = 1000 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
        -- A stale commitment to an objective that no longer exists on the
        -- board this tick (completed/expired between ticks — §8 E1).
        local commitments = {
            ['obj:999'] = { packageId = 'pkg:home', sinceFrame = 100, score = 999 },
        }
        local out = plan(p, commitments)
        assert.is_nil(commitments['obj:999'])
        local expand
        for _, d in ipairs(out.directives) do
            if d.goalId == 'exp:plains' then expand = d end
        end
        assert.is_truthy(expand)
        assert.are.equal('pkg:home', expand.groupId)
    end)
end)

--=============================================================================
describe("reproducibility (§10)", function()
    it("identical Picture ⇒ identical directives", function()
        local role = fullSideRole()
        local function build()
            return makePicture({
                _role = role,
                regions = { home = { owner = 0, value = 1.5, neighbors = { 'front' } },
                            front = { owner = 1, value = 1.0, neighbors = { 'home' } } },
                intel = { front = { strength = 500, confidence = 1.0, lastSeenFrame = 1000 } },
                ledger = { home = { strength = 1000 } },
                economy = { ownPool = 1000, teamPool = 0, costScale = 1.0 },
            })
        end
        local a = plan(build())
        local b = plan(build())
        assert.are.equal(#a.directives, #b.directives)
        for i = 1, #a.directives do
            assert.are.equal(a.directives[i].goalId, b.directives[i].goalId)
            assert.are.equal(a.directives[i].groupId, b.directives[i].groupId)
        end
    end)
end)

--=============================================================================
describe("co-commander etiquette (§5.1/§11)", function()
    local Actuators = require('actuators')

    it("idle-only filtering: busy packages are untouchable", function()
        -- Co-commander role with idleOnly=true should only assign idle force.
        -- Test with ONE package idle and ONE busy, and ONE objective that both
        -- could contest — the busy one should be excluded and go to RESERVE.
        local role = coCommanderRole()
        local p = makePicture({
            _role = role,
            regions = {
                home   = { owner = 0, value = 1.0, neighbors = { 'front' } },
                front  = { owner = 1, value = 2.0, neighbors = { 'home' } },  -- enemy region
            },
            board   = {
                -- One objective: assault the front. Both packages could do it, but
                -- only the idle one should be assigned. Note: board is a MAP not array!
                assault_front = {
                    type = 'kill', scope = 'platoon',
                    state = 'active', reward = 500, team = nil, progress = 0,
                    region = 'front', pos = {x = 1000, z = 1000},
                },
            },
            ledger  = {
                home   = { strength = 500, idle = true, groups = {} },   -- idle package
                front  = { strength = 600, idle = false, groups = {} },  -- busy package at the front
            },
            economy = { ownPool = 10000, teamPool = 0, costScale = 1.0 },
        })

        local out = plan(p)
        -- Assert: the objective should be assigned to the idle package ONLY.
        -- The busy package should be filtered out during scoring (touchable=false).
        local assigned = {}
        for _, d in ipairs(out.directives) do
            if d.goalId == 'obj:assault_front' then
                assigned[#assigned + 1] = d.groupId
            end
        end
        assert.are.equal(1, #assigned, "objective should be assigned to exactly one package")
        assert.are.equal('pkg:home', assigned[1], "idle package should win the objective")

        -- Verify the busy package did NOT get the objective (core etiquette test).
        for _, d in ipairs(out.directives) do
            if d.goalId == 'obj:assault_front' then
                assert.are_not.equal('pkg:front', d.groupId, "busy package must not be assigned")
            end
        end
    end)

    it("suggest-only mode (mentor profile): no real commands issued", function()
        -- Mentor profile has suggest_only=true; actuator should route to
        -- suggestions rather than issuing real directives.
        local mentorProfile = require('profiles.mentor')
        local role = coCommanderRole()
        local chatLog = {}  -- mock chat sink

        local actuators = Actuators.new({ role = role, profile = mentorProfile })
        -- Override chat to capture output.
        function actuators:chat(msg) table.insert(chatLog, msg) end

        local testPlan = {
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'plains', goalId = 'exp:plains', predictedCost = 50 },
            },
            intent = {},
        }
        local picture = { frame = 1000 }
        actuators:apply(testPlan, picture)

        -- Assert: no real directive was issued (issueDirective was NOT called),
        -- but a suggestion was emitted via chat.
        assert.are.equal(1, #chatLog)
        assert.is_truthy(chatLog[1]:match('%[mentor%]'))
        assert.is_truthy(chatLog[1]:match('Suggest'))
    end)

    it("suggest-only rate limiting: respects suggest_period_sec", function()
        local mentorProfile = require('profiles.mentor')
        local role = coCommanderRole()
        local chatLog = {}
        local actuators = Actuators.new({ role = role, profile = mentorProfile })
        function actuators:chat(msg) table.insert(chatLog, msg) end

        local testPlan = {
            directives = {
                { type = 'directive', directive = 'DEFEND', groupId = 'pkg:home',
                  region = 'home', goalId = 'def:home', predictedCost = 10 },
            },
            intent = {},
        }

        -- First tick: suggestion emitted.
        actuators:apply(testPlan, { frame = 1000 })
        assert.are.equal(1, #chatLog)

        -- Second tick 10 seconds later (300 frames): should be rate-limited.
        -- mentor.lua has suggest_period_sec=45, so 45*30=1350 frames.
        actuators:apply(testPlan, { frame = 1300 })
        assert.are.equal(1, #chatLog)  -- still just one (rate-limited)

        -- Third tick 46 seconds later: now allowed.
        actuators:apply(testPlan, { frame = 2400 })
        assert.are.equal(2, #chatLog)  -- second suggestion emitted
    end)
end)

--=============================================================================
describe("guidance stance re-weights the slate (binding, §6.2)", function()
    -- One package, a threatened home (DEFEND) and open ground next door
    -- (EXPAND). The stance a human sets decides which the package takes:
    -- defensive holds home, aggressive pushes into the open ground.
    local function stanceFixture(stance)
        local role = fullSideRole()
        return makePicture({
            _role = role,
            regions = {
                home   = { owner = 0, value = 1.0, neighbors = { 'front', 'plains' } },
                front  = { owner = 1, value = 1.0, neighbors = { 'home' } },
                plains = { owner = nil, value = 1.0, neighbors = { 'home' } },
            },
            intel   = { front = { strength = 8, confidence = 1.0, lastSeenFrame = 1000 } },
            -- Small package so directive/posture COST asymmetry doesn't swamp
            -- the stance signal — this test isolates the stance value multiplier.
            ledger  = { home = { strength = 10 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
            guidance = { stance = stance, regionPaint = {}, assetLocks = {},
                         delegated = {}, veto = {} },
        })
    end

    local function outcome(out)
        local defend, expand = false, false
        for _, d in ipairs(out.directives) do
            if d.goalId == 'def:home' then defend = true end
            if d.goalId == 'exp:plains' then expand = true end
        end
        return defend, expand
    end

    it("defensive stance holds home instead of expanding", function()
        local defend, expand = outcome(plan(stanceFixture('defensive')))
        assert.is_true(defend)
        assert.is_false(expand)
    end)

    it("aggressive stance pushes into the open ground instead of holding", function()
        local defend, expand = outcome(plan(stanceFixture('aggressive')))
        assert.is_true(expand)
        assert.is_false(defend)
    end)
end)

--=============================================================================
describe("suggested_for ×2 weighting (co-commander soft tasking, §5.1)", function()
    -- Same shape as the bounty ×3 test, but the tasking is the softer
    -- `suggested` hint published on the board (picture threads it onto
    -- meta.suggested). A full-side AI ignores it; a co-commander's ×2 pulls it.
    local function fixture(role)
        return makePicture({
            _role = role,
            regions = {
                home   = { owner = 0, value = 1.0, neighbors = { 'plains' } },
                plains = { owner = nil, value = 1.5, neighbors = { 'home' } },
            },
            board = {
                -- reward 200 < EXPAND raw value (1.5 × 200 = 300) < 2 × 200:
                -- full-side takes the ground, the ×2 suggested flips it.
                ['1'] = { type = 'control', scope = 'strategic', state = 'active',
                          team = -1, region = 'target', reward = 200, suggested = 1 },
            },
            ledger  = { home = { strength = 1000 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
    end

    local function winners(out)
        local expandWon, objWon = false, false
        for _, d in ipairs(out.directives) do
            if d.goalId == 'exp:plains' then expandWon = true end
            if d.goalId == 'obj:1' then objWon = true end
        end
        return expandWon, objWon
    end

    it("a full-side AI takes the open ground over the suggested objective", function()
        local expandWon, objWon = winners(plan(fixture(fullSideRole())))
        assert.is_true(expandWon)
        assert.is_false(objWon)
    end)

    it("a co-commander's ×2 suggested weighting flips it to the objective", function()
        local expandWon, objWon =
            winners(plan(fixture(coCommanderRole()), nil, caretakerProfile))
        assert.is_true(objWon)
        assert.is_false(expandWon)
    end)
end)

--=============================================================================
-- The terminal objective (endtoend Q-E1 / D47, answer A: the AI must want the
-- prize). The fixture is fire 23's war in miniature: the enemy stands on the
-- region whose control objective ENDS THE WAR, our army is its equal (so
-- pSuccess ≈ 0.5, under the 0.6 floor), and a safe side objective is available.
-- Before the fix the planner could not see `victory` at all, priced the war at
-- 300 authority against the side objective's 110, and skipped the prize on the
-- floor — two wars ran to the same frame with 14 player directives and with 0.
describe("terminal objective is contested (Q-E1 / D47)", function()
    -- `victory` is passed through as the board publishes it (1 / absent) so
    -- the same fixture with the flag removed is the null control.
    local function warFixture(victory, progress, prizeOwner)
        local role = fullSideRole()
        return makePicture({
            _role = role,
            regions = {
                home  = { owner = 0,          value = 1.0, neighbors = { 'raven' } },
                raven = { owner = prizeOwner, value = 1.0, neighbors = { 'home', 'side' } },
                side  = { owner = nil,        value = 1.0, neighbors = { 'raven' } },
            },
            board = {
                ['1'] = { type = 'control', scope = 'strategic', state = 'active',
                          team = -1, region = 'raven', reward = 300,
                          progress = progress or 0, victory = victory },
                ['2'] = { type = 'control', scope = 'tactical', state = 'active',
                          team = -1, region = 'side', reward = 110, progress = 0 },
            },
            -- Equal armies: pSuccess = 1000²/(1000²+1000²) = 0.5 < PSUCCESS_FLOOR.
            intel   = { raven = { strength = 1000, confidence = 1.0, lastSeenFrame = 1000 } },
            ledger  = { home = { strength = 1000 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
    end

    local function directiveFor(out, goalId)
        for _, d in ipairs(out.directives) do
            if d.goalId == goalId then return d end
        end
        return nil
    end

    it("NULL CONTROL: an unflagged 300-reward control is skipped on the floor", function()
        local out = plan(warFixture(nil, 0, 1))
        assert.is_nil(directiveFor(out, 'obj:1'))
    end)

    it("marches on a defended prize the same fixture otherwise skips", function()
        local out = plan(warFixture(1, 0, 1))
        local d = directiveFor(out, 'obj:1')
        assert.is_truthy(d)
        assert.are.equal('TAKE_AND_HOLD', d.directive)
    end)

    it("outranks a side objective for the one available package", function()
        local out = plan(warFixture(1, 0, 1))
        assert.is_truthy(directiveFor(out, 'obj:1'))
        assert.is_nil(directiveFor(out, 'obj:2'))
    end)

    it("a hopeless attack is still refused while the hold clock is young", function()
        local p = warFixture(1, 0, 1)
        -- 5:1 against: pSuccess ≈ 0.04, under even VICTORY_PSUCCESS_FLOOR.
        p.intel.raven.strength = 5000
        assert.is_nil(directiveFor(plan(p), 'obj:1'))
    end)

    it("and is taken anyway once the holder is about to bank the war", function()
        local p = warFixture(1, 0.9, 1)
        p.intel.raven.strength = 5000
        assert.is_truthy(directiveFor(plan(p), 'obj:1'))
    end)

    it("holds a prize of our own against odds that would rout a side objective", function()
        local p = warFixture(1, 0.5, 0)      -- we own raven and are banking it
        p.intel.raven.strength = 5000        -- contested by a much larger force
        local d = directiveFor(plan(p), 'obj:1')
        assert.is_truthy(d)
        assert.are.equal('TAKE_AND_HOLD', d.directive)
    end)
end)

--=============================================================================
-- Mass, not thrift, picks the package for the terminal objective (fire 24).
-- `score = value·pSuccess − cost` with cost scaling in package strength means
-- the CHEAPEST package maximises the score for any goal whose pSuccess is the
-- flat no-intel prior — so the planner sent 3 units at the war and left 14 on
-- a rear posture. Two packages, one prize, no intel: the big one must go.
describe("the terminal objective takes the strongest package (fire 24)", function()
    local function twoPackageFixture(victory)
        local role = fullSideRole()
        return makePicture({
            _role = role,
            regions = {
                home  = { owner = 0,   value = 1.0, neighbors = { 'raven' } },
                bend  = { owner = 0,   value = 1.0, neighbors = { 'raven' } },
                raven = { owner = nil, value = 1.0, neighbors = { 'home', 'bend' } },
            },
            board = {
                ['1'] = { type = 'control', scope = 'strategic', state = 'active',
                          team = -1, region = 'raven', reward = 300,
                          progress = 0, victory = victory },
            },
            ledger  = { home = { strength = 3 }, bend = { strength = 14 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
    end

    local function packageFor(out, goalId)
        for _, d in ipairs(out.directives) do
            if d.goalId == goalId then return d.groupId end
        end
        return nil
    end

    it("NULL CONTROL: unflagged, thrift wins and the 3-force fragment is sent", function()
        assert.are.equal('pkg:home', packageFor(plan(twoPackageFixture(nil)), 'obj:1'))
    end)

    it("flagged, the 14-force package is sent at the prize", function()
        assert.are.equal('pkg:bend', packageFor(plan(twoPackageFixture(1)), 'obj:1'))
    end)
end)

--=============================================================================
-- Commitment hysteresis must not pin the war to a rump (fire 24). A package is
-- identified by the region its units stand in, so a marching army is re-bucketed
-- under a new id and the goal's commitment stays on whatever was left behind;
-- the ×1.4 reassign bar then makes that permanent. Reproduced with a commitment
-- on the 3-force home package while 14 units stand one region on.
describe("the terminal objective is not pinned to a stale package (fire 24)", function()
    local function marchedFixture(victory)
        local role = fullSideRole()
        return makePicture({
            _role = role,
            regions = {
                home  = { owner = 0,   value = 1.0, neighbors = { 'raven' } },
                bend  = { owner = 0,   value = 1.0, neighbors = { 'raven' } },
                raven = { owner = nil, value = 1.0, neighbors = { 'home', 'bend' } },
            },
            board = {
                ['1'] = { type = 'control', scope = 'strategic', state = 'active',
                          team = -1, region = 'raven', reward = 300,
                          progress = 0, victory = victory },
            },
            ledger  = { home = { strength = 3 }, bend = { strength = 14 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
        })
    end

    -- The commitment the whole 17-unit army earned before it marched.
    local function pinnedToHome()
        return { ['obj:1'] = { packageId = 'pkg:home', sinceFrame = 0, score = 189 } }
    end

    local function packageFor(out, goalId)
        for _, d in ipairs(out.directives) do
            if d.goalId == goalId then return d.groupId end
        end
        return nil
    end

    it("NULL CONTROL: an unflagged goal stays pinned to the 3-force rump", function()
        assert.are.equal('pkg:home',
            packageFor(plan(marchedFixture(nil), pinnedToHome()), 'obj:1'))
    end)

    it("the terminal objective moves to the marched 14-force package", function()
        assert.are.equal('pkg:bend',
            packageFor(plan(marchedFixture(1), pinnedToHome()), 'obj:1'))
    end)
end)

describe("a human's veto is excluded AND reported (PLAN-ai-synced-write task 5)", function()
    -- Two goals the planner would otherwise both pursue, and one package. The
    -- veto is on the one it prefers, so the observable is not just "the other
    -- one won" — it is that the plan NAMES the vetoed goal, which is what
    -- `make test-ai-veto-loop` reads off the tick line.
    local function vetoFixture(vetoed)
        local role = fullSideRole()
        local veto = {}
        if vetoed then veto[vetoed] = true end
        return makePicture({
            _role = role,
            regions = {
                home   = { owner = 0, value = 1.0, neighbors = { 'plains', 'ridge' } },
                plains = { owner = nil, value = 2.0, neighbors = { 'home' } },
                ridge  = { owner = nil, value = 1.0, neighbors = { 'home' } },
            },
            ledger  = { home = { strength = 10 } },
            economy = { ownPool = 100000, teamPool = 0, costScale = 1.0 },
            guidance = { regionPaint = {}, assetLocks = {}, delegated = {}, veto = veto },
        })
    end

    local function ids(list)
        local out = {}
        for _, v in ipairs(list or {}) do out[#out + 1] = v end
        table.sort(out)
        return out
    end

    it("NULL CONTROL: with no veto, nothing is reported and the goal is live", function()
        local out = plan(vetoFixture(nil))
        assert.are.same({}, ids(out.vetoed))
        local sawPlains = false
        for _, d in ipairs(out.directives) do
            if d.goalId == 'exp:plains' then sawPlains = true end
        end
        assert.is_true(sawPlains)
    end)

    it("the vetoed goal is dropped from the directives and named in the plan", function()
        local out = plan(vetoFixture('exp:plains'))
        assert.are.same({ 'exp:plains' }, ids(out.vetoed))
        for _, d in ipairs(out.directives) do
            assert.are_not.equal('exp:plains', d.goalId)
        end
    end)

    it("the report comes from the exclusion, not from the veto list", function()
        -- The distinction the live gate depends on: a veto naming a goal that is
        -- not on this tick's slate must NOT be reported, because nothing was
        -- excluded. A report recomputed from `guidance.veto` would name it, and
        -- would then keep naming it for a planner that had stopped acting.
        local out = plan(vetoFixture('exp:nowhere'))
        assert.are.same({}, ids(out.vetoed))
    end)
end)
