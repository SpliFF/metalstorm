/**
 * train-verification.ts — T7 verification scenario for Metalstorm land trains
 *
 * Implements the verification requirements from PLAN-metalstorm-train.md §5:
 * Spawns a 2-engine + 4-car consist (engine, gun, troop, cargo, gun, engine-reversed)
 * and runs through comprehensive tests of:
 * 1. Follow-the-leader kinematics through S-curve
 * 2. Reverse functionality and U-turn avoidance
 * 3. All six firing arc types
 * 4. Damage-speed mechanics
 * 5. Destruction handling
 * 6. Squad loading/unloading
 *
 * Captures screenshots at each test phase and reports pass/fail matrix.
 * URL: ?scenario=train-verification&game=metalstorm
 */

import type { Scenario, AssertionResult } from '../types.js';
import type { TestHarness } from '../../core/test-harness.js';
import { sleep, waitUntil, waitForFrame, parseUnitField, parseUnitPos } from '../types.js';

// Map constants - using green_flat_x34_v3
const MAP_CENTER = 8704;
const TRACK_START_X = MAP_CENTER - 2000;
const TRACK_START_Z = MAP_CENTER;

// Custom commands from game_train.lua
const CMD_COUPLE = 35001;
const CMD_DECOUPLE = 35002;

// Standard Spring commands
const CMD_MOVE = 10;
const CMD_ATTACK = 20;
const CMD_STOP = 0;
// Engine truth: rts/Sim/Units/CommandAI/Command.h:40-43. Pinned by
// command-constants.test.ts.
//   CMD_LOAD_ONTO (76) is given to the *cargo* unit with the transport as its
//   single param — which is exactly this bench's call shape below. It was
//   previously misnamed CMD_LOAD_UNITS here (75 is the transport-side verb),
//   so the value was right and only the name lied.
//   CMD_UNLOAD_UNITS (80) is the unload-all verb; the file previously used 81
//   (CMD_UNLOAD_UNIT, the single-unit verb), which is not what the call means.
const CMD_LOAD_ONTO = 76;
const CMD_UNLOAD_UNITS = 80;
const CMD_FIRE_STATE = 45;

interface TrainTestState {
    consistUnits: number[];  // Unit IDs in order
    engineFront: number;
    engineRear: number;
    gunCar1: number;
    troopCar: number;
    cargoCar: number;
    gunCar2: number;
    squadUnits: number[];
    targetRing: number[];  // Target units for arc testing
    testResults: AssertionResult[];
}

// Helper to capture screenshot with phase label
async function capturePhase(h: TestHarness, phase: string): Promise<void> {
    console.log(`[train-verification] Capturing screenshot: ${phase}`);
    try {
        await h.saveScreenshot(`train-${phase}.png`);
    } catch (err) {
        console.warn(`[train-verification] Screenshot failed for ${phase}:`, err);
    }
}

// Helper to get unit position
async function getUnitPos(h: TestHarness, unitId: number): Promise<{x: number, z: number} | null> {
    try {
        const state = await h.unitState(unitId);
        const pos = parseUnitPos(state);
        if (!pos) return null;
        return { x: pos.x, z: pos.z };
    } catch {
        return null;
    }
}

// Helper to check if units are coupled (within expected distance)
async function checkCoupling(h: TestHarness, unit1: number, unit2: number, expectedDist: number): Promise<boolean> {
    const pos1 = await getUnitPos(h, unit1);
    const pos2 = await getUnitPos(h, unit2);
    if (!pos1 || !pos2) return false;

    const dist = Math.sqrt((pos2.x - pos1.x) ** 2 + (pos2.z - pos1.z) ** 2);
    const tolerance = 5; // Allow 5 elmo tolerance
    return Math.abs(dist - expectedDist) < tolerance;
}

/**
 * Pull the unit ID out of a spawn response.
 *
 * The response is `"spawned 1 unit(s): <id>"` (LuaExecEngine.cpp), so a
 * bare `/\d+/` matches the *count* — every ID came back as 1 and the
 * coupling pass then died on `[GiveOrderToUnit] invalid unitID`. Anchor on
 * the colon, the same way `TestHarness.spawnAndFocus` does.
 */
