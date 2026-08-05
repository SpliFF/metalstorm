/**
 * integration.ts — Bridge between Connection and native UI system
 *
 * Wires up the rulesParams stream from the server to the ui-store
 * and provides the sendCommand bridge for widgets to send messages.
 */

import type { Connection } from '../../core/connection.js';
import { uiStore } from './ui-store.js';

/**
 * The slice of `Connection` the widget sendCommand bridge needs. The real
 * Connection lives inside the game-processor worker (GW4), so on the main
 * thread main.ts passes a proxy implementing this interface that forwards
 * each call over the gp message channel; a real `Connection` satisfies it
 * structurally for any same-thread caller (e.g. wireRulesParamsToStore).
 */
export interface CommandConnection {
    sendGroupDirective(
        directiveId: number, groupId: number, type: number, shape: number, params: number[],
        opts?: { priority?: number; requestedStrength?: number; active?: boolean },
    ): void;
    sendGroupDirectiveRemove(directiveId: number): void;
    sendStandingOrderCreate(type: number, priority: number, params: number[], expiresInFrames?: number): void;
    sendOrgGroupCreate(name: string, memberIds: number[]): void;
    sendOrgGroupUpdate(groupId: number, addIds: number[], removeIds: number[], name: string): void;
    sendOrgGroupDisband(groupId: number): void;
    sendGroupPosture(groupId: number, postureJson: string): void;
    sendLuaRulesMsg(data: Uint8Array | string): void;
    sendConsoleCommand(scope: string, command: string): void;
    sendPlayerCommand(commandId: number, unitIds: number[], params: number[], options?: number): void;
    sendSelectionState(unitIds: number[]): void;
}

// Debug hook: expose the native-ui store so live boot-verification
// (chrome-devtools / the metalstorm-demo live-verify workflow) can inspect the
// gameRulesParams/teamRulesParams the widgets read — e.g.
// `window.__msUiStore.gameRulesParam('objective_count')`. Read-only handle to
// the singleton; harmless in prod.
if (typeof window !== 'undefined') {
    (window as unknown as { __msUiStore?: unknown }).__msUiStore = uiStore;
}
import { WidgetLoader } from './widget-loader.js';
import { startEntityIndexProducer } from './entity-index-producer.js';

let widgetLoader: WidgetLoader | null = null;
let activeConnection: CommandConnection | null = null;
// The named-entity-index producer (regions/objectives/groups → index). Kept at
// module scope so the same session teardown that disposes the widget loader
// also stops the producer and clears the index.
let stopEntityIndexProducer: (() => void) | null = null;

/**
 * Initialize native UI for a game session.
 * This sets up the widget loader and wires up the connection events.
 */
export async function initializeNativeUI(
    gameId: string,
    httpBase: string,
    /** Spring's sim `playerNum`, NOT the DB account id — see PLAN-native-ui §3.3. */
    playerId: number,
    teamId: number,
    connection: CommandConnection | null = null,
    role: string = '',
    /** DB account id, exposed to widgets as `ctx.identity.accountId`. */
    accountId: number = 0
): Promise<void> {
    // Clean up any existing loader
    if (widgetLoader) {
        widgetLoader.dispose();
        widgetLoader = null;
    }

    // Store connection reference
    activeConnection = connection;

    // Start the named-entity-index producer (regions/objectives/org-groups →
    // namedEntityIndex) so the command composer's Target picker and free-text
    // accelerator have live data instead of an empty index. Idempotent across
    // re-init: stop any prior instance first.
    if (stopEntityIndexProducer) {
        stopEntityIndexProducer();
        stopEntityIndexProducer = null;
    }
    stopEntityIndexProducer = startEntityIndexProducer();

    // Create new loader and load widgets
    widgetLoader = new WidgetLoader();

    // Wire up sendCommand if we have a connection
    if (connection) {
        widgetLoader.setSendCommandProvider(createSendCommand(connection, role));
    }

    // PLAN-metalstorm-onboarding.md §4: role gates which widgets mount
    // (command-composer / ai-command-panel carry `hideForSpectator` in the
    // manifest) — spectators get the same HUD minus every order-issuing
    // panel, no separate spectator build.
    await widgetLoader.load(gameId, httpBase, playerId, teamId, role, accountId);
}

/**
 * Wire up rulesParams updates from the Connection to the ui-store.
 * This should be called when setting up Connection event handlers.
 */
export function wireRulesParamsToStore(connection: Connection): void {
    // Store reference for sendCommand
    activeConnection = connection;

    // Wire up existing widgets if loader exists
    if (widgetLoader && !widgetLoader.hasSendCommand()) {
        widgetLoader.setSendCommandProvider(createSendCommand(connection, connection.myRole));
    }
}

/**
 * Handle rulesParams update from server and update the ui-store.
 */
