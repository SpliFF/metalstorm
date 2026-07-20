/**
 * RecoveryLadder (PLAN-client-resilience.md task 2) — the R1/R2/R3 recovery
 * ladder + loop guard. The single decision authority for what to do when the
 * game-processor worker fails: a soft in-place reset (R1), a worker
 * respawn+reconnect (R2), or giving up to an error screen (R3).
 *
 * WHY MAIN-THREAD-OWNED: R2 (terminate+respawn) and R3 (the DOM error screen)
 * are main-thread actions, the heartbeat watchdog that detects a wedged worker
 * is main-side, and — crucially — a wedged/dead worker cannot run its own
 * recovery. So the guard lives on main and survives worker termination. R1's
 * actual subsystem reset runs *in* the worker (it owns the Babylon engine +
 * FX pools + connection); the ladder reaches it through the injected
 * `softReset` dep (main.ts wires it to a `gp:recover`/`gp:recovered`
 * round-trip). This class is otherwise DOM/worker-free so it is unit-testable
 * with injected timers + a controllable clock (mirrors HeartbeatWatchdog).
 *
 * TRIGGER → RUNG mapping (see PLAN §2's table):
 *   - WebGL context restored .............. R1 (in-place reset; the one failure
 *                                           class with a genuine reset path).
 *   - WebGL context lost that never restores → R2 (a dead GL context needs a
 *                                           fresh worker, not a soft reset).
 *   - Wedged watchdog / worker fatal ...... R2 (respawn + reconnect; the sim is
 *                                           server-authoritative so a full
 *                                           snapshot on reconnect is lossless).
 *   - R1 failed ........................... escalates to R2.
 *   - R2 twice in the window .............. R3 (error screen).
 * Widget-callin errors never reach here — the LuaUI dispatch pcall-wraps every
 * callin, so only genuinely-uncaught worker errors (render loop, bare async)
 * surface as `fatal`, and those really are unrecoverable-in-place.
 *
 * ── LOOP GUARD: PROVABLE TERMINATION (no recovery storm) ──────────────────
 * Escalation is MONOTONIC within a rolling `windowMs` (default 5 min): the
 * `floor` rung never decreases inside a window, and each rung's action count is
 * hard-capped:
 *   - at most `r1Max` R1s, then the next escalates to R2;
 *   - at most `r2Max` R2s, then the next escalates to R3;
 *   - R3 is TERMINAL — every later trigger is ignored.
 * A `recovering` latch makes the ladder re-entrant-safe: while one rung is
 * executing (or a render loop is throwing at 60 Hz), further triggers are
 * absorbed into the trigger chain instead of launching a second recovery.
 * Therefore the number of recovery ACTIONS per window is bounded by the
 * constant `r1Max + r2Max + 1` (default 2+2+1 = 5), and a fresh window only
 * opens after `windowMs` of NOT being terminal — so the long-run recovery rate
 * is bounded (≤5 per 5 min) and the ladder provably cannot storm. A crash loop
 * therefore reaches R3 in a bounded number of steps rather than ping-ponging
 * R1 forever.
 */

/** Externally-observable failure signals the ladder reacts to. `context-lost`
 *  is not itself a rung — it arms a grace timer via {@link RecoveryLadder.
 *  notifyContextLost}; a restore within the grace is R1, a timeout is R2. */
export type RecoveryTrigger =
    | 'context-restored'
    | 'context-lost-timeout'
    | 'wedged'
    | 'fatal'
    | 'worker-error';

export interface RungEvent {
    /** 'R1' | 'R2' | 'R3'. */
    rung: string;
    /** The trigger that ultimately drove this rung (last link in the chain). */
    reason: RecoveryTrigger;
    /** Ordered trigger chain within this window, for telemetry triage. */
    chain: string[];
    /** Citable handle: matches the report row this rung emits. */
    reportId: string;
}

