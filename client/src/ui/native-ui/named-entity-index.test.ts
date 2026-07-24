/**
 * named-entity-index.test.ts — Tests for NamedEntityIndex
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    NamedEntityIndex,
    parseRegionsFromRulesParams,
    parseObjectivesFromRulesParams,
    parseLandmarksFromRulesParams,
    parseOrgGroupsFromTeamRulesParams,
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

describe('parseRegionsFromRulesParams', () => {
    it('should parse complete regions', () => {
        const params = new Map<string, number | string>([
            ['region:north:name', 'North Basin'],
            ['region:north:x', 1000],
            ['region:north:z', 2000],
            ['region:south:name', 'South District'],
            ['region:south:x', 3000],
            ['region:south:z', 4000],
        ]);

        const regions = parseRegionsFromRulesParams(params);
        expect(regions).toHaveLength(2);
        expect(regions[0].name).toBe('North Basin');
        expect(regions[0].x).toBe(1000);
        expect(regions[1].name).toBe('South District');
    });

    it('should ignore incomplete regions', () => {
        const params = new Map<string, number | string>([
            ['region:incomplete:name', 'Incomplete'],
            // Missing x and z
            ['region:complete:name', 'Complete'],
            ['region:complete:x', 100],
            ['region:complete:z', 200],
        ]);

        const regions = parseRegionsFromRulesParams(params);
        expect(regions).toHaveLength(1);
        expect(regions[0].name).toBe('Complete');
    });
});

describe('parseObjectivesFromRulesParams', () => {
    it('should parse active objectives', () => {
        const params = new Map<string, number | string>([
            ['objective:1:name', 'Capture City'],
            ['objective:1:x', 1000],
            ['objective:1:z', 2000],
            ['objective:1:active', 1],
            ['objective:2:name', 'Inactive Objective'],
            ['objective:2:x', 3000],
            ['objective:2:z', 4000],
            ['objective:2:active', 0], // Inactive - should be filtered
        ]);

        const objectives = parseObjectivesFromRulesParams(params);
        expect(objectives).toHaveLength(1);
        expect(objectives[0].name).toBe('Capture City');
        expect(objectives[0].metadata?.active).toBe(true);
    });

    it('should ignore objectives without active flag', () => {
        const params = new Map<string, number | string>([
            ['objective:1:name', 'No Active Flag'],
            ['objective:1:x', 1000],
            ['objective:1:z', 2000],
        ]);

        const objectives = parseObjectivesFromRulesParams(params);
        expect(objectives).toHaveLength(0);
    });
});

describe('parseLandmarksFromRulesParams', () => {
    it('should parse landmarks', () => {
        const params = new Map<string, number | string>([
            ['landmark:Central Tower:x', 1000],
            ['landmark:Central Tower:z', 2000],
            ['landmark:Eastern Bridge:x', 3000],
            ['landmark:Eastern Bridge:z', 4000],
        ]);

        const landmarks = parseLandmarksFromRulesParams(params);
        expect(landmarks).toHaveLength(2);
        expect(landmarks[0].name).toBe('Central Tower');
        expect(landmarks[0].id).toBe('Central Tower');
        expect(landmarks[1].name).toBe('Eastern Bridge');
    });
});

describe('parseOrgGroupsFromTeamRulesParams', () => {
    it('should parse org groups', () => {
        const params = new Map<string, number | string>([
            ['org:group:1:name', '3rd Armoured'],
            ['org:group:1:x', 1500],
            ['org:group:1:z', 1600],
            ['org:platoon:2:name', 'Alpha Platoon'],
            ['org:platoon:2:x', 2500],
            ['org:platoon:2:z', 2600],
        ]);

        const groups = parseOrgGroupsFromTeamRulesParams(params);
        expect(groups).toHaveLength(2);
        expect(groups[0].name).toBe('3rd Armoured');
        expect(groups[1].name).toBe('Alpha Platoon');
    });

    it('should use specified default type', () => {
        const params = new Map<string, number | string>([
            ['org:group:1:name', 'Test Army'],
            ['org:group:1:x', 100],
            ['org:group:1:z', 200],
        ]);

        const armies = parseOrgGroupsFromTeamRulesParams(params, 'army');
        expect(armies).toHaveLength(1);
        expect(armies[0].type).toBe('army');
    });
});
