/**
 * Recon category — applicable to units with a hard recon extension
 * (radar, sonar, or jammer; raw LOS doesn't count — almost every unit
 * has some LOS, so testing on raw LOS would be noisy and meaningless).
 *
 * Probe layout:
 *   - UUT spawns at the anchor.
 *   - One enemy `shieldraid` probe spawns at ~60% of the largest recon
 *     range, in a direction (east) clear of the economy cluster.
 *   - After a brief settle, `Spring.GetUnitLosState` for the probe is
 *     queried from the player's ally team. Pass when the probe is
 *     either fully in LOS or detected on radar.
 *
 * Notes:
 *   - Jammer units don't *extend* recon — they hide things — so their
 *     probe is a positive/negative control pair instead of a single
 *     detection probe: a "hidden" unit inside the jam radius and a
 *     "control" unit just outside it, both owned by the jammer's own
 *     team, plus an enemy `staticheavyradar` tower placed far enough
 *     away that only its radar circle (not its sight circle) reaches
 *     either one. Pass requires the enemy's radar to miss the hidden
 *     unit *and* see the control unit — proving the jam field is what
 *     made the difference, not a lack of enemy radar coverage.
 *   - Sonar-only units (sonarRadius > 0, radarRadius === 0) can't be
 *     probed on a dry map — a target has to actually be underwater for
 *     sonar to be the thing detecting it. Without `ReconCtx.waterSite`
 *     the test soft-passes with the declared range (today's behaviour
 *     on the dry `unit-test-loop` sandbox). When a caller supplies a
 *     confirmed-deep-water site (see the `recon-sonar` scenario), this
 *     promotes to the same positive/negative shape as the jammer check:
 *     a submersible probe at ~60% of the UUT's sonar radius (should be
 *     seen) and a second one well beyond it (should not — see
 *     SONAR_NEG_FACTOR/SONAR_NEG_FLOOR for why "well beyond" needs more
 *     margin than the declared radius alone suggests), both placed
 *     along the site's verified-deep direction. The UUT itself does not
 *     need to be underwater — sonar coverage originates from the unit's
 *     position regardless of its own terrain; only the *target* being
 *     submerged matters (`LosHandler.cpp` `ILosType::GetRadius` reads
 *     `unit->sonarRadius` unconditionally, and `InRadar`/`InLos` gate
 *     purely on the target's `IsUnderWater()`).
 *   - A fixed set of bot-only/PvE fixture defs (`comm_cai_*`,
 *     `comm_trainer_*`, `comm_hammer`, `chickenbroodqueen`, `chickena`)
 *     detect the negative-control probe regardless of distance —
 *     verified deterministic across repeat full-catalog runs (same
 *     defs, same failure shape, unaffected by a longer inter-iteration
 *     decay wait or a same-probe recheck), so it isn't the margin or a
 *     timing race. `alwaysVisible` is unset on all of them and no
 *     `UnitCreated`/`customParams` hook matching their names was found
 *     in the zk Lua tree, so the exact mechanism is unconfirmed — but
 *     none of these defs are real player-controlled multiplayer units
 *     (AI-practice dummy commanders and Raptor PvE mobs), so a stealth
 *     probe doesn't have a real target to exercise here anyway. See
 *     `recon-sonar.ts`'s `KNOWN_ALWAYS_DETECTED` for the exclusion.
 */

import type { TestHarness } from '../../../core/test-harness.js';
import type { UnitClassification } from '../catalog.js';
import { sleep } from '../../types.js';

const PROBE_DEF = 'shieldraid';
/** Stationary ZK "Advanced Radar" — radarDistance=5600 comfortably
 *  covers every jammer radius in the ZK catalog (max 600), and its
 *  sightDistance=1120 is short enough to keep clear of both jam-test
 *  targets so only the radar bit (not direct sight) is exercised. */
const ENEMY_RADAR_DEF = 'staticheavyradar';
const CMD_FIRE_STATE = 45;
const CMD_MOVE_STATE = 50;
/** Settle time (wall ms at 5× sim speed ≈ 4 sim seconds) — enough for
 *  LOS quads to update once after both units exist. */
const SETTLE_WALL_MS = 800;
/** Fraction of the jammer's radius used to place the "hidden" unit —
 *  well inside the jam field so a partial-radius miss doesn't trip a
 *  false negative. */
const JAM_HIDDEN_FACTOR = 0.5;
/** Fraction of the jammer's radius (plus a flat margin) used to place
 *  the "control" unit just outside the jam field — same enemy radar
 *  coverage, just past the radius that should hide it. */
