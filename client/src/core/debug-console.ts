/**
 * Debug console — tabbed log viewer + command interface.
 *
 * Features:
 *   - Multiple tabs with independent scope, filters, history
 *   - Dock/undock: pop a tab out to its own window
 *   - Multi-line input (Shift+Enter for newlines, Enter to submit)
 *   - Programmatic API: debugConsole.exec(scope, code) for automation
 *   - Copy/paste: output is user-selectable, textarea supports clipboard
 *   - Log server WS for log streaming
 *   - Game server WS for command execution
 *
 * Toggle with backtick (`) or call debugConsole.show().
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
import { ConsoleCommand } from '../protocol/spring-web/console-command.js';
import { ConsoleResponse } from '../protocol/spring-web/console-response.js';
import { setNetInspectorEnabled } from './net-inspector.js';
import type { Scene } from '@babylonjs/core';

const LEVEL_NAMES = ['DEBUG', 'INFO', 'NOTICE', 'WARN', 'ERROR', 'FATAL'];
const LEVEL_CLASSES = ['debug', 'info', 'notice', 'warning', 'error', 'fatal'];
const MAX_LINES = 2000;
const SCOPE_OPTIONS = ['LuaRules', 'LuaGaia', 'server', 'lobby', 'sql'];

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

// ─── Tab state ───

interface ConsoleTab {
    id: number;
    label: string;
    scope: string;
    minLevel: number;
    sectionFilter: string;
    scopeFilter: string;
    searchFilter: string;
    history: string[];
    historyIndex: number;
    entries: LogEntry[];
    lineCount: number;
    autoScroll: boolean;

    // DOM (null when popped out)
    tabEl: HTMLElement | null;
    panelEl: HTMLElement | null;
    outputEl: HTMLElement | null;
    inputEl: HTMLTextAreaElement | null;
    promptEl: HTMLElement | null;
    scopeSelectEl: HTMLSelectElement | null;

    // Popout
    popoutWindow: Window | null;
}

// ─── Main class ───

export class DebugConsole {
    private container: HTMLElement | null = null;
    private tabListEl: HTMLElement | null = null;
    private panelsEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;

    private tabs: ConsoleTab[] = [];
    private activeTabId = -1;
    private nextTabId = 1;

    private ws: WebSocket | null = null;
    private logServerUrl = '';
    private visible = false;
    private gameChannel: WebSocket | RTCDataChannel | null = null;
    private scene: Scene | null = null;
    private nextRequestId = 1;

    // Pending exec() promises keyed by requestId
    private pendingExecs = new Map<number, (result: { success: boolean; output: string }) => void>();

    // All entries (shared across tabs for filtering)
    private globalEntries: LogEntry[] = [];

    constructor() {
        this.setupKeyboard();
    }

    // ─── Public API ───

    setLogServerUrl(url: string): void {
        this.logServerUrl = url;
        if (this.visible) this.connectLogServer();
    }

    setScene(scene: Scene): void { this.scene = scene; }

    /** Set game channel for command forwarding. Accepts WebSocket or RTCDataChannel. */
    setGameWs(channel: WebSocket | RTCDataChannel): void {
        this.gameChannel = channel;
        channel.addEventListener('message', ((evt: MessageEvent) => {
            if (!(evt.data instanceof ArrayBuffer)) return;
            this.handleGameMessage(new Uint8Array(evt.data));
        }) as EventListener);
    }

    /**
     * Programmatic command execution. Returns a promise that resolves
     * when the server responds. Use this from browser automation (Claude)
     * or other scripts — no DOM event simulation needed.
     *
     * Example:
     *   const r = await debugConsole.exec('server', 'frame');
     *   console.log(r.output); // "1234"
     */
    exec(scope: string, code: string): Promise<{ success: boolean; output: string }> {
        return new Promise((resolve, reject) => {
            if (!this.isChannelOpen()) {
                resolve({ success: false, output: 'Not connected to game server' });
                return;
            }
            const reqId = this.nextRequestId++;
            this.pendingExecs.set(reqId, resolve);

            this.sendConsoleCommand(scope, code, reqId);

            // Timeout after 10s
            setTimeout(() => {
                if (this.pendingExecs.has(reqId)) {
                    this.pendingExecs.delete(reqId);
                    resolve({ success: false, output: 'Timeout (10s)' });
                }
            }, 10000);
        });
    }

    init(): void {
        injectStyle('debug-console-style', css);

        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        const el = wrapper.firstElementChild as HTMLElement;
        document.body.appendChild(el);

        this.container = el;
        this.tabListEl = document.getElementById('debug-tab-list');
        this.panelsEl = document.getElementById('debug-tab-panels');
        this.statusEl = document.getElementById('debug-status');

        document.getElementById('debug-close-btn')?.addEventListener('click', () => this.hide());
        document.getElementById('debug-tab-add')?.addEventListener('click', () => {
            this.addTab();
        });

        const netToggle = document.getElementById('debug-net-toggle') as HTMLInputElement;
        netToggle?.addEventListener('change', () => setNetInspectorEnabled(netToggle.checked));

        // Create initial tab
        this.addTab('LuaRules');

        // Expose on window for automation
        (window as any).debugConsole = this;
    }

    toggle(): void { this.visible ? this.hide() : this.show(); }

    show(): void {
        if (!this.container) this.init();
        this.container!.classList.remove('hidden');
        this.visible = true;
        if (this.logServerUrl && !this.ws) this.connectLogServer();
        // Focus the active tab's input
        const tab = this.getTab(this.activeTabId);
        tab?.inputEl?.focus();
    }

    hide(): void {
        this.container?.classList.add('hidden');
        this.visible = false;
    }

    addEntry(entry: LogEntry): void {
        this.globalEntries.push(entry);
        if (this.globalEntries.length > MAX_LINES * 2) {
            this.globalEntries = this.globalEntries.slice(-MAX_LINES);
        }
        for (const tab of this.tabs) {
            if (this.tabPassesFilter(tab, entry)) {
                tab.entries.push(entry);
                this.appendLogLine(tab, entry);
            }
        }
    }

    async toggleInspector(): Promise<void> {
        if (!this.scene) return;
        if (this.scene.debugLayer.isVisible()) {
            this.scene.debugLayer.hide();
        } else {
            await this.scene.debugLayer.show({ embedMode: true });
        }
    }

    // ─── Tab management ───

    private addTab(scope = 'LuaRules'): ConsoleTab {
        const id = this.nextTabId++;
        const tab: ConsoleTab = {
            id, label: scope, scope,
            minLevel: 2, sectionFilter: '', scopeFilter: '', searchFilter: '',
            history: [], historyIndex: -1,
            entries: [], lineCount: 0, autoScroll: true,
            tabEl: null, panelEl: null, outputEl: null,
            inputEl: null, promptEl: null, scopeSelectEl: null,
            popoutWindow: null,
        };
        this.tabs.push(tab);
        this.buildTabDOM(tab);
        this.activateTab(id);
        return tab;
    }

    private removeTab(id: number): void {
        const tab = this.getTab(id);
        if (!tab) return;

        // Close popout if open
        if (tab.popoutWindow && !tab.popoutWindow.closed) {
            tab.popoutWindow.close();
        }

        tab.tabEl?.remove();
        tab.panelEl?.remove();
        this.tabs = this.tabs.filter(t => t.id !== id);

        if (this.tabs.length === 0) {
            this.hide();
            return;
        }
        if (this.activeTabId === id) {
            this.activateTab(this.tabs[this.tabs.length - 1].id);
        }
    }

    private activateTab(id: number): void {
        this.activeTabId = id;
        for (const tab of this.tabs) {
            const isActive = tab.id === id;
            tab.tabEl?.classList.toggle('active', isActive);
            tab.panelEl?.classList.toggle('active', isActive);
        }
    }

    private getTab(id: number): ConsoleTab | undefined {
        return this.tabs.find(t => t.id === id);
    }

    // ─── Tab DOM construction ───

    private buildTabDOM(tab: ConsoleTab): void {
        if (!this.tabListEl || !this.panelsEl) return;

        // Tab button
        const tabEl = document.createElement('div');
        tabEl.className = 'debug-tab';
        tabEl.innerHTML = `
            <span class="tab-label">${tab.scope}</span>
            <span class="tab-undock" title="Pop out to window">&#x2197;</span>
            <span class="tab-close" title="Close tab">&times;</span>
        `;
        tabEl.querySelector('.tab-label')!.addEventListener('click', () => this.activateTab(tab.id));
        tabEl.querySelector('.tab-close')!.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeTab(tab.id);
        });
        tabEl.querySelector('.tab-undock')!.addEventListener('click', (e) => {
            e.stopPropagation();
            this.undockTab(tab.id);
        });
        tab.tabEl = tabEl;
        this.tabListEl.appendChild(tabEl);

        // Panel
        const panel = document.createElement('div');
        panel.className = 'debug-tab-panel';
        panel.innerHTML = this.buildPanelHTML(tab.id);
        tab.panelEl = panel;
        this.panelsEl.appendChild(panel);

        // Cache DOM refs
        tab.outputEl = panel.querySelector('.debug-panel-output');
        tab.inputEl = panel.querySelector('textarea');
        tab.promptEl = panel.querySelector('.debug-prompt');
        tab.scopeSelectEl = panel.querySelector('.panel-scope-select');

        // Wire panel events
        this.wirePanelEvents(tab);
    }

    private buildPanelHTML(tabId: number): string {
        const scopeOpts = SCOPE_OPTIONS.map(s =>
            `<option value="${s}">${s}</option>`
        ).join('');

        return `
            <div class="debug-panel-header">
                <select class="panel-level-filter" title="Min log level">
                    <option value="0">DEBUG</option>
                    <option value="1">INFO</option>
                    <option value="2" selected>NOTICE</option>
                    <option value="3">WARN</option>
                    <option value="4">ERROR</option>
                    <option value="5">FATAL</option>
                </select>
                <input class="panel-section-filter" type="text" placeholder="section" title="Filter by section" />
                <input class="panel-scope-filter" type="text" placeholder="scope" title="Filter by scope" />
                <input class="panel-search-filter" type="text" placeholder="search..." title="Search" />
                <button class="panel-clear-btn" title="Clear output">Clear</button>
            </div>
            <div class="debug-panel-output"></div>
            <div class="debug-panel-input">
                <select class="panel-scope-select" title="Execution scope">${scopeOpts}</select>
                <span class="debug-prompt">LuaRules&gt;</span>
                <textarea rows="1" placeholder="Enter command... (Shift+Enter for newline)" spellcheck="false"></textarea>
                <span class="debug-input-hint">Enter: run | Shift+Enter: newline</span>
            </div>
        `;
    }

    private wirePanelEvents(tab: ConsoleTab): void {
        const panel = tab.panelEl!;

        // Level filter
        const levelFilter = panel.querySelector('.panel-level-filter') as HTMLSelectElement;
        levelFilter?.addEventListener('change', () => {
            tab.minLevel = parseInt(levelFilter.value, 10);
            this.rerenderTab(tab);
        });

        // Section filter
        const sectionInput = panel.querySelector('.panel-section-filter') as HTMLInputElement;
        sectionInput?.addEventListener('input', () => {
            tab.sectionFilter = sectionInput.value.trim().toLowerCase();
            this.rerenderTab(tab);
        });

        // Scope filter
        const scopeInput = panel.querySelector('.panel-scope-filter') as HTMLInputElement;
        scopeInput?.addEventListener('input', () => {
            tab.scopeFilter = scopeInput.value.trim().toLowerCase();
            this.rerenderTab(tab);
        });

        // Search filter
        const searchInput = panel.querySelector('.panel-search-filter') as HTMLInputElement;
        searchInput?.addEventListener('input', () => {
            tab.searchFilter = searchInput.value.trim().toLowerCase();
            this.rerenderTab(tab);
        });

        // Clear
        panel.querySelector('.panel-clear-btn')?.addEventListener('click', () => {
            tab.entries = [];
            if (tab.outputEl) { tab.outputEl.innerHTML = ''; tab.lineCount = 0; }
        });

        // Scope selector
        tab.scopeSelectEl?.addEventListener('change', () => {
            tab.scope = tab.scopeSelectEl!.value;
            tab.label = tab.scope;
            if (tab.promptEl) tab.promptEl.textContent = `${tab.scope}>`;
            // Update tab button label
            const labelEl = tab.tabEl?.querySelector('.tab-label');
            if (labelEl) labelEl.textContent = tab.scope;
        });

        // Multi-line textarea input
        if (tab.inputEl) {
            tab.inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const code = tab.inputEl!.value.trim();
                    if (code) {
                        this.executeInTab(tab, code);
                        tab.inputEl!.value = '';
                        this.autoSizeTextarea(tab.inputEl!);
                    }
                } else if (e.key === 'ArrowUp' && !e.shiftKey && tab.inputEl!.value === '') {
                    e.preventDefault();
                    if (tab.historyIndex < tab.history.length - 1) {
                        tab.historyIndex++;
                        tab.inputEl!.value = tab.history[tab.history.length - 1 - tab.historyIndex];
                        this.autoSizeTextarea(tab.inputEl!);
                    }
                } else if (e.key === 'ArrowDown' && !e.shiftKey && tab.inputEl!.value === '') {
                    e.preventDefault();
                    if (tab.historyIndex > 0) {
                        tab.historyIndex--;
                        tab.inputEl!.value = tab.history[tab.history.length - 1 - tab.historyIndex];
                    } else {
                        tab.historyIndex = -1;
                        tab.inputEl!.value = '';
                    }
                    this.autoSizeTextarea(tab.inputEl!);
                }
            });

            // Auto-resize textarea as user types
            tab.inputEl.addEventListener('input', () => {
                this.autoSizeTextarea(tab.inputEl!);
            });
        }

        // Auto-scroll pause
        tab.outputEl?.addEventListener('scroll', () => {
            if (!tab.outputEl) return;
            const { scrollTop, scrollHeight, clientHeight } = tab.outputEl;
            tab.autoScroll = scrollTop + clientHeight >= scrollHeight - 20;
        });
    }

    private autoSizeTextarea(el: HTMLTextAreaElement): void {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    // ─── Undock / popout ───

    private undockTab(tabId: number): void {
        const tab = this.getTab(tabId);
        if (!tab) return;

        // If already popped out, focus existing window
        if (tab.popoutWindow && !tab.popoutWindow.closed) {
            tab.popoutWindow.focus();
            return;
        }

        const popup = window.open('', `debug-tab-${tabId}`,
            'width=700,height=500,menubar=no,toolbar=no,location=no,status=no');
        if (!popup) return;

        tab.popoutWindow = popup;

        // Build standalone popout HTML
        popup.document.write(`<!DOCTYPE html>
<html><head><title>Debug: ${tab.scope}</title>
<style>${css}
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
body { background: #0f0f14; }
.debug-tab-panel { display: flex !important; height: 100vh; }
</style></head>
<body class="debug-popout-body"></body></html>`);
        popup.document.close();

        // Move the panel DOM into the popup
        const panelClone = tab.panelEl!.cloneNode(true) as HTMLElement;
        panelClone.classList.add('active');
        popup.document.body.appendChild(panelClone);

        // Re-cache DOM refs to the popout elements
        const oldOutput = tab.outputEl;
        tab.outputEl = panelClone.querySelector('.debug-panel-output');
        tab.inputEl = panelClone.querySelector('textarea');
        tab.promptEl = panelClone.querySelector('.debug-prompt');
        tab.scopeSelectEl = panelClone.querySelector('.panel-scope-select');

        // Copy output content
        if (oldOutput && tab.outputEl) {
            tab.outputEl.innerHTML = oldOutput.innerHTML;
        }

        // Set scope selector to current
        if (tab.scopeSelectEl) tab.scopeSelectEl.value = tab.scope;
        if (tab.promptEl) tab.promptEl.textContent = `${tab.scope}>`;

        // Re-wire events in the new DOM
        tab.panelEl = panelClone;
        this.wirePanelEvents(tab);

        // Hide from main console
        const mainTabEl = this.tabListEl?.querySelector(`.debug-tab:nth-child(${this.tabs.indexOf(tab) + 1})`);
        // Mark tab as undocked visually
        tab.tabEl?.classList.add('undocked');

        // When popup closes, re-dock
        popup.addEventListener('beforeunload', () => {
            this.redockTab(tab);
        });

        tab.inputEl?.focus();
    }

    private redockTab(tab: ConsoleTab): void {
        tab.popoutWindow = null;
        tab.tabEl?.classList.remove('undocked');

        // Rebuild the panel in the main console
        const oldPanel = this.panelsEl?.querySelector(`.debug-tab-panel:nth-child(${this.tabs.indexOf(tab) + 1})`);
        if (oldPanel) oldPanel.remove();

        const panel = document.createElement('div');
        panel.className = 'debug-tab-panel' + (tab.id === this.activeTabId ? ' active' : '');
        panel.innerHTML = this.buildPanelHTML(tab.id);
        tab.panelEl = panel;
        this.panelsEl?.appendChild(panel);

        // Re-cache refs
        tab.outputEl = panel.querySelector('.debug-panel-output');
        tab.inputEl = panel.querySelector('textarea');
        tab.promptEl = panel.querySelector('.debug-prompt');
        tab.scopeSelectEl = panel.querySelector('.panel-scope-select');

        if (tab.scopeSelectEl) tab.scopeSelectEl.value = tab.scope;
        if (tab.promptEl) tab.promptEl.textContent = `${tab.scope}>`;

        this.wirePanelEvents(tab);
        this.rerenderTab(tab);
    }

    // ─── Command execution ───

    private executeInTab(tab: ConsoleTab, cmd: string): void {
        // Meta-commands
        if (cmd.startsWith('/connect ')) {
            tab.scope = cmd.slice(9).trim();
            tab.label = tab.scope;
            if (tab.scopeSelectEl) tab.scopeSelectEl.value = tab.scope;
            if (tab.promptEl) tab.promptEl.textContent = `${tab.scope}>`;
            const labelEl = tab.tabEl?.querySelector('.tab-label');
            if (labelEl) labelEl.textContent = tab.scope;
            this.appendText(tab, `Switched to ${tab.scope}`);
            return;
        }
        if (cmd === '/clear') {
            tab.entries = [];
            if (tab.outputEl) { tab.outputEl.innerHTML = ''; tab.lineCount = 0; }
            return;
        }
        if (cmd === '/inspector') { this.toggleInspector(); return; }
        if (cmd === '/scopes') {
            this.appendText(tab, `Available scopes: ${SCOPE_OPTIONS.join(', ')}`);
            return;
        }
        if (cmd === '/help') {
            this.appendText(tab, [
                '/connect <scope>  — switch scope',
                '/scopes           — list scopes',
                '/clear            — clear output',
                '/inspector        — toggle Babylon.js inspector',
                '/help             — this message',
                '',
                'Enter: execute | Shift+Enter: newline',
                'Up/Down: history (when input is empty)',
            ].join('\n'));
            return;
        }

        tab.history.push(cmd);
        tab.historyIndex = -1;

        // Show input (truncate display for very long multi-line)
        const displayCmd = cmd.includes('\n') ? cmd.split('\n')[0] + '...' : cmd;
        this.appendText(tab, `${tab.scope}> ${displayCmd}`, 'exec-input');

        if (!this.isChannelOpen()) {
            this.appendText(tab, 'Not connected to game server', 'exec-error');
            return;
        }

        const reqId = this.nextRequestId++;
        // Route response to this tab
        this.pendingExecs.set(reqId, (result) => {
            const cls = result.success ? 'exec-output' : 'exec-error';
            this.appendText(tab, result.output, cls);
        });

        this.sendConsoleCommand(tab.scope, cmd, reqId);
    }

    private sendConsoleCommand(scope: string, code: string, requestId: number): void {
        if (!this.isChannelOpen()) return;

        const builder = new flatbuffers.Builder(256 + code.length);
        const scopeOff = builder.createString(scope);
        const cmdOff = builder.createString(code);
        const cc = ConsoleCommand.createConsoleCommand(builder, scopeOff, cmdOff, requestId);
        const payload = ClientMessage.createClientMessage(builder, ClientPayload.ConsoleCommand, cc);
        builder.finish(payload);

        const fbBytes = builder.asUint8Array();
        const frame = new Uint8Array(1 + fbBytes.length);
        frame[0] = 0x01;
        frame.set(fbBytes, 1);
        this.gameChannel!.send(frame.buffer);
    }

    // ─── Message handling ───

    private handleGameMessage(data: Uint8Array): void {
        if (data.length < 2 || data[0] !== 0x01) return;

        const buf = new flatbuffers.ByteBuffer(data.slice(1));
        const msg = ServerMessage.getRootAsServerMessage(buf);
        if (!msg || msg.payloadType() !== ServerPayload.ConsoleResponse) return;

        const resp = msg.payload(new ConsoleResponse()) as ConsoleResponse;
        if (!resp) return;

        const reqId = resp.requestId();
        const result = { success: resp.success(), output: resp.output() ?? '' };

        const handler = this.pendingExecs.get(reqId);
        if (handler) {
            this.pendingExecs.delete(reqId);
            handler(result);
        }
    }

    // ─── DOM helpers ───

    private appendText(tab: ConsoleTab, text: string, cls = ''): void {
        if (!tab.outputEl) return;
        const div = document.createElement('div');
        div.className = `debug-line ${cls}`;
        div.textContent = text;
        tab.outputEl.appendChild(div);
        tab.lineCount++;
        while (tab.lineCount > MAX_LINES && tab.outputEl.firstChild) {
            tab.outputEl.removeChild(tab.outputEl.firstChild);
            tab.lineCount--;
        }
        if (tab.autoScroll) tab.outputEl.scrollTop = tab.outputEl.scrollHeight;
    }

    private appendLogLine(tab: ConsoleTab, entry: LogEntry): void {
        if (!tab.outputEl) return;
        const div = document.createElement('div');
        const levelClass = LEVEL_CLASSES[entry.level] ?? 'info';
        div.className = `debug-line level-${levelClass}`;

        const frameStr = entry.frame > 0 ? `[${entry.frame}] ` : '';
        const scopeStr = entry.scope ? `:${entry.scope}` : '';

        div.innerHTML =
            `<span class="frame">${frameStr}</span>` +
            `<span class="process">[${this.esc(entry.process)}:</span>` +
            `<span class="section">${this.esc(entry.section)}</span>` +
            `<span class="scope">${this.esc(scopeStr)}]</span> ` +
            `<span class="msg">${this.esc(entry.message)}</span>`;

        tab.outputEl.appendChild(div);
        tab.lineCount++;
        while (tab.lineCount > MAX_LINES && tab.outputEl.firstChild) {
            tab.outputEl.removeChild(tab.outputEl.firstChild);
            tab.lineCount--;
        }
        if (tab.autoScroll) tab.outputEl.scrollTop = tab.outputEl.scrollHeight;
    }

    private tabPassesFilter(tab: ConsoleTab, entry: LogEntry): boolean {
        if (entry.level < tab.minLevel) return false;
        if (tab.sectionFilter && !entry.section.toLowerCase().includes(tab.sectionFilter)) return false;
        if (tab.scopeFilter && !entry.scope.toLowerCase().includes(tab.scopeFilter)) return false;
        if (tab.searchFilter && !entry.message.toLowerCase().includes(tab.searchFilter)) return false;
        return true;
    }

    private rerenderTab(tab: ConsoleTab): void {
        if (!tab.outputEl) return;
        tab.outputEl.innerHTML = '';
        tab.lineCount = 0;
        tab.entries = this.globalEntries.filter(e => this.tabPassesFilter(tab, e));
        for (const entry of tab.entries) {
            this.appendLogLine(tab, entry);
        }
    }

    // ─── Log server connection ───

    private connectLogServer(): void {
        if (!this.logServerUrl) return;
        if (this.ws) { this.ws.close(); this.ws = null; }

        const wsUrl = this.logServerUrl.replace(/^http/, 'ws');
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.setStatus(true);
            this.sendLogSubscribe();
        };
        this.ws.onmessage = (evt) => {
            if (!(evt.data instanceof ArrayBuffer)) return;
            this.handleLogMessage(new Uint8Array(evt.data));
        };
        this.ws.onclose = () => {
            this.setStatus(false);
            this.ws = null;
            setTimeout(() => {
                if (this.visible && this.logServerUrl) this.connectLogServer();
            }, 3000);
        };
        this.ws.onerror = () => {};
    }

    private sendLogSubscribe(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const builder = new flatbuffers.Builder(128);
        const sub = LogSubscribe.createLogSubscribe(builder, 0, 0, 0, 0);
        const payload = ClientMessage.createClientMessage(builder, ClientPayload.LogSubscribe, sub);
        builder.finish(payload);
        const fbBytes = builder.asUint8Array();
        const frame = new Uint8Array(1 + fbBytes.length);
        frame[0] = 0x01;
        frame.set(fbBytes, 1);
        this.ws.send(frame.buffer);
    }

    private handleLogMessage(data: Uint8Array): void {
        if (data.length < 2 || data[0] !== 0x01) return;
        const buf = new flatbuffers.ByteBuffer(data.slice(1));
        const msg = ServerMessage.getRootAsServerMessage(buf);
        if (!msg || msg.payloadType() !== ServerPayload.LogBatch) return;

        const batch = msg.payload(new LogBatch()) as LogBatch;
        if (!batch) return;
        for (let i = 0; i < batch.entriesLength(); i++) {
            const e = batch.entries(i);
            if (!e) continue;
            this.addEntry({
                id: Number(e.id()), timestamp: Number(e.timestamp()),
                level: e.level(), section: e.section() ?? '',
                scope: e.scope() ?? '', process: e.process() ?? '',
                message: e.message() ?? '', frame: e.frame(),
            });
        }
    }

    private setStatus(connected: boolean): void {
        if (!this.statusEl) return;
        this.statusEl.className = `debug-status ${connected ? 'connected' : 'disconnected'}`;
        this.statusEl.title = connected ? 'Connected to log server' : 'Disconnected';
    }

    // ─── Keyboard ───

    private setupKeyboard(): void {
        window.addEventListener('keydown', (e) => {
            if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                e.preventDefault();
                this.toggle();
            }
            if (e.key === 'F12' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                this.toggleInspector();
            }
        });
    }

    private isChannelOpen(): boolean {
        if (!this.gameChannel) return false;
        if (this.gameChannel instanceof WebSocket) return this.gameChannel.readyState === WebSocket.OPEN;
        return this.gameChannel.readyState === 'open';
    }

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
               .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

/** Singleton instance */
export const debugConsole = new DebugConsole();
