-- tests/game_snapshot_spec.lua — the per-gadget snapshot contract
-- (PLAN-persistence.md task 1d-b, §7.1d).
--
-- One `it` per gadget the coverage ledger named as a gap, and every one of them
-- asserts the SAME three things, because the same three things are what a
-- rollback needs and what an eyeballed Save/Load pair gets wrong:
--
--   1. ROUND-TRIP — Save, mutate the world, Load the saved table, Save again:
--      the two captures must be identical. This is the check that catches a
--      field written by Save and never read by Load (the shape that looks
--      covered and restores nothing).
--   2. THE MUTATION IS ACTUALLY UNDONE — asserted through the gadget's own
--      read API where it has one, not just through its Save output, so a
--      Load that populates a table nothing else reads cannot pass.
--   3. AN ABSENT FIELD IS A DEFAULT, NOT "KEEP WHAT THIS PROCESS HOLDS" —
--      Load({}) must clear, because a restore to before a thing happened has
--      to take it back. This is the one that turns a rollback into a merge.
--
-- Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
--
-- The gadgets reuse the existing narrow mocks (parley_mock, spring_mock,
-- train_mock, authority_charge_mock); the four with no mock of their own get
-- the minimal permissive surface below. Same deliberate exception as those
-- files: extend narrowly, do not grow a framework.

package.path = './?.lua;' .. package.path

-- ============================================================
-- Canonical encoding of a captured state table.
--
-- Deliberately mirrors the C++ codec's own rule (§7.1d decision 4): pairs are
-- written in a canonical order, because `pairs()` is hash order and two
-- captures of the SAME state would otherwise compare unequal for no reason.
-- Numbers are formatted with %.17g so a float round-trip that loses a bit is a
-- failure rather than a rounding that assert.are.same would forgive.
-- ============================================================
local function typeRank(v)
    local t = type(v)
    if t == 'boolean' then return 1 end
    if t == 'number' then return 2 end
    return 3
end

local function scalar(v)
    local t = type(v)
    if t == 'number' then return string.format('%.17g', v) end
    if t == 'string' then return string.format('%q', v) end
    return tostring(v)
end

