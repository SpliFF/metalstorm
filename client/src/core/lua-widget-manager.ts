/**
 * LuaWidgetManager — Engine API provider for Spring LuaUI.
 *
 * This is a faithful reimplementation of the C++ side of Spring's LuaUI
 * subsystem. It creates a Lua state, installs the engine API surface
 * (Spring.*, gl.*, VFS.*, etc.), prefetches game files into the VFS cache,
 * then runs the game's own `camain.lua` bootstrap. From that point, the
 * game's Lua code (cawidgets.lua) handles all widget management.
 *
 * What this file does (the "engine" role):
 *   - Creates the Lua state and installs globals
 *   - Provides VFS backed by HTTP fetch with case-insensitive lookup
 *   - Provides Spring.*, gl.*, GL.*, Game.*, CMD.*, Script.* APIs
 *   - Provides Lua 5.1 compat shims (newproxy, getfenv, etc.)
 *   - Hooks the Babylon.js render loop to call Lua callins
 *
 * What this file does NOT do (the "game" role — handled by cawidgets.lua):
 *   - Widget discovery, loading, ordering
 *   - widgetHandler table
 *   - WG table, Spring.Utilities, Spring.Orig
 *   - Callin dispatch to widgets
 *   - Error handling / safe wrapping
 */
import type { Scene } from '@babylonjs/core/scene';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { ParsedMapData } from './map-data.js';
import { LuaRuntime, type LuaValue } from './lua-runtime.js';
import { LuaGLBridge } from './lua-gl-bridge.js';
import {
    buildSpringGlobals,
    type SpringAPIContext,
} from './lua-spring-api.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface WidgetManagerOptions {
    gameId: string;
    /** Base URL for game data (e.g. http://localhost:8011) */
    lobbyUrl: string;
}

// ── Main class ──────────────────────────────────────────────────────────

export class LuaWidgetManager {
    private scene: Scene;
    private camera: FreeCamera;
    private map: ParsedMapData;
    private options: WidgetManagerOptions;

    /** Single Lua state — camain.lua and all widgets run here */
    private runtime: LuaRuntime;
    private bridge: LuaGLBridge;
    private ctx: SpringAPIContext;

    /** Pre-fetched VFS files (path → source) */
    private vfsFiles = new Map<string, string>();
    /** Case-insensitive lookup: lowercase path → canonical path */
    private vfsPathMap = new Map<string, string>();
    /** Directory listings: dir path → file names */
    private vfsDirCache = new Map<string, string[]>();
    /** Subdirectory listings: dir path → subdir names */
    private vfsSubdirCache = new Map<string, string[]>();

    private startTime = performance.now() / 1000;
    private renderObserver: { remove: () => void } | null = null;

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

        this.runtime = new LuaRuntime('LuaUI');

        const engine = scene.getEngine();
        const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
        this.bridge = new LuaGLBridge(gl, map.mapSourceUrl);

