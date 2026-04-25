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
    createDefaultLiveState,
    type SpringAPIContext,
    type LiveState,
    type UnitEntry,
    type FeatureEntry,
} from './lua-spring-api.js';

// Engine-bundled test widgets. Loaded only when `?widgetTest` is active.
// Bundled here (not in any game's content) so the gl-bridge / Chili
// pipeline can be exercised against known-good widgets regardless of
// which game is loaded.
import dbgRenderTestSrc from '../lua-test-widgets/dbg_render_test.lua?raw';
import dbgRenderTestQuit from '../lua-test-widgets/quit.png?url';
import dbgRenderTestTick from '../lua-test-widgets/tick.png?url';
import dbgRenderTestPanel from '../lua-test-widgets/panel_0001.png?url';
import dbgChiliTestSrc from '../lua-test-widgets/dbg_chili_test.lua?raw';

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

// Track repeated messages to suppress spamming widgets.
const recentMsgs = new Map<string, number>();

function postLog(level: number, msg: string): void {
    // Suppress exact-duplicate messages (e.g. Key Unbinder spam).
    // Allow the first occurrence and then once every 100 repeats.
    const count = (recentMsgs.get(msg) ?? 0) + 1;
    recentMsgs.set(msg, count);
    if (count > 2 && (count & 0xff) !== 0) return;
    // Periodically clear to avoid unbounded map growth.
    if (recentMsgs.size > 500) recentMsgs.clear();

    const now = performance.now();
    while (logTimes.length && logTimes[0] < now - 1000) logTimes.shift();
    if (logTimes.length >= LOG_RATE_LIMIT_PER_SEC) {
        logDropCount++;
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
        case 'stateUpdate':   return `stateUpdate frame=${msg.gameFrame}`;
        case 'entityState':   return `entityState count=${msg.count} delta=${msg.isDelta}`;
        case 'entityDestroy': return `entityDestroy id=${msg.entityId}`;
        case 'resourceUpdate':return `resourceUpdate team=${msg.team}`;
        case 'gameInfo':      return `gameInfo frame=${msg.frame}`;
        default:              return t;
    }
}

// ── localStorage bridge ────────────────────────────────────────────────
// Workers can't access localStorage directly. Main thread sends all
// luaui:* entries at init time; writes update the local cache AND post
// back to main thread for persistence.

const storageCache: Record<string, string> = {};

function loadFromStorage(key: string): string | null {
    return storageCache[key] ?? null;
}

function saveToStorage(key: string, value: string): void {
    storageCache[key] = value;
    postToMain({ type: 'storage:set', key, value });
}

// ── Main init ──────────────────────────────────────────────────────────

let runtime: LuaRuntime | null = null;
let bridge: LuaGLBridge | null = null;
let startTime = performance.now() / 1000;
let frameInterval: ReturnType<typeof setInterval> | null = null;
let initBaseUrl = '';  // saved from init() for re-fetch on enable

// Mouse state updated by main thread messages
let mouseX = 0, mouseY = 0;
let mouseButton1 = false, mouseButton2 = false, mouseButton3 = false;

// Live game state updated by main thread messages, read by Spring API
const liveState: LiveState = createDefaultLiveState();

