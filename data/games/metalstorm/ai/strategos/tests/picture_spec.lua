-- tests/picture_spec.lua — the Picture builder (PLAN-metalstorm-ai.md §2,
-- §10 task 3). Run from the plugin root: busted tests/ (cwd = ai/strategos/).
--
-- picture.lua is the one module that talks to the engine (`_G.AI`), so
-- unlike planner_spec.lua/parley_evaluation_spec.lua it can't be exercised
-- as a pure function of hand-built tables alone — these specs mock `_G.AI`
-- (the same feature-detected surface AIScriptContext.cpp exposes: AI1
-- getRulesParam, AI4 getMapData/getDefExport, getOwnUnits/getVisibleEnemies)
-- and drive the single public entry point, `Picture.refresh(ctx)`, plus the
-- standalone geometry helper `Picture.regionOf` directly.
--
-- Fixture: tests/fixtures/regions.json is a real (small, hand-authored)
-- regions.json export in the SAME "graph" provider shape MapProcessor.cpp
-- produces (rts/Server/MapProcessor.cpp ExtractRegions) — three 1024×1024
-- quadrants of a 2048×2048 map, so readRegions/regionOf exercise the actual
-- on-disk JSON shape, not a hand-typed Lua table standing in for it.

package.path = './?.lua;' .. package.path

local dkjson = require('dkjson')
local Config = require('config')

--=============================================================================
-- Fixture helpers
--=============================================================================
local function readFixtureFile(name)
    local f = assert(io.open('tests/fixtures/' .. name, 'r'))
    local content = f:read('*a')
    f:close()
    return content
end

local regionsFixtureJSON = readFixtureFile('regions.json')

local function regionsFixtureData()
    return (dkjson.decode(regionsFixtureJSON))
end

--- Build a mock `_G.AI` from a flat rulesParams map (`'game:key'` /
-- `'team:key'` -> value) plus optional mapData/defExport/unit-list fixtures.
-- A field left nil in `opts` means that capability isn't present on the VM
-- (caps() feature-detects `type(AI.x) == 'function'`), matching how a real,
-- partially-landed AI surface degrades.
local function makeAI(opts)
    opts = opts or {}
    local rulesParams = opts.rulesParams or {}
    local ai = {}
    if opts.rulesParams ~= nil or opts.hasRulesParam then
        ai.getRulesParam = function(scope, key)
            return rulesParams[scope .. ':' .. key]
        end
    end
    if opts.mapData ~= nil then
        ai.getMapData = function(name) return opts.mapData[name] end
    end
    if opts.defExport ~= nil then
        ai.getDefExport = function(name) return opts.defExport[name] end
    end
    if opts.ownUnits ~= nil then
        ai.getOwnUnits = function() return opts.ownUnits end
    end
    if opts.enemyUnits ~= nil then
        ai.getVisibleEnemies = function() return opts.enemyUnits end
    end
    return ai
end

--- Fresh `Picture` module instance (clears its internal powerTable/lookup-
-- grid caches, both plain `local`s that otherwise persist for the life of
-- the Lua state across every `require('picture')` call in this process).
local function freshPicture()
    package.loaded['picture'] = nil
    return require('picture')
end

local function role(over)
    local r = { teamId = 0 }
    for k, v in pairs(over or {}) do r[k] = v end
    return r
end

local function refresh(Picture, ai, opts)
    opts = opts or {}
    _G.AI = ai
    return Picture.refresh({
        frame  = opts.frame or 1000,
        memory = opts.memory or { intel = {} },
        role   = opts.role or role(),
        config = Config,
    })
end

--=============================================================================
-- readRegions — geometry from AI.getMapData, owner/contested overlay from
-- region_* rulesParams (AI1).
--=============================================================================
describe("Picture.refresh — regions", function()
    it("loads static geometry and overlays live owner/contested", function()
        local Picture = freshPicture()
        local ai = makeAI({
            mapData = { ['regions.json'] = regionsFixtureData() },
            rulesParams = {
                ['game:region_north_ridge_team'] = 3,
                ['game:region_north_ridge_contested'] = 1,
                -- central_basin / south_marsh: no overlay -> stay "unknown".
            },
        })
        local picture = refresh(Picture, ai)

        local nr = picture.regions.north_ridge
        assert.is_not_nil(nr)
        assert.are.equal(2, nr.value)
        assert.are.same({ 'high_ground' }, nr.tags)
        assert.are.same({ 'central_basin' }, nr.neighbors)
        assert.are.equal(3, nr.owner)
        assert.is_true(nr.contested)

        local cb = picture.regions.central_basin
        assert.is_not_nil(cb)
        assert.is_nil(cb.owner)
        assert.is_false(cb.contested)
    end)

    it("degrades to an empty region graph when AI4 isn't available", function()
        local Picture = freshPicture()
        local ai = makeAI({ rulesParams = {} })   -- no getMapData at all
        local picture = refresh(Picture, ai)
        assert.are.same({}, picture.regions)
    end)
end)

