/**
 * LobbyUI — manages login, room browser, and room setup screens.
 *
 * All screens are HTML overlays above the game canvas.
 * Uses Connection for auth and room messages.
 */

import * as flatbuffers from 'flatbuffers';
import { Connection, type ConnectionState, type CombatEventInfo } from '../core/connection.js';
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
    id: number;
    name: string;
    mapName: string;
    playerCount: number;
    maxPlayers: number;
    state: number;
    hasPassword: boolean;
    hostName: string;
}

interface RoomPlayerInfo {
    playerId: number;
    username: string;
    team: number;
    ready: boolean;
    isSpectator: boolean;
    isHost: boolean;
}

interface RoomState {
    id: number;
    name: string;
    mapName: string;
    state: number;
    players: RoomPlayerInfo[];
}

export class LobbyUI {
    private container: HTMLDivElement;
    private connection: Connection | null = null;
    private currentScreen: LobbyScreen = 'login';
    private rooms: RoomInfo[] = [];
    private currentRoom: RoomState | null = null;
    private onGameStart?: () => void;

    constructor(onGameStart?: () => void) {
        this.onGameStart = onGameStart;
        this.container = document.getElementById('lobby') as HTMLDivElement;
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'lobby';
            document.body.appendChild(this.container);
        }
        this.injectStyles();
        this.showLogin();
    }

    setConnection(conn: Connection): void {
        this.connection = conn;
    }

    /** Handle server messages that the lobby cares about. */
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

    show(): void { this.container.style.display = 'flex'; }
    hide(): void { this.container.style.display = 'none'; }

    // --- Login ---

    showLogin(): void {
        this.currentScreen = 'login';
        this.container.style.display = 'flex';
        this.container.innerHTML = `
            <div class="lobby-card">
                <h1>Spring RTS Web</h1>
                <div class="lobby-form">
                    <input type="text" id="login-username" placeholder="Username" value="player1" autofocus>
                    <input type="password" id="login-password" placeholder="Password" value="pass">
                    <button id="login-btn">Login / Register</button>
                    <div id="login-error" class="error"></div>
                </div>
            </div>
        `;
        document.getElementById('login-btn')!.onclick = () => this.doLogin();
        document.getElementById('login-password')!.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.doLogin();
        });
    }

    private doLogin(): void {
        const username = (document.getElementById('login-username') as HTMLInputElement).value.trim();
        const password = (document.getElementById('login-password') as HTMLInputElement).value;
        if (!username) return;

        const errEl = document.getElementById('login-error')!;
        errEl.textContent = 'Connecting...';

        const serverUrl = `ws://${window.location.hostname || 'localhost'}:9001`;
        this.connection = new Connection({
            onStateChange: (state: ConnectionState) => {
                if (state === 'disconnected') {
                    errEl.textContent = 'Disconnected from server';
                }
            },
            onAuthenticated: (_playerId: number, _token: string) => {
                this.showBrowser();
            },
            onAuthFailed: (message: string) => {
                errEl.textContent = message;
            },
            onServerError: (_code: number, message: string) => {
                errEl.textContent = message;
            },
            onServerMessage: (msg: ServerMessage) => {
                this.handleServerMessage(msg);
            },
            onEntityState: () => {},
            onCombatEvents: () => {},
            onEntityDestroy: () => {},
        });
        this.connection.connect(serverUrl, username, password);
    }

    getConnection(): Connection | null { return this.connection; }

    // --- Room Browser ---

    showBrowser(): void {
        this.currentScreen = 'browser';
        this.container.innerHTML = `
            <div class="lobby-panel">
                <div class="lobby-header">
                    <h2>Game Rooms</h2>
                    <button id="create-room-btn">Create Room</button>
                </div>
                <div id="room-list" class="room-list">
                    <div class="empty-state">No rooms available. Create one!</div>
                </div>
            </div>
        `;
        document.getElementById('create-room-btn')!.onclick = () => this.showCreateRoomDialog();
        this.renderRoomList();
    }

    private renderRoomList(): void {
        const listEl = document.getElementById('room-list');
        if (!listEl) return;

        if (this.rooms.length === 0) {
            listEl.innerHTML = '<div class="empty-state">No rooms available. Create one!</div>';
            return;
        }

        listEl.innerHTML = this.rooms.map(r => `
            <div class="room-entry" data-room-id="${r.id}">
                <div class="room-name">${r.name}</div>
                <div class="room-info">${r.mapName || 'No map'} &middot; ${r.playerCount}/${r.maxPlayers} players</div>
                <div class="room-host">Host: ${r.hostName}</div>
                <button class="join-btn" data-room-id="${r.id}">Join</button>
            </div>
        `).join('');

        listEl.querySelectorAll('.join-btn').forEach(btn => {
            (btn as HTMLButtonElement).onclick = () => {
                const roomId = parseInt(btn.getAttribute('data-room-id')!);
                this.joinRoom(roomId);
            };
        });
    }

    private showCreateRoomDialog(): void {
        const dialog = document.createElement('div');
        dialog.className = 'lobby-modal';
        dialog.innerHTML = `
            <div class="lobby-card">
                <h3>Create Room</h3>
                <div class="lobby-form">
                    <input type="text" id="room-name" placeholder="Room name" value="My Game">
                    <input type="text" id="room-map" placeholder="Map name" value="">
                    <button id="create-btn">Create</button>
                    <button id="cancel-btn" class="secondary">Cancel</button>
                </div>
            </div>
        `;
        this.container.appendChild(dialog);

        document.getElementById('create-btn')!.onclick = () => {
            this.createRoom(
                (document.getElementById('room-name') as HTMLInputElement).value,
                (document.getElementById('room-map') as HTMLInputElement).value,
            );
            dialog.remove();
        };
        document.getElementById('cancel-btn')!.onclick = () => dialog.remove();
    }

    private createRoom(name: string, mapName: string): void {
        if (!this.connection?.authenticated) return;
        const builder = new flatbuffers.Builder(256);
        const nameOff = builder.createString(name || 'Game');
        const mapOff = builder.createString(mapName);
        const gameOff = builder.createString('papertanks');
        RoomCreate.startRoomCreate(builder);
        RoomCreate.addName(builder, nameOff);
        RoomCreate.addMapName(builder, mapOff);
        RoomCreate.addGameName(builder, gameOff);
        RoomCreate.addMaxPlayers(builder, 8);
        const rc = RoomCreate.endRoomCreate(builder);
        this.connection.sendClientMessage(builder, ClientPayload.RoomCreate, rc);
    }

    private joinRoom(roomId: number): void {
        if (!this.connection?.authenticated) return;
        const builder = new flatbuffers.Builder(64);
        RoomJoin.startRoomJoin(builder);
        RoomJoin.addRoomId(builder, roomId);
        const rj = RoomJoin.endRoomJoin(builder);
        this.connection.sendClientMessage(builder, ClientPayload.RoomJoin, rj);
    }

    // --- Room Setup ---

    showRoom(): void {
        this.currentScreen = 'room';
        if (!this.currentRoom) return;

        const r = this.currentRoom;
        const stateNames = ['Configuring', 'Filling', 'Ready Check', 'Loading', 'Active', 'Ended'];

        this.container.innerHTML = `
            <div class="lobby-panel">
                <div class="lobby-header">
                    <h2>${r.name}</h2>
                    <span class="room-state-badge">${stateNames[r.state] || 'Unknown'}</span>
                    <button id="leave-room-btn" class="secondary">Leave</button>
                </div>
                <div class="room-players">
                    ${r.players.map(p => `
                        <div class="player-row ${p.ready ? 'ready' : ''}">
                            <span class="player-name">${p.isHost ? '★ ' : ''}${p.username}</span>
                            <span class="player-team">Team ${p.team}</span>
                            <span class="player-status">${p.isSpectator ? 'Spectator' : (p.ready ? '✓ Ready' : 'Not ready')}</span>
                        </div>
                    `).join('')}
                </div>
                <div class="room-controls">
                    <label>Team: <select id="team-select">
                        <option value="0">Team 0</option>
                        <option value="1">Team 1</option>
                    </select></label>
                    <button id="ready-btn">Ready</button>
                    <button id="start-btn" class="primary">Start Game</button>
                </div>
            </div>
        `;

        document.getElementById('leave-room-btn')!.onclick = () => {
            if (!this.connection?.authenticated) return;
            const builder = new flatbuffers.Builder(32);
            RoomLeave.startRoomLeave(builder);
            const rl = RoomLeave.endRoomLeave(builder);
            this.connection.sendClientMessage(builder, ClientPayload.RoomLeave, rl);
            this.currentRoom = null;
            this.showBrowser();
        };

        document.getElementById('team-select')!.onchange = (e) => {
            if (!this.connection?.authenticated) return;
            const team = parseInt((e.target as HTMLSelectElement).value);
            const builder = new flatbuffers.Builder(32);
            RoomTeamSelect.startRoomTeamSelect(builder);
            RoomTeamSelect.addTeam(builder, team);
            const rts = RoomTeamSelect.endRoomTeamSelect(builder);
            this.connection.sendClientMessage(builder, ClientPayload.RoomTeamSelect, rts);
        };

        document.getElementById('ready-btn')!.onclick = () => {
            if (!this.connection?.authenticated) return;
            const builder = new flatbuffers.Builder(32);
            RoomReady.startRoomReady(builder);
            RoomReady.addReady(builder, true);
            const rr = RoomReady.endRoomReady(builder);
            this.connection.sendClientMessage(builder, ClientPayload.RoomReady, rr);
        };

        document.getElementById('start-btn')!.onclick = () => {
            if (!this.connection?.authenticated) return;
            const builder = new flatbuffers.Builder(32);
            RoomStartGame.startRoomStartGame(builder);
            const rs = RoomStartGame.endRoomStartGame(builder);
            this.connection.sendClientMessage(builder, ClientPayload.RoomStartGame, rs);
        };
    }

    // --- Message Handlers ---

    private handleRoomList(msg: ServerMessage): void {
        const update = msg.payload(new RoomListUpdate()) as RoomListUpdate;
        this.rooms = [];
        for (let i = 0; i < update.roomsLength(); i++) {
            const r = update.rooms(i);
            if (!r) continue;
            this.rooms.push({
                id: r.roomId(),
                name: r.name() ?? '',
                mapName: r.mapName() ?? '',
                playerCount: r.playerCount(),
                maxPlayers: r.maxPlayers(),
                state: r.state(),
                hasPassword: r.hasPassword(),
                hostName: r.hostName() ?? '',
            });
        }
        if (this.currentScreen === 'browser') this.renderRoomList();
    }

    private handleRoomState(msg: ServerMessage): void {
        const update = msg.payload(new RoomStateUpdate()) as RoomStateUpdate;
        const players: RoomPlayerInfo[] = [];
        for (let i = 0; i < update.playersLength(); i++) {
            const p = update.players(i);
            if (!p) continue;
            players.push({
                playerId: p.playerId(),
                username: p.username() ?? '',
                team: p.team(),
                ready: p.ready(),
                isSpectator: p.isSpectator(),
                isHost: p.isHost(),
            });
        }

        this.currentRoom = {
            id: update.roomId(),
            name: update.name() ?? '',
            mapName: update.mapName() ?? '',
            state: update.state(),
            players,
        };

        // State 3 = Loading, 4 = Active → transition to game
        if (this.currentRoom.state >= 3) {
            this.hide();
            this.onGameStart?.();
            return;
        }

        // Show/update room screen
        if (this.currentScreen !== 'room') {
            this.showRoom();
        } else {
            this.showRoom(); // re-render
        }
    }

    // --- Styles ---

    private injectStyles(): void {
        if (document.getElementById('lobby-styles')) return;
        const style = document.createElement('style');
        style.id = 'lobby-styles';
        style.textContent = `
            #lobby {
                position: fixed; inset: 0; z-index: 100;
                background: #1a1a2e;
                display: flex; align-items: center; justify-content: center;
                font-family: system-ui, sans-serif; color: #e0e0e0;
            }
            .lobby-card {
                background: #16213e; border-radius: 12px; padding: 32px;
                min-width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            }
            .lobby-card h1 { margin: 0 0 24px; text-align: center; color: #4cc9f0; }
            .lobby-card h3 { margin: 0 0 16px; }
            .lobby-form { display: flex; flex-direction: column; gap: 12px; }
            .lobby-form input {
                padding: 10px 14px; border: 1px solid #334; border-radius: 6px;
                background: #0f1626; color: #e0e0e0; font-size: 14px;
            }
            .lobby-form input:focus { outline: none; border-color: #4cc9f0; }
            .lobby-panel {
                background: #16213e; border-radius: 12px; padding: 24px;
                min-width: 500px; max-width: 700px; width: 100%;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            }
            .lobby-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
            .lobby-header h2 { margin: 0; flex: 1; }
            button {
                padding: 10px 20px; border: none; border-radius: 6px;
                background: #4cc9f0; color: #0f1626; font-weight: 600;
                cursor: pointer; font-size: 14px;
            }
            button:hover { background: #7bdff2; }
            button.secondary { background: #334; color: #aaa; }
            button.secondary:hover { background: #445; }
            button.primary { background: #06d6a0; }
            button.primary:hover { background: #0be5af; }
            .error { color: #f07; font-size: 13px; min-height: 20px; }
            .room-list { display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; }
            .room-entry {
                display: grid; grid-template-columns: 1fr auto auto;
                align-items: center; gap: 12px;
                padding: 12px 16px; background: #0f1626; border-radius: 8px;
            }
            .room-name { font-weight: 600; }
            .room-info { color: #888; font-size: 13px; }
            .room-host { color: #666; font-size: 12px; }
            .empty-state { text-align: center; color: #555; padding: 32px; }
            .room-players { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
            .player-row {
                display: flex; gap: 16px; padding: 8px 12px;
                background: #0f1626; border-radius: 6px; align-items: center;
            }
            .player-row.ready { border-left: 3px solid #06d6a0; }
            .player-name { flex: 1; font-weight: 500; }
            .player-team { color: #888; font-size: 13px; }
            .player-status { font-size: 13px; }
            .room-controls { display: flex; gap: 12px; align-items: center; }
            .room-controls label { color: #888; font-size: 13px; }
            .room-controls select {
                padding: 6px 10px; background: #0f1626; color: #e0e0e0;
                border: 1px solid #334; border-radius: 4px;
            }
            .room-state-badge {
                background: #334; padding: 4px 10px; border-radius: 12px;
                font-size: 12px; color: #4cc9f0;
            }
            .lobby-modal {
                position: fixed; inset: 0; z-index: 200;
                background: rgba(0,0,0,0.6); display: flex;
                align-items: center; justify-content: center;
            }
        `;
        document.head.appendChild(style);
    }
}
