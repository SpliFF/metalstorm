-- meridian_basin_scenario_spec.lua — Milestone 4 verification
-- Tests the objective-driven demo scenario with escort/protect/extract
-- objectives tied to civilian populations.
--
-- Run from the GAME root, not the plugin root like its neighbours in this
-- directory: `cd data/games/metalstorm && busted LuaRules/Gadgets/tests/
-- meridian_basin_scenario_spec.lua`. It dofile()s 'scenarios/meridian_basin.
-- lua' by a game-root-relative path, so `cd LuaRules/Gadgets && busted tests/`
-- reports 8 errors ("cannot open scenarios/meridian_basin.lua") that are a
-- wrong cwd, not real failures.

describe("Meridian Basin Scenario", function()
    local Spring, GG

    before_each(function()
        -- Mock Spring API
        Spring = {
            GetModOptions = function() return { scenario = 'meridian_basin' } end,
            GetUnitsInCylinder = function(x, z, r) return {} end,
            GetUnitDefID = function() return 1 end,
            GetUnitTeam = function() return 0 end,
            GetUnitHealth = function() return 100, 100 end,
            GetUnitPosition = function(id) return 100, 0, 100 end,
            ValidUnitID = function() return true end,
            GetTeamList = function() return {0, 1, 2, 3, 4, 5, 6, 7} end,
            GetGaiaTeamID = function() return 8 end,
            GetTeamStartPosition = function(team)
                -- North teams start north, south teams start south
                if team < 4 then
                    return 6600, 0, 1200
                else
                    return 6600, 0, 15184
                end
            end,
            CreateUnit = function(def, x, y, z, facing, team) return 1000 + team end,
            GiveOrderToUnit = function() end,
            SetGameRulesParam = function() end,
            Echo = function() end,
            GetGroundHeight = function() return 0 end,
        }

        UnitDefs = {
            [1] = {
                name = 'ms_civilians',
                customParams = { is_civilian = 'true' }
            }
        }

        VFS = {
            Include = function(path)
                if path:match('scenarios/meridian_basin.lua') then
                    return dofile('scenarios/meridian_basin.lua')
                end
                return {}
            end
        }

        -- Mock GG tables
        GG = {
            Objectives = {
                Create = spy.new(function() return 1 end),
            },
            Regions = {
                KeyAt = function(x, z) return '0:0' end,
                SetControllingTeam = function() end,
                Keys = function() return {} end,
                ControllingTeam = function() return nil end,
            },
            Civilians = {
                Spawn = spy.new(function(def, x, z, facing) return 5000 end),
                Register = spy.new(function() end),
                GetRole = function(unitID) return 'ambient' end,
            },
            Scenario = {},
        }

        _G.Spring = Spring
        _G.GG = GG
        _G.UnitDefs = UnitDefs
        _G.VFS = VFS

        -- Clear any previous state
        package.loaded['LuaRules/Gadgets/game_scenario'] = nil
    end)

    it("should load the meridian_basin scenario", function()
        local scn = VFS.Include('scenarios/meridian_basin.lua')

        assert.is_table(scn)
        assert.equals(1, scn.version)
        assert.equals('Meridian Basin — Standard War', scn.name)
        assert.is_false(scn.tutorial)
        assert.is_false(scn.ephemeral)
    end)

    it("should include the Meridian Evacuation story objectives", function()
        local scn = VFS.Include('scenarios/meridian_basin.lua')

        assert.is_table(scn.objectives)
        -- Count objective types
        local counts = { control = 0, protect = 0, escort = 0, extract = 0 }
        for _, obj in ipairs(scn.objectives) do
            counts[obj.type] = (counts[obj.type] or 0) + 1
        end

        -- Verify we have all expected objective types
        assert.equals(3, counts.control)  -- Basin + 2 passes
        assert.equals(2, counts.protect)  -- North + south habitats
        assert.equals(2, counts.escort)   -- North + south convoys
        assert.equals(2, counts.extract)  -- North + south evacuations
    end)

    it("should define protect objectives with runtime population markers", function()
        local scn = VFS.Include('scenarios/meridian_basin.lua')

        -- Find a protect objective
        local protectObj = nil
        for _, obj in ipairs(scn.objectives) do
            if obj.type == 'protect' then
                protectObj = obj
                break
            end
        end

        assert.is_not_nil(protectObj)
        assert.is_table(protectObj._populateTargetsFrom)
        assert.is_number(protectObj._populateTargetsFrom.x)
        assert.is_number(protectObj._populateTargetsFrom.z)
        assert.is_number(protectObj._populateTargetsFrom.r)
        assert.equals('ambient', protectObj._populateTargetsFrom.role)
    end)

    it("should define extract objectives with runtime population markers", function()
        local scn = VFS.Include('scenarios/meridian_basin.lua')

        -- Find an extract objective
        local extractObj = nil
        for _, obj in ipairs(scn.objectives) do
            if obj.type == 'extract' then
                extractObj = obj
                break
            end
        end

        assert.is_not_nil(extractObj)
        assert.is_table(extractObj._populatePayloadFrom)
        assert.is_number(extractObj._populatePayloadFrom.x)
        assert.is_number(extractObj._populatePayloadFrom.z)
        assert.is_number(extractObj._populatePayloadFrom.r)
        assert.equals('ambient', extractObj._populatePayloadFrom.role)

        -- Verify extract params
        assert.is_table(extractObj.params)
        assert.is_table(extractObj.params.pickupArea)
        assert.is_table(extractObj.params.extractArea)
        assert.is_number(extractObj.params.holdFrames)
        assert.is_number(extractObj.params.threshold)
        assert.is_number(extractObj.params.quorum)
    end)

    it("should spawn civilian units in habitats", function()
        local scn = VFS.Include('scenarios/meridian_basin.lua')

        assert.is_table(scn.civilians)
        assert.is_table(scn.civilians.units)
        assert.equals(2, #scn.civilians.units)  -- North + south habitats

        -- Verify positions are offset from the habitat centre (clear of the
        -- building's blocked footprint — see meridian_basin.lua's comment).
        assert.equals(2920, scn.civilians.units[1].x)
        assert.equals('ambient', scn.civilians.units[1].role)
    end)

    it("should define starting military forces at garrisons", function()
        local scn = VFS.Include('scenarios/meridian_basin.lua')

        assert.is_table(scn.units)

        -- Count units per team
        local team0Units = 0
        local team4Units = 0
        for _, u in ipairs(scn.units) do
            if u.team == 0 then team0Units = team0Units + (u.count or 1) end
            if u.team == 4 then team4Units = team4Units + (u.count or 1) end
        end

        -- Should have balanced starting forces
        assert.equals(team0Units, team4Units)
        assert.is_true(team0Units > 0)
    end)

    it("should have strategic and tactical objectives with appropriate rewards", function()
        local scn = VFS.Include('scenarios/meridian_basin.lua')

        local strategicTotal = 0
        local tacticalTotal = 0

        for _, obj in ipairs(scn.objectives) do
            if obj.scope == 'strategic' then
                strategicTotal = strategicTotal + obj.reward
            elseif obj.scope == 'tactical' then
                tacticalTotal = tacticalTotal + obj.reward
            end
        end

        -- Strategic should be significant
        assert.equals(300, strategicTotal)  -- The basin control

        -- Tactical should be diverse and rewarding
        assert.is_true(tacticalTotal > 500)  -- Multiple tactical objectives
    end)

    it("should set appropriate expiry times for time-sensitive objectives", function()
        local scn = VFS.Include('scenarios/meridian_basin.lua')

        for _, obj in ipairs(scn.objectives) do
            if obj.type == 'protect' then
                -- Protect objectives must have expiry
                assert.is_not_nil(obj.expiresAtFrame)
                assert.equals(9000, obj.expiresAtFrame)  -- 5 minutes
            elseif obj.type == 'extract' then
                -- Extract objectives should have reasonable time limit
                assert.is_not_nil(obj.expiresAtFrame)
                assert.equals(27000, obj.expiresAtFrame)  -- 15 minutes
            elseif obj.type == 'control' and obj.scope == 'strategic' then
                -- Strategic control is open-ended
                assert.is_nil(obj.expiresAtFrame)
            end
        end
    end)
end)

-- ============================================================
-- Transports (PLAN-metalstorm-transports.md §3.2, §7.1). This file is the
-- CONTRASTING case to crossing_standoff_scenario_spec.lua: two factions
-- fighting over the neutral band in front of their OWN towns are home, not
-- expeditionary, and §7.1 says stranding is an expeditionary property only.
-- ============================================================
describe("Meridian Basin — transports", function()
    local scn

    before_each(function()
        scn = dofile('scenarios/meridian_basin.lua')
    end)

    it("stages a parked carrier for each of the two armies", function()
        local carriers = {}
        for _, u in ipairs(scn.units) do
            if u.def == 'fable_airship' then carriers[u.team] = u end
        end
        assert.is_not_nil(carriers[0])
        assert.is_not_nil(carriers[4])
        assert.is_nil(carriers[0].orders)   -- §3.2: staged-as-arrived
        assert.is_nil(carriers[4].orders)
    end)

    it("flags NO side expeditionary — both own home ground on this map", function()
        -- The repair §7.1 makes to §3.7's guard. Flag a home defender and
        -- `war_side_stranded` fires on it from frame 60 for the whole war,
        -- which is a guard that cries wolf and therefore is not a guard.
        for _, side in ipairs(scn.sides) do
            assert.is_nil(side.expeditionary,
                'side ' .. side.faction .. ' holds regions here and is not expeditionary')
        end
    end)

    it("still gives the two staged armies an exit — withdrawal is not gated on it", function()
        -- §3.4 applies to everyone: extracting materiel by transport is how
        -- value leaves ANY battle, expeditionary or not.
        local carriers = {}
        for _, u in ipairs(scn.units) do
            if u.def == 'fable_airship' then carriers[u.team] = u end
        end
        local withExit = 0
        for _, side in ipairs(scn.sides) do
            local d = side.departure
            if d then
                withExit = withExit + 1
                local c = carriers[side.team]
                assert.is_not_nil(c, 'team ' .. side.team .. ' has an exit but no carrier')
                local dx, dz = c.x - d.x, c.z - d.z
                assert.is_true(math.sqrt(dx * dx + dz * dz) > d.radius,
                    'the parked carrier of team ' .. side.team .. ' sits in its own exit')
            end
        end
        assert.are.equal(2, withExit)
    end)
end)
