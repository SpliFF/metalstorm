/**
 * PendingActionRegistry — the optimistic-input control timeline (PLAN-latency
 * L4.1). Design rationale in PLAN-latency-impl.md §"Phase L4".
 *
 * L0–L3 all push work *later*: they take something the server already told us
 * and present it at the frame it belongs on. L4 is the only phase that pushes
 * the other way — it shows the player a consequence of their own click
 * *before* the server has confirmed it. So nothing here rides `EventScheduler`
 * and `D` is not the budget; the round trip is.
 *
 * What that buys, concretely. Command-queue overlays (waypoint markers, the
 * command path, the pending build ghost) are fed exclusively by
 * `UnitCommandQueuesUpdate`, which `StateStreamer::StreamCommandQueues` emits
 * on `(frame % 30) == 0` — once a second. A right-click move order therefore
 * showed its waypoint after up to a full snapshot period *plus* the round trip.
 * Most of that is not latency at all, it is polling.
 *
 * The fix is not to replace the snapshot but to overlay it. Every command the
 * client sends registers here; the entry is drawn immediately, merged on top of
 * the last snapshot by `merge()`. Then one of three things happens:
 *
 *   - **confirmed** — a `UnitCommandBatch` `issued` event names the same
 *     (unit, cmdId, position). That stream is per-tick and already on the wire;
 *     until L4.1 it had no subscriber at all. The entry adopts the server's
 *     `tag` and stops being able to *roll back*. It does not stop being able
 *     to die: an ack is not an acceptance (see below).
 *   - **retired** — a later snapshot contains the order (matched by that
 *     adopted tag). The overlay hands off to authoritative data and forgets it.
 *   - **rolled back** — nothing confirmed it inside the window, so it is
 *     dropped and the artifact disappears. **Refusal is observed as silence:**
 *     the server sends no veto message, so a timeout is the only refutation
 *     available. Everything here is built around that.
 *   - **refuted** — confirmed, but a snapshot that provably post-dates the ack
 *     does not carry the order. See "two kinds of refusal" below.
 *
 * ## Two kinds of refusal, and why only one of them is silent
 *
 * `CCommandAI::GiveCommand` (CommandAI.cpp:817-826, byte-identical to upstream
 * Recoil, so the ordering is faithful reproduction and not ours to change):
 *
 *     if (!eventHandler.AllowCommand(...)) return;   // (1) gadget veto
 *     eventHandler.UnitCommand(...);                 // (2) the ack we consume
 *     GiveCommandReal(c, fromSynced);                // (3) -> AllowedCommand()
 *
 * So the two refusal classes land on opposite sides of the ack:
 *
 *   - **Gadget vetoes run at (1), before the ack.** Metalstorm's authority
 *     economy charges and refuses in `gadget:AllowCommand`
 *     (`game_authority_charge.lua`, layer +100), so a refused order produces
 *     *no* ack at all and rolls back on the ordinary unconfirmed window. This
 *     is the class the optimistic-refusal UX cares about and it was already
 *     correct.
 *   - **The engine's own legality check runs at (3), after the ack.**
 *     `CCommandAI::AllowedCommand` rejects e.g. CMD_BUILD on a non-builder —
 *     and we have already confirmed the entry. Measured 2026-08-04: a build
 *     order to a tank acked at 84 ms and never entered the queue.
 *
 * The second class is why a confirmed entry cannot simply be trusted (which
 * was design decision 5's assumption). It is refuted by *evidence* instead:
 * the first queue snapshot to arrive after the ack. That snapshot is
 * conclusive because both streams go out over the same reliable ordered
 * channel (`rtcServer.SendReliable`) and the streaming phase is monotone in
 * frame, so anything the client receives after the ack was built at a sim
 * frame at or after the one the ack was raised on. If the order were real and
 * still queued, that snapshot would carry it.
 *
 * Absence of the unit is the same evidence as absence of the order:
 * `Protocol::BuildUnitCommandQueues` skips units whose visible queue is empty
 * ("the client treats absence as `empty queue`"), so a refused order to an
 * otherwise-idle unit — the common case, and exactly the measured one — shows
 * up as a missing row rather than a short row.
 *
 * Deliberately an *overlay with an expiry*, not a client-side queue store.
 * PLAN-state-change Phase 2 wants the latter (replay `UnitCommandBatch` into
 * `liveState.unitCommands` and delete the poll) and calls its own coverage
 * audit — factory queues, repeat reordering, gadget `GiveOrderToUnit` — "the
 * phase's main risk". An overlay does not take that risk: a mutation path we
 * fail to model expires and we are back to exactly today's behaviour. When
 * Phase 2 lands, `merge()` is the seam it replaces.
 */

