/* Vite plugin that serves all static game/map/engine data directly from
 * the repository's data/ directory, with proper HTTP cache validation
 * (Last-Modified + If-None-Match / If-Modified-Since → 304 Not Modified).
 *
 * This is the canonical static-serving path in dev. The C++ lobby
 * (spring-lobby) no longer serves static assets — production deployment
 * must front the lobby with a real static server (nginx / apache / CDN)
 * for the routes handled here plus the built client bundle from
 * client/dist/. See the production-deployment notes in CLAUDE.md.
 *
 * Routes:
 *   /api/games/data/*    → data/games/<rest>
 *   /api/maps/data/*     → data/maps/<rest>
 *   /api/engine/data/*   → data/engine/<rest>
 *   /api/maps/thumb/<id> → data/maps/<id>/thumbnail.png (with multi-fallback)
 *
 * Special handling:
 *   - `.lua.br` files → Content-Encoding: br so the browser decompresses
 *     transparently (used by the def cache, see PLAN-defs.md).
 *   - Case-insensitive path resolution component-by-component, because
 *     ZK ships filenames like "LightningBolt.wav" but references them
 *     as "lightningbolt.wav" in places.
 *
 * Why this exists (history):
 *   - Client used to stamp asset URLs with `?v=<buildStamp>` for cache
 *     busting. Babylon's glTF loader resolves sibling .bin / .ktx2
 *     URIs against the document URL; a stamp on the .gltf URL broke
 *     that resolution.
 *   - Switching to Last-Modified / ETag revalidation kills the need
 *     for the stamp, and lets the lobby drop its bespoke static
 *     handler (which lacked revalidation support).
 */