local canon
canon = function(v, depth)
    depth = depth or 0
    assert(depth < 32, 'depth limit — the codec refuses past 32 too')
    if type(v) ~= 'table' then return scalar(v) end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b)
        local ra, rb = typeRank(a), typeRank(b)
        if ra ~= rb then return ra < rb end
        if type(a) == 'boolean' then return (a and 1 or 0) < (b and 1 or 0) end
        return a < b
    end)
    local parts = {}
    for _, k in ipairs(keys) do
        parts[#parts + 1] = scalar(k) .. '=' .. canon(v[k], depth + 1)
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

--- Model what the C++ side does with the table Save fills: encode it to bytes
--- immediately, then hand a freshly DECODED table to Load. In-process a gadget
--- hands over live references (deliberately — CaptureSyncedLua walks the table
--- and encodes it in the same call, so deep-copying on the hot path would be
--- pure waste), which means a spec that kept the reference would be mutating
--- the very payload it is about to restore.
local function wire(v)
    if type(v) ~= 'table' then return v end
    local out = {}
    for k, val in pairs(v) do out[k] = wire(val) end
    return out
end

--- The whole contract in one call. `build` puts state into the gadget, `mutate`
--- moves the world on, `readback` (optional) returns something observable that
--- must come back to what it was.
local function assertRoundTrip(gadgetObj, build, mutate, readback)
    build()
    local before = readback and canon(readback())

    local live = {}
    gadgetObj:Save(live)
    local captured = canon(live)
    local saved = wire(live)

    mutate()
    if readback then
        assert.are_not.equal(before, canon(readback()),
            'the mutation must actually change something, or this test proves nothing')
    end

    gadgetObj:Load(saved)
    local again = {}
    gadgetObj:Save(again)
    assert.are.equal(captured, canon(again))
    if readback then
        assert.are.equal(before, canon(readback()))
    end
end

-- ============================================================
-- A minimal permissive Spring surface for the four gadgets with no mock of
-- their own (regions, objectives, civilians, scenario). Every query answers
-- "nothing is there", which is exactly right here: these specs drive state in
-- through the gadgets' own APIs and out through Save, and never ask the gadget
-- to observe a world.
-- ============================================================
local function bareWorld(gadgetFile, extraGG)
    local world = { frame = 0, gameRulesParams = {}, teamRulesParams = {}, echoes = {} }

    local function noop() end
    local function emptyList() return {} end

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
        GetUnitPosition = function() return nil end,
        GetUnitTeam = function() return nil end,
        GetUnitHealth = function() return nil end,
        GetUnitDefID = function() return nil end,
        GetUnitIsDead = function() return false end,
        ValidUnitID = function() return false end,
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
    _G.gadgetHandler = {
        IsSyncedCode = function() return true end,
        RegisterCMDID = noop,
    }
    _G.gadget = {}
    _G.GG = extraGG or {}

    dofile('./' .. gadgetFile)
    return world, _G.gadget
end

-- ============================================================

describe("Region Control", function()
    local Ownership = dofile('./regions/ownership.lua')

    it("round-trips the hysteresis machine, the rev counter and the gate", function()
        local world, g = bareWorld('game_regions.lua')
        g:Initialize()

        assertRoundTrip(g, function()
            -- Mid-flip, mid-decay and contested all at once: the states that
            -- are invisible in the published params and only live in Lua.
            GG.Regions.SetControllingTeam('basin_a', 3)
            GG.Regions.SetControllingTeam('ridge_b', nil)
            world.frame = 600
            g:GameFrame(600)
        end, function()
            GG.Regions.SetControllingTeam('basin_a', 7)
            world.frame = 30000
            g:GameFrame(30000)
        end, function()
            return { owner = GG.Regions.ControllingTeam('basin_a') }
        end)
    end)

    it("clears to a fresh state machine when the payload carries nothing", function()
        local world, g = bareWorld('game_regions.lua')
        g:Initialize()
        GG.Regions.SetControllingTeam('basin_a', 3)
        assert.are.equal(3, GG.Regions.ControllingTeam('basin_a'))

        g:Load({})
        -- A restore to before the region was ever taken must TAKE IT BACK.
        assert.is_nil(GG.Regions.ControllingTeam('basin_a'))
    end)

    it("keeps the eval gate's phase rather than re-phasing onto the restored frame", function()
        local world, g = bareWorld('game_regions.lua')
        g:Initialize()
        world.frame = 450
        g:GameFrame(450)

        local saved = {}
        g:Save(saved)
        assert.are.equal(450, saved.evalGate.last)

        -- The live process runs on for another two hours...
        world.frame = 200000
        g:GameFrame(200000)
        -- ...and the restore puts the gate back where the payload says.
        g:Load(saved)
        local after = {}
        g:Save(after)
        assert.are.equal(450, after.evalGate.last)
    end)

    it("captures the state Ownership.step authored, not a recomputation of it", function()
        -- The point of capturing `ownershipState` rather than re-deriving it:
        -- leadTicks/emptyTicks are progress toward a flip or a decay, and the
        -- restored board cannot say how far along either one is.
        local state = Ownership.newState()
        Ownership.step(state, { basin_a = { [1] = 900, [2] = 100 } })
        Ownership.step(state, { basin_a = { [1] = 900, [2] = 100 } })
        assert.are.equal(2, state.basin_a.leadTicks[1])
        assert.is_nil(state.basin_a.owner)   -- FLIP_TICKS is 3 — not yet

        local world, g = bareWorld('game_regions.lua')
        g:Initialize()
        g:Load({ ownership = state, regionsRev = 5 })
        local saved = {}
        g:Save(saved)
        assert.are.equal(2, saved.ownership.basin_a.leadTicks[1])
    end)
end)

describe("Team Lifecycle", function()
    local mock = require('tests.spring_mock')

    it("round-trips tenure, leadership and the lifetime scoreboard", function()
        local world, g = mock.new()
        world.setPlayer(1, 10)
        world.setPlayer(2, 10)
        g:Initialize()          -- registers the OnAward/OnCharge hooks

        assertRoundTrip(g, function()
            world.frame = 300
            g:GameStart()
            world.fireAward(1, 10, 250)
            world.fireCharge(1, 10, 80)
            world.fireAward(2, 10, 40)
        end, function()
            world.frame = 90000
            world.fireAward(1, 10, 9999)
            world.fireCharge(2, 10, 5000)
        end, function()
            -- The scoreboard gate COLLAPSES a multi-period skip, so a second
            -- read at the same frame would return the previous publish. Step
            -- the clock so each read is its own publish.
            world.frame = world.frame + 900
            g:GameFrame(world.frame)
            return {
                earned = world.rp('score_1_earned'),
                spent = world.rp('score_1_spent'),
            }
        end)
    end)

    it("rolls the scoreboard BACK, unlike RestoreScore's rejoin MAX", function()
        -- The distinction the census turns on: RestoreScore exists so a live
        -- process ahead of the saved numbers is not walked backwards on a
        -- reconnect. A snapshot restore is the opposite case — the saved
        -- numbers ARE the world, and a rollback that kept the higher live
        -- figure would credit a player for fighting that has been undone.
        local world, g = mock.new()
        world.setPlayer(1, 10)
        g:Initialize()
        g:GameStart()
        world.fireAward(1, 10, 100)

        local live = {}
        g:Save(live)
        local saved = wire(live)

        world.fireAward(1, 10, 900)
        world.frame = 900
        g:GameFrame(900)
        assert.are.equal(1000, world.rp('score_1_earned'))

        g:Load(saved)
        world.frame = 1800
        g:GameFrame(1800)
        assert.are.equal(100, world.rp('score_1_earned'))
    end)
end)

describe("AI Guidance", function()
    local mock = require('tests.parley_mock')
    local Wire = require('parley.wire')

    it("round-trips the guidance store, its timed fuses and the change cursor", function()
        local world, g = mock.new('./game_ai_guidance.lua')
        world.setPlayer(1, 10)

        assertRoundTrip(g, function()
            world.frame = 1000
            g:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'aggressive' }), 1)
            g:RecvLuaMsg(Wire.encode('guidance.paint', { regionKey = 'basin_a', value = 'forbidden' }), 1)
            g:RecvLuaMsg(Wire.encode('guidance.lock', { groupId = 5, locked = '1' }), 1)
            g:RecvLuaMsg(Wire.encode('guidance.fund', { rateCap = 200 }), 1)
            g:RecvLuaMsg(Wire.encode('guidance.veto', { goalId = 77 }), 1)
        end, function()
            world.frame = 2000
            g:RecvLuaMsg(Wire.encode('guidance.stance', { value = 'defensive' }), 1)
            g:RecvLuaMsg(Wire.encode('guidance.veto', { goalId = 88 }), 1)
        end, function()
            local s = GG.AIGuidance.Get(10)
            return { stance = s.stance, veto = s.veto, funding = s.funding }
        end)
    end)

    it("keeps a veto's absolute expiry frame, so a restore does not unblock it", function()
        local world, g = mock.new('./game_ai_guidance.lua')
        world.setPlayer(1, 10)
        world.frame = 1000
        g:RecvLuaMsg(Wire.encode('guidance.veto', { goalId = 77 }), 1)

        local live = {}
        g:Save(live)
        local saved = wire(live)
        -- 1000 + VETO_TTL_FRAMES (9000).
        assert.are.equal(10000, saved.stores[10].veto[77])

        -- The live process sweeps it away when the fuse burns out...
        world.frame = 11000
        g:GameFrame(11000)
        assert.is_nil(GG.AIGuidance.Get(10).veto[77])

        -- ...and the restore brings back both the veto AND its deadline.
        g:Load(saved)
        assert.are.equal(10000, GG.AIGuidance.Get(10).veto[77])
    end)

    it("restores the allowance gate, which is an ACCRUAL gate and pays out", function()
        -- The case tick.lua's snapshot note calls out: Tick.count banks every
        -- whole period between `last` and the frame, so a gate left where the
        -- live process had it mints an unauthorised lump on the first frame
        -- after a restore.
        local world, g = mock.new('./game_ai_guidance.lua')
        world.setPlayer(1, 10)
        world.setAIPlayer(2, 10)
        world.setTeamPool(10, 1000000)
        g:RecvLuaMsg(Wire.encode('guidance.fund', { rateCap = 100 }), 1)

        world.frame = 1800
        g:GameFrame(1800)
        local live = {}
        g:Save(live)
        local saved = wire(live)
        assert.are.equal(1800, saved.allowanceGate.last)

        world.frame = 180000
        g:GameFrame(180000)
        local drained = #world.transferLog

        g:Load(saved)
        world.frame = 3600
        g:GameFrame(3600)
        -- ONE period since the restored `last`, not a hundred.
        assert.are.equal(drained + 1, #world.transferLog)
    end)
end)

