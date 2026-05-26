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
/** Wall ms budget for bombers — they need to fly past the target,
 *  swing back round and line up the drop. 18s × 5× sim speed = ~90
 *  sim seconds, room for two full passes on the slowest bombers. */
const BOMBER_OBS_WALL_MS = 18000;
/** Distance from unit-under-test to the dummy target. Picked small
 *  enough that nearly every weapon is in range, large enough that
 *  splash from the unit's own death-on-spawn (rare) doesn't kill
 *  the dummy. */
const TARGET_OFFSET = 200;
/** Approach distance for non-bomber air UUTs. Far enough that the
 *  unit isn't already in weapon-min-range, close enough that the
 *  attacker reaches the target before OBS_WALL_MS expires. */
const AIR_APPROACH_OFFSET = 600;
/** Approach distance for bomber-class UUTs. AircraftBomb weapons
 *  drop with gravity-fall — `CBombDropper::TestRange` requires the
 *  bomber to be flying such that `pos + velocity * fallTime` lands
 *  on the target. At cruise altitude ~180 and gravity 9.8, fall
 *  time is ~6 sim seconds, so a 240-elmo/sec bomber needs to start
 *  the drop ~1450 elmos away. We spawn at 3000 elmos so the bomber
 *  has a long straight approach before reaching drop range, plus
 *  budget for one full circle-back if the first pass misses. */
const BOMBER_APPROACH_OFFSET = 3000;
/** Wall ms to let the target (and its hold-state orders) register
 *  before we drop the UUT into the world. Avoids the UUT issuing
 *  CMD_ATTACK on a target whose visibility/LOS/team allocations
 *  the sim hasn't fully wired yet. */
const TARGET_SETTLE_MS = 200;
/** Stationary punching-bag def. `staticheavyradar` sits at ground
 *  level on land (no water dependency). Its declared HP is only 330,
 *  which trips ZK's per-attacker `OverkillPrevention_CheckBlockNoFire`
 *  for any weapon with `okp_damage >= 330` (most bombers, anti-air,
 *  heavy artillery). We crank max-HP to TARGET_HP_BOOST after spawn so
 *  OKP stays silent and we measure raw weapon delivery, not the OKP
 *  gating decision. */
const TARGET_DEF = 'staticheavyradar';
/** Bigger target used for the bomber-runway profile. `factoryplane` is
 *  16×14 footprint (vs the radar's 4×4) so near-miss bomb drops still
 *  land impulse + splash on it, and — crucially — `factoryplane` is a
 *  ZK airpad, so the bomber can rearm on the same building it's been
 *  ordered to attack. Without this, every bomber drops one bomb, flies
 *  off toward the nearest pad (often nothing), and the test only ever
 *  sees a single fly-by. */
const BOMBER_TARGET_DEF = 'factoryplane';
/** Boosted max-HP for the target. Picked well above the largest
 *  `okp_damage` value in ZK (`turretaaheavy` = 1600) plus comfortable
 *  headroom for multi-shot salvos. */
const TARGET_HP_BOOST = 50000;
/** Air target used when the UUT only has AA weapons. Drone has 360 HP,
 *  spawns cheap, and gets MoveCtrl-pinned to altitude so AA testers
 *  don't have to chase it. Same OKP boost applied. */
