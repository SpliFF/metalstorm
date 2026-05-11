/**
 * IntelTransitionTracker — synthesises LOS / radar / cloak callins on
 * the client by diffing successive entity-state snapshots.
 *
 * The server already streams the per-unit `losStatus` byte with every
 * entity-state envelope (see entity-state.ts FIELD_LOS_STATE). For
 * Spring/Recoil parity we still need to fire `widgetHandler:UnitEnteredLos`
 * etc. when those bits change. Doing the diff here keeps the wire format
 * unchanged and matches Spring's own `LOS_UPDATE_RATE = 5` cadence
 * (transitions inside one snapshot window collapse — acceptable, since
 * upstream already loses sub-tick flickers).
 *
 * Entities present in the snapshot but missing from the previous one are
 * treated as having had `losState=0`, so the corresponding `Entered*`
 * events fire on first sight. Entities that drop out of a *full* snapshot
 * (the server stopped sending them) emit `Left*` events for whichever
 * bits were set on the last seen frame. Delta snapshots do not cause
 * eviction — only full snapshots do.
 *
 * Cloak transitions diff bit 5 of `state_bits` (FIELD_STATE_BITS, see
 * entity-state.ts comment block). They are unit-only on the wire — the
 * synthesised callin signature mirrors `widgetHandler:UnitCloaked`'s
 * `(unitID, unitDefID, unitTeam)`, so the worker can dispatch directly.
 *
 * Recoil semantics: enemies that cloak while in our LOS are dropped from
 * the snapshot entirely (the server-side cloak filter handles this — see
 * EntityStateSerializer). The client therefore sees `LeftLos` for those,
 * NOT `UnitCloaked`. `UnitCloaked` only fires for own / allied units the
 * client actually observes the transition on.
 */

import type { EntityStateSnapshot } from './entity-state.js';

const LOS_INLOS    = 1 << 0;
const LOS_INRADAR  = 1 << 1;
// LOS_PREVLOS = 1 << 2 — currently not surfaced as a callin
// LOS_CONTRADAR = 1 << 3 — same
const STATE_CLOAKED = 1 << 5;

export type IntelTransitionKind =
    | 'enteredLos'
    | 'leftLos'
    | 'enteredRadar'
    | 'leftRadar'
    | 'cloaked'
    | 'decloaked';

export interface UnitTransition {
    kind: IntelTransitionKind;
    unitId: number;
    /** Owner team of the unit. Used for the `unitTeam` arg in widgetHandler. */
    unitTeam: number;
    /** Unit-def id, for the `unitDefID` arg in widgetHandler. */
    unitDefId: number;
}

interface EntityIntelState {
    losState: number;
    stateBits: number;
    team: number;
    defId: number;
}

export class IntelTransitionTracker {
    /** Per-entity last-seen intel state. Eviction happens on full snapshots. */
    private readonly prev = new Map<number, EntityIntelState>();

    /**
     * Diff the new snapshot against the previous one and return the
     * resulting transitions. Mutates the internal state map.
     *
     * For delta snapshots, fields not included in the field mask are
     * considered unchanged for the diff (e.g. losState absent → keep
     * prev.losState). For full snapshots, missing fields default to
     * "no change from prev"; missing entities are evicted and emit
     * `Left*` callins for whichever bits they had set.
     */
    diffSnapshot(snapshot: EntityStateSnapshot, isDelta: boolean): UnitTransition[] {
        const out: UnitTransition[] = [];

        const ids = snapshot.entityIds;
        if (!ids) return out;

        const losStates = snapshot.losStates;
        const stateBits = snapshot.stateBits;
        const teams = snapshot.teams;
        const defIds = snapshot.defIds;

        const seen = isDelta ? null : new Set<number>();

        for (let i = 0; i < snapshot.count; i++) {
            const id = ids[i];
            seen?.add(id);

            const prev = this.prev.get(id);
            const isNew = !prev;

            // Resolve effective per-field values: snapshot wins, else carry
            // forward, else default. Defaults mirror entity-renderer.ts —
            // a brand-new entity with no losState in its first snapshot is
            // treated as fully visible (own/allied or permissive session).
            const team  = teams ? teams[i]  : prev?.team  ?? 0;
            const defId = defIds ? defIds[i] : prev?.defId ?? 0;
            const newLos = losStates ? losStates[i] : prev?.losState ?? 0x0F;
            const newSb  = stateBits ? stateBits[i] : prev?.stateBits ?? 0;

            // For brand-new entities, treat the previous state as "nothing
            // visible / not cloaked" so the *first* visible frame fires
            // the matching Entered callin.
            const oldLos = isNew ? 0 : prev!.losState;
            const oldSb  = isNew ? 0 : prev!.stateBits;

            const losChanged = oldLos !== newLos;
            const sbChanged  = (oldSb & STATE_CLOAKED) !== (newSb & STATE_CLOAKED);

            if (losChanged) {
                const wasInLos   = (oldLos & LOS_INLOS) !== 0;
                const wasInRadar = (oldLos & LOS_INRADAR) !== 0;
                const inLos      = (newLos & LOS_INLOS) !== 0;
                const inRadar    = (newLos & LOS_INRADAR) !== 0;

                if (!wasInLos && inLos)
                    out.push({ kind: 'enteredLos', unitId: id, unitTeam: team, unitDefId: defId });
                else if (wasInLos && !inLos)
                    out.push({ kind: 'leftLos', unitId: id, unitTeam: team, unitDefId: defId });

                if (!wasInRadar && inRadar)
                    out.push({ kind: 'enteredRadar', unitId: id, unitTeam: team, unitDefId: defId });
                else if (wasInRadar && !inRadar)
                    out.push({ kind: 'leftRadar', unitId: id, unitTeam: team, unitDefId: defId });
            }

            if (sbChanged) {
                const wasCloaked = (oldSb & STATE_CLOAKED) !== 0;
                const isCloaked  = (newSb & STATE_CLOAKED) !== 0;
                out.push({
                    kind: isCloaked ? 'cloaked' : 'decloaked',
                    unitId: id,
                    unitTeam: team,
                    unitDefId: defId,
                });
            }

            this.prev.set(id, { losState: newLos, stateBits: newSb, team, defId });
        }

        // Full snapshot eviction: any entity not in this snapshot has
        // dropped out of our view entirely. Fire Left* / Decloaked for
        // whichever bits were set, then drop the entry.
        if (seen) {
            for (const [id, state] of this.prev) {
                if (seen.has(id)) continue;
                if ((state.losState & LOS_INLOS) !== 0) {
                    out.push({ kind: 'leftLos', unitId: id, unitTeam: state.team, unitDefId: state.defId });
                }
                if ((state.losState & LOS_INRADAR) !== 0) {
                    out.push({ kind: 'leftRadar', unitId: id, unitTeam: state.team, unitDefId: state.defId });
                }
                this.prev.delete(id);
            }
        }

        return out;
    }

    /** Drop a single entity's tracking. Call from EntityDestroy so
     *  killed-while-out-of-LOS units don't fire spurious Left* callins
     *  the next time we receive a full snapshot.
     *  We intentionally do NOT emit Left* / Decloaked here — the kill
     *  itself already produces a UnitDestroyed callin chain. */
    forget(unitId: number): void {
        this.prev.delete(unitId);
    }

    /** Reset all tracking. Call on game restart / disconnect. */
    reset(): void {
        this.prev.clear();
    }

    size(): number {
        return this.prev.size;
    }
}
