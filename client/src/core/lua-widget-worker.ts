/**
 * LuaUI Web Worker — runs fengari and all widget Lua code off the main thread.
 *
 * Receives an OffscreenCanvas for 2D UI rendering (DrawScreen).
 * World-space callins (DrawWorldPreUnit etc.) produce a command buffer
 * sent back to the main thread for replay on the Babylon GL context.
 *
 * Message protocol:
 *   Main → Worker:
 *     {type:'init', canvas, gameId, lobbyUrl, mapData}
 *     {type:'frame', viewMatrix, projMatrix}
 *     {type:'keypress', keyCode, alt, ctrl, meta, shift}
 *     {type:'getWidgetList'}
 *     {type:'shutdown'}
 *
 *   Worker → Main:
 *     {type:'log', level, msg}
 *     {type:'ready', fileCount}
 *     {type:'widgetList', data}
 *     {type:'worldGLCommands', commands}  (future — command buffer for world-space rendering)
 *     {type:'error', msg}
 */

import { LuaRuntime, type LuaValue, luaTable } from './lua-runtime.js';
import { LuaGLBridge } from './lua-gl-bridge.js';
import {
    buildSpringGlobals,
    type SpringAPIContext,
} from './lua-spring-api.js';

// ── Types ──────────────────────────────────────────────────────────────

interface MapDataTransfer {
    mapx: number;
    mapy: number;
    squareSize: number;
    minHeight: number;
    maxHeight: number;
    widthElmos: number;
    heightElmos: number;
    heightmap: Uint16Array;
    mapSourceUrl: string;
}

// ── VFS state ──────────────────────────────────────────────────────────

const vfsFiles = new Map<string, string>();
const vfsPathMap = new Map<string, string>();
const vfsDirCache = new Map<string, string[]>();
const vfsSubdirCache = new Map<string, string[]>();

function vfsRegister(path: string, content: string): void {
    vfsFiles.set(path, content);
    vfsPathMap.set(path.toLowerCase(), path);

    const lastSlash = path.lastIndexOf('/');
    if (lastSlash >= 0) {
        const dir = path.substring(0, lastSlash + 1);
        const file = path.substring(lastSlash + 1);

        if (!vfsDirCache.has(dir)) vfsDirCache.set(dir, []);
        vfsDirCache.get(dir)!.push(file);

        const parts = path.split('/');
        for (let i = 1; i < parts.length - 1; i++) {
            const parent = parts.slice(0, i).join('/') + '/';
            const child = parts[i];
            if (!vfsSubdirCache.has(parent)) vfsSubdirCache.set(parent, []);
            const subs = vfsSubdirCache.get(parent)!;
            if (!subs.includes(child)) subs.push(child);
        }
    }
}

function vfsLookup(path: string): string | undefined {
    const exact = vfsFiles.get(path);
    if (exact !== undefined) return exact;
    const withPrefix = vfsFiles.get('LuaUI/' + path);
    if (withPrefix !== undefined) return withPrefix;
    const lower = path.toLowerCase();
    const canonical = vfsPathMap.get(lower);
    if (canonical) return vfsFiles.get(canonical);
    const canonicalPrefixed = vfsPathMap.get(('LuaUI/' + path).toLowerCase());
    if (canonicalPrefixed) return vfsFiles.get(canonicalPrefixed);
    return undefined;
}

// ── HTTP VFS prefetch ──────────────────────────────────────────────────

