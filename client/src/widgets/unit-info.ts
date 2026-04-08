/**
 * UnitInfo widget — displays info about entities under the cursor.
 *
 * Example JS widget demonstrating the widget API. Tracks entity
 * state updates and provides hover information.
 */

import type { Widget } from '../core/widget-manager.js';
import type { EntityStateSnapshot } from '../core/entity-state.js';

interface TrackedEntity {
    id: number;
    defId: number;
    team: number;
    x: number;
    y: number;
    z: number;
    health: number;
}

export const unitInfoWidget: Widget = {
    name: 'UnitInfo',
    description: 'Shows unit information on hover',
    order: 50,

    // Local entity tracking
    _entities: new Map<number, TrackedEntity>(),

    onActivate() {
        console.log('[UnitInfo] activated');
    },

    onDeactivate() {
        (this as any)._entities.clear();
    },

    onEntityState(snapshot: EntityStateSnapshot, isDelta: boolean) {
        const entities = (this as any)._entities as Map<number, TrackedEntity>;
        if (!snapshot.entityIds) return;

        for (let i = 0; i < snapshot.count; i++) {
            const id = snapshot.entityIds[i];
            let ent = entities.get(id);
            if (!ent) {
                ent = { id, defId: 0, team: 0, x: 0, y: 0, z: 0, health: 1 };
                entities.set(id, ent);
            }
            if (snapshot.positionsX) ent.x = snapshot.positionsX[i];
            if (snapshot.positionsY) ent.y = snapshot.positionsY[i];
            if (snapshot.positionsZ) ent.z = snapshot.positionsZ[i];
            if (snapshot.defIds) ent.defId = snapshot.defIds[i];
            if (snapshot.teams) ent.team = snapshot.teams[i];
            if (snapshot.health) ent.health = snapshot.health[i] / 65535;
        }

        if (!isDelta) {
            const seen = new Set<number>();
            for (let i = 0; i < snapshot.count; i++) seen.add(snapshot.entityIds[i]);
            for (const id of entities.keys()) {
                if (!seen.has(id)) entities.delete(id);
            }
        }
    },

    onUpdate(_dt: number) {
        // Future: update hover UI based on mouse position vs entity positions
    },
} as Widget & { _entities: Map<number, TrackedEntity> };
