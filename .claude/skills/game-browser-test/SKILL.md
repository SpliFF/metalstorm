---
name: game-browser-test
description: Test the Spring RTS Web game client in Chrome. Use when verifying the lobby UI, game rendering, network traffic, debug console, or WebRTC connections in the browser.
when_to_use: Use when testing the browser client, verifying login flow, checking network requests, inspecting game state in Chrome, taking screenshots, or running Lighthouse audits.
user-invocable: false
---

# Browser Testing for Spring RTS Web

Two MCP servers provide browser automation (both declared in `.mcp.json`):

## chrome-devtools (Chrome DevTools MCP)

Full Chrome DevTools Protocol access via Puppeteer. Best for network inspection and performance analysis.

Key tools for game testing:

| Tool | Use for |
|------|---------|
| `navigate_page` | Load `http://localhost:5173` (Vite dev) or `http://localhost:8012` |
| `fill` / `click` | Fill login form, click buttons |
| `take_screenshot` | Capture visual state at each test step |
| `take_snapshot` | Get page DOM/accessibility tree |
| `list_network_requests` | Verify HTTP/2 vs HTTP/1.1, check CORS headers, find SSE connections |
| `get_network_request` | Inspect specific request/response (headers, status, body) |
| `evaluate_script` | Run JS in page context — check game state, connection status |
| `list_console_messages` | Find errors, warnings, game log output |
| `performance_start_trace` / `performance_stop_trace` | Profile render performance during gameplay |
| `lighthouse_audit` | Run Lighthouse for performance/accessibility checks |

## claude-in-chrome (Claude Chrome Extension)

Available when the Claude Chrome extension is connected. Simpler API, works with the user's active browser.

Key tools: `read_page`, `javascript_tool`, `form_input`, `computer` (click/type/screenshot), `read_console_messages`, `read_network_requests`.

## Which to use

| Scenario | Prefer |
|----------|--------|
| Network-level verification (HTTP/2, headers) | chrome-devtools |
| Performance profiling | chrome-devtools |
| Interactive debugging with user watching | claude-in-chrome |
| Headless CI testing | chrome-devtools (with `--headless`) |
| Quick screenshot of current state | either |

## Test flow: Login and room creation

```
1. Navigate to http://localhost:5173 (or whichever port Vite is on)
2. Fill #login-user with username, #login-pass with password
3. Optionally fill #login-pass2 for registration
4. Submit the login form
5. Verify "Game Rooms" heading appears (browser screen)
6. Click "+ New Game" to create a room
7. Verify room state in the room view
```

## Test flow: Network verification (HTTP/2)

```
1. Navigate to the game client
2. list_network_requests → find /api/version, /api/maps
3. get_network_request → verify response headers:
   - Access-Control-Allow-Origin: *
   - X-Build-Stamp: <hash>
   - Cache-Control: appropriate value
4. After login, verify /api/rooms polling starts (2s interval)
5. After game start, verify /api/rtc/offer WebRTC signaling request
```

## Test flow: Debug console + SSE

```
1. Press backtick (`) to open debug console
2. Verify console panel appears
3. list_network_requests → find /api/logs/stream (SSE)
4. get_network_request → content-type: text/event-stream
5. evaluate_script → check EventSource readyState === 1 (OPEN)
```

## Prerequisites

- Vite dev server running: `cd client && npx vite`
- Lobby server running: `./build/debug/spring-lobby --port 8011 ...`
- Log server running (for SSE): `./build/debug/spring-logserver --port 8010`
