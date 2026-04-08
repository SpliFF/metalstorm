# PLAN: Next Steps — Functional Lobby + Demo Game

## Status Assessment

As of Phase 6 completion, the codebase has substantial infrastructure but limited end-to-end functionality. The goal of this plan is to connect the disconnected pieces and fill the gaps needed for a player to: open a browser → see a lobby → create/join a game → watch units fight → see a result.

### What works end-to-end
- Server sim ticks at 30Hz with real Spring subsystems
- Entity state streaming (full snapshots + deltas) at ~10Hz
- Client renders team-colored boxes with interpolation on a heightmap terrain
- Auth flow (register/login with auto-create, session tokens)
- Player commands route through to CCommandAI
- Combat events collected from DoDamage and broadcast to clients
- Camera viewport filtering via QuadField

### What's built but disconnected
- **RoomManager** — fully implemented, not called from server_main
- **ScriptEventDispatcher** — instantiated but not registered with eventHandler
- **AIRuntimePool** — instantiated, ticked, drained, but no AIs added
- **StandingOrders** — evaluated every 30 ticks, but no orders ever created
- **WidgetManager / CommandBuffer / ScriptAPI** — implemented, not used in main.ts
- **ContentServer** — running, no client requests assets
- **AudioManager / CombatFX** — instantiated and wired to callbacks

### What's missing entirely
- Any UI beyond a status line
- Lobby screens (login, room browser, room setup)
- Game HUD (unit selection, minimap, command buttons)
- Unit model rendering (only boxes)
- Game-over detection and results
- Client-side input handling (click-to-select, right-click-to-command)
- Paper Tanks as a loadable game (currently uses generic "any movable unit")

---

## UI Architecture

### HTML over WebGL

The game UI will be built in HTML/CSS/JS layered over the WebGL canvas. This is the standard approach for browser games and has no performance penalty — the browser compositor handles layer composition natively.

**Layout stack (bottom to top):**
```
z-index 0:    <canvas id="game-canvas">     — Babylon.js WebGL
z-index 10:   <div id="game-hud">           — in-game HUD (health bars, minimap, command panel)
z-index 20:   <div id="chat-panel">          — chat overlay
z-index 100:  <div id="lobby-ui">            — lobby screens (hides during gameplay)
z-index 200:  <div id="modal-overlay">       — modals, dialogs
```

**Mouse click handling:**
- UI elements use `pointer-events: auto` and consume clicks normally
- Non-interactive UI regions use `pointer-events: none` to let clicks fall through to canvas
- The game canvas receives all clicks that don't hit a UI element
- On mousedown, record whether the click started on UI or canvas — this prevents drag operations from crossing the boundary
- Babylon.js's built-in `scene.onPointerObservable` handles canvas clicks for unit selection and commands

**Implementation:** Plain HTML/CSS with vanilla JS event handlers. No framework needed for the HUD. The lobby uses Svelte (already a project dependency per PLAN-lobby.md) for the more complex form-based UI.

---

## Task List

### Sprint 1: Playable Demo (no lobby)

Goal: One player connects, sees units fighting, can issue commands, sees combat effects.

**1.1 Wire up client input handling**
- Add click-to-select on entities (ray cast from camera through click position)
- Add right-click-to-command (move to ground position, attack if clicking enemy)
- Instantiate CommandBuffer in main.ts connected to the Connection
- Wire keyboard shortcuts (S = stop, A = attack-move, P = patrol)

**1.2 Basic game HUD**
- HTML overlay with: selected unit info panel, minimap placeholder, command buttons
- Show entity count and connection status
- `pointer-events: none` on the HUD container, `auto` on interactive elements

**1.3 Paper Tanks as a real game**
- Update Simulation::SetupTestGame to specifically load Paper Tanks unit defs by name
- Ensure Paper Tanks units have working weapons (weapon defs match unit weapon references)
- Verify units actually fight when in range (weapon targeting, firing, damage)

