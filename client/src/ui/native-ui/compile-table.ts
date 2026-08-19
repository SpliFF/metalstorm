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
 * Target shapes each verb accepts (the closed verb:shape vocabulary — §1).
 * Single source of truth for both `validateIntent` and the map-arm target
 * picker (metalstorm-scripting task 4: only offer "paint on map" options
 * for shapes the current verb actually compiles).
 */
export const TARGET_SHAPES_BY_VERB: Record<CommandVerb, TargetShape[]> = {
    attack: ['entity', 'area', 'point'],
    secure: ['entity', 'area', 'point'],
    defend: ['area', 'entity'],
    hold: ['area', 'entity'],
    patrol: ['route'],
    screen: ['route'],
    scout: ['area', 'point', 'entity'],
    escort: ['entity'],
    withdraw: ['point', 'entity'],
    reinforce: ['area', 'entity'],
    build: ['point', 'entity'],
};

/**
 * Target shapes the AI-guidance path can carry (PLAN-endtoend D60).
 *
 * `compileIntent` routes `subject.type === 'ai'` to `compileToAIGuidance`
 * **before** the verb:shape switch, and that payload carries the target as
 * advice — a `targetEntity`, or a `targetPoint` (an area travels as its
 * centre). It has no `OrderShape` and no params, so the verb:shape table
 * describes a wire encoding this path never performs. What it *can* carry is
 * the same for every verb, and a route is the one shape it cannot: it would
 * produce neither field, and `generateIntentText` would name no target at all.
 */
export const AI_GUIDANCE_TARGET_SHAPES: TargetShape[] = ['entity', 'point', 'area'];

/**
 * Target shapes this intent can compile against.
 *
 * Subject-aware because the compile path is (D60): a directive encodes the
 * target as an `OrderShape` and reads §5's table; guidance to the AI encodes
 * it as advice and reads `AI_GUIDANCE_TARGET_SHAPES`. Passing no subject keeps
 * the directive answer, which is what a half-composed sentence should show.
 */
export function getAcceptedTargetShapes(
    verb: CommandVerb,
    subject?: CommandSubject,
): TargetShape[] {
    if (subject?.type === 'ai') return AI_GUIDANCE_TARGET_SHAPES;
    return TARGET_SHAPES_BY_VERB[verb] ?? [];
}

/**
 * A target shape in the player's words (PLAN-endtoend D51).
 *
 * The composer's own vocabulary is `entity` / `area` / `route`; a refusal
 * spelled in those words names the *type system*, not the thing the player
 * did. Every string a player can be shown about a shape comes from here so
 * the menu's offer and the refusal that follows it cannot disagree.
 */
export function describeTargetShape(shape: TargetShape): string {
    switch (shape) {
        case 'entity': return 'a named place';
        case 'point':  return 'a point on the map';
        case 'area':   return 'a painted area';
        case 'route':  return 'a route drawn on the map';
        default:       return String(shape);
    }
}

/** "a" · "a or b" · "a, b or c" — so a three-shape offer does not read as
 *  three `or`s in a row. */
