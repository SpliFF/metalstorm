/**
 * Network message inspector — intercepts and decodes protocol messages
 * for display in the debug console's network tab.
 *
 * Hooks into inbound/outbound data channel frames, decodes envelope
 * byte + FlatBuffer type, and logs to the debug console.
 */

import * as flatbuffers from 'flatbuffers';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { ClientMessage } from '../protocol/spring-web/client-message.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { debugConsole } from './debug-console.js';

const ENVELOPE_NAMES: Record<number, string> = {
    0x01: 'FlatBuffers',
    0x02: 'EntityState',
    0x03: 'EntityDelta',
    0x04: 'ProjectileState',
};

// Map enum values to type names
const SERVER_PAYLOAD_NAMES: Record<number, string> = {};
const CLIENT_PAYLOAD_NAMES: Record<number, string> = {};

// Populate from enums
for (const [key, val] of Object.entries(ServerPayload)) {
    if (typeof val === 'number') SERVER_PAYLOAD_NAMES[val] = key;
}
for (const [key, val] of Object.entries(ClientPayload)) {
    if (typeof val === 'number') CLIENT_PAYLOAD_NAMES[val] = key;
}

let enabled = false;

export function setNetInspectorEnabled(on: boolean): void {
    enabled = on;
}

export function isNetInspectorEnabled(): boolean {
    return enabled;
}

/** Log an inbound (server→client) message */
export function inspectInbound(data: Uint8Array): void {
    if (!enabled || data.length < 1) return;

    const envelope = data[0];
    const envName = ENVELOPE_NAMES[envelope] || `0x${envelope.toString(16)}`;
    const size = data.length;

    if (envelope === 0x01 && data.length > 1) {
        // Decode FlatBuffers type
        try {
            const buf = new flatbuffers.ByteBuffer(data.slice(1));
            const msg = ServerMessage.getRootAsServerMessage(buf);
            if (msg) {
                const typeName = SERVER_PAYLOAD_NAMES[msg.payloadType()] || `unknown(${msg.payloadType()})`;
                logNetMessage('←', envName, typeName, size);
                return;
            }
        } catch { /* fall through */ }
    }

    logNetMessage('←', envName, '', size);
}

/** Log an outbound (client→server) message */
export function inspectOutbound(data: Uint8Array): void {
    if (!enabled || data.length < 1) return;

    const envelope = data[0];
    const envName = ENVELOPE_NAMES[envelope] || `0x${envelope.toString(16)}`;
    const size = data.length;

    if (envelope === 0x01 && data.length > 1) {
        try {
            const buf = new flatbuffers.ByteBuffer(data.slice(1));
            const msg = ClientMessage.getRootAsClientMessage(buf);
            if (msg) {
                const typeName = CLIENT_PAYLOAD_NAMES[msg.payloadType()] || `unknown(${msg.payloadType()})`;
                logNetMessage('→', envName, typeName, size);
                return;
            }
        } catch { /* fall through */ }
    }

    logNetMessage('→', envName, '', size);
}

function logNetMessage(dir: string, envelope: string, typeName: string, size: number): void {
    const typeStr = typeName ? ` ${typeName}` : '';
    debugConsole.addEntry({
        id: 0,
        timestamp: Date.now(),
        level: 1, // INFO
        section: 'net',
        scope: '',
        process: 'client',
        message: `${dir} [${envelope}]${typeStr} (${size} bytes)`,
        frame: 0,
    });
}