async function prefetchAllGameFiles(baseUrl: string): Promise<void> {
    const queue = ['LuaUI', 'LuaRules', 'LuaRules/Utilities',
        'LuaRules/Configs', 'Configs'];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const dir = queue.shift()!;
        if (visited.has(dir.toLowerCase())) continue;
        visited.add(dir.toLowerCase());

        try {
            const res = await fetch(`${baseUrl}/${dir}`);
            if (!res.ok) continue;
            const entries = await res.json() as { name: string; type: string }[];

            const fileFetches: Promise<void>[] = [];
            for (const e of entries) {
                const fullPath = `${dir}/${e.name}`;
                if (e.type === 'file' &&
                    (e.name.endsWith('.lua') || e.name.endsWith('.txt'))) {
                    if (vfsFiles.has(fullPath)) continue;
                    fileFetches.push((async () => {
                        try {
                            const fRes = await fetch(`${baseUrl}/${fullPath}`);
                            if (fRes.ok) vfsRegister(fullPath, await fRes.text());
                        } catch { /* silent */ }
                    })());
                } else if (e.type === 'dir' || e.type === 'directory') {
                    queue.push(fullPath);
                }
            }
            await Promise.all(fileFetches);
        } catch { /* silent */ }
    }
}

// ── Logging ────────────────────────────────────────────────────────────

function postLog(level: number, msg: string): void {
    self.postMessage({ type: 'log', level, msg });
}

// ── localStorage bridge ────────────────────────────────────────────────
// Workers can't access localStorage directly, so we use synchronous
// messaging via a SharedArrayBuffer or just accept that config persistence
// won't work until we add a proper bridge. For now, config reads return
// null (widgets start with defaults) and writes are no-ops.

function loadFromStorage(_key: string): string | null {
    // TODO: bridge to main thread localStorage
    return null;
}

function saveToStorage(_key: string, _value: string): void {
    // TODO: bridge to main thread localStorage
    // For now, post a message so main thread can save it
    self.postMessage({ type: 'storage:set', key: _key, value: _value });
}

// ── Main init ──────────────────────────────────────────────────────────

let runtime: LuaRuntime | null = null;
let bridge: LuaGLBridge | null = null;
let startTime = performance.now() / 1000;
let frameInterval: ReturnType<typeof setInterval> | null = null;

// Mouse state updated by main thread messages
let mouseX = 0, mouseY = 0;
let mouseButton1 = false, mouseButton2 = false, mouseButton3 = false;

async function init(
    canvas: OffscreenCanvas,
    gameId: string,
    lobbyUrl: string,
    mapData: MapDataTransfer,
): Promise<void> {
    const baseUrl = `${lobbyUrl}/api/games/data/${gameId}`;
    startTime = performance.now() / 1000;

    // 1. Prefetch VFS
    await prefetchAllGameFiles(baseUrl);
    postLog(2, `VFS: ${vfsFiles.size} files prefetched`);

    // 2. Create GL context on OffscreenCanvas for 2D UI rendering
    const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext;

    if (!gl) {
        postLog(4, 'Failed to create WebGL2 context on OffscreenCanvas');
        self.postMessage({ type: 'error', msg: 'No WebGL2 on OffscreenCanvas' });
        return;
    }

    // 3. Create Lua runtime and GL bridge
    runtime = new LuaRuntime('LuaUI');
    bridge = new LuaGLBridge(gl, mapData.mapSourceUrl);

    const ctx: SpringAPIContext = {
        mapSizeX: mapData.widthElmos,
        mapSizeZ: mapData.heightElmos,
        heightmap: mapData.heightmap,
        heightmapWidth: mapData.mapx + 1,
        heightmapHeight: mapData.mapy + 1,
        minHeight: mapData.minHeight,
        maxHeight: mapData.maxHeight,
        squareSize: mapData.squareSize,
        vfsFiles,
        gameRulesParams: new Map(),
        getGameSeconds: () => (performance.now() / 1000) - startTime,
    };

    // 4. Install engine globals
    installEngineGlobals(runtime, bridge, ctx, gameId);

    // 5. Install VFS callbacks
    installVFS(runtime);

    // 6. Install error tracking
    runtime.doString(`
        _widgetErrors = {}
        local origEcho = Spring.Echo
        Spring.Echo = function(...)
            local msg = table.concat({...}, "\\t")
            if msg:find("Failed to load") then
                _widgetErrors[#_widgetErrors+1] = msg
            end
            return origEcho(...)
        end
        local origLog = Spring.Log
        Spring.Log = function(section, level, ...)
            local msg = table.concat({...}, "\\t")
            if msg:find("Failed to load") then
                _widgetErrors[#_widgetErrors+1] = msg
            end
            return origLog(section, level, ...)
        end
    `, 'error_tracker');

    // 7. Bootstrap
    postLog(2, 'Starting bootstrap...');
    const bootStart = performance.now();
    const bootErr = runtime.doString(`
        local ok, err = pcall(function()
            VFS.Include("LuaUI/camain.lua", nil, VFS.GAME)
        end)
        if not ok then
            Spring.Echo("[LuaUI] Bootstrap failed: " .. tostring(err))
            error(err)
        end
    `, 'bootstrap');

    postLog(2, `Bootstrap completed in ${(performance.now() - bootStart).toFixed(0)}ms`);
    if (bootErr) {
        postLog(4, `Bootstrap failed: ${bootErr}`);
    }

    // 8. Start frame loop (30fps — matches Spring's GAME_SPEED)
    frameInterval = setInterval(() => {
        if (!runtime) return;
        runFrame(runtime, gl);
    }, 33);

    // Report which callins widgets registered so main thread only sends needed events
    const registeredCallins = getRegisteredCallins(runtime);
    self.postMessage({ type: 'ready', fileCount: vfsFiles.size, callins: registeredCallins });
}

