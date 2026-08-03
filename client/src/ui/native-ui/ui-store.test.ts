import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UIStore, type DirectiveSummary } from './ui-store';

describe('UIStore', () => {
    let store: UIStore;

    beforeEach(() => {
        store = new UIStore();
    });

    afterEach(() => {
        store.dispose();
        vi.clearAllTimers();
    });

    it('should store and retrieve game rules params', () => {
        store.updateGameRulesParams({
            'test_param': 42,
            'string_param': 'hello'
        });

        expect(store.gameRulesParam('test_param')).toBe(42);
        expect(store.gameRulesParam('string_param')).toBe('hello');
        expect(store.gameRulesParam('missing')).toBeUndefined();
    });

    it('should handle replace mode for game rules params', () => {
        store.updateGameRulesParams({ 'old': 1, 'keep': 2 });
        store.updateGameRulesParams({ 'new': 3, 'keep': 4 }, true);

        expect(store.gameRulesParam('old')).toBeUndefined();
        expect(store.gameRulesParam('keep')).toBe(4);
        expect(store.gameRulesParam('new')).toBe(3);
    });

    it('should delete params when value is null', () => {
        store.updateGameRulesParams({ 'test': 42 });
        expect(store.gameRulesParam('test')).toBe(42);

        store.updateGameRulesParams({ 'test': null });
        expect(store.gameRulesParam('test')).toBeUndefined();
    });

    it('should store and retrieve team rules params', () => {
        store.updateTeamRulesParams(1, {
            'authority_pool': 100,
            'authority_player_5': 25
        });

        expect(store.teamRulesParam(1, 'authority_pool')).toBe(100);
        expect(store.teamRulesParam(1, 'authority_player_5')).toBe(25);
        expect(store.teamRulesParam(2, 'authority_pool')).toBeUndefined();
    });

    it('should notify subscribers on changes', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const unsub = store.subscribe(['gameRulesParams'], callback);

        store.updateGameRulesParams({ 'test': 1 });
        expect(callback).not.toHaveBeenCalled(); // Batched

        vi.runAllTimers();
        expect(callback).toHaveBeenCalledTimes(1);

        unsub();
        store.updateGameRulesParams({ 'test': 2 });
        vi.runAllTimers();
        expect(callback).toHaveBeenCalledTimes(1); // Not called after unsub
    });

    it('should batch multiple updates in same frame', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        store.subscribe(['gameRulesParams', 'teamRulesParams'], callback);

        store.updateGameRulesParams({ 'a': 1 });
        store.updateTeamRulesParams(1, { 'b': 2 });
        store.updateGameRulesParams({ 'c': 3 });

        expect(callback).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(callback).toHaveBeenCalledTimes(1); // All batched into one notification
    });

    it('should manage player roster', () => {
        const players = [
            { playerId: 1, name: 'Player1', teamId: 0, isSpectator: false, isAI: false },
            { playerId: 2, name: 'AI Bot', teamId: 1, isSpectator: false, isAI: true }
        ];

        store.updatePlayerRoster(players);
        expect(store.getPlayer(1)?.name).toBe('Player1');
        expect(store.getPlayer(2)?.isAI).toBe(true);
        expect(store.getPlayers()).toHaveLength(2);

        store.removePlayer(1);
        expect(store.getPlayer(1)).toBeUndefined();
        expect(store.getPlayers()).toHaveLength(1);
    });

    it('should manage selection state', () => {
        const cmdDescs = [
            { id: 1, name: 'Move' },
            { id: 2, name: 'Attack' }
        ];

        store.updateSelection([100, 101], cmdDescs);
        const selection = store.getSelection();
        expect(selection.unitIds).toEqual([100, 101]);
        expect(selection.cmdDescs).toEqual(cmdDescs);
    });

    it('should manage team economy', () => {
        store.updateEconomy(0, {
            metal: 1000,
            metalIncome: 10.5,
            metalUsage: 5.2
        });

        const econ = store.getEconomy(0);
        expect(econ?.metal).toBe(1000);
        expect(econ?.metalIncome).toBe(10.5);
        expect(econ?.energy).toBe(0); // Default value
    });

    it('should manage game events with limit', () => {
        vi.useFakeTimers();
        const callback = vi.fn();

        // Subscribe before adding events
        store.subscribe(['gameEvents'], callback);

        // Add 105 events
        for (let i = 0; i < 105; i++) {
            store.addGameEvent({ id: i, type: 'test' });
        }

        vi.runAllTimers();

        // Should have been notified for the batch
        expect(callback).toHaveBeenCalled();

        // Add another event to verify it still works
        callback.mockClear();
        store.addGameEvent({ id: 999, type: 'new' });
        vi.runAllTimers();
        expect(callback).toHaveBeenCalled();
    });

    // ─── Directive mirror (`gp:directives`) — PLAN-macro-ui.md §3 ───

    const directive = (directiveId: number, over: Partial<DirectiveSummary> = {}): DirectiveSummary => ({
        directiveId, ownerTeam: 1, groupId: 7, type: 'DefendFront', priority: 2,
        shape: 'Polyline', params: [1, 2, 3], requestedStrength: 200,
        assignedStrength: 80, assignedSquadCount: 3, active: true,
        createdAtFrame: directiveId * 10, expiresAtFrame: 0, ...over,
    });

    it('should store directives and index them by id and group', () => {
        store.updateDirectives([directive(1), directive(2, { groupId: 9 })]);

        expect(store.getDirectives()).toHaveLength(2);
        expect(store.getDirective(1)?.type).toBe('DefendFront');
        expect(store.getDirective(99)).toBeUndefined();
        expect(store.getDirectivesForGroup(7).map(d => d.directiveId)).toEqual([1]);
        expect(store.getDirectivesForGroup(9).map(d => d.directiveId)).toEqual([2]);
    });

    it('should return directives newest-first', () => {
        store.updateDirectives([directive(1), directive(3), directive(2)]);
        expect(store.getDirectives().map(d => d.directiveId)).toEqual([3, 2, 1]);
    });

    it('should replace rather than merge the directive snapshot', () => {
        // A revoked directive must disappear — merging would leave the org
        // panel showing dead intent for the rest of the game.
        store.updateDirectives([directive(1), directive(2)]);
        store.updateDirectives([directive(2)]);

        expect(store.getDirectives().map(d => d.directiveId)).toEqual([2]);
        expect(store.getDirective(1)).toBeUndefined();
    });

    it('should notify directive subscribers', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        store.subscribe(['directives'], callback);

        store.updateDirectives([directive(1)]);
        vi.runAllTimers();

        expect(callback).toHaveBeenCalled();
    });

    it('should carry the org-tree fields the OOB panel needs', () => {
        // parentId / currentDirectiveId / postureJson arrive over gp:orgGroups
        // and used to be dropped by this type — that omission is what blocked
        // the org panel from being built against the store.
        store.updateOrgGroups([{
            groupId: 4, echelon: 'Platoon', ownerTeam: 1, parentId: 2,
            name: '3rd Armoured', memberIds: [11, 12],
            currentDirectiveId: 1, postureJson: '{"roe":"free"}', baseCostSum: 50,
        }]);

        const [g] = store.getOrgGroups();
        expect(g.parentId).toBe(2);
        expect(g.currentDirectiveId).toBe(1);
        expect(g.postureJson).toBe('{"roe":"free"}');
    });

    it('should let a group resolve its current directive through the store', () => {
        store.updateDirectives([directive(1, { groupId: 4, requestedStrength: 200, assignedStrength: 80 })]);
        store.updateOrgGroups([{
            groupId: 4, echelon: 'Platoon', ownerTeam: 1, parentId: 0,
            name: '3rd Armoured', memberIds: [11], currentDirectiveId: 1,
            postureJson: '', baseCostSum: 10,
        }]);

        // The exact lookup the org panel's fulfillment % does.
        const [g] = store.getOrgGroups();
        const d = store.getDirective(g.currentDirectiveId)!;
        expect(d.assignedStrength / d.requestedStrength).toBeCloseTo(0.4);
    });

    it('should clear directives on clear()', () => {
        store.updateDirectives([directive(1)]);
        store.updateOrgGroups([{
            groupId: 1, echelon: 'Squad', ownerTeam: 1, parentId: 0, name: 'A',
            memberIds: [], currentDirectiveId: 0, postureJson: '', baseCostSum: 0,
        }]);
        store.clear();

        expect(store.getDirectives()).toHaveLength(0);
        expect(store.getOrgGroups()).toHaveLength(0);
    });

    it('should clear all state', () => {
        store.updateGameRulesParams({ 'test': 1 });
        store.updateTeamRulesParams(1, { 'test': 2 });
        store.updatePlayerRoster([
            { playerId: 1, name: 'Test', teamId: 0, isSpectator: false, isAI: false }
        ]);

        store.clear();

        expect(store.gameRulesParam('test')).toBeUndefined();
        expect(store.teamRulesParam(1, 'test')).toBeUndefined();
        expect(store.getPlayers()).toHaveLength(0);
    });
});