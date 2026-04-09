/**
 * LobbyUI — login, room browser, room setup screens.
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
import { RoomLeave } from '../protocol/spring-web/room-leave.js';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { RoomListUpdate } from '../protocol/spring-web/room-list-update.js';
import { RoomStateUpdate } from '../protocol/spring-web/room-state-update.js';

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

    constructor(onGameStart?: (gameServerPort: number) => void) {
        this.onGameStart = onGameStart;
        this.container = document.getElementById('lobby') as HTMLDivElement;
        this.injectStyles();

        // Try auto-login with saved session
        const savedUser = localStorage.getItem('springrts-username');
        const savedToken = localStorage.getItem('springrts-token');
        if (savedUser && savedToken) {
            this.tryAutoLogin(savedUser, savedToken);
        } else {
            this.showLogin();
        }
    }

    private tryAutoLogin(username: string, token: string): void {
        this.container.style.display = 'flex';
        this.container.innerHTML = `
            <div class="lobby-card"><h1>Spring RTS Web</h1><p class="msg">Reconnecting...</p></div>
        `;

        const savedRoomId = localStorage.getItem('springrts-game-room');
        const savedPort = localStorage.getItem('springrts-game-port');

        this.connection = this.createConnection(
            (msg: string) => {
                console.log('[lobby] auto-login failed:', msg);
                localStorage.removeItem('springrts-token');
                localStorage.removeItem('springrts-game-room');
                localStorage.removeItem('springrts-game-port');
                this.showLogin();
            },
        );

        // After auth succeeds, check for saved game
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
        this.container.innerHTML = `
            <div class="lobby-card">
                <h1>Spring RTS Web</h1>
                <form id="login-form" class="lobby-form">
                    <input type="text" id="login-user" placeholder="Username" autofocus>
                    <input type="password" id="login-pass" placeholder="Password">
                    <input type="password" id="login-pass2" placeholder="Confirm password (new accounts)">
                    <button type="submit" id="login-btn">Login / Register</button>
                    <p id="login-msg" class="msg"></p>
                    <p class="hint">New username? Enter a password twice to register.</p>
                </form>
            </div>
        `;
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

    showBrowser(): void {
        this.currentScreen = 'browser';
        this.currentRoom = null;

        // Fetch available maps
        fetch(`${CONFIG.httpUrl}/api/maps`).then(r => r.ok ? r.json() : []).then(maps => {
            this.availableMaps = maps;
            this.renderMapOptions();
        }).catch(() => {});

        this.container.innerHTML = `
            <div class="lobby-panel">
                <div class="lobby-header">
                    <h2>Game Rooms</h2>
                    <button id="create-room-btn">+ New Game</button>
                </div>
                <div id="room-list" class="room-list"></div>
                <div id="create-form" class="create-form" style="display:none">
                    <h3>Create Game</h3>
                    <input type="text" id="new-room-name" placeholder="Room name" value="My Game">
                    <div class="map-select-label">Map:</div>
                    <div id="map-selector" class="map-grid">
                        <div class="empty-state">Loading maps...</div>
                    </div>
                    <div class="btn-row">
                        <button id="do-create-btn" class="primary">Create</button>
                        <button id="cancel-create-btn" class="secondary">Cancel</button>
                    </div>
                </div>
            </div>
        `;
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
            const thumbUrl = `${CONFIG.httpUrl}/api/maps/thumb/${encodeURIComponent(m.id)}`;
            return `
                <div class="map-card ${m.id === this.selectedMapId ? 'selected' : ''}" data-map-id="${this.esc(m.id)}">
                    <div class="map-thumb" style="background-image:url('${thumbUrl}')"></div>
                    <div class="map-label">${this.esc(m.name)}</div>
                    <div class="map-size">${m.mapx}×${m.mapy} (${sizeKm} km²)</div>
                </div>
            `;
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

        const stateLabels = ['Setup', 'Waiting', 'Ready Check', 'Loading', 'In Progress', 'Ended'];
        el.innerHTML = this.rooms.map(r => `
            <div class="room-entry">
                <div class="room-main">
                    <span class="room-name">${this.esc(r.name)}</span>
                    <span class="room-badge">${stateLabels[r.state] || '?'}</span>
                </div>
                <div class="room-detail">
                    ${r.mapName ? this.esc(r.mapName) : '<em>No map</em>'} ·
                    ${r.playerCount}/${r.maxPlayers} players ·
                    Host: ${this.esc(r.hostName)}
                </div>
                <button class="join-btn" data-id="${r.id}"${r.state >= 5 ? ' disabled' : ''}>
                    ${r.state >= 3 && r.state < 5 ? 'Watch / Rejoin' : (r.state >= 5 ? 'Ended' : 'Join')}
                </button>
            </div>
        `).join('');

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
        const stateLabels = ['Setup', 'Waiting', 'Ready Check', 'Loading', 'In Progress', 'Ended'];
        const myPlayer = r.players.find(p => p.playerId === this.myPlayerId);
        const amHost = myPlayer?.isHost ?? false;

        this.container.innerHTML = `
            <div class="lobby-panel">
                <div class="lobby-header">
                    <h2>${this.esc(r.name)}</h2>
                    <span class="room-badge">${stateLabels[r.state] || '?'}</span>
                    <button id="leave-btn" class="secondary">Leave</button>
                </div>

                <div class="player-list">
                    ${r.players.map(p => `
                        <div class="player-row ${p.ready ? 'ready' : ''}">
                            <span class="player-icon">${p.isHost ? '★' : '●'}</span>
                            <span class="player-name">${this.esc(p.username)}</span>
                            <select class="team-select" data-pid="${p.playerId}"
                                    ${p.playerId !== this.myPlayerId ? 'disabled' : ''}>
                                <option value="0" ${p.team === 0 ? 'selected' : ''}>Team 1</option>
                                <option value="1" ${p.team === 1 ? 'selected' : ''}>Team 2</option>
                            </select>
                            <span class="player-status">
                                ${p.isSpectator ? 'Spectator' : (p.ready ? '✓ Ready' : '—')}
                            </span>
                        </div>
                    `).join('')}
                </div>

                <div class="room-actions">
                    <button id="ready-btn" class="${myPlayer?.ready ? 'secondary' : ''}">${myPlayer?.ready ? 'Unready' : 'Ready'}</button>
                    ${amHost ? '<button id="start-btn" class="primary">Start Game</button>' : ''}
                </div>
            </div>
        `;

        document.getElementById('leave-btn')!.onclick = () => this.sendLeave();
        document.getElementById('ready-btn')!.onclick = () => this.sendReady(!myPlayer?.ready);
        document.getElementById('start-btn')?.addEventListener('click', () => this.sendStartGame());

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

    private injectStyles(): void {
        if (document.getElementById('lobby-styles')) return;
        const s = document.createElement('style');
        s.id = 'lobby-styles';
        s.textContent = `
            #lobby {
                position:fixed; inset:0; z-index:100;
                background:#1a1a2e;
                display:flex; align-items:center; justify-content:center;
                font-family:system-ui,sans-serif; color:#e0e0e0;
            }
            .lobby-card, .lobby-panel {
                background:#16213e; border-radius:12px; padding:32px;
                min-width:360px; max-width:600px; width:100%;
                box-shadow:0 8px 32px rgba(0,0,0,0.4);
            }
            .lobby-card h1 { margin:0 0 24px; text-align:center; color:#4cc9f0; }
            .lobby-form { display:flex; flex-direction:column; gap:12px; }
            .lobby-form input, .create-form input {
                padding:10px 14px; border:1px solid #334; border-radius:6px;
                background:#0f1626; color:#e0e0e0; font-size:14px;
            }
            .lobby-form input:focus, .create-form input:focus { outline:none; border-color:#4cc9f0; }
            button {
                padding:10px 20px; border:none; border-radius:6px;
                background:#4cc9f0; color:#0f1626; font-weight:600;
                cursor:pointer; font-size:14px; transition:background .15s;
            }
            button:hover { background:#7bdff2; }
            button:disabled { opacity:0.4; cursor:default; }
            button.secondary { background:#334; color:#aaa; }
            button.secondary:hover { background:#445; }
            button.primary { background:#06d6a0; }
            button.primary:hover { background:#0be5af; }
            .msg { font-size:13px; min-height:20px; margin:0; }
            .msg.error { color:#f07; }
            .hint { font-size:11px; color:#555; margin:0; }
            .lobby-header { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
            .lobby-header h2 { margin:0; flex:1; }
            .room-badge {
                background:#334; padding:3px 10px; border-radius:10px;
                font-size:11px; color:#4cc9f0; white-space:nowrap;
            }
            .room-list { display:flex; flex-direction:column; gap:8px; max-height:400px; overflow-y:auto; }
            .room-entry {
                display:grid; grid-template-columns:1fr auto;
                gap:4px 12px; padding:12px 16px;
                background:#0f1626; border-radius:8px; align-items:center;
            }
            .room-main { display:flex; align-items:center; gap:8px; }
            .room-name { font-weight:600; }
            .room-detail { grid-column:1; color:#888; font-size:12px; }
            .join-btn { grid-row:1/3; grid-column:2; }
            .empty-state { text-align:center; color:#555; padding:32px; }
            .create-form {
                margin-top:16px; padding-top:16px; border-top:1px solid #334;
                display:flex; flex-direction:column; gap:12px;
            }
            .create-form h3 { margin:0; font-size:15px; }
            .btn-row { display:flex; gap:8px; }
            .player-list { display:flex; flex-direction:column; gap:4px; margin-bottom:16px; }
            .player-row {
                display:flex; gap:10px; padding:8px 12px;
                background:#0f1626; border-radius:6px; align-items:center;
            }
            .player-row.ready { border-left:3px solid #06d6a0; }
            .player-icon { width:16px; text-align:center; color:#4cc9f0; }
            .player-name { flex:1; font-weight:500; }
            .team-select {
                padding:4px 8px; background:#0f1626; color:#e0e0e0;
                border:1px solid #334; border-radius:4px; font-size:12px;
            }
            .player-status { font-size:12px; color:#888; min-width:60px; text-align:right; }
            .room-actions { display:flex; gap:10px; }
            .map-select-label { font-size:13px; color:#888; margin-bottom:4px; }
            .map-grid { display:flex; gap:8px; flex-wrap:wrap; max-height:200px; overflow-y:auto; }
            .map-card {
                width:140px; background:#0f1626; border:2px solid transparent;
                border-radius:8px; cursor:pointer; overflow:hidden; transition:border-color .15s;
            }
            .map-card:hover { border-color:#445; }
            .map-card.selected { border-color:#4cc9f0; }
            .map-thumb {
                width:140px; height:100px; background-color:#1a2a1a;
                background-size:cover; background-position:center;
            }
            .map-label { padding:6px 8px 2px; font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .map-size { padding:0 8px 6px; font-size:10px; color:#666; }
        `;
        document.head.appendChild(s);
    }
}
