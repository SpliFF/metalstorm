/**
 * global-surface.ts — the ONE access point (DESIGN-DRILLDOWN.md §6, rung 4)
 *
 * > Global battle options behind one access point: statistics, detailed
 * > reports, events, objectives, diplomacy.
 *
 * U0 designed this and did not build it; U1 and U2 both had to say "the rung-4
 * access point is still unbuilt" and leave content homeless because of it. This
 * is it: one labelled control in the `top-right` dock, one key (`Tab`), and one
 * surface with a tab strip. Rung 4 is the only rung with no size budget,
 * because it is the only rung the player is *only* looking at.
 *
 * ── This is a REMOVAL, and that is the point ──
 *
 * §7's audit says `scoreboard-panel`, `parley-panel` and `ai-command-panel`
 * fold to rung 4 and leave the rails entirely. They now do, by declaring
 * `mount: "menu:statistics" | "menu:diplomacy" | "menu:reports"` in the game
 * manifest — the loader routes those to a pane in here instead of to a rail.
 * That is deliberately a MOUNT change and not a new widget API: a panel that
 * lives behind the access point is the same panel, docked somewhere else, and
 * anything more would have meant rewriting three working widgets to move them.
 *
 * §6's rule "if a surface is in the tab strip it is not also a rail panel" is
 * therefore enforced by construction — a widget has exactly one `mount`.
 *
 * ── The one permitted leak ──
 *
 * A single always-visible line beside the access point: the victory condition's
 * current state. It is here rather than resident anywhere else because it
 * changes what the player does next, and it drills into the Objectives tab
 * rather than carrying its own detail. `setSummaryLine` is how its owner (the
 * objective HUD, which is the one thing that parses objectives) fills it; the
 * surface never derives it, so there is still exactly one reader of the
 * objective wire.
 *
 * ── Not in the DOM when it is not open ──
 *
 * Rule 6 of §9. The access point is one button; the panel body is built on open
 * and emptied on close, EXCEPT for the panes, which have to persist because
 * manifest widgets are mounted into them once at load. So the panes are kept
 * and the surface is hidden — which is the same `display:none` a collapsed rail
 * panel already gets, and costs nothing while closed.
 */

import { uiActionRegistry } from './ui-action-registry.js';
import { focusModel } from './focus-model.js';

/** The tabs, in the order §6 names them. A tab whose pane is empty after the
 *  widgets have loaded renders no button — a tab that opens onto nothing is
 *  the dead end §3 forbids for a focus kind, in another costume. */
export const GLOBAL_TABS = [
    { id: 'statistics', label: 'Statistics' },
    { id: 'reports', label: 'Reports' },
    { id: 'events', label: 'Events' },
    { id: 'objectives', label: 'Objectives' },
    { id: 'diplomacy', label: 'Diplomacy' },
] as const;

export type GlobalTabId = typeof GLOBAL_TABS[number]['id'];

/** `mount: "menu:events"` → `"events"`; anything else → null. */
export function parseMenuMount(mount: string): GlobalTabId | null {
    if (!mount.startsWith('menu:')) return null;
    const id = mount.slice(5);
    return GLOBAL_TABS.some((t) => t.id === id) ? (id as GlobalTabId) : null;
}

/** The surface id recorded in `focusModel.openSurfaces`, so story 4's
 *  "close that" has something to bind to. */
export const GLOBAL_SURFACE_ID = 'battle-menu';

class GlobalSurface {
    private root: HTMLElement | null = null;
    private button: HTMLButtonElement | null = null;
    private summary: HTMLButtonElement | null = null;
    private panel: HTMLElement | null = null;
    private tabStrip: HTMLElement | null = null;
    private panes = new Map<GlobalTabId, HTMLElement>();
    private tabButtons = new Map<GlobalTabId, HTMLButtonElement>();
    private active: GlobalTabId = 'events';
    private open_ = false;
    private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
    private unregister: Array<() => void> = [];

    /** True once `mount` has run for this session. */
    get mounted(): boolean { return this.root !== null; }
    isOpen(): boolean { return this.open_; }

