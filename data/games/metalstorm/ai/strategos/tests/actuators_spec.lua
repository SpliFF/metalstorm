-- tests/actuators_spec.lua — the write surface (PLAN-metalstorm-ai.md §4,
-- §10 task 5). Run from the plugin root:  busted tests/  (cwd = ai/strategos/).
--
-- AI2 landed: the actuator drives the REAL directive-shaped verbs
-- (AI.createGroup / issueDirective / setPosture) and the pre-AI2 standing-order
-- fallback is DELETED. These specs mock `_G.AI`'s directive verbs, drive
-- `Actuators:apply`, and assert the numeric engine spec the actuator builds —
-- plus the structural guarantees: no per-squad command verb is ever reached,
-- and the fallback machinery is gone.

package.path = './?.lua;' .. package.path

local Config = require('config')
local Roles  = require('roles')

--=============================================================================
-- Mock the AI2 write surface. Records every verb call so the spec can assert
-- on the exact numeric spec that would go over the command queue.
--=============================================================================
-- `log.queue` is the ORDER-PRESERVING record of every command pushed, which is
-- the whole correlation mechanism for the `ai.intent` tag (PLAN-ai-synced-write
-- §2.5): the engine drains one queue in push order, so a tag that is recorded
-- after its directive here would arrive after its charge in the sim. Asserting
-- only on `log.messages` and `log.directives` separately cannot see that.
local function makeAI(opts)
    opts = opts or {}
    local log = { directives = {}, postures = {}, groups = {}, commands = {},
                  messages = {}, queue = {}, chats = {} }
    _G.AI = {
        createGroup = function(squads, echelon)
            log.groups[#log.groups + 1] = { squads = squads, echelon = echelon }
            return -(#log.groups)         -- negative token handle
        end,
        issueDirective = not opts.noIssueDirective and function(handle, spec)
            log.directives[#log.directives + 1] = { handle = handle, spec = spec }
            log.queue[#log.queue + 1] = { verb = 'issueDirective', spec = spec }
            return true
        end or nil,
        setPosture = function(handle, json)
            log.postures[#log.postures + 1] = { handle = handle, json = json }
            return true
        end,
        -- A per-squad command verb the actuator must NEVER call (strategic
        -- floor). Present so a violation is caught as a recorded call, not a
        -- nil-index crash.
        issueCommand = function(...) log.commands[#log.commands + 1] = { ... } end,
        -- Narration sink. Present because the announcement is the surface D68
        -- was FOUND on — a fire read "Taking Raven Basin — 3 force" off a live
        -- chat log while the basin was empty — so what it says is a testable
        -- product, not flavour.
        chat = function(msg) log.chats[#log.chats + 1] = tostring(msg) end,
    }
    -- I1/SG1's message verb. `opts.noSendMessage` stages an engine that predates
    -- it, so the feature-detect degrade path is covered rather than assumed.
    if not opts.noSendMessage then
        _G.AI.sendMessage = function(msg)
            log.messages[#log.messages + 1] = msg
            log.queue[#log.queue + 1] = { verb = 'sendMessage', msg = msg }
            return true
        end
    end
    return log
end

local function fullSideRole()
    local role = Roles.resolve('full_side', Config)
    role.teamId = 1
    return role
end

-- A Picture with two square regions, each carrying a polygon so the actuator
-- can resolve a directive anchor (centroid) — the SAME geometry picture.lua
-- loads from regions.json.
local function pictureWithRegions()
    return {
        frame = 1000,
        regions = {
            home  = { owner = 1, value = 10, neighbors = { 'front' },
                      polygon = { {x=0,z=0}, {x=100,z=0}, {x=100,z=100}, {x=0,z=100} } },
            front = { owner = -1, value = 20, neighbors = { 'home' },
                      polygon = { {x=100,z=0}, {x=200,z=0}, {x=200,z=100}, {x=100,z=100} } },
        },
    }
end

describe("actuators — AI2 real verb path (§4/§10 task 5)", function()
    local Actuators = require('actuators')

    it("the standing-order fallback is DELETED (no fallback machinery remains)", function()
        assert.is_nil(Actuators._standingOrderFallback)
        assert.is_nil(Actuators._directiveToStandingCmd)
        -- No instance method for it either.
        makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })
        assert.is_nil(a._standingOrderFallback)
        assert.is_nil(a._directiveToStandingCmd)
    end)

    it("a directive is issued through AI.issueDirective with the mapped type + anchor", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })

        a:apply({
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:front', predictedCost = 50,
                  -- 4 units, 500 hitpoints: the planner emits BOTH scales and
                  -- only one of them may become the demand cap (D68).
                  strength = 4, healthStrength = 500 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(1, #log.directives)
        local d = log.directives[1]
        assert.are.equal(0, d.handle)                 -- area scope (no engine group)
        assert.are.equal(9, d.spec.type)              -- TAKE_AND_HOLD → Assault(9)
        assert.are.equal(1, d.spec.shape)             -- Circle
        -- Anchor is the FRONT centroid (150, 50), radius > 0.
        assert.are.equal(150, d.spec.params[1])
        assert.are.equal(50,  d.spec.params[3])
        assert.is_true(d.spec.params[4] > 0)
        -- Demand cap in the ENGINE's scale (hitpoints), never the head count.
        assert.are.equal(500, d.spec.requestedStrength)

        -- Structural floor: the per-squad command verb was NEVER touched.
        assert.are.equal(0, #log.commands)
    end)

    -- endtoend D68. THE defect: the cap was stated in the planner's own scale
    -- (a damage-discounted head count) and the engine reads it as hitpoints, so
    -- the first unit assigned met a cap of "3" and every directive recruited
    -- exactly one unit however much force it announced.
    it("the demand cap is the package's hitpoints, not its head count (D68)", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })

        a:apply({
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:front', predictedCost = 50,
                  strength = 3, healthStrength = 3600 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(1, #log.directives)
        assert.are.equal(3600, log.directives[1].spec.requestedStrength)
        -- The head count must not appear anywhere in the spec. A cap of 3 is
        -- the bug, and a cap of 3 is what a re-inlined `d.strength` produces.
        assert.are_not.equal(3, log.directives[1].spec.requestedStrength)
    end)

    -- The announcement keeps speaking the AI's scale — "3 force" means three
    -- units, and is honest. Pinned so nobody "fixes" the narration to hitpoints
    -- while chasing D68.
    it("narrates the head count while capping on hitpoints (D68)", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })

        a:apply({
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:front', predictedCost = 50,
                  strength = 3, healthStrength = 3600 },
            },
            intent = {},
        }, pictureWithRegions())

        local said = table.concat(log.chats or {}, "\n")
        assert.is_truthy(said:find("3 force", 1, true))
        assert.is_nil(said:find("3600 force", 1, true))
    end)

    -- A package the Picture could not price at all sends 0 = "take what idles"
    -- (uncapped), NOT 1. Sending 1 is the D68 failure mode by another route: it
    -- reads as one hitpoint and shuts the cap on the first recruit.
    it("an unpriced package asks for no cap rather than a cap of one (D68)", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })

        a:apply({
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:front', strength = 3 },  -- no healthStrength
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(1, #log.directives)
        assert.are.equal(0, log.directives[1].spec.requestedStrength)
    end)

    -- D68's third mechanism, and the one only a live run found: the planner
    -- re-states its whole plan every tick and `expiresInFrames` was never set,
    -- so 0 = "forever" and the team accumulated a live directive per goal per
    -- tick. Measured at 107 on one team by frame 6 000, all of them commanding
    -- the same eight units.
    it("every directive expires with the plan that issued it (D68)", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })

        local plan = {
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', strength = 3, healthStrength = 3600 },
                { type = 'posture', directive = 'DEFEND', groupId = 'pkg:home',
                  region = 'home', strength = 3, healthStrength = 3600 },
            },
            intent = {},
        }
        a:apply(plan, pictureWithRegions(), { tickFrames = 150 })

        assert.are.equal(2, #log.directives)
        for _, d in ipairs(log.directives) do
            -- Two ticks' worth: survives its own tick and one late one, then dies.
            assert.are.equal(300, d.spec.expiresInFrames)
        end
    end)

    -- A dormant NPC sleeps for up to 60 s (LOD 3). Its orders must not expire
    -- 20 s in, or the army stands still for the rest of the nap.
    it("the lifetime follows the LOD-adjusted tick period (D68)", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })
        local plan = {
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', strength = 3, healthStrength = 3600 },
            },
            intent = {},
        }
        a:apply(plan, pictureWithRegions(), { tickFrames = 1800 })   -- LOD 3
        assert.are.equal(3600, log.directives[1].spec.expiresInFrames)
    end)

    -- A caller that says nothing must still get a mortal directive. 0 is the
    -- engine's "no expiry" and is the value that produced the 107.
    it("a caller that states no tick period still issues a mortal directive (D68)", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })
        a:apply({
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', strength = 3, healthStrength = 3600 },
            },
            intent = {},
        }, pictureWithRegions())

        local ttl = log.directives[1].spec.expiresInFrames
        assert.is_true(ttl > 0)
        assert.are.equal(450, ttl)
    end)

    it("an unmapped directive name or a region with no geometry is skipped, not faked", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })

        a:apply({
            directives = {
                -- Unknown directive name → no engine type → skipped.
                { type = 'directive', directive = 'MICRO_KITE', groupId = 'pkg:home',
                  region = 'front', strength = 100 },
                -- Known name but a region absent from the Picture → no geometry → skipped.
                { type = 'directive', directive = 'DEFEND', groupId = 'pkg:home',
                  region = 'nowhere', strength = 100 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(0, #log.directives)
        assert.are.equal(0, #log.commands)
    end)

    it("a DEFEND posture goal issues the always-affordable hold directive", function()
        local log = makeAI()
        local a = Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })

        a:apply({
            directives = {
                { type = 'posture', directive = 'DEFEND', groupId = 'pkg:home',
                  region = 'home', goalId = 'def:home', predictedCost = 5, strength = 300 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(1, #log.directives)
        assert.are.equal(10, log.directives[1].spec.type)   -- DEFEND → Defend(10)
        -- Home centroid (50, 50).
        assert.are.equal(50, log.directives[1].spec.params[1])
        assert.are.equal(50, log.directives[1].spec.params[3])
    end)

    it("suggest-only mode still issues NO real directive (mentor path intact)", function()
        local log = makeAI()
        local mentor = require('profiles.mentor')
        local role = Roles.resolve('co_commander', Config); role.teamId = 1
        local a = Actuators.new({ role = role, profile = mentor })
        local chat = {}
        function a:chat(m) chat[#chat + 1] = m end

        a:apply({
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', predictedCost = 50, strength = 500 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(0, #log.directives)   -- suggestion only, no real order
        assert.are.equal(1, #chat)
        assert.is_truthy(chat[1]:match('%[mentor%]'))
        -- A suggestion is not a directive, so there is nothing to annotate: a
        -- tag here would leave a pending goal id for whatever the team's other
        -- AI issues next.
        assert.are.equal(0, #log.messages)
    end)
end)

--=============================================================================
-- The `ai.intent` tag (PLAN-ai-synced-write.md §2.5, task 3). The tag carries
-- the planner goal id across into synced Lua so the guidance gadget can
-- annotate the charge-driven intent line with it — which is what makes the
-- panel's Veto button reach `planner.lua`'s `guidance.veto[goal.id]`.
--=============================================================================
describe("actuators — ai.intent tag (I1/SG1 §2.5)", function()
    local Actuators = require('actuators')
    local Wire      = require('wire')

    local function newActuator()
        return Actuators.new({ role = fullSideRole(), profile = require('profiles.default') })
    end

    it("tags each directive with its goal id, and the tag is pushed BEFORE it", function()
        local log = makeAI()
        newActuator():apply({
            directives = {
                { type = 'directive', directive = 'TAKE_AND_HOLD', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:front', predictedCost = 50, strength = 500 },
            },
            intent = {},
        }, pictureWithRegions())

        -- Push order is the correlation: tag first, directive second.
        assert.are.equal(2, #log.queue)
        assert.are.equal('sendMessage', log.queue[1].verb)
        assert.are.equal('issueDirective', log.queue[2].verb)

        local cmd, fields = Wire.decode(log.queue[1].msg)
        assert.are.equal('ai.intent', cmd)
        assert.are.equal('exp:front', fields.goalId)   -- STRING id, uncoerced
        assert.are.equal('front', fields.region)
        assert.are.equal(9, tonumber(fields.dt))       -- the type actually issued
        assert.are.equal(log.queue[2].spec.type, tonumber(fields.dt))
    end)

    it("a DEFEND posture is tagged too (spend 0 is the case most worth vetoing)", function()
        local log = makeAI()
        newActuator():apply({
            directives = {
                { type = 'posture', directive = 'DEFEND', groupId = 'pkg:home',
                  region = 'home', goalId = 'def:home', predictedCost = 5, strength = 300 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(2, #log.queue)
        assert.are.equal('sendMessage', log.queue[1].verb)
        local _, fields = Wire.decode(log.queue[1].msg)
        assert.are.equal('def:home', fields.goalId)
        assert.are.equal(10, tonumber(fields.dt))      -- Defend(10)
    end)

    it("a SKIPPED directive sends no tag (a pending id would annotate the next one)", function()
        local log = makeAI()
        newActuator():apply({
            directives = {
                -- Unmapped name → no engine type → skipped.
                { type = 'directive', directive = 'MICRO_KITE', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:kite', strength = 100 },
                -- Known name, region absent from the Picture → no geometry → skipped.
                { type = 'directive', directive = 'DEFEND', groupId = 'pkg:home',
                  region = 'nowhere', goalId = 'def:nowhere', strength = 100 },
                -- This one really issues, and must carry ITS OWN goal id.
                { type = 'directive', directive = 'ASSAULT', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:front', strength = 200 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(1, #log.directives)
        assert.are.equal(1, #log.messages)
        local _, fields = Wire.decode(log.messages[1])
        assert.are.equal('exp:front', fields.goalId)
    end)

    it("a directive with no goal id issues untagged rather than tagging nil", function()
        local log = makeAI()
        newActuator():apply({
            directives = {
                -- Scripted-slate directives carry no planner goal (task 4(a)).
                { type = 'directive', directive = 'ASSAULT', groupId = 'pkg:home',
                  region = 'front', strength = 200 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(1, #log.directives)      -- the directive still goes out
        assert.are.equal(0, #log.messages)        -- lossless: no goal id, no line to veto
    end)

    it("an engine without the directive verb sends no tag either", function()
        -- The mirror of the case above, and the reason `_issueTagged` re-checks
        -- the cap instead of leaning on `issueDirective`'s own guard: a tag for
        -- a directive that can never be issued is a pending goal id waiting to
        -- annotate somebody else's line.
        local log = makeAI({ noIssueDirective = true })
        newActuator():apply({
            directives = {
                { type = 'directive', directive = 'ASSAULT', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:front', strength = 200 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(0, #log.directives)
        assert.are.equal(0, #log.messages)
    end)

    it("an engine without the I1 verb still issues directives (feature-detect degrade)", function()
        local log = makeAI({ noSendMessage = true })
        newActuator():apply({
            directives = {
                { type = 'directive', directive = 'ASSAULT', groupId = 'pkg:home',
                  region = 'front', goalId = 'exp:front', strength = 200 },
            },
            intent = {},
        }, pictureWithRegions())

        assert.are.equal(1, #log.directives)
        assert.are.equal(0, #log.messages)
    end)
end)
