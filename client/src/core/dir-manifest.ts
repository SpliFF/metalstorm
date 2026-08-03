/**
 * DirManifest — client-side helper for the static directory listings
 * the gameconverter writes alongside game content (e.g.
 * `data/games/<gameId>/models/manifest.json`).
 *
 * The manifest is the lobby HTTP server's poor-man's `DirList`: a flat
 * list of regular filenames in a single directory, JSON-encoded. The
 * client uses it to gate optional sidecar fetches that would otherwise
 * 404 for the bulk of files (e.g. there's a `.glb` for every model but
 * a `.config.lua` for almost none — speculative fetches without the
 * manifest produce hundreds of "Failed to load resource: 404" errors
 * per game start and pointless server hits).
 *
 * The shape is intentionally minimal so this same code can serve any
 * directory the client wants to enumerate later (weapons/, sounds/,
 * future scripts/, etc.) — e.g. as the backing store for a future
 * `vfs.dirList(path)` API exposed to widgets.
 *
 *   { "version": 1, "files": ["a.glb", "a.config.json", ...] }
 *
 * Files are sorted in the manifest for stable diffs.
 *
 * Caching: per-base-URL singleton promise. Multiple concurrent callers
 * for the same directory share one fetch; the result lives for the
 * lifetime of the page session. Game switches reload the page, so
 * there's no need for explicit invalidation.
 */

interface ManifestData {
    version: number;
    files: ReadonlyArray<string>;
}

export interface DirManifest {
    /// True when `name` is a regular file in the directory.
    has(name: string): boolean;
    /// All filenames in the directory (defensive copy).
    list(): ReadonlyArray<string>;
}

/// One in-flight or resolved promise per base URL. Concurrent
/// `loadDirManifest()` calls during initial game load share the fetch.
const cache = new Map<string, Promise<DirManifest>>();

/** Fetch (or return the cached promise for) the manifest at
 *  `<baseUrl>/manifest.json`. `baseUrl` should NOT include a trailing
 *  slash. On any failure (404, parse error, network) returns a
 *  manifest that reports every name as absent — callers should use
 *  `has()` defensively rather than crashing the load path on a missing
 *  manifest, since not every directory has one. */
export function loadDirManifest(baseUrl: string): Promise<DirManifest> {
    let cached = cache.get(baseUrl);
    if (cached) return cached;

    cached = (async (): Promise<DirManifest> => {
        try {
            const resp = await fetch(`${baseUrl}/manifest.json`);
            if (!resp.ok) {
                // A 404 here is an expected, documented case (see file header —
                // "not every directory has one"), not a broken build step; only
                // surface unexpected server responses (5xx etc.) as a warning.
                const log = resp.status === 404 ? console.debug : console.warn;
                log(
                    `[dir-manifest] no manifest at ${baseUrl}/manifest.json ` +
                    `(${resp.status}) — sidecar fetches will run blind`
                );
                return makeEmptyManifest();
            }
            const data = (await resp.json()) as ManifestData;
            if (!data || !Array.isArray(data.files)) {
                console.warn(`[dir-manifest] malformed manifest at ${baseUrl}`);
                return makeEmptyManifest();
            }
            // Case-insensitive lookup. The lobby's HTTP server resolves
            // paths case-insensitively (the engine + ZK author tooling
            // routinely reference "Hermit.s3o" / "HERMIT.s3o" / "hermit.s3o"
            // for the same on-disk file), but Spring's unitdef objectName
            // strings preserve whatever case the author typed —
            // "AMETALEXTRACTORLVL1.S3O" or "hermit.s3o". The corresponding
            // .glb on disk uses canonical Pascal case ("Hermit.glb",
            // "AMetalExtractorLvl1.glb"). A case-sensitive Set.has() check
            // here returns false for those queries, the .config.json fetch
            // gets skipped, tex1/tex2 are never read, and the unit
            // renders with the synthesized-white textureless fallback
            // (fully team-coloured via TeamColorPlugin.syntheticAlbedo).
            const set = new Set(data.files.map(f => f.toLowerCase()));
            return {
                has: (name) => set.has(name.toLowerCase()),
                list: () => data.files,
            };
        } catch (e) {
            console.warn(`[dir-manifest] failed to load ${baseUrl}/manifest.json:`, e);
            return makeEmptyManifest();
        }
    })();

    cache.set(baseUrl, cached);
    return cached;
}

function makeEmptyManifest(): DirManifest {
    return {
        has: () => false,
        list: () => [],
    };
}

/// Strip the filename component off a URL, returning the directory
/// portion (no trailing slash). Used by callers that have a full file
/// URL like `.../models/armcom.glb` and want the directory base.
export function dirOfUrl(fileUrl: string): string {
    const slash = fileUrl.lastIndexOf('/');
    return slash >= 0 ? fileUrl.substring(0, slash) : fileUrl;
}
