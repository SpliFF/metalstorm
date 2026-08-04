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
local function makeAI()
    local log = { directives = {}, postures = {}, groups = {}, commands = {} }
    _G.AI = {
        createGroup = function(squads, echelon)
            log.groups[#log.groups + 1] = { squads = squads, echelon = echelon }
            return -(#log.groups)         -- negative token handle
        end,
        issueDirective = function(handle, spec)
            log.directives[#log.directives + 1] = { handle = handle, spec = spec }
            return true
        end,
        setPosture = function(handle, json)
            log.postures[#log.postures + 1] = { handle = handle, json = json }
            return true
        end,
        -- A per-squad command verb the actuator must NEVER call (strategic
        -- floor). Present so a violation is caught as a recorded call, not a
        -- nil-index crash.
        issueCommand = function(...) log.commands[#log.commands + 1] = { ... } end,
    }
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
                  region = 'front', goalId = 'exp:front', predictedCost = 50, strength = 500 },
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
        assert.are.equal(500, d.spec.requestedStrength)  -- demand cap from package strength

        -- Structural floor: the per-squad command verb was NEVER touched.
        assert.are.equal(0, #log.commands)
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
    end)
end)
