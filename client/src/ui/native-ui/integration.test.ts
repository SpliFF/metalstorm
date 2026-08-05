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
        // commandId first, then unitIds — Connection.sendPlayerCommand's real
        // signature (the pre-fix bridge passed them swapped).
        expect(conn.sendPlayerCommand).toHaveBeenCalledWith(1, [1], [], 0);
    });

    it('still forwards commands when no role is supplied (default player HUD)', () => {
        const conn = makeMockConnection();
        const send = createSendCommand(conn);
        send({ type: 'SelectionState', unitIds: [7] });
        expect(conn.sendSelectionState).toHaveBeenCalledWith([7]);
    });
});

/**
 * PLAN-endtoend.md D28: the ai-command, parley and objectives panels call a
 * two-argument verb API (`sendCommand('guidance.stance', {value})`) while the
 * bridge only understood the composer's typed-object form, so every non-
 * composer HUD action died at `Invalid command - missing type`. The verb names
 * are not a client invention — `game_ai_guidance.lua` and `game_parley.lua`
 * dispatch `RecvLuaMsg` on exactly these strings, so the wire command name and
 * the widget verb are the same token by construction.
 */
describe('createSendCommand — the RecvLuaMsg verb form (D28)', () => {
    it('encodes a guidance verb onto the LuaRules wire', () => {
        const conn = makeMockConnection();
        createSendCommand(conn, 'player')('guidance.stance', { value: 'aggressive' });
        expect(conn.sendLuaRulesMsg).toHaveBeenCalledWith('cmd=guidance.stance&value=aggressive');
    });

    it('encodes a parley proposal, including its numeric terms', () => {
        const conn = makeMockConnection();
        createSendCommand(conn, 'player')('parley.propose', { kind: 'ceasefire', toTeam: 4, duration: 600 });
        const sent = conn.sendLuaRulesMsg.mock.calls[0][0] as string;
        expect(sent.startsWith('cmd=parley.propose')).toBe(true);
        for (const kv of ['kind=ceasefire', 'toTeam=4', 'duration=600']) expect(sent).toContain(kv);
    });

    it('percent-escapes the four characters the Lua codec escapes', () => {
        const conn = makeMockConnection();
        // parley/wire.lua escapes exactly %, &, = and , — a region key carrying
        // any of them must survive the round trip rather than split the payload.
        createSendCommand(conn, 'player')('guidance.paint', { regionKey: 'a&b=c,d%e', value: 'forbidden' });
        const sent = conn.sendLuaRulesMsg.mock.calls[0][0] as string;
        expect(sent).toContain('regionKey=a%26b%3Dc%2Cd%25e');
    });

    it('comma-joins array fields and omits null/undefined ones', () => {
        const conn = makeMockConnection();
        createSendCommand(conn, 'player')('parley.propose', { corridor: ['west_pass', 'east_pass'], amount: null, payer: undefined });
        const sent = conn.sendLuaRulesMsg.mock.calls[0][0] as string;
        expect(sent).toContain('corridor=west_pass,east_pass');
        expect(sent).not.toContain('amount');
        expect(sent).not.toContain('payer');
    });

    it("sends booleans as '1'/'0', which is what the gadget compares against", () => {
        const conn = makeMockConnection();
        // game_ai_guidance.lua: `fields.locked == '1'` — tostring(true) reads false.
        createSendCommand(conn, 'player')('guidance.lock', { groupId: 3, locked: true });
        expect(conn.sendLuaRulesMsg.mock.calls[0][0]).toContain('locked=1');
    });

    it('refuses a verb with no gadget behind it rather than looking sent', () => {
        const conn = makeMockConnection();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        createSendCommand(conn, 'player')('objectives.createBounty', { def: 'x', stake: 10 });
        expect(conn.sendLuaRulesMsg).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('[native-ui] no wire target for verb:', 'objectives.createBounty', { def: 'x', stake: 10 });
        warn.mockRestore();
    });

    it('drops a verb command for a spectator', () => {
        const conn = makeMockConnection();
        createSendCommand(conn, 'spectator')('guidance.stance', { value: 'aggressive' });
        for (const fn of Object.values(conn)) expect(fn).not.toHaveBeenCalled();
    });

    it('refuses to silently mangle a nested object field', () => {
        const conn = makeMockConnection();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The parley panel used to send { kind, toTeam, terms: {...} }; the
        // gadget reads flat fields, so the nested object arrived as
        // "[object Object]" and every term read nil.
        createSendCommand(conn, 'player')('parley.propose', { kind: 'ceasefire', terms: { duration: 600 } });
        const sent = conn.sendLuaRulesMsg.mock.calls[0][0] as string;
        expect(sent).not.toContain('object Object');
        expect(sent).not.toContain('terms');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
