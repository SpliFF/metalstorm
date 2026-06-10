import { defineConfig } from 'vite';
import { resolve } from 'path';
import { staticDataPlugin } from './vite-static-data-plugin.js';

// Dev architecture:
//   - Vite (this server) serves the client TS/JS bundle on port 8012
//     and bundles `?raw` HTML/CSS imports, Svelte components, the
//     Lua widget worker, etc.
//   - `staticDataPlugin` intercepts `/api/games/data/*`,
//     `/api/maps/data/*`, `/api/engine/data/*`, `/api/maps/thumb/*`
//     and serves them directly from the repo's `data/` tree with
//     native Last-Modified + ETag revalidation.
//   - Everything else under `/api/*` (REST API, /api/rooms, /api/exec,
//     etc.) proxies to spring-lobby on port 8011.
//
// Production architecture (deferred — see PLAN-static-serving.md):
//   - An external static server (nginx / apache / CDN) must serve:
//       * the built client bundle from `client/dist/`
//       * `/api/games/data/*`, `/api/maps/data/*`,
//         `/api/engine/data/*`, `/api/maps/thumb/*`
//   - The same external server proxies `/api/*` (everything else) to
//     spring-lobby for the REST API + SSE.
//   - spring-lobby itself no longer serves static assets — those four
//     paths return 404 if hit directly.
const GAME_SERVER_PORT = process.env.GAME_SERVER_PORT || '8011';
const REPO_ROOT = resolve(__dirname, '..');

export default defineConfig({
    plugins: [
        staticDataPlugin({ repoRoot: REPO_ROOT }),
    ],
    server: {
        port: parseInt(process.env.WEB_SERVER_PORT || '8012'),
        proxy: {
            '/api': {
                target: `http://localhost:${GAME_SERVER_PORT}`,
                changeOrigin: true,
            },
        },
    },
    build: {
        rolldownOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                viewport: resolve(__dirname, 'viewport.html'),
            },
        },
    },
    // Pass env vars to the client so it knows the game server port
    define: {
        '__GAME_SERVER_PORT__': JSON.stringify(GAME_SERVER_PORT),
    },
    envDir: resolve(__dirname, '..'),
    test: {
        include: ['src/**/*.test.ts'],
    },
});
