/**
 * ui-store.ts — Native UI state store (PLAN-native-ui.md §2)
 *
 * The single source of truth for all UI-relevant game state mirrors.
 * Components subscribe to changes and render accordingly.
 *
 * This store holds mirrors of:
 *   - gameRulesParams: game-wide rules params
 *   - teamRulesParams: per-team rules params
 *   - playerRoster: active players and their teams
 *   - selection: currently selected units
 *   - cmdDescs: available commands for selection
 *   - economy: team resources
 *   - unitQueues: unit command queues
 *   - directives: standing orders/directives
 *   - gameEvents: combat/unit lifecycle events
 *
 * All updates are EVENT-DRIVEN from server streams, never per-frame.
 */

type Subscriber = () => void;
type UnsubscribeFn = () => void;

export interface PlayerInfo {
    /** Spring's sim `playerNum` — the id every rulesParam key and Lua callin
     *  is scoped by, NOT the DB account id. See PLAN-native-ui.md §3.3. */
    playerId: number;
    name: string;
    teamId: number;
    /** The team's ally team; -1 when unknown (pre-GameStart, or a spectator).
     *  Optional so existing seeds that predate the server roster still typecheck. */
    allyTeamId?: number;
    isSpectator: boolean;
    isAI: boolean;
    /** False once the player has disconnected. The row is kept so a scoreboard
     *  can still name them. Absent = assume active. */
    isActive?: boolean;
}

export interface UnitSelection {
    unitIds: number[];
    cmdDescs: any[]; // SCommandDescription[]
}

export interface TeamEconomy {
    metal: number;
    energy: number;
    metalIncome: number;
    energyIncome: number;
    metalUsage: number;
    energyUsage: number;
}

/** Org-group summary for widget consumption (PLAN-macro-ui.md §3, fed by
 *  `gp:orgGroups` — main.ts). `baseCostSum` is the worker-computed Σ
 *  `authority_cost_base` over current members (PLAN-metalstorm-authority.md
 *  §3.3), used by the command composer's cost preview (task 5).
 *
 *  `parentId` / `currentDirectiveId` / `postureJson` mirror `OrgGroupInfoMsg`
 *  and are what make an order-of-battle *tree* renderable: the OOB sidebar
 *  needs the parent link to nest armies → platoons → squads, the directive id
 *  to show each node's current-directive icon, and the posture blob for its
 *  posture chips. They arrive over `gp:orgGroups` already; this type used to
 *  drop them, which is why the panel couldn't be built against the store. */
export interface OrgGroupSummary {
    groupId: number;
    echelon: 'Squad' | 'Platoon' | 'Army';
    ownerTeam: number;
    /** 0 = top-level (no parent). */
    parentId: number;
    name: string;
    memberIds: number[];
    /** 0 = none currently assigned. Index into the `directives` mirror. */
    currentDirectiveId: number;
    /** Raw posture blob (PLAN-macro-orders.md §3); '' when unset. */
    postureJson: string;
    baseCostSum: number;
}

/** One live macro directive (PLAN-macro-directives.md §1), fed by
 *  `gp:directives` — own team + allies, same visibility rule as the
 *  standing-order broadcast.
 *
 *  The org panel reads `assignedStrength / requestedStrength` for its
 *  fulfillment %, and the directive inspector reads the rest. */
export interface DirectiveSummary {
    directiveId: number;
    ownerTeam: number;
    groupId: number;
    type: string;
    priority: number;
    shape: 'Point' | 'Circle' | 'Polygon' | 'Polyline';
    params: number[];
    requestedStrength: number;
    assignedStrength: number;
    assignedSquadCount: number;
    active: boolean;
    createdAtFrame: number;
    expiresAtFrame: number;
}

export class UIStore {
    // State mirrors
    private gameRulesParams = new Map<string, number | string>();
    private teamRulesParams = new Map<number, Map<string, number | string>>();
    private players = new Map<number, PlayerInfo>();
    private selection: UnitSelection = { unitIds: [], cmdDescs: [] };
    private economy = new Map<number, TeamEconomy>();
    private unitQueues = new Map<number, any[]>(); // unitId -> command queue
    private directives = new Map<number, DirectiveSummary>(); // directiveId -> live directive
    private gameEvents: any[] = []; // recent events
    private orgGroups: OrgGroupSummary[] = [];

    // Subscription management
    private subscribers = new Map<string[], Set<Subscriber>>();
    private pendingNotify = new Set<string>();
    private notifyRaf: number | null = null;

    constructor() {
        // Initialize UI root overlay if it doesn't exist
        this.initUIRoot();
    }

