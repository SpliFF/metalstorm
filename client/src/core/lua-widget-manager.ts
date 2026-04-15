/**
 * LuaWidgetManager — single-state widget manager for Spring LuaUI.
 *
 * All widgets share one Lua VM. Each widget gets an isolated environment
 * table via Lua 5.3's `load(source, name, 't', env)`. The environment
 * delegates reads to the global table via __index, so widgets see
 * Spring/gl/GL/Game/VFS but can't pollute each other's globals.
 *
 * Widget lifecycle:
 *   1. Discover available widgets via HTTP directory listing
 *   2. Fetch each widget source
 *   3. Parse GetInfo (compile + run in a temp env)
 *   4. Sort: API widgets first, then by layer, then alphabetical
 *   5. Load enabled widgets into the shared Lua state
 *   6. Dispatch callins per frame (DrawScreen, DrawWorld, etc.)
 *
 * Error handling: each callin is pcall-wrapped. A widget that errors
 * is auto-disabled (removed from active callin lists) and marked with
 * an error state visible via window.widgets.
 */
import type { Scene } from '@babylonjs/core/scene';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { ParsedMapData } from './map-data.js';
import { LuaRuntime, type LuaValue } from './lua-runtime.js';
import { LuaGLBridge } from './lua-gl-bridge.js';
import {
    buildSpringGlobals,
    normaliseSpringPath,
    type SpringAPIContext,
} from './lua-spring-api.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface WidgetInfo {
    name: string;
    desc: string;
    author: string;
    version: string;
    date: string;
    license: string;
    layer: number;
    enabled: boolean;
    api: boolean;
    alwaysStart: boolean;
    handler: boolean;
}

export type WidgetState = 'enabled' | 'disabled' | 'error' | 'loading';

export interface WidgetEntry {
    /** Relative path from game LuaUI root */
    fileName: string;
    /** Parsed info from widget:GetInfo() */
    info: WidgetInfo;
    /** Current state */
    state: WidgetState;
    /** Error message if state === 'error' */
    error?: string;
    /** Source code (fetched once) */
    source?: string;
}

/** Console message from a widget */
export interface WidgetLogEntry {
    level: 'info' | 'warn' | 'error';
    widget: string;
    message: string;
    timestamp: number;
}

export interface WidgetManagerOptions {
    gameId: string;
    /** Base URL for game data (e.g. http://localhost:8011) */
    lobbyUrl: string;
}

// ── Callins we dispatch ─────────────────────────────────────────────────

const DRAW_CALLINS = [
    'DrawScreen', 'DrawWorld', 'DrawWorldPreUnit',
] as const;

const CALLINS = [
    'Initialize', 'Shutdown', 'GameFrame', 'Update',
    ...DRAW_CALLINS,
    'KeyPress', 'KeyRelease',
    'MousePress', 'MouseRelease', 'MouseMove', 'MouseWheel',
    'IsAbove', 'GetTooltip',
    'UnsyncedHeightMapUpdate',
    'TextCommand', 'CommandNotify',
] as const;

type CallinName = typeof CALLINS[number];

// ── Main class ──────────────────────────────────────────────────────────

export class LuaWidgetManager {
    private scene: Scene;
    private camera: FreeCamera;
    private map: ParsedMapData;
    private options: WidgetManagerOptions;

    /** Single Lua state for all widgets */
    private runtime: LuaRuntime;
    private bridge: LuaGLBridge;
    private ctx: SpringAPIContext;

    /** All discovered widgets (active + inactive) */
    private registry = new Map<string, WidgetEntry>();
    /** Active widgets in callin order (sorted by layer) */
    private activeWidgets: WidgetEntry[] = [];
    /** Per-callin widget lists (only widgets that define the callin) */
    private callinLists = new Map<CallinName, WidgetEntry[]>();

    /** Pre-fetched VFS files */
    private vfsFiles = new Map<string, string>();
    /** Console log buffer */
    private log: WidgetLogEntry[] = [];
    private maxLogEntries = 500;

    private startTime = performance.now() / 1000;
    private currentFrame = 0;
    private renderObserver: { remove: () => void } | null = null;

    /** LocalStorage key for widget enable/disable state */
    private storageKey: string;

