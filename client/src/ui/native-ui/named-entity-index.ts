/**
 * named-entity-index.ts — Client-side named-entity index for command composer
 * (PLAN-metalstorm-scripting.md §4)
 *
 * A small index built from already-streamed state: name → { id, type, x, z }
 * Used by the command composer's autocomplete.
 *
 * Entity types:
 *   - regions / districts / cities (from region graph + rulesParams)
 *   - org groups / platoons / armies (from macro-orders names)
 *   - active objectives (from objectives rulesParams stream)
 *   - landmarks (from map/scenario file)
 *   - known enemy forces (coarse summaries from macro-map aggregation)
 *
 * Rebuilt incrementally on state change (change-driven, not per-frame).
 * Every entry resolves to a map location for the "locate" ping.
 */

export type EntityType =
    | 'region'
    | 'district'
    | 'city'
    | 'group'
    | 'platoon'
    | 'army'
    | 'objective'
    | 'landmark'
    | 'enemy-force';

export interface NamedEntity {
    id: number | string;   // Numeric for units/objectives, string for regions/landmarks
    type: EntityType;
    name: string;
    x: number;             // Map X coordinate (elmos)
    z: number;             // Map Z coordinate (elmos)
    metadata?: any;        // Type-specific extra data
}

/**
 * NamedEntityIndex — maintains a searchable index of named entities.
 *
 * Built incrementally from:
 *   - gameRulesParams: regions, objectives, landmarks
 *   - teamRulesParams: org groups
 *   - Entity state: known enemy forces (future)
 *
 * Provides fuzzy search for autocomplete.
 */
export class NamedEntityIndex {
    private entities = new Map<string, NamedEntity>(); // key = `${type}:${id}`
    private nameIndex = new Map<string, Set<string>>(); // lowercase name -> set of keys
    private changeListeners = new Set<() => void>();

    constructor() {}

    /**
     * Add or update a named entity in the index.
     */
    add(entity: NamedEntity): void {
        const key = this.makeKey(entity.type, entity.id);
        const existing = this.entities.get(key);

        // Update entity
        this.entities.set(key, entity);

        // Update name index
        const lowerName = entity.name.toLowerCase();

        // Remove old name from index if it changed
        if (existing && existing.name.toLowerCase() !== lowerName) {
            const oldLowerName = existing.name.toLowerCase();
            const oldSet = this.nameIndex.get(oldLowerName);
            if (oldSet) {
                oldSet.delete(key);
                if (oldSet.size === 0) {
                    this.nameIndex.delete(oldLowerName);
                }
            }
        }

        // Add new name to index
        let nameSet = this.nameIndex.get(lowerName);
        if (!nameSet) {
            nameSet = new Set();
            this.nameIndex.set(lowerName, nameSet);
        }
        nameSet.add(key);

        this.notifyChange();
    }

    /**
     * Remove an entity from the index.
     */
    remove(type: EntityType, id: number | string): void {
        const key = this.makeKey(type, id);
        const entity = this.entities.get(key);
        if (!entity) return;

        // Remove from name index
        const lowerName = entity.name.toLowerCase();
        const nameSet = this.nameIndex.get(lowerName);
        if (nameSet) {
            nameSet.delete(key);
            if (nameSet.size === 0) {
                this.nameIndex.delete(lowerName);
            }
        }

        // Remove from main index
        this.entities.delete(key);
        this.notifyChange();
    }

    /**
     * Get an entity by type and id.
     */
    get(type: EntityType, id: number | string): NamedEntity | undefined {
        return this.entities.get(this.makeKey(type, id));
    }

    /**
     * Search for entities by name (fuzzy substring match).
     * Returns results sorted by relevance (exact match first, then prefix match, then contains).
     *
     * @param query - Search string
     * @param typeFilter - Optional filter by entity type(s)
     * @param limit - Max results (default 10)
     */
    search(query: string, typeFilter?: EntityType | EntityType[], limit = 10): NamedEntity[] {
        if (!query) return [];

        const lowerQuery = query.toLowerCase();
        const results: Array<{ entity: NamedEntity; score: number }> = [];
        const types = typeFilter ? (Array.isArray(typeFilter) ? typeFilter : [typeFilter]) : null;

        // Search through all entities
        for (const entity of this.entities.values()) {
            // Apply type filter
            if (types && !types.includes(entity.type)) continue;

            const lowerName = entity.name.toLowerCase();

            // Calculate relevance score
            let score = 0;
            if (lowerName === lowerQuery) {
                score = 1000; // Exact match
            } else if (lowerName.startsWith(lowerQuery)) {
                score = 500; // Prefix match
            } else if (lowerName.includes(lowerQuery)) {
                score = 100; // Contains match
            } else {
                // Try fuzzy match (simple word boundary check)
                const words = lowerName.split(/\s+/);
                for (const word of words) {
                    if (word.startsWith(lowerQuery)) {
                        score = 50;
                        break;
                    }
                }
            }

            if (score > 0) {
                results.push({ entity, score });
            }
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);

        // Return top N
        return results.slice(0, limit).map(r => r.entity);
    }

