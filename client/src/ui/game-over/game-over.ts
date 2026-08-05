/**
 * Game-over overlay.
 *
 * Shown when the server's `onGameOver` fires. Single button returns to
 * the lobby; caller supplies the action.
 */

import { injectStyle, renderTemplate } from '../ui.js';
import type { GameTemplates } from '../game/loader.js';

export interface GameOverCallbacks {
    /** Winning allyteam IDs from the server (empty = undecided). */
    winningAllyTeams?: number[];
    /** Local player's result: true = won, false = lost, null/undefined =
     *  draw / undecided / spectator (neutral headline). */
    won?: boolean | null;
    onReturnToLobby: () => void;
}

/** Headline + winner line from the winners list and the local result (G2).
 *  Exported for unit testing (the overlay's user-visible copy). */
export function describeResult(winningAllyTeams: number[], won: boolean | null | undefined): {
    headline: string; result: string;
} {
    if (winningAllyTeams.length === 0) {
        return { headline: 'Game Over', result: 'The battle ended without a decisive winner.' };
    }
    const names = winningAllyTeams.map((a) => `Ally team ${a}`);
    const winnerLine = names.length === 1
        ? `${names[0]} is victorious!`
        : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]} share victory.`;
    const headline = won === true ? 'Victory' : won === false ? 'Defeat' : 'Game Over';
    return { headline, result: winnerLine };
}

export function showGameOver(
    templates: GameTemplates, frame: number, callbacks: GameOverCallbacks,
): void {
    injectStyle('game-over-style', templates.gameOverCss);

    const { headline, result } = describeResult(
        callbacks.winningAllyTeams ?? [], callbacks.won,
    );

    // Idempotent: the result can be announced more than once for one match —
    // the server re-announces it through the post-game window and a resync
    // gets it replayed at auth (PLAN-endtoend D36). Reuse the existing element
    // rather than stacking a second `#game-over-overlay` on top of the first.
    const overlay = document.getElementById('game-over-overlay')
        ?? document.body.appendChild(Object.assign(document.createElement('div'),
            { id: 'game-over-overlay' }));
    overlay.innerHTML = renderTemplate(templates.gameOverHtml, { frame, headline, result });

    document.getElementById('return-lobby-btn')?.addEventListener('click', callbacks.onReturnToLobby);
}
