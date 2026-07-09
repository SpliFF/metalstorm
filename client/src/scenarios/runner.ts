/**
 * Scenario runner — drives a single named scenario end-to-end from a
 * cold browser session. Triggered by the `?scenario=<name>` URL param.
 *
 * Two pipelines get a scenario from a cold session to a booted game.
 * Both converge on the same waitForHarness/waitForFirstFrame/setup/run
 * tail (steps 3+ below) — only how the room gets created differs.
 *
 * **Direct (default, PLAN-quickstart.md Part A):** the scenario's
 * map/gameId/aiSlots/playerTeam/playerStartPos already match the
 * `/api/rooms/direct` manifest shape, so `startDirect()` serialises them
 * into one manifest and POSTs it once — no lobby login, no stale-room
 * cleanup (the server force-leaves busy players itself), no N-step
 * AI/slot/ready dance. Every bench scenario gets this fast path for
 * free with zero scenario-file changes.
 *
 * **Legacy (`?via=lobby`):** the original end-to-end lobby walk —
 *   1. Auto-login as `test1:test` (hard-coded test credential; the
 *      regular saved-session auto-login is suppressed when this runner
 *      is active to avoid race conditions).
 *   2. Inject the token into LobbyUI via `attachSession` so its SSE
 *      stream starts and `onGameStart` fires when the game boots.
 *   3. Leave any stale rooms from a prior session (`leaveAllRooms` —
 *      lives only in this pipeline; the direct endpoint owns that
 *      cleanup atomically server-side).
 *   4. Create a fresh room on the scenario's `map` + `gameId` (via
 *      LobbyUI.lobbyPost so the same auth path is used everywhere).
 *   5. POST `/api/rooms/ai/add` for every declared AI slot.
 *   6. Set the host's team / start-position if the scenario asks for
 *      something non-default.
 *   7. Mark host ready → `/api/rooms/start`. The lobby's existing
 *      onGameStart wiring then triggers `startGame()` in main.ts.
 * This is deliberately the *only* thing that still exercises the full
 * lobby HTTP surface end-to-end — kept as a regression path, not the
 * tax every scenario run pays. See the `lobby-flow` scenario.
 *
 * Then, on either pipeline:
 *   - Wait for `window.test` to appear, then for the sim to tick.
 *   - Enable cheats + revive every team (dead-team edge case).
 *   - Call `scenario.setup(h)`, optionally `scenario.run(h)`, and stash
 *     results on `window.scenarioResults`.
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

    /** `?via=lobby` opts into the legacy end-to-end lobby walk (login →
     *  leaveAll → create → addAI → slots → ready → start). Default is
     *  the direct-start pipeline (one `/api/rooms/direct` call) — the
     *  legacy path is kept only as a deliberate lobby-surface
     *  regression path (see the `lobby-flow` scenario), never the tax
     *  every scenario run pays. */
    static useLegacyPipeline(): boolean {
        return new URLSearchParams(location.search).get('via') === 'lobby';
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

            if (ScenarioRunner.useLegacyPipeline()) {
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
            } else {
                await this.startDirect();
                console.log(`[scenario] room ${this.roomId} created via /api/rooms/direct — waiting for game to boot`);
            }

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

    /**
     * Direct pipeline (default, PLAN-quickstart.md Part A). Serialises
     * the scenario straight into a `/api/rooms/direct` manifest — one
     * round trip replaces login + leaveAllRooms + createRoom +
     * addAISlots + setPlayerSlot + ready + startGame. The response is
     * the same room JSON `/api/rooms/start` already returns plus a
     * `sessions` map; hand it to the lobby exactly like `createRoom()`
     * does so the existing SSE → onGameStart wiring is untouched.
     */
    private async startDirect(): Promise<void> {
        const s = this.scenario;
        const manifest = {
            name: `scenario:${s.name}`,
            map: s.map,
            game: s.gameId,
            aiSlots: s.aiSlots.map((slot) => ({
                aiId: slot.aiId,
                team: slot.team,
                ...(slot.startPos !== undefined ? { startPos: slot.startPos } : {}),
            })),
            players: [{
                username: TEST_USER,
                team: s.playerTeam ?? 0,
                ...(s.playerStartPos !== undefined ? { startPos: s.playerStartPos } : {}),
                spectator: false,
            }],
            autoStart: true,
        };

        const resp = await fetch(`${CONFIG.httpUrl}/api/rooms/direct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(manifest),
        });
        const room = await resp.json();
        if (!resp.ok) throw new Error(`startDirect: /api/rooms/direct failed: ${room?.error ?? resp.status}`);
        if (!room?.id) throw new Error(`startDirect: missing id in response: ${JSON.stringify(room)}`);

        const token = room.sessions?.[TEST_USER];
        const hostPlayer = (room.players ?? []).find((p: any) => p.username === TEST_USER);
        if (!token || !hostPlayer) throw new Error('startDirect: response missing host session/player');

        this.playerId = hostPlayer.player_id;
        this.roomId = room.id;
        // Hand off to the lobby so SSE polling, lobbyPost, and the
        // onGameStart wiring all share this session/room, same as the
        // legacy pipeline's login()/createRoom() do.
        this.lobby.attachSession(token, this.playerId, TEST_USER);
        this.lobby.setCurrentRoomFromJson(room);
    }

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