describe("Authority Economy", function()
    local mock = require('tests.authority_charge_mock')

    local function newWorld()
        local world, g = mock.new()
        world.setPlayer(1, 0)
        -- The mock has no Echo (its own specs never hit a path that warns);
        -- Award's unmapped-reason warn does. Added here, not in the mock, so
        -- the mock stays narrowly scoped to what its own specs need.
        _G.Spring.Echo = function() end
        return world, g
    end

    it("round-trips the ledger, metrics, escrow and all three gates", function()
        local world, g = newWorld()

        assertRoundTrip(g, function()
            GG.Authority.Award({ team = 0 }, 300, 'objective_reward')
            GG.Authority.Award({ player = 1 }, 120, 'join_grant')
            assert.is_true(GG.Authority.Stake(1, 42, 50))
        end, function()
            GG.Authority.Award({ team = 0 }, 7777, 'stipend')
        end, function()
            return { ledger = GG.Authority.ExportLedger() }
        end)
    end)

    it("takes back an escrowed stake a rollback undoes", function()
        local world, g = newWorld()
        local live = {}
        g:Save(live)                          -- before anything is staked
        local saved = wire(live)

        GG.Authority.Award({ player = 1 }, 500, 'join_grant')
        assert.is_true(GG.Authority.Stake(1, 42, 200))
        assert.are.equal(200, GG.Authority.EscrowTotal(42))

        g:Load(saved)
        -- The stake is money that left a pool; the pools ride the `teams`
        -- section, so an escrow left behind would refund into a world that
        -- never paid it.
        assert.are.equal(0, GG.Authority.EscrowTotal(42))
    end)

    it("restores the stipend gate, which banks every elapsed period", function()
        -- The accrual hazard, on the gate where it costs the most: leave
        -- `last` where the live process had it and the first frame after a
        -- restore mints one lump per minute between the two worlds' frames.
        local world, g = newWorld()
        world.modOptions.authority_team_stipend = 10
        g:Initialize()

        g:GameFrame(1800)
        local live = {}
        g:Save(live)
        local saved = wire(live)
        assert.are.equal(1800, saved.stipendGate.last)

        g:GameFrame(180000)
        g:Load(saved)
        local after = {}
        g:Save(after)
        assert.are.equal(1800, after.stipendGate.last)
    end)
end)

