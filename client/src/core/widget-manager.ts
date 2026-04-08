/**
 * WidgetManager — manages client-side widgets (Lua and JS).
 *
 * Per PLAN-scripting.md, widgets are client-side scripts that respond to
 * game events for UI, visual effects, and player assistance. They run in
 * the browser and have no access to synced game state beyond what the
 * server streams.
 *
 * The widget system supports both Lua (via WASM, future) and native JS
 * widgets. JS widgets are preferred for new development as they avoid
 * the WASM overhead.
 *
 * Event dispatch chain: game event → widget hooks → render
 */

import type { EntityStateSnapshot } from './entity-state.js';
import type { CombatEventInfo } from './connection.js';

/** Interface for a client-side widget. */
export interface Widget {
    /** Unique widget name. */
    name: string;

    /** Widget description. */
    description?: string;

    /** Load priority (lower = loaded first). */
    order?: number;

    /** Called when the widget is activated. */
    onActivate?(): void;

    /** Called when the widget is deactivated. */
    onDeactivate?(): void;

    /** Called every render frame with delta time in seconds. */
    onUpdate?(dt: number): void;

    /** Called when entity state is received from server. */
    onEntityState?(snapshot: EntityStateSnapshot, isDelta: boolean): void;

    /** Called when combat events arrive. */
    onCombatEvents?(events: CombatEventInfo[], frame: number): void;

    /** Called on game frame (from server). */
    onGameFrame?(frame: number): void;

    /** Called on key press. Return true to consume the event. */
    onKeyPress?(key: string, ctrl: boolean, alt: boolean, shift: boolean): boolean;

    /** Called on mouse click. Return true to consume. */
    onMousePress?(x: number, y: number, button: number): boolean;
}

export class WidgetManager {
    private widgets: Widget[] = [];
    private activeWidgets = new Set<string>();

    /** Register a widget. */
    addWidget(widget: Widget): void {
        this.widgets.push(widget);
        // Sort by order (lower first)
        this.widgets.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    }

    /** Activate a widget by name. */
    activate(name: string): boolean {
        const widget = this.widgets.find(w => w.name === name);
        if (!widget || this.activeWidgets.has(name)) return false;
        this.activeWidgets.add(name);
        widget.onActivate?.();
        return true;
    }

    /** Deactivate a widget by name. */
    deactivate(name: string): boolean {
        const widget = this.widgets.find(w => w.name === name);
        if (!widget || !this.activeWidgets.has(name)) return false;
        this.activeWidgets.delete(name);
        widget.onDeactivate?.();
        return true;
    }

    /** Activate all registered widgets. */
    activateAll(): void {
        for (const w of this.widgets) this.activate(w.name);
    }

    /** Dispatch update to all active widgets. */
    update(dt: number): void {
        for (const w of this.widgets) {
            if (this.activeWidgets.has(w.name))
                w.onUpdate?.(dt);
        }
    }

    /** Dispatch entity state to all active widgets. */
    entityState(snapshot: EntityStateSnapshot, isDelta: boolean): void {
        for (const w of this.widgets) {
            if (this.activeWidgets.has(w.name))
                w.onEntityState?.(snapshot, isDelta);
        }
    }

    /** Dispatch combat events to all active widgets. */
    combatEvents(events: CombatEventInfo[], frame: number): void {
        for (const w of this.widgets) {
            if (this.activeWidgets.has(w.name))
                w.onCombatEvents?.(events, frame);
        }
    }

    /** Dispatch key press. Returns true if any widget consumed it. */
    keyPress(key: string, ctrl: boolean, alt: boolean, shift: boolean): boolean {
        for (const w of this.widgets) {
            if (this.activeWidgets.has(w.name) && w.onKeyPress?.(key, ctrl, alt, shift))
                return true;
        }
        return false;
    }

    /** Get all registered widget names and their active state. */
    list(): { name: string; active: boolean; description?: string }[] {
        return this.widgets.map(w => ({
            name: w.name,
            active: this.activeWidgets.has(w.name),
            description: w.description,
        }));
    }

    get activeCount(): number {
        return this.activeWidgets.size;
    }
}
