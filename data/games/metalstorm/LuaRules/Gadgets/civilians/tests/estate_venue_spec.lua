-- civilians/tests/estate_venue_spec.lua — the meeting hall as the estate's
-- parley venue (town-planner T4; model-integration §M2 "meeting hall is the
-- parley venue"). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets/civilians && busted tests/
--
-- Kept separate from estate_spec.lua on purpose. That spec's world has no
-- GG.Towns, and it must KEEP not having one: the venue rule is a constraint
-- towns add, and every scenario written before towns existed has to answer
-- exactly as it always did. Two worlds rather than one with a flag makes that
-- guarantee legible instead of a branch somebody can quietly flip.
package.path = './?.lua;' .. package.path

local GAIA = 99

local function freshWorld(opts)
    opts = opts or {}
    local world = {
        respondCalls = {},
        logs = {},
        venues = {},          -- townKey -> unitID | nil (nil = hall gone)
        townKeys = opts.townKeys or {},
        towns = {},           -- townKey -> record
    }
    for i, k in ipairs(world.townKeys) do
        world.towns[k] = { key = k }
        -- Written long-hand: `opts.noVenues and nil or <id>` is the classic Lua
        -- and/or trap and yields the id in BOTH branches.
        if not opts.noVenues then world.venues[k] = 1000 + i end
    end

    _G.CMD = { MOVE = 10 }
    _G.LOG = { INFO = 1, WARNING = 2 }
    _G.Spring = {
        GetUnitPosition = function() return nil end,
        GetUnitTeam = function() return nil end,
        GetUnitHealth = function() return nil end,
        GetUnitsInCylinder = function() return {} end,
        GetGroundHeight = function() return 0 end,
        GiveOrderToUnit = function() end,
        Log = function(_s, level, msg)
            world.logs[#world.logs + 1] = { level = level, msg = msg }
        end,
    }

    _G.GG = {
        Regions = { KeyAt = function() return nil end,
                    ControllingTeam = function() return nil end },
        Parley = {
            Trust = function() return 0 end,
            Respond = function(id, byTeam, _byPlayer, decision)
                world.respondCalls[#world.respondCalls + 1] =
                    { id = id, byTeam = byTeam, decision = decision }
            end,
            OnPropose = function() end,
        },
    }
    if not opts.noTownsGadget then
        _G.GG.Towns = {
            Keys = function()
                local out = {}
                for i, k in ipairs(world.townKeys) do out[i] = k end
                return out
            end,
            Get = function(key) return world.towns[key] end,
            Venue = function(key) return world.venues[key] end,
        }
    end

    package.loaded['estate'] = nil
    local estate = dofile('./estate.lua')
    local civ = { gaiaTeam = GAIA, population = {} }
    return world, estate, civ
end

local function proposal(over)
    local p = { id = 1, kind = 'ceasefire', fromTeam = 0, toTeam = GAIA,
                terms = { duration = 600 } }
    for k, v in pairs(over or {}) do p[k] = v end
    return p
end

local function lastDecision(world)
    local c = world.respondCalls[#world.respondCalls]
    return c and c.decision
end

--=============================================================================
describe("a game with no towns answers exactly as it always did", function()

    it("accepts a ceasefire when the civilians gadget exposes no GG.Towns", function()
        local world, estate, civ = freshWorld({ noTownsGadget = true })
        estate.respond(civ, proposal())
        assert.are.equal('accept', lastDecision(world))
    end)

    it("accepts a ceasefire when GG.Towns exists but the scenario has none", function()
        -- The common case on every map with no planned town in it. An empty
        -- registry must not read as "the estate has lost all its halls".
        local world, estate, civ = freshWorld({ townKeys = {} })
        estate.respond(civ, proposal())
        assert.are.equal('accept', lastDecision(world))
    end)
end)

--=============================================================================
describe("a district-scoped proposal is heard at that district's hall", function()

    it("is answered normally while the town's hall stands", function()
        local world, estate, civ = freshWorld({ townKeys = { 'north_market' } })
        estate.respond(civ, proposal({
            kind = 'safe_passage',
            terms = { duration = 600, corridor = { 'north_market' },
                      regionKey = 'north_market' } }))
        assert.are.equal('accept', lastDecision(world))
    end)

    it("is REFUSED once that town's hall is gone", function()
        -- THE MECHANIC. Burning a town's meeting hall does not merely destroy a
        -- building: it ends the estate's ability to negotiate over that town.
        local world, estate, civ = freshWorld({ townKeys = { 'north_market' } })
        world.venues['north_market'] = nil
        estate.respond(civ, proposal({
            kind = 'ceasefire',
            terms = { duration = 600, regionKey = 'north_market' } }))
        assert.are.equal('reject', lastDecision(world))
        assert.is_truthy(world.logs[1].msg:find('north_market', 1, true))
    end)

    it("refuses even a ceasefire, which the estate otherwise always wants", function()
        -- The venue check sits AHEAD of the rule table rather than inside it:
        -- this is a question about whether the estate can meet at all, and the
        -- one branch that accepts unconditionally is where a rule-table-local
        -- check would have been forgotten.
        local world, estate, civ = freshWorld({ townKeys = { 'a' } })
        world.venues['a'] = nil
        estate.respond(civ, proposal({ terms = { duration = 600, regionKey = 'a' } }))
        assert.are.equal('reject', lastDecision(world))
    end)

    it("answers rather than going silent, so the proposal does not sit until TTL", function()
        local world, estate, civ = freshWorld({ townKeys = { 'a' } })
        world.venues['a'] = nil
        estate.respond(civ, proposal({ id = 42, terms = { regionKey = 'a' } }))
        assert.are.equal(1, #world.respondCalls)
        assert.are.equal(42, world.respondCalls[1].id)
        assert.are.equal(GAIA, world.respondCalls[1].byTeam)
    end)

    it("reads the region out of a demand's INNER terms too", function()
        -- A demand wraps another proposal; the district it is about is in the
        -- wrapped terms, and a check that only looked at the outer ones would
        -- let an ultimatum be heard at a hall that no longer exists.
        local world, estate, civ = freshWorld({ townKeys = { 'a' } })
        world.venues['a'] = nil
        estate.respond(civ, proposal({
            kind = 'demand',
            terms = { innerKind = 'tribute',
                      innerTerms = { amount = 10, regionKey = 'a' } } }))
        assert.are.equal('reject', lastDecision(world))
        assert.is_truthy(world.logs[1].msg:find('no meeting hall', 1, true))
    end)

    it("does not bind a proposal about a region that HAS no town", function()
        -- Only a region with a town in it is bound to that town's hall. A
        -- proposal about open country is not refused for want of a hall that
        -- was never there.
        local world, estate, civ = freshWorld({ townKeys = { 'north_market' } })
        world.venues['north_market'] = nil
        estate.respond(civ, proposal({
            terms = { duration = 600, regionKey = 'east_pass' } }))
        assert.are.equal('accept', lastDecision(world))
    end)
end)

--=============================================================================
describe("an estate-wide proposal needs a hall SOMEWHERE", function()

    it("is answered while any town still has its hall", function()
        local world, estate, civ = freshWorld({ townKeys = { 'a', 'b' } })
        world.venues['a'] = nil          -- one burned, one standing
        estate.respond(civ, proposal())
        assert.are.equal('accept', lastDecision(world))
    end)

    it("is refused once the estate has lost every hall it had", function()
        local world, estate, civ = freshWorld({ townKeys = { 'a', 'b' },
                                               noVenues = true })
        estate.respond(civ, proposal())
        assert.are.equal('reject', lastDecision(world))
        assert.is_truthy(world.logs[1].msg:find('anywhere in the estate', 1, true))
    end)
end)
