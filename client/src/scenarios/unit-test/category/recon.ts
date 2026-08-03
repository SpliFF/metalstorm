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
        return string.format('%d,%d,%d,%d',
            ud.radarRadius or 0, ud.sonarRadius or 0,
            ud.jammerRadius or 0, ud.losRadius or 0)
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
    // Sonar-only units: would need a water unit at depth to detect.
    // Our flat sandbox map is dry, so we soft-pass with the declared
    // sonar range. A future iteration can spawn an `attackdrone` /
    // submarine inside sonar range over water.
    if (isSonarOnly) {
        return {
            applicable: true, pass: true,
            detail: `sonar-only r=${sonarR} (soft: needs water probe)`,
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
