/**
 * named-entity-index.test.ts — Tests for NamedEntityIndex
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    NamedEntityIndex,
    parseRegionsFromRulesParams,
    parseObjectivesFromRulesParams,
    parseLandmarksFromRulesParams,
    type NamedEntity,
} from './named-entity-index.js';

describe('NamedEntityIndex', () => {
    let index: NamedEntityIndex;

    beforeEach(() => {
        index = new NamedEntityIndex();
    });

    describe('add and get', () => {
        it('should add and retrieve entities', () => {
            const entity: NamedEntity = {
                id: 'region1',
                type: 'region',
                name: 'North Basin',
                x: 1000,
                z: 2000,
            };

            index.add(entity);
            expect(index.size).toBe(1);

            const retrieved = index.get('region', 'region1');
            expect(retrieved).toEqual(entity);
        });

        it('should update existing entities', () => {
            const entity: NamedEntity = {
                id: 1,
                type: 'objective',
                name: 'Capture City',
                x: 500,
                z: 600,
            };

            index.add(entity);

            // Update with new position
            const updated: NamedEntity = {
                ...entity,
                x: 700,
                z: 800,
            };
            index.add(updated);

            expect(index.size).toBe(1);
            const retrieved = index.get('objective', 1);
            expect(retrieved?.x).toBe(700);
            expect(retrieved?.z).toBe(800);
        });

        it('should handle name changes', () => {
            const entity: NamedEntity = {
                id: 1,
                type: 'group',
                name: '3rd Armoured',
                x: 100,
                z: 200,
            };

            index.add(entity);

            // Update name
            const renamed: NamedEntity = {
                ...entity,
                name: '3rd Tank Division',
            };
            index.add(renamed);

            // Search by old name should fail
            expect(index.search('3rd Armoured')).toHaveLength(0);
            // Search by new name should succeed
            expect(index.search('3rd Tank')).toHaveLength(1);
        });
    });

    describe('remove', () => {
        it('should remove entities', () => {
            const entity: NamedEntity = {
                id: 1,
                type: 'objective',
                name: 'Test Objective',
                x: 100,
                z: 200,
            };

            index.add(entity);
            expect(index.size).toBe(1);

            index.remove('objective', 1);
            expect(index.size).toBe(0);
            expect(index.get('objective', 1)).toBeUndefined();
        });
    });

    describe('search', () => {
        beforeEach(() => {
            // Add test data
            index.add({
                id: 'r1',
                type: 'region',
                name: 'Meridian City',
                x: 1000,
                z: 1000,
            });
            index.add({
                id: 'r2',
                type: 'region',
                name: 'North Basin',
                x: 2000,
                z: 2000,
            });
            index.add({
                id: 1,
                type: 'group',
                name: '3rd Armoured Division',
                x: 1500,
                z: 1500,
            });
            index.add({
                id: 2,
                type: 'objective',
                name: 'Defend Meridian',
                x: 1100,
                z: 1100,
            });
        });

        it('should find exact matches', () => {
            const results = index.search('Meridian City');
            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('Meridian City');
        });

        it('should find prefix matches', () => {
            const results = index.search('North');
            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('North Basin');
        });

        it('should find substring matches', () => {
            const results = index.search('meridian');
            expect(results).toHaveLength(2); // "Meridian City" and "Defend Meridian"
            // Exact match should be first
            expect(results[0].name).toBe('Meridian City');
        });

        it('should be case-insensitive', () => {
            const results = index.search('MERIDIAN');
            expect(results.length).toBeGreaterThan(0);
        });

        it('should filter by type', () => {
            const results = index.search('meridian', 'region');
            expect(results).toHaveLength(1);
            expect(results[0].type).toBe('region');
        });

        it('should filter by multiple types', () => {
            const results = index.search('meridian', ['region', 'objective']);
            expect(results).toHaveLength(2);
        });

        it('should limit results', () => {
            const results = index.search('', undefined, 2);
            expect(results.length).toBeLessThanOrEqual(2);
        });

        it('should match word boundaries', () => {
            const results = index.search('3rd');
            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('3rd Armoured Division');
        });
    });

    describe('getByType', () => {
        it('should return all entities of a type', () => {
            index.add({
                id: 'r1',
                type: 'region',
                name: 'Region 1',
                x: 100,
                z: 100,
            });
            index.add({
                id: 'r2',
                type: 'region',
                name: 'Region 2',
                x: 200,
                z: 200,
            });
            index.add({
                id: 1,
                type: 'objective',
                name: 'Objective 1',
                x: 300,
                z: 300,
            });

            const regions = index.getByType('region');
            expect(regions).toHaveLength(2);

            const objectives = index.getByType('objective');
            expect(objectives).toHaveLength(1);
        });
    });

    describe('onChange', () => {
        it('should notify listeners on add', () => {
            let changeCount = 0;
            index.onChange(() => {
                changeCount++;
            });

            index.add({
                id: 1,
                type: 'region',
                name: 'Test',
                x: 100,
                z: 100,
            });

            expect(changeCount).toBe(1);
        });

        it('should notify listeners on remove', () => {
            index.add({
                id: 1,
                type: 'region',
                name: 'Test',
                x: 100,
                z: 100,
            });

            let changeCount = 0;
            index.onChange(() => {
                changeCount++;
            });

            index.remove('region', 1);
            expect(changeCount).toBe(1);
        });

        it('should support unsubscribe', () => {
            let changeCount = 0;
            const unsubscribe = index.onChange(() => {
                changeCount++;
            });

            index.add({
                id: 1,
                type: 'region',
                name: 'Test',
                x: 100,
                z: 100,
            });
            expect(changeCount).toBe(1);

            unsubscribe();

            index.add({
                id: 2,
                type: 'region',
                name: 'Test 2',
                x: 200,
                z: 200,
            });
            expect(changeCount).toBe(1); // Should not have changed
        });
    });
});

describe('replaceAll', () => {
    it('replaces contents and fires a single change notification', () => {
        const index = new NamedEntityIndex();
        index.add({ id: 'old', type: 'region', name: 'Old Region', x: 0, z: 0 });

        let changes = 0;
        index.onChange(() => { changes++; });

        index.replaceAll([
            { id: 'r1', type: 'region', name: 'Alpha', x: 1, z: 2 },
            { id: 'r2', type: 'region', name: 'Beta', x: 3, z: 4 },
            { id: 5, type: 'objective', name: 'Secure Alpha', x: 1, z: 2 },
        ]);

        expect(changes).toBe(1);                       // one notify for the whole rebuild
        expect(index.size).toBe(3);
        expect(index.get('region', 'old')).toBeUndefined(); // prior contents gone
        expect(index.search('Beta')).toHaveLength(1);       // name index rebuilt too
        expect(index.get('objective', 5)?.name).toBe('Secure Alpha');
    });
});

describe('parseRegionsFromRulesParams', () => {
    it('parses regions from region_<key>_name/_x/_z (keys may contain underscores)', () => {
        const params = new Map<string, number | string>([
            ['region_north_basin_name', 'North Basin'],
            ['region_north_basin_x', 1000],
            ['region_north_basin_z', 2000],
            ['region_west_scarp_n_name', 'West Scarp'],
            ['region_west_scarp_n_x', 3000],
            ['region_west_scarp_n_z', 4000],
            // control state and the rev counter must NOT be parsed as regions
            ['region_north_basin_team', 1],
            ['region_north_basin_contested', 0],
            ['regions_rev', 7],
        ]);

        const regions = parseRegionsFromRulesParams(params);
        expect(regions).toHaveLength(2);
        const byId = new Map(regions.map((r) => [r.id, r]));
        expect(byId.get('north_basin')?.name).toBe('North Basin');
        expect(byId.get('north_basin')?.x).toBe(1000);
        expect(byId.get('west_scarp_n')?.name).toBe('West Scarp');
        expect(byId.get('west_scarp_n')?.z).toBe(4000);
    });

    it('ignores incomplete regions (missing centroid)', () => {
        const params = new Map<string, number | string>([
            ['region_incomplete_name', 'Incomplete'], // no x/z
            ['region_complete_name', 'Complete'],
            ['region_complete_x', 100],
            ['region_complete_z', 200],
        ]);

        const regions = parseRegionsFromRulesParams(params);
        expect(regions).toHaveLength(1);
        expect(regions[0].name).toBe('Complete');
    });
});

describe('parseObjectivesFromRulesParams', () => {
    it('parses only active objectives, up to objective_count', () => {
        const params = new Map<string, number | string>([
            ['objective_count', 2],
            ['objective_1_type', 'kill'],
            ['objective_1_state', 'active'],
            ['objective_1_x', 1000],
            ['objective_1_z', 2000],
            ['objective_2_type', 'secure'],
            ['objective_2_state', 'complete'], // completed → filtered out
            ['objective_2_x', 3000],
            ['objective_2_z', 4000],
        ]);

        const objectives = parseObjectivesFromRulesParams(params);
        expect(objectives).toHaveLength(1);
        expect(objectives[0].id).toBe(1);
        expect(objectives[0].name).toBe('Destroy #1');       // type label + id (no region name)
        expect(objectives[0].x).toBe(1000);
        expect(objectives[0].metadata?.objType).toBe('kill');
    });

    it('resolves region-hinted objectives via the region resolver', () => {
        const params = new Map<string, number | string>([
            ['objective_count', 1],
            ['objective_1_type', 'control'],
            ['objective_1_state', 'active'],
            ['objective_1_region', 'north_market'],
        ]);

        const objectives = parseObjectivesFromRulesParams(params, (key) =>
            key === 'north_market' ? { name: 'North Market', x: 5000, z: 6000 } : undefined);

        expect(objectives).toHaveLength(1);
        expect(objectives[0].name).toBe('Secure: North Market'); // borrows region name
        expect(objectives[0].x).toBe(5000);
        expect(objectives[0].z).toBe(6000);
    });

    it('skips objectives with no resolvable position', () => {
        const params = new Map<string, number | string>([
            ['objective_count', 1],
            ['objective_1_type', 'control'],
            ['objective_1_state', 'active'],
            ['objective_1_region', 'unknown_region'], // resolver returns undefined
        ]);

        const objectives = parseObjectivesFromRulesParams(params, () => undefined);
        expect(objectives).toHaveLength(0);
    });

    it('returns nothing when objective_count is absent', () => {
        expect(parseObjectivesFromRulesParams(new Map())).toHaveLength(0);
    });
});

describe('parseLandmarksFromRulesParams', () => {
    it('parses landmarks from landmark_<name>_x/_z', () => {
        const params = new Map<string, number | string>([
            ['landmark_Central Tower_x', 1000],
            ['landmark_Central Tower_z', 2000],
            ['landmark_Eastern Bridge_x', 3000],
            ['landmark_Eastern Bridge_z', 4000],
        ]);

        const landmarks = parseLandmarksFromRulesParams(params);
        expect(landmarks).toHaveLength(2);
        const byId = new Map(landmarks.map((l) => [l.id, l]));
        expect(byId.get('Central Tower')?.name).toBe('Central Tower');
        expect(byId.get('Eastern Bridge')?.x).toBe(3000);
    });
});
