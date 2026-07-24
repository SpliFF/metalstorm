/**
 * widget-loader.ts — Metalstorm native JS widget loader (PLAN-native-ui.md §3)
 *
 * Fetches the game's metalstorm.ui.json manifest, dynamically imports its
 * widgets/*.js modules, mounts them at their declared mount points, and
 * provides each with the widget context (store, identity, sendCommand,
 * strategicMap).
 *
 * This is a NEW dynamic widget-import path separate from the existing
 * client/src/ui/game/loader.ts (which loads CSS/HTML template overrides).
 */

import { uiStore, type UIStore } from './ui-store.js';
import { stampUrl } from '../../config.js';

export interface WidgetManifest {
    game: string;
    uiVersion: number;
    widgets: WidgetDescriptor[];
}

export interface WidgetDescriptor {
    id: string;
    entry: string;           // Relative path like "widgets/authority-bar.js"
    mount: string;           // Mount point: "top-center", "right", "left", etc.
    subscribes?: string[];   // Store paths this widget subscribes to
    revealOn?: string;       // Progressive disclosure predicate (not impl yet)
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
}

export interface Widget {
    id: string;
    init(ctx: WidgetContext): void;
    dispose(): void;
    showRefusalToast?: (cost: number) => void;  // authority-bar specific method
}

/**
 * WidgetLoader manages the lifecycle of native JS widgets for a game.
 *
 * It fetches the manifest, creates mount points, imports and initializes
 * widgets, and handles cleanup on game exit.
 */
export class WidgetLoader {
    private widgets = new Map<string, { widget: Widget; context: WidgetContext }>();
    private mountPoints = new Map<string, HTMLElement>();
    private uiRoot: HTMLElement | null = null;
    private sendCommandProvider: ((cmd: any) => void) | null = null;

    /**
     * Load and mount all widgets for the given game.
     *
     * @param gameId - Game identifier (e.g., "metalstorm")
     * @param httpBase - HTTP base URL for fetching game data
     * @param playerId - Local player ID
     * @param teamId - Local player's team ID
     */
    async load(
        gameId: string,
        httpBase: string,
        playerId: number,
        teamId: number,
    ): Promise<void> {
        // Fetch the widget manifest
        const manifest = await this.fetchManifest(gameId, httpBase);
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

        // Load and mount each widget
        const baseUrl = `${httpBase}/api/games/data/${encodeURIComponent(gameId)}/ui`;
        for (const descriptor of manifest.widgets) {
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
            const url = stampUrl(
                `${httpBase}/api/games/data/${encodeURIComponent(gameId)}/ui/metalstorm.ui.json`
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
                mount.style.cssText = 'pointer-events: auto;';
                this.uiRoot.appendChild(mount);
            }
            this.mountPoints.set(id, mount);
        }

        // Apply default positioning styles if not already styled
        this.applyDefaultMountStyles();
    }

    /**
     * Apply default CSS positioning for mount points.
     * Games can override these via their own CSS.
     */
    private applyDefaultMountStyles(): void {
        if (!this.uiRoot) return;

        const styleId = 'ui-mount-styles';
        if (document.getElementById(styleId)) return; // Already applied

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .ui-mount {
                position: absolute;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ui-mount-top-left { top: 8px; left: 8px; align-items: flex-start; }
            .ui-mount-top-center { top: 8px; left: 50%; transform: translateX(-50%); align-items: center; }
            .ui-mount-top-right { top: 8px; right: 8px; align-items: flex-end; }
            .ui-mount-left { top: 50%; left: 8px; transform: translateY(-50%); align-items: flex-start; }
            .ui-mount-center { top: 50%; left: 50%; transform: translate(-50%, -50%); align-items: center; }
            .ui-mount-right { top: 50%; right: 8px; transform: translateY(-50%); align-items: flex-end; }
            .ui-mount-bottom-left { bottom: 8px; left: 8px; align-items: flex-start; }
            .ui-mount-bottom-center { bottom: 8px; left: 50%; transform: translateX(-50%); align-items: center; }
            .ui-mount-bottom-right { bottom: 8px; right: 8px; align-items: flex-end; }
        `;
        document.head.appendChild(style);
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

        // Dynamic import of the widget module
        const widgetUrl = stampUrl(`${baseUrl}/${descriptor.entry}`);
        const module = await import(/* @vite-ignore */ widgetUrl);
        const widget = module.default as Widget;

        if (!widget || typeof widget.init !== 'function') {
            console.error(`[widget-loader] Widget ${descriptor.id} has no init() method`);
            return;
        }

        // Create widget context
        const context: WidgetContext = {
            store: uiStore,
            mount: mountElement,
            identity: { playerId, teamId },
            sendCommand: this.createSendCommand(),
            strategicMap: this.createStrategicMapStub(),
        };

        // Initialize widget
        try {
            widget.init(context);
            this.widgets.set(descriptor.id, { widget, context });
            console.log(`[widget-loader] Mounted widget ${descriptor.id} at ${descriptor.mount}`);
        } catch (e) {
            console.error(`[widget-loader] Widget ${descriptor.id} init() failed:`, e);
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
        for (const [id, { widget }] of this.widgets.entries()) {
            try {
                widget.dispose();
                console.log(`[widget-loader] Disposed widget ${id}`);
            } catch (e) {
                console.error(`[widget-loader] Widget ${id} dispose() failed:`, e);
            }
        }
        this.widgets.clear();

        // Clean up mount points
        for (const mount of this.mountPoints.values()) {
            mount.remove();
        }
        this.mountPoints.clear();

        // Remove mount point styles
        const styleEl = document.getElementById('ui-mount-styles');
        if (styleEl) {
            styleEl.remove();
        }
    }

    /**
     * Get a loaded widget by ID (for programmatic access, e.g., showing refusal toasts).
     */
    getWidget(id: string): Widget | undefined {
        return this.widgets.get(id)?.widget;
    }
}
