# Caching & Cache-Busting

How HTTP caching works across the lobby, game server, and browser client, and how to disable it during development.

---

## Build Stamp

Every build generates a unique stamp at CMake configure time:

```
<git-short-hash>-<YYYYMMDDHHmmss>
```

Example: `5ca1489766-20260414143333`

The stamp is baked into all server binaries via `-DSPRING_BUILD_STAMP="..."` and exposed at runtime through:

- `GET /api/version` — returns `{"engine":"springweb","stamp":"...","no_cache":true/false}`
- `X-Build-Stamp` response header on every HTTP response
- `CacheControl::BuildStamp()` in C++ code

The stamp changes on every `cmake --preset debug` (or any cmake configure), so redeploying with a fresh build automatically invalidates all cached assets.

## Asset URL Versioning

The client appends `?v=<stamp>` to all asset URLs:

```
/api/maps/data/wanderlust2.1/heightmap.bin?v=5ca1489766-20260414143333
/api/games/data/papertanks/models/tank.glb?v=5ca1489766-20260414143333
/api/maps/thumb/scorched_crossing_v2.4?v=5ca1489766-20260414143333
```

Because the query parameter changes with each build, browsers treat each deployment's assets as distinct URLs. The server can set aggressive cache headers (`immutable`, 1-year `max-age`) safely — the old cached versions are never requested again after an update.

### How it works

1. Client calls `fetchBuildStamp()` on startup — fetches `GET /api/version` from the lobby
2. The stamp is stored in `CONFIG.buildStamp`
3. All asset fetch calls use `stampUrl(url)` which appends `?v=<stamp>`

```typescript
import { stampUrl } from './config.js';

// Before: fetch('/api/maps/data/foo/bar.glb')
// After:
fetch(stampUrl('/api/maps/data/foo/bar.glb'))
// → '/api/maps/data/foo/bar.glb?v=5ca1489766-20260414143333'
```

### What gets stamped

| Asset type | Where loaded | File |
|-----------|-------------|------|
| Map metadata list | Lobby room browser | `lobby-ui.ts` |
| Map thumbnails | Lobby + viewport | `lobby-ui.ts`, `viewport.ts` |
| Unit .glb models | In-game entity renderer | `entity-renderer.ts` |
| Feature .glb models | In-game feature renderer | `feature-renderer.ts` |
| Game UI templates | Game start | `ui/game/loader.ts` |
| Lobby UI templates | Login | `ui/lobby/loader.ts` |

## Cache Policies

Three tiers of caching, all controlled by `CacheControl.h`:

| Tier | Policy | Used for | Header |
|------|--------|----------|--------|
| **Static assets** | 1 year, immutable | Maps, models, textures, thumbnails | `public, max-age=31536000, immutable` |
| **Metadata** | 5 minutes | Map list, game list, manifest | `public, max-age=300` |
| **Dynamic** | Never cached | API responses, exec, auth, version | `no-store` |

Static assets use immutable caching because the `?v=` parameter makes each build's URLs unique. The browser caches them forever and never revalidates — it simply never requests the old URL again.

### Server-side usage

```cpp
#include "Server/CacheControl.h"

// In an HTTP handler:
return {
    .contentType = "model/gltf-binary",
    .body = modelData,
    .status = 200,
    .cacheControl = CacheControl::StaticAssetHeader(),  // respects --no-cache
};
```

## Development: `--no-cache` Flag

Pass `--no-cache` to the lobby or game server to disable all HTTP caching:

```bash
./build/debug/spring-lobby --no-cache --port 8011 ...
./build/debug/spring-server --no-cache --port <dynamic> ...
```

When active:
- All responses get `Cache-Control: no-store` regardless of tier
- `/api/version` returns `"no_cache": true`
- The `mprocs.yaml` dev config includes `--no-cache` by default

This eliminates stale asset issues during development. No more "clear your cache" or hard-refresh.

## Response Headers

Every HTTP response from the lobby and game server includes:

| Header | Value | Purpose |
|--------|-------|---------|
| `Cache-Control` | varies by tier | Browser caching directive |
| `X-Build-Stamp` | e.g. `5ca1489766-20260414143333` | Identifies the server build |
| `Access-Control-Allow-Origin` | `*` | CORS for browser clients |
| `Content-Type` | varies | Standard MIME type |

The `X-Build-Stamp` header lets clients, proxies, and monitoring tools verify which build a server is running without hitting a specific endpoint.

## Deployment Cache-Busting

When deploying a new version:

1. Build the server (`cmake --preset debug && cmake --build build/debug`)
2. The cmake configure step generates a new build stamp
3. Start the server — it serves the new stamp via `/api/version`
4. Browsers fetch the stamp on page load
5. All asset URLs now include the new `?v=` parameter
6. Browsers fetch fresh assets (old cached versions are orphaned)

No player action required. No hard refresh. No cache clear.

## Client-Side Storage

The client uses `localStorage` for session state (not asset caching):

| Key | Content | Lifetime |
|-----|---------|----------|
| `springrts-username` | Last logged-in username | Until cleared |
| `springrts-token` | Session auth token | 24h (server-enforced) |
| `springrts-game-room` | Active room ID | Until game ends |
| `springrts-game-port` | Game server port | Until game ends |
| `springrts-game-id` | Selected game ID | Until changed |

Tokens are stored in SQLite on the server (`sessions` table) and validated with a 24-hour expiry window. Expired sessions are cleaned up automatically on lobby startup.

## In-Memory Caches (Server)

| Cache | Location | Purpose | Invalidation |
|-------|----------|---------|-------------|
| `EntityDeltaCache` | Game server, per-client | Tracks last-sent entity state for delta compression | Cleared on disconnect |
| `ContentServer.cachedManifest` | Game server | Pre-built JSON asset manifest | Rebuilt on startup |
| `LogBuffer` | Log server | Ring buffer of recent log entries (2000 per source) | Evicts oldest on overflow |

These are runtime caches — they don't affect HTTP caching and aren't exposed to browsers.

## Troubleshooting

**Assets not updating after rebuild:**
- Verify the lobby is running the new binary (check `curl /api/version`)
- If using mprocs, restart the lobby process
- Check that `--no-cache` is in the lobby command line for dev

**Browser still showing old UI:**
- The Vite dev server has its own HMR — this is separate from server caching
- If Vite HMR fails, `touch client/src/main.ts` forces a re-transform
- For production builds, `npx vite build` generates hashed filenames automatically

**Token auth failing after restart:**
- Tokens persist in SQLite — they survive lobby restarts
- Check if the token is >24h old (expired)
- The lobby cleans expired sessions on startup
