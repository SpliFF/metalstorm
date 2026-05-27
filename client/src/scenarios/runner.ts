/**
 * Scenario runner — drives a single named scenario end-to-end from a
 * cold browser session. Triggered by the `?scenario=<name>` URL param.
 *
 * Flow:
 *   1. Auto-login as `test1:test` (hard-coded test credential; the
 *      regular saved-session auto-login is suppressed when this runner
 *      is active to avoid race conditions).
 *   2. Inject the token into LobbyUI via `attachSession` so its SSE
 *      stream starts and `onGameStart` fires when the game boots.
 *   3. Create a fresh room on the scenario's `map` + `gameId` (via
 *      LobbyUI.lobbyPost so the same auth path is used everywhere).
 *   4. POST `/api/rooms/ai/add` for every declared AI slot.
 *   5. Set the host's team / start-position if the scenario asks for
 *      something non-default.
 *   6. Mark host ready → `/api/rooms/start`. The lobby's existing
 *      onGameStart wiring then triggers `startGame()` in main.ts.
 *   7. After main.ts publishes `window.test`, call `scenario.setup(h)`,
 *      optionally `scenario.run(h)`, and stash results on
 *      `window.scenarioResults`.
 *
 * Errors at any step are surfaced both via `console.error` and an entry
 * appended to `window.scenarioResults` so external drivers (MCP, manual
 * inspection) see them.
 */

import { CONFIG } from '../config.js';
import type { TestHarness } from '../core/test-harness.js';
import type { LobbyUI } from '../lobby/lobby-ui.js';
import { getScenario, listScenarios } from './registry.js';
import type { AssertionResult, Scenario } from './types.js';

const TEST_USER = 'test1';
const TEST_PASS = 'test';

/** Stashed on `window.scenarioResults` for external pickup. */
export interface ScenarioReport {
    name: string;
    startedAt: number;
    finishedAt?: number;
    status: 'running' | 'pass' | 'fail' | 'error';
    error?: string;
    assertions: AssertionResult[];
}

declare global {
    interface Window {
        scenarioResults?: ScenarioReport;
    }
}

export class ScenarioRunner {
    /**
     * Resolve the scenario from `?scenario=<name>` and return its
     * Scenario object, or null when the param is missing or no
     * scenario matches.
     */
    static fromUrl(): Scenario | null {
        const name = new URLSearchParams(location.search).get('scenario');
        if (!name) return null;
        const s = getScenario(name);
        if (!s) {
            const known = listScenarios().map((x) => x.name).join(', ');
            console.error(`[scenario] no scenario "${name}". Known: ${known}`);
            return null;
        }
        return s;
    }

    private scenario: Scenario;
    private lobby: LobbyUI;
    private playerId = 0;
    private roomId = 0;
    private report: ScenarioReport;
    private getHarness: () => TestHarness | null;

    constructor(scenario: Scenario, lobby: LobbyUI, getHarness: () => TestHarness | null) {
        this.scenario = scenario;
        this.lobby = lobby;
        this.getHarness = getHarness;
        this.report = {
            name: scenario.name,
            startedAt: Date.now(),
            status: 'running',
            assertions: [],
        };
        window.scenarioResults = this.report;
    }

