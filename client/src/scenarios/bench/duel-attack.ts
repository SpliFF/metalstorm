/**
 * duel-attack — 1v1 combat path sanity check.
 *
 * Spawn one `ms_mechs_s1` on team 0 and one on team 1, 150 elmos apart,
 * and order team 0 to attack. Within a 5-second window the attacker
 * should acquire its target and its autocannon should land damage.
 *
 * Metalstorm port (2026-08-04). Was ZK `shieldraid` vs `shieldraid` with
 * a laser; ZK is archived (PLAN.md "The goal"), so this is a rewrite
 * against Metalstorm defs, not a `gameId` swap. `ms_mechs_s1` carries
 * MS_MG_S2 — range 380, ~90 damage a shot — so the pair is in range from
 * frame 1 at 150 elmos and neither has to pursue.
 *
 * The assertion is "took damage", not "died", deliberately: at 900 HP a
 * mech survives the window comfortably, so the test measures a real HP
 * delta instead of racing a kill. A destroy still passes (the delta is
 * then the full bar) — it just isn't required, which keeps the result
 * stable if weapon balance moves.
 *
 * No pre-setup `cheats on` / `revive_team all` here or in the runner:
 * that was a ZK game_over.lua workaround and Metalstorm has no gadget
 * that flags unit-less teams dead (see runner.ts).
 */

import type { Scenario } from '../types.js';
import { sleep, parseUnitField, currentFrame } from '../types.js';

const CMD_ATTACK = 20;
/** green_flat_x34_v3 is 17408×17408 elmos. */
const FLAT_MAP_CENTER = 8704;
/** Half-separation. MS_MG_S2 reaches 380, so 150 total keeps both
 *  inside range with margin for the spawn scatter. */
const HALF_SEPARATION = 75;
const COMBATANT = 'ms_mechs_s1';

let _aId = 0;
let _tId = 0;

const scenario: Scenario = {
    name: 'duel-attack',
    description: '1v1 ms_mechs_s1 attacker vs a held-still ms_mechs_s1 target. Asserts the attacker acquires and lands damage inside the observation window.',
    map: 'green_flat_x34_v3',
    gameId: 'metalstorm',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,
    async setup(h) {
        await h.setLogging({ combat: true, weapon: true });
        await h.clear();
        const aOut = await h.spawn(COMBATANT, FLAT_MAP_CENTER - HALF_SEPARATION, FLAT_MAP_CENTER, 0, 1);
        const tOut = await h.spawn(COMBATANT, FLAT_MAP_CENTER + HALF_SEPARATION, FLAT_MAP_CENTER, 1, 1);
        const aId = Number(aOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        const tId = Number(tOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!aId || !tId) throw new Error(`spawn parse failed: ${aOut} / ${tOut}`);
        _aId = aId;
        _tId = tId;
        // Hold-position + hold-fire the target so it's a stationary dummy:
        // it stays in range for the whole window and doesn't turn the test
        // into a mutual chase. Spring.SetUnit{Move,Fire}State aren't wired
        // into our LuaSyncedCtrl yet (Phase 4 API gap), so use the
        // CMD_*_STATE order verbs. 50 = CMD_MOVE_STATE (0=Hold),
        // 45 = CMD_FIRE_STATE (0=HoldFire).
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

        // Sample the attacker's targeting state mid-window rather than at
        // the end: if the target does die early, `hasTarget` goes back to
        // no and a late sample would read as "never acquired". 750ms is
        // ~22 sim frames, well past the first reload.
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