export function handleRulesParamUpdate(update: {
    scope: 'game' | 'team';
    id: number;
    replace: boolean;
    params: Record<string, number | string | null>;
}): void {
    if (update.scope === 'game') {
        uiStore.updateGameRulesParams(update.params, update.replace);
    } else if (update.scope === 'team') {
        uiStore.updateTeamRulesParams(update.id, update.params, update.replace);
    }
}

/**
 * Verb prefixes that ride the synced `RecvLuaMsg` wire rather than a typed
 * FlatBuffer message. `data/games/metalstorm/LuaRules/Gadgets/parley/wire.lua`
 * defines the encoding and `game_parley.lua` / `game_ai_guidance.lua` dispatch
 * on exactly these verb strings, so the widget-side verb IS the wire command
 * name — no mapping table to keep in sync.
 */
const WIRE_VERB_PREFIXES = ['guidance.', 'parley.'];

/**
 * Encode a `cmd=name&key=value&…` payload for `gadget:RecvLuaMsg`.
 *
 * Mirrors `parley/wire.lua`'s `escape`/`encode` exactly: the same four
 * characters are percent-escaped (`%`, `&`, `=`, `,`), array values are
 * comma-joined, and `null`/`undefined` fields are omitted. Booleans are sent
 * as `'1'`/`'0'` because the Lua side compares against those strings
 * (`fields.locked == '1'`); a bare `tostring(true)` would silently read false.
 */
export function encodeWireCommand(cmd: string, fields?: Record<string, unknown>): string {
    const esc = (v: unknown) =>
        String(v).replace(/[%&=,]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    const parts = ['cmd=' + esc(cmd)];
    for (const [k, v] of Object.entries(fields ?? {})) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'object' && !Array.isArray(v)) {
            // A nested object would encode as "[object Object]" and arrive as a
            // string the gadget cannot read — and the gadgets refuse silently
            // (GG.Parley.Propose returns `nil, err` and logs nothing), so this
            // must not be a quiet coercion. This is exactly how the parley
            // panel's nested `terms` stayed dead. Skip it and say so.
            console.warn(`[native-ui] wire field '${k}' is a nested object — flatten it at the call site; dropped:`, v);
            continue;
        }
        const val = Array.isArray(v)
            ? v.map((item) => esc(item)).join(',')
            : esc(typeof v === 'boolean' ? (v ? '1' : '0') : v);
        parts.push(esc(k) + '=' + val);
    }
    return parts.join('&');
}

/**
 * Create the sendCommand function that bridges widget commands to Connection methods.
 *
 * Two call shapes, both live (PLAN-endtoend.md D28):
 * - `send({ type: 'GroupDirective', … })` — the typed-object form used by the
 *   command composer, switched on below.
 * - `send('guidance.stance', { value })` — the verb form the ai-command,
 *   parley and objectives panels are written against. Verbs whose prefix is in
 *   `WIRE_VERB_PREFIXES` have a synced gadget waiting on the other end and are
 *   encoded onto the `RecvLuaMsg` wire; anything else warns, because a verb
 *   with no gadget behind it would otherwise look sent.
 *
 * Supports command types used by Metalstorm widgets:
 * - GroupDirective: strategic directives for unit groups
 * - OrgGroup: organizational group management
 * - LuaRulesMsg: messages to synced Lua
 * - ConsoleCommand: server console commands
 */