describe("Objectives", function()
    -- A control objective validates its regionKey against GG.Regions, so this
    -- is the one bare world that needs a neighbour gadget's surface.
    local REGIONS = { basin_a = true, ridge_b = true, wilds = true,
                      r1 = true, r2 = true, r3 = true, r4 = true }
    local function objWorld()
        return bareWorld('game_objectives.lua', {
            Regions = {
                Keys = function()
                    local out = {}
                    for k in pairs(REGIONS) do out[#out + 1] = k end
                    table.sort(out)
                    return out
                end,
                ControllingTeam = function() return nil end,
                KeyAt = function() return nil end,
            },
            Authority = {
                NormaliseReward = function(_, amount) return amount end,
                Award = function() end,
                EscrowTotal = function() return 0 end,
                SettleEscrow = function() end,
                Stake = function() return true end,
            },
        })
    end

    it("round-trips the live board, the archive ring and the generator memory", function()
        local world, g = objWorld()

        assertRoundTrip(g, function()
            world.frame = 100
            GG.Objectives.Create({ type = 'control', scope = 'strategic',
                                   forTeam = 0, reward = 100,
                                   params = { regionKey = 'basin_a', holdFrames = 900 } })
            GG.Objectives.Create({ type = 'control', scope = 'tactical',
                                   forTeam = 1, reward = 50,
                                   params = { regionKey = 'ridge_b', holdFrames = 300 } })
        end, function()
            world.frame = 5000
            GG.Objectives.Create({ type = 'control', scope = 'tactical',
                                   forTeam = 0, reward = 10,
                                   params = { regionKey = 'wilds', holdFrames = 300 } })
        end, function()
            return { one = GG.Objectives.Get(1), two = GG.Objectives.Get(2),
                     three = GG.Objectives.Get(3) }
        end)
    end)

    it("restores nextId, so the next Create cannot re-issue a live id", function()
        local world, g = objWorld()
        world.frame = 100
        local first = GG.Objectives.Create({ type = 'control', scope = 'tactical',
                                            forTeam = 0, reward = 10,
                                            params = { regionKey = 'basin_a', holdFrames = 300 } })
        local saved = {}
        g:Save(saved)
        assert.is_true(saved.nextId > first)

        g:Load(saved)
        local next_ = GG.Objectives.Create({ type = 'control', scope = 'tactical',
                                            forTeam = 0, reward = 10,
                                            params = { regionKey = 'ridge_b', holdFrames = 300 } })
        assert.are_not.equal(first, next_)
    end)

    it("keeps activeList and activeIndex agreeing after a restore", function()
        -- They are captured as a PAIR on purpose: an index rebuilt from the
        -- list (or the other way round) is a second source of truth, and
        -- removeFromActive's swap-with-last only works while they agree.
        local world, g = objWorld()
        world.frame = 100
        for i = 1, 4 do
            GG.Objectives.Create({ type = 'control', scope = 'tactical',
                                   forTeam = 0, reward = 10,
                                   params = { regionKey = 'r' .. i, holdFrames = 300 } })
        end
        local saved = {}
        g:Save(saved)
        g:Load(saved)
        local after = {}
        g:Save(after)

        for idx, id in ipairs(after.activeList) do
            assert.are.equal(idx, after.activeIndex[id])
        end
    end)
end)

describe("Parley", function()
    local mock = require('tests.parley_mock')

    it("round-trips the registry, the E6 caps and the trust decay cursors", function()
        local world, g = mock.new('./game_parley.lua')
        world.setPlayer(1, 10)
        world.setPlayer(2, 20)
        world.setTeamPool(10, 5000)
        world.setTeamPool(20, 5000)

        assertRoundTrip(g, function()
            world.frame = 100
            GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
            GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 900 })
        end, function()
            world.frame = 40000
            GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 600 })
        end)
    end)

    it("restores liveOutgoingCount, so the E6 cap survives a rollback", function()
        local world, g = mock.new('./game_parley.lua')
        world.setPlayer(1, 10)
        world.setPlayer(2, 20)
        world.setTeamPool(10, 5000)
        world.setTeamPool(20, 5000)
        world.frame = 100
        for _ = 1, 4 do
            GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        end
        local live = {}
        g:Save(live)
        local saved = wire(live)
        assert.are.equal(4, saved.liveOutgoingCount[10])

        -- A restore that dropped the counter would hand team 10 its four
        -- outgoing slots back on top of four live proposals.
        g:Load(saved)
        local after = {}
        g:Save(after)
        assert.are.equal(4, after.liveOutgoingCount[10])
    end)

    it("drops the projectile fire-frame map, which names objects that are gone", function()
        -- In-flight projectiles are §7's named deliberate loss. Keeping the
        -- map would leak one entry per in-flight round per restore, forever:
        -- ProjectileDestroyed can never fire for a projectile that no longer
        -- exists.
        local world, g = mock.new('./game_parley.lua')
        g:ProjectileCreated(4001)
        g:ProjectileCreated(4002)

        local saved = {}
        g:Save(saved)
        assert.is_nil(saved.fireFrameOf)

        g:Load(saved)
        -- Nothing to observe directly (it is a file-local), so assert the
        -- absence from the payload plus that Load runs clean over it.
        g:ProjectileDestroyed(4001)
    end)
