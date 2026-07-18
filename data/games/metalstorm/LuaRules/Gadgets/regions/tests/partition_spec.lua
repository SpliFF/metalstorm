-- tests/partition_spec.lua — partition provider unit tests.
-- Run from the plugin root:  cd data/games/metalstorm/LuaRules/Gadgets/regions && busted tests/

package.path = './?.lua;' .. package.path

local Partition = require('partition')

local function square(x0, z0, x1, z1)
    return { {x=x0,z=z0}, {x=x1,z=z0}, {x=x1,z=z1}, {x=x0,z=z1} }
end

describe("grid provider", function()
    it("floor-divides into stable 'gx:gz' keys", function()
        local p = Partition.newGridProvider(8192, 8192, 2048)
        assert.are.equal('0:0', p.at(0, 0))
        assert.are.equal('1:0', p.at(2049, 0))
        assert.are.equal('0:1', p.at(0, 2049))
        assert.are.equal('3:3', p.at(8000, 8000))
    end)

    it("clamps to >= 2x2 regions on a tiny map (E5)", function()
        local p = Partition.newGridProvider(512, 512, 2048)
        assert.is_true(p.gridW >= 2)
        assert.is_true(p.gridH >= 2)
        -- must not crash / return an out-of-range key
        assert.is_truthy(p.at(0, 0))
        assert.is_truthy(p.at(511, 511))
    end)

    it("clamps out-of-bounds queries to the nearest edge cell", function()
        local p = Partition.newGridProvider(8192, 8192, 2048)
        assert.are.equal(p.at(0, 0), p.at(-100, -100))
        assert.are.equal(p.at(8191, 8191), p.at(999999, 999999))
    end)
end)

describe("point-in-polygon", function()
    it("detects points inside and outside a square", function()
        local sq = square(0, 0, 100, 100)
        assert.is_true(Partition.pointInPolygon(50, 50, sq))
        assert.is_false(Partition.pointInPolygon(150, 50, sq))
    end)
end)

describe("self-intersection check", function()
    it("accepts a simple square", function()
        assert.is_false(Partition.isSelfIntersecting(square(0, 0, 100, 100)))
    end)

    it("rejects a bowtie quadrilateral", function()
        local bowtie = { {x=0,z=0}, {x=100,z=100}, {x=100,z=0}, {x=0,z=100} }
        assert.is_true(Partition.isSelfIntersecting(bowtie))
    end)

    it("rejects degenerate (< 3 vertex) polygons", function()
        assert.is_true(Partition.isSelfIntersecting({ {x=0,z=0}, {x=1,z=1} }))
    end)
end)

describe("graph validator", function()
    it("accepts a valid graph with symmetric neighbors and a gap (wilds)", function()
        local regions = {
            { key = 'north', polygon = square(0, 0, 100, 100), neighbors = { 'south' } },
            { key = 'south', polygon = square(0, 200, 100, 300), neighbors = { 'north' } },
        }
        local ok, errors = Partition.validateGraph(regions, 1000, 1000)
        assert.is_true(ok)
        assert.is_nil(errors)
    end)

    it("rejects duplicate keys", function()
        local regions = {
            { key = 'a', polygon = square(0, 0, 100, 100), neighbors = {} },
            { key = 'a', polygon = square(200, 0, 300, 100), neighbors = {} },
        }
        local ok, errors = Partition.validateGraph(regions, 1000, 1000)
        assert.is_false(ok)
        assert.is_truthy(errors)
    end)

    it("rejects out-of-bounds vertices", function()
        local regions = {
            { key = 'a', polygon = square(-50, 0, 100, 100), neighbors = {} },
        }
        local ok = Partition.validateGraph(regions, 1000, 1000)
        assert.is_false(ok)
    end)

    it("rejects self-intersecting polygons", function()
        local regions = {
            { key = 'a', polygon = { {x=0,z=0}, {x=100,z=100}, {x=100,z=0}, {x=0,z=100} }, neighbors = {} },
        }
        local ok = Partition.validateGraph(regions, 1000, 1000)
        assert.is_false(ok)
    end)

    it("rejects asymmetric neighbor references", function()
        local regions = {
            { key = 'a', polygon = square(0, 0, 100, 100), neighbors = { 'b' } },
            { key = 'b', polygon = square(200, 0, 300, 100), neighbors = {} },
        }
        local ok = Partition.validateGraph(regions, 1000, 1000)
        assert.is_false(ok)
    end)
end)

describe("graph provider (point lookup)", function()
    local regions = {
        { key = 'north', polygon = square(0, 0, 1000, 1000), value = 1.5, tags = { 'civilian' }, neighbors = {} },
        { key = 'south', polygon = square(0, 2000, 1000, 3000), value = 1.0, tags = {}, neighbors = {} },
    }

    it("resolves points inside authored polygons to their key", function()
        local provider = Partition.newGraphProvider(regions, 4096, 4096)
        assert.are.equal('north', provider.at(500, 500))
        assert.are.equal('south', provider.at(500, 2500))
    end)

    it("resolves points in no polygon to the synthetic 'wilds' region", function()
        local provider = Partition.newGraphProvider(regions, 4096, 4096)
        assert.are.equal('wilds', provider.at(500, 1500))
        assert.are.equal(0, provider.byKey.wilds.value)
    end)

    it("first-declared-wins on overlapping polygons", function()
        local overlapping = {
            { key = 'first',  polygon = square(0, 0, 1000, 1000), neighbors = {} },
            { key = 'second', polygon = square(500, 500, 1500, 1500), neighbors = {} },
        }
        local provider = Partition.newGraphProvider(overlapping, 4096, 4096)
        -- (600,600) is inside both polygons — first declared wins.
        assert.are.equal('first', provider.at(600, 600))
    end)

    it("returns nil + errors and lets the caller fall back to grid on a broken graph (E2)", function()
        local broken = {
            { key = 'a', polygon = { {x=0,z=0}, {x=100,z=100}, {x=100,z=0}, {x=0,z=100} }, neighbors = {} },
        }
        local provider, errors = Partition.newGraphProvider(broken, 4096, 4096)
        assert.is_nil(provider)
        assert.is_truthy(errors)
    end)

    it("does NOT assume a single-candidate cell is fully covered (an isolated polygon's edge can still cut through it)", function()
        local isolated = {
            { key = 'a', polygon = square(0, 0, 300, 300), neighbors = {} },
        }
        local provider = Partition.newGraphProvider(isolated, 1024, 1024)
        -- (280,280) and (320,320) share lookup cell (1,1) — that cell's
        -- bbox-overlap list holds exactly one candidate ('a'), but the
        -- region's edge at 300 cuts through the cell, so only the first
        -- point is actually inside.
        assert.are.equal('a', provider.at(280, 280))
        assert.are.equal('wilds', provider.at(320, 320))
    end)
end)

describe("lookup grid", function()
    it("agrees with direct point-in-polygon queries on boundary cells", function()
        local regions = {
            { key = 'a', polygon = square(0, 0, 300, 300), neighbors = {} },
        }
        local lookup = Partition.buildLookupGrid(regions, 1024, 1024, 256)
        -- cell (1,1) covers [256,512)x[256,512) — straddles the polygon edge at 300.
        local cellRegions = lookup.grid[1] and lookup.grid[1][1]
        assert.is_truthy(cellRegions)
        assert.are.equal(1, #cellRegions)
        assert.are.equal('a', cellRegions[1])
    end)
end)
