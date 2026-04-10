import { defineConfig } from 'vite';
import { resolve } from 'path';

// In production the lobby server serves both the client bundle and
// the REST API on the same port, so the client can fetch relative
// URLs like `/api/maps/data/...` and have them resolve same-origin.
// In dev the Vite server runs on a different port and would otherwise
// serve its SPA index fallback for those paths, so we proxy any /api/*
// request through to the lobby. This lets application code stay
// origin-agnostic whether running against `vite dev` or the packaged
// bundle served by spring-lobby itself.
const GAME_SERVER_PORT = process.env.GAME_SERVER_PORT || '8011';

export default defineConfig({
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