end)

describe("Civilians", function()
    it("round-trips the population registry and the venue order", function()
        local world, g = bareWorld('game_civilians.lua')

        assertRoundTrip(g, function()
            GG.Civilians.Register(500, 'ambient')
            GG.Civilians.Register(501, 'convoy')
            GG.Civilians.Register(502, 'payload')
        end, function()
            GG.Civilians.Register(503, 'ambient')
            g:UnitDestroyed(500)
        end, function()
            return {
                r500 = GG.Civilians.GetRole(500),
                r503 = GG.Civilians.GetRole(503),
            }
        end)
    end)

    it("replaces the population rather than merging with the roster rebuild", function()
        -- ApplyUnits fires UnitCreated for every restored unit BEFORE this
        -- Load, so entries are already in `population` by the time it runs. A
        -- merge would keep whichever of the two wrote last.
        local world, g = bareWorld('game_civilians.lua')
        GG.Civilians.Register(500, 'ambient')
        local live = {}
        g:Save(live)
        local saved = wire(live)

        GG.Civilians.Register(900, 'convoy')
        assert.is_true(GG.Civilians.IsCivilian(900))

        g:Load(saved)
        assert.is_false(GG.Civilians.IsCivilian(900))
        assert.is_true(GG.Civilians.IsCivilian(500))
    end)
end)

