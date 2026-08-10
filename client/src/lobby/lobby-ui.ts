/**
 * LobbyUI — login, room browser, room setup screens.
 *
 * The visual layer (HTML + CSS) lives under `client/src/ui/lobby/`. This
 * file owns only the *behaviour* — handing data to the templates,
 * wiring event listeners after each render, and routing protocol
 * messages from the server. Templates are passed in via the
 * constructor and can be hot-swapped at runtime via `setTemplates()`,
 * which is what game-specific overrides ride on top of (see
 * `client/src/ui/lobby/loader.ts`).
 */

import * as flatbuffers from 'flatbuffers';
import { mapListStatus } from './map-list-status';
import { Connection, type ConnectionState } from '../core/connection.js';
import { CONFIG, stampUrl } from '../config.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { RoomCreate } from '../protocol/spring-web/room-create.js';
import { RoomJoin } from '../protocol/spring-web/room-join.js';
import { RoomReady } from '../protocol/spring-web/room-ready.js';
import { RoomTeamSelect } from '../protocol/spring-web/room-team-select.js';
import { RoomStartGame } from '../protocol/spring-web/room-start-game.js';
import { RoomLeave } from '../protocol/spring-web/room-leave.js';
import { RoomAddAI } from '../protocol/spring-web/room-add-ai.js';
import { RoomRemoveAI } from '../protocol/spring-web/room-remove-ai.js';
import { RoomSetAITeam } from '../protocol/spring-web/room-set-aiteam.js';
import { RoomSetStartPos } from '../protocol/spring-web/room-set-start-pos.js';
import { AIListRequest } from '../protocol/spring-web/ailist-request.js';
import { AIListUpdate } from '../protocol/spring-web/ailist-update.js';
import { GameListRequest } from '../protocol/spring-web/game-list-request.js';
import { GameListUpdate } from '../protocol/spring-web/game-list-update.js';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { RoomListUpdate } from '../protocol/spring-web/room-list-update.js';
import { RoomStateUpdate } from '../protocol/spring-web/room-state-update.js';
import { renderTemplate } from '../ui/ui.js';
import {
    defaultTeamForNewSlot, renderSideOptions, sideForFaction, warSidesForRoom,
} from './war-sides.js';
import { decideRoomTransition } from './room-transition.js';
import { LOGOUT_CLEARED_KEYS, runLogout } from './logout.js';
import type { AvailableScenarioInfo } from './scenario-picker.js';
import {
    defaultScenarioFor, noWarNote, noWarReason, parseScenarioList,
    resolveScenarioLabel, scenarioNote, scenarioOptionLabel, scenariosForMap,
} from './scenario-picker.js';
import {
    getDefaultLobbyTemplates,
    type LobbyTemplates,
} from '../ui/lobby/loader.js';
import {
    describeReplayEntry, parseWatchFrame, type ReplayListing,
} from './replay-browser.js';
import { setDeepLinkSeekFrame } from '../ui/replay-bar.js';

const ROOM_STATE_LABELS = ['Setup', 'Waiting', 'Ready Check', 'Loading', 'In Progress', 'Ended'];

export type LobbyScreen = 'login' | 'browser' | 'room' | 'game';

interface RoomInfo {
    id: number; name: string; mapId: string;
    playerCount: number; maxPlayers: number;
    state: number; hasPassword: boolean; hostName: string;
    /// PLAN-replay task 4c: set when this room is a live replay cast rather
    /// than a game. Joining one goes through /api/replays/watch, not
    /// /api/rooms/join — the watch route is what knows about the recording.
    replayFile?: string;
}

interface RoomPlayerInfo {
    playerId: number; username: string; team: number;
    ready: boolean; isSpectator: boolean; isHost: boolean;
    /// Map start position index assigned to this player. -1 = unset.
    startPos: number;
}

/// An AI player that the host has added to the room before game
/// start. Same shape as the wire type — see RoomAISlot in
/// schemas/protocol.fbs.
interface RoomAISlotInfo {
    aiId: string;
    displayName: string;
    team: number;
    /// Map start position index assigned to this AI. -1 = unset
    /// (the lobby auto-fills at game start).
    startPos: number;
    /// Personality/difficulty profile name (PLAN-metalstorm-ai.md §10 task
    /// 6), e.g. "aggressive"/"caretaker" for the strategos AI. Empty = no
    /// override (the plugin falls back to its own default).
    profile: string;
}

/// One AI plugin the server discovered under content/engine/ai or
/// the current game's content/games/<game>/ai directory. Used to
/// populate the host's "Add AI" dropdown.
interface AvailableAIInfo {
    id: string;
    displayName: string;
    description: string;
    isEngineProvided: boolean;
}

/// One discovered game the lobby can host. Populated from
/// GameListUpdate; drives the "create game" dropdown in the
/// browser screen. The `id` is what RoomCreate.game_id carries.
/// One faction declared by a game's gamedata/sidedata.lua, as surfaced by
/// GET /api/factions/<gameId> (PLAN-metalstorm-lobby.md task 0). Drives the
/// sign-up form's required faction picker.
interface AvailableFactionInfo {
    key: string;
    name: string;
    fullName: string;
    description: string;
}

interface AvailableGameInfo {
    id: string;
    displayName: string;
    description: string;
    version: string;
    /// Shader-lighting style the game wants the entity renderer to use,
    /// from `modinfo.lua`'s `lighting` field. `"gameplay"` (default) is
    /// the half-Lambert + high-ambient formula tuned for silhouette
    /// readability at typical RTS camera distance; `"realistic"` is true
    /// Lambert with low ambient — stronger front/back contrast, closer
    /// to what a third-party glTF viewer renders. Unknown values fall
    /// back to gameplay on the renderer side.
    lighting: string;
}

/// Mirrors ai/strategos/config.lua's Config.PROFILES allow-list. A
/// documented duplicate, not a source of truth (like game_scenario.lua's
/// AI_SLATE_KINDS) — the plugin lives in a separate Lua VM the client can't
/// introspect, and only the "strategos" AI ships selectable profiles today.
/// PLAN-metalstorm-ai.md §10 task 6.
const STRATEGOS_PROFILES: { id: string; label: string }[] = [
    { id: '', label: '(default)' },
    { id: 'default', label: 'Balanced' },
    { id: 'aggressive', label: 'Aggressive' },
    { id: 'caretaker', label: 'Caretaker' },
    { id: 'mentor', label: 'Mentor (suggest-only)' },
    { id: 'npc_raider', label: 'NPC Raider (needs scenario slate)' },
];

// AvailableScenarioInfo and every rule that operates on it now live in
// ./scenario-picker.ts, so they can be tested without a DOM — same move, and
// the same reason, as war-sides.ts. Imported above.

interface CurrentRoom {
    id: number; name: string; mapId: string; gameId: string;
    state: number; players: RoomPlayerInfo[];
    aiSlots: RoomAISlotInfo[];
    gameServerPort: number;
    /// Room modoptions as the lobby reports them. `scenario` is the war
    /// this room will stage; the room screen shows it so the coupling
    /// between map and war is visible rather than implicit.
    modOptions: Record<string, string>;
}

export class LobbyUI {
    private container: HTMLDivElement;
    private connection: Connection | null = null;
    private currentScreen: LobbyScreen = 'login';
    private rooms: RoomInfo[] = [];
    private currentRoom: CurrentRoom | null = null;
    /// Guards against firing onGameStart twice for the same game session.
    /// `attachSession()` kicks off a background `lobbyGet('/api/rooms')`
    /// (via `startPolling()`) that isn't cancelled by a subsequent direct
    /// `setCurrentRoomFromJson()` call — when the room is already
    /// Loading/Active at attach time (direct-start's whole point), both
    /// resolve into `updateCurrentRoomFromJson` in quick succession and
    /// would otherwise double-fire. Reset on the state>=5 (Ended) branch
    /// below so a later restart of the *same* persistent room re-arms it.
    private gameStartedForRoomId: number | null = null;
    private onGameStart?: (gameServerPort: number, mapId: string, gameId: string) => void;
    /// PLAN-quickstart.md Part B: true while a detached game session is
    /// parked (worker alive, `currentRoom` still points at that game). Guards
    /// `updateCurrentRoomFromJson`'s gameRunning branch — while detached, a
    /// live room update must NOT re-hide the lobby or re-fire `onGameStart`
    /// (the player deliberately backed out to browse); it only needs to
    /// notice the room ending (E4, below).
    private detached = false;
    /// True while the game surface (canvas + HUD) owns the screen for
    /// `currentRoom` — i.e. between `onGameStart` firing and the player
    /// coming back through `showAfterGame()` (quit, detach, or the
    /// game-over overlay's Return to Lobby). Room updates that arrive
    /// while this is set must not touch the screen; updates that arrive
    /// while it is clear must be allowed to re-render the room view, or
    /// the room freezes on the state it had when the game began (D25).
    private inGame = false;
    private onParkedRoomEnded?: () => void;
    private parkedBanner: HTMLElement | null = null;
    private myPlayerId = 0;
    /// This account's permanent faction, from the `faction` field every auth
    /// response now carries (login / register / validate — PLAN-endtoend.md
    /// D40). Empty for an account that has none: a dev or `/api/rooms/direct`
    /// manifest account, or a pre-faction legacy one.
    ///
    /// The server owns the consequence — it seats by faction and refuses a
    /// cross-faction `POST /api/rooms/team`. The client holds it only so the
    /// room screen can stop offering the side that would be refused.
    private myFaction = '';
    private pendingRejoinRoomId = 0;
    private authToken = '';
    private roomEventSource: EventSource | null = null;
    /// Tracks the room state at last full render so patchRoom() can
    /// detect when the action buttons need to change (state bracket
    /// shift) and fall back to a full re-render.
    private lastRenderedRoomState = -1;
    private availableMaps: {
        id: string;
        name: string;
        mapx: number;
        mapy: number;
        widthElmos: number;
        heightElmos: number;
        /// Authored start positions from the map's mapinfo.lua. Used
        /// to populate the per-slot start-pos dropdown in the room
        /// view. Missing / empty means the map has no authored
        /// positions and the sim will fall back to its own default
        /// placement.
        startPositions?: { x: number; z: number }[];
    }[] = [];
    private templates: LobbyTemplates;

    /// Cached result of the most recent AIListUpdate the server sent.
    /// The AI list is per-game, so this cache is invalidated whenever
    /// the current room's game changes (see handleRoomState). Populated
    /// by sendAIListRequest() and consumed by the host-only "Add AI"
    /// dropdown in showRoom().
    private availableAIs: AvailableAIInfo[] = [];

    /// The game id the cached `availableAIs` was fetched for. Used to
    /// detect when we enter a room running a different game and need
    /// to refresh the AI list before the UI can populate correctly.
    private availableAIsForGame: string = '';