export interface RecoveryLadderDeps {
    /** R1: ask the (live) worker for an in-place soft reset — Babylon
     *  wipeCaches + FX-pool flush + a fresh-snapshot resync. MUST resolve
     *  `true` only on a confirmed worker ack, and `false` (or reject) on
     *  failure OR its own timeout (a wedged worker will never ack). A non-true
     *  outcome escalates the ladder to R2. */
    softReset: () => Promise<boolean>;
    /** R2: terminate + respawn the worker on the boot/resync path (a fresh
     *  ClientSession reconnects and the server re-streams a full snapshot). */
    respawn: () => void;
    /** R3: show the terminal error screen with a citable report id and tear
     *  the (crash-looping) worker down so no further triggers can fire. */
    showErrorScreen: (reportId: string) => void;
    /** Fire ONE telemetry event recording the rung taken + its trigger chain
     *  (PLAN §2: "every rung fires a telemetry event with its trigger chain"). */
    emitRungEvent: (ev: RungEvent) => void;
    /** Monotonic wall clock in ms (Date.now in prod; injected in tests). */
    now: () => number;
    /** Rolling accounting window (default 5 min). */
    windowMs?: number;
    /** Max R1 actions per window before escalating to R2 (default 2). */
    r1Max?: number;
    /** Max R2 actions per window before escalating to R3 (default 2). */
    r2Max?: number;
    /** Grace for a lost context to restore before R1 gives up → R2 (default
     *  4000; must exceed the injection verb's restoreAfterMs). */
    contextRestoreGraceMs?: number;
    /** Timer primitives (injected for fake-timer tests). */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_R1_MAX = 2;
const DEFAULT_R2_MAX = 2;
const DEFAULT_CONTEXT_GRACE_MS = 4000;

function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

export class RecoveryLadder {
    private readonly deps: RecoveryLadderDeps;
    private readonly windowMs: number;
    private readonly r1Max: number;
    private readonly r2Max: number;
    private readonly graceMs: number;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (h: unknown) => void;

    /** Start of the current accounting window (ms). */
    private windowStart = 0;
    /** Monotonic minimum rung within the window (0 = idle). */
    private floor = 0;
    private r1Count = 0;
    private r2Count = 0;
    /** Trigger chain accumulated across the window (telemetry). */
    private chain: string[] = [];
    /** A rung action is in flight — absorb further triggers into `chain`. */
    private recovering = false;
    /** R3 reached — the ladder is done; every later trigger is ignored. */
    private terminal = false;
    /** Per-window episode counter, folds into the report id so repeated
     *  episodes get distinct citable handles. */
    private episodeSeq = 0;
    /** Armed while a lost context has not yet restored (grace window). */
    private graceTimer: unknown = null;
    private windowInitialised = false;

    constructor(deps: RecoveryLadderDeps) {
        this.deps = deps;
        this.windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
        this.r1Max = deps.r1Max ?? DEFAULT_R1_MAX;
        this.r2Max = deps.r2Max ?? DEFAULT_R2_MAX;
        this.graceMs = deps.contextRestoreGraceMs ?? DEFAULT_CONTEXT_GRACE_MS;
        this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    }

    // ── introspection (tests + diagnostics) ──────────────────────────────
    get currentFloor(): number { return this.floor; }
    get isTerminal(): boolean { return this.terminal; }
    get isRecovering(): boolean { return this.recovering; }
    get counts(): { r1: number; r2: number } { return { r1: this.r1Count, r2: this.r2Count }; }
    get triggerChain(): string[] { return [...this.chain]; }

    /** WebGL context loss — not itself a rung. Arm the restore grace: a
     *  restore within `graceMs` is a soft R1; a timeout is a dead context → R2.
     *  No-op while recovering/terminal (the in-flight action owns the outcome)
     *  or if a grace is already armed. */
    notifyContextLost(): void {
        if (this.terminal || this.recovering || this.graceTimer !== null) return;
        this.rollWindow();
        this.chain.push('context-lost');
        this.graceTimer = this.setTimer(() => {
            this.graceTimer = null;
            // The context never came back — a soft reset can't help a dead GL
            // context; go straight to respawn.
            this.trigger('context-lost-timeout');
        }, this.graceMs);
    }

