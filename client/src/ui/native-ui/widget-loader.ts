/**
 * widget-loader.ts — Metalstorm native JS widget loader (PLAN-native-ui.md §3)
 *
 * Fetches the game's `<gameId>.ui.json` manifest, dynamically imports its
 * widgets/*.js modules, mounts them at their declared mount points, and
 * provides each with the widget context (store, identity, sendCommand,
 * strategicMap).
 *
 * The loader also owns all HUD *chrome*: it injects the shared design system
 * (native-ui.css) and builds the collapsible panel frame around each titled widget,
 * so widgets only ever render their own content. That's what keeps every
 * panel — engine-bundled and game-authored — visually identical without any
 * widget carrying inline styles.
 *
 * This is a NEW dynamic widget-import path separate from the existing
 * client/src/ui/game/loader.ts (which loads CSS/HTML template overrides).
 */

import { uiStore, type UIStore } from './ui-store.js';
import { stampUrl } from '../../config.js';
import { injectStyle } from '../ui.js';
import { clientSettings } from '../../core/client-settings.js';
import nativeUiCss from './native-ui.css?raw';

export interface WidgetManifest {
    game: string;
    uiVersion: number;
    widgets: WidgetDescriptor[];
    /** Game stylesheets (relative to the game's ui/ dir), fetched and injected
     *  after native-ui.css so a game can skin the design system's tokens/primitives
     *  and add its own widget classes. */
    styles?: string[];
}

export interface WidgetDescriptor {
    id: string;
    entry: string;           // Relative path like "widgets/authority-bar.js"
    mount: string;           // Mount point: "top-center", "right", "left", etc.
    subscribes?: string[];   // Store paths this widget subscribes to
    revealOn?: string;       // Progressive disclosure predicate (not impl yet)
    builtin?: boolean;       // Mount the client-bundled module from BUILTIN_WIDGETS
                             // instead of fetching entry from the game dir. Used for
                             // engine-provided UI that depends on bundled modules
                             // (e.g. the command composer needs compile-table +
                             // named-entity-index).
    /** Never mount this widget for a spectator session (PLAN-metalstorm-
     *  onboarding.md §4). Set on every order-issuing panel — the command
     *  composer, AI guidance — so a spectator's HUD has zero command paths
     *  by construction rather than by every widget self-checking a role. */
    hideForSpectator?: boolean;

    // ── panel chrome (owned by the loader, not the widget) ──
    /** Header text. Present ⇒ the widget is wrapped in a titled .nui-panel
     *  frame and `ctx.mount` is the panel BODY. Absent ⇒ the widget is mounted
     *  bare (it renders its own container, e.g. the authority pill). */
    title?: string;
    /** Header toggles the body. Defaults to true for titled widgets. */
    collapsible?: boolean;
    /** Start collapsed the first time this player sees the panel. Use for the
     *  heavy, occasionally-used panels so the HUD opens quiet. */
    collapsed?: boolean;
}

export interface WidgetContext {
    store: UIStore;
    mount: HTMLElement;      // DOM mount point inside #ui-root
    identity: {
        playerId: number;
        teamId: number;
    };
    sendCommand?: (cmd: any) => void;        // Command submission API (stub for now)
    strategicMap?: {                         // Strategic map overlay API (stub for now)
        setMarkers?: (markers: any[]) => void;
    };
    /** Set the count/status pill in this widget's panel header. Visible even
     *  while the panel is collapsed, so a collapsed panel can still report
     *  "3 pending". Pass null/'' to clear. No-op for untitled widgets. */
    setBadge?: (text: string | number | null) => void;
}

export interface Widget {
    id: string;
    init(ctx: WidgetContext): void;
    dispose(): void;
    showRefusalToast?: (cost: number) => void;  // authority-bar specific method
}

/**
 * Client-bundled ("built-in") widgets, keyed by manifest widget id.
 *
 * A manifest entry with `builtin: true` is mounted from here instead of being
 * fetched from the game dir. This exists for engine-provided UI that depends on
 * bundled modules which can't be resolved when a widget is fetched as a
 * standalone ES module (e.g. the command composer statically imports
 * compile-table + named-entity-index). The dynamic import() keeps the module
 * out of the initial bundle until a game that uses it loads.
 */
