/**
 * Game-over overlay.
 *
 * Shown when the server's `onGameOver` fires. Single button returns to
 * the lobby; caller supplies the action.
 */

import { injectStyle, renderTemplate } from '../ui.js';
import type { GameTemplates } from '../game/loader.js';

export interface GameOverCallbacks {
    onReturnToLobby: () => void;
}

export function showGameOver(
    templates: GameTemplates, frame: number, callbacks: GameOverCallbacks,
): void {
    injectStyle('game-over-style', templates.gameOverCss);

    const overlay = document.createElement('div');
    overlay.id = 'game-over-overlay';
    overlay.innerHTML = renderTemplate(templates.gameOverHtml, { frame });
    document.body.appendChild(overlay);

    document.getElementById('return-lobby-btn')?.addEventListener('click', callbacks.onReturnToLobby);
}
