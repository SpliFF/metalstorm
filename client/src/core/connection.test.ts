/**
 * Beta E2E1 defect D9: the broadcast-spectator send gate used to wrap only
 * `sendPlayerCommand` / `sendPlayerCommandBatch` (game-processor.ts), so a
 * watcher still emitted `SelectionState` (and every other player verb) to
 * the relay, which silently dropped it. The gate now lives in
 * `Connection.sendClientMessage` — the one choke point every outgoing verb
 * funnels through — via broadcast-send-gate.ts. This drives a real
 * `Connection` through AuthResponse(role=spectator) + ReplayState(broadcast)
 * and asserts none of its player-verb methods reach a fake transport.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as flatbuffers from 'flatbuffers';

import { Connection } from './connection.js';
import type { GameTransport, TransportClass } from './transport.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { ClientMessage } from '../protocol/spring-web/client-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { AuthResponse } from '../protocol/spring-web/auth-response.js';
import { AuthStatus } from '../protocol/spring-web/auth-status.js';
import { ReplayState } from '../protocol/spring-web/replay-state.js';
import { ReplayControlAction } from '../protocol/spring-web/replay-control-action.js';
import { ENVELOPE_FLATBUFFERS } from './protocol-version.js';
import { BROADCAST_SPECTATOR_ALLOWED_VERBS, isBroadcastSendGated } from './broadcast-send-gate.js';

function frameServerMessage(payloadType: ServerPayload, payloadOffset: number, builder: flatbuffers.Builder): Uint8Array {
    builder.finish(ServerMessage.createServerMessage(builder, payloadType, payloadOffset));
    const buf = builder.asUint8Array();
    const frame = new Uint8Array(1 + buf.length);
    frame[0] = ENVELOPE_FLATBUFFERS;
    frame.set(buf, 1);
    return frame;
}

function authResponseFrame(role: string): Uint8Array {
    const b = new flatbuffers.Builder(256);
    const roleOff = b.createString(role);
    const off = AuthResponse.createAuthResponse(b, AuthStatus.OK, 0, 1, 0, 0, roleOff, 0, 1);
    return frameServerMessage(ServerPayload.AuthResponse, off, b);
}

function replayStateFrame(broadcast: boolean): Uint8Array {
    const b = new flatbuffers.Builder(256);
    const gameIdOff = b.createString('game-1');
    const mapIdOff = b.createString('map-1');
    const off = ReplayState.createReplayState(
        b, 0, 1000, 500, false, 1.0, false, 0, -1, 0, false,
        gameIdOff, mapIdOff, -1, broadcast, 3600, 500);
    return frameServerMessage(ServerPayload.ReplayState, off, b);
}

/** Decode the ClientPayload tag of a frame captured off a fake transport's
 *  `send`, so a positive assertion ("the allowed verb actually went out")
 *  proves it's the right verb, not just that *something* was sent. */
function sentPayloadType(frame: Uint8Array): ClientPayload {
    const bb = new flatbuffers.ByteBuffer(frame.slice(1));
    return ClientMessage.getRootAsClientMessage(bb).payloadType();
}

class FakeTransport implements GameTransport {
    readonly type = 'webtransport' as const;
    connected = true;
    sent: Uint8Array[] = [];
    async connect(): Promise<void> { /* unused in this test */ }
    disconnect(): void { /* unused in this test */ }
    send(data: Uint8Array, _cls?: TransportClass): void { this.sent.push(data); }
}

/** Puts a fresh Connection into "watching a broadcast relay as a spectator"
 *  state, with a fake transport wired in so sends are observable. */
function makeBroadcastSpectatorConnection(): { conn: Connection; transport: FakeTransport } {
    const conn = new Connection();
    const transport = new FakeTransport();
    (conn as unknown as { transport: GameTransport | null }).transport = transport;
    conn.ingestFramedMessage(authResponseFrame('spectator'));
    conn.ingestFramedMessage(replayStateFrame(true));
    expect(conn.myRole).toBe('spectator');
    expect(conn.authenticated).toBe(true);
    return { conn, transport };
}

