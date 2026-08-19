/**
 * Scenario framework — types shared by all bench scenarios and the
 * runner that orchestrates them.
 *
 * A scenario is a self-contained, reproducible engagement: declare the
 * map, the AI slots (any combination, up to map's max_players), then
 * spawn units / give orders / poll state through the TestHarness on
 * `window.test`.
 *
 * The runner (`runner.ts`) is triggered by `?scenario=<name>` in the
 * URL: it auto-logs in as `test1:test`, creates a fresh room on the
 * declared map, adds the AI slots, starts the game, and once
 * `window.test` is wired it calls `setup` → `run` → reports results.
 *
 * Scenarios should not assume any prior world state — the runner
 * recreates the room from scratch every time.
 */

import type { TestHarness } from '../core/test-harness.js';

export interface ScenarioAISlot {
    /** AI plugin id as reported by `/api/ai/<gameId>` (e.g. `"null"`,
     *  `"CAI"`). The runner POSTs this verbatim to `/api/rooms/ai/add`. */
    aiId: string;
    /** Team number (0-indexed). Must not collide with `playerTeam`. */
    team: number;
    /** Optional start-position index (0-indexed). Omit for auto-assign. */
    startPos?: number;
}

export interface AssertionResult {
    name: string;
    ok: boolean;
    detail?: string;
}

export interface Scenario {
    /** URL slug — `?scenario=<name>`. Must be unique across the registry. */
    name: string;
    /** Human-readable one-liner. Shown in the runner log. */
    description: string;
    /** Map id as in `data/maps/<id>/`. */
    map: string;
    /** Game id as in `data/games/<id>/`. */
    gameId: string;
    /** AI slot configuration. Multiple slots → multiple NullAI / CAI on
     *  arbitrary teams, up to `kMaxAISlotsPerRoom` (16) server-side. */
    aiSlots: ScenarioAISlot[];
    /** Team the host (test1) joins. Defaults to 0 if omitted. */
    playerTeam?: number;
    /** Host start-position index. Omit for auto-assign. */
    playerStartPos?: number;
    /**
     * Game-side scenario id (`data/games/<gameId>/scenarios/<id>.lua`), sent as
     * the manifest's TOP-LEVEL `scenario` field — `modoptions.scenario` alone
     * is overwritten by the map's own default (lobby_main.cpp `chooseScenario`).
     *
     * Omit → the map default applies. `''` → explicitly no scenario at all.
     * Those are different launches, which is why this is `?: string` and not a
     * truthiness check at the call site.
     */
    scenario?: string;
    /** Extra room modoptions, e.g. `{ startmetal: '5000' }`. */
    modoptions?: Record<string, string>;
    /**
     * Stage the scenario. Runs once after `startGame()` has wired
     * `window.test` and the first entity-state tick has arrived. Use
     * `h.spawn`, `h.order`, `h.setLogging`, etc.
     */
    setup(h: TestHarness): Promise<void>;
    /**
     * Observation window + assertions. Runs after `setup`. Implementations
     * typically wait some sim frames (via `h.frame()` polling or
     * `setTimeout`) then read `h.unitState(...)`, `h.combatSummary()`,
     * etc. and emit an `AssertionResult[]`.
     */
    run?(h: TestHarness): Promise<AssertionResult[]>;
    /** Optional cleanup. Most scenarios are one-shot per browser session
     *  and do not need this. */
    teardown?(h: TestHarness): Promise<void>;
}

/**
 * Wait for `predicate` to return true. Polls every `pollMs`; rejects
 * if `timeoutMs` elapses first. Useful for "wait until N enemy units
 * remain" or "wait until weapon has reloaded".
 */
export async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 30000,
    pollMs = 100,
): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (await predicate()) return;
        await sleep(pollMs);
    }
    throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
}

/** Sleep helper for use inside scenarios. Prefer `waitUntil` when possible. */
export function sleep(ms: number): Promise<void> {
    return new Promise((res) => window.setTimeout(res, ms));
}

/**
 * Spin-wait for the server frame counter to reach (or exceed) `targetFrame`.
 * Reads via `h.frame()` (`server frame` exec verb). Returns the actual
 * frame on resolution.
 */
export async function waitForFrame(
    h: TestHarness, targetFrame: number, timeoutMs = 30000, pollMs = 100,
): Promise<number> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const out = await h.frame();
        const m = out.match(/(\d+)/);
        const cur = m ? Number(m[1]) : 0;
        if (cur >= targetFrame) return cur;
        await sleep(pollMs);
    }
    throw new Error(`waitForFrame: did not reach ${targetFrame} within ${timeoutMs}ms`);
}

/**
 * Read the current server frame. Convenience wrapper that parses the
 * `frame` exec verb output. Returns 0 if parse fails (e.g. server
 * hasn't ticked yet).
 */
export async function currentFrame(h: TestHarness): Promise<number> {
    const out = await h.frame();
    const m = out.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
}

/**
 * Parse `unit_state` output for a single field. The exec verb emits:
 *   id=15976 def=dyntrainer_strike_base team=0 hp=2602.14/4200 pos=(572,810,1982) heading=-25060 weapons=N
 *     w0 def=... range=... reloadFrame=... hasTarget=...
 *
 * Returns the first capture group or null.
 */
export function parseUnitField(text: string, field: string): string | null {
    const re = new RegExp(`${field}=([^\\s]+)`);
    const m = text.match(re);
    return m ? m[1] : null;
}

/**
 * Convenience: parse `pos=(x,y,z)` from a `unit_state` line. Returns null
 * if the unit is gone or the format doesn't match.
 */
export function parseUnitPos(text: string): { x: number; y: number; z: number } | null {
    const m = text.match(/pos=\(([^,]+),([^,]+),([^)]+)\)/);
    if (!m) return null;
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}
