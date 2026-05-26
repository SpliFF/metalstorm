/**
 * unit-test-loop — iterate every land+air unit (or a `units=` URL
 * filter list) through one or more category tests and aggregate the
 * pass/fail per unit per category.
 *
 * Categories shipped today:
 *   - movement — `canMove` units; assert arrival at a goal point.
 *   - combat   — `canShoot` units; assert HP damage / firing / target acq.
 *   - economy  — `producesResources` units; assert team income delta.
 *   - recon    — units with radar/sonar/jammer; assert detection of
 *                an enemy probe inside the recon radius.
 *
 * The selection filter widens to any unit that's relevant to ≥1
 * category, so mexes, radars, fusion, sonar towers and jammers all
 * cycle through the loop alongside mobile units.
 *
 * URL filters:
 *   ?scenario=unit-test-loop
 *   ?scenario=unit-test-loop&units=shieldraid,armraz,reef
 *
 * Per-unit flow:
 *   1. `h.clear()` — wipe leftover units from the previous iteration.
 *   2. `spawnEconomy()` — drop fusion + 5 mexes around the anchor so
 *      categories that need resources (build, etc.) have them.
 *   3. Snapshot log high-water mark.
 *   4. Run each applicable category, capturing pass/fail/detail.
 *   5. Fetch logs since snapshot, attach any WARN/ERROR to the row.
 *
 * Results land on `window.unitTestResults` as a structured array plus
 * a summary line printed to the console.
 */

import type { Scenario, AssertionResult } from '../types.js';
import type { TestHarness } from '../../core/test-harness.js';
import { loadCatalog, pickUnits, type UnitClassification } from '../unit-test/catalog.js';
import { spawnEconomy } from '../unit-test/economy.js';
import { runMovement, type CategoryResult } from '../unit-test/category/movement.js';
import { runCombat } from '../unit-test/category/combat.js';
import { runRecon } from '../unit-test/category/recon.js';
import { runEconomy } from '../unit-test/category/economy.js';
import {
    logHighWaterMark, fetchLogsSince, formatLogEntry, type LogEntry,
} from '../lib/log-fetch.js';

interface PerUnitResult {
    name: string;
    humanName: string;
    defId: number;
    canMove: boolean;
    canShoot: boolean;
    canBuild: boolean;
    producesResources: boolean;
    extendsRecon: boolean;
    categories: {
        movement?: CategoryResult;
        combat?: CategoryResult;
        recon?: CategoryResult;
        economy?: CategoryResult;
    };
    logs: LogEntry[];
    elapsedMs: number;
}

declare global {
    interface Window {
        unitTestResults?: {
            startedAt: number;
            finishedAt?: number;
            tested: number;
            passed: number;
            failed: number;
            results: PerUnitResult[];
        };
    }
}

/** Anchor point for the per-unit playground. Centred on the flat
 *  sandbox map so units have ~8000 elmos of clear ground in every
 *  direction. */
const ANCHOR_X = 8704;
const ANCHOR_Z = 8704;
const PLAYER_TEAM = 0;
const ENEMY_TEAM = 1;

const scenario: Scenario = {
    name: 'unit-test-loop',
    description: 'Iterate land+air units through movement (v1) and record pass/fail. Use ?units=a,b,c to test a subset.',
    map: 'green_flat_x34_v3',
    gameId: 'zk',
    // NullAI on team 1 keeps the dead-team workaround in spawn-via-Gaia
    // happy and gives us a permanent enemy team for future combat tests.
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: PLAYER_TEAM,

    async setup(h) {
        // Quiet the noisy log subsystems for the duration of the loop.
        // Per-unit log capture filters to WARN/ERROR anyway, but turning
        // off the verbose flags reduces buffer churn on the log server.
        await h.setLogging({
            combat: false, sound: false, weapon: false,
            explosion: false, order: false, unit: false, script: false,
        });

        // Crank sim speed so each unit's movement test completes in a
        // few wall seconds instead of a few wall minutes. The headless
        // sim CPU-caps somewhere around 1.5–2× for ZK, but request 5
        // and let it land where it lands.
        await h.simSpeed(5);

        const catalog = await loadCatalog(h);
        const requested = parseUnitsParam();
        // Any unit relevant to at least one shipped category. Drops
        // pure scaffolding / decorations (and `terraunit`, `wreck`-style
        // pseudo-defs) but keeps mexes, fusion, radars and jammers.
        const units = pickUnits(catalog, requested, /*requireMovement*/ false)
            .filter((u) => u.canMove || u.canShoot || u.producesResources || u.extendsRecon);

        window.unitTestResults = {
            startedAt: Date.now(),
            tested: 0,
            passed: 0,
            failed: 0,
            results: [],
        };
        (this as any)._units = units;

        console.log(`[unit-test-loop] catalog: ${catalog.length} total, ${units.length} selected (movement + combat + economy + recon)`);
        if (requested) console.log(`[unit-test-loop] URL filter: ${requested.join(', ')}`);
    },

    async run(h): Promise<AssertionResult[]> {
        const units = (this as any)._units as UnitClassification[];
        const aggregate = window.unitTestResults!;

        for (let i = 0; i < units.length; i++) {
            const unit = units[i];
            const startMs = performance.now();
            console.log(`[unit-test-loop] (${i + 1}/${units.length}) ${unit.name}`);

            const result = await runOneUnit(h, unit);
            aggregate.results.push(result);
            aggregate.tested++;
            const allPass = Object.values(result.categories).every((c) => c.pass);
            if (allPass) aggregate.passed++; else aggregate.failed++;

            const tags: string[] = [];
            for (const [k, v] of Object.entries(result.categories)) {
                tags.push(`${k}=${v.pass ? 'PASS' : 'FAIL'}${v.detail ? ` (${v.detail})` : ''}`);
            }
            if (result.logs.length > 0) tags.push(`logs=${result.logs.length} W/E`);
            console.log(`[unit-test-loop]   ${tags.join(' | ')}`);
        }

        aggregate.finishedAt = Date.now();
        const totalMs = aggregate.finishedAt - aggregate.startedAt;
        console.log(`[unit-test-loop] done in ${(totalMs / 1000).toFixed(1)}s: `
            + `${aggregate.passed} pass / ${aggregate.failed} fail / ${aggregate.tested} total`);

        return [
            {
                name: 'every selected unit was tested',
                ok: aggregate.tested === units.length,
                detail: `${aggregate.tested}/${units.length}`,
            },
            {
                name: 'at least one unit passed',
                ok: aggregate.passed > 0,
                detail: `${aggregate.passed} passed`,
            },
            // Soft signal — useful in the report but never gating, since
            // many WARN/ERROR lines come from ZK gadgets we haven't
            // quieted (e.g. Chili rendering, perks shaders).
            {
                name: 'no unit triggered new ERROR-level logs',
                ok: aggregate.results.every((r) => !r.logs.some((l) => l.level >= 4)),
                detail: `${aggregate.results.filter((r) => r.logs.some((l) => l.level >= 4)).length} units with errors`,
            },
        ];
    },
};

