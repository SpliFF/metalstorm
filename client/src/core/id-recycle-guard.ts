/**
 * IdRecycleGuard — PLAN-long-uptime S5 task 6.
 *
 * The sim recycles unit ids (`SimObjectIDPool`), so an id is not a name for a
 * unit — it is a name for a *slot*. Every association this client builds on an
 * id and keeps across snapshots (selection, squad membership, clip/aim/wheel
 * poses, PREVLOS ghosts) survives the unit it was made about, and the moment
 * the slot is handed to a new unit those associations silently transfer to a
 * stranger: an order issued to a selection, a squad drawn around a unit that
 * is not in it, a ghost of a building at the position of a tank.
 *
 * The server announces the recycle rather than shipping a per-unit generation
 * counter — the whole tempIDs set becomes re-issuable in one step, so a
 * per-unit encoding conveys nothing extra, and the client's only useful
 * response is wholesale anyway. See EntityStateSerializer.h FLAG_ID_RECYCLED.
 *
 * The rule this class implements is the delivery discipline for that flag:
 *
 *  - the flag LATCHES on any message that carries it (the entity lane is
 *    unreliable and newest-wins, so the flagged message that reaches us may
 *    be a delta even though the server also flagged the full snapshots);
 *  - the flush FIRES on the first FULL snapshot after the latch, because that
 *    is the only message that repopulates the world in the same step — firing
 *    on a delta would blank every unit the delta did not happen to mention.
 *
 * Latching separately from firing is what makes a dropped message harmless:
 * the flag rides ~10 messages, and any one of them arms the flush.
 */
import { FLAG_ID_RECYCLED } from './entity-state.js';

export class IdRecycleGuard {
    private pending = false;
    /** Number of flushes fired — surfaced for the debug HUD / tests. */
    private flushes = 0;

    /**
     * Feed one entity-state message's header. Returns true when the caller
     * must drop its id-keyed state BEFORE applying this snapshot's contents.
     */
    observe(fieldMask: number, isDelta: boolean): boolean {
        if ((fieldMask & FLAG_ID_RECYCLED) !== 0) this.pending = true;
        if (!this.pending || isDelta) return false;
        this.pending = false;
        this.flushes++;
        return true;
    }

    /** Drop a latched flag — for a resync, which flushes everything anyway. */
    reset(): void { this.pending = false; }

    get isPending(): boolean { return this.pending; }
    get flushCount(): number { return this.flushes; }
}
