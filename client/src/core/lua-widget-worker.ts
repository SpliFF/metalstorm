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

        // Use lowercase keys for directory caches so case-insensitive
        // lookups work (ZK code uses "skins/" but disk has "Skins/").
        const dirKey = dir.toLowerCase();
        if (!vfsDirCache.has(dirKey)) vfsDirCache.set(dirKey, []);
        vfsDirCache.get(dirKey)!.push(file);

        const parts = path.split('/');
        for (let i = 1; i < parts.length - 1; i++) {
            const parent = parts.slice(0, i).join('/').toLowerCase() + '/';
            const child = parts[i];
            if (!vfsSubdirCache.has(parent)) vfsSubdirCache.set(parent, []);
            const subs = vfsSubdirCache.get(parent)!;
            // Avoid duplicate subdirs with different case
            if (!subs.some(s => s.toLowerCase() === child.toLowerCase())) {
                subs.push(child);
            }
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
    const queue = [
        'LuaUI', 'LuaRules', 'LuaRules/Utilities',
        'LuaRules/Configs', 'Configs',
        // Chili UI framework has deep directory trees that may not
        // be reached by BFS from LuaUI if the walker doesn't descend
        // into all Widget subdirectories quickly enough.
        'LuaUI/Widgets/chili', 'LuaUI/Widgets/chili_old',
        'gamedata',
    ];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const dir = queue.shift()!;
        if (visited.has(dir.toLowerCase())) continue;
        visited.add(dir.toLowerCase());

        try {
            const res = await fetch(`${baseUrl}/${dir}`);
            if (!res.ok) continue;
            const entries = await res.json() as { name: string; type: string }[];

            // Batch file fetches in groups of 30 to avoid overwhelming
            // the single-threaded lobby HTTP server with hundreds of
            // concurrent connections. Failing files are retried once.
            const toFetch: string[] = [];
            for (const e of entries) {
                const fullPath = `${dir}/${e.name}`;
                if (e.type === 'file' &&
                    (e.name.endsWith('.lua') || e.name.endsWith('.txt'))) {
                    if (vfsFiles.has(fullPath)) continue;
                    toFetch.push(fullPath);
                } else if (e.type === 'dir' || e.type === 'directory') {
                    queue.push(fullPath);
                }
            }
            const BATCH = 30;
            const failed: string[] = [];
            for (let i = 0; i < toFetch.length; i += BATCH) {
                const batch = toFetch.slice(i, i + BATCH);
                await Promise.all(batch.map(async (fp) => {
                    try {
                        const fRes = await fetch(`${baseUrl}/${fp}`);
                        if (fRes.ok) vfsRegister(fp, await fRes.text());
                        else failed.push(fp);
                    } catch { failed.push(fp); }
                }));
            }
            // Retry once for files that failed (transient network issues)
            for (const fp of failed) {
                try {
                    const fRes = await fetch(`${baseUrl}/${fp}`);
                    if (fRes.ok) vfsRegister(fp, await fRes.text());
                } catch { /* silent */ }
            }
        } catch { /* silent */ }
    }
}

// ── Logging ────────────────────────────────────────────────────────────

// Rate-limit log posting to prevent a runaway widget loop from
// filling the main thread's postMessage queue and OOMing the tab.
// We keep a sliding window of log timestamps over the last second.
const logTimes: number[] = [];
const LOG_RATE_LIMIT_PER_SEC = 500;
let logDropCount = 0;

function postLog(level: number, msg: string): void {
    const now = performance.now();
    while (logTimes.length && logTimes[0] < now - 1000) logTimes.shift();
    if (logTimes.length >= LOG_RATE_LIMIT_PER_SEC) {
        logDropCount++;
        // Periodically report drops so silence doesn't hide the flood.
        if ((logDropCount & 0x3ff) === 0) {
            const post = self.postMessage as (msg: unknown) => void;
            post({ type: 'log', level: 3, msg: `[LuaUI] log rate-limited: ${logDropCount} messages dropped` });
        }
        return;
    }
    logTimes.push(now);
    postToMain({ type: 'log', level, msg });
}

/// Wrap every outgoing postMessage so we can diagnose the shutdown loop.
/// Level-1 debug traffic so it's hidden from normal views but visible
/// via the debug console filter. `log` messages are skipped to avoid
/// recursive self-description of the log pipe.
function postToMain(msg: Record<string, unknown>, transfer?: Transferable[]): void {
    const post = self.postMessage as (msg: unknown, transfer?: Transferable[]) => void;
    if (transfer && transfer.length) {
        post(msg, transfer);
    } else {
        post(msg);
    }
}

