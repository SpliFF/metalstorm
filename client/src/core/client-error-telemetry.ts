/**
 * Client-error telemetry (PLAN-client-resilience.md task 3) — assembles a
 * crash/fatal report, dedups + rate-caps + size-caps it, and POSTs it to
 * `POST /api/client-errors`. Isomorphic: the game-processor worker (richest
 * context — frame profiler, log ring, live entity count) and the main thread
 * (worker-wedged / worker-onerror / onmessageerror, where the worker itself
 * may be unresponsive) both call `reportClientError` directly; each realm
 * gets its own module instance (no shared state across the worker boundary),
 * so `configureErrorTelemetry` must be called once per realm.
 *
 * EXTENSION POINT for PLAN-client-resilience.md task 2 (the R1/R2/R3 recovery
 * ladder, Opus + PLAN-quickstart.md part B): every report already carries a
 * `recoveryRung` field ('none' until the ladder exists). Once the ladder is
 * built it should stamp the rung it actually took (or attempted) onto the
 * report it passes in here — this module doesn't decide rungs, it only
 * transports whatever rung the caller supplies.
 */

/** Why this report was generated. Task 2's rungs react to a subset of these
 *  (`wedged` → R2, `contextLost` → R1); `injected` covers task 5's
 *  fault-injection verbs so a synthetic failure is visibly tagged in the
 *  dashboard rather than indistinguishable from a real one. */
export type ClientErrorReason =
    | 'fatal' | 'wedged' | 'contextLost' | 'messageError' | 'injected';

export interface ClientErrorReport {
    reason: ClientErrorReason;
    errorClass: string;
    message: string;
    stack?: string;
    /** Recovery rung taken/attempted for this report. 'none' until task 2's
     *  ladder exists — see the EXTENSION POINT note above. */
    recoveryRung?: string;
    /** Frame-profiler phase slice active when the error fired (e.g. 'fx'),
     *  when known. */
    phase?: string;
    frame?: number;
    entityCount?: number;
    gameId?: string;
    mapId?: string;
    /** Last ~50 log-ring lines, oldest first. Truncated first if the
     *  serialised payload exceeds the size cap. */
    logRing?: string[];
}

interface WireReport {
    reason: string;
    error_class: string;
    message: string;
    stack: string;
    stack_hash: string;
    recovery_rung: string;
    phase: string;
    frame: number;
    entity_count: number;
    game_id: string;
    map_id: string;
    build_stamp: string;
    gpu_renderer: string;
    log_ring: string[];
    count: number;
}

const MAX_PAYLOAD_BYTES = 32 * 1024;
const RATE_CAP_PER_HOUR = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RECOUNT_DEBOUNCE_MS = 60 * 1000;
const MAX_RETRY_QUEUE = 3;
const RETRY_DELAY_MS = 5000;

let endpointBase = '';
let authToken = '';
let enabled = true;
let buildStamp = '';
let gpuRenderer = '';

/** Wire the report channel once per realm (worker: from `gp:init`/gpConnect;
 *  main: from `startGame()`). Safe to call again to update a field (e.g. a
 *  fresh token on reconnect) — omitted fields keep their current value. */
export function configureErrorTelemetry(opts: {
    endpoint?: string;
    token?: string;
    enabled?: boolean;
    buildStamp?: string;
    gpuRenderer?: string;
}): void {
    if (opts.endpoint !== undefined) endpointBase = opts.endpoint.replace(/\/+$/, '');
    if (opts.token !== undefined) authToken = opts.token;
    if (opts.enabled !== undefined) enabled = opts.enabled;
    if (opts.buildStamp !== undefined) buildStamp = opts.buildStamp;
    if (opts.gpuRenderer !== undefined) gpuRenderer = opts.gpuRenderer;
}

/** FNV-1a over the class+message+head-of-stack — stable across repeats of
 *  the same crash, sensitive enough to separate distinct ones. Exported for
 *  the dashboard/tests to reproduce the same grouping key. */
