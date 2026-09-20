/**
 * PLAN-beta-broadcast.md lane S2 / beta E2E1 defect D9.
 *
 * The relay already enforces this (rts/Server/ClientMessageHandler.cpp,
 * "Broadcast relay admission") as an ALLOW-LIST: a `.msb` relay has no
 * simulation to affect, so it admits only Handshake, AuthRequest, Ping and
 * ReplayControl from a watcher, plus ViewportUpdate (accepted but ignored).
 * Everything else is dropped — a verb added to the protocol tomorrow is
 * refused by default rather than admitted by default.
 *
 * The client-side gate used to wrap only `sendPlayerCommand` /
 * `sendPlayerCommandBatch` (game-processor.ts), which left every other
 * player verb — `SelectionState` chief among them (E2E1 D9) — going out over
 * the wire only to be silently dropped by the relay. Mirroring the relay's
 * allow-list here, at the one place every verb funnels through
 * (`Connection.sendClientMessage`), means a watcher never emits a doomed
 * message and a future verb is safe by construction.
 *
 * Its own module (rather than a closure inside connection.ts) so the
 * decision is testable without a live transport.
 */
import { ClientPayload } from '../protocol/spring-web/client-payload.js';

/** The verbs a broadcast relay admits from a watcher. Keep in lockstep with
 *  the `admitted` list in rts/Server/ClientMessageHandler.cpp. */
export const BROADCAST_SPECTATOR_ALLOWED_VERBS: ReadonlySet<ClientPayload> = new Set([
    ClientPayload.Handshake,
    ClientPayload.AuthRequest,
    ClientPayload.Ping,
    ClientPayload.ReplayControl,
    ClientPayload.ViewportUpdate,
]);

/** True when `payloadType` must be dropped before it reaches the wire: this
 *  connection is watching a broadcast relay (not a live game or a finished
 *  replay) as a spectator, and the verb is not on the relay's admit list. */
export function isBroadcastSendGated(
    payloadType: ClientPayload, role: string, isBroadcastFeed: boolean,
): boolean {
    return role === 'spectator' && isBroadcastFeed
        && !BROADCAST_SPECTATOR_ALLOWED_VERBS.has(payloadType);
}