    private initUIRoot(): void {
        if (typeof document === 'undefined') return; // Skip in non-browser environment
        if (document.getElementById('ui-root')) return;

        const root = document.createElement('div');
        root.id = 'ui-root';
        root.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            pointer-events: none;
            z-index: 100;
        `;
        document.body.appendChild(root);
    }

    // ─── Public API ───

    /** Subscribe to changes in specified data paths */
    subscribe(paths: string[], callback: Subscriber): UnsubscribeFn {
        const key = [...paths].sort().join(',');
        let subs = this.subscribers.get(paths);
        if (!subs) {
            subs = new Set();
            this.subscribers.set(paths, subs);
        }
        subs.add(callback);

        // Return unsubscribe function
        return () => {
            subs?.delete(callback);
            if (subs?.size === 0) {
                this.subscribers.delete(paths);
            }
        };
    }

    /** Get game rules param */
    gameRulesParam(key: string): number | string | undefined {
        return this.gameRulesParams.get(key);
    }

    /** Get team rules param */
    teamRulesParam(teamId: number, key: string): number | string | undefined {
        return this.teamRulesParams.get(teamId)?.get(key);
    }

    /** The full accumulated game rules-params map (read-only snapshot handle).
     *  The named-entity-index producer needs the whole batch to parse regions
     *  / objectives out of it — the per-key `gameRulesParam` getter can't
     *  enumerate. Returned as the live Map (not a copy): callers must not
     *  mutate it. */
    getGameRulesParams(): ReadonlyMap<string, number | string> {
        return this.gameRulesParams;
    }

    /** Get player info */
    getPlayer(playerId: number): PlayerInfo | undefined {
        return this.players.get(playerId);
    }

    /** Get current selection */
    getSelection(): Readonly<UnitSelection> {
        return this.selection;
    }

    /** Get team economy */
    getEconomy(teamId: number): TeamEconomy | undefined {
        return this.economy.get(teamId);
    }

    /** Get all players */
    getPlayers(): PlayerInfo[] {
        return Array.from(this.players.values());
    }

    /** Get player roster — native-JS widget public API (mirrors
     *  gameRulesParam/teamRulesParam's singular-getter shape; see
     *  scoreboard-panel.js / authority-bar.js's `ctx.store.playerRoster()`).
     *  Arrow-function field, not a prototype method: callers destructure it
     *  off `ctx.store` into a bare reference before calling
     *  (`const getRoster = ctx.store.playerRoster; getRoster()`), which would
     *  drop `this` for an ordinary method. */
    playerRoster = (): PlayerInfo[] => {
        return this.getPlayers();
    };

    /** Get the current org-group snapshot (own team, PLAN-macro-ui.md §3). */
    getOrgGroups(): readonly OrgGroupSummary[] {
        return this.orgGroups;
    }

    /** All live directives (own team + allies), newest-first by creation frame
     *  so an alert feed / inspector list needs no re-sort. */
    getDirectives(): readonly DirectiveSummary[] {
        return Array.from(this.directives.values())
            .sort((a, b) => b.createdAtFrame - a.createdAtFrame);
    }

    /** One directive by id — the org panel's per-node lookup via
     *  `OrgGroupSummary.currentDirectiveId`. */
    getDirective(directiveId: number): DirectiveSummary | undefined {
        return this.directives.get(directiveId);
    }

    /** Directives targeting one org group (a group may hold more than one
     *  over its life; `currentDirectiveId` names the active one). */
    getDirectivesForGroup(groupId: number): DirectiveSummary[] {
        return this.getDirectives().filter(d => d.groupId === groupId);
    }

    // ─── Update methods (called by native UI loader / connection) ───

    /** Update game rules params batch */
    updateGameRulesParams(params: Record<string, number | string | null>, replace = false): void {
        if (replace) {
            this.gameRulesParams.clear();
        }

        for (const [key, value] of Object.entries(params)) {
            if (value === null) {
                this.gameRulesParams.delete(key);
            } else {
                this.gameRulesParams.set(key, value);
            }
        }

        this.notifySubscribers(['gameRulesParams']);
    }

    /** Update team rules params batch */
    updateTeamRulesParams(teamId: number, params: Record<string, number | string | null>, replace = false): void {
        let teamParams = this.teamRulesParams.get(teamId);
        if (!teamParams) {
            teamParams = new Map();
            this.teamRulesParams.set(teamId, teamParams);
        } else if (replace) {
            teamParams.clear();
        }

        for (const [key, value] of Object.entries(params)) {
            if (value === null) {
                teamParams.delete(key);
            } else {
                teamParams.set(key, value);
            }
        }

        this.notifySubscribers(['teamRulesParams']);
    }

    /** Update player roster */
    updatePlayerRoster(players: PlayerInfo[]): void {
        this.players.clear();
        for (const player of players) {
            this.players.set(player.playerId, player);
        }
        this.notifySubscribers(['playerRoster']);
    }

    /** Add or update a player */
    updatePlayer(player: PlayerInfo): void {
        this.players.set(player.playerId, player);
        this.notifySubscribers(['playerRoster']);
    }

    /** Remove a player */
    removePlayer(playerId: number): void {
        this.players.delete(playerId);
        this.notifySubscribers(['playerRoster']);
    }

    /** Update selection */
    updateSelection(unitIds: number[], cmdDescs?: any[]): void {
        this.selection.unitIds = unitIds;
        if (cmdDescs) {
            this.selection.cmdDescs = cmdDescs;
        }
        this.notifySubscribers(['selection']);
    }

    /** Update team economy */
    updateEconomy(teamId: number, economy: Partial<TeamEconomy>): void {
        const current = this.economy.get(teamId) || {
            metal: 0, energy: 0,
            metalIncome: 0, energyIncome: 0,
            metalUsage: 0, energyUsage: 0
        };
        this.economy.set(teamId, { ...current, ...economy });
        this.notifySubscribers(['economy']);
    }

    /** Update unit command queue */
    updateUnitQueue(unitId: number, queue: any[]): void {
        this.unitQueues.set(unitId, queue);
        this.notifySubscribers(['unitQueues']);
    }

    /** Clear unit command queue */
    clearUnitQueue(unitId: number): void {
        this.unitQueues.delete(unitId);
        this.notifySubscribers(['unitQueues']);
    }

    /** Replace the org-group snapshot (`gp:orgGroups` forwarding — own team
     *  only, change-driven). */
    updateOrgGroups(groups: OrgGroupSummary[]): void {
        this.orgGroups = groups;
        this.notifySubscribers(['orgGroups']);
    }

    /** Replace the directive snapshot (`gp:directives` forwarding — own team +
     *  allies, change-driven).
     *
     *  A full replace, not a merge: the worker's `onDirectiveState` is itself a
     *  snapshot, so merging would resurrect directives the server has since
     *  revoked and leave the org panel showing dead intent forever. */
    updateDirectives(directives: DirectiveSummary[]): void {
        this.directives.clear();
        for (const d of directives) {
            this.directives.set(d.directiveId, d);
        }
        this.notifySubscribers(['directives']);
    }

    /** Add game event */
    addGameEvent(event: any): void {
        this.gameEvents.push(event);
        // Keep only last 100 events
        if (this.gameEvents.length > 100) {
            this.gameEvents.shift();
        }
        this.notifySubscribers(['gameEvents']);
    }

    // ─── Internal ───

    private notifySubscribers(changedPaths: string[]): void {
        // Mark paths as pending
        for (const path of changedPaths) {
            this.pendingNotify.add(path);
        }

        // Schedule notification on next frame to batch updates
        if (this.notifyRaf === null) {
            // Use requestAnimationFrame if available, otherwise use setTimeout
            const schedule = typeof requestAnimationFrame !== 'undefined'
                ? requestAnimationFrame
                : (cb: () => void) => setTimeout(cb, 0) as unknown as number;

            this.notifyRaf = schedule(() => {
                this.flushNotifications();
            });
        }
    }

    private flushNotifications(): void {
        this.notifyRaf = null;
        const paths = Array.from(this.pendingNotify);
        this.pendingNotify.clear();

        // Notify all subscribers whose paths match
        for (const [subPaths, callbacks] of this.subscribers.entries()) {
            const shouldNotify = subPaths.some(p => paths.includes(p));
            if (shouldNotify) {
                for (const callback of callbacks) {
                    try {
                        callback();
                    } catch (e) {
                        console.error('UI store subscriber error:', e);
                    }
                }
            }
        }
    }

    /** Clear all state (for cleanup/restart) */
    clear(): void {
        this.gameRulesParams.clear();
        this.teamRulesParams.clear();
        this.players.clear();
        this.selection = { unitIds: [], cmdDescs: [] };
        this.economy.clear();
        this.unitQueues.clear();
        this.directives.clear();
        this.gameEvents = [];
        this.orgGroups = [];
        // Don't notify - this is for teardown
    }

    /** Dispose of the store */
    dispose(): void {
        if (this.notifyRaf !== null) {
            // Use cancelAnimationFrame if available, otherwise use clearTimeout
            const cancel = typeof cancelAnimationFrame !== 'undefined'
                ? cancelAnimationFrame
                : clearTimeout;
            cancel(this.notifyRaf as any);
            this.notifyRaf = null;
        }
        this.subscribers.clear();
        this.clear();
    }
}

// Export singleton instance for production use
export const uiStore = new UIStore();

// Also export the class for testing
export default UIStore;