export function hashReportKey(errorClass: string, message: string, stack: string): string {
    const s = `${errorClass}|${message}|${stack.slice(0, 500)}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

interface DedupEntry {
    count: number;
    timer: ReturnType<typeof setTimeout> | null;
    original: ClientErrorReport;
}
const seen = new Map<string, DedupEntry>();
const sendTimes: number[] = [];
const retryQueue: string[] = [];
let retryScheduled = false;

function withinRateCap(now: number): boolean {
    while (sendTimes.length && sendTimes[0] < now - RATE_WINDOW_MS) sendTimes.shift();
    if (sendTimes.length >= RATE_CAP_PER_HOUR) return false;
    sendTimes.push(now);
    return true;
}

function buildWire(report: ClientErrorReport, hash: string, count: number): WireReport {
    return {
        reason: report.reason,
        error_class: report.errorClass,
        message: report.message,
        stack: report.stack ?? '',
        stack_hash: hash,
        recovery_rung: report.recoveryRung ?? 'none',
        phase: report.phase ?? '',
        frame: report.frame ?? 0,
        entity_count: report.entityCount ?? 0,
        game_id: report.gameId ?? '',
        map_id: report.mapId ?? '',
        build_stamp: buildStamp,
        gpu_renderer: gpuRenderer,
        log_ring: report.logRing ?? [],
        count,
    };
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Serialise + enforce the 32 KB (actual UTF-8 bytes, not UTF-16 code units)
 *  cap, dropping log-ring lines first (cheapest signal to lose) and then
 *  truncating the stack before giving up on the message itself. */
function serialiseCapped(wire: WireReport): string {
    let body = JSON.stringify(wire);
    if (byteLength(body) <= MAX_PAYLOAD_BYTES) return body;
    const trimmed: WireReport = { ...wire, log_ring: [] };
    body = JSON.stringify(trimmed);
    if (byteLength(body) <= MAX_PAYLOAD_BYTES) return body;
    const overshoot = byteLength(body) - MAX_PAYLOAD_BYTES;
    trimmed.stack = trimmed.stack.slice(0, Math.max(0, trimmed.stack.length - overshoot - 32)) + '…(truncated)';
    body = JSON.stringify(trimmed);
    if (byteLength(body) <= MAX_PAYLOAD_BYTES) return body;
    // Still oversized (a pathological message) — hard-truncate and accept
    // the server may still reject it; better than never sending.
    trimmed.message = trimmed.message.slice(0, 500);
    return JSON.stringify(trimmed);
}

function scheduleRetryDrain(): void {
    if (retryScheduled) return;
    retryScheduled = true;
    setTimeout(() => {
        retryScheduled = false;
        const body = retryQueue.shift();
        if (body) {
            void doSend(body, /*isRetry*/ true);
            if (retryQueue.length) scheduleRetryDrain();
        }
    }, RETRY_DELAY_MS);
}

async function doSend(body: string, isRetry = false): Promise<void> {
    if (!endpointBase) return;
    try {
        const resp = await fetch(`${endpointBase}/api/client-errors`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body,
            keepalive: true,
        });
        if (!resp.ok && !isRetry) throw new Error(`http ${resp.status}`);
    } catch {
        // E1: fire-and-forget with one retry; queue (cap 3) in memory only.
        if (isRetry) return;
        retryQueue.push(body);
        while (retryQueue.length > MAX_RETRY_QUEUE) retryQueue.shift();
        scheduleRetryDrain();
    }
}

function send(report: ClientErrorReport, hash: string, count: number): void {
    if (!withinRateCap(Date.now())) return;
    void doSend(serialiseCapped(buildWire(report, hash, count)));
}

/** Report a fatal/wedged/context-loss/injected client error. Dedups by a
 *  stack-shape hash for the lifetime of this realm (worker or main; each has
 *  its own session-scoped table — a crash-looping subsystem sends its first
 *  occurrence immediately, then at most one debounced recount update per
 *  minute while it keeps recurring — never one send per occurrence. */
export function reportClientError(report: ClientErrorReport): void {
    if (!enabled) return;
    const hash = hashReportKey(report.errorClass, report.message, report.stack ?? '');
    const existing = seen.get(hash);
    if (!existing) {
        seen.set(hash, { count: 1, timer: null, original: report });
        send(report, hash, 1);
        return;
    }
    existing.count++;
    existing.original = report;
    if (existing.timer) return;
    existing.timer = setTimeout(() => {
        existing.timer = null;
        send(existing.original, hash, existing.count);
    }, RECOUNT_DEBOUNCE_MS);
}

/** Test-only: drop all dedup/rate-limit state between vitest cases. */
export function resetErrorTelemetryForTests(): void {
    for (const e of seen.values()) if (e.timer) clearTimeout(e.timer);
    seen.clear();
    sendTimes.length = 0;
    retryQueue.length = 0;
    retryScheduled = false;
    endpointBase = '';
    authToken = '';
    enabled = true;
    buildStamp = '';
    gpuRenderer = '';
}
