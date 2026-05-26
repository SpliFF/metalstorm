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
 *   - Jammer units don't *extend* recon — they hide things — so the
 *     test is a degenerate pass: the jammer spawns, no probe is added,
 *     and the test reports `applicable=true, pass=true` with a detail
 *     noting "jammer (no positive probe)". A future iteration can
 *     verify the jammer actually hides a probe spawned inside its
 *     radius from the enemy's perspective.
 */

import type { TestHarness } from '../../../core/test-harness.js';
import type { UnitClassification } from '../catalog.js';
import { sleep } from '../../types.js';

const PROBE_DEF = 'shieldraid';
const CMD_FIRE_STATE = 45;
const CMD_MOVE_STATE = 50;
/** Settle time (wall ms at 5× sim speed ≈ 4 sim seconds) — enough for
 *  LOS quads to update once after both units exist. */
const SETTLE_WALL_MS = 800;

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

    // Jammer-only units: spawning succeeds is all we assert (a real
    // detect-vs-jamming test needs two ally teams + a probe and is out
    // of scope for v1).
    if (isJammer) {
        return {
            applicable: true, pass: true,
            detail: `jammer r=${jammerR} (no positive probe)`,
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