    /**
     * Build the access point into `dock` and the surface into `overlayHost`.
     * Idempotent — a re-mount (a resync) tears the old one down first.
     */
    mount(dock: HTMLElement, overlayHost: HTMLElement): void {
        this.dispose();

        const cluster = document.createElement('div');
        cluster.className = 'nui-access';

        // The one permitted always-visible line (§6). Empty and hidden until
        // its owner fills it — an empty line reserved "for later" is clutter
        // that reports nothing.
        const summary = document.createElement('button');
        summary.type = 'button';
        summary.className = 'nui-access__summary';
        summary.hidden = true;
        this.summary = summary;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nui-access__btn';
        button.textContent = 'Battle ▾';
        button.title = 'Statistics, reports, events, objectives, diplomacy (Tab)';
        button.addEventListener('click', () => this.toggle());
        this.button = button;

        cluster.append(summary, button);
        dock.append(cluster);

        const panel = document.createElement('div');
        panel.className = 'nui-global';
        panel.hidden = true;

        const header = document.createElement('div');
        header.className = 'nui-global__header';
        const strip = document.createElement('div');
        strip.className = 'nui-global__tabs';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'nui-global__close';
        close.textContent = '✕';
        close.title = 'Close (Esc)';
        close.addEventListener('click', () => this.close());
        header.append(strip, close);

        const body = document.createElement('div');
        body.className = 'nui-global__body';

        for (const tab of GLOBAL_TABS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nui-global__tab';
            btn.dataset.tab = tab.id;
            btn.textContent = tab.label;
            btn.hidden = true;                   // until something mounts here
            btn.addEventListener('click', () => this.open(tab.id));
            strip.append(btn);
            this.tabButtons.set(tab.id, btn);

            const pane = document.createElement('div');
            pane.className = 'nui-global__pane';
            pane.dataset.tab = tab.id;
            pane.hidden = true;
            body.append(pane);
            this.panes.set(tab.id, pane);
        }

        panel.append(header, body);
        overlayHost.append(panel);
        this.panel = panel;
        this.tabStrip = strip;
        this.root = cluster;

        // Tab opens/closes; Esc closes. Both in the CAPTURE phase and both
        // consumed, for the reason drilldown.ts documents: main.ts has a global
        // Escape handler that opens the quit dialog, and a surface that closes
        // AND quits is worse than one that does neither.
        this.onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const typing = target
                && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
                    || target.isContentEditable);
            if (typing) return;
            if (e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                this.toggle();
            } else if (e.key === 'Escape' && this.open_) {
                e.preventDefault();
                e.stopPropagation();
                this.close();
            }
        };
        document.addEventListener('keydown', this.onKeyDown, true);

        // Every tab is addressable by name, so "open the diplomacy panel"
        // reaches the TAB rather than a rail panel that no longer exists.
        for (const tab of GLOBAL_TABS) {
            this.unregister.push(uiActionRegistry.register({
                id: `menu-${tab.id}`,
                label: `${tab.label} tab`,
                aliases: [tab.label, tab.id],
                open: () => this.open(tab.id),
                close: () => this.close(),
                toggle: () => (this.open_ && this.active === tab.id
                    ? this.close() : this.open(tab.id)),
                isOpen: () => this.open_ && this.active === tab.id,
            }));
        }
    }

    /** The mount point for `mount: "menu:<tab>"`. Null before `mount()`. */
    paneFor(tab: GlobalTabId): HTMLElement | null {
        return this.panes.get(tab) ?? null;
    }

    /**
     * Reveal only the tabs that something actually mounted into. Called by the
     * loader once every widget has loaded — before that, a pane being empty
     * only means its widget has not arrived yet.
     */
    settle(): void {
        let firstLive: GlobalTabId | null = null;
        for (const tab of GLOBAL_TABS) {
            const pane = this.panes.get(tab.id);
            const live = !!pane && pane.childElementCount > 0;
            const btn = this.tabButtons.get(tab.id);
            if (btn) btn.hidden = !live;
            if (live && !firstLive) firstLive = tab.id;
        }
        if (firstLive) this.active = firstLive;
        // Nothing folded in here ⇒ no access point at all. A button that opens
        // an empty window teaches a new player the UI is broken.
        const any = firstLive !== null;
        if (this.button) this.button.hidden = !any;
    }

    open(tab?: GlobalTabId): void {
        if (!this.panel) return;
        if (tab) this.active = tab;
        this.open_ = true;
        this.panel.hidden = false;
        for (const [id, pane] of this.panes) pane.hidden = id !== this.active;
        for (const [id, btn] of this.tabButtons) {
            btn.classList.toggle('is-active', id === this.active);
        }
        this.button?.classList.add('is-open');
        focusModel.openSurface(GLOBAL_SURFACE_ID);
    }

    close(): void {
        if (!this.panel) return;
        this.open_ = false;
        this.panel.hidden = true;
        this.button?.classList.remove('is-open');
        focusModel.closeSurface(GLOBAL_SURFACE_ID);
    }

    toggle(): void { this.open_ ? this.close() : this.open(); }

    /**
     * Fill the one always-visible line (§6). Pass null to hide it — which is
     * what a scenario with no victory condition on the wire gets, rather than
     * a line saying nothing.
     */
    setSummaryLine(text: string | null, opts: { title?: string } = {}): void {
        const el = this.summary;
        if (!el) return;
        if (!text) { el.hidden = true; el.textContent = ''; return; }
        el.hidden = false;
        el.textContent = text;
        el.title = opts.title ?? 'Open the objectives';
        el.onclick = () => this.open('objectives');
    }

    dispose(): void {
        if (this.onKeyDown) {
            document.removeEventListener('keydown', this.onKeyDown, true);
            this.onKeyDown = null;
        }
        for (const un of this.unregister) un();
        this.unregister = [];
        this.panel?.remove();
        this.root?.remove();
        this.panel = null;
        this.root = null;
        this.button = null;
        this.summary = null;
        this.tabStrip = null;
        this.panes.clear();
        this.tabButtons.clear();
        this.open_ = false;
    }
}

/** The session's one global surface. */
export const globalSurface = new GlobalSurface();
