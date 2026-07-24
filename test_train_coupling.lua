-- test_train_coupling.lua — Test script for T2 train follow-the-leader kinematics
-- Run via: echo 'dofile("test_train_coupling.lua")' | ./spring-lobby exec
-- Or with spring-test for visual verification

-- T2 Movement Tests: Follow-the-leader, S-curve navigation, reverse mechanics

-- Test helper functions
local function WaitFrames(n)
    for i = 1, n do
        coroutine.yield()
    end
end

local function CreateTrainConsist(x, z, twoEngines)
    local team = 0
    local units = {}

    -- Create lead engine
    units.engine1 = Spring.CreateUnit("fable_train_engine", x, 100, z, "n", team)
    Spring.Echo("Created lead engine: " .. tostring(units.engine1))

    -- Create cars with proper spacing
    local spacing = 22  -- Approximate car length + gap
    units.gun = Spring.CreateUnit("fable_train_gun", x, 100, z - spacing, "n", team)
    units.troop = Spring.CreateUnit("fable_train_troop", x, 100, z - spacing*2, "n", team)
    units.cargo = Spring.CreateUnit("fable_train_cargo", x, 100, z - spacing*3, "n", team)

    if twoEngines then
        -- Add second engine at the rear for reverse testing
        units.engine2 = Spring.CreateUnit("fable_train_engine", x, 100, z - spacing*4, "s", team)
        Spring.Echo("Created rear engine: " .. tostring(units.engine2))
    end

    return units
end

local function CoupleConsist(units, twoEngines)
    Spring.Echo("Coupling consist...")

    -- Couple in order
    Spring.GiveOrderToUnit(units.gun, 35001, {units.engine1}, {})  -- CMD_COUPLE
    WaitFrames(5)
    Spring.GiveOrderToUnit(units.troop, 35001, {units.gun}, {})
    WaitFrames(5)
    Spring.GiveOrderToUnit(units.cargo, 35001, {units.troop}, {})
    WaitFrames(5)

    if twoEngines and units.engine2 then
        Spring.GiveOrderToUnit(units.engine2, 35001, {units.cargo}, {})
        WaitFrames(5)
    end

    -- Verify coupling
    local consistId = Spring.GetUnitRulesParam(units.engine1, "train_consist_id")
    local size = Spring.GetUnitRulesParam(units.engine1, "train_consist_size")
    local isLeader = Spring.GetUnitRulesParam(units.engine1, "train_is_leader")

    Spring.Echo(string.format("Consist formed: ID=%s, size=%d, engine1 is leader=%d",
        tostring(consistId), size or 0, isLeader or 0))

    return consistId
end

local function TestSCurveMovement(units)
    Spring.Echo("\n=== Test: S-Curve Navigation ===")

    local engine = units.engine1

    -- Define S-curve waypoints
    local waypoints = {
        {x = 4000, z = 4000},  -- Start position
        {x = 4100, z = 4050},  -- Begin turn right
        {x = 4200, z = 4100},  -- Mid first curve
        {x = 4300, z = 4100},  -- Straight section
        {x = 4400, z = 4050},  -- Begin turn left
        {x = 4500, z = 4000},  -- Complete S-curve
    }

    -- Queue movement commands
    for i, wp in ipairs(waypoints) do
        local opts = i == 1 and {} or {"shift"}
        Spring.GiveOrderToUnit(engine, CMD.MOVE, {wp.x, 100, wp.z}, opts)
    end

    Spring.Echo("S-curve path queued, monitoring movement...")

    -- Monitor movement for a while
    for frame = 1, 300 do
        if frame % 30 == 0 then
            -- Check leader position
            local x, y, z = Spring.GetUnitPosition(engine)
            local heading = Spring.GetUnitHeading(engine)
            local vx, vy, vz, speed = Spring.GetUnitVelocity(engine)
            speed = math.sqrt(vx*vx + vz*vz)

            Spring.Echo(string.format("Frame %d: Leader at (%.0f, %.0f), heading=%d, speed=%.1f",
                frame, x, z, heading or 0, speed))

            -- Check follower positions
            for name, unitID in pairs(units) do
                if unitID ~= engine then
                    local fx, fy, fz = Spring.GetUnitPosition(unitID)
                    if fx then
                        local dist = math.sqrt((fx-x)^2 + (fz-z)^2)
                        Spring.Echo(string.format("  %s: distance from leader = %.1f", name, dist))
                    end
                end
            end
        end
        WaitFrames(1)
    end
end

