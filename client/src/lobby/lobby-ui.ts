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
import { CONFIG } from '../config.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { RoomCreate } from '../protocol/spring-web/room-create.js';
import { RoomJoin } from '../protocol/spring-web/room-join.js';
import { RoomReady } from '../protocol/spring-web/room-ready.js';
import { RoomTeamSelect } from '../protocol/spring-web/room-team-select.js';
import { RoomStartGame } from '../protocol/spring-web/room-start-game.js';
import { RoomEndGame } from '../protocol/spring-web/room-end-game.js';
import { RoomLeave } from '../protocol/spring-web/room-leave.js';
import { RoomAddAI } from '../protocol/spring-web/room-add-ai.js';
import { RoomRemoveAI } from '../protocol/spring-web/room-remove-ai.js';
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
    id: number; name: string; mapName: string;
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
/// browser screen. The `id` is what RoomCreate.game_name carries.
interface AvailableGameInfo {
    id: string;
    displayName: string;
    description: string;
    version: string;
}

interface CurrentRoom {
    id: number; name: string; mapName: string; gameName: string;
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
    private onGameStart?: (gameServerPort: number) => void;
    private myPlayerId = 0;
    private pendingRejoinRoomId = 0;
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
    /// arrives. Passed to RoomCreate.game_name on create.
    private selectedGameId: string = '';

