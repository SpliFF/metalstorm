/**
 * compile-table.test.ts — Tests for command composer compile table
 */

import { describe, it, expect } from 'vitest';
import {
    compileIntent,
    validateIntent,
    getPriorityBand,
    targetMenuOptions,
    PRIORITY_BANDS,
    DirectiveType,
    StandingOrderType,
    OrderShape,
    type CommandVerb,
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
        // Names the requirement, not the type system (D51) — the old wording
        // was "Invalid combination: escort cannot target area", which tells a
        // player nothing about what escort actually wants.
        expect(error).toBe('escort cannot take a painted area — it needs a named place');
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

/**
 * D56 — the Subject slot used to be discarded at compile time. Every
 * non-group subject produced `groupId = 0` and no conditions at all, so the
 * server matched any idle unit on the team; on a scenario-staged army (every
 * combat unit carries an opening order from frame 0) that is only the units
 * the scenario deliberately left unordered — engineers and a radar.
 */
describe('class subject reaches the wire (D56)', () => {
    const classIntent = (filterClass: string): CommandIntent => ({
        verb: 'attack',
        subject: { type: 'idle-filter', filterClass },
        target: { shape: 'point', point: { x: 4480, z: 4480 } },
        priority: 50,
    });

    it('carries the class and clears idleOnly for an ungrouped directive', () => {
        const result = compileIntent(classIntent('armour'));
        expect(result?.type).toBe('GroupDirective');
        if (result?.type !== 'GroupDirective') return;
        expect(result.payload.groupId).toBe(0);
        expect(result.payload.conditions).toEqual({ idleOnly: false, unitClass: 'armour' });
    });

    it('no longer compiles two different classes to the same message', () => {
        const armour = compileIntent(classIntent('armour'));
        const artillery = compileIntent(classIntent('artillery'));
        expect(armour).not.toEqual(artillery);
        if (armour?.type !== 'GroupDirective' || artillery?.type !== 'GroupDirective') return;
        expect(armour.payload.conditions?.unitClass).toBe('armour');
        expect(artillery.payload.conditions?.unitClass).toBe('artillery');
    });

    it('sends no conditions for a group-scoped directive', () => {
        // The group IS the roster and the server derives conditions.org_group
        // from group_id; its members keep suspend/auto-rejoin (Q-D-d §3).
        const result = compileIntent({
            verb: 'attack',
            subject: { type: 'group', groupId: 4 },
            target: { shape: 'point', point: { x: 4480, z: 4480 } },
            priority: 50,
        });
        expect(result?.type).toBe('GroupDirective');
        if (result?.type !== 'GroupDirective') return;
        expect(result.payload.conditions).toBeUndefined();
    });

    it('sends no conditions when the subject names no class', () => {
        const result = compileIntent({
            verb: 'attack',
            subject: { type: 'idle-filter' },
            target: { shape: 'point', point: { x: 4480, z: 4480 } },
            priority: 50,
        });
        expect(result?.type).toBe('GroupDirective');
        if (result?.type !== 'GroupDirective') return;
        expect(result.payload.conditions).toBeUndefined();
    });
});

/**
 * PLAN-endtoend.md D51 — the target slot offered a target the verb refused.
 *
 * Walked live: `patrol / Idle armour / Grey Flat` filled all three chips, the
 * echo line rendered, and Commit stayed disabled. The cause was not the verb —
 * it was that the target menu listed "🔍 Search by name…" for **every** verb
 * while the compile table accepts a named place for only six of the eleven.
 * Two halves, both here: the menu's offer is now derived from the same table
 * (`targetMenuOptions`), and the three verbs that *can* honestly take a named
 * place — scout / withdraw / build, all of which encode an entity as its
 * centre point, exactly what they already accept as a point — now do.
 */
describe('target offer matches the compile table (D51)', () => {
    const region: NamedEntity = {
        id: 'grey_flat',
        type: 'region',
        name: 'Grey Flat',
        x: 3200,
        z: 4100,
    };

    it('does not offer the name search for a verb that cannot take a place', () => {
        for (const verb of ['patrol', 'screen'] as CommandVerb[]) {
            const options = targetMenuOptions(verb);
            const search = options.find((o) => o.kind === 'search');
            expect(search).toBeDefined();
            expect(search?.enabled).toBe(false);
            // Shown-and-disabled, carrying the reason: a silently absent
            // option is the same dead surface one layer quieter.
            expect(search?.reason).toBe(
                `${verb} cannot take a named place — it needs a route drawn on the map`);
        }
    });

    it('offers exactly the map shapes the verb compiles, and never entity-as-gesture', () => {
        expect(targetMenuOptions('attack')).toEqual([
            { kind: 'map', shape: 'area', enabled: true },
            { kind: 'map', shape: 'point', enabled: true },
            { kind: 'search', enabled: true },
        ]);
        // escort takes a named place and nothing else — no map arm at all.
        expect(targetMenuOptions('escort')).toEqual([{ kind: 'search', enabled: true }]);
        expect(targetMenuOptions('patrol').filter((o) => o.kind === 'map'))
            .toEqual([{ kind: 'map', shape: 'route', enabled: true }]);
    });

    it('every enabled option corresponds to a shape validateIntent accepts', () => {
        const verbs: CommandVerb[] = [
            'attack', 'secure', 'defend', 'hold', 'patrol',
            'screen', 'scout', 'escort', 'withdraw', 'reinforce', 'build',
        ];
        for (const verb of verbs) {
            for (const option of targetMenuOptions(verb)) {
                if (!option.enabled) continue;
                const shape = option.kind === 'search' ? 'entity' : option.shape!;
                const target: CommandTarget =
                    shape === 'entity' ? { shape, entity: region }
                    : shape === 'point' ? { shape, point: { x: 1, z: 2 } }
                    : shape === 'area' ? { shape, area: { x: 1, z: 2, radius: 3 } }
                    : { shape, route: [{ x: 1, z: 2 }, { x: 3, z: 4 }] };

                expect(validateIntent({
                    verb, subject: { type: 'group', groupId: 1 }, target, priority: 50,
                }), `${verb}:${shape}`).toBeNull();
                expect(compileIntent({
                    verb, subject: { type: 'group', groupId: 1 }, target, priority: 50,
                }), `${verb}:${shape}`).not.toBeNull();
            }
        }
    });

    it('compiles scout / withdraw / build against a named place, as its centre point', () => {
        const expected: Array<[CommandVerb, DirectiveType]> = [
            ['scout', DirectiveType.Screen],
            ['withdraw', DirectiveType.Withdraw],
            ['build', DirectiveType.BuildBase],
        ];
        for (const [verb, directiveType] of expected) {
            const result = compileIntent({
                verb,
                subject: { type: 'group', groupId: 7 },
                target: { shape: 'entity', entity: region },
                priority: 50,
            });
            expect(result?.type, verb).toBe('GroupDirective');
            if (result?.type !== 'GroupDirective') continue;
            expect(result.payload.directiveType, verb).toBe(directiveType);
            expect(result.payload.shape, verb).toBe(OrderShape.Point);
            expect(result.payload.params, verb).toEqual([3200, 0, 4100]);
        }
    });

    it('still refuses a named place for patrol, and says what patrol needs', () => {
        expect(validateIntent({
            verb: 'patrol',
            subject: { type: 'idle-filter', filterClass: 'armour' },
            target: { shape: 'entity', entity: region },
            priority: 50,
        })).toBe('patrol cannot take a named place — it needs a route drawn on the map');
    });
});
