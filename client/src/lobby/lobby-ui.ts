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
import { formatJoinPreview, type WarJoinPreview } from './join-preview';
import { formatDigest } from './war-digest';
import { noticeFor, parseWarStateEvent } from './war-notice';
import {
    filterWars, fightLabel, formatWarDetail, formatControl, hasRoomForFaction,
    warStateBadge, formatYourWar,
    formatDeploy, WAR_FILTER_LABELS,
    type DeployResult, type WarFilter, type WarInfo, type WarRow,
} from './war-browser';
import {
    friendActions, friendFactionLabel, friendJoinNeedsConfirm, friendStatusLine,
    friendWarRooms,
    formatFriendJoin, formatFriendsHere, pendingRequestCount, sortFriends,
    type FriendJoinResult, type FriendRow,
} from './friends';
import {
    ChatModel, CHAT_STREAM_MAX_ATTEMPTS, CHAT_TICKET_TTL_SEC,
    actionBody, chatTime, hasMention, isActionLine, linkSegments, moderationActive,
    moderationNoticeText, muteRowLine, parseChatInput, pmOther, shouldNotify,
    streamRecovery, tabKey,
    type ChatModerationEvent, type ChatMuteRow,
} from './chat';
import {
    classifyLoginResponse, describeStatus, formatSecret, normaliseCode,
    type TotpStatus,
} from './totp';
import {
    classifyUpgradeResponse, clearDeviceToken, decideBoot, describeUpgradeCost,
    displayGuestName, DEVICE_TOKEN_KEY, storeDeviceToken,
} from './guest';
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
import { decideRoomTransition, type SessionKind } from './room-transition.js';
import { resolveRoomSeat, roomSeatStatus, type RoomSeat } from './room-seat.js';
import { LOGOUT_CLEARED_KEYS, runLogout } from './logout.js';
import {
    ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, browserTokenStore,
    fetchWarReconnectToken, refreshAccessToken, storeTokens,
} from './auth-tokens.js';
import type { AvailableScenarioInfo } from './scenario-picker.js';
import {
    defaultScenarioFor, noWarNote, noWarReason, parseScenarioList,
    resolveScenarioLabel, scenarioNote, scenarioOptionLabel, scenariosForMap,
} from './scenario-picker.js';
import {
    defaultAIId, defaultGameId, gameOptionLabel, gameOptionState,
} from './game-picker.js';
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
    /// 'skirmish' | 'persistent' (task 1). The browser has to tell a war from
    /// a skirmish for every row — a war is the only kind that gets a pre-join
    /// preview, because it is the only kind whose seat is not chosen.
    sessionKind?: string;
    /// The `war` block a persistent-war room carries (§4, task 6): sides,
    /// seat counts, and — when a server is publishing — live populations,
    /// spectators and region control. Absent on every skirmish.
    war?: WarInfo;
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
    /// True when the game is kept on disk but does not run (PLAN-endtoend.md
    /// D26). Drives the disabled option in the create-room picker; the server
    /// enforces the same rule on POST /api/rooms.
    archived: boolean;
    /// One sentence on why, for the disabled option's tooltip.
    archivedReason: string;
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
    /// 'persistent' for a war, 'skirmish' otherwise (task 1's SessionKind, as
    /// the room JSON reports it). Task 8a reads it to decide whether to mint a
    /// per-war reconnect token on entry — a skirmish has nothing to come back
    /// to. Optional because the flatbuffer RoomUpdate does not carry it; that
    /// path carries the last JSON value forward, exactly like `modOptions`.
    sessionKind?: string;
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
    private onGameStart?: (gameServerPort: number, mapId: string, gameId: string, modOptions: Record<string, string>) => void;
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
    /// The war notice on screen (PLAN-persistence task 4d), if any. One at a
    /// time and the newest wins: two wars moving in the same tick is real (a
    /// deploy hibernates every war at once), and a stack of toasts would cover
    /// the war list the player is being told to look at.
    private warNotice: HTMLElement | null = null;
    private warNoticeTimer: ReturnType<typeof setTimeout> | null = null;
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

    /// Q-P3: the room the player has just explicitly asked to (re)join, live
    /// only for the length of that `joinRoom` call. It is what tells
    /// `decideRoomTransition` that a live war it has already been in should be
    /// re-entered — a passive poll mentioning the same war must not, or
    /// quitting a war to the lobby would be undone by the next broadcast.
    private rejoinRequestedRoomId: number | null = null;

    /// 8a-follow-on: no longer a cached string. LobbyUI was a holder of the
    /// access token that task 8a's "six call sites" note did not even count —
    /// one `private authToken` read by ~20 methods for the life of the page.
    /// Every assignment to it already wrote localStorage in the next line or
    /// two, so the field was a *copy* whose only possible divergence was going
    /// stale; at a 1 h TTL it goes stale inside one session. Accessors over
    /// the store, so a renewal in this tab or a peer's is picked up by every
    /// reader with no plumbing.
    ///
    /// Deliberately the RAW stored value, not `getAccessToken` — the lobby's
    /// HTTP surface observes expiry as a 401 and reacts to it (tryAutoLogin),
    /// and that path is better than pre-emptively sending no credential at all.
    private get authToken(): string {
        return browserTokenStore.get(ACCESS_TOKEN_KEY) ?? '';
    }
    private set authToken(v: string) {
        if (v) browserTokenStore.set(ACCESS_TOKEN_KEY, v);
        else browserTokenStore.remove(ACCESS_TOKEN_KEY);
    }
    private roomEventSource: EventSource | null = null;
    /// Per-war pre-join preview for THIS account, keyed by room id (§2.4).
    private warPreviews = new Map<number, WarJoinPreview>();
    /// Which wars the browser is listing (§4). Defaults to the question §4
    /// says a player is actually asking — "wars where my faction is
    /// fighting" — and is remembered for the session, not persisted: it is a
    /// view, and a player who comes back tomorrow is asking it fresh.
    private warFilter: WarFilter = 'my-faction';
    /// The friends list (§8, task 9a), or null on a lobby whose friends routes
    /// do not answer. Null and empty are different states and the panel reads
    /// them differently: null hides the whole feature, `[]` says "no friends
    /// yet" and offers the add box.
    private friends: FriendRow[] | null = null;
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
        onGameStart?: (gameServerPort: number, mapId: string, gameId: string, modOptions: Record<string, string>) => void,
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
        } else {
            // Task 8c: a third boot state — no session, but a guest device
            // token. The ordering is `decideBoot`'s, and it runs one way only
            // (session beats device); see guest.ts for why the reverse breaks
            // every reload after an upgrade.
            const boot = decideBoot(
                savedUser && savedToken ? savedToken : null,
                browserTokenStore.get(DEVICE_TOKEN_KEY));
            if (boot.kind === 'session') this.tryAutoLogin(savedUser!, savedToken!);
            else if (boot.kind === 'resume-guest') void this.resumeGuest(boot.deviceToken);
            else this.showLogin();
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
                    this.adoptSession(token, data);
                    return;
                }
            }
            // Task 8a / §7.2: the access session aged out. Before task 8a this
            // was the end of the account — the player retyped their password,
            // which is exactly what "reconnect over days" is not. A rotating
            // refresh token turns it into a round trip nobody sees.
            //
            // Placed on the 401 path rather than on a timer on purpose: an
            // expiry the client never observes needs no refresh, and a timer
            // would rotate the credential (and burn a family generation) on
            // every idle tab.
            if (resp.status === 401) {
                const outcome = await refreshAccessToken(
                    CONFIG.httpUrl, browserTokenStore);
                if (outcome.kind === 'refreshed') {
                    console.log('[lobby] access session refreshed silently');
                    this.autoLoginAttempts = 0;
                    this.adoptSession(outcome.token, outcome.data);
                    return;
                }
                if (outcome.kind === 'rejected' || outcome.kind === 'none') {
                    // Nothing left to try. Retrying the same dead access token
                    // four more times just delays the login form by 4 s.
                    this.autoLoginAttempts = 0;
                    localStorage.removeItem('springrts-token');
                    this.showLogin();
                    return;
                }
                // 'unreachable' — fall through to the retry ladder below, which
                // is what it is for.
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

    /// Enter the logged-in state with `token`. Shared by the validate path and
    /// the refresh path so the two cannot drift — the refresh arm is the one
    /// nobody exercises by hand, and it is the one that would quietly skip
    /// e.g. the saved-room rejoin.
    private adoptSession(token: string, data: {
        user_id?: number; username?: string; faction?: string;
        refresh_token?: string; expires_in?: number;
    }): void {
        this.authToken = token;
        this.myPlayerId = data.user_id ?? 0;
        this.myFaction = data.faction ?? '';
        console.log(`[lobby] auto-login OK: user=${data.username}`
            + `${this.myFaction ? ` faction=${this.myFaction}` : ''}`);
        // 8a-follow-on: `expires_in` is forwarded, and on THIS path it is the
        // session's remaining life rather than the full TTL (/api/auth/validate
        // reports on a session it did not mint). Without it the renewal timer
        // has nothing to arm against on every visit after the first — which is
        // every visit.
        storeTokens({ token, refresh_token: data.refresh_token,
                      expires_in: data.expires_in },
                    browserTokenStore);

        const savedRoomId = localStorage.getItem('springrts-game-room');
        if (savedRoomId) {
            this.pendingRejoinRoomId = parseInt(savedRoomId);
            this.joinRoom(this.pendingRejoinRoomId);
        }
        this.startPolling();
        this.showBrowser();
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
        // A war MOVED (PLAN-persistence task 4d). The list above carries the
        // state as a datum, which is enough for a badge and not enough for a
        // player who left a war days ago and is waiting for it to come back:
        // the badge flips on a tick nobody is watching. This event is the
        // interruption, and it arrives after the `rooms` event that describes
        // the same war — the lobby orders them that way so the lookup below
        // finds the NEW row.
        es.addEventListener('war-state', (e: MessageEvent) => {
            const ev = parseWarStateEvent(e.data);
            if (!ev) return;
            const notice = noticeFor(ev, this.warRows());
            if (notice) this.renderWarNotice(notice);
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
        // Chat rides the same session: a logged-out browser must not keep a
        // stream open against a ticket the server has just revoked, retrying
        // it every few seconds for the life of the page.
        this.stopChat();
    }

    private applyRoomList(rooms: any[]): void {
        this.rooms = rooms.map((r: any) => ({
            id: r.id, name: r.name ?? '', mapId: r.map ?? '',
            playerCount: r.players?.length ?? 0, maxPlayers: 8,
            state: r.state ?? 0, hasPassword: false,
            hostName: r.players?.find((p: any) => p.is_host)?.username ?? '',
            replayFile: r.replay_file,
            sessionKind: r.session_kind,
            war: r.war,
        }));

        // Pre-join legibility (§2.4, task 5). Refreshed with the list rather
        // than per card: the answer is per-account and changes when anyone
        // else takes a seat, so it cannot ride the (shared) room broadcast,
        // but one call per list tick is cheap where N calls per tick is not.
        // Fire-and-forget — a war row renders without the line if it fails.
        if (this.rooms.some(r => r.sessionKind === 'persistent'))
            void this.refreshWarPreviews();

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

    /// Ask the lobby what joining each war would do to THIS account, and
    /// re-render if we are looking at the browser. Never throws outward: a
    /// preview is an enrichment, and a lobby that cannot answer must still
    /// list its wars.
    private async refreshWarPreviews(): Promise<void> {
        try {
            const rows = await this.lobbyPost('/api/wars/join-preview');
            if (!Array.isArray(rows)) return;
            this.warPreviews.clear();
            for (const p of rows as WarJoinPreview[]) this.warPreviews.set(p.room_id, p);
            if (this.currentScreen === 'browser') this.renderRoomList();
        } catch (e) {
            console.warn('[lobby] war join-preview failed', e);
        }
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
            sessionKind: r.session_kind,
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
            {
                gameStartedForRoomId: this.gameStartedForRoomId, inGame: this.inGame,
                detached: this.detached,
                rejoinRequestedRoomId: this.rejoinRequestedRoomId,
            },
            this.currentRoom.sessionKind as SessionKind | undefined,
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
                // Task 8a / §7.3: mint this account's long-TTL key back into
                // the war it is about to enter, while the access session that
                // authorises the mint is still live. Fire-and-forget and
                // deliberately not awaited — entering the game must not wait
                // on a credential whose whole purpose is the visit AFTER this
                // one. Wars only: a skirmish dies with its lobby, so the route
                // refuses one and there is nothing to cache.
                if (this.currentRoom.sessionKind === 'persistent') {
                    void fetchWarReconnectToken(
                        CONFIG.httpUrl, this.authToken, this.currentRoom.id,
                        browserTokenStore);
                }
                this.onGameStart?.(this.currentRoom.gameServerPort, this.currentRoom.mapId, this.currentRoom.gameId, this.currentRoom.modOptions);
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
        // Task 8c. Optional in the same way every other control here is: a
        // game's template override may ship a login screen without it.
        const guestBtn = document.getElementById('login-guest-btn') as HTMLButtonElement | null;
        if (guestBtn) guestBtn.onclick = () => { void this.signInAsGuest(); };
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
        const totpEl = document.getElementById('login-totp') as HTMLInputElement | null;
        const totpGroup = document.getElementById('login-totp-group');
        const msgEl = document.getElementById('login-msg')!;

        if (!user) { msgEl.textContent = 'Enter a username'; return; }
        if (!pass) { msgEl.textContent = 'Enter a password'; return; }
        if (pass2 && pass !== pass2) { msgEl.textContent = 'Passwords do not match'; return; }
        if (pass2 && !faction) { msgEl.textContent = 'Choose a faction'; return; }

        msgEl.textContent = 'Connecting...';
        msgEl.className = 'msg';

        try {
            // Task 8d: the code rides on the FIRST login attempt when the
            // player has already been challenged, rather than on a second
            // round-trip. The password is re-sent with it because the server
            // authenticates both factors in one call — there is no
            // half-authenticated state on the server, deliberately, since one
            // would be a credential in its own right.
            const code = totpEl ? normaliseCode(totpEl.value) : '';
            let resp = await fetch(`${CONFIG.httpUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(code
                    ? { username: user, password: pass, totp_code: code }
                    : { username: user, password: pass }),
            });

            let data = await resp.json().catch(() => ({}));
            // A two-factor challenge is a failed login that must NOT fall
            // through to registration — see classifyLoginResponse.
            let outcome = classifyLoginResponse(resp, data, pass2 !== '');
            if (outcome.kind === 'totp-required') {
                totpGroup?.classList.remove('hidden');
                totpEl?.focus();
                // The code field is cleared on a rejection so the player is
                // not editing a stale six digits — a code that was refused for
                // being replayed looks identical to one refused for being
                // wrong, and both want a fresh one.
                if (code && totpEl) totpEl.value = '';
                msgEl.textContent = code ? outcome.message
                    : 'Enter the code from your authenticator app';
                msgEl.className = code ? 'msg error' : 'msg';
                return;
            }
            if (outcome.kind === 'register') {
                resp = await fetch(`${CONFIG.httpUrl}/api/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: user, password: pass, faction }),
                });
                data = await resp.json().catch(() => ({}));
                outcome = classifyLoginResponse(resp, data, false);
            }
            if (outcome.kind !== 'ok') {
                msgEl.textContent = outcome.kind === 'failed' ? outcome.message : 'Login failed';
                msgEl.className = 'msg error';
                return;
            }

            this.authToken = data.token;
            this.myPlayerId = data.user_id ?? 0;
            // Both /login and /register echo the account's faction (D40); the
            // register-time value used to be dropped on the floor here.
            this.myFaction = data.faction ?? '';
            localStorage.setItem('springrts-username', user);
            // Task 8a: the access token AND the 30-day rotating refresh token
            // the response now carries. Written through storeTokens so the
            // "never clear what the response omitted" rule lives in one place.
            storeTokens(data, browserTokenStore);
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
            // Task 8a: the refresh token rides along in the body so the server
            // revokes the whole rotation family, not just the session row.
            // Read here rather than inside the closure's `token` because the
            // two are different credentials under different keys.
            revokeToken: () => fetch(`${CONFIG.httpUrl}/api/auth/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    refresh_token: localStorage.getItem(REFRESH_TOKEN_KEY) ?? '',
                }),
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

    /**
     * §7.2's "log out everywhere" verb — the compromise response.
     *
     * Deliberately NOT what the header's Logout button does: one browser
     * signing out must not evict the player's phone from a war they are
     * standing in. This ends every session and every refresh family the
     * account holds, then finishes as an ordinary local logout, because the
     * token this browser is holding is one of the ones it just killed.
     */
    async logoutEverywhere(): Promise<void> {
        const token = this.authToken;
        if (token) {
            try {
                const resp = await fetch(`${CONFIG.httpUrl}/api/auth/logout-all`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: '{}',
                });
                const data = await resp.json().catch(() => ({}));
                console.log('[lobby] logout-all:'
                    + ` sessions=${data.sessions_revoked ?? '?'}`
                    + ` refresh=${data.refresh_revoked ?? '?'}`);
            } catch { /* best effort — the local half still runs */ }
        }
        await this.logout();
    }

    /// Wire the header's logout button. Shared by the browser and room
    /// screens; both ship one, and a game's template override may ship
    /// neither — hence the null check rather than a `!` assertion.
    ///
    /// `logout-all-btn` is optional in exactly the same way and is a separate
    /// control rather than a modifier on the first: the two acts differ in
    /// blast radius, and a shift-click that silently signed the player out of
    /// their other devices is the kind of thing nobody discovers until it has
    /// already happened to them.
    private wireLogoutButton(): void {
        const btn = document.getElementById('logout-btn') as HTMLButtonElement | null;
        if (btn) btn.onclick = () => { void this.logout(); };
        const allBtn = document.getElementById('logout-all-btn') as HTMLButtonElement | null;
        if (allBtn) allBtn.onclick = () => { void this.logoutEverywhere(); };
        this.wireTotpPanel();
        this.wireGuestPanel();
    }

    // ===================== GUEST ACCOUNTS (task 8c) =====================

    /// True while this session belongs to a provisional account. Held so the
    /// browser screen can offer the upgrade — and so it can NOT offer it to
    /// everyone else, for whom it is an invitation to become what they are.
    private isProvisional = false;

    /**
     * Sign in with no account at all. The response is a real session on a real
     * account, so everything downstream — polling, rooms, wars — is the
     * ordinary path from here; the only difference is the device token, which
     * is what makes this account survive closing the tab.
     */
    private async signInAsGuest(): Promise<void> {
        const msgEl = document.getElementById('login-msg');
        if (msgEl) { msgEl.textContent = 'Signing in…'; msgEl.className = 'msg'; }
        try {
            // The faction picker on the login form is the sign-up one, and it
            // is only visible when a confirm-password has been typed. Sent if
            // the player happened to choose — a guest may hold a provisional
            // faction, and one that does can fight rather than only watch.
            const faction = (document.getElementById('login-faction') as HTMLSelectElement | null)?.value ?? '';
            const resp = await fetch(`${CONFIG.httpUrl}/api/auth/guest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(faction ? { faction } : {}),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data?.token) {
                if (msgEl) {
                    msgEl.textContent = data?.error ?? 'Guest sign-in failed';
                    msgEl.className = 'msg error';
                }
                return;
            }
            storeDeviceToken(data, browserTokenStore);
            this.adoptGuestSession(data);
        } catch (err) {
            if (msgEl) {
                msgEl.textContent = `Connection failed: ${err}`;
                msgEl.className = 'msg error';
            }
        }
    }

    /// Come back as the guest this browser already is. Falls back to the login
    /// screen rather than retrying: unlike an access token, a device token
    /// that is refused is not going to start working — it has expired, been
    /// revoked by an upgrade, or the account was swept.
    private async resumeGuest(deviceToken: string): Promise<void> {
        try {
            const resp = await fetch(`${CONFIG.httpUrl}/api/auth/guest/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_token: deviceToken }),
            });
            const data = await resp.json().catch(() => ({}));
            if (resp.ok && data?.token) {
                console.log('[lobby] resumed guest session');
                this.adoptGuestSession(data);
                return;
            }
            clearDeviceToken(browserTokenStore);
        } catch { /* network error — the login screen is still the answer */ }
        this.showLogin();
    }

    /// Shared tail of both guest entry points. Deliberately does NOT go
    /// through `adoptSession`: that one writes `springrts-token` via
    /// storeTokens and looks for a saved room to rejoin, both of which are
    /// right here — but it also assumes a full account, and the provisional
    /// flag has to be set before showBrowser() renders the header.
    private adoptGuestSession(data: {
        token?: string; user_id?: number; username?: string; faction?: string;
        expires_in?: number;
    }): void {
        this.authToken = data.token ?? '';
        this.myPlayerId = data.user_id ?? 0;
        this.myFaction = data.faction ?? '';
        this.isProvisional = true;
        if (data.username) localStorage.setItem('springrts-username', data.username);
        // 8a-follow-on: `data`, not a rebuilt `{token}` — the rebuild dropped
        // `expires_in`, so a guest was the one account kind whose session could
        // never schedule a renewal.
        storeTokens(data, browserTokenStore);
        this.startPolling();
        this.showBrowser();
    }

    /**
     * Wire the "Claim account" panel.
     *
     * The cost line is re-rendered on every faction change rather than only on
     * submit, because the decision it describes is not reversible: switching
     * faction gives up every war seat held on the old side (§1b, inherited by
     * the upgrade), and a player who learns that from the result has already
     * paid it.
     */
    private wireGuestPanel(): void {
        const openBtn = document.getElementById('guest-upgrade-btn') as HTMLButtonElement | null;
        const panel = document.getElementById('guest-panel');
        if (!openBtn || !panel) return;

        // Everyone who is not a guest sees nothing at all.
        openBtn.style.display = this.isProvisional ? 'inline-block' : 'none';
        if (!this.isProvisional) { panel.style.display = 'none'; return; }

        // Logging out of a guest account ends it: the device token is the only
        // credential it has, and a logout has to clear it (see logout.ts). The
        // warning goes on the control rather than into a confirm() dialog, so
        // it is readable before the click rather than after it.
        const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement | null;
        if (logoutBtn) {
            logoutBtn.title = 'Logging out ends this guest account — claim it '
                + 'first to keep your war seats and everything you have earned.';
        }

        // A guest must not be offered 2FA, and the reason is a one-way door
        // rather than tidiness: `totp/disable` costs the PASSWORD as well as a
        // code (task 8d, deliberately — a stolen session must not strip the
        // factor), and a guest has no password. So a guest who enrolled would
        // hold a factor they can never remove — one that meanwhile gates
        // nothing, because their sign-in is `guest/resume`, which presents a
        // device token and never visits /api/auth/login. Offered again the
        // moment the account is claimed, which is when it starts working.
        const totpBtn = document.getElementById('totp-btn') as HTMLButtonElement | null;
        if (totpBtn) totpBtn.style.display = 'none';

        const select = document.getElementById('guest-faction') as HTMLSelectElement | null;
        const costEl = document.getElementById('guest-cost');
        const renderCost = () => {
            if (costEl) costEl.textContent =
                describeUpgradeCost(this.myFaction, select?.value || this.myFaction);
        };

        openBtn.onclick = () => {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            if (panel.style.display !== 'block') return;
            // The picker is filled from the game's declared factions, the same
            // source the sign-up form uses — a guest confirming a faction is
            // making the sign-up choice, just later.
            if (select && select.options.length <= 1) {
                for (const f of this.availableFactions) {
                    const opt = document.createElement('option');
                    opt.value = f.key;
                    opt.textContent = f.fullName || f.name;
                    select.appendChild(opt);
                }
                if (this.availableFactions.length === 0) void this.fetchFactionsForSignup();
            }
            renderCost();
        };
        if (select) select.onchange = renderCost;
        (document.getElementById('guest-close-btn') as HTMLButtonElement | null)
            ?.addEventListener('click', () => { panel.style.display = 'none'; });
        (document.getElementById('guest-confirm-btn') as HTMLButtonElement | null)
            ?.addEventListener('click', () => { void this.upgradeGuest(); });
    }

    private async upgradeGuest(): Promise<void> {
        const msgEl = document.getElementById('guest-msg');
        const username = (document.getElementById('guest-username') as HTMLInputElement | null)?.value.trim() ?? '';
        const password = (document.getElementById('guest-password') as HTMLInputElement | null)?.value ?? '';
        const faction = (document.getElementById('guest-faction') as HTMLSelectElement | null)?.value ?? '';
        const say = (text: string, error = false) => {
            if (msgEl) { msgEl.textContent = text; msgEl.className = error ? 'msg error' : 'msg'; }
        };
        if (!password) { say('Choose a password', true); return; }

        try {
            const body: Record<string, string> = { password };
            if (username) body.username = username;
            // Sent only when the player actually moved the picker. An echo of
            // the current faction is harmless server-side (it compares before
            // deciding) but omitting it keeps "kept" and "re-chosen" the same
            // request, which is what the promise above says they are.
            if (faction && faction !== this.myFaction) body.faction = faction;

            const resp = await fetch(`${CONFIG.httpUrl}/api/auth/upgrade`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });
            const data = await resp.json().catch(() => ({}));
            const outcome = classifyUpgradeResponse(resp, data);
            if (outcome.kind === 'name-in-use') {
                // Not a dead end: the upgrade itself is fine, it is the rename
                // that the live roster blocks — so say what to do instead of
                // what went wrong.
                say(`${outcome.message}. You can claim the account now and `
                    + `choose a name afterwards by clearing the name field.`, true);
                return;
            }
            if (outcome.kind !== 'ok') { say(outcome.message, true); return; }

            this.authToken = outcome.data.token ?? this.authToken;
            this.myFaction = outcome.data.faction ?? this.myFaction;
            this.isProvisional = false;
            if (outcome.data.username)
                localStorage.setItem('springrts-username', outcome.data.username);
            storeTokens(outcome.data, browserTokenStore);
            // The server has already revoked it; this drops the copy that
            // would otherwise sit in a shared browser's localStorage.
            clearDeviceToken(browserTokenStore);
            const lost = outcome.data.cleared_bindings ?? 0;
            console.log(`[lobby] account claimed: user=${outcome.data.username}`
                + ` faction=${this.myFaction} cleared_bindings=${lost}`);
            this.showBrowser();
        } catch (err) {
            say(`Connection failed: ${err}`, true);
        }
    }

    // ===================== TWO-FACTOR (task 8d) =====================

    /**
     * Wire the 2FA panel. Every element is optional in the same way the
     * logout controls are: the browser screen ships the panel, the room
     * screen does not, and a game's template override may ship neither.
     *
     * The panel is re-rendered from `/api/auth/totp/status` after every verb
     * rather than from what the verb returned. A local guess at the new state
     * is how a UI ends up claiming 2FA is on because the request that turned
     * it on came back 200 for some other reason.
     */
    private wireTotpPanel(): void {
        const panel = document.getElementById('totp-panel');
        const openBtn = document.getElementById('totp-btn') as HTMLButtonElement | null;
        if (!panel || !openBtn) return;

        const el = (id: string) => document.getElementById(id);
        const close = document.getElementById('totp-close-btn') as HTMLButtonElement | null;

        openBtn.onclick = () => {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            if (panel.style.display === 'block') void this.refreshTotpStatus();
        };
        if (close) close.onclick = () => { panel.style.display = 'none'; };

        (el('totp-start-btn') as HTMLButtonElement | null)?.addEventListener('click', () => {
            void this.startTotpEnrolment();
        });
        (el('totp-confirm-btn') as HTMLButtonElement | null)?.addEventListener('click', () => {
            void this.confirmTotpEnrolment();
        });
        (el('totp-disable-btn') as HTMLButtonElement | null)?.addEventListener('click', () => {
            const form = el('totp-disable-form');
            if (form) form.style.display = 'flex';
        });
        (el('totp-disable-confirm-btn') as HTMLButtonElement | null)?.addEventListener('click', () => {
            void this.disableTotp();
        });

        // The label carries the state, so an account with 2FA on says so
        // without the panel having to be opened.
        void this.refreshTotpStatus(/*quiet=*/true);
    }

    /// Read the account's 2FA state and render every control from it.
    private async refreshTotpStatus(quiet = false): Promise<void> {
        let status: TotpStatus;
        try {
            status = await this.lobbyPost('/api/auth/totp/status') as TotpStatus;
        } catch { return; }
        if (typeof status?.enabled !== 'boolean') return;

        const btn = document.getElementById('totp-btn');
        if (btn) btn.textContent = status.enabled ? '2FA ✓' : '2FA';
        if (quiet) return;

        const statusEl = document.getElementById('totp-status');
        if (statusEl) statusEl.textContent = describeStatus(status);
        const show = (id: string, on: boolean, mode = 'block') => {
            const e = document.getElementById(id);
            if (e) e.style.display = on ? mode : 'none';
        };
        // "Set up" and "Turn off" are mutually exclusive, and the enrolment
        // block only exists between the two — a panel that offered both at
        // once would let a player start an enrolment they cannot finish (the
        // server refuses one over a live factor, by design).
        show('totp-start-btn', !status.enabled, 'inline-block');
        show('totp-disable-btn', status.enabled, 'inline-block');
        show('totp-enrol', false, 'flex');
        show('totp-disable-form', false, 'flex');
        show('totp-recovery', false);
    }

    private async startTotpEnrolment(): Promise<void> {
        const msg = document.getElementById('totp-msg');
        try {
            const data = await this.lobbyPost('/api/auth/totp/enroll');
            if (!data?.secret) {
                if (msg) { msg.textContent = data?.error ?? 'Could not start set-up'; msg.className = 'msg error'; }
                return;
            }
            const secretEl = document.getElementById('totp-secret');
            if (secretEl) secretEl.textContent = formatSecret(data.secret);
            const uriEl = document.getElementById('totp-uri') as HTMLAnchorElement | null;
            // The href is the otpauth:// URI itself: on a phone that hands the
            // enrolment straight to the authenticator app, and on a desktop it
            // is inert, which is why the secret is shown as text as well.
            if (uriEl) uriEl.href = data.uri ?? '#';
            const enrol = document.getElementById('totp-enrol');
            if (enrol) enrol.style.display = 'flex';
            if (msg) { msg.textContent = ''; msg.className = 'msg'; }
        } catch {
            if (msg) { msg.textContent = 'Could not start set-up'; msg.className = 'msg error'; }
        }
    }

    private async confirmTotpEnrolment(): Promise<void> {
        const msg = document.getElementById('totp-msg');
        const codeEl = document.getElementById('totp-code') as HTMLInputElement | null;
        const code = normaliseCode(codeEl?.value ?? '');
        if (!code) {
            if (msg) { msg.textContent = 'Enter the code from your app'; msg.className = 'msg error'; }
            return;
        }
        try {
            const data = await this.lobbyPost('/api/auth/totp/confirm', { code });
            if (!data?.ok) {
                if (msg) { msg.textContent = data?.error ?? 'That code did not match'; msg.className = 'msg error'; }
                if (codeEl) codeEl.value = '';
                return;
            }
            await this.refreshTotpStatus();
            // Recovery codes are rendered AFTER the status refresh, because
            // that refresh hides the block — and this is the one and only time
            // they exist. Nothing re-fetches them; there is no route that
            // could.
            const list = document.getElementById('totp-recovery-list');
            const wrap = document.getElementById('totp-recovery');
            if (list && wrap && Array.isArray(data.recovery_codes)) {
                list.innerHTML = '';
                for (const c of data.recovery_codes as string[]) {
                    const li = document.createElement('li');
                    li.textContent = c;
                    list.appendChild(li);
                }
                wrap.style.display = 'block';
            }
            if (codeEl) codeEl.value = '';
            if (msg) { msg.textContent = 'Two-factor authentication is on.'; msg.className = 'msg'; }
        } catch {
            if (msg) { msg.textContent = 'Could not turn on two-factor'; msg.className = 'msg error'; }
        }
    }

    private async disableTotp(): Promise<void> {
        const msg = document.getElementById('totp-msg');
        const passEl = document.getElementById('totp-disable-pass') as HTMLInputElement | null;
        const codeEl = document.getElementById('totp-disable-code') as HTMLInputElement | null;
        const password = passEl?.value ?? '';
        const code = normaliseCode(codeEl?.value ?? '');
        if (!password || !code) {
            if (msg) { msg.textContent = 'Password and a current code are both required'; msg.className = 'msg error'; }
            return;
        }
        try {
            const data = await this.lobbyPost('/api/auth/totp/disable', { password, code });
            // Both fields are cleared whatever happened: a password left
            // sitting in a form on a shared machine is the thing this panel is
            // supposed to be defending.
            if (passEl) passEl.value = '';
            if (codeEl) codeEl.value = '';
            if (!data?.ok) {
                if (msg) { msg.textContent = data?.error ?? 'Could not turn off two-factor'; msg.className = 'msg error'; }
                return;
            }
            await this.refreshTotpStatus();
            if (msg) { msg.textContent = 'Two-factor authentication is off.'; msg.className = 'msg'; }
        } catch {
            if (msg) { msg.textContent = 'Could not turn off two-factor'; msg.className = 'msg error'; }
        }
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

    /// The war notice (PLAN-persistence task 4d) — the toast a `war-state`
    /// event becomes when `noticeFor` says it is this player's business.
    ///
    /// Built in the DOM rather than as a template because it is not part of any
    /// screen: it must survive a re-render of the browser (which is what an
    /// arriving `rooms` event does, and one always arrives just before this) and
    /// it must be able to appear over the room screen too. Same reasoning, and
    /// the same shape, as `renderParkedBanner` above.
    private renderWarNotice(n: {
        roomId: number; title: string; detail: string; cls: string; canJoin: boolean;
    }): void {
        this.dismissWarNotice();
        const el = document.createElement('div');
        el.className = `war-notice ${n.cls}`;
        el.id = 'war-notice';
        el.setAttribute('data-room', String(n.roomId));
        const title = document.createElement('div');
        title.className = 'war-notice-title';
        title.textContent = n.title;
        const detail = document.createElement('div');
        detail.className = 'war-notice-detail';
        detail.textContent = n.detail;
        const actions = document.createElement('div');
        actions.className = 'war-notice-actions';
        if (n.canJoin) {
            const join = document.createElement('button');
            join.className = 'join-btn';
            // "Rejoin", not "Join": every notice this button appears on is for
            // a war the account already holds a seat in — `noticeFor` returns
            // nothing for any other war — which is the same reading
            // `fightLabel` gives a returning player's card.
            join.textContent = 'Rejoin';
            join.onclick = () => {
                this.dismissWarNotice();
                this.joinRoom(n.roomId, /*asSpectator=*/false);
            };
            actions.appendChild(join);
        }
        const close = document.createElement('button');
        close.className = 'war-notice-dismiss';
        close.textContent = 'Dismiss';
        close.onclick = () => this.dismissWarNotice();
        actions.appendChild(close);
        el.append(title, detail, actions);
        document.body.appendChild(el);
        this.warNotice = el;
        // Auto-dismissed, but not quickly: this is news about a world the
        // player has been away from for days, and it carries an action. 30 s is
        // long enough to read and act on and short enough that a stale notice
        // is not still on screen when the war moves again.
        this.warNoticeTimer = setTimeout(() => this.dismissWarNotice(), 30000);
    }

    /// Remove the notice, if one is up. Idempotent — called by the dismiss
    /// button, the timer, the join, and by the next notice replacing it.
    private dismissWarNotice(): void {
        if (this.warNoticeTimer !== null) {
            clearTimeout(this.warNoticeTimer);
            this.warNoticeTimer = null;
        }
        this.warNotice?.remove();
        this.warNotice = null;
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
        // Task 8c: a generated guest name is 14 characters of hex nobody can
        // read back, and the header's job is telling the player WHICH account
        // this is. `displayGuestName` shortens it and leaves a claimed name
        // exactly as typed.
        this.container.innerHTML = renderTemplate(this.templates.browser, {
            account_name: this.esc(
                displayGuestName(localStorage.getItem('springrts-username') ?? '')),
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
        this.wireFriendsPanel();
        this.wireDeployButton();
        this.wireChatDock();
    }

    /// Deploy — §6/task 7's one-click "which war should I fight in".
    ///
    /// The server decides; this only carries the answer out. Three of the four
    /// outcomes end somewhere: a war to join, a war to return to, or the Create
    /// Game form — because "every side for your faction is taken" is answered
    /// by seeding a new war, not by a queue (WarDeploy.h). The fourth
    /// (`no_faction`) has nowhere to send anyone and says so.
    private wireDeployButton(): void {
        const btn = document.getElementById('deploy-btn') as HTMLButtonElement | null;
        if (!btn) return;
        btn.onclick = async () => {
            btn.disabled = true;
            const out = document.getElementById('deploy-result');
            try {
                const d = await this.lobbyPost('/api/wars/deploy') as DeployResult;
                if (out) {
                    out.textContent = formatDeploy(d);
                    out.style.display = '';
                }
                if ((d.outcome === 'join' || d.outcome === 'return') && d.room_id) {
                    this.joinRoom(d.room_id, /*asSpectator=*/false);
                } else if (d.outcome === 'seed') {
                    // Opened, not created: a war needs a map and a scenario,
                    // and picking those for somebody is a bigger decision than
                    // picking which existing war they walk into.
                    const form = document.getElementById('create-form');
                    if (form) form.style.display = 'block';
                }
            } catch (e) {
                console.warn('[lobby] deploy failed', e);
                if (out) {
                    out.textContent = 'Deploy failed — pick a war from the list.';
                    out.style.display = '';
                }
            } finally {
                btn.disabled = false;
            }
        };
    }

    // ============== FRIENDS (PLAN-metalstorm-lobby §8, task 9a) ==============
    //
    // The server half answers four routes and this is everything that reads
    // them: the panel, the add box, and the "Friends here" war filter, whose
    // only input is `friendWarRooms(this.friends)`.
    //
    // Polled with the room list rather than streamed. Presence here is derived
    // from three sources with 120–150 s freshness windows (FriendPresence.h),
    // so a per-event push would carry no fact the next poll does not, and the
    // lobby deliberately has no presence heartbeat to hang one on.

    private wireFriendsPanel(): void {
        const btn = document.getElementById('show-friends-btn') as HTMLButtonElement | null;
        const panel = document.getElementById('friends-panel');
        if (!btn || !panel) return;
        btn.onclick = () => {
            const showing = panel.style.display !== 'none';
            panel.style.display = showing ? 'none' : 'block';
            if (!showing) void this.refreshFriends();
        };

        const form = document.getElementById('friend-add-form') as HTMLFormElement | null;
        const input = document.getElementById('friend-add-name') as HTMLInputElement | null;
        if (form && input) {
            form.onsubmit = (e) => {
                e.preventDefault();
                const name = input.value.trim();
                if (!name) return;
                input.value = '';
                void this.friendRequest('/api/friends/add', name);
            };
        }

        // Probed once per browser render, exactly like the replay panel: the
        // button only appears on a lobby that actually has the routes.
        void this.refreshFriends().then(() => {
            if (this.friends === null) return;
            btn.style.display = '';
        });
    }

    /// Fetch the friends list. Leaves `this.friends` null — and the whole
    /// feature invisible — when the route does not answer.
    private async refreshFriends(): Promise<void> {
        try {
            const resp = await this.lobbyPost('/api/friends/list');
            this.friends = Array.isArray(resp) ? resp as FriendRow[] : null;
        } catch {
            this.friends = null;
        }
        this.renderFriendsList();
        // The war browser reads the same list: a friend who just went into a
        // war changes which rows "Friends here" keeps.
        if (this.friends !== null) this.renderWarList();
    }

    /// add / remove, and the two words that are the same two routes: accept is
    /// `add` from the other end, decline and cancel are both `remove`
    /// (Friends.h). One helper, because the panel must not grow a route the
    /// server does not have.
    private async friendRequest(path: string, username: string): Promise<void> {
        const msg = document.getElementById('friend-msg');
        try {
            const r = await this.lobbyPost(path, { username });
            if (msg) {
                // `edge` is what actually happened, which is not always what
                // was asked for: adding somebody who already added you
                // completes the friendship rather than sending a request, and
                // saying "request sent" there would be wrong on the one click
                // the player most wants confirmed.
                const text = r?.error
                    ? String(r.error)
                    : r?.edge === 'mutual'
                        ? `You and ${username} are now friends.`
                        : r?.edge === 'outgoing'
                            ? `Friend request sent to ${username}.`
                            : r?.removed !== undefined
                                ? `${username} removed.`
                                : 'Done.';
                msg.textContent = text;
                msg.className = r?.error ? 'friend-msg friend-msg-error' : 'friend-msg';
                msg.style.display = '';
            }
        } catch {
            if (msg) {
                msg.textContent = 'The lobby did not answer.';
                msg.className = 'friend-msg friend-msg-error';
                msg.style.display = '';
            }
        }
        await this.refreshFriends();
    }

    /// "Take me to where my friend is fighting" (§8).
    ///
    /// Two steps on purpose: `/api/friends/join` ANSWERS — it names the war
    /// and the side — and the ordinary `/api/rooms/join` does the seating, so
    /// this path cannot skip the fork brakes, the resume decision or the audit
    /// row that path owns. The sentence is shown before the join either way,
    /// because on a cross-faction friend the successful click seats the player
    /// OPPOSITE them and that is not something to discover on the map.
    private async joinFriend(username: string): Promise<void> {
        const msg = document.getElementById('friend-msg');
        const r = await this.lobbyPost('/api/friends/join', { username }) as FriendJoinResult;
        if (!r || !r.outcome) {
            if (msg) {
                msg.textContent = `Could not join ${username}.`;
                msg.className = 'friend-msg friend-msg-error';
                msg.style.display = '';
            }
            return;
        }
        const { text, seats } = formatFriendJoin(r);
        const confirm = seats && friendJoinNeedsConfirm(r.outcome);
        if (msg) {
            msg.textContent = text;
            msg.className = confirm
                ? 'friend-msg friend-msg-warn'
                : seats ? 'friend-msg' : 'friend-msg friend-msg-error';
            msg.style.display = '';
        }
        if (!seats || !r.room_id) return;
        if (!confirm) { this.joinRoom(r.room_id, /*asSpectator=*/false); return; }
        // The warning needs somewhere to stand. Seating immediately writes the
        // sentence and replaces it with the room screen in the same tick —
        // verified in the browser, where it was on screen for a frame — so the
        // surprising outcome, and only that one, costs a second click.
        const roomId = r.room_id;
        const go = document.createElement('button');
        go.className = 'friend-confirm-btn';
        go.textContent = `Join anyway — fight against ${r.friend}`;
        go.onclick = () => this.joinRoom(roomId, /*asSpectator=*/false);
        msg?.appendChild(document.createElement('br'));
        msg?.appendChild(go);
    }

    private renderFriendsList(): void {
        const panel = document.getElementById('friends-panel');
        const el = document.getElementById('friends-list');
        const btn = document.getElementById('show-friends-btn');
        if (!panel || !el) return;
        if (this.friends === null) { panel.style.display = 'none'; return; }

        // The pending count rides on the closed button: an incoming request is
        // the only thing here that asks the player a question.
        if (btn) {
            const pending = pendingRequestCount(this.friends);
            btn.textContent = pending > 0 ? `Friends (${pending})` : 'Friends';
            btn.className = pending > 0 ? 'friends-btn-pending' : '';
        }

        if (this.friends.length === 0) {
            el.innerHTML = '<div class="empty-state">No friends yet — add one ' +
                           'by username above.</div>';
            return;
        }

        el.innerHTML = sortFriends(this.friends).map(f => {
            const faction = friendFactionLabel(f);
            const factionHtml = faction
                ? `<span class="friend-faction">${this.esc(faction)}</span>` : '';
            const actions = friendActions(f).map(a =>
                `<button class="friend-action-btn${a.primary ? '' : ' secondary'}" ` +
                `data-action="${a.kind}" data-name="${this.escAttr(f.username)}">` +
                `${this.esc(a.label)}</button>`).join('');
            return `<div class="friend-entry friend-${f.edge}">` +
                   `<div class="friend-main"><span class="friend-name">` +
                   `${this.esc(f.username)}</span>${factionHtml}` +
                   `<span class="friend-presence friend-presence-${f.presence}">` +
                   `${this.esc(friendStatusLine(f))}</span></div>` +
                   `<div class="friend-actions">${actions}</div></div>`;
        }).join('');

        el.querySelectorAll('.friend-action-btn').forEach(b => {
            (b as HTMLElement).onclick = () => {
                const name = b.getAttribute('data-name')!;
                switch (b.getAttribute('data-action')) {
                    case 'accept': void this.friendRequest('/api/friends/add', name); break;
                    // Decline and cancel are the same verb from the two ends:
                    // "there is no edge between us any more".
                    case 'decline':
                    case 'cancel':
                    case 'remove': void this.friendRequest('/api/friends/remove', name); break;
                    case 'join': void this.joinFriend(name); break;
                }
            };
        });
    }

    // ================= CHAT (PLAN-lobby.md §3, task 9b client) ================
    //
    // The service is `rts/Server/Chat.{h,cpp}` plus six `/api/chat/*` routes;
    // every decision that is not a fetch lives in `chat.ts`. Two things about
    // the transport shape the code here:
    //
    //   * The stream is IDENTIFIED, so it needs a credential, and an
    //     `EventSource` cannot send a header — hence the ticket, minted with
    //     the real token and spent in the url (SSETickets.h).
    //   * `onerror` says nothing about WHY, so the recovery policy has to be a
    //     rule rather than a reaction; `streamRecovery` is that rule, and this
    //     file only carries out what it decides.
    //
    // The dock is rendered from `chat.ts`'s model into whichever screen is up
    // — the browser and the room are two views of the same conversation list,
    // which is §3's "one chat service" seen from the client end.

    private chat = new ChatModel();
    private chatStream: EventSource | null = null;
    private chatTicketMintedAt = 0;
    private chatTicketTtlSec = CHAT_TICKET_TTL_SEC;
    private chatErrors = 0;
    private chatRetryTimer: ReturnType<typeof setTimeout> | null = null;
    /// Null until the first mint answers: null hides the dock (a lobby without
    /// the routes must look exactly as it did), false means the routes refused
    /// this account, true means chat is live.
    private chatAvailable: boolean | null = null;
    /// Two notice lines, deliberately not one. The stream's state
    /// (reconnecting, disconnected) is a standing condition and clears itself
    /// when the connection comes back; a refused command ("Unknown command
    /// /whisper", a mute, a 404 on a typo'd name) is a reply to one action and
    /// has to go away on the next one. Sharing a field left a refusal from
    /// four actions ago sitting over a working panel — seen in the browser,
    /// which is the only place it looked wrong.
    private chatStreamNotice = '';
    private chatCmdNotice = '';
    /// The standing account-level mute, from the `moderation` SSE event
    /// (task 9d). A THIRD notice and not a fourth use of the other two: it
    /// outranks both — it is why sending fails — and unlike the stream's it
    /// is about this account rather than this connection, so a reconnect must
    /// not clear it and a command reply must not overwrite it.
    private chatMod: ChatModerationEvent | null = null;
    /// The operator's mute list, shown until dismissed. Null = not asked for.
    private chatMuteList: ChatMuteRow[] | null = null;
    /// §3.5's "optional notification sound" — optional, so it is a toggle, and
    /// remembered, because a player who turns a sound off means it.
    private chatSoundOn = localStorage.getItem('springrts-chat-sound') !== 'off';
    private chatAudio: AudioContext | null = null;

    /// Bring the chat panel up. Idempotent: both screens call it on render and
    /// the stream survives the screen change.
    private wireChatDock(): void {
        const dock = document.getElementById('chat-dock');
        if (!dock) return;
        if (this.chatAvailable === null && !this.chatStream) void this.startChat();
        this.chat.myId = this.myPlayerId;
        this.syncChatRoomTabs();
        this.renderChat();
    }

    /// Mint a ticket and open the stream.
    ///
    /// Order matters and is the opposite of the obvious one: the STREAM opens
    /// before any history is fetched, so a line said while the backfill is in
    /// flight is delivered rather than lost. It arrives twice instead, which
    /// `mergeMessages` is for.
    private async startChat(): Promise<void> {
        let ticket = '';
        try {
            const r = await this.lobbyPost('/api/chat/ticket');
            ticket = typeof r?.ticket === 'string' ? r.ticket : '';
            if (typeof r?.ttl === 'number' && r.ttl > 0) this.chatTicketTtlSec = r.ttl;
        } catch { /* no route, or no lobby */ }
        if (!ticket) {
            this.chatAvailable = false;
            this.renderChat();
            return;
        }
        this.chatAvailable = true;
        this.chatTicketMintedAt = Date.now();
        this.openChatStream(ticket);
        void this.backfillActiveTab();
    }

    private openChatStream(ticket: string): void {
        this.closeChatStream();
        const es = new EventSource(
            `${CONFIG.httpUrl}/api/chat/stream?ticket=${encodeURIComponent(ticket)}`);
        this.chatStream = es;
        es.addEventListener('open', () => {
            // A connection that stands up clears the backoff: the next failure
            // is a new failure, not the sixth of the old one.
            this.chatErrors = 0;
            if (this.chatStreamNotice) { this.chatStreamNotice = ''; this.renderChat(); }
        });
        es.addEventListener('chat', (e: MessageEvent) => {
            let f: any;
            try { f = JSON.parse(e.data); } catch { return; }
            if (!f || typeof f.id !== 'number') return;
            const frame = {
                id: f.id, scope: f.scope, target: String(f.target ?? ''),
                from: String(f.from ?? ''), fromId: Number(f.fromId ?? 0),
                text: String(f.text ?? ''), ts: Number(f.ts ?? 0),
                ...(f.system ? { system: true } : {}),
            };
            // The unread decision is `applyFrame`'s and reads the tab the
            // frame lands in; the ping is decided on the FRAME, before it is
            // filed, because a mention pings in the tab you are reading and
            // that tab never counts an unread.
            const landed = this.chat.applyFrame(frame);
            if (landed) {
                if (shouldNotify(frame, this.myPlayerId, this.myChatName(),
                                 this.chat.activeKey)) this.chatPing();
                this.renderChat();
            }
        });
        // The moderation channel (task 9d). It carries exactly one thing —
        // this account's own account-level mute — because a scoped mute is
        // told to its channel as a system line instead. Both directions
        // arrive: the mute, and the lift, without which an
        // until-lifted banner would stand for the rest of the session.
        es.addEventListener('moderation', (e: MessageEvent) => {
            let ev: any;
            try { ev = JSON.parse(e.data); } catch { return; }
            if (!ev || typeof ev.muted !== 'boolean') return;
            this.chatMod = {
                muted: ev.muted, until: Number(ev.until ?? 0),
                reason: String(ev.reason ?? ''), by: String(ev.by ?? ''),
            };
            this.renderChat();
        });
        es.onerror = () => this.onChatStreamError();
    }

    /// The one place that decides what a dead stream means.
    private onChatStreamError(): void {
        this.chatErrors++;
        const ageSec = (Date.now() - this.chatTicketMintedAt) / 1000;
        const r = streamRecovery(this.chatErrors, ageSec, this.chatTicketTtlSec);
        if (r.notice !== this.chatStreamNotice) { this.chatStreamNotice = r.notice; this.renderChat(); }
        if (r.action === 'wait') return;          // the browser retries on its own
        this.closeChatStream();                    // stop the retry on a dead url
        if (r.action === 'stop') return;           // the player asks for the next one
        if (this.chatRetryTimer) clearTimeout(this.chatRetryTimer);
        this.chatRetryTimer = setTimeout(() => {
            this.chatRetryTimer = null;
            void this.remintAndReopen();
        }, r.delayMs);
    }

    /// Trade the (real, header-borne) token for a fresh ticket and reconnect.
    private async remintAndReopen(): Promise<void> {
        try {
            const r = await this.lobbyPost('/api/chat/ticket');
            if (typeof r?.ticket === 'string' && r.ticket) {
                this.chatTicketMintedAt = Date.now();
                if (typeof r?.ttl === 'number' && r.ttl > 0) this.chatTicketTtlSec = r.ttl;
                this.openChatStream(r.ticket);
                return;
            }
        } catch { /* fall through to the same backoff as a stream failure */ }
        this.onChatStreamError();
    }

    private closeChatStream(): void {
        if (!this.chatStream) return;
        this.chatStream.close();
        this.chatStream = null;
    }

    /// Shut chat down with the rest of the session (logout, or leaving the
    /// lobby for the game surface). The ticket dies server-side with the
    /// account's tokens; this stops the browser retrying against it.
    private stopChat(): void {
        this.closeChatStream();
        if (this.chatRetryTimer) { clearTimeout(this.chatRetryTimer); this.chatRetryTimer = null; }
        this.chatErrors = 0;
        this.chatAvailable = null;
        this.chatStreamNotice = '';
        this.chatCmdNotice = '';
        this.chatMod = null;
        this.chatMuteList = null;
    }

    /// The name a mention has to match. Off the stored session rather than the
    /// roster: chat runs on the browser screen too, where there is no room and
    /// therefore no roster row to read a name out of.
    private myChatName(): string {
        return localStorage.getItem('springrts-username') ?? '';
    }

    /// §3.5's notification sound. Synthesised rather than fetched: the lobby
    /// ships no audio assets and a two-tone blip needs none, so this cannot
    /// 404 or wait on the network. Built lazily because a browser refuses an
    /// `AudioContext` created before the first gesture.
    private chatPing(): void {
        if (!this.chatSoundOn) return;
        try {
            const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
            if (!Ctor) return;
            this.chatAudio ??= new Ctor();
            const ctx = this.chatAudio!;
            if (ctx.state === 'suspended') void ctx.resume();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.setValueAtTime(1174, ctx.currentTime + 0.07);
            // Ramped, not switched: a square-edged gain on a sine is a click.
            gain.gain.setValueAtTime(0.0001, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.2);
        } catch { /* audio is a courtesy; a chat panel that throws over it is not */ }
    }

    /// Room tabs follow the seat, and the seat comes off the roster the room
    /// screen already holds — never off anything the client chooses.
    private syncChatRoomTabs(): void {
        const r = this.currentRoom;
        const me = r?.players.find(p => p.playerId === this.myPlayerId) ?? null;
        const seat = r && me
            ? { roomId: r.id, team: me.team, isSpectator: !!me.isSpectator }
            : null;
        if (this.chat.syncRoomTabs(seat, r?.name ?? '')) void this.backfillActiveTab();
    }

    /// §3.3's "backfills the UI on join". Once per tab: the store is
    /// authoritative and a re-open must not re-page it.
    private async backfillActiveTab(): Promise<void> {
        const tab = this.chat.active();
        if (!tab || tab.loaded || this.chatAvailable !== true) return;
        try {
            const r = await this.lobbyPost('/api/chat/history',
                { scope: tab.scope, target: tab.sendTarget, limit: 50 });
            if (Array.isArray(r?.messages)) {
                this.chat.applyHistory(tab.key, r.messages);
                this.renderChat();
            }
        } catch { /* an empty channel and an unreachable one look the same here */ }
    }

    /// One line typed in the composer.
    private async submitChat(raw: string): Promise<void> {
        // A reply belongs to one action, so the next action takes it away.
        this.chatCmdNotice = '';
        const cmd = parseChatInput(raw, this.chat.active());
        switch (cmd.kind) {
            case 'none':
                return;
            case 'error':
                this.chatCmdNotice = cmd.message;
                this.renderChat();
                return;
            case 'send': {
                const r = await this.lobbyPost('/api/chat/send',
                    { scope: cmd.scope, target: cmd.target, text: cmd.text });
                // The line comes back down the stream — the sender is in its
                // own recipient list — so nothing is appended here. What the
                // reply is for is the refusals: a mute, a flood drop, or a
                // scope this client thinks it is in and the server does not.
                if (r?.error) { this.chatCmdNotice = String(r.error); this.renderChat(); }
                return;
            }
            case 'pm': {
                // Open the tab whatever happens, so a typed name that turns
                // out to be nobody says so in the conversation it was aimed
                // at rather than in the channel the player was reading.
                const r = await this.lobbyPost('/api/chat/send',
                    { scope: 'pm', target: cmd.username, text: cmd.text || ' ' });
                if (r?.error) { this.chatCmdNotice = String(r.error); this.renderChat(); return; }
                // `target` in the reply is CANONICAL (`<lo>:<hi>`); the tab is
                // keyed on it and addressed by the name that was typed.
                const other = pmOther(String(r?.target ?? ''), this.myPlayerId);
                if (other) {
                    const tab = this.chat.ensurePmTab(other, cmd.username);
                    this.chat.setActive(tab.key);
                    void this.backfillActiveTab();
                }
                this.renderChat();
                return;
            }
            case 'ignore': {
                const r = await this.lobbyPost('/api/chat/ignore',
                    { username: cmd.username, on: cmd.on });
                this.chatCmdNotice = r?.error
                    ? String(r.error)
                    : cmd.on ? `Ignoring ${cmd.username}.` : `No longer ignoring ${cmd.username}.`;
                this.renderChat();
                return;
            }
            case 'channel': {
                const r = await this.lobbyPost('/api/chat/channel',
                    { channel: cmd.channel, join: cmd.join });
                if (r?.error) { this.chatCmdNotice = String(r.error); this.renderChat(); return; }
                if (cmd.join) {
                    const tab = this.chat.ensureTab({
                        scope: 'channel', target: cmd.channel, sendTarget: cmd.channel,
                        label: `#${cmd.channel}`, closable: true,
                    });
                    this.chat.setActive(tab.key);
                    void this.backfillActiveTab();
                } else {
                    this.chat.close(tabKey('channel', cmd.channel));
                }
                this.chatCmdNotice = '';
                this.renderChat();
                return;
            }
            // ── The moderation verbs (task 9d) ─────────────────────────────
            //
            // Every one of them reports its REPLY, refusal or not. A
            // moderation action whose only evidence is a system line in the
            // channel looks like it worked to the one person who has to know
            // whether it did — the moderator is not necessarily reading the
            // scope they acted in (`/gmute` is told to nobody at all).
            case 'mute': {
                const body: Record<string, unknown> = {
                    username: cmd.username, on: cmd.on,
                };
                if (cmd.scope) { body.scope = cmd.scope; body.target = cmd.target; }
                if (cmd.on) {
                    body.seconds = cmd.seconds;
                    if (cmd.reason) body.reason = cmd.reason;
                }
                const r = await this.lobbyPost('/api/chat/mute', body);
                const where = cmd.scope ? 'here' : 'everywhere';
                this.chatCmdNotice = r?.error
                    ? String(r.error)
                    : cmd.on
                        ? `Muted ${cmd.username} ${where}` +
                          (cmd.seconds > 0 ? ` for ${cmd.seconds}s.` : ' until lifted.')
                        : `Unmuted ${cmd.username} ${where}.`;
                // The list is stale the moment a mute changes, and a stale
                // list of who is muted is worse than none.
                if (!r?.error && this.chatMuteList) void this.refreshMuteList();
                this.renderChat();
                return;
            }
            case 'kick': {
                const body: Record<string, unknown> = {
                    channel: cmd.channel, username: cmd.username,
                };
                if (cmd.seconds > 0) body.seconds = cmd.seconds;
                if (cmd.reason) body.reason = cmd.reason;
                const r = await this.lobbyPost('/api/chat/kick', body);
                this.chatCmdNotice = r?.error
                    ? String(r.error)
                    : `Kicked ${cmd.username} from #${cmd.channel}.`;
                this.renderChat();
                return;
            }
            case 'broadcast': {
                const r = await this.lobbyPost('/api/chat/broadcast', { text: cmd.text });
                // The line itself arrives down the stream like any other
                // `#main` line, so the reply's job is only the count.
                this.chatCmdNotice = r?.error
                    ? String(r.error)
                    : `Broadcast to ${r?.delivered ?? 0} in #main.`;
                this.renderChat();
                return;
            }
            case 'mutes': {
                await this.refreshMuteList();
                this.renderChat();
                return;
            }
        }
    }

    /// `/api/chat/mute` with no `username` — "who is muted", which the service
    /// answers to admins only (the list names accounts and reasons, which is
    /// moderation record rather than chat).
    private async refreshMuteList(): Promise<void> {
        try {
            const r = await this.lobbyPost('/api/chat/mute', {});
            if (Array.isArray(r)) { this.chatMuteList = r as ChatMuteRow[]; return; }
            this.chatMuteList = null;
            this.chatCmdNotice = String(r?.error ?? 'Could not read the mute list.');
        } catch {
            this.chatMuteList = null;
            this.chatCmdNotice = 'Could not read the mute list.';
        }
    }

    /// One message body, with §3.5's auto-detected links.
    ///
    /// The segmentation runs on the RAW text and each piece is escaped here,
    /// which is the only order that is safe: a linkifier that runs over
    /// already-escaped text sees `&amp;` as five characters and is one
    /// mis-slice away from emitting markup. `rel="noopener noreferrer"` and no
    /// embed of any kind — §3.5 says plain anchors.
    private chatBody(text: string): string {
        return linkSegments(text).map(s => s.href
            ? `<a class="chat-link" href="${this.escAttr(s.href)}" target="_blank" ` +
              `rel="noopener noreferrer">${this.esc(s.text)}</a>`
            : this.esc(s.text)).join('');
    }

    private renderChat(): void {
        const dock = document.getElementById('chat-dock');
        if (!dock) return;
        if (this.chatAvailable !== true) { dock.style.display = 'none'; return; }
        dock.style.display = '';

        const active = this.chat.active();
        const tabs = this.chat.list().map(t => {
            const unread = t.unread > 0 ? `<span class="chat-unread">${t.unread}</span>` : '';
            const close = t.closable
                ? `<span class="chat-tab-close" data-close="${this.escAttr(t.key)}">×</span>` : '';
            return `<button class="chat-tab${t.key === this.chat.activeKey ? ' chat-tab-active' : ''}" ` +
                   `data-tab="${this.escAttr(t.key)}">${this.esc(t.label)}${unread}${close}</button>`;
        }).join('');

        const myName = this.myChatName();
        const lines = (active?.messages ?? []).map(m => {
            const time = `<span class="chat-time">${chatTime(m.ts)}</span>`;
            if (m.system) {
                // A server line has no name and no mention highlight: it is
                // the room talking, and it says everybody's name.
                return `<div class="chat-line chat-line-system">${time}` +
                       `<span class="chat-text">${this.esc(m.text)}</span></div>`;
            }
            // §3.5's mention highlight. Never on my own line — I know I said
            // my name — and computed on the raw text, before linkification
            // splits it.
            const mine = m.fromId === this.myPlayerId;
            const mention = !mine && hasMention(m.text, myName) ? ' chat-line-mention' : '';
            if (isActionLine(m.text)) {
                // No colon, no name-then-text: an action reads as one
                // sentence or it is not an action.
                return `<div class="chat-line chat-line-action${mention}">${time}` +
                       `<span class="chat-text">${this.esc(m.from)} ` +
                       `${this.chatBody(actionBody(m.text))}</span></div>`;
            }
            return `<div class="chat-line${mine ? ' chat-line-mine' : ''}${mention}">${time}` +
                   `<span class="chat-from">${this.esc(m.from)}</span>` +
                   `<span class="chat-text">${this.chatBody(m.text)}</span></div>`;
        }).join('');

        const empty = !active || active.messages.length === 0
            ? `<div class="empty-state">Nothing said here yet. ` +
              `<code>/w player</code>, <code>/join #channel</code>, <code>/me</code>.</div>`
            : '';
        const stopped = this.chatErrors >= CHAT_STREAM_MAX_ATTEMPTS;
        // Three notices, in the order they explain a failure. A standing mute
        // outranks everything — it is *why* sending fails, and it is true of
        // the account rather than of this connection — then the stream's state,
        // then the reply to the last command ("chat is disconnected" explains
        // a refusal that "unknown command" does not).
        const muted = moderationActive(this.chatMod, Date.now() / 1000);
        const modNotice = muted
            ? `<div class="chat-notice chat-notice-mod">` +
              `${this.esc(moderationNoticeText(this.chatMod!))}</div>`
            : '';
        const noticeText = this.chatStreamNotice || this.chatCmdNotice;
        const notice = noticeText
            ? `<div class="chat-notice">${this.esc(noticeText)}` +
              (stopped ? ' <button id="chat-reconnect-btn" class="secondary">Reconnect</button>' : '') +
              `</div>`
            : '';
        const muteList = this.chatMuteList
            ? `<div class="chat-mutes"><div class="chat-mutes-head">` +
              `${this.chatMuteList.length} mute(s) in force` +
              `<button id="chat-mutes-close" class="chat-mutes-close">×</button></div>` +
              (this.chatMuteList.length
                  ? this.chatMuteList.map(m =>
                        `<div class="chat-mutes-row">` +
                        `${this.esc(muteRowLine(m, Date.now() / 1000))}</div>`).join('')
                  : `<div class="chat-mutes-row">Nobody is muted.</div>`) +
              `</div>`
            : '';

        // The sound toggle rides in the head rather than in a settings screen
        // the lobby does not have: §3.5 makes the sound optional, and an
        // option nobody can find is not one.
        const sound = `<button id="chat-sound-btn" class="chat-sound-btn" ` +
                      `title="Notification sound for mentions and PMs">` +
                      `${this.chatSoundOn ? '🔔' : '🔕'}</button>`;

        dock.innerHTML =
            `<div class="chat-head"><h3>Chat</h3><div class="chat-tabs">${tabs}</div>` +
            `${sound}</div>` +
            modNotice + notice + muteList +
            `<div id="chat-log" class="chat-log">${lines}${empty}</div>` +
            `<form id="chat-form" class="chat-compose">` +
            `<input type="text" id="chat-input" class="chat-input" autocomplete="off" ` +
            `maxlength="500" placeholder="Message ${this.escAttr(active?.label ?? '')}">` +
            `<button type="submit" class="chat-send-btn">Send</button></form>`;

        // Newest line at the bottom, and the view pinned to it: a chat panel
        // that opens scrolled to the oldest line looks empty.
        const log = document.getElementById('chat-log');
        if (log) log.scrollTop = log.scrollHeight;

        const form = document.getElementById('chat-form') as HTMLFormElement | null;
        const input = document.getElementById('chat-input') as HTMLInputElement | null;
        if (form && input) {
            form.onsubmit = (e) => {
                e.preventDefault();
                const text = input.value;
                input.value = '';
                void this.submitChat(text);
            };
        }
        dock.querySelectorAll('.chat-tab').forEach(b => {
            (b as HTMLElement).onclick = (e) => {
                const closeKey = (e.target as HTMLElement).getAttribute('data-close');
                if (closeKey) { this.chat.close(closeKey); this.renderChat(); return; }
                this.chat.setActive(b.getAttribute('data-tab')!);
                this.chatCmdNotice = '';
                this.renderChat();
                void this.backfillActiveTab();
            };
        });
        const again = document.getElementById('chat-reconnect-btn');
        if (again) again.onclick = () => {
            this.chatErrors = 0;
            this.chatStreamNotice = '';
            void this.remintAndReopen();
        };
        const soundBtn = document.getElementById('chat-sound-btn');
        if (soundBtn) soundBtn.onclick = () => {
            this.chatSoundOn = !this.chatSoundOn;
            localStorage.setItem('springrts-chat-sound', this.chatSoundOn ? 'on' : 'off');
            // Play the sound the toggle just turned on: a mute button whose
            // effect is only audible the next time somebody else speaks is a
            // control nobody can check.
            if (this.chatSoundOn) this.chatPing();
            this.renderChat();
        };
        const closeMutes = document.getElementById('chat-mutes-close');
        if (closeMutes) closeMutes.onclick = () => {
            this.chatMuteList = null;
            this.renderChat();
        };
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
        // An archived game stays listed and is rendered disabled with its
        // reason (PLAN-endtoend.md D26). Disabled rather than dropped so a
        // player looking for a game they know is in the tree finds it and
        // learns why, instead of doubting the list; and the server refuses
        // it on POST /api/rooms anyway, so the disable is what makes that
        // 400 unreachable rather than silent — the shape D40 settled on for
        // the faction team-select.
        sel.innerHTML = this.availableGames.map(g => {
            const label = this.esc(gameOptionLabel(g));
            const selAttr = g.id === this.selectedGameId ? ' selected' : '';
            const state = gameOptionState(g);
            const disAttr = state.disabled
                ? ` disabled title="${this.esc(state.title)}"` : '';
            return `<option value="${this.esc(g.id)}"${selAttr}${disAttr}>`
                + `${label}</option>`;
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

    /// The war browser (§4, task 6).
    ///
    /// Wars are rendered in their own list, above the rooms, because they
    /// answer a different question: a room browser asks "is there a game?", a
    /// war browser asks "is there room for ME, on my side". The whole section
    /// stays hidden on a lobby with no wars, so a skirmish-only lobby is
    /// untouched by this feature rather than merely unaffected by it.
    /// The war rows, joined to this account's per-war preview.
    ///
    /// Extracted from `renderWarList` (PLAN-persistence task 4d) because the
    /// `war-state` notice needs the same join: whether a transition is worth
    /// telling this player about is decided off `enlisted`, which lives in the
    /// preview and not in the room row. Two spellings of the join would be two
    /// answers to "is this war mine".
    private warRows(): WarRow[] {
        return this.rooms
            .filter(r => r.sessionKind === 'persistent' && r.war && !r.replayFile)
            .map(r => {
                const p = this.warPreviews.get(r.id);
                return {
                    id: r.id, name: r.name, mapId: r.mapId, state: r.state,
                    war: r.war!,
                    returning: p?.returning ?? false,
                    // The durable half of "is this war mine" (task 4c). Left
                    // undefined when the lobby does not publish it, so
                    // `filterWars` falls back to `returning` rather than
                    // reading a defaulted `false` as "not enlisted".
                    enlisted: p?.enlisted,
                    seat: p?.seat,
                    awaySec: p?.away_sec,
                    mySide: p?.side || undefined,
                };
            });
    }

    private renderWarList(): void {
        const section = document.getElementById('war-section');
        const list = document.getElementById('war-list');
        const filters = document.getElementById('war-filters');
        if (!section || !list || !filters) return;

        const wars: WarRow[] = this.warRows();

        if (wars.length === 0) { section.style.display = 'none'; return; }
        section.style.display = '';

        // Deploy needs a faction to deploy: without one the server can only
        // answer `no_faction`, and a button whose only possible reply is "this
        // does nothing for you" is worse than no button (D41's lesson).
        const deployBtn = document.getElementById('deploy-btn');
        if (deployBtn) deployBtn.style.display = this.myFaction ? '' : 'none';

        // The friends chip only exists on a lobby whose friends routes answer.
        // A chip that can only ever be empty advertises a feature this lobby
        // does not have — the same call the Friends button itself makes.
        if (this.friends === null && this.warFilter === 'friends-here')
            this.warFilter = 'my-faction';
        const filterKeys = (Object.keys(WAR_FILTER_LABELS) as WarFilter[])
            .filter(f => f !== 'friends-here' || this.friends !== null);
        filters.innerHTML = filterKeys
            .map(f => `<button class="war-filter-chip${f === this.warFilter ? ' active' : ''}"` +
                      ` data-filter="${f}">${this.esc(WAR_FILTER_LABELS[f])}</button>`)
            .join('');
        filters.querySelectorAll('.war-filter-chip').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                this.warFilter = btn.getAttribute('data-filter') as WarFilter;
                this.renderWarList();
            };
        });

        const friends = this.friends ?? [];
        const friendRooms = friendWarRooms(friends);
        const shown = filterWars(wars, this.warFilter, this.myFaction, friendRooms);
        if (shown.length === 0) {
            // Named per filter: "no wars" and "none for your faction" send a
            // player to two different places, and the second one is the whole
            // reason the default filter exists.
            const why = this.warFilter === 'my-faction'
                ? 'No war is fielding your faction right now.'
                : this.warFilter === 'my-wars'
                    ? 'You hold no seat in any war yet.'
                    : this.warFilter === 'friends-here'
                        // Says which fact is missing: presence, not friendship.
                        // "You have no friends" would be wrong for a player
                        // whose friends are simply not fighting right now.
                        ? 'None of your friends are in a war right now.'
                        : 'No wars are running.';
            list.innerHTML = `<div class="empty-state">${this.esc(why)}</div>`;
            return;
        }

        // One clock read for the whole list, so every "3h ago" on screen is
        // measured from the same instant.
        const nowSec = Math.floor(Date.now() / 1000);
        list.innerHTML = shown.map(row => {
            const preview = this.warPreviews.get(row.id);
            const previewText = preview ? formatJoinPreview(preview) : '';
            const previewHtml = previewText
                ? `<div class="room-preview${preview!.will_fight ? '' : ' room-preview-watch'}">` +
                  `${this.esc(previewText)}</div>`
                : '';
            // The badge is the war's STATE, not the one "is a digest being
            // published" bit (PLAN-persistence task 4): hibernated, crashed
            // and unresumable all used to read "Idle", and they are three
            // different things to walk into.
            // The while-you-were-away digest (PLAN-persistence task 4b). Only
            // a returning player has one — the lobby sends it only for an
            // account that already holds a seat here — so this is empty on
            // every war a player is meeting for the first time, which is the
            // correct reading of "what did I miss".
            const digest = preview
                ? formatDigest(preview.digest, preview.digest_total, row.war.sides, {
                      awaySec: preview.away_sec,
                      myTeam: preview.team,
                  })
                : null;
            const digestHtml = digest
                ? `<div class="war-digest"><span class="war-digest-head">` +
                  `${this.esc(digest.heading)}</span><ul>` +
                  // Above the lines, not below: it counts what was cut off the
                  // FRONT of the story, and a card with a bounded height put
                  // it under the fold when it trailed.
                  (digest.more > 0
                      ? `<li class="war-digest-more">${digest.more} earlier, not shown</li>`
                      : '') +
                  digest.lines.map(l => `<li>${this.esc(l)}</li>`).join('') +
                  `</ul></div>`
                : '';
            // What is MINE in this war (task 4c): my side, how long I have been
            // gone, how much world is frozen waiting. Rendered on every filter,
            // not just "My wars" — a war a player holds a seat in reads the
            // same wherever they find it.
            const yours = formatYourWar(row);
            // A superseded seat is a loss, not a greeting, and must not wear
            // the accent colour the other "your side" lines do — the same call
            // task 4a made for the crashed badge, which deliberately does not
            // share the muted "nothing here" colour with a clean freeze.
            const yoursCls = row.seat === 'superseded'
                ? 'war-yours war-yours-lost' : 'war-yours';
            const yoursHtml = yours
                ? `<div class="${yoursCls}">${this.esc(yours)}</div>` : '';
            // Who of MINE is in this war (task 9a). Rendered in every filter,
            // not only under "Friends here": the filter is a way of finding
            // these rows and the line is the reason they were kept, and a
            // marker that appears only inside its own filter cannot be
            // discovered by anyone who has not already found it.
            const friendsHere = formatFriendsHere(friends, row.id);
            const friendsHtml = friendsHere
                ? `<div class="war-friends">${this.esc(friendsHere)}</div>` : '';
            const badge = warStateBadge(row.war);
            const liveBadge = `<span class="${badge.cls}">${this.esc(badge.label)}</span>`;
            const warStateIsKnown =
                !!row.war.state && row.war.state !== 'not_a_war';
            // The operator's own E1 sentence, hashes and all, one hover away
            // from the player sentence on the card.
            const refusal = row.war.resume_blocked_reason
                ? ` title="${this.escAttr(row.war.resume_blocked_reason)}"`
                : '';
            // Disabled only when this account could not take a seat under any
            // reading — no side for its faction, or no seat left on it. A
            // returning player is never disabled: their seat is held for them
            // and bypasses capacity (task 4), which is exactly the case a
            // naive "is it full" test gets wrong.
            const canFight = row.returning ||
                (!!this.myFaction && hasRoomForFaction(row.war, this.myFaction));
            return renderTemplate(this.templates.browserWarEntry, {
                id: row.id,
                name: this.esc(row.name),
                // The ROOM state is dropped once the WAR state is known: a
                // hibernated war keeps `state = InGame` (the room is what the
                // world was doing when the process left), so the two badges
                // side by side read "In game · Hibernated". The war word is
                // the true one, and two badges that disagree is worse than one.
                state: warStateIsKnown ? '' : (ROOM_STATE_LABELS[row.state] || '?'),
                live_badge: liveBadge,
                detail: this.esc(formatWarDetail(row, nowSec)),
                detail_title: refusal,
                control: this.esc(formatControl(row.war)),
                friends_html: friendsHtml,
                yours_html: yoursHtml,
                preview_html: previewHtml,
                digest_html: digestHtml,
                fight_label: fightLabel(row),
                fight_disabled: canFight ? '' : ' disabled',
            });
        }).join('');

        // Scoped to `.war-actions` rather than given hook classes of their
        // own: the two buttons already ARE the two shapes the room browser
        // uses (`join-btn` / `spectate-btn`), and a class that exists only for
        // a querySelector is a class the stylesheet will never hear about.
        list.querySelectorAll('.war-actions .join-btn:not([disabled])').forEach(btn => {
            (btn as HTMLElement).onclick = () =>
                this.joinRoom(parseInt(btn.getAttribute('data-id')!), /*asSpectator=*/false);
        });
        list.querySelectorAll('.war-actions .spectate-btn').forEach(btn => {
            (btn as HTMLElement).onclick = () =>
                this.joinRoom(parseInt(btn.getAttribute('data-id')!), /*asSpectator=*/true);
        });
    }

    private renderRoomList(): void {
        this.renderWarList();
        const el = document.getElementById('room-list');
        if (!el) return;

        // Wars have their own list above; a war left in this one would offer
        // the plain Join that seats by roster and would say "0/8 players" for
        // a war whose fighters the room row never sees.
        const rooms = this.rooms.filter(
            r => !(r.sessionKind === 'persistent' && r.war && !r.replayFile));

        if (rooms.length === 0) {
            el.innerHTML = this.rooms.length === 0
                ? '<div class="empty-state">No games available — create one!</div>'
                : '';
            return;
        }

        el.innerHTML = rooms.map(r => {
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
            // §2.4: a war's card says what joining it will DO to you — which
            // side your faction puts you on, whether the seat is already
            // yours, and the authority you arrive with. Escaped like every
            // other interpolation here: the sentence is built from server
            // numbers, but the faction key inside it is account data.
            const preview = this.warPreviews.get(r.id);
            const previewText = preview ? formatJoinPreview(preview) : '';
            const previewHtml = previewText
                ? `<div class="room-preview${preview!.will_fight ? '' : ' room-preview-watch'}">` +
                  `${this.esc(previewText)}</div>`
                : '';
            return renderTemplate(this.templates.browserRoomEntry, {
                id: r.id,
                name: this.esc(r.name),
                state: ROOM_STATE_LABELS[r.state] || '?',
                detail,
                preview_html: previewHtml,
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

    /// Q-P3: resolve one room row to a seat. The war half of the question is
    /// answered by this account's join preview, which is the only per-account
    /// seat source the lobby has for a room the game server is seating itself.
    private seatFor(p: RoomPlayerInfo, running: boolean): RoomSeat {
        const r = this.currentRoom;
        const isWar = r?.sessionKind === 'persistent';
        return resolveRoomSeat({
            running,
            isWar,
            mine: p.playerId === this.myPlayerId,
            isSpectatorFlag: p.isSpectator,
            preview: (isWar && r) ? this.warPreviews.get(r.id) : undefined,
        });
    }

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

            // Ready status — same seat source as the full render (Q-P3), or
            // the patch would put the flag's label back on the next poll.
            const statusEl = row.querySelector('.player-status');
            if (statusEl) {
                const running = r.state === 3 || r.state === 4;
                statusEl.textContent =
                    roomSeatStatus(this.seatFor(p, running), p.ready, running);
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
            const seat = this.seatFor(p, gameRunning);
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
                status: roomSeatStatus(seat, p.ready, gameRunning),
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
                // Default to the AI the GAME ships, not option 0.
                // AIDiscovery lists engine AIs first on purpose (a game AI
                // sharing an id has to be able to override one), and a
                // `<select>` with no `selected` takes option 0 — so on
                // Metalstorm the host's Add AI defaulted to "Null AI
                // (engine)", an opponent that issues no commands, in the
                // one click that decides whether the room is a game
                // (PLAN-endtoend.md D26).
                const aiDefaultId = defaultAIId(this.availableAIs);
                const options = this.availableAIs.map(ai => {
                    const label = this.esc(ai.displayName)
                        + (ai.isEngineProvided ? ' (engine)' : '');
                    const selAttr = ai.id === aiDefaultId ? ' selected' : '';
                    return `<option value="${this.esc(ai.id)}"${selAttr}>`
                        + `${label}</option>`;
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
        // Q-P3: read the seat, not the flag. On a running war `is_spectator` is
        // true of every fighter in it, which offered a resumed player **Enlist**
        // and called the one button that worked "Watch Game".
        const mySeat = myPlayer ? this.seatFor(myPlayer, gameRunning) : 'unknown';
        if (preGame && mySeat !== 'spectator') {
            actions.push(`<button id="ready-btn" class="${myPlayer?.ready ? 'secondary' : ''}">${myPlayer?.ready ? 'Unready' : 'Ready'}</button>`);
        }
        if (mySeat === 'spectator') {
            actions.push('<button id="enlist-btn" class="primary">Enlist</button>');
        }
        if (preGame && amHost) {
            actions.push('<button id="start-btn" class="primary">Start Game</button>');
        }
        if (gameRunning) {
            actions.push(`<button id="rejoin-btn" class="primary">${mySeat === 'spectator' ? 'Watch Game' : 'Rejoin Game'}</button>`);
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
        // The room screen hosts the same dock: the room and ally tabs only
        // exist while a seat does, and this is where the seat is known.
        this.wireChatDock();
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
                this.onGameStart?.(this.currentRoom.gameServerPort, this.currentRoom.mapId, this.currentRoom.gameId, this.currentRoom.modOptions);
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
        // Q-P3: every caller of this method is a button — the war notice's
        // Rejoin, a war card's Fight/Rejoin, a room-list Join, the saved-room
        // auto-rejoin at boot. So the request itself is the intent, and it is
        // set before the await because a poll landing mid-flight is welcome to
        // consume it: whichever update arrives first enters the game, and the
        // other one then reads `inGame` and stays put.
        this.rejoinRequestedRoomId = roomId;
        try {
            data = await this.lobbyPost('/api/rooms/join', { room_id: roomId, as_spectator: asSpectator });
        } catch { /* network / non-JSON error — handled as a failed join below */ }
        if (data?.id) {
            this.updateCurrentRoomFromJson(data);
            this.rejoinRequestedRoomId = null;
            if (this.currentRoom) this.showRoom();
            return;
        }
        this.rejoinRequestedRoomId = null;
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
                    archived: !!g.archived,
                    archivedReason: g.archivedReason ?? '',
                }));
                // First PLAYABLE game, not games[0] — the list is
                // alphabetical, so games[0] is `bar` on any tree that still
                // carries the archived ports (PLAN-endtoend.md D26).
                if (!this.selectedGameId && this.availableGames.length > 0) {
                    this.selectedGameId =
                        defaultGameId(this.availableGames) ?? '';
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
                // Same field the HTTP path reads. Nothing currently sends
                // GameListUpdate — the live list comes from
                // `GET /api/games` — but an ingestion path that cannot see
                // `archived` would show an archived game as playable the
                // moment anything did send it (PLAN-endtoend.md D26/D59).
                archived: g.archived(),
                archivedReason: g.archivedReason() ?? '',
            });
        }
        // Auto-select the first PLAYABLE game so a user who immediately
        // clicks "New Game" after login has a valid selection without
        // having to touch the dropdown — "valid" meaning one the create
        // route will accept (PLAN-endtoend.md D26).
        if (!this.selectedGameId && this.availableGames.length > 0) {
            this.selectedGameId = defaultGameId(this.availableGames) ?? '';
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
        const sameRoom =
            this.currentRoom !== null && this.currentRoom.id === u.roomId();
        const carriedModOptions = sameRoom ? this.currentRoom!.modOptions : {};
        // Carried for the same reason as the modoptions above: the flatbuffer
        // RoomUpdate has no session-kind field, and dropping it here would
        // make every war look like a skirmish the moment a binary update
        // arrived — which is most of them.
        const carriedSessionKind = sameRoom ? this.currentRoom!.sessionKind : undefined;
        this.currentRoom = {
            id: u.roomId(), name: u.name() ?? '', mapId: u.mapId() ?? '',
            gameId: newGameId,
            state: u.state(), players, aiSlots,
            gameServerPort: u.gameServerPort(),
            modOptions: carriedModOptions,
            sessionKind: carriedSessionKind,
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
            this.onGameStart?.(this.currentRoom.gameServerPort, this.currentRoom.mapId, this.currentRoom.gameId, this.currentRoom.modOptions);
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

    /// `esc` for a value going inside a quoted ATTRIBUTE. `esc` alone leaves
    /// quotes standing, which is safe between tags and is not safe here — a
    /// value carrying `"` would close the attribute. Server-authored strings
    /// (an E1 refusal names a map id) reach attributes now, so the two cases
    /// get two functions rather than one that is right most of the time.
    private escAttr(s: string): string {
        return this.esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