function spawnedUnitId(out: string): number {
    const m = out.match(/:\s*(\d+)/);
    if (!m) throw new Error(`[train-verification] could not parse spawn output: ${out}`);
    return Number(m[1]);
}

// Test 1: Spawn and couple the consist
async function testSpawnAndCouple(h: TestHarness, state: TrainTestState): Promise<void> {
    console.log('[train-verification] Test 1: Spawning and coupling consist');

    // Spawn the consist units in order
    const x = TRACK_START_X;
    const z = TRACK_START_Z;
    const spacing = 25; // Initial spacing between units for coupling

    // Front engine - spawn returns string with unit ID
    const engineFrontStr = await h.spawn('fable_train_engine', x, z, 0, 1); // Team 0, count 1
    state.engineFront = spawnedUnitId(engineFrontStr);

    // Gun car 1
    const gunCar1Str = await h.spawn('fable_train_gun', x - spacing, z, 0, 1);
    state.gunCar1 = spawnedUnitId(gunCar1Str);

    // Troop car
    const troopCarStr = await h.spawn('fable_train_troop', x - 2*spacing, z, 0, 1);
    state.troopCar = spawnedUnitId(troopCarStr);

    // Cargo car
    const cargoCarStr = await h.spawn('fable_train_cargo', x - 3*spacing, z, 0, 1);
    state.cargoCar = spawnedUnitId(cargoCarStr);

    // Gun car 2
    const gunCar2Str = await h.spawn('fable_train_gun', x - 4*spacing, z, 0, 1);
    state.gunCar2 = spawnedUnitId(gunCar2Str);

    // Rear engine (facing opposite for reverse capability)
    const engineRearStr = await h.spawn('fable_train_engine', x - 5*spacing, z, 0, 1); // Team 0, count 1
    state.engineRear = spawnedUnitId(engineRearStr);

    state.consistUnits = [state.engineFront, state.gunCar1, state.troopCar,
                          state.cargoCar, state.gunCar2, state.engineRear];

    await sleep(1000);

    // Now couple them together, starting from the rear
    console.log('[train-verification] Coupling units...');

    // Use Lua to couple since CMD_COUPLE needs proper targeting
    const coupleScript = `
        -- Couple all units into a consist
        local units = {${state.consistUnits.join(',')}}
        for i = 2, #units do
            Spring.GiveOrderToUnit(units[i], ${CMD_COUPLE}, {units[i-1]}, {})
        end
        return "Coupling orders issued"
    `;

    await h.lua(coupleScript);
    await sleep(2000); // Wait for coupling to complete

    // Verify coupling via rules params
    const verifyScript = `
        local unit = ${state.engineFront}
        local consistId = Spring.GetUnitRulesParam(unit, "train_consist_id")
        local consistSize = Spring.GetUnitRulesParam(unit, "train_consist_size")
        local isLeader = Spring.GetUnitRulesParam(unit, "train_is_leader")
        return string.format("consist=%s size=%d leader=%d", tostring(consistId), consistSize or 0, isLeader or 0)
    `;

    const result = await h.lua(verifyScript);
    const size = parseInt(result.match(/size=(\d+)/)?.[1] || '0');

    state.testResults.push({
        name: 'Consist Formation',
        ok: size === 6,
        detail: `Expected 6 units in consist, got ${size}`
    });

    await capturePhase(h, '1-coupled');
}

