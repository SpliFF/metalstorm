/**
 * Debug console — tabbed log viewer + command interface.
 *
 * Features:
 *   - Multiple tabs with independent scope, filters, history
 *   - Dock/undock: pop a tab out to its own window
 *   - Multi-line input (Shift+Enter for newlines, Enter to submit)
 *   - Programmatic API: debugConsole.exec(scope, code) for automation
 *   - Copy/paste: output is user-selectable, textarea supports clipboard
 *   - HTTP polling for log streaming
 *   - WebTransport control stream for command execution (via GameLink)
 *
 * Toggle with backtick (`) or call debugConsole.show().
 */

import { injectStyle } from '../ui/ui';
import html from '../ui/debug-console/debug-console.html?raw';
import css from '../ui/debug-console/debug-console.css?raw';

import * as flatbuffers from 'flatbuffers';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { ClientMessage } from '../protocol/spring-web/client-message.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { ConsoleCommand } from '../protocol/spring-web/console-command.js';
import { ConsoleResponse } from '../protocol/spring-web/console-response.js';
import { setNetInspectorEnabled, setNetLogSink } from './net-inspector.js';
import type { Scene } from '@babylonjs/core';

/** Transport-agnostic link to the game server's control channel. */
export interface GameLink {
    /** Send a pre-framed (envelope + payload) message on the control tier. */
    send(data: Uint8Array): void;
    /** Whether the control channel is currently usable. */
    isOpen(): boolean;
}

