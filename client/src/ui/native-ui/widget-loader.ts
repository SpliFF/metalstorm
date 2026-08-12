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
import { parseRevealPredicate } from './reveal-predicate.js';
import { classVocabulary, loadClassVocabulary } from './class-vocabulary.js';
import { uiActionRegistry } from './ui-action-registry.js';
import nativeUiCss from './native-ui.css?raw';

/**
 * Every `subscribes` / `revealOn` store path the loader recognises. Used only
 * to warn on a manifest typo — a widget that declares `subscribes: ["econmy"]`
 * still works (it subscribes itself in `init()`), but the typo is a reliable
 * sign the author expected the loader to wire something it never will.
 */
const KNOWN_STORE_PATHS: ReadonlySet<string> = new Set([
    'gameRulesParams', 'teamRulesParams', 'playerRoster', 'selection',
    'economy', 'unitQueues', 'directives', 'gameEvents', 'orgGroups',
]);

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
    /** Advisory: the ui-store paths this widget reads. The loader does not
     *  wire subscriptions from it (widgets subscribe themselves in `init()`);
     *  it validates the names and warns on unknown ones, which is how a
     *  manifest typo gets caught instead of silently doing nothing. */
    subscribes?: string[];
    /** Progressive-disclosure predicate (PLAN-native-ui.md §3). The widget
     *  stays unmounted until this first evaluates true against the ui-store,
     *  then mounts permanently — disclosure is one-way. Grammar and examples
     *  in `reveal-predicate.ts`. Absent ⇒ mount immediately. */
    revealOn?: string;
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
    /**
     * Extra names a player may call this panel by, for the natural-language
     * command layer (PLAN-metalstorm-command-language.md §6.3 — "open the
     * diplomacy panel" for `parley-panel`).
     *
     * They live in the MANIFEST, next to the `title` the player reads, because
     * the alternative is a second table in the client that has to be kept in
     * step with a game's panel list — the same drift `class-vocabulary.json`
     * exists to prevent. The widget id and the title are always accepted, so
     * this is only for the phrasings neither of those covers.
     */
    nlAliases?: string[];
}