describe("Scenario Loader", function()
    it("round-trips the stipend cursors and the one-shot audit latch", function()
        local world, g = bareWorld('game_scenario.lua')

        assertRoundTrip(g, function()
            g:Load({
                aiStipends = { { team = 2, amount = 40, periodFrames = 1800, nextFrame = 3600 } },
                unstagedChecked = true,
                pendingConvoyObjectives = { ['route_north'] = { { type = 'escort' } } },
            })
        end, function()
            g:Load({})
        end)
    end)

    it("keeps the frame-60 audit latch set, so a restore does not re-warn", function()
        local world, g = bareWorld('game_scenario.lua')
        g:Load({ unstagedChecked = true })
        world.frame = 20000
        g:GameFrame(20000)
        -- The audit asks whether a side was ever STAGED. Re-running it against
        -- a mid-war board would warn about a side that has simply lost.
        assert.are.equal(0, #world.echoes)

        g:Load({})
        g:GameFrame(20001)
        -- With the latch clear it runs — which is what makes the latch load-bearing.
        assert.is_not_nil(world.gameRulesParams['war_teams_unstaged'])
    end)
end)

describe("Trains", function()
    local mock = require('tests.train_mock')

    local function coupled()
        local world, g = mock.new()
        g:Initialize()
        local engineHalf = mock.HalfLength(mock.ENGINE_DEF_ID)
        local gunHalf = mock.HalfLength(mock.GUN_DEF_ID)
        world.setUnit(1, { defID = mock.ENGINE_DEF_ID, x = 0, z = 0 })
        world.setUnit(2, { defID = mock.GUN_DEF_ID, x = 0, z = -(engineHalf + gunHalf) })
        g:UnitCreated(1, mock.ENGINE_DEF_ID)
        g:UnitCreated(2, mock.GUN_DEF_ID)
        assert.is_true(GG.Train.Couple(1, 2))
        return world, g
    end

    it("round-trips consists including the leader's breadcrumb ring", function()
        local world, g = coupled()

        assertRoundTrip(g, function()
            for f = 1, 60 do
                world.frame = f
                world.moveUnit(1, 0, 0, f * 3)
                g:GameFrame(f)
            end
        end, function()
            for f = 61, 200 do
                world.frame = f
                world.moveUnit(1, 0, 0, f * 3)
                g:GameFrame(f)
            end
        end)
    end)

    it("brings the breadcrumb trail back, not an empty ring", function()
        -- The ring is the LEADER'S PAST PATH and every follower's position is
        -- computed from it. It is history, not geometry: an empty ring snaps
        -- every car onto the engine until it refills.
        local world, g = coupled()
        for f = 1, 60 do
            world.frame = f
            world.moveUnit(1, 0, 0, f * 3)
            g:GameFrame(f)
        end

        local live = {}
        g:Save(live)
        local saved = wire(live)
        local consist = select(2, next(saved.consists))
        assert.is_true(consist.breadcrumbs.writeIdx > 1)
        assert.is_true(consist.breadcrumbs.totalArcLength > 0)

        g:Load(saved)
        local after = {}
        g:Save(after)
        local restored = select(2, next(after.consists))
        assert.are.equal(consist.breadcrumbs.writeIdx, restored.breadcrumbs.writeIdx)
        assert.are.equal(consist.breadcrumbs.totalArcLength, restored.breadcrumbs.totalArcLength)
    end)

    it("restores nextConsistID so a new consist cannot collide with a live one", function()
        local world, g = coupled()
        local live = {}
        g:Save(live)
        local saved = wire(live)
        assert.is_true(saved.nextConsistID > 1)

        g:Load(saved)
        local after = {}
        g:Save(after)
        assert.are.equal(saved.nextConsistID, after.nextConsistID)
    end)
end)
