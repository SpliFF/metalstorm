-- tests/game_scenario_objectives_spec.lua — the scenario loader's objective
-- CHAINING fields (S4.1): bounty, phases, parentId, phase, linkedId.
--
-- Run from the GAME root (same as game_scenario_towns_spec.lua, and for the
-- same reason — the gadget is loaded by a game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_scenario_objectives_spec.lua
--
-- WHY THIS EXISTS. game_objectives.lua has implemented phase chaining (§4.7)
-- since it was written; the loader simply never passed the fields on, so no
-- scenario file could sequence anything — the tutorial-beats design had no
-- authoring surface at all. The failure was silent in the worst way: the file
-- validates, the war boots, and the chain just isn't there.
--
-- And it is silent TWICE, because the loader has TWO create sites with
-- different field lists: stageObjectives' immediate call, and
-- createPopulatedObjective for objectives whose targets are civilians found at
-- frame 30. `bounty` reached only the first for exactly this reason. Every
-- case below is therefore run on BOTH paths — a fix (or a grep) that touches
-- only one site is what this file exists to catch.

local GADGET = './LuaRules/Gadgets/game_scenario.lua'

local GAIA = 99

--- A world whose GG.Objectives.Create records every def it is handed, so the
--- assertions are about what the LOADER emitted, not about what the objectives
--- engine then did with it (that half is covered live in
--- objectives/tests/registry_spec.lua's "phase chaining" describe).
local function newWorld(opts)
    opts = opts or {}
    local world = {
        created = {},           -- captured GG.Objectives.Create defs, in order
        echoes = {},
        gameRulesParams = {},
        civilians = opts.civilians or {},   -- unitID -> role
        teams = { 0, 1, GAIA },
        scenario = opts.scenario,
        frame = 0,
    }

    _G.Spring = {
        GetModOptions = function() return { scenario = 'objective_chain_test' } end,
        GetTeamList = function() return world.teams end,
        GetGaiaTeamID = function() return GAIA end,
        GetTeamInfo = function(teamID)
            return nil, (teamID == 0 or teamID == 1) and 1 or -1
        end,
        GetTeamUnits = function() return {} end,
        GetGameFrame = function() return world.frame end,
        GetGroundHeight = function() return 0 end,
        GetUnitsInCylinder = function()
            local out = {}
            for unitID in pairs(world.civilians) do out[#out + 1] = unitID end
            table.sort(out)
            return out
        end,
        GetUnitDefID = function() return 1 end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        ValidUnitID = function() return true end,
        CreateUnit = function() return 1 end,
        GiveOrderToUnit = function() end,
        SetUnitNeutral = function() end,
        SetTeamRulesParam = function() end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
    }

    _G.CMD = { FIGHT = 16, MOVE = 10, GUARD = 25 }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    _G.UnitDefs = { { name = 'ms_civilians', speed = 42, customParams = { civilian = '1' } } }

    local nextId = 100
    _G.GG = {
        Regions = {
            KeyAt = function() return '0:0' end,
            SetControllingTeam = function() end,
            SetName = function() end,
        },
        Objectives = {
            Create = function(def)
                nextId = nextId + 1
                world.created[#world.created + 1] = def
                return nextId
            end,
        },
        Civilians = {
            Spawn = function() return 5000 end,
            Register = function() end,
            IsCivilian = function(unitID) return world.civilians[unitID] ~= nil end,
            GetRole = function(unitID) return world.civilians[unitID] end,
        },
        Teams = { AIPlayers = function() return {} end },
        Authority = { Award = function() end },
        Scenario = {},
    }
    _G.VFS = { Include = function() return world.scenario end }

    dofile(GADGET)
    return world, _G.gadget
end

--- The D4 authoring shape: a parent whose progress IS its children, with a
--- second beat that only activates once the first completes. Note the parent
--- is a real `control` objective and must itself validate — a `phases` parent
--- with bogus params returns nil from Create and the whole chain silently does
--- not exist.
local function chainedObjective(over)
    local o = {
        type = 'control', scope = 'strategic', forTeam = 0,
        reward = 0, bounty = 25, phase = 1, linkedId = 7, parentId = 3,
        params = { regionKey = 'r1_1' },
        phases = {
            { { type = 'control', region = 'r1_1', reward = 40, holdFrames = 300 } },
            { { type = 'control', region = 'r2_1', reward = 80 } },
        },
    }
    for k, v in pairs(over or {}) do o[k] = v end
    return o
end

local function scenario(objectives)
    return {
        version = 1, name = 'Objective chaining test',
        world = { regions = { { key = 'home_north', team = 0 } } },
        sides = { { faction = 'compact', team = 0 }, { faction = 'union', team = 1 } },
        objectives = objectives,
    }
end

local function echoMatching(world, pattern)
    for _, e in ipairs(world.echoes) do
        if e:find(pattern, 1, true) then return e end
    end
    return nil
end

--=============================================================================
describe("game_scenario objective chaining (S4.1)", function()

    describe("the immediate create path", function()
        local world
        before_each(function()
            local w, g = newWorld({ scenario = scenario({ chainedObjective() }) })
            world = w
            g:GameStart()
        end)

        it("forwards every chaining field to GG.Objectives.Create", function()
            assert.are.equal(1, #world.created)
            local def = world.created[1]
            assert.are.equal(25, def.bounty)
            assert.are.equal(1, def.phase)
            assert.are.equal(3, def.parentId)
            assert.are.equal(7, def.linkedId)
            assert.is_table(def.phases)
            assert.are.equal(2, #def.phases)
        end)

        it("folds a phase child's flat fields the same way a top-level one gets", function()
            local child = world.created[1].phases[1][1]
            -- `region` is the authoring spelling; `params.regionKey` is what
            -- objectives/control.lua reads. A child authored in the top-level
            -- dialect but folded by nobody would fail validateParams and take
            -- the whole chain down with it (Create returns nil when phase 1
            -- spawns nothing).
            assert.are.equal('r1_1', child.params.regionKey)
            assert.are.equal(300, child.params.holdFrames)
        end)

        it("applies the control hold default to a child that omits it", function()
            local child = world.created[1].phases[2][1]
            assert.are.equal('r2_1', child.params.regionKey)
            assert.is_number(child.params.holdFrames)
        end)

        it("copies phase children rather than mutating the authored file", function()
            local scn = scenario({ chainedObjective() })
            local w, g = newWorld({ scenario = scn })
            g:GameStart()
            -- The scenario table is content shared with anything else that
            -- reads it (the briefing publisher, validate()); folding must not
            -- edit it in place.
            assert.is_nil(scn.objectives[1].phases[1][1].params)
            assert.is_table(w.created[1].phases[1][1].params)
        end)
    end)

    describe("the deferred (frame-30 civilian sweep) path", function()
        -- The asymmetry this pins: `bounty` reached the immediate site and not
        -- this one, for the entire life of the field.
        local world, gadgetObj
        before_each(function()
            local o = chainedObjective({
                type = 'protect', params = {},
                phases = { { { type = 'control', region = 'r1_1', reward = 40 } } },
                _populateTargetsFrom = { x = 100, z = 100, r = 500, role = 'ambient' },
            })
            world, gadgetObj = newWorld({
                scenario = scenario({ o }),
                civilians = { [4242] = 'ambient' },
            })
            gadgetObj:GameStart()
        end)

        it("defers instead of creating at GameStart", function()
            assert.are.equal(0, #world.created)
            assert.is_not_nil(echoMatching(world, 'deferred'))
        end)

        it("forwards bounty and the chaining fields at frame 30", function()
            world.frame = 30
            gadgetObj:GameFrame(30)
            assert.are.equal(1, #world.created)
            local def = world.created[1]
            assert.are.same({ 4242 }, def.params.targetUnitIDs)
            assert.are.equal(25, def.bounty)
            assert.are.equal(1, def.phase)
            assert.are.equal(3, def.parentId)
            assert.are.equal(7, def.linkedId)
            assert.are.equal('r1_1', def.phases[1][1].params.regionKey)
        end)
    end)

    describe("validation — a mis-shaped chain must fail LOUD at load", function()
        -- Without these, every case here is a silent no-op at runtime: Create's
        -- `#def.phases > 0` guard skips a malformed chain and the parent
        -- quietly becomes an ordinary objective the author thinks is a chain.
        local function expectLoadError(objective, pattern)
            local _, g = newWorld({ scenario = scenario({ objective }) })
            local ok, err = pcall(function() g:GameStart() end)
            assert.is_false(ok)
            assert.is_truthy(tostring(err):find(pattern, 1, true))
        end

        it("accepts the authorable chain", function()
            local _, g = newWorld({ scenario = scenario({ chainedObjective() }) })
            assert.has_no.errors(function() g:GameStart() end)
        end)

        it("rejects a non-table phases", function()
            expectLoadError(chainedObjective({ phases = 'later' }),
                'non-empty array of phases')
        end)

        it("rejects an empty phase", function()
            expectLoadError(chainedObjective({ phases = { {} } }),
                'non-empty array of child objectives')
        end)

        it("rejects a child with no type", function()
            expectLoadError(chainedObjective({ phases = { { { reward = 1 } } } }),
                'child needs a string "type"')
        end)

        it("rejects nested phases", function()
            expectLoadError(chainedObjective({
                phases = { { { type = 'control', region = 'r1_1',
                               phases = { { { type = 'kill' } } } } } },
            }), 'nested phases are not supported')
        end)

        it("rejects a non-numeric parentId", function()
            expectLoadError(chainedObjective({ parentId = 'the_first_one' }),
                '"parentId" must be a numeric runtime objective id')
        end)

        it("rejects a non-numeric linkedId", function()
            expectLoadError(chainedObjective({ linkedId = {} }),
                '"linkedId" must be a numeric runtime objective id')
        end)
    end)
end)
