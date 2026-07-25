/**
 * integration.test.ts — createSendCommand's spectator gate.
 *
 * PLAN-metalstorm-onboarding.md §4 / §8: "spectator widget-set has zero
 * command paths (assert no order-send call sites reachable)". Every widget
 * command funnels through createSendCommand before reaching Connection, so
 * this one choke-point test covers every command type a widget can emit —
 * no need to enumerate widgets.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Connection } from '../../core/connection.js';

// integration.ts transitively imports widget-loader.ts -> config.ts, which
// reads `globalThis.location.hostname` at module-load time (it resolves the
// lobby HTTP base for both the main thread and the game-processor worker,
// both of which have a real `location`). Vitest's default node environment
// has none, so the module must be imported dynamically, after stubbing
// `location`, rather than via a static top-level import.
let createSendCommand: typeof import('./integration.js')['createSendCommand'];

beforeAll(async () => {
    vi.stubGlobal('location', { hostname: 'localhost' });
    ({ createSendCommand } = await import('./integration.js'));
});

function makeMockConnection() {
    return {
        sendGroupDirectiveRemove: vi.fn(),
        sendGroupDirective: vi.fn(),
        sendStandingOrderCreate: vi.fn(),
        sendOrgGroupCreate: vi.fn(),
        sendOrgGroupUpdate: vi.fn(),
        sendOrgGroupDisband: vi.fn(),
        sendGroupPosture: vi.fn(),
        sendLuaRulesMsg: vi.fn(),
        sendConsoleCommand: vi.fn(),
        sendPlayerCommand: vi.fn(),
        sendSelectionState: vi.fn(),
    } as unknown as Connection & Record<string, ReturnType<typeof vi.fn>>;
}

const COMMANDS: Array<{ label: string; cmd: any }> = [
    { label: 'GroupDirective', cmd: { type: 'GroupDirective', payload: { groupId: 1, directiveType: 0, shape: 0, params: [] } } },
    { label: 'GroupDirective remove', cmd: { type: 'GroupDirective', action: 'remove', directiveId: 5 } },
    { label: 'StandingOrder', cmd: { type: 'StandingOrder', payload: { orderType: 0, priority: 0, params: [] } } },
    { label: 'OrgGroup create', cmd: { type: 'OrgGroup', action: 'create', name: 'x', memberIds: [1] } },
    { label: 'OrgGroup update', cmd: { type: 'OrgGroup', action: 'update', groupId: 1, addIds: [], removeIds: [] } },
    { label: 'OrgGroup disband', cmd: { type: 'OrgGroup', action: 'disband', groupId: 1 } },
    { label: 'GroupPosture', cmd: { type: 'GroupPosture', groupId: 1, postureJson: '{}' } },
    { label: 'LuaRulesMsg', cmd: { type: 'LuaRulesMsg', data: 'x' } },
    { label: 'ConsoleCommand', cmd: { type: 'ConsoleCommand', command: 'help' } },
    { label: 'PlayerCommand', cmd: { type: 'PlayerCommand', unitIds: [1], cmdId: 1 } },
    { label: 'SelectionState', cmd: { type: 'SelectionState', unitIds: [1] } },
];

describe('createSendCommand — spectator gate', () => {
    for (const { label, cmd } of COMMANDS) {
        it(`drops ${label} for role=spectator without touching Connection`, () => {
            const conn = makeMockConnection();
            const send = createSendCommand(conn, 'spectator');
            send(cmd);
            for (const fn of Object.values(conn)) expect(fn).not.toHaveBeenCalled();
        });
    }

    it('still forwards commands for a real player (role=player)', () => {
        const conn = makeMockConnection();
        const send = createSendCommand(conn, 'player');
        send({ type: 'PlayerCommand', unitIds: [1], cmdId: 1 });
        expect(conn.sendPlayerCommand).toHaveBeenCalledWith([1], 1, [], 0);
    });

    it('still forwards commands when no role is supplied (default player HUD)', () => {
        const conn = makeMockConnection();
        const send = createSendCommand(conn);
        send({ type: 'SelectionState', unitIds: [7] });
        expect(conn.sendSelectionState).toHaveBeenCalledWith([7]);
    });
});