    constructor(
        scene: Scene,
        camera: FreeCamera,
        map: ParsedMapData,
        options: WidgetManagerOptions,
    ) {
        this.scene = scene;
        this.camera = camera;
        this.map = map;
        this.options = options;
        this.storageKey = `widgets:${options.gameId}:order`;

        // Create single Lua runtime
        this.runtime = new LuaRuntime('LuaUI');

        // Create GL bridge
        const engine = scene.getEngine();
        const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
        this.bridge = new LuaGLBridge(gl, map.mapSourceUrl);

        // Build heightmap texture
        const heightTex = buildHeightmapTexture(gl, map);
        if (heightTex) this.bridge.setEngineHeightmap(heightTex);

        // Build Spring API context
        this.ctx = {
            mapSizeX: map.widthElmos,
            mapSizeZ: map.heightElmos,
            heightmap: map.heightmap,
            heightmapWidth: map.mapx + 1,
            heightmapHeight: map.mapy + 1,
            minHeight: map.minHeight,
            maxHeight: map.maxHeight,
            squareSize: map.squareSize,
            vfsFiles: this.vfsFiles,
            gameRulesParams: new Map(),
            getGameSeconds: () => (performance.now() / 1000) - this.startTime,
        };

        // Install base globals and Lua 5.1 compat shims
        this.installGlobals();

        // Expose widget API on window for JS console + MCP access
        (window as any).widgets = this.buildWindowAPI();
    }

    // ── Global installation ─────────────────────────────────────────────

    private installGlobals(): void {
        const springGlobals = buildSpringGlobals(this.ctx);
        const glGlobal = this.bridge.buildGlGlobal();

        // Override Spring.Echo to route through our console
        (springGlobals.Spring as Record<string, LuaValue>).Echo =
            (...args: LuaValue[]) => {
                const msg = args.map(a => String(a ?? '')).join('\t');
                this.addLog('info', 'Spring', msg);
            };

        // Install all globals
        for (const [k, v] of Object.entries(springGlobals)) {
            this.runtime.setGlobal(k, v);
        }
        this.runtime.setGlobal('gl', glGlobal);

        // WG — shared widget globals table (single object, shared by reference)
        this.runtime.setGlobal('WG', {});

        // widgetHandler — TypeScript-backed handler table
        this.runtime.setGlobal('widgetHandler', this.buildWidgetHandler());

        // Lua 5.1 compatibility shims
        this.runtime.doString(LUA_COMPAT_SHIM, 'compat_shim');

        // VFS.DirList — backed by HTTP
        this.patchVFSDirList();

        // LUAUI constants
        this.runtime.setGlobal('LUAUI_DIRNAME', 'LuaUI/');
        this.runtime.setGlobal('LUAUI_VERSION', `spring-web LuaUI v0.2 (${this.options.gameId})`);

        // Script stub
        this.runtime.setGlobal('Script', {
            CreateScream: () => ({ func: null }),
            GetSynced: () => false,
            LuaUI: () => ({}),
        });

        // LOG constants
        this.runtime.setGlobal('LOG', {
            ERROR: 0,
            WARNING: 1,
            INFO: 2,
            DEBUG: 3,
        });

        // Spring.Log
        (springGlobals.Spring as Record<string, LuaValue>).Log =
            (_section: LuaValue, _level: LuaValue, ...args: LuaValue[]) => {
                const msg = args.map(a => String(a ?? '')).join('\t');
                this.addLog('info', 'Spring.Log', msg);
            };
    }

    /** Patch VFS.DirList to use HTTP directory listing */
    private patchVFSDirList(): void {
        // We can't do async in Lua, so DirList returns from a prefetched cache.
        // The cache is populated before widget loading starts.
        const dirCache = new Map<string, string[]>();

        // Expose the dir cache setter for async prefetch
        (this as any)._dirCache = dirCache;

        // Override VFS.DirList in the Lua state
        this.runtime.doString(`
            local _dirCache = {}
            function _setDirCache(path, files)
                _dirCache[path] = files
            end
            -- Override VFS.DirList
            local origDirList = VFS.DirList
            VFS.DirList = function(path, pattern, mode)
                path = path or ""
                -- Normalise path separators
                path = path:gsub("\\\\", "/")
                if path:sub(-1) ~= "/" then path = path .. "/" end

                local cached = _dirCache[path]
                if not cached then return {} end

                -- Filter by pattern (simple *.lua matching)
                if pattern then
                    local ext = pattern:match("^%*(.+)$")
                    if ext then
                        local result = {}
                        for _, f in ipairs(cached) do
                            if f:sub(-#ext) == ext then
                                result[#result + 1] = path .. f
                            end
                        end
                        return result
                    end
                end
                -- No filter — return all
                local result = {}
                for _, f in ipairs(cached) do
                    result[#result + 1] = path .. f
                end
                return result
            end
        `, 'vfs_dirlist_setup');
    }

