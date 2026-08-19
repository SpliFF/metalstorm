-- tests/registry_spec.lua — end-to-end registry behaviour against a mocked
-- Spring/GG (see spring_mock.lua header for why this deviates from the
-- codebase's usual "pure modules only" test convention).
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets/objectives && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.spring_mock')

-- D15 regression. The evaluator was gated on `frame % EVAL_PERIOD == 0`, and on
-- a server that logs `sim fell behind, skipped N ticks` the engine never calls
-- gadget:GameFrame for the skipped frames — they do not arrive late. Measured at
-- 8x sim: a control objective accumulated ZERO hold progress over 40 000 frames.
-- Both cases below deliver only frames that are NOT multiples of 90, which is
-- what a stalled server does; under the old gate the objective never evaluated
-- once and the war could not be won.
describe("the eval tick survives skipped frames (D15)", function()
    local function heldRegion()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.regionOwner.r1 = 1
        world.keyAt = function() return 'r1' end
        world.setUnit(10, { x = 0, z = 0, team = 1 })
        local id = GG.Objectives.Create({
            type = 'control', forTeam = 1, reward = 50,
            params = { regionKey = 'r1', holdFrames = 180 },
        })
        return world, gadgetObj, id
    end

    it("evaluates and completes when no exact period boundary is ever delivered", function()
        local world, gadgetObj, id = heldRegion()
        for _, f in ipairs({ 91, 137, 182, 271, 293 }) do
            world.frame = f
            gadgetObj:GameFrame(f)
        end
        assert.are.equal('complete', world.rp(id, 'state'))
        assert.are.equal(1, #world.awards)
    end)

    it("banks the whole hold across one multi-period stall", function()
        local world, gadgetObj, id = heldRegion()
        world.frame = 91
        gadgetObj:GameFrame(91)                 -- clock starts
        assert.are.equal('active', world.rp(id, 'state'))
        -- 3 509 frames in one delivered frame: D57's accrual banks the elapsed
        -- interval, so the 180-frame hold is long since satisfied.
        world.frame = 3600
        gadgetObj:GameFrame(3600)
        assert.are.equal('complete', world.rp(id, 'state'))
    end)

    it("does not evaluate more than once per period when frames are dense", function()
        local world, gadgetObj = heldRegion()
        local before = world.frame
        -- 89 consecutive frames inside one period must yield no eval at all,
        -- which is what keeps this a cadence fix and not a per-frame evaluator.
        for f = 1, 89 do
            world.frame = f
            gadgetObj:GameFrame(f)
        end
        assert.are.equal(0, #world.awards)
        assert.is_number(before)
    end)
end)

describe("control objective: full lifecycle to award", function()
    it("completes on sustained hold and awards the team pool (zero participation)", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.regionOwner.r1 = 1
        -- D57: the clock accrues only while the owner occupies the region, so
        -- a garrison is now part of the fixture. No `last_commander` on it —
        -- that is what makes this the zero-participation case.
        world.keyAt = function() return 'r1' end
        world.setUnit(10, { x = 0, z = 0, team = 1 })
        local id = GG.Objectives.Create({
            type = 'control', forTeam = 1, reward = 50,
            params = { regionKey = 'r1', holdFrames = 180 },
        })
        assert.is_number(id)
        assert.are.equal('active', world.rp(id, 'state'))

        world.frame = 90
        gadgetObj:GameFrame(90)
        assert.are.equal('active', world.rp(id, 'state'))

        world.frame = 270
        gadgetObj:GameFrame(270)
        assert.are.equal('complete', world.rp(id, 'state'))
        assert.are.equal(1, #world.awards)
        assert.are.equal(50, world.awards[1].amount)
        assert.are.equal(1, world.awards[1].target.team)
        assert.is_nil(world.awards[1].target.split)
    end)

    it("splits the award by participation, routing an inactive player's share team-ward", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.regionOwner.r1 = 1
        world.keyAt = function(x, z) return (x < 500) and 'r1' or 'r2' end
        world.setUnit(10, { x = 100, z = 100, team = 1 })
        world.setUnit(11, { x = 100, z = 100, team = 1 })
        world.setLastCommander(10, 501)   -- active
        world.setLastCommander(11, 502)   -- will leave before resolve
        world.setPlayer(501, 1, true)
        world.setPlayer(502, 1, false)    -- inactive at resolve time

        local id = GG.Objectives.Create({
            type = 'control', forTeam = 1, reward = 90,
            params = { regionKey = 'r1', holdFrames = 90 },
        })
        world.frame = 90
        gadgetObj:GameFrame(90)   -- starts the clock, credits participation for players 501/502
        world.frame = 180
        gadgetObj:GameFrame(180)  -- 180-90=90 >= 90 -> complete

        assert.are.equal('complete', world.rp(id, 'state'))
        assert.are.equal(1, #world.awards)
        local split = world.awards[1].target.split
        assert.is_not_nil(split)
        assert.are.equal(1.0, split.weights[501])
        assert.is_nil(split.weights[502])
        assert.are.equal(1.0, split.teamWeight)   -- player 502's share redirected team-ward
    end)

    it("ignores participation from an enemy commander who wandered nearby", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.regionOwner.r1 = 1
        world.keyAt = function() return 'r1' end
        world.setUnit(20, { x = 0, z = 0, team = 2 })   -- enemy unit, not team 1
        world.setLastCommander(20, 999)
        world.setPlayer(999, 2, true)
        world.setUnit(21, { x = 0, z = 0, team = 1 })   -- D57: the owner's own garrison

        local id = GG.Objectives.Create({
            type = 'control', forTeam = 1, reward = 40,
            params = { regionKey = 'r1', holdFrames = 90 },
        })
        world.frame = 90; gadgetObj:GameFrame(90)
        world.frame = 180; gadgetObj:GameFrame(180)

        assert.are.equal('complete', world.rp(id, 'state'))
        assert.are.equal(1, #world.awards)
        assert.is_nil(world.awards[1].target.split)   -- enemy participation discarded -> team award
        assert.are.equal(1, world.awards[1].target.team)
    end)
end)

describe("kill objective via UnitDestroyed", function()
    it("completes and settles escrow on a killer hit, no reward on a killerless death", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.setUnit(30, { x = 0, z = 0, team = 2 })
        local id = GG.Objectives.Create({ type = 'kill', reward = 25, params = { targetUnitID = 30 } })
        assert.is_number(id)

        world.kill(30)
        gadgetObj:UnitDestroyed(30, nil, 2, nil, nil, 1)
        assert.are.equal('complete', world.rp(id, 'state'))
        assert.are.equal(1, #world.awards)
        assert.are.equal(1, world.awards[1].target.team)
        assert.are.equal(1, #world.escrowSettles)
        assert.are.equal('complete', world.escrowSettles[1].outcome)
    end)
end)

describe("bounty creation", function()
    it("stakes the objective and publishes reward as the escrow amount", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.setPlayer(1, 1, true)
        world.setUnit(40, { x = 0, z = 0, team = 2 })
        local id = GG.Objectives.CreateBounty(1, { type = 'kill', params = { targetUnitID = 40 } }, 60)
        assert.is_number(id)
        assert.are.equal(1, #world.stakes)
        assert.are.equal(60, world.stakes[1].amount)
        assert.are.equal(60, world.rp(id, 'reward'))   -- reward(0) + escrow(60)
    end)

    it("rolls back the objective entirely when the stake is rejected (insufficient funds)", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.setPlayer(1, 1, true)
        world.setUnit(41, { x = 0, z = 0, team = 2 })
        world.stakeResult = false
        local rejectedId = GG.Objectives.CreateBounty(1, { type = 'kill', params = { targetUnitID = 41 } }, 999)
        assert.is_nil(rejectedId)
        -- The id itself is burned (objective_count is a high-water mark, §1
        -- — never reused, never decremented), but its per-id params are
        -- rolled back: nothing was left visibly "active" for a bounty that
        -- never actually got its stake.
        assert.is_nil(world.rp(1, 'state'))
    end)

    it("enforces the per-player bounty cap", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.setPlayer(1, 1, true)
        for i = 1, 6 do
            world.setUnit(50 + i, { x = 0, z = 0, team = 2 })
        end
        local created = 0
        for i = 1, 6 do
            local id = GG.Objectives.CreateBounty(1, { type = 'kill', params = { targetUnitID = 50 + i } }, 10)
            if id then created = created + 1 end
        end
        assert.are.equal(4, created)   -- BOUNTY_CAP_PER_PLAYER
    end)
end)

describe("linked pair (E4)", function()
    it("resolving one half expires the other", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.setUnit(60, { x = 0, z = 0, team = 3 })
        local escortId, killId
        local idA = GG.Objectives.CreateLinkedPair(
            { type = 'escort', forTeam = 2, reward = 30,
              params = { payloadUnitIDs = { 60 }, destArea = { x = 1000, z = 0, r = 50 } } },
            { type = 'kill', reward = 30, params = { targetUnitID = 60 } }
        )
        assert.is_number(idA)
        killId = idA + 1   -- created immediately after, monotonic ids

        -- Escort completes (payload reaches destArea).
        world.units[60].x, world.units[60].z = 1000, 0
        world.frame = 90
        gadgetObj:GameFrame(90)

        assert.are.equal('complete', world.rp(idA, 'state'))
        assert.are.equal('expired', world.rp(killId, 'state'))
    end)

    it("rolls back the first half if the second half fails validation", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        local id = GG.Objectives.CreateLinkedPair(
            { type = 'escort', params = { payloadUnitIDs = { 1 }, destArea = { x = 0, z = 0, r = 10 } } },
            { type = 'kill', params = {} }   -- missing targetUnitID -> validateParams fails
        )
        assert.is_nil(id)
    end)
end)

describe("phase chaining (§4.7)", function()
    it("advances phase on child completion and pays out on the final phase", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.regionOwner.r1 = 1
        world.setUnit(70, { x = 0, z = 0, team = 3 })   -- phase 1 kill target
        world.setUnit(71, { x = 0, z = 0, team = 3 })   -- phase 2 kill target

        local parentId = GG.Objectives.Create({
            type = 'control', forTeam = 1, reward = 100,
            params = { regionKey = 'r1', holdFrames = 999999 },  -- parent's own predicate never fires
            phases = {
                { { type = 'kill', reward = 10, params = { targetUnitID = 70 } } },
                { { type = 'kill', reward = 10, params = { targetUnitID = 71 } } },
            },
        })
        assert.is_number(parentId)
        assert.are.equal(1, world.rp(parentId, 'phase'))

        world.kill(70)
        gadgetObj:UnitDestroyed(70, nil, 3, nil, nil, 1)
        assert.are.equal('active', world.rp(parentId, 'state'))
        assert.are.equal(2, world.rp(parentId, 'phase'))

        world.kill(71)
        gadgetObj:UnitDestroyed(71, nil, 3, nil, nil, 1)
        assert.are.equal('complete', world.rp(parentId, 'state'))
        -- Parent's own award (100) is a separate Award call from each phase
        -- child's own small reward (10 each) — three awards total.
        assert.are.equal(3, #world.awards)
        assert.are.equal(100, world.awards[3].amount)
    end)

    it("fails the parent when a phase child fails", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.regionOwner.r1 = 1
        world.setUnit(80, { x = 0, z = 0, team = 3 })

        local parentId = GG.Objectives.Create({
            type = 'control', forTeam = 1, reward = 100,
            params = { regionKey = 'r1', holdFrames = 999999 },
            phases = { { { type = 'kill', reward = 10, params = { targetUnitID = 80 } } } },
        })
        world.kill(80)
        gadgetObj:UnitDestroyed(80, nil, 3, nil, nil, nil)   -- no attacker -> child expires, not completes
        assert.are.equal('failed', world.rp(parentId, 'state'))
    end)

    -- S4/D3. `parentId` is forwarded verbatim from scenario files now, so a
    -- child can name a parent that was created WITHOUT `phases` — that parent
    -- has no phaseDefs/phaseIdx/phaseChildren, and every line of the advance
    -- path used to raise on nil. The error surfaced inside resolveObjective,
    -- which gadgetHandler answers by removing this gadget: one mis-authored
    -- scenario field killed the entire objectives evaluator, silently, for the
    -- rest of the war. The parent must simply take no part.
    it("ignores a child naming a parent that has no phases at all", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.regionOwner.r1 = 1
        world.setUnit(85, { x = 0, z = 0, team = 3 })

        local plainId = GG.Objectives.Create({
            type = 'control', forTeam = 1, reward = 100,
            params = { regionKey = 'r1', holdFrames = 999999 },
        })
        local childId = GG.Objectives.Create({
            type = 'kill', forTeam = 1, reward = 10, parentId = plainId,
            params = { targetUnitID = 85 },
        })
        assert.is_number(plainId)
        assert.is_number(childId)

        world.kill(85)
        gadgetObj:UnitDestroyed(85, nil, 3, nil, nil, 1)

        assert.are.equal('complete', world.rp(childId, 'state'))
        assert.are.equal('active', world.rp(plainId, 'state'))
        assert.is_nil(world.rp(plainId, 'phase'))
    end)
end)

describe("resolve-retention window (§1)", function()
    it("keeps published params for 30s after resolve, then clears them", function()
        local world, gadgetObj = mock.new()
        world.frame = 0
        world.setUnit(90, { x = 0, z = 0, team = 2 })
        local id = GG.Objectives.Create({ type = 'kill', reward = 5, params = { targetUnitID = 90 } })
        world.kill(90)
        gadgetObj:UnitDestroyed(90, nil, 2, nil, nil, 1)
        assert.are.equal('complete', world.rp(id, 'state'))

        world.frame = 810   -- resolvedFrame was 0; still within the 900-frame window (>= clears)
        gadgetObj:GameFrame(810)
        assert.are.equal('complete', world.rp(id, 'state'))

        world.frame = 990   -- elapsed (990) >= RESOLVE_RETENTION_FRAMES (900)
        gadgetObj:GameFrame(990)
        assert.is_nil(world.rp(id, 'state'))
    end)
end)
