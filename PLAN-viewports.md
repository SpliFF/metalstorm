# PLAN: Detachable Viewports & Multi-Window Architecture

## Concept

The minimap is not a fixed UI element — it's a **detachable viewport** that can be popped out as a separate browser window. This extends naturally: players can open multiple viewport windows for multi-monitor setups, each showing a different area of the battlefield at different zoom levels.

Each viewport window is a lightweight browser client that:
- Connects to the server with the same session token
- Registers its own viewport area
- Receives entity state filtered to its viewport
- Can issue commands (move, attack) from any window
- Renders at appropriate fidelity for its zoom level

## Architecture

### Connection Model

Each browser window opens its own WebSocket connection and authenticates with the same session token (stored in `localStorage`). The server links these connections to the same player:

```
Player "alice" (userId=42):
  ├── Window 1 (main view):   clientId=5, viewport centered on base
  ├── Window 2 (minimap):     clientId=8, viewport covering full map, low fidelity
  └── Window 3 (front line):  clientId=12, viewport on combat zone
```

### Server Changes

The server already tracks sessions by `clientId`. To support multiple connections per player:

1. `ClientSession` gains a `userId` link (already exists)
2. `SessionManager` allows multiple clientIds with the same userId
3. Each connection independently registers viewports and receives filtered state
4. Commands from any connection are validated against the player's team (already works — auth gives the same userId/team)
5. Token-based reconnection already exists in the auth flow

No new server infrastructure needed — the existing per-client viewport + entity filtering handles this naturally.

### Client Changes

**Main window:**
- Renders the primary 3D game view
- Has the full HUD (selection, commands, resources)
- Contains a "Detach Minimap" button that opens a new window

**Detached viewport window:**
- Lightweight: no full HUD, minimal UI
- Loads a separate entry point (`viewport.html` / `viewport.ts`)
- Reads the session token from `localStorage`
- Connects to the server, authenticates with the token
- Registers a viewport (user can pan/zoom this window independently)
- Shows entities as simplified icons at strategic zoom
- Can issue commands via right-click (shares the same CommandBuffer logic)
- Communicates with the main window via `BroadcastChannel` for selection sync

### Fidelity Levels

The viewport's `zoom_level` field (already in the protocol) controls what data the server sends:

| Zoom Level | Entity Data | Rendering | Use Case |
|-----------|-------------|-----------|----------|
| 1-4 (close) | Full: position, heading, health, defId, team | 3D models/boxes | Main tactical view |
| 4-8 (medium) | Reduced: position, team, defId. No heading/health | Colored icons/dots | Overview |
| 8+ (strategic) | Minimal: squad center positions, team | Team-colored blips | Full-map minimap |

The server already has the `zoom_level` field in `ViewportUpdate`. The entity state serializer can use it to select which fields to include via the `fieldMask`:

- Close zoom: `FIELD_ALL` (all fields)
- Medium zoom: `FIELD_ENTITY_IDS | FIELD_POSITION_X | FIELD_POSITION_Z | FIELD_TEAM | FIELD_DEF_ID`
- Strategic zoom: `FIELD_ENTITY_IDS | FIELD_POSITION_X | FIELD_POSITION_Z | FIELD_TEAM`

### Cross-Window Communication

Windows share state via `BroadcastChannel`:

```typescript
const channel = new BroadcastChannel('springrts-game');

// Main window sends selection changes
channel.postMessage({ type: 'selection', unitIds: [42, 55, 67] });

// Viewport window receives and highlights selected units
channel.onmessage = (e) => {
    if (e.data.type === 'selection') {
        highlightUnits(e.data.unitIds);
    }
};

// Viewport window sends camera-move request
channel.postMessage({ type: 'focusPosition', x: 1500, z: 3200 });

// Main window receives and moves its camera
channel.onmessage = (e) => {
    if (e.data.type === 'focusPosition') {
        camera.setTarget(new Vector3(e.data.x, 0, e.data.z));
    }
};
```

Messages:
- `selection` — sync selected units across windows
- `focusPosition` — double-click on minimap moves main camera
- `ping` — mark a position on all windows
- `viewportUpdate` — sync viewport position (optional)

### Opening a Detached Window

```typescript
function detachMinimap(): void {
    const url = `/viewport.html?token=${sessionToken}&zoom=strategic`;
    const win = window.open(url, 'minimap', 'width=400,height=400');
    // The new window handles its own connection and rendering
}
```

### Viewport Window Entry Point

`viewport.html` loads `viewport.ts` which is a stripped-down version of `main.ts`:
- No lobby UI
- No full HUD
- Reads token from URL params or localStorage
- Connects, authenticates, registers viewport
- Renders entities as 2D icons on a flat map (HTML canvas or simplified Babylon.js)
- Click/drag to pan, scroll to zoom
- Right-click to issue commands
- Listens to BroadcastChannel for selection sync

### Rendering in Viewport Windows

Viewport windows at strategic zoom don't need Babylon.js 3D rendering. A 2D HTML `<canvas>` is lighter:

```
Heightmap as background image (downscaled, pre-rendered)
Unit dots: fillRect with team color (2-4px)
Selected units: highlighted ring
Viewport rectangle: outline showing main window's view area
```

This keeps detached viewports extremely lightweight — they can run on low-end monitors without GPU pressure.

## Implementation Phases

### Phase A: Minimap in main window (2D canvas, embedded)
- Render a small 2D canvas in the HUD showing unit dots on heightmap
- Click to move camera, right-click to issue commands from minimap
- This validates the data flow before adding multi-window

### Phase B: Detachable window
- Add viewport.html entry point
- Session token sharing via localStorage
- BroadcastChannel for selection sync
- Detach button on the embedded minimap

### Phase C: Zoom-based LOD filtering
- Server uses zoom_level to adjust field_mask per viewport
- Strategic zoom sends minimal data
- Close zoom sends full data

### Phase D: Multi-viewport from same window
- Allow splitting the main window into multiple viewports (picture-in-picture)
- Each registers its own viewport with the server
- Shares the same WebSocket connection (multiple viewports per client, already supported up to 4)
