# E2E Debug Testing Analysis — Pain Points & Recommendations

**Date:** 2026-04-14
**Context:** End-to-end testing of HTTP/2 migration across all debug/control surfaces

## Test Matrix Summary

| Surface | Status | Notes |
|---------|--------|-------|
| REST API (curl HTTP/1.1) | PASS | All 36 endpoints verified |
| REST API (curl HTTP/2 h2c) | PASS | All endpoints work via `127.0.0.1` |
| springcli (GET commands) | PASS | `get`, `logs`, `processes` work |
| springcli (POST commands) | FAIL | `sql`, `exec` hang — h2c POST bug in libspringapi |
| Chrome game interface | BLOCKED | Chrome extension not connected |
| Browser JS debug console | BLOCKED | Requires browser context |
| In-game console | BLOCKED | Requires running game + browser |
| MCP debug server (read tools) | PASS | `get_logs`, `list_processes`, `list_sessions` work |
| MCP debug server (exec tools) | FAIL | `exec_lua`, `query_db` still expect WebSocket |
| MCP debug server (search) | PARTIAL | `search_logs` returns empty (ring buffer vs SQLite mismatch) |

---

## Pain Points

### P1: libspringapi h2c POST requests hang (Critical)

**Symptom:** `springcli sql "SELECT ..."` and any `exec` command hang indefinitely.

**Root cause:** The nghttp2 client in `libspringapi/src/http.cpp` sends POST requests via h2c but the response is never received. GET requests work fine. The issue is in the `h2cRequest()` function — likely the POST body data provider or the request submission flow doesn't complete the stream correctly.

**Impact:** springcli can only use GET endpoints (logs, processes, raw get). All POST-based commands (exec, sql, login via cli flags) fail. The HTTP/1.1 fallback should trigger after the 10-second h2c timeout but the process is killed first.

**Workaround:** Use `SPRING_TOKEN` env var (avoids login POST) and `springcli get <url>` for GET endpoints. Or use curl directly.

**Recommendation:** Debug the nghttp2 client session — add frame-level logging to trace what frames are sent/received. The POST body data provider callback may not be called during `nghttp2_session_send()`, or the END_STREAM flag may not be set correctly on the request.

### P2: IPv6 vs IPv4 — `localhost` resolves to `::1` first (Medium)

**Symptom:** `curl --http2-prior-knowledge http://localhost:8010/api/logs/sources` fails, but `http://127.0.0.1:8010/...` works.

**Root cause:** The server binds to `INADDR_ANY` (IPv4 only, `AF_INET`). On macOS, `localhost` resolves to `::1` (IPv6) first. curl connects via IPv6 but the server isn't listening on IPv6.

**Impact:** Any h2c client that resolves `localhost` to IPv6 won't connect. HTTP/1.1 curl sometimes works because it tries both and falls back.

**Workaround:** Use `127.0.0.1` explicitly.

**Recommendation:** Bind to `AF_INET6` with `IPV6_V6ONLY=0` (dual-stack) so the server accepts both IPv4 and IPv6 connections. Or create two listen sockets (one per protocol).

### P3: MCP debug server uses WebSocket for exec/query_db — removed (Critical)

**Symptom:** `exec_lua` and `query_db` tools return "requires WebSocket connection" errors.

**Root cause:** The MCP server (`tools/debug-mcp/server.js`) was written when game server communication used WebSocket. The exec and SQL tools use a WebSocket connection to send ConsoleCommand FlatBuffer messages. WebSocket has been removed — these operations are now HTTP POST to `/api/exec`.

**Impact:** Two of the most useful MCP tools don't work. Claude can query logs but can't execute commands or run SQL through the MCP interface.

**Recommendation:** Rewrite `exec_lua` and `query_db` in the MCP server to use `fetch()` against the HTTP `/api/exec` endpoint with Bearer auth. The auth token can be obtained via `/api/auth/login` at MCP server startup.

### P4: Chrome browser extension not connected (Blocked)