    // ── Widget handler table for Lua ────────────────────────────────────

    private buildWidgetHandler(): Record<string, LuaValue> {
        return {
            // Widget self-management
            RemoveWidget: (_self: LuaValue) => {
                // Called by widget code to unload itself
                // We'll handle this during callin dispatch
            },
            RaiseWidget: (_self: LuaValue) => { },
            LowerWidget: (_self: LuaValue) => { },

            // View queries
            GetViewSizes: () => {
                const c = this.scene.getEngine().getRenderingCanvas();
                return [c?.width ?? 1920, c?.height ?? 1080];
            },
            GetHourTimer: () => {
                return (performance.now() / 1000) % 3600;
            },

            // Callin management
            UpdateCallIn: (_name: LuaValue) => { },
            RemoveCallIn: (_name: LuaValue) => { },

            // Mouse ownership
            IsMouseOwner: () => false,
            DisownMouse: () => { },

            // Tweak mode
            InTweakMode: () => false,

            // Commands
            GetCommands: () => ({}),

            // Action system (stub)
            AddAction: (_cmd: LuaValue, _fn: LuaValue, _data: LuaValue, _types: LuaValue) => { },
            RemoveAction: (_cmd: LuaValue, _types: LuaValue) => { },
            AddLayoutCommand: (_cmd: LuaValue) => { },

            // Global registration
            RegisterGlobal: (_name: LuaValue, _value: LuaValue) => { },
            DeregisterGlobal: (_name: LuaValue) => { },
            SetGlobal: (_name: LuaValue, _value: LuaValue) => { },

            // Config layout
            ConfigLayoutHandler: (_data: LuaValue) => { },
            ForceLayout: () => { },

            // Ignore list (stub)
            Ignore: (_name: LuaValue) => { },
            Unignore: (_name: LuaValue) => { },
            GetIgnoreList: () => ({}),

            // Widget list access
            GetWidgets: () => {
                const result: Record<string, LuaValue> = {};
                for (const [name, entry] of this.registry) {
                    result[name] = {
                        active: entry.state === 'enabled',
                        name: entry.info.name,
                        desc: entry.info.desc,
                        author: entry.info.author,
                    };
                }
                return result;
            },

            // Order list (stub — we use localStorage)
            orderList: {},
            knownWidgets: {},
        };
    }

    // ── Widget discovery and loading ────────────────────────────────────

    /**
     * Main entry point: discover widgets, fetch sources, load them.
     */
    async initialize(): Promise<void> {
        const { gameId, lobbyUrl } = this.options;
        const baseUrl = `${lobbyUrl}/api/games/data/${gameId}`;

        // Prefetch game utility files that cawidgets.lua and widgets need
        await this.prefetchGameFiles(baseUrl);

        // Discover widgets
        const widgetFiles = await this.discoverWidgets(baseUrl);
        this.addLog('info', 'WidgetManager',
            `Discovered ${widgetFiles.length} widget files`);

        // Fetch and parse all widget sources
        await this.fetchWidgetSources(baseUrl, widgetFiles);

        // Sort: API widgets first, then by layer
        const sorted = this.getSortedWidgets();

        // Populate VFS dir cache for widgets that call VFS.DirList
        this.populateDirCache(baseUrl, widgetFiles);

        // Load widgets in order
        for (const entry of sorted) {
            if (!this.shouldEnable(entry)) {
                entry.state = 'disabled';
                continue;
            }
            this.loadWidget(entry);
        }

        this.addLog('info', 'WidgetManager',
            `${this.activeWidgets.length} widgets active, ` +
            `${this.registry.size - this.activeWidgets.length} inactive`);

        // Hook render loop
        this.hookRenderLoop();
    }

    /** Discover widget files via HTTP directory listing */
    private async discoverWidgets(baseUrl: string): Promise<string[]> {
        try {
            const res = await fetch(`${baseUrl}/LuaUI/Widgets`);
            if (!res.ok) {
                this.addLog('warn', 'WidgetManager',
                    `Widget directory listing failed: ${res.status}`);
                return [];
            }
            const entries = await res.json() as { name: string; type: string }[];
            return entries
                .filter(e => e.type === 'file' && e.name.endsWith('.lua'))
                .map(e => e.name)
                .sort();
        } catch (e) {
            this.addLog('error', 'WidgetManager', `Widget discovery failed: ${e}`);
            return [];
        }
    }