const AIR_TARGET_DEF = 'dronefighter';
const AIR_TARGET_ALT = 200;
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

    // Probe the UUT's weapons to decide: ground-attack target (default),
    // air-only target (for AA units), or bomber-runway profile (for
    // AircraftBomb weapons that need to fly over the target). The
    // catalog only carries a boolean canShoot — per-weapon flags
    // (canAttackGround, onlyTargetCategory, weaponType) live in the
    // WeaponDef.
    const wInfoRaw = await h.lua(`
        local ud = UnitDefs[${unit.defId}]
        if not ud or not ud.weapons then return 'none' end
        local canGround, canAir, hasBomb = false, false, false
        for _, w in ipairs(ud.weapons) do
            local wd = w and w.weaponDef and WeaponDefs[w.weaponDef]
            if wd then
                -- canAttackGround defaults to true; explicit false means AA-only
                if wd.canAttackGround ~= false then canGround = true end
                -- onlyTargets / onlyTargetCategory hint at AA when 'vtol' is set
                local otc = wd.onlyTargetCategory or ''
                if (wd.canAttackGround == false)
                    or (type(otc) == 'string' and otc:lower():find('vtol'))
                    or wd.targetMoveErrorMult then
                    canAir = true
                end
                -- Engine-level bomber signal. CBombDropper needs a
                -- physical fly-over, not just LOS+range.
                if wd.type == 'AircraftBomb' then hasBomb = true end
            end
        end
        local tag = (canGround and 'G' or '') .. (canAir and 'A' or '')
        if hasBomb then tag = tag .. 'B' end
        return tag
    `);
    const targetsGround = /G/.test(wInfoRaw);
    const isBomber = /B/.test(wInfoRaw);
    // AA-only when no ground-attack weapon was declared. Bombers
    // always attack ground regardless of secondary AA weapons.
    const useAirTarget = !targetsGround && !isBomber;

    // Target sits 800 elmos east of the anchor. UUT placement depends
    // on what it is:
    //   - ground UUT: 200 elmos west of target (most ZK weapon ranges
    //     250–800 are in range from frame 1; clears the mex cluster
    //     since easternmost mex is at anchor + 220 and UUT lands at
    //     anchor + 600).
    //   - non-bomber air UUT: 600 elmos west of target — far enough
    //     out that the unit isn't in min-range yet, close enough that
    //     it acquires within the standard observation window.
    //   - bomber UUT: 1500 elmos west of target so it has runway for
    //     the AircraftBomb fly-over (see TestRange in BombDropper.cpp).
    const targetX = anchorX + 800;
    const targetZ = anchorZ;
    const utOffset = isBomber
        ? BOMBER_APPROACH_OFFSET
        : unit.canFly ? AIR_APPROACH_OFFSET : TARGET_OFFSET;
    const utX = targetX - utOffset;
    const utZ = targetZ;

    const targetDef = useAirTarget ? AIR_TARGET_DEF
        : isBomber ? BOMBER_TARGET_DEF
        : TARGET_DEF;
    const tSpawn = await h.spawn(targetDef, targetX, targetZ, enemyTeam, 1);
    const targetId = Number(tSpawn.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!targetId) {
        return { applicable: true, pass: false, detail: `target spawn (${targetDef}) failed: ${tSpawn}` };
    }
    // Boost target HP so ZK's overkill-prevention gadget doesn't block
    // high-damage UUTs (e.g. bomberassault's 2500-dmg bomb, anti-air
    // turrets with okp_damage 1600). Without this the bomber dives in,
    // gets BlockShot=true, and the test scores `inert` for a weapon
    // that would otherwise pass.
    try {
        await h.lua(
            `Spring.SetUnitMaxHealth(${targetId}, ${TARGET_HP_BOOST}); `
            + `Spring.SetUnitHealth(${targetId}, { health = ${TARGET_HP_BOOST} })`,
        );
    } catch { /* non-fatal — test will just see OKP-gated misses */ }
    if (useAirTarget) {
        // Lift the air target to fixed altitude with MoveCtrl-enabled
        // (the natural takeoff path doesn't fire — see PLAN-scenarios
        // "Open follow-ups"). Leave MoveCtrl ON so the target stays put
        // throughout the test instead of trying to land or drift.
        try {
            await h.lua(`
                Spring.MoveCtrl.Enable(${targetId})
                Spring.SetUnitPosition(${targetId}, ${targetX}, ${AIR_TARGET_ALT}, ${targetZ})
            `);
        } catch { /* MoveCtrl unavailable on some builds */ }
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

    // Let the target's spawn + hold-state settle into the world
    // before the UUT spawns. Without this, fast-moving aircraft
    // sometimes issue CMD_ATTACK against a target whose LOS / team
    // wiring hasn't finished propagating and acquire fails on
    // frame 1, scoring `inert` for a perfectly healthy weapon.
    await sleep(TARGET_SETTLE_MS);

    const utSpawn = await h.spawn(unit.name, utX, utZ, team, 1);
    const utId = Number(utSpawn.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!utId) {
        return { applicable: true, pass: false, detail: `unit spawn failed: ${utSpawn}` };
    }

    // Air UUTs: warp to wantedHeight so they're in the FLYING state
    // by the time we issue CMD_ATTACK (natural takeoff doesn't lift
    // them — same workaround as the movement category). Also point
    // them east and seed their velocity to def.speed, so the move
    // type doesn't burn observation budget banking + accelerating
    // from a standstill. This matters most for bombers: AircraftBomb
    // only fires if the predicted impact lands on the target while
    // the bomber is in level flight, so a turning bomber rarely
    // drops within the OBS window.
    //
    // The final CMD_MOVE kick is critical for CStrafeAirMoveType
    // (fixed-wing) units. MoveCtrl.Disable on a warped-but-idle
    // bomber leaves aircraftState=LANDED, gravity drops it to
    // ground, and CMD_ATTACK on a LANDED bomber does nothing —
    // only StartMoving (triggered by CMD_MOVE) transitions
    // LANDED → TAKEOFF → FLYING. The move-goal sits 2000 elmos
    // past the target so the bomber doesn't decide to land before
    // CMD_ATTACK overrides the queue.
    if (unit.canFly) {
        // Warp to the engine's true cruise altitude
        // (`def.wantedHeight * 1.5`, matching CStrafeAirMoveType::Init).
        // Spawning lower triggers a climb during the approach, which
        // (a) breaks CBombDropper's fall-time math for bombers and
        // (b) makes the move type drop back to LANDED state when the
        // attack command arrives mid-climb, so the unit falls to the
        // ground and only manages to fire one (often missing) shot
        // before scoring `acquired` instead of `hit`.
        try {
            await h.lua(`
                local ud = UnitDefs[${unit.defId}]
                local defAlt = (ud and ud.wantedHeight) or 100
                local alt = defAlt * 1.5
                local groundY = Spring.GetGroundHeight(${utX}, ${utZ}) or 0
                if alt < groundY + 50 then alt = groundY + defAlt end
                local spd = (ud and ud.speed) or 0
                Spring.MoveCtrl.Enable(${utId})
                Spring.SetUnitPosition(${utId}, ${utX}, alt, ${utZ})
                -- Face east toward the target (UUT is west of target).
                Spring.SetUnitDirection(${utId}, 1, 0, 0)
                Spring.MoveCtrl.Disable(${utId})
                -- def.speed is elmos/second; engine velocity is per
                -- sim-frame, so divide by GAME_SPEED (30).
                if spd > 0 then
                    Spring.SetUnitVelocity(${utId}, spd / 30, 0, 0)
                end
                Spring.GiveOrderToUnit(${utId}, 10, {${utX + 2000}, alt, ${utZ}}, 0)
            `);
        } catch { /* MoveCtrl unavailable */ }
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
    const obsBudget = isBomber ? BOMBER_OBS_WALL_MS : OBS_WALL_MS;
    const deadline = performance.now() + obsBudget;
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
    const targetTag = useAirTarget ? ' [air-target]' : '';
    const profileTag = isBomber ? ' [bomber-runway]'
        : unit.canFly ? ' [air-warm-start]' : '';
    const detail = `tier=${tier} hpΔ=${(beforeHp - finalHp).toFixed(0)}`
        + (reloadDelta !== null ? ` reloadΔ=${reloadDelta.toFixed(0)}` : '')
        + targetTag + profileTag;
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
