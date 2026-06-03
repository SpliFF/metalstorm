/**
 * Network message inspector — intercepts and decodes protocol messages
 * for display in the debug console's network tab, and maintains an
 * always-on per-envelope bandwidth tally for PLAN-performance.md Phase 2
 * (network packet-size / excessive-data review).
 *
 * Two concerns live here:
 *   1. Debug-console logging of each frame (gated behind `enabled`).
 *   2. A lightweight cumulative byte/count accumulator keyed by envelope
 *      type (and, for FlatBuffers frames, by payload type). This runs
 *      unconditionally because it's cheap (one byte read + a map bump,
 *      plus a vtable lookup for 0x01 frames) and is what the PerfOverlay
 *      reads to break bandwidth down by stream.
 *
 * Hook points (see connection.ts): `recordInbound` at the single
 * `handleBinaryMessage` dispatch entry, `recordOutbound` at `sendOnControl`.
 */

import * as flatbuffers from 'flatbuffers';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { ClientMessage } from '../protocol/spring-web/client-message.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';

// GW8: net-inspector must be worker-safe — the connection (and thus the
// bandwidth tally) now lives in the game-processor worker. It used to `import
// { debugConsole }` directly, which drags the DOM-constructing debug-console
// singleton into the worker bundle (ReferenceError: window/document undefined
// at module load). Inverted to a registered log sink: debug-console (main-only)
// calls setNetLogSink(); the worker leaves it null and the gated logging no-ops
// while the tally still runs. Dependency is now one-way (debug-console →
// net-inspector), keeping net-inspector free of any DOM import.
export interface NetLogEntry {
    id: number; timestamp: number; level: number; section: string;
    scope: string; process: string; message: string; frame: number;
}
let netLogSink: ((entry: NetLogEntry) => void) | null = null;
export function setNetLogSink(sink: ((entry: NetLogEntry) => void) | null): void {
    netLogSink = sink;
}

const ENVELOPE_NAMES: Record<number, string> = {
    0x01: 'FlatBuffers',
    0x02: 'EntityState',
    0x03: 'EntityDelta',
    0x04: 'ProjectileState',
    0x05: 'PieceState',
    0x06: 'BuildActivity',
    0x07: 'LosBitmap',
    0x08: 'Decals',
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

// ─── Bandwidth accumulator (always on) ───

export interface EnvelopeStat {
    count: number;
    bytes: number;
}

/** A point-in-time copy of the cumulative counters. Consumers diff two
 *  snapshots over a wall-clock window to derive per-second rates. */
export interface NetStatsSnapshot {
    inbound: Record<string, EnvelopeStat>;
    outbound: Record<string, EnvelopeStat>;
    inboundTotalBytes: number;
    outboundTotalBytes: number;
}

const inboundStats: Record<string, EnvelopeStat> = {};
const outboundStats: Record<string, EnvelopeStat> = {};
let inboundTotalBytes = 0;
let outboundTotalBytes = 0;

function bump(map: Record<string, EnvelopeStat>, label: string, bytes: number): void {
    const s = map[label];
    if (s) {
        s.count++;
        s.bytes += bytes;
    } else {
        map[label] = { count: 1, bytes };
    }
}

/** Resolve a stat-bucket label for a framed message. FlatBuffers frames
 *  (0x01) are broken out by payload type so the bandwidth report shows
 *  which message types cost bytes (e.g. `FB:GameUnitDefs`). The decode is
 *  a cheap root + vtable read — no deep parse, no copy (subarray is a view). */
function labelFor(data: Uint8Array, isServer: boolean): string {
    const envelope = data[0];
    const envName = ENVELOPE_NAMES[envelope] || `0x${envelope.toString(16)}`;
    if (envelope === 0x01 && data.length > 1) {
        try {
            const buf = new flatbuffers.ByteBuffer(data.subarray(1));
            if (isServer) {
                const msg = ServerMessage.getRootAsServerMessage(buf);
                return `FB:${SERVER_PAYLOAD_NAMES[msg.payloadType()] || msg.payloadType()}`;
            }
            const msg = ClientMessage.getRootAsClientMessage(buf);
            return `FB:${CLIENT_PAYLOAD_NAMES[msg.payloadType()] || msg.payloadType()}`;
        } catch { /* fall through to envelope name */ }
    }
    return envName;
}

/** Snapshot the cumulative counters (deep copy so the caller can diff). */
export function snapshotNetStats(): NetStatsSnapshot {
    const copy = (src: Record<string, EnvelopeStat>): Record<string, EnvelopeStat> => {
        const out: Record<string, EnvelopeStat> = {};
        for (const k in src) out[k] = { count: src[k].count, bytes: src[k].bytes };
        return out;
    };
    return {
        inbound: copy(inboundStats),
        outbound: copy(outboundStats),
        inboundTotalBytes,
        outboundTotalBytes,
    };
}

/** Zero the accumulator (e.g. at game start so per-game budgets are clean). */
export function resetNetStats(): void {
    for (const k in inboundStats) delete inboundStats[k];
    for (const k in outboundStats) delete outboundStats[k];
    inboundTotalBytes = 0;
    outboundTotalBytes = 0;
}

// ─── Inbound / outbound hooks ───

/** Record an inbound (server→client) frame: always tallies bandwidth,
 *  and logs to the debug console when the inspector is enabled. */
export function recordInbound(data: Uint8Array): void {
    if (data.length < 1) return;
    const label = labelFor(data, true);
    bump(inboundStats, label, data.length);
    inboundTotalBytes += data.length;
    if (enabled) logNetMessage('←', label, data.length);
}

/** Record an outbound (client→server) frame. */
export function recordOutbound(data: Uint8Array): void {
    if (data.length < 1) return;
    const label = labelFor(data, false);
    bump(outboundStats, label, data.length);
    outboundTotalBytes += data.length;
    if (enabled) logNetMessage('→', label, data.length);
}

// Backwards-compatible aliases (the original log-only entry points).
export const inspectInbound = recordInbound;
export const inspectOutbound = recordOutbound;

function logNetMessage(dir: string, label: string, size: number): void {
    netLogSink?.({
        id: 0,
        timestamp: Date.now(),
        level: 1, // INFO
        section: 'net',
        scope: '',
        process: 'client',
        message: `${dir} [${label}] (${size} bytes)`,
        frame: 0,
    });
}