    /** WebGL context restored — cancel any pending grace and take the soft
     *  rung (R1). */
    notifyContextRestored(): void {
        if (this.graceTimer !== null) { this.clearTimer(this.graceTimer); this.graceTimer = null; }
        this.trigger('context-restored');
    }

    /** External failure signal → run the appropriate rung (subject to the
     *  monotonic loop guard). Absorbs triggers that arrive while a recovery is
     *  already in flight, and ignores everything once terminal. */
    trigger(t: RecoveryTrigger): void {
        if (this.terminal) return;
        this.rollWindow();
        this.chain.push(t);
        if (this.recovering) return;   // absorb — an action already owns this episode
        const requested = t === 'context-restored' ? 1 : 2;
        this.recovering = true;
        this.episodeSeq++;
        this.executeRung(this.resolveRung(requested), t);
    }

    /** Reset if the window has elapsed AND we are not mid-recovery/terminal.
     *  Monotonicity holds *within* a window; a fresh window is a clean slate
     *  only after `windowMs` of non-terminal quiet. */
    private rollWindow(): void {
        const now = this.deps.now();
        if (!this.windowInitialised) {
            this.windowInitialised = true;
            this.windowStart = now;
            return;
        }
        if (this.terminal || this.recovering) return;
        if (now - this.windowStart >= this.windowMs) {
            this.windowStart = now;
            this.floor = 0;
            this.r1Count = 0;
            this.r2Count = 0;
            this.chain = [];
        }
    }

    /** Apply the monotonic floor + per-rung caps to a requested rung. This is
     *  where escalation happens: a requested R1 becomes R2 once `r1Max` R1s
     *  have run this window, and a requested/floored R2 becomes R3 once `r2Max`
     *  R2s have run. */
    private resolveRung(requested: number): number {
        let rung = Math.max(requested, this.floor);
        if (rung <= 1 && this.r1Count >= this.r1Max) rung = 2;
        if (rung === 2 && this.r2Count >= this.r2Max) rung = 3;
        return Math.min(rung, 3);
    }

    private makeReportId(): string {
        return 'rcv-' + fnv1a(`${this.windowStart}|${this.episodeSeq}|${this.chain.join('>')}`);
    }

    /** Execute exactly one rung. Escalation from an R1 failure re-enters here
     *  directly (bypassing the latch — it is a continuation of the same
     *  episode, not a fresh external trigger). */
    private executeRung(rung: number, reason: RecoveryTrigger): void {
        this.floor = Math.max(this.floor, rung);
        const reportId = this.makeReportId();
        this.deps.emitRungEvent({ rung: `R${rung}`, reason, chain: [...this.chain], reportId });
        if (rung === 1) {
            this.r1Count++;
            let settled = false;
            const escalate = () => {
                if (settled) return;
                settled = true;
                this.chain.push('r1-failed');
                // Still the same episode — escalate to R2 (or R3 if capped).
                this.executeRung(this.resolveRung(2), reason);
            };
            void this.deps.softReset().then((ok) => {
                if (settled) return;
                if (ok) { settled = true; this.recovering = false; }
                else escalate();
            }).catch(escalate);
        } else if (rung === 2) {
            this.r2Count++;
            // A fresh worker is independent: its own boot-crash arrives later as
            // a NEW external trigger, so drop the latch now (after respawn kicks
            // off) to let that trigger escalate toward R3.
            this.recovering = false;
            this.deps.respawn();
        } else {
            // R3 — terminal. Keep `recovering`/`terminal` latched so nothing
            // else fires; the error screen owns the user's next move (lobby).
            this.terminal = true;
            this.deps.showErrorScreen(reportId);
        }
    }

    /** Drop all timers + state (main.ts calls this on teardown/quit so a new
     *  game session starts from a clean ladder). */
    reset(): void {
        if (this.graceTimer !== null) { this.clearTimer(this.graceTimer); this.graceTimer = null; }
        this.windowStart = 0;
        this.floor = 0;
        this.r1Count = 0;
        this.r2Count = 0;
        this.chain = [];
        this.recovering = false;
        this.terminal = false;
        this.episodeSeq = 0;
        this.windowInitialised = false;
    }
}