const BUILTIN_WIDGETS: Record<string, () => Promise<{ default: Widget }>> = {
    // @ts-ignore — command-composer.js is untyped JS (same as the game-dir
    // widgets); it exports a default { id, init, dispose } matching Widget.
    'command-composer': () => import('../../native-widgets/command-composer.js'),
};

/** Widget mounting waits on the game's stylesheets; don't wait forever. */
const GAME_STYLE_TIMEOUT_MS = 5000;

/**
 * WidgetLoader manages the lifecycle of native JS widgets for a game.
 *
 * It fetches the manifest, creates mount points, imports and initializes
 * widgets, and handles cleanup on game exit.
 */
export class WidgetLoader {
    private widgets = new Map<string, { widget: Widget; context: WidgetContext }>();
    private mountPoints = new Map<string, HTMLElement>();
    /** Ids of game stylesheets injected by this loader, removed on dispose. */
    private gameStyleIds: string[] = [];
    private uiRoot: HTMLElement | null = null;
    private sendCommandProvider: ((cmd: any) => void) | null = null;
    private gameId = '';
    /** PLAN-metalstorm-onboarding.md §4 — gates `hideForSpectator` widgets. */
    private isSpectator = false;
    /** Keeps the left rail docked below whatever occupies the top-left mount. */
    private topLeftObserver: ResizeObserver | null = null;
    /**
     * Bumped by dispose(). `load()` is long (manifest fetch + skin fetch + N
     * dynamic imports) and is re-entered on every authenticate — including a
     * resync reconnect — so an in-flight load must notice it has been disposed
     * and stop, rather than mounting widgets and styles into a torn-down HUD
     * that no later dispose() knows about.
     */
    private generation = 0;

    /**
     * Load and mount all widgets for the given game.
     *
     * @param gameId - Game identifier (e.g., "metalstorm")
     * @param httpBase - HTTP base URL for fetching game data
     * @param playerId - Local player ID
     * @param teamId - Local player's team ID
     * @param role - Session role ("player" / "spectator" / "admin"); gates
     *   `hideForSpectator` manifest entries (PLAN-metalstorm-onboarding §4).
     */
    async load(
        gameId: string,
        httpBase: string,
        playerId: number,
        teamId: number,
        role: string = '',
    ): Promise<void> {
        this.gameId = gameId;
        this.isSpectator = role === 'spectator';
        const generation = this.generation;
        const stale = () => this.generation !== generation;

        // Fetch the widget manifest
        const manifest = await this.fetchManifest(gameId, httpBase);
        if (stale()) return;
        if (!manifest || manifest.widgets.length === 0) {
            console.log(`[widget-loader] No widgets for game ${gameId}`);
            return;
        }

        console.log(`[widget-loader] Loading ${manifest.widgets.length} widgets for ${gameId}`);

        // Ensure ui-root exists
        this.uiRoot = document.getElementById('ui-root') as HTMLElement;
        if (!this.uiRoot) {
            console.error('[widget-loader] #ui-root not found');
            return;
        }

        // Create mount points
        this.createMountPoints();

        const baseUrl = `${httpBase}/api/games/data/${encodeURIComponent(gameId)}/ui`;

        // Game skin goes in after the design system so it can override tokens.
        await this.injectGameStyles(manifest.styles ?? [], baseUrl);
        if (stale()) return;

        // Load and mount each widget
        for (const descriptor of manifest.widgets) {
            if (stale()) return;
            if (this.isSpectator && descriptor.hideForSpectator) {
                console.log(`[widget-loader] Skipping ${descriptor.id} (spectator session)`);
                continue;
            }
            try {
                await this.loadWidget(descriptor, baseUrl, playerId, teamId);
            } catch (e) {
                console.error(`[widget-loader] Failed to load widget ${descriptor.id}:`, e);
            }
        }
    }

