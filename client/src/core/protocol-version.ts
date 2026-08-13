/**
 * The one client-side definition of the wire-protocol version and the control
 * envelope byte.
 *
 * Extracted from connection.ts so a second client of the same wire (the
 * scripted wire client in `client/wire/`, PLAN-replay.md §7.11 T2-a-1) can
 * speak it without copying the number. The version already lives in two places
 * that must move together — here and `Protocol::CURRENT_PROTOCOL_VERSION`
 * (rts/Server/Protocol.h) — and a third copy is exactly the drift
 * PLAN-protocol-guard.md was written about.
 */

/** Wire-protocol version sent in the Handshake (C1). The game server rejects a
 *  mismatch with AuthStatus.VersionMismatch — bump this in lockstep with
 *  Protocol::CURRENT_PROTOCOL_VERSION (rts/Server/Protocol.h) on any breaking
 *  schema / envelope change. */
export const PROTOCOL_VERSION = 1;

/** Envelope byte prefixing a FlatBuffers ClientMessage/ServerMessage. The other
 *  envelope bytes (0x02–0x09) are binary state formats only connection.ts
 *  decodes, and stay there. */
export const ENVELOPE_FLATBUFFERS = 0x01;
