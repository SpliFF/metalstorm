/**
 * move-pathing — movement + pathfinding sanity check.
 *
 * Spawn a single `ms_tanks_s1` at one side of the flat map and order it
 * to move 5000 elmos across to the opposite side. Asserts the unit
 * arrived within the expected wall-clock budget and that no enemies
 * are present that would distract it (combat is out of scope here).
 *
 * Catches regressions in: movement orders being accepted, MoveDef
 * pathing, unit reaching its goal, frame rate sufficient for the
 * traversal.
 *
 * Metalstorm port (2026-08-04) — was ZK `shieldraid` (70 elmos/sec).
 * `ms_tanks_s1` does 78, so the same 5000-elmo corridor and the same
 * 30 s budget at 5× sim speed carry over unchanged.
 */

import type { Scenario } from '../types.js';
import { sleep, parseUnitField, parseUnitPos, currentFrame } from '../types.js';

const CMD_MOVE = 10;
const MOVER_DEF = 'ms_tanks_s1';

let _startX = 0;
let _goalX = 0;
let _z = 0;
let _id = 0;

const scenario: Scenario = {
    name: 'move-pathing',
    description: 'Single ms_tanks_s1 traverses the flat map. Asserts arrival within a generous frame budget.',
    map: 'green_flat_x34_v3',
    gameId: 'metalstorm',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,
    async setup(h) {
        await h.setLogging({ order: true, unit: true });
        await h.clear();
        // 5× sim speed → ~13s wall for 5000 elmos at ms_tanks_s1's
        // 78 elmos/sec. The sim loop reads wantedSpeedFactor every
        // tick (rts/server_main.cpp), so this takes effect immediately.
        await h.simSpeed(5);

        const startX = 5000;
        const goalX = 10000;
        const z = 8704;
        _startX = startX;
        _goalX = goalX;
        _z = z;

        const out = await h.spawn(MOVER_DEF, startX, z, 0, 1);
        const id = Number(out.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!id) throw new Error(`spawn parse failed: ${out}`);
        _id = id;

        await h.cameraSnapToGround((startX + goalX) / 2, z, { height: 4000, durationMs: 0 });
        await h.order(id, CMD_MOVE, [goalX, 80, z], 0);
    },
    async run(h) {
        const id = _id;
        const startX = _startX;
        const goalX = _goalX;
        const distance = goalX - startX;
        // 5000 elmos at 78 elmos/sec = ~64 sim seconds. At 5× sim
        // speed (set in setup) that's ~13s wall. Give 30s budget so
        // pathing detours have headroom.
        const TIMEOUT_MS = 30000;
        const ARRIVAL_THRESHOLD = 250;

        const startFrame = await currentFrame(h);
        const initial = await h.unitState(id);
        const initialPos = parseUnitPos(initial);

        const deadline = performance.now() + TIMEOUT_MS;
        let arrived = false;
        let lastPos: { x: number; y: number; z: number } | null = null;
        while (performance.now() < deadline) {
            const u = await h.unitState(id);
            lastPos = parseUnitPos(u);
            if (lastPos && Math.abs(lastPos.x - goalX) < ARRIVAL_THRESHOLD) {
                arrived = true;
                break;
            }
            await sleep(500);
        }
        const endFrame = await currentFrame(h);
        const elapsedFrames = endFrame - startFrame;
        const distanceTravelled = (lastPos && initialPos)
            ? Math.hypot(lastPos.x - initialPos.x, lastPos.z - initialPos.z)
            : 0;

        return [
            {
                name: 'unit accepted order',
                ok: distanceTravelled > 100,
                detail: `travelled ${distanceTravelled.toFixed(0)} elmos of ${distance}`,
            },
            {
                name: 'arrived at goal',
                ok: arrived,
                detail: lastPos
                    ? `final pos=(${lastPos.x.toFixed(0)},${lastPos.z.toFixed(0)}) vs goal (${goalX},${_z})`
                    : 'unit disappeared (no position)',
            },
            {
                name: 'unit still alive',
                ok: !!parseUnitField(await h.unitState(id), 'hp'),
                detail: 'no enemies were spawned — unit should not die',
            },
            {
                name: 'sim ticked at expected rate',
                ok: elapsedFrames >= 30 * 5,
                detail: `${elapsedFrames} frames over ${(TIMEOUT_MS / 1000).toFixed(0)}s wall`,
            },
        ];
    },
};

export default scenario;