    /**
     * Fetch the widget manifest from the server.
     */
    private async fetchManifest(
        gameId: string,
        httpBase: string,
    ): Promise<WidgetManifest | null> {
        try {
            // `<gameId>.ui.json` — Metalstorm's manifest already uses this
            // shape, so the convention is uniform rather than hardcoded to
            // one game (the loader, the panel chrome and `styles[]` are all
            // game-agnostic; a hardcoded filename would make them unreachable).
            const url = stampUrl(
                `${httpBase}/api/games/data/${encodeURIComponent(gameId)}/ui/${encodeURIComponent(gameId)}.ui.json`
            );
            const res = await fetch(url);
            if (!res.ok) {
                console.log(`[widget-loader] No manifest for ${gameId} (${res.status})`);
                return null;
            }
            return await res.json() as WidgetManifest;
        } catch (e) {
            console.error(`[widget-loader] Failed to fetch manifest:`, e);
            return null;
        }
    }

    /**
     * Create standard mount point containers inside #ui-root.
     *
     * Mount points are positioned using CSS classes that games can override.
     */
    private createMountPoints(): void {
        if (!this.uiRoot) return;

        const mountPointIds = [
            'top-left',
            'top-center',
            'top-right',
            'left',
            'center',
            'right',
            'bottom-left',
            'bottom-center',
            'bottom-right',
        ];

        for (const id of mountPointIds) {
            let mount = this.uiRoot.querySelector(`#ui-mount-${id}`) as HTMLElement;
            if (!mount) {
                mount = document.createElement('div');
                mount.id = `ui-mount-${id}`;
                mount.className = `ui-mount ui-mount-${id}`;
                this.uiRoot.appendChild(mount);
            }
            this.mountPoints.set(id, mount);
        }

        // The design system owns dock geometry AND the mount's pointer-events
        // discipline (frame: none, panels: auto) — see native-ui.css.
        injectStyle('native-ui-design-system', nativeUiCss);

        this.trackTopLeftDock();
    }

    /**
     * Keep the left rail docked below whatever the game put in the top-left
     * mount, by publishing that mount's measured height as `--nui-rail-top`.
     *
     * The alternative — a constant in the engine stylesheet — would bake one
     * game's top-left widget height (Metalstorm's authority pill happens to be
     * 42px) into shared geometry, so a game with a taller readout would have
     * its rail overlap it and a game with nothing top-left would get a band of
     * dead rail. Measuring makes the engine agnostic about what docks there.
     */
    private trackTopLeftDock(): void {
        const topLeft = this.mountPoints.get('top-left');
        const rail = this.mountPoints.get('left');
        if (!topLeft || !rail) return;

        const inset = 8;
        const apply = () => {
            const h = topLeft.getBoundingClientRect().height;
            // Empty dock ⇒ the rail starts at the plain screen inset.
            rail.style.setProperty('--nui-rail-top', `${h > 0 ? h + inset * 2 : inset}px`);
        };

        if (typeof ResizeObserver !== 'undefined') {
            this.topLeftObserver = new ResizeObserver(apply);
            this.topLeftObserver.observe(topLeft);
        }
        apply();
    }

    /**
     * Fetch and inject the game's own stylesheets, in manifest order, after
     * the design system. Failures are logged, never fatal — a missing skin
     * leaves the game looking like the engine default rather than unstyled.
     */
    private async injectGameStyles(styles: string[], baseUrl: string): Promise<void> {
        // Fetched concurrently — widget mounting is gated on this, so a serial
        // loop would add one RTT of unstyled HUD per stylesheet. Injected in
        // manifest order afterwards, since later sheets may override earlier.
        const sources = await Promise.all(styles.map(async (href) => {
            try {
                // Bounded: a stalled CDN must not cost the player their whole
                // HUD, only its skin.
                const res = await fetch(stampUrl(`${baseUrl}/${href}`), {
                    signal: AbortSignal.timeout(GAME_STYLE_TIMEOUT_MS),
                });
                if (res.ok) return await res.text();
                console.warn(`[widget-loader] Game stylesheet ${href} → ${res.status}`);
            } catch (e) {
                console.warn(`[widget-loader] Failed to load game stylesheet ${href}:`, e);
            }
            return null;
        }));

        for (const [i, css] of sources.entries()) {
            if (css === null) continue;
            const styleId = `native-ui-game-style-${this.gameId}-${i}`;
            injectStyle(styleId, css);   // id-guarded, so re-entry is a no-op
            // Recorded unconditionally: if the element already existed (an
            // earlier loader raced us), dispose() must still remove it —
            // otherwise the id is permanently taken and every later load
            // silently keeps the stale skin.
            if (!this.gameStyleIds.includes(styleId)) this.gameStyleIds.push(styleId);
        }
    }

