-- civilians/tests/estate_spec.lua — civilian estate parley responder + threat
-- detection (PLAN-metalstorm-interaction.md §3, §11). Run from the plugin
-- root: cd data/games/metalstorm/LuaRules/Gadgets/civilians && busted tests/
package.path = './?.lua;' .. package.path

local function freshWorld()
    local world = {
        units = {},           -- unitID -> { team, x, z, health }
        unitRegions = {},     -- unitID -> regionKey
        regionOwners = {},    -- regionKey -> teamID
        trustByPair = {},     -- "lo_hi" -> value
        respondCalls = {},
        proposeHooks = {},
        moveOrders = {},
    }

    function world.setUnit(unitID, teamID, x, z, health)
        world.units[unitID] = { team = teamID, x = x, z = z, health = health or 100 }
    end
    function world.setUnitRegion(unitID, regionKey) world.unitRegions[unitID] = regionKey end
    function world.setRegionOwner(key, teamID) world.regionOwners[key] = teamID end
    function world.setTrust(a, b, v)
        local lo, hi = math.min(a, b), math.max(a, b)
        world.trustByPair[lo .. '_' .. hi] = v
    end

    _G.CMD = { MOVE = 10 }
    _G.Spring = {
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            return u.x, 0, u.z
        end,
        GetUnitTeam = function(unitID) local u = world.units[unitID]; return u and u.team end,
        GetUnitHealth = function(unitID) local u = world.units[unitID]; return u and u.health end,
        GetUnitsInCylinder = function(x, z, r)
            local out = {}
            for unitID, u in pairs(world.units) do
                local dx, dz = u.x - x, u.z - z
                if math.sqrt(dx * dx + dz * dz) <= r then out[#out + 1] = unitID end
            end
            table.sort(out)
            return out
        end,
        GetGroundHeight = function() return 0 end,
        GiveOrderToUnit = function(unitID, cmdID, params)
            world.moveOrders[#world.moveOrders + 1] = { unitID = unitID, cmdID = cmdID, params = params }
        end,
    }

    _G.GG = {
        Regions = {
            KeyAt = function(x, z)
                for unitID, u in pairs(world.units) do
                    if u.x == x and u.z == z then return world.unitRegions[unitID] end
                end
                return nil
            end,
            ControllingTeam = function(key) return world.regionOwners[key] end,
        },
        Parley = {
            Trust = function(a, b)
                local lo, hi = math.min(a, b), math.max(a, b)
                return world.trustByPair[lo .. '_' .. hi] or 0
            end,
            Respond = function(id, byTeam, byPlayer, decision)
                world.respondCalls[#world.respondCalls + 1] = { id = id, byTeam = byTeam, decision = decision }
            end,
            OnPropose = function(fn) world.proposeHooks[#world.proposeHooks + 1] = fn end,
        },
    }

    package.loaded['estate'] = nil
    local estate = dofile('./estate.lua')
    return world, estate
end

describe("register (§3)", function()
    it("auto-responds to a proposal addressed to the civilian estate", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = {} }
        estate.register(civ)

        assert.are.equal(1, #world.proposeHooks)
        world.proposeHooks[1]({ id = 5, kind = 'ceasefire', toTeam = 99, fromTeam = 10, terms = {} })
        assert.are.equal(1, #world.respondCalls)
        assert.are.equal(5, world.respondCalls[1].id)
        assert.are.equal('accept', world.respondCalls[1].decision)
    end)

    it("ignores proposals not addressed to the estate", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = {} }
        estate.register(civ)
        world.proposeHooks[1]({ id = 6, kind = 'ceasefire', toTeam = 20, fromTeam = 10, terms = {} })
        assert.are.equal(0, #world.respondCalls)
    end)
end)

describe("rule-table evaluation (§3)", function()
    it("always accepts a ceasefire", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = {} }
        estate.respond(civ, { id = 1, kind = 'ceasefire', fromTeam = 10, toTeam = 99, terms = {} })
        assert.are.equal('accept', world.respondCalls[1].decision)
    end)

    it("accepts safe_passage when trust is neutral or better", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = {} }
        world.setTrust(10, 99, 0)
        estate.respond(civ, { id = 2, kind = 'safe_passage', fromTeam = 10, toTeam = 99, terms = { corridor = { 'a' } } })
        assert.are.equal('accept', world.respondCalls[1].decision)
    end)

    it("rejects safe_passage from a distrusted team", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = {} }
        world.setTrust(10, 99, -5)
        estate.respond(civ, { id = 3, kind = 'safe_passage', fromTeam = 10, toTeam = 99, terms = { corridor = { 'a' } } })
        assert.are.equal('reject', world.respondCalls[1].decision)
    end)

    it("rejects joint_objective and intel unconditionally", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = {} }
        estate.respond(civ, { id = 4, kind = 'joint_objective', fromTeam = 10, toTeam = 99, terms = { objectiveId = 1 } })
        estate.respond(civ, { id = 5, kind = 'intel', fromTeam = 10, toTeam = 99, terms = { regionKeys = { 'a' } } })
        assert.are.equal('reject', world.respondCalls[1].decision)
        assert.are.equal('reject', world.respondCalls[2].decision)
    end)

    it("rejects a large tribute demand and reacts with evacuation when credible", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = { [1] = { role = 'ambient' } } }
        world.setUnit(1, 99, 0, 0, 100)
        world.setUnit(2, 10, 100, 0, 300)   -- a credible enemy nearby (>50 HP within 600)

        estate.respond(civ, {
            id = 6, kind = 'demand', fromTeam = 10, toTeam = 99,
            terms = { innerKind = 'tribute', innerTerms = { amount = 5000 } },
        })

        assert.are.equal('reject', world.respondCalls[1].decision)
        assert.are.equal(1, #world.moveOrders)   -- fled
        assert.are.equal(1, world.moveOrders[1].unitID)
    end)

    it("does not evacuate against a non-credible (weak/absent) threat", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = { [1] = { role = 'ambient' } } }
        world.setUnit(1, 99, 0, 0, 100)

        estate.respond(civ, {
            id = 7, kind = 'demand', fromTeam = 10, toTeam = 99,
            terms = { innerKind = 'tribute', innerTerms = { amount = 5000 } },
        })

        assert.are.equal('reject', world.respondCalls[1].decision)
        assert.are.equal(0, #world.moveOrders)   -- no credible threat nearby, no flee
    end)
end)

describe("protection-contract origination (§3, wired to objectives/generator.lua)", function()
    it("reports a district as threatened when a credible enemy is adjacent", function()
        local world, estate = freshWorld()
        local civ = { gaiaTeam = 99, population = { [1] = { role = 'ambient', districtId = 'd1' } } }
        world.setUnit(1, 99, 0, 0, 100)
        world.setUnitRegion(1, 'basin_a')
        world.setRegionOwner('basin_a', 10)
        world.setUnit(2, 20, 50, 0, 200)   -- enemy of the region owner, credible strength

        local out = estate.threatenedDistricts(civ)
        assert.are.equal(1, #out)
        assert.are.equal('d1', out[1].districtId)
        assert.are.equal(10, out[1].districtTeam)
        assert.are.same({ 1 }, out[1].unitIDs)
    end)

    it("yields nothing when no district has a threat (or no districtId tagging exists yet)", function()
        local world, estate = freshWorld()
        -- civilians/spawn.lua doesn't tag districtId yet (documented,
        -- pre-existing scope gap) — population with no districtId produces {}.
        local civ = { gaiaTeam = 99, population = { [1] = { role = 'ambient' } } }
        world.setUnit(1, 99, 0, 0, 100)
        assert.are.same({}, estate.threatenedDistricts(civ))
    end)
end)
