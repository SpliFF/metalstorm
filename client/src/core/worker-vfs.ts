// ── VFS state ──────────────────────────────────────────────────────────

export const vfsFiles = new Map<string, string>();
export const vfsPathMap = new Map<string, string>();
export const vfsDirCache = new Map<string, string[]>();
export const vfsSubdirCache = new Map<string, string[]>();

// On-demand binary load cache (canonical-lowercase path → byte-1:1 string).
// Holds the bytes of indexed-but-path-only assets (audio/images not
// prefetched as text) once VFS.LoadFile pulls them. See vfsLoadBinary.
const vfsBinaryCache = new Map<string, string>();

// Synchronous raw-byte fetcher seam. worker-vfs.ts is pure (no fetch / no
// game base URL), so the host (lua-ui-host.ts) injects the actual transport
// once at init. Returns a byte-1:1 (latin1) string or null. See vfsLoadBinary.
let vfsBinaryFetcher: ((diskPath: string) => string | null) | null = null;
export function setVfsBinaryFetcher(fn: (diskPath: string) => string | null): void {
    vfsBinaryFetcher = fn;
}

// FIDELITY-STANDIN: present the authored audio namespace in VFS.DirList.
//
// The gameconverter re-encodes every `sounds/**` (+ `LuaUI/Sounds/**`) source
// to `.webm` (tools/gameconverter/main.cpp). Real Spring's `VFS.DirList` only
// ever returns the files the game *shipped* (`.wav`/`.ogg`); our `.webm` is a
// browser-playback artifact, not part of the authored namespace. Games that
// *resolve* sound paths cope — audio.ts `normalizeSoundPath` rewrites
// `.wav`/`.ogg`/… → `.webm` at playback — but games that *parse the filename
// out of `VFS.DirList`* break: BAR's `gamedata/sounds.lua` does
// `string.find(fileName, ".wav") - 1` per entry and crashes (arithmetic on
// nil) on any non-`.wav` entry, aborting its whole SoundItems build (→ 0
// sounds). So for `sounds/` listings we make DirList faithful:
//   • source sibling present (un-pruned import, e.g. BAR + ZK both ship
//     `.wav`+`.webm` side by side) → HIDE the `.webm` and return only the
//     source. (This is the case that regressed BAR: returning both crashed
//     sounds.lua on the `.webm` half.)
//   • source pruned away (only `.webm` left) → present it under the assumed
//     `.wav` ext so the parser matches; the byte fetch still resolves `.webm`.
//     The original ext is unrecoverable post-prune, so we assume `.wav` (the
//     dominant Spring convention; warned once). General fix: have the converter
//     record the source extension (or stop pruning).
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
    vfsBinaryCache.clear();
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
    let dropped = false;
    const out: string[] = [];
    for (const f of entries) {
        if (!f.toLowerCase().endsWith('.webm')) { out.push(f); continue; }
        const stem = f.slice(0, -'.webm'.length);
        if (sourceStems.has(stem.toLowerCase())) {
            // Authored source sibling present (e.g. foo.wav). The .webm is our
            // converted *playback* artifact, NOT part of the VFS namespace the
            // game shipped — HIDE it. A filename-parsing game (BAR's sounds.lua:
            // `string.find(name, ".wav") - 1`) iterates every DirList entry, so a
            // stray .webm crashes it (arithmetic on nil) and the whole SoundItems
            // build aborts → 0 sounds. Real Spring's DirList only ever sees the
            // source files. Playback still resolves .webm via normalizeSoundPath.
            dropped = true;
            continue;
        }
        // Source was pruned: only the .webm remains. Present it under the
        // (assumed) authored .wav extension so the parser matches; the byte
        // fetch still resolves .webm. (A pruned .ogg-only game would mis-present
        // as .wav — warned; general fix is recording the source ext.)
        swapped = true;
        out.push(stem + '.wav');
    }
    if ((swapped || dropped) && !warnedAudioDirSwap) {
        warnedAudioDirSwap = true;
        _vfsLogger(2, '[VFS] FIDELITY-STANDIN: VFS.DirList(sounds/…) presents the authored ' +
            'source audio (.wav/.ogg) and hides converted .webm artifacts (orphan .webm with ' +
            'no source → presented as .wav). Playback resolves .webm via normalizeSoundPath. ' +
            'General fix: record the source ext in the converter.');
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

/// Resolve the on-disk (original-case) path for an indexed file, or null
/// if the path isn't known to exist. Mirrors vfsExists / vfsLookup
/// resolution (exact, LuaUI/-prefixed, case-folded), so the URL a binary
/// fetch uses matches what FileExists/DirList reported.
export function vfsCanonicalPath(path: string): string | null {
    if (vfsFiles.has(path)) return path;
    if (vfsFiles.has('LuaUI/' + path)) return 'LuaUI/' + path;
    const lower = path.toLowerCase();
    const canonical = vfsPathMap.get(lower);
    if (canonical) return canonical;
    const canonicalPrefixed = vfsPathMap.get(('LuaUI/' + path).toLowerCase());
    if (canonicalPrefixed) return canonicalPrefixed;
    return null;
}

/// Synchronously load a file's raw bytes by VFS path, returned byte-1:1
/// (latin1 — LuaRuntime.pushValue pushes such a string byte-exact). This is
/// the faithful Recoil VFS.LoadFile behaviour for binary assets that aren't
/// held as text in the worker: audio (.wav/.ogg…) and images are indexed
/// path-only (vfsRegisterPath) to avoid prefetching megabytes the Lua side
/// usually can't consume, so vfsLookup returns undefined for them. A widget
/// that *does* read the bytes (e.g. BAR's common/wav.lua parsing a .wav
/// header for sound-scheduling durations) hit the FileExists(true) /
/// LoadFile(nil) inconsistency and crashed. Gated on vfsExists so LoadFile
/// stays consistent with FileExists; results are cached so repeat reads
/// don't re-fetch. Returns null if the file isn't indexed or the fetch fails.
export function vfsLoadBinary(path: string): string | null {
    // Prefer in-memory content — a file held as text is never re-fetched as
    // binary (the Lua VFS.LoadFile already tries this, but stay self-consistent
    // for any direct caller).
    const held = vfsLookup(path);
    if (held !== undefined) return held;
    if (!vfsExists(path)) return null;
    const disk = vfsCanonicalPath(path) ?? path;
    const key = disk.toLowerCase();
    const cached = vfsBinaryCache.get(key);
    if (cached !== undefined) return cached;
    if (!vfsBinaryFetcher) return null;
    const bytes = vfsBinaryFetcher(disk);
    if (bytes !== null) vfsBinaryCache.set(key, bytes);
    return bytes;
}

// ── HTTP VFS prefetch ──────────────────────────────────────────────────

export async function prefetchAllGameFiles(baseUrl: string): Promise<void> {
    // Game-root code files that the LuaUI bootstrap VFS.Includes directly,
    // before any subdirectory is touched. ZK reads `ModOptions.lua` / `modinfo`;
    // BAR's `LuaUI/main.lua` includes the game-root `init.lua` (which installs
    // Spring.I18N, Json, Spring.Utilities, Game.Commands, Spring.Lava and the
    // graphics module) on its second line — without it the bootstrap crashes at
    // `Spring.I18N.setLanguage()` and the whole widget framework never loads.
    // The BFS below seeds curated subdirectories (not the game root) to keep
    // boot cost bounded, so root files would otherwise never be fetched.
    // Discover them generically: list the root and fetch every code file in it,
    // rather than hardcoding per-game filenames.
    try {
        const rootRes = await fetch(`${baseUrl}/`);
        if (rootRes.ok) {
            const rootEntries = await rootRes.json() as { name: string; type: string }[];
            await Promise.all(rootEntries
                .filter((e) => e.type === 'file' && /\.(lua|txt|json)$/i.test(e.name))
                .map(async (e) => {
                    try {
                        const fRes = await fetch(`${baseUrl}/${e.name}`);
                        if (fRes.ok) vfsRegister(e.name, await fRes.text());
                    } catch { /* silent */ }
                }));
        }
    } catch { /* silent */ }
    const queue = [
        'LuaUI', 'LuaRules', 'LuaRules/Utilities',
        'LuaRules/Configs', 'Configs',
        // Chili UI framework has deep directory trees that may not
        // be reached by BFS from LuaUI if the walker doesn't descend
        // into all Widget subdirectories quickly enough.
        'LuaUI/Widgets/chili', 'LuaUI/Widgets/chili_old',
        'gamedata',
        // BAR's game-root `init.lua` chain pulls shared library code from these
        // top-level trees: `common/` (number/string/table fns, Json, Spring
        // overrides + utilities, platform fns, constants), `modules/` (i18n,
        // commands, customcommands, lava, graphics) and `language/` (per-locale
        // *.json the i18n module enumerates via VFS.SubDirs/DirList). Crawling
        // `language` also indexes its subdirs so SubDirs('language')→{en,…} and
        // DirList('language/en','*.json') resolve from the registered paths.
        'common', 'modules', 'language',
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
        // Game-root cursor sets. BAR's gui_cursor.lua builds cursorSets from
        // `VFS.SubDirs('anims')` at Initialize/ViewResize time (Recoil reads
        // the same archive-mounted tree); without this descent the dir was
        // never crawled, `_vfsSubDirs` returned [], and indexing the empty
        // `cursorSets['icexuick']` crashed with "index a nil value" (PLAN-bar
        // U5). The actual cursor images are fetched separately over HTTP by
        // AnimatedCursor, not through this VFS cache — this descent only
        // needs to register enough of the tree (the per-set `.txt` manifests
        // match the existing text-file filter) to populate the subdir cache.
        // Case-insensitive fetch resolves ZK's `Anims/` too (additive, safe).
        'anims',
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
    local content = vfsLookup(path)
    if content ~= nil then return content end
    -- Faithful fallback: a file can be indexed (FileExists==true) but held
    -- path-only, i.e. without its bytes in the worker (binary audio/images).
    -- Recoil's VFS.LoadFile returns raw bytes for ANY existing file, so load
    -- them synchronously on demand (byte-exact). Keeps FileExists/LoadFile
    -- consistent — e.g. common/wav.lua reads a .wav header for sound timing.
    if _vfsLoadBinary then
        return _vfsLoadBinary(path)
    end
    return nil
end

VFS.DirList = function(path, pattern, mode)
    path = path or ""
    path = path:gsub("\\\\", "/")
    if path:sub(-1) ~= "/" then path = path .. "/" end
    mode = mode or VFS.DEF_MODE
    -- Mode-aware listing (mirrors VFS.FileExists). In the web model every
    -- HTTP-served engine/game file is archive-equivalent (ZIP); the only RAW
    -- files are user-written (io.open / persisted config) in VFS._writeCache.
    -- A RAW-layer list must NOT return game content, or Spring's RAW/ZIP
    -- distinction collapses: BAR's barwidgets.lua scans WIDGET_DIRNAME with
    -- VFS.RAW then VFS.ZIP and keys each widget's fromZip flag off which pass
    -- found it; if the RAW pass returns the game's widgets they are all tagged
    -- fromZip=false and the default-enable gate turns the entire HUD off. So
    -- RAW/RAW_ONLY lists only the write-cache (empty for shipped content);
    -- everything else lists the archive.
    local files
    if mode == VFS.RAW or mode == VFS.RAW_ONLY then
        files = {}
        for k in pairs(VFS._writeCache) do
            if k:sub(1, #path) == path then
                local rest = k:sub(#path + 1)
                if rest ~= "" and not rest:find("/") then
                    files[#files + 1] = rest
                end
            end
        end
    else
        files = _vfsDirList(path)
    end
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