import { promises as fs, statSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

interface StaticDataPluginOptions {
    /** Path to the repository root (where the `data/` directory lives). */
    repoRoot: string;
}

/// URL prefix → on-disk subdirectory under `<repoRoot>/data/`.
const PREFIX_ROUTES: Record<string, string> = {
    '/api/games/data/':  'games',
    '/api/maps/data/':   'maps',
    '/api/engine/data/': 'engine',
};

/// File extension → Content-Type. Matches the legacy lobby table so
/// behaviour is identical for the assets this plugin replaces.
const CONTENT_TYPES: Record<string, string> = {
    '.lua':   'text/x-lua; charset=utf-8',
    '.json':  'application/json',
    '.png':   'image/png',
    '.jpg':   'image/jpeg',
    '.jpeg':  'image/jpeg',
    '.webp':  'image/webp',
    '.ktx2':  'image/ktx2',
    '.dds':   'image/vnd-ms.dds',
    '.glb':   'model/gltf-binary',
    '.gltf':  'model/gltf+json',
    '.bin':   'application/octet-stream',
    '.html':  'text/html; charset=utf-8',
    '.css':   'text/css; charset=utf-8',
    '.js':    'application/javascript; charset=utf-8',
    '.wav':   'audio/wav',
    '.ogg':   'audio/ogg',
    '.opus':  'audio/ogg; codecs=opus',
    '.webm':  'audio/webm',
    '.mp3':   'audio/mpeg',
};

const THUMB_PREFIX = '/api/maps/thumb/';

export function staticDataPlugin(opts: StaticDataPluginOptions): Plugin {
    const dataRoot = path.resolve(opts.repoRoot, 'data');
    const mapsDir = path.join(dataRoot, 'maps');

    return {
        name: 'static-data',
        configureServer(server: ViteDevServer) {
            server.middlewares.use(async (req, res, next) => {
                const url = req.url ?? '';
                const qpos = url.indexOf('?');
                const cleanUrl = qpos >= 0 ? url.substring(0, qpos) : url;

                try {
                    // ── Thumb route (multi-fallback) ──
                    if (cleanUrl.startsWith(THUMB_PREFIX)) {
                        const mapId = decodeURIComponent(cleanUrl.substring(THUMB_PREFIX.length));
                        if (mapId.includes('..') || !mapId) {
                            res.statusCode = 403;
                            res.end('forbidden');
                            return;
                        }
                        const resolved = resolveThumb(mapsDir, mapId);
                        if (!resolved) {
                            res.statusCode = 404;
                            res.end();
                            return;
                        }
                        await serveFile(resolved, req, res);
                        return;
                    }

                    // ── Prefix-based routes ──
                    let subDir: string | null = null;
                    let rest: string | null = null;
                    for (const [prefix, dir] of Object.entries(PREFIX_ROUTES)) {
                        if (cleanUrl.startsWith(prefix)) {
                            subDir = dir;
                            rest = decodeURIComponent(cleanUrl.substring(prefix.length));
                            break;
                        }
                    }
                    if (subDir === null || rest === null) {
                        return next();
                    }
                    if (rest.includes('..')) {
                        res.statusCode = 403;
                        res.end('forbidden');
                        return;
                    }

                    const resolved = await resolvePath(
                        path.join(dataRoot, subDir),
                        rest,
                    );
                    if (!resolved) {
                        return next();   // fall through (lobby will 404 cleanly)
                    }

                    const stat = statSync(resolved);
                    if (!stat.isFile()) {
                        return next();   // directory listings still go to the lobby
                    }

                    await serveFile(resolved, req, res);
                } catch (err) {
                    server.config.logger.warn(
                        `[static-data] ${cleanUrl}: ${(err as Error).message}`,
                    );
                    next();
                }
            });
        },
    };
}

// ────────────────────────────────────────────────────────────────────

/// Common file-serving path: emit Last-Modified / ETag, honour
/// conditional GET (If-None-Match / If-Modified-Since), set proper
/// Content-Type + Content-Encoding for compressed files.
async function serveFile(
    resolved: string,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    const stat = statSync(resolved);
    const fname = path.basename(resolved);

    // Pre-compressed files: ".lua.br" → text/x-lua + Content-Encoding: br.
    // Pattern can extend to .json.br / .js.br etc. if needed later.
    let contentType: string;
    let contentEncoding: string | null = null;
    if (fname.endsWith('.lua.br')) {
        contentType = 'text/x-lua; charset=utf-8';
        contentEncoding = 'br';
    } else if (fname.endsWith('.json.br')) {
        contentType = 'application/json';
        contentEncoding = 'br';
    } else {
        const ext = path.extname(fname).toLowerCase();
        contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    }

    const lastModified = stat.mtime.toUTCString();
    // Weak ETag: mtime in ms + file size, base-36 for compactness.
    // "W/" prefix flags it weak (we don't guarantee byte identity
    // across replicas, just content-equality).
    const etag = `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;

    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const matchesEtag = typeof inm === 'string' && inm === etag;
    const notModified = typeof ims === 'string' &&
        Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000;
    if (matchesEtag || notModified) {
        res.statusCode = 304;
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', lastModified);
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        res.end();
        return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    if (contentEncoding) res.setHeader('Content-Encoding', contentEncoding);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    const body = await fs.readFile(resolved);
    res.end(body);
}

/// Resolve a path inside `base`, falling back to case-insensitive
/// component matching for filesystems where ZK's mixed-case names
/// don't match the lower-case references in scripts.
async function resolvePath(base: string, rel: string): Promise<string | null> {
    const direct = path.join(base, rel);
    if (existsSync(direct)) return direct;

    const wanted = rel.split('/').filter(Boolean);
    let cur = base;
    for (const segment of wanted) {
        const candidate = path.join(cur, segment);
        if (existsSync(candidate)) {
            cur = candidate;
            continue;
        }
        if (!existsSync(cur)) return null;
        try {
            const entries = await fs.readdir(cur);
            const want = segment.toLowerCase();
            const match = entries.find(e => e.toLowerCase() === want);
            if (!match) return null;
            cur = path.join(cur, match);
        } catch {
            return null;
        }
    }
    return existsSync(cur) ? cur : null;
}

/// Map thumbnail with multi-tier fallback. Mirrors the legacy lobby
/// handler at rts/lobby_main.cpp:820-882 (before deletion):
///   1. data/maps/<id>/thumbnail.png  (preprocessed 256px, primary)
///   2. data/maps/<id>/thumbnail.webp (legacy preprocessed output)
///   3. data/maps/<id>/**/*minimap.(png|jpg) (author-shipped fallback)
function resolveThumb(mapsDir: string, mapId: string): string | null {
    const png = path.join(mapsDir, mapId, 'thumbnail.png');
    if (existsSync(png)) return png;
    const webp = path.join(mapsDir, mapId, 'thumbnail.webp');
    if (existsSync(webp)) return webp;

    const mapDir = path.join(mapsDir, mapId);
    if (!existsSync(mapDir)) return null;
    return findMinimapRecursive(mapDir);
}

function findMinimapRecursive(dir: string): string | null {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return null;
    }
    for (const name of entries) {
        const full = path.join(dir, name);
        let s;
        try { s = statSync(full); } catch { continue; }
        if (s.isDirectory()) {
            const found = findMinimapRecursive(full);
            if (found) return found;
            continue;
        }
        if (!s.isFile()) continue;
        const lower = name.toLowerCase();
        if (lower.includes('minimap') &&
            (lower.endsWith('.png') || lower.endsWith('.jpg'))) {
            return full;
        }
    }
    return null;
}