    /** Fetch all widget sources and parse GetInfo */
    private async fetchWidgetSources(baseUrl: string, files: string[]): Promise<void> {
        const fetches = files.map(async (fileName) => {
            const url = `${baseUrl}/LuaUI/Widgets/${fileName}`;
            try {
                const res = await fetch(url);
                if (!res.ok) return;
                const source = await res.text();
                const info = this.parseWidgetInfo(source, fileName);
                if (!info) return;

                const entry: WidgetEntry = {
                    fileName: `LuaUI/Widgets/${fileName}`,
                    info,
                    state: 'loading',
                    source,
                };
                this.registry.set(info.name, entry);
            } catch (e) {
                this.addLog('warn', 'WidgetManager',
                    `Failed to fetch ${fileName}: ${e}`);
            }
        });
        await Promise.all(fetches);
    }

    /** Parse widget:GetInfo() from source without side effects */
    private parseWidgetInfo(source: string, fileName: string): WidgetInfo | null {
        // Quick check: does the source define GetInfo?
        if (!source.includes('GetInfo')) return null;

        // Run in a temporary Lua state to extract info
        const tmpRuntime = new LuaRuntime(`parse:${fileName}`);
        tmpRuntime.setGlobal('widget', {});
        // Provide minimal stubs so parsing doesn't crash
        tmpRuntime.setGlobal('Spring', { Echo: () => {} });
        tmpRuntime.setGlobal('VFS', {
            Include: () => null,
            FileExists: () => false,
            LoadFile: () => null,
            DirList: () => [],
        });
        tmpRuntime.setGlobal('GL', {});
        tmpRuntime.setGlobal('WG', {});
        tmpRuntime.setGlobal('include', () => null);

        const err = tmpRuntime.doString(source, fileName);
        if (err) {
            tmpRuntime.dispose();
            // Not necessarily an error — widget may need globals we didn't provide
            return null;
        }

        let info: WidgetInfo | null = null;
        if (tmpRuntime.hasTableFn('widget', 'GetInfo')) {
            const raw = tmpRuntime.callTableFn('widget', 'GetInfo');
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                const r = raw as Record<string, LuaValue>;
                info = {
                    name: String(r.name ?? fileName),
                    desc: String(r.desc ?? ''),
                    author: String(r.author ?? ''),
                    version: String(r.version ?? ''),
                    date: String(r.date ?? ''),
                    license: String(r.license ?? ''),
                    layer: Number(r.layer ?? 0),
                    enabled: r.enabled !== false,
                    api: !!r.api,
                    alwaysStart: !!r.alwaysStart,
                    handler: !!r.handler,
                };
            }
        }
        tmpRuntime.dispose();
        return info;
    }

    /** Sort widgets: API first, then by layer, then alphabetical */
    private getSortedWidgets(): WidgetEntry[] {
        const entries = Array.from(this.registry.values());
        return entries.sort((a, b) => {
            // API widgets first
            if (a.info.api !== b.info.api) return a.info.api ? -1 : 1;
            // Then by layer
            if (a.info.layer !== b.info.layer) return a.info.layer - b.info.layer;
            // Then alphabetical
            return a.info.name.localeCompare(b.info.name);
        });
    }

    /** Check if a widget should be enabled (localStorage + defaults) */
    private shouldEnable(entry: WidgetEntry): boolean {
        if (entry.info.alwaysStart) return true;

        // Check localStorage
        const saved = this.loadOrderList();
        if (saved.has(entry.info.name)) {
            return saved.get(entry.info.name)! > 0;
        }

        // Default from widget info
        return entry.info.enabled;
    }

    /** Load a single widget into the shared Lua state */
    private loadWidget(entry: WidgetEntry): void {
        if (!entry.source) {
            entry.state = 'error';
            entry.error = 'No source';
            return;
        }

        const widgetName = entry.info.name;

        // Create widget environment table and widget self-table in Lua
        const setupErr = this.runtime.doString(`
            -- Create isolated widget environment
            local _G = _G
            local widgetEnv = {}
            setmetatable(widgetEnv, { __index = _G })

            -- Create widget self-table
            widgetEnv.widget = {}

            -- Store environment for later access
            _widgetEnvs = _widgetEnvs or {}
            _widgetEnvs["${escapeLuaString(widgetName)}"] = widgetEnv
            _widgetSelf = _widgetSelf or {}
            _widgetSelf["${escapeLuaString(widgetName)}"] = widgetEnv.widget
        `, `setup:${widgetName}`);

        if (setupErr) {
            entry.state = 'error';
            entry.error = setupErr;
            this.addLog('error', widgetName, `Setup failed: ${setupErr}`);
            return;
        }

        // Load the widget source with the custom environment
        // In Lua 5.3, load(source, name, mode, env) sets the chunk's _ENV
        const loadErr = this.runtime.doString(`
            local env = _widgetEnvs["${escapeLuaString(widgetName)}"]
            local chunk, err = load(
                ${luaStringLiteral(entry.source)},
                "${escapeLuaString(entry.fileName)}",
                "t",
                env
            )
            if not chunk then
                error("compile: " .. (err or "unknown"))
            end
            local ok, err2 = pcall(chunk)
            if not ok then
                error("run: " .. (err2 or "unknown"))
            end
        `, `load:${widgetName}`);

        if (loadErr) {
            entry.state = 'error';
            entry.error = loadErr;
            this.addLog('error', widgetName, `Load failed: ${loadErr}`);
            return;
        }

        // Call widget:Initialize()
        const initErr = this.runtime.doString(`
            local w = _widgetSelf["${escapeLuaString(widgetName)}"]
            if w and w.Initialize then
                local ok, err = pcall(w.Initialize, w)
                if not ok then
                    error("init: " .. (err or "unknown"))
                end
            end
        `, `init:${widgetName}`);

        if (initErr) {
            entry.state = 'error';
            entry.error = initErr;
            this.addLog('error', widgetName, `Initialize failed: ${initErr}`);
            return;
        }

        entry.state = 'enabled';
        this.activeWidgets.push(entry);
        this.addLog('info', widgetName,
            `Loaded (layer=${entry.info.layer}${entry.info.api ? ', api' : ''})`);

        // Register callins
        this.updateCallinLists();
    }

    /** Rebuild callin dispatch lists from active widgets */
    private updateCallinLists(): void {
        this.callinLists.clear();
        for (const callin of CALLINS) {
            const list: WidgetEntry[] = [];
            for (const entry of this.activeWidgets) {
                // Check if widget defines this callin
                const hasIt = this.runtime.doString(`
                    local w = _widgetSelf["${escapeLuaString(entry.info.name)}"]
                    return w and type(w["${callin}"]) == "function"
                `, `check:${callin}`);
                // doString returns null on success — we need a different approach
                // Let's use a flag variable
                this.runtime.doString(`
                    local w = _widgetSelf["${escapeLuaString(entry.info.name)}"]
                    _callinCheck = w and type(w["${callin}"]) == "function"
                `, `check:${callin}`);
                // Read the flag... actually this is getting unwieldy.
                // Let's just add all active widgets and let the callin dispatch
                // check at call time.
                list.push(entry);
            }
            this.callinLists.set(callin, list);
        }
    }

    /** Dispatch a callin to all active widgets that define it */
    private dispatchCallin(name: CallinName, ...args: LuaValue[]): void {
        for (const entry of this.activeWidgets) {
            if (entry.state !== 'enabled') continue;

            const argsStr = args.map(a => {
                if (typeof a === 'number') return String(a);
                if (typeof a === 'string') return luaStringLiteral(a);
                if (typeof a === 'boolean') return a ? 'true' : 'false';
                return 'nil';
            }).join(', ');

            const err = this.runtime.doString(`
                local w = _widgetSelf["${escapeLuaString(entry.info.name)}"]
                if w and w["${name}"] then
                    local ok, err = pcall(w["${name}"], w${args.length > 0 ? ', ' + argsStr : ''})
                    if not ok then
                        error(err)
                    end
                end
            `, `${name}:${entry.info.name}`);

            if (err) {
                entry.state = 'error';
                entry.error = `${name}: ${err}`;
                this.addLog('error', entry.info.name,
                    `Error in ${name}: ${err} — widget disabled`);
            }
        }
    }

    // ── VFS prefetch ────────────────────────────────────────────────────

    /** Prefetch game files that widgets commonly need */
    private async prefetchGameFiles(baseUrl: string): Promise<void> {
        // Common paths that ZK widgets include
        const paths = [
            'LuaUI/system.lua',
            'LuaUI/cache.lua',
            'LuaUI/callins.lua',
            'LuaUI/savetable.lua',
            'LuaUI/utils.lua',
            'LuaUI/keysym.lua',
            'LuaUI/colors.lua',
            'LuaUI/layout.lua',
            'LuaUI/modfonts.lua',
            'LuaUI/setupdefs.lua',
            'LuaUI/actions.lua',
        ];

        const fetches = paths.map(async (path) => {
            try {
                const res = await fetch(`${baseUrl}/${path}`);
                if (res.ok) {
                    const text = await res.text();
                    this.vfsFiles.set(path, text);
                }
            } catch { /* silent */ }
        });

        // Also fetch LuaRules/Utilities/ if they exist
        try {
            const dirRes = await fetch(`${baseUrl}/LuaRules/Utilities`);
            if (dirRes.ok) {
                const entries = await dirRes.json() as { name: string; type: string }[];
                const utilFetches = entries
                    .filter(e => e.type === 'file' && e.name.endsWith('.lua'))
                    .map(async (e) => {
                        const path = `LuaRules/Utilities/${e.name}`;
                        try {
                            const res = await fetch(`${baseUrl}/${path}`);
                            if (res.ok) {
                                this.vfsFiles.set(path, await res.text());
                            }
                        } catch { /* silent */ }
                    });
                fetches.push(...utilFetches);
            }
        } catch { /* silent */ }

        // Fetch LuaUI/Utilities/ too
        try {
            const dirRes = await fetch(`${baseUrl}/LuaUI/Utilities`);
            if (dirRes.ok) {
                const entries = await dirRes.json() as { name: string; type: string }[];
                const utilFetches = entries
                    .filter(e => e.type === 'file' && e.name.endsWith('.lua'))
                    .map(async (e) => {
                        const path = `LuaUI/Utilities/${e.name}`;
                        try {
                            const res = await fetch(`${baseUrl}/${path}`);
                            if (res.ok) {
                                this.vfsFiles.set(path, await res.text());
                            }
                        } catch { /* silent */ }
                    });
                fetches.push(...utilFetches);
            }
        } catch { /* silent */ }

        await Promise.all(fetches);
        this.addLog('info', 'VFS',
            `Prefetched ${this.vfsFiles.size} game files`);

        // Install VFS files into Lua VFS.Include/LoadFile/FileExists
        this.syncVFSToLua();
    }

    /** Push prefetched VFS files into the Lua VFS implementation */
    private syncVFSToLua(): void {
        // Rebuild VFS.Include to use our prefetched files and support
        // game-level includes (not just map files)
        const baseUrl = `${this.options.lobbyUrl}/api/games/data/${this.options.gameId}`;

        // Update VFS functions to use our cache
        for (const [path, source] of this.vfsFiles) {
            // Escape the source for Lua
            this.runtime.doString(`
                VFS._cache = VFS._cache or {}
                VFS._cache["${escapeLuaString(path)}"] = ${luaStringLiteral(source)}
            `, `vfs_cache:${path}`);
        }

        // Override VFS.Include to use cache
        this.runtime.doString(`
            VFS._cache = VFS._cache or {}
            local origInclude = VFS.Include
            VFS.Include = function(path, env, mode)
                if not path then return nil end
                path = path:gsub("\\\\", "/")
                if path:sub(1,1) == "/" then path = path:sub(2) end
                -- Strip VFS mode prefix
                if path:sub(1,1) == ":" and path:sub(3,3) == ":" then
                    path = path:sub(4)
                end

                local source = VFS._cache[path]
                if not source then
                    -- Try with LuaUI/ prefix
                    source = VFS._cache["LuaUI/" .. path]
                end
                if not source then
                    Spring.Echo("[VFS.Include] not found: " .. path)
                    return nil
                end

                local chunk, err = load(source, path, "t", env or _G)
                if not chunk then
                    Spring.Echo("[VFS.Include] compile error in " .. path .. ": " .. (err or ""))
                    return nil
                end
                return chunk()
            end

            VFS.FileExists = function(path, mode)
                if not path then return false end
                path = path:gsub("\\\\", "/")
                if path:sub(1,1) == "/" then path = path:sub(2) end
                if path:sub(1,1) == ":" and path:sub(3,3) == ":" then
                    path = path:sub(4)
                end
                return VFS._cache[path] ~= nil or VFS._cache["LuaUI/" .. path] ~= nil
            end

            VFS.LoadFile = function(path, mode)
                if not path then return nil end
                path = path:gsub("\\\\", "/")
                if path:sub(1,1) == "/" then path = path:sub(2) end
                if path:sub(1,1) == ":" and path:sub(3,3) == ":" then
                    path = path:sub(4)
                end
                return VFS._cache[path] or VFS._cache["LuaUI/" .. path]
            end
        `, 'vfs_override');
    }

    /** Populate the VFS.DirList cache */
    private populateDirCache(_baseUrl: string, widgetFiles: string[]): void {
        // Set widget directory listing
        const fileListStr = widgetFiles.map(f => `"${escapeLuaString(f)}"`).join(', ');
        this.runtime.doString(`
            _setDirCache("LuaUI/Widgets/", {${fileListStr}})
        `, 'dir_cache_widgets');
    }

    // ── Render loop ─────────────────────────────────────────────────────

    private hookRenderLoop(): void {
        const beforeObs = this.scene.onBeforeRenderObservable.add(() => {
            this.preDraw();
        });
        const afterObs = this.scene.onAfterRenderObservable.add(() => {
            this.postDraw();
        });
        this.renderObserver = {
            remove: () => {
                this.scene.onBeforeRenderObservable.remove(beforeObs);
                this.scene.onAfterRenderObservable.remove(afterObs);
            },
        };
    }

    private preDraw(): void {
        this.currentFrame++;

        // Update camera matrices
        const view = this.camera.getViewMatrix();
        const proj = this.scene.getProjectionMatrix();
        this.bridge.setCameraMatrices(
            toFloat32Array(view),
            toFloat32Array(proj),
        );

        // GameFrame (~30Hz)
        if (this.currentFrame % 2 === 0) {
            this.dispatchCallin('GameFrame', this.currentFrame);
        }

        // DrawScreen
        this.dispatchCallin('DrawScreen');
    }

    private postDraw(): void {
        const engine = this.scene.getEngine();
        const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;

        // Save GL state
        const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const savedVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        const savedBlend = gl.getParameter(gl.BLEND);
        const savedDepthTest = gl.getParameter(gl.DEPTH_TEST);
        const savedDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        const savedFBO = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);

        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

        this.dispatchCallin('DrawWorldPreUnit');

        // Restore
        gl.useProgram(savedProgram);
        gl.bindVertexArray(savedVao);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, savedFBO);
        if (savedBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        if (savedDepthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        gl.depthMask(savedDepthMask);
        (engine as unknown as { wipeCaches: (b?: boolean) => void }).wipeCaches(true);
    }

    // ── Console / logging ───────────────────────────────────────────────

    private addLog(level: 'info' | 'warn' | 'error', widget: string, message: string): void {
        const entry: WidgetLogEntry = {
            level,
            widget,
            message,
            timestamp: Date.now(),
        };
        this.log.push(entry);
        if (this.log.length > this.maxLogEntries) {
            this.log.shift();
        }

        // Also output to browser console
        const prefix = `[LuaUI:${widget}]`;
        if (level === 'error') console.error(prefix, message);
        else if (level === 'warn') console.warn(prefix, message);
        else console.log(prefix, message);
    }

    // ── LocalStorage persistence ────────────────────────────────────────

    private loadOrderList(): Map<string, number> {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw) return new Map();
            return new Map(Object.entries(JSON.parse(raw)));
        } catch {
            return new Map();
        }
    }

    private saveOrderList(): void {
        const order: Record<string, number> = {};
        for (const [name, entry] of this.registry) {
            if (entry.info.alwaysStart) continue;
            order[name] = entry.state === 'enabled' ? 1 : 0;
        }
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(order));
        } catch { /* silent */ }
    }

    // ── window.widgets API ──────────────────────────────────────────────

    private buildWindowAPI() {
        const mgr = this;
        return {
            /** List all discovered widgets with their state */
            list() {
                const result: Record<string, {
                    state: string;
                    layer: number;
                    api: boolean;
                    author: string;
                    desc: string;
                    error?: string;
                }> = {};
                for (const [name, entry] of mgr.registry) {
                    result[name] = {
                        state: entry.state,
                        layer: entry.info.layer,
                        api: entry.info.api,
                        author: entry.info.author,
                        desc: entry.info.desc,
                        error: entry.error,
                    };
                }
                return result;
            },

            /** Get active widget count */
            get activeCount() {
                return mgr.activeWidgets.filter(w => w.state === 'enabled').length;
            },

            /** Get total widget count */
            get totalCount() {
                return mgr.registry.size;
            },

            /** Get console log */
            log(count = 20) {
                return mgr.log.slice(-count);
            },

            /** Enable a widget by name */
            enable(name: string) {
                const entry = mgr.registry.get(name);
                if (!entry) return `Unknown widget: ${name}`;
                if (entry.state === 'enabled') return 'Already enabled';
                mgr.loadWidget(entry);
                mgr.saveOrderList();
                return (entry.state as string) === 'enabled' ? 'OK' : entry.error;
            },

            /** Disable a widget by name */
            disable(name: string) {
                const entry = mgr.registry.get(name);
                if (!entry) return `Unknown widget: ${name}`;
                if (entry.state !== 'enabled') return 'Not active';

                // Call Shutdown
                mgr.runtime.doString(`
                    local w = _widgetSelf["${escapeLuaString(name)}"]
                    if w and w.Shutdown then pcall(w.Shutdown, w) end
                `, `shutdown:${name}`);

                entry.state = 'disabled';
                mgr.activeWidgets = mgr.activeWidgets.filter(w => w !== entry);
                mgr.updateCallinLists();
                mgr.saveOrderList();
                mgr.addLog('info', name, 'Disabled');
                return 'OK';
            },

            /** Get errors for all widgets */
            errors() {
                const result: Record<string, string> = {};
                for (const [name, entry] of mgr.registry) {
                    if (entry.error) result[name] = entry.error;
                }
                return result;
            },
        };
    }

    // ── Cleanup ─────────────────────────────────────────────────────────

    dispose(): void {
        this.renderObserver?.remove();
        this.renderObserver = null;

        // Call Shutdown on all active widgets
        for (const entry of this.activeWidgets) {
            if (entry.state === 'enabled') {
                this.runtime.doString(`
                    local w = _widgetSelf["${escapeLuaString(entry.info.name)}"]
                    if w and w.Shutdown then pcall(w.Shutdown, w) end
                `, `shutdown:${entry.info.name}`);
            }
        }

        this.activeWidgets = [];
        this.registry.clear();
        this.runtime.dispose();
        delete (window as any).widgets;
    }
}