import type {
    UnitCommandEventMsg,
    UnitCommandQueueInfo,
    UnitOrderInfo,
} from './connection.js';

/// Canonical table is command-buffer.ts; duplicated (not imported) so this
/// module stays free of runtime imports and unit-tests without a Connection.
const OPT_SHIFT = 32;
const CMD_STOP = 0;
const CMD_REMOVE = 2;
const CMD_MOVE = 10;
const CMD_PATROL = 15;
const CMD_FIGHT = 16;
const CMD_ATTACK = 20;
const CMD_AREA_ATTACK = 21;

/** Horizontal tolerance (elmos) when matching our sent position against the
 *  server's echo. The echo is not byte-identical: we send `[x, 0, z]` for
 *  ground orders and the server fills the real ground height, and build orders
 *  come back grid-snapped. Only x/z discriminate, so only x/z are compared —
 *  y is ignored outright rather than given a tolerance. */
const POS_EPSILON = 12;

/** Floor for the confirmation window. Even on a LAN the server has to reach a
 *  sim tick before `UnitCommand` can fire, and a stalled tick must not read as
 *  a refusal. */
const MIN_CONFIRM_MS = 1000;
/** Ceiling, so a wedged link drains the registry instead of stranding
 *  artifacts on screen forever. */
const MAX_CONFIRM_MS = 8000;
/** Fixed slack added to `2·RTT`: one snapshot period (1 s at 30 Hz) plus a
 *  render-stall allowance. */
const CONFIRM_SLACK_MS = 500;

/** How long a *confirmed* entry may wait for a snapshot to carry its tag
 *  before we drop it anyway. Needed because not every acked command ever
 *  appears in a queue snapshot — an order that completes inside one snapshot
 *  period (a short move) is acked and then gone. 3 snapshot periods.
 *
 *  This is the *no evidence yet* cap only. Once a snapshot has actually been
 *  examined the entry switches to `REFUTE_GRACE_MS` — see `retire()`. */
const RETIRE_MS = 3000;

/** How long a confirmed entry survives after a snapshot has positively failed
 *  to carry its order. The evidence is already conclusive (see the module
 *  doc), so this is a grace, not a second window: it keeps the artifact from
 *  vanishing in the same frame as the snapshot repaint, and it gives an order
 *  whose echoed waypoint drifted past `POS_EPSILON` one more matching attempt.
 *
 *  What it buys: a refused order is drawn for the ack (~RTT) plus at most one
 *  snapshot period plus this, i.e. ~1.1 s at the worst snapshot phase and
 *  ~0.6 s on average — the same order as the unconfirmed rollback window,
 *  instead of the flat 3 s `RETIRE_MS` it used to ride. That matters more than
 *  a stray line suggests, because a non-shift entry also `replaces` the
 *  merged view, so a phantom order *hides the unit's real queue* for as long
 *  as it is drawn. */
const REFUTE_GRACE_MS = 250;

/** Commands whose acceptance we draw. Positional orders and builds (`cmdId<0`)
 *  are the queue-shaped ones the overlay renderers understand. State commands
 *  (FIRE_STATE, MOVE_STATE, ...) are acked by the same event stream but never
 *  appear in a command queue, so drawing them would be meaningless — they are
 *  not registered. Their feedback is L4.2's order-ack bark. */
function isOverlayCommand(cmdId: number, params: readonly number[]): boolean {
    if (cmdId < 0) return true; // build order
    if (params.length < 3) return false; // e.g. ATTACK on a target id
    return cmdId === CMD_MOVE || cmdId === CMD_ATTACK || cmdId === CMD_FIGHT ||
           cmdId === CMD_PATROL || cmdId === CMD_AREA_ATTACK;
}