**1.4 Combat working end-to-end**
- Verify DoDamage → CombatEventCollector → broadcast → client CombatFX renders impacts
- Add muzzle flash effect (small sphere at attacker position on weapon fire)
- Test: two opposing units should fight and one should die

**1.5 Unit death and cleanup**
- Server: detect unit death, broadcast EntityDestroy message
- Client: handle EntityDestroy, remove mesh, spawn explosion effect
- Clean up delta cache for dead entities

### Sprint 2: Lobby Flow

Goal: Player opens browser → login screen → room browser → create/join room → game starts.

**2.1 Wire RoomManager into server_main**
- Add RoomCreate, RoomJoin, RoomLeave, RoomTeamSelect, RoomReady, RoomStartGame handlers to the message dispatch switch
- Send RoomStateUpdate to all players in a room when state changes
- Send RoomListUpdate to clients in the lobby
- Handle client disconnect: remove from room, clean up session

**2.2 Login screen**
- HTML form: username + password fields, login/register button
- On success: transition to lobby view, hide login
- On failure: show error message
- Store session token in localStorage for reconnection

**2.3 Room browser**
- Show list of available rooms (from RoomListUpdate messages)
- Each room shows: name, map, player count, state, has password
- "Create Room" button opens room creation form
- "Join" button joins the room (prompts for password if needed)

**2.4 Room setup screen**
- Show room name, map, player list with team assignments
- Team selection dropdown (or click to switch teams)
- Ready toggle button
- Host sees "Start Game" button (enabled when all ready)
- Chat within the room

**2.5 Game transition**
- When room state changes to LOADING: hide lobby UI, show game canvas
- Load terrain heightmap, wait for first entity state
- When room state changes to ACTIVE: enable game input
- When room state changes to ENDED: show results overlay

### Sprint 3: Game Completion

Goal: Full game loop — start → play → win/lose → return to lobby.

**3.1 Win condition detection**
- Server checks each tick: if all units of a team are dead, that team loses
- When only one team remains, transition room to ENDED
- Send GameOver event with winning team

**3.2 Results screen**
- Show winning team, unit kills/losses per player
- "Return to Lobby" button

**3.3 Spectator mode**
- Join a room as spectator (no team, no commands)
- Full visibility (no fog of war filtering)
- Can watch game in progress

**3.4 AI opponents**
- Wire AIRuntimePool.AddAI() when a room has AI slots
- Ship a basic Paper Tanks AI script: attack-move idle units toward nearest visible enemy
- AI commands flow through the normal command pipeline

### Sprint 4: Polish

**4.1 Register ScriptEventDispatcher properly**
- Call eventHandler.AddClient(scriptDispatcher) in InitScripting
- Verify GameFrame events flow through to LuaRules if loaded

**4.2 Real unit visuals (Phase 2 gap)**
- Replace box mesh with distinct shapes per unit type (cylinder for tanks, cone for scouts, etc.)
- Or: load simple .glb models via ContentServer for Paper Tanks units

**4.3 Minimap**
- Render a small top-down view of the map in an HTML canvas element
- Show unit positions as colored dots
- Click on minimap to move camera

**4.4 Sound effects**
- Load basic sounds (cannon fire, explosion, movement) via AudioManager
- Play positional audio on combat events
- Background ambient sound

---

## Order of Implementation

```
Sprint 1 (playable demo):   1.1 → 1.3 → 1.4 → 1.5 → 1.2
Sprint 2 (lobby):           2.1 → 2.2 → 2.3 → 2.4 → 2.5
Sprint 3 (game loop):       3.1 → 3.2 → 3.3 → 3.4
Sprint 4 (polish):          4.1 → 4.2 → 4.3 → 4.4
```

Sprint 1 comes first because it validates that the core game loop works before building lobby UI around it. No point having a lobby that launches a broken game.