function runFrame(rt: LuaRuntime, gl: WebGL2RenderingContext): void {
    // Clear the overlay canvas (transparent)
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Update callin
    rt.doString(`
        if Update then
            local ok, err = pcall(Update)
            if not ok then Spring.Echo("[LuaUI] Update error: " .. tostring(err)) end
        end
    `, 'callin:Update');

    // DrawScreen callin — renders 2D UI on the OffscreenCanvas
    rt.doString(`
        if DrawScreen then
            local vsx, vsy = Spring.GetViewSizes()
            local ok, err = pcall(DrawScreen, vsx, vsy)
            if not ok then Spring.Echo("[LuaUI] DrawScreen error: " .. tostring(err)) end
        end
    `, 'callin:DrawScreen');
}

// ── Engine globals ─────────────────────────────────────────────────────

function installEngineGlobals(
    rt: LuaRuntime,
    glBridge: LuaGLBridge,
    ctx: SpringAPIContext,
    gameId: string,
): void {
    const springGlobals = buildSpringGlobals(ctx);
    const glGlobal = glBridge.buildGlGlobal();

    // Override Spring.GetMouseState to use worker-tracked mouse state
    (springGlobals.Spring as Record<string, LuaValue>).GetMouseState = () => {
        return [mouseX, mouseY, mouseButton1, mouseButton2, mouseButton3];
    };

    // Override Spring.Echo to route to main thread
    (springGlobals.Spring as Record<string, LuaValue>).Echo =
        (...args: LuaValue[]) => {
            const msg = args.map(a => String(a ?? '')).join('\t');
            const level = msg.includes('error') || msg.includes('Error') ? 4
                : msg.includes('warn') || msg.includes('Warn') ? 3 : 2;
            postLog(level, msg);
        };

    // Install all globals except VFS (set up separately in Lua)
    for (const [k, v] of Object.entries(springGlobals)) {
        if (k === 'VFS') continue;
        rt.setGlobal(k, v);
    }
    rt.setGlobal('gl', glGlobal);

    // gl fallback metatable
    rt.doString(`
        setmetatable(gl, {
            __index = function(t, k)
                local stub = function(...) end
                rawset(t, k, stub)
                return stub
            end
        })
    `, 'gl_fallback');

    rt.setGlobal('LUAUI_DIRNAME', 'LuaUI/');
    rt.setGlobal('LUAUI_VERSION', `spring-web LuaUI v0.3 (${gameId})`);

    rt.setGlobal('Script', {
        CreateScream: () => ({ func: null }),
        GetSynced: () => false,
        LuaUI: () => ({}),
        IsEngineMinVersion: () => true,
        UpdateCallIn: () => {},
        LuaGaia: () => ({}),
        LuaRules: () => ({}),
    });

    rt.setGlobal('LOG', { ERROR: 0, WARNING: 1, INFO: 2, DEBUG: 3 });

    rt.setGlobal('UnitDefs', {});
    rt.setGlobal('UnitDefNames', {});
    rt.setGlobal('WeaponDefs', {});
    rt.setGlobal('WeaponDefNames', {});
    rt.setGlobal('FeatureDefs', {});
    rt.setGlobal('FeatureDefNames', {});

    rt.doString(CMD_GLOBALS_LUA, 'cmd_globals');

    rt.doString(`
        tracy = setmetatable({}, {
            __index = function() return function() end end
        })
    `, 'tracy_stub');

    rt.doString(LUA_COMPAT_SHIM, 'compat_shim');

    rt.setGlobal('os', {
        remove: () => [null, 'os.remove disabled in browser'],
        rename: () => [null, 'os.rename disabled in browser'],
        clock: () => performance.now() / 1000,
        time: () => Math.floor(Date.now() / 1000),
        date: (_fmt: LuaValue) => new Date().toISOString(),
        difftime: (t2: LuaValue, t1: LuaValue) => Number(t2 ?? 0) - Number(t1 ?? 0),
    });

    // io/loadfile stubs
    installIOStubs(rt, gameId);
}

