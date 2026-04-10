/**
 * Detached Viewport — lightweight battlefield view in a separate window.
 *
 * Connects to the server with the shared session token, registers a
 * viewport covering the full map, and renders entities as 2D dots on
 * an HTML canvas. Click to move the main window's camera, right-click
 * to issue commands.
 *
 * Communicates with the main window via BroadcastChannel.
 */

import { Connection } from './core/connection.js';
import { CommandBuffer, CMD } from './core/command-buffer.js';
import { parseEntityState, type EntityStateSnapshot } from './core/entity-state.js';
import { CONFIG } from './config.js';

const TEAM_COLORS = ['#3388ff', '#ff4444', '#44cc44', '#ffcc22'];

// Read params from URL
const params = new URLSearchParams(window.location.search);
const mapWidth = parseInt(params.get('mapW') ?? '8192');
const mapHeight = parseInt(params.get('mapH') ?? '8192');
const token = params.get('token') ?? localStorage.getItem('springrts-session-token') ?? '';
// Port of the game server this viewport should connect to. Passed by
// Minimap.detach() as a URL param; falls back to localStorage (set by
// the lobby when the player joined a game), and finally to the default
// lobby URL as a last resort. Without this, the viewport connects to
// the lobby server and never receives any entity state.
const gamePort = params.get('port') ?? localStorage.getItem('springrts-game-port') ?? '';
// Map id for the terrain backdrop. Without this the viewport renders
// entities on a black grid; with it we fetch the same minimap thumb
// the lobby browser uses and draw it underneath.
const mapId = params.get('mapId') ?? '';

const statusEl = document.getElementById('viewport-status')!;
const canvas = document.getElementById('viewport-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Entity tracking
interface ViewportEntity {
    id: number;
    x: number;
    z: number;
    team: number;
    defId: number;
}
const entities = new Map<number, ViewportEntity>();
let selectedIds = new Set<number>();

// Cross-window communication
let channel: BroadcastChannel | null = null;
try {
    channel = new BroadcastChannel('springrts-game');
    channel.onmessage = (e) => {
        if (e.data.type === 'selection') {
            selectedIds = new Set(e.data.unitIds);
        }
    };
} catch { /* ok */ }

// Connection. Prefer the game server URL built from the port param;
// fall back to CONFIG.wsUrl (lobby) only if no game is active.
const host = window.location.hostname || 'localhost';
const serverUrl = gamePort ? `ws://${host}:${gamePort}` : CONFIG.wsUrl;

// Map terrain backdrop. Loaded asynchronously from the lobby's
// /api/maps/thumb/{id} endpoint. We just hold an Image and check its
// `complete` flag in render() — the load is fire-and-forget so the
// viewport keeps working even if the request fails (entities just
// render on the black grid as before).
let mapThumb: HTMLImageElement | null = null;
if (mapId) {
    const img = new Image();
    img.onload = () => { mapThumb = img; };
    img.onerror = () => { /* fall back to grid */ };
    // Lobby HTTP is on the same host as the game WebSocket but on the
    // lobby's port. The configured CONFIG.httpUrl points there.
    img.src = `${CONFIG.httpUrl}/api/maps/thumb/${encodeURIComponent(mapId)}`;
}
const connection = new Connection({
    onStateChange(state) {
        statusEl.textContent = state;
    },
    onAuthenticated(_playerId, _token) {
        statusEl.textContent = 'Connected';
        // Register a viewport covering the full map at strategic zoom
        connection.sendViewportUpdate(0,
            mapWidth / 2, mapHeight / 2,
            mapWidth, mapHeight,
            0, 20); // zoom level 20 = very zoomed out
    },
    onAuthFailed(msg) {
        statusEl.textContent = `Auth failed: ${msg}`;
    },
    onEntityState(snapshot, _isDelta) {
        updateEntities(snapshot);
    },
    onCombatEvents() {},
    onEntityDestroy(entityId) {
        entities.delete(entityId);
    },
});

// Connect with the same credentials (token-based reconnection)
connection.connect(serverUrl, 'viewport', token);

// Command buffer for right-click commands
const commandBuffer = new CommandBuffer(connection);

function updateEntities(snapshot: EntityStateSnapshot): void {
    if (!snapshot.entityIds) return;

    for (let i = 0; i < snapshot.count; i++) {
        const id = snapshot.entityIds[i];
        let ent = entities.get(id);
        if (!ent) {
            ent = { id, x: 0, z: 0, team: 0, defId: 0 };
            entities.set(id, ent);
        }
        if (snapshot.positionsX) ent.x = snapshot.positionsX[i];
        if (snapshot.positionsZ) ent.z = snapshot.positionsZ[i];
        if (snapshot.teams) ent.team = snapshot.teams[i];
        if (snapshot.defIds) ent.defId = snapshot.defIds[i];
    }
}

function render(): void {
    const w = canvas.width;
    const h = canvas.height;
    const scaleX = w / mapWidth;
    const scaleZ = h / mapHeight;

    ctx.fillStyle = '#0a0f0a';
    ctx.fillRect(0, 0, w, h);

    // Terrain backdrop. Stretched to the full canvas; the source thumb
    // is the SMF minimap so its aspect matches the map exactly. If it
    // hasn't loaded yet (or never loaded) the grid below still renders.
    if (mapThumb && mapThumb.complete && mapThumb.naturalWidth > 0) {
        ctx.drawImage(mapThumb, 0, 0, w, h);
    }

    // Grid — kept on top of the terrain so 1km cells stay legible at
    // any zoom. Use a subtle dark green stroke that works against both
    // the black fallback and the textured terrain.
    ctx.strokeStyle = mapThumb ? 'rgba(0,0,0,0.25)' : '#1a2a1a';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < mapWidth; x += 1024) {
        ctx.beginPath();
        ctx.moveTo(x * scaleX, 0);
        ctx.lineTo(x * scaleX, h);
        ctx.stroke();
    }
    for (let z = 0; z < mapHeight; z += 1024) {
        ctx.beginPath();
        ctx.moveTo(0, z * scaleZ);
        ctx.lineTo(w, z * scaleZ);
        ctx.stroke();
    }

    // Entities
    for (const ent of entities.values()) {
        const px = ent.x * scaleX;
        const pz = ent.z * scaleZ;
        const isSelected = selectedIds.has(ent.id);

        if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(px, pz, 6, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.fillStyle = TEAM_COLORS[ent.team % TEAM_COLORS.length];
        ctx.beginPath();
        ctx.arc(px, pz, isSelected ? 3.5 : 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    // Entity count
    ctx.fillStyle = '#555';
    ctx.font = '10px monospace';
    ctx.fillText(`${entities.size} entities`, 4, h - 4);
}

// Resize canvas to fill window
function resize(): void {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// Input
canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.offsetX / rect.width) * mapWidth;
    const mz = (e.offsetY / rect.height) * mapHeight;

    if (e.button === 0) {
        // Left click — tell main window to move camera here
        channel?.postMessage({ type: 'focusPosition', x: mx, z: mz });
    } else if (e.button === 2) {
        // Right click — issue move command
        const ids = Array.from(selectedIds);
        if (ids.length > 0) {
            commandBuffer.issueImmediate(CMD.MOVE, ids, [mx, 0, mz],
                e.shiftKey ? 32 : 0);
        }
    }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Render loop at ~15fps
setInterval(render, 66);