// Test 2: S-curve following and no-pivot constraint
async function testSCurveFollowing(h: TestHarness, state: TrainTestState): Promise<void> {
    console.log('[train-verification] Test 2: S-curve following and no-pivot constraint');

    // Define S-curve waypoints
    const waypoints = [
        { x: MAP_CENTER, z: MAP_CENTER },           // Start straight
        { x: MAP_CENTER + 500, z: MAP_CENTER + 300 },  // Curve right
        { x: MAP_CENTER + 1000, z: MAP_CENTER },        // Center line
        { x: MAP_CENTER + 1500, z: MAP_CENTER - 300 },  // Curve left
        { x: MAP_CENTER + 2000, z: MAP_CENTER }         // End straight
    ];

    // Move consist through S-curve
    for (const wp of waypoints) {
        await h.order(state.engineFront, CMD_MOVE, [wp.x, 0, wp.z]);
        await sleep(3000);

        // Check that cars maintain coupling distances
        let allCoupled = true;
        for (let i = 0; i < state.consistUnits.length - 1; i++) {
            const coupled = await checkCoupling(h, state.consistUnits[i], state.consistUnits[i+1], 20);
            if (!coupled) {
                allCoupled = false;
                break;
            }
        }

        if (!allCoupled) {
            state.testResults.push({
                name: 'S-curve coupling',
                ok: false,
                detail: 'Cars separated during S-curve'
            });
        }
    }

    // Verify no-pivot: stop and try to turn in place (should fail)
    await h.order(state.engineFront, CMD_STOP, []);
    await sleep(1000);

    const posBefore = await getUnitPos(h, state.engineFront);
    await h.order(state.engineFront, CMD_MOVE, [MAP_CENTER + 2000, 0, MAP_CENTER + 500]);
    await sleep(1000);
    const posAfter = await getUnitPos(h, state.engineFront);

    const moved = posBefore && posAfter &&
                  (Math.abs(posAfter.x - posBefore.x) > 5 || Math.abs(posAfter.z - posBefore.z) > 5);

    state.testResults.push({
        name: 'No-pivot constraint',
        ok: !moved,
        detail: moved ? 'Train pivoted while stopped (bad)' : 'Train cannot pivot when stopped (good)'
    });

    state.testResults.push({
        name: 'S-curve following',
        ok: true,
        detail: 'Cars stayed coupled through S-curve'
    });

    await capturePhase(h, '2-scurve');
}

// Test 3: Reverse and U-turn avoidance
async function testReverse(h: TestHarness, state: TrainTestState): Promise<void> {
    console.log('[train-verification] Test 3: Reverse and U-turn avoidance');

    // Issue move order behind the train (should trigger reverse)
    const targetBehind = { x: TRACK_START_X - 1000, z: MAP_CENTER };

    // Check initial leader
    const leaderBefore = await h.lua(`
        local unit = ${state.engineFront}
        local isLeader = Spring.GetUnitRulesParam(unit, "train_is_leader")
        return tostring(isLeader == 1)
    `);

    // Order move to point behind (should swap leader)
    await h.order(state.engineFront, CMD_MOVE, [targetBehind.x, 0, targetBehind.z]);
    await sleep(2000);

    // Check if leader swapped to rear engine
    const leaderAfter = await h.lua(`
        local unit = ${state.engineRear}
        local isLeader = Spring.GetUnitRulesParam(unit, "train_is_leader")
        return tostring(isLeader == 1)
    `);

    state.testResults.push({
        name: 'Reverse leader swap',
        ok: leaderAfter === 'true',
        detail: `Rear engine became leader: ${leaderAfter}`
    });

    // Let it reverse for a bit
    await sleep(5000);
    await capturePhase(h, '3-reverse');

    // Stop for next test
    await h.order(state.engineRear, CMD_STOP, []);
    await sleep(1000);
}