async function runOneUnit(
    h: TestHarness, unit: UnitClassification,
): Promise<PerUnitResult> {
    const startMs = performance.now();
    const result: PerUnitResult = {
        name: unit.name, humanName: unit.humanName, defId: unit.defId,
        canMove: unit.canMove, canShoot: unit.canShoot, canBuild: unit.canBuild,
        producesResources: unit.producesResources, extendsRecon: unit.extendsRecon,
        categories: {}, logs: [], elapsedMs: 0,
    };

    // Clean the slate. Note: clear() wipes ALL teams' units. Economy
    // gets re-spawned right after.
    try { await h.clear(); } catch { /* nothing to clear is fine */ }

    try {
        await spawnEconomy(h, PLAYER_TEAM, ANCHOR_X, ANCHOR_Z);
    } catch (err: any) {
        result.categories.movement = {
            applicable: true, pass: false,
            detail: `economy bootstrap failed: ${err?.message ?? err}`,
        };
        result.elapsedMs = performance.now() - startMs;
        return result;
    }

    const sinceLogId = await logHighWaterMark();

    try {
        result.categories.movement = await runMovement(
            { h, anchorX: ANCHOR_X, anchorZ: ANCHOR_Z, team: PLAYER_TEAM },
            unit,
        );
    } catch (err: any) {
        result.categories.movement = {
            applicable: true, pass: false,
            detail: `category threw: ${err?.message ?? err}`,
        };
    }

    try {
        result.categories.combat = await runCombat(
            { h, anchorX: ANCHOR_X, anchorZ: ANCHOR_Z, team: PLAYER_TEAM, enemyTeam: ENEMY_TEAM },
            unit,
        );
    } catch (err: any) {
        result.categories.combat = {
            applicable: true, pass: false,
            detail: `category threw: ${err?.message ?? err}`,
        };
    }

    try {
        result.categories.economy = await runEconomy(
            { h, anchorX: ANCHOR_X, anchorZ: ANCHOR_Z, team: PLAYER_TEAM },
            unit,
        );
    } catch (err: any) {
        result.categories.economy = {
            applicable: true, pass: false,
            detail: `category threw: ${err?.message ?? err}`,
        };
    }

    try {
        result.categories.recon = await runRecon(
            { h, anchorX: ANCHOR_X, anchorZ: ANCHOR_Z, team: PLAYER_TEAM, enemyTeam: ENEMY_TEAM },
            unit,
        );
    } catch (err: any) {
        result.categories.recon = {
            applicable: true, pass: false,
            detail: `category threw: ${err?.message ?? err}`,
        };
    }

    // Harvest any warnings / errors emitted during this unit's tests.
    // Filter to sim-side only — browser-side LuaUI spam (shader
    // warnings, widget init noise) is unrelated to unit behaviour
    // and would drown the signal we care about.
    try {
        const raw = await fetchLogsSince(sinceLogId, 'WARN', 2000);
        result.logs = raw.filter((e) =>
            e.process === 'spring-server'
            || e.scope === 'LuaRules'
            || e.scope === 'LuaGaia');
    } catch { result.logs = []; }

    result.elapsedMs = performance.now() - startMs;
    return result;
}

/** Parse `?units=a,b,c` from the current URL. Returns null when the
 *  param is absent so the caller falls back to "every land/air mover". */
function parseUnitsParam(): string[] | null {
    const p = new URLSearchParams(location.search).get('units');
    if (!p) return null;
    return p.split(',').map((s) => s.trim()).filter(Boolean);
}

export default scenario;
