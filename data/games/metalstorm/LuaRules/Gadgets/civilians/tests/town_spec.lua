-- civilians/tests/town_spec.lua — the town registry: districts, statics and
-- the meeting-hall parley venue (town-planner T4). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets/civilians && busted tests/
--
-- WHAT THIS PINS. A town is the object three separate mechanisms hang off, and
-- each one fails silently when it is wrong:
--   * the RENAME is what makes a town addressable — get it wrong and every
--     typed or spoken order naming the town resolves to nothing, or to the
--     region's empty centroid half a kilometre away;
--   * the DISTRICT binding is what estate.lua groups the population by — get it
--     wrong and threatenedDistricts() goes back to returning an empty list from
--     a mechanism that looks complete;
--   * the VENUE is a live unitID resolved by position — get it wrong and the
--     estate refuses every district-scoped parley, which is indistinguishable
--     from the hall having been destroyed.
package.path = './?.lua;' .. package.path

local HALL = 'ms_transit_hub'

local function freshWorld()
    local world = {
        units = {},           -- unitID -> { def, x, z }
        rulesParams = {},
        regionAt = {},        -- "x:z" -> key   (what GG.Regions.KeyAt answers)
        renames = {},         -- key -> { name, x, z }
        logs = {},
        valid = {},           -- unitID -> false to kill it
    }

    function world.addUnit(unitID, def, x, z)
        world.units[unitID] = { def = def, x = x, z = z }
        world.valid[unitID] = true
    end
    function world.kill(unitID) world.valid[unitID] = false end

    _G.LOG = { INFO = 1, WARNING = 2 }
    _G.UnitDefs = {}
    local defIDs = {}
    for i, name in ipairs({ HALL, 'ms_habitat', 'ms_depot' }) do
        _G.UnitDefs[i] = { name = name }
        defIDs[name] = i
    end

    _G.Spring = {
        GetUnitsInCylinder = function(x, z, r)
            local out = {}
            for unitID, u in pairs(world.units) do
                local dx, dz = u.x - x, u.z - z
                if math.sqrt(dx * dx + dz * dz) <= r then out[#out + 1] = unitID end
            end
            table.sort(out)
            return out
        end,
        GetUnitDefID = function(unitID)
            local u = world.units[unitID]
            return u and defIDs[u.def] or nil
        end,
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            return u.x, 0, u.z
        end,
        ValidUnitID = function(unitID) return world.valid[unitID] == true end,
        SetGameRulesParam = function(key, value) world.rulesParams[key] = value end,
        Log = function(_sys, level, msg)
            world.logs[#world.logs + 1] = { level = level, msg = msg }
        end,
    }

    _G.GG = {
        Regions = {
            KeyAt = function(x, z) return world.regionAt[x .. ':' .. z] end,
            SetName = function(key, name, x, z)
                world.renames[key] = { name = name, x = x, z = z }
            end,
        },
    }

    package.loaded['town'] = nil
    local town = dofile('./town.lua')
    local civ = { gaiaTeam = 99, population = {}, towns = {}, townOrder = {} }
    return world, town, civ
end

local function aTown(over)
    local t = {
        key = 'north_market', name = 'Kessel Reach', region = 'north_market',
        x = 4000, z = 3000, radius = 760,
        archetype = 'main_street', defense = 'stockade',
        hall = { def = HALL, x = 4100, z = 3050 },
    }
    for k, v in pairs(over or {}) do t[k] = v end
    -- `pairs` cannot carry a nil, so removing a field needs its own spelling.
    if over and over.noHall then t.hall, t.noHall = nil, nil end
    return t
end

--=============================================================================
describe("registration", function()

    it("keeps declaration order and never a pairs() walk", function()
        local _w, town, civ = freshWorld()
        town.register(civ, aTown({ key = 'z_last' }))
        town.register(civ, aTown({ key = 'a_first' }))
        town.register(civ, aTown({ key = 'm_middle' }))
        assert.are.same({ 'z_last', 'a_first', 'm_middle' }, town.keys(civ))
    end)

    it("re-registering a key updates it in place rather than duplicating", function()
        local _w, town, civ = freshWorld()
        town.register(civ, aTown())
        town.register(civ, aTown({ name = 'Renamed' }))
        assert.are.equal(1, #town.keys(civ))
        assert.are.equal('Renamed', town.get(civ, 'north_market').name)
    end)

    it("refuses a malformed entry rather than registering a keyless town", function()
        local _w, town, civ = freshWorld()
        assert.is_nil(town.register(civ, { name = 'no key' }))
        assert.is_nil(town.register(civ, 'not a table'))
        assert.are.equal(0, #town.keys(civ))
    end)

    it("hands back a fresh key list, so a caller cannot corrupt the registry", function()
        local _w, town, civ = freshWorld()
        town.register(civ, aTown())
        local keys = town.keys(civ)
        keys[1] = 'clobbered'
        assert.are.equal('north_market', town.keys(civ)[1])
    end)
end)

--=============================================================================
describe("publish (the addressable place)", function()

    it("renames the town's region AND moves its published centre onto the town", function()
        -- THE POINT OF THE RENAME. `region_<key>_name/_x/_z` is what the
        -- client's named-entity index reads to build the command composer's
        -- Target picker. Without the name a town cannot be addressed at all;
        -- without the centre "attack Kessel Reach" pings the region's polygon
        -- centroid, which on a 2 km region is empty field.
        local world, town, civ = freshWorld()
        town.register(civ, aTown())
        town.publish(civ)
        assert.are.same({ name = 'Kessel Reach', x = 4000, z = 3000 },
                        world.renames['north_market'])
    end)

    it("publishes the town's own statics under town_<key>_*", function()
        local world, town, civ = freshWorld()
        town.register(civ, aTown())
        town.publish(civ)
        assert.are.equal('Kessel Reach', world.rulesParams['town_north_market_name'])
        assert.are.equal('north_market', world.rulesParams['town_north_market_region'])
        assert.are.equal(4000, world.rulesParams['town_north_market_x'])
        assert.are.equal('stockade', world.rulesParams['town_north_market_defense'])
        assert.are.equal(1, world.rulesParams['town_count'])
    end)

    it("publishes town_count = 0 for a scenario with no towns", function()
        local world, town, civ = freshWorld()
        town.publish(civ)
        assert.are.equal(0, world.rulesParams['town_count'])
    end)

    it("survives a game whose regions gadget has no SetName", function()
        -- A town is still a district and still a venue on a build without the
        -- rename; it is only not NAMED. Crashing here would take the whole
        -- civilians gadget out under SAFEWRAP.
        local world, town, civ = freshWorld()
        _G.GG.Regions.SetName = nil
        town.register(civ, aTown())
        town.publish(civ)
        assert.are.equal('Kessel Reach', world.rulesParams['town_north_market_name'])
    end)
end)

--=============================================================================
describe("bind (resolving the meeting hall)", function()

    it("resolves the hall to the unit the scenario staged at that spot", function()
        local world, town, civ = freshWorld()
        world.addUnit(7, HALL, 4100, 3050)
        town.register(civ, aTown())
        town.bind(civ)
        assert.are.equal(7, town.venue(civ, 'north_market'))
        assert.are.equal(7, world.rulesParams['town_north_market_hall'])
    end)

    it("picks the NEAREST matching unit when several are in range", function()
        local world, town, civ = freshWorld()
        world.addUnit(7, HALL, 4160, 3050)   -- 60 elmos off
        world.addUnit(8, HALL, 4105, 3050)   -- 5 elmos off
        town.register(civ, aTown())
        town.bind(civ)
        assert.are.equal(8, town.venue(civ, 'north_market'))
    end)

    it("ignores a unit of the wrong def standing on the hall's spot", function()
        -- The failure this catches is a town silently adopting a habitat as its
        -- parley venue because the habitat happened to be nearest.
        local world, town, civ = freshWorld()
        world.addUnit(7, 'ms_habitat', 4100, 3050)
        town.register(civ, aTown())
        town.bind(civ)
        assert.is_nil(town.venue(civ, 'north_market'))
    end)

    it("warns loudly when an authored hall staged no unit", function()
        -- Otherwise a scenario that failed to stage its hall negotiates exactly
        -- like one whose hall has been destroyed, and the two mean opposite
        -- things about whether the staging worked.
        local world, town, civ = freshWorld()
        town.register(civ, aTown())
        town.bind(civ)
        assert.are.equal(1, #world.logs)
        assert.are.equal(LOG.WARNING, world.logs[1].level)
        assert.is_truthy(world.logs[1].msg:find('no parley venue', 1, true))
    end)

    it("says nothing about a town that declares no hall at all", function()
        -- A game whose content ships no def for the `unique` lot role produces
        -- these, and it is not an error — it is a town with no venue.
        local world, town, civ = freshWorld()
        town.register(civ, aTown({ noHall = true }))
        town.bind(civ)
        assert.are.equal(0, #world.logs)
        assert.is_nil(town.venue(civ, 'north_market'))
    end)
end)

--=============================================================================
describe("venue (the mechanic that makes a hall worth defending)", function()

    it("stops being a venue the moment the hall dies", function()
        local world, town, civ = freshWorld()
        world.addUnit(7, HALL, 4100, 3050)
        town.register(civ, aTown())
        town.bind(civ)
        assert.are.equal(7, town.venue(civ, 'north_market'))

        world.kill(7)
        assert.is_nil(town.venue(civ, 'north_market'))
        -- ...and the published id is cleared, not left pointing at a corpse.
        assert.is_nil(world.rulesParams['town_north_market_hall'])
    end)

    it("re-validates on every call rather than caching a live flag", function()
        -- Deliberate: UnitDestroyed on a Gaia building is not a hook this
        -- module wants to depend on not missing.
        local world, town, civ = freshWorld()
        world.addUnit(7, HALL, 4100, 3050)
        town.register(civ, aTown())
        town.bind(civ)
        world.kill(7)
        assert.is_nil(town.venue(civ, 'north_market'))
        assert.is_nil(town.venue(civ, 'north_market'))   -- and stays nil
    end)

    it("is nil for a key that names no town", function()
        local _w, town, civ = freshWorld()
        assert.is_nil(town.venue(civ, 'nowhere'))
    end)
end)

--=============================================================================
describe("population and lookup", function()

    it("claims and releases residents", function()
        local _w, town, civ = freshWorld()
        town.register(civ, aTown())
        town.claim(civ, 11, 'north_market')
        town.claim(civ, 12, 'north_market')
        assert.are.same({ 11, 12 }, town.residents(civ, 'north_market'))
        town.release(civ, 11)
        assert.are.same({ 12 }, town.residents(civ, 'north_market'))
    end)

    it("returns residents sorted, because the order reaches decisions", function()
        local _w, town, civ = freshWorld()
        town.register(civ, aTown())
        for _, id in ipairs({ 40, 3, 17 }) do town.claim(civ, id, 'north_market') end
        assert.are.same({ 3, 17, 40 }, town.residents(civ, 'north_market'))
    end)

    it("ignores a claim for a town that was never registered", function()
        local _w, town, civ = freshWorld()
        town.claim(civ, 11, 'nowhere')
        assert.are.same({}, town.residents(civ, 'nowhere'))
    end)

    it("answers `at` through the region partition, not through a radius", function()
        -- A town's key IS its region's key, so GG.Regions already owns
        -- position -> place. A second, circle-shaped answer would drift from it.
        local world, town, civ = freshWorld()
        town.register(civ, aTown())
        world.regionAt['4200:3100'] = 'north_market'
        assert.are.equal('north_market', town.at(civ, 4200, 3100).key)
        assert.is_nil(town.at(civ, 9000, 9000))
    end)
end)
