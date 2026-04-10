/**
 * LuaWidget — loads and dispatches a single Spring-style Lua widget.
 *
 * A Spring widget is a Lua chunk that populates a global `widget` table
 * with callin functions: widget:Initialize, widget:Shutdown,
 * widget:GameFrame(f), widget:DrawScreen, widget:DrawWorldPreUnit,
 * widget:UnsyncedHeightMapUpdate(x1,z1,x2,z2), etc. The chunk may also
 * read a few other globals (Spring, gl, Game, GL, VFS) which the loader
 * must inject before running the chunk.
 *
 * This class owns one LuaRuntime per widget and provides typed methods
 * for dispatching the specific callins our renderer cares about. Other
 * callins can be added as needed.
 */
import { LuaRuntime, type LuaValue } from './lua-runtime.js';

export interface LuaWidgetInfo {
    name: string;
    desc?: string;
    author?: string;
    version?: string;
    layer?: number;
    enabled?: boolean;
}

export class LuaWidget {
    readonly runtime: LuaRuntime;
    readonly source: string;
    readonly fileName: string;
    info: LuaWidgetInfo | null = null;
    loaded = false;

    constructor(fileName: string, source: string) {
        this.fileName = fileName;
        this.source = source;
        this.runtime = new LuaRuntime(fileName);
    }

    /**
     * Install globals, run any game-level base files, and execute the
     * widget source. After this call, the widget's callins are available
     * via the dispatch methods below.
     *
     * Spring widgets expect a pre-existing `widget` table to attach
     * their callins to; we create it before executing the source.
     *
     * `gameBase` is a list of pre-fetched Lua chunks (game VFS files
     * like `LuaUI/widgets.lua`) to execute before the widget source.
     * These set up globals like WG and widgetHandler that the widget
     * may depend on. They're re-run for every widget because each
     * widget has its own Lua state.
     */
    load(
        globals: Record<string, LuaValue>,
        gameBase: { path: string; source: string }[] = [],
    ): string | null {
        // Create the widget table the source will populate.
        this.runtime.setGlobal('widget', {});
        // Install provided globals (Spring, gl, Game, GL, VFS, WG, ...).
        for (const [k, v] of Object.entries(globals)) {
            this.runtime.setGlobal(k, v);
        }
        // Run game base files first — these define widgetHandler, set
        // up default WG entries, LUAUI_DIRNAME, etc. Failures are
        // warnings, not fatals, so a partially-loadable game base
        // doesn't block every widget.
        for (const { path, source } of gameBase) {
            const baseErr = this.runtime.doString(source, path);
            if (baseErr) {
                console.warn(`[widget ${this.fileName}] game base ${path}: ${baseErr}`);
            }
        }
        const err = this.runtime.doString(this.source, this.fileName);
        if (err) return err;
        // Read back widget info if GetInfo is defined.
        if (this.runtime.hasTableFn('widget', 'GetInfo')) {
            const raw = this.runtime.callTableFn('widget', 'GetInfo');
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                this.info = raw as LuaWidgetInfo;
            }
        }
        this.loaded = true;
        return null;
    }

    // --- Callin dispatch ---

    initialize(): void {
        if (this.runtime.hasTableFn('widget', 'Initialize')) {
            this.runtime.callTableFn('widget', 'Initialize');
        }
    }

    shutdown(): void {
        if (this.runtime.hasTableFn('widget', 'Shutdown')) {
            this.runtime.callTableFn('widget', 'Shutdown');
        }
    }

    gameFrame(frame: number): void {
        if (this.runtime.hasTableFn('widget', 'GameFrame')) {
            this.runtime.callTableFn('widget', 'GameFrame', frame);
        }
    }

    drawScreen(): void {
        if (this.runtime.hasTableFn('widget', 'DrawScreen')) {
            this.runtime.callTableFn('widget', 'DrawScreen');
        }
    }

    drawWorldPreUnit(): void {
        if (this.runtime.hasTableFn('widget', 'DrawWorldPreUnit')) {
            this.runtime.callTableFn('widget', 'DrawWorldPreUnit');
        }
    }

    drawWorld(): void {
        if (this.runtime.hasTableFn('widget', 'DrawWorld')) {
            this.runtime.callTableFn('widget', 'DrawWorld');
        }
    }

    unsyncedHeightMapUpdate(x1: number, z1: number, x2: number, z2: number): void {
        if (this.runtime.hasTableFn('widget', 'UnsyncedHeightMapUpdate')) {
            this.runtime.callTableFn('widget', 'UnsyncedHeightMapUpdate', x1, z1, x2, z2);
        }
    }

    dispose(): void {
        this.shutdown();
        this.runtime.dispose();
    }
}
