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
    getDefaultLobbyTemplates,
    type LobbyTemplates,
} from '../ui/lobby/loader.js';

const ROOM_STATE_LABELS = ['Setup', 'Waiting', 'Ready Check', 'Loading', 'In Progress', 'Ended'];

export type LobbyScreen = 'login' | 'browser' | 'room' | 'game';

interface RoomInfo {
    id: number; name: string; mapId: string;
    playerCount: number; maxPlayers: number;
    state: number; hasPassword: boolean; hostName: string;
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
interface AvailableGameInfo {
    id: string;
    displayName: string;
    description: string;
    version: string;
}

interface CurrentRoom {
    id: number; name: string; mapId: string; gameId: string;
    state: number; players: RoomPlayerInfo[];
    aiSlots: RoomAISlotInfo[];
    gameServerPort: number;
}

export class LobbyUI {
    private container: HTMLDivElement;
    private connection: Connection | null = null;
    private currentScreen: LobbyScreen = 'login';
    private rooms: RoomInfo[] = [];
    private currentRoom: CurrentRoom | null = null;
    private onGameStart?: (gameServerPort: number, mapId: string, gameId: string) => void;
    private myPlayerId = 0;
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

    // ─── Public read-only accessors for debugging / automation ───

    get room(): CurrentRoom | null { return this.currentRoom; }
    get screen(): LobbyScreen { return this.currentScreen; }
    get token(): string { return this.authToken; }
    get playerId(): number { return this.myPlayerId; }
    get roomList(): RoomInfo[] { return this.rooms; }
    get maps(): typeof this.availableMaps { return this.availableMaps; }
    get games(): AvailableGameInfo[] { return this.availableGames; }
    get ais(): AvailableAIInfo[] { return this.availableAIs; }

    constructor(
        onGameStart?: (gameServerPort: number, mapId: string, gameId: string) => void,
        templates?: LobbyTemplates,
    ) {
        this.onGameStart = onGameStart;
        this.templates = templates ?? getDefaultLobbyTemplates();
        this.container = document.getElementById('lobby') as HTMLDivElement;
        this.injectStyles();

        // Try auto-login with saved session
        const savedUser = localStorage.getItem('springrts-username');
        const savedToken = localStorage.getItem('springrts-token');
        console.log(`[lobby] init: savedUser=${savedUser ?? 'null'} savedToken=${savedToken ? savedToken.substring(0,8) + '...' : 'null'}`);
        if (savedUser && savedToken) {
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
        if (this.currentScreen === 'login') this.showLogin();
        else if (this.currentScreen === 'browser') this.showBrowser();
        else if (this.currentScreen === 'room') this.showRoom();
    }

    private autoLoginAttempts = 0;

    private async tryAutoLogin(username: string, token: string): Promise<void> {
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
                    console.log(`[lobby] auto-login OK: user=${data.username}`);
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

    /// Create a Connection for the game server (WebRTC). Only used
    /// when a game starts — not for lobby operations.
    createGameConnection(): Connection {
        return new Connection({
            onEntityState: () => {},
            onCombatEvents: () => {},
            onEntityDestroy: () => {},
        });
    }
    show(): void { this.container.style.display = 'flex'; }
    hide(): void { this.container.style.display = 'none'; }

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
        }));