    /**
     * Build the shared panel chrome for a titled widget and return the body
     * element the widget mounts into.
     *
     * Widgets never draw their own frame or header — that's what makes the
     * HUD consistent by construction. Collapse state is sticky per game (in
     * the browser profile, via the settings store), so a panel the player
     * closed stays closed across sessions.
     *
     * Accessibility: a collapsible header is a real `<button>` with
     * `aria-expanded`/`aria-controls`, not a click-handled `<div>`. Three of
     * Metalstorm's five panels start collapsed, so a div here would leave a
     * keyboard-only player with no way to ever open them.
     */
    private createPanelFrame(
        descriptor: WidgetDescriptor,
        parent: HTMLElement,
    ): { body: HTMLElement; frame: HTMLElement; setBadge: (t: string | number | null) => void } {
        const collapsible = descriptor.collapsible !== false;
        const label = descriptor.title ?? descriptor.id;
        const bodyId = `nui-panel-body-${descriptor.id}`;

        const frame = document.createElement('section');
        frame.className = `nui-panel nui-panel--${descriptor.id}`;
        frame.setAttribute('aria-label', label);
        if (collapsible) frame.classList.add('nui-panel--collapsible');

        const head = document.createElement(collapsible ? 'button' : 'header');
        head.className = 'nui-panel__head';

        const caret = document.createElement('span');
        caret.className = 'nui-panel__caret';
        caret.textContent = '▾';
        caret.setAttribute('aria-hidden', 'true');

        const title = document.createElement('span');
        title.className = 'nui-panel__title';
        title.textContent = label;

        const badge = document.createElement('span');
        badge.className = 'nui-panel__badge';

        if (collapsible) head.appendChild(caret);
        head.appendChild(title);
        head.appendChild(badge);

        const body = document.createElement('div');
        body.className = 'nui-panel__body';
        body.id = bodyId;

        frame.appendChild(head);
        frame.appendChild(body);
        parent.appendChild(frame);

        if (collapsible) {
            (head as HTMLButtonElement).type = 'button';
            head.setAttribute('aria-controls', bodyId);

            // Collapse state is a user preference, so it lives in the settings
            // store like every other one — which also makes it readable and
            // resettable from Lua via Spring.Get/SetConfigInt.
            const key = this.collapseKey(descriptor.id);
            const setExpanded = (collapsed: boolean) =>
                head.setAttribute('aria-expanded', String(!collapsed));

            const collapsed = clientSettings.getBool(key, descriptor.collapsed ?? false);
            if (collapsed) frame.classList.add('is-collapsed');
            setExpanded(collapsed);

            head.addEventListener('click', () => {
                const nowCollapsed = frame.classList.toggle('is-collapsed');
                setExpanded(nowCollapsed);
                clientSettings.set(key, nowCollapsed);
            });
        }

        return {
            frame,
            body,
            setBadge: (t) => {
                badge.textContent = t === null || t === undefined ? '' : String(t);
            },
        };
    }

    private collapseKey(widgetId: string): string {
        return `hud.collapsed.${this.gameId}.${widgetId}`;
    }