describe('broadcast-send-gate: pure allow-list', () => {
    it('gates every ClientPayload verb except the relay\'s admit list', () => {
        for (const key of Object.keys(ClientPayload)) {
            if (!Number.isNaN(Number(key))) continue;  // reverse-mapping entries
            const value = ClientPayload[key as keyof typeof ClientPayload] as ClientPayload;
            const gated = isBroadcastSendGated(value, 'spectator', true);
            expect(gated).toBe(!BROADCAST_SPECTATOR_ALLOWED_VERBS.has(value));
        }
    });

    it('never gates a player role, or a spectator not watching a broadcast', () => {
        for (const key of Object.keys(ClientPayload)) {
            if (!Number.isNaN(Number(key))) continue;
            const value = ClientPayload[key as keyof typeof ClientPayload] as ClientPayload;
            expect(isBroadcastSendGated(value, 'player', true)).toBe(false);
            expect(isBroadcastSendGated(value, 'spectator', false)).toBe(false);
        }
    });
});

describe('Connection: broadcast-spectator send gate (E2E1 D9)', () => {
    let conn: Connection;
    let transport: FakeTransport;

    beforeEach(() => {
        ({ conn, transport } = makeBroadcastSpectatorConnection());
    });

    it('drops every player-originated verb — enumerated, not hand-picked', () => {
        // Every call a watcher's UI could plausibly make. SelectionState is
        // the exact verb D9 caught leaking; the rest close out the same gap
        // for every other player-identity-bearing verb this Connection can
        // send.
        conn.sendSelectionState([1, 2, 3]);
        conn.sendPlayerCommand(1, [1], [0, 0, 0]);
        conn.sendPlayerCommandBatch([{ commandId: 1, unitIds: [1], params: [] }]);
        conn.sendPathRequest(1, 0, 0, 0, 1, 0, 1, 0, 1);
        conn.sendPathRequestCancel(1);
        conn.sendPlayerLeaveIntent(3);
        conn.sendOrgGroupCreate('alpha', [1, 2]);
        conn.sendOrgGroupUpdate(1, [3], []);
        conn.sendOrgGroupDisband(1);
        conn.sendGroupDirective(0, 1, 0, 0, [0, 0, 0]);
        conn.sendGroupDirectiveRemove(1);
        conn.sendGroupPosture(1, '{}');
        conn.sendStandingOrderCreate(0, 0, [0, 0, 0]);
        conn.sendConsoleCommand('server', 'pause');
        conn.sendClientEvalResponse(1, true, 'ok');
        conn.sendLuaRulesMsg('hello');
        conn.sendLuaUIMsg('hello', 0);

        expect(transport.sent).toEqual([]);
    });

    it('still allows the relay-admitted verbs through: Ping, ReplayControl, ViewportUpdate', () => {
        conn.sendReplayControl(ReplayControlAction.Pause);
        conn.sendViewportUpdate(0, 0, 0, 100, 100, 0, 1);

        const types = transport.sent.map(sentPayloadType);
        expect(types).toContain(ClientPayload.ReplayControl);
        expect(types).toContain(ClientPayload.ViewportUpdate);
    });

    it('a live-game spectator (not broadcast) is not gated', () => {
        const live = new Connection();
        const liveTransport = new FakeTransport();
        (live as unknown as { transport: GameTransport | null }).transport = liveTransport;
        live.ingestFramedMessage(authResponseFrame('spectator'));
        // No ReplayState at all ⇒ isBroadcastFeed stays false (a live game
        // never sends one).

        live.sendSelectionState([1]);

        expect(liveTransport.sent.map(sentPayloadType)).toContain(ClientPayload.SelectionState);
    });

    it('a player role watching the same broadcast feed is not gated', () => {
        const player = new Connection();
        const playerTransport = new FakeTransport();
        (player as unknown as { transport: GameTransport | null }).transport = playerTransport;
        player.ingestFramedMessage(authResponseFrame('player'));
        player.ingestFramedMessage(replayStateFrame(true));

        player.sendSelectionState([1]);

        expect(playerTransport.sent.map(sentPayloadType)).toContain(ClientPayload.SelectionState);
    });
});
