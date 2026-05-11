/**
 * DefCache — client-side accumulator for incrementally streamed defs.
 *
 * The server sends unit and weapon defs on-demand as the player
 * encounters new entity/projectile types. DefCache merges each batch
 * into a persistent Map and notifies listeners when new defs arrive.
 *
 * Consumers (EntityRenderer, ProjectileRenderer, Lua scopes) query
 * this cache rather than holding their own copy of the def list.
 */

import type { UnitDefInfo, WeaponDefInfo, CegDefInfo } from './connection.js';

export type DefListener<T> = (newDefs: T[]) => void;

export class DefCache {
    private unitDefs = new Map<number, UnitDefInfo>();
    private weaponDefs = new Map<number, WeaponDefInfo>();
    /// CEG defs are name-keyed (matched against weapon `cegTag` /
    /// `explosionGenerator` strings), unlike unit/weapon defs which
    /// are integer-keyed. Tags arrive lowercased from the server.
    private cegDefs = new Map<string, CegDefInfo>();

    private unitDefListeners: DefListener<UnitDefInfo>[] = [];
    private weaponDefListeners: DefListener<WeaponDefInfo>[] = [];
    private cegDefListeners: DefListener<CegDefInfo>[] = [];

    /** Merge a batch of unit defs (may contain defs already cached). */
    addUnitDefs(defs: UnitDefInfo[]): void {
        const newDefs: UnitDefInfo[] = [];
        for (const d of defs) {
            if (!this.unitDefs.has(d.defId)) {
                this.unitDefs.set(d.defId, d);
                newDefs.push(d);
            }
        }
        if (newDefs.length > 0) {
            for (const fn of this.unitDefListeners) fn(newDefs);
        }
    }

    /** Merge a batch of weapon defs. */
    addWeaponDefs(defs: WeaponDefInfo[]): void {
        const newDefs: WeaponDefInfo[] = [];
        for (const d of defs) {
            if (!this.weaponDefs.has(d.defId)) {
                this.weaponDefs.set(d.defId, d);
                newDefs.push(d);
            }
        }
        if (newDefs.length > 0) {
            for (const fn of this.weaponDefListeners) fn(newDefs);
        }
    }

    /** Merge a batch of CEG defs. Lookup is by lowercased tag. */
    addCegDefs(defs: CegDefInfo[]): void {
        const newDefs: CegDefInfo[] = [];
        for (const d of defs) {
            const tag = d.tag.toLowerCase();
            if (!this.cegDefs.has(tag)) {
                this.cegDefs.set(tag, d);
                newDefs.push(d);
            }
        }
        if (newDefs.length > 0) {
            for (const fn of this.cegDefListeners) fn(newDefs);
        }
    }

    /** Look up a single unit def. */
    getUnitDef(defId: number): UnitDefInfo | undefined {
        return this.unitDefs.get(defId);
    }

    /** Look up a single weapon def. */
    getWeaponDef(defId: number): WeaponDefInfo | undefined {
        return this.weaponDefs.get(defId);
    }

    /** Look up a single CEG def by tag. Lowercases the input —
     *  CEG references on weapon defs may be authored in mixed case. */
    getCegDef(tag: string): CegDefInfo | undefined {
        if (!tag) return undefined;
        return this.cegDefs.get(tag.toLowerCase());
    }

    /** All cached unit defs. */
    getAllUnitDefs(): UnitDefInfo[] {
        return [...this.unitDefs.values()];
    }

    /** All cached weapon defs. */
    getAllWeaponDefs(): WeaponDefInfo[] {
        return [...this.weaponDefs.values()];
    }

    /** All cached CEG defs. */
    getAllCegDefs(): CegDefInfo[] {
        return [...this.cegDefs.values()];
    }

    /** Subscribe to new unit defs. Called with only the newly added defs. */
    onUnitDefs(fn: DefListener<UnitDefInfo>): void {
        this.unitDefListeners.push(fn);
    }

    /** Subscribe to new weapon defs. Called with only the newly added defs. */
    onWeaponDefs(fn: DefListener<WeaponDefInfo>): void {
        this.weaponDefListeners.push(fn);
    }

    /** Subscribe to new CEG defs. */
    onCegDefs(fn: DefListener<CegDefInfo>): void {
        this.cegDefListeners.push(fn);
    }

    /** Clear all cached defs and listeners (game session ended). */
    clear(): void {
        this.unitDefs.clear();
        this.weaponDefs.clear();
        this.cegDefs.clear();
        this.unitDefListeners.length = 0;
        this.weaponDefListeners.length = 0;
        this.cegDefListeners.length = 0;
    }
}