/** Commands that clear a unit's queue — they refute our own outstanding
 *  optimism rather than adding to it. */
function isClearingCommand(cmdId: number): boolean {
    return cmdId === CMD_STOP || cmdId === CMD_REMOVE;
}

type PendingState = 'unconfirmed' | 'confirmed';

interface Entry {
    readonly id: number;
    readonly unitId: number;
    readonly cmdId: number;
    readonly params: number[];
    readonly options: number;
    /** True when the order was issued without shift, i.e. it replaces the
     *  unit's queue rather than appending to it. The overlay has to model this
     *  or a plain move click keeps drawing the old path alongside the new one
     *  until the snapshot catches up. */
    readonly replaces: boolean;
    state: PendingState;
    /** Server-assigned tag, adopted on confirmation. Negative (`-id`) while
     *  unconfirmed: server tags are always >= 1 and 0 already means "untagged"
     *  to the marker renderer, so a negative value is unambiguously ours.
     *  Interaction sites that feed a tag back to the server (CMD.REMOVE /
     *  CMD.INSERT anchors) gate on `tag > 0`. */
    tag: number;
    /** Wall-clock deadline: rollback while unconfirmed, retire once confirmed. */
    deadline: number;
    /** Registration time, kept for the entry's whole life (unlike `issuedAt`,
     *  which is dropped at confirmation) so a refutation can report how long
     *  the artifact was actually on screen — the number L4.4 claims. */
    readonly bornAt: number;
    /** True once `retire()` has tested this (confirmed) entry against the
     *  current snapshot and *kept* it — which is positive evidence that the
     *  snapshot does not contain its order, so `merge()` must draw both. Reset
     *  on confirmation, because the hazard the merge-time duplicate guard
     *  exists for is exactly an ack that lands after its snapshot did. */
    vetted: boolean;
}

/** Shared empty-orders sentinel: a unit missing from a snapshot has an empty
 *  queue, and allocating a fresh `[]` per absent unit per snapshot is pure
 *  garbage on the 1 Hz path. */
const NO_ORDERS: readonly UnitOrderInfo[] = [];

/** One command as it went on the wire. */
export interface SentCommand {
    readonly commandId: number;
    readonly unitIds: readonly number[];
    readonly params: readonly number[];
    readonly options?: number;
}

export interface PendingActionStats {
    /** Entries currently drawn but unconfirmed. */
    unconfirmed: number;
    /** Entries confirmed by an ack but not yet present in a snapshot. */
    confirmed: number;
    registered: number;
    confirmedTotal: number;
    retiredTotal: number;
    /** Confirmed entries a snapshot positively refuted (the order was acked
     *  but never queued — engine `AllowedCommand`, a completed short order, or
     *  an unmatchable echo). Distinct from `retiredTotal`, which means the
     *  server demonstrably DID take the order. */
    refutedTotal: number;
    rolledBackTotal: number;
    /** Entries dropped because the player cleared the queue themselves. */
    clearedTotal: number;
    /** Snapshot orders suppressed by a tag collision with a live entry.
     *  Expected 0 in steady state — a non-zero count means `retire()` is
     *  missing its handoff and the overlay is double-drawing. */
    mergeCollisions: number;
    /** Confirmation latency (ms) — click to ack. */
    lastConfirmMs: number;
    meanConfirmMs: number;
    /** How long a refuted entry was drawn (ms) — click to disappearance. This
     *  is the L4.4 number: the visible lifetime of an order the server acked
     *  and then refused. */
    lastRefuteMs: number;
    meanRefuteMs: number;
}

export class PendingActionRegistry {
    private entries: Entry[] = [];
    private nextId = 1;
    private readonly now: () => number;
    private readonly getRttMs: () => number;

    private registered = 0;
    private confirmedTotal = 0;
    private retiredTotal = 0;
    private refutedTotal = 0;
    private rolledBackTotal = 0;
    private clearedTotal = 0;
    private mergeCollisions = 0;
    private confirmMsSum = 0;
    private confirmMsCount = 0;
    private lastConfirmMs = 0;
    private refuteMsSum = 0;
    private refuteMsCount = 0;
    private lastRefuteMs = 0;
    /** Issue time per entry id, kept only until confirmation. */
    private issuedAt = new Map<number, number>();

