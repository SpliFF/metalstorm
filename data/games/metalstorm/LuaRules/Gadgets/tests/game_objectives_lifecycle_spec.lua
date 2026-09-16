-- tests/game_objectives_lifecycle_spec.lua — the registry's own resolution
-- wiring: the expiry/completion race, escrow disposition, cascades, the bounty
-- cap, and reward normalisation (2026-09-10 review, F6–F12 + the dead-code
-- finding).
--
-- Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
--
-- WHY THIS FILE EXISTS. objectives/tests/* drives the pure type modules through
-- a fake ctx, which tests what an objective DOES; game_objectives_publication_
-- spec.lua tests what publish() puts on the wire. Neither watches the GADGET
-- decide an objective's ending — which tick wins when completion and expiry
-- land together, who gets paid when there is no payee, what a cascade does to
-- the objectives hanging off the one that just resolved. All six defects here
-- lived in that gap, and every one of them is silent in play: the objective
-- resolves, the board updates, and only the ledger (or a cap that stopped
-- letting anyone stake) says anything was wrong.
--
-- The authority mock therefore keeps a real escrow LEDGER rather than stubbing
-- SettleEscrow to a no-op. F7 is a defect you cannot see without one: the call
-- sequence looks perfectly ordinary, and the only evidence is authority that
-- was staked and then belongs to nobody.

package.path = './?.lua;' .. package.path

local function noop() end
local function emptyList() return {} end

local ESCROW_WAR_END = 'war_end'

--- A synced world with `game_objectives.lua` loaded. `world.units[id] =
--- {x, z, team}` is the whole unit database; dropping an entry kills that unit.
local function newWorld(opts)
    opts = opts or {}
    local world = {
        frame = 0,
        gameRulesParams = {}, teamRulesParams = {},
        echoes = {}, units = {},
        awards = {},        -- { target, amount, reason }
        settles = {},       -- { id, outcome }
        escrow = {},        -- objective id -> { staker, amount }
        regionOwner = nil,
        modOptions = opts.modOptions or {},
        velocity = 1.0,
    }

    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        SetGameRulesParam = function(k, v) world.gameRulesParams[k] = v end,
        GetGameRulesParam = function(k) return world.gameRulesParams[k] end,
        SetTeamRulesParam = function(t, k, v)
            world.teamRulesParams[t] = world.teamRulesParams[t] or {}
            world.teamRulesParams[t][k] = v
        end,
        GetTeamRulesParam = function(t, k)
            local tbl = world.teamRulesParams[t]; return tbl and tbl[k]
        end,
        GetGaiaTeamID = function() return 99 end,
        GetTeamList = function() return world.teamList or {} end,
        GetPlayerList = emptyList,
        GetAllUnits = function()
            local out = {}
            for id in pairs(world.units) do out[#out + 1] = id end
            table.sort(out)
            return out
        end,
        GetTeamUnits = emptyList,
        GetUnitsInCylinder = function(x, z, r)
            local out = {}
            for id, u in pairs(world.units) do
                local dx, dz = u.x - x, u.z - z
                if dx * dx + dz * dz <= r * r then out[#out + 1] = id end
            end
            table.sort(out)
            return out
        end,
        GetTeamInfo = function(t) return t, -1, false end,
        -- One player per team, id == team, always "connected".
        GetPlayerInfo = function(playerID) return 'p' .. playerID, false, false, playerID end,
        GetUnitPosition = function(id)
            local u = world.units[id]; if not u then return nil end
            return u.x, 0, u.z
        end,
        GetUnitTransporter = function() return nil end,
        GetUnitTeam = function(id) local u = world.units[id]; return u and u.team end,
        GetUnitHealth = function(id) return world.units[id] and 100 or nil end,
        GetUnitDefID = function() return nil end,
        GetUnitIsDead = function(id) return world.units[id] == nil end,
        ValidUnitID = function(id) return world.units[id] ~= nil end,
        GetUnitRulesParam = function() return nil end,
        GetGroundHeight = function() return 0 end,
        GiveOrderToUnit = noop,
        GetModOptions = function() return world.modOptions end,
        AreTeamsAllied = function() return false end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = msg end,
        Log = noop,
        MoveCtrl = { Enable = noop, Disable = noop, SetNoBlocking = noop },
    }
    _G.UnitDefs, _G.FeatureDefs = {}, {}
    _G.CMD = { MOVE = 10 }
    _G.Game = { mapSizeX = 8192, mapSizeZ = 8192 }
    _G.LOG = { ERROR = 'ERROR', WARNING = 'WARNING', NOTICE = 'NOTICE' }
    _G.VFS = {
        MAP = 'map',
        FileExists = function() return false end,
        Include = function(path)
            local rel = path:gsub('^LuaRules/', ''):gsub('^Gadgets/', './')
            if not rel:match('^%./') then rel = '../' .. rel end
            return dofile(rel)
        end,
    }
    _G.gadgetHandler = { IsSyncedCode = function() return true end, RegisterCMDID = noop }
    _G.gadget = {}

    _G.GG = {
        Regions = {
            Keys = function() return { 'raven_basin', 'ash_verge' } end,
            ControllingTeam = function() return world.regionOwner end,
            -- Every unit in this world stands in `raven_basin` unless a case
            -- says otherwise — control's hold clock only runs while the owner
            -- has somebody actually IN the region.
            KeyAt = function() return world.regionKeyAt or 'raven_basin' end,
            Area = function() return 100, 200, 300 end,
            -- The systemic generator's world facade reaches for these each
            -- eval tick. Empty: every objective in this file is created by
            -- hand, so nothing the generator produces can perturb a count.
            GetContested = emptyList,
            Value = function() return 0 end,
            Neighbors = function(key) return (world.neighbors or {})[key] or {} end,
            Owner = function() return nil end,
        },
        Authority = {
            ESCROW_WAR_END = ESCROW_WAR_END,
            Award = function(target, amount, reason)
                world.awards[#world.awards + 1] =
                    { target = target, amount = amount, reason = reason }
            end,
            EscrowTotal = function(id)
                local e = world.escrow[id]; return e and e.amount or 0
            end,
            Stake = function(playerID, id, amount)
                world.escrow[id] = { staker = playerID, amount = amount }
                return true
            end,
            SettleEscrow = function(id, outcome)
                world.settles[#world.settles + 1] = { id = id, outcome = outcome }
                world.escrow[id] = nil
            end,
            NormaliseReward = function(_, amount)
                return amount * (world.normaliseScale or 1)
            end,
        },
    }

    dofile('./game_objectives.lua')
    local g = _G.gadget
    g:Initialize()
    if not opts.skipGameStart then g:GameStart() end

    --- Advance to `frame` and run one eval tick there. EVAL_PERIOD is 90.
    function world.evalAt(frame)
        world.frame = frame
        g:GameFrame(frame)
    end

    --- The outcome `SettleEscrow` was last handed for `id`, or nil.
    function world.settleFor(id)
        for i = #world.settles, 1, -1 do
            if world.settles[i].id == id then return world.settles[i].outcome end
        end
        return nil
    end

    function world.totalAwarded()
        local n = 0
        for _, a in ipairs(world.awards) do n = n + a.amount end
        return n
    end

    return world, g
end

-- ============================================================
-- F6 — completion beats expiry on the same tick
-- ============================================================
describe("expiry vs completion on the same tick (F6)", function()
    --- A control objective that will have held `raven_basin` long enough by
    --- the time its deadline arrives. holdFrames is under one eval period, so
    --- the tick that crosses `expiresAtFrame` is also the tick on which the
    --- hold clock first satisfies the predicate — the race, exactly.
    local function heldControl(world, expiresAtFrame)
        world.regionOwner = 2
        world.units[1] = { x = 100, z = 200, team = 2 }   -- garrison, in-region
        return GG.Objectives.Create({
            type = 'control', scope = 'tactical', forTeam = 2, reward = 100,
            expiresAtFrame = expiresAtFrame,
            params = { regionKey = 'raven_basin', holdFrames = 90 },
        })
    end

    it("completes an objective whose criteria are met on its deadline tick", function()
        local world = newWorld()
        local id = heldControl(world, 180)
        world.evalAt(90)     -- accrues the hold clock, not yet due to expire
        world.evalAt(180)    -- deadline AND hold satisfied
        local o = GG.Objectives.Get(id)
        assert.are.equal('complete', o.state)
        assert.are.equal(2, o.completedBy)
    end)

    it("pays the reward rather than refunding it", function()
        local world = newWorld()
        heldControl(world, 180)
        world.evalAt(90)
        world.evalAt(180)
        assert.are.equal(100, world.totalAwarded())
    end)

    it("still expires an objective whose criteria are NOT met", function()
        local world = newWorld()
        world.regionOwner = nil    -- nobody holds it, the clock never runs
        world.units[1] = { x = 100, z = 200, team = 2 }
        local id = GG.Objectives.Create({
            type = 'control', scope = 'tactical', forTeam = 2, reward = 100,
            expiresAtFrame = 180,
            params = { regionKey = 'raven_basin', holdFrames = 90 },
        })
        world.evalAt(90)
        world.evalAt(180)
        assert.are.equal('expired', GG.Objectives.Get(id).state)
        assert.are.equal(0, world.totalAwarded())
    end)

    it("honours a type's expiry-as-success disposition when check is silent", function()
        -- protect answers nil from check() while its wards live and 'complete'
        -- from onExpire — so asking check() first must not swallow that.
        local world = newWorld()
        world.units[7] = { x = 0, z = 0, team = 2 }
        local id = GG.Objectives.Create({
            type = 'protect', scope = 'tactical', forTeam = 2, reward = 50,
            expiresAtFrame = 90,
            params = { targetUnitIDs = { 7 } },
        })
        world.evalAt(90)
        assert.are.equal('complete', GG.Objectives.Get(id).state)
    end)
end)

-- ============================================================
-- F7 — completion with nobody to pay must not destroy the stakes
-- ============================================================
describe("completion with no payee (F7)", function()
    --- An escort whose check() answers `'complete', o.forTeam` — with no
    --- forTeam authored, that second return is nil and there is nobody to pay.
    --- The payload starts inside destArea, so it completes on the first tick.
    local function unownedEscort(world)
        world.units[11] = { x = 500, z = 500, team = 3 }
        return GG.Objectives.Create({
            type = 'escort', scope = 'tactical', reward = 80,
            params = {
                payloadUnitIDs = { 11 },
                destArea = { x = 500, z = 500, r = 100 },
            },
        })
    end

    it("refunds the escrow instead of clearing it as a completion", function()
        local world = newWorld()
        local id = unownedEscort(world)
        GG.Authority.Stake(5, id, 120)
        world.evalAt(90)

        assert.are.equal('complete', GG.Objectives.Get(id).state)
        -- The defect settled 'complete' with no Award behind it: the ledger
        -- cleared and 120 authority stopped existing.
        assert.are.equal('expired', world.settleFor(id))
    end)

    it("awards nothing, and says so", function()
        local world = newWorld()
        local id = unownedEscort(world)
        GG.Authority.Stake(5, id, 120)
        world.evalAt(90)

        assert.are.equal(0, #world.awards)
        local told = false
        for _, msg in ipairs(world.echoes) do
            if msg:match('no team to pay') then told = true end
        end
        assert.is_true(told)
    end)

    it("still settles 'complete' when there IS a team to pay", function()
        local world = newWorld()
        world.units[11] = { x = 500, z = 500, team = 3 }
        local id = GG.Objectives.Create({
            type = 'escort', scope = 'tactical', forTeam = 3, reward = 80,
            params = {
                payloadUnitIDs = { 11 },
                destArea = { x = 500, z = 500, r = 100 },
            },
        })
        GG.Authority.Stake(5, id, 120)
        world.evalAt(90)
        assert.are.equal('complete', world.settleFor(id))
        assert.are.equal(200, world.totalAwarded())   -- reward 80 + escrow 120
    end)
end)

-- ============================================================
-- F8 — a mooted linked partner inherits the escrow outcome
-- ============================================================
describe("linked partner escrow outcome (F8)", function()
    local function linkedPair(world)
        world.units[21] = { x = 0, z = 0, team = 2 }
        return GG.Objectives.CreateLinkedPair({
            type = 'escort', scope = 'tactical', forTeam = 2, reward = 60,
            params = { payloadUnitIDs = { 21 }, destArea = { x = 900, z = 900, r = 100 } },
        }, {
            type = 'kill', scope = 'tactical', forTeam = 3, reward = 60,
            params = { targetUnitID = 21 },
        })
    end

    it("routes BOTH halves' stakes team-ward at war end", function()
        local world = newWorld()
        local idA = linkedPair(world)
        local idB = GG.Objectives.Get(idA).linkedId
        GG.Authority.Stake(5, idA, 40)
        GG.Authority.Stake(6, idB, 40)

        world.frame = 300
        GG.Objectives.ExpireAllActive()

        assert.are.equal(ESCROW_WAR_END, world.settleFor(idA))
        -- The sweep walks a snapshot, so the partner is already resolved by
        -- the time its own entry comes round: the ONLY chance to give it the
        -- war-end outcome is the mutual-resolve call that mooted it out.
        assert.are.equal(ESCROW_WAR_END, world.settleFor(idB))
    end)

    it("leaves the ordinary mutual resolve on the ordinary rule", function()
        -- No escrowOutcome override in play: a partner mooted out during
        -- normal play still settles as a plain 'expired' refund.
        local world = newWorld()
        local idA = linkedPair(world)
        local idB = GG.Objectives.Get(idA).linkedId
        GG.Objectives.Fail(idA)
        assert.are.equal('expired', world.settleFor(idB))
    end)
end)

-- ============================================================
-- F9 — a parent that ends leaves no live phase children
-- ============================================================
describe("phase children of a resolved parent (F9)", function()
    local function phasedParent(world, expiresAtFrame)
        world.units[31] = { x = 0, z = 0, team = 2 }
        return GG.Objectives.Create({
            type = 'control', scope = 'strategic', forTeam = 2, reward = 200,
            expiresAtFrame = expiresAtFrame,
            params = { regionKey = 'raven_basin', holdFrames = 100000 },
            phases = { {
                { type = 'protect', reward = 20, expiresAtFrame = 100000,
                  params = { targetUnitIDs = { 31 } } },
            } },
        })
    end

    it("expires the children when the parent times out", function()
        local world = newWorld()
        local parentId = phasedParent(world, 90)
        local childId = GG.Objectives.Get(parentId).phaseChildren[1]
        assert.are.equal('active', GG.Objectives.Get(childId).state)

        world.evalAt(90)

        assert.are.equal('expired', GG.Objectives.Get(parentId).state)
        assert.are.equal('expired', GG.Objectives.Get(childId).state)
    end)

    it("passes the parent's escrow outcome down to them", function()
        local world = newWorld()
        local parentId = phasedParent(world, 100000)
        local childId = GG.Objectives.Get(parentId).phaseChildren[1]
        GG.Authority.Stake(5, childId, 30)

        world.frame = 300
        GG.Objectives.ExpireAllActive()

        assert.are.equal(ESCROW_WAR_END, world.settleFor(parentId))
        assert.are.equal(ESCROW_WAR_END, world.settleFor(childId))
    end)

    it("does not touch children when the parent COMPLETES", function()
        -- Completion arrives through the children's own cascade, by which
        -- point they are all resolved — there is nothing to sweep, and
        -- sweeping would mean the cascade had double-resolved one.
        local world = newWorld()
        local parentId = phasedParent(world, 100000)
        local childId = GG.Objectives.Get(parentId).phaseChildren[1]

        world.units[31] = nil          -- the ward dies: child fails
        _G.gadget:UnitDestroyed(31, nil, 2, nil, nil, nil)
        world.evalAt(90)

        assert.are.equal('failed', GG.Objectives.Get(childId).state)
        assert.are.equal('failed', GG.Objectives.Get(parentId).state)
    end)
end)

-- ============================================================
-- F10 — the bounty cap counts LIVE bounties
-- ============================================================
describe("bounty cap (F10)", function()
    local function stakeBounty(world, playerID, targetID)
        world.units[targetID] = { x = 0, z = 0, team = 3 }
        return GG.Objectives.CreateBounty(playerID, {
            type = 'kill', scope = 'tactical',
            params = { targetUnitID = targetID },
        }, 25)
    end

    it("refuses a fifth bounty while four are live", function()
        local world = newWorld()
        for i = 1, 4 do
            assert.is_not_nil(stakeBounty(world, 5, 40 + i))
        end
        assert.is_nil(stakeBounty(world, 5, 45))
    end)

    it("frees the slot once a bounty resolves", function()
        local world = newWorld()
        local ids = {}
        for i = 1, 4 do ids[i] = stakeBounty(world, 5, 40 + i) end
        GG.Objectives.Fail(ids[1])
        -- Under the defect this stayed nil for the rest of the war: the count
        -- only ever went up.
        assert.is_not_nil(stakeBounty(world, 5, 45))
    end)

    it("is per player", function()
        local world = newWorld()
        for i = 1, 4 do stakeBounty(world, 5, 40 + i) end
        assert.is_nil(stakeBounty(world, 5, 45))
        assert.is_not_nil(stakeBounty(world, 6, 46))
    end)

    it("does not let a resolve free somebody else's slot", function()
        local world = newWorld()
        local mine = {}
        for i = 1, 4 do mine[i] = stakeBounty(world, 5, 40 + i) end
        local theirs = stakeBounty(world, 6, 50)
        GG.Objectives.Fail(theirs)
        assert.is_nil(stakeBounty(world, 5, 45))
    end)
end)

-- ============================================================
-- F11 — authority_reward_scale reaches scripted objectives
-- ============================================================
describe("authority_reward_scale (F11)", function()
    it("is read at Initialize, before any other gadget's GameStart", function()
        -- game_scenario (layer -90) stages its objectives from ITS GameStart,
        -- which runs before this gadget's (-50). Only Initialize is early
        -- enough to have the scale in hand by then.
        local world = newWorld({
            modOptions = { authority_reward_scale = 2 },
            skipGameStart = true,
        })
        world.units[61] = { x = 0, z = 0, team = 3 }
        local id = GG.Objectives.Create({
            type = 'kill', scope = 'tactical', forTeam = 2, reward = 100,
            params = { targetUnitID = 61 },
        })
        assert.are.equal(200, GG.Objectives.Get(id).reward)
    end)

    it("defaults to 1.0 with the modoption absent", function()
        local world = newWorld({ skipGameStart = true })
        world.units[61] = { x = 0, z = 0, team = 3 }
        local id = GG.Objectives.Create({
            type = 'kill', scope = 'tactical', forTeam = 2, reward = 100,
            params = { targetUnitID = 61 },
        })
        assert.are.equal(100, GG.Objectives.Get(id).reward)
    end)
end)

-- ============================================================
-- F12 — UnitDestroyed must not see the dying unit as alive
-- ============================================================
describe("the dying unit during UnitDestroyed (F12)", function()
    it("fails a protect objective on the death tick, not three seconds later", function()
        local world = newWorld()
        world.units[71] = { x = 0, z = 0, team = 2 }
        local id = GG.Objectives.Create({
            type = 'protect', scope = 'tactical', forTeam = 2, reward = 50,
            expiresAtFrame = 100000,
            params = { targetUnitIDs = { 71 } },
        })

        -- Spring still answers ValidUnitID for a unit inside its own
        -- UnitDestroyed, so the engine-truthful mock keeps it in the table.
        _G.gadget:UnitDestroyed(71, nil, 2, 3, nil, 3)

        assert.are.equal('failed', GG.Objectives.Get(id).state)
    end)

    it("leaves the other units in the roster alone", function()
        local world = newWorld()
        world.units[71] = { x = 0, z = 0, team = 2 }
        world.units[72] = { x = 0, z = 0, team = 2 }
        local id = GG.Objectives.Create({
            type = 'protect', scope = 'tactical', forTeam = 2, reward = 50,
            expiresAtFrame = 100000,
            params = { targetUnitIDs = { 71, 72 }, quorum = 1 },
        })
        _G.gadget:UnitDestroyed(71, nil, 2, 3, nil, 3)
        assert.are.equal('active', GG.Objectives.Get(id).state)
    end)
end)

-- ============================================================
-- Reward normalisation is wired (the dead-code finding)
-- ============================================================
describe("reward normalisation", function()
    local function systemicKill(world, reward)
        world.units[81] = { x = 0, z = 0, team = 3 }
        return GG.Objectives.Create({
            type = 'kill', scope = 'tactical', forTeam = 2, source = 'systemic',
            reward = reward, params = { targetUnitID = 81 },
        })
    end

    it("scales a systemic objective's reward through GG.Authority", function()
        local world = newWorld()
        world.normaliseScale = 0.5
        systemicKill(world, 100)
        _G.gadget:UnitDestroyed(81, nil, 3, 2, nil, 2)
        assert.are.equal(50, world.totalAwarded())
    end)

    it("leaves a scripted objective's reward alone", function()
        local world = newWorld()
        world.normaliseScale = 0.5
        world.units[81] = { x = 0, z = 0, team = 3 }
        GG.Objectives.Create({
            type = 'kill', scope = 'tactical', forTeam = 2, reward = 100,
            params = { targetUnitID = 81 },
        })
        _G.gadget:UnitDestroyed(81, nil, 3, 2, nil, 2)
        assert.are.equal(100, world.totalAwarded())
    end)

    it("never scales escrowed stakes — a bounty pays back what was staked", function()
        local world = newWorld()
        world.normaliseScale = 0.5
        local id = systemicKill(world, 100)
        GG.Authority.Stake(5, id, 200)
        _G.gadget:UnitDestroyed(81, nil, 3, 2, nil, 2)
        assert.are.equal(250, world.totalAwarded())   -- 100×0.5 + 200 untouched
    end)
end)

-- ============================================================
-- The comeback valve's published number (gameplay rule (b))
-- ============================================================
describe("objective_comeback publication", function()
    --- Ownership is read through GG.Regions.ControllingTeam per key, so the
    --- world's single `regionOwner` is not enough here — override the accessor.
    local function worldWithRegions(ownerByKey)
        local world = newWorld()
        world.teamList = { 0, 1, 99 }        -- 99 is gaia and must not be published
        GG.Regions.Keys = function()
            local out = {}
            for k in pairs(ownerByKey) do out[#out + 1] = k end
            table.sort(out)
            return out
        end
        GG.Regions.ControllingTeam = function(key) return ownerByKey[key] end
        return world
    end

    it("publishes a multiplier per team every eval tick", function()
        local world = worldWithRegions({ a = 0, b = 0, c = 1, d = 1 })
        world.evalAt(90)
        assert.are.equal(1.0, world.gameRulesParams['objective_comeback_0'])
        assert.are.equal(1.0, world.gameRulesParams['objective_comeback_1'])
    end)

    it("publishes above 1.0 for the team that is behind", function()
        local world = worldWithRegions({ a = 0, b = 0, c = 0, d = 1 })
        world.evalAt(90)
        assert.are.equal(1.0, world.gameRulesParams['objective_comeback_0'])
        assert.is_true(world.gameRulesParams['objective_comeback_1'] > 1.0)
        assert.is_true(world.gameRulesParams['objective_comeback_1'] <= 1.5)
    end)

    it("never publishes one for gaia", function()
        local world = worldWithRegions({ a = 0, b = 1 })
        world.evalAt(90)
        assert.is_nil(world.gameRulesParams['objective_comeback_99'])
    end)
end)
