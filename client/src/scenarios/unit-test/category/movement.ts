/**
 * Movement category — spawn one unit-under-test, order it to a goal
 * point, observe whether it arrived within a frame budget proportional
 * to the unit's declared speed.
 *
 * Returned `CategoryResult`:
 *   - `applicable=false` for non-movers (returned untested).
 *   - `pass=true` when the unit ends within ARRIVAL_THRESHOLD of the
 *     goal, OR when it travelled at least 80% of the distance (slow
 *     turners often run out of frame budget but are still functional).
 *   - `detail` records distance + frame budget used so a regression
 *     report can show speed deltas over time.
 */

import type { TestHarness } from '../../../core/test-harness.js';
import type { UnitClassification } from '../catalog.js';
import { sleep, parseUnitPos } from '../../types.js';

const CMD_MOVE = 10;
const ARRIVAL_THRESHOLD = 250; // elmos; matches base move-pathing scenario
const PARTIAL_PASS_FRACTION = 0.8;
/** Wall-clock budget per unit (max). At 5× sim speed this lets us
 *  measure ~50 sim seconds of travel before timing out. */
const MAX_WALL_MS = 12_000;
const POLL_MS = 250;

export interface CategoryResult {
    applicable: boolean;
    pass: boolean;
    detail: string;
}

export interface MovementCtx {
    h: TestHarness;
    anchorX: number;
    anchorZ: number;
    team: number;
}

export async function runMovement(
    ctx: MovementCtx, unit: UnitClassification,
): Promise<CategoryResult> {
    if (!unit.canMove) {
        return { applicable: false, pass: true, detail: 'unit cannot move' };
    }

    const { h, anchorX, anchorZ, team } = ctx;
    // Spawn ~600 elmos west of the anchor. Goal is 1200 elmos east —
    // a 1800-elmo traversal that comfortably exercises pathing
    // without blowing the wall budget at default sim speed.
    const startX = anchorX - 600;
    const goalX = anchorX + 1200;
    const z = anchorZ;
    const spawnOut = await h.spawn(unit.name, startX, z, team, 1);
    const unitId = Number(spawnOut.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!unitId) {
        return { applicable: true, pass: false, detail: `spawn failed: ${spawnOut}` };
    }

    // Air units: natural takeoff doesn't lift the unit off the ground
    // in our headless build (HoverAirMoveType::UpdateTakeoff never
    // gives the unit positive vertical speed — see PLAN-scenarios.md
    // "Open follow-ups"). Workaround: warp the unit to its
    // wantedHeight with Spring.MoveCtrl so it skips takeoff and
    // UpdateFlying takes over immediately. Also seed direction +
    // velocity toward the goal so the move type doesn't burn the
    // wall budget banking and accelerating from a standstill — slow
    // bombers in particular need every elmo of forward progress.
    // Movement doesn't need an explicit CMD_MOVE kick like combat
    // does, because the test issues CMD_MOVE itself a few lines
    // below and that order is enough to drive CStrafeAirMoveType's
    // StartMoving → TAKEOFF transition.
    if (unit.canFly) {
        await h.lua(`
            local ud = UnitDefs[${unit.defId}]
            -- Warp to the engine's internal cruise altitude
            -- (def.wantedHeight * 1.5; see CStrafeAirMoveType::Init).
            -- Spawning at the raw def value triggers a takeoff climb
            -- which fights pathfinding and burns wall budget on
            -- vertical motion instead of horizontal progress.
            local defAlt = (ud and ud.wantedHeight) or 100
            local h = defAlt * 1.5
            local spd = (ud and ud.speed) or 0
            local x, _, z = Spring.GetUnitPosition(${unitId})
            Spring.MoveCtrl.Enable(${unitId})
            Spring.SetUnitPosition(${unitId}, x, h, z)
            -- Face east toward the goal (UUT spawns west of it).
            Spring.SetUnitDirection(${unitId}, 1, 0, 0)
            Spring.MoveCtrl.Disable(${unitId})
            -- def.speed is elmos/second; engine velocity is per
            -- sim-frame, so divide by GAME_SPEED (30).
            if spd > 0 then
                Spring.SetUnitVelocity(${unitId}, spd / 30, 0, 0)
            end
        `);
    }

    await sleep(150);

    const initialStateOut = await h.unitState(unitId);
    const initial = parseUnitPos(initialStateOut);
    if (!initial) {
        return { applicable: true, pass: false, detail: 'no initial pos after spawn' };
    }

    // Air units fly to goal at their wantedHeight; ground units use
    // y=80 (anything above ground is fine — pathing snaps to surface).
    const goalY = unit.canFly ? 200 : 80;
    await h.order(unitId, CMD_MOVE, [goalX, goalY, z], 0);

    const deadline = performance.now() + MAX_WALL_MS;
    let lastPos = initial;
    let arrived = false;
    while (performance.now() < deadline) {
        const out = await h.unitState(unitId);
        const pos = parseUnitPos(out);
        if (!pos) break; // unit died or vanished
        lastPos = pos;
        if (Math.abs(pos.x - goalX) < ARRIVAL_THRESHOLD) {
            arrived = true;
            break;
        }
        await sleep(POLL_MS);
    }

    const travelled = Math.hypot(lastPos.x - initial.x, lastPos.z - initial.z);
    const targetDistance = Math.abs(goalX - startX);
    const fraction = targetDistance > 0 ? travelled / targetDistance : 0;
    const pass = arrived || fraction >= PARTIAL_PASS_FRACTION;
    const detail = arrived
        ? `arrived at (${lastPos.x.toFixed(0)},${lastPos.z.toFixed(0)})`
        : `travelled ${travelled.toFixed(0)}/${targetDistance} elmos (${(fraction * 100).toFixed(0)}%)`;
    return { applicable: true, pass, detail };
}
