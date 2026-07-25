-- tests/game_train_spec.lua — coupler-distance geometry, the GG.Train.Couple
-- programmatic seam, and T2 follow-spacing kinematics against the real
-- game_train.lua gadget (see train_mock.lua header for why a gadget-level
-- mock earns its cost here). Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/game_train_spec.lua
--
-- Regression context (2026-07-25, .tasks/notes/metalstorm-train.md): the T1
-- coupling foundation hardcoded halfLength placeholders (11.2/8.7) that were
-- ~6x smaller than the fable_train unitdefs' real footprints, so CanCouple's
-- range never reached two footprint-adjacent cars and live coupling on
-- Meridian was impossible. The geometry describe block below spawns units at
-- distances derived from the REAL footprint data (train_mock.HalfLength),
-- not arbitrary in-range mock coordinates — that's what makes it an honest
-- guard against this class of bug recurring.

package.path = './?.lua;' .. package.path

local mock = require('tests.train_mock')

local CMD_COUPLE = 35001

-- True if any Spring.Echo emitted so far contains `needle` (plain find).
local function echoed(world, needle)
    for _, msg in ipairs(world.echoes) do
        if msg:find(needle, 1, true) then return true end
    end
    return false
end

describe("coupler-distance geometry (regression guard)", function()
    it("lets a footprint-adjacent engine and gun car couple", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()

        local engineHalf = mock.HalfLength(mock.ENGINE_DEF_ID)  -- 72
        local gunHalf = mock.HalfLength(mock.GUN_DEF_ID)        -- 56

        -- Placed exactly footprint-to-footprint (centres separated by the
        -- sum of half-lengths, zero extra gap) — the closest two real
        -- fable_train hulls can physically sit without overlapping.
        world.setUnit(1, { defID = mock.ENGINE_DEF_ID, x = 0, z = 0 })
        world.setUnit(2, { defID = mock.GUN_DEF_ID, x = 0, z = -(engineHalf + gunHalf) })
        gadgetObj:UnitCreated(1, mock.ENGINE_DEF_ID)
        gadgetObj:UnitCreated(2, mock.GUN_DEF_ID)

        local ok = GG.Train.Couple(1, 2)

        assert.is_true(ok)
        assert.are.equal(world.rp(1, 'train_consist_id'), world.rp(2, 'train_consist_id'))
    end)

    it("still rejects units that are genuinely far apart", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()

        world.setUnit(1, { defID = mock.ENGINE_DEF_ID, x = 0, z = 0 })
        world.setUnit(2, { defID = mock.GUN_DEF_ID, x = 0, z = -1000 })
        gadgetObj:UnitCreated(1, mock.ENGINE_DEF_ID)
        gadgetObj:UnitCreated(2, mock.GUN_DEF_ID)

        local ok = GG.Train.Couple(1, 2)

        assert.is_false(ok)
        assert.is_nil(world.rp(1, 'train_consist_id'))
        assert.is_nil(world.rp(2, 'train_consist_id'))
    end)
end)

describe("GG.Train.Couple programmatic seam", function()
    it("couples two units without going through the CMD_COUPLE order flow", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()

        local engineHalf = mock.HalfLength(mock.ENGINE_DEF_ID)
        local troopHalf = mock.HalfLength(mock.TROOP_DEF_ID)
        world.setUnit(10, { defID = mock.ENGINE_DEF_ID, x = 0, z = 0 })
        world.setUnit(11, { defID = mock.TROOP_DEF_ID, x = 0, z = -(engineHalf + troopHalf) })
        gadgetObj:UnitCreated(10, mock.ENGINE_DEF_ID)
        gadgetObj:UnitCreated(11, mock.TROOP_DEF_ID)

        -- No CommandFallback/CMD_COUPLE order involved at all — this is the
        -- scenario/GM spawn path the seam exists for.
        local ok = GG.Train.Couple(10, 11)

        assert.is_true(ok)
        assert.are.equal(2, world.rp(10, 'train_consist_size'))
        assert.are.equal(2, world.rp(11, 'train_consist_size'))
        assert.are.equal(1, world.rp(10, 'train_is_leader'))
        assert.are.equal(0, world.rp(11, 'train_is_leader'))
    end)

    it("is equivalent to the CMD_COUPLE order-flow path (CommandFallback)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()

        local engineHalf = mock.HalfLength(mock.ENGINE_DEF_ID)
        local gunHalf = mock.HalfLength(mock.GUN_DEF_ID)
        world.setUnit(20, { defID = mock.ENGINE_DEF_ID, x = 0, z = 0 })
        world.setUnit(21, { defID = mock.GUN_DEF_ID, x = 0, z = -(engineHalf + gunHalf) })
        gadgetObj:UnitCreated(20, mock.ENGINE_DEF_ID)
        gadgetObj:UnitCreated(21, mock.GUN_DEF_ID)

        local handled, success = gadgetObj:CommandFallback(20, mock.ENGINE_DEF_ID, 1, CMD_COUPLE, { 21 }, {})

        assert.is_true(handled)
        assert.is_true(success)
        assert.are.equal(world.rp(20, 'train_consist_id'), world.rp(21, 'train_consist_id'))
    end)
end)

