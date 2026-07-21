/**
 * DetachSessionManager — PLAN-quickstart.md Part B (leave/re-enter without the
 * boot, Metalstorm).
 *
 * Pure, DOM-free bookkeeping for the "detach vs quit" split (§3.1) and the
 * re-entry decision (§3.2, edge cases E4/E5). It owns no Babylon/worker/audio
 * handles — main.ts drives those and calls this manager to decide *whether* a
 * given re-entry can reuse the parked worker (fast `gpResync`) or must fall back
 * to a full boot. Keeping it pure makes the staleness/TTL/keying logic — the
 * place §5 warns "the bugs live" — unit-testable without a browser.
 *
 * Keying (§3.1): one parked session at a time, keyed to `{roomId, gamePort}`.
 * A parked worker is disposed on TTL expiry (~10 min) or when the player enters
 * a *different* room. Re-entry against a room whose game server was restarted
 * (a new spawned process ⇒ a new port) is caught by the port mismatch and falls
 * back to a full boot (E5) — never a resync against a different game instance.
 *
 * Generation (§3.1): each detach bumps a monotonic sub-generation. Async work
 * in flight from before the detach compares the generation it captured against
 * the current one and bails if they differ — the same pattern main.ts's
 * `activeSession` uses across a full quit, but at detach granularity so the
 * worker (which is *not* torn down) doesn't act on a stale reconnect.
 */

export interface ParkedSession {
    /** Lobby room id the parked worker is bound to. */
    readonly roomId: string;
    /** Game-server port at park time — the E5 restart guard compares this. */
    readonly gamePort: number;
    /** Detach sub-generation captured when this session was parked. */
    readonly generation: number;
    /** Wall-clock (ms) the session was parked, for the TTL sweep. */
    readonly parkedAtMs: number;
}

/** What a re-entry attempt should do. */
export type ReentryPlan = 'resync' | 'full-boot';

export const DEFAULT_PARK_TTL_MS = 10 * 60 * 1000; // 10 minutes (§3.1)

export class DetachSessionManager {
    private parked: ParkedSession | null = null;
    private generation = 0;

    constructor(private readonly ttlMs: number = DEFAULT_PARK_TTL_MS) {}

    /** True while a session is parked (a worker is alive but detached). */
    get isParked(): boolean {
        return this.parked !== null;
    }

    /** The parked session, or null. Read-only snapshot. */
    get session(): ParkedSession | null {
        return this.parked;
    }

    /** Current detach sub-generation (bumped by `park` and `bumpGeneration`). */
    get currentGeneration(): number {
        return this.generation;
    }

    /**
     * Park the current session. Bumps the sub-generation (so pre-detach async
     * bails) and records the keying/TTL anchor. Returns the new generation so
     * the caller can hand it to any in-flight-guarded closures.
     */
    park(roomId: string, gamePort: number, nowMs: number): number {
        this.generation++;
        this.parked = { roomId, gamePort, generation: this.generation, parkedAtMs: nowMs };
        return this.generation;
    }

    /**
     * Decide how to enter `roomId`@`gamePort` right now. `resync` only when a
     * session is parked, un-expired, and keyed to the *same* room AND port;
     * every other case is a clean full boot (E4/E5, TTL, different room, cold
     * start). Does not mutate state — call `clear()`/`bumpGeneration()` after
     * acting on the plan.
     */
    planReentry(roomId: string, gamePort: number, nowMs: number): ReentryPlan {
        const p = this.parked;
        if (!p) return 'full-boot';
        if (nowMs - p.parkedAtMs > this.ttlMs) return 'full-boot';        // TTL
        if (p.roomId !== roomId) return 'full-boot';                      // different room
        if (p.gamePort !== gamePort) return 'full-boot';                  // E5: restarted room
        return 'resync';
    }

    /** True when the parked session has outlived its TTL (for the sweep timer). */
    isExpired(nowMs: number): boolean {
        return this.parked !== null && nowMs - this.parked.parkedAtMs > this.ttlMs;
    }

    /**
     * Bump the sub-generation without parking — used on a successful re-entry
     * and on a hard quit, so any async still referencing the parked generation
     * bails. Returns the new generation.
     */
    bumpGeneration(): number {
        return ++this.generation;
    }

    /** Drop the parked session (re-entered, disposed on TTL, or room ended). */
    clear(): void {
        this.parked = null;
    }
}
