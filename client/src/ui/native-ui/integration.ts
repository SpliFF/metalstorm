/**
 * integration.ts — Bridge between Connection and native UI system
 *
 * Wires up the rulesParams stream from the server to the ui-store
 * and provides the sendCommand bridge for widgets to send messages.
 */

import type { Connection } from '../../core/connection.js';
import { uiStore } from './ui-store.js';

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
let activeConnection: Connection | null = null;
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
    playerId: number,
    teamId: number,
    connection: Connection | null = null,
    role: string = ''
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
    await widgetLoader.load(gameId, httpBase, playerId, teamId, role);
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
 * Create the sendCommand function that bridges widget commands to Connection methods.
 *
 * Supports command types used by Metalstorm widgets:
 * - GroupDirective: strategic directives for unit groups
 * - OrgGroup: organizational group management
 * - LuaRulesMsg: messages to synced Lua
 * - ConsoleCommand: server console commands
 */
export function createSendCommand(connection: Connection, role: string = ''): (cmd: any) => void {
    return (cmd: any) => {
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
                    // PLAN-metalstorm-interaction.md §6's guidance store
                    // doesn't exist yet — a subject="the AI" commit compiles
                    // correctly (compile-table.ts) but has no sim/store
                    // target to reach. Logged rather than silently dropped
                    // so this gap stays visible instead of masquerading as
                    // a successful send.
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
                            cmd.unitIds,
                            cmd.cmdId,
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