        const heightTex = buildHeightmapTexture(gl, map);
        if (heightTex) this.bridge.setEngineHeightmap(heightTex);

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
    }

    // ── Main entry point ────────────────────────────────────────────────

    async initialize(): Promise<void> {
        const { gameId, lobbyUrl } = this.options;
        const baseUrl = `${lobbyUrl}/api/games/data/${gameId}`;

        // 1. Prefetch all game files into VFS cache
        await this.prefetchAllGameFiles(baseUrl);
        console.log(`[LuaUI] VFS: ${this.vfsFiles.size} files prefetched`);

        // 2. Install engine API surface (what C++ would provide)
        this.installEngineGlobals();

        // 3. Sync VFS cache to Lua state
        this.syncVFSToLua();

        // 4. Run the game's bootstrap: camain.lua
        //    This loads cawidgets.lua which handles all widget management.
        const bootErr = this.runtime.doString(`
            local ok, err = pcall(function()
                VFS.Include("LuaUI/camain.lua", nil, VFS.GAME)
            end)
            if not ok then
                Spring.Echo("[LuaUI] Bootstrap failed: " .. tostring(err))
                error(err)
            end
        `, 'bootstrap');

        if (bootErr) {
            console.error('[LuaUI] Bootstrap failed:', bootErr);
            // Try to continue — some widgets may have loaded before the error
        }

        // 5. Hook render loop — call Lua callins from Babylon.js frame events
        //    (widgetHandler:Initialize() is called at the end of cawidgets.lua)
        this.hookRenderLoop();

        // 7. Expose debug API on window
        (window as any).widgets = this.buildWindowAPI();
    }

    // ── Engine globals installation ─────────────────────────────────────
    //
    // This is what the C++ engine does before loading camain.lua.
    // Every global here is something the engine provides, not the game.

    private installEngineGlobals(): void {
        const springGlobals = buildSpringGlobals(this.ctx);
        const glGlobal = this.bridge.buildGlGlobal();

        // Override Spring.Echo to route through browser console
        (springGlobals.Spring as Record<string, LuaValue>).Echo =
            (...args: LuaValue[]) => {
                const msg = args.map(a => String(a ?? '')).join('\t');
                console.log(`[LuaUI]`, msg);
            };

        // Install all engine-provided globals
        for (const [k, v] of Object.entries(springGlobals)) {
            this.runtime.setGlobal(k, v);
        }
        this.runtime.setGlobal('gl', glGlobal);

        // Add __index fallback on gl table — unimplemented gl.* functions
        // return no-op stubs instead of nil (prevents widget crashes)
        this.runtime.doString(`
            setmetatable(gl, {
                __index = function(t, k)
                    local stub = function(...) end
                    rawset(t, k, stub)
                    return stub
                end
            })
        `, 'gl_fallback');

        // LUAUI_DIRNAME — set by the engine before loading camain.lua
        this.runtime.setGlobal('LUAUI_DIRNAME', 'LuaUI/');
        this.runtime.setGlobal('LUAUI_VERSION',
            `spring-web LuaUI v0.2 (${this.options.gameId})`);

        // Script table — engine provides this.
        // IsEngineMinVersion returns true — we're a modern fork.
        // engine_compat.lua uses this to apply API compatibility wrappers.
        this.runtime.setGlobal('Script', {
            CreateScream: () => ({ func: null }),
            GetSynced: () => false,
            LuaUI: () => ({}),
            IsEngineMinVersion: () => true,
            // UpdateCallIn registers/deregisters Lua callins with the C++ engine.
            // In our case we call global Lua functions directly, so this is a no-op.
            UpdateCallIn: () => {},
            LuaGaia: () => ({}),
            LuaRules: () => ({}),
        });

        // LOG level constants
        this.runtime.setGlobal('LOG', {
            ERROR: 0,
            WARNING: 1,
            INFO: 2,
            DEBUG: 3,
        });

        // Empty def tables — engine populates these before Lua starts.
        // For now empty; will be filled when defs stream from the server.
        this.runtime.setGlobal('UnitDefs', {});
        this.runtime.setGlobal('UnitDefNames', {});
        this.runtime.setGlobal('WeaponDefs', {});
        this.runtime.setGlobal('WeaponDefNames', {});
        this.runtime.setGlobal('FeatureDefs', {});
        this.runtime.setGlobal('FeatureDefNames', {});

        // CMD constants — engine provides these
        this.runtime.doString(CMD_GLOBALS_LUA, 'cmd_globals');

        // tracy stubs (profiling hooks — no-op in browser)
        this.runtime.doString(`
            tracy = setmetatable({}, {
                __index = function() return function() end end
            })
        `, 'tracy_stub');

        // Lua 5.1 compatibility shims
        this.runtime.doString(LUA_COMPAT_SHIM, 'compat_shim');

        // os stub — os.remove, os.clock etc.
        this.runtime.setGlobal('os', {
            remove: () => [null, 'os.remove disabled in browser'],
            rename: () => [null, 'os.rename disabled in browser'],
            clock: () => performance.now() / 1000,
            time: () => Math.floor(Date.now() / 1000),
            date: (_fmt: LuaValue) => new Date().toISOString(),
            difftime: (t2: LuaValue, t1: LuaValue) => Number(t2 ?? 0) - Number(t1 ?? 0),
        });

        // io stub — loadfile/savefile use localStorage, not real files
        this.installIOStubs();
    }

    /** Install io/loadfile stubs that bridge to localStorage for config persistence */
    private installIOStubs(): void {
        const storagePrefix = `luaui:${this.options.gameId}:`;

        // loadfile — used by cawidgets to load config files
        this.runtime.doString(`
            local _storagePrefix = "${escapeLuaString(storagePrefix)}"

            -- loadfile: load Lua source from VFS cache (for config files)
            function loadfile(path)
                if not path then return nil, "no path" end
                local source = VFS._cache[path] or VFS._cache[path:lower()]
                if not source then
                    -- Try localStorage bridge
                    local stored = _loadFromStorage(_storagePrefix .. path)
                    if stored then source = stored end
                end
                if not source then
                    return nil, "file not found: " .. path
                end
                return load(source, path, "t")
            end

            -- dofile: convenience wrapper
            function dofile(path)
                local chunk, err = loadfile(path)
                if not chunk then error(err, 2) end
                return chunk()
            end
        `, 'loadfile_shim');

        // Expose localStorage read/write to Lua
        this.runtime.setGlobal('_loadFromStorage', (key: LuaValue) => {
            try {
                return localStorage.getItem(String(key)) ?? null;
            } catch { return null; }
        });
        this.runtime.setGlobal('_saveToStorage', (key: LuaValue, value: LuaValue) => {
            try {
                localStorage.setItem(String(key), String(value));
            } catch { /* silent */ }
        });

        // io.open — bridges to localStorage for config file persistence.
        // Returns a file-like object with :write() and :close().
        this.runtime.doString(`
            local _storagePrefix = "${escapeLuaString(storagePrefix)}"
            io = io or {}
            io.open = function(path, mode)
                if not path then return nil, "no path" end
                mode = mode or "r"
                if mode:find("w") or mode:find("a") then
                    -- Write mode: accumulate content, save on close
                    local buf = {}
                    local f = {}
                    function f:write(...)
                        for _, s in ipairs({...}) do
                            buf[#buf + 1] = tostring(s)
                        end
                    end
                    function f:close()
                        local content = table.concat(buf)
                        _saveToStorage(_storagePrefix .. path, content)
                        -- Also put in VFS cache so loadfile can find it
                        VFS._cache[path] = content
                    end
                    return f
                else
                    -- Read mode: try VFS cache then localStorage
                    local content = VFS._cache[path]
                        or VFS._cache[path:lower()]
                    if not content then
                        content = _loadFromStorage(_storagePrefix .. path)
                    end
                    if not content then
                        return nil, "file not found: " .. path
                    end
                    local pos = 1
                    local f = {}
                    function f:read(fmt)
                        if pos > #content then return nil end
                        if fmt == "*a" then
                            local r = content:sub(pos)
                            pos = #content + 1
                            return r
                        end
                        -- line read
                        local nl = content:find("\\n", pos, true)
                        local line
                        if nl then
                            line = content:sub(pos, nl - 1)
                            pos = nl + 1
                        else
                            line = content:sub(pos)
                            pos = #content + 1
                        end
                        return line
                    end
                    function f:close() end
                    return f
                end
            end
            io.read = function() return nil end
            io.write = function() end
            io.close = function() end
        `, 'io_shim');
    }

    // ── VFS layer ───────────────────────────────────────────────────────
    //
    // Spring's VFS is case-insensitive. All lookups normalize to lowercase
    // internally. This is engine behavior, not game-specific.

    /** Register a file in the VFS cache with case-insensitive indexing */
    private vfsRegister(path: string, content: string): void {
        this.vfsFiles.set(path, content);
        this.vfsPathMap.set(path.toLowerCase(), path);

        // Update directory and subdirectory caches
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash >= 0) {
            const dir = path.substring(0, lastSlash + 1);
            const file = path.substring(lastSlash + 1);

            if (!this.vfsDirCache.has(dir)) this.vfsDirCache.set(dir, []);
            this.vfsDirCache.get(dir)!.push(file);

            // Build parent→child dir relationships
            const parts = path.split('/');
            for (let i = 1; i < parts.length - 1; i++) {
                const parent = parts.slice(0, i).join('/') + '/';
                const child = parts[i];
                if (!this.vfsSubdirCache.has(parent))
                    this.vfsSubdirCache.set(parent, []);
                const subs = this.vfsSubdirCache.get(parent)!;
                if (!subs.includes(child)) subs.push(child);
            }
        }
    }

    /** Case-insensitive file lookup — returns content or undefined */
    private vfsLookup(path: string): string | undefined {
        // Try exact match first
        const exact = this.vfsFiles.get(path);
        if (exact !== undefined) return exact;
        // Try with LuaUI/ prefix
        const withPrefix = this.vfsFiles.get('LuaUI/' + path);
        if (withPrefix !== undefined) return withPrefix;
        // Case-insensitive fallback
        const lower = path.toLowerCase();
        const canonical = this.vfsPathMap.get(lower);
        if (canonical) return this.vfsFiles.get(canonical);
        const canonicalPrefixed = this.vfsPathMap.get(('LuaUI/' + path).toLowerCase());
        if (canonicalPrefixed) return this.vfsFiles.get(canonicalPrefixed);
        return undefined;
    }

    /** Prefetch all game files recursively */
    private async prefetchAllGameFiles(baseUrl: string): Promise<void> {
        // BFS scan all directories under the game root
        const queue = ['LuaUI', 'LuaRules', 'LuaRules/Utilities',
            'LuaRules/Configs', 'Configs'];

        // Discover top-level dirs first
        for (const startDir of [...queue]) {
            await this.scanDirectory(baseUrl, startDir);
        }

        // BFS through discovered subdirectories
        const visited = new Set<string>();
        while (queue.length > 0) {
            const dir = queue.shift()!;
            if (visited.has(dir.toLowerCase())) continue;
            visited.add(dir.toLowerCase());

            const newDirs = await this.scanDirectory(baseUrl, dir);
            queue.push(...newDirs);
        }
    }

    /** Scan a directory, fetch all files, return subdirectory paths */
    private async scanDirectory(baseUrl: string, dir: string): Promise<string[]> {
        try {
            const res = await fetch(`${baseUrl}/${dir}`);
            if (!res.ok) return [];
            const entries = await res.json() as { name: string; type: string }[];

            const subdirs: string[] = [];
            const fileFetches: Promise<void>[] = [];

            for (const e of entries) {
                const fullPath = `${dir}/${e.name}`;
                if (e.type === 'file' &&
                    (e.name.endsWith('.lua') || e.name.endsWith('.txt'))) {
                    if (this.vfsFiles.has(fullPath)) continue;
                    fileFetches.push((async () => {
                        try {
                            const fRes = await fetch(`${baseUrl}/${fullPath}`);
                            if (fRes.ok) {
                                this.vfsRegister(fullPath, await fRes.text());
                            }
                        } catch { /* silent */ }
                    })());
                } else if (e.type === 'dir' || e.type === 'directory') {
                    subdirs.push(fullPath);
                }
            }

            await Promise.all(fileFetches);
            return subdirs;
        } catch {
            return [];
        }
    }

    /** Push the VFS cache into the Lua state */
    private syncVFSToLua(): void {
        // Build the VFS._cache table in Lua with all prefetched files
        this.runtime.doString(`VFS._cache = VFS._cache or {}`, 'vfs_init');

        for (const [path, source] of this.vfsFiles) {
            this.runtime.doString(`
                VFS._cache["${escapeLuaString(path)}"] = ${luaStringLiteral(source)}
            `, `vfs:${path}`);
        }

        // Build case-insensitive index
        for (const [lowerPath, canonPath] of this.vfsPathMap) {
            if (lowerPath !== canonPath) {
                this.runtime.doString(`
                    if not VFS._cache["${escapeLuaString(lowerPath)}"] then
                        VFS._cache["${escapeLuaString(lowerPath)}"] = VFS._cache["${escapeLuaString(canonPath)}"]
                    end
                `, `vfs_ci:${lowerPath}`);
            }
        }

        // Install VFS.Include, FileExists, LoadFile, DirList, SubDirs
        this.runtime.doString(VFS_IMPLEMENTATION_LUA, 'vfs_impl');

        // Populate DirList cache
        for (const [dir, files] of this.vfsDirCache) {
            const filesStr = files.map(f => `"${escapeLuaString(f)}"`).join(', ');
            this.runtime.doString(`
                VFS._dirCache["${escapeLuaString(dir)}"] = {${filesStr}}
            `, `vfs_dir:${dir}`);
        }

        // Populate SubDirs cache
        for (const [dir, subs] of this.vfsSubdirCache) {
            const subsStr = subs.map(s => `"${escapeLuaString(s)}"`).join(', ');
            this.runtime.doString(`
                VFS._subdirCache["${escapeLuaString(dir)}"] = {${subsStr}}
            `, `vfs_subdir:${dir}`);
        }
    }

    // ── Render loop ─────────────────────────────────────────────────────
    //
    // The C++ engine calls global Lua functions per frame. We do the same
    // from Babylon.js render observers.

    private hookRenderLoop(): void {
        const beforeObs = this.scene.onBeforeRenderObservable.add(() => {
            // Update camera matrices for gl.* drawing
            const view = this.camera.getViewMatrix();
            const proj = this.scene.getProjectionMatrix();
            this.bridge.setCameraMatrices(
                toFloat32Array(view),
                toFloat32Array(proj),
            );

            // Call the global Update() callin — camain.lua defines this
            this.runtime.doString(`
                if Update then
                    local ok, err = pcall(Update)
                    if not ok then Spring.Echo("[LuaUI] Update error: " .. tostring(err)) end
                end
            `, 'callin:Update');

            // Call DrawScreen — camain.lua delegates to widgetHandler:DrawScreen()
            this.runtime.doString(`
                if DrawScreen then
                    local vsx, vsy = Spring.GetViewSizes()
                    local ok, err = pcall(DrawScreen, vsx, vsy)
                    if not ok then Spring.Echo("[LuaUI] DrawScreen error: " .. tostring(err)) end
                end
            `, 'callin:DrawScreen');
        });

        const afterObs = this.scene.onAfterRenderObservable.add(() => {
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

            // DrawWorldPreUnit
            this.runtime.doString(`
                if widgetHandler and widgetHandler.DrawWorldPreUnit then
                    local ok, err = pcall(widgetHandler.DrawWorldPreUnit, widgetHandler)
                    if not ok then Spring.Echo("[LuaUI] DrawWorldPreUnit error: " .. tostring(err)) end
                end
            `, 'callin:DrawWorldPreUnit');

            // Restore GL state
            gl.useProgram(savedProgram);
            gl.bindVertexArray(savedVao);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, savedFBO);
            if (savedBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
            if (savedDepthTest) gl.enable(gl.DEPTH_TEST);
            else gl.disable(gl.DEPTH_TEST);
            gl.depthMask(savedDepthMask);
            (engine as unknown as { wipeCaches: (b?: boolean) => void })
                .wipeCaches(true);
        });

        this.renderObserver = {
            remove: () => {
                this.scene.onBeforeRenderObservable.remove(beforeObs);
                this.scene.onAfterRenderObservable.remove(afterObs);
            },
        };
    }

    // ── window.widgets debug API ────────────────────────────────────────
    //
    // Minimal debug surface. Most state lives in Lua now.

    private buildWindowAPI() {
        const rt = this.runtime;
        return {
            /** Get widget list from widgetHandler */
            list() {
                // Query widgetHandler.knownWidgets from Lua
                const result: Record<string, unknown> = {};
                rt.doString(`
                    _widgetListResult = {}
                    if widgetHandler then
                        for name, info in pairs(widgetHandler.knownWidgets or {}) do
                            _widgetListResult[name] = {
                                active = info.active or false,
                                desc = info.desc or "",
                                author = info.author or "",
                                basename = info.basename or "",
                            }
                        end
                    end
                `, 'api:list');
                return result;
            },

            /** Get recent console log entries */
            log(count = 20) {
                return `Use browser console — LuaUI logs go to console.log with [LuaUI] prefix`;
            },

            /** Get error info */
            errors() {
                return `Widget errors are logged to browser console`;
            },

            /** VFS stats */
            get vfsFileCount() {
                return rt.doString(`return #VFS._cache`, 'api:vfs') ?? 0;
            },
        };
    }

    // ── Cleanup ─────────────────────────────────────────────────────────

    dispose(): void {
        this.renderObserver?.remove();
        this.renderObserver = null;

        // Call Shutdown callin
        this.runtime.doString(`
            if Shutdown then pcall(Shutdown) end
        `, 'shutdown');

        this.runtime.dispose();
        delete (window as any).widgets;
    }
}