const JAM_CONTROL_FACTOR = 1.6;
const JAM_CONTROL_MARGIN = 100;
/** Elmos further out than the "hidden" unit to place the enemy radar
 *  tower — past its own 1120-elmo sight range but well inside its
 *  5600-elmo radar range for any jammer radius in the catalog. */
const RADAR_TOWER_OFFSET = 2500;
/** Submersible probe for the sonar water-site check — cheap ZK minisub,
 *  waterline 15 comfortably clears the shallowest confirmed-deep depth
 *  (-15 or deeper) the `recon-sonar` scenario measures before use. */
const WATER_PROBE_DEF = 'subscout';
/** Fraction of the UUT's own sonar radius used to place the "detected"
 *  water probe — mirrors JAM_HIDDEN_FACTOR's "well inside" margin. */
const SONAR_POS_FACTOR = 0.6;
/**
 * Multiplier and flat floor for the "missed" control probe's distance
 * (`max(sonarR * SONAR_NEG_FACTOR, sonarR + SONAR_NEG_FLOOR)`).
 *
 * Live binary-search on a lone `armcom1` (declared sonarRadius=300)
 * found the *actual* detection boundary between real distances 457
 * (still detected) and 493 (not detected) — the true range is ~1.5-1.6x
 * the declared UnitDef field, not 1.0x. A flat `sonarR * 1.5` alone
 * still isn't enough margin for small radii (240-300: the gap needs to
 * be ~160-190 elmos, more than 0.5x of a 240-300 range) — hence the
 * flat-floor term. Root cause unconfirmed (not simple mip-cell
 * quantization: at `radarMipLevel`, the cell size is 32 elmos, far
 * smaller than the ~150-190 elmo excess measured) — treat the
 * declared field as a lower bound on real coverage, not the boundary.
 */
const SONAR_NEG_FACTOR = 1.8;
const SONAR_NEG_FLOOR = 250;

export interface CategoryResult {
    applicable: boolean;
    pass: boolean;
    detail: string;
}

export interface ReconCtx {
    h: TestHarness;
    anchorX: number;
    anchorZ: number;
    team: number;
    enemyTeam: number;
    /**
     * Real underwater test site. When present, promotes the sonar-only
     * soft-pass to a strict positive/negative probe check. `x`/`z` is a
     * confirmed-deep-water point (does not need to be near `anchorX`/
     * `anchorZ` — the UUT is spawned here instead of at the anchor for
     * sonar-only units); `dirX`/`dirZ` is a unit vector along which real
     * water (depth sufficient for `WATER_PROBE_DEF`) extends at least
     * `safeRadius` elmos from that point, as verified by the caller.
     */
    waterSite?: { x: number; z: number; dirX: number; dirZ: number; safeRadius: number };
}