    /** A/B control for the L4.4 measurement (`gp:test setSnapshotRefutation`).
     *  Off restores the pre-L4.4 behaviour exactly: a missing unit row is
     *  "no evidence" and a confirmed entry rides the flat `RETIRE_MS` cap. Both
     *  arms then share one binary and differ only here. */
    private refuteOnSnapshot = true;

    constructor(opts: { getRttMs: () => number; now?: () => number }) {
        this.getRttMs = opts.getRttMs;
        this.now = opts.now ?? (() => performance.now());
    }

    /** @see refuteOnSnapshot */
    setSnapshotRefutation(on: boolean): void { this.refuteOnSnapshot = on; }

    /** Confirmation window in ms, derived from the live RTT estimate. */
    private confirmWindowMs(): number {
        const rtt = this.getRttMs();
        const w = (Number.isFinite(rtt) && rtt > 0 ? rtt * 2 : 0) + CONFIRM_SLACK_MS;
        return Math.min(MAX_CONFIRM_MS, Math.max(MIN_CONFIRM_MS, w));
    }

    /**
     * Record a command that has just been sent. Called from the
     * `Connection.sendPlayerCommand` sink, so it sees orders in their final
     * form — including ones a `CommandNotify` widget rewrote (raw-move
     * substitution) or issued itself, which a hook in `CommandBuffer` would
     * miss.
     */
    register(cmd: SentCommand): void {
        if (isClearingCommand(cmd.commandId)) {
            // The player cancelled; our own outstanding optimism for these
            // units is refuted by their own input, not by a timeout.
            this.dropForUnits(cmd.unitIds, 'cleared');
            return;
        }
        if (!isOverlayCommand(cmd.commandId, cmd.params)) return;

        const t = this.now();
        const deadline = t + this.confirmWindowMs();
        // Build orders are always treated as appending. For a mobile builder a
        // non-shift build does replace the queue, but shift on a *factory*
        // build means the ×5 count multiplier rather than "queue it", so the
        // flag does not tell us which semantics apply. Appending is the
        // conservative error: guessing "replace" wrongly *hides* real queued
        // orders for a round trip, which is plainly visible, while guessing
        // "append" wrongly shows one extra order for the same window and
        // self-corrects at the next snapshot.
        const replaces = cmd.commandId >= 0 &&
            ((cmd.options ?? 0) & OPT_SHIFT) === 0;
        for (const unitId of cmd.unitIds) {
            const id = this.nextId++;
            this.entries.push({
                id,
                unitId,
                cmdId: cmd.commandId,
                params: [...cmd.params],
                options: cmd.options ?? 0,
                replaces,
                state: 'unconfirmed',
                tag: -id,
                deadline,
                bornAt: t,
                vetted: false,
            });
            this.issuedAt.set(id, t);
            this.registered++;
        }
    }

    /**
     * Reconcile against the per-tick ack stream. Only `issued` events match:
     * `done` means an order left the queue, which for us is a retirement the
     * snapshot will carry anyway.
     *
     * The wire echoes no copy of `Connection.commandSequence`, so identity is
     * not available — we match on (unitId, cmdId, position) and take the first
     * unconfirmed entry that fits. Two identical orders to the same unit are
     * therefore interchangeable, which is harmless: they draw the same artifact.
     */
    confirm(events: readonly UnitCommandEventMsg[]): void {
        for (const ev of events) {
            if (ev.kind !== 'issued') continue;
            const e = this.entries.find(
                x => x.state === 'unconfirmed' &&
                     x.unitId === ev.unitId &&
                     x.cmdId === ev.cmdId &&
                     paramsMatch(x.cmdId, x.params, ev.params));
            if (!e) continue;
            e.state = 'confirmed';
            // Adopt the tag ONLY if it is a real queue tag. Measured 2026-08-04:
            // it usually is not. `CCommandAI::GiveCommand` fires the
            // `UnitCommand` callin BEFORE `GiveCommandReal` →
            // `CommandQueue::push_back`, and push_back is where
            // `SetTag(GetNextTag())` runs — so the ack carries the command's
            // pre-queue tag (0 for an ordinary player order), not the tag the
            // queue snapshot will show. Keeping our synthetic negative tag when
            // there is nothing real to adopt is the honest state: the order is
            // confirmed, but we still cannot address it by tag.
            if (ev.tag > 0) e.tag = ev.tag;
            e.vetted = false;
            e.deadline = this.now() + RETIRE_MS;
            this.confirmedTotal++;
            const issued = this.issuedAt.get(e.id);
            if (issued !== undefined) {
                this.lastConfirmMs = this.now() - issued;
                this.confirmMsSum += this.lastConfirmMs;
                this.confirmMsCount++;
                this.issuedAt.delete(e.id);
            }
        }
    }