    /**
     * Get all entities of a specific type.
     */
    getByType(type: EntityType): NamedEntity[] {
        const results: NamedEntity[] = [];
        for (const entity of this.entities.values()) {
            if (entity.type === type) {
                results.push(entity);
            }
        }
        return results;
    }

    /**
     * Get all entities (for debugging/inspection).
     */
    getAll(): NamedEntity[] {
        return Array.from(this.entities.values());
    }

    /**
     * Clear all entities from the index.
     */
    clear(): void {
        this.entities.clear();
        this.nameIndex.clear();
        this.notifyChange();
    }

    /**
     * Atomically replace the entire index contents with `entities`, firing a
     * single change notification.
     *
     * This is the producer's write path (entity-index-producer.ts): each
     * rulesParams / org-group change rebuilds the whole entity set from the
     * store snapshot, and a per-`add()` notify would re-render the composer's
     * open Target menu once per entity. `replaceAll` collapses that to one
     * rebuild → one notify. Entity *identity* is still keyed on `(type, id)`,
     * so a rename between rebuilds is picked up (the display name changes)
     * without the id-keyed references in a saved preset going stale.
     */
    replaceAll(entities: NamedEntity[]): void {
        this.entities.clear();
        this.nameIndex.clear();
        for (const entity of entities) {
            const key = this.makeKey(entity.type, entity.id);
            this.entities.set(key, entity);
            const lowerName = entity.name.toLowerCase();
            let nameSet = this.nameIndex.get(lowerName);
            if (!nameSet) {
                nameSet = new Set();
                this.nameIndex.set(lowerName, nameSet);
            }
            nameSet.add(key);
        }
        this.notifyChange();
    }

    /**
     * Subscribe to index changes.
     * Returns an unsubscribe function.
     */
    onChange(callback: () => void): () => void {
        this.changeListeners.add(callback);
        return () => {
            this.changeListeners.delete(callback);
        };
    }

    /**
     * Get the number of entities in the index.
     */
    get size(): number {
        return this.entities.size;
    }

    // ─── Internal ───

    private makeKey(type: EntityType, id: number | string): string {
        return `${type}:${id}`;
    }

    private notifyChange(): void {
        for (const listener of this.changeListeners) {
            try {
                listener();
            } catch (e) {
                console.error('[named-entity-index] Change listener error:', e);
            }
        }
    }
}

/**
 * The wire shapes below are the ACTUAL rulesParams the Metalstorm gadgets
 * publish (flat, underscore-delimited keys — the Spring rulesParam
 * convention), NOT a synthetic colon-delimited contract. See:
 *   - regions:    game_regions.lua      → `region_<key>_name/_x/_z`
 *   - objectives: game_objectives.lua   → `objective_<id>_type/_state/_region/_x/_z` + `objective_count`
 *   - landmarks:  (no publisher yet)    → `landmark_<name>_x/_z` (reserved shape)
 * Region keys and landmark names can themselves contain underscores
 * (`west_scarp_n`), so every parser anchors the field suffix at end-of-string
 * and lets the greedy `(.+)` capture the full id — never split on the first
 * underscore.
 */

/**
 * Parse regions from gameRulesParams into named entities.
 *
 * `region_<key>_name` (display string) + `region_<key>_x` / `_z` (polygon
 * centroid, elmos) — published once at setup by game_regions.lua. A region is
 * only emitted once all three are present (grid-provider maps publish none of
 * them, so they contribute no named places). The dynamic `region_<key>_team` /
 * `_contested` control state is intentionally NOT part of the entity — it
 * changes far more often than the composer needs and belongs to the strategic
 * overlay, not the name index.
 */
export function parseRegionsFromRulesParams(
    params: ReadonlyMap<string, number | string>
): NamedEntity[] {
    const regions = new Map<string, Partial<NamedEntity>>();

    for (const [key, value] of params.entries()) {
        const match = key.match(/^region_(.+)_(name|x|z)$/);
        if (!match) continue;

        const [, id, field] = match;
        let region = regions.get(id);
        if (!region) {
            region = { id, type: 'region' };
            regions.set(id, region);
        }

        if (field === 'name' && typeof value === 'string') {
            region.name = value;
        } else if (field === 'x' && typeof value === 'number') {
            region.x = value;
        } else if (field === 'z' && typeof value === 'number') {
            region.z = value;
        }
    }

    const result: NamedEntity[] = [];
    for (const region of regions.values()) {
        if (region.name && typeof region.x === 'number' && typeof region.z === 'number') {
            result.push(region as NamedEntity);
        }
    }

    return result;
}

/** Human-readable label for an objective's compile-side `type` string
 *  (objectives/*.lua). Falls back to a capitalised raw type for any newer type
 *  not enumerated here, so an unknown objective still gets a sensible name. */
const OBJECTIVE_TYPE_LABELS: Record<string, string> = {
    control: 'Secure',
    secure: 'Secure',
    kill: 'Destroy',
    escort: 'Escort',
    protect: 'Protect',
    infra: 'Hold',
    extract: 'Extract',
};

function objectiveTypeLabel(type: string): string {
    return OBJECTIVE_TYPE_LABELS[type] ?? (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Objective');
}

/**
 * Parse ACTIVE objectives from gameRulesParams into named entities.
 *
 * Objectives publish `objective_count` + a per-id field block
 * (`objective_<id>_type/_state/_region/_x/_z`). Only `state === 'active'`
 * objectives are indexed — completed/failed ones drop out of the Target
 * picker. An objective carries EITHER an explicit `_x/_z` OR a `_region`
 * key (never both — game_objectives.lua positionHint), so region-hinted
 * objectives borrow their location (and region name) from `resolveRegion`,
 * the region lookup the producer builds from the regions parsed above. An
 * objective with no resolvable position is skipped: the composer can't offer
 * a locate-ping or a coordinate target for it.
 */
export function parseObjectivesFromRulesParams(
    params: ReadonlyMap<string, number | string>,
    resolveRegion?: (key: string) => { name: string; x: number; z: number } | undefined
): NamedEntity[] {
    const count = Number(params.get('objective_count') ?? 0);
    if (!Number.isFinite(count) || count <= 0) return [];

    const result: NamedEntity[] = [];
    for (let id = 1; id <= count; id++) {
        const p = `objective_${id}_`;
        const state = params.get(`${p}state`);
        if (state !== 'active') continue;

        const type = String(params.get(`${p}type`) ?? '');
        const rawX = params.get(`${p}x`);
        const rawZ = params.get(`${p}z`);
        const regionKey = params.get(`${p}region`);

        let x: number | undefined;
        let z: number | undefined;
        let place: string | undefined;

        if (typeof rawX === 'number' && typeof rawZ === 'number') {
            x = rawX;
            z = rawZ;
        } else if (typeof regionKey === 'string' && resolveRegion) {
            const region = resolveRegion(regionKey);
            if (region) {
                x = region.x;
                z = region.z;
                place = region.name;
            }
        }

        if (typeof x !== 'number' || typeof z !== 'number') continue; // unlocatable → not a pickable target

        const label = objectiveTypeLabel(type);
        const name = place ? `${label}: ${place}` : `${label} #${id}`;
        result.push({
            id,
            type: 'objective',
            name,
            x,
            z,
            metadata: { objType: type, state, region: regionKey },
        });
    }

    return result;
}

/**
 * Parse landmarks from gameRulesParams (`landmark_<name>_x/_z`).
 *
 * No gadget publishes landmarks yet (scenario/map-authored places are a
 * future producer — PLAN-persistence §5); this parser exists so that path is
 * a data change, not a code change, and to keep the free-text accelerator's
 * `landmark` target type meaningful the moment they land.
 */
export function parseLandmarksFromRulesParams(
    params: ReadonlyMap<string, number | string>
): NamedEntity[] {
    const landmarks = new Map<string, Partial<NamedEntity>>();

    for (const [key, value] of params.entries()) {
        const match = key.match(/^landmark_(.+)_(x|z)$/);
        if (!match) continue;

        const [, name, field] = match;
        let landmark = landmarks.get(name);
        if (!landmark) {
            landmark = { id: name, name, type: 'landmark' };
            landmarks.set(name, landmark);
        }

        if (field === 'x' && typeof value === 'number') {
            landmark.x = value;
        } else if (field === 'z' && typeof value === 'number') {
            landmark.z = value;
        }
    }

    const result: NamedEntity[] = [];
    for (const landmark of landmarks.values()) {
        if (typeof landmark.x === 'number' && typeof landmark.z === 'number') {
            result.push(landmark as NamedEntity);
        }
    }

    return result;
}

// Export singleton instance
export const namedEntityIndex = new NamedEntityIndex();
