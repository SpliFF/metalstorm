-- tests/game_objectives_publication_spec.lua — what `publish()` actually puts
-- on the wire (battle-clarity U2).
--
-- Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
--
-- WHY THIS FILE EXISTS. Every other objectives spec drives the pure type
-- modules through a fake `ctx` (objectives/tests/*), which is the right shape
-- for testing what an objective DOES. None of them touch `publish()`, so
-- nothing asserted what a client can actually READ — and U2 needs exactly that,
-- because the world/minimap markers are drawn from published params and from
-- nothing else.
--
-- It was written after a live run caught the defect it now pins. U2's first
-- cut wrote the ctx accessor as
--
--     regionArea = function(key)
--         return GG.Regions and GG.Regions.Area and GG.Regions.Area(key) or nil
--     end
--
-- which reads correct, leaves the in-memory objective table correct, and
-- publishes `objective_<id>_x` with no `_z` and no `_r` — because an `and`/`or`
-- chain adjusts its operand to ONE value. Measured on the wire in a live
-- `crossing_standoff`; invisible from every other vantage point. A guard that
-- truncates a multi-return is a whole family of bug, so the assertions below
-- are on the published KEYS, never on `o.params`.

package.path = './?.lua;' .. package.path

local function noop() end
local function emptyList() return {} end

--- A minimal synced world with `game_objectives.lua` loaded, plus whatever GG
--- surface the case needs. Same shape as game_snapshot_spec's `bareWorld`,
--- duplicated rather than shared for the reason that file states: these mocks
--- stay narrowly scoped, they do not grow into a framework.
local function newWorld(gg)
    local world = { frame = 0, gameRulesParams = {}, teamRulesParams = {},
                    echoes = {}, unitPos = {} }

    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
        SetTeamRulesParam = function(teamID, key, value)
            world.teamRulesParams[teamID] = world.teamRulesParams[teamID] or {}
            world.teamRulesParams[teamID][key] = value
        end,
        GetTeamRulesParam = function(teamID, key)
            local t = world.teamRulesParams[teamID]
            return t and t[key]
        end,
        GetGaiaTeamID = function() return 99 end,
        GetTeamList = emptyList,
        GetPlayerList = emptyList,
        GetAllUnits = emptyList,
        GetTeamUnits = emptyList,
        GetUnitsInCylinder = emptyList,
        GetTeamInfo = function(teamID) return teamID, -1, false end,
        GetPlayerInfo = function() return nil end,
        GetUnitPosition = function(id)
            local p = world.unitPos[id]
            if not p then return nil end
            return p[1], 0, p[2]
        end,
        GetUnitTransporter = function() return nil end,
        GetUnitTeam = function() return 0 end,
        GetUnitHealth = function(id) return world.unitPos[id] and 100 or nil end,
        GetUnitDefID = function() return nil end,
        GetUnitIsDead = function() return false end,
        ValidUnitID = function(id) return world.unitPos[id] ~= nil end,
        GetUnitRulesParam = function() return nil end,
        GetModOptions = function() return {} end,
        AreTeamsAllied = function() return false end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = msg end,
        Log = noop,
        MoveCtrl = { Enable = noop, Disable = noop, SetNoBlocking = noop },
    }
    _G.UnitDefs = {}
    _G.FeatureDefs = {}
    _G.Game = { mapSizeX = 8192, mapSizeZ = 8192 }
    _G.LOG = { ERROR = 'ERROR', WARNING = 'WARNING', NOTICE = 'NOTICE' }
    _G.VFS = {
        MAP = 'map',
        FileExists = function() return false end,
        Include = function(path)
            local rel = path:gsub('^LuaRules/', '')
            rel = rel:gsub('^Gadgets/', './')
            if not rel:match('^%./') then rel = '../' .. rel end
            return dofile(rel)
        end,
    }
    _G.gadgetHandler = { IsSyncedCode = function() return true end, RegisterCMDID = noop }
    _G.gadget = {}
    _G.GG = gg

    dofile('./game_objectives.lua')
    return world, _G.gadget
end

--- The neighbour-gadget surface `game_objectives.lua` reaches for.
--- `regionArea` is the whole point: it returns THREE values, the way
--- `GG.Regions.Area` does.
local function ggWith(areaFn)
    return {
        Regions = {
            Keys = function() return { 'raven_basin', 'ash_verge', 'wilds' } end,
            ControllingTeam = function() return nil end,
            KeyAt = function() return nil end,
            Area = areaFn,
        },
        Authority = {
            NormaliseReward = function(_, amount) return amount end,
            Award = noop,
            EscrowTotal = function() return 0 end,
            SettleEscrow = noop,
            Stake = function() return true end,
        },
    }
end

local RAVEN = function(key)
    if key ~= 'raven_basin' then return nil end
    return 4480, 4390, 912
end

describe("objectives publication — position and extent", function()
    it("publishes a control objective's region AND its circle", function()
        -- Before U2 a control objective published only `region`: a name with
        -- no place, which is why "Hold Raven Basin" could not be drawn on the
        -- map at all. The key is still needed — it is the only field that
        -- carries the region's NAME.
        local world = newWorld(ggWith(RAVEN))
        GG.Objectives.Create({ type = 'control', scope = 'strategic',
                               reward = 300,
                               params = { regionKey = 'raven_basin', holdFrames = 900 } })
        local p = world.gameRulesParams
        assert.are.equal('raven_basin', p.objective_1_region)
        assert.are.equal(4480, p.objective_1_x)
        assert.are.equal(4390, p.objective_1_z)
        assert.are.equal(912,  p.objective_1_r)
    end)

    it("publishes ALL THREE coordinates, not just the first", function()
        -- The regression this file was written for. Asserted separately from
        -- the case above and in these words, because the defect's whole
        -- signature was "x is right, z and r are absent" — and a spec that
        -- only checked `x` (or checked `o.params`) passes straight through it.
        local world = newWorld(ggWith(RAVEN))
        GG.Objectives.Create({ type = 'control', scope = 'strategic', reward = 300,
                               params = { regionKey = 'raven_basin', holdFrames = 900 } })
        for _, field in ipairs({ 'x', 'z', 'r' }) do
            assert.is_not_nil(world.gameRulesParams['objective_1_' .. field],
                'objective_1_' .. field .. ' missing from the published params')
        end
    end)

    it("still publishes the region when the partition cannot place it", function()
        -- "wilds" is synthetic and has no polygon; an older regions gadget has
        -- no Area at all. Either way the objective is real and its name still
        -- ships — the marker layer draws a nameless point rather than nothing.
        local world = newWorld(ggWith(function() return nil end))
        GG.Objectives.Create({ type = 'control', scope = 'strategic', reward = 50,
                               params = { regionKey = 'ash_verge', holdFrames = 300 } })
        local p = world.gameRulesParams
        assert.are.equal('ash_verge', p.objective_1_region)
        assert.is_nil(p.objective_1_x)
        assert.is_nil(p.objective_1_r)
    end)

    it("survives a regions gadget with no Area function", function()
        local gg = ggWith(nil)
        gg.Regions.Area = nil
        local world = newWorld(gg)
        GG.Objectives.Create({ type = 'control', scope = 'strategic', reward = 50,
                               params = { regionKey = 'raven_basin', holdFrames = 300 } })
        assert.are.equal('raven_basin', world.gameRulesParams.objective_1_region)
        assert.is_nil(world.gameRulesParams.objective_1_x)
    end)

    it("publishes a protect objective's covering circle over its targets", function()
        -- A protect objective's "area" is not authored anywhere — it is
        -- wherever the things being defended stand. Before U2 it published the
        -- FIRST target's position and no radius, so a town spread over 600
        -- elmos was a point somewhere inside it.
        local world = newWorld(ggWith(RAVEN))
        world.unitPos[11] = { 1000, 2000 }
        world.unitPos[12] = { 1400, 2000 }
        world.frame = 10
        GG.Objectives.Create({ type = 'protect', scope = 'tactical', forTeam = 0,
                               reward = 120, expiresAtFrame = 1000,
                               params = { targetUnitIDs = { 11, 12 } } })
        local p = world.gameRulesParams
        assert.are.equal(1200, p.objective_1_x)     -- centroid, not targets[1]
        assert.are.equal(2000, p.objective_1_z)
        assert.is_true(p.objective_1_r >= 200)      -- covers both, floored
        assert.is_nil(p.objective_1_region)         -- no region to name
    end)

    it("gives a single-target protect objective a visible radius, not zero", function()
        local world = newWorld(ggWith(RAVEN))
        world.unitPos[21] = { 5000, 5000 }
        GG.Objectives.Create({ type = 'protect', scope = 'tactical', forTeam = 0,
                               reward = 60, expiresAtFrame = 1000,
                               params = { targetUnitIDs = { 21 } } })
        assert.are.equal(5000, world.gameRulesParams.objective_1_x)
        assert.are.equal(200,  world.gameRulesParams.objective_1_r)
    end)

    it("publishes an authored extract circle unchanged", function()
        -- escort/extract already carried a real authored circle before U2;
        -- this pins that the region branch's change did not disturb them.
        local world = newWorld(ggWith(RAVEN))
        world.unitPos[31] = { 100, 100 }
        GG.Objectives.Create({ type = 'escort', scope = 'strategic', forTeam = 0,
                               reward = 120,
                               params = { payloadUnitIDs = { 31 },
                                          extractArea = { x = 400, z = 6900, r = 500 } } })
        local p = world.gameRulesParams
        assert.are.equal(400, p.objective_1_x)
        assert.are.equal(6900, p.objective_1_z)
        assert.are.equal(500, p.objective_1_r)
    end)
end)