    /**
     * Hand off to authoritative data: drop every confirmed entry whose tag now
     * appears in the snapshot. Call before `merge()` on the snapshot path.
     *
     * Each snapshot order retires **at most one** entry. Positional orders are
     * self-limiting (two orders to the same waypoint are the same order), but
     * L4.2's factory queues are not: a build order carries no params at all, so
     * every queued `-defId` on that factory matches every pending one. Without
     * claiming, two fast clicks on the same build tile both retire against the
     * single order the first snapshot carries, and the row's count dips to 1
     * before the next snapshot restores 2.
     */
    retire(queues: readonly UnitCommandQueueInfo[]): void {
        if (this.entries.length === 0) return;
        const ordersByUnit = new Map<number, readonly UnitOrderInfo[]>();
        for (const q of queues) ordersByUnit.set(q.unitId, q.orders);
        const claimed = new Set<UnitOrderInfo>();
        this.entries = this.entries.filter(e => {
            if (e.state !== 'confirmed') return true;
            // A missing row is an EMPTY queue, not an unknown one:
            // `Protocol::BuildUnitCommandQueues` omits units with no
            // externally-visible orders. Treating absence as "no evidence"
            // (which is what this did until 2026-08-04) is why a refused order
            // to an idle unit — the measured case in the L4 gate's finding 1 —
            // rode the full 3 s cap: the tank had no other orders, so it never
            // appeared in a snapshot at all and was never tested.
            const orders = this.refuteOnSnapshot
                ? (ordersByUnit.get(e.unitId) ?? NO_ORDERS)
                : ordersByUnit.get(e.unitId);
            if (!orders) return true;
            const hit = orders.find(o => !claimed.has(o) && orderIs(e, o));
            if (hit) {
                claimed.add(hit);
                this.retiredTotal++;
                return false;
            }
            // Kept, but now on the evidence clock. This snapshot post-dates the
            // ack and demonstrably does not carry the order, which means one of
            // three things, and all three end the same way: the order was
            // refused after the ack (`AllowedCommand`), it already completed,
            // or the server queued it under a form `orderIs` cannot match. Only
            // the last would still want drawing, and in that case the snapshot
            // itself carries a matching order for the renderers to draw — so
            // letting go costs nothing visually.
            //
            // `vetted` also stops `merge()` treating it as a possible duplicate.
            if (!e.vetted) {
                e.vetted = true;
                if (this.refuteOnSnapshot) {
                    e.deadline = Math.min(
                        e.deadline, this.now() + REFUTE_GRACE_MS);
                }
            }
            return true;
        });
    }

    /**
     * Drop entries whose deadline has passed. Unconfirmed ones are rollbacks
     * (the order was refused, lost, or the ack never came); confirmed ones are
     * retirements the snapshot never carried — a short move that completed
     * inside one snapshot period is acked and then simply gone.
     *
     * Call once per render frame. Returns the number of rollbacks, so a caller
     * can log the interesting half.
     */
    expire(): number {
        if (this.entries.length === 0) return 0;
        const t = this.now();
        let rolledBack = 0;
        this.entries = this.entries.filter(e => {
            if (t < e.deadline) return true;
            if (e.state === 'unconfirmed') {
                this.rolledBackTotal++;
                rolledBack++;
                this.issuedAt.delete(e.id);
            } else if (e.vetted) {
                // A snapshot tested it and it was not there — refuted, not
                // merely un-carried. Counted apart from `retiredTotal` because
                // the two mean opposite things about whether the server took
                // the order, and the L4 gate needs to tell them apart.
                this.refutedTotal++;
                this.lastRefuteMs = t - e.bornAt;
                this.refuteMsSum += this.lastRefuteMs;
                this.refuteMsCount++;
            } else {
                this.retiredTotal++;
            }
            return false;
        });
        return rolledBack;
    }

