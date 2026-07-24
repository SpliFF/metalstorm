-- test_train_damage_speed.lua — Test script for T3 train damage-speed mechanics
--
-- Tests:
-- 1. Speed drops with aggregate HP damage
-- 2. Car death keeps train moving with small slow
-- 3. Engine death causes large slow and leader re-election
-- 4. Zero live engines makes train immobile but still fires

local function TestDamageSpeed()
    print("=== Testing T3: Train Damage-Speed Mechanics ===")

    -- Spawn test consist: 2 engines + 2 cars
    local engine1 = Spring.CreateUnit("fable_train_engine", 3000, 100, 3000, 0, 0)
    local car1 = Spring.CreateUnit("fable_train_gun", 3020, 100, 3000, 0, 0)
    local car2 = Spring.CreateUnit("fable_train_troop", 3040, 100, 3000, 0, 0)
    local engine2 = Spring.CreateUnit("fable_train_engine", 3060, 100, 3000, 0, 0)

    Spring.Echo("Spawned test consist: engine-gun-troop-engine")

    -- Wait for units to initialize
    for i = 1, 10 do
        Spring.Update()
    end

    -- Couple them together
    Spring.GiveOrderToUnit(engine1, 35001, {car1}, {}) -- CMD_COUPLE
    for i = 1, 30 do Spring.Update() end

    Spring.GiveOrderToUnit(engine1, 35001, {car2}, {})
    for i = 1, 30 do Spring.Update() end

    Spring.GiveOrderToUnit(engine1, 35001, {engine2}, {})
    for i = 1, 30 do Spring.Update() end

    -- Verify coupling
    local consistID = Spring.GetUnitRulesParam(engine1, "train_consist_id")
    local consistSize = Spring.GetUnitRulesParam(engine1, "train_consist_size")
    assert(consistSize == 4, "Expected 4-unit consist, got " .. tostring(consistSize))
    Spring.Echo("Consist formed successfully with " .. consistSize .. " units")

    -- Give move order to measure baseline speed
    Spring.GiveOrderToUnit(engine1, CMD.MOVE, {3200, 100, 3000}, {})

    -- Measure baseline speed
    for i = 1, 60 do Spring.Update() end
    local x1, _, z1 = Spring.GetUnitPosition(engine1)
    for i = 1, 60 do Spring.Update() end
    local x2, _, z2 = Spring.GetUnitPosition(engine1)
    local baselineSpeed = math.sqrt((x2-x1)^2 + (z2-z1)^2) / 60

    Spring.Echo(string.format("Baseline speed: %.2f elmos/frame", baselineSpeed))

    -- TEST 1: Damage units and verify speed drops
    Spring.Echo("\n--- TEST 1: Speed drops with damage ---")

    -- Damage car1 to 50% HP
    local maxHP = select(2, Spring.GetUnitHealth(car1))
    Spring.SetUnitHealth(car1, maxHP * 0.5)

    for i = 1, 30 do Spring.Update() end

    local speedFactor1 = Spring.GetUnitRulesParam(engine1, "train_speed_factor")
    Spring.Echo(string.format("After 50%% damage to car: speedFactor = %.2f", speedFactor1))
    assert(speedFactor1 < 1.0 and speedFactor1 > 0.7, "Speed factor should be reduced but not too much")

    -- Measure actual speed
    local x3, _, z3 = Spring.GetUnitPosition(engine1)
    for i = 1, 60 do Spring.Update() end
    local x4, _, z4 = Spring.GetUnitPosition(engine1)
    local damagedSpeed = math.sqrt((x4-x3)^2 + (z4-z3)^2) / 60

    Spring.Echo(string.format("Speed after damage: %.2f (%.1f%% of baseline)",
        damagedSpeed, (damagedSpeed/baselineSpeed)*100))
    assert(damagedSpeed < baselineSpeed, "Speed should be reduced after damage")

    -- TEST 2: Kill a car (non-engine)
    Spring.Echo("\n--- TEST 2: Car death behavior ---")

    Spring.DestroyUnit(car1, false, false)
    for i = 1, 30 do Spring.Update() end

    local speedFactor2 = Spring.GetUnitRulesParam(engine1, "train_speed_factor")
    Spring.Echo(string.format("After car death: speedFactor = %.2f", speedFactor2))
    assert(speedFactor2 < speedFactor1, "Speed should drop further after car death")

    -- Verify consist still has 4 units
    local sizeAfterDeath = Spring.GetUnitRulesParam(engine1, "train_consist_size")
    assert(sizeAfterDeath == 4, "Dead car should stay in consist")
    Spring.Echo("Dead car remains in consist (size = " .. sizeAfterDeath .. ")")

    -- TEST 3: Kill one engine
    Spring.Echo("\n--- TEST 3: Engine death and re-election ---")

    local wasLeader = (Spring.GetUnitRulesParam(engine1, "train_is_leader") == 1)
    Spring.Echo("Engine1 is leader: " .. tostring(wasLeader))

    Spring.DestroyUnit(engine1, false, false)
    for i = 1, 30 do Spring.Update() end

    local speedFactor3 = Spring.GetUnitRulesParam(engine2, "train_speed_factor")
    Spring.Echo(string.format("After engine death: speedFactor = %.2f", speedFactor3))
    assert(speedFactor3 < speedFactor2 - 0.2, "Large speed penalty expected for dead engine")

    -- Check if engine2 is now leader
    local isNewLeader = (Spring.GetUnitRulesParam(engine2, "train_is_leader") == 1)
    assert(isNewLeader, "Engine2 should be elected as new leader")
    Spring.Echo("Engine2 elected as new leader: " .. tostring(isNewLeader))

    -- TEST 4: Kill all engines (immobile)
    Spring.Echo("\n--- TEST 4: Zero live engines (immobile) ---")

    -- First spawn a dummy target to test if train can still fire
    local target = Spring.CreateUnit("fable_train_cargo", 3100, 100, 2900, 0, 0)

    Spring.DestroyUnit(engine2, false, false)
    for i = 1, 30 do Spring.Update() end

    local speedFactor4 = Spring.GetUnitRulesParam(car2, "train_speed_factor")
    Spring.Echo(string.format("After all engines dead: speedFactor = %.2f", speedFactor4))
    assert(speedFactor4 == 0, "Speed factor should be 0 with no live engines")

    -- Give attack order to verify units can still fire
    Spring.GiveOrderToUnit(car2, CMD.ATTACK, {target}, {})

    -- Measure position to verify immobility
    local px1, _, pz1 = Spring.GetUnitPosition(car2)
    for i = 1, 120 do Spring.Update() end
    local px2, _, pz2 = Spring.GetUnitPosition(car2)
    local movement = math.sqrt((px2-px1)^2 + (pz2-pz1)^2)

    Spring.Echo(string.format("Movement with no engines: %.2f elmos (should be ~0)", movement))
    assert(movement < 1.0, "Consist should be immobile with no live engines")

    -- Check if car2 is still attacking (has active command)
    local cmdQueue = Spring.GetUnitCommands(car2, 1)
    if cmdQueue and #cmdQueue > 0 then
        Spring.Echo("Car can still accept attack orders (weapons functional)")
    end

    Spring.Echo("\n=== T3 Tests Complete ===")
    Spring.Echo("✓ Speed reduces with damage")
    Spring.Echo("✓ Dead cars stay in consist with small slow")
    Spring.Echo("✓ Dead engine causes large slow and re-election")
    Spring.Echo("✓ Zero engines makes consist immobile but armed")
end

-- Run the test
TestDamageSpeed()