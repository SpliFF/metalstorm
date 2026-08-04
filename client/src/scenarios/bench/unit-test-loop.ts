/**
 * unit-test-loop — iterate every land+air unit (or a `units=` URL
 * filter list) through one or more category tests and aggregate the
 * pass/fail per unit per category.
 *
 * Categories shipped today:
 *   - movement — `canMove` units; assert arrival at a goal point.
 *   - combat   — `canShoot` units; assert HP damage / firing / target acq.
 *   - recon    — units with radar/sonar/jammer; assert detection of
 *                an enemy probe inside the recon radius.
 *
 * The selection filter widens to any unit that's relevant to ≥1
 * category, so radars cycle through the loop alongside mobile units.
 *
 * URL filters:
 *   ?scenario=unit-test-loop
 *   ?scenario=unit-test-loop&units=ms_mechs_s1,ms_tanks_s2,ms_radar_s1
 *
 * Per-unit flow:
 *   1. `h.clear()` — wipe leftover units from the previous iteration.
 *   2. Snapshot log high-water mark.
 *   3. Run each applicable category, capturing pass/fail/detail.
 *   4. Fetch logs since snapshot, attach any WARN/ERROR to the row.
 *
 * Results land on `window.unitTestResults` as a structured array plus
 * a summary line printed to the console.
 *
 * **Metalstorm port (2026-08-04).** Two things went with the ZK port:
 *
 *   - **The economy bootstrap** (`unit-test/economy.ts` — one fusion +
 *     five mexes per iteration, so build/assist probes had resources).
 *     Metalstorm has no passive resource producer at all; its economy is
 *     authority-based (PLAN-metalstorm-economy.md), so there is nothing
 *     to spawn.
 *   - **The economy category** (`category/economy.ts`). It gated on
 *     `producesResources`, which is false for all 74 Metalstorm defs, so
 *     it could only ever return "not applicable" — an assertion that can
 *     never fire. When authority income becomes observable per-unit, the
 *     replacement is a new category against *that*, not a revival of the
 *     mex/fusion one.
 *
 * `catalog.ts` still carries the ZK `customParams.income_*` fallbacks in
 * its `producesResources` classification. That is deliberate: the field
 * is what a future economy category would key off, and dropping the
 * classification would make re-adding one harder than leaving it.
 */

import type { Scenario, AssertionResult } from '../types.js';
import type { TestHarness } from '../../core/test-harness.js';
import { loadCatalog, pickUnits, type UnitClassification } from '../unit-test/catalog.js';
import { runMovement, type CategoryResult } from '../unit-test/category/movement.js';
import { runCombat } from '../unit-test/category/combat.js';
import { runRecon } from '../unit-test/category/recon.js';
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

let _units: UnitClassification[] = [];

const scenario: Scenario = {
    name: 'unit-test-loop',
    description: 'Iterate land+air units through movement, combat and recon and record pass/fail. Use ?units=a,b,c to test a subset.',
    map: 'green_flat_x34_v3',
    gameId: 'metalstorm',
    // NullAI on team 1 gives the combat and recon categories a permanent
    // enemy team to spawn their dummy targets and probes onto.
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
        // few wall seconds instead of a few wall minutes. Request 5 and
        // let it land wherever the headless sim's CPU budget allows.
        await h.simSpeed(5);

        // Frame the test playground so an observer can watch each unit
        // run instead of looking at empty terrain. Height 1500 covers
        // the full ±1200-elmo movement corridor plus the combat target
        // 400 elmos east of anchor.
        try {
            await h.cameraSnapToGround(ANCHOR_X, ANCHOR_Z, { height: 1500, durationMs: 0 });
        } catch { /* harness may not expose this verb on every build */ }

        const catalog = await loadCatalog(h);
        const requested = parseUnitsParam();
        // Any unit relevant to at least one shipped category. Drops pure
        // scaffolding / decorations but keeps radars and every mover or
        // shooter. `producesResources` stays in the predicate even though
        // no Metalstorm def sets it — so a future economy unit is picked
        // up by the sweep the day it lands rather than silently skipped.
        const units = pickUnits(catalog, requested, /*requireMovement*/ false)
            .filter((u) => u.canMove || u.canShoot || u.producesResources || u.extendsRecon);

        window.unitTestResults = {
            startedAt: Date.now(),
            tested: 0,
            passed: 0,
            failed: 0,
            results: [],
        };
        _units = units;

        console.log(`[unit-test-loop] catalog: ${catalog.length} total, ${units.length} selected (movement + combat + recon)`);
        if (requested) console.log(`[unit-test-loop] URL filter: ${requested.join(', ')}`);
    },

    async run(h): Promise<AssertionResult[]> {
        const units = _units;
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
            // WARN/ERROR lines also come from game gadgets unrelated to
            // the unit under test.
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

    // Clean the slate. Note: clear() wipes ALL teams' units, so every
    // category below starts from an empty board and spawns what it needs.
    try { await h.clear(); } catch { /* nothing to clear is fine */ }

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
