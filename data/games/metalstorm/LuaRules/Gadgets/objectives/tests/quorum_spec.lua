-- tests/quorum_spec.lua — `params.quorum` validation across the four types
-- that take one (2026-09-10 review, F14).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/
--
-- Quorum is a count of things in a named roster, so the only meaningful values
-- are whole numbers in 1..roster. The two ways out of that range are not
-- symmetrical in how they FEEL, which is why neither was noticed:
--
--   * q <= 0  — "keep at least zero of them alive" is trivially true forever,
--     so protect/infra can never fail and pay out at expiry no matter what
--     happened to the roster;
--   * q > roster — unreachable, so escort/extract can never complete, and the
--     objective just sits on the board until it times out.
--
-- Both read as a quiet balance problem rather than a bad def, and neither
-- raises. validateParams is the only place that can still tell the difference,
-- because it is the only place that still has the authored roster in hand.

package.path = './?.lua;' .. package.path

local escort  = require('escort')
local protect = require('protect')
local extract = require('extract')
local infra   = require('infra')

local AREA = { x = 100, z = 200, r = 300 }

--- One entry per type: a params table that is otherwise valid, plus the
--- roster size the quorum is measured against.
local CASES = {
    {
        name = 'escort',
        validate = escort.validateParams,
        roster = 3,
        params = function()
            return {
                transportUnitIDs = { 1, 2, 3 },
                extractArea = { x = AREA.x, z = AREA.z, r = AREA.r },
            }
        end,
    },
    {
        name = 'protect',
        validate = protect.validateParams,
        roster = 3,
        params = function() return { targetUnitIDs = { 1, 2, 3 } } end,
    },
    {
        name = 'extract',
        validate = extract.validateParams,
        roster = 3,
        params = function()
            return {
                payloadUnitIDs = { 1, 2, 3 },
                pickupArea  = { x = 0, z = 0, r = 100 },
                extractArea = { x = AREA.x, z = AREA.z, r = AREA.r },
                holdFrames = 90,
                threshold = 0,
            }
        end,
    },
    {
        name = 'infra',
        validate = infra.validateParams,
        roster = 3,
        params = function() return { buildingUnitIDs = { 1, 2, 3 } } end,
    },
}

for _, case in ipairs(CASES) do
    describe(case.name .. '.validateParams quorum', function()
        local function withQuorum(q)
            local p = case.params()
            p.quorum = q
            return case.validate(p)
        end

        it('accepts an absent quorum (each type has its own default)', function()
            assert.is_true((case.validate(case.params())))
        end)

        it('accepts 1', function()
            assert.is_true((withQuorum(1)))
        end)

        it('accepts the whole roster', function()
            assert.is_true((withQuorum(case.roster)))
        end)

        it('rejects zero — it would make the objective unfailable', function()
            local ok, err = withQuorum(0)
            assert.is_false(ok)
            assert.is_string(err)
        end)

        it('rejects a negative quorum', function()
            local ok, err = withQuorum(-1)
            assert.is_false(ok)
            assert.is_string(err)
        end)

        it('rejects more than the roster — unwinnable by construction', function()
            local ok, err = withQuorum(case.roster + 1)
            assert.is_false(ok)
            assert.is_string(err)
        end)

        it('rejects a fractional quorum', function()
            local ok, err = withQuorum(1.5)
            assert.is_false(ok)
            assert.is_string(err)
        end)

        it('rejects a non-number', function()
            local ok, err = withQuorum('2')
            assert.is_false(ok)
            assert.is_string(err)
        end)
    end)
end