describe("T2 follow-spacing kinematics re-verified against derived halfLength", function()
    it("trails the follower behind the leader by the new (footprint-derived) coupling length", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()

        local engineHalf = mock.HalfLength(mock.ENGINE_DEF_ID)  -- 72
        local gunHalf = mock.HalfLength(mock.GUN_DEF_ID)        -- 56
        -- DEFAULT_COUPLING_GAP in game_train.lua is 1.0 (not exported; the
        -- gap is small relative to the footprint halves so it's asserted by
        -- value here rather than duplicating the gadget's local constant).
        local expectedCouplingLength = engineHalf + 1.0 + gunHalf  -- 129

        world.setUnit(1, { defID = mock.ENGINE_DEF_ID, x = 0, y = 0, z = 0, heading = 0, vz = 10 })
        world.setUnit(2, { defID = mock.GUN_DEF_ID, x = 0, y = 0, z = -expectedCouplingLength })
        gadgetObj:UnitCreated(1, mock.ENGINE_DEF_ID)
        gadgetObj:UnitCreated(2, mock.GUN_DEF_ID)

        assert.is_true(GG.Train.Couple(1, 2))
        -- Follower must be under MoveCtrl; leader must not be.
        assert.is_true(world.moveCtrl[2].enabled)
        assert.is_falsy(world.moveCtrl[1].enabled)

        -- Drive the leader in a straight line (+Z) for enough frames that
        -- the breadcrumb history clears the coupling length, so the
        -- follower's placement is a real interpolated trail position, not
        -- the startup snap-to-leader transient.
        local z = 0
        for frame = 1, 30 do
            z = z + 10
            world.moveUnit(1, 0, 0, z, 0)
            gadgetObj:GameFrame(frame)
        end

        local positions = world.moveCtrl[2].positions
        assert.is_true(#positions > 0)
        local lastPos = positions[#positions]

        -- Straight-line breadcrumb interpolation is exact: the follower
        -- should sit precisely `expectedCouplingLength` behind the leader.
        assert.is_true(math.abs(lastPos.z - (z - expectedCouplingLength)) < 0.001)
    end)
end)

-- Regression guards for the 2026-07-25 demo re-verify (fire 3) findings: the
-- U-turn/prefer-reverse logic lived in gadget:AllowUnitCommand, a callin name
-- no engine dispatches, so it was dead code. It now lives in the real
-- gadget:AllowCommand. These specs call AllowCommand with the exact argument
-- shape the gadgetHandler dispatches (…, cmdTag, playerID, fromSynced,
-- fromLua) so the wiring stays honest.
describe("U-turn detection via the real AllowCommand callin", function()
    local function makeConsist(world, gadgetObj, frontDefID, rearDefID)
        local frontHalf = mock.HalfLength(frontDefID)
        local rearHalf = mock.HalfLength(rearDefID)
        -- heading 0 = facing +Z; rear car sits behind on -Z
        world.setUnit(1, { defID = frontDefID, x = 0, z = 0, heading = 0 })
        world.setUnit(2, { defID = rearDefID, x = 0, z = -(frontHalf + rearHalf) })
        gadgetObj:UnitCreated(1, frontDefID)
        gadgetObj:UnitCreated(2, rearDefID)
        assert.is_true(GG.Train.Couple(1, 2))
    end

    it("flags a slow reverse when a single-engine leader is ordered straight behind", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        makeConsist(world, gadgetObj, mock.ENGINE_DEF_ID, mock.GUN_DEF_ID)

        local allow = gadgetObj:AllowCommand(1, mock.ENGINE_DEF_ID, 1,
            CMD.MOVE, { 0, 0, -1000 }, {}, 0, 1, false, false)

        assert.is_true(allow)  -- order is shaped, never blocked
        assert.is_true(echoed(world, "Single-engine consist will reverse slowly"))
    end)

    it("does not trigger for a target ahead of the leader", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        makeConsist(world, gadgetObj, mock.ENGINE_DEF_ID, mock.GUN_DEF_ID)

        local allow = gadgetObj:AllowCommand(1, mock.ENGINE_DEF_ID, 1,
            CMD.MOVE, { 0, 0, 1000 }, {}, 0, 1, false, false)

        assert.is_true(allow)
        assert.is_false(echoed(world, "reverse"))
        assert.is_false(echoed(world, "Reversing"))
    end)

    it("does not trigger for move orders to a non-leader car", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        makeConsist(world, gadgetObj, mock.ENGINE_DEF_ID, mock.GUN_DEF_ID)

        local allow = gadgetObj:AllowCommand(2, mock.GUN_DEF_ID, 1,
            CMD.MOVE, { 0, 0, -1000 }, {}, 0, 1, false, false)

        assert.is_true(allow)
        assert.is_false(echoed(world, "reverse"))
    end)

    it("swaps leadership on a two-engine consist instead of reversing slowly", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        makeConsist(world, gadgetObj, mock.ENGINE_DEF_ID, mock.ENGINE_DEF_ID)
        assert.are.equal(1, world.rp(1, 'train_is_leader'))

        local allow = gadgetObj:AllowCommand(1, mock.ENGINE_DEF_ID, 1,
            CMD.MOVE, { 0, 0, -1000 }, {}, 0, 1, false, false)

        assert.is_true(allow)
        assert.is_true(echoed(world, "Reversing consist to avoid U-turn"))
        assert.are.equal(0, world.rp(1, 'train_is_leader'))
        assert.are.equal(1, world.rp(2, 'train_is_leader'))
    end)

    it("also fires for CMD.FIGHT (attack-move) — CMD.ATTACK_MOVE does not exist", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        makeConsist(world, gadgetObj, mock.ENGINE_DEF_ID, mock.GUN_DEF_ID)

        gadgetObj:AllowCommand(1, mock.ENGINE_DEF_ID, 1,
            CMD.FIGHT, { 0, 0, -1000 }, {}, 0, 1, false, false)

        assert.is_true(echoed(world, "Single-engine consist will reverse slowly"))
    end)
end)

describe("damage→speed factor recomputes on live (non-lethal) damage", function()
    local HP_RECOMPUTE_INTERVAL = 15  -- game_train.lua cadence (0.5 s at 30 Hz)

    local function makeDamagedConsist(world, gadgetObj)
        local engineHalf = mock.HalfLength(mock.ENGINE_DEF_ID)
        local gunHalf = mock.HalfLength(mock.GUN_DEF_ID)
        world.setUnit(1, { defID = mock.ENGINE_DEF_ID, x = 0, z = 0 })
        world.setUnit(2, { defID = mock.GUN_DEF_ID, x = 0, z = -(engineHalf + gunHalf) })
        gadgetObj:UnitCreated(1, mock.ENGINE_DEF_ID)
        gadgetObj:UnitCreated(2, mock.GUN_DEF_ID)
        assert.is_true(GG.Train.Couple(1, 2))
        assert.are.equal(1.0, world.rp(1, 'train_speed_factor'))
    end

    it("slows a heavily-damaged-but-alive train without any unit dying", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        makeDamagedConsist(world, gadgetObj)

        -- 72% damage to the engine, both units still alive — the live-test
        -- case from the 2026-07-25 re-verify where the factor stayed 1.0.
        world.units[1].hp = 28

        gadgetObj:GameFrame(HP_RECOMPUTE_INTERVAL)

        -- liveHP/liveMaxHP = (28 + 100) / 200
        assert.are.equal(0.64, world.rp(1, 'train_speed_factor'))
        assert.are.equal(0.64, world.rp(2, 'train_speed_factor'))
    end)

    it("applies the cap to the leader's real move type (not the scriptless COB path)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        makeDamagedConsist(world, gadgetObj)

        world.units[1].hp = 28
        gadgetObj:GameFrame(HP_RECOMPUTE_INTERVAL)

        -- maxSpeed is elmos/sec (the engine divides by GAME_SPEED itself in
        -- AMoveType::SetMemberValue — passing elmos/frame double-divides and
        -- near-freezes the train): speed 72 * factor 0.64. The old
        -- SetUnitCOBValue(COB.MAX_SPEED) path needed a COB script the
        -- fable_train units don't have — it errored per-frame and never
        -- actually slowed the leader.
        local gm = world.groundMoveData[1]
        assert.is_truthy(gm)
        assert.is_true(math.abs(gm.maxSpeed - 72 * 0.64) < 1e-9)
    end)

    it("recovers the factor when HP comes back (repair fires no damage event)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()
        makeDamagedConsist(world, gadgetObj)

        world.units[1].hp = 28
        gadgetObj:GameFrame(HP_RECOMPUTE_INTERVAL)
        assert.are.equal(0.64, world.rp(1, 'train_speed_factor'))

        world.units[1].hp = 100
        gadgetObj:GameFrame(HP_RECOMPUTE_INTERVAL * 2)
        assert.are.equal(1.0, world.rp(1, 'train_speed_factor'))
    end)
end)

describe("failed CMD_COUPLE orders are removed from the queue", function()
    it("returns remove=true on a too-far-apart couple attempt (no retry spam)", function()
        local world, gadgetObj = mock.new()
        gadgetObj:Initialize()

        world.setUnit(1, { defID = mock.ENGINE_DEF_ID, x = 0, z = 0 })
        world.setUnit(2, { defID = mock.GUN_DEF_ID, x = 0, z = -1000 })
        gadgetObj:UnitCreated(1, mock.ENGINE_DEF_ID)
        gadgetObj:UnitCreated(2, mock.GUN_DEF_ID)

        local handled, remove = gadgetObj:CommandFallback(1, mock.ENGINE_DEF_ID, 1, CMD_COUPLE, { 2 }, {})

        -- The old code returned remove=false on failure, so the engine
        -- retried (and re-echoed) every ~15 frames forever.
        assert.is_true(handled)
        assert.is_true(remove)
        assert.is_true(echoed(world, "Cannot couple: Units too far apart"))
        assert.is_nil(world.rp(1, 'train_consist_id'))
    end)
end)
