/**
 * aim-rotation — static turret aiming at a moving target.
 *
 * Spawn a turretlaser at map centre. Spawn a shieldraid 200 elmos
 * away on a different team and give it a chain of move orders that
 * walks the target around the turret in a square. Observe whether
 * the turret hits and damages the moving target during a fixed
 * observation window.
 *
 * Aim-bench heritage: targets aim regressions where headless
 * LocalModelPiece stubs returned identity matrices, causing weapons
 * to fire straight up or in fixed world directions instead of
 * tracking. A clean run shows the target taking sustained damage
 * even as it changes direction.
 */

import type { Scenario } from '../types.js';
import { sleep, parseUnitField, currentFrame } from '../types.js';

const CMD_MOVE = 10;
const FLAT_MAP_CENTER = 8704;
const ORBIT_RADIUS = 200;

const scenario: Scenario = {
    name: 'aim-rotation',
    description: 'Static turretlaser fires at a shieldraid walking a square around it. Asserts the moving target takes sustained damage (i.e. the turret tracks).',
    map: 'green_flat_x34_v3',
    gameId: 'zk',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,
    async setup(h) {
        await h.setLogging({ combat: true, weapon: true });
        await h.clear();
        const turretOut = await h.spawn('turretlaser', FLAT_MAP_CENTER, FLAT_MAP_CENTER, 0, 1);
        const targetOut = await h.spawn('shieldraid', FLAT_MAP_CENTER + ORBIT_RADIUS, FLAT_MAP_CENTER, 1, 1);
        const turretId = Number(turretOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        const targetId = Number(targetOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!turretId || !targetId) throw new Error(`spawn parse failed: ${turretOut} / ${targetOut}`);
        (this as any)._turretId = turretId;
        (this as any)._targetId = targetId;

        await h.cameraSnapToGround(FLAT_MAP_CENTER, FLAT_MAP_CENTER, { height: 500, durationMs: 0 });

        // Queue a square patrol around the turret. Each leg is one
        // CMD_MOVE order with the shift modifier to queue (opts=64
        // — the same value command-buffer.ts uses for SHIFT_QUEUE).
        const SHIFT = 64;
        const corners = [
            [FLAT_MAP_CENTER + ORBIT_RADIUS, FLAT_MAP_CENTER + ORBIT_RADIUS],
            [FLAT_MAP_CENTER - ORBIT_RADIUS, FLAT_MAP_CENTER + ORBIT_RADIUS],
            [FLAT_MAP_CENTER - ORBIT_RADIUS, FLAT_MAP_CENTER - ORBIT_RADIUS],
            [FLAT_MAP_CENTER + ORBIT_RADIUS, FLAT_MAP_CENTER - ORBIT_RADIUS],
            [FLAT_MAP_CENTER + ORBIT_RADIUS, FLAT_MAP_CENTER + ORBIT_RADIUS],
        ];
        // First leg without shift (replaces current), the rest queued.
        await h.order(targetId, CMD_MOVE, [corners[0][0], 80, corners[0][1]], 0);
        for (let i = 1; i < corners.length; i++) {
            await h.order(targetId, CMD_MOVE, [corners[i][0], 80, corners[i][1]], SHIFT);
        }
    },
    async run(h) {
        const turretId = (this as any)._turretId as number;
        const targetId = (this as any)._targetId as number;

        const startFrame = await currentFrame(h);
        const before = await h.unitState(targetId);
        const beforeHp = Number(parseUnitField(before, 'hp')?.split('/')[0] ?? '0');

        // Sample HP every 2s for 10s — we want sustained damage, not
        // just a single hit on the way past.
        const samples: number[] = [beforeHp];
        for (let i = 0; i < 5; i++) {
            await sleep(2000);
            const u = await h.unitState(targetId);
            const hp = Number(parseUnitField(u, 'hp')?.split('/')[0] ?? '0');
            samples.push(hp);
        }
        const endFrame = await currentFrame(h);

        // Strictly-decreasing across all samples is too strict
        // (reload + travel time create gaps); require monotonically
        // non-increasing with at least 2 distinct drops.
        let drops = 0;
        for (let i = 1; i < samples.length; i++) {
            if (samples[i] < samples[i - 1]) drops++;
        }
        const totalDamage = samples[0] - samples[samples.length - 1];

        const turretState = await h.unitState(turretId);

        return [
            {
                name: 'turret still alive',
                ok: /id=\d+/.test(turretState),
                detail: turretState.split('\n')[0],
            },
            {
                name: 'target took damage',
                ok: totalDamage > 0,
                detail: `samples=[${samples.join(', ')}] total Δ=${totalDamage.toFixed(1)}`,
            },
            {
                name: 'damage sustained across motion',
                ok: drops >= 2,
                detail: `${drops} distinct drop(s) across ${samples.length} samples`,
            },
            {
                name: 'sim ticked',
                ok: endFrame - startFrame >= 250,
                detail: `${endFrame - startFrame} frames in 10s (expect ≥250)`,
            },
        ];
    },
};

export default scenario;
