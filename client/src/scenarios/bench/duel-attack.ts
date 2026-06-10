/**
 * duel-attack — 1v1 combat path sanity check.
 *
 * Spawn one shieldraid (Bandit) on team 0 and one on the opposing
 * NullAI team. Order team 0 to attack team 1. Within a 5-second
 * observation window the attacker should acquire its target and the
 * laser should deal lethal damage (shieldraid HP 340, laser DPS well
 * over that across the window).
 *
 * Dead-team note: the runner enables cheats + `revive_team all` before
 * setup. ZK's game_over.lua otherwise flags teams 0 and 1 isDead at
 * frame 45 (no units → alliance destroyed), and Spring.CreateUnit on
 * a dead team raises a Lua error that aborts the spawn snippet. With
 * cheats on the periodic check returns early, and with isDead reset
 * the fast `CreateUnit(team)` path works.
 */

import type { Scenario } from '../types.js';
import { sleep, parseUnitField, currentFrame } from '../types.js';

const CMD_ATTACK = 20;
const FLAT_MAP_CENTER = 8704; // green_flat_x34_v3 is 17408×17408 elmos

let _aId = 0;
let _tId = 0;

const scenario: Scenario = {
    name: 'duel-attack',
    description: '1v1 shieldraid attacker vs shieldraid target. Asserts target took damage and a shot was fired within the observation window.',
    map: 'green_flat_x34_v3',
    gameId: 'zk',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,
    async setup(h) {
        await h.setLogging({ combat: true, weapon: true });
        await h.clear();
        // Place attacker and target straddling map centre. shieldraid
        // weapon range is 232; with 150 elmo separation the attacker is
        // already in range from the first frame and doesn't need to
        // pursue. The target is held stationary + fire-disabled so
        // (a) it stays in range for the whole window and (b) it doesn't
        // pursue the attacker, which previously turned the test into
        // a 700-elmo chase neither could resolve before the timeout.
        const aOut = await h.spawn('shieldraid', FLAT_MAP_CENTER - 75, FLAT_MAP_CENTER, 0, 1);
        const tOut = await h.spawn('shieldraid', FLAT_MAP_CENTER + 75, FLAT_MAP_CENTER, 1, 1);
        const aId = Number(aOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        const tId = Number(tOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!aId || !tId) throw new Error(`spawn parse failed: ${aOut} / ${tOut}`);
        _aId = aId;
        _tId = tId;
        // Hold-position + hold-fire the target so it's a stationary dummy.
        // Spring.SetUnit{Move,Fire}State aren't wired into our LuaSyncedCtrl
        // yet (Phase 4 API gap); use the CMD_*_STATE order verbs instead.
        // 50 = CMD_MOVE_STATE (0=Hold), 45 = CMD_FIRE_STATE (0=HoldFire).
        await h.lua(`Spring.GiveOrderToUnit(${tId}, 50, {0}, 0); Spring.GiveOrderToUnit(${tId}, 45, {0}, 0)`);
        // Camera framing so screenshots are useful.
        await h.cameraSnapToGround(FLAT_MAP_CENTER, FLAT_MAP_CENTER, { height: 600, durationMs: 0 });
        h.select([aId]);
        await h.order(aId, CMD_ATTACK, [tId]);
    },
    async run(h) {
        const aId = _aId;
        const tId = _tId;

        const startFrame = await currentFrame(h);
        const beforeT = await h.unitState(tId);
        const beforeHp = parseUnitField(beforeT, 'hp')?.split('/')[0];

        // Sample the attacker's targeting state mid-window so it isn't
        // affected by the target dying before the assertions run (the
        // shieldraid kills its dummy in ~1s now that LaserCannon hits
        // land — by the 5s mark the attacker no longer has anything to
        // aim at). 750ms / ~22 frames is well past the first reload.
        await sleep(750);
        const midA = await h.unitState(aId);
        const midHasTarget = /hasTarget=yes/.test(midA);

        await sleep(4250);

        const afterT = await h.unitState(tId);
        const afterHp = parseUnitField(afterT, 'hp')?.split('/')[0];
        const afterA = await h.unitState(aId);
        const endFrame = await currentFrame(h);
        const elapsed = endFrame - startFrame;

        const before = Number(beforeHp ?? '0');
        const after = Number(afterHp ?? '0');
        const targetDestroyed = !/id=\d+/.test(afterT);
        const damageDealt = targetDestroyed ? before : (before - after);

        return [
            {
                name: 'attacker still alive',
                ok: /id=\d+/.test(afterA),
                detail: afterA.split('\n')[0],
            },
            {
                name: 'attacker acquired target',
                ok: midHasTarget,
                detail: midHasTarget ? 'w0 hasTarget=yes (sampled @750ms)' : 'no weapon reports hasTarget=yes',
            },
            {
                name: 'sim advanced',
                ok: elapsed >= 100,
                detail: `${elapsed} frames in 5s wall (expect ≥100)`,
            },
            {
                name: 'target took damage',
                ok: damageDealt > 0,
                detail: targetDestroyed
                    ? `target destroyed (hp ${before} → 0 in ${elapsed} frames)`
                    : `before=${before} after=${after} (Δ=${damageDealt.toFixed(1)})`,
            },
        ];
    },
};

export default scenario;