    /// Cached result of the most recent GameListUpdate. Fetched once
    /// on first login; the lobby's game roster is immutable for the
    /// process lifetime, so a single request covers every future
    /// create-room interaction. Powers the game dropdown in the
    /// create-room form.
    private availableGames: AvailableGameInfo[] = [];

    /// The game id the user has selected in the create-room form.
    /// Defaults to the first discovered game once GameListUpdate
    /// arrives. Passed to RoomCreate.game_id on create.
    private selectedGameId: string = '';

    /// Scenarios (war templates) the selected game ships, from
    /// `GET /api/games/<id>/scenarios`. Empty for games that ship none,
    /// which hides the War picker entirely. PLAN-endtoend.md D10.
    private availableScenarios: AvailableScenarioInfo[] = [];

    /// The game id `availableScenarios` was fetched for — the list is
    /// per-game, so changing the game dropdown invalidates it.
    private availableScenariosForGame: string = '';

    /// The scenario id the user picked in the create-room form, or null
    /// for "whatever this map's war is" (the server-side default).
    /// Distinct from '': that is an explicit "no scenario", which the
    /// server honours rather than overriding with the map default.
    private selectedScenarioId: string | null = null;
    /// Factions the sign-up form can offer, fetched once when the login
    /// screen renders (PLAN-metalstorm-lobby.md task 0). There is no game
    /// selection at sign-up time — an account's faction isn't scoped to a
    /// room — so this always asks GET /api/games first and uses whichever
    /// game comes back first, same "first discovered game" convention the
    /// create-room form falls back to via `selectedGameId`.
    private availableFactions: AvailableFactionInfo[] = [];

    // ─── Public read-only accessors for debugging / automation ───

    get room(): CurrentRoom | null { return this.currentRoom; }
    get screen(): LobbyScreen { return this.currentScreen; }
    get token(): string { return this.authToken; }
    get playerId(): number { return this.myPlayerId; }
    get roomList(): RoomInfo[] { return this.rooms; }
    get maps(): typeof this.availableMaps { return this.availableMaps; }
    get games(): AvailableGameInfo[] { return this.availableGames; }
    get ais(): AvailableAIInfo[] { return this.availableAIs; }

    /// When true, the lobby UI never puts itself on screen: the initial
    /// login/auto-login is skipped and every show*()/setTemplates() path
    /// stays a no-op. Set by scenario (`?scenario=`) and direct-boot
    /// (`?direct=`) modes, which own the screen and drive the game
    /// themselves — otherwise the async game-template load resolving into
    /// setTemplates() re-renders (and un-hides) the login form the runner
    /// had already hidden. See main.ts scenario/direct dispatch. Not
    /// permanent: quitToLobby lifts it via unsuppress() so quitting a
    /// scenario/direct game still lands on a usable lobby.
    private suppressed = false;

    constructor(
        onGameStart?: (gameServerPort: number, mapId: string, gameId: string) => void,
        templates?: LobbyTemplates,
        suppressed = false,
    ) {
        this.onGameStart = onGameStart;
        this.templates = templates ?? getDefaultLobbyTemplates();
        this.container = document.getElementById('lobby') as HTMLDivElement;
        this.suppressed = suppressed;
        this.injectStyles();

        // §5's digest deep-link: `?watch=<file>&frame=N` → watch that
        // recording as soon as there is a session to watch it with. Held
        // rather than fired here because the constructor usually runs before
        // auto-login has resolved, and the watch route needs a token.
        const params = new URLSearchParams(window.location.search);
        const watchFile = params.get('watch');
        if (watchFile) {
            this.pendingWatch = {
                file: watchFile,
                frame: parseWatchFrame(params.get('frame')),
            };
        }

        // Try auto-login with saved session
        const savedUser = localStorage.getItem('springrts-username');
        const savedToken = localStorage.getItem('springrts-token');
        console.log(`[lobby] init: savedUser=${savedUser ?? 'null'} savedToken=${savedToken ? savedToken.substring(0,8) + '...' : 'null'} suppressed=${suppressed}`);
        if (this.suppressed) {
            this.hide();
        } else if (savedUser && savedToken) {
            this.tryAutoLogin(savedUser, savedToken);
        } else {
            this.showLogin();
        }
    }

    /**
     * Hot-swap the active template bundle and re-render the current
     * screen. Used to apply game-specific UI overrides — see
     * `loadGameLobbyTemplates` in `client/src/ui/lobby/loader.ts`.
     */
    setTemplates(templates: LobbyTemplates): void {
        this.templates = templates;
        this.injectStyles();
        // Suppressed (scenario/direct boot): keep the swapped-in templates
        // for a possible later un-suppress, but never re-render — a
        // re-render here would un-hide the login form the runner hid.
        if (this.suppressed) return;
        if (this.currentScreen === 'login') this.showLogin();
        else if (this.currentScreen === 'browser') this.showBrowser();
        else if (this.currentScreen === 'room') this.showRoom();
    }

    private autoLoginAttempts = 0;

    private async tryAutoLogin(username: string, token: string): Promise<void> {
        if (this.suppressed) return;
        this.container.style.display = 'flex';
        this.container.innerHTML = renderTemplate(this.templates.reconnecting, {
            attempt_suffix: this.autoLoginAttempts > 0
                ? ` (attempt ${this.autoLoginAttempts + 1})`
                : '',
        });

        try {
            const resp = await fetch(`${CONFIG.httpUrl}/api/auth/validate`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: '{}',
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.valid) {
                    this.authToken = token;
                    this.myPlayerId = data.user_id ?? 0;
                    this.myFaction = data.faction ?? '';
                    console.log(`[lobby] auto-login OK: user=${data.username}`
                        + `${this.myFaction ? ` faction=${this.myFaction}` : ''}`);
                    localStorage.setItem('springrts-token', token);

                    const savedRoomId = localStorage.getItem('springrts-game-room');
                    if (savedRoomId) {
                        this.pendingRejoinRoomId = parseInt(savedRoomId);
                        this.joinRoom(this.pendingRejoinRoomId);
                    }
                    this.startPolling();
                    this.showBrowser();
                    return;
                }
            }
        } catch { /* network error */ }

