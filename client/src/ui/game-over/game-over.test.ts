import { describe, it, expect } from 'vitest';
import { describeResult } from './game-over.js';
import type { WarSide } from '../../lobby/war-sides.js';

const FACTION_SIDES: WarSide[] = [
    { faction: 'compact', team: 0, label: 'Compact' },
    { faction: 'union', team: 1, label: 'Union' },
];

// G2 / rename-war D8 — the game-over overlay must name the winning allyteam
// and frame the result from the local player's perspective (won / lost /
// neutral), without leaking the engine's "Ally team N" vocabulary: the
// viewer's own team reads as "You", another team reads by its Faction (from
// the room's `war_sides`) or, lacking that, a plain "Team N". These pin the
// user-visible copy so the winners plumbing (server GameInfo.winning_
// ally_teams → worker → overlay) can't silently regress to the old
// empty-winners deviation or the old engine-vocabulary string.
describe('describeResult (game-over winner naming)', () => {
    it('names the viewer "You" for a solo-mission win (D8: tutorial vs. an AI side)', () => {
        const { headline, result } = describeResult([0], true, 0);
        expect(headline).toBe('Victory');
        expect(result).toBe('You are victorious!');
    });

    it('shows Defeat for a player whose allyteam did not win, naming the winner by team', () => {
        const { headline, result } = describeResult([0], false, 1);
        expect(headline).toBe('Defeat');
        expect(result).toBe('Team 0 is victorious!');
    });

    it('names the winning allyteam by its Faction when war_sides sidedata is available', () => {
        const { headline, result } = describeResult([1], false, 0, FACTION_SIDES);
        expect(headline).toBe('Defeat');
        expect(result).toBe('Union is victorious!');
    });

    it('shows a neutral headline for a draw / spectator (won === null) and names all winners', () => {
        const { headline, result } = describeResult([0, 2], null);
        expect(headline).toBe('Game Over');
        expect(result).toBe('Team 0 & Team 2 share victory.');
    });

    it('reports an undecided result when the winners list is empty', () => {
        const { headline, result } = describeResult([], null);
        expect(headline).toBe('Game Over');
        expect(result).toBe('The battle ended without a decisive winner.');
    });

    it('lists three-plus winners with a comma series, naming a shared Faction win', () => {
        const { result } = describeResult([0, 1, 2], null, undefined, FACTION_SIDES);
        expect(result).toBe('Compact, Union & Team 2 share victory.');
    });
});