    /** Kick off the full pipeline. Async — fires and forgets; caller
     *  watches `window.scenarioResults` for completion. */
    async start(): Promise<void> {
        const s = this.scenario;
        console.log(`[scenario] === ${s.name} ===`);
        console.log(`[scenario] ${s.description}`);
        try {
            // Hide the login form — the runner is in charge of auth.
            this.lobby.hide();

            await this.login();
            console.log(`[scenario] logged in as ${TEST_USER} (id=${this.playerId})`);
            const leftCount = await this.leaveAllRooms();
            if (leftCount > 0) {
                console.log(`[scenario] left ${leftCount} stale room(s) from prior session`);
            }
            await this.createRoom();
            console.log(`[scenario] created room ${this.roomId} on ${s.map} / ${s.gameId}`);
            await this.addAISlots();
            console.log(`[scenario] added ${s.aiSlots.length} AI slot(s)`);
            await this.setPlayerSlot();
            await this.ready();
            await this.startGame();
            console.log(`[scenario] /api/rooms/start sent — waiting for game to boot`);

            // Wait for window.test to appear (startGame in main.ts wires
            // it after entityRenderer is constructed). 60s should be
            // more than enough — model + map load completes in <10s.
            await this.waitForHarness(60000);
            console.log(`[scenario] window.test ready — waiting for game server HTTP`);

            // The game server's HTTP listener takes a few seconds to
            // come up after `/api/rooms/start` (process spawn + map
            // load + first tick). The lobby may also fire onGameStart
            // more than once, which rebuilds testHarness each time —
            // re-read it on every poll instead of caching the first
            // sight. Polling `frame()` confirms the server is both
            // listening and ticking.
            //
            // ZK boot is dominated by unit-script loading (~600 Lua
            // files via LuaParser) and can take 150–180 s on a cold
            // start. 240 s gives comfortable headroom; the shorter
            // 120 s ceiling caused setup() to never run on a clean
            // boot. If a sim genuinely never ticks the runner will
            // still error after 4 wall minutes rather than hang.
            const h = await this.waitForFirstFrame(240000);

            // Pre-setup: enable cheats + revive every team. Without this,
            // ZK's game_over.lua (game_over.lua ProcessLastAlly) flags
            // teams with no units as dead, and Spring.CreateUnit raises
            // a Lua error rather than returning nil. `cheats on` makes
            // ZK skip the periodic check; `revive_team all` flips
            // team.isDead back to false for teams that were killed
            // before we got here.
            try {
                await h.cheats(true);
                await h.reviveTeam('all');
                console.log(`[scenario] cheats on + teams revived`);
            } catch (err: any) {
                console.warn(`[scenario] pre-setup cheats/revive failed:`, err?.message ?? err);
            }

            await s.setup(h);
            console.log(`[scenario] setup complete`);

            if (s.run) {
                console.log(`[scenario] running assertions…`);
                const results = await s.run(h);
                this.report.assertions = results;
                const failed = results.filter((r) => !r.ok);
                this.report.status = failed.length === 0 ? 'pass' : 'fail';
                console.log(`[scenario] ${results.length} assertion(s), ${failed.length} failed`);
                for (const r of results) {
                    const tag = r.ok ? 'PASS' : 'FAIL';
                    console.log(`[scenario]   [${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
                }
            } else {
                this.report.status = 'pass';
                console.log(`[scenario] no run() defined — setup-only scenario complete`);
            }
        } catch (err: any) {
            this.report.status = 'error';
            this.report.error = err?.message ?? String(err);
            console.error(`[scenario] ${this.scenario.name} ERRORED:`, err);
        } finally {
            this.report.finishedAt = Date.now();
            console.log(`[scenario] === done (${this.report.status}) ===`);
        }
    }

    // ── Pipeline steps ──────────────────────────────────────────────

    private async login(): Promise<void> {
        // Raw fetch — LobbyUI.lobbyPost requires authToken which we don't
        // have yet. Once we get the token we hand it back to the lobby
        // so subsequent operations (and the TestHarness exec route) use
        // a single, consistent auth context.
        const resp = await fetch(`${CONFIG.httpUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
        });
        if (!resp.ok) {
            throw new Error(`login: HTTP ${resp.status} ${await resp.text()}`);
        }
        const data = await resp.json();
        if (!data?.token) throw new Error(`login: no token in response`);
        this.playerId = data.user_id ?? 0;
        // Hand off to the lobby so SSE polling and lobbyPost share state.
        this.lobby.attachSession(data.token, this.playerId, TEST_USER);
    }

    /**
     * Leave every room test1 is currently in. The lobby's findPlayerRoom
     * helper returns whatever room it finds first when called by
     * subsequent handlers — if test1 is in two rooms (a leftover Active
     * one and our new Filling one), the addAI / ready / start calls
     * will all target the wrong room. Loop until the leave endpoint
     * returns 404. Hard-capped to avoid infinite loops if the lobby
     * misbehaves.
     */
    private async leaveAllRooms(): Promise<number> {
        let count = 0;
        for (let i = 0; i < 16; i++) {
            const r = await this.lobby.lobbyPost('/api/rooms/leave');
            // lobbyPost swallows the status code, so detect "not in a
            // room" by the error envelope the lobby returns on 404.
            if (r?.error === 'not in a room' || (!r?.ok && !r?.result)) return count;
            count++;
        }
        return count;
    }

    private async createRoom(): Promise<void> {
        const s = this.scenario;
        const r = await this.lobby.lobbyPost('/api/rooms', {
            name: `scenario:${s.name}`, map: s.map, game: s.gameId,
        });
        if (!r?.id) throw new Error(`createRoom: missing id in response: ${JSON.stringify(r)}`);
        this.roomId = r.id;
        // Hand the room back to the lobby so its SSE handler tracks
        // state transitions and fires onGameStart on Active.
        this.lobby.setCurrentRoomFromJson(r);
    }

    private async addAISlots(): Promise<void> {
        for (const slot of this.scenario.aiSlots) {
            const r = await this.lobby.lobbyPost('/api/rooms/ai/add', {
                ai_id: slot.aiId, team: String(slot.team),
            });
            if (!r?.id) throw new Error(`addAI ${slot.aiId}/team ${slot.team}: ${JSON.stringify(r)}`);
            // If the slot wants a specific start position, set it now.
            // ai_slots[] is in insertion order so the newest slot is
            // last.
            if (slot.startPos !== undefined) {
                const slots = r.ai_slots ?? [];
                const slotIndex = slots.length - 1;
                await this.lobby.lobbyPost('/api/rooms/startpos', {
                    target_ai_slot: slotIndex, pos: slot.startPos,
                });
            }
        }
    }

    private async setPlayerSlot(): Promise<void> {
        const team = this.scenario.playerTeam ?? 0;
        if (team !== 0) {
            await this.lobby.lobbyPost('/api/rooms/team', { team });
        }
        if (this.scenario.playerStartPos !== undefined) {
            await this.lobby.lobbyPost('/api/rooms/startpos', { pos: this.scenario.playerStartPos });
        }
    }

    private async ready(): Promise<void> {
        await this.lobby.lobbyPost('/api/rooms/ready', { ready: 'true' });
    }

    private async startGame(): Promise<void> {
        await this.lobby.lobbyPost('/api/rooms/start');
    }

    // ── Waiting ──────────────────────────────────────────────────────

    private async waitForHarness(timeoutMs: number): Promise<TestHarness> {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            const h = this.getHarness();
            if (h) return h;
            await sleep(200);
        }
        throw new Error(`waitForHarness: window.test not ready after ${timeoutMs}ms`);
    }

    /**
     * Poll the *current* TestHarness (re-read every iteration — main.ts
     * may rebuild it as the game boots) until `server frame` returns a
     * tick count > 0. This is the only way to know the game-server HTTP
     * listener is up AND the sim has entered its loop. Both must be
     * true before scenarios can spawn anything.
     */
    private async waitForFirstFrame(timeoutMs: number): Promise<TestHarness> {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            const h = this.getHarness();
            if (h) {
                try {
                    // `frame` exec verb returns a bare integer string
                    // (e.g. "8091"). Match the first integer in the
                    // output and require > 0.
                    const out = await h.frame();
                    const m = out.match(/(\d+)/);
                    if (m && Number(m[1]) > 0) return h;
                } catch {
                    // exec route not ready yet — connection refused or
                    // 401 while the game server warms up. Retry.
                }
            }
            await sleep(250);
        }
        throw new Error(`waitForFirstFrame: sim did not tick within ${timeoutMs}ms`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => window.setTimeout(res, ms));
}
