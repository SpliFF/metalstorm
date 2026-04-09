import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    server: {
        port: parseInt(process.env.WEB_SERVER_PORT || '8012'),
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
        '__GAME_SERVER_PORT__': JSON.stringify(process.env.GAME_SERVER_PORT || '8011'),
    },
    envDir: resolve(__dirname, '..'),
    test: {
        include: ['src/**/*.test.ts'],
    },
});
