/**
 * EventScheduler — the presentation-timeline for discrete events (PLAN-latency
 * L1). Design rationale in PLAN-latency-impl.md §"Phase L1".
 *
 * Interpolated *state* (unit positions, piece poses) already renders at the
 * presentation cursor `P = E − D` (PresentationClock, L0). But discrete events
 * — explosions, deaths, impact CEGs, sounds — arrive on the wire stamped with
 * the sim frame they occurred (`GameEventBatch.frame`) and, until L1, fired the
 * instant they were *received*. Reception happens ~D frames ahead of `P`, so
 * every such effect played early: a unit's death burst popped before the unit
 * had visibly reached the spot the interpolator is easing it toward.
 *
 * This scheduler closes that gap. Each event is queued keyed by its sim frame;
 * once per render frame the loop calls `drain(P)`, which fires everything whose
 * frame the cursor has now reached — so an explosion lands on exactly the frame
 * the dying unit is rendered at. Frames are *sim* frames, so a pause (which
 * freezes `P`) naturally freezes the drain; speed changes need no special care.
 *
 * Ordering: `drain` fires in ascending frame order; within one frame, in the
 * order events were scheduled (a monotonic sequence tiebreaker on the heap, so
 * same-frame effects stay deterministic). Past-due events (frame ≤ P at
 * schedule time — e.g. an event that arrives after a stall, or before the
 * cursor has anchored) fire on the very next drain.
 *
 * State vs cosmetic: `drain` only runs from the worker render loop, but the
 * transport keeps delivering while rAF is throttled (hidden tab) — so the
 * queue can accumulate minutes of off-screen combat and refocus would fire it
 * all in one burst. Kinds whose `fire` mutates client state (entity removal,
 * liveState sweeps, reveals) always run, however late; cosmetic kinds (FX,
 * sounds, impact visuals) are silently dropped once they lag the cursor by
 * more than COSMETIC_STALE_FRAMES, collapsing hidden-tab backlogs safely.
 */

/** Event families the timeline carries. `projSpawn`/`projDetonate` are wired by
 *  L2 (Tier-C cosmetic projectiles); the rest by L1. */
export type ScheduledKind =
    | 'combatFx'
    | 'sound'
    | 'impact'
    | 'destroy'
    | 'losReveal'
    | 'projSpawn'
    | 'projDetonate';

/** Kinds whose `fire` mutates client state — mesh/liveState removal
 *  ('destroy'), renderer adds ('losReveal'). Skipping one leaks meshes or
 *  desyncs liveState, so they always fire, however late. Every other kind is
 *  cosmetic (presentation-only FX/audio; even a dropped 'impact' is safe —
 *  the projectile renderer self-sweeps via TTL / MAX_ORPHAN_LIFE_MS). */
const STATE_CRITICAL: ReadonlySet<ScheduledKind> = new Set<ScheduledKind>([
    'destroy',
    'losReveal',
]);

/** Staleness horizon for cosmetic fires, in sim frames: 90 ≈ 3 s at
 *  GAME_SPEED 30 — 3× the display-delay ceiling (DELAY_CEIL_FRAMES = 30 in
 *  presentation-clock.ts, the largest lag a *legitimately* late event can
 *  carry, since events arrive ~D ahead of the cursor). The 3× slack covers
 *  hard-snap stalls and drain hiccups without ever dropping an on-screen
 *  effect, while a hidden-tab backlog (minutes of frames) collapses to
 *  silence on refocus instead of firing as one burst. */
export const COSMETIC_STALE_FRAMES = 90;

export interface Scheduled {
    /** Sim frame the event should be presented on. */
    readonly frame: number;
    readonly kind: ScheduledKind;
    /** The side effect to run when the cursor reaches `frame`. */
    readonly fire: () => void;
    /**
     * Optional pre-roll callback: run repeatedly, every frame the event sits
     * in the future window `(P, E]`, *before* `fire`. This is the point of the
     * foreknowledge window — work that must already be finished by the time
     * the cursor arrives (fetching an about-to-be-revealed unit's model, say)
     * starts up to `D` frames early instead of on the reveal frame itself.
     *
     * Because it runs on many frames it MUST be idempotent and cheap; the
     * retry is deliberate, since the prerequisite a warm-up needs (the unit's
     * def, which streams on its own schedule) may not have arrived on the
     * first attempt.
     */
    readonly prep?: () => void;
    /** Monotonic insertion order — the same-frame tiebreaker. */
    readonly seq: number;
}

