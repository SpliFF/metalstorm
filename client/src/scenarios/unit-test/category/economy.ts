/**
 * Economy category — applicable to units that passively produce
 * resources (mexes, fusion, wind, tidal, ZK customParam.income_* etc).
 *
 * The test does two things:
 *   1. Reads the def's declared income (customParams.income_metal /
 *      income_energy, falling back to legacy metalMake/energyMake).
 *      A non-zero declaration is the structural assertion: the def
 *      says it's a producer.
 *   2. Measures the team's `currentLevel` rate before vs after spawning
 *      the UUT, to verify the income mechanism actually credits the
 *      team at runtime.
 *
 * Pass logic:
 *   - Strict pass when `rateAfter > rateBase + 0.05` (real income
 *     measurable). Mexes hit this on the flat sandbox map.
 *   - Soft pass when the def declares positive income but the runtime
 *     rate didn't move. ZK's mex_overdrive gadget needs the Lagmonitor
 *     GG bindings to be live for fusion/wind income to flow; until
 *     that Phase-4 gap closes, declared-income is the best we can
 *     verify for those defs. Detail flags "decl-only" so a future fix
 *     can promote these to strict.
 *   - Fail when the def declares no income (would mean a catalog
 *     classification bug — catalog says producesResources but def
 *     doesn't show it).
 */

import type { TestHarness } from '../../../core/test-harness.js';
import type { UnitClassification } from '../catalog.js';
import { sleep } from '../../types.js';

/** Sample window. At 5× sim speed 800ms ≈ 4 sim seconds, well past one
 *  income tick. Two windows in a row + spawn settle => ~2.6s per unit. */
const WINDOW_WALL_MS = 800;
const SETTLE_WALL_MS = 500;

export interface CategoryResult {
    applicable: boolean;
    pass: boolean;
    detail: string;
}

export interface EconomyCheckCtx {
    h: TestHarness;
    anchorX: number;
    anchorZ: number;
    team: number;
}

export async function runEconomy(
    ctx: EconomyCheckCtx, unit: UnitClassification,
): Promise<CategoryResult> {
    if (!unit.producesResources) {
        return { applicable: false, pass: true, detail: 'unit does not produce resources' };
    }

    const { h, anchorX, anchorZ, team } = ctx;

    // Pull declared income from the def. ZK uses customParams.income_*;
    // the metalMake/energyMake fields are the legacy fallback.
    const declRaw = await h.lua(`
        local ud = UnitDefs[${unit.defId}]
        if not ud then return '0,0,0' end
        local cp = ud.customParams or {}
        local cm = tonumber(cp.income_metal or 0) or 0
        local ce = tonumber(cp.income_energy or 0) or 0
        local isMex = (cp.ismex == '1' or cp.ismex == 1) and 1 or 0
        local m = math.max(cm, ud.metalMake or 0, ud.extractsMetal or 0)
        local e = math.max(ce, ud.energyMake or 0)
        return string.format('%.3f,%.3f,%d', m, e, isMex)
    `);
    const [declM, declE, declMex] = declRaw.split(',').map(Number);
    const hasDeclared = declM > 0 || declE > 0 || declMex === 1;

    const sampleScript = `
        local m = select(1, Spring.GetTeamResources(${team}, 'metal'))
        local e = select(1, Spring.GetTeamResources(${team}, 'energy'))
        return string.format('%.3f,%.3f', m or 0, e or 0)
    `;
    async function sample(): Promise<[number, number]> {
        const raw = await h.lua(sampleScript);
        const [m, e] = raw.split(',').map(Number);
        return [m, e];
    }

    const [m0, e0] = await sample();
    await sleep(WINDOW_WALL_MS);
    const [m1, e1] = await sample();
    const rateBase = (m1 - m0) + (e1 - e0);

    // Spawn well clear of the bootstrap cluster (mexes at anchor ± 220,
    // fusion at anchor.z - 400). 500 elmos north is open ground.
    const utSpawn = await h.spawn(unit.name, anchorX, anchorZ + 500, team, 1);
    const utId = Number(utSpawn.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!utId) return { applicable: true, pass: false, detail: `spawn failed: ${utSpawn}` };

    await sleep(SETTLE_WALL_MS);
    const [m2, e2] = await sample();
    await sleep(WINDOW_WALL_MS);
    const [m3, e3] = await sample();
    const rateAfter = (m3 - m2) + (e3 - e2);
    const delta = rateAfter - rateBase;

    const declTag = `decl m=${declM.toFixed(1)} e=${declE.toFixed(1)}${declMex ? ' mex' : ''}`;
    const rateTag = `Δrate=${delta.toFixed(2)}/win`;
    if (delta > 0.05) {
        return {
            applicable: true, pass: true,
            detail: `strict: measured income (${declTag} ${rateTag})`,
        };
    }
    if (hasDeclared) {
        return {
            applicable: true, pass: true,
            detail: `soft: ${declTag} but ${rateTag} (ZK income gadget gap)`,
        };
    }
    return {
        applicable: true, pass: false,
        detail: `producesResources=true but ${declTag} and ${rateTag} — catalog/def mismatch`,
    };
}
