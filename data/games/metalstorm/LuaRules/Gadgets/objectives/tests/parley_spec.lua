-- tests/parley_spec.lua — the agreement objective type (a Mission ends on a pact).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local parley = require('parley')

local function fakeCtx(rp)
    return { frame = 0, gameRulesParam = function(k) return rp[k] end }
end

local function publish(rp, id, kind, from, to, state)
    rp['parley_' .. id .. '_kind'] = kind
    rp['parley_' .. id .. '_from'] = from
    rp['parley_' .. id .. '_to'] = to
    rp['parley_' .. id .. '_state'] = state
    rp.parley_count = math.max(rp.parley_count or 0, id)
end

local function objective(params, forTeam)
    local o = { forTeam = forTeam, params = params }
    assert(parley.init(o, fakeCtx({ parley_count = 0 })))
    return o
end

describe('parley.validateParams', function()
    it('accepts an empty spec and known kinds, refuses unknown ones', function()
        assert.is_true(parley.validateParams({}))
        assert.is_true(parley.validateParams({ kind = 'intel', withTeam = 1 }))
        assert.is_false(parley.validateParams({ kind = 'treaty' }))
        assert.is_false(parley.validateParams({ withTeam = 'union' }))
    end)
end)

describe('parley.check', function()
    it('completes for the objective team once the matching pact is accepted', function()
        local o = objective({ kind = 'intel', withTeam = 1 }, 0)
        local rp = {}
        publish(rp, 1, 'intel', 0, 1, 'offered')
        assert.is_nil(parley.check(o, fakeCtx(rp)))
        assert.equals(0.5, parley.progress(o, fakeCtx(rp)))
        publish(rp, 1, 'intel', 0, 1, 'fulfilled')
        local state, team = parley.check(o, fakeCtx(rp))
        assert.equals('complete', state)
        assert.equals(0, team)
    end)

    it('counts an agreement the other side proposed', function()
        local o = objective({ kind = 'ceasefire', withTeam = 1 }, 0)
        local rp = {}
        publish(rp, 1, 'ceasefire', 1, 0, 'active')
        assert.equals('complete', parley.check(o, fakeCtx(rp)))
    end)

    it('ignores the wrong kind, a third team, and pacts older than the objective', function()
        local rp = {}
        publish(rp, 1, 'intel', 0, 1, 'fulfilled')          -- before the objective existed
        local o = { forTeam = 0, params = { kind = 'intel', withTeam = 1 } }
        parley.init(o, fakeCtx(rp))
        assert.is_nil(parley.check(o, fakeCtx(rp)))
        publish(rp, 2, 'tribute', 0, 1, 'active')           -- wrong kind
        publish(rp, 3, 'intel', 0, 2, 'active')             -- wrong partner
        assert.is_nil(parley.check(o, fakeCtx(rp)))
        publish(rp, 4, 'intel', 0, 1, 'active')
        assert.equals('complete', parley.check(o, fakeCtx(rp)))
    end)

    it('an open race completes for whoever proposed', function()
        local o = objective({}, nil)
        local rp = {}
        publish(rp, 1, 'tribute', 1, 0, 'active')
        local state, team = parley.check(o, fakeCtx(rp))
        assert.equals('complete', state)
        assert.equals(1, team)
    end)

    it('describes itself in player words', function()
        assert.equals('Agree a safe passage pact with team 1',
            parley.describe({ params = { kind = 'safe_passage', withTeam = 1 } }))
        assert.equals('Agree a pact', parley.describe({ params = {} }))
    end)
end)
