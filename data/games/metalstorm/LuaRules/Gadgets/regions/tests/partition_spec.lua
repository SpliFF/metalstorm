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

-- Sector naming (PLAN-metalstorm-command-language.md §5). The contract these
-- guard is "every grid cell has exactly one spoken name, and no two cells share
-- one" — a duplicate name would leave the NL resolver guessing which sector the
-- player meant, which is the one thing the named-entity index must never do.
describe("column labels", function()
    it("maps the first 26 columns to single letters", function()
        assert.are.equal('A', Partition.columnLabel(0))
        assert.are.equal('B', Partition.columnLabel(1))
        assert.are.equal('Z', Partition.columnLabel(25))
    end)

    it("rolls into a second letter past Z instead of repeating one", function()
        assert.are.equal('AA', Partition.columnLabel(26))
        assert.are.equal('AB', Partition.columnLabel(27))
        assert.are.equal('AZ', Partition.columnLabel(51))
        assert.are.equal('BA', Partition.columnLabel(52))
        assert.are.equal('ZZ', Partition.columnLabel(701))
        assert.are.equal('AAA', Partition.columnLabel(702))
    end)

    it("is injective over a range far wider than any real map", function()
        local seen = {}
        for ix = 0, 999 do
            local label = Partition.columnLabel(ix)
            assert.is_nil(seen[label], 'duplicate column label ' .. tostring(label))
            seen[label] = ix
        end
    end)

    it("rejects non-column inputs rather than inventing a letter", function()
        assert.is_nil(Partition.columnLabel(-1))
        assert.is_nil(Partition.columnLabel(nil))
        assert.is_nil(Partition.columnLabel('3'))
    end)
end)

describe("grid sector names", function()
    it("reads col:row as letter+1-based number", function()
        assert.are.equal('Sector A1', Partition.gridSectorName('0:0'))
        assert.are.equal('Sector D6', Partition.gridSectorName('3:5'))
        assert.are.equal('Sector B9', Partition.gridSectorName('1:8'))
    end)

    it("handles the column edges", function()
        assert.are.equal('Sector A1', Partition.gridSectorName('0:0'))     -- col 0
        assert.are.equal('Sector Z1', Partition.gridSectorName('25:0'))    -- col 25
        assert.are.equal('Sector AA1', Partition.gridSectorName('26:0'))   -- col 26
    end)

    it("has no row ceiling", function()
        assert.are.equal('Sector A100', Partition.gridSectorName('0:99'))
    end)

    it("leaves authored graph keys alone", function()
        assert.is_nil(Partition.gridSectorName('west_scarp_n'))
        assert.is_nil(Partition.gridSectorName('wilds'))
        assert.is_nil(Partition.gridSectorName('3:'))
        assert.is_nil(Partition.gridSectorName(nil))
    end)
end)