    /**
     * Dynamically import and initialize a single widget.
     */
    private async loadWidget(
        descriptor: WidgetDescriptor,
        baseUrl: string,
        playerId: number,
        teamId: number,
    ): Promise<void> {
        // Get mount point
        const mountElement = this.mountPoints.get(descriptor.mount);
        if (!mountElement) {
            console.warn(`[widget-loader] Unknown mount point "${descriptor.mount}" for widget ${descriptor.id}`);
            return;
        }

        // Resolve the widget module: client-bundled built-ins come from the
        // BUILTIN_WIDGETS registry; game-authored widgets are fetched from the
        // game dir as standalone ES modules.
        let module: { default: Widget };
        if (descriptor.builtin) {
            const builtin = BUILTIN_WIDGETS[descriptor.id];
            if (!builtin) {
                console.error(`[widget-loader] Widget ${descriptor.id} is marked builtin but not registered in BUILTIN_WIDGETS`);
                return;
            }
            module = await builtin();
        } else {
            const widgetUrl = stampUrl(`${baseUrl}/${descriptor.entry}`);
            module = await import(/* @vite-ignore */ widgetUrl);
        }
        const widget = module.default as Widget;

        if (!widget || typeof widget.init !== 'function') {
            console.error(`[widget-loader] Widget ${descriptor.id} has no init() method`);
            return;
        }

        // Titled widgets get the shared collapsible panel frame and mount into
        // its body; untitled ones (the authority pill) mount bare.
        const panel = descriptor.title
            ? this.createPanelFrame(descriptor, mountElement)
            : null;

        // Create widget context
        const context: WidgetContext = {
            store: uiStore,
            mount: panel ? panel.body : mountElement,
            identity: { playerId, teamId },
            sendCommand: this.createSendCommand(),
            strategicMap: this.createStrategicMapStub(),
            setBadge: panel ? panel.setBadge : () => {},
        };

        // Initialize widget
        try {
            widget.init(context);
            this.widgets.set(descriptor.id, { widget, context });
            console.log(`[widget-loader] Mounted widget ${descriptor.id} at ${descriptor.mount}`);
        } catch (e) {
            console.error(`[widget-loader] Widget ${descriptor.id} init() failed:`, e);
            // The frame was created before init(), so a crashed widget would
            // otherwise leave a fully-styled, permanently empty panel docked in
            // the rail — indistinguishable from "no data yet". Take it down so
            // the failure is visible as a missing panel.
            panel?.frame.remove();
            try {
                widget.dispose();   // it may have registered subscriptions before throwing
            } catch { /* already failing; don't mask the original error */ }
        }
    }

    /**
     * Set the sendCommand provider for widgets.
     * This should be called after the Connection is established.
     */
    setSendCommandProvider(provider: (cmd: any) => void): void {
        this.sendCommandProvider = provider;

        // Update existing widgets with the new provider
        for (const { context } of this.widgets.values()) {
            context.sendCommand = provider;
        }
    }

    /**
     * Check if sendCommand has been wired.
     */
    hasSendCommand(): boolean {
        return this.sendCommandProvider !== null;
    }

    /**
     * Create the sendCommand function.
     * Uses the provider if set, otherwise returns a stub.
     */
    private createSendCommand(): (cmd: any) => void {
        if (this.sendCommandProvider) {
            return this.sendCommandProvider;
        }

        // Return stub if not wired yet
        let warned = false;
        return (cmd: any) => {
            if (!warned) {
                console.warn('[widget-loader] sendCommand not yet wired - waiting for connection');
                warned = true;
            }
            console.log('[widget-loader] sendCommand (stub):', cmd);
        };
    }

    /**
     * Create the strategicMap stub (PLAN-macro-map.md's strategic-map overlay doesn't exist yet).
     */
    private createStrategicMapStub(): WidgetContext['strategicMap'] {
        let warned = false;
        return {
            setMarkers: (markers: any[]) => {
                if (!warned) {
                    console.warn('[widget-loader] strategicMap.setMarkers not yet wired (strategic-map overlay gap)');
                    warned = true;
                }
                console.log('[widget-loader] setMarkers (stub):', markers);
            },
        };
    }

    /**
     * Dispose all loaded widgets and clean up.
     */
    dispose(): void {
        this.generation++;

        for (const [id, { widget }] of this.widgets.entries()) {
            try {
                widget.dispose();
                console.log(`[widget-loader] Disposed widget ${id}`);
            } catch (e) {
                console.error(`[widget-loader] Widget ${id} dispose() failed:`, e);
            }
        }
        this.widgets.clear();

        this.topLeftObserver?.disconnect();
        this.topLeftObserver = null;

        // Removing the mounts also detaches every panel frame we built inside
        // them (a widget's own dispose() only removes its content).
        for (const mount of this.mountPoints.values()) {
            mount.remove();
        }
        this.mountPoints.clear();

        // Design-system + game skin styles
        document.getElementById('native-ui-design-system')?.remove();
        for (const id of this.gameStyleIds) document.getElementById(id)?.remove();
        this.gameStyleIds = [];
    }

    /**
     * Get a loaded widget by ID (for programmatic access, e.g., showing refusal toasts).
     */
    getWidget(id: string): Widget | undefined {
        return this.widgets.get(id)?.widget;
    }
}