export function createSendCommand(
    connection: CommandConnection,
    role: string = '',
): (cmd: any, fields?: Record<string, unknown>) => void {
    return (cmd: any, fields?: Record<string, unknown>) => {
        if (typeof cmd === 'string') {
            if (role === 'spectator') {
                console.warn('[native-ui] command dropped — spectators cannot issue orders:', cmd);
                return;
            }
            if (!WIRE_VERB_PREFIXES.some((p) => cmd.startsWith(p))) {
                // objectives.createBounty and the map-marker verbs land here:
                // the widgets exist, the gadgets do not (see wire.lua's header).
                console.warn('[native-ui] no wire target for verb:', cmd, fields);
                return;
            }
            try {
                connection.sendLuaRulesMsg(encodeWireCommand(cmd, fields));
            } catch (e) {
                console.error('[native-ui] Error sending wire command:', e, cmd, fields);
            }
            return;
        }
        // PLAN-metalstorm-onboarding.md §4: spectators render the HUD but
        // issue nothing — this is the single choke-point every widget
        // command funnels through (GroupDirective, OrgGroup, StandingOrder,
        // LuaRulesMsg, ConsoleCommand, …), so gating here is sufficient even
        // though the server (CanCommandTeam) would refuse it anyway.
        if (role === 'spectator') {
            console.warn('[native-ui] command dropped — spectators cannot issue orders:', cmd?.type);
            return;
        }
        if (!cmd || !cmd.type) {
            console.warn('[native-ui] Invalid command - missing type:', cmd);
            return;
        }

        try {
            switch (cmd.type) {
                case 'GroupDirective':
                    if (cmd.action === 'remove' && cmd.directiveId != null) {
                        connection.sendGroupDirectiveRemove(cmd.directiveId);
                    } else if (cmd.payload) {
                        // The compile-table's `CompiledMessage` shape
                        // (compile-table.ts GroupDirectivePayload) — the
                        // command composer's commit path (metalstorm-
                        // scripting §5/task 5). `phasesJson` has no wire
                        // slot on `sendGroupDirective` yet (macro-directives
                        // phase gates are stored-but-not-evaluated server-
                        // side — PLAN-metalstorm-scripting field notes); it
                        // is intentionally dropped here rather than silently
                        // padded onto a param the server would misread.
                        const p = cmd.payload;
                        connection.sendGroupDirective(
                            p.directiveId ?? 0,
                            p.groupId ?? 0,
                            p.directiveType ?? 0,
                            p.shape ?? 0,
                            p.params ?? [],
                            { priority: p.priority, requestedStrength: p.requestedStrength },
                        );
                    } else if (cmd.groupId != null) {
                        // Legacy flat shape for any caller that isn't the
                        // compile-table (none currently, kept for callers
                        // that predate the payload wrapper).
                        connection.sendGroupDirective(
                            cmd.directiveId ?? 0,
                            cmd.groupId,
                            cmd.directiveType ?? 0,
                            cmd.shape ?? 0,
                            cmd.params ?? [],
                            { priority: cmd.priority, requestedStrength: cmd.requestedStrength },
                        );
                    }
                    break;

                case 'StandingOrder':
                    if (cmd.payload) {
                        const p = cmd.payload;
                        connection.sendStandingOrderCreate(
                            p.orderType ?? 0, p.priority ?? 0, p.params ?? [], p.expiresInFrames ?? 0,
                        );
                    }
                    break;

                case 'AIGuidance':
                    // Distinct from the ai-command panel's `guidance.*` verbs,
                    // which DO have a wire target now (see WIRE_VERB_PREFIXES).
                    // This is the composer's subject="the AI" path, whose
                    // payload is a free-form {intent, verb, target, priority} —
                    // it maps onto none of game_ai_guidance.lua's seven
                    // stance/paint/lock/delegate/fund/roe/veto commands, and
                    // still wants PLAN-metalstorm-interaction.md §6's guidance
                    // store. Logged rather than silently dropped so the gap
                    // stays visible instead of masquerading as a successful send.
                    console.warn('[native-ui] AIGuidance has no guidance-store target yet (interaction §6 not implemented):', cmd.payload);
                    break;

                case 'OrgGroup':
                    if (cmd.action === 'create' && cmd.name && cmd.memberIds) {
                        connection.sendOrgGroupCreate(cmd.name, cmd.memberIds);
                    } else if (cmd.action === 'update' && cmd.groupId != null) {
                        connection.sendOrgGroupUpdate(
                            cmd.groupId,
                            cmd.addIds ?? [],
                            cmd.removeIds ?? [],
                            cmd.name ?? ''
                        );
                    } else if (cmd.action === 'disband' && cmd.groupId != null) {
                        connection.sendOrgGroupDisband(cmd.groupId);
                    }
                    break;

                case 'GroupPosture':
                    if (cmd.groupId != null && cmd.postureJson) {
                        connection.sendGroupPosture(cmd.groupId, cmd.postureJson);
                    }
                    break;

                case 'LuaRulesMsg':
                    if (cmd.data) {
                        connection.sendLuaRulesMsg(cmd.data);
                    }
                    break;

                case 'ConsoleCommand':
                    if (cmd.command) {
                        connection.sendConsoleCommand(cmd.scope ?? 'game', cmd.command);
                    }
                    break;

                case 'PlayerCommand':
                    // For unit commands (move, attack, build, etc.)
                    if (cmd.unitIds && cmd.cmdId != null) {
                        connection.sendPlayerCommand(
                            cmd.cmdId,
                            cmd.unitIds,
                            cmd.params ?? [],
                            cmd.options ?? 0
                        );
                    }
                    break;

                case 'SelectionState':
                    if (cmd.unitIds) {
                        connection.sendSelectionState(cmd.unitIds);
                    }
                    break;

                default:
                    console.warn('[native-ui] Unknown command type:', cmd.type, cmd);
            }
        } catch (e) {
            console.error('[native-ui] Error sending command:', e, cmd);
        }
    };
}

/**
 * Clean up native UI on game exit.
 */
export function disposeNativeUI(): void {
    if (widgetLoader) {
        widgetLoader.dispose();
        widgetLoader = null;
    }
    if (stopEntityIndexProducer) {
        stopEntityIndexProducer();
        stopEntityIndexProducer = null;
    }
    activeConnection = null;
    // Note: We don't clear the ui-store here as it may be used across sessions
}