/**
 * Debug console — log viewer + command interface.
 *
 * Connects directly to the log server (URL received from the lobby)
 * for log streaming, independent of the lobby WebSocket. Survives
 * lobby restarts.
 *
 * Toggle with backtick (`) key or HUD button.
 */

import { injectStyle } from '../ui/ui';
import html from '../ui/debug-console/debug-console.html?raw';
import css from '../ui/debug-console/debug-console.css?raw';

import * as flatbuffers from 'flatbuffers';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { LogBatch } from '../protocol/spring-web/log-batch.js';
import { LogSubscribe } from '../protocol/spring-web/log-subscribe.js';
import { ClientMessage } from '../protocol/spring-web/client-message.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';

const LEVEL_NAMES = ['DEBUG', 'INFO', 'NOTICE', 'WARN', 'ERROR', 'FATAL'];
const LEVEL_CLASSES = ['debug', 'info', 'notice', 'warning', 'error', 'fatal'];
const MAX_LINES = 2000;

interface LogEntry {
    id: number;
    timestamp: number;
    level: number;
    section: string;
    scope: string;
    process: string;
    message: string;
    frame: number;
}

export class DebugConsole {
    private container: HTMLElement | null = null;
    private output: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private ws: WebSocket | null = null;
    private logServerUrl: string = '';
    private visible = false;
    private autoScroll = true;
    private entries: LogEntry[] = [];
    private lineCount = 0;

    // Filters
    private minLevel = 2; // NOTICE
    private sectionFilter = '';
    private scopeFilter = '';
    private searchFilter = '';

    constructor() {
        this.setupKeyboard();
    }

    /** Set the log server URL (called when lobby sends it) */
    setLogServerUrl(url: string): void {
        this.logServerUrl = url;
        if (this.visible) this.connect();
    }

    /** Inject DOM and wire events */
    init(): void {
        injectStyle('debug-console-style', css);

        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        const el = wrapper.firstElementChild as HTMLElement;
        document.body.appendChild(el);

        this.container = el;
        this.output = document.getElementById('debug-console-output');
        this.statusEl = document.getElementById('debug-status');

        // Wire controls
        document.getElementById('debug-close-btn')?.addEventListener('click', () => this.hide());
        document.getElementById('debug-clear-btn')?.addEventListener('click', () => this.clear());

        // Filters
        const levelFilter = document.getElementById('debug-level-filter') as HTMLSelectElement;
        levelFilter?.addEventListener('change', () => {
            this.minLevel = parseInt(levelFilter.value, 10);
            this.rerender();
        });

        const sectionInput = document.getElementById('debug-section-filter') as HTMLInputElement;
        sectionInput?.addEventListener('input', () => {
            this.sectionFilter = sectionInput.value.trim().toLowerCase();
            this.rerender();
        });

        const scopeInput = document.getElementById('debug-scope-filter') as HTMLInputElement;
        scopeInput?.addEventListener('input', () => {
            this.scopeFilter = scopeInput.value.trim().toLowerCase();
            this.rerender();
        });

        const searchInput = document.getElementById('debug-search-filter') as HTMLInputElement;
        searchInput?.addEventListener('input', () => {
            this.searchFilter = searchInput.value.trim().toLowerCase();
            this.rerender();
        });

        // Auto-scroll pause on user scroll up
        this.output?.addEventListener('scroll', () => {
            if (!this.output) return;
            const { scrollTop, scrollHeight, clientHeight } = this.output;
            this.autoScroll = scrollTop + clientHeight >= scrollHeight - 20;
        });
    }

    toggle(): void {
        this.visible ? this.hide() : this.show();
    }

    show(): void {
        if (!this.container) this.init();
        this.container?.classList.remove('hidden');
        this.visible = true;
        if (this.logServerUrl && !this.ws) this.connect();
    }

    hide(): void {
        this.container?.classList.add('hidden');
        this.visible = false;
    }

    /** Add a log entry from any source (local or remote) */
    addEntry(entry: LogEntry): void {
        this.entries.push(entry);
        if (this.entries.length > MAX_LINES * 2) {
            this.entries = this.entries.slice(-MAX_LINES);
        }
        if (this.passesFilter(entry)) {
            this.appendLine(entry);
        }
    }

    /** Connect to the log server WebSocket */
    private connect(): void {
        if (!this.logServerUrl) return;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        const wsUrl = this.logServerUrl.replace(/^http/, 'ws');
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.setStatus(true);
            // Subscribe to all logs
            this.sendSubscribe();
        };