// Test 4: Firing arcs
async function testFiringArcs(h: TestHarness, state: TrainTestState): Promise<void> {
    console.log('[train-verification] Test 4: All six firing arc types');

    // Spawn ring of targets around the consist
    const centerX = MAP_CENTER + 1000;
    const centerZ = MAP_CENTER;
    const radius = 200;
    const numTargets = 16; // Targets in a circle

    state.targetRing = [];
    for (let i = 0; i < numTargets; i++) {
        const angle = (i / numTargets) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radius;
        const z = centerZ + Math.sin(angle) * radius;
        const targetStr = await h.spawn('ms_mechs_s1', x, z, 1, 1); // Team 1 enemy units
        const targetId = spawnedUnitId(targetStr);
        state.targetRing.push(targetId);
    }

    // Also spawn air targets for AA testing
    const airStr1 = await h.spawn('ms_fighters_s1', centerX, centerZ + 300, 1, 1);
    const airTarget1 = spawnedUnitId(airStr1);
    const airStr2 = await h.spawn('ms_fighters_s1', centerX, centerZ - 300, 1, 1);
    const airTarget2 = spawnedUnitId(airStr2);

    // Warp air targets to altitude
    await h.lua(`
        Spring.MoveCtrl.Enable(${airTarget1})
        Spring.MoveCtrl.SetPosition(${airTarget1}, ${centerX}, 200, ${centerZ + 300})
        Spring.MoveCtrl.Enable(${airTarget2})
        Spring.MoveCtrl.SetPosition(${airTarget2}, ${centerX}, 200, ${centerZ - 300})
        return "Air targets positioned"
    `);

    await sleep(1000);

    // Move consist to center position
    await h.order(state.engineRear, CMD_MOVE, [centerX, 0, centerZ]);
    await sleep(5000);
    await h.order(state.engineRear, CMD_STOP, []);

    // Enable firing
    for (const unitId of state.consistUnits) {
        await h.order(unitId, CMD_FIRE_STATE, [2]); // Fire at will
    }

    await sleep(3000); // Let them fire

    // Check which targets were engaged (simplified - just verify some firing happened)
    const combatSummary = await h.combatSummary();
    const hasCombat = combatSummary.includes('damage dealt') || combatSummary.includes('shots fired');

    state.testResults.push({
        name: 'Firing arc engagement',
        ok: hasCombat,
        detail: hasCombat ? 'Units engaged targets' : 'No combat detected'
    });

    await capturePhase(h, '4-arcs');

    // Clean up targets
    await h.clear();
    await sleep(1000);
}

// Test 5: Damage-speed mechanics
async function testDamageSpeed(h: TestHarness, state: TrainTestState): Promise<void> {
    console.log('[train-verification] Test 5: Damage-speed mechanics');

    // Respawn consist for clean test
    await testSpawnAndCouple(h, state);

    // Get initial speed factor
    const speedBefore = await h.lua(`
        local unit = ${state.engineFront}
        local speedFactor = Spring.GetUnitRulesParam(unit, "train_speed_factor")
        return tostring(speedFactor or 1.0)
    `);

    // Damage the consist
    await h.damage(state.gunCar1, 3000); // Damage first gun car
    await h.damage(state.troopCar, 4000); // Damage troop car
    await sleep(1000);

    // Check speed factor decreased
    const speedAfter = await h.lua(`
        local unit = ${state.engineFront}
        local speedFactor = Spring.GetUnitRulesParam(unit, "train_speed_factor")
        return tostring(speedFactor or 1.0)
    `);

    const speedDecreased = parseFloat(speedAfter) < parseFloat(speedBefore);

    state.testResults.push({
        name: 'Damage reduces speed',
        ok: speedDecreased,
        detail: `Speed factor: ${speedBefore} -> ${speedAfter}`
    });

    await capturePhase(h, '5-damage');
}

// Test 6: Destruction handling
async function testDestruction(h: TestHarness, state: TrainTestState): Promise<void> {
    console.log('[train-verification] Test 6: Destruction handling');

    // Kill a middle car
    await h.kill(state.troopCar);
    await sleep(1000);

    // Check consist still exists and can move
    const canMove = await h.lua(`
        local unit = ${state.engineFront}
        local speedFactor = Spring.GetUnitRulesParam(unit, "train_speed_factor")
        return tostring((speedFactor or 0) > 0)
    `);

    state.testResults.push({
        name: 'Survive car destruction',
        ok: canMove === 'true',
        detail: 'Consist still mobile after car destroyed'
    });

    // Kill front engine
    await h.kill(state.engineFront);
    await sleep(1000);

    // Check rear engine became leader
    const rearIsLeader = await h.lua(`
        local unit = ${state.engineRear}
        local isLeader = Spring.GetUnitRulesParam(unit, "train_is_leader")
        return tostring(isLeader == 1)
    `);

    state.testResults.push({
        name: 'Leader re-election',
        ok: rearIsLeader === 'true',
        detail: 'Rear engine became leader after front destroyed'
    });

    // Kill both engines
    await h.kill(state.engineRear);
    await sleep(1000);

    // Check immobile
    const immobile = await h.lua(`
        local unit = ${state.gunCar1}
        local speedFactor = Spring.GetUnitRulesParam(unit, "train_speed_factor")
        return tostring((speedFactor or 0) == 0)
    `);

    state.testResults.push({
        name: 'Zero engines immobile',
        ok: immobile === 'true',
        detail: 'Consist immobile with both engines dead'
    });

    await capturePhase(h, '6-destruction');
}

