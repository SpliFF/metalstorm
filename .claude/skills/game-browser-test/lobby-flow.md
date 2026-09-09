# game-browser-test reference — the lobby-flow path (testing the lobby UI itself)

Split out of [SKILL.md](SKILL.md) (2026-09-10). Only for testing the login
form, room browser, create/join and `launch_game` regressions — for any
scenario/game test, `launch_scenario({openBrowser:true})` skips all of it.

## Lobby-flow path (testing the lobby UI itself)

> Everything from here down is for testing **the lobby UI** — login form, room
> browser, `launch_game` regressions. For scenario/game testing,
> `launch_scenario` + its `browserUrl` skips all of it.

**Discipline — track your own game, every time:**

1. **Own the roomId.** Capture the `roomId` that *your* `launch_game`
   returns and only ever `joinRoom(thatId)`. Never `joinRoom` a room you
   didn't create, and never assume "the first/only game" is yours —
   `list_processes` may show several. Joining another session's room fails
   the roster check (`Not in this room's roster`) and, worse, could attach
   you to the wrong game.
2. **Match credentials to the roster.** The browser auto-logs in as
   `test1`; `launch_game` must run as the **same** user (`username:'test1',
   password:'test'`). Don't mix an `admin` browser with a `test1` game or
   vice-versa — the roster is per-account (note: `test1` now carries the
   **admin** role too, so role isn't the discriminator — the account is).
   Dev accounts: `test1`/`test`, `admin`/`admin`. These are known by
   convention — `users.password_hash` holds a **scrypt** digest
   (`scrypt$32768$8$1$…`), so don't try to read passwords out of the table.
3. **Fresh-login before the first join.** The stale auto-login token in a
   fresh isolated profile causes `[connection] auth failed: no valid
   token`. Do a credential login and attach it *before* joining:
   ```js
   const r = await fetch(`${location.origin}/api/auth/login`, {
     method:'POST', headers:{'Content-Type':'application/json'},
     body: JSON.stringify({ username:'test1', password:'test' }) });
   const d = await r.json();                 // note: snake_case user_id
   lobby.attachSession(d.token, d.user_id, d.username);
   ```
4. **Launch, then join immediately — no churn.** `launch_game({...})` →
   grab `roomId` → `lobby.joinRoom(roomId)` right away. A `leave()`/rejoin
   dance after a failed attempt yields `Not in this room's roster`; start
   clean instead. Pick one identity and one room-creation path and stick with
   it — the most reliable browser flow is to create the room **in-browser as
   the already-logged-in user** (`createRoom` → `addAI` → `ready(true)` →
   `startGame`), where the host is always in the roster. Confirm the client
   came up with `await test.readyState()`.
5. **Clean up only your rooms.** `end_game(yourRoomId)` when done. Never kill
   or restart a room you didn't launch — the verb *requires* the roomId and
   refuses with a candidate list without one. In-browser,
   `await window.lobby.leave()` — the player-facing lifecycle is leave-only.
6. **Scope log reads to your room.** `get_logs` and `search_logs` default
   to all rooms — with concurrent sessions that buries your entries. Always
   pass `roomId: <yourRoomId>`.

### Lobby JS API (`window.lobby`)

The `LobbyUI` instance is exposed on `window.lobby`. All lobby actions can be called directly from JS (via `evaluate_script` or browser console) — full reference: [docs/javascript.md](../../../docs/javascript.md#windowlobby--lobby-ui):

```js
// Room lifecycle
await lobby.createRoom('test', 'scorched_crossing_v2.4')  // name, mapId, scenarioId?
await lobby.joinRoom(1)                                  // roomId
await lobby.leave()

// Game setup
await lobby.addAI('null', 1)        // aiId, team (0-indexed)
await lobby.teamSelect(0)           // team for self
await lobby.ready(true)             // toggle ready state
await lobby.startGame()             // host only, requires ready + 2 teams

// Low-level
await lobby.lobbyPost('/api/rooms/start')
await lobby.lobbyGet('/api/rooms')
```

Quick-start a game from scratch in one script block:

```js
await lobby.createRoom('test', 'scorched_crossing_v2.4');  // or lobby.maps[0].id
await lobby.addAI('null', 1);   // AI on team 2 (index 1) — game needs 2 teams
await lobby.ready(true);         // host must ready up
await lobby.startGame();         // launches the game server
```

### Test flow: Login and room creation

```
1. Navigate to http://localhost:8012 (Vite dev server)
2. Fill #login-user with username, #login-pass with password
3. Optionally fill #login-pass2 (and #login-faction — required) for registration
4. Submit the login form
5. Verify "Game Rooms" heading appears (browser screen)
6. Use lobby JS API to create room, add AI, ready up, and start
```

### Test flow: Network verification (HTTP/2)

```
1. Navigate to the game client
2. list_network_requests → find /api/version, /api/maps
3. get_network_request → verify response headers:
   - Access-Control-Allow-Origin: *
   - X-Build-Stamp: <hash>
   - Cache-Control: appropriate value
4. After login, verify the `/api/rooms/stream` SSE opened (`content-type: text/event-stream`; there is no 2 s `/api/rooms` poll any more — `lobby-ui.ts` opens an `EventSource`)
5. After game start, verify the client fetched `GET :<game-port>/api/wt/info` (WebTransport endpoint discovery — WebRTC and `/api/rtc/*` were removed in GW7)
```

### Test flow: Debug console + SSE

```
1. Press backtick (`) to open debug console
2. Verify console panel appears
3. list_network_requests → find /api/logs/stream (SSE)
4. get_network_request → content-type: text/event-stream
5. evaluate_script → check EventSource readyState === 1 (OPEN)
```