// ── Lua 5.1 compatibility shim ──────────────────────────────────────────
//
// These are language-level polyfills, not game-specific.

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

-- newproxy polyfill (Lua 5.1 function, not in 5.3)
if not newproxy then
    function newproxy(hasMeta)
        if hasMeta then
            local t = {}
            setmetatable(t, { __isProxy = true })
            return t
        else
            return {}
        end
    end
end

-- debug.getfenv / debug.setfenv (Lua 5.1 debug API, not in 5.3)
if not debug.getfenv then
    debug.getfenv = function(obj)
        if type(obj) == "function" then
            local i = 1
            while true do
                local name, val = debug.getupvalue(obj, i)
                if name == "_ENV" then return val
                elseif not name then break end
                i = i + 1
            end
        end
        return _ENV or _G
    end
end
if not debug.setfenv then
    debug.setfenv = function(obj, env)
        if type(obj) == "function" then
            local i = 1
            while true do
                local name = debug.getupvalue(obj, i)
                if name == "_ENV" then
                    debug.upvaluejoin(obj, i, (function() return env end), 1)
                    return obj
                elseif not name then break end
                i = i + 1
            end
        end
        return obj
    end
end

-- setfenv/getfenv global polyfills
if not setfenv then
    function setfenv(fn, env)
        if type(fn) == "number" then return env end
        local i = 1
        while true do
            local name = debug.getupvalue(fn, i)
            if name == "_ENV" then
                debug.upvaluejoin(fn, i, (function() return env end), 1)
                return fn
            elseif not name then break end
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
            if name == "_ENV" then return val
            elseif not name then break end
            i = i + 1
        end
        return _ENV or _G
    end