**Symptom:** `mcp__claude-in-chrome__tabs_context_mcp` returns "Browser extension is not connected."

**Root cause:** The Claude Chrome extension needs to be installed and active. It wasn't connected during this test session.

**Impact:** All browser-based testing blocked — cannot verify the game UI, lobby, in-game debug console, SSE log streaming in the browser, or WebRTC game connection.

**Workaround:** None. Browser testing requires manual intervention or a properly configured Chrome extension session.

**Recommendation:** For automated testing, replace Chrome extension dependency with Playwright or Puppeteer. These headless browser tools provide the same DOM interaction and network inspection without requiring an extension.

### P5: SSE log stream has no test data (Minor)

**Symptom:** SSE stream endpoint `/api/logs/stream` connects and holds open, but no events are delivered during the test window.

**Root cause:** The SSE log push is implemented via a custom log sink callback in the logserver. During testing, the log server's own logs go to stdout/file sinks, not through the SSE channel. No game server was running to generate log traffic to push.

**Impact:** Cannot verify end-to-end SSE delivery without a running game generating log output.

**Recommendation:** Add a test endpoint `POST /api/logs/test-event` that generates a synthetic log entry and pushes it to SSE subscribers. This enables automated SSE testing without needing a full game.

### P6: Log server search returns empty despite data in SQLite (Minor)

**Symptom:** `search_logs` MCP tool and logserver `/api/logs/search` return empty results, but `/api/logs/0` returns entries from SQLite.

**Root cause:** The search endpoint queries the in-memory ring buffer first. The ring buffer only contains entries received via the network ingest pipeline (WebSocket from game servers). Log entries written directly to SQLite by the lobby's SpringLogSqlite sink are not in the ring buffer.

**Impact:** Search only works for entries received via the network ingest pipeline, not for entries that come from local SQLite logging.

**Recommendation:** Fall back to SQLite `LIKE` search when the ring buffer search returns empty, similar to how the `/api/logs/:roomId` endpoint already does.

### P7: springcli option parsing — options must follow command (Minor)

**Symptom:** `springcli --lobby http://... sql "query"` fails with "Unknown command: --lobby". Must be `springcli sql "query"` with `SPRING_LOBBY` env var or no server override.

**Root cause:** The CLI parser expects `argv[1]` to be the command name. Options before the command are treated as the command name.

**Impact:** Less intuitive CLI usage. User must set env vars or place options after the command.

**Recommendation:** Parse global options (--lobby, --server, --log-server, --user, --pass, --token) before extracting the command. Use a standard option parser library (e.g. CLI11 or cxxopts).

---

## Summary Statistics

- **6 test surfaces attempted**
- **3 fully passing** (REST API, springcli GET, MCP read tools)
- **1 partially passing** (springcli — GET works, POST hangs)
- **3 blocked** (Chrome interface, JS console, in-game console — all need browser)
- **1 partially passing** (MCP — read tools work, exec/query broken)
- **7 pain points identified** (2 critical, 1 medium, 1 blocked, 3 minor)

---

## Fix Verification (2026-04-14)

All 7 pain points fixed and verified:

| Issue | Fix | Status |
|-------|-----|--------|
| P1: h2c POST hang | Dangling string pointers in nghttp2 nv headers — stored all header value strings in named variables | PASS |
| P2: IPv6/IPv4 | Switched listen socket from `AF_INET` to `AF_INET6` with `IPV6_V6ONLY=0` (dual-stack) | PASS |
| P3: MCP WebSocket | Rewrote exec_lua, query_db, list_gadgets, get_game_state, list_units to use HTTP POST `/api/exec` with Bearer auth | PASS |
| P5: SSE test data | Added `POST /api/logs/test-event` that generates synthetic log entry and pushes to SSE | PASS |
| P6: Log search | Added SQLite `LIKE` fallback when ring buffer search returns empty | PASS |
| P7: CLI option order | Pre-parse all `--option` args before extracting command; find command as first non-option arg | PASS |
| P4: Chrome extension | Not a code issue — requires Chrome extension to be connected | N/A |
