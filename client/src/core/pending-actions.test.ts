import { describe, it, expect } from 'vitest';
import { PendingActionRegistry } from './pending-actions.js';
import type { UnitCommandEventMsg, UnitCommandQueueInfo } from './connection.js';

const CMD_MOVE = 10;
const CMD_STOP = 0;
const CMD_FIRE_STATE = 45;
const OPT_SHIFT = 32;

/** Registry with a controllable clock so the timeout paths are exact rather
 *  than slept-through. */
function mk(rttMs = 100) {
    let t = 0;
    const reg = new PendingActionRegistry({
        getRttMs: () => rttMs,
        now: () => t,
    });
    return { reg, advance: (ms: number) => { t += ms; }, at: () => t };
}

function issued(
    unitId: number,
    cmdId: number,
    params: number[],
    tag: number,
): UnitCommandEventMsg {
    return {
        kind: 'issued', unitId, unitDefId: 1, unitTeam: 0, cmdId, params,
        options: 0, tag, playerId: 0, fromSynced: true, fromLua: false,
    };
}

describe('PendingActionRegistry', () => {
    it('draws a move order before any server traffic', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
        const merged = reg.merge([]);
        expect(merged).toHaveLength(1);
        expect(merged[0].unitId).toBe(7);
        expect(merged[0].orders).toHaveLength(1);
        expect(merged[0].orders[0].cmdId).toBe(CMD_MOVE);
        expect(merged[0].orders[0].params).toEqual([100, 0, 200]);
        expect(reg.stats().unconfirmed).toBe(1);
    });

    it('fans one command out to an entry per unit', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [1, 2, 3], params: [0, 0, 0] });
        expect(reg.size).toBe(3);
        expect(reg.merge([])).toHaveLength(3);
    });

    it('tags unconfirmed entries negatively so tag-consumers can skip them', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
        expect(reg.merge([])[0].orders[0].tag).toBeLessThan(0);
    });

    it('confirms on the ack stream and adopts a real server tag', () => {
        const { reg, advance } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
        advance(60);
        // The echo carries a real ground height where we sent y=0.
        reg.confirm([issued(7, CMD_MOVE, [100, 43.5, 200], 91)]);
        const s = reg.stats();
        expect(s.confirmed).toBe(1);
        expect(s.unconfirmed).toBe(0);
        expect(s.lastConfirmMs).toBe(60);
        expect(reg.merge([])[0].orders[0].tag).toBe(91);
    });

    it('keeps its synthetic tag when the ack carries no queue tag', () => {
        // The live case, measured 2026-08-04: the UnitCommand callin fires
        // before CommandQueue::push_back assigns the tag, so an ordinary
        // player order acks with tag 0.
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
        reg.confirm([issued(7, CMD_MOVE, [100, 43.5, 200], 0)]);
        expect(reg.stats().confirmed).toBe(1);
        expect(reg.merge([])[0].orders[0].tag).toBeLessThan(0);
    });

    it('retires a tagless-acked entry on order identity, not tag', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
        reg.confirm([issued(7, CMD_MOVE, [100, 0, 200], 0)]);
        // The snapshot's tag (91) is one we never saw; only the command and
        // position identify it.
        reg.retire([{
            unitId: 7,
            orders: [{ cmdId: CMD_MOVE, params: [100, 43, 200], options: 0, tag: 91, timeout: 0 }],
        }]);
        expect(reg.size).toBe(0);
        expect(reg.stats().retiredTotal).toBe(1);
    });

    it('retires when the game rewrote the command id but kept the waypoint', () => {
        // ZK: client CMD.MOVE 10 lands in the queue as CMD_RAW_MOVE 31109.
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [9460.2, 0, 8523.4] });
        reg.confirm([issued(7, CMD_MOVE, [9460.2, 0, 8523.4], 0)]);
        reg.retire([{
            unitId: 7,
            orders: [{ cmdId: 31109, params: [9460.2, 0, 8523.4], options: 0, tag: 13, timeout: 0 }],
        }]);
        expect(reg.size).toBe(0);
        expect(reg.stats().retiredTotal).toBe(1);
    });

    it('does not retire on an unrelated order for the same unit', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
        reg.confirm([issued(7, CMD_MOVE, [100, 0, 200], 0)]);
        reg.retire([{
            unitId: 7,
            orders: [{ cmdId: CMD_MOVE, params: [900, 0, 900], options: 0, tag: 91, timeout: 0 }],
        }]);
        expect(reg.size).toBe(1);
        expect(reg.stats().retiredTotal).toBe(0);
    });

    it('does not confirm from a `done` event', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
        const ev = { ...issued(7, CMD_MOVE, [100, 0, 200], 91), kind: 'done' as const };
        reg.confirm([ev]);
        expect(reg.stats().confirmed).toBe(0);
    });

    it('does not confirm from a different position', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
        reg.confirm([issued(7, CMD_MOVE, [400, 0, 200], 91)]);
        expect(reg.stats().confirmed).toBe(0);
        expect(reg.stats().unconfirmed).toBe(1);
    });

    it('rolls back an unconfirmed entry once the window passes', () => {
        const { reg, advance } = mk(100); // window = 2*100 + 500 = 1000 (== floor)
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
        advance(999);
        expect(reg.expire()).toBe(0);
        expect(reg.size).toBe(1);
        advance(2);
        expect(reg.expire()).toBe(1);
        expect(reg.size).toBe(0);
        expect(reg.stats().rolledBackTotal).toBe(1);
        expect(reg.merge([])).toEqual([]);
    });

    it('scales the confirmation window with RTT', () => {
        const { reg, advance } = mk(1200); // 2*1200 + 500 = 2900
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
        advance(2899);
        expect(reg.expire()).toBe(0);
        advance(2);
        expect(reg.expire()).toBe(1);
    });

    it('never rolls back a confirmed entry as a refusal', () => {
        const { reg, advance } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
        reg.confirm([issued(7, CMD_MOVE, [1, 0, 2], 5)]);
        advance(10_000);
        expect(reg.expire()).toBe(0);          // zero *rollbacks*
        expect(reg.size).toBe(0);              // but it did retire
        expect(reg.stats().rolledBackTotal).toBe(0);
        expect(reg.stats().retiredTotal).toBe(1);
    });

    it('retires a confirmed entry when the snapshot carries its tag', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
        reg.confirm([issued(7, CMD_MOVE, [100, 0, 200], 91)]);
        const snap: UnitCommandQueueInfo[] = [{
            unitId: 7,
            orders: [{ cmdId: CMD_MOVE, params: [100, 43, 200], options: 0, tag: 91, timeout: 0 }],
        }];
        reg.retire(snap);
        expect(reg.size).toBe(0);
        expect(reg.stats().retiredTotal).toBe(1);
        // Handed off cleanly: the merged view is the snapshot, undoubled.
        expect(reg.merge(snap)[0].orders).toHaveLength(1);
        expect(reg.stats().mergeCollisions).toBe(0);
    });

    it('never double-draws while confirmed-but-not-yet-retired', () => {
        // Shift-queued, so the entry appends rather than replacing — that is
        // the only path where the snapshot row survives far enough to collide
        // with our own copy of it. (A non-shift entry drops the whole server
        // list first, so it can never double-draw by construction.)
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200], options: OPT_SHIFT });
        reg.confirm([issued(7, CMD_MOVE, [100, 0, 200], 0)]);
        // merge() without a preceding retire() — the selection-change path.
        const snap: UnitCommandQueueInfo[] = [{
            unitId: 7,
            orders: [{ cmdId: CMD_MOVE, params: [100, 43, 200], options: 0, tag: 91, timeout: 0 }],
        }];
        const merged = reg.merge(snap);
        expect(merged[0].orders).toHaveLength(1);
        expect(reg.stats().mergeCollisions).toBe(1);
    });

    it('a non-shift order replaces the queued path, a shift order appends', () => {
        const snap: UnitCommandQueueInfo[] = [{
            unitId: 7,
            orders: [
                { cmdId: CMD_MOVE, params: [10, 0, 10], options: 0, tag: 1, timeout: 0 },
                { cmdId: CMD_MOVE, params: [20, 0, 20], options: 0, tag: 2, timeout: 0 },
            ],
        }];

        const a = mk().reg;
        a.register({ commandId: CMD_MOVE, unitIds: [7], params: [99, 0, 99] });
        expect(a.merge(snap)[0].orders.map(o => o.params[0])).toEqual([99]);

        const b = mk().reg;
        b.register({ commandId: CMD_MOVE, unitIds: [7], params: [99, 0, 99], options: OPT_SHIFT });
        expect(b.merge(snap)[0].orders.map(o => o.params[0])).toEqual([10, 20, 99]);
    });

    it('keeps only the orders from the last replacing entry onward', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 1], options: OPT_SHIFT });
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [2, 0, 2] });          // replaces
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [3, 0, 3], options: OPT_SHIFT });
        expect(reg.merge([])[0].orders.map(o => o.params[0])).toEqual([2, 3]);
    });

    it('drops outstanding optimism when the player stops the unit', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7, 8], params: [1, 0, 2] });
        expect(reg.size).toBe(2);
        reg.register({ commandId: CMD_STOP, unitIds: [7], params: [] });
        expect(reg.size).toBe(1);
        expect(reg.merge([])[0].unitId).toBe(8);
        expect(reg.stats().clearedTotal).toBe(1);
        expect(reg.stats().rolledBackTotal).toBe(0);
    });

    it('ignores commands that never appear in a queue', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_FIRE_STATE, unitIds: [7], params: [0] });
        reg.register({ commandId: 20, unitIds: [7], params: [1234] }); // ATTACK on a target id
        expect(reg.size).toBe(0);
    });

    it('registers build orders (negative cmdId), including param-less factory builds', () => {
        const { reg } = mk();
        reg.register({ commandId: -42, unitIds: [7], params: [512, 0, 512, 0] });
        reg.register({ commandId: -43, unitIds: [8], params: [] });
        expect(reg.size).toBe(2);
        expect(reg.merge([])[0].orders[0].cmdId).toBe(-42);
    });

    it('a build order appends rather than replacing, whatever the shift flag', () => {
        const snap: UnitCommandQueueInfo[] = [{
            unitId: 7,
            orders: [{ cmdId: -1, params: [], options: 0, tag: 1, timeout: 0 }],
        }];
        const { reg } = mk();
        reg.register({ commandId: -42, unitIds: [7], params: [] }); // no shift
        expect(reg.merge(snap)[0].orders.map(o => o.cmdId)).toEqual([-1, -42]);
    });

    it('passes the snapshot straight through when nothing is pending', () => {
        const { reg } = mk();
        const snap: UnitCommandQueueInfo[] = [{ unitId: 7, orders: [] }];
        expect(reg.merge(snap)).toBe(snap);
    });

    it('leaves unrelated units untouched', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
        const snap: UnitCommandQueueInfo[] = [
            { unitId: 9, orders: [{ cmdId: CMD_MOVE, params: [5, 0, 5], options: 0, tag: 3, timeout: 0 }] },
        ];
        const merged = reg.merge(snap);
        expect(merged).toHaveLength(2);
        expect(merged.find(q => q.unitId === 9)!.orders).toHaveLength(1);
    });

    it('matches one ack to one entry when two identical orders are outstanding', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2], options: OPT_SHIFT });
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2], options: OPT_SHIFT });
        reg.confirm([issued(7, CMD_MOVE, [1, 0, 2], 11)]);
        expect(reg.stats().confirmed).toBe(1);
        expect(reg.stats().unconfirmed).toBe(1);
    });

    // --- L4.4: an ack is not an acceptance (PLAN-latency-impl §L4.4). The
    // engine's own `AllowedCommand` runs AFTER the `UnitCommand` callin, so a
    // refused order is confirmed and then never queued.
    describe('snapshot refutation of a confirmed entry', () => {
        it('refutes a confirmed order the next snapshot does not carry', () => {
            const { reg, advance } = mk();
            reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
            advance(84);                       // the measured ack latency
            reg.confirm([issued(7, CMD_MOVE, [100, 0, 200], 0)]);
            // A snapshot in which unit 7 has some OTHER order: post-dates the
            // ack, so it is conclusive that ours was refused.
            reg.retire([{
                unitId: 7,
                orders: [{ cmdId: CMD_MOVE, params: [900, 0, 900], options: 0, tag: 4, timeout: 0 }],
            }]);
            expect(reg.size).toBe(1);          // grace, not an instant pop
            advance(250);
            expect(reg.expire()).toBe(0);      // not a *rollback*
            expect(reg.size).toBe(0);
            expect(reg.stats().refutedTotal).toBe(1);
            expect(reg.stats().retiredTotal).toBe(0);
        });

        it('treats a unit missing from the snapshot as an empty queue', () => {
            // The measured case: a build order to a tank. The tank has no other
            // orders, so `BuildUnitCommandQueues` omits it entirely — before
            // L4.4 that read as "no evidence" and the ghost rode the 3 s cap.
            const { reg, advance } = mk();
            reg.register({ commandId: -42, unitIds: [7], params: [100, 0, 200] });
            advance(84);
            reg.confirm([issued(7, -42, [100, 0, 200], 0)]);
            reg.retire([{ unitId: 99, orders: [] }]);   // unit 7 absent
            advance(250);
            reg.expire();
            expect(reg.size).toBe(0);
            expect(reg.stats().refutedTotal).toBe(1);
        });

        it('bounds a refused order well inside the old 3 s cap', () => {
            const { reg, advance, at } = mk();
            reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
            advance(84);
            reg.confirm([issued(7, CMD_MOVE, [1, 0, 2], 0)]);
            // Worst-case snapshot phase: a full period after the ack.
            advance(1000);
            reg.retire([]);
            advance(250);
            reg.expire();
            expect(reg.size).toBe(0);
            expect(at()).toBeLessThan(3000);   // the pre-L4.4 bound
        });

        it('still retires normally when the snapshot does carry the order', () => {
            const { reg, advance } = mk();
            reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [100, 0, 200] });
            reg.confirm([issued(7, CMD_MOVE, [100, 0, 200], 91)]);
            reg.retire([{
                unitId: 7,
                orders: [{ cmdId: CMD_MOVE, params: [100, 43, 200], options: 0, tag: 91, timeout: 0 }],
            }]);
            expect(reg.stats().retiredTotal).toBe(1);
            expect(reg.stats().refutedTotal).toBe(0);
            advance(5000);
            expect(reg.stats().refutedTotal).toBe(0);
        });

        it('an unconfirmed entry is never refuted by a snapshot', () => {
            // It cannot be: the snapshot may predate our order entirely. Only
            // the ack establishes the ordering that makes absence conclusive.
            const { reg, advance } = mk();
            reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
            reg.retire([]);
            advance(250);
            reg.expire();
            expect(reg.size).toBe(1);          // still drawn, still waiting
            expect(reg.stats().refutedTotal).toBe(0);
        });

        it('a confirmed entry no snapshot ever examined still rides the cap', () => {
            const { reg, advance } = mk();
            reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
            reg.confirm([issued(7, CMD_MOVE, [1, 0, 2], 0)]);
            advance(2900);
            reg.expire();
            expect(reg.size).toBe(1);
            advance(200);
            reg.expire();
            expect(reg.size).toBe(0);
            expect(reg.stats().retiredTotal).toBe(1);   // not refuted
            expect(reg.stats().refutedTotal).toBe(0);
        });
    });

    it('clear() drains everything', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [1, 2, 3], params: [1, 0, 2] });
        reg.clear();
        expect(reg.size).toBe(0);
        expect(reg.merge([])).toEqual([]);
    });

    it('resetStats() keeps live entries but zeroes the counters', () => {
        const { reg } = mk();
        reg.register({ commandId: CMD_MOVE, unitIds: [7], params: [1, 0, 2] });
        reg.resetStats();
        expect(reg.stats().registered).toBe(0);
        expect(reg.stats().unconfirmed).toBe(1);
    });

    // PLAN-latency L4.2 — the factory-queue panel put paramless build orders
    // through merge()/retire() for the first time. A build order has nothing to
    // discriminate on but its `-defId`, so every queued instance on a factory
    // matches every pending one, and the one-to-many matches both paths did
    // silently were suddenly a visibly wrong row count.
    describe('factory build orders (paramless, non-unique)', () => {
        const BUILD = -408;

        /** A factory queue holding `n` identical build orders, tags 1..n. */
        function factoryQueue(unitId: number, n: number): UnitCommandQueueInfo[] {
            return [{
                unitId,
                orders: Array.from({ length: n }, (_, i) => ({
                    cmdId: BUILD, params: [], options: 0, tag: i + 1, timeout: 0,
                })),
            }];
        }

        it('draws a queued build immediately, with a non-addressable tag', () => {
            const { reg } = mk();
            reg.register({ commandId: BUILD, unitIds: [42], params: [] });
            const orders = reg.merge([])[0].orders;
            expect(orders).toHaveLength(1);
            expect(orders[0].cmdId).toBe(BUILD);
            // Synthetic negative tag: confirmed-or-not, it is not a CMD.REMOVE
            // anchor, which is what the panel keys "cancellable" off.
            expect(orders[0].tag).toBeLessThanOrEqual(0);
        });

        it('appends to an existing production run instead of replacing it', () => {
            const { reg } = mk();
            // No shift held — but a build is always treated as appending.
            reg.register({ commandId: BUILD, unitIds: [42], params: [], options: 0 });
            expect(reg.merge(factoryQueue(42, 3))[0].orders).toHaveLength(4);
        });

        it('a freshly-confirmed build shadows at most ONE snapshot order', () => {
            const { reg } = mk();
            reg.register({ commandId: BUILD, unitIds: [42], params: [] });
            reg.confirm([issued(42, BUILD, [], 0)]);
            // An ack that beat its snapshot is the one case the merge-time
            // duplicate guard exists for, and the snapshot may already carry
            // this order — so shadowing one of the three is right. Shadowing
            // all three is not: before L4.2 the guard matched this single
            // entry against every identical build and the row read ×1.
            expect(reg.merge(factoryQueue(42, 3))[0].orders).toHaveLength(3);
            expect(reg.stats().mergeCollisions).toBe(1);
        });

        it('does not shadow an order retire() already proved absent', () => {
            const { reg } = mk();
            reg.register({ commandId: BUILD, unitIds: [42], params: [] });
            reg.confirm([issued(42, BUILD, [], 0)]);
            // retire() runs first on the snapshot path with the same predicate.
            // It keeps the entry, which is proof this snapshot lacks its order.
            reg.retire(factoryQueue(42, 3));
            expect(reg.size).toBe(0);

            // Same again, but with more entries than the snapshot can retire.
            const b = mk().reg;
            b.register({ commandId: BUILD, unitIds: [42], params: [] });
            b.register({ commandId: BUILD, unitIds: [42], params: [] });
            b.confirm([issued(42, BUILD, [], 0), issued(42, BUILD, [], 0)]);
            b.retire(factoryQueue(42, 1));
            expect(b.size).toBe(1);
            // The survivor is vetted, so it adds to the row rather than
            // hiding the one order the snapshot does carry.
            expect(b.merge(factoryQueue(42, 1))[0].orders).toHaveLength(2);
            expect(b.stats().mergeCollisions).toBe(0);
        });

        it('two fast clicks retire against two orders, not one twice', () => {
            const { reg } = mk();
            reg.register({ commandId: BUILD, unitIds: [42], params: [] });
            reg.register({ commandId: BUILD, unitIds: [42], params: [] });
            reg.confirm([issued(42, BUILD, [], 0), issued(42, BUILD, [], 0)]);
            expect(reg.stats().confirmedTotal).toBe(2);
            // The first snapshot carries only the first of the two orders.
            reg.retire(factoryQueue(42, 1));
            expect(reg.size).toBe(1);
            expect(reg.stats().retiredTotal).toBe(1);
            // ...so the row still reads ×2 rather than dipping to ×1.
            expect(reg.merge(factoryQueue(42, 1))[0].orders).toHaveLength(2);
            // The next snapshot carries both and the overlay lets go.
            reg.retire(factoryQueue(42, 2));
            expect(reg.size).toBe(0);
            expect(reg.stats().retiredTotal).toBe(2);
        });
    });
});
