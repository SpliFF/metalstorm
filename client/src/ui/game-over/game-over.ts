/**
 * Game-over overlay.
 *
 * Shown when the server's `onGameOver` fires. Single button returns to
 * the lobby; caller supplies the action.
 */

import { injectStyle, renderTemplate } from '../ui.js';
import type { GameTemplates } from '../game/loader.js';
import { parseWarSides, type WarSide } from '../../lobby/war-sides.js';

export interface GameOverCallbacks {
    /** Winning allyteam IDs from the server (empty = undecided). */
    winningAllyTeams?: number[];
    /** Local player's result: true = won, false = lost, null/undefined =
     *  draw / undecided / spectator (neutral headline). */
    won?: boolean | null;
    /** The viewer's own ally team, so their own entry in the winners list
     *  reads as "You" rather than by Faction (rename-war D8). */
    myAllyTeam?: number;
    /** The room's raw `war_sides` modoption (`"compact:0,union:4"`), if any —
     *  parsed to name a winning ally team by its Faction. */
    warSides?: string;
    onReturnToLobby: () => void;
}

/** Headline + winner line from the winners list and the local result (G2).
 *  Names the viewer's own ally team "You" and any other winner by its
 *  Faction (from `sides`, the room's parsed `war_sides`), falling back to a
 *  bare team number only when no side data names it (rename-war D8 — the
 *  engine's "Ally team N" is not player-facing vocabulary).
 *  Exported for unit testing (the overlay's user-visible copy). */
export function describeResult(
    winningAllyTeams: number[], won: boolean | null | undefined,
    myAllyTeam?: number, sides?: readonly WarSide[],
): { headline: string; result: string } {
    if (winningAllyTeams.length === 0) {
        return { headline: 'Game Over', result: 'The battle ended without a decisive winner.' };
    }
    const nameFor = (allyTeam: number): string => {
        if (allyTeam === myAllyTeam) return 'You';
        return sides?.find((s) => s.team === allyTeam)?.label ?? `Team ${allyTeam}`;
    };
    const names = winningAllyTeams.map(nameFor);
    const winnerLine = names.length === 1
        ? `${names[0]} ${names[0] === 'You' ? 'are' : 'is'} victorious!`
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
        callbacks.myAllyTeam, parseWarSides(callbacks.warSides),
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
