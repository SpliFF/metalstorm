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
    if opts.playerId ~= nil then
        ai.getPlayerId = function() return opts.playerId end   -- AI3 virtual playerID
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

    -- ⚠ `unit.health` here is the runtime's own scale: a 0-1 RATIO
    -- (`AIStateSnapshot.cpp:45` — `health / maxHealth`), not hitpoints. Taken
    -- from the producer's construction site rather than invented, because a
    -- fixture that feeds absolute hitpoints tests arithmetic the runtime never
    -- performs — which is exactly how D68 stayed hidden through 112 green specs.
    it("buckets own units by region and by class, in the runtime's 0-1 scale", function()
        local Picture = freshPicture()
        local ai = makeAI({
            mapData = { ['regions.json'] = regionsFixtureData() },
            defExport = { ['power.json'] = powerFixture() },
            ownUnits = {
                { defId = 101, x = 512, z = 512, health = 1.0 },   -- north_ridge, tanks, undamaged
                { defId = 202, x = 600, z = 600, health = 0.5 },   -- north_ridge, soldiers, half dead
                { defId = 303, x = 600, z = 600, health = 0.25 },  -- north_ridge, unclassed
            },
        })
        local picture = refresh(Picture, ai)

        local bucket = picture.ledger.north_ridge
        assert.is_not_nil(bucket)
        -- `strength` is a damage-discounted HEAD COUNT: 1 + 0.5 + 0.25.
        assert.are.equal(1.75, bucket.strength)
        assert.are.equal(1.0, bucket.byClass.tanks)
        assert.are.equal(0.5, bucket.byClass.soldiers)
        assert.are.equal(0.25, bucket.byClass._unclassed)
    end)

    -- D68: the bucket ALSO carries the engine's scale, because that is the only
    -- number allowed to become a directive's requestedStrength.
    it("prices the same force in absolute hitpoints off power.json (D68)", function()
        local Picture = freshPicture()
        local ai = makeAI({
            mapData = { ['regions.json'] = regionsFixtureData() },
            defExport = { ['power.json'] = powerFixture() },
            ownUnits = {
                { defId = 101, x = 512, z = 512, health = 1.0 },   -- 500 hp tank, undamaged
                { defId = 202, x = 600, z = 600, health = 0.5 },   -- 100 hp soldier, half dead
            },
        })
        local picture = refresh(Picture, ai)

        local bucket = picture.ledger.north_ridge
        -- 1.0 x 500 + 0.5 x 100. Two units, 550 hitpoints — and it is the 550
        -- the engine's demand cap is denominated in, not the 1.5.
        assert.are.equal(550, bucket.health)
        assert.are.equal(1.5, bucket.strength)
        -- The two scales are not interchangeable, which is the whole finding.
        assert.is_true(bucket.health > bucket.strength * 100)
    end)

    -- A def the power table cannot price still has to contribute force, or a
    -- package of them would ask the engine for nothing and recruit nobody.
    it("prices an unpriced def at a nominal hp rather than zero (D68)", function()
        local Picture = freshPicture()
        local ai = makeAI({
            mapData = { ['regions.json'] = regionsFixtureData() },
            defExport = { ['power.json'] = powerFixture() },
            ownUnits = {
                -- 303 is absent from power.json (the unclassed def).
                { defId = 303, x = 600, z = 600, health = 1.0 },
            },
        })
        local picture = refresh(Picture, ai)

        local bucket = picture.ledger.north_ridge
        assert.are.equal(1.0, bucket.strength)
        assert.are.equal(1000, bucket.health)   -- NOMINAL_UNIT_HP, warned once
    end)

    -- The blind path: no def export at all. Every unit falls to the nominal
    -- price, so `health` degrades to "hitpoints at 1 000 each" and never to 0.
    it("still prices force with no def export at all (D68)", function()
        local Picture = freshPicture()
        local ai = makeAI({
            mapData = { ['regions.json'] = regionsFixtureData() },
            ownUnits = {
                { defId = 101, x = 512, z = 512, health = 1.0 },
                { defId = 202, x = 600, z = 600, health = 0.5 },
            },
        })
        local picture = refresh(Picture, ai)

        local bucket = picture.ledger.north_ridge
        assert.are.equal(1.5, bucket.strength)
        assert.are.equal(1500, bucket.health)
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

--=============================================================================
-- Task 4 (co-commander): the live-data path for delegation-first scoring +
-- AI3 own-pool + caretaker human-presence read.
--=============================================================================
describe("Picture.refresh — co-commander live data (task 4)", function()
    it("reads the AI's own pool from authority_player_<playerID> (AI3)", function()
        local Picture = freshPicture()
        local ai = makeAI({
            playerId = 7,
            rulesParams = {
                ['team:authority_pool']       = 500,
                ['team:authority_player_7']   = 120,
                ['team:team_active_humans']   = 1,
            },
        })
        local p = refresh(Picture, ai, { role = role({ readsGuidance = true }) })
        assert.are.equal(120, p.economy.ownPool)   -- own pool, not the 500 team pool
        assert.are.equal(500, p.economy.teamPool)
        assert.are.equal(1,   p.economy.humans)     -- caretaker up/downgrade signal
    end)

    it("leaves ownPool 0 for an unattributed AI (playerId -1)", function()
        local Picture = freshPicture()
        local ai = makeAI({
            playerId = -1,
            rulesParams = { ['team:authority_pool'] = 500, ['team:authority_player_-1'] = 999 },
        })
        local p = refresh(Picture, ai)
        assert.are.equal(0, p.economy.ownPool)
    end)

    it("surfaces objective source (bounty) so slate's ×3 fires from real board data", function()
        local Picture = freshPicture()
        local ai = makeAI({
            rulesParams = {
                ['game:objective_count']       = 1,
                ['game:objective_1_type']      = 'kill',
                ['game:objective_1_scope']     = 'strategic',
                ['game:objective_1_state']     = 'active',
                ['game:objective_1_reward']    = 150,
                ['game:objective_1_team']      = -1,
                ['game:objective_1_source']    = 'bounty',
                ['game:objective_1_suggested'] = 1,
            },
        })
        local p = refresh(Picture, ai)
        assert.are.equal('bounty', p.board[1].source)
        assert.are.equal(1, p.board[1].suggested)
    end)

    -- endtoend Q-E1 / D47: the terminal objective was published PUBLIC and the
    -- AI was the one reader that never asked for it, so the war read as a
    -- 300-authority control among 110s.
    it("surfaces the terminal objective flag so the planner can price the war", function()
        local Picture = freshPicture()
        local ai = makeAI({
            rulesParams = {
                ['game:objective_count']     = 2,
                ['game:objective_1_type']    = 'control',
                ['game:objective_1_scope']   = 'strategic',
                ['game:objective_1_state']   = 'active',
                ['game:objective_1_reward']  = 300,
                ['game:objective_1_team']    = -1,
                ['game:objective_1_region']  = 'raven_basin',
                ['game:objective_1_victory'] = 1,
                -- id 2: a side objective — `victory` is absent, not 0.
                ['game:objective_2_type']    = 'control',
                ['game:objective_2_scope']   = 'tactical',
                ['game:objective_2_state']   = 'active',
                ['game:objective_2_reward']  = 110,
                ['game:objective_2_team']    = -1,
                ['game:objective_2_region']  = 'marrow_watch',
            },
        })
        local p = refresh(Picture, ai)
        assert.are.equal(1, p.board[1].victory)
        assert.is_nil(p.board[2].victory)
    end)
end)

--=============================================================================
-- readScript / readProfileHint — the scenario→AI slot configuration channel
-- (PLAN-metalstorm-ai.md §5 NPC column). game_scenario.lua's stageAI publishes
-- these team rulesParams; this is the read side of that contract, so the key
-- names and the comma-list convention below must match
-- LuaRules/Gadgets/game_scenario.lua exactly (tests/game_scenario_ai_spec.lua
-- asserts the write side against the same names).
--=============================================================================
describe("Picture.refresh — scenario-authored AI slot config", function()
    local SLATE_PARAMS = {
        ['team:ai_profile']        = 'npc_raider',
        ['team:ai_slate_kinds']    = 'garrison,raid,toll',
        ['team:ai_slate_home']     = 'east_pass',
        ['team:ai_slate_targets']  = 'north_market,south_market',
        ['team:ai_slate_route']    = 'still_mere',
        ['team:ai_slate_reach']    = 2,
    }

    it("reads the scripted slate into picture.script", function()
        local Picture = freshPicture()
        local p = refresh(Picture, makeAI({ rulesParams = SLATE_PARAMS }))
        assert.is_not_nil(p.script)
        assert.are.same({ 'garrison', 'raid', 'toll' }, p.script.kinds)
        assert.are.equal('east_pass', p.script.home)
        assert.are.same({ 'north_market', 'south_market' }, p.script.targets)
        assert.are.same({ 'still_mere' }, p.script.route)
        assert.are.equal(2, p.script.reach)
    end)

    it("leaves picture.script nil when no scenario published one", function()
        local Picture = freshPicture()
        local p = refresh(Picture, makeAI({ rulesParams = {} }))
        assert.is_nil(p.script)
    end)

    it("degrades to nil script with no rulesParam surface at all", function()
        local Picture = freshPicture()
        _G.AI = {}
        local p = Picture.refresh({ frame = 1, memory = { intel = {} },
                                    role = role(), config = Config })
        assert.is_nil(p.script)
    end)

    it("prefers the per-player profile key over the team-wide one", function()
        local Picture = freshPicture()
        _G.AI = makeAI({ rulesParams = {
            ['team:ai_profile']   = 'npc_raider',
            ['team:ai_profile_4'] = 'aggressive',
        } })
        assert.are.equal('aggressive', Picture.readProfileHint(4))
        assert.are.equal('npc_raider', Picture.readProfileHint(7))   -- no per-player key
        assert.are.equal('npc_raider', Picture.readProfileHint(-1))  -- unattributed AI
    end)

    it("returns no profile hint when nothing published one", function()
        local Picture = freshPicture()
        _G.AI = makeAI({ rulesParams = {} })
        assert.is_nil(Picture.readProfileHint(0))
        _G.AI = {}
        assert.is_nil(Picture.readProfileHint(0))
    end)
end)