end

-- table helpers used by Spring games
if not table.shallowcopy then
    function table.shallowcopy(t)
        local copy = {}
        for k, v in pairs(t) do copy[k] = v end
        return copy
    end
end
if not table.merge then
    function table.merge(dst, src)
        for k, v in pairs(src) do
            if dst[k] == nil then dst[k] = v end
        end
        return dst
    end
end

-- gcinfo (Lua 5.0/5.1, removed in 5.3)
if not gcinfo then
    gcinfo = function()
        return math.floor(collectgarbage("count"))
    end
end
`;

// ── VFS Lua implementation ──────────────────────────────────────────────
//
// This is what the C++ engine's VFS provides. Case-insensitive by design.

const VFS_IMPLEMENTATION_LUA = `
VFS._cache = VFS._cache or {}
VFS._dirCache = VFS._dirCache or {}
VFS._subdirCache = VFS._subdirCache or {}

-- Normalize a path: strip VFS mode prefix, backslashes, leading slash
local function normalizePath(path)
    if not path then return nil end
    path = path:gsub("\\\\", "/")
    if path:sub(1,1) == "/" then path = path:sub(2) end
    if path:sub(1,1) == ":" and #path >= 3 and path:sub(3,3) == ":" then
        path = path:sub(4)
    end
    return path
