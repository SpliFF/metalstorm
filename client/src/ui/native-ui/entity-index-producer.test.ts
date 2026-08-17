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

    /**
     * Grid-provider maps (PLAN-metalstorm-command-language.md §5, M2). The
     * gadget now derives a name and a centre for every grid cell and publishes
     * them through the SAME shape the graph provider always used, which is why
     * nothing in this module changed. This asserts the consumer end of that:
     * "defend Sector B3" needs a searchable place, not just a rulesParam.
     */
    it('finds grid sector names — the shape game_regions.lua publishes for a grid map', () => {
        const store = new UIStore();
        const index = new NamedEntityIndex();

        // Keys carry a colon ("col:row"); the region parser's greedy id capture
        // has to survive that as readily as it survives underscores.
        store.updateGameRulesParams({
            'region_0:0_name': 'Sector A1',
            'region_0:0_x': 1024,
            'region_0:0_z': 1024,
            'region_1:2_name': 'Sector B3',
            'region_1:2_x': 3072,
            'region_1:2_z': 5120,
        });

        rebuildEntityIndex(store, index);

        expect(index.get('region', '1:2')?.name).toBe('Sector B3');
        const hit = index.search('sector b3', ['region'])[0];
        expect(hit?.id).toBe('1:2');
        expect(hit?.x).toBe(3072);
        // Two sectors, two names — the grid contributes real places now.
        expect(index.search('sector', ['region']).length).toBe(2);
    });

    /**
     * Landmarks have no publisher yet (scenario-gen lane). Both halves of that
     * matter: absence must cost nothing, and arrival must need no code change.
     */
    it('tolerates the absence of landmark params without disturbing anything else', () => {
        const store = new UIStore();
        const index = new NamedEntityIndex();

        store.updateGameRulesParams({
            region_alpha_name: 'Alpha', region_alpha_x: 1, region_alpha_z: 2,
        });
        rebuildEntityIndex(store, index);

        expect(index.search('', ['landmark'])).toEqual([]);
        expect(index.get('region', 'alpha')?.name).toBe('Alpha');
    });

    it('surfaces a landmark the moment landmark_* params exist', () => {
        const store = new UIStore();
        const index = new NamedEntityIndex();

        store.updateGameRulesParams({
            region_alpha_name: 'Alpha', region_alpha_x: 1, region_alpha_z: 2,
            // What a scenario-gen publisher would write.
            landmark_grain_silo_x: 1200,
            landmark_grain_silo_z: 1800,
            landmark_grain_silo_name: 'Grain Silo',
            // Named from its key alone — the publisher may omit _name.
            landmark_west_scarp_relay_x: 4000,
            landmark_west_scarp_relay_z: 500,
        });
        rebuildEntityIndex(store, index);

        const silo = index.search('grain silo', ['landmark'])[0];
        expect(silo?.name).toBe('Grain Silo');
        expect(silo?.x).toBe(1200);
        expect(index.search('west scarp relay', ['landmark'])[0]?.name).toBe('West Scarp Relay');
        // The region is still there — landmarks are additive, not a replacement.
        expect(index.get('region', 'alpha')?.name).toBe('Alpha');
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