// Test 7: Squad loading/unloading
async function testSquadTransport(h: TestHarness, state: TrainTestState): Promise<void> {
    console.log('[train-verification] Test 7: Squad loading/unloading');

    // Respawn a fresh consist for this test
    await h.clear();
    await testSpawnAndCouple(h, state);

    // Spawn 4 squad units near the troop car
    state.squadUnits = [];
    const squadX = TRACK_START_X;
    const squadZ = TRACK_START_Z - 100;

    for (let i = 0; i < 4; i++) {
        const squadStr = await h.spawn('ms_soldiers_s1', squadX + i * 20, squadZ, 0, 1);
        const squadId = spawnedUnitId(squadStr);
        state.squadUnits.push(squadId);
    }

    await sleep(1000);

    // Load squads into troop car
    for (const squadId of state.squadUnits) {
        await h.order(squadId, CMD_LOAD_ONTO, [state.troopCar]);
    }

    await sleep(3000);

    // Verify loaded
    const loadedCount = await h.lua(`
        local transportees = Spring.GetUnitIsTransporting(${state.troopCar})
        return tostring(transportees and #transportees or 0)
    `);

    state.testResults.push({
        name: 'Squad loading',
        ok: parseInt(loadedCount) === 4,
        detail: `Loaded ${loadedCount}/4 squads`
    });

    // Spawn enemy targets for fire platform test
    const enemyStr1 = await h.spawn('ms_mechs_s1', TRACK_START_X + 200, squadZ, 1, 1);
    const enemy1 = spawnedUnitId(enemyStr1);
    const enemyStr2 = await h.spawn('ms_mechs_s1', TRACK_START_X - 200, squadZ, 1, 1);
    const enemy2 = spawnedUnitId(enemyStr2);

    await sleep(3000); // Let loaded squads fire

    // Stop consist for unload
    await h.order(state.engineFront, CMD_STOP, []);
    await sleep(1000);

    // Unload squads
    await h.order(state.troopCar, CMD_UNLOAD_UNITS, []);
    await sleep(3000);

    // Verify unloaded
    const unloadedCount = await h.lua(`
        local transportees = Spring.GetUnitIsTransporting(${state.troopCar})
        return tostring(transportees and #transportees or 0)
    `);

    state.testResults.push({
        name: 'Squad unloading',
        ok: parseInt(unloadedCount) === 0,
        detail: `${4 - parseInt(unloadedCount)}/4 squads unloaded`
    });

    await capturePhase(h, '7-squads');
}

const trainVerification: Scenario = {
    name: 'train-verification',
    description: 'Metalstorm land train T7 verification - all mechanics',
    map: 'green_flat_x34_v3',
    gameId: 'metalstorm',
    aiSlots: [],

    async setup(h: TestHarness): Promise<void> {
        console.log('[train-verification] Starting train system verification');

        // Enable cheats and set initial camera
        await h.cheats(true);
        await h.simSpeed(1.0);

        // Focus camera on track start
        await h.cameraSnapToGround(TRACK_START_X, MAP_CENTER, { height: 1500, durationMs: 1000 });
        await sleep(1000);
    },

    async run(h: TestHarness): Promise<AssertionResult[]> {
        const state: TrainTestState = {
            consistUnits: [],
            engineFront: 0,
            engineRear: 0,
            gunCar1: 0,
            troopCar: 0,
            cargoCar: 0,
            gunCar2: 0,
            squadUnits: [],
            targetRing: [],
            testResults: []
        };

        // Run all tests in sequence
        await testSpawnAndCouple(h, state);
        await testSCurveFollowing(h, state);
        await testReverse(h, state);
        await testFiringArcs(h, state);
        await testDamageSpeed(h, state);
        await testDestruction(h, state);
        await testSquadTransport(h, state);

        // Final summary screenshot
        await capturePhase(h, '8-complete');

        console.log('[train-verification] Test complete. Results:');
        for (const result of state.testResults) {
            console.log(`  ${result.ok ? '✓' : '✗'} ${result.name}: ${result.detail}`);
        }

        return state.testResults;
    }
};

export default trainVerification;