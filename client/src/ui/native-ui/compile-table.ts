/**
 * compile-table.ts — Command composer compile table
 * (PLAN-metalstorm-scripting.md §5)
 *
 * The thin layer that converts composed intents into FlatBuffers messages.
 * One entry per (verb, target shape) mapping to a specific message type.
 *
 * Closed vocabularies only:
 *   - No variables, loops, boolean algebra
 *   - Every composable command maps to a directive the sim already executes
 *   - If a slot can't express it, it isn't offered
 */

import type { NamedEntity } from './named-entity-index.js';

/**
 * Command verbs - closed vocabulary
 */
export type CommandVerb =
    | 'attack'
    | 'secure'
    | 'defend'
    | 'hold'
    | 'patrol'
    | 'screen'
    | 'scout'
    | 'escort'
    | 'withdraw'
    | 'reinforce'
    | 'build';

/**
 * Target shapes for commands
 */
export type TargetShape = 'point' | 'area' | 'route' | 'entity';

/**
 * Command subject - who executes
 */
export interface CommandSubject {
    type: 'group' | 'idle-filter' | 'ai';
    groupId?: number;           // For type='group'
    filterClass?: string;       // For type='idle-filter' (e.g., "armour", "infantry")
}

/**
 * Command target
 */
export interface CommandTarget {
    shape: TargetShape;
    entity?: NamedEntity;       // For named entities
    point?: { x: number; z: number };
    area?: { x: number; z: number; radius: number };
    polygon?: Array<{ x: number; z: number }>;
    route?: Array<{ x: number; z: number }>;
}

/**
 * When-condition for commands (closed menu)
 */
export type WhenCondition =
    | { type: 'now' }
    | { type: 'region-contested'; regionId: string }
    | { type: 'under-attack' }
    | { type: 'objective-complete'; objectiveId: number }
    | { type: 'strength-below'; percent: number };

/**
 * Composed command intent (before compilation)
 */
export interface CommandIntent {
    verb: CommandVerb;
    subject: CommandSubject;
    target: CommandTarget;
    priority: number;           // 0-100 slider
    when?: WhenCondition;       // Optional condition
}

/**
 * Priority bands (for slider snapping)
 */
export const PRIORITY_BANDS = {
    low: 25,
    normal: 50,
    high: 75,
    urgent: 100,
} as const;

/**
 * Map priority slider value to labeled band
 */
export function getPriorityBand(value: number): keyof typeof PRIORITY_BANDS {
    if (value <= 30) return 'low';
    if (value <= 60) return 'normal';
    if (value <= 85) return 'high';
    return 'urgent';
}

/**
 * Directive type enum (mirrors protocol.fbs DirectiveType)
 */
export enum DirectiveType {
    DefendArea = 0,
    PatrolRoute = 1,
    RallyPoint = 2,
    Fallback = 3,
    Reinforce = 4,
    Screen = 5,
    SupplyRoute = 6,
    BuildBase = 7,
    MoveFormation = 8,
    Assault = 9,
    Defend = 10,
    Overwatch = 11,
    Withdraw = 12,
    Escort = 13,
    DefendFront = 14,
}

/**
 * Order shape enum (mirrors protocol.fbs OrderShape)
 */
export enum OrderShape {
    Point = 0,
    Circle = 1,
    Polygon = 2,
    Polyline = 3,
}

/**
 * Standing order type enum (mirrors protocol.fbs StandingOrderType)
 */
export enum StandingOrderType {
    DefendArea = 0,
    PatrolRoute = 1,
    RallyPoint = 2,
    Fallback = 3,
    Reinforce = 4,
    Screen = 5,
    SupplyRoute = 6,
    BuildBase = 7,
}

/**
 * Compiled message (output of compilation)
 */
export type CompiledMessage =
    | { type: 'GroupDirective'; payload: GroupDirectivePayload }
    | { type: 'StandingOrder'; payload: StandingOrderPayload }
    | { type: 'AIGuidance'; payload: AIGuidancePayload };

/**
 * GroupDirective message payload
 */
export interface GroupDirectivePayload {
    directiveId: number;        // 0 = create new
    groupId: number;            // 0 = condition-scoped
    directiveType: DirectiveType;
    priority: number;           // 0-100 mapped from slider
    shape: OrderShape;
    params: number[];           // Interpreted per shape
    requestedStrength: number;  // 0 = take what idles
    phasesJson?: string;        // Optional phase gate from when-condition
}

/**
 * StandingOrder message payload
 */
export interface StandingOrderPayload {
    orderType: StandingOrderType;
    priority: number;
    params: number[];
    expiresInFrames: number;    // 0 = no expiry
    conditionJson?: string;     // Encoded when-condition
}

/**
 * AI Guidance message payload (interaction §6)
 * Subject='the AI' writes guidance instead of a direct directive
 */
export interface AIGuidancePayload {
    intent: string;             // Human-readable intent
    verb: CommandVerb;
    targetEntity?: { id: number | string; type: string };
    targetPoint?: { x: number; z: number };
    priority: number;
}

/**
 * Compile a command intent into a message.
 * This is the core translation table (§5).
 *
 * Returns null if the intent cannot be compiled (invalid combination).
 */
export function compileIntent(intent: CommandIntent): CompiledMessage | null {
    // Subject='ai' → AI guidance (interaction §6)
    if (intent.subject.type === 'ai') {
        return compileToAIGuidance(intent);
    }

    // Map verb + target shape to directive/standing order
    const key = `${intent.verb}:${intent.target.shape}` as const;

    // Compile table (§5)
    switch (key) {
        // Attack / secure → Assault or TakeAndHold directive
        case 'attack:entity':
        case 'attack:area':
        case 'attack:point':
        case 'secure:entity':
        case 'secure:area':
        case 'secure:point': {
            const directiveType = intent.verb === 'attack'
                ? DirectiveType.Assault
                : DirectiveType.Defend; // "secure" = take and hold

            return compileToGroupDirective(intent, directiveType);
        }

        // Defend / hold → Defend directive or area standing order
        case 'defend:area':
        case 'defend:entity':
        case 'hold:area':
        case 'hold:entity': {
            // Use GroupDirective if we have a specific group, otherwise standing order
            if (intent.subject.type === 'group' && intent.subject.groupId) {
                return compileToGroupDirective(intent, DirectiveType.Defend);
            } else {
                return compileToStandingOrder(intent, StandingOrderType.DefendArea);
            }
        }

        // Patrol / screen
        case 'patrol:route':
        case 'screen:route': {
            const type = intent.verb === 'patrol'
                ? DirectiveType.PatrolRoute
                : DirectiveType.Screen;

            if (intent.subject.type === 'group' && intent.subject.groupId) {
                return compileToGroupDirective(intent, type);
            } else {
                const orderType = intent.verb === 'patrol'
                    ? StandingOrderType.PatrolRoute
                    : StandingOrderType.Screen;
                return compileToStandingOrder(intent, orderType);
            }
        }

        // Scout → screen/patrol depending on target
        case 'scout:area':
        case 'scout:point': {
            return compileToGroupDirective(intent, DirectiveType.Screen);
        }

        // Escort
        case 'escort:entity': {
            return compileToGroupDirective(intent, DirectiveType.Escort);
        }

        // Withdraw
        case 'withdraw:point': {
            return compileToGroupDirective(intent, DirectiveType.Withdraw);
        }

        // Reinforce
        case 'reinforce:area':
        case 'reinforce:entity': {
            if (intent.subject.type === 'group' && intent.subject.groupId) {
                return compileToGroupDirective(intent, DirectiveType.Reinforce);
            } else {
                return compileToStandingOrder(intent, StandingOrderType.Reinforce);
            }
        }

        // Build
        case 'build:point': {
            return compileToGroupDirective(intent, DirectiveType.BuildBase);
        }

        default:
            console.warn('[compile-table] Unhandled verb:shape combination:', key);
            return null;
    }
}

/**
 * Compile to GroupDirective
 */
function compileToGroupDirective(
    intent: CommandIntent,
    directiveType: DirectiveType
): CompiledMessage {
    const { target, subject, priority, when } = intent;

    // Determine order shape and params from target
    const { shape, params } = encodeTargetParams(target);

    // Group ID (0 = condition-scoped)
    const groupId = subject.type === 'group' && subject.groupId ? subject.groupId : 0;

    // Phase gate from when-condition
    const phasesJson = when ? encodeWhenConditionAsPhase(when) : undefined;

    const payload: GroupDirectivePayload = {
        directiveId: 0,         // 0 = create new
        groupId,
        directiveType,
        priority: Math.round(priority),
        shape,
        params,
        requestedStrength: 0,   // 0 = take what idles
        phasesJson,
    };

    return { type: 'GroupDirective', payload };
}

/**
 * Compile to StandingOrder
 */
function compileToStandingOrder(
    intent: CommandIntent,
    orderType: StandingOrderType
): CompiledMessage {
    const { target, priority, when } = intent;

    // Encode params from target
    const { params } = encodeTargetParams(target);

    // Encode when-condition
    const conditionJson = when ? encodeWhenConditionAsJson(when) : undefined;

    const payload: StandingOrderPayload = {
        orderType,
        priority: Math.round(priority),
        params,
        expiresInFrames: 0,     // 0 = no expiry
        conditionJson,
    };

    return { type: 'StandingOrder', payload };
}

/**
 * Compile to AI Guidance (subject='the AI')
 */
function compileToAIGuidance(intent: CommandIntent): CompiledMessage {
    const { verb, target, priority } = intent;

    // Extract target entity or point
    let targetEntity: AIGuidancePayload['targetEntity'];
    let targetPoint: AIGuidancePayload['targetPoint'];

    if (target.entity) {
        targetEntity = {
            id: target.entity.id,
            type: target.entity.type,
        };
    } else if (target.point) {
        targetPoint = target.point;
    } else if (target.area) {
        targetPoint = { x: target.area.x, z: target.area.z };
    }

    // Generate human-readable intent
    const intentText = generateIntentText(intent);

    const payload: AIGuidancePayload = {
        intent: intentText,
        verb,
        targetEntity,
        targetPoint,
        priority: Math.round(priority),
    };

    return { type: 'AIGuidance', payload };
}

