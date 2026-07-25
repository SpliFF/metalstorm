/**
 * entity-index-producer.test.ts — the live producer that feeds namedEntityIndex
 * from the ui-store (rulesParams + org-group snapshot).
 */

import { describe, it, expect } from 'vitest';
import { UIStore, type OrgGroupSummary } from './ui-store.js';
import { NamedEntityIndex } from './named-entity-index.js';
import {
    orgGroupsToEntities,
    rebuildEntityIndex,
    startEntityIndexProducer,
} from './entity-index-producer.js';

function group(partial: Partial<OrgGroupSummary> & { groupId: number }): OrgGroupSummary {
    return {
        echelon: 'Squad',
        ownerTeam: 0,
        name: `Group ${partial.groupId}`,
        memberIds: [],
        baseCostSum: 0,
        ...partial,
    };
}

describe('orgGroupsToEntities', () => {
    it('maps echelon to the accelerator subject entity types', () => {
        const entities = orgGroupsToEntities([
            group({ groupId: 1, echelon: 'Squad', name: '1st Squad' }),
            group({ groupId: 2, echelon: 'Platoon', name: 'Alpha Platoon' }),
            group({ groupId: 3, echelon: 'Army', name: 'Northern Army' }),
        ]);

        expect(entities.map((e) => e.type)).toEqual(['group', 'platoon', 'army']);
        expect(entities[0].id).toBe(1);
        expect(entities[1].name).toBe('Alpha Platoon');
    });

    it('falls back to a default name and carries member count in metadata', () => {
        const [e] = orgGroupsToEntities([group({ groupId: 9, name: '', memberIds: [10, 11] })]);
        expect(e.name).toBe('Group 9');
        expect(e.metadata?.memberCount).toBe(2);
    });
});

describe('rebuildEntityIndex', () => {
    it('builds regions, region-hinted objectives, and groups from the store', () => {
        const store = new UIStore();
        const index = new NamedEntityIndex();

        store.updateGameRulesParams({
            region_north_market_name: 'North Market',
            region_north_market_x: 5000,
            region_north_market_z: 6000,
            // an active objective hinted at that region (no explicit x/z)
            objective_count: 2,
            objective_1_type: 'control',
            objective_1_state: 'active',
            objective_1_region: 'north_market',
            // a completed objective — must be excluded
            objective_2_type: 'kill',
            objective_2_state: 'complete',
            objective_2_x: 100,
            objective_2_z: 200,
        });
        store.updateOrgGroups([group({ groupId: 1, echelon: 'Platoon', name: 'Alpha Platoon' })]);

        rebuildEntityIndex(store, index);

        const region = index.get('region', 'north_market');
        expect(region?.name).toBe('North Market');

        // Region-hinted objective borrows the region's centroid + name.
        const objective = index.get('objective', 1);
        expect(objective?.name).toBe('Secure: North Market');
        expect(objective?.x).toBe(5000);

        // Completed objective excluded.
        expect(index.get('objective', 2)).toBeUndefined();

        // Group mirrored in for the Subject picker / accelerator.
        expect(index.get('platoon', 1)?.name).toBe('Alpha Platoon');

        // Target-type search finds the region + objective but not the group.
        const targets = index.search('north', ['region', 'objective', 'landmark']);
        expect(targets.map((t) => t.type).sort()).toEqual(['objective', 'region']);
    });
});

describe('startEntityIndexProducer', () => {
    it('seeds the index immediately and clears it on dispose', () => {
        const store = new UIStore();
        const index = new NamedEntityIndex();

        store.updateGameRulesParams({
            region_alpha_name: 'Alpha',
            region_alpha_x: 1,
            region_alpha_z: 2,
        });

        const stop = startEntityIndexProducer(store, index);
        expect(index.get('region', 'alpha')?.name).toBe('Alpha'); // seeded synchronously

        stop();
        expect(index.size).toBe(0); // cleared on teardown
    });
});
