/**
 * Browser-side log capture helper for scenario assertions.
 *
 * The spring-logserver (default `http://<host>:8010`) buffers every
 * NOTICE/WARN/ERROR/DEBUG line emitted by the lobby, every game
 * server, and the browser itself (the client POSTs its own errors
 * back via `log-ingest.ts`). Scenarios use this helper to snapshot
 * the current high-water-mark log id, run a piece of work, then
 * harvest every entry whose id > snapshot — i.e. every warning or
 * error caused by what they just did.
 *
 * The HTTP endpoint doesn't expose `since=` directly, so we fetch
 * the latest N entries and filter client-side. Bumping `limit` is
 * the cheap fix when a single test iteration emits more than the
 * default.
 */

const LOG_SERVER_URL = `http://${window.location.hostname || 'localhost'}:8010`;

export interface LogEntry {
    id: number;
    timestamp: number;
    /** 0=DEBUG, 2=NOTICE, 3=WARN, 4=ERROR */
    level: number;
    section: string;
    scope: string;
    process: string;
    frame: number;
    message: string;
}

export type LogLevel = 'DEBUG' | 'NOTICE' | 'WARN' | 'ERROR';

const LEVEL_TO_NUM: Record<LogLevel, number> = {
    DEBUG: 0, NOTICE: 2, WARN: 3, ERROR: 4,
};

/** Snapshot the current highest log id across the whole system.
 *  Use the returned id as `sinceId` in subsequent `fetchLogsSince`
 *  calls to get only what arrived after this point.
 *
 *  Implementation: the server returns entries in id ASC order, so we
 *  ask for a large page and take the max. `limit=1` would give us
 *  the OLDEST id (the buffer head), not the newest — which would
 *  pollute every subsequent diff with the whole boot log. */
export async function logHighWaterMark(): Promise<number> {
    const resp = await fetch(`${LOG_SERVER_URL}/api/logs/0?limit=2000&level=0`);
    if (!resp.ok) return 0;
    const data = await resp.json() as LogEntry[];
    let max = 0;
    for (const e of data) if (e.id > max) max = e.id;
    return max;
}

/** Fetch every log entry with id > `sinceId` at level >= `minLevel`.
 *  `limit` caps the number of entries returned by the server (default
 *  2000); the post-filter by id usually returns a small slice. */
export async function fetchLogsSince(
    sinceId: number,
    minLevel: LogLevel = 'WARN',
    limit = 2000,
): Promise<LogEntry[]> {
    const lvl = LEVEL_TO_NUM[minLevel];
    const resp = await fetch(
        `${LOG_SERVER_URL}/api/logs/0?level=${lvl}&limit=${limit}`,
    );
    if (!resp.ok) return [];
    const all = await resp.json() as LogEntry[];
    return all.filter((e) => e.id > sinceId);
}

/** Pretty-print a log entry as a single line for the report. */
export function formatLogEntry(e: LogEntry): string {
    const tag = e.level >= 4 ? 'ERROR' : e.level >= 3 ? 'WARN' : 'INFO';
    const where = e.scope ? `${e.section}:${e.scope}` : e.section;
    const msg = e.message.replace(/\s+/g, ' ').slice(0, 200);
    return `[${tag}] ${where} ${msg}`;
}