    constructor(
        onGameStart?: (gameServerPort: number) => void,
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

    private tryAutoLogin(username: string, token: string): void {
        this.container.style.display = 'flex';
        this.container.innerHTML = renderTemplate(this.templates.reconnecting, {
            attempt_suffix: this.autoLoginAttempts > 0
                ? ` (attempt ${this.autoLoginAttempts + 1})`
                : '',
        });

        const savedRoomId = localStorage.getItem('springrts-game-room');
        const savedPort = localStorage.getItem('springrts-game-port');

        this.connection = this.createConnection(
            (msg: string) => {
                this.autoLoginAttempts++;
                if (this.autoLoginAttempts < 5) {
                    // Retry — server might still be starting
                    console.log(`[lobby] auto-login attempt ${this.autoLoginAttempts} failed: ${msg}, retrying...`);
                    setTimeout(() => this.tryAutoLogin(username, token), 1000);
                } else {
                    console.log('[lobby] auto-login failed after retries:', msg);
                    this.autoLoginAttempts = 0;
                    localStorage.removeItem('springrts-token');
                    localStorage.removeItem('springrts-game-room');
                    localStorage.removeItem('springrts-game-port');
                    this.showLogin();
                }
            },
        );

        this.pendingRejoinRoomId = savedRoomId ? parseInt(savedRoomId) : 0;
        this.connection.connect(CONFIG.wsUrl, username, '', token);
    }

    getConnection(): Connection | null { return this.connection; }

    private createConnection(onError: (msg: string) => void): Connection {
        return new Connection({
            onStateChange: (state: ConnectionState) => {
                if (state === 'disconnected') onError('Disconnected from server');
            },
            onAuthenticated: (playerId: number, token: string) => {
                this.myPlayerId = playerId;
                console.log(`[lobby] AUTH OK: playerId=${playerId} token=${token?.substring(0,8)}... saving to localStorage`);
                localStorage.setItem('springrts-token', token);

                // If we have a saved game to rejoin, try it
                if (this.pendingRejoinRoomId > 0) {
                    const roomId = this.pendingRejoinRoomId;
                    this.pendingRejoinRoomId = 0;
                    console.log(`[lobby] rejoining room ${roomId}`);
                    this.sendJoinRoom(roomId);
                    // handleRoomState will fire onGameStart if the room is active.
                    // If not, fall back to browser after a delay.
                    setTimeout(() => {
                        if (!this.currentRoom || this.currentRoom.state < 3) {
                            console.log('[lobby] saved game no longer active');
                            localStorage.removeItem('springrts-game-room');
                            localStorage.removeItem('springrts-game-port');
                            this.showBrowser();
                        }
                    }, 2000);
                    return;
                }

                this.showBrowser();
            },
            onAuthFailed: (message: string) => {
                localStorage.removeItem('springrts-token');
                onError(message);
            },
            onServerError: (_code: number, message: string) => onError(message),
            onServerMessage: (msg: ServerMessage) => this.handleServerMessage(msg),
            onEntityState: () => {},
            onCombatEvents: () => {},
            onEntityDestroy: () => {},
        });
    }
    show(): void { this.container.style.display = 'flex'; }
    hide(): void { this.container.style.display = 'none'; }

    handleServerMessage(msg: ServerMessage): void {
        switch (msg.payloadType()) {
            case ServerPayload.RoomListUpdate:
                this.handleRoomList(msg);
                break;
            case ServerPayload.RoomStateUpdate:
                this.handleRoomState(msg);
                break;
            case ServerPayload.AIListUpdate:
                this.handleAIList(msg);
                break;
            case ServerPayload.GameListUpdate:
                this.handleGameList(msg);
                break;
        }
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

    private doLogin(): void {
        const user = (document.getElementById('login-user') as HTMLInputElement).value.trim();
        const pass = (document.getElementById('login-pass') as HTMLInputElement).value;
        const pass2 = (document.getElementById('login-pass2') as HTMLInputElement).value;
        const msgEl = document.getElementById('login-msg')!;

        if (!user) { msgEl.textContent = 'Enter a username'; return; }
        if (!pass) { msgEl.textContent = 'Enter a password'; return; }
        if (pass2 && pass !== pass2) { msgEl.textContent = 'Passwords do not match'; return; }

        msgEl.textContent = 'Connecting...';
        msgEl.className = 'msg';

        localStorage.setItem('springrts-username', user);
        this.connection = this.createConnection(
            (msg: string) => { msgEl.textContent = msg; msgEl.className = 'msg error'; },
        );
        this.connection.connect(CONFIG.wsUrl, user, pass);
    }

    /// Land on the most appropriate lobby screen after the game canvas
    /// is hidden (e.g. after the user clicks Quit mid-game). If the
    /// player is still a member of a room, show the room view so the
    /// host still has access to the End Game button — otherwise show
    /// the room browser.
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
        fetch(`${CONFIG.httpUrl}/api/maps`).then(r => r.ok ? r.json() : []).then(maps => {
            this.availableMaps = maps;
            this.renderMapOptions();
        }).catch(() => {});

        // Fetch the game list if we haven't already. Immutable for
        // the lobby's lifetime, so a single request per session is
        // enough — handleGameList() re-renders the dropdown when
        // the response arrives.
        if (this.availableGames.length === 0) {
            this.sendGameListRequest();
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
            this.sendCreateRoom(name, mapId);
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
                thumb_url: `${CONFIG.httpUrl}/api/maps/thumb/${encodeURIComponent(m.id)}`,
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
                `${r.mapName ? this.esc(r.mapName) : '<em>No map</em>'} · ` +
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
                this.sendJoinRoom(parseInt(btn.getAttribute('data-id')!));
            };
        });
    }

    // ===================== ROOM =====================

    private showRoom(): void {
        if (!this.currentRoom) return;
        this.currentScreen = 'room';
        const r = this.currentRoom;
        const myPlayer = r.players.find(p => p.playerId === this.myPlayerId);
        const amHost = myPlayer?.isHost ?? false;
        // Room is considered "running" once the host has clicked Start
        // Game — either Loading (3) or Active/In Progress (4).
        const gameRunning = r.state === 3 || r.state === 4;
        const preGame = r.state < 3;

        // Start-position metadata for the room's current map.
        // `availableMaps` is populated on showBrowser() from /api/maps;
        // if the user landed on a room before the fetch completed
        // (e.g. via reconnection), the list is empty and the dropdown
        // renders as "Loading positions…". An empty start_positions
        // array is a legitimate map shape too — the sim will fall
        // back to its own default placement and we hide the dropdown.
        const currentMap = this.availableMaps.find(m => m.id === r.mapName);
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
        // Non-hosts see a read-only row with the AI name and team.
        // The host gets a remove button per slot plus the start-pos
        // select; the add-AI dropdown is rendered below the slot
        // list rather than per-slot.
        const aiRowsHtml = r.aiSlots.map((slot, idx) => {
            const nameText = this.esc(slot.displayName || slot.aiId);
            const teamLabel = `Team ${slot.team + 1}`;
            const removeBtn = (amHost && preGame)
                ? `<button class="ai-remove-btn" data-slot="${idx}" title="Remove AI">✕</button>`
                : '';
            const canEdit = preGame && amHost;
            const posSel = renderStartPosSelect(
                slot.startPos, `ai:${idx}`, canEdit);
            return `<div class="player-row ai-row"><span class="player-icon">🤖</span>`
                + `<span class="player-name">${nameText}</span>`
                + `<span class="ai-team-label">${teamLabel}</span>`
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
        if (gameRunning && amHost) {
            actions.push('<button id="endgame-btn" class="danger">End Game</button>');
        }

        this.container.innerHTML = renderTemplate(this.templates.room, {
            name: this.esc(r.name),
            state: ROOM_STATE_LABELS[r.state] || '?',
            players_html: playersHtml + aiRowsHtml + addAIHtml,
            actions_html: actions.join(''),
        });

        document.getElementById('leave-btn')!.onclick = () => this.sendLeave();
        document.getElementById('ready-btn')?.addEventListener('click',
            () => this.sendReady(!myPlayer?.ready));
        document.getElementById('start-btn')?.addEventListener('click',
            () => this.sendStartGame());
        document.getElementById('rejoin-btn')?.addEventListener('click', () => {
            if (this.currentRoom && this.currentRoom.gameServerPort > 0) {
                this.onGameStart?.(this.currentRoom.gameServerPort);
            }
        });
        document.getElementById('endgame-btn')?.addEventListener('click', () => {
            if (confirm('End the game for everyone?')) {
                this.sendEndGame();
            }
        });

        // The team-select dropdown is reused both as a player team
        // picker AND as the host's "add-AI" dropdowns; we only want
        // the change handler on the player-row selects (which carry
        // a data-pid attribute). Filter by that attribute so the
        // add-AI row's selects don't try to reassign the player's team.
        this.container.querySelectorAll('.team-select[data-pid]').forEach(sel => {
            (sel as HTMLSelectElement).onchange = (e) => {
                const team = parseInt((e.target as HTMLSelectElement).value);
                this.sendTeamSelect(team);
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
                if (aiId) this.sendAddAI(aiId, team);
            };
        }
        this.container.querySelectorAll('.ai-remove-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = (e) => {
                const el = e.currentTarget as HTMLButtonElement;
                const idx = parseInt(el.dataset.slot ?? '-1');
                if (idx >= 0) this.sendRemoveAI(idx);
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
                        this.sendSetStartPos({ kind: 'self' }, posIndex);
                    } else {
                        this.sendSetStartPos({ kind: 'player', playerId: pid }, posIndex);
                    }
                } else if (owner.startsWith('ai:')) {
                    const idx = parseInt(owner.substring('ai:'.length));
                    this.sendSetStartPos({ kind: 'ai', slotIndex: idx }, posIndex);
                }
            };
        });
    }

    // ===================== NETWORK =====================

    private sendCreateRoom(name: string, mapId: string = ''): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(256);
        const nOff = b.createString(name);
        const mOff = b.createString(mapId);
        // Send whichever game the user picked in the create-room
        // dropdown. If the game list hasn't arrived yet (unlikely
        // but possible on a very fast double-click post-login), we
        // send an empty string and the server picks its first
        // discovered game as a default.
        const gOff = b.createString(this.selectedGameId);
        RoomCreate.startRoomCreate(b);
        RoomCreate.addName(b, nOff);
        RoomCreate.addMapName(b, mOff);
        RoomCreate.addGameName(b, gOff);
        RoomCreate.addMaxPlayers(b, 8);
        this.connection.sendClientMessage(b, ClientPayload.RoomCreate, RoomCreate.endRoomCreate(b));
    }

    private sendJoinRoom(roomId: number): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(64);
        RoomJoin.startRoomJoin(b);
        RoomJoin.addRoomId(b, roomId);
        this.connection.sendClientMessage(b, ClientPayload.RoomJoin, RoomJoin.endRoomJoin(b));
    }

    private sendLeave(): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        RoomLeave.startRoomLeave(b);
        this.connection.sendClientMessage(b, ClientPayload.RoomLeave, RoomLeave.endRoomLeave(b));
        this.currentRoom = null;
        this.showBrowser();
    }

    private sendReady(ready: boolean): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        RoomReady.startRoomReady(b);
        RoomReady.addReady(b, ready);
        this.connection.sendClientMessage(b, ClientPayload.RoomReady, RoomReady.endRoomReady(b));
    }

    private sendTeamSelect(team: number): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        RoomTeamSelect.startRoomTeamSelect(b);
        RoomTeamSelect.addTeam(b, team);
        this.connection.sendClientMessage(b, ClientPayload.RoomTeamSelect, RoomTeamSelect.endRoomTeamSelect(b));
    }

    private sendStartGame(): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        RoomStartGame.startRoomStartGame(b);
        this.connection.sendClientMessage(b, ClientPayload.RoomStartGame, RoomStartGame.endRoomStartGame(b));
    }

    /// Host-only: tell the lobby to terminate the game server subprocess
    /// for this room. The server validates that the sender is the host;
    /// the room transitions to Ended via the existing health-check loop
    /// once the subprocess exits. Non-host senders are silently ignored
    /// by the server.
    private sendEndGame(): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        RoomEndGame.startRoomEndGame(b);
        this.connection.sendClientMessage(b, ClientPayload.RoomEndGame, RoomEndGame.endRoomEndGame(b));
    }

    /// Ask the server for the list of AI plugins it discovered under
    /// content/engine/ai and the current game's content/games/<game>/ai.
    /// The server replies asynchronously with an AIListUpdate that
    /// handleAIList() caches into `availableAIs`.
    private sendAIListRequest(): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        AIListRequest.startAIListRequest(b);
        this.connection.sendClientMessage(
            b, ClientPayload.AIListRequest, AIListRequest.endAIListRequest(b));
    }

    /// Ask the server for the list of games discovered under
    /// content/games. Sent once on first login; the lobby's game
    /// roster is immutable for the process lifetime so we don't
    /// re-fetch. Response is a GameListUpdate handled by
    /// handleGameList().
    private sendGameListRequest(): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        GameListRequest.startGameListRequest(b);
        this.connection.sendClientMessage(
            b, ClientPayload.GameListRequest, GameListRequest.endGameListRequest(b));
    }

    /// Host-only: add an AI player to the current room's roster.
    /// `aiId` must be one of the ids the server reported in its most
    /// recent AIListUpdate; unknown ids are rejected by the lobby.
    private sendAddAI(aiId: string, team: number): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(64);
        const idOff = b.createString(aiId);
        RoomAddAI.startRoomAddAI(b);
        RoomAddAI.addAiId(b, idOff);
        RoomAddAI.addTeam(b, team);
        this.connection.sendClientMessage(
            b, ClientPayload.RoomAddAI, RoomAddAI.endRoomAddAI(b));
    }

    /// Host-only: remove the AI slot at `slotIndex` (as ordered in
    /// the most recent RoomStateUpdate.aiSlots vector).
    private sendRemoveAI(slotIndex: number): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        RoomRemoveAI.startRoomRemoveAI(b);
        RoomRemoveAI.addSlotIndex(b, slotIndex);
        this.connection.sendClientMessage(
            b, ClientPayload.RoomRemoveAI, RoomRemoveAI.endRoomRemoveAI(b));
    }

    /// Assign a map start position to a player or AI slot.
    ///
    /// Call with one of:
    ///   - `target = { kind: 'self' }`     — own slot (any client can do this)
    ///   - `target = { kind: 'player', playerId }` — host only, another player
    ///   - `target = { kind: 'ai', slotIndex }`    — host only, an AI slot
    ///
    /// `posIndex` is the index into the map's start_positions array,
    /// or -1 to clear the assignment. The server validates permission
    /// + occupancy and silently rejects on failure.
    private sendSetStartPos(
        target: { kind: 'self' } | { kind: 'player'; playerId: number } | { kind: 'ai'; slotIndex: number },
        posIndex: number,
    ): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(16);
        RoomSetStartPos.startRoomSetStartPos(b);
        if (target.kind === 'player') {
            RoomSetStartPos.addTargetPlayerId(b, target.playerId);
        } else if (target.kind === 'ai') {
            RoomSetStartPos.addTargetAiSlot(b, target.slotIndex);
        }
        // kind === 'self' leaves target_player_id = 0 which the
        // server interprets as "the requester's own slot".
        RoomSetStartPos.addPosIndex(b, posIndex);
        this.connection.sendClientMessage(
            b, ClientPayload.RoomSetStartPos, RoomSetStartPos.endRoomSetStartPos(b));
    }

    // ===================== HANDLERS =====================

    private handleRoomList(msg: ServerMessage): void {
        const update = msg.payload(new RoomListUpdate()) as RoomListUpdate;
        this.rooms = [];
        for (let i = 0; i < update.roomsLength(); i++) {
            const r = update.rooms(i);
            if (!r) continue;
            this.rooms.push({
                id: r.roomId(), name: r.name() ?? '', mapName: r.mapName() ?? '',
                playerCount: r.playerCount(), maxPlayers: r.maxPlayers(),
                state: r.state(), hasPassword: r.hasPassword(), hostName: r.hostName() ?? '',
            });
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
        // room's game, so this list matches room.gameName at the
        // time of the reply.
        this.availableAIsForGame = this.currentRoom?.gameName ?? '';
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
        const newGameName = u.gameName() ?? '';
        this.currentRoom = {
            id: u.roomId(), name: u.name() ?? '', mapName: u.mapName() ?? '',
            gameName: newGameName,
            state: u.state(), players, aiSlots,
            gameServerPort: u.gameServerPort(),
        };

        // The AI list is per-game (each game has its own ai/ folder
        // merged with the engine's), so refresh whenever we enter
        // a room running a different game than the currently cached
        // list, or when we don't have a cached list at all.
        if (this.availableAIsForGame !== newGameName) {
            this.sendAIListRequest();
        }

        // Loading or Active → start game (need a port to connect to)
        if (this.currentRoom.state >= 3 && this.currentRoom.gameServerPort > 0) {
            // Persist game info for reconnection on reload
            localStorage.setItem('springrts-game-room', String(this.currentRoom.id));
            localStorage.setItem('springrts-game-port', String(this.currentRoom.gameServerPort));
            this.hide();
            this.onGameStart?.(this.currentRoom.gameServerPort);
            return;
        }

        // Game ended — clear saved game
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
