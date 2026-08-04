/**
 * HeartbeatWatchdog (PLAN-client-resilience.md task 1) — detects a wedged
 * game-processor worker: an infinite loop or GPU hang blocks the worker's
 * event loop entirely, so it never processes a `gp:test`/`gp:ping` message
 * and `self.onerror` never fires (there's no exception — nothing ever
 * returns). This is the class onerror/onmessageerror structurally cannot
 * catch, hence a heartbeat.
 *
 * Deps-injected (no direct worker/main-thread coupling) so it's unit-
 * testable with fake timers and a controllable `ping`. main.ts wires
 * `ping: () => workerCall('ping')`.
 *
 * At most one ping is ever in flight — a tick that finds the previous ping
 * still unsettled counts a miss and skips issuing a new one, so a genuinely
 * wedged worker never accumulates unbounded outstanding requests.
 *
 * E3 discipline: `isSuppressed()` gates ticks entirely (no ping sent, no miss
 * counted) — the caller wires this to `document.hidden` (tab backgrounded)
 * and `test.pause()`. A slow-but-alive frame (LuaUI's measured 90ms frames)
 * never misses a beat because the heartbeat rides its own timer, not the
 * render loop; only a truly blocked event loop does.
 *
 * EXTENSION POINT for PLAN-client-resilience.md task 2: `onWedged` is rung
 * R2's trigger ("wedged watchdog, fatal outside R1's reach") — the ladder
 * should terminate + respawn the worker there instead of only reporting.
 */
export interface HeartbeatWatchdogDeps {
    /** Issue one round-trip probe to the worker. Never rejects on a wedge —
     *  it just never resolves; a rejection (worker gone/terminated) is
     *  treated as "not our problem", not a wedge. */
    ping: () => Promise<unknown>;
    /** True while ticks should be skipped without counting a miss (tab
     *  hidden, render loop deliberately frozen via test.pause()). */
    isSuppressed: () => boolean;
    /** Fired once when `missLimit` consecutive ticks find a still-unsettled
     *  ping. Not fired again until a `onRecovered` in between. */
    onWedged: () => void;
    /** Fired when a ping finally resolves after at least one miss (or after
     *  a prior wedge declaration). Not fired on every healthy tick. */
    onRecovered: () => void;
    intervalMs?: number;
    missLimit?: number;
}

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_MISS_LIMIT = 3;

export class HeartbeatWatchdog {
    private readonly deps: HeartbeatWatchdogDeps;
    private readonly intervalMs: number;
    private readonly missLimit: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private pingInFlight = false;
    private misses = 0;
    private wedgedFlag = false;

    constructor(deps: HeartbeatWatchdogDeps) {
        this.deps = deps;
        this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
        this.missLimit = deps.missLimit ?? DEFAULT_MISS_LIMIT;
    }

    start(): void {
        this.stop();
        this.misses = 0;
        this.wedgedFlag = false;
        this.pingInFlight = false;
        this.timer = setInterval(() => this.tick(), this.intervalMs);
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.misses = 0;
        this.wedgedFlag = false;
        this.pingInFlight = false;
    }

    get wedged(): boolean { return this.wedgedFlag; }
    get missCount(): number { return this.misses; }

    private tick(): void {
        if (this.deps.isSuppressed()) {
            // A deliberately-frozen or backgrounded worker isn't wedged —
            // don't let suppressed time count toward the miss streak once
            // ticking resumes.
            this.misses = 0;
            return;
        }
        if (this.pingInFlight) {
            this.misses++;
            if (this.misses >= this.missLimit && !this.wedgedFlag) {
                this.wedgedFlag = true;
                this.deps.onWedged();
            }
            return;
        }
        this.pingInFlight = true;
        this.deps.ping().then(() => {
            this.pingInFlight = false;
            if (this.misses > 0 || this.wedgedFlag) this.deps.onRecovered();
            this.misses = 0;
            this.wedgedFlag = false;
        }).catch(() => {
            // Worker gone (terminated/reloaded) — teardown owns that path,
            // not the watchdog. Just stop tracking this round.
            this.pingInFlight = false;
        });
    }
}