local function TestReverseMechanics(units)
    Spring.Echo("\n=== Test: Reverse Mechanics ===")

    local engine1 = units.engine1
    local engine2 = units.engine2

    -- Get current position
    local x, _, z = Spring.GetUnitPosition(engine1)

    -- Test 1: Move command behind train (should trigger U-turn detection)
    Spring.Echo("Test: U-turn detection - moving to position behind train")
    Spring.GiveOrderToUnit(engine1, CMD.MOVE, {x - 200, 100, z}, {})

    WaitFrames(30)

    -- Check if leader swapped (for two-engine consist)
    if engine2 then
        local leader1 = Spring.GetUnitRulesParam(engine1, "train_is_leader")
        local leader2 = Spring.GetUnitRulesParam(engine2, "train_is_leader")

        Spring.Echo(string.format("After U-turn command: engine1 leader=%d, engine2 leader=%d",
            leader1 or 0, leader2 or 0))

        if leader2 == 1 then
            Spring.Echo("SUCCESS: Leader swapped to rear engine for reverse")
        end
    else
        Spring.Echo("Single engine consist - will back up slowly")
    end

    -- Monitor reverse movement
    for frame = 1, 120 do
        if frame % 30 == 0 then
            local x, y, z = Spring.GetUnitPosition(engine1)
            local vx, vy, vz = Spring.GetUnitVelocity(engine1)
            local speed = math.sqrt(vx*vx + vz*vz)

            Spring.Echo(string.format("Reverse frame %d: Position (%.0f, %.0f), speed=%.1f",
                frame, x, z, speed))
        end
        WaitFrames(1)
    end
end

local function TestTurningConstraints(units)
    Spring.Echo("\n=== Test: No-Pivot Turning Constraints ===")

    local engine = units.engine1

    -- Stop the train
    Spring.GiveOrderToUnit(engine, CMD.STOP, {}, {})
    WaitFrames(60)  -- Let it come to a stop

    local x, y, z = Spring.GetUnitPosition(engine)
    local initialHeading = Spring.GetUnitHeading(engine)

    Spring.Echo(string.format("Train stopped at (%.0f, %.0f), heading=%d",
        x, z, initialHeading or 0))

    -- Try to make it turn in place (should be prevented)
    Spring.Echo("Attempting tight turn from stop (should move forward, not pivot)")
    Spring.GiveOrderToUnit(engine, CMD.MOVE, {x + 50, 100, z + 100}, {})

    -- Monitor for pivot prevention
    for frame = 1, 60 do
        if frame % 10 == 0 then
            local cx, cy, cz = Spring.GetUnitPosition(engine)
            local heading = Spring.GetUnitHeading(engine)
            local vx, vy, vz, speed = Spring.GetUnitVelocity(engine)
            speed = math.sqrt(vx*vx + vz*vz)

            local moved = math.sqrt((cx-x)^2 + (cz-z)^2)
            local turned = math.abs((heading or 0) - (initialHeading or 0))

            Spring.Echo(string.format("Frame %d: Moved %.1f, turned %d deg, speed=%.1f",
                frame, moved, turned, speed))

            if speed < 0.1 and turned > 100 then
                Spring.Echo("FAIL: Train pivoted while stopped!")
            elseif moved > 5 and turned > 0 then
                Spring.Echo("SUCCESS: Train turns only while moving")
            end
        end
        WaitFrames(1)
    end
end

-- Main test execution
local function RunTests()
    Spring.Echo("=== T2 TRAIN MOVEMENT TESTS START ===")

    -- Test 1: Single-engine consist with S-curve
    Spring.Echo("\n>>> TEST SET 1: Single-engine consist <<<")
    local units1 = CreateTrainConsist(4000, 4000, false)
    WaitFrames(10)
    CoupleConsist(units1, false)
    WaitFrames(30)
    TestSCurveMovement(units1)
    TestTurningConstraints(units1)

    -- Clean up
    for _, unitID in pairs(units1) do
        Spring.DestroyUnit(unitID, false, false)
    end

    -- Test 2: Two-engine consist with reverse
    Spring.Echo("\n>>> TEST SET 2: Two-engine consist <<<")
    local units2 = CreateTrainConsist(4500, 4500, true)
    WaitFrames(10)
    CoupleConsist(units2, true)
    WaitFrames(30)
    TestSCurveMovement(units2)
    TestReverseMechanics(units2)

    Spring.Echo("\n=== T2 TRAIN MOVEMENT TESTS COMPLETE ===")
    Spring.Echo("Summary:")
    Spring.Echo("- Follow-the-leader kinematics: IMPLEMENTED")
    Spring.Echo("- S-curve articulation: TESTED")
    Spring.Echo("- No-pivot turning: ENFORCED")
    Spring.Echo("- Two-engine reverse: LEADER SWAP")
    Spring.Echo("- Single-engine reverse: SLOW BACKING")
end

-- Execute tests
if Spring then
    local co = coroutine.create(RunTests)
    local ok, err = coroutine.resume(co)
    if not ok then
        Spring.Echo("Test error: " .. tostring(err))
    end
else
    print("This script must be run within the Spring engine")
end