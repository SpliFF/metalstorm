import { describe, it, expect } from 'vitest';
import { describeResult } from './game-over.js';

// G2 — the game-over overlay must name the winning allyteam and frame the
// result from the local player's perspective (won / lost / neutral). These
// pin the user-visible copy so the winners plumbing (server GameInfo.winning_
// ally_teams → worker → overlay) can't silently regress to the old
// empty-winners deviation.
describe('describeResult (game-over winner naming)', () => {
    it('names a single winning allyteam as a victory for the winner', () => {
        const { headline, result } = describeResult([1], true);
        expect(headline).toBe('Victory');
        expect(result).toBe('Ally team 1 is victorious!');
    });

    it('shows Defeat for a player whose allyteam did not win, still naming the winner', () => {
        const { headline, result } = describeResult([0], false);
        expect(headline).toBe('Defeat');
        expect(result).toBe('Ally team 0 is victorious!');
    });

    it('shows a neutral headline for a draw / spectator (won === null) and names all winners', () => {
        const { headline, result } = describeResult([0, 2], null);
        expect(headline).toBe('Game Over');
        expect(result).toBe('Ally team 0 & Ally team 2 share victory.');
    });

    it('reports an undecided result when the winners list is empty', () => {
        const { headline, result } = describeResult([], null);
        expect(headline).toBe('Game Over');
        expect(result).toBe('The battle ended without a decisive winner.');
    });

    it('lists three-plus winners with a comma series', () => {
        const { result } = describeResult([0, 1, 2], null);
        expect(result).toBe('Ally team 0, Ally team 1 & Ally team 2 share victory.');
    });
});
