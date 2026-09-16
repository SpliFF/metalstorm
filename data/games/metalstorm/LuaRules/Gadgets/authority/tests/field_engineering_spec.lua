-- tests/field_engineering_spec.lua — the "field engineering only" verdict
-- (manual §6/§12; review 2026-09-10).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/authority && busted tests/
--
-- Every case here FABRICATES the violating input (a factory asking to build a
-- tank, a builder placing a Foundry) — the shipped scenarios never issue
-- those orders, so a rule the producer already satisfies would be inert
-- without them.

package.path = './?.lua;' .. package.path

local FE = require('field_engineering')

local SPEC = {
    allowed_families = { support = true },
    allowed_defs = { ms_scenario_bunker = true },
    denied_defs  = { ms_mooring_mast = true },
}

local function def(name, isBuilding, family)
    return { name = name, isBuilding = isBuilding,
             customParams = family and { building_family = family } or {} }
end

describe("field engineering verdict", function()
    it("refuses factory output (a mobile unit) — the production economy is the world's", function()
        local ok, why = FE.verdict(SPEC, def('ms_tanks_s2', false, nil))
        assert.is_false(ok)
        assert.are.equal(FE.DENY_PRODUCTION, why)
    end)

    it("refuses a base structure outside the field tier (a Foundry, the Nexus)", function()
        local ok, why = FE.verdict(SPEC, def('ms_foundry', true, 'military'))
        assert.is_false(ok)
        assert.are.equal(FE.DENY_STRUCTURE, why)
        ok = FE.verdict(SPEC, def('ms_command_nexus', true, 'military'))
        assert.is_false(ok)
    end)

    it("admits the support tier by the tag the defs already carry", function()
        local ok, why = FE.verdict(SPEC, def('ms_watchtower', true, 'support'))
        assert.is_true(ok)
        assert.are.equal(FE.ALLOW_FAMILY, why)
    end)

    it("refuses a building with no family tag at all — fail closed", function()
        local ok, why = FE.verdict(SPEC, def('ms_mystery', true, nil))
        assert.is_false(ok)
        assert.are.equal(FE.DENY_STRUCTURE, why)
    end)

    it("refuses an unknown def — fail closed", function()
        local ok, why = FE.verdict(SPEC, nil)
        assert.is_false(ok)
        assert.are.equal(FE.DENY_UNKNOWN, why)
    end)

    it("honours a per-def allow entry whatever the family", function()
        local ok, why = FE.verdict(SPEC, def('ms_scenario_bunker', true, 'military'))
        assert.is_true(ok)
        assert.are.equal(FE.ALLOW_DEF, why)
    end)

    it("lets a deny entry win over an allowed family", function()
        local ok, why = FE.verdict(SPEC, def('ms_mooring_mast', true, 'support'))
        assert.is_false(ok)
        assert.are.equal(FE.DENY_DEF, why)
    end)

    it("bypasses everything when the battle_production escape hatch is on", function()
        local ok, why = FE.verdict(SPEC, def('ms_tanks_s4', false, nil), true)
        assert.is_true(ok)
        assert.are.equal(FE.ALLOW_ESCAPE, why)
    end)

    it("survives a partial config: an omitted list disables nothing it did not name", function()
        -- Memory trap "a partial config disables the rules it omits": a spec
        -- with no deny list must still refuse production and admit support.
        local partial = { allowed_families = { support = true } }
        assert.is_false(FE.verdict(partial, def('ms_tanks_s1', false)))
        assert.is_true(FE.verdict(partial, def('ms_barricade_set', true, 'support')))
        -- And a spec with NO family list admits nothing but explicit defs.
        assert.is_false(FE.verdict({}, def('ms_barricade_set', true, 'support')))
    end)
end)

describe("modoption coercion", function()
    it("reads Spring's string booleans and real booleans, and nothing else", function()
        assert.is_true(FE.escapeFromModOption('1'))
        assert.is_true(FE.escapeFromModOption('true'))
        assert.is_true(FE.escapeFromModOption(true))
        assert.is_true(FE.escapeFromModOption(1))
        assert.is_false(FE.escapeFromModOption('0'))
        assert.is_false(FE.escapeFromModOption('false'))
        assert.is_false(FE.escapeFromModOption(nil))
        assert.is_false(FE.escapeFromModOption('yes'))
    end)
end)
