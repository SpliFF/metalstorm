-- tests/game_scenario_towns_spec.lua — the scenario loader's `towns` block and
-- the district binding on `civilians.units` (town-planner T4).
--
-- Run from the GAME root (same as game_scenario_neutral_spec.lua, and for the
-- same reason — the gadget is loaded by a game-root-relative path):
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/game_scenario_towns_spec.lua
--
-- WHY THIS EXISTS. Every failure this block can have is silent:
--
--   * a civilian whose `town` is dropped on the floor gets no districtId, and
--     civilians/estate.lua's threatenedDistricts() goes back to returning an
--     empty list — from a mechanism that has always LOOKED complete and, until
--     towns emitted a district id, never had one to see;
--   * a `towns` entry the loader forgets to register leaves the region unnamed,
--     which does not error anywhere: it just means every typed or spoken order
--     naming that town resolves to nothing;
--   * a `world.regions` entry carrying a name and no team must not clear the
--     region's owner, because SetControllingTeam(key, nil) is not a no-op — it
--     publishes team = -1 and would take a landing zone off the side that was
--     given it two entries earlier.

local GADGET = './LuaRules/Gadgets/game_scenario.lua'

local GAIA = 99
local HALL = 'ms_transit_hub'

local function newWorld(opts)
    opts = opts or {}
    local world = {
        createdUnits = {},      -- { def, team, x, z }
        civSpawns = {},         -- { def, x, z, facing }
        registrations = {},     -- { unitID, role, info }
        townsRegistered = {},   -- scenario `towns` entries handed to GG.Towns
        ownerSets = {},         -- { key, team }
        renames = {},           -- key -> { name, x, z }
        echoes = {},
        gameRulesParams = {},
        teams = { 0, 1, GAIA },
        scenario = opts.scenario,
    }

    _G.Spring = {
        GetModOptions = function() return { scenario = 'towns_test' } end,
        GetTeamList = function() return world.teams end,
        GetGaiaTeamID = function() return GAIA end,
        GetTeamInfo = function(teamID)
            return nil, (teamID == 0 or teamID == 1) and 1 or -1
        end,
        GetTeamUnits = function(teamID)
            local out = {}
            for i, u in ipairs(world.createdUnits) do
                if u.team == teamID then out[#out + 1] = i end
            end
            return out
        end,
        GetGroundHeight = function() return 0 end,
        GetUnitsInCylinder = function() return {} end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        ValidUnitID = function() return true end,
        CreateUnit = function(def, x, _y, z, _facing, team)
            world.createdUnits[#world.createdUnits + 1] =
                { def = def, team = team, x = x, z = z }
            return #world.createdUnits
        end,
        GiveOrderToUnit = function() end,
        SetTeamRulesParam = function() end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = tostring(msg) end,
    }

    _G.CMD = { FIGHT = 16, MOVE = 10, GUARD = 25 }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    _G.UnitDefs = {}
    for i, d in ipairs({
        { name = HALL,             speed = 0 },
        { name = 'ms_habitat',     speed = 0 },
        { name = 'ms_civilians',   speed = 42 },
        { name = 'ms_militia',     speed = 45 },
        { name = 'ms_tanks_s2',    speed = 66.3 },
    }) do
        _G.UnitDefs[i] = { name = d.name, speed = d.speed, customParams = {} }
    end

    local nextCiv = 5000
    _G.GG = {
        Regions = {
            KeyAt = function() return '0:0' end,
            SetControllingTeam = function(key, team)
                world.ownerSets[#world.ownerSets + 1] = { key = key, team = team }
            end,
            SetName = function(key, name, x, z)
                world.renames[key] = { name = name, x = x, z = z }
            end,
        },
        Objectives = { Create = function() return 1 end },
        Civilians = {
            Spawn = function(def, x, z, facing)
                nextCiv = nextCiv + 1
                world.civSpawns[#world.civSpawns + 1] =
                    { def = def, x = x, z = z, facing = facing, id = nextCiv }
                return nextCiv
            end,
            Register = function(unitID, role, info)
                world.registrations[#world.registrations + 1] =
                    { unitID = unitID, role = role, info = info }
            end,
        },
        Teams = { AIPlayers = function() return {} end },
        Authority = { Award = function() end },
        Scenario = {},
    }
    if not opts.noTownsGadget then
        _G.GG.Towns = {
            Register = function(entry)
                world.townsRegistered[#world.townsRegistered + 1] = entry
                return entry
            end,
            Get = function(key)
                for _, t in ipairs(world.townsRegistered) do
                    if t.key == key then return t end
                end
                return nil
            end,
        }
    end
    _G.VFS = { Include = function() return world.scenario end }

    dofile(GADGET)
    return world, _G.gadget
end

--- A two-side war with one planned town in it.
local function scenario(over)
    local scn = {
        version = 1, name = 'Towns staging test',
        world = {
            regions = {
                { key = 'home_north', team = 0 },
                { key = 'home_south', team = 1 },
                { key = 'north_market', name = 'Kessel Reach', x = 4000, z = 3000 },
            },
        },
        towns = {
            {
                key = 'north_market', name = 'Kessel Reach',
                region = 'north_market', x = 4000, z = 3000, radius = 760,
                archetype = 'main_street', defense = 'stockade',
                hall = { def = HALL, x = 4100, z = 3050 },
            },
        },
        sides = { { faction = 'compact', team = 0 }, { faction = 'union', team = 1 } },
        units = {
            { def = 'ms_tanks_s2', team = 0, x = 1000, z = 1000, facing = 'south',
              orders = { { cmd = 'FIGHT', params = { 4000, 0, 4000 } } } },
            { def = 'ms_tanks_s2', team = 1, x = 7000, z = 7000, facing = 'south',
              orders = { { cmd = 'FIGHT', params = { 4000, 0, 4000 } } } },
            { def = HALL, team = 'neutral', x = 4100, z = 3050, facing = 'east' },
            { def = 'ms_habitat', team = 'neutral', x = 4300, z = 3050, facing = 'west' },
        },
        civilians = {
            units = {
                { def = 'ms_civilians', x = 4200, z = 3200, facing = 'north',
                  role = 'ambient', town = 'north_market' },
                { def = 'ms_militia', x = 4400, z = 3400, facing = 'south',
                  role = 'garrison', town = 'north_market' },
            },
        },
        objectives = {
            { type = 'control', scope = 'strategic', forTeam = nil,
              region = 'north_market', reward = 300, victory = true,
              notBefore = 0, holdFrames = 5400 },
        },
    }
    for k, v in pairs(over or {}) do scn[k] = v end
    return scn
end

local function echoMatching(world, pattern)
    for _, e in ipairs(world.echoes) do
        if e:find(pattern, 1, true) then return e end
    end
    return nil
end

local function registrationFor(world, def)
    for i, s in ipairs(world.civSpawns) do
        if s.def == def then
            for _, r in ipairs(world.registrations) do
                if r.unitID == s.id then return r end
            end
            return nil, i
        end
    end
    return nil
end

--=============================================================================
describe("game_scenario `towns` (town-planner T4)", function()

    it("hands every town to the registry, in file order", function()
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        assert.are.equal(1, #world.townsRegistered)
        assert.are.equal('north_market', world.townsRegistered[1].key)
        assert.are.equal(HALL, world.townsRegistered[1].hall.def)
    end)

    it("homes each resident on its OWN doorstep, not on the town square", function()
        -- routines.lua both wanders and flees toward `homePos`, so it has to
        -- mean "where this person lives". A whole district homed on the town's
        -- centre mills about the square and leaves every street the placer
        -- carefully put it on empty — the same class of defect as the
        -- cross-map migration the routines spec pins.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        local r = registrationFor(world, 'ms_civilians')
        assert.is_not_nil(r)
        assert.are.same({ x = 4200, z = 3200 }, r.info.homePos)
    end)

    it("registers towns BEFORE staging the civilians that live in them", function()
        -- Ordering is load-bearing: a civilian registered against a town the
        -- registry has not seen yet is claimed by nothing, and the district it
        -- names then has a population of one fewer than the file says.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        assert.are.equal('north_market', world.townsRegistered[1].key)
        assert.are.equal('north_market',
                         registrationFor(world, 'ms_civilians').info.town)
    end)

    it("binds each civilian to its town as a DISTRICT", function()
        -- The whole reason estate.lua's threatenedDistricts() has always
        -- returned nothing: no spawn path ever set a districtId.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        local r = registrationFor(world, 'ms_civilians')
        assert.are.equal('north_market', r.info.town)
        assert.are.equal('ambient', r.role)
    end)

    it("keeps the militia's `garrison` role intact", function()
        -- routines.lua only moves `ambient`. A militiaman silently promoted to
        -- ambient walks off the gateway it was posted to on the next tick.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        assert.are.equal('garrison', registrationFor(world, 'ms_militia').role)
    end)

    it("warns, and still stages the buildings, when there is no civilians gadget", function()
        local world, g = newWorld({ scenario = scenario(), noTownsGadget = true })
        g:GameStart()
        assert.is_not_nil(echoMatching(world, 'GG.Towns is absent'))
        -- The town's buildings are ordinary `units` entries and are unaffected.
        local staged = 0
        for _, u in ipairs(world.createdUnits) do
            if u.team == GAIA then staged = staged + 1 end
        end
        assert.are.equal(2, staged)
    end)
end)

--=============================================================================
describe("naming the region a town stands in", function()

    it("renames it and moves its published centre onto the town", function()
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        assert.are.same({ name = 'Kessel Reach', x = 4000, z = 3000 },
                        world.renames['north_market'])
    end)

    it("does NOT clear the owner of a region it only names", function()
        -- SetControllingTeam(key, nil) publishes team = -1. A name-only entry
        -- that fell through to it would hand a landing zone back to nobody.
        local world, g = newWorld({ scenario = scenario() })
        g:GameStart()
        for _, s in ipairs(world.ownerSets) do
            assert.are_not.equal('north_market', s.key)
        end
        -- ...while the two entries that DO carry a team still set one.
        assert.are.equal(2, #world.ownerSets)
        assert.are.equal(0, world.ownerSets[1].team)
    end)

    it("still clears a region explicitly declared neutral", function()
        local scn = scenario()
        scn.world.regions[3] = { key = 'north_market', name = 'Kessel Reach',
                                 team = 'neutral' }
        local world, g = newWorld({ scenario = scn })
        g:GameStart()
        local found = false
        for _, s in ipairs(world.ownerSets) do
            if s.key == 'north_market' then
                found = true
                assert.is_nil(s.team)
            end
        end
        assert.is_true(found)
    end)
end)

--=============================================================================
describe("validation refuses a town that would load and then not be a place", function()

    it("rejects a civilian whose `town` no towns entry declares", function()
        -- Otherwise that civilian is registered into a district nothing knows
        -- about: never counted, never evacuated, never a protect target.
        local scn = scenario()
        scn.civilians.units[1].town = 'nowhere'
        local _world, g = newWorld({ scenario = scn })
        assert.has_error(function() g:GameStart() end)
    end)

    it("rejects a hall whose def this game does not ship", function()
        -- A misspelt hall def resolves to no unit, and the town then negotiates
        -- exactly as if its hall had been destroyed.
        local scn = scenario()
        scn.towns[1].hall.def = 'ms_meeting_hal'
        local _world, g = newWorld({ scenario = scn })
        assert.has_error(function() g:GameStart() end)
    end)

    it("rejects a hall with no position to resolve it at", function()
        local scn = scenario()
        scn.towns[1].hall = { def = HALL }
        local _world, g = newWorld({ scenario = scn })
        assert.has_error(function() g:GameStart() end)
    end)

    it("rejects two towns sharing a key", function()
        local scn = scenario()
        scn.towns[2] = { key = 'north_market', name = 'Twin', x = 1, z = 1 }
        local _world, g = newWorld({ scenario = scn })
        assert.has_error(function() g:GameStart() end)
    end)

    it("rejects a keyless town", function()
        local scn = scenario()
        scn.towns[2] = { name = 'Nameless', x = 1, z = 1 }
        local _world, g = newWorld({ scenario = scn })
        assert.has_error(function() g:GameStart() end)
    end)

    it("accepts a town with no hall — that is a town with no venue", function()
        -- The state a game whose content ships no `unique` lot def produces.
        local scn = scenario()
        scn.towns[1].hall = nil
        local world, g = newWorld({ scenario = scn })
        g:GameStart()
        assert.are.equal(1, #world.townsRegistered)
    end)
end)
