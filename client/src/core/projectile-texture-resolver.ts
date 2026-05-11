/**
 * ProjectileTextureResolver — turns Spring weapon-def texture names
 * (`largelaser`, `flarescale01`, `flame`) into HTTP URLs the renderer
 * can load.
 *
 * Spring's runtime resolves a logical texture name through
 * `gamedata/resources.lua`'s `graphics.projectiletextures` table to a
 * relative file path under `bitmaps/`. The lobby parses that Lua file
 * (it has a real Lua VM with VFS) and ships the result as JSON at
 * `/api/games/<gameId>/resources.json`. The bitmaps/ tree is
 * converted to KTX2 in place by gameconverter, with a recursive
 * manifest at `<root>/bitmaps/manifest.json`.
 *
 * Resolution order for a logical name:
 *   1. Lookup in the game's `graphics.projectiletextures` table.
 *      The value is a relative path (e.g. `gpl/largelaserfalloff.png`).
 *      Strip the original extension and probe `<game>/bitmaps/<rel>.ktx2`
 *      against the game manifest. If present → return that URL.
 *   2. If the manifest miss happens because the file lives in the
 *      engine root (the table value points at `flare.tga` and the
 *      game ships no `flare` itself), probe `<engine>/bitmaps/<rel>.ktx2`
 *      against the engine manifest.
 *   3. If the name is missing from the game table entirely, fall
 *      back to the engine's resources.lua (which the JSON also
 *      includes when the game doesn't ship its own).
 *   4. Return null. The renderer falls back to procedural shapes.
 *
 * The resolver is async because the resources.json + manifests are
 * fetched on first use and cached. Consumers should await `init()`
 * once per game session before doing lookups.
 */

import { stampUrl } from '../config.js';
import { loadDirManifest, type DirManifest } from './dir-manifest.js';

interface ResourcesGraphics {
    projectiletextures?: Record<string, string>;
    groundfx?: Record<string, string>;
    // Other categories (smoke, scars, caustics, trees, maps) are
    // available too but only projectiletextures + groundfx are
    // consumed by the projectile renderer.
}

interface ResourcesData {
    graphics?: ResourcesGraphics;
}

const ENGINE_BASE = '/api/engine/data/bitmaps';

export class ProjectileTextureResolver {
    private gameId = '';
    private resources: ResourcesData = {};
    private gameManifest: DirManifest | null = null;
    private engineManifest: DirManifest | null = null;
    private ready = false;
    /// Resolved when the most recent init() finishes (resources.json
    /// + manifests fetched). Consumers that want the *real* URL —
    /// not procedural fallback — for a name should `await whenReady()`
    /// before resolving, or call resolve() now and re-resolve after
    /// the promise settles. Replaced on every init().
    private readyPromise: Promise<void> = Promise.resolve();
    /// One-time warning per (name, reason) so a missing texture
    /// surfaces in the console without spamming on every weapon
    /// def or every fired projectile.
    private warned = new Set<string>();

    /// Fetch resources.json and the two manifests. Idempotent;
    /// repeated calls with the same gameId are no-ops. Calls with a
    /// different gameId reload everything.
    async init(gameId: string, lobbyHttpUrl = ''): Promise<void> {
        if (this.gameId === gameId && this.ready) return;
        this.gameId = gameId;
        this.ready = false;
        this.resources = {};
        this.gameManifest = null;
        this.engineManifest = null;
        this.warned.clear();
        this.readyPromise = this.doInit(gameId, lobbyHttpUrl);
        return this.readyPromise;
    }

    /// Returns a promise that settles when the current init() finishes.
    /// Cheap to call repeatedly; the same promise is returned across
    /// callers until the next init() replaces it.
    whenReady(): Promise<void> {
        return this.readyPromise;
    }

    private async doInit(gameId: string, lobbyHttpUrl: string): Promise<void> {
        if (!gameId) return;

        const base = lobbyHttpUrl || '';
        const resourcesUrl = `${base}/api/games/${gameId}/resources.json`;
        try {
            const resp = await fetch(stampUrl(resourcesUrl));
            if (resp.ok) {
                this.resources = await resp.json() as ResourcesData;
            } else {
                console.warn(
                    `[projTex] resources.json fetch returned ${resp.status} ` +
                    `for game ${gameId}; weapon texture lookups will fall back to procedural`
                );
            }
        } catch (e) {
            console.warn(`[projTex] resources.json fetch failed:`, e);
        }

        // Manifests are fetched in parallel via the shared helper —
        // both calls cache by URL so a future re-init for the same
        // game costs only the resources.json round-trip.
        const [game, engine] = await Promise.all([
            loadDirManifest(`${base}/api/games/data/${gameId}/bitmaps`),
            loadDirManifest(`${base}${ENGINE_BASE}`),
        ]);
        this.gameManifest = game;
        this.engineManifest = engine;
        this.ready = true;
    }

    /// Resolve `name` → URL, or null if no texture is available.
    /// `name` is the bare logical name from a weapon def
    /// (`def.texture1`, etc.); the resolver does the resources.lua
    /// lookup and manifest probing. Empty `name` → null without
    /// logging. Spring weapondefs use the literal string `"none"`
    /// (case-insensitive) as a sentinel meaning "this texture slot is
    /// explicitly disabled" — treat it the same as empty.
    resolve(name: string): string | null {
        if (!name) return null;
        if (!this.ready) return null;

        const lower = name.toLowerCase();
        if (lower === 'none') return null;

        const map = this.resources.graphics?.projectiletextures ?? {};

        // resources.lua keys are case-sensitive in the file but
        // Spring's runtime is case-insensitive for projectile texture
        // names (the engine lowercases on lookup). Honour that.
        let relPath = map[name] ?? map[lower];
        if (!relPath) {
            // Some games miscase the key — try a linear scan.
            for (const k of Object.keys(map)) {
                if (k.toLowerCase() === lower) {
                    relPath = map[k];
                    break;
                }
            }
        }

        if (!relPath) {
            this.warnOnce(`unmapped:${lower}`,
                `[projTex] '${name}' not in graphics.projectiletextures`);
            return null;
        }

        // Strip extension, swap to .ktx2.
        const ktx2Rel = stripExt(relPath) + '.ktx2';

        // Probe game manifest, then engine. Game wins because the
        // manifest is the source of truth for what's been transcoded;
        // a path the table points to may be an engine file even when
        // the table came from the game's resources.lua.
        if (this.gameManifest?.has(ktx2Rel)) {
            return stampUrl(`/api/games/data/${this.gameId}/bitmaps/${ktx2Rel}`);
        }
        if (this.engineManifest?.has(ktx2Rel)) {
            return stampUrl(`${ENGINE_BASE}/${ktx2Rel}`);
        }

        this.warnOnce(`unmanifest:${ktx2Rel}`,
            `[projTex] '${name}' → '${relPath}' but no .ktx2 in game or engine manifest`);
        return null;
    }

    private warnOnce(key: string, message: string): void {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        console.warn(message);
    }
}

function stripExt(p: string): string {
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dot = p.lastIndexOf('.');
    if (dot <= slash) return p; // no extension
    return p.substring(0, dot);
}
