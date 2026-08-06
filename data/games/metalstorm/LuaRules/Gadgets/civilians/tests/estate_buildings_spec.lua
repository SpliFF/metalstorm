-- civilians/tests/estate_buildings_spec.lua — civilian BUILDINGS register with
-- the estate (PLAN-metalstorm-model-integration §M2 acceptance: "civilian
-- buildings register with the estate gadget").
-- Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets/civilians && busted tests/
--
-- This drives the REAL game_civilians.lua gadget, not just estate.lua, because
-- the thing under test is the WIRING: a def flag alone proves nothing if no
-- callin ever hands the unit to the estate. Separate from estate_spec.lua
-- (parley responder + threat detection) — that spec mocks a world with no
-- UnitDefs and no gadget instance at all, and widening it to carry both would
-- make one fixture serve two unrelated surfaces. Narrowly built for this file,
-- not a shared framework (same convention as tests/parley_mock.lua).

package.path = './?.lua;' .. package.path

--- A fresh mock world + a fresh instance of game_civilians.lua loaded against
--- it. Globals are process-wide in plain Lua, so every `it` gets its own.
local function freshWorld()
    local world = {
        units = {},        -- unitID -> { defID, x, z }
        unitDefs = {},     -- defID   -> { name, customParams }
        logs = {},
    }

    --- Declare a unit def. `civRole` nil = not a civilian building at all.
    function world.defineDef(defID, name, civilian, civRole)
        local cp = {}
        if civilian then cp.civilian = '1' end
        if civRole then cp.civ_role = civRole end
        world.unitDefs[defID] = { name = name, customParams = cp }
    end

    function world.place(unitID, defID, x, z)
        world.units[unitID] = { defID = defID, x = x or 0, z = z or 0 }
    end

    _G.UnitDefs = world.unitDefs
    _G.CMD = { MOVE = 10 }
    _G.LOG = { INFO = 1, WARNING = 2 }

    _G.Spring = {
        GetGaiaTeamID = function() return 99 end,
        GetGameFrame  = function() return 0 end,
        GetGroundHeight = function() return 0 end,
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            return u.x, 0, u.z
        end,
        GetUnitsInCylinder = function() return {} end,
        GetUnitTeam = function() return 99 end,
        GetUnitHealth = function() return 100 end,
        GiveOrderToUnit = function() end,
        Log = function(_, _, msg) world.logs[#world.logs + 1] = msg end,
        CreateUnit = function() return nil end,
    }

    -- The gadget resolves its library modules through VFS.Include on absolute
    -- VFS paths; the spec runs from the civilians/ folder, so map them onto
    -- plain requires of the same files.
    _G.VFS = {
        MAP = 'map',
        Include = function(path)
            local mod = path:match('civilians/([%w_]+)%.lua$')
            if mod then return require(mod) end
            -- mapdata/civilians.lua — no map placement data in this fixture.
            error('no such file: ' .. tostring(path))
        end,
    }

    _G.GG = {}
    _G.gadget = {}
    _G.gadgetHandler = { IsSyncedCode = function() return true end }

    local chunk = assert(loadfile('../game_civilians.lua'))
    chunk()
    world.gadget = _G.gadget
    return world
end

describe("civilian buildings join the estate (§M2)", function()
    it("registers a civilian building on creation", function()
        local world = freshWorld()
        world.defineDef(70, 'ms_shanty_block', true, 'housing')
        world.place(1, 70)
        world.gadget:UnitCreated(1, 70)

        assert.is_true(GG.Civilians.IsCivilian(1))
        assert.are.equal('estate', GG.Civilians.GetRole(1))
    end)

    it("ignores a unit whose def is not civilian", function()
        local world = freshWorld()
        world.defineDef(80, 'ms_tanks_s2', false)
        world.place(2, 80)
        world.gadget:UnitCreated(2, 80)

        assert.is_false(GG.Civilians.IsCivilian(2))
        assert.is_nil(GG.Civilians.GetRole(2))
    end)

    it("survives a unit with an unknown def id", function()
        -- UnitCreated fires for every unit in the game; a def the registry has
        -- never heard of must be a no-op, not an index-a-nil error.
        local world = freshWorld()
        assert.has_no.errors(function() world.gadget:UnitCreated(3, 999) end)
        assert.is_false(GG.Civilians.IsCivilian(3))
    end)

    it("does NOT mark buildings 'ambient' — they must not wander or flee", function()
        -- routines.tick() drives everything role=='ambient', and
        -- threatenedDistricts() samples ambient units as evacuable district
        -- positions. A building belongs in neither set.
        local world = freshWorld()
        world.defineDef(70, 'ms_meeting_hall', true, 'venue')
        world.place(1, 70)
        world.gadget:UnitCreated(1, 70)

        assert.are_not.equal('ambient', GG.Civilians.GetRole(1))
        assert.are.same({}, GG.Civilians.ThreatenedDistricts())
    end)

    it("records the meeting hall as a parley venue, and nothing else", function()
        local world = freshWorld()
        world.defineDef(70, 'ms_meeting_hall', true, 'venue')
        world.defineDef(71, 'ms_market_stalls', true, 'market')
        world.place(1, 70, 100, 100)
        world.place(2, 71, 110, 100)
        world.gadget:UnitCreated(1, 70)
        world.gadget:UnitCreated(2, 71)

        assert.are.same({ 1 }, GG.Civilians.ParleyVenues())
    end)

    it("keeps venues in deterministic creation order", function()
        -- Synced code: a venue list built by iterating a hash would order
        -- differently per client and desync anything derived from it.
        local world = freshWorld()
        world.defineDef(70, 'ms_meeting_hall', true, 'venue')
        for _, id in ipairs({ 5, 3, 9, 1 }) do
            world.place(id, 70)
            world.gadget:UnitCreated(id, 70)
        end
        assert.are.same({ 5, 3, 9, 1 }, GG.Civilians.ParleyVenues())
    end)

    it("finds the venue nearest a point", function()
        local world = freshWorld()
        world.defineDef(70, 'ms_meeting_hall', true, 'venue')
        world.place(1, 70, 0, 0)
        world.place(2, 70, 1000, 0)
        world.gadget:UnitCreated(1, 70)
        world.gadget:UnitCreated(2, 70)

        assert.are.equal(2, GG.Civilians.NearestVenue(900, 0))
        assert.are.equal(1, GG.Civilians.NearestVenue(100, 0))
    end)

    it("returns no venue when the estate has none standing", function()
        freshWorld()
        assert.are.same({}, GG.Civilians.ParleyVenues())
        assert.is_nil(GG.Civilians.NearestVenue(0, 0))
    end)

    it("forgets a destroyed hall, in both the registry and the venue list", function()
        local world = freshWorld()
        world.defineDef(70, 'ms_meeting_hall', true, 'venue')
        world.place(1, 70)
        world.place(2, 70)
        world.gadget:UnitCreated(1, 70)
        world.gadget:UnitCreated(2, 70)
        assert.are.same({ 1, 2 }, GG.Civilians.ParleyVenues())

        world.gadget:UnitDestroyed(1)
        assert.is_false(GG.Civilians.IsCivilian(1))
        assert.are.same({ 2 }, GG.Civilians.ParleyVenues())
    end)
end)

describe("the shipped civilian building defs carry the estate flags", function()
    -- The registration above is only reachable if units/buildings_civilian.lua
    -- actually sets `civilian = '1'` (and, for the hall, civ_role = 'venue').
    -- This reads the real def file, so a def edit that drops either flag fails
    -- here rather than silently un-registering a town.
    local defs = assert(loadfile('../../../units/buildings_civilian.lua'))()

    it("flags every civilian building as civilian", function()
        for name, def in pairs(defs) do
            assert.are.equal('1', def.customparams.civilian,
                name .. ' is missing customparams.civilian')
            assert.are.equal('civilian', def.customparams.building_family, name)
        end
    end)

    it("makes exactly the meeting hall the parley venue", function()
        local venues = {}
        for name, def in pairs(defs) do
            if def.customparams.civ_role == 'venue' then venues[#venues + 1] = name end
        end
        assert.are.same({ 'ms_meeting_hall' }, venues)
    end)

    it("ships the three §M2 models with their forge object names", function()
        for _, name in ipairs({ 'ms_meeting_hall', 'ms_shanty_block', 'ms_market_stalls' }) do
            assert.is_table(defs[name], name .. ' missing from buildings_civilian.lua')
            assert.are.equal(name, defs[name].objectname)
            assert.is_true(defs[name].isbuilding)
            assert.is_false(defs[name].canmove)
        end
    end)
end)