end

-- Case-insensitive file lookup
local function vfsLookup(path)
    local source = VFS._cache[path]
    if source then return source end
    source = VFS._cache["LuaUI/" .. path]
    if source then return source end
    -- Case-insensitive fallback
    source = VFS._cache[path:lower()]
    if source then return source end
    source = VFS._cache[("LuaUI/" .. path):lower()]
    return source
end

VFS.Include = function(path, env, mode)
    if not path then return nil end
    path = normalizePath(path)

    local source = vfsLookup(path)
    if not source then
        Spring.Echo("[VFS.Include] not found: " .. path)
        return nil
    end

    -- When env is nil, use the caller's environment (matching Spring behavior).
    if env == nil then
        local info = debug.getinfo(2, "f")
        if info and info.func then
            local i = 1
            while true do
                local name, val = debug.getupvalue(info.func, i)
                if name == "_ENV" then env = val; break
                elseif not name then break end
                i = i + 1
            end
        end
        env = env or _G
    end

    -- Ensure env has access to standard globals
    if env ~= _G and not getmetatable(env) then
        setmetatable(env, { __index = _G })
    end

    local chunk, err = load(source, path, "t", env)
    if not chunk then
        Spring.Echo("[VFS.Include] compile error in " .. path .. ": " .. (err or ""))
        return nil
    end
    return chunk()