const LEVEL_NAMES = ['DEBUG', 'INFO', 'NOTICE', 'WARN', 'ERROR', 'FATAL'];
const LEVEL_CLASSES = ['debug', 'info', 'notice', 'warning', 'error', 'fatal'];
const MAX_LINES = 2000;
const SCOPE_OPTIONS = ['LuaRules', 'LuaGaia', 'LuaUI', 'server', 'lobby', 'sql'];

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

    // Console pane state
    history: string[];
    historyIndex: number;
    consoleLineCount: number;

    // Log pane filter state
    minLevel: number;
    searchFilter: string;
    // Toggle-based source filtering: empty set = show all
    hiddenSources: Set<string>; // "process:section" or "scope:X" keys to HIDE
    entries: LogEntry[];
    logLineCount: number;
    logAutoScroll: boolean;

    // DOM refs
    tabEl: HTMLElement | null;
    panelEl: HTMLElement | null;
    // Console pane
    consoleOutputEl: HTMLElement | null;
    inputEl: HTMLTextAreaElement | null;
    promptEl: HTMLElement | null;
    scopeSelectEl: HTMLSelectElement | null;
    // Log pane
    logOutputEl: HTMLElement | null;

    // Popout windows (one per pane)
    popoutWindow: Window | null;
    consolePopout: Window | null;
    logPopout: Window | null;
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

    private logServerUrl = '';
    private visible = false;
    private gameLink: GameLink | null = null;
    private scene: Scene | null = null;
    private nextRequestId = 1;

    // Pending exec() promises keyed by requestId
    private pendingExecs = new Map<number, (result: { success: boolean; output: string }) => void>();

    // All entries (shared across tabs for filtering)
    private globalEntries: LogEntry[] = [];

    // HTTP log polling
    private logEventSource: EventSource | null = null;
    private lastLogId = 0;
    private logPollUrl = '';
    private logHistoryFetched = false;

    constructor() {
        this.setupKeyboard();
    }

    // ─── Public API ───

    setLogServerUrl(url: string): void {
        this.logServerUrl = url;
        this.logPollUrl = url;
        if (this.visible) this.startLogPolling();
    }

    setScene(scene: Scene): void { this.scene = scene; }

    /** Set the game-server control link for command forwarding. Inbound
     *  control messages are fed in via {@link ingestGameMessage} (the
     *  Connection taps its control stream — WebTransport delivers one onMessage
     *  for the whole session, so the console can't read the raw stream itself). */
    setGameLink(link: GameLink | null): void {
        this.gameLink = link;
    }

    /** Feed a framed control message (envelope + payload) from the Connection's
     *  control-stream tap, so ConsoleResponse can resolve pending exec()s. */
    ingestGameMessage(data: Uint8Array): void {
        this.handleGameMessage(data);
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
        this.startLogPolling();
        const tab = this.getTab(this.activeTabId);
        tab?.inputEl?.focus();
    }

    hide(): void {
        this.container?.classList.add('hidden');
        this.visible = false;
        this.stopLogPolling();
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
            history: [], historyIndex: -1, consoleLineCount: 0,
            minLevel: 2, searchFilter: '',
            hiddenSources: new Set(),
            entries: [], logLineCount: 0, logAutoScroll: true,
            tabEl: null, panelEl: null,
            consoleOutputEl: null, inputEl: null, promptEl: null, scopeSelectEl: null,
            logOutputEl: null,
            popoutWindow: null, consolePopout: null, logPopout: null,
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
        tab.consoleOutputEl = panel.querySelector('.debug-console-output');
        tab.logOutputEl = panel.querySelector('.debug-log-output');
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
            <div class="debug-split">
                <div class="debug-pane debug-pane-console" style="width:40%">
                    <div class="debug-pane-toolbar">
                        <span class="pane-title">Console</span>
                        <button type="button" class="pane-clear-btn" title="Clear">Clear</button>
                        <button type="button" class="pane-undock-btn" title="Pop out console" data-pane="console">&#x2197;</button>
                    </div>
                    <div class="debug-console-output"></div>
                    <div class="debug-panel-input">
                        <select class="panel-scope-select" name="debug-scope" title="Execution scope">${scopeOpts}</select>
                        <span class="debug-prompt">LuaRules&gt;</span>
                        <textarea name="debug-input" rows="1" placeholder="Enter command... (Shift+Enter for newline)" spellcheck="false"></textarea>
                        <span class="debug-input-hint">Enter | Shift+Enter: newline</span>
                    </div>
                </div>
                <div class="debug-split-handle" title="Drag to resize"></div>
                <div class="debug-pane debug-pane-logs" style="width:60%">
                    <div class="debug-pane-toolbar">
                        <span class="pane-title">Logs</span>
                        <select class="panel-level-filter" name="debug-level-filter" title="Min log level">
                            <option value="0">ALL</option>
                            <option value="1">INFO+</option>
                            <option value="2" selected>NOTICE+</option>
                            <option value="3">WARN+</option>
                            <option value="4">ERROR+</option>
                            <option value="5">FATAL</option>
                        </select>
                        <span class="log-source-toggles"></span>
                        <input class="panel-search-filter" name="debug-search-filter" type="text" placeholder="search..." />
                        <button type="button" class="pane-clear-btn log-clear-btn" title="Clear">Clear</button>
                        <button type="button" class="pane-undock-btn" title="Pop out logs" data-pane="logs">&#x2197;</button>
                    </div>
                    <div class="debug-log-output"></div>
                </div>
            </div>
        `;
    }

    private wirePanelEvents(tab: ConsoleTab): void {
        const panel = tab.panelEl!;

        // --- Log pane filters ---
        const levelFilter = panel.querySelector('.panel-level-filter') as HTMLSelectElement;
        levelFilter?.addEventListener('change', () => {
            tab.minLevel = parseInt(levelFilter.value, 10);
            this.rerenderTab(tab);
        });
        const searchInput = panel.querySelector('.panel-search-filter') as HTMLInputElement;
        searchInput?.addEventListener('input', () => {
            tab.searchFilter = searchInput.value.trim().toLowerCase();
            this.rerenderTab(tab);
        });

        // Build source toggle buttons from discovered sources
        this.rebuildSourceToggles(tab);

        // Console clear button
        const consoleClearBtn = panel.querySelector('.debug-pane-console .pane-clear-btn');
        consoleClearBtn?.addEventListener('click', () => {
            if (tab.consoleOutputEl) { tab.consoleOutputEl.innerHTML = ''; tab.consoleLineCount = 0; }
        });

        // Log clear button
        const logClearBtn = panel.querySelector('.log-clear-btn');
        logClearBtn?.addEventListener('click', () => {
            tab.entries = [];
            if (tab.logOutputEl) { tab.logOutputEl.innerHTML = ''; tab.logLineCount = 0; }
        });

        // Scope selector
        tab.scopeSelectEl?.addEventListener('change', () => {
            tab.scope = tab.scopeSelectEl!.value;
            tab.label = tab.scope;
            if (tab.promptEl) tab.promptEl.textContent = `${tab.scope}>`;
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
            tab.inputEl.addEventListener('input', () => this.autoSizeTextarea(tab.inputEl!));
        }

        // Log pane auto-scroll
        tab.logOutputEl?.addEventListener('scroll', () => {
            if (!tab.logOutputEl) return;
            const { scrollTop, scrollHeight, clientHeight } = tab.logOutputEl;
            tab.logAutoScroll = scrollTop + clientHeight >= scrollHeight - 20;
        });

        // --- Drag handle for split resize ---
        const handle = panel.querySelector('.debug-split-handle');
        if (handle) {
            const split = panel.querySelector('.debug-split') as HTMLElement;
            const consolePane = panel.querySelector('.debug-pane-console') as HTMLElement;
            const logPane = panel.querySelector('.debug-pane-logs') as HTMLElement;

            let dragging = false;
            handle.addEventListener('mousedown', (e) => {
                dragging = true;
                e.preventDefault();
                const doc = handle.ownerDocument;
                const onMove = (ev: MouseEvent) => {
                    if (!dragging || !split) return;
                    const rect = split.getBoundingClientRect();
                    const x = ev.clientX - rect.left;
                    const pct = Math.max(15, Math.min(85, (x / rect.width) * 100));
                    consolePane.style.width = `${pct}%`;
                    logPane.style.width = `${100 - pct}%`;
                };
                const onUp = () => {
                    dragging = false;
                    doc.removeEventListener('mousemove', onMove);
                    doc.removeEventListener('mouseup', onUp);
                };
                doc.addEventListener('mousemove', onMove);
                doc.addEventListener('mouseup', onUp);
            });
        }

        // --- Pane undock buttons ---
        panel.querySelectorAll('.pane-undock-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const pane = (btn as HTMLElement).dataset.pane;
                if (pane === 'console') this.undockPane(tab, 'console');
                else if (pane === 'logs') this.undockPane(tab, 'logs');
            });
        });
    }

    private autoSizeTextarea(el: HTMLTextAreaElement): void {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    // ─── Undock / popout ───

    private undockTab(tabId: number): void {
        // Full tab undock — pop the entire split panel into a window
        const tab = this.getTab(tabId);
        if (!tab) return;
        if (tab.popoutWindow && !tab.popoutWindow.closed) {
            tab.popoutWindow.focus();
            return;
        }
        const popup = window.open('', `debug-tab-${tabId}`,
            'width=900,height=500,menubar=no,toolbar=no,location=no,status=no');
        if (!popup) return;
        tab.popoutWindow = popup;

        popup.document.write(`<!DOCTYPE html>
<html><head><title>Debug: ${tab.scope}</title>
<style>${css}
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
body { background: #0f0f14; }
.debug-tab-panel { display: flex !important; height: 100vh; }
</style></head>
<body></body></html>`);
        popup.document.close();

        const panelClone = tab.panelEl!.cloneNode(true) as HTMLElement;
        panelClone.classList.add('active');
        popup.document.body.appendChild(panelClone);

        this.recacheTabRefs(tab, panelClone);
        this.wirePanelEvents(tab);
        tab.tabEl?.classList.add('undocked');

        popup.addEventListener('beforeunload', () => this.redockTab(tab));
        tab.inputEl?.focus();
    }

    private undockPane(tab: ConsoleTab, pane: 'console' | 'logs'): void {
        const existing = pane === 'console' ? tab.consolePopout : tab.logPopout;
        if (existing && !existing.closed) { existing.focus(); return; }

        const title = pane === 'console' ? `Console: ${tab.scope}` : `Logs: ${tab.scope}`;
        const popup = window.open('', `debug-${pane}-${tab.id}`,
            'width=600,height=450,menubar=no,toolbar=no,location=no,status=no');
        if (!popup) return;

        if (pane === 'console') tab.consolePopout = popup;
        else tab.logPopout = popup;

        popup.document.write(`<!DOCTYPE html>
<html><head><title>${title}</title>
<style>${css}
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
body { background: #0f0f14; display: flex; flex-direction: column; }
.debug-pane { width: 100% !important; height: 100vh; display: flex; flex-direction: column; }
</style></head>
<body></body></html>`);
        popup.document.close();

        // Clone the specific pane
        const selector = pane === 'console' ? '.debug-pane-console' : '.debug-pane-logs';
        const paneEl = tab.panelEl?.querySelector(selector);
        if (!paneEl) return;
        const clone = paneEl.cloneNode(true) as HTMLElement;
        popup.document.body.appendChild(clone);

        // Copy content
        if (pane === 'console' && tab.consoleOutputEl) {
            const newOut = clone.querySelector('.debug-console-output');
            if (newOut) newOut.innerHTML = tab.consoleOutputEl.innerHTML;
            // Rewire refs to the popout
            tab.consoleOutputEl = newOut as HTMLElement;
            tab.inputEl = clone.querySelector('textarea');
            tab.promptEl = clone.querySelector('.debug-prompt');
            tab.scopeSelectEl = clone.querySelector('.panel-scope-select');
        } else if (pane === 'logs' && tab.logOutputEl) {
            const newOut = clone.querySelector('.debug-log-output');
            if (newOut) newOut.innerHTML = tab.logOutputEl.innerHTML;
            tab.logOutputEl = newOut as HTMLElement;
        }

        // Wire events on the popout pane
        // (Simplified: re-wire the whole panel since filters/input live in the clone)
        const origPanel = tab.panelEl;
        tab.panelEl = clone;
        this.wirePanelEvents(tab);
        tab.panelEl = origPanel;

        // Hide the pane in the main panel
        const mainPane = tab.panelEl?.querySelector(selector) as HTMLElement;
        if (mainPane) mainPane.style.display = 'none';
        const handle = tab.panelEl?.querySelector('.debug-split-handle') as HTMLElement;
        if (handle) handle.style.display = 'none';
        // Expand the remaining pane to full width
        const otherSelector = pane === 'console' ? '.debug-pane-logs' : '.debug-pane-console';
        const otherPane = tab.panelEl?.querySelector(otherSelector) as HTMLElement;
        if (otherPane) otherPane.style.width = '100%';

        popup.addEventListener('beforeunload', () => {
            if (pane === 'console') tab.consolePopout = null;
            else tab.logPopout = null;
            // Re-show the pane in the main panel
            if (mainPane) mainPane.style.display = '';
            if (handle) handle.style.display = '';
            if (otherPane) otherPane.style.width = '';
            // Re-cache refs back to the main panel
            this.recacheTabRefs(tab, tab.panelEl!);
            this.wirePanelEvents(tab);
            this.rerenderTab(tab);
        });
    }

    private recacheTabRefs(tab: ConsoleTab, panel: HTMLElement): void {
        tab.panelEl = panel;
        tab.consoleOutputEl = panel.querySelector('.debug-console-output');
        tab.logOutputEl = panel.querySelector('.debug-log-output');
        tab.inputEl = panel.querySelector('textarea');
        tab.promptEl = panel.querySelector('.debug-prompt');
        tab.scopeSelectEl = panel.querySelector('.panel-scope-select');
        if (tab.scopeSelectEl) tab.scopeSelectEl.value = tab.scope;
        if (tab.promptEl) tab.promptEl.textContent = `${tab.scope}>`;
    }

    private redockTab(tab: ConsoleTab): void {
        tab.popoutWindow = null;
        tab.tabEl?.classList.remove('undocked');

        const oldPanel = this.panelsEl?.querySelector(`.debug-tab-panel:nth-child(${this.tabs.indexOf(tab) + 1})`);
        if (oldPanel) oldPanel.remove();

        const panel = document.createElement('div');
        panel.className = 'debug-tab-panel' + (tab.id === this.activeTabId ? ' active' : '');
        panel.innerHTML = this.buildPanelHTML(tab.id);
        this.panelsEl?.appendChild(panel);

        this.recacheTabRefs(tab, panel);
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
            if (tab.consoleOutputEl) { tab.consoleOutputEl.innerHTML = ''; tab.consoleLineCount = 0; }
            if (tab.logOutputEl) { tab.logOutputEl.innerHTML = ''; tab.logLineCount = 0; }
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
        this.gameLink!.send(frame);
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
        const el = tab.consoleOutputEl;
        if (!el) return;
        const div = document.createElement('div');
        div.className = `debug-line ${cls}`;
        div.textContent = text;
        el.appendChild(div);
        tab.consoleLineCount++;
        while (tab.consoleLineCount > MAX_LINES && el.firstChild) {
            el.removeChild(el.firstChild);
            tab.consoleLineCount--;
        }
        el.scrollTop = el.scrollHeight;
    }

    private appendLogLine(tab: ConsoleTab, entry: LogEntry): void {
        const el = tab.logOutputEl;
        if (!el) return;
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

        el.appendChild(div);
        tab.logLineCount++;
        while (tab.logLineCount > MAX_LINES && el.firstChild) {
            el.removeChild(el.firstChild);
            tab.logLineCount--;
        }
        if (tab.logAutoScroll) el.scrollTop = el.scrollHeight;
    }

    private tabPassesFilter(tab: ConsoleTab, entry: LogEntry): boolean {
        if (entry.level < tab.minLevel) return false;
        if (tab.searchFilter && !entry.message.toLowerCase().includes(tab.searchFilter)) return false;
        // Toggle-based source filtering
        if (tab.hiddenSources.size > 0) {
            const processKey = `process:${entry.process}`;
            const sectionKey = `section:${entry.section}`;
            const scopeKey = entry.scope ? `scope:${entry.scope}` : '';
            if (tab.hiddenSources.has(processKey)) return false;
            if (tab.hiddenSources.has(sectionKey)) return false;
            if (scopeKey && tab.hiddenSources.has(scopeKey)) return false;
        }
        return true;
    }

    private rerenderTab(tab: ConsoleTab): void {
        if (!tab.logOutputEl) return;
        tab.logOutputEl.innerHTML = '';
        tab.logLineCount = 0;
        tab.entries = this.globalEntries.filter(e => this.tabPassesFilter(tab, e));
        for (const entry of tab.entries) {
            this.appendLogLine(tab, entry);
        }
    }

    // ─── Log streaming (SSE) + history backfill ───

    private startLogPolling(): void {
        if (this.logEventSource) return;
        if (!this.logPollUrl) {
            const host = window.location.hostname || 'localhost';
            this.logPollUrl = `http://${host}:8010`;
        }
        this.setStatus(true);

        // Fetch history on first open (last 500 entries)
        if (!this.logHistoryFetched) {
            this.logHistoryFetched = true;
            this.fetchLogHistory();
        }

        // Connect SSE for real-time streaming (replaces 2s polling)
        const sseUrl = `${this.logPollUrl}/api/logs/stream`;
        const es = new EventSource(sseUrl);
        this.logEventSource = es;

        es.addEventListener('log', (event: MessageEvent) => {
            try {
                const e = JSON.parse(event.data);
                this.ingestLogEntry(e);
                for (const tab of this.tabs) this.rebuildSourceToggles(tab);
            } catch { /* ignore malformed events */ }
        });

        es.onopen = () => this.setStatus(true);
        es.onerror = () => {
            this.setStatus(false);
            // EventSource auto-reconnects — no manual retry needed
        };
    }

    private stopLogPolling(): void {
        if (this.logEventSource) {
            this.logEventSource.close();
            this.logEventSource = null;
        }
    }

    /** Fetch historical logs (last 500 entries) to show context from
     *  before the debug console was opened. */
    private async fetchLogHistory(): Promise<void> {
        if (!this.logPollUrl) return;
        try {
            const resp = await fetch(`${this.logPollUrl}/api/logs/0?limit=500&level=0`);
            if (!resp.ok) return;
            const entries: any[] = await resp.json();
            if (!Array.isArray(entries)) return;

            // History comes newest-first from SQLite; reverse for chronological
            const sorted = entries.reverse();
            for (const e of sorted) {
                if (e.id && e.id <= this.lastLogId) continue;
                if (e.id) this.lastLogId = e.id;
                this.ingestLogEntry(e);
            }
            // Rebuild source toggles now that we have data
            for (const tab of this.tabs) this.rebuildSourceToggles(tab);
        } catch { /* ignore */ }
    }

    private knownSources = new Set<string>();

    private ingestLogEntry(e: any): void {
        const entry: LogEntry = {
            id: e.id ?? 0,
            timestamp: e.timestamp ?? 0,
            level: e.level ?? 2,
            section: e.section ?? '',
            scope: e.scope ?? '',
            process: e.process ?? '',
            message: e.message ?? '',
            frame: e.frame ?? 0,
        };
        // Track sources for toggle buttons
        if (entry.process) this.knownSources.add(`process:${entry.process}`);
        if (entry.section) this.knownSources.add(`section:${entry.section}`);
        if (entry.scope) this.knownSources.add(`scope:${entry.scope}`);

        this.addEntry(entry);
    }

    /** Build toggle buttons for each discovered log source. */
    private rebuildSourceToggles(tab: ConsoleTab): void {
        const container = tab.panelEl?.querySelector('.log-source-toggles');
        if (!container || this.knownSources.size === 0) return;

        // Only rebuild if the source set has changed
        const key = [...this.knownSources].sort().join(',');
        if (container.getAttribute('data-sources') === key) return;
        container.setAttribute('data-sources', key);

        container.innerHTML = '';
        // Group by type
        const processes: string[] = [];
        const sections: string[] = [];
        const scopes: string[] = [];
        for (const s of this.knownSources) {
            if (s.startsWith('process:')) processes.push(s);
            else if (s.startsWith('section:')) sections.push(s);
            else if (s.startsWith('scope:')) scopes.push(s);
        }

        const addButtons = (items: string[], color: string) => {
            for (const key of items.sort()) {
                const label = key.split(':').slice(1).join(':');
                const btn = document.createElement('button');
                btn.className = 'log-source-toggle active';
                btn.textContent = label;
                btn.style.borderColor = color;
                btn.title = `Toggle ${key}`;
                btn.dataset.sourceKey = key;

                if (tab.hiddenSources.has(key)) {
                    btn.classList.remove('active');
                }

                btn.addEventListener('click', () => {
                    if (tab.hiddenSources.has(key)) {
                        tab.hiddenSources.delete(key);
                        btn.classList.add('active');
                    } else {
                        tab.hiddenSources.add(key);
                        btn.classList.remove('active');
                    }
                    this.rerenderTab(tab);
                });
                container.appendChild(btn);
            }
        };

        addButtons(processes, '#88f');
        addButtons(sections, '#8c8');
        addButtons(scopes, '#ca8');
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
        return this.gameLink?.isOpen() ?? false;
    }

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
               .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

/** Singleton instance */
export const debugConsole = new DebugConsole();

// GW8: register the net-inspector log sink (main-thread only). net-inspector is
// worker-safe and no longer imports debug-console; the gated per-frame net log
// routes back here via this sink. The worker never imports debug-console, so it
// leaves the sink null and the bandwidth tally runs without any DOM dependency.
setNetLogSink((e) => debugConsole.addEntry(e));