        this.autoLoginAttempts++;
        if (this.autoLoginAttempts < 5) {
            console.log(`[lobby] auto-login attempt ${this.autoLoginAttempts} failed, retrying...`);
            setTimeout(() => this.tryAutoLogin(username, token), 1000);
        } else {
            this.autoLoginAttempts = 0;
            localStorage.removeItem('springrts-token');
            this.showLogin();
        }
    }

    getConnection(): Connection | null { return this.connection; }

    /// Create a Connection for the game server (WebTransport). Only used
    /// when a game starts — not for lobby operations.
    createGameConnection(): Connection {
        return new Connection({
            onEntityState: () => {},
            onCombatEvents: () => {},
            onEntityDestroy: () => {},
        });
    }
    show(): void { if (this.suppressed) return; this.container.style.display = 'flex'; }
    hide(): void { this.container.style.display = 'none'; }

    /**
     * Lift the scenario/direct-boot suppression so the lobby can render
     * again. Called by main.ts's quitToLobby: in suppressed mode every
     * show*() path is a no-op, so an ESC-quit out of a `?scenario=` /
     * `?direct=` game would otherwise land on a permanently blank page.
     * The template bundle swapped in via setTemplates() while suppressed
     * was deliberately retained for exactly this un-suppress. No-op when
     * not suppressed (the normal lobby flow).
     */
    unsuppress(): void { this.suppressed = false; }

    /**
     * Inject an already-acquired session token into the lobby. Used by
     * the scenario runner, which performs its own /api/auth/login via
     * fetch (the runner bypasses the saved-session auto-login path) but
     * still needs the lobby to be in a "logged-in" state so:
     *   - `lobbyPost` works (TestHarness uses it for /api/exec)
     *   - the SSE stream is active and `onGameStart` fires when the
     *     game server reports state=Active
     *
     * Safe to call repeatedly — it overwrites the token and (re-)starts
     * polling. The lobby UI is not shown automatically; callers that
     * want it visible should call `show()` themselves.
     */
    attachSession(token: string, userId: number, username: string): void {
        this.authToken = token;
        this.myPlayerId = userId;
        localStorage.setItem('springrts-username', username);
        localStorage.setItem('springrts-token', token);
        this.startPolling();
    }

    /**
     * Adopt an externally-fetched room JSON as the lobby's current room.
     * Used by the scenario runner, which POSTs `/api/rooms` itself to
     * keep its pipeline explicit but still needs the lobby to track
     * `currentRoom` so the SSE handler will fire `onGameStart` when the
     * room transitions to Active.
     */
    setCurrentRoomFromJson(roomJson: any): void {
        this.updateCurrentRoomFromJson(roomJson);
    }

    // ─── HTTP helpers for lobby operations ───

    async lobbyPost(path: string, body: Record<string, unknown> = {}): Promise<any> {
        const resp = await fetch(`${CONFIG.httpUrl}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.authToken}`,
            },
            body: JSON.stringify(body),
        });
        return resp.json();
    }

    async lobbyGet(path: string): Promise<any> {
        const resp = await fetch(stampUrl(`${CONFIG.httpUrl}${path}`));
        return resp.ok ? resp.json() : null;
    }

    private startPolling(): void {
        if (this.roomEventSource) return;

        // Fetch initial room list, then connect SSE for live updates
        this.lobbyGet('/api/rooms').then(rooms => {
            if (Array.isArray(rooms)) this.applyRoomList(rooms);
        }).catch(() => {});

        const es = new EventSource(`${CONFIG.httpUrl}/api/rooms/stream`);
        this.roomEventSource = es;
        es.addEventListener('rooms', (e: MessageEvent) => {
            try {
                const rooms = JSON.parse(e.data);
                if (Array.isArray(rooms)) this.applyRoomList(rooms);
            } catch { /* ignore parse errors */ }
        });
        es.onerror = () => {
            // EventSource auto-reconnects; no manual retry needed
        };
    }

    private stopPolling(): void {
        if (this.roomEventSource) {
            this.roomEventSource.close();
            this.roomEventSource = null;
        }
    }

    private applyRoomList(rooms: any[]): void {
        this.rooms = rooms.map((r: any) => ({
            id: r.id, name: r.name ?? '', mapId: r.map ?? '',
            playerCount: r.players?.length ?? 0, maxPlayers: 8,
            state: r.state ?? 0, hasPassword: false,
            hostName: r.players?.find((p: any) => p.is_host)?.username ?? '',
            replayFile: r.replay_file,
        }));

        // Check if our current room still exists
        if (this.currentRoom) {
            const myRoom = rooms.find((r: any) => r.id === this.currentRoom!.id);
            if (!myRoom) {
                console.log(`[lobby] current room ${this.currentRoom.id} no longer exists`);
                // E4: the room vanished outright (not just state>=5) while parked.
                if (this.detached) this.onParkedRoomEnded?.();
                this.currentRoom = null;
                localStorage.removeItem('springrts-game-room');
                localStorage.removeItem('springrts-game-port');
                if (this.currentScreen === 'room') { this.showBrowser(); return; }
            } else {
                this.updateCurrentRoomFromJson(myRoom);
            }
        }

        if (this.currentScreen === 'browser') this.renderRoomList();
    }

    private updateCurrentRoomFromJson(r: any): void {
        const players: RoomPlayerInfo[] = (r.players ?? []).map((p: any) => ({
            playerId: p.player_id ?? 0, username: p.username ?? '',
            team: p.team ?? 0, ready: p.ready ?? false,
            isSpectator: p.is_spectator ?? false, isHost: p.is_host ?? false,
            startPos: p.start_pos ?? -1,
        }));
        const aiSlots: RoomAISlotInfo[] = (r.ai_slots ?? []).map((s: any) => ({
            aiId: s.ai_id ?? '', displayName: s.name ?? s.ai_id ?? '',
            team: s.team ?? 0, startPos: s.start_pos ?? -1,
            profile: s.profile ?? '',
        }));
        const newGameId = r.game ?? '';
        this.currentRoom = {
            id: r.id, name: r.name ?? '', mapId: r.map ?? '',
            gameId: newGameId,
            state: r.state ?? 0, players, aiSlots,
            gameServerPort: r.game_server_port ?? 0,
            modOptions: (r.modoptions && typeof r.modoptions === 'object')
                ? r.modoptions as Record<string, string> : {},
        };

        // Refresh AI list when entering a room with a different game
        if (this.availableAIsForGame !== newGameId) {
            this.refreshAIList();
        }
        // Same for the scenario list — the room screen resolves the room's
        // `scenario` modoption to a display name out of it. Covers the
        // auto-rejoin path, where the create form was never opened.
        if (newGameId && this.availableScenariosForGame !== newGameId) {
            this.refreshScenarioList(newGameId);
        }

        const transition = decideRoomTransition(
            this.currentRoom.id, this.currentRoom.state, this.currentRoom.gameServerPort,
            { gameStartedForRoomId: this.gameStartedForRoomId, inGame: this.inGame, detached: this.detached },
        );
        if (transition !== 'refresh-room-game-gone') {
            // A live game to reconnect to — persist the creds a page refresh
            // uses to land back in it.
            localStorage.setItem('springrts-game-room', String(this.currentRoom.id));
            localStorage.setItem('springrts-game-port', String(this.currentRoom.gameServerPort));
        }
        switch (transition) {
            case 'stay-in-game':
                // The game surface owns the screen — `currentRoom` is now
                // fresh and there is nothing else to do.
                return;
            case 'enter-game':
                this.gameStartedForRoomId = this.currentRoom.id;
                this.inGame = true;
                this.stopPolling();
                this.hide();
                this.onGameStart?.(this.currentRoom.gameServerPort, this.currentRoom.mapId, this.currentRoom.gameId);
                return;
            case 'refresh-room-game-gone':
                // E4: the game ended while a session was parked — dispose the
                // parked worker now rather than waiting out the park TTL. Note
                // this used to test `state >= 5`, which a finished war never
                // reaches: the lobby recycles the room to `Filling` when the
                // subprocess exits (RoomManager::ResetRoomForNextGame), so the
                // TTL was doing all the work.
                if (this.detached) this.onParkedRoomEnded?.();
                this.gameStartedForRoomId = null;
                localStorage.removeItem('springrts-game-room');
                localStorage.removeItem('springrts-game-port');
                break;
            case 'refresh-room':
                break;
        }
        if (this.currentScreen === 'room') {
            if (!this.patchRoom()) this.showRoom();
        }
    }

    handleServerMessage(msg: ServerMessage): void {
        // Room state updates now come from HTTP polling, not WebRTC.
        // This method is kept for any game-server messages that might
        // route through the lobby connection.
    }

    // ===================== LOGIN =====================

    showLogin(): void {
        this.currentScreen = 'login';
        if (this.suppressed) return;
        this.container.style.display = 'flex';
        this.container.innerHTML = this.templates.login;
        document.getElementById('login-form')!.onsubmit = (e) => {
            e.preventDefault();
            this.doLogin();
        };

        // PLAN-metalstorm-lobby.md task 0: faction is a required, one-time
        // sign-up choice — only shown once the user signals "new account"
        // by filling the confirm-password field (the same signal doLogin()
        // itself uses to decide login vs. register).
        const pass2El = document.getElementById('login-pass2') as HTMLInputElement | null;
        const groupEl = document.getElementById('login-faction-group');
        const selectEl = document.getElementById('login-faction') as HTMLSelectElement | null;
        const descEl = document.getElementById('login-faction-desc');
        if (pass2El && groupEl) {
            pass2El.oninput = () => groupEl.classList.toggle('hidden', pass2El.value === '');
        }
        if (selectEl && descEl) {
            selectEl.onchange = () => {
                const f = this.availableFactions.find(x => x.key === selectEl.value);
                descEl.textContent = f ? f.description : '';
            };
        }
        this.fetchFactionsForSignup();
    }

    /// Populate the sign-up faction picker. Hardcoded to Metalstorm, not
    /// "whichever game comes first" — the lobby can discover several game
    /// folders (this dev tree also carries archived BAR/ZK/papertanks
    /// content), and `/api/games` is not guaranteed to list Metalstorm
    /// first (verified: alphabetical, `bar` sorts before `metalstorm`).
    /// accounts.faction_id is Metalstorm's account model specifically
    /// (PLAN-metalstorm-lobby.md task 0), not a generic pick-the-first-game
    /// abstraction — same reasoning as the server's `factionRegistry` scope
    /// (rts/lobby_main.cpp).
    private async fetchFactionsForSignup(): Promise<void> {
        try {
            const factions = await this.lobbyGet('/api/factions/metalstorm');
            if (!Array.isArray(factions) || factions.length === 0) return;
            this.availableFactions = factions;

            const selectEl = document.getElementById('login-faction') as HTMLSelectElement | null;
            if (!selectEl) return;
            for (const f of factions) {
                const opt = document.createElement('option');
                opt.value = f.key;
                opt.textContent = f.fullName || f.name;
                selectEl.appendChild(opt);
            }
        } catch {
            // Sign-up faction choice degrades to "no factions offered" —
            // login (not register) still works with an empty picker.
        }
    }

    private async doLogin(): Promise<void> {
        const user = (document.getElementById('login-user') as HTMLInputElement).value.trim();
        const pass = (document.getElementById('login-pass') as HTMLInputElement).value;
        const pass2 = (document.getElementById('login-pass2') as HTMLInputElement).value;
        const faction = (document.getElementById('login-faction') as HTMLSelectElement | null)?.value ?? '';
        const msgEl = document.getElementById('login-msg')!;

        if (!user) { msgEl.textContent = 'Enter a username'; return; }
        if (!pass) { msgEl.textContent = 'Enter a password'; return; }
        if (pass2 && pass !== pass2) { msgEl.textContent = 'Passwords do not match'; return; }
        if (pass2 && !faction) { msgEl.textContent = 'Choose a faction'; return; }

        msgEl.textContent = 'Connecting...';
        msgEl.className = 'msg';

        try {
            // Try login first, then register if login fails
            let resp = await fetch(`${CONFIG.httpUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: user, password: pass }),
            });

            if (!resp.ok && pass2) {
                // Registration attempt (confirm password was provided)
                resp = await fetch(`${CONFIG.httpUrl}/api/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: user, password: pass, faction }),
                });
            }

            const data = await resp.json();
            if (!resp.ok || !data.token) {
                msgEl.textContent = data.error || 'Login failed';
                msgEl.className = 'msg error';
                return;
            }

            this.authToken = data.token;
            this.myPlayerId = data.user_id ?? 0;
            // Both /login and /register echo the account's faction (D40); the
            // register-time value used to be dropped on the floor here.
            this.myFaction = data.faction ?? '';
            localStorage.setItem('springrts-username', user);
            localStorage.setItem('springrts-token', data.token);
            console.log(`[lobby] login OK: user=${user} id=${this.myPlayerId}`
                + `${this.myFaction ? ` faction=${this.myFaction}` : ''}`);
            this.startPolling();
            this.showBrowser();
        } catch (err) {
            msgEl.textContent = `Connection failed: ${err}`;
            msgEl.className = 'msg error';
        }
    }

    /**
     * Leave the account entirely (PLAN-endtoend.md D45). The ordering and the
     * best-effort semantics are `runLogout`'s; this supplies the effects.
     */
    async logout(): Promise<void> {
        const token = this.authToken;
        await runLogout({
            hasToken: token !== '',
            inRoom: this.currentRoom !== null,
            leaveRoom: () => this.lobbyPost('/api/rooms/leave'),
            revokeToken: () => fetch(`${CONFIG.httpUrl}/api/auth/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: '{}',
            }),
            clearLocalState: () => {
                this.stopPolling();
                this.clearParked();
                for (const key of LOGOUT_CLEARED_KEYS) localStorage.removeItem(key);
                this.authToken = '';
                this.myPlayerId = 0;
                this.myFaction = '';
                this.currentRoom = null;
                this.rooms = [];
                this.replays = null;
                this.pendingRejoinRoomId = 0;
                this.autoLoginAttempts = 0;
            },
        });
        console.log('[lobby] logged out');
        this.showLogin();
    }

    /// Wire the header's logout button. Shared by the browser and room
    /// screens; both ship one, and a game's template override may ship
    /// neither — hence the null check rather than a `!` assertion.
    private wireLogoutButton(): void {
        const btn = document.getElementById('logout-btn') as HTMLButtonElement | null;
        if (!btn) return;
        btn.onclick = () => { void this.logout(); };
    }

    /// Land on the most appropriate lobby screen after the game canvas
    /// is hidden (e.g. after the user clicks Quit mid-game). If the
    /// player is still a member of a room, show the room view;
    /// otherwise show the room browser.
    showAfterGame(): void {
        // The lobby owns the screen again. Restart the room stream that
        // entering the game stopped: without this the room view is frozen on
        // the state it had at kickoff, so a war that has finished (and whose
        // server has exited) still reads "Loading" and still offers a "Rejoin
        // Game" button pointed at a dead port — D25's dead end.
        this.inGame = false;
        this.startPolling();
        if (this.currentRoom) {
            this.showRoom();
        } else {
            this.showBrowser();
        }
    }

    /**
     * PLAN-quickstart.md Part B: the game-processor worker for `currentRoom`
     * is parked (detached, not quit) — show a persistent "return to game"
     * card and start watching this room for state changes so a game-over
     * while parked disposes the worker immediately (E4) instead of waiting
     * on the ~10 min TTL. `onReenter` drives the fast `gpResync` path;
     * `onEnded` is the TTL-independent dispose hook. Idempotent — calling
     * again (e.g. a second detach guard miss) just refreshes the callbacks.
     */
    markParked(onReenter: () => void, onEnded: () => void): void {
        this.detached = true;
        this.onParkedRoomEnded = onEnded;
        this.startPolling();
        this.renderParkedBanner(onReenter);
    }

    /// Clear parked state — called on resync (re-entered), TTL dispose, or
    /// E4 dispose. Safe to call when nothing is parked (no-op banner-wise).
    clearParked(): void {
        this.detached = false;
        this.onParkedRoomEnded = undefined;
        this.parkedBanner?.remove();
        this.parkedBanner = null;
    }

    private renderParkedBanner(onReenter: () => void): void {
        this.parkedBanner?.remove();
        const roomName = this.currentRoom?.name || 'your game';
        const el = document.createElement('div');
        el.id = 'parked-session-banner';
        el.style.cssText =
            'position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%);z-index:150;' +
            'display:flex;align-items:center;gap:0.9rem;padding:0.75rem 1rem;' +
            'background:#161a22;border:1px solid #2a3140;border-radius:10px;' +
            'box-shadow:0 8px 30px rgba(0,0,0,0.45);color:#e6e8ec;' +
            'font-family:system-ui,sans-serif;font-size:0.9rem;';
        const label = document.createElement('span');
        label.textContent = `Parked: ${roomName}`;
        const btn = document.createElement('button');
        btn.textContent = 'Return to game';
        btn.style.cssText =
            'padding:0.45rem 1rem;font-size:0.9rem;border:0;border-radius:6px;' +
            'background:#3b6fe0;color:#fff;cursor:pointer;';
        btn.onclick = () => onReenter();
        el.append(label, btn);
        document.body.appendChild(el);
        this.parkedBanner = el;
    }

    showBrowser(): void {
        // Suppressed (scenario/direct boot): stay off screen and, crucially,
        // do not null currentRoom — the runner's setCurrentRoomFromJson wiring
        // depends on it to fire onGameStart when the room goes Active.
        if (this.suppressed) return;
        this.currentScreen = 'browser';
        this.currentRoom = null;

        // Fetch available maps.
        //
        // A failed fetch must NOT collapse into an empty list. The server
        // answers 503 when it cannot read the map database (D33: the lobby's
        // SQLite handle can fault mid-session while the file and the maps on
        // disk stay perfectly healthy). Rendering that as "No maps found in
        // content/maps/" sent a whole session hunting through the content
        // directory for a problem that was never there.
        this.mapLoadError = '';
        fetch(stampUrl(`${CONFIG.httpUrl}/api/maps`)).then(async r => {
            if (!r.ok) {
                let detail = '';
                try { detail = (await r.json())?.detail ?? ''; } catch { /* non-JSON body */ }
                throw new Error(detail || `HTTP ${r.status}`);
            }
            return r.json();
        }).then(maps => {
            this.availableMaps = maps;
            this.renderMapOptions();
        }).catch(err => {
            this.availableMaps = [];
            this.mapLoadError = err?.message || 'request failed';
            console.error('[lobby] /api/maps failed:', this.mapLoadError);
            this.renderMapOptions();
        });

        // Fetch the game list if we haven't already. Immutable for
        // the lobby's lifetime, so a single request per session is
        // enough — handleGameList() re-renders the dropdown when
        // the response arrives.
        if (this.availableGames.length === 0) {
            this.refreshGameList();
        }

        // D45: the header carries the signed-in account name so the player
        // can see *which* account they are about to log out of — the whole
        // point of the control on a shared machine. Escaped here because
        // renderTemplate substitutes raw.
        this.container.innerHTML = renderTemplate(this.templates.browser, {
            account_name: this.esc(localStorage.getItem('springrts-username') ?? ''),
        });
        this.wireLogoutButton();
        document.getElementById('create-room-btn')!.onclick = () => {
            document.getElementById('create-form')!.style.display = 'block';
        };
        document.getElementById('cancel-create-btn')!.onclick = () => {
            document.getElementById('create-form')!.style.display = 'none';
        };
        document.getElementById('do-create-btn')!.onclick = () => {
            const name = (document.getElementById('new-room-name') as HTMLInputElement).value || 'Game';
            const selected = this.container.querySelector('.map-card.selected');
            const mapId = selected?.getAttribute('data-map-id') ?? '';
            this.createRoom(name, mapId, this.selectedScenarioId);
        };

        // Populate the game dropdown if the list has already arrived.
        // The template owns the <select id="game-select"> element —
        // we just fill it with <option> children and attach a change
        // handler that updates `selectedGameId`.
        this.renderGameOptions();
        this.renderRoomList();
        this.wireReplayPanel();
    }

    // ===================== REPLAYS (PLAN-replay task 4c) =====================

    /// Cached rows from the last `/api/replays/list`. Null until the first
    /// fetch resolves; an empty array means "this lobby records, and has
    /// nothing yet", which is a different screen from "this lobby does not
    /// record" (that one hides the button entirely).
    private replays: ReplayListing[] | null = null;
    /// Set from `?watch=<file>[&frame=N]` at construction and consumed once a
    /// browser screen exists. Deferred rather than fired immediately because a
    /// deep link usually arrives before login has finished.
    private pendingWatch: { file: string; frame: number } | null = null;

    private wireReplayPanel(): void {
        const btn = document.getElementById('show-replays-btn') as HTMLButtonElement | null;
        const panel = document.getElementById('replay-panel');
        if (!btn || !panel) return;
        btn.onclick = () => {
            const showing = panel.style.display !== 'none';
            panel.style.display = showing ? 'none' : 'block';
            if (!showing) void this.refreshReplays();
        };
        // Probe once per browser render so the button only appears on a lobby
        // that is actually recording. A pending deep link opens the panel
        // itself, so the probe doubles as the deep link's trigger.
        void this.refreshReplays().then(() => {
            if (this.replays === null) return;
            btn.style.display = '';
            const pending = this.pendingWatch;
            if (pending) {
                this.pendingWatch = null;
                void this.watchReplay(pending.file, pending.frame);
            }
        });
    }

    /// Fetch the replay list. Leaves `this.replays` null — and the button
    /// hidden — when the lobby is not recording (the route 404s).
    private async refreshReplays(): Promise<void> {
        try {
            const resp = await this.lobbyPost('/api/replays/list');
            if (!resp || !Array.isArray(resp.replays)) { this.replays = null; return; }
            this.replays = resp.replays as ReplayListing[];
        } catch {
            this.replays = null;
        }
        this.renderReplayList();
    }

    private renderReplayList(): void {
        const el = document.getElementById('replay-list');
        if (!el) return;
        const list = this.replays ?? [];
        if (list.length === 0) {
            el.innerHTML = '<div class="empty-state">No replays recorded yet.</div>';
            return;
        }
        el.innerHTML = list.map(r => {
            const m = describeReplayEntry(r);
            return renderTemplate(this.templates.browserReplayEntry, {
                file: this.esc(r.file),
                title: this.esc(m.title),
                outcome: this.esc(m.outcome),
                players: this.esc(m.players),
                detail: this.esc(m.detail),
                watch_label: m.watchLabel,
                disabled_attr: m.disabled ? ' disabled' : '',
            });
        }).join('');

        el.querySelectorAll('.watch-btn:not([disabled])').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                void this.watchReplay(btn.getAttribute('data-file')!);
            };
        });
    }

    /**
     * Ask the lobby to serve a recording, and adopt the room it returns.
     *
     * The response is an ordinary room JSON with a `game_server_port` — which
     * is the entire point of making a replay a real room. Handing it to
     * `updateCurrentRoomFromJson` runs the same Loading→connect path a player
     * takes out of the room screen, so nothing about entering a game forks for
     * replays. (4a and 4b were both verified by hand-injecting exactly this
     * object; this route is what produces it for real.)
     *
     * `frame` is NOT sent to the lobby. A replay server told to seek at launch
     * fast-forwards with its network loop stalled and the watcher's connection
     * times out before it can attach — so the start frame is published for the
     * replay bar to send as an ordinary seek once it is attached, through 4b's
     * control channel. See the watch route in lobby_main.cpp.
     */
    async watchReplay(file: string, frame = 0): Promise<void> {
        setDeepLinkSeekFrame(frame);
        const resp = await this.lobbyPost('/api/replays/watch', { file });
        if (!resp || resp.error) {
            const msg = resp?.error ?? 'could not start a replay server';
            console.error(`[lobby] watch '${file}' failed: ${msg}`);
            const el = document.getElementById('replay-list');
            if (el) {
                const note = document.createElement('div');
                note.className = 'replay-error';
                note.textContent = `Could not watch ${file}: ${msg}`;
                el.prepend(note);
            }
            return;
        }
        console.log(`[lobby] watching '${file}' in room ${resp.id} on port ${resp.game_server_port}`);
        this.updateCurrentRoomFromJson(resp);
    }

    /// Repopulate the `<select id="game-select">` inside the
    /// create-room form with the cached game list. Safe to call
    /// before the list arrives — renders nothing and waits for
    /// handleGameList() to call us back once the response is in.
    private renderGameOptions(): void {
        const sel = document.getElementById('game-select') as HTMLSelectElement | null;
        if (!sel) return;
        if (this.availableGames.length === 0) {
            sel.innerHTML = '<option value="">Loading games…</option>';
            sel.disabled = true;
            return;
        }
        sel.innerHTML = this.availableGames.map(g => {
            const label = this.esc(g.displayName)
                + (g.version ? ` (${this.esc(g.version)})` : '');
            const selAttr = g.id === this.selectedGameId ? ' selected' : '';
            return `<option value="${this.esc(g.id)}"${selAttr}>${label}</option>`;
        }).join('');
        sel.disabled = false;
        sel.onchange = () => {
            this.selectedGameId = sel.value;
            // The scenario list is per-game. Drop the stale pick rather
            // than carry a Metalstorm war id into a ZK room.
            this.selectedScenarioId = null;
            this.refreshScenarioList();
        };
        this.refreshScenarioList();
    }

    /// Fetch the selected game's scenarios, once per game. Games that ship
    /// none return `[]` and the War row stays hidden, so this is a no-op
    /// for every game but Metalstorm today. PLAN-endtoend.md D10.
    private async refreshScenarioList(forGameId?: string): Promise<void> {
        const gameId = forGameId ?? this.selectedGameId;
        if (!gameId) return;
        if (this.availableScenariosForGame === gameId) {
            this.renderScenarioOptions();
            return;
        }
        try {
            const list = await this.lobbyGet(
                `/api/games/${encodeURIComponent(gameId)}/scenarios`);
            // Shipped and generated wars arrive in the same list — the server
            // materialises `generated_scenarios` rows into the directory it
            // then discovers, so there is nothing to merge here.
            this.availableScenarios = parseScenarioList(list);
            this.availableScenariosForGame = gameId;
        } catch {
            this.availableScenarios = [];
            this.availableScenariosForGame = gameId;
        }
        this.renderScenarioOptions();
        // Also refreshes the room screen's "War:" label, which resolves the
        // room's scenario id to a display name out of this same list.
        if (this.currentScreen === 'room' && this.currentRoom) this.showRoom();
    }

    /// Which scenarios are offerable for the map currently selected in the
    /// create form. See scenariosForMap for the filtering rules.
    private scenariosForSelectedMap(): AvailableScenarioInfo[] {
        return scenariosForMap(this.availableScenarios, this.selectedMapId);
    }

    /// Repopulate the War picker. Hidden when the selected game+map pair
    /// has no scenarios at all, so create-room is visually unchanged for
    /// games that don't use them.
    private renderScenarioOptions(): void {
        const row = document.getElementById('scenario-row');
        const sel = document.getElementById('scenario-select') as HTMLSelectElement | null;
        const note = document.getElementById('scenario-note');
        if (!row || !sel) return;

        const offerable = this.scenariosForSelectedMap();
        if (offerable.length === 0) {
            // Don't leave a pick from a previous map applied to this one.
            this.selectedScenarioId = null;

            // A game that ships no scenarios at all keeps its create form
            // unchanged — there is nothing to say about wars to Paper Tanks.
            // But a scenario-driven game whose selected map has no offerable
            // war has something to say, and saying nothing is what made
            // retiring Meridian Basin's war (PLAN-metalstorm-wars.md §7.6)
            // present as a map card that silently offers no war and no reason.
            if (this.availableScenarios.length === 0 || !this.selectedMapId) {
                row.style.display = 'none';
                return;
            }
            row.style.display = 'block';
            sel.style.display = 'none';
            sel.innerHTML = '';
            if (note) {
                const { className, text } =
                    noWarNote(noWarReason(this.availableScenarios,
                                          this.selectedMapId));
                note.className = className;
                note.textContent = text;
            }
            return;
        }
        row.style.display = 'block';
        sel.style.display = '';

        // The default entry carries no value, so the create request omits
        // `scenario` entirely and the server applies the map's default —
        // one owner for that decision, not two that can disagree. Mirrors
        // ScenarioDiscovery::DefaultForMap exactly, including its rule that a
        // non-terminal scenario is never automatic; when the map has only
        // endless wars the honest default is "no war", not one of them.
        const serverDefault = defaultScenarioFor(offerable);
        const options = [
            serverDefault
                ? `<option value="">${this.esc(serverDefault.displayName)} (default for this map)</option>`
                : `<option value="">No war (default) — a free-form battle with no ending</option>`,
            ...offerable.map(s => {
                const selAttr = s.id === this.selectedScenarioId ? ' selected' : '';
                return `<option value="${this.esc(s.id)}"${selAttr}>`
                    + `${this.esc(scenarioOptionLabel(s))}</option>`;
            }),
        ];
        sel.innerHTML = options.join('');
        sel.value = this.selectedScenarioId ?? '';

        const describe = () => {
            if (!note) return;
            const picked = (this.selectedScenarioId
                ? offerable.find(s => s.id === this.selectedScenarioId)
                : serverDefault) ?? null;
            const { className, text } = scenarioNote(picked);
            note.className = className;
            note.textContent = text;
        };
        describe();

        sel.onchange = () => {
            this.selectedScenarioId = sel.value === '' ? null : sel.value;
            describe();
        };
    }

    private selectedMapId = '';
    /// Non-empty when the last /api/maps call failed. Kept distinct from
    /// "zero maps installed" — see the fetch in showBrowser(). D33.
    private mapLoadError = '';

    private renderMapOptions(): void {
        const el = document.getElementById('map-selector');
        if (!el) return;

        const status = mapListStatus(this.availableMaps.length, this.mapLoadError);

        if (status.kind === 'error') {
            // Built via the DOM rather than innerHTML: the detail string is
            // a server error message, not trusted markup.
            el.innerHTML = '';
            const box = document.createElement('div');
            box.className = 'empty-state error-state';
            box.textContent =
                'Could not load the map list — the server could not read its map database.';
            const note = document.createElement('small');
            note.textContent =
                'This is a server fault, not a missing map. Restarting the lobby ' +
                `usually clears it. (${status.detail})`;
            box.appendChild(document.createElement('br'));
            box.appendChild(note);
            el.appendChild(box);
            return;
        }

        if (status.kind === 'empty') {
            el.innerHTML = '<div class="empty-state">No maps found in content/maps/</div>';
            return;
        }

        el.innerHTML = this.availableMaps.map(m => {
            const sizeKm = ((m.widthElmos / 1000) * (m.heightElmos / 1000)).toFixed(1);
            return renderTemplate(this.templates.browserMapCard, {
                id: this.esc(m.id),
                name: this.esc(m.name),
                thumb_url: `/api/maps/thumb/${encodeURIComponent(m.id)}`,
                size_label: `${m.mapx}×${m.mapy} (${sizeKm} km²)`,
                selected_class: m.id === this.selectedMapId ? 'selected' : '',
            });
        }).join('');

        // Auto-select first map
        if (!this.selectedMapId && this.availableMaps.length > 0) {
            this.selectedMapId = this.availableMaps[0].id;
            this.container.querySelector('.map-card')?.classList.add('selected');
        }

        el.querySelectorAll('.map-card').forEach(card => {
            (card as HTMLElement).onclick = () => {
                el.querySelectorAll('.map-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this.selectedMapId = card.getAttribute('data-map-id') ?? '';
                // Wars are authored per map, so the picker's contents change
                // with the map. Drop any pick that belonged to the old one.
                this.selectedScenarioId = null;
                this.renderScenarioOptions();
            };
        });

        // The map list usually arrives after renderGameOptions() ran, so the
        // War row was rendered against an empty `selectedMapId`. Redo it now
        // that a map is actually selected.
        this.renderScenarioOptions();
    }

    /// The room screen's "Map · War" line (PLAN-endtoend.md D10).
    ///
    /// The war is read from the room's own `scenario` modoption, which the
    /// lobby resolved at create time — not re-derived here, so what the
    /// player reads is exactly what the sim will stage. Its display name
    /// comes from the cached scenario list when we have it and falls back
    /// to the raw id when we don't (a room joined without ever opening the
    /// create form). Returns '' for rooms with no scenario in a game that
    /// ships none, which collapses the row.
    private renderRoomSetupLine(r: CurrentRoom): string {
        const parts: string[] = [];
        if (r.mapId) parts.push(`Map: <strong>${this.esc(r.mapId)}</strong>`);

        const scenarioId = r.modOptions.scenario ?? '';
        const gameHasScenarios =
            this.availableScenariosForGame === r.gameId
            && this.availableScenarios.length > 0;
        if (scenarioId) {
            // Resolves generated wars as well as shipped ones — they are in
            // the same list — so a room created with one shows its minted name
            // rather than a raw `gen_<map>_<hash>` id.
            const { label, known, terminal } =
                resolveScenarioLabel(this.availableScenarios, scenarioId);
            // Only claim "no ending" when we actually know the scenario —
            // an unrecognised id means we have no list, not that the war
            // is endless.
            const warn = known && !terminal
                ? ` <span class="scenario-note endless">(no ending)</span>` : '';
            parts.push(`War: <strong>${this.esc(label)}</strong>${warn}`);
        } else if (gameHasScenarios) {
            parts.push(
                `War: <span class="scenario-note endless">none — this war `
                + `cannot end</span>`);
        }
        return parts.length > 0 ? parts.join(' &middot; ') : '';
    }

    private renderRoomList(): void {
        const el = document.getElementById('room-list');
        if (!el) return;

        if (this.rooms.length === 0) {
            el.innerHTML = '<div class="empty-state">No games available — create one!</div>';
            return;
        }

        el.innerHTML = this.rooms.map(r => {
            const detail = r.replayFile
                ? `replay · ${this.esc(r.replayFile)} · ` +
                  `${r.playerCount} watching`
                : `${r.mapId ? this.esc(r.mapId) : '<em>No map</em>'} · ` +
                  `${r.playerCount}/${r.maxPlayers} players · ` +
                  `Host: ${this.esc(r.hostName)}`;
            const joinLabel = r.replayFile ? 'Join cast'
                : r.state >= 5 ? 'Ended'
                : (r.state >= 3 ? 'Watch / Rejoin' : 'Join');
            // A room already Loading/Active auto-spectates anyone not on its
            // original roster (RoomManager::JoinRoom's isActive branch) — the
            // plain Join button already gets you in as a spectator there, so
            // the explicit Spectate button only adds value pre-game (Filling),
            // where the default Join would claim a player slot instead
            // (PLAN-metalstorm-onboarding.md §4).
            const spectateHtml = (!r.replayFile && r.state < 3 && r.state < 5)
                ? `<button class="spectate-btn" data-id="${r.id}">Spectate</button>`
                : '';
            return renderTemplate(this.templates.browserRoomEntry, {
                id: r.id,
                name: this.esc(r.name),
                state: ROOM_STATE_LABELS[r.state] || '?',
                detail,
                join_label: joinLabel,
                disabled_attr: r.state >= 5 ? ' disabled' : '',
                spectate_html: spectateHtml,
            });
        }).join('');

        el.querySelectorAll('.join-btn:not([disabled])').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                const id = parseInt(btn.getAttribute('data-id')!);
                const room = this.rooms.find(r => r.id === id);
                // A replay cast is joined through the watch route, which knows
                // how to attach a second spectator to a server that is already
                // playing a file (§5 casting). /api/rooms/join would put the
                // watcher in the room without ever telling the replay server.
                if (room?.replayFile) { void this.watchReplay(room.replayFile); return; }
                this.joinRoom(id);
            };
        });
        el.querySelectorAll('.spectate-btn').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                this.joinRoom(parseInt(btn.getAttribute('data-id')!), /*asSpectator=*/true);
            };
        });
    }

    // ===================== ROOM =====================

    /// Patch the room DOM in-place without rebuilding innerHTML.
    /// Returns true if the patch succeeded, false if a full re-render
    /// is needed (structural change: player/AI count changed, state
    /// bracket changed, etc.).
    private patchRoom(): boolean {
        if (!this.currentRoom) return false;
        const r = this.currentRoom;

        // Structural checks — if these changed, the DOM shape is
        // different and we need a full re-render.
        if (r.state !== this.lastRenderedRoomState) return false;
        const playerRows = this.container.querySelectorAll('.player-row:not(.ai-row)');
        const aiRows = this.container.querySelectorAll('.ai-row');
        if (playerRows.length !== r.players.length) return false;
        if (aiRows.length !== r.aiSlots.length) return false;

        // Patch room header
        const stateEl = this.container.querySelector('.room-state');
        if (stateEl) stateEl.textContent = ROOM_STATE_LABELS[r.state] || '?';

        // Patch player rows — update team select, ready status, start
        // pos without touching innerHTML so focus/scroll are preserved.
        r.players.forEach((p, i) => {
            const row = playerRows[i];
            if (!row) return;

            // Team select
            const teamSel = row.querySelector('.team-select[data-pid]') as HTMLSelectElement | null;
            if (teamSel && teamSel !== document.activeElement) {
                teamSel.value = String(p.team);
            }

            // Ready status
            const statusEl = row.querySelector('.player-status');
            if (statusEl) {
                statusEl.textContent = p.isSpectator ? 'Spectator' : (p.ready ? '✓ Ready' : '—');
            }

            // Start pos select
            const posSel = row.querySelector('.startpos-select') as HTMLSelectElement | null;
            if (posSel && posSel !== document.activeElement) {
                posSel.value = String(p.startPos);
            }
        });

        // Patch AI rows
        r.aiSlots.forEach((slot, i) => {
            const row = aiRows[i];
            if (!row) return;

            const teamSel = row.querySelector('.ai-team-select') as HTMLSelectElement | null;
            if (teamSel && teamSel !== document.activeElement) {
                teamSel.value = String(slot.team);
            }

            const posSel = row.querySelector('.startpos-select') as HTMLSelectElement | null;
            if (posSel && posSel !== document.activeElement) {
                posSel.value = String(slot.startPos);
            }

            const profileSel = row.querySelector('.ai-profile-select') as HTMLSelectElement | null;
            if (profileSel && profileSel !== document.activeElement) {
                profileSel.value = slot.profile;
            }
        });

        return true;
    }

    private showRoom(): void {
        if (this.suppressed) return;
        if (!this.currentRoom) return;
        this.currentScreen = 'room';
        this.lastRenderedRoomState = this.currentRoom.state;
        const r = this.currentRoom;
        const myPlayer = r.players.find(p => p.playerId === this.myPlayerId);
        const amHost = myPlayer?.isHost ?? false;
        // Room is considered "running" while the host has an active
        // game subprocess — either Loading (3) or Active/In Progress (4).
        const gameRunning = r.state === 3 || r.state === 4;
        // Rooms persist across game sessions: after a game ends
        // members stay in the room to chat, adjust settings, and
        // launch another round. For UI purposes we treat both the
        // initial pre-game states (0-2) and the post-game Ended
        // state (5+) as "preGame" — Ready / Start Game controls
        // reappear and the host can kick off a fresh game without
        // recreating the room.
        const preGame = r.state < 3 || r.state >= 5;

        // Start-position metadata for the room's current map.
        // `availableMaps` is populated on showBrowser() from /api/maps;
        // if the user landed on a room before the fetch completed
        // (e.g. via reconnection), the list is empty and the dropdown
        // renders as "Loading positions…". An empty start_positions
        // array is a legitimate map shape too — the sim will fall
        // back to its own default placement and we hide the dropdown.
        const currentMap = this.availableMaps.find(m => m.id === r.mapId);
        const startPositions = currentMap?.startPositions ?? [];
        const mapHasStartPositions = startPositions.length > 0;

        // Build a "which slot owns which position index" reverse map
        // so the dropdown can mark already-taken slots as unavailable
        // to everyone except the slot that already owns them.
        const posOwner = new Map<number, string>(); // posIdx -> owner label
        for (const p of r.players) {
            if (p.startPos >= 0) posOwner.set(p.startPos, p.username);
        }
        for (const s of r.aiSlots) {
            if (s.startPos >= 0) posOwner.set(s.startPos, s.displayName || s.aiId);
        }

        // Small helper: build the HTML fragment for one start-pos
        // dropdown. `ownerKey` tags the resulting <select> so the
        // change handler wiring below can resolve it back to its
        // target. `canEdit` greys the control out when the viewer
        // doesn't own the slot (non-host, non-self).
        const renderStartPosSelect = (
            currentPos: number,
            ownerKey: string,
            canEdit: boolean,
        ): string => {
            if (!mapHasStartPositions) return '';
            const disabledAttr = canEdit ? '' : ' disabled';
            const options: string[] = [
                `<option value="-1"${currentPos < 0 ? ' selected' : ''}>Unassigned</option>`,
            ];
            for (let i = 0; i < startPositions.length; i++) {
                const owner = posOwner.get(i);
                const selectedAttr = i === currentPos ? ' selected' : '';
                // A position is selectable if it's free OR it's the
                // slot's current assignment (so re-picking the same
                // value is a no-op rather than a permission error).
                const taken = owner !== undefined && i !== currentPos;
                const label = `Pos ${i + 1}` + (taken ? ` (${this.esc(owner!)})` : '');
                const optDisabled = taken ? ' disabled' : '';
                options.push(
                    `<option value="${i}"${selectedAttr}${optDisabled}>${label}</option>`);
            }
            return `<select class="startpos-select" name="startpos-${this.esc(ownerKey)}" data-owner="${this.esc(ownerKey)}"${disabledAttr}>`
                + options.join('')
                + `</select>`;
        };

        // The room's slot list (PLAN-metalstorm-wars.md §7.4). A slot picks a
        // SIDE — Compact / Union — and the server has already resolved each
        // side to the team its army is staged on. Falls back to the legacy
        // Team 1 / Team 2 for every room whose game ships no scenarios.
        const sides = warSidesForRoom(r.modOptions);

        // Pre-render each player row through the template so games
        // can restyle the row layout. The `{{startpos_html}}` and
        // `{{team_options}}` placeholders receive the start-pos select
        // (possibly empty if the map ships no positions) and the side list.
        // The side my own faction binds me to in this room, if any (D40). The
        // server seated me there and refuses any other team, so the dropdown
        // must not offer one — a control whose every alternative is a 403 is
        // D41's silent refusal waiting to happen.
        const myBoundSide = sideForFaction(sides, this.myFaction);
        const playersHtml = r.players.map(p => {
            const canEdit = preGame && (p.playerId === this.myPlayerId || amHost);
            const posSel = renderStartPosSelect(
                p.startPos, `player:${p.playerId}`, canEdit);
            const mine = p.playerId === this.myPlayerId;
            return renderTemplate(this.templates.roomPlayerRow, {
                pid: p.playerId,
                name: this.esc(p.username),
                host_icon: p.isHost ? '★' : '●',
                ready_class: p.ready ? 'ready' : '',
                select_disabled: !mine
                    ? ' disabled'
                    : (myBoundSide
                        ? ` disabled title="You fight for ${this.esc(myBoundSide.label)}"`
                        : ''),
                team_options: renderSideOptions(sides, p.team),
                status: p.isSpectator ? 'Spectator' : (p.ready ? '✓ Ready' : '—'),
                startpos_html: posSel,
            });
        }).join('');

        // AI slot rows — one per entry in the room's aiSlots vector.
        // Non-hosts see a row with a disabled team dropdown (so the
        // AI's team is still visible) and no remove button. The host
        // gets an editable team dropdown, a remove button, and the
        // start-pos select. The add-AI row below the slot list is
        // a separate control for creating new slots.
        const aiRowsHtml = r.aiSlots.map((slot, idx) => {
            const nameText = this.esc(slot.displayName || slot.aiId);
            const removeBtn = (amHost && preGame)
                ? `<button class="ai-remove-btn" data-slot="${idx}" title="Remove AI">✕</button>`
                : '';
            const canEdit = preGame && amHost;
            const posSel = renderStartPosSelect(
                slot.startPos, `ai:${idx}`, canEdit);
            // Side dropdown mirrors the player-row layout: one option per
            // side the room offers, tagged with data-slot so the change
            // handler below can resolve it back to the slot index without
            // replaying the whole roster. Disabled for non-hosts and while a
            // game is running.
            //
            // This select is where endtoend D19 lived: it offered team
            // indices 0 and 1, so the AI opponent on a Meridian war landed on
            // team 1 — a compact teammate the scenario stages no army for —
            // and the union's whole force was skipped. It now offers the
            // scenario's sides, so the opponent lands on team 4 with an army.
            const teamDisabled = canEdit ? '' : ' disabled';
            const teamSel =
                `<select class="ai-team-select" name="ai-team-${idx}" data-slot="${idx}"${teamDisabled}>`
                + renderSideOptions(sides, slot.team)
                + `</select>`;
            // Personality/difficulty profile dropdown (§10 task 6) — only
            // the strategos AI ships selectable profiles; other plugins
            // (e.g. "null") get no dropdown at all.
            const profileSel = slot.aiId !== 'strategos' ? '' : (canEdit
                ? `<select class="ai-profile-select" name="ai-profile-${idx}" data-slot="${idx}">`
                  + STRATEGOS_PROFILES.map(p =>
                      `<option value="${this.esc(p.id)}"${p.id === slot.profile ? ' selected' : ''}>${this.esc(p.label)}</option>`
                  ).join('')
                  + `</select>`
                : `<span class="player-status">${this.esc(slot.profile || '(default)')}</span>`);
            return `<div class="player-row ai-row"><span class="player-icon">🤖</span>`
                + `<span class="player-name">${nameText}</span>`
                + teamSel
                + posSel
                + profileSel
                + `<span class="player-status">AI</span>`
                + removeBtn
                + `</div>`;
        }).join('');

        // (The map + war line is built by renderRoomSetupLine below.)

        // Host-only: "Add AI" row, rendered below the AI slots. Lists
        // every discovered plugin. Shows a disabled placeholder if the
        // list hasn't arrived yet (server responds asynchronously).
        let addAIHtml = '';
        if (amHost && preGame) {
            if (this.availableAIs.length === 0) {
                addAIHtml =
                    `<div class="ai-add-row"><span class="muted">Loading AI list…</span></div>`;
            } else {
                const options = this.availableAIs.map(ai => {
                    const label = this.esc(ai.displayName)
                        + (ai.isEngineProvided ? ' (engine)' : '');
                    return `<option value="${this.esc(ai.id)}">${label}</option>`;
                }).join('');
                // Default the new slot to a side nobody holds, so "Add AI" on
                // a fresh room produces an *opponent* rather than a second
                // occupant of the host's side.
                const occupied = [
                    ...r.players.filter(p => !p.isSpectator).map(p => p.team),
                    ...r.aiSlots.map(s => s.team),
                ];
                const aiDefaultTeam = defaultTeamForNewSlot(sides, occupied);
                addAIHtml =
                    `<div class="ai-add-row">`
                    + `<select id="ai-add-select" class="team-select">${options}</select>`
                    + `<select id="ai-add-team" class="team-select">`
                    + renderSideOptions(sides, aiDefaultTeam)
                    + `</select>`
                    + `<button id="ai-add-btn" class="primary">Add AI</button>`
                    + `</div>`;
            }
        }

        // Action buttons depend on room state + whether the viewer is
        // the host. We compose a small HTML fragment in JS rather than
        // adding more conditional placeholders to the template.
        const actions: string[] = [];
        // Spectators (PLAN-metalstorm-onboarding.md §4) aren't part of the
        // ready-check (RoomManager::AllReady already excludes them) — Ready
        // doesn't apply to them; Enlist is their path to a team slot instead.
        if (preGame && !myPlayer?.isSpectator) {
            actions.push(`<button id="ready-btn" class="${myPlayer?.ready ? 'secondary' : ''}">${myPlayer?.ready ? 'Unready' : 'Ready'}</button>`);
        }
        if (myPlayer?.isSpectator) {
            actions.push('<button id="enlist-btn" class="primary">Enlist</button>');
        }
        if (preGame && amHost) {
            actions.push('<button id="start-btn" class="primary">Start Game</button>');
        }
        if (gameRunning) {
            actions.push(`<button id="rejoin-btn" class="primary">${myPlayer?.isSpectator ? 'Watch Game' : 'Rejoin Game'}</button>`);
        }
        // No "End Game" or "Close Room" buttons. Room lifecycle is
        // handled via Leave: last human out kills the game and room.

        this.container.innerHTML = renderTemplate(this.templates.room, {
            name: this.esc(r.name),
            state: ROOM_STATE_LABELS[r.state] || '?',
            setup_html: this.renderRoomSetupLine(r),
            players_html: playersHtml + aiRowsHtml + addAIHtml,
            actions_html: actions.join(''),
        });

        document.getElementById('leave-btn')!.onclick = () => this.leave();
        this.wireLogoutButton();
        document.getElementById('ready-btn')?.addEventListener('click',
            () => this.ready(!myPlayer?.ready));
        document.getElementById('enlist-btn')?.addEventListener('click',
            () => this.enlist());
        document.getElementById('start-btn')?.addEventListener('click',
            () => this.startGame());
        document.getElementById('rejoin-btn')?.addEventListener('click', () => {
            if (this.currentRoom && this.currentRoom.gameServerPort > 0) {
                // Mirror the hide + save dance that handleRoomState
                // does on the first game start. Without this the
                // lobby stays overlaid on the game canvas after the
                // click and the user just sees the room view again
                // with no visible change — which reads as "Rejoin
                // didn't work" even though startGame() runs fine
                // underneath. Also re-persist the port so a page
                // refresh post-rejoin lands back in the game rather
                // than the lobby.
                localStorage.setItem('springrts-game-room', String(this.currentRoom.id));
                localStorage.setItem('springrts-game-port', String(this.currentRoom.gameServerPort));
                this.inGame = true;
                this.gameStartedForRoomId = this.currentRoom.id;
                this.hide();
                this.onGameStart?.(this.currentRoom.gameServerPort, this.currentRoom.mapId, this.currentRoom.gameId);
            }
        });
        // "End Game" and "Close Room" buttons removed — room lifecycle
        // is handled entirely via Leave. When the last human leaves a
        // non-persistent room, the server abandons it and kills the
        // game. Host transfer happens automatically.

        // The team-select dropdown is reused both as a player team
        // picker AND as the host's "add-AI" dropdowns; we only want
        // the change handler on the player-row selects (which carry
        // a data-pid attribute). Filter by that attribute so the
        // add-AI row's selects don't try to reassign the player's team.
        this.container.querySelectorAll('.team-select[data-pid]').forEach(sel => {
            (sel as HTMLSelectElement).onchange = (e) => {
                const team = parseInt((e.target as HTMLSelectElement).value);
                this.teamSelect(team);
            };
        });

        // Host-only: AI add + remove buttons. The add control reads
        // from the two dropdowns the host-only render branch emits
        // above; the remove buttons carry their slot index as a
        // data-slot attribute so one listener handles all of them.
        const addBtn = document.getElementById('ai-add-btn') as HTMLButtonElement | null;
        if (addBtn) {
            addBtn.onclick = () => {
                const aiSel = document.getElementById('ai-add-select') as HTMLSelectElement | null;
                const teamSel = document.getElementById('ai-add-team') as HTMLSelectElement | null;
                if (!aiSel || !teamSel) return;
                const aiId = aiSel.value;
                const team = parseInt(teamSel.value);
                if (aiId) this.addAI(aiId, team);
            };
        }
        this.container.querySelectorAll('.ai-remove-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = (e) => {
                const el = e.currentTarget as HTMLButtonElement;
                const idx = parseInt(el.dataset.slot ?? '-1');
                if (idx >= 0) this.removeAI(idx);
            };
        });
        // Per-AI-row team dropdowns. Each one carries its slot
        // index as a data-slot attribute so one listener handles
        // every row. Host-only; non-hosts have the select rendered
        // in disabled state above and the change event never fires.
        this.container.querySelectorAll('.ai-team-select').forEach(sel => {
            (sel as HTMLSelectElement).onchange = (e) => {
                const el = e.target as HTMLSelectElement;
                const idx = parseInt(el.dataset.slot ?? '-1');
                const team = parseInt(el.value);
                if (idx >= 0) this.setAITeam(idx, team);
            };
        });
        // Per-AI-row personality/difficulty profile dropdowns (§10 task 6).
        // Same data-slot addressing as the team dropdown above.
        this.container.querySelectorAll('.ai-profile-select').forEach(sel => {
            (sel as HTMLSelectElement).onchange = (e) => {
                const el = e.target as HTMLSelectElement;
                const idx = parseInt(el.dataset.slot ?? '-1');
                if (idx >= 0) this.setAIProfile(idx, el.value);
            };
        });

        // Start-position dropdowns. The `data-owner` attribute
        // encodes the target: "player:<playerId>" for a human row
        // (including the viewer's own), "ai:<slotIndex>" for an
        // AI row. We translate into the right sendSetStartPos call
        // without the host needing to know which flavour they're
        // editing; the server re-validates the permission on its
        // side regardless.
        this.container.querySelectorAll('.startpos-select').forEach(sel => {
            (sel as HTMLSelectElement).onchange = (e) => {
                const el = e.target as HTMLSelectElement;
                const owner = el.dataset.owner ?? '';
                const posIndex = parseInt(el.value);
                if (owner.startsWith('player:')) {
                    const pid = parseInt(owner.substring('player:'.length));
                    // Use 'self' shorthand when the viewer owns the
                    // slot so the server's "self" path handles it
                    // without requiring host privilege.
                    if (pid === this.myPlayerId) {
                        this.setStartPos({ kind: 'self' }, posIndex);
                    } else {
                        this.setStartPos({ kind: 'player', playerId: pid }, posIndex);
                    }
                } else if (owner.startsWith('ai:')) {
                    const idx = parseInt(owner.substring('ai:'.length));
                    this.setStartPos({ kind: 'ai', slotIndex: idx }, posIndex);
                }
            };
        });
    }

    // ===================== NETWORK =====================

    // ─── Room operations (all HTTP POST) ───

    async createRoom(name: string, mapId: string = '',
                     scenarioId: string | null = null): Promise<void> {
        if (!this.authToken) return;
        // `scenario` is omitted, not sent empty, when the host left the
        // picker on its default — an empty string means "deliberately no
        // scenario" server-side and would suppress the map default
        // (PLAN-endtoend.md D10).
        const body: Record<string, string> = {
            name, map: mapId, game: this.selectedGameId,
        };
        if (scenarioId !== null) body.scenario = scenarioId;
        const data = await this.lobbyPost('/api/rooms', body);
        if (data?.id) {
            this.updateCurrentRoomFromJson(data);
            if (this.currentRoom) this.showRoom();
        }
    }

    async joinRoom(roomId: number, asSpectator: boolean = false): Promise<void> {
        if (!this.authToken) return;
        let data: any = null;
        try {
            data = await this.lobbyPost('/api/rooms/join', { room_id: roomId, as_spectator: asSpectator });
        } catch { /* network / non-JSON error — handled as a failed join below */ }
        if (data?.id) {
            this.updateCurrentRoomFromJson(data);
            if (this.currentRoom) this.showRoom();
            return;
        }
        // Join failed (room deleted/reset, full, or no longer joinable).
        // Self-heal the auto-reconnect: if this was the saved-room rejoin
        // (tryAutoLogin), clear the stale `springrts-game-room` so we don't
        // silently retry a corpse on every page load and strand the player
        // in a dead room. An explicit user-driven join that fails leaves a
        // valid current room's saved id untouched.
        if (roomId === this.pendingRejoinRoomId) {
            this.pendingRejoinRoomId = 0;
            localStorage.removeItem('springrts-game-room');
            console.warn(`[lobby] auto-rejoin of room ${roomId} failed (gone?); cleared stale saved room`);
        }
    }

    async leave(): Promise<void> {
        if (!this.authToken) return;
        await this.lobbyPost('/api/rooms/leave');
        this.currentRoom = null;
        this.showBrowser();
    }

    async ready(ready: boolean): Promise<void> {
        if (!this.authToken) return;
        const data = await this.lobbyPost('/api/rooms/ready', { ready: ready ? 'true' : 'false' });
        if (data?.id) this.updateCurrentRoomFromJson(data);
    }

    async teamSelect(team: number): Promise<void> {
        if (!this.authToken) return;
        const data = await this.lobbyPost('/api/rooms/team', { team });
        if (data?.id) this.updateCurrentRoomFromJson(data);
    }

    /// Spectator → player (PLAN-metalstorm-onboarding.md §4). Auto-assigns
    /// the next open team. Converting before the game starts is the fully
    /// working path — the new roster entry rides the next spawnGameServer
    /// call. Enlisting while watching an already-running game updates the
    /// lobby's roster (so a restart/rejoin picks it up) but does not grant
    /// command rights on the CURRENT session — the running spring-server's
    /// --player roster is fixed at spawn (dynamic mid-game roster growth is
    /// tracked separately, gated behind Stage 7).
    async enlist(): Promise<{ id: number } | null> {
        if (!this.authToken) return null;
        const data = await this.lobbyPost('/api/rooms/enlist', { team: 255 });
        if (data?.id) this.updateCurrentRoomFromJson(data);
        return data?.id ? data : null;
    }

    /// Start the room's game. The server's refusal is the ONLY feedback a
    /// host gets, so it has to reach the screen: this used to discard the
    /// response entirely, which made a refused Start Game completely silent
    /// — the commonest cause being the host's own un-pressed Ready, since
    /// RoomManager::AllReady() counts the host like any other player
    /// (PLAN-endtoend.md D41, found fire 19).
    async startGame(): Promise<void> {
        if (!this.authToken) return;
        const data = await this.lobbyPost('/api/rooms/start');
        const msgEl = document.getElementById('room-msg');
        if (!msgEl) return;
        if (data?.error) {
            msgEl.textContent = data.error;
            msgEl.className = 'msg error';
        } else {
            msgEl.textContent = '';
            msgEl.className = 'msg';
        }
    }

    // endGame() and closeRoom() removed — room lifecycle is handled
    // entirely via leave(). The server handles abandonment, host
    // transfer, and game server cleanup automatically.

    async refreshAIList(): Promise<void> {
        if (!this.currentRoom) return;
        try {
            const ais = await this.lobbyGet(`/api/ai/${this.currentRoom.gameId}`);
            if (Array.isArray(ais)) {
                this.availableAIs = ais.map((ai: any) => ({
                    id: ai.id ?? '', displayName: ai.displayName ?? '',
                    description: ai.description ?? '', isEngineProvided: ai.isEngineProvided ?? false,
                }));
                this.availableAIsForGame = this.currentRoom.gameId;
                if (this.currentScreen === 'room') this.showRoom();
            }
        } catch { /* ignore */ }
    }

    async refreshGameList(): Promise<void> {
        try {
            const games = await this.lobbyGet('/api/games');
            if (Array.isArray(games)) {
                this.availableGames = games.map((g: any) => ({
                    id: g.id ?? '', displayName: g.displayName ?? '',
                    description: g.description ?? '', version: g.version ?? '',
                    lighting: g.lighting ?? 'gameplay',
                }));
                if (!this.selectedGameId && this.availableGames.length > 0) {
                    this.selectedGameId = this.availableGames[0].id;
                }
                if (this.currentScreen === 'browser') this.renderGameOptions();
            }
        } catch { /* ignore */ }
    }

    async addAI(aiId: string, team: number): Promise<void> {
        if (!this.authToken) return;
        const data = await this.lobbyPost('/api/rooms/ai/add', { ai_id: aiId, team });
        if (data?.id) this.updateCurrentRoomFromJson(data);
    }

    async removeAI(slotIndex: number): Promise<void> {
        if (!this.authToken) return;
        const data = await this.lobbyPost('/api/rooms/ai/remove', { slot_index: slotIndex });
        if (data?.id) this.updateCurrentRoomFromJson(data);
    }

    async setAITeam(slotIndex: number, team: number): Promise<void> {
        const data = await this.lobbyPost('/api/rooms/ai/team', { slot_index: slotIndex, team });
        if (data?.id) this.updateCurrentRoomFromJson(data);
    }

    /// Set (or, with '' clear) an AI slot's personality/difficulty profile
    /// (PLAN-metalstorm-ai.md §10 task 6).
    async setAIProfile(slotIndex: number, profile: string): Promise<void> {
        const data = await this.lobbyPost('/api/rooms/ai/profile', { slot_index: slotIndex, profile });
        if (data?.id) this.updateCurrentRoomFromJson(data);
    }

    async setStartPos(
        target: { kind: 'self' } | { kind: 'player'; playerId: number } | { kind: 'ai'; slotIndex: number },
        posIndex: number,
    ): Promise<void> {
        if (!this.authToken) return;
        const body: Record<string, unknown> = { pos: posIndex };
        if (target.kind === 'player') body.target_player_id = target.playerId;
        if (target.kind === 'ai') body.target_ai_slot = target.slotIndex;
        await this.lobbyPost('/api/rooms/startpos', body);
    }

    // ===================== HANDLERS =====================

    private handleRoomList(msg: ServerMessage): void {
        const update = msg.payload(new RoomListUpdate()) as RoomListUpdate;
        this.rooms = [];
        for (let i = 0; i < update.roomsLength(); i++) {
            const r = update.rooms(i);
            if (!r) continue;
            this.rooms.push({
                id: r.roomId(), name: r.name() ?? '', mapId: r.mapId() ?? '',
                playerCount: r.playerCount(), maxPlayers: r.maxPlayers(),
                state: r.state(), hasPassword: r.hasPassword(), hostName: r.hostName() ?? '',
            });
        }

        // If the room we're currently in no longer exists in the
        // list, the host must have closed it. Fall back to the
        // browser. This is how RoomCloseRoom signals the rest of
        // the room's members — we notice our room id is gone,
        // clear the cached state, and land on the browser view.
        // Note: we only do this for clients in the room view;
        // clients already in the browser just see the room
        // disappear from the list (which renderRoomList handles
        // below).
        if (this.currentRoom &&
            !this.rooms.some(r => r.id === this.currentRoom!.id)) {
            console.log(`[lobby] current room ${this.currentRoom.id} no longer exists, returning to browser`);
            this.currentRoom = null;
            localStorage.removeItem('springrts-game-room');
            localStorage.removeItem('springrts-game-port');
            if (this.currentScreen === 'room') {
                this.showBrowser();
                return;
            }
        }

        if (this.currentScreen === 'browser') this.renderRoomList();
    }

    /// Cache the server's AI plugin list. If the host is currently
    /// viewing the room screen, re-render so the "Add AI" dropdown
    /// can populate immediately without a second round-trip. The
    /// list is tagged with the game id it came from so we can
    /// detect cache staleness when the current room's game changes.
    private handleAIList(msg: ServerMessage): void {
        const u = msg.payload(new AIListUpdate()) as AIListUpdate;
        this.availableAIs = [];
        for (let i = 0; i < u.aisLength(); i++) {
            const ai = u.ais(i);
            if (!ai) continue;
            this.availableAIs.push({
                id: ai.aiId() ?? '',
                displayName: ai.displayName() ?? '',
                description: ai.description() ?? '',
                isEngineProvided: ai.isEngineProvided(),
            });
        }
        // Tag the cache with whichever game we're currently in —
        // the server routes AIListRequest by the caller's current
        // room's game, so this list matches room.gameId at the
        // time of the reply.
        this.availableAIsForGame = this.currentRoom?.gameId ?? '';
        if (this.currentScreen === 'room') {
            this.showRoom();
        }
    }

    /// Cache the server's discovered game list. If the browser
    /// screen is currently open, re-render so the create-room
    /// dropdown populates without waiting for the next show.
    private handleGameList(msg: ServerMessage): void {
        const u = msg.payload(new GameListUpdate()) as GameListUpdate;
        this.availableGames = [];
        for (let i = 0; i < u.gamesLength(); i++) {
            const g = u.games(i);
            if (!g) continue;
            this.availableGames.push({
                id: g.id() ?? '',
                displayName: g.displayName() ?? '',
                description: g.description() ?? '',
                version: g.version() ?? '',
                lighting: g.lighting() ?? 'gameplay',
            });
        }
        // Auto-select the first game so a user who immediately
        // clicks "New Game" after login has a valid selection
        // without having to touch the dropdown.
        if (!this.selectedGameId && this.availableGames.length > 0) {
            this.selectedGameId = this.availableGames[0].id;
        }
        if (this.currentScreen === 'browser') {
            this.renderGameOptions();
        }
    }

    private handleRoomState(msg: ServerMessage): void {
        const u = msg.payload(new RoomStateUpdate()) as RoomStateUpdate;
        const players: RoomPlayerInfo[] = [];
        for (let i = 0; i < u.playersLength(); i++) {
            const p = u.players(i);
            if (!p) continue;
            players.push({
                playerId: p.playerId(), username: p.username() ?? '',
                team: p.team(), ready: p.ready(),
                isSpectator: p.isSpectator(), isHost: p.isHost(),
                startPos: p.startPos(),
            });
        }
        const aiSlots: RoomAISlotInfo[] = [];
        for (let i = 0; i < u.aiSlotsLength(); i++) {
            const s = u.aiSlots(i);
            if (!s) continue;
            aiSlots.push({
                aiId: s.aiId() ?? '',
                displayName: s.displayName() ?? '',
                team: s.team(),
                startPos: s.startPos(),
                profile: s.profile() ?? '',
            });
        }
        const newGameId = u.gameId() ?? '';
        // RoomStateUpdate carries no modoptions, so carry the ones we already
        // have for this room forward rather than blanking the room screen's
        // "War:" label every time a player readies up. A different room id
        // means different modoptions, so those start empty until the JSON
        // path (updateCurrentRoomFromJson) fills them in.
        const carriedModOptions =
            this.currentRoom && this.currentRoom.id === u.roomId()
                ? this.currentRoom.modOptions : {};
        this.currentRoom = {
            id: u.roomId(), name: u.name() ?? '', mapId: u.mapId() ?? '',
            gameId: newGameId,
            state: u.state(), players, aiSlots,
            gameServerPort: u.gameServerPort(),
            modOptions: carriedModOptions,
        };

        // The AI list is per-game (each game has its own ai/ folder
        // merged with the engine's), so refresh whenever we enter
        // a room running a different game than the currently cached
        // list, or when we don't have a cached list at all.
        if (this.availableAIsForGame !== newGameId) {
            this.refreshAIList();
        }
        if (newGameId && this.availableScenariosForGame !== newGameId) {
            this.refreshScenarioList(newGameId);
        }

        // Loading (3) or Active (4) → game is running, jump to the
        // game canvas. We do NOT include Ended (5+) in this check —
        // Ended is the post-game state where the subprocess has
        // already exited and there's nothing to connect to. Without
        // the explicit upper bound, quitting a game back to the
        // room and then clicking End Game would trigger the health-
        // check loop to flip the room to Ended, broadcast a new
        // RoomStateUpdate, and this code would auto-fire onGameStart
        // again — dragging the user straight back into the dead
        // game canvas instead of leaving them in the room view.
        const gameRunning = this.currentRoom.state === 3 || this.currentRoom.state === 4;
        if (gameRunning && this.currentRoom.gameServerPort > 0) {
            // Persist game info for reconnection on reload
            localStorage.setItem('springrts-game-room', String(this.currentRoom.id));
            localStorage.setItem('springrts-game-port', String(this.currentRoom.gameServerPort));
            this.hide();
            this.onGameStart?.(this.currentRoom.gameServerPort, this.currentRoom.mapId, this.currentRoom.gameId);
            return;
        }

        // Game ended — clear the saved-game localStorage keys so a
        // page refresh lands on the lobby rather than trying to
        // rejoin a dead subprocess. Stay in the room: a room persists
        // across game sessions so members can adjust settings and
        // launch another game. The host leaving is what destroys the
        // room (if no other humans remain).
        if (this.currentRoom.state >= 5) {
            localStorage.removeItem('springrts-game-room');
            localStorage.removeItem('springrts-game-port');
        }

        this.showRoom();
    }

    // ===================== UTIL =====================

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Replace (or insert) the lobby stylesheet from the active templates.
     * Re-runnable: `setTemplates()` calls this on every hot-swap, so we
     * always remove the previous tag instead of leaving stale rules
     * behind from the engine default.
     */
    private injectStyles(): void {
        const existing = document.getElementById('lobby-styles');
        if (existing) existing.remove();
        const s = document.createElement('style');
        s.id = 'lobby-styles';
        s.textContent = this.templates.styles;
        document.head.appendChild(s);
    }
}
