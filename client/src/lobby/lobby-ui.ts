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
}

interface CurrentRoom {
    id: number; name: string; mapName: string;
    state: number; players: RoomPlayerInfo[];
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
    private availableMaps: { id: string; name: string; mapx: number; mapy: number; widthElmos: number; heightElmos: number }[] = [];
    private templates: LobbyTemplates;

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
        this.renderRoomList();
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

        // Pre-render each player row through the template so games can
        // override the row layout.
        const playersHtml = r.players.map(p => renderTemplate(this.templates.roomPlayerRow, {
            pid: p.playerId,
            name: this.esc(p.username),
            host_icon: p.isHost ? '★' : '●',
            ready_class: p.ready ? 'ready' : '',
            select_disabled: p.playerId !== this.myPlayerId ? ' disabled' : '',
            team0_selected: p.team === 0 ? ' selected' : '',
            team1_selected: p.team === 1 ? ' selected' : '',
            status: p.isSpectator ? 'Spectator' : (p.ready ? '✓ Ready' : '—'),
        })).join('');

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
            players_html: playersHtml,
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

        this.container.querySelectorAll('.team-select').forEach(sel => {
            (sel as HTMLSelectElement).onchange = (e) => {
                const team = parseInt((e.target as HTMLSelectElement).value);
                this.sendTeamSelect(team);
            };
        });
    }

    // ===================== NETWORK =====================

    private sendCreateRoom(name: string, mapId: string = ''): void {
        if (!this.connection?.authenticated) return;
        const b = new flatbuffers.Builder(256);
        const nOff = b.createString(name);
        const mOff = b.createString(mapId);
        const gOff = b.createString('papertanks');
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
            });
        }
        this.currentRoom = {
            id: u.roomId(), name: u.name() ?? '', mapName: u.mapName() ?? '',
            state: u.state(), players,
            gameServerPort: u.gameServerPort(),
        };

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
