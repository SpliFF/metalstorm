import { defineConfig } from 'vite';
import { resolve } from 'path';
import { staticDataPlugin } from './vite-static-data-plugin.js';
// @ts-expect-error — plain .mjs, deliberately untyped: it is shared with the
// `prebuild` npm hook, which cannot consume TypeScript.
import { protocolGuardPlugin } from './scripts/check-protocol-schema.mjs';

// The Babylon Inspector (used only by the model-inspector debug page,
// babylon-inspector.html) lazily `import()`s optional editor packages — the
// GUI / node / node-geometry / particle / render-graph editors — that we do
// not install and never open from the model inspector. Babylon 9.1.0's
// gui-editor also has no `exports` map, so the subpath the inspector requests
// (`@babylonjs/gui-editor/guiEditor.js`) is unresolvable and 500s the dev
// server. Stub every such subpath to an empty module: the import resolves,
// the destructured symbol is `undefined`, and since we never click those
// panels nothing ever uses it. Only affects the inspector page.
const BABYLON_EDITOR_PKGS = [
    '@babylonjs/gui-editor',
    '@babylonjs/node-editor',
    '@babylonjs/node-geometry-editor',
    '@babylonjs/node-particle-editor',
    '@babylonjs/node-render-graph-editor',
];
function stubBabylonEditors() {
    const STUB = '\0babylon-editor-stub';
    const re = new RegExp(`^(${BABYLON_EDITOR_PKGS.join('|')})(/|$)`);
    return {
        name: 'stub-babylon-editors',
        enforce: 'pre' as const,
        resolveId(id: string) { return re.test(id) ? STUB : null; },
        load(id: string) { return id === STUB ? 'export default {};' : null; },
    };
}

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
//   - `npm run build && npm run preview` is a **local stand-in** for that
//     production shape (PLAN-perf P0b): `vite preview` serves the built
//     bundle, `staticDataPlugin`'s `configurePreviewServer` hook serves the
//     four data routes, and `preview.proxy` below forwards the rest of
//     `/api/*` to spring-lobby — same routing as dev, just against the
//     built, minified bundle. It is not a substitute for a real external
//     static server in an actual deployment.
const GAME_SERVER_PORT = process.env.GAME_SERVER_PORT || '8011';
const REPO_ROOT = resolve(__dirname, '..');

export default defineConfig({
    plugins: [
        // Wire-schema drift guard (PLAN-protocol-guard task 2). Runs in
        // buildStart, so it covers `vite dev` too — mprocs launches vite
        // directly, where npm's `prebuild` hook never fires.
        protocolGuardPlugin({ repoRoot: REPO_ROOT }),
        stubBabylonEditors(),
        staticDataPlugin({ repoRoot: REPO_ROOT }),
    ],
    optimizeDeps: {
        // Keep esbuild's pre-bundler from trying to resolve the optional
        // editor packages the inspector references (see stubBabylonEditors).
        exclude: BABYLON_EDITOR_PKGS,
    },
    server: {
        port: parseInt(process.env.WEB_SERVER_PORT || '8012'),
        proxy: {
            '/api': {
                target: `http://localhost:${GAME_SERVER_PORT}`,
                changeOrigin: true,
            },
        },
    },
    preview: {
        port: parseInt(process.env.WEB_SERVER_PORT || '8012'),
        // Fail hard if the port is taken (usually a running dev server on the
        // same default 8012) instead of silently auto-incrementing — a perf
        // capture pointed at the "preview" URL would otherwise measure the
        // unminified dev bundle. Dev keeps Vite's auto-increment behaviour.
        strictPort: true,
        proxy: {
            '/api': {
                target: `http://localhost:${GAME_SERVER_PORT}`,
                changeOrigin: true,
            },
        },
    },
    build: {
        // PLAN-client-resilience.md task 3: generate sourcemaps so a crash
        // report's minified stack can be resolved later, but 'hidden' omits
        // the `//# sourceMappingURL` comment — the map exists as a build
        // artifact without being served to (or fetchable by) the browser.
        // "ship the map to the server, not the client" (the plan's phrasing)
        // still needs a deploy step to actually copy `dist/**/*.map`
        // somewhere the server can read it — PLAN-static-serving.md's
        // production client build/deploy pipeline doesn't exist yet (this
        // repo has no `vite build` step wired into anything today), so that
        // half is a documented gap, not built here; wire it when that
        // pipeline lands.
        sourcemap: 'hidden',
        rolldownOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                viewport: resolve(__dirname, 'viewport.html'),
                // Bundled Babylon model inspector (approach 2 — same module
                // graph as the game). CDN twin is public/model-inspector.html.
                babylonInspector: resolve(__dirname, 'babylon-inspector.html'),
            },
        },
    },
    // Pass env vars to the client so it knows the game server port
    define: {
        '__GAME_SERVER_PORT__': JSON.stringify(GAME_SERVER_PORT),
    },
    envDir: resolve(__dirname, '..'),
    test: {
        // Two projects, so the ONE gate command (`npx vitest run` from client/)
        // covers both trees. The native-game JS under data/games/*/client is a
        // separate ESM module tree with no build step and its own vitest config
        // — it used to be reachable only by naming that config by hand, which
        // is how PLAN-metalstorm-squad-performance.md §14 S2's 13 governor tests
        // sat red and unnoticed for a week after a merge dropped the code they
        // covered. A suite in no gate is not a gate.
        projects: [
            {
                extends: true,
                test: {
                    name: 'client',
                    // `wire/` is the scripted wire client (PLAN-replay §7.11
                    // T2-a-1). Its off-QUIC half belongs in this gate for the
                    // reason written above: a suite in no gate is not a gate.
                    include: ['src/**/*.test.ts', 'wire/**/*.test.ts'],
                },
            },
            {
                test: {
                    name: 'metalstorm-game',
                    root: resolve(__dirname, '../data/games/metalstorm/client'),
                    include: ['**/*.test.js'],
                    environment: 'node',
                },
            },
        ],
    },
});