function describeMessage(msg: Record<string, unknown>): string {
    const t = String(msg.type ?? '?');
    // Short summary per message type; avoids dumping huge payloads.
    switch (t) {
        case 'ready':      return `ready (fileCount=${msg.fileCount}, callins=${(msg.callins as string[])?.join(',') || 'none'})`;
        case 'error':      return `error: ${String(msg.msg ?? '')}`;
        case 'storage:set':return `storage:set key=${msg.key}`;
        case 'widgetList': return `widgetList (${String(msg.data ?? '').length} bytes)`;
        case 'worldGLCommands': return `worldGLCommands (${(msg.commands as unknown[])?.length ?? '?'} cmds)`;
        default:           return t;
    }
}

function describeInboundMessage(msg: Record<string, unknown>): string {
    const t = String(msg?.type ?? '?');
    switch (t) {
        case 'init':        return `init (gameId=${msg.gameId})`;
        case 'shutdown':    return 'shutdown';
        case 'resize':      return `resize ${msg.width}x${msg.height}`;
        case 'keypress':    return `keypress keyCode=${msg.keyCode}`;
        case 'keyrelease':  return `keyrelease keyCode=${msg.keyCode}`;
        case 'mousepress':  return `mousepress @${msg.x},${msg.y} btn=${msg.button}`;
        case 'mouserelease':return `mouserelease @${msg.x},${msg.y} btn=${msg.button}`;
        case 'mousemove':   return `mousemove @${msg.x},${msg.y}`;
        case 'mousewheel':  return `mousewheel up=${msg.up} value=${msg.value}`;
        case 'getWidgetList': return 'getWidgetList';
        case 'toggleWidget':  return `toggleWidget name=${msg.name}`;
        case 'enableWidget':  return `enableWidget name=${msg.name}`;
        case 'disableWidget': return `disableWidget name=${msg.name}`;
        default:              return t;
    }
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
    postToMain({ type: 'storage:set', key: _key, value: _value });
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

    postLog(2, `[LuaUI] init step 1/8: VFS prefetch starting from ${baseUrl}`);

    // 1. Prefetch VFS
    await prefetchAllGameFiles(baseUrl);
    postLog(2, `[LuaUI] init step 1/8 done: VFS ${vfsFiles.size} files prefetched`);

    // 2. Create GL context on OffscreenCanvas for 2D UI rendering
    const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext;

    if (!gl) {
        postLog(4, 'Failed to create WebGL2 context on OffscreenCanvas');
        postToMain({ type: 'error', msg: 'No WebGL2 on OffscreenCanvas' });
        return;
    }

    postLog(2, '[LuaUI] init step 2/8 done: WebGL2 context ready');

    // 3. Create Lua runtime and GL bridge
    runtime = new LuaRuntime('LuaUI');
    bridge = new LuaGLBridge(gl, mapData.mapSourceUrl);
    postLog(2, '[LuaUI] init step 3/8 done: Lua runtime + GL bridge created');

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
    postLog(2, '[LuaUI] init step 4/8 done: engine globals installed');

    // 5. Install VFS callbacks
    installVFS(runtime);
    postLog(2, '[LuaUI] init step 5/8 done: VFS callbacks installed');

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
    postLog(2, '[LuaUI] init step 6/8 done: error tracker installed');

    // 6b. Pre-install shutdown recursion guard as a delayed hook.
    // cawidgets.lua defines widgetHandler.Shutdown. We wrap it the
    // first time it's referenced (via metatable) so repeated calls
    // become no-ops. This has to be set up BEFORE camain.lua runs,
    // because widget load errors can cascade into widgetHandler
    // methods.
    runtime.doString(`
        local _shuttingDown = false
        _widgetHandler_shutdown_wrap = function(wh)
            if not wh or type(wh.Shutdown) ~= 'function' then return end
            if wh.__shutdownWrapped then return end
            wh.__shutdownWrapped = true
            local orig = wh.Shutdown
            wh.Shutdown = function(self, ...)
                if _shuttingDown then
                    Spring.Echo("[LuaUI] widgetHandler:Shutdown re-entry blocked")
                    return
                end
                _shuttingDown = true
                local ok, err = pcall(orig, self, ...)
                if not ok then
                    Spring.Echo("[LuaUI] widgetHandler:Shutdown errored: " .. tostring(err))
                end
            end
        end
    `, 'shutdown_guard_pre');
    // Pre-install a nil-safe math.round. ZK's numberfunctions.lua
    // defines one but it crashes on nil input, which happens during
    // epicmenu's include chain. This version falls back to 0 for nil.
    runtime.doString(`
        function math.round(num, idp)
            num = num or 0
            return ("%." .. (((num==0) and 0) or idp or 0) .. "f"):format(num)
        end
    `, 'math_round_fix');
    postLog(2, '[LuaUI] init step 6b/8 done: pre-guard installed');

    // 7. Bootstrap
    postLog(2, '[LuaUI] init step 7/8: starting bootstrap (VFS.Include camain.lua)...');
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

    postLog(2, `[LuaUI] init step 7/8 done: bootstrap completed in ${(performance.now() - bootStart).toFixed(0)}ms`);
    if (bootErr) {
        postLog(4, `Bootstrap failed: ${bootErr}`);
    }

    // Patch Chili's widget:Dispose to guard against nil screen0.
    // The old-chili path defines Dispose as `screen0:Dispose()` but
    // screen0 is an upvalue that stays nil if texturehandler fails
    // during Initialize. Without this guard, every Chili Dispose call
    // recurses through the DebugHandler error handler, producing
    // hundreds of log messages that consume the rate limit budget.
    runtime.doString(`
        if widgetHandler then
            for _, w in ipairs(widgetHandler.widgets) do
                if w.whInfo and w.whInfo.name == "Chili Framework" and w.Dispose then
                    local origDispose = w.Dispose
                    w.Dispose = function(self, ...)
                        local ok, err = pcall(origDispose, self, ...)
                        if not ok then
                            -- Silently ignore nil screen0 errors
                        end
                    end
                    break
                end
            end
        end
    `, 'chili_dispose_guard');

    // Apply the pre-installed shutdown guard to widgetHandler now that
    // camain.lua has loaded it.
    runtime.doString(`
        if _widgetHandler_shutdown_wrap and widgetHandler then
            _widgetHandler_shutdown_wrap(widgetHandler)
        end
    `, 'shutdown_guard_apply');
    postLog(2, '[LuaUI] init done: shutdown recursion guard applied');

    // 8. Start frame loop (30fps — matches Spring's GAME_SPEED)
    // Guard against re-entry: if a previous frame is still running
    // (e.g. a widget's Update is slow), skip rather than stacking.
    let frameRunning = false;
    frameInterval = setInterval(() => {
        if (!runtime || shuttingDown || frameRunning) return;
        frameRunning = true;
        try {
            runFrame(runtime, gl);
        } finally {
            frameRunning = false;
        }
    }, 33);

    // Report which callins widgets registered so main thread only sends needed events
    const registeredCallins = getRegisteredCallins(runtime);
    postToMain({ type: 'ready', fileCount: vfsFiles.size, callins: registeredCallins });
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
        const d = String(dir).toLowerCase();
        return luaTable(...(vfsDirCache.get(d) ?? []));
    });

    rt.setGlobal('_vfsSubDirs', (dir: LuaValue) => {
        const d = String(dir).toLowerCase();
        return luaTable(...(vfsSubdirCache.get(d) ?? []));
    });

    // Purge a file from the VFS cache so the next VFS.LoadFile re-fetches
    // it from the server. Used by enableWidget to force a reload.
    rt.setGlobal('_vfsPurge', (path: LuaValue) => {
        const p = String(path);
        vfsFiles.delete(p);
        const lower = p.toLowerCase();
        const canonical = vfsPathMap.get(lower);
        if (canonical) {
            vfsFiles.delete(canonical);
            vfsPathMap.delete(lower);
        }
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
    // Returns one line per widget. Fields are pipe-delimited:
    //   status|name|author|basename|error|desc|date|license|layer|enabled|handler
    return String(runtime.evalString(`
        local entries = {}
        local esc = function(s) return (tostring(s or "")):gsub("|", "/") end
        if widgetHandler then
            for _, w in ipairs(widgetHandler.widgets or {}) do
                local info = w.whInfo or {}
                local gi = (w.GetInfo and type(w.GetInfo) == "function") and w:GetInfo() or {}
                entries[#entries+1] = "active|" .. esc(info.name) .. "|" .. esc(info.author)
                    .. "|" .. esc(info.basename) .. "||" .. esc(gi.desc or info.desc)
                    .. "|" .. esc(gi.date) .. "|" .. esc(gi.license)
                    .. "|" .. esc(gi.layer or info.layer) .. "|" .. esc(tostring(gi.enabled))
                    .. "|" .. esc(tostring(gi.handler))
            end
            for name, info in pairs(widgetHandler.knownWidgets or {}) do
                if not info.active then
                    entries[#entries+1] = "disabled|" .. esc(name) .. "|" .. esc(info.author)
                        .. "|" .. esc(info.basename) .. "||" .. esc(info.desc)
                        .. "|||" .. esc(info.layer or "") .. "||"
                end
            end
        end
        for _, errMsg in ipairs(_widgetErrors or {}) do
            entries[#entries+1] = "failed||||| " .. esc(errMsg)
        end
        return table.concat(entries, "\\n")
    `) ?? '');
}

function escapeLuaStr(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Toggle a widget by name. */
function toggleWidget(name: string): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler then
            widgetHandler:ToggleWidget("${escapeLuaStr(name)}")
        end
    `, 'toggleWidget');
}

/** Enable a widget by name. Clears VFS cache for its file so the
 *  next load fetches fresh source from the server. */
function enableWidget(name: string): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler then
            -- Clear VFS cache for this widget so EnableWidget reloads from server
            local ki = widgetHandler.knownWidgets and widgetHandler.knownWidgets["${escapeLuaStr(name)}"]
            if ki and ki.filename and VFS._writeCache then
                VFS._writeCache[ki.filename] = nil
            end
            -- Also purge from the prefetched VFS map so VFS.LoadFile re-fetches
            if ki and ki.filename then
                _vfsPurge(ki.filename)
            end
            widgetHandler:EnableWidget("${escapeLuaStr(name)}")
        end
    `, 'enableWidget');
}

