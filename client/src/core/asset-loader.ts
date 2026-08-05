/**
 * AssetLoader — priority queue + concurrency cap shared across the unit,
 * feature, and projectile renderers' `.glb`/texture fetches.
 *
 * Two problems this solves (PLAN-lazy-loading.md):
 *   - A wave of freshly-revealed defs (e.g. 30 enemy unit types entering
 *     LOS at once) used to fire that many concurrent `ImportMeshAsync`
 *     calls. Babylon's loader is bottlenecked on the main thread anyway
 *     (parses gltf, builds meshes), so more than a handful in flight just
 *     serializes behind each other — capping concurrency doesn't slow
 *     anything down, it just stops the request burst from also
 *     saturating the HTTP connection pool.
 *   - Without prioritisation, a build-placement preview (needs its model
 *     *now*) waits behind whatever background reveals queued first. A
 *     later, more urgent request for a key still waiting in the queue
 *     reorders it ahead via `raisePriority`; a key already executing is
 *     unaffected — Babylon's loaders don't expose an abort/reorder hook,
 *     so once a fetch starts it runs to completion.
 */

export enum LoadPriority {
    /** Blocks a player action right now (build-placement preview). */
    P0 = 0,
    /** Imminent visibility (own/allied unit spawn, build-menu hover). */
    P1 = 1,
    /** Default — LOS reveal. */
    P2 = 2,
    /** Static reveal (wreck/feature) or first weapon fire. */
    P3 = 3,
    /** Idle pre-warm; only runs when nothing more urgent is queued. */
    P4 = 4,
}

interface QueueEntry {
    key: string;
    priority: LoadPriority;
    task: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
}

const DEFAULT_POOL_SIZE = 4;

export class AssetLoader {
    private readonly poolSize: number;
    private active = 0;
    private queue: QueueEntry[] = [];
    private inFlight = new Map<string, Promise<unknown>>();

    constructor(poolSize: number = DEFAULT_POOL_SIZE) {
        this.poolSize = poolSize;
    }

    /** Schedule `task` under `key`. Concurrent calls for the same key
     *  return the same promise (the second caller's `task` is never
     *  invoked) — if the first call is still queued, its priority is
     *  raised to the more urgent of the two. */
    schedule<T>(key: string, priority: LoadPriority, task: () => Promise<T>): Promise<T> {
        const existing = this.inFlight.get(key);
        if (existing) {
            this.raisePriority(key, priority);
            return existing as Promise<T>;
        }

        const p = new Promise<T>((resolve, reject) => {
            this.queue.push({
                key,
                priority,
                task: task as () => Promise<unknown>,
                resolve: resolve as (v: unknown) => void,
                reject,
            });
            this.pump();
        });
        this.inFlight.set(key, p);
        // Cleanup chain is separate from the stored/returned promise so a
        // dedupe hit still sees the real resolution/rejection; attached
        // synchronously here (before `schedule` returns) so it fires ahead
        // of any `.then`/`await` a caller attaches afterward, keeping the
        // map's removal visible by the time the caller's own await resolves.
        p.finally(() => { this.inFlight.delete(key); }).catch(() => {});
        return p;
    }

    /** Fire-and-forget pre-warm: schedules at P4 (or a caller-supplied
     *  priority) and swallows the result/error — nothing is awaiting it. */
    prewarm(key: string, task: () => Promise<unknown>, priority: LoadPriority = LoadPriority.P4): void {
        if (this.inFlight.has(key)) return;
        this.schedule(key, priority, task).catch(() => {});
    }

    /** Raise the priority of a request still waiting in the queue.
     *  No-op if `key` isn't queued — either it's already running (in
     *  which case there's nothing left to reorder) or unknown. Never
     *  lowers priority: a later, less-urgent request for the same key
     *  shouldn't demote one already queued. */
    raisePriority(key: string, priority: LoadPriority): void {
        const entry = this.queue.find((e) => e.key === key);
        if (entry && priority < entry.priority) entry.priority = priority;
    }

    private pump(): void {
        while (this.active < this.poolSize && this.queue.length > 0) {
            let bestIdx = 0;
            for (let i = 1; i < this.queue.length; i++) {
                if (this.queue[i].priority < this.queue[bestIdx].priority) bestIdx = i;
            }
            const [entry] = this.queue.splice(bestIdx, 1);
            this.active++;
            entry.task().then(
                (v) => { this.active--; entry.resolve(v); this.pump(); },
                (e) => { this.active--; entry.reject(e); this.pump(); },
            );
        }
    }

    /** Debug/test readout — number of requests queued but not yet running. */
    get pendingCount(): number {
        return this.queue.length;
    }

    /** Debug/test readout — number of requests currently executing. */
    get activeCount(): number {
        return this.active;
    }
}