function joinAlternatives(parts: string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/**
 * Why this intent cannot take `shape` — names the requirement, not just the
 * rejection (D51: "the refusal message names a cause that is not the cause").
 * Shared by `validateIntent` and the target menu's disabled offer.
 *
 * The refused *thing* is named too (D60): a directive is refused by the verb,
 * but guidance to the AI is refused by the guidance payload, and blaming the
 * verb there points the player at a rule that does not apply to their sentence.
 */
export function explainShapeMismatch(
    verb: CommandVerb,
    shape: TargetShape,
    subject?: CommandSubject,
): string {
    const accepted = getAcceptedTargetShapes(verb, subject).map(describeTargetShape);
    const needs = accepted.length
        ? joinAlternatives(accepted)
        : 'a target this build cannot compose';
    const refusedBy = subject?.type === 'ai' ? 'guidance to the AI' : verb;
    return `${refusedBy} cannot take ${describeTargetShape(shape)} — it needs ${needs}`;
}

/**
 * One option in the target slot's menu.
 *
 * `kind: 'map'` arms a map gesture for `shape`; `kind: 'search'` opens the
 * named-place search. A disabled option is still *shown*, carrying `reason` —
 * a verb whose target the player cannot supply has to say so, and silently
 * dropping the search offer would leave the same dead surface D41 filed.
 */
export interface TargetMenuOption {
    kind: 'map' | 'search';
    shape?: TargetShape;
    enabled: boolean;
    reason?: string;
}

/**
 * The target slot's offer for `verb` (D51).
 *
 * Derived from the same `TARGET_SHAPES_BY_VERB` the compile table and
 * `validateIntent` read, so the menu can no longer offer a target the
 * Commit button will refuse: before this, the name search was offered for
 * every verb, and `patrol Grey Flat` filled all three chips and then died on
 * a verb:shape rule the menu knew nothing about.
 *
 * Subject-aware for the same reason (D60): with `subject = the AI` the verb's
 * table is not the rule that will be applied, so offering from it refuses
 * `patrol Grey Flat` — which the guidance payload encodes perfectly well — and
 * offers a route it cannot encode at all.
 */
export function targetMenuOptions(
    verb: CommandVerb,
    subject?: CommandSubject,
): TargetMenuOption[] {
    const accepted = getAcceptedTargetShapes(verb, subject);
    const options: TargetMenuOption[] = accepted
        .filter((shape) => shape !== 'entity')
        .map((shape) => ({ kind: 'map' as const, shape, enabled: true }));

    options.push(accepted.includes('entity')
        ? { kind: 'search', enabled: true }
        : { kind: 'search', enabled: false, reason: explainShapeMismatch(verb, 'entity', subject) });

    return options;
}

/**
 * Command subject - who executes
 *
 * `idle-filter` is a historical name: the subject names a *unit class*, and
 * whether the directive may take a unit that is already busy is the separate
 * `idleOnly` decision below. Both now reach the wire; before D56 neither did.
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
/**
 * The subject slot as the wire sees it — `StandingOrderConditions` minus the
 * fields the composer has no vocabulary for.
 *
 * `unitClass` is a command-language class name, NOT a `squad_types` vector:
 * the class → unit-def-id mapping needs the streamed def table, which lives in
 * the game-processor worker, so the worker resolves it on the way out
 * (game-processor.ts `gp:groupDirectiveUpdate`). Keeping the class name here
 * means the compile table stays pure and testable without a def table.
 */
export interface DirectiveConditions {
    /** false = an explicit order that overrides what the unit is doing.
     *  Omitted → the wire default (true), i.e. only unemployed units. */
    idleOnly?: boolean;
    /** Command-language class name ("armour", "infantry", …). */
    unitClass?: string;
}

export interface GroupDirectivePayload {
    directiveId: number;        // 0 = create new
    groupId: number;            // 0 = condition-scoped
    directiveType: DirectiveType;
    priority: number;           // 0-100 mapped from slider
    shape: OrderShape;
    params: number[];           // Interpreted per shape
    requestedStrength: number;  // 0 = take what idles
    phasesJson?: string;        // Optional phase gate from when-condition
    /** Absent for a group-scoped directive — the server derives
     *  `conditions.org_group` from `group_id` and the roster is the group. */
    conditions?: DirectiveConditions;
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
    // Subject='ai' → AI guidance (interaction §6). Guarded by the shapes that
    // path can actually encode, not by §5's table (D60) — and guarded here so
    // a caller that skipped `validateIntent` cannot mint a guidance payload
    // carrying neither `targetEntity` nor `targetPoint`.
    if (intent.subject.type === 'ai') {
        if (!getAcceptedTargetShapes(intent.verb, intent.subject).includes(intent.target.shape)) {
            console.warn('[compile-table] AI guidance cannot carry target shape:',
                intent.target.shape);
            return null;
        }
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
        case 'scout:point':
        case 'scout:entity': {
            return compileToGroupDirective(intent, DirectiveType.Screen);
        }

        // Escort
        case 'escort:entity': {
            return compileToGroupDirective(intent, DirectiveType.Escort);
        }

        // Withdraw
        case 'withdraw:point':
        case 'withdraw:entity': {
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
        case 'build:point':
        case 'build:entity': {
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

    // A class subject IS the roster for an ungrouped directive, so it has to
    // travel as conditions or the directive addresses the whole team. And it
    // travels with `idleOnly: false` — the player picked a force and gave it an
    // order, which is the definition of overriding what that force is doing.
    // A group-scoped directive sends none of this: the group is the roster and
    // its members keep the suspend/auto-rejoin semantics (Q-D-d §3).
    const conditions: DirectiveConditions | undefined =
        groupId === 0 && subject.type === 'idle-filter' && subject.filterClass
            ? { idleOnly: false, unitClass: subject.filterClass }
            : undefined;

    const payload: GroupDirectivePayload = {
        directiveId: 0,         // 0 = create new
        groupId,
        directiveType,
        priority: Math.round(priority),
        shape,
        params,
        requestedStrength: 0,   // 0 = take what idles
        phasesJson,
        conditions,
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
    // Check shape compatibility against the rule this intent's own compile
    // path applies — §5's verb table for a directive, the guidance payload's
    // fields for `subject = the AI` (D60). Same function the map-arm target
    // picker reads, so the offer and the refusal can never drift apart.
    if (!getAcceptedTargetShapes(intent.verb, intent.subject).includes(intent.target.shape)) {
        // Names what is needed, not just what was refused (D51).
        return explainShapeMismatch(intent.verb, intent.target.shape, intent.subject);
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