--=============================================================================
-- readBoard — objective_* rulesParams (AI1), high-water-mark gap skipping.
--=============================================================================
describe("Picture.refresh — board", function()
    it("reads live objectives and skips burned/expired ids", function()
        local Picture = freshPicture()
        local ai = makeAI({
            rulesParams = {
                ['game:objective_count'] = 3,
                -- id 1: open (team = -1), position via region.
                ['game:objective_1_type']     = 'control',
                ['game:objective_1_scope']    = 'strategic',
                ['game:objective_1_state']    = 'active',
                ['game:objective_1_reward']   = 150,
                ['game:objective_1_team']     = -1,
                ['game:objective_1_progress'] = 0.5,
                ['game:objective_1_region']   = 'north_ridge',
                -- id 2: burned/expired — every field cleared (nil), the
                -- high-water-mark gap game_objectives.lua's §1 documents.
                -- id 3: team-scoped, position via x/z/r.
                ['game:objective_3_type']   = 'kill',
                ['game:objective_3_scope']  = 'tactical',
                ['game:objective_3_state']  = 'active',
                ['game:objective_3_reward'] = 40,
                ['game:objective_3_team']   = 7,
                ['game:objective_3_x']      = 500,
                ['game:objective_3_z']      = 600,
                ['game:objective_3_r']      = 50,
            },
        })
        local picture = refresh(Picture, ai)

        assert.is_not_nil(picture.board[1])
        assert.are.equal('control', picture.board[1].type)
        assert.are.equal(-1, picture.board[1].team)
        assert.are.equal('north_ridge', picture.board[1].region)
        assert.is_nil(picture.board[1].pos)

        assert.is_nil(picture.board[2])   -- gap: no `type` -> skipped

        assert.is_not_nil(picture.board[3])
        assert.are.equal(7, picture.board[3].team)
        assert.are.same({ x = 500, z = 600, r = 50 }, picture.board[3].pos)
    end)

    it("degrades to an empty board without AI1", function()
        local Picture = freshPicture()
        local ai = makeAI({})   -- no getRulesParam at all
        local picture = refresh(Picture, ai)
        assert.are.same({}, picture.board)
    end)
end)

--=============================================================================
-- readEconomy — authority_* rulesParams (AI1), the AI3 own-pool gap.
--=============================================================================
describe("Picture.refresh — economy", function()
    it("reads the team pool; own pool stays 0 (AI3 not landed)", function()
        local Picture = freshPicture()
        local ai = makeAI({
            rulesParams = { ['team:authority_pool'] = 500 },
        })
        local picture = refresh(Picture, ai, {
            role = role({ teamAuthorityFallback = true }),
        })
        assert.are.equal(0, picture.economy.ownPool)
        assert.are.equal(500, picture.economy.teamPool)
        assert.are.equal(1.0, picture.economy.costScale)
        assert.is_true(picture.economy.teamFallback)
    end)

    it("degrades to zeros without AI1", function()
        local Picture = freshPicture()
        local ai = makeAI({})
        local picture = refresh(Picture, ai)
        assert.are.equal(0, picture.economy.ownPool)
        assert.are.equal(0, picture.economy.teamPool)
        assert.is_true(picture.economy.reserveHonoured)
    end)
end)

--=============================================================================
-- Picture.regionOf — the O(1) lookup grid + point-in-polygon confirm, must
-- agree with ui/lib/regions.js's graphKeyAt on the SAME regions.json shape.
--=============================================================================
describe("Picture.regionOf", function()
    local function graphRegions()
        local Picture = freshPicture()
        local ai = makeAI({ mapData = { ['regions.json'] = regionsFixtureData() } })
        local picture = refresh(Picture, ai)
        return Picture, picture.regions
    end

    it("resolves an interior point to its authored region", function()
        local Picture, regions = graphRegions()
        assert.are.equal('north_ridge', Picture.regionOf(512, 512, regions))
        assert.are.equal('central_basin', Picture.regionOf(1536, 512, regions))
        assert.are.equal('south_marsh', Picture.regionOf(1024, 1536, regions))
    end)

    it("resolves a point outside every polygon to 'wilds'", function()
        local Picture, regions = graphRegions()
        assert.are.equal('wilds', Picture.regionOf(9000, 9000, regions))
    end)

    it("returns nil when no graph is loaded at all (blind AI)", function()
        local Picture = freshPicture()
        assert.is_nil(Picture.regionOf(512, 512, {}))
        assert.is_nil(Picture.regionOf(512, 512, nil))
    end)
end)

