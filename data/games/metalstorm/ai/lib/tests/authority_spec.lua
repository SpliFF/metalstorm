-- lib/tests/authority_spec.lua — the cost preview must equal what
-- game_authority.lua's ChargeDirective charges. Run from data/games/metalstorm/ai.
package.path = './?.lua;' .. package.path

local Authority = require('lib.authority')
local CostSpec  = require('lib.vendor.authority_cost')
local Formula   = require('lib.vendor.formula')

describe("lib.authority", function()
    before_each(function()
        _G.AI = nil
        Authority._setSpec(nil)
    end)
    after_each(function() _G.AI = nil; Authority._setSpec(nil) end)

    it("falls back to the vendored spec when there is no export", function()
        local spec, source = Authority.load()
        assert.are.equal('vendor', source)
        assert.are.equal(CostSpec.version, spec.version)
    end)

    it("prefers a JSON export from the def cache when the runtime has one", function()
        _G.AI = { getDefExport = function(name)
            if name == 'authority_cost.json' then
                return { version = 99, base_k = 2.0, order_class = { standing = 1.0 } }
            end
        end }
        local spec, source = Authority.load()
        assert.are.equal('export', source)
        assert.are.equal(99, spec.version)
        assert.are.equal(2, Authority.directiveCost({ scope = 'area', costScale = 1 }))
    end)

    it("prices an AREA directive exactly as the sim does (base 1, class 'standing')", function()
        local expected = Formula.cost(CostSpec.base_k, 1, 1.0, CostSpec.order_class.standing, 1.0)
        assert.are.equal(expected, Authority.directiveCost({ scope = 'area', costScale = 1.0 }))
        assert.are.equal(2, expected)     -- ceil(1 × 1 × 1 × 1.2 × 1)
    end)

    it("prices a GROUP directive from Σ base under the 'directive' class", function()
        local expected = Formula.cost(CostSpec.base_k, 7, 1.0, CostSpec.order_class.directive, 1.0)
        assert.are.equal(expected,
            Authority.directiveCost({ scope = 'group', baseSum = 7, costScale = 1.0 }))
    end)

    it("scales with authority_cost_scale and is free at scale 0", function()
        assert.are.equal(0, Authority.directiveCost({ scope = 'area', costScale = 0 }))
        assert.are.equal(3, Authority.directiveCost({ scope = 'area', costScale = 2 }))
        _G.AI = { getRulesParam = function(scope, key)
            if scope == 'game' and key == 'authority_cost_scale' then return 0 end
        end }
        assert.are.equal(0, Authority.costScale())
        assert.are.equal(0, Authority.directiveCost({ scope = 'area' }))
    end)

    it("postures, groups and messages carry no charge on the AI drain", function()
        assert.are.equal(0, Authority.postureCost())
        assert.are.equal(0, Authority.groupCost())
        assert.are.equal(0, Authority.messageCost())
    end)

    it("derives a per-def base from power.json scale (flagged approximate)", function()
        local base, exact = Authority.unitBase({ scale = 3 })
        assert.are.equal(3, base); assert.is_false(exact)
        base, exact = Authority.unitBase({ authority_cost_base = 5, scale = 3 })
        assert.are.equal(5, base); assert.is_true(exact)
        assert.are.equal(1, Authority.unitBase(nil))
        local power = { [101] = { scale = 1 }, [103] = { scale = 3 } }
        assert.are.equal(5, Authority.baseSum({ { defId = 101 }, { defId = 103 }, { defId = 9 } }, power))
    end)

    it("detects a live cost-spec version mismatch when the game publishes one", function()
        assert.is_nil(Authority.versionMismatch())
        _G.AI = { getRulesParam = function(scope, key)
            if key == 'authority_cost_version' then return CostSpec.version + 1 end
        end }
        assert.is_true(Authority.versionMismatch())
    end)
end)
