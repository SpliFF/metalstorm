/**
 * Combat category — spawn the unit-under-test next to a fragile target,
 * give attack order, then classify the result.
 *
 * Three nested outcomes (most-strict to most-lenient):
 *   1. **hit** — target HP dropped. Means aim + weapon piece bindings
 *      work end-to-end.
 *   2. **fired** — the weapon's `reloadFrame` advanced past the spawn
 *      baseline. Means the firing path runs but the projectile/beam
 *      missed (likely the well-known ZK piece-binding gap that affects
 *      most mobile units — see PLAN-scenarios.md open follow-ups).
 *   3. **acquired** — `hasTarget` flipped true on at least one weapon
 *      but the reload counter never moved. Useful "did targetting work
 *      at all" diagnostic.
 *
 * Pass = at least `acquired`. A unit that can't even acquire is broken
 * (no LOS, weapon disabled, wrong team filter, target outside range).
 * The detail string records which level the unit reached so the report
 * can grade units by combat tier.
 */

import type { TestHarness } from '../../../core/test-harness.js';
import type { UnitClassification } from '../catalog.js';
import { sleep, parseUnitField } from '../../types.js';

const CMD_ATTACK = 20;
const CMD_FIRE_STATE = 45;
const CMD_MOVE_STATE = 50;
/** Wall ms to observe firing. At 5× sim speed this covers ~30 sim
 *  seconds — long enough for slow-cycle weapons (e.g. siege artillery)
 *  to get one shot off. */
const OBS_WALL_MS = 6000;
/** Distance from unit-under-test to the dummy target. Picked small
 *  enough that nearly every weapon is in range, large enough that
 *  splash from the unit's own death-on-spawn (rare) doesn't kill
 *  the dummy. */
const TARGET_OFFSET = 200;
/** Stationary punching-bag def. `staticheavyradar` has a big HP pool
 *  (~3500) so a single shot won't outright delete it, and it sits at
 *  ground level on land (no water dependency). */
const TARGET_DEF = 'staticheavyradar';
const TARGET_HP_FALLBACK = 1; // assertion bound — any drop counts

export interface CategoryResult {
    applicable: boolean;
    pass: boolean;
    detail: string;
}

export interface CombatCtx {
    h: TestHarness;
    anchorX: number;
    anchorZ: number;
    team: number;
    /** Team the dummy target spawns on. Must differ from `team` so
     *  hostile targeting works without explicit alliance setup. */
    enemyTeam: number;
}

export async function runCombat(
    ctx: CombatCtx, unit: UnitClassification,
): Promise<CategoryResult> {
    if (!unit.canShoot) {
        return { applicable: false, pass: true, detail: 'unit has no offensive weapon' };
    }

    const { h, anchorX, anchorZ, team, enemyTeam } = ctx;

    // Target sits 800 elmos east of the anchor; UUT spawns 200 elmos
    // west of the target (so 600 east of the anchor). This clears the
    // mex cluster (easternmost mex is at anchor + 220, so the UUT now
    // has 380 elmos of breathing room — units no longer spawn on top
    // of a mex). 200-elmo UUT↔target gap keeps most ZK weapons (range
    // 250–800) in range from frame 1 without a chase.
    const targetX = anchorX + 800;
    const targetZ = anchorZ;
    const utX = targetX - TARGET_OFFSET;
    const utZ = targetZ;

    const tSpawn = await h.spawn(TARGET_DEF, targetX, targetZ, enemyTeam, 1);
    const targetId = Number(tSpawn.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!targetId) {
        return { applicable: true, pass: false, detail: `target spawn failed: ${tSpawn}` };
    }
    // Hold-position + hold-fire on the dummy so it doesn't shoot back
    // or wander out of range. Same workaround duel-attack uses for the
    // Phase-4 LuaSyncedCtrl gap (SetUnit{Move,Fire}State not wired).
    try {
        await h.lua(
            `Spring.GiveOrderToUnit(${targetId}, ${CMD_MOVE_STATE}, {0}, 0); `
            + `Spring.GiveOrderToUnit(${targetId}, ${CMD_FIRE_STATE}, {0}, 0)`,
        );
    } catch { /* hold-state failure is non-fatal */ }

    const utSpawn = await h.spawn(unit.name, utX, utZ, team, 1);
    const utId = Number(utSpawn.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!utId) {
        return { applicable: true, pass: false, detail: `unit spawn failed: ${utSpawn}` };
    }

    // Settle 1 sim tick so the unit's weapon refs initialise.
    await sleep(150);

    const beforeT = await h.unitState(targetId);
    const beforeHp = Number(parseUnitField(beforeT, 'hp')?.split('/')[0] ?? TARGET_HP_FALLBACK);
    const beforeUt = await h.unitState(utId);
    const beforeReload = parseFirstReload(beforeUt);

    await h.order(utId, CMD_ATTACK, [targetId]);

    // Poll a few times to catch the earliest interesting state change.
    let acquired = false;
    let fired = false;
    let hit = false;
    let finalHp = beforeHp;
    let finalReload = beforeReload;
    const deadline = performance.now() + OBS_WALL_MS;
    while (performance.now() < deadline) {
        const tState = await h.unitState(targetId);
        if (!/id=\d+/.test(tState)) break; // target died — definitely hit
        const hp = Number(parseUnitField(tState, 'hp')?.split('/')[0] ?? TARGET_HP_FALLBACK);
        finalHp = hp;
        if (hp < beforeHp) { hit = true; break; }

        const utState = await h.unitState(utId);
        if (!/id=\d+/.test(utState)) break; // attacker died
        if (/hasTarget=yes/.test(utState)) acquired = true;
        const reload = parseFirstReload(utState);
        if (reload !== null) {
            finalReload = reload;
            if (beforeReload !== null && reload > beforeReload + 1) fired = true;
        }
        await sleep(400);
    }

    // Clean up so the next unit doesn't inherit the dummy target.
    try { await h.lua(`Spring.DestroyUnit(${targetId}, false, true)`); } catch {}

    const tier = hit ? 'hit' : fired ? 'fired' : acquired ? 'acquired' : 'inert';
    const pass = hit || fired || acquired;
    const reloadDelta = (beforeReload != null && finalReload != null)
        ? finalReload - beforeReload : null;
    const detail = `tier=${tier} hpΔ=${(beforeHp - finalHp).toFixed(0)}`
        + (reloadDelta !== null ? ` reloadΔ=${reloadDelta.toFixed(0)}` : '');
    return { applicable: true, pass, detail };
}

/**
 * Pull the first weapon's `reloadFrame` value from a unit_state dump.
 * The verb formats weapons as `w0 def=... range=... reloadFrame=N ...`.
 */
function parseFirstReload(text: string): number | null {
    const m = text.match(/w0\b[^\n]*reloadFrame=(-?\d+)/);
    return m ? Number(m[1]) : null;
}