--=============================================================================
-- Force ledger / intel — byClass bucketing off the power table (AI4),
-- region bucketing via regionOf, decaying enemy memory.
--=============================================================================
describe("Picture.refresh — ledger + intel", function()
    local function powerFixture()
        return {
            defs = {
                ['101'] = { name = 'pt_tank_s1', dps = 40, hp = 500, class = 'tanks' },
                ['202'] = { name = 'pt_soldier_s1', dps = 8, hp = 100, class = 'soldiers' },
                -- 303 intentionally absent: an unclassed def.
            },
        }
    end

    it("buckets own units by region and by class", function()
        local Picture = freshPicture()
        local ai = makeAI({
            mapData = { ['regions.json'] = regionsFixtureData() },
            defExport = { ['power.json'] = powerFixture() },
            ownUnits = {
                { defId = 101, x = 512, z = 512, health = 500 },   -- north_ridge, tanks
                { defId = 202, x = 600, z = 600, health = 100 },   -- north_ridge, soldiers
                { defId = 303, x = 600, z = 600, health = 50 },    -- north_ridge, unclassed
            },
        })
        local picture = refresh(Picture, ai)

        local bucket = picture.ledger.north_ridge
        assert.is_not_nil(bucket)
        assert.are.equal(650, bucket.strength)
        assert.are.equal(500, bucket.byClass.tanks)
        assert.are.equal(100, bucket.byClass.soldiers)
        assert.are.equal(50, bucket.byClass._unclassed)
    end)

    it("folds fresh enemy sightings into intel with byClass + full confidence", function()
        local Picture = freshPicture()
        local ai = makeAI({
            mapData = { ['regions.json'] = regionsFixtureData() },
            defExport = { ['power.json'] = powerFixture() },
            enemyUnits = {
                { defId = 101, x = 1536, z = 512, health = 300 },  -- central_basin
            },
        })
        local picture = refresh(Picture, ai, { frame = 1000 })

        local mem = picture.intel.central_basin
        assert.is_not_nil(mem)
        assert.are.equal(300, mem.strength)
        assert.are.equal(300, mem.byClass.tanks)
        assert.are.equal(1.0, mem.confidence)
        assert.are.equal(1000, mem.lastSeenFrame)
    end)

    it("decays unseen intel and forgets it below the confidence floor", function()
        local Picture = freshPicture()
        local memory = { intel = {} }
        local ai = makeAI({
            mapData = { ['regions.json'] = regionsFixtureData() },
            enemyUnits = { { defId = 101, x = 1536, z = 512, health = 300 } },
        })
        refresh(Picture, ai, { frame = 1000, memory = memory })
        assert.is_not_nil(memory.intel.central_basin)

        -- A different AI, no more sightings: confidence should decay over time.
        local aiBlind = makeAI({ mapData = { ['regions.json'] = regionsFixtureData() } })
        local halfway = 1000 + math.floor(Config.INTEL_DECAY_FRAMES / 2)
        local picture = refresh(Picture, aiBlind, { frame = halfway, memory = memory })
        assert.is_not_nil(picture.intel.central_basin)
        assert.is_true(picture.intel.central_basin.confidence < 1.0)

        -- ...and eventually be forgotten entirely (honest amnesia, plan §2).
        local muchLater = 1000 + Config.INTEL_DECAY_FRAMES * 2
        local picture2 = refresh(Picture, aiBlind, { frame = muchLater, memory = memory })
        assert.is_nil(picture2.intel.central_basin)
    end)
end)

--=============================================================================
-- loadPowerTable — the expected-DPS table (AI4), re-keyed by numeric defID.
--=============================================================================
describe("Picture.refresh — power table", function()
    it("re-keys power.json's string defIDs to numbers", function()
        local Picture = freshPicture()
        local ai = makeAI({
            defExport = { ['power.json'] = { defs = {
                ['55'] = { name = 'pt_arty_s1', dps = 60, hp = 400, class = 'artillery' },
            } } },
        })
        local picture = refresh(Picture, ai)
        assert.is_not_nil(picture.power[55])
        assert.are.equal('artillery', picture.power[55].class)
    end)
end)
