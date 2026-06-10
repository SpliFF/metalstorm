// ── VFS state ──────────────────────────────────────────────────────────

export const vfsFiles = new Map<string, string>();
export const vfsPathMap = new Map<string, string>();
export const vfsDirCache = new Map<string, string[]>();
export const vfsSubdirCache = new Map<string, string[]>();

// FIDELITY-STANDIN: pruned-audio DirList extension swap.
//
// The gameconverter re-encodes every `sounds/**` (+ `LuaUI/Sounds/**`)
// source to `.webm` and DELETES the source (tools/gameconverter/main.cpp).
// Games that *resolve* sound paths cope — audio.ts `normalizeSoundPath`
// rewrites `.wav`/`.ogg`/… → `.webm` at playback — but games that *parse the
// filename out of `VFS.DirList`* break: BAR's `gamedata/sounds.lua` does
// `string.find(fileName, ".wav") - 1` and crashes (arithmetic on nil) on a
// `.webm` entry. We present pruned audio under its authored extension so
// DirList matches what the game shipped; the actual byte fetch still resolves
// `.webm`. The original extension is unrecoverable once the source is pruned,
// so we assume `.wav` (the dominant Spring convention; BAR ships only `.wav`).
// The general fix is for the converter to record the source extension — until
// then a pruned `.ogg`-only game would mis-present as `.wav` (warned once).
// Applied ONLY when no sibling source file is present in the same directory,
// so games that keep their sources (e.g. ZK) are left exactly as-is.
export const AUDIO_SOURCE_EXTS = ['.wav', '.ogg', '.mp3', '.flac', '.m4a', '.aac'];
export let warnedAudioDirSwap = false;
// One-time latch for the unimplemented VFS.CalculateHash SHA512 path.
export let warnedVfsSha = false;

// ── Logger seam ───────────────────────────────────────────────────────
// worker-vfs.ts must not import lua-widget-worker.ts (would be circular).
// Callers inject the logger once at module init via setVfsLogger().

let _vfsLogger: (level: number, msg: string) => void = () => { /* no-op until wired */ };

export function setVfsLogger(fn: (level: number, msg: string) => void): void {
    _vfsLogger = fn;
}

// ── Exported mutators for warned flags ────────────────────────────────
// installVFS stays in lua-widget-worker.ts and needs to set warnedVfsSha.
export function setWarnedVfsSha(v: boolean): void {
    warnedVfsSha = v;
}

// ── Reset ─────────────────────────────────────────────────────────────

/** Clear all VFS state. Called at the top of init() to prevent stale
 *  file registrations from a previous game session (CODE-REVIEW C10). */
export function resetVfs(): void {
    vfsFiles.clear();
    vfsPathMap.clear();
    vfsDirCache.clear();
    vfsSubdirCache.clear();
    warnedAudioDirSwap = false;
    warnedVfsSha = false;
}

// ── VFS helpers ───────────────────────────────────────────────────────

export function presentDirListEntries(dirKey: string, entries: string[]): string[] {
    if (!dirKey.includes('sounds/')) return entries;
    // Stems that already have a real (un-pruned) source file in this dir.
    const sourceStems = new Set<string>();
    for (const f of entries) {
        const lf = f.toLowerCase();
        for (const ext of AUDIO_SOURCE_EXTS) {
            if (lf.endsWith(ext)) { sourceStems.add(lf.slice(0, -ext.length)); break; }
        }
    }
    let swapped = false;
    const out = entries.map(f => {
        if (!f.toLowerCase().endsWith('.webm')) return f;
        const stem = f.slice(0, -'.webm'.length);
        if (sourceStems.has(stem.toLowerCase())) return f; // source kept → leave .webm
        swapped = true;
        return stem + '.wav';
    });
    if (swapped && !warnedAudioDirSwap) {
        warnedAudioDirSwap = true;
        _vfsLogger(2, '[VFS] FIDELITY-STANDIN: presenting pruned .webm audio as .wav in ' +
            'VFS.DirList (source extension lost to converter prune; assuming .wav). ' +
            'Playback still resolves .webm. General fix: record source ext in the converter.');
    }
    return out;
}

export function vfsIndexPath(path: string): void {
    vfsPathMap.set(path.toLowerCase(), path);

    const lastSlash = path.lastIndexOf('/');
    if (lastSlash >= 0) {
        const dir = path.substring(0, lastSlash + 1);
        const file = path.substring(lastSlash + 1);

        // Use lowercase keys for directory caches so case-insensitive
        // lookups work (ZK code uses "skins/" but disk has "Skins/").
        const dirKey = dir.toLowerCase();
        if (!vfsDirCache.has(dirKey)) vfsDirCache.set(dirKey, []);
        const dirArr = vfsDirCache.get(dirKey)!;
        if (!dirArr.includes(file)) dirArr.push(file);

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

export function vfsRegister(path: string, content: string): void {
    vfsFiles.set(path, content);
    vfsIndexPath(path);
}

/// Register a path that exists on disk but whose bytes aren't stored
/// in the worker. Used for binary assets (audio, images) so widgets
/// can probe via VFS.FileExists / VFS.DirList without us prefetching
/// megabytes of content the Lua side can't consume anyway. AudioManager
/// fetches the actual bytes directly when a SoundEvent fires.
export function vfsRegisterPath(path: string): void {
    if (vfsPathMap.has(path.toLowerCase())) return;
    vfsIndexPath(path);
}

/// Audio extensions mirror ContentServer.cpp's whitelist. Kept in
/// sync so a file servable over HTTP is discoverable via VFS.
const AUDIO_EXTS = ['.wav', '.ogg', '.webm', '.m4a', '.mp3'];
export function isAudioFile(nameLower: string): boolean {
    for (const ext of AUDIO_EXTS) {
        if (nameLower.endsWith(ext)) return true;
    }
    return false;
}

/// Existence check that succeeds for both content-bearing and
/// path-only registrations. vfsLookup intentionally returns undefined
/// for path-only entries so VFS.LoadFile yields nil on binary assets,
/// so we can't piggyback on it for existence semantics.
export function vfsExists(path: string): boolean {
    if (vfsFiles.has(path)) return true;
    if (vfsFiles.has('LuaUI/' + path)) return true;
    const lower = path.toLowerCase();
    if (vfsPathMap.has(lower)) return true;
    if (vfsPathMap.has(('LuaUI/' + path).toLowerCase())) return true;
    return false;
}

export function vfsLookup(path: string): string | undefined {
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

export async function prefetchAllGameFiles(baseUrl: string): Promise<void> {
    // Top-level game files that some widgets VFS.Include directly
    // (e.g. ModOptions.lua, modinfo.lua). The BFS below starts from
    // subdirectories so root files would otherwise never be fetched.
    const ROOT_FILES = ['ModOptions.lua', 'modoptions.lua', 'modinfo.lua'];
    await Promise.all(ROOT_FILES.map(async (fp) => {
        try {
            const fRes = await fetch(`${baseUrl}/${fp}`);
            if (fRes.ok) vfsRegister(fp, await fRes.text());
        } catch { /* silent */ }
    }));
    const queue = [
        'LuaUI', 'LuaRules', 'LuaRules/Utilities',
        'LuaRules/Configs', 'Configs',
        // Chili UI framework has deep directory trees that may not
        // be reached by BFS from LuaUI if the walker doesn't descend
        // into all Widget subdirectories quickly enough.
        'LuaUI/Widgets/chili', 'LuaUI/Widgets/chili_old',
        'gamedata',
        // ZK keeps shared library code in top-level dirs that root-BFS
        // would otherwise skip. modularCommAPI/ is referenced by
        // api_modularcomms.lua → drives WG.ModularCommAPI → drives
        // commander selector and several context-menu widgets.
        'modularCommAPI',
        // Game-root audio. ZK's snd_noises and friends probe
        // `Sounds/reply/<unit>.WAV` via VFS.FileExists; without this
        // descent the audio paths aren't indexed and every probe
        // returns false even though the bytes are on disk.
        'sounds',
        // PLAN-weapon-fx Z3 — authored GLSL shaders. ZK ships engine
        // shaders under `shaders/GLSL/` and widget-side helpers under
        // `LuaUI/Widgets/Shaders/` (reached via the LuaUI descent).
        // Also include `lups/` so the worker host can boot ZK's LUPS
        // (Phase Z1) — its 30 ParticleClasses include inline shader
        // source that's already covered by the .lua descent, but
        // `lups/shaders/` (if any) needs the explicit root.
        'shaders', 'shaders/GLSL', 'lups', 'lups/shaders',
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
                if (e.type === 'file') {
                    const lower = e.name.toLowerCase();
                    if (lower.endsWith('.lua') || lower.endsWith('.txt') ||
                        lower.endsWith('.json') ||
                        // PLAN-weapon-fx Z3 — preload authored GLSL so
                        // ModelMaterials templates and LuaShaders widgets
                        // can `#include "path"` source through the
                        // bridge's shader include resolver. Extensions
                        // mirror ZK's content tree: `.glsl`, `.fs`/`.vs`
                        // (legacy short forms), plus the compound forms
                        // (`.frag.glsl`/`.vert.glsl`/`.geom.glsl`) which
                        // already end with `.glsl`.
                        lower.endsWith('.glsl') || lower.endsWith('.fs') ||
                        lower.endsWith('.vs')) {
                        if (vfsFiles.has(fullPath)) continue;
                        toFetch.push(fullPath);
                    } else if (isAudioFile(lower)) {
                        // Path-only index — AudioManager fetches the bytes
                        // on demand when a SoundEvent fires.
                        vfsRegisterPath(fullPath);
                    }
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

// ── Lua VFS implementation source ─────────────────────────────────────

export const VFS_IMPLEMENTATION_LUA = `
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
    local prefetched = _vfsLookup(path)
    if prefetched then return prefetched end
    -- PLAN-settings.md §3: fall back to persisted (io.open-written)
    -- config so settings survive a reload. Excludes widget-order files.
    if _vfsStorageLookup then return _vfsStorageLookup(path) end
    return nil
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
    -- Capture ALL return values from the included chunk. Spring's real
    -- VFS.Include returns multi-values; chunks like languages.lua use
    -- "return a, b, c" and callers destructure with three locals. If we
    -- only return the first, downstream upvalues like flagByLang are nil
    -- and widgets that depend on it (gui_epicmenu cascade to
    -- ChiliGlobalCommands, ChiliMinimap, SimpleSettings) silently die.
    local results = { pcall(chunk) }
    _includeStack[path] = nil
    if not results[1] then
        Spring.Echo("[VFS.Include] runtime error in " .. path .. ": " .. tostring(results[2]))
        return nil
    end
    -- results[1] is the pcall ok flag; results[2..n] are the chunk's
    -- return values. unpack(results, 2, #results) returns idx 2 to N.
    return unpack(results, 2, #results)
end

VFS.FileExists = function(path, mode)
    if not path then return false end
    path = normalizePath(path)
    mode = mode or VFS.DEF_MODE
    -- Mode-aware existence. RAW_ONLY / ZIP_ONLY must disambiguate which
    -- layer a file came from — the distinction ZK's fromZip security gate
    -- (cawidgets.lua: only archive-shipped widgets may access SpringRestricted)
    -- depends on. In the web model every HTTP-served engine/game file is
    -- archive-equivalent (ZIP); only io.open-written / localStorage-persisted
    -- config is raw (user-writable, outside any archive). A stub that
    -- returned true for BOTH _ONLY modes collapsed not FileExists(.., RAW_ONLY)
    -- to false, so gfx_projectile_lights.lua never received SpringRestricted and
    -- failed to load. PLAN-settings.md section 3: persisted config must still
    -- count as existing (raw) so cawidgets default-mode gated load restores it.
    local inArchive = _vfsExists(path)
    local inRaw = (VFS._writeCache[path] ~= nil)
        or (_vfsStorageLookup ~= nil and _vfsStorageLookup(path) ~= nil)
    if mode == VFS.RAW_ONLY then
        return inRaw
    elseif mode == VFS.ZIP_ONLY then
        return inArchive
    end
    return inArchive or inRaw
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

-- Pack/Unpack helpers used by ZK widgets (AllyCursors stores 16-bit
-- coords in shared messages). Provide string-based stubs so the call
-- site doesn't crash; the round-trip is opaque to widgets that don't
-- transmit these across the network.
VFS.PackU8 = VFS.PackU8 or function(n) return string.char(math.floor(n) % 256) end
VFS.PackU16 = VFS.PackU16 or function(n)
    n = math.floor(n)
    return string.char(n % 256) .. string.char(math.floor(n / 256) % 256)
end
VFS.PackU32 = VFS.PackU32 or function(n)
    n = math.floor(n)
    return string.char(n % 256)
        .. string.char(math.floor(n / 256) % 256)
        .. string.char(math.floor(n / 65536) % 256)
        .. string.char(math.floor(n / 16777216) % 256)
end
VFS.UnpackU8 = VFS.UnpackU8 or function(s, i) return s:byte(i or 1) or 0 end
VFS.UnpackU16 = VFS.UnpackU16 or function(s, i)
    i = i or 1
    return (s:byte(i) or 0) + (s:byte(i+1) or 0) * 256
end
VFS.UnpackU32 = VFS.UnpackU32 or function(s, i)
    i = i or 1
    return (s:byte(i) or 0) + (s:byte(i+1) or 0) * 256
        + (s:byte(i+2) or 0) * 65536 + (s:byte(i+3) or 0) * 16777216
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

-- VFS.CalculateHash(input, hashType): type 0 = base64(MD5), type 1 = SHA512
-- hex (Recoil rts/Lua/LuaVFS.cpp). Backed by vfs-hash.ts (MD5 only; type 1
-- is a loud nil standin). Reaching BAR/ZK consumers call this at load time and
-- die on a nil function without it.
VFS.CalculateHash = function(input, hashType)
    if input == nil then return nil end
    return _vfsCalculateHash(input, hashType or 0)
end

-- VFS.GetNameFromRapidTag(tag): resolves a rapid (pool) package tag to an
-- archive name. The web content model has no rapid system (all content is
-- HTTP-served, pre-resolved), so there is nothing to resolve. Loud standin
-- (no-silent-GL-failures spirit) returning nil — the 2 BAR callers fall back
-- to their own defaults when this is nil.
local _warnedRapidTag = false
VFS.GetNameFromRapidTag = function(tag)
    if not _warnedRapidTag then
        _warnedRapidTag = true
        Spring.Echo("[VFS.GetNameFromRapidTag] FIDELITY-STANDIN: no rapid/pool " ..
            "system in the web content model; returning nil.")
    end
    return nil
end

-- VFS.ZlibCompress / VFS.ZlibDecompress: real zlib (RFC 1950) round-trip in
-- Recoil. Deferred here: a synchronous zlib codec plus binary-safe Lua<->JS
-- string marshaling is its own task, and the only reaching consumers are a
-- telemetry widget (log_unitdefids) and a start-pos widget gated behind
-- modoptions not yet fed to the worker. Present (not absent) but LOUD: raise a
-- clear error rather than corrupt data with a passthrough, so a consumer that
-- reaches them surfaces with a named reason instead of silently mangling
-- compressed bytes. (Tracked: PLAN-bar.md §3b VFS.*.)
local function _zlibUnimplemented(which)
    return function()
        error("VFS." .. which .. ": FIDELITY-STANDIN not implemented " ..
            "(needs a synchronous zlib codec; see PLAN-bar.md VFS.*)", 2)
    end
end
VFS.ZlibCompress = _zlibUnimplemented("ZlibCompress")
VFS.ZlibDecompress = _zlibUnimplemented("ZlibDecompress")
`;