    /**
     * The view the overlay renderers consume: the last snapshot with our
     * outstanding orders merged on top. Returns `queues` itself when nothing
     * is pending, so the common case allocates nothing.
     *
     * A `replaces` entry (no shift held) drops the server orders that preceded
     * it, matching what the server will do when the order lands.
     */
    merge(queues: readonly UnitCommandQueueInfo[]): UnitCommandQueueInfo[] {
        if (this.entries.length === 0) return queues as UnitCommandQueueInfo[];

        const byUnit = new Map<number, Entry[]>();
        for (const e of this.entries) {
            const list = byUnit.get(e.unitId);
            if (list) list.push(e);
            else byUnit.set(e.unitId, [e]);
        }

        const out: UnitCommandQueueInfo[] = [];
        for (const q of queues) {
            const es = byUnit.get(q.unitId);
            if (!es) { out.push(q); continue; }
            byUnit.delete(q.unitId);
            out.push({ unitId: q.unitId, orders: mergeOrders(q.orders, es, this) });
        }
        // Units with pending orders but no snapshot row yet (a unit whose queue
        // was empty at the last poll — the overwhelmingly common case for a
        // first move order).
        for (const [unitId, es] of byUnit) {
            out.push({ unitId, orders: mergeOrders([], es, this) });
        }
        return out;
    }

    /** Drop every entry for these units (queue cleared by the player). */
    private dropForUnits(unitIds: readonly number[], reason: 'cleared'): void {
        if (this.entries.length === 0) return;
        const set = new Set(unitIds);
        this.entries = this.entries.filter(e => {
            if (!set.has(e.unitId)) return true;
            if (reason === 'cleared') this.clearedTotal++;
            this.issuedAt.delete(e.id);
            return false;
        });
    }

    /** @internal — bumped from `mergeOrders`. */
    noteCollision(): void { this.mergeCollisions++; }

    stats(): PendingActionStats {
        let unconfirmed = 0, confirmed = 0;
        for (const e of this.entries) {
            if (e.state === 'unconfirmed') unconfirmed++;
            else confirmed++;
        }
        return {
            unconfirmed,
            confirmed,
            registered: this.registered,
            confirmedTotal: this.confirmedTotal,
            retiredTotal: this.retiredTotal,
            refutedTotal: this.refutedTotal,
            rolledBackTotal: this.rolledBackTotal,
            clearedTotal: this.clearedTotal,
            mergeCollisions: this.mergeCollisions,
            lastConfirmMs: this.lastConfirmMs,
            meanConfirmMs: this.confirmMsCount > 0
                ? this.confirmMsSum / this.confirmMsCount : 0,
            lastRefuteMs: this.lastRefuteMs,
            meanRefuteMs: this.refuteMsCount > 0
                ? this.refuteMsSum / this.refuteMsCount : 0,
        };
    }

    /** Reset the cumulative counters, keeping live entries. L3.2's finding —
     *  counters spanning the boot transient are worthless — applies here too. */
    resetStats(): void {
        this.registered = 0;
        this.confirmedTotal = 0;
        this.retiredTotal = 0;
        this.refutedTotal = 0;
        this.rolledBackTotal = 0;
        this.clearedTotal = 0;
        this.mergeCollisions = 0;
        this.confirmMsSum = 0;
        this.confirmMsCount = 0;
        this.lastConfirmMs = 0;
        this.refuteMsSum = 0;
        this.refuteMsCount = 0;
        this.lastRefuteMs = 0;
    }

    /** Drop everything (quit to lobby, reconnect). */
    clear(): void {
        this.entries = [];
        this.issuedAt.clear();
    }

    /** Live entry count — the drain check for the L4 gate. */
    get size(): number { return this.entries.length; }
}

