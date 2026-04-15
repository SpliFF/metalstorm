# JavaScript API Reference

Runtime interfaces exposed on `window` for debugging, automation, and AI agent integration.

## `window.lobby` — Lobby UI

The `LobbyUI` instance. Available after page load completes.

### State (read-only)

| Property | Type | Description |
|----------|------|-------------|
| `lobby.screen` | `string` | Current screen: `'login'`, `'browser'`, `'room'` |
| `lobby.token` | `string` | Auth token (empty if not logged in) |
| `lobby.playerId` | `number` | Current player's ID |
| `lobby.room` | `object\|null` | Current room: `{ id, name, mapName, gameName, state, players, aiSlots, gameServerPort }` |
| `lobby.roomList` | `array` | All visible rooms: `[{ id, name, mapName, playerCount, maxPlayers, state, hostName }]` |
| `lobby.maps` | `array` | Available maps: `[{ id, name, mapx, mapy, widthElmos, heightElmos, startPositions? }]` |
| `lobby.games` | `array` | Available games: `[{ id, displayName, description, version }]` |
| `lobby.ais` | `array` | Available AIs for current game: `[{ id, displayName, description, isEngineProvided }]` |

Room state values: `1`=Waiting, `2`=Ready, `3`=Starting, `4`=Active, `5`=Ended.

### Room lifecycle

```js
await lobby.createRoom(name, mapId)   // Create and enter a room
await lobby.joinRoom(roomId)          // Join an existing room
await lobby.leave()                   // Leave current room
await lobby.closeRoom()               // Host: delete room, boot everyone
```

### Game setup

```js
await lobby.addAI(aiId, team)         // Add AI player (team is 0-indexed)
await lobby.removeAI(slotIndex)       // Remove AI by slot index
await lobby.setAITeam(slotIndex, team)
await lobby.teamSelect(team)          // Set own team
await lobby.setStartPos(target, pos)  // target: {kind:'self'} | {kind:'player',playerId} | {kind:'ai',slotIndex}
await lobby.ready(true)               // Toggle ready state
await lobby.startGame()               // Host only — launch game server
await lobby.endGame()                 // Host only — stop running game
```

### Data refresh

```js
await lobby.refreshGameList()         // Re-fetch available games
await lobby.refreshAIList()           // Re-fetch AIs for current game
```

### Low-level HTTP

```js
await lobby.lobbyPost(path, body)     // POST with auth header, returns parsed JSON
await lobby.lobbyGet(path)            // GET, returns parsed JSON or null
```

### Quick-start recipe

Create a room, add an AI opponent, and start a game in one block:

```js
// Pick game and map
const game = lobby.games[0].id;       // e.g. 'papertanks' or 'zk'
const map = lobby.maps[0].id;

await lobby.createRoom('test', map);
await lobby.addAI('null', 1);        // AI on team 2 (0-indexed = 1)
await lobby.ready(true);              // Host must ready up
await lobby.startGame();              // Launches game server
```

**Requirements for starting a game:**
1. The room must have players on at least 2 teams
2. The host must be in Ready state
3. Then `startGame()` will succeed

### Selecting a specific game

Set `lobby.selectedGameId` before calling `createRoom` if you want to override the dropdown:

```js
// Not needed if the dropdown already shows the right game — createRoom
// reads from the internal selectedGameId which defaults to the first game.
// The createRoom() call sends whatever selectedGameId is set to.
```

## `window.debugConsole` — Debug Console

The in-game debug console (opened with backtick `` ` ``). Provides:

| Method | Description |
|--------|-------------|
| `debugConsole.toggleInspector()` | Toggle the network inspector panel |

The debug console also supports tabbed scopes (LuaRules, LuaGaia, server, lobby, sql) for executing commands against the running game server.

## Using from automation tools

### Chrome DevTools MCP (`evaluate_script`)

```js
// In evaluate_script:
await lobby.createRoom('test', 'pools_of_ilys_1.0.0');
```

### Browser console

All `window.lobby` methods are available directly in the browser console (F12 → Console tab).

### Checking state

```js
// Is a game running?
lobby.room?.state === 4

// What map?
lobby.room?.mapName

// How many players?
lobby.room?.players.length

// Am I authenticated?
lobby.token !== ''
```