describe("grid provider sectors()", function()
    it("names every cell the grid can return, uniquely", function()
        local p = Partition.newGridProvider(8192, 8192, 2048)
        local sectors = p.sectors()
        assert.are.equal(#p.keys(), #sectors)

        local byName, byKey = {}, {}
        for _, s in ipairs(sectors) do
            assert.is_string(s.name)
            assert.is_nil(byName[s.name], 'duplicate sector name ' .. tostring(s.name))
            byName[s.name] = true
            byKey[s.key] = s
        end
        assert.are.equal('Sector A1', byKey['0:0'].name)
        assert.are.equal('Sector D4', byKey['3:3'].name)
    end)

    it("puts each centre inside its own cell", function()
        local p = Partition.newGridProvider(8192, 8192, 2048)
        for _, s in ipairs(p.sectors()) do
            assert.are.equal(s.key, p.at(s.x, s.z))
        end
    end)

    it("clips the overhanging last row/column back onto the map", function()
        -- 9000 / 2048 = 4.39 cells: the 5th column runs to 10240, well past the
        -- map edge. An unclipped centre would be off-map and un-orderable.
        local p = Partition.newGridProvider(9000, 9000, 2048)
        for _, s in ipairs(p.sectors()) do
            assert.is_true(s.x >= 0 and s.x <= 9000, 'x out of map: ' .. tostring(s.x))
            assert.is_true(s.z >= 0 and s.z <= 9000, 'z out of map: ' .. tostring(s.z))
        end
    end)

    it("names a tiny map's clamped 2x2 grid too (E5)", function()
        local p = Partition.newGridProvider(512, 512, 2048)
        local sectors = p.sectors()
        assert.are.equal(4, #sectors)
        assert.are.equal('Sector A1', sectors[1].name)
    end)

    it("is not offered by the graph provider — authored names stay primary", function()
        local regions = {
            { key = 'north', name = 'Northgate', polygon = square(0, 0, 4096, 4096) },
            { key = 'south', name = 'Slag Forge', polygon = square(0, 4096, 4096, 8192) },
        }
        local p = Partition.newGraphProvider(regions, 8192, 8192)
        assert.is_nil(p.sectors)
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

    it("rejects an empty region list (empty = grid, not everything-wilds)", function()
        local ok, errors = Partition.validateGraph({}, 1000, 1000)
        assert.is_false(ok)
        assert.is_truthy(errors)
    end)

    it("rejects the reserved 'wilds' key", function()
        local regions = {
            { key = 'wilds', polygon = square(0, 0, 100, 100), neighbors = {} },
        }
        local ok, errors = Partition.validateGraph(regions, 1000, 1000)
        assert.is_false(ok)
        assert.is_truthy(errors)
    end)

    -- E2: malformed authored data must produce a loud error + grid fallback,
    -- NEVER a raw Lua error that would take the gadget (and downstream
    -- game_authority) down.
    it("returns errors instead of raising on a non-table region entry", function()
        local ok, errors
        assert.has_no.errors(function()
            ok, errors = Partition.validateGraph({ 42 }, 1000, 1000)
        end)
        assert.is_false(ok)
        assert.is_truthy(errors)
    end)

    it("returns errors instead of raising on a region with a missing key", function()
        local ok, errors
        assert.has_no.errors(function()
            ok, errors = Partition.validateGraph({ { name = 'x', polygon = square(0, 0, 100, 100) } }, 1000, 1000)
        end)
        assert.is_false(ok)
        assert.is_truthy(errors)
    end)

    it("returns errors instead of raising on a malformed vertex", function()
        local ok, errors
        assert.has_no.errors(function()
            ok, errors = Partition.validateGraph(
                { { key = 'a', polygon = { {x=0,z=0}, {x='bad'}, {x=100,z=100} }, neighbors = {} } },
                1000, 1000)
        end)
        assert.is_false(ok)
        assert.is_truthy(errors)
    end)
end)

describe("graph provider — malformed input (E2 grid fallback)", function()
    it("newGraphProvider returns nil + errors (never raises) on an empty list", function()
        local provider, errors
        assert.has_no.errors(function()
            provider, errors = Partition.newGraphProvider({}, 1000, 1000)
        end)
        assert.is_nil(provider)
        assert.is_truthy(errors)
    end)

    it("newGraphProvider returns nil + errors (never raises) on a non-table entry", function()
        local provider, errors
        assert.has_no.errors(function()
            provider, errors = Partition.newGraphProvider({ 42 }, 1000, 1000)
        end)
        assert.is_nil(provider)
        assert.is_truthy(errors)
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

describe("graph provider — clipped (M9m) region polygons", function()
    -- A generated region's polygon is its component's coastline, not the leaf
    -- rectangle: concave, many-vertexed, and it deliberately does NOT cover
    -- everything inside its own bounding box. This is a C shape whose mouth
    -- opens east — the "bay" is ground of another component, which must
    -- resolve to wilds rather than to the region wrapped around it.
    local c_shape = {
        { key = 'bay_arm', neighbors = {}, centre = { x = 100, z = 100 },
          polygon = {
              {x=0,z=0}, {x=900,z=0}, {x=900,z=300}, {x=300,z=300},
              {x=300,z=700}, {x=900,z=700}, {x=900,z=1000}, {x=0,z=1000},
          } },
    }

    it("answers wilds for ground inside the bbox but outside the polygon", function()
        local provider = Partition.newGraphProvider(c_shape, 4096, 4096)
        assert.is_truthy(provider)
        assert.are.equal('bay_arm', provider.at(100, 500))    -- the spine
        assert.are.equal('bay_arm', provider.at(600, 100))    -- north arm
        assert.are.equal('wilds', provider.at(600, 500))      -- the bay
    end)

    it("agrees with a bare point-in-polygon sweep everywhere", function()
        -- The provider pre-filters candidates by bounding box before running
        -- the polygon test. That is a speed change only, so a sweep of the
        -- whole map must give the same answer as calling pointInPolygon
        -- directly — including outside the bbox, where the filter fires.
        local provider = Partition.newGraphProvider(c_shape, 4096, 4096)
        for x = 25, 4000, 137 do
            for z = 25, 4000, 149 do
                local want = Partition.pointInPolygon(x, z, c_shape[1].polygon)
                    and 'bay_arm' or 'wilds'
                assert.are.equal(want, provider.at(x, z))
            end
        end
    end)

    it("accepts an optional centre and rejects one outside the map", function()
        local ok = Partition.validateGraph(c_shape, 4096, 4096)
        assert.is_true(ok)

        local outside = {
            { key = 'a', polygon = square(0, 0, 100, 100), neighbors = {},
              centre = { x = 5000, z = 50 } },
        }
        local bad, errors = Partition.validateGraph(outside, 4096, 4096)
        assert.is_false(bad)
        assert.are.equal('a: centre out of map bounds', errors[1])

        local malformed = {
            { key = 'a', polygon = square(0, 0, 100, 100), neighbors = {},
              centre = { x = 'nope' } },
        }
        local bad2, errors2 = Partition.validateGraph(malformed, 4096, 4096)
        assert.is_false(bad2)
        assert.are.equal('a: malformed centre', errors2[1])
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

-- ============================================================
-- Region extent as a circle (battle-clarity U2)
-- ============================================================
--
-- `GG.Regions.Area` is the only reason an objective that names a region can be
-- drawn on the map at all. The two providers approximate differently and the
-- difference is the point, so both are pinned here.

describe("region circle", function()
    it("computes polygon area by the shoelace rule, winding-agnostic", function()
        local ccw = square(0, 0, 100, 100)
        local cw  = { {x=0,z=0}, {x=0,z=100}, {x=100,z=100}, {x=100,z=0} }
        assert.are.equal(10000, Partition.polygonArea(ccw))
        assert.are.equal(10000, Partition.polygonArea(cw))
        assert.are.equal(0, Partition.polygonArea({ {x=0,z=0}, {x=1,z=1} }))
        assert.are.equal(0, Partition.polygonArea(nil))
    end)

    it("uses the AREA-EQUIVALENT radius, not the farthest vertex", function()
        -- A 2000x2000 square with one 8000-elmo spike, which is the shape a
        -- generated coastline actually has. Farthest-vertex would draw a
        -- ~8000-elmo ring around a region that is 2000 across.
        local spiked = { {x=0,z=0}, {x=2000,z=0}, {x=2000,z=2000}, {x=0,z=2000}, {x=0,z=8000} }
        local _, _, r = Partition.regionCircle({ polygon = spiked, centre = {x=1000, z=1000} })
        assert.is_true(r < 2500, 'radius should track footprint, not the spike: ' .. tostring(r))
    end)

    it("prefers the authored centre over the vertex average", function()
        local x, z = Partition.regionCircle({
            polygon = square(0, 0, 1000, 1000), centre = { x = 250, z = 750 },
        })
        assert.are.equal(250, x)
        assert.are.equal(750, z)
        local vx, vz = Partition.regionCircle({ polygon = square(0, 0, 1000, 1000) })
        assert.are.equal(500, vx)
        assert.are.equal(500, vz)
    end)

    it("clamps: a tiny region still gets a visible ring", function()
        local _, _, r = Partition.regionCircle({ polygon = square(0, 0, 10, 10) })
        assert.are.equal(128, r)
    end)

    it("returns nil for anything it cannot place", function()
        assert.is_nil(Partition.regionCircle(nil))
        assert.is_nil(Partition.regionCircle({}))
        assert.is_nil(Partition.regionCircle({ polygon = { {x=0,z=0}, {x=1,z=1} } }))
    end)

    it("graph provider answers area() per key and refuses 'wilds'", function()
        local p = Partition.newGraphProvider({
            { key = 'a', polygon = square(0, 0, 1000, 1000), neighbors = {} },
        }, 4096, 4096)
        local x, z, r = p.area('a')
        assert.are.equal(500, x)
        assert.are.equal(500, z)
        assert.is_true(r > 500 and r < 570)   -- sqrt(1e6/pi) = 564
        assert.is_nil(p.area('wilds'))
        assert.is_nil(p.area('nope'))
    end)

    it("grid provider inscribes the CLIPPED cell so rings never overlap", function()
        local p = Partition.newGridProvider(8192, 8192, 2048)
        local x, z, r = p.area('0:0')
        assert.are.equal(1024, x)
        assert.are.equal(1024, z)
        assert.are.equal(1024, r)
        -- A map whose last column hangs off the edge: 5000/2048 -> 3 columns,
        -- the last one only 904 wide, so its inscribed radius is 452.
        local q = Partition.newGridProvider(5000, 5000, 2048)
        local lx, _, lr = q.area('2:0')
        assert.are.equal((4096 + 5000) / 2, lx)
        assert.are.equal(452, lr)
        assert.is_nil(q.area('9:9'))
        assert.is_nil(q.area('west_scarp'))
    end)
end)