function mergeOrders(
    serverOrders: readonly UnitOrderInfo[],
    es: readonly Entry[],
    reg: PendingActionRegistry,
): UnitOrderInfo[] {
    // Everything from the last `replaces` entry onward; anything before it is
    // about to be discarded by the server too.
    let from = 0;
    for (let i = es.length - 1; i >= 0; i--) {
        if (es[i].replaces) { from = i; break; }
    }
    const tail = es.slice(from);
    // Guard against double-drawing: `retire()` normally removes a confirmed
    // entry the moment the snapshot carries its order, but `merge()` also runs
    // on selection changes and on the send path against the *cached* snapshot,
    // and an ack that lands after its snapshot leaves a confirmed entry whose
    // order is already in that cache.
    //
    // Three constraints, all learned from L4.2's factory queues:
    //   - only **confirmed** entries can shadow a server order. An unconfirmed
    //     one is by definition not in the snapshot yet, so treating it as a
    //     duplicate hides a real order.
    //   - not entries `retire()` has already **vetted** against this snapshot.
    //     Retire runs first on the snapshot path with the same predicate, so a
    //     confirmed entry that survived it is proof the snapshot lacks its
    //     order. Shadowing it there is how two fast build clicks displayed ×1.
    //   - each entry shadows at most **one** server order. A build order
    //     carries no params, so `orderIs` matches every queued `-defId` on that
    //     factory; without this, one pending build hid an entire five-deep
    //     production row.
    const unclaimed = new Set(
        tail.filter(e => e.state === 'confirmed' && !e.vetted));
    const base: UnitOrderInfo[] = es[from]?.replaces
        ? []
        : serverOrders.filter(o => {
            let dup: Entry | undefined;
            for (const e of unclaimed) {
                if (orderIs(e, o)) { dup = e; break; }
            }
            if (!dup) return true;
            unclaimed.delete(dup);
            reg.noteCollision();
            return false;
        });
    for (const e of tail) {
        base.push({
            cmdId: e.cmdId,
            params: e.params,
            options: e.options,
            tag: e.tag,
            timeout: 0,
        });
    }
    return base;
}

/**
 * Is this snapshot order the one our entry stands for? Tag equality when we
 * have a real tag to compare (we usually do not — see `confirm`), otherwise
 * the same command-and-position test confirmation uses.
 */
function orderIs(e: Entry, o: UnitOrderInfo): boolean {
    if (e.tag > 0 && o.tag === e.tag) return true;
    // For a positional order the *waypoint* is the identity, not the command
    // id. Measured on ZK 2026-08-04: a client `CMD.MOVE` (10) is in the queue
    // as `CMD_RAW_MOVE` (31109) — a gadget rewrites it — while the params come
    // back bit-identical to what we sent. Requiring cmdId equality here meant
    // an order was never recognised as having landed, so the entry sat until
    // its hard retirement cap instead of handing off at the next snapshot.
    // The ack itself still matches strictly (`confirm`), because the callin
    // fires ahead of the rewrite and does carry cmdId 10.
    if (isOverlayCommand(e.cmdId, e.params) &&
        e.params.length >= 3 && o.params.length >= 3) {
        return Math.abs(e.params[0] - o.params[0]) <= POS_EPSILON &&
               Math.abs(e.params[2] - o.params[2]) <= POS_EPSILON;
    }
    return o.cmdId === e.cmdId && paramsMatch(e.cmdId, e.params, o.params);
}

/**
 * Does the server's echoed parameter list describe the order we sent?
 *
 * For positional orders only x/z are compared, with tolerance — see
 * POS_EPSILON. For everything else the values are small exact quantities
 * (target ids, state enums) where a tolerance would actively mis-match, so
 * they are compared exactly over the shorter list.
 */
function paramsMatch(
    cmdId: number,
    ours: readonly number[],
    theirs: readonly number[],
): boolean {
    if (isOverlayCommand(cmdId, ours) && ours.length >= 3 && theirs.length >= 3) {
        return Math.abs(ours[0] - theirs[0]) <= POS_EPSILON &&
               Math.abs(ours[2] - theirs[2]) <= POS_EPSILON;
    }
    const n = Math.min(ours.length, theirs.length);
    for (let i = 0; i < n; i++) {
        if (ours[i] !== theirs[i]) return false;
    }
    return true;
}