        this.ws.onmessage = (evt) => {
            if (!(evt.data instanceof ArrayBuffer)) return;
            this.handleMessage(new Uint8Array(evt.data));
        };

        this.ws.onclose = () => {
            this.setStatus(false);
            this.ws = null;
            // Reconnect after delay
            setTimeout(() => {
                if (this.visible && this.logServerUrl) this.connect();
            }, 3000);
        };

        this.ws.onerror = () => {
            // onclose will fire after this
        };
    }

    private sendSubscribe(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const builder = new flatbuffers.Builder(128);
        const sub = LogSubscribe.createLogSubscribe(builder, 0, 0, 0, 0);
        const payload = ClientMessage.createClientMessage(
            builder,
            ClientPayload.LogSubscribe,
            sub,
        );
        builder.finish(payload);

        const fbBytes = builder.asUint8Array();
        const frame = new Uint8Array(1 + fbBytes.length);
        frame[0] = 0x01; // FlatBuffers envelope
        frame.set(fbBytes, 1);
        this.ws.send(frame.buffer);
    }

    private handleMessage(data: Uint8Array): void {
        if (data.length < 2 || data[0] !== 0x01) return;

        const buf = new flatbuffers.ByteBuffer(data.slice(1));
        const msg = ServerMessage.getRootAsServerMessage(buf);
        if (!msg) return;

        if (msg.payloadType() === ServerPayload.LogBatch) {
            const batch = msg.payload(new LogBatch()) as LogBatch;
            if (!batch) return;

            for (let i = 0; i < batch.entriesLength(); i++) {
                const e = batch.entries(i);
                if (!e) continue;
                this.addEntry({
                    id: Number(e.id()),
                    timestamp: Number(e.timestamp()),
                    level: e.level(),
                    section: e.section() ?? '',
                    scope: e.scope() ?? '',
                    process: e.process() ?? '',
                    message: e.message() ?? '',
                    frame: e.frame(),
                });
            }
        }
    }

    private passesFilter(entry: LogEntry): boolean {
        if (entry.level < this.minLevel) return false;
        if (this.sectionFilter && !entry.section.toLowerCase().includes(this.sectionFilter)) return false;
        if (this.scopeFilter && !entry.scope.toLowerCase().includes(this.scopeFilter)) return false;
        if (this.searchFilter && !entry.message.toLowerCase().includes(this.searchFilter)) return false;
        return true;
    }

    private appendLine(entry: LogEntry): void {
        if (!this.output) return;

        const div = document.createElement('div');
        const levelClass = LEVEL_CLASSES[entry.level] ?? 'info';
        div.className = `debug-line level-${levelClass}`;

        const levelStr = LEVEL_NAMES[entry.level] ?? '???';
        const frameStr = entry.frame > 0 ? `[${entry.frame}] ` : '';
        const scopeStr = entry.scope ? `:${entry.scope}` : '';

        div.innerHTML =
            `<span class="frame">${frameStr}</span>` +
            `<span class="process">[${this.escapeHtml(entry.process)}:</span>` +
            `<span class="section">${this.escapeHtml(entry.section)}</span>` +
            `<span class="scope">${this.escapeHtml(scopeStr)}]</span> ` +
            `<span class="msg">${this.escapeHtml(entry.message)}</span>`;

        this.output.appendChild(div);
        this.lineCount++;

        // Trim old lines
        while (this.lineCount > MAX_LINES && this.output.firstChild) {
            this.output.removeChild(this.output.firstChild);
            this.lineCount--;
        }

        if (this.autoScroll) {
            this.output.scrollTop = this.output.scrollHeight;
        }
    }

    private rerender(): void {
        if (!this.output) return;
        this.output.innerHTML = '';
        this.lineCount = 0;
        for (const entry of this.entries) {
            if (this.passesFilter(entry)) {
                this.appendLine(entry);
            }
        }
    }

    private clear(): void {
        this.entries = [];
        if (this.output) {
            this.output.innerHTML = '';
            this.lineCount = 0;
        }
    }

    private setStatus(connected: boolean): void {
        if (!this.statusEl) return;
        this.statusEl.className = `debug-status ${connected ? 'connected' : 'disconnected'}`;
        this.statusEl.title = connected ? 'Connected to log server' : 'Disconnected';
    }

    private setupKeyboard(): void {
        window.addEventListener('keydown', (e) => {
            if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                // Don't toggle if user is typing in an input
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                e.preventDefault();
                this.toggle();
            }
        });
    }

    private escapeHtml(s: string): string {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}

/** Singleton instance */
export const debugConsole = new DebugConsole();