export interface WidgetContext {
    store: UIStore;
    mount: HTMLElement;      // DOM mount point inside #ui-root
    /**
     * Who the local session is, in the sim's terms.
     *
     * `playerId` is Spring's **sim playerNum** — the id that scopes every
     * rulesParam key (`authority_player_<playerId>`, `score_<playerId>_*`),
     * every Lua callin argument, and every server-side player check. It is
     * NOT the DB account id; the two are different numbers and coincide only
     * by accident on low-id dev accounts. `accountId` is available for the
     * rare widget that needs the persistent account (profiles, ratings) —
     * never for anything sim-scoped. See PLAN-native-ui.md §3.3.
     */
    identity: {
        playerId: number;
        teamId: number;
        accountId: number;
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
    // @ts-ignore — same shape; the NL command console (PLAN-metalstorm-
    // command-language.md §4) needs the bundled console-exchange + accelerator
    // + class-vocabulary modules.
    'command-console': () => import('../../native-widgets/command-console.js'),
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
    /** Local DB account id, surfaced as `ctx.identity.accountId`. Distinct
     *  from the sim playerNum threaded through as `playerId`. */
    private accountId = 0;
    /** PLAN-metalstorm-onboarding.md §4 — gates `hideForSpectator` widgets. */
    private isSpectator = false;
    /** PLAN-metalstorm-onboarding.md §5 — when false, `revealOn` is ignored and
     *  every widget mounts at load. Onboarding gates this on `sessions_played`
     *  so a veteran account gets the whole HUD immediately. */
    private progressiveDisclosure = true;
    /** Unsubscribe fns for widgets still waiting on their `revealOn`. */
    private pendingReveals = new Map<string, () => void>();
    /** ui-action-registry removals, one per mounted titled panel. Dropped on
     *  dispose so the registry never answers "opened" for a panel that has been
     *  taken out of the DOM. */
    private panelUnregisters = new Map<string, () => void>();
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
     * Enable/disable `revealOn` gating for the next `load()`
     * (PLAN-metalstorm-onboarding.md §5). Disabled ⇒ every widget mounts at
     * load regardless of its predicate. Call before `load()`.
     */
    setProgressiveDisclosure(enabled: boolean): void {
        this.progressiveDisclosure = enabled;
    }

    /**
     * Load and mount all widgets for the given game.
     *
     * @param gameId - Game identifier (e.g., "metalstorm")
     * @param httpBase - HTTP base URL for fetching game data
     * @param playerId - Local **sim playerNum** (see WidgetContext.identity)
     * @param teamId - Local player's team ID
     * @param role - Session role ("player" / "spectator" / "admin"); gates
     *   `hideForSpectator` manifest entries (PLAN-metalstorm-onboarding §4).
     * @param accountId - Local DB account id (see WidgetContext.identity)
     */
    async load(
        gameId: string,
        httpBase: string,
        playerId: number,
        teamId: number,
        role: string = '',
        accountId: number = 0,
    ): Promise<void> {
        this.gameId = gameId;
        this.isSpectator = role === 'spectator';
        // Held on the instance rather than threaded through armReveal /
        // loadWidget: it is session-constant and only the ctx builder reads it.
        this.accountId = accountId;
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
        // The class vocabulary (PLAN-metalstorm-command-language.md §2) is a
        // sibling of the manifest in the same ui/ dir and is fetched with the
        // styles rather than after them — widgets that parse sentences read it
        // from the shared holder at mount, and a missing/failed vocabulary is
        // never fatal (an empty one costs keyword coverage, nothing else).
        classVocabulary.reset();
        await Promise.all([
            this.injectGameStyles(manifest.styles ?? [], baseUrl),
            loadClassVocabulary(gameId, httpBase),
        ]);
        if (stale()) return;

        // Load and mount each widget
        for (const descriptor of manifest.widgets) {
            if (stale()) return;
            if (this.isSpectator && descriptor.hideForSpectator) {
                console.log(`[widget-loader] Skipping ${descriptor.id} (spectator session)`);
                continue;
            }
            this.validateSubscribes(descriptor);
            try {
                // `revealOn` may defer the mount indefinitely; an immediate
                // widget is awaited so load() still resolves with the initial
                // HUD fully up (tests and the boot path both rely on that).
                if (!this.armReveal(descriptor, baseUrl, playerId, teamId, generation)) {
                    await this.loadWidget(descriptor, baseUrl, playerId, teamId);
                }
            } catch (e) {
                console.error(`[widget-loader] Failed to load widget ${descriptor.id}:`, e);
            }
        }
    }

    /** Warn on `subscribes` entries that name no real store path. */
    private validateSubscribes(descriptor: WidgetDescriptor): void {
        for (const path of descriptor.subscribes ?? []) {
            if (!KNOWN_STORE_PATHS.has(path)) {
                console.warn(
                    `[widget-loader] Widget ${descriptor.id} declares subscribes:"${path}", ` +
                    `which is not a ui-store path (typo?). Known: ${[...KNOWN_STORE_PATHS].join(', ')}`,
                );
            }
        }
    }

    /**
     * Apply `revealOn` (PLAN-native-ui.md §3): returns true if the mount was
     * deferred, false if the widget should be mounted now.
     *
     * Disclosure is one-way — once the predicate fires we mount and drop the
     * subscription, so a widget never disappears again mid-game.
     */
    private armReveal(
        descriptor: WidgetDescriptor,
        baseUrl: string,
        playerId: number,
        teamId: number,
        generation: number,
    ): boolean {
        if (!descriptor.revealOn || !this.progressiveDisclosure) return false;

        const predicate = parseRevealPredicate(descriptor.revealOn);
        if (!predicate) {
            // Fail *open*. A malformed predicate that hid the widget would be
            // an unreachable panel with no player-visible cause; a visible
            // panel plus a console warning is diagnosable.
            console.warn(
                `[widget-loader] Widget ${descriptor.id}: unparseable revealOn ` +
                `"${descriptor.revealOn}" — mounting immediately`,
            );
            return false;
        }

        const identity = { playerId, teamId };
        if (predicate.test(uiStore, identity)) return false;   // already true

        const unsubscribe = uiStore.subscribe([...predicate.paths], () => {
            if (this.generation !== generation) return;         // torn down mid-wait
            if (!predicate.test(uiStore, identity)) return;

            this.pendingReveals.get(descriptor.id)?.();
            this.pendingReveals.delete(descriptor.id);

            console.log(`[widget-loader] revealOn fired for ${descriptor.id} ("${predicate.source}")`);
            this.loadWidget(descriptor, baseUrl, playerId, teamId).catch((e) => {
                console.error(`[widget-loader] Deferred mount of ${descriptor.id} failed:`, e);
            });
        });

        this.pendingReveals.set(descriptor.id, unsubscribe);
        console.log(`[widget-loader] Widget ${descriptor.id} deferred on revealOn "${predicate.source}"`);
        return true;
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
    ): {
        body: HTMLElement;
        frame: HTMLElement;
        setBadge: (t: string | number | null) => void;
        /** Collapse/expand programmatically (the NL registry's open/close).
         *  No-op for a non-collapsible panel — see `setCollapsed` below. */
        setCollapsed: (collapsed: boolean) => void;
        isCollapsed: () => boolean;
    } {
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

        /**
         * Programmatic collapse. Goes through the same class + aria + settings
         * write the header click does, so "open the diplomacy panel" and clicking
         * its header leave the HUD in an identical state — including the sticky
         * preference, which is what makes a spoken "close the scoreboard" persist
         * the way a click does.
         *
         * A non-collapsible panel (no chrome toggle) reports itself permanently
         * open rather than pretending to close: the NL registry then echoes the
         * truth instead of "closed" for a panel still on screen.
         */
        let setCollapsed = (_collapsed: boolean): void => {};
        let isCollapsed = (): boolean => false;

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

            const apply = (nowCollapsed: boolean) => {
                frame.classList.toggle('is-collapsed', nowCollapsed);
                setExpanded(nowCollapsed);
                clientSettings.set(key, nowCollapsed);
            };

            head.addEventListener('click', () => apply(!frame.classList.contains('is-collapsed')));

            setCollapsed = apply;
            isCollapsed = () => frame.classList.contains('is-collapsed');
        }

        return {
            frame,
            body,
            setBadge: (t) => {
                badge.textContent = t === null || t === undefined ? '' : String(t);
            },
            setCollapsed,
            isCollapsed,
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
        // A revealOn mount can fire arbitrarily late, so re-check teardown here
        // as well as in the subscriber — the dynamic import below is itself a
        // window in which dispose() can land.
        const generation = this.generation;

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
        if (this.generation !== generation) return;
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
            identity: { playerId, teamId, accountId: this.accountId },
            sendCommand: this.createSendCommand(),
            strategicMap: this.createStrategicMapStub(),
            setBadge: panel ? panel.setBadge : () => {},
        };

        // Initialize widget
        try {
            widget.init(context);
            this.widgets.set(descriptor.id, { widget, context });
            if (panel) this.registerPanelActions(descriptor, panel);
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
     * Make a mounted panel addressable by name for the command language
     * (PLAN-metalstorm-command-language.md §6.3).
     *
     * The loader does this, not the widgets, for the same reason it owns the
     * chrome: collapse state IS open/closed for a manifest panel, and the loader
     * is what holds it. A widget registering itself would have to reach back
     * into chrome it doesn't own, and every game-authored widget would have to
     * remember to do it — so the panels a game ships would be addressable only
     * as often as their authors remembered.
     *
     * `fullscreen` is deliberately NOT provided: a rail panel has no such mode,
     * and the registry refuses "full screen" by name rather than quietly opening
     * it at rail width. The minimap, which does have one, registers from
     * `main.ts` where its overlay lives.
     */
    private registerPanelActions(
        descriptor: WidgetDescriptor,
        panel: { setCollapsed: (c: boolean) => void; isCollapsed: () => boolean },
    ): void {
        this.panelUnregisters.get(descriptor.id)?.();
        const unregister = uiActionRegistry.register({
            id: descriptor.id,
            label: descriptor.title ?? descriptor.id,
            aliases: descriptor.nlAliases ?? [],
            open: () => panel.setCollapsed(false),
            close: () => panel.setCollapsed(true),
            toggle: () => panel.setCollapsed(!panel.isCollapsed()),
            isOpen: () => !panel.isCollapsed(),
        });
        this.panelUnregisters.set(descriptor.id, unregister);
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
                    console.log('[widget-loader] setMarkers (stub):', markers);
                    warned = true;
                }
            },
        };
    }

    /**
     * Dispose all loaded widgets and clean up.
     */
    dispose(): void {
        this.generation++;

        // Drop revealOn watchers first: they hold ui-store subscriptions that
        // outlive the HUD otherwise, and would mount a widget into a torn-down
        // mount point on the next store change.
        for (const unsubscribe of this.pendingReveals.values()) {
            try { unsubscribe(); } catch { /* nothing useful to do */ }
        }
        this.pendingReveals.clear();

        for (const unregister of this.panelUnregisters.values()) {
            try { unregister(); } catch { /* nothing useful to do */ }
        }
        this.panelUnregisters.clear();

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