/** Disable a widget by name. */
function disableWidget(name: string): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler then
            widgetHandler:DisableWidget("${escapeLuaStr(name)}")
        end
    `, 'disableWidget');
}

let shuttingDown = false;

function shutdown(): void {
    // Idempotent: multiple shutdown messages from the main thread (e.g.
    // the startGame→dispose→new-manager path) shouldn't trigger multiple
    // widgetHandler:Shutdown runs. Each run iterates all ZK widgets and
    // can produce thousands of log entries — repeated runs compound into
    // a browser-killing flood.
    if (shuttingDown) {
        postLog(2, '[LuaUI] shutdown() ignored (already shutting down)');
        return;
    }
    shuttingDown = true;

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
    // Debug-level trace of inbound messages (skip high-frequency input
    // events to avoid drowning real log entries).
    if (msg.type !== 'mousemove') {
        postLog(1, `[LuaUI:main→worker] ${describeInboundMessage(msg)}`);
    }
    switch (msg.type) {
        case 'init':
            try {
                await init(msg.canvas, msg.gameId, msg.lobbyUrl, msg.mapData);
            } catch (err) {
                postLog(4, `Init failed: ${err}`);
                postToMain({ type: 'error', msg: String(err) });
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
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'toggleWidget':
            toggleWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'enableWidget':
            enableWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;


        case 'disableWidget':
            disableWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'resize':
            if (bridge && msg.width && msg.height) {
                bridge.resizeCanvas(msg.width, msg.height);
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
        if fn == nil or fn == 0 then
            -- Return the caller's _ENV (stack level 2)
            local info = debug.getinfo(2, "f")
            if info and info.func then
                local i = 1
                while true do
                    local name, val = debug.getupvalue(info.func, i)
                    if name == "_ENV" then return val
                    elseif not name then break end
                    i = i + 1
                end
            end
            return _G
        end
        if type(fn) == "number" then
            -- Stack level: 1=getfenv itself, 2=caller, fn+1=target
            local info = debug.getinfo(fn + 1, "f")
            if info and info.func then
                local i = 1
                while true do
                    local name, val = debug.getupvalue(info.func, i)
                    if name == "_ENV" then return val
                    elseif not name then break end
                    i = i + 1
                end
            end
            return _G
        end
        -- fn is a function
        local i = 1
        while true do
            local name, val = debug.getupvalue(fn, i)
            if name == "_ENV" then return val
            elseif not name then break end
            i = i + 1
        end
        return _G
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
    -- Intentionally do NOT add a __index=_G metatable to env here.
    -- Spring's real VFS.Include does NOT do that, and adding it turns
    -- the widget's environment into a leaky proxy to _G — widgets then
    -- accidentally invoke _G globals (like Shutdown, the widgetHandler
    -- dispatcher), triggering widgetHandler:Shutdown recursion.
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