/**
 * Encode target as OrderShape and params array
 */
function encodeTargetParams(target: CommandTarget): { shape: OrderShape; params: number[] } {
    if (target.point) {
        return {
            shape: OrderShape.Point,
            params: [target.point.x, 0, target.point.z],
        };
    }

    if (target.area) {
        return {
            shape: OrderShape.Circle,
            params: [target.area.x, 0, target.area.z, target.area.radius],
        };
    }

    if (target.polygon) {
        const params: number[] = [];
        for (const p of target.polygon) {
            params.push(p.x, 0, p.z);
        }
        return { shape: OrderShape.Polygon, params };
    }

    if (target.route) {
        const params: number[] = [];
        for (const p of target.route) {
            params.push(p.x, 0, p.z);
        }
        return { shape: OrderShape.Polyline, params };
    }

    // Fallback: entity position as point
    if (target.entity) {
        return {
            shape: OrderShape.Point,
            params: [target.entity.x, 0, target.entity.z],
        };
    }

    // Default fallback
    return { shape: OrderShape.Point, params: [0, 0, 0] };
}

/**
 * Encode when-condition as phase gate JSON (for GroupDirective)
 */
function encodeWhenConditionAsPhase(condition: WhenCondition): string {
    switch (condition.type) {
        case 'now':
            return ''; // No phase gate

        case 'region-contested':
            return JSON.stringify({
                type: 'region-state',
                regionId: condition.regionId,
                state: 'contested',
            });

        case 'under-attack':
            return JSON.stringify({
                type: 'group-under-attack',
            });

        case 'objective-complete':
            return JSON.stringify({
                type: 'objective-state',
                objectiveId: condition.objectiveId,
                state: 'complete',
            });

        case 'strength-below':
            return JSON.stringify({
                type: 'group-strength',
                threshold: condition.percent,
            });

        default:
            return '';
    }
}

/**
 * Encode when-condition as JSON (for StandingOrder)
 */
function encodeWhenConditionAsJson(condition: WhenCondition): string {
    // Same as phase encoding for now
    return encodeWhenConditionAsPhase(condition);
}

/**
 * Generate plain-language intent text for AI guidance
 */
function generateIntentText(intent: CommandIntent): string {
    const { verb, target, priority } = intent;
    const priorityLabel = getPriorityBand(priority);

    let targetName = '';
    if (target.entity) {
        targetName = target.entity.name;
    } else if (target.point) {
        targetName = `coordinates (${Math.round(target.point.x)}, ${Math.round(target.point.z)})`;
    } else if (target.area) {
        targetName = `area at (${Math.round(target.area.x)}, ${Math.round(target.area.z)})`;
    }

    let whenText = '';
    if (intent.when) {
        whenText = ` when ${formatWhenCondition(intent.when)}`;
    }

    return `${verb} ${targetName} — ${priorityLabel} priority${whenText}`;
}

/**
 * Format when-condition as human-readable text
 */
function formatWhenCondition(condition: WhenCondition): string {
    switch (condition.type) {
        case 'now':
            return 'now';
        case 'region-contested':
            return `region ${condition.regionId} is contested`;
        case 'under-attack':
            return 'under attack';
        case 'objective-complete':
            return `objective ${condition.objectiveId} is complete`;
        case 'strength-below':
            return `strength below ${condition.percent}%`;
        default:
            return '';
    }
}

/**
 * Validate that a command intent can be compiled.
 * Returns an error message if invalid, null if valid.
 */
export function validateIntent(intent: CommandIntent): string | null {
    // Check verb:shape compatibility
    const key = `${intent.verb}:${intent.target.shape}`;

    const validCombinations = new Set([
        'attack:entity', 'attack:area', 'attack:point',
        'secure:entity', 'secure:area', 'secure:point',
        'defend:area', 'defend:entity',
        'hold:area', 'hold:entity',
        'patrol:route',
        'screen:route',
        'scout:area', 'scout:point',
        'escort:entity',
        'withdraw:point',
        'reinforce:area', 'reinforce:entity',
        'build:point',
    ]);

    if (!validCombinations.has(key)) {
        return `Invalid combination: ${intent.verb} cannot target ${intent.target.shape}`;
    }

    // Check that target has required data
    if (!hasTargetData(intent.target)) {
        return 'Target is incomplete (missing coordinates or entity)';
    }

    // Check priority range
    if (intent.priority < 0 || intent.priority > 100) {
        return 'Priority must be between 0 and 100';
    }

    return null;
}

/**
 * Check if target has required data
 */
function hasTargetData(target: CommandTarget): boolean {
    switch (target.shape) {
        case 'point':
            return !!(target.point || target.entity);
        case 'area':
            return !!(target.area || target.entity);
        case 'route':
            return !!(target.route && target.route.length >= 2);
        case 'entity':
            return !!target.entity;
        default:
            return false;
    }
}
