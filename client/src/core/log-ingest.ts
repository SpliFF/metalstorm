/**
 * Client-side log ingestion — forwards browser-side logs and errors to the
 * spring-logserver via POST /api/logs/ingest. Once entries reach the log
 * server they land in debug.db / the SSE stream / the log ring buffer, so
 * they're discoverable via spring-debug MCP, the in-game console, and any
 * other consumer of the unified log pipeline.
 *
 * Sources we capture:
 *   - LuaUI worker messages (level 3+ = warning or error)
 *   - window.onerror (uncaught script errors)
 *   - window.onunhandledrejection (unhandled promise rejections)
 *   - console.error / console.warn (preserved chain to original implementations)
 *
 * Entries are batched and flushed every 500ms (or immediately when the
 * batch hits a soft cap) to keep traffic light. Failed POSTs drop the
 * batch silently — log loss is preferable to runaway retries that
 * compete with gameplay traffic.
 */

const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH_SIZE = 50;
const MAX_QUEUE_SIZE = 500;
const MAX_MESSAGE_LENGTH = 4096;

export type LogLevel = 0 | 1 | 2 | 3 | 4 | 5; // matches SPRING_LOG_*

export interface ClientLogEntry {
    level: LogLevel;
    section?: string;
    scope?: string;
    process?: string;
    message: string;
    frame?: number;
}

class LogIngest {
    private endpoint = '';
    private queue: ClientLogEntry[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private process = 'browser';
    private installed = false;
    /** Suppress recursion when our forwarders themselves call console.* */
    private inForwarder = false;

    /** Set the base URL for the log server (e.g. "http://localhost:8010"). */
    setEndpoint(baseUrl: string): void {
        if (!baseUrl) return;
        this.endpoint = baseUrl.replace(/\/$/, '') + '/api/logs/ingest';
    }

    /** Identify this client in log entries — useful when multiple tabs run. */
    setProcessName(name: string): void {
        this.process = name;
    }

    /** Install global hooks once. Safe to call repeatedly. */
    install(): void {
        if (this.installed) return;
        this.installed = true;

        // Default endpoint for dev: same host, log server port 8010. The
        // caller can override with setEndpoint() if the log server is
        // hosted elsewhere.
        if (!this.endpoint) {
            const host = (typeof window !== 'undefined' && window.location.hostname) || 'localhost';
            this.setEndpoint(`http://${host}:8010`);
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('error', (e) => {
                const msg = e.error?.stack
                    ? `${e.message}\n${e.error.stack}`
                    : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`;
                this.push({ level: 4, section: 'browser', scope: 'window.onerror', message: msg });
            });

            window.addEventListener('unhandledrejection', (e) => {
                const reason = e.reason;
                let msg: string;
                if (reason instanceof Error) {
                    msg = reason.stack ? `${reason.message}\n${reason.stack}` : reason.message;
                } else {
                    try { msg = typeof reason === 'string' ? reason : JSON.stringify(reason); }
                    catch { msg = String(reason); }
                }
                this.push({ level: 4, section: 'browser', scope: 'unhandledrejection', message: msg });
            });
        }

        // Wrap console.error and console.warn so any direct console use
        // (third-party libs, ad-hoc logging during development) ends up
        // in the unified log pipeline. We chain to the original so devs
        // still see the formatted output in the browser console.
        const origError = console.error.bind(console);
        const origWarn = console.warn.bind(console);
        console.error = (...args: unknown[]) => {
            origError(...args);
            if (this.inForwarder) return;
            this.push({ level: 4, section: 'browser', scope: 'console.error', message: this.format(args) });
        };
        console.warn = (...args: unknown[]) => {
            origWarn(...args);
            if (this.inForwarder) return;
            this.push({ level: 3, section: 'browser', scope: 'console.warn', message: this.format(args) });
        };
    }

    /** Queue a log entry for ingestion. Drops silently if queue is full. */
    push(entry: ClientLogEntry): void {
        if (this.queue.length >= MAX_QUEUE_SIZE) return;
        const e: ClientLogEntry = { ...entry, process: entry.process ?? this.process };
        if (e.message.length > MAX_MESSAGE_LENGTH) {
            e.message = e.message.substring(0, MAX_MESSAGE_LENGTH) + '…(truncated)';
        }
        this.queue.push(e);
        if (this.queue.length >= MAX_BATCH_SIZE) {
            this.flush();
        } else {
            this.scheduleFlush();
        }
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_INTERVAL_MS);
    }

    private flush(): void {
        if (!this.endpoint || this.queue.length === 0) return;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const entries = this.queue.splice(0, MAX_BATCH_SIZE);
        const body = JSON.stringify({ entries });
        // fetch with keepalive so flushes during page-unload still go out.
        // The response is intentionally ignored — log loss is cheaper than
        // blocking the game on log delivery.
        this.inForwarder = true;
        try {
            void fetch(this.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            }).catch(() => { /* swallow — see comment above */ });
        } finally {
            this.inForwarder = false;
        }
    }

    private format(args: unknown[]): string {
        return args.map((a) => {
            if (a instanceof Error) {
                return a.stack ? `${a.message}\n${a.stack}` : a.message;
            }
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
    }
}

export const logIngest = new LogIngest();
