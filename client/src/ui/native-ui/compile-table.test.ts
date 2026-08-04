/**
 * compile-table.test.ts — Tests for command composer compile table
 */

import { describe, it, expect } from 'vitest';
import {
    compileIntent,
    validateIntent,
    getPriorityBand,
    PRIORITY_BANDS,
    DirectiveType,
    StandingOrderType,
    OrderShape,
    type CommandIntent,
    type CommandSubject,
    type CommandTarget,
} from './compile-table.js';
import type { NamedEntity } from './named-entity-index.js';

describe('compileIntent', () => {
    describe('attack / secure → GroupDirective (Assault/Defend)', () => {
        it('should compile attack to Assault directive', () => {
            const intent: CommandIntent = {
                verb: 'attack',
                subject: { type: 'group', groupId: 1 },
                target: {
                    shape: 'point',
                    point: { x: 1000, z: 2000 },
                },
                priority: 75,
            };

            const result = compileIntent(intent);
            expect(result).toBeDefined();
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.Assault);
                expect(result.payload.groupId).toBe(1);
                expect(result.payload.priority).toBe(75);
                expect(result.payload.shape).toBe(OrderShape.Point);
                expect(result.payload.params).toEqual([1000, 0, 2000]);
            }
        });

        it('should compile secure to Defend (take and hold) directive', () => {
            const intent: CommandIntent = {
                verb: 'secure',
                subject: { type: 'group', groupId: 2 },
                target: {
                    shape: 'area',
                    area: { x: 1500, z: 1600, radius: 500 },
                },
                priority: 50,
            };

            const result = compileIntent(intent);
            expect(result).toBeDefined();
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.Defend);
                expect(result.payload.shape).toBe(OrderShape.Circle);
                expect(result.payload.params).toEqual([1500, 0, 1600, 500]);
            }
        });

        it('should compile attack on named entity', () => {
            const entity: NamedEntity = {
                id: 'city1',
                type: 'city',
                name: 'Meridian City',
                x: 1000,
                z: 2000,
            };

            const intent: CommandIntent = {
                verb: 'attack',
                subject: { type: 'group', groupId: 1 },
                target: {
                    shape: 'entity',
                    entity,
                },
                priority: 80,
            };

            const result = compileIntent(intent);
            expect(result).toBeDefined();

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.Assault);
                // Entity position should be encoded as point
                expect(result.payload.params).toEqual([1000, 0, 2000]);
            }
        });
    });

    describe('defend / hold → GroupDirective or StandingOrder', () => {
        it('should compile defend with group to GroupDirective', () => {
            const intent: CommandIntent = {
                verb: 'defend',
                subject: { type: 'group', groupId: 3 },
                target: {
                    shape: 'area',
                    area: { x: 2000, z: 3000, radius: 400 },
                },
                priority: 60,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.Defend);
                expect(result.payload.groupId).toBe(3);
            }
        });

        it('should compile defend without group to StandingOrder', () => {
            const intent: CommandIntent = {
                verb: 'defend',
                subject: { type: 'idle-filter', filterClass: 'armour' },
                target: {
                    shape: 'area',
                    area: { x: 2000, z: 3000, radius: 400 },
                },
                priority: 60,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('StandingOrder');

            if (result?.type === 'StandingOrder') {
                expect(result.payload.orderType).toBe(StandingOrderType.DefendArea);
                expect(result.payload.priority).toBe(60);
            }
        });
    });

    describe('patrol / screen → Directive or StandingOrder', () => {
        it('should compile patrol route', () => {
            const intent: CommandIntent = {
                verb: 'patrol',
                subject: { type: 'group', groupId: 4 },
                target: {
                    shape: 'route',
                    route: [
                        { x: 1000, z: 1000 },
                        { x: 2000, z: 2000 },
                        { x: 3000, z: 1500 },
                    ],
                },
                priority: 40,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.PatrolRoute);
                expect(result.payload.shape).toBe(OrderShape.Polyline);
                expect(result.payload.params).toEqual([
                    1000, 0, 1000,
                    2000, 0, 2000,
                    3000, 0, 1500,
                ]);
            }
        });

        it('should compile screen route', () => {
            const intent: CommandIntent = {
                verb: 'screen',
                subject: { type: 'group', groupId: 5 },
                target: {
                    shape: 'route',
                    route: [
                        { x: 1000, z: 1000 },
                        { x: 2000, z: 1000 },
                    ],
                },
                priority: 50,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.Screen);
            }
        });
    });

    describe('when-conditions → phase gates', () => {
        it('should encode "when contested" phase gate', () => {
            const intent: CommandIntent = {
                verb: 'attack',
                subject: { type: 'group', groupId: 1 },
                target: { shape: 'point', point: { x: 1000, z: 2000 } },
                priority: 75,
                when: { type: 'region-contested', regionId: 'north' },
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.phasesJson).toBeDefined();
                const phase = JSON.parse(result.payload.phasesJson!);
                expect(phase.type).toBe('region-state');
                expect(phase.regionId).toBe('north');
                expect(phase.state).toBe('contested');
            }
        });

        it('should encode "under attack" phase gate', () => {
            const intent: CommandIntent = {
                verb: 'withdraw',
                subject: { type: 'group', groupId: 2 },
                target: { shape: 'point', point: { x: 500, z: 600 } },
                priority: 100,
                when: { type: 'under-attack' },
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                const phase = JSON.parse(result.payload.phasesJson!);
                expect(phase.type).toBe('group-under-attack');
            }
        });

        it('should encode "objective complete" phase gate', () => {
            const intent: CommandIntent = {
                verb: 'attack',
                subject: { type: 'group', groupId: 1 },
                target: { shape: 'point', point: { x: 1000, z: 2000 } },
                priority: 70,
                when: { type: 'objective-complete', objectiveId: 123 },
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                const phase = JSON.parse(result.payload.phasesJson!);
                expect(phase.type).toBe('objective-state');
                expect(phase.objectiveId).toBe(123);
                expect(phase.state).toBe('complete');
            }
        });

        it('should encode "strength below" phase gate', () => {
            const intent: CommandIntent = {
                verb: 'reinforce',
                subject: { type: 'group', groupId: 3 },
                target: { shape: 'area', area: { x: 1000, z: 2000, radius: 300 } },
                priority: 80,
                when: { type: 'strength-below', percent: 50 },
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                const phase = JSON.parse(result.payload.phasesJson!);
                expect(phase.type).toBe('group-strength');
                expect(phase.threshold).toBe(50);
            }
        });
    });

    describe('subject="the AI" → AI Guidance', () => {
        it('should compile to AI guidance when subject is AI', () => {
            const intent: CommandIntent = {
                verb: 'attack',
                subject: { type: 'ai' },
                target: {
                    shape: 'entity',
                    entity: {
                        id: 'city1',
                        type: 'city',
                        name: 'Meridian City',
                        x: 1000,
                        z: 2000,
                    },
                },
                priority: 75,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('AIGuidance');

            if (result?.type === 'AIGuidance') {
                expect(result.payload.verb).toBe('attack');
                expect(result.payload.priority).toBe(75);
                expect(result.payload.targetEntity).toEqual({
                    id: 'city1',
                    type: 'city',
                });
                expect(result.payload.intent).toContain('attack');
                expect(result.payload.intent).toContain('Meridian City');
                expect(result.payload.intent).toContain('high priority');
            }
        });

        it('should include point target in AI guidance', () => {
            const intent: CommandIntent = {
                verb: 'defend',
                subject: { type: 'ai' },
                target: {
                    shape: 'point',
                    point: { x: 1500, z: 1600 },
                },
                priority: 50,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('AIGuidance');

            if (result?.type === 'AIGuidance') {
                expect(result.payload.targetPoint).toEqual({ x: 1500, z: 1600 });
            }
        });
    });

    describe('other verbs', () => {
        it('should compile escort', () => {
            const intent: CommandIntent = {
                verb: 'escort',
                subject: { type: 'group', groupId: 1 },
                target: {
                    shape: 'entity',
                    entity: {
                        id: 2,
                        type: 'group',
                        name: 'Supply Convoy',
                        x: 1000,
                        z: 2000,
                    },
                },
                priority: 60,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.Escort);
            }
        });

        it('should compile withdraw', () => {
            const intent: CommandIntent = {
                verb: 'withdraw',
                subject: { type: 'group', groupId: 1 },
                target: {
                    shape: 'point',
                    point: { x: 500, z: 600 },
                },
                priority: 100,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.Withdraw);
            }
        });

        it('should compile build', () => {
            const intent: CommandIntent = {
                verb: 'build',
                subject: { type: 'group', groupId: 1 },
                target: {
                    shape: 'point',
                    point: { x: 1000, z: 2000 },
                },
                priority: 30,
            };

            const result = compileIntent(intent);
            expect(result?.type).toBe('GroupDirective');

            if (result?.type === 'GroupDirective') {
                expect(result.payload.directiveType).toBe(DirectiveType.BuildBase);
            }
        });
    });
});

