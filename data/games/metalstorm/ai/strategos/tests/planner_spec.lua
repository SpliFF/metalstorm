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

    it("a broke AI turtles — only DEFEND postures go out", function()
        local out = plan(economyFixture(0))
        assert.is_true(out.posturesOnly)
        assert.are.equal(0, countType(out.directives, 'directive'))
        assert.is_true(countType(out.directives, 'posture') >= 1)
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