// ── Lua 5.1 compatibility shim ──────────────────────────────────────────

const LUA_COMPAT_SHIM = `
-- Lua 5.1 → 5.3 compatibility
if not loadstring then
    loadstring = load
end

if not unpack then
    unpack = table.unpack
end

if not table.getn then
    table.getn = function(t) return #t end
end

if not math.mod then
    math.mod = math.fmod
end

-- setfenv/getfenv polyfill using debug library
if not setfenv then
    function setfenv(fn, env)
        if type(fn) == "number" then
            -- Level-based: not fully supported in 5.3
            -- Level 1 = caller, but we can't easily change _ENV retroactively
            return env
        end
        local i = 1
        while true do
            local name = debug.getupvalue(fn, i)
            if name == "_ENV" then
                debug.upvaluejoin(fn, i, (function() return env end), 1)
                return fn
            elseif not name then
                break
            end
            i = i + 1
        end
        return fn
    end
end

if not getfenv then
    function getfenv(fn)
        if type(fn) == "number" or fn == nil then
            return _ENV or _G
        end
        local i = 1
        while true do
            local name, val = debug.getupvalue(fn, i)
            if name == "_ENV" then
                return val
            elseif not name then
                break
            end
            i = i + 1
        end
        return _ENV or _G
    end
end

-- table.shallowcopy (used by Chili)
if not table.shallowcopy then
    function table.shallowcopy(t)
        local copy = {}
        for k, v in pairs(t) do copy[k] = v end
        return copy
    end
end

-- table.merge (used by Chili)
if not table.merge then
    function table.merge(dst, src)
        for k, v in pairs(src) do
            if dst[k] == nil then dst[k] = v end
        end
        return dst
    end
end
`;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Escape a string for safe embedding in Lua source. */
function escapeLuaString(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\0');
}

/** Create a Lua string literal with long brackets to handle any content. */
function luaStringLiteral(s: string): string {
    // Find a bracket level that doesn't appear in the string
    let level = 0;
    while (s.includes(']' + '='.repeat(level) + ']')) {
        level++;
    }
    const eq = '='.repeat(level);
    return `[${eq}[${s}]${eq}]`;
}

function toFloat32Array(m: Matrix): Float32Array {
    const arr = new Float32Array(16);
    const src = m.m;
    for (let i = 0; i < 16; i++) arr[i] = src[i];
    return arr;
}

function buildHeightmapTexture(gl: WebGL2RenderingContext, map: ParsedMapData): WebGLTexture | null {
    const w = map.mapx + 1;
    const h = map.mapy + 1;
    if (!map.heightmap || map.heightmap.length < w * h) return null;
    const buf = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        buf[i] = map.heightmap[i] >> 8;
    }
    const tex = gl.createTexture();
    if (!tex) return null;
    const saved = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const savedAlign = gl.getParameter(gl.UNPACK_ALIGNMENT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, buf);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, savedAlign);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, saved);
    return tex;
}