        // Check if our current room still exists
        if (this.currentRoom) {
            const myRoom = rooms.find((r: any) => r.id === this.currentRoom!.id);
            if (!myRoom) {
                console.log(`[lobby] current room ${this.currentRoom.id} no longer exists`);
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
            isSpectator: false, isHost: p.is_host ?? false,
            startPos: p.start_pos ?? -1,
        }));
        const aiSlots: RoomAISlotInfo[] = (r.ai_slots ?? []).map((s: any) => ({
            aiId: s.ai_id ?? '', displayName: s.name ?? s.ai_id ?? '',
            team: s.team ?? 0, startPos: s.start_pos ?? -1,
        }));
        const newGameId = r.game ?? '';
        this.currentRoom = {
            id: r.id, name: r.name ?? '', mapId: r.map ?? '',
            gameId: newGameId,
            state: r.state ?? 0, players, aiSlots,
            gameServerPort: r.game_server_port ?? 0,
        };

        // Refresh AI list when entering a room with a different game
        if (this.availableAIsForGame !== newGameId) {
            this.refreshAIList();
        }

        const gameRunning = this.currentRoom.state === 3 || this.currentRoom.state === 4;
        if (gameRunning && this.currentRoom.gameServerPort > 0) {
            localStorage.setItem('springrts-game-room', String(this.currentRoom.id));
            localStorage.setItem('springrts-game-port', String(this.currentRoom.gameServerPort));
            this.stopPolling();
            this.hide();
            this.onGameStart?.(this.currentRoom.gameServerPort, this.currentRoom.mapId, this.currentRoom.gameId);
            return;
        }
        if (this.currentRoom.state >= 5) {
            localStorage.removeItem('springrts-game-room');
            localStorage.removeItem('springrts-game-port');
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
        this.container.style.display = 'flex';
        this.container.innerHTML = this.templates.login;
        document.getElementById('login-form')!.onsubmit = (e) => {
            e.preventDefault();
            this.doLogin();
        };
    }

    private async doLogin(): Promise<void> {
        const user = (document.getElementById('login-user') as HTMLInputElement).value.trim();
        const pass = (document.getElementById('login-pass') as HTMLInputElement).value;
        const pass2 = (document.getElementById('login-pass2') as HTMLInputElement).value;
        const msgEl = document.getElementById('login-msg')!;

        if (!user) { msgEl.textContent = 'Enter a username'; return; }
        if (!pass) { msgEl.textContent = 'Enter a password'; return; }
        if (pass2 && pass !== pass2) { msgEl.textContent = 'Passwords do not match'; return; }

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
                    body: JSON.stringify({ username: user, password: pass }),
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
            localStorage.setItem('springrts-username', user);
            localStorage.setItem('springrts-token', data.token);
            console.log(`[lobby] login OK: user=${user} id=${this.myPlayerId}`);
            this.startPolling();
            this.showBrowser();
        } catch (err) {
            msgEl.textContent = `Connection failed: ${err}`;
            msgEl.className = 'msg error';
        }
    }

    /// Land on the most appropriate lobby screen after the game canvas
    /// is hidden (e.g. after the user clicks Quit mid-game). If the
    /// player is still a member of a room, show the room view;
    /// otherwise show the room browser.
    showAfterGame(): void {
        if (this.currentRoom) {
            this.showRoom();
        } else {
            this.showBrowser();
        }
    }

    showBrowser(): void {
        this.currentScreen = 'browser';
        this.currentRoom = null;

        // Fetch available maps
        fetch(stampUrl(`${CONFIG.httpUrl}/api/maps`)).then(r => r.ok ? r.json() : []).then(maps => {
            this.availableMaps = maps;
            this.renderMapOptions();
        }).catch(() => {});

        // Fetch the game list if we haven't already. Immutable for
        // the lobby's lifetime, so a single request per session is
        // enough — handleGameList() re-renders the dropdown when
        // the response arrives.
        if (this.availableGames.length === 0) {
            this.refreshGameList();
        }

        this.container.innerHTML = this.templates.browser;
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
            this.createRoom(name, mapId);
        };

        // Populate the game dropdown if the list has already arrived.
        // The template owns the <select id="game-select"> element —
        // we just fill it with <option> children and attach a change
        // handler that updates `selectedGameId`.
        this.renderGameOptions();
        this.renderRoomList();
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
        };
    }

    private selectedMapId = '';

    private renderMapOptions(): void {
        const el = document.getElementById('map-selector');
        if (!el) return;

        if (this.availableMaps.length === 0) {
            el.innerHTML = '<div class="empty-state">No maps found in content/maps/</div>';
            return;
        }

        el.innerHTML = this.availableMaps.map(m => {
            const sizeKm = ((m.widthElmos / 1000) * (m.heightElmos / 1000)).toFixed(1);
            return renderTemplate(this.templates.browserMapCard, {
                id: this.esc(m.id),
                name: this.esc(m.name),
                thumb_url: stampUrl(`${CONFIG.httpUrl}/api/maps/thumb/${encodeURIComponent(m.id)}`),
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
            };
        });
    }

    private renderRoomList(): void {
        const el = document.getElementById('room-list');
        if (!el) return;

        if (this.rooms.length === 0) {
            el.innerHTML = '<div class="empty-state">No games available — create one!</div>';
            return;
        }

        el.innerHTML = this.rooms.map(r => {
            const detail =
                `${r.mapId ? this.esc(r.mapId) : '<em>No map</em>'} · ` +
                `${r.playerCount}/${r.maxPlayers} players · ` +
                `Host: ${this.esc(r.hostName)}`;
            const joinLabel = r.state >= 5 ? 'Ended'
                : (r.state >= 3 ? 'Watch / Rejoin' : 'Join');
            return renderTemplate(this.templates.browserRoomEntry, {
                id: r.id,
                name: this.esc(r.name),
                state: ROOM_STATE_LABELS[r.state] || '?',
                detail,
                join_label: joinLabel,
                disabled_attr: r.state >= 5 ? ' disabled' : '',
            });
        }).join('');

        el.querySelectorAll('.join-btn:not([disabled])').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                this.joinRoom(parseInt(btn.getAttribute('data-id')!));
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
        });

        return true;
    }

    private showRoom(): void {
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
            return `<select class="startpos-select" data-owner="${this.esc(ownerKey)}"${disabledAttr}>`
                + options.join('')
                + `</select>`;
        };

        // Pre-render each player row through the template so games
        // can restyle the row layout. The `{{startpos_html}}`
        // placeholder receives the start-pos select (possibly
        // empty if the map ships no positions).
        const playersHtml = r.players.map(p => {
            const canEdit = preGame && (p.playerId === this.myPlayerId || amHost);
            const posSel = renderStartPosSelect(
                p.startPos, `player:${p.playerId}`, canEdit);
            return renderTemplate(this.templates.roomPlayerRow, {
                pid: p.playerId,
                name: this.esc(p.username),
                host_icon: p.isHost ? '★' : '●',
                ready_class: p.ready ? 'ready' : '',
                select_disabled: p.playerId !== this.myPlayerId ? ' disabled' : '',
                team0_selected: p.team === 0 ? ' selected' : '',
                team1_selected: p.team === 1 ? ' selected' : '',
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
            // Team dropdown mirrors the player-row layout: a two-option
            // select tagged with data-slot so the change handler below
            // can resolve it back to the slot index without replaying
            // the whole roster. Disabled for non-hosts and while a
            // game is running.
            const teamDisabled = canEdit ? '' : ' disabled';
            const teamSel =
                `<select class="ai-team-select" data-slot="${idx}"${teamDisabled}>`
                + `<option value="0"${slot.team === 0 ? ' selected' : ''}>Team 1</option>`
                + `<option value="1"${slot.team === 1 ? ' selected' : ''}>Team 2</option>`
                + `</select>`;
            return `<div class="player-row ai-row"><span class="player-icon">🤖</span>`
                + `<span class="player-name">${nameText}</span>`
                + teamSel
                + posSel
                + `<span class="player-status">AI</span>`
                + removeBtn
                + `</div>`;
        }).join('');

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
                addAIHtml =
                    `<div class="ai-add-row">`
                    + `<select id="ai-add-select" class="team-select">${options}</select>`
                    + `<select id="ai-add-team" class="team-select">`
                    + `<option value="0">Team 1</option>`
                    + `<option value="1">Team 2</option>`
                    + `</select>`
                    + `<button id="ai-add-btn" class="primary">Add AI</button>`
                    + `</div>`;
            }
        }

        // Action buttons depend on room state + whether the viewer is
        // the host. We compose a small HTML fragment in JS rather than
        // adding more conditional placeholders to the template.
        const actions: string[] = [];
        if (preGame) {
            actions.push(`<button id="ready-btn" class="${myPlayer?.ready ? 'secondary' : ''}">${myPlayer?.ready ? 'Unready' : 'Ready'}</button>`);
        }
        if (preGame && amHost) {
            actions.push('<button id="start-btn" class="primary">Start Game</button>');
        }
        if (gameRunning) {
            actions.push('<button id="rejoin-btn" class="primary">Rejoin Game</button>');
        }
        // No "End Game" or "Close Room" buttons. Room lifecycle is
        // handled via Leave: last human out kills the game and room.

        this.container.innerHTML = renderTemplate(this.templates.room, {
            name: this.esc(r.name),
            state: ROOM_STATE_LABELS[r.state] || '?',
            players_html: playersHtml + aiRowsHtml + addAIHtml,
            actions_html: actions.join(''),
        });

        document.getElementById('leave-btn')!.onclick = () => this.leave();
        document.getElementById('ready-btn')?.addEventListener('click',
            () => this.ready(!myPlayer?.ready));
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

    async createRoom(name: string, mapId: string = ''): Promise<void> {
        if (!this.authToken) return;
        const data = await this.lobbyPost('/api/rooms', {
            name, map: mapId, game: this.selectedGameId,
        });
        if (data?.id) {
            this.updateCurrentRoomFromJson(data);
            if (this.currentRoom) this.showRoom();
        }
    }

    async joinRoom(roomId: number): Promise<void> {
        if (!this.authToken) return;
        const data = await this.lobbyPost('/api/rooms/join', { room_id: roomId });
        if (data?.id) {
            this.updateCurrentRoomFromJson(data);
            if (this.currentRoom) this.showRoom();
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

    async startGame(): Promise<void> {
        if (!this.authToken) return;
        await this.lobbyPost('/api/rooms/start');
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
                id: r.roomId(), name: r.name() ?? '', mapId: r.mapName() ?? '',
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
            });
        }
        const newGameId = u.gameId() ?? '';
        this.currentRoom = {
            id: u.roomId(), name: u.name() ?? '', mapId: u.mapName() ?? '',
            gameId: newGameId,
            state: u.state(), players, aiSlots,
            gameServerPort: u.gameServerPort(),
        };

        // The AI list is per-game (each game has its own ai/ folder
        // merged with the engine's), so refresh whenever we enter
        // a room running a different game than the currently cached
        // list, or when we don't have a cached list at all.
        if (this.availableAIsForGame !== newGameId) {
            this.refreshAIList();
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