async function init(
    canvas: OffscreenCanvas,
    gameId: string,
    lobbyUrl: string,
    mapData: MapDataTransfer,
    soloWidget?: string,
): Promise<void> {
    const baseUrl = `${lobbyUrl}/api/games/data/${gameId}`;
    initBaseUrl = baseUrl;
    startTime = performance.now() / 1000;

    postLog(2, `[LuaUI] init step 1/8: VFS prefetch starting from ${baseUrl}`);

    // 1. Prefetch VFS
    await prefetchAllGameFiles(baseUrl);
    postLog(2, `[LuaUI] init step 1/8 done: VFS ${vfsFiles.size} files prefetched`);

    // 2. Create GL context on OffscreenCanvas for 2D UI rendering
    const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
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
    bridge.setGameBaseUrl(baseUrl);
    postLog(2, '[LuaUI] init step 3/8 done: Lua runtime + GL bridge created');

    // 3b. Inject engine-bundled test widgets when solo mode is active.
    // Source + textures live under client/src/lua-test-widgets/ and ship
    // with the client bundle, so they're available regardless of which
    // game is loaded. soloWidget may be a comma-separated list of needles
    // (e.g. "api_chili.lua,dbg_chili_test"); we inject any test widget
    // whose stem appears in the list.
    const soloNeedles = (soloWidget ?? '').split(',').map(s => s.trim());
    const wants = (stem: string) => soloNeedles.some(n => n.includes(stem));
    if (wants('dbg_render_test')) {
        vfsRegister('LuaUI/Widgets/dbg_render_test.lua', dbgRenderTestSrc);
        bridge.addAssetOverride('LuaUI/Images/quit.png', dbgRenderTestQuit);
        bridge.addAssetOverride('LuaUI/Images/tick.png', dbgRenderTestTick);
        bridge.addAssetOverride(
            'LuaUI/Widgets/chili/skins/Carbon/panel_0001.png',
            dbgRenderTestPanel,
        );
        postLog(2, '[LuaUI] Injected engine-bundled dbg_render_test widget + textures');
    }
    if (wants('dbg_chili_test')) {
        vfsRegister('LuaUI/Widgets/dbg_chili_test.lua', dbgChiliTestSrc);
        postLog(2, '[LuaUI] Injected engine-bundled dbg_chili_test widget');
    }

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

    // Expose texture search path configuration to Lua
    runtime.setGlobal('_addTextureSearchPath', (path: LuaValue) => {
        bridge!.addTextureSearchPaths(String(path));
    });
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
    // Clear any cached widget order files so Chili always loads with
    // defaults (previous sessions may have saved a "disabled" state).
    // Also patch the DebugHandler source in VFS to raise the error
    // tolerance — Chili's DebugHandler self-destructs after 5 errors
    // in 5 seconds, but our incomplete GL/API surface triggers more
    // harmless errors during init than native Spring.
    runtime.doString(`
        if VFS and VFS._writeCache then
            VFS._writeCache["LuaUI/Config/ZK_order.lua"] = nil
            VFS._writeCache["LuaUI/Config/widget_data.lua"] = nil
        end
    `, 'clear_widget_config');

    // Patch debughandler.lua in VFS before bootstrap loads it
    const debugHandlerPath = 'LuaUI/Widgets/chili_old/Handlers/debughandler.lua';
    const debugHandlerSrc = vfsLookup(debugHandlerPath);
    if (debugHandlerSrc) {
        const patched = debugHandlerSrc.replace(
            'DebugHandler.maxChiliErrors = 5',
            'DebugHandler.maxChiliErrors = 9999',
        );
        if (patched !== debugHandlerSrc) {
            vfsRegister(debugHandlerPath, patched);
            postLog(2, '[LuaUI] Patched DebugHandler: maxChiliErrors = 9999');
        }
    }

    // Patch cawidgets.lua HandleError to not remove handler widgets (like
    // Chili Framework). Our incomplete API surface causes harmless callin
    // errors that the real Spring engine doesn't hit. Without this, Chili
    // is removed after a single callin error.
    const cawidgetsPath = 'LuaUI/cawidgets.lua';
    const cawidgetsSrc = vfsLookup(cawidgetsPath);
    if (cawidgetsSrc) {
        let patched = cawidgetsSrc.replace(
            `if (funcName ~= 'Shutdown') then\n\t\twidgetHandler:RemoveWidget(widget)`,
            `if (funcName ~= 'Shutdown') then\n\t\tif widget.whInfo and widget.whInfo.handler then\n\t\t\tSpring.Log("LuaUI", 0, "Suppressed removal of handler widget: " .. (widget.whInfo.name or "?") .. " error in " .. funcName)\n\t\telse\n\t\t\twidgetHandler:RemoveWidget(widget)\n\t\tend`,
        );
        if (patched !== cawidgetsSrc) {
            postLog(2, '[LuaUI] Patched cawidgets.lua: handler widgets survive callin errors');
        } else {
            postLog(3, '[LuaUI] cawidgets.lua HandleError patch did not match');
        }

        // Solo-widget mode: filter widgetFiles down to just the matching
        // widgets so we can isolate gl-bridge / Chili pipeline issues.
        // Accepts comma-separated needles ("api_chili.lua,dbg_chili_test").
        if (soloWidget) {
            const needles = soloWidget
                .split(',')
                .map(s => s.replace(/[\\'"`]/g, '').trim())
                .filter(s => s.length > 0);
            const luaList = needles.map(n => `"${n}"`).join(', ');
            const marker = `local widgetFiles = VFS.DirList(WIDGET_DIRNAME, "*.lua", VFSMODE)`;
            const filterBlock = `${marker}\n\tdo\n\t\tlocal _needles = { ${luaList} }\n\t\tlocal _filtered = {}\n\t\tfor _, _f in ipairs(widgetFiles) do\n\t\t\tlocal _s = tostring(_f)\n\t\t\tfor _, _n in ipairs(_needles) do\n\t\t\t\tif _s:find(_n, 1, true) then\n\t\t\t\t\t_filtered[#_filtered+1] = _f\n\t\t\t\t\tbreak\n\t\t\t\tend\n\t\t\tend\n\t\tend\n\t\twidgetFiles = _filtered\n\t\tSpring.Echo("[LuaUI] Solo widget mode: filtered to " .. #widgetFiles .. " widget(s)")\n\tend`;
            const beforeFilter = patched;
            patched = patched.replace(marker, filterBlock);
            if (patched !== beforeFilter) {
                postLog(2, `[LuaUI] Patched cawidgets.lua: solo widget filter [${needles.join(', ')}]`);
            } else {
                postLog(3, '[LuaUI] cawidgets.lua solo widget filter — anchor not found');
            }
        }

        if (patched !== cawidgetsSrc) {
            vfsRegister(cawidgetsPath, patched);
        }
    }

    // Patch control.lua: disable _all_dlist caching. Chili's Control:Draw
    // checks _all_dlist first and short-circuits, skipping _own_dlist and
    // DrawChildren. The _all_dlist is recorded during Update (before
    // DrawScreen sets up projection/modelview), so the captured content
    // renders in the wrong matrix context. Disabling it forces the
    // individual _own_dlist + DrawChildren path which draws live each frame.
    const controlPath = 'LuaUI/Widgets/chili_old/controls/control.lua';
    const controlSrc = vfsLookup(controlPath);
    if (controlSrc) {
        // Disable _UpdateAllDList so _all_dlist is never created
        let patched = controlSrc.replace(
            'self:_UpdateAllDList()',
            '-- self:_UpdateAllDList() -- disabled: web renderer draws live',
        );
        // Also disable _children_dlist creation
        patched = patched.replace(
            'self._children_dlist = gl.CreateList(self.DrawChildrenForList,self)',
            '-- self._children_dlist = gl.CreateList(self.DrawChildrenForList,self) -- disabled',
        );
        // Also disable _own_dlist caching. Skin draws (DrawWindow / DrawPanel
        // etc.) call gl.TextureInfo to get TileImage dimensions for 9-slice
        // UV math. The first invocation runs before the async-loaded skin
        // texture has resolved, so TextureInfo returns the 1x1 placeholder
        // dimensions and the recorded UVs are wrong (out of [0,1], producing
        // a tiled-texture grid instead of a seamless 9-slice frame). Drawing
        // live each frame avoids stale-UV recordings — the cost is one extra
        // skin draw per frame per visible control.
        patched = patched.replace(
            'self._own_dlist = gl.CreateList(self.DrawControl, self)',
            '-- self._own_dlist = gl.CreateList(self.DrawControl, self) -- disabled: live draw',
        );
        if (patched !== controlSrc) {
            vfsRegister(controlPath, patched);
            postLog(2, '[LuaUI] Patched control.lua: disabled all dlist caching (live draws)');
        }
    }

    // Patch font.lua: _GetExtra has no case for valign="linecenter" and
    // falls through to 'a' (ascender), so chili Button / Label captions
    // pass valign="linecenter" but never get vertical centering. Add a
    // proper case mapping to the 'x' flag char so the font sees it.
    const fontPath = 'LuaUI/Widgets/chili_old/controls/font.lua';
    const fontSrc = vfsLookup(fontPath);
    if (fontSrc) {
        const patched = fontSrc.replace(
            `  if valign == "center" then\n    extra = 'v'\n  elseif valign == "top" then\n    extra = 't'\n  elseif valign == "bottom" then\n    extra = 'b'\n  else\n    --// ascender\n    extra = 'a'\n  end`,
            `  if valign == "center" then\n    extra = 'v'\n  elseif valign == "linecenter" then\n    extra = 'x'\n  elseif valign == "top" then\n    extra = 't'\n  elseif valign == "bottom" then\n    extra = 'b'\n  else\n    --// ascender\n    extra = 'a'\n  end`,
        );
        if (patched !== fontSrc) {
            vfsRegister(fontPath, patched);
            postLog(2, '[LuaUI] Patched font.lua: _GetExtra recognises "linecenter"');
        } else {
            postLog(3, '[LuaUI] font.lua _GetExtra patch — anchor not found');
        }
    }

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

    // Increase Chili's DebugHandler error tolerance. The default is 5
    // errors in 5 seconds before self-destruct. Our incomplete GL/API
    // surface triggers more errors during init than native Spring, but
    // they're harmless (missing skin draw methods on controls that
    // haven't been fully realized yet).
    runtime.doString(`
        if WG and WG.Chili and WG.Chili.DebugHandler then
            WG.Chili.DebugHandler.maxChiliErrors = 999
            Spring.Echo("[LuaUI] DebugHandler.maxChiliErrors raised to 999")
        end
    `, 'chili_error_tolerance');

    // Force-enable Chili Framework if widgetHandler didn't auto-start it.
    runtime.doString(`
        if widgetHandler and (not WG or not WG.Chili) then
            local ki = widgetHandler.knownWidgets and widgetHandler.knownWidgets["Chili Framework"]
            if ki and not ki.active then
                Spring.Echo("[LuaUI] Force-enabling Chili Framework")
                widgetHandler:EnableWidget("Chili Framework")
                -- Raise error tolerance on the freshly loaded Chili
                if WG and WG.Chili and WG.Chili.DebugHandler then
                    WG.Chili.DebugHandler.maxChiliErrors = 999
                end
            end
        end
    `, 'chili_force_enable');

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

    // Post-bootstrap API patches: ZK's bootstrap replaces Spring.Utilities
    // with its own table, so any pre-bootstrap additions are lost. Add
    // missing stubs that ZK widgets expect but ZK's own utilities don't provide.
    runtime.doString(`
        if Spring.Utilities then
            Spring.Utilities.GetHumanName = Spring.Utilities.GetHumanName or function(ud)
                if type(ud) == "table" and ud.humanName then return ud.humanName end
                if type(ud) == "table" and ud.name then return ud.name end
                return tostring(ud or "")
            end
            Spring.Utilities.bit_inv = Spring.Utilities.bit_inv or function(x)
                return bit32 and bit32.bnot(x) or (~x)
            end
        end
        if not Spring.Translate then
            Spring.Translate = function(key) return tostring(key or "") end
        end
        if not Spring.GetHumanName then
            Spring.GetHumanName = function(defName) return tostring(defName or "") end
        end
    `, 'post_bootstrap_api_stubs');

    // Fix Chili TaskHandler queue desync: fengari's weak table GC
    // collects entries from the TaskHandler's objects/objects2 queues
    // before Update() processes them. This causes controls to be stuck
    // with __inUpdateQueue=true but not in any queue, so they never get
    // their Update() called and never create display lists.
    //
    // Fix: remove __mode="v" from the queue tables (make them strong)
    // and install a per-frame repair that resets stuck controls.
    runtime.doString(`
        -- Deferred: runs after first DrawGenesis when WG.Chili exists
        _chiliTaskFix = function()
            if not WG or not WG.Chili then return false end
            local th = WG.Chili.TaskHandler
            if not th then return false end

            -- Remove weak-table mode from TaskHandler's internal tables.
            -- We can't access the locals directly, but we can patch
            -- RequestUpdate to use strong tables instead.
            local strongQueue = {}
            local strongQueue2 = {}
            local strongCount = 0
            local strongInstant = {}
            local strongInstant2 = {}
            local strongInstantCount = 0

            local origRequestUpdate = th.RequestUpdate
            local origRequestInstant = th.RequestInstantUpdate
            local origRemoveObject = th.RemoveObject
            local origUpdate = th.Update

            local _reqLog = 0
            th.RequestUpdate = function(obj)
                obj = (type(obj) == "table" and obj.__target) and obj.__target or obj
                if not obj.__inUpdateQueue then
                    obj.__inUpdateQueue = true
                    strongCount = strongCount + 1
                    strongQueue[strongCount] = obj
                    _reqLog = _reqLog + 1
                    if _reqLog <= 20 then
                        Spring.Echo("[TaskHandler] RequestUpdate: " .. tostring(obj.name or obj.classname) .. " count=" .. strongCount)
                    end
                end
            end

            th.RequestInstantUpdate = function(obj)
                obj = (type(obj) == "table" and obj.__target) and obj.__target or obj
                if not obj.__inUpdateQueue then
                    obj.__inUpdateQueue = true
                    strongInstantCount = strongInstantCount + 1
                    strongInstant[strongInstantCount] = obj
                end
            end

            th.RemoveObject = function(obj)
                obj = (type(obj) == "table" and obj.__target) and obj.__target or obj
                -- Call original for globalDisposeListeners
                pcall(origRemoveObject, obj)
                -- Also remove from our strong queue
                if obj.__inUpdateQueue then
                    obj.__inUpdateQueue = false
                    for i = 1, strongCount do
                        if strongQueue[i] == obj then
                            strongQueue[i] = strongQueue[strongCount]
                            strongQueue[strongCount] = nil
                            strongCount = strongCount - 1
                            return true
                        end
                    end
                end
                return false
            end

            th.Update = function()
                -- Process type1 queue
                local cnt = strongCount
                if cnt > 0 then
                    Spring.Echo("[TaskHandler] Processing " .. cnt .. " queued controls")
                end
                strongCount = 0
                strongQueue, strongQueue2 = strongQueue2, strongQueue
                for i = 1, cnt do
                    local obj = strongQueue2[i]
                    strongQueue2[i] = nil  -- clear processed entry
                    if obj and not obj.disposed then
                        obj.__inUpdateQueue = false
                        local Update = obj.Update
                        if Update then
                            local ok, err = pcall(Update, obj)
                            if not ok then
                                Spring.Echo("[TaskHandler] Update error on " .. tostring(obj.name or obj.classname) .. ": " .. tostring(err):sub(1,100))
                            end
                        end
                    end
                end

                -- Process type2 (instant) queue
                local runCounter = 0
                while strongInstantCount > 0 do
                    local icnt = strongInstantCount
                    strongInstantCount = 0
                    strongInstant, strongInstant2 = strongInstant2, strongInstant
                    for i = 1, icnt do
                        local obj = strongInstant2[i]
                        strongInstant2[i] = nil
                        if obj and not obj.disposed then
                            obj.__inUpdateQueue = false
                            local InstantUpdate = obj.InstantUpdate
                            if InstantUpdate then
                                pcall(InstantUpdate, obj)
                            end
                        end
                    end
                    runCounter = runCounter + 1
                    if runCounter > 20 then break end
                end
            end

            -- Reset all stuck controls and re-enqueue them
            local s = WG.Chili.Screen0
            if s then
                local function resetTree(ctrl)
                    if ctrl.__inUpdateQueue then
                        ctrl.__inUpdateQueue = false
                    end
                    if ctrl.children then
                        for _, child in ipairs(ctrl.children) do
                            if type(child) == "table" then
                                resetTree(child)
                            end
                        end
                    end
                end
                resetTree(s)
                -- Invalidate to trigger re-enqueue
                if s.Invalidate then pcall(s.Invalidate, s) end
                for _, c in ipairs(s.children or {}) do
                    if c.Invalidate then pcall(c.Invalidate, c) end
                end
            end

            -- Configure texture search paths from the active skin directory
            -- so short texture names (e.g. "tech_overlaywindow.png") resolve
            -- to the correct skin folder on the game server.
            local sh = WG.Chili.SkinHandler
            if sh and sh.knownSkins then
                for _, skin in pairs(sh.knownSkins) do
                    if type(skin) == "table" and skin.info and skin.info.dir then
                        _addTextureSearchPath(skin.info.dir)
                    end
                end
            end
            -- Also add the default chili skins path
            _addTextureSearchPath(WG.Chili.SKIN_DIRNAME or "LuaUI/Widgets/chili_old/skins/")
            _addTextureSearchPath((WG.Chili.CHILI_DIRNAME or "LuaUI/Widgets/chili_old/") .. "skins/default/")

            Spring.Echo("[LuaUI] TaskHandler patched: strong queues, " .. tostring(strongCount) .. " controls enqueued")
            _chiliTaskFix = nil  -- run once
            return true
        end
    `, 'taskhandler_fix');

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
    // Set up GL state for 2D overlay rendering
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    // Callins: Update → DrawGenesis → DrawScreen
    rt.doString(`
        -- Deferred Chili TaskHandler patch (runs once after WG.Chili exists)
        if _chiliTaskFix then _chiliTaskFix() end

        if Update then pcall(Update) end
        if DrawGenesis then pcall(DrawGenesis) end

        -- Force-update any Chili controls stuck without display lists.
        -- The TaskHandler queue loses entries due to fengari's weak table
        -- GC behavior. This brute-force walk runs once per second (not
        -- every frame) to keep overhead low.
        if WG and WG.Chili and WG.Chili.Screen0 then
            _chiliFixTimer = (_chiliFixTimer or 0) + 1
            if _chiliFixTimer % 30 == 1 then  -- every ~1 second at 30fps
                local s = WG.Chili.Screen0

                -- Fix orphaned controls: AddChild sometimes fails to set
                -- parent (fengari table identity issue). Without parent,
                -- IsInView() returns false and Update() skips dlist creation.
                for _, c in ipairs(s.children or {}) do
                    if type(c) == "table" and c.parent == nil then
                        c.parent = s
                        c._needRedraw = true
                        c.__inUpdateQueue = false
                    end
                end

                local function fixTree(ctrl, depth)
                    if depth > 10 then return end
                    if ctrl._needRedraw and ctrl.visible and not ctrl._own_dlist
                       and ctrl.parent and ctrl.Update then
                        ctrl.__inUpdateQueue = false
                        pcall(ctrl.Update, ctrl)
                    end
                    if ctrl.children then
                        for _, ch in ipairs(ctrl.children) do
                            if type(ch) == "table" then fixTree(ch, depth + 1) end
                        end
                    end
                end
                pcall(fixTree, s, 0)
            end

            -- Rebuild display lists after async texture loads complete.
            -- Skin textures load asynchronously but gl.TextureInfo returns
            -- placeholder dimensions (1x1) at first recording. The 9-slice
            -- UV math uses texWidth/texHeight, so stale dimensions produce
            -- wildly wrong UVs. We do a one-time full rebuild after textures
            -- have had time to load (~3 seconds after init).
            if not _chiliTextureRebuildDone and _chiliFixTimer > 90 then
                _chiliTextureRebuildDone = true
                -- Invalidate all controls so Chili fully rebuilds every
                -- display list (_own_dlist, _all_dlist, _children_dlist).
                -- Control:Draw short-circuits on _all_dlist, so just
                -- rebuilding _own_dlist is not enough.
                local function invalidateAll(ctrl, depth)
                    if depth > 10 then return end
                    -- Delete ALL cached display lists
                    if ctrl._all_dlist then gl.DeleteList(ctrl._all_dlist); ctrl._all_dlist = nil end
                    if ctrl._own_dlist then gl.DeleteList(ctrl._own_dlist); ctrl._own_dlist = nil end
                    if ctrl._children_dlist then gl.DeleteList(ctrl._children_dlist); ctrl._children_dlist = nil end
                    ctrl._needRedraw = true
                    ctrl.__inUpdateQueue = false
                    for _, ch in ipairs(ctrl.children or {}) do
                        if type(ch) == "table" then invalidateAll(ch, depth + 1) end
                    end
                end
                pcall(invalidateAll, s, 0)
                Spring.Echo("[LuaUI] Invalidated all Chili display lists for texture rebuild")
            end
        end

        if DrawScreen then
            local vsx, vsy = Spring.GetViewSizes()
            -- Spring's DrawScreen uses Y-up ortho (y=0 at bottom).
            -- Chili internally does Translate(0,vsy,0)+Scale(1,-1,1) to
            -- flip to its Y-down coordinate system. Using the wrong ortho
            -- causes a double-flip that inverts textures and positions.
            gl.MatrixMode(GL.PROJECTION)
            gl.LoadIdentity()
            gl.Ortho(0, vsx, 0, vsy, -1, 1)
            gl.MatrixMode(GL.MODELVIEW)
            gl.LoadIdentity()
            pcall(DrawScreen, vsx, vsy)
        end
    `, 'callin:frame');
}

// ── Engine globals ─────────────────────────────────────────────────────

function installEngineGlobals(
    rt: LuaRuntime,
    glBridge: LuaGLBridge,
    ctx: SpringAPIContext,
    gameId: string,
): void {
    const springGlobals = buildSpringGlobals(ctx, liveState);
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

    // Spring.Translate — i18n stub that returns the key.
    // Must be set BEFORE setGlobal — the Lua table is a snapshot of the JS
    // object at push time; later JS mutations are not reflected.
    (springGlobals.Spring as Record<string, LuaValue>).Translate = (key: LuaValue) => String(key ?? '');
    (springGlobals.Spring as Record<string, LuaValue>).GetHumanName = (defName: LuaValue) => String(defName ?? '');

    // Spring.Utilities — stub table; Lua-side code below adds CopyTable etc.
    (springGlobals.Spring as Record<string, LuaValue>).Utilities = {};

    // Install all globals except VFS (set up separately in Lua)
    for (const [k, v] of Object.entries(springGlobals)) {
        if (k === 'VFS') continue;
        rt.setGlobal(k, v);
    }
    rt.setGlobal('gl', glGlobal);

    // gl.Utilities — table of helper draw functions used by some ZK widgets
    // (e.g. cmd_factory_plate_placer uses gl.Utilities.DrawCircle).
    // Must be set before the fallback metatable, which would auto-stub it
    // as a plain function.
    rt.doString(`
        gl.Utilities = {
            DrawCircle = function() end,
            DrawGroundCircle = function() end,
        }
    `, 'gl_utilities');

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

    // Lua-side gl.CreateList: calls the function IN Lua so table arguments
    // (like `self`) keep their metatables. The JS-side createList loses
    // metatables during the readValue→pushValue round-trip, which breaks
    // gl.CreateList(self.DrawControl, self) — DrawControl receives a plain
    // table without methods.
    rt.doString(`
        gl.CreateList = function(fn, ...)
            if type(fn) ~= "function" then return 0 end
            gl._startRecording()
            local ok, err = pcall(fn, ...)
            local id = gl._stopRecording()
            if not ok then
                -- Partial recording is still valid (e.g. texture-only lists)
            end
            return id
        end
    `, 'gl_createlist_lua');

    rt.setGlobal('LUAUI_DIRNAME', 'LuaUI/');
    rt.setGlobal('LUAUI_VERSION', `spring-web LuaUI v0.3 (${gameId})`);

    rt.setGlobal('Script', {
        CreateScream: () => ({ func: null, _scream: { func: null } }),
        GetSynced: () => false,
        GetName: () => 'LuaUI',
        IsEngineMinVersion: () => true,
        UpdateCallIn: () => {},
    });

    // Script.LuaUI / Script.LuaRules / Script.LuaGaia — callable tables
    // with auto-stub methods. Widgets do Script.LuaUI.SomeCallin(...) to
    // call across handler boundaries.
    rt.doString(`
        local function makeScriptProxy()
            return setmetatable({}, {
                __index = function(t, k)
                    local stub = function(...) return false end
                    rawset(t, k, stub)
                    return stub
                end,
                __call = function() return {} end,
            })
        end
        Script.LuaUI = makeScriptProxy()
        Script.LuaRules = makeScriptProxy()
        Script.LuaGaia = makeScriptProxy()
    `, 'script_proxies');

    rt.setGlobal('LOG', { ERROR: 0, WARNING: 1, INFO: 2, DEBUG: 3 });

    // Platform table — some GL4 widgets check this
    rt.setGlobal('Platform', {
        glVersionShort: 'WebGL 2.0',
        glVersion: 'WebGL 2.0',
        glslVersionShort: '300',
        glslVersion: '300 es',
        gpuVendor: 'WebGL',
        gpuName: 'WebGL2',
        glSupportClipSpaceControl: false,
        glSupport24bitDepthBuffer: true,
        glSupportRestartPrimitive: false,
        glSupportFragDepthLayout: false,
        numCompressedTexFormats: 0,
    });

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

    // Spring.Utilities Lua-side: needs metatables for CopyTable, json, etc.
    rt.doString(`
        Spring.Utilities = Spring.Utilities or {}
        Spring.Utilities.CopyTable = function(t, deep)
            if type(t) ~= "table" then return t end
            local copy = {}
            for k, v in pairs(t) do
                if deep and type(v) == "table" then
                    copy[k] = Spring.Utilities.CopyTable(v, true)
                else
                    copy[k] = v
                end
            end
            return copy
        end
        Spring.Utilities.MergeTable = function(dst, src)
            for k, v in pairs(src) do
                if dst[k] == nil then dst[k] = v end
            end
            return dst
        end
        Spring.Utilities.json = { encode = function() return "{}" end, decode = function() return {} end }
        Spring.Utilities.TableToString = function(t) return tostring(t) end

        -- Ensure Spring.Translate and GetHumanName are in the Lua table.
        -- The JS-side assignment covers the initial push, but widgets that
        -- snapshot Spring before this doString runs would miss them.
        if not Spring.Translate then
            Spring.Translate = function(key) return tostring(key or "") end
        end
        if not Spring.GetHumanName then
            Spring.GetHumanName = function(defName) return tostring(defName or "") end
        end
        -- Spring.Utilities.GetHumanName — some ZK widgets call this path
        Spring.Utilities.GetHumanName = Spring.Utilities.GetHumanName or function(ud)
            if type(ud) == "table" and ud.humanName then return ud.humanName end
            if type(ud) == "table" and ud.name then return ud.name end
            return tostring(ud or "")
        end
        -- Bit operation helpers used by some ZK widgets
        Spring.Utilities.bit_inv = Spring.Utilities.bit_inv or function(x)
            return bit32 and bit32.bnot(x) or (~x)
        end
    `, 'spring_utilities');

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
                function f:flush() end
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
        local function esc(s)
            return (tostring(s or "")):gsub("|", "/"):gsub("\\n", " "):gsub("\\r", "")
        end
        local seen = {}
        if widgetHandler then
            -- Active widgets
            for _, w in ipairs(widgetHandler.widgets or {}) do
                local info = w.whInfo or {}
                local gi = (w.GetInfo and type(w.GetInfo) == "function") and w:GetInfo() or {}
                seen[info.name] = true
                entries[#entries+1] = "active|" .. esc(info.name) .. "|" .. esc(info.author)
                    .. "|" .. esc(info.basename) .. "||" .. esc(gi.desc or info.desc)
                    .. "|" .. esc(gi.date) .. "|" .. esc(gi.license)
                    .. "|" .. esc(gi.layer or info.layer) .. "|" .. esc(tostring(gi.enabled))
                    .. "|" .. esc(tostring(gi.handler))
            end
            -- Known but inactive widgets (disabled or failed after knownWidgets registration)
            for name, info in pairs(widgetHandler.knownWidgets or {}) do
                if not info.active then
                    seen[name] = true
                    entries[#entries+1] = "disabled|" .. esc(name) .. "|" .. esc(info.author)
                        .. "|" .. esc(info.basename) .. "||" .. esc(info.desc)
                        .. "|||" .. esc(info.layer or "") .. "||"
                end
            end
            -- Widgets that failed before reaching knownWidgets (parse errors, pcall failures)
            for _, errMsg in ipairs(_widgetErrors or {}) do
                local bname = errMsg:match("Failed to load:%s+(%S+)")
                if bname and not seen[bname] then
                    seen[bname] = true
                    entries[#entries+1] = "failed|" .. esc(bname) .. "|||" .. esc(errMsg) .. "||||||"
                end
            end
            -- Cross-check: find widget files VFS knows about that didn't appear anywhere.
            -- Build a set of known basenames from active widgets and knownWidgets.
            local seenBasenames = {}
            for _, w in ipairs(widgetHandler.widgets or {}) do
                if w.whInfo and w.whInfo.basename then
                    seenBasenames[w.whInfo.basename] = true
                end
            end
            for _, info in pairs(widgetHandler.knownWidgets or {}) do
                if info.basename then
                    seenBasenames[info.basename] = true
                end
            end
            -- Also mark basenames from _widgetErrors
            for _, errMsg in ipairs(_widgetErrors or {}) do
                local bname = errMsg:match("Failed to load:%s+(%S+)")
                if bname then seenBasenames[bname] = true end
            end
            local ok, files = pcall(function()
                return VFS.DirList("LuaUI/Widgets/", "*.lua", VFS.RAW_FIRST)
            end)
            if ok and files then
                for _, fpath in ipairs(files) do
                    local bname = fpath:match("([^/\\\\]+)$")
                    if bname and not seenBasenames[bname] then
                        entries[#entries+1] = "failed|" .. esc(bname) .. "|||silent load failure||||||"
                    end
                end
            end
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

/** Enable a widget by name. Re-fetches its source from the server
 *  first so enable after disable acts as a reload. */
async function enableWidget(name: string): Promise<void> {
    if (!runtime) return;
    // Get the widget's filename from knownWidgets
    const filename = String(runtime.evalString(`
        local ki = widgetHandler and widgetHandler.knownWidgets and widgetHandler.knownWidgets["${escapeLuaStr(name)}"]
        return ki and ki.filename or ""
    `) ?? '');
    // Re-fetch the file from server if we have a filename and a base URL
    if (filename && initBaseUrl) {
        try {
            const res = await fetch(`${initBaseUrl}/${filename}`);
            if (res.ok) {
                const text = await res.text();
                vfsRegister(filename, text);
                postLog(2, `[LuaUI] re-fetched ${filename} (${text.length} bytes)`);
            }
        } catch { /* silent */ }
    }
    runtime?.doString(`
        if widgetHandler then
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
                // Pre-load localStorage data into cache before init
                if (msg.storageData) {
                    for (const [k, v] of Object.entries(msg.storageData as Record<string, string>)) {
                        storageCache[k] = v;
                    }
                }
                await init(msg.canvas, msg.gameId, msg.lobbyUrl, msg.mapData, msg.soloWidget);
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
            await enableWidget(String(msg.name ?? ''));
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

        case 'evalLua': {
            if (!runtime) break;
            const evalResult = runtime.evalString(String(msg.code ?? ''));
            postToMain({ type: 'evalResult', result: String(evalResult ?? 'nil') });
            break;
        }

        case 'pauseFrames':
            if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }
            break;
        case 'resumeFrames':
            if (!frameInterval && runtime && bridge) {
                const gl2 = bridge.getGL();
                if (gl2) {
                    let running = false;
                    frameInterval = setInterval(() => {
                        if (!runtime || shuttingDown || running) return;
                        running = true;
                        try { runFrame(runtime!, gl2); } finally { running = false; }
                    }, 33);
                }
            }
            break;

        case 'stateUpdate':
            // Camera, viewport, identity, gameFrame from main thread
            if (msg.camera) liveState.camera = msg.camera;
            if (msg.viewport) liveState.viewport = msg.viewport;
            if (msg.identity) liveState.identity = msg.identity;
            if (msg.gameFrame !== undefined) liveState.gameFrame = msg.gameFrame as number;
            if (msg.selectedUnitIds) liveState.selectedUnitIds = msg.selectedUnitIds as number[];
            if (msg.viewMatrix) liveState.viewMatrix = msg.viewMatrix as Float32Array;
            if (msg.projMatrix) liveState.projMatrix = msg.projMatrix as Float32Array;
            if (msg.modKeys) liveState.modKeys = msg.modKeys as { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
            break;

        case 'entityState': {
            // Rebuild/merge the units Map from typed arrays
            const count = msg.count as number;
            const isDelta = msg.isDelta as boolean;
            const entityIds = msg.entityIds as Uint32Array | null;
            const posX = msg.positionsX as Float32Array | null;
            const posY = msg.positionsY as Float32Array | null;
            const posZ = msg.positionsZ as Float32Array | null;
            const headings = msg.headings as Uint16Array | null;
            const health = msg.health as Uint16Array | null;
            const defIds = msg.defIds as Uint16Array | null;
            const teams = msg.teams as Uint8Array | null;

            if (!isDelta) {
                // Full snapshot — rebuild. Only keep IDs in this snapshot.
                const newUnits = new Map<number, UnitEntry>();
                if (entityIds) {
                    for (let i = 0; i < count; i++) {
                        const id = entityIds[i];
                        newUnits.set(id, {
                            x: posX ? posX[i] : 0,
                            y: posY ? posY[i] : 0,
                            z: posZ ? posZ[i] : 0,
                            heading: headings ? headings[i] : 0,
                            healthRatio: health ? health[i] / 65535 : 1,
                            defId: defIds ? defIds[i] : 0,
                            team: teams ? teams[i] : 0,
                        });
                    }
                }
                liveState.units = newUnits;
            } else {
                // Delta — merge changed units
                if (entityIds) {
                    for (let i = 0; i < count; i++) {
                        const id = entityIds[i];
                        const existing = liveState.units.get(id);
                        const entry: UnitEntry = existing ?? { x: 0, y: 0, z: 0, heading: 0, healthRatio: 1, defId: 0, team: 0 };
                        if (posX) entry.x = posX[i];
                        if (posY) entry.y = posY[i];
                        if (posZ) entry.z = posZ[i];
                        if (headings) entry.heading = headings[i];
                        if (health) entry.healthRatio = health[i] / 65535;
                        if (defIds) entry.defId = defIds[i];
                        if (teams) entry.team = teams[i];
                        liveState.units.set(id, entry);
                    }
                }
            }
            break;
        }

        case 'entityDestroy':
            liveState.units.delete(msg.entityId as number);
            break;

        case 'resourceUpdate':
            liveState.resources.set(msg.team as number, {
                metal: msg.metal as number,
                maxMetal: msg.maxMetal as number,
                energy: msg.energy as number,
                maxEnergy: msg.maxEnergy as number,
                metalIncome: msg.metalIncome as number,
                energyIncome: msg.energyIncome as number,
            });
            break;

        case 'gameInfo':
            if (msg.frame !== undefined) liveState.gameFrame = msg.frame as number;
            if (msg.speed !== undefined) liveState.gameSpeed = msg.speed as number;
            if (msg.paused !== undefined) liveState.gamePaused = msg.paused as boolean;
            if (msg.gameOver !== undefined) liveState.gameOver = msg.gameOver as boolean;
            break;

        case 'mapFeatures': {
            // Populate features map from MapData
            const feats = msg.features as Array<{ id: number; x: number; y: number; z: number; defId: number; team: number; healthRatio: number }>;
            liveState.features.clear();
            for (const f of feats) {
                liveState.features.set(f.id, {
                    x: f.x, y: f.y, z: f.z,
                    defId: f.defId, team: f.team, healthRatio: f.healthRatio,
                });
            }
            break;
        }

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
