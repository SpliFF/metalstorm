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
 * cursor has anchored) fire on the very next drain; nothing is ever dropped.
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

export interface Scheduled {
    /** Sim frame the event should be presented on. */
    readonly frame: number;
    readonly kind: ScheduledKind;
    /** The side effect to run when the cursor reaches `frame`. */
    readonly fire: () => void;
    /** Monotonic insertion order — the same-frame tiebreaker. */
    readonly seq: number;
}

export class EventScheduler {
    /** Binary min-heap of pending events, ordered by (frame, seq). */
    private heap: Scheduled[] = [];
    private seqCounter = 0;

    /** Queue an event to fire when the presentation cursor reaches `frame`. */
    schedule(frame: number, kind: ScheduledKind, fire: () => void): void {
        this.heapPush({ frame, kind, fire, seq: this.seqCounter++ });
    }

    /**
     * Fire every queued event with `frame <= P`, in ascending (frame, seq)
     * order. Call once per render frame with the current presentation cursor.
     * A throwing `fire` callback is caught and logged so one bad consumer can't
     * abort the drain (or the render loop).
     */
    drain(P: number): void {
        while (this.heap.length > 0 && this.heap[0].frame <= P) {
            const ev = this.heapPop()!;
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
