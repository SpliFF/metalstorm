/**
 * Client configuration — reads from build-time defines set by Vite.
 */

declare const __GAME_SERVER_PORT__: string;

const gamePort = typeof __GAME_SERVER_PORT__ !== 'undefined'
    ? __GAME_SERVER_PORT__
    : '8011';

const host = window.location.hostname || 'localhost';

export const CONFIG = {
    gameServerPort: gamePort,
    wsUrl: `ws://${host}:${gamePort}`,
    httpUrl: `http://${host}:${gamePort}`,
};