end

VFS.FileExists = function(path, mode)
    if not path then return false end
    path = normalizePath(path)
    return vfsLookup(path) ~= nil
end

VFS.LoadFile = function(path, mode)
    if not path then return nil end
    path = normalizePath(path)
    return vfsLookup(path)
end

VFS.DirList = function(path, pattern, mode)
    path = path or ""
    path = path:gsub("\\\\", "/")
    if path:sub(-1) ~= "/" then path = path .. "/" end

    local cached = VFS._dirCache[path] or VFS._dirCache[path:lower()]
    if not cached then return {} end

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

    local result = {}
    for _, f in ipairs(cached) do
        result[#result + 1] = path .. f
    end
    return result
end

VFS.SubDirs = function(path, pattern, mode)
    path = path or ""
    path = path:gsub("\\\\", "/")
    if path:sub(-1) ~= "/" then path = path .. "/" end

    local cached = VFS._subdirCache[path] or VFS._subdirCache[path:lower()]
    if not cached then return {} end

    local result = {}
    for _, d in ipairs(cached) do
        result[#result + 1] = path .. d .. "/"
    end
    return result
end
`;

// ── CMD constants ───────────────────────────────────────────────────────

const CMD_GLOBALS_LUA = `
CMD = CMD or {}
setmetatable(CMD, { __index = function() return 0 end })
CMD.STOP = 0; CMD.INSERT = 1; CMD.REMOVE = 2
CMD.WAIT = 5; CMD.TIMEWAIT = 6; CMD.DEATHWAIT = 7
CMD.SQUADWAIT = 8; CMD.GATHERWAIT = 9; CMD.MOVE = 10
CMD.PATROL = 15; CMD.FIGHT = 16; CMD.ATTACK = 20
CMD.GUARD = 25; CMD.REPAIR = 40; CMD.FIRE_STATE = 45
CMD.MOVE_STATE = 50; CMD.REPEAT = 55; CMD.SELFD = 65
CMD.SET_WANTED_MAX_SPEED = 70; CMD.LOAD_UNITS = 75
CMD.UNLOAD_UNIT = 80; CMD.UNLOAD_UNITS = 81
CMD.ONOFF = 85; CMD.RECLAIM = 90; CMD.CLOAK = 95
CMD.STOCKPILE = 100; CMD.MANUALFIRE = 105; CMD.RESURRECT = 125
CMD.OPT_META = 4; CMD.OPT_INTERNAL = 8; CMD.OPT_RIGHT = 16
CMD.OPT_SHIFT = 32; CMD.OPT_CTRL = 64; CMD.OPT_ALT = 128

CMDTYPE = CMDTYPE or {}
CMDTYPE.ICON = 0; CMDTYPE.ICON_MODE = 5; CMDTYPE.ICON_MAP = 10
CMDTYPE.ICON_AREA = 11; CMDTYPE.ICON_UNIT = 12
CMDTYPE.ICON_UNIT_OR_MAP = 13; CMDTYPE.ICON_FRONT = 14
CMDTYPE.COMBO_BOX = 15; CMDTYPE.ICON_UNIT_OR_AREA = 16
CMDTYPE.NEXT = 17; CMDTYPE.PREV = 18; CMDTYPE.ICON_UNIT_FEATURE_OR_AREA = 19
CMDTYPE.ICON_BUILDING = 20; CMDTYPE.CUSTOM = 21
CMDTYPE.ICON_UNIT_OR_RECTANGLE = 22; CMDTYPE.NUMBER = 23

cmdColors = cmdColors or {}
`;

// ── Helpers ─────────────────────────────────────────────────────────────

function escapeLuaString(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\0');
}

function luaStringLiteral(s: string): string {
    let level = 0;
    while (s.includes(']' + '='.repeat(level) + ']')) level++;
    const eq = '='.repeat(level);
    return `[${eq}[${s}]${eq}]`;
}

function toFloat32Array(m: Matrix): Float32Array {
    const arr = new Float32Array(16);
    const src = m.m;
    for (let i = 0; i < 16; i++) arr[i] = src[i];
    return arr;
}

function buildHeightmapTexture(
    gl: WebGL2RenderingContext, map: ParsedMapData,
): WebGLTexture | null {
    const w = map.mapx + 1;
    const h = map.mapy + 1;
    if (!map.heightmap || map.heightmap.length < w * h) return null;
    const buf = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) buf[i] = map.heightmap[i] >> 8;
    const tex = gl.createTexture();
    if (!tex) return null;
    const saved = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const savedAlign = gl.getParameter(gl.UNPACK_ALIGNMENT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED,
        gl.UNSIGNED_BYTE, buf);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, savedAlign);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, saved);
    return tex;
}