describe('validateIntent', () => {
    it('should accept valid attack:point', () => {
        const intent: CommandIntent = {
            verb: 'attack',
            subject: { type: 'group', groupId: 1 },
            target: { shape: 'point', point: { x: 100, z: 200 } },
            priority: 50,
        };

        expect(validateIntent(intent)).toBeNull();
    });

    it('should reject invalid verb:shape combinations', () => {
        const intent: CommandIntent = {
            verb: 'escort',
            subject: { type: 'group', groupId: 1 },
            target: { shape: 'area', area: { x: 100, z: 200, radius: 50 } },
            priority: 50,
        };

        const error = validateIntent(intent);
        expect(error).toBeDefined();
        expect(error).toContain('Invalid combination');
    });

    it('should reject incomplete targets', () => {
        const intent: CommandIntent = {
            verb: 'attack',
            subject: { type: 'group', groupId: 1 },
            target: { shape: 'point' }, // Missing point data
            priority: 50,
        };

        const error = validateIntent(intent);
        expect(error).toBeDefined();
        expect(error).toContain('incomplete');
    });

    it('should reject out-of-range priority', () => {
        const intent: CommandIntent = {
            verb: 'attack',
            subject: { type: 'group', groupId: 1 },
            target: { shape: 'point', point: { x: 100, z: 200 } },
            priority: 150, // Out of range
        };

        const error = validateIntent(intent);
        expect(error).toBeDefined();
        expect(error).toContain('Priority must be between 0 and 100');
    });

    it('should accept routes with at least 2 points', () => {
        const intent: CommandIntent = {
            verb: 'patrol',
            subject: { type: 'group', groupId: 1 },
            target: {
                shape: 'route',
                route: [
                    { x: 100, z: 200 },
                    { x: 300, z: 400 },
                ],
            },
            priority: 50,
        };

        expect(validateIntent(intent)).toBeNull();
    });

    it('should reject routes with < 2 points', () => {
        const intent: CommandIntent = {
            verb: 'patrol',
            subject: { type: 'group', groupId: 1 },
            target: {
                shape: 'route',
                route: [{ x: 100, z: 200 }],
            },
            priority: 50,
        };

        const error = validateIntent(intent);
        expect(error).toBeDefined();
    });
});

describe('getPriorityBand', () => {
    it('should map values to bands', () => {
        expect(getPriorityBand(0)).toBe('low');
        expect(getPriorityBand(25)).toBe('low');
        expect(getPriorityBand(30)).toBe('low');

        expect(getPriorityBand(35)).toBe('normal');
        expect(getPriorityBand(50)).toBe('normal');
        expect(getPriorityBand(60)).toBe('normal');

        expect(getPriorityBand(65)).toBe('high');
        expect(getPriorityBand(75)).toBe('high');
        expect(getPriorityBand(85)).toBe('high');

        expect(getPriorityBand(90)).toBe('urgent');
        expect(getPriorityBand(100)).toBe('urgent');
    });

    it('should have correct band values', () => {
        expect(PRIORITY_BANDS.low).toBe(25);
        expect(PRIORITY_BANDS.normal).toBe(50);
        expect(PRIORITY_BANDS.high).toBe(75);
        expect(PRIORITY_BANDS.urgent).toBe(100);
    });
});