export class EventScheduler {
    /** Binary min-heap of pending events, ordered by (frame, seq). */
    private heap: Scheduled[] = [];
    private seqCounter = 0;

    /**
     * Queue an event to fire when the presentation cursor reaches `frame`.
     * `prep`, if given, is the pre-roll warm-up run by `prefetch()` while the
     * event is still ahead of the cursor (see `Scheduled.prep`).
     */
    schedule(frame: number, kind: ScheduledKind, fire: () => void, prep?: () => void): void {
        this.heapPush({ frame, kind, fire, prep, seq: this.seqCounter++ });
    }

    /**
     * Fire every queued event with `frame <= P`, in ascending (frame, seq)
     * order. Call once per render frame with the current presentation cursor.
     * Cosmetic events staler than COSMETIC_STALE_FRAMES are dropped without
     * firing (hidden-tab refocus burst collapse); state-critical kinds always
     * fire. A throwing `fire` callback is caught and logged so one bad
     * consumer can't abort the drain (or the render loop).
     */
    drain(P: number): void {
        while (this.heap.length > 0 && this.heap[0].frame <= P) {
            const ev = this.heapPop()!;
            if (!STATE_CRITICAL.has(ev.kind) &&
                P - ev.frame > COSMETIC_STALE_FRAMES) {
                continue;
            }
            try {
                ev.fire();
            } catch (err) {
                console.error(
                    `[event-scheduler] '${ev.kind}' handler for frame ${ev.frame} threw:`,
                    err,
                );
            }
        }
    }

    /**
     * Pre-roll peek: every queued event in the *future* window `(P, E]`, in
     * ascending (frame, seq) order, without firing or removing them. Lets a
     * consumer warm up work that must be ready by the time the cursor arrives
     * — e.g. prefetching the def/model of an about-to-be-revealed unit. `E` is
     * the estimated leading edge (PresentationClock.E).
     */
    window(P: number, E: number): ReadonlyArray<Scheduled> {
        const out = this.heap.filter((s) => s.frame > P && s.frame <= E);
        out.sort(cmp);
        return out;
    }

    /**
     * Run the `prep` warm-up of every queued event in the future window
     * `(P, E]`. Call once per render frame, right after `drain(P)`.
     *
     * Unlike `window()` this walks the heap in place — no filter, no sort, no
     * allocation — because warm-up order is irrelevant and this is on the
     * render path. A throwing `prep` is caught per-event: a warm-up failure
     * must never abort the sweep or the frame (the event still fires on time;
     * the consumer just falls back to its cold path).
     */
    prefetch(P: number, E: number): void {
        const h = this.heap;
        for (let i = 0; i < h.length; i++) {
            const ev = h[i];
            if (ev.prep === undefined || ev.frame <= P || ev.frame > E) continue;
            try {
                ev.prep();
            } catch (err) {
                console.error(
                    `[event-scheduler] '${ev.kind}' pre-roll for frame ${ev.frame} threw:`,
                    err,
                );
            }
        }
    }

    /** Drop every pending event (quit-to-lobby / teardown). */
    clear(): void {
        this.heap.length = 0;
        this.seqCounter = 0;
    }

    /** Number of events still queued (tests / debug overlay). */
    get size(): number {
        return this.heap.length;
    }

    // ── binary min-heap ─────────────────────────────────────────────────────

    private heapPush(ev: Scheduled): void {
        const h = this.heap;
        h.push(ev);
        let i = h.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (cmp(h[i], h[parent]) >= 0) break;
            [h[i], h[parent]] = [h[parent], h[i]];
            i = parent;
        }
    }

    private heapPop(): Scheduled | undefined {
        const h = this.heap;
        const n = h.length;
        if (n === 0) return undefined;
        const top = h[0];
        const last = h.pop()!;
        if (n > 1) {
            h[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let smallest = i;
                if (l < h.length && cmp(h[l], h[smallest]) < 0) smallest = l;
                if (r < h.length && cmp(h[r], h[smallest]) < 0) smallest = r;
                if (smallest === i) break;
                [h[i], h[smallest]] = [h[smallest], h[i]];
                i = smallest;
            }
        }
        return top;
    }
}

/** Heap/sort order: earlier frame first, then earlier insertion (FIFO). */
function cmp(a: Scheduled, b: Scheduled): number {
    return a.frame - b.frame || a.seq - b.seq;
}