function installIOStubs(rt: LuaRuntime, gameId: string): void {
    const storagePrefix = `luaui:${gameId}:`;

    rt.doString(`
        local _storagePrefix = "${escapeLuaString(storagePrefix)}"

        function loadfile(path)
            if not path then return nil, "no path" end
            local source = VFS._writeCache and (VFS._writeCache[path] or VFS._writeCache[path:lower()])
            if not source then
                local stored = _loadFromStorage(_storagePrefix .. path)
                if stored then source = stored end
            end
            if not source then
                return nil, "file not found: " .. path
            end
            return load(source, path, "t")
        end

        function dofile(path)
            local chunk, err = loadfile(path)
            if not chunk then error(err, 2) end
            return chunk()
        end
    `, 'loadfile_shim');

    rt.setGlobal('_loadFromStorage', (key: LuaValue) => {
        return loadFromStorage(String(key));
    });
    rt.setGlobal('_saveToStorage', (key: LuaValue, value: LuaValue) => {
        saveToStorage(String(key), String(value));
    });

    rt.doString(`
        local _storagePrefix = "${escapeLuaString(storagePrefix)}"
        io = io or {}
        io.open = function(path, mode)
            if not path then return nil, "no path" end
            mode = mode or "r"
            if mode:find("w") or mode:find("a") then
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
                    VFS._writeCache[path] = content
                end
                return f
            else
                local content = VFS._writeCache and (VFS._writeCache[path]
                    or VFS._writeCache[path:lower()])
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

// ── VFS installation ───────────────────────────────────────────────────

function installVFS(rt: LuaRuntime): void {
    rt.setGlobal('_vfsLookup', (path: LuaValue) => {
        return vfsLookup(String(path)) ?? null;
    });

    rt.setGlobal('_vfsDirList', (dir: LuaValue) => {
        const d = String(dir);
        const files = vfsDirCache.get(d) ?? vfsDirCache.get(d.toLowerCase());
        return luaTable(...(files ?? []));
    });

    rt.setGlobal('_vfsSubDirs', (dir: LuaValue) => {
        const d = String(dir);
        const subs = vfsSubdirCache.get(d) ?? vfsSubdirCache.get(d.toLowerCase());
        return luaTable(...(subs ?? []));
    });

    rt.doString(VFS_IMPLEMENTATION_LUA, 'vfs_impl');
}

// ── Callin detection ───────────────────────────────────────────────────

/** Check which input-related callins have widget handlers registered */
function getRegisteredCallins(rt: LuaRuntime): string[] {
    const result = rt.evalString(`
        local callins = {}
        if widgetHandler then
            -- cawidgets.lua creates FooList tables for each callin with registered widgets
            local names = {
                'KeyPress', 'KeyRelease',
                'MousePress', 'MouseRelease', 'MouseMove', 'MouseWheel',
                'IsAbove', 'GetTooltip',
                'TextInput', 'TextEditing',
            }
            for _, name in ipairs(names) do
                local list = widgetHandler[name .. 'List']
                if list and #list > 0 then
                    callins[#callins+1] = name
                end
            end
        end
        return table.concat(callins, ",")
    `);
    if (!result || result === '') return [];
    return String(result).split(',');
}

// ── Widget list query ──────────────────────────────────────────────────

function getWidgetList(): string {
    if (!runtime) return '';
    return String(runtime.evalString(`
        local entries = {}
        if widgetHandler then
            for _, w in ipairs(widgetHandler.widgets or {}) do
                local info = w.whInfo or {}
                entries[#entries+1] = "active|" .. (info.name or "?") .. "|" .. (info.author or "") .. "|" .. (info.basename or "")
            end
            for name, info in pairs(widgetHandler.knownWidgets or {}) do
                if not info.active then
                    entries[#entries+1] = "disabled|" .. name .. "|" .. (info.author or "") .. "|" .. (info.basename or "")
                end
            end
        end
        for _, errMsg in ipairs(_widgetErrors or {}) do
            entries[#entries+1] = "failed|||| " .. errMsg
        end
        return table.concat(entries, "\\n")
    `) ?? '');
}

function shutdown(): void {
    if (frameInterval) {
        clearInterval(frameInterval);
        frameInterval = null;
    }
    if (runtime) {
        runtime.doString(`
            if Shutdown then
                local ok, err = xpcall(Shutdown, function(e) return e end)
                if not ok then
                    Spring.Echo("[LuaUI] Shutdown error (non-fatal): " .. tostring(err))
                end
            end
        `, 'shutdown');
        runtime.dispose();
        runtime = null;
    }
    bridge = null;
}

// ── Message handler ────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    switch (msg.type) {
        case 'init':
            try {
                await init(msg.canvas, msg.gameId, msg.lobbyUrl, msg.mapData);
            } catch (err) {
                postLog(4, `Init failed: ${err}`);
                self.postMessage({ type: 'error', msg: String(err) });
            }
            break;

        case 'keypress':
            if (runtime) {
                runtime.doString(`
                    if KeyPress then
                        pcall(KeyPress, ${msg.keyCode}, { alt=${msg.alt}, ctrl=${msg.ctrl}, meta=${msg.meta}, shift=${msg.shift} }, false)
                    end
                `, 'callin:KeyPress');
            }
            break;

        case 'keyrelease':
            if (runtime) {
                runtime.doString(`
                    if KeyRelease then
                        pcall(KeyRelease, ${msg.keyCode}, { alt=${msg.alt}, ctrl=${msg.ctrl}, meta=${msg.meta}, shift=${msg.shift} })
                    end
                `, 'callin:KeyRelease');
            }
            break;

        case 'mousepress':
            mouseX = msg.x; mouseY = msg.y;
            if (msg.button === 1) mouseButton1 = true;
            if (msg.button === 2) mouseButton2 = true;
            if (msg.button === 3) mouseButton3 = true;
            if (runtime) {
                runtime.doString(`
                    if MousePress then
                        pcall(MousePress, ${msg.x}, ${msg.y}, ${msg.button})
                    end
                `, 'callin:MousePress');
            }
            break;

        case 'mouserelease':
            mouseX = msg.x; mouseY = msg.y;
            if (msg.button === 1) mouseButton1 = false;
            if (msg.button === 2) mouseButton2 = false;
            if (msg.button === 3) mouseButton3 = false;
            if (runtime) {
                runtime.doString(`
                    if MouseRelease then
                        pcall(MouseRelease, ${msg.x}, ${msg.y}, ${msg.button})
                    end
                `, 'callin:MouseRelease');
            }
            break;

        case 'mousewheel':
            if (runtime) {
                runtime.doString(`
                    if MouseWheel then
                        pcall(MouseWheel, ${msg.up}, ${msg.value})
                    end
                `, 'callin:MouseWheel');
            }
            break;

        case 'mousemove':
            mouseX = msg.x; mouseY = msg.y;
            if (runtime) {
                runtime.doString(`
                    if MouseMove then
                        pcall(MouseMove, ${msg.x}, ${msg.y}, ${msg.dx}, ${msg.dy}, ${msg.button})
                    end
                `, 'callin:MouseMove');
            }
            break;

        case 'getWidgetList':
            self.postMessage({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'resize':
            // Update canvas size for DrawScreen
            if (bridge) {
                // The OffscreenCanvas size is set by the main thread via canvas.width/height
                // before sending this message
            }
            break;

        case 'shutdown':
            shutdown();
            break;
    }
};

// ── Lua constants (shared with old widget manager) ─────────────────────

const LUA_COMPAT_SHIM = `
if not loadstring then loadstring = load end
if not unpack then unpack = table.unpack end
if not table.getn then table.getn = function(t) return #t end end
if not math.mod then math.mod = math.fmod end

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

if not gcinfo then
    gcinfo = function()
        return math.floor(collectgarbage("count"))
    end
end
`;

const VFS_IMPLEMENTATION_LUA = `
VFS = VFS or {}
VFS.RAW_ONLY = 1; VFS.ZIP_ONLY = 2; VFS.RAW_FIRST = 3; VFS.ZIP_FIRST = 4
VFS.ZIP = 5; VFS.RAW = 6; VFS.MAP = 7; VFS.GAME = 8; VFS.BASE = 9; VFS.MENU = 10
VFS.DEF_MODE = 5
VFS._writeCache = {}

local function normalizePath(path)
    if not path then return nil end
    path = path:gsub("\\\\", "/")
    if path:sub(1,1) == "/" then path = path:sub(2) end
    if path:sub(1,1) == ":" and #path >= 3 and path:sub(3,3) == ":" then
        path = path:sub(4)
    end
    return path
end

local function vfsLookup(path)
    local cached = VFS._writeCache[path]
    if cached then return cached end
    return _vfsLookup(path)
end

-- Include-loop detection
local _includeStack = {}

VFS.Include = function(path, env, mode)
    if not path then return nil end
    path = normalizePath(path)
    if _includeStack[path] then
        Spring.Echo("[VFS.Include] circular include detected: " .. path)
        return nil
    end
    local source = vfsLookup(path)
    if not source then
        Spring.Echo("[VFS.Include] not found: " .. path)
        return nil
    end
    _includeStack[path] = true
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
    if env ~= _G and not getmetatable(env) then
        setmetatable(env, { __index = _G })
    end
    local chunk, err = load(source, path, "t", env)
    if not chunk then
        _includeStack[path] = nil
        Spring.Echo("[VFS.Include] compile error in " .. path .. ": " .. (err or ""))
        return nil
    end
    local ok, result = pcall(chunk)
    _includeStack[path] = nil
    if not ok then
        Spring.Echo("[VFS.Include] runtime error in " .. path .. ": " .. tostring(result))
        return nil
    end
    return result
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
    local files = _vfsDirList(path)
    if not files or #files == 0 then return {} end
    if pattern then
        local ext = pattern:match("^%*(.+)$")
        if ext then
            local result = {}
            for i = 1, #files do
                local f = files[i]
                if f:sub(-#ext) == ext then
                    result[#result + 1] = path .. f
                end
            end
            return result
        end
    end
    local result = {}
    for i = 1, #files do
        result[#result + 1] = path .. files[i]
    end
    return result
end

VFS.SubDirs = function(path, pattern, mode)
    path = path or ""
    path = path:gsub("\\\\", "/")
    if path:sub(-1) ~= "/" then path = path .. "/" end
    local subs = _vfsSubDirs(path)
    if not subs or #subs == 0 then return {} end
    local result = {}
    for i = 1, #subs do
        result[#result + 1] = path .. subs[i] .. "/"
    end
    return result
end
`;

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

// ── Helpers ────────────────────────────────────────────────────────────

function escapeLuaString(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\0');
}