export async function runRecon(
    ctx: ReconCtx, unit: UnitClassification,
): Promise<CategoryResult> {
    const { h, anchorX, anchorZ, team, enemyTeam } = ctx;

    // Pull authoritative radar/sonar/jammer radii — the catalog only
    // tracks a boolean `extendsRecon`, not the actual numbers.
    const radiiRaw = await h.lua(`
        local ud = UnitDefs[${unit.defId}]
        if not ud then return '0,0,0,0' end
        -- %d requires an exact-integer representation (Lua 5.4) and
        -- these fields are sometimes fractional (e.g. losRadius); floor
        -- first rather than format directly.
        return string.format('%d,%d,%d,%d',
            math.floor(ud.radarRadius or 0), math.floor(ud.sonarRadius or 0),
            math.floor(ud.jammerRadius or 0), math.floor(ud.losRadius or 0))
    `);
    const [radarR, sonarR, jammerR, losR] = radiiRaw.split(',').map(Number);
    // Radar is the only positive-detection range we can probe on land
    // (sonar needs an underwater target — the flat sandbox map is dry,
    // so a sonar-only unit gets a soft pass).
    const isJammer = jammerR > 0 && radarR === 0 && sonarR === 0;
    const isSonarOnly = sonarR > 0 && radarR === 0;
    const isApplicable = radarR > 0 || isJammer || isSonarOnly;
    if (!isApplicable) {
        return { applicable: false, pass: true, detail: `no recon ext (los=${losR})` };
    }

    // Sonar-only units need a real underwater target to probe — see the
    // file header. Without a water site, soft-pass as before. With one,
    // the UUT spawns *at* the site instead of the dry anchor (its own
    // terrain doesn't matter — see header) and this branch returns
    // early, skipping the generic dry-anchor spawn below entirely.
    if (isSonarOnly) {
        if (!ctx.waterSite) {
            return {
                applicable: true, pass: true,
                detail: `sonar-only r=${sonarR} (soft: needs water probe)`,
            };
        }
        const { x: siteX, z: siteZ, dirX, dirZ, safeRadius } = ctx.waterSite;
        const posDist = Math.round(sonarR * SONAR_POS_FACTOR);
        const negDist = Math.round(Math.max(sonarR * SONAR_NEG_FACTOR, sonarR + SONAR_NEG_FLOOR));
        if (negDist > safeRadius) {
            return {
                applicable: true, pass: true,
                detail: `sonar-only r=${sonarR} (soft: exceeds ${safeRadius}-elmo water site)`,
            };
        }

        const uutOut = await h.spawn(unit.name, siteX, siteZ, team, 1);
        const uutId = Number(uutOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!uutId) return { applicable: true, pass: false, detail: `spawn failed: ${uutOut}` };

        const posX = siteX + dirX * posDist;
        const posZ = siteZ + dirZ * posDist;
        const negX = siteX + dirX * negDist;
        const negZ = siteZ + dirZ * negDist;
        const posOut = await h.spawn(WATER_PROBE_DEF, posX, posZ, enemyTeam, 1);
        const posId = Number(posOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        const negOut = await h.spawn(WATER_PROBE_DEF, negX, negZ, enemyTeam, 1);
        const negId = Number(negOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!posId || !negId) {
            for (const id of [uutId, posId, negId]) {
                if (id) { try { await h.lua(`Spring.DestroyUnit(${id}, false, true)`); } catch {} }
            }
            return {
                applicable: true, pass: false,
                detail: `water probe spawn failed (pos=${posOut} neg=${negOut})`,
            };
        }

        await sleep(SETTLE_WALL_MS);

        const stateRaw = await h.lua(`
            local allyTeam = Spring.GetUnitAllyTeam(${uutId}) or 0
            local function radar(id)
                local s = Spring.GetUnitLosState(id, allyTeam, false)
                if type(s) == 'table' then return s.radar and true or false end
                return s and true or false
            end
            return string.format('%s,%s', tostring(radar(${posId})), tostring(radar(${negId})))
        `);
        const [posRadarRaw, negRadarRaw] = stateRaw.split(',');
        const posDetected = posRadarRaw === 'true';
        const negDetected = negRadarRaw === 'true';

        for (const id of [uutId, posId, negId]) {
            try { await h.lua(`Spring.DestroyUnit(${id}, false, true)`); } catch {}
        }

        const pass = posDetected && !negDetected;
        return {
            applicable: true,
            pass,
            detail: pass
                ? `sonar r=${sonarR}: detected @ ${posDist} elmos, missed @ ${negDist} elmos (water probe)`
                : `sonar r=${sonarR}: pos(${posDist})=${posDetected} neg(${negDist})=${negDetected} (expected true,false)`,
        };
    }

    // 400 elmos north-west of anchor — clear of the bootstrap mex/fusion
    // cluster and of the movement-test corridor (anchor.x ± 600 east-west).
    const utX = anchorX - 400;
    const utZ = anchorZ - 400;
    const utSpawn = await h.spawn(unit.name, utX, utZ, team, 1);
    const utId = Number(utSpawn.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!utId) return { applicable: true, pass: false, detail: `spawn failed: ${utSpawn}` };

    // Jammer-only units: verify the jam field actually hides a unit
    // from an enemy's radar, using a positive/negative control pair
    // (see the file header comment for the layout and why it's needed).
    if (isJammer) {
        const hiddenX = utX - Math.floor(jammerR * JAM_HIDDEN_FACTOR);
        const hiddenZ = utZ;
        const controlX = utX - Math.floor(jammerR * JAM_CONTROL_FACTOR) - JAM_CONTROL_MARGIN;
        const controlZ = utZ;
        const radarTowerX = hiddenX - RADAR_TOWER_OFFSET;
        const radarTowerZ = utZ;

        const hiddenOut = await h.spawn(PROBE_DEF, hiddenX, hiddenZ, team, 1);
        const hiddenId = Number(hiddenOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        const controlOut = await h.spawn(PROBE_DEF, controlX, controlZ, team, 1);
        const controlId = Number(controlOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        const towerOut = await h.spawn(ENEMY_RADAR_DEF, radarTowerX, radarTowerZ, enemyTeam, 1);
        const towerId = Number(towerOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!hiddenId || !controlId || !towerId) {
            return {
                applicable: true, pass: false,
                detail: `jammer probe setup failed (hidden=${hiddenOut} control=${controlOut} tower=${towerOut})`,
            };
        }

        // Pin both mobile targets so they don't wander before the
        // settle window elapses (same hold-state workaround as the
        // radar probe below).
        for (const id of [hiddenId, controlId]) {
            try {
                await h.lua(
                    `Spring.GiveOrderToUnit(${id}, ${CMD_MOVE_STATE}, {0}, 0); `
                    + `Spring.GiveOrderToUnit(${id}, ${CMD_FIRE_STATE}, {0}, 0)`,
                );
            } catch { /* hold-state failure is non-fatal */ }
        }

        await sleep(SETTLE_WALL_MS);

        // A jammer never hides a unit from its own ally team (engine:
        // CLosHandler::InJammer returns false when allyTeam == the
        // jammed unit's allyteam) — the query must come from the
        // *enemy's* ally team, resolved off the radar tower we own.
        const jamStateRaw = await h.lua(`
            local enemyAlly = Spring.GetUnitAllyTeam(${towerId}) or 0
            local function radar(id)
                local s = Spring.GetUnitLosState(id, enemyAlly, false)
                if type(s) == 'table' then return s.radar and true or false end
                return s and true or false
            end
            return string.format('%s,%s', tostring(radar(${hiddenId})), tostring(radar(${controlId})))
        `);
        const [hiddenRadarRaw, controlRadarRaw] = jamStateRaw.split(',');
        const hiddenRadar = hiddenRadarRaw === 'true';
        const controlRadar = controlRadarRaw === 'true';

        for (const id of [hiddenId, controlId, towerId]) {
            try { await h.lua(`Spring.DestroyUnit(${id}, false, true)`); } catch {}
        }

        // Pass requires both halves of the pair: the jam field hides
        // the inside unit AND the enemy's radar genuinely reaches the
        // outside unit — otherwise "hidden" not being seen could just
        // mean the enemy has no radar coverage there at all.
        const pass = !hiddenRadar && controlRadar;
        return {
            applicable: true,
            pass,
            detail: pass
                ? `jam r=${jammerR}: hidden unseen, control seen by enemy radar`
                : `jam r=${jammerR}: hidden radar=${hiddenRadar} control radar=${controlRadar} (expected false,true)`,
        };
    }

    // Probe at 60% of radar range — well inside the threshold so a
    // partial-radius miss (rounding, terrain occlusion) doesn't trip a
    // false negative.
    const probeDist = Math.floor(radarR * 0.6);
    const probeX = utX + probeDist;
    const probeZ = utZ;
    const probeOut = await h.spawn(PROBE_DEF, probeX, probeZ, enemyTeam, 1);
    const probeId = Number(probeOut.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!probeId) {
        return { applicable: true, pass: false, detail: `probe spawn failed: ${probeOut}` };
    }
    // Pin the probe in place (same hold-state workaround the combat
    // category uses).
    try {
        await h.lua(
            `Spring.GiveOrderToUnit(${probeId}, ${CMD_MOVE_STATE}, {0}, 0); `
            + `Spring.GiveOrderToUnit(${probeId}, ${CMD_FIRE_STATE}, {0}, 0)`,
        );
    } catch { /* hold-state failure is non-fatal */ }

    await sleep(SETTLE_WALL_MS);

    // Query whether our ally team sees the probe. GetUnitAllyTeam gives
    // us the right ally id even if team != allyTeam in some configs.
    const losStateRaw = await h.lua(`
        local allyTeam = Spring.GetUnitAllyTeam(${utId}) or 0
        local s = Spring.GetUnitLosState(${probeId}, allyTeam, false)
        if s == nil then return 'nil' end
        if type(s) == 'table' then
            return string.format('los=%s radar=%s',
                tostring(s.los or false), tostring(s.radar or false))
        end
        return tostring(s)
    `);
    const detected = /los=true|radar=true|^true$|^[1-9]/.test(losStateRaw);

    try { await h.lua(`Spring.DestroyUnit(${probeId}, false, true)`); } catch {}

    const tag = `radar=${radarR} sonar=${sonarR}`;
    return {
        applicable: true,
        pass: detected,
        detail: detected
            ? `detected probe @ ${probeDist} elmos (${tag})`
            : `probe @ ${probeDist}/${radarR} elmos NOT seen (${tag} ${losStateRaw})`,
    };
}
