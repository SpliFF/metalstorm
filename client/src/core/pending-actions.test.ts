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
});
