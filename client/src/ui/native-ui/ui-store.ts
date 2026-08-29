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

import type { BattleMoment, BattleMomentMarker } from '../../core/battle-events.js';

/** How much battle history the rung-4 Events tab keeps. The sim's own warlog
 *  ring is 32 and the digest shows 5; this is the client's own record of a
 *  single session and is bounded for the same reason theirs are — the record
 *  is not the HUD's job to hold indefinitely. */
export const BATTLE_HISTORY_MAX = 100;

/** The briefing fields the HUD re-reads. Structurally a `ScenarioBriefing`
 *  (lobby/scenario-picker.ts) minus the art, which the splash owned and a
 *  rung-4 tab has no room for. Declared here rather than imported so the store
 *  does not depend on the lobby. */
export interface StoredBriefing {
    title?: string;
    subtitle?: string;
    story?: string;
    tips: readonly string[];
    parTimeSec?: number;
}

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
    /**
     * What has happened in the battle (battle-clarity U3).
     *
     * This mirror has been declared since the store was written and had NO
     * producer at all — the file header has always said "combat/unit lifecycle
     * events", `widget-loader.ts` has always accepted `gameEvents` as a
     * subscribable path, and nothing ever pushed one. U3 connects it rather
     * than adding a parallel path beside it.
     *
     * It is the rung-4 HISTORY, not the HUD's feed: the decaying notices render
     * from the moments as they ARRIVE, and this is what the Events tab reads
     * when the player asks what they missed.
     */
    private gameEvents: BattleMoment[] = [];
    /**
     * Where each still-live moment is on screen right now.
     *
     * Recomputed in the worker (which owns the camera) at 2 Hz and only posted
     * when it changes, so a stationary camera over a quiet field notifies
     * nobody. A subscribable path rather than a poll mirror because the whole
     * point of an edge pointer is that it MOVES when the player pans.
     */
    private battleMarkers: readonly BattleMomentMarker[] = [];
    /**
     * The scenario briefing this battle booted with (battle-clarity U3).
     *
     * `main.ts` fetches it for the boot splash and, until now, threw it away
     * when the player clicked Begin — so the story and the field advice were
     * readable exactly once, before the player had seen the map they describe.
     * Stashing it here is what makes "the briefing is REACHABLE" true: the
     * Reports tab reads this. Null for a boot with no scenario, no briefing, or
     * `?skipBriefing=1`.
     */
    private briefing: StoredBriefing | null = null;
    private orgGroups: OrgGroupSummary[] = [];
    /**
     * Latest sim frame, mirrored off the scene feed.
     *
     * DELIBERATELY NOT A SUBSCRIBABLE PATH. `gp:sceneState` arrives at render
     * rate, so notifying on it would hand every widget a per-frame redraw —
     * exactly what PLAN-native-ui.md forbids. This is a POLL source: a widget
     * that needs the clock (the objective HUD's countdowns) reads it on its own
     * 1 Hz tick, and a widget that does not is unaffected by it changing.
     */
    private gameFrame = 0;

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

    /** The sim frame the scene feed last reported, 0 before the first frame.
     *  See the field's note: this is a poll source, never a notification. */
    getGameFrame(): number {
        return this.gameFrame;
    }

    /** Fed from main.ts's `gp:sceneState` handler. Does not notify. */
    setGameFrame(frame: number): void {
        if (Number.isFinite(frame)) this.gameFrame = frame;
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

    /**
     * Record what just happened (battle-clarity U3).
     *
     * Called with the worker's `gp:battleMoments.moments`, which is already
     * coalesced — one entry per piece of news, not one per shot — so the cap
     * below is a backstop against a long match, not a de-duplicator.
     */
    addBattleMoments(moments: readonly BattleMoment[]): void {
        if (moments.length === 0) return;
        this.gameEvents.push(...moments);
        if (this.gameEvents.length > BATTLE_HISTORY_MAX) {
            this.gameEvents.splice(0, this.gameEvents.length - BATTLE_HISTORY_MAX);
        }
        this.notifySubscribers(['gameEvents']);
    }

    /** The scenario briefing, or null when this boot had none. */
    getBriefing(): StoredBriefing | null { return this.briefing; }

    /** Fed by main.ts at boot, from the same fetch the splash uses. */
    setBriefing(briefing: StoredBriefing | null): void {
        this.briefing = briefing;
        this.notifySubscribers(['briefing']);
    }

    /** Everything that has happened, oldest first. The rung-4 Events tab. */
    getBattleMoments(): readonly BattleMoment[] {
        return this.gameEvents;
    }

    /** Screen state of the live moments, from the worker's projection. */
    setBattleMarkers(markers: readonly BattleMomentMarker[]): void {
        this.battleMarkers = markers;
        this.notifySubscribers(['battleMarkers']);
    }

    getBattleMarkers(): readonly BattleMomentMarker[] {
        return this.battleMarkers;
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
        this.battleMarkers = [];
        this.briefing = null;
        this.orgGroups = [];
        // A stale frame would make the next match's first countdowns tick from
        // the last match's clock.
        this.gameFrame = 0;
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