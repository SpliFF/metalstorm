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
 * Helper to parse a region from gameRulesParams.
 * Regions are stored as:
 *   region:${id}:name = string
 *   region:${id}:x = number
 *   region:${id}:z = number
 */
export function parseRegionsFromRulesParams(
    params: Map<string, number | string>
): NamedEntity[] {
    const regions = new Map<string, Partial<NamedEntity>>();

    for (const [key, value] of params.entries()) {
        const match = key.match(/^region:([^:]+):(.+)$/);
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

    // Filter complete regions
    const result: NamedEntity[] = [];
    for (const region of regions.values()) {
        if (region.name && typeof region.x === 'number' && typeof region.z === 'number') {
            result.push(region as NamedEntity);
        }
    }

    return result;
}

/**
 * Helper to parse objectives from gameRulesParams.
 * Objectives are stored as:
 *   objective:${id}:name = string
 *   objective:${id}:x = number
 *   objective:${id}:z = number
 *   objective:${id}:active = 1 (only include if active)
 */
export function parseObjectivesFromRulesParams(
    params: Map<string, number | string>
): NamedEntity[] {
    const objectives = new Map<number, Partial<NamedEntity>>();

    for (const [key, value] of params.entries()) {
        const match = key.match(/^objective:(\d+):(.+)$/);
        if (!match) continue;

        const [, idStr, field] = match;
        const id = parseInt(idStr, 10);
        let objective = objectives.get(id);
        if (!objective) {
            objective = { id, type: 'objective' };
            objectives.set(id, objective);
        }

        if (field === 'name' && typeof value === 'string') {
            objective.name = value;
        } else if (field === 'x' && typeof value === 'number') {
            objective.x = value;
        } else if (field === 'z' && typeof value === 'number') {
            objective.z = value;
        } else if (field === 'active') {
            objective.metadata = { ...objective.metadata, active: value === 1 };
        }
    }

    // Filter complete and active objectives
    const result: NamedEntity[] = [];
    for (const objective of objectives.values()) {
        if (
            objective.name &&
            typeof objective.x === 'number' &&
            typeof objective.z === 'number' &&
            objective.metadata?.active
        ) {
            result.push(objective as NamedEntity);
        }
    }

    return result;
}

/**
 * Helper to parse landmarks from gameRulesParams.
 * Landmarks are stored as:
 *   landmark:${name}:x = number
 *   landmark:${name}:z = number
 */
export function parseLandmarksFromRulesParams(
    params: Map<string, number | string>
): NamedEntity[] {
    const landmarks = new Map<string, Partial<NamedEntity>>();

    for (const [key, value] of params.entries()) {
        const match = key.match(/^landmark:([^:]+):(.+)$/);
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

    // Filter complete landmarks
    const result: NamedEntity[] = [];
    for (const landmark of landmarks.values()) {
        if (typeof landmark.x === 'number' && typeof landmark.z === 'number') {
            result.push(landmark as NamedEntity);
        }
    }

    return result;
}

/**
 * Helper to parse org groups from teamRulesParams.
 * Groups are stored as:
 *   org:group:${id}:name = string
 *   org:group:${id}:x = number (centroid)
 *   org:group:${id}:z = number (centroid)
 */
export function parseOrgGroupsFromTeamRulesParams(
    params: Map<string, number | string>,
    defaultType: Extract<EntityType, 'group' | 'platoon' | 'army'> = 'group'
): NamedEntity[] {
    const groups = new Map<number, Partial<NamedEntity>>();

    for (const [key, value] of params.entries()) {
        const match = key.match(/^org:(?:group|platoon|army):(\d+):(.+)$/);
        if (!match) continue;

        const [, idStr, field] = match;
        const id = parseInt(idStr, 10);
        let group = groups.get(id);
        if (!group) {
            group = { id, type: defaultType };
            groups.set(id, group);
        }

        if (field === 'name' && typeof value === 'string') {
            group.name = value;
        } else if (field === 'x' && typeof value === 'number') {
            group.x = value;
        } else if (field === 'z' && typeof value === 'number') {
            group.z = value;
        }
    }

    // Filter complete groups
    const result: NamedEntity[] = [];
    for (const group of groups.values()) {
        if (group.name && typeof group.x === 'number' && typeof group.z === 'number') {
            result.push(group as NamedEntity);
        }
    }

    return result;
}

// Export singleton instance
export const namedEntityIndex = new NamedEntityIndex();
