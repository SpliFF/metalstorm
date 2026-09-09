-- lib/tests/regions_spec.lua — run from data/games/metalstorm/ai:  busted lib/tests/
package.path = './?.lua;' .. package.path

local Regions = require('lib.regions')
local Fix     = require('lib.tests.fixtures.graph')

describe("lib.regions", function()
    local regions
    before_each(function() regions = Regions.load(Fix.regionsJson()) end)

    it("loads a graph export keyed by region key", function()
        assert.are.equal(3, Regions.count(regions))
        assert.are.equal('Central Basin', regions.central_basin.name)
        assert.are.same({ 'north_ridge', 'south_marsh' }, regions.central_basin.neighbors)
        assert.is_nil(regions.central_basin.owner)
    end)

    it("returns an empty graph for anything that is not an export", function()
        assert.are.same({}, Regions.load(nil))
        assert.are.same({}, Regions.load({ regions = 'nope' }))
    end)

    it("overlays owner/contested from rulesParams and resets stale values", function()
        local params = { region_north_ridge_team = 0, region_north_ridge_contested = 1,
                         region_central_basin_team = -1 }
        Regions.overlay(regions, function(k) return params[k] end)
        assert.are.equal(0, regions.north_ridge.owner)
        assert.is_true(regions.north_ridge.contested)
        assert.are.equal(-1, regions.central_basin.owner)
        assert.is_true(Regions.isNeutral(regions.central_basin))
        assert.is_true(Regions.isNeutral(regions.south_marsh))
        params.region_north_ridge_team = nil
        params.region_north_ridge_contested = nil
        Regions.overlay(regions, function(k) return params[k] end)
        assert.is_nil(regions.north_ridge.owner)
        assert.is_false(regions.north_ridge.contested)
    end)

    it("resolves points to regions, 'wilds' when uncovered, nil when blind", function()
        assert.are.equal('north_ridge', Regions.regionOf(100, 100, regions))
        assert.are.equal('central_basin', Regions.regionOf(1500, 500, regions))
        assert.are.equal('south_marsh', Regions.regionOf(1500, 1500, regions))
        assert.are.equal('wilds', Regions.regionOf(5000, 5000, regions))
        assert.is_nil(Regions.regionOf(100, 100, {}))
        assert.is_nil(Regions.regionOf(100, 100, nil))
    end)

    it("computes a directive anchor (centroid + bounding radius)", function()
        local cx, cz, r = Regions.anchor(regions.north_ridge)
        assert.are.equal(512, cx)
        assert.are.equal(512, cz)
        assert.is_true(math.abs(r - 724.08) < 0.1)
        assert.is_nil(Regions.anchor({ polygon = {} }))
        assert.is_nil(Regions.anchor(nil))
    end)

    it("measures strategic distance in hops", function()
        local d = Regions.hops(regions, { north_ridge = true })
        assert.are.equal(0, d.north_ridge)
        assert.are.equal(1, d.central_basin)
        assert.are.equal(2, d.south_marsh)
        assert.are.equal(2, Regions.minHops(regions, { north_ridge = true }, { south_marsh = true }))
        assert.is_nil(Regions.minHops(regions, { north_ridge = true }, {}))
        assert.is_nil(Regions.minHops(regions, { north_ridge = true }, { nowhere = true }))
    end)

    it("finds the nearest map edge like the transports gadget's default departure", function()
        local x, z = Regions.nearestEdgePoint(100, 900, 2048, 2048)
        assert.are.same({ 0, 900 }, { x, z })          -- west edge wins
        x, z = Regions.nearestEdgePoint(1000, 2000, 2048, 2048)
        assert.are.same({ 1000, 2048 }, { x, z })      -- south edge
        x, z = Regions.nearestEdgePoint(50, 50, 0, 0)
        assert.are.same({ 50, 50 }, { x, z })          -- unknown map: stay put
    end)

    it("lists ground owned by a team", function()
        regions.north_ridge.owner = 4
        regions.south_marsh.owner = 4
        assert.are.same({ north_ridge = true, south_marsh = true }, Regions.ownedBy(regions, 4))
    end)
end)
