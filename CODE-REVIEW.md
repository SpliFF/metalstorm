# Code Review — springrts-web

## Status update (2026-07-30, quality review)

Full codebase review for quality issues. **All P0 security issues from the June review are resolved.** The architecture is sound — clean server/client separation, well-designed WebTransport layer, strong debugging infrastructure. Remaining concerns cluster in TypeScript type safety, large monolithic files, and non-functional CI.

**Previously identified — now resolved:**

- **S1** passwords: scrypt via `rts/Server/Crypto.{h,cpp}` ✅
- **S2** console/exec: admin role gate ✅
- **S3** tokens: `Crypto::GenerateToken` (RAND_bytes) ✅
- **S4** SQL injection: prepared statements ✅
- **S5** resource limits: MAX_REQUEST_BODY + MAX_CONNECTIONS ✅
- **S6** raw token fallback: removed ✅
- **S7** path traversal: segment-wise rejection ✅
- **C1** protocol handshake: `CURRENT_PROTOCOL_VERSION` enforced ✅
- **B2** test-cpp: builds `spring-tests`, runs ctest ✅
- **Q1** server_main.cpp: reduced from ~3,000 → 1,425 lines (partial)
- **Q2** lua-widget-worker.ts: split into `game-processor.ts` (3,838) + `lua-ui-host.ts` (6,198) + `lua-widget-worker.ts` (850) (partial)

**Still open from prior review:**

- **B7** `NOT_USING_CREG` contradicts "creg is kept" design decision — `CMakeLists.txt:36` globally defines `NOT_USING_CREG` while AGENTS.md says creg is retained for save/load. If the macro stubs creg out, snapshot serialization is silently broken.
- **C12** Database not thread-safe — `Database.h` has no mutex; game server's WebTransport thread and HTTP thread can both call `ValidateSession` concurrently.

**New findings:**

**T1. TypeScript strict mode off** — `client/tsconfig.json` lacks `strict`, has `noUnusedLocals: false`, `noUnusedParameters: false`. Allows null dereferences, unused variables, implicit any to ship silently. **Fix:** Enable `strictNullChecks` first (highest value), then add Biome with `noExplicitAny` as warning.

**T2. Extensive `any` usage** — 25+ instances in critical paths: `defs-fetch.ts` (15× in def parsing), `entity-renderer.ts` (glTF parsing), `terrain.ts`/`lua-gl-bridge.ts` (WebGL extension casts). These bypass type checking in the network decode path.

**T3. `as any` window globals** — 10+ instances of `(window as any).foo` for debug APIs (`test`, `widgets`, `springrts`, `lobby`, `debugConsole`, `camera`). Bypass type checking entirely, create implicit global contracts. **Fix:** Declare a proper `Window` interface extension.

**T4. No linter** — No ESLint or Biome configured. `@typescript-eslint/no-explicit-any` suppressions in comments suggest awareness but no enforcement.

**CI1. Workflows won't run** — `.github/workflows/engine-build.yml:60` gates on `github.repository == 'beyond-all-reason/RecoilEngine'`. This fork's pushes/PRs trigger nothing. No project-specific CI workflow exists. **Fix:** Add one minimal workflow (Ubuntu + macOS matrix) that runs `cmake --preset debug && cmake --build build/debug --target spring-tests && ctest` + `cd client && npx tsc --noEmit && npx vitest run`. Delete or archive inherited RecoilEngine workflows.

**CI2. QUIC deps Homebrew-only** — `CMakeLists.txt:120-138` uses pkg-config with hardcoded `/opt/homebrew` paths. Linux/CI builds fail at configure. The `SPRING_QUIC_FETCHCONTENT` fallback mentioned in comments doesn't exist. **Fix:** Implement FetchContent fallback with pinned tags.

**C++1. Manual memory management in WebTransport** — `WebTransportServer.cpp:679-781` uses raw `new WtConn()` / `delete c` with multiple early-return cleanup paths. A missed `delete` on any error path leaks. **Fix:** Use `std::unique_ptr<WtConn>` with custom deleter for OpenSSL/ngtcp2 resources.

**C++2. Compiler warnings globally suppressed** — `CMakeLists.txt:55` has `add_compile_options(-Wno-unused-variable -Wno-unused-function -Wno-sign-compare)`. Hides real issues in new code. **Fix:** Apply suppressions only to legacy sim targets, not `rts/Server/*`.

**Large files still exist** — Several files exceed reasonable size: `lua-ui-host.ts` (6,198), `lua-spring-api.ts` (4,393), `game-processor.ts` (3,838), `lua-gl-bridge.ts` (3,132), `connection.ts` (2,734), `entity-renderer.ts` (2,765), `projectile-renderer.ts` (2,773). The split of `lua-widget-worker.ts` was a good start; same pattern could apply to `lua-ui-host.ts` (extract VFS, widget manager, command buffer).

**CL1. Console logging without structure** — 25+ `console.log/warn/error` calls scattered through rendering code. Pollute browser console in production. **Fix:** Route through existing `logIngest` / `debugConsole` infrastructure with levels.

**CL2. TODOs in production code** — 15+ TODO comments in shipped code paths (`train-presentation.ts:206`, `impostor-renderer.ts:305`, `build-beam-renderer.ts:220`). Fine as tracked work items but should reference PLAN files or issue numbers.

**Suggested priority:**

1. Enable `strictNullChecks` — one tsconfig change, catches null bugs immediately
2. Add minimal CI workflow — blocks regressions on every PR
3. Fix `NOT_USING_CREG` contradiction — either remove the define or update the design doc
4. Add Database mutex — small change, prevents a race condition
5. Add Biome linter — enforce `noExplicitAny` as warning, unused vars as error
6. Extract WebTransport cleanup to RAII — prevents leaks on error paths

---

## Status update (2026-06-11, P0-security + C1 + B2 batch)

Landed the spec-prerequisite batch (builds green: spring-server, spring-lobby, spring-tests; ctest + client tsc pass). **Resolved:**

- **S1** passwords: new `rts/Server/Crypto.{h,cpp}` (OpenSSL scrypt + RAND_bytes); register/login in `HttpAuth.h` and the game-server `AuthRequest` path now hash, verify, and transparently rehash legacy plaintext on next login (`Database::UpdatePasswordHash`). `tests/test_crypto.cpp` covers round-trip + legacy + malformed.
- **S3** tokens: both `std::mt19937` generators (HttpAuth + ClientMessageHandler) replaced by `Crypto::GenerateToken` (RAND_bytes), fail-closed on RNG error.
- **S6** removed the raw-token auth fallback in `ValidateAuth`.
- **S2** console/exec gated on the **admin** role — `ConsoleCommand` (ClientMessageHandler), lobby `/api/exec`, and game `/api/exec` (GameHttpRoutes). Admin provisioning **decided (CLI promote subcommand):** `spring-lobby --promote-admin <user>` grants the role to an already-registered account and exits (one-shot, never creates, never auto-elevates on boot) via `Database::EnsureAdminRole`. The shared `data/spring-server.db` `admin` account has been promoted so the MCP `admin/admin` flow keeps working. Exit 0 on success/idempotent, 1 on missing account.
- **S5** resource limits: `MAX_REQUEST_BODY` (8 MB → 413) + `MAX_CONNECTIONS` (1024) in `NetworkServer` (H1 buffer + Content-Length + H2 body via RST_STREAM + accept cap); `kMaxControlMsg` (4 MB) + `kMaxWtConnections` (512) in `WebTransportServer` (control-bidi length gate + AcceptConn cap).
- **S7** `ContentServer` rejects `..`/absolute asset keys (segment-wise, 403) for defence in depth.
- **C1** handshake **enforced**: `CURRENT_PROTOCOL_VERSION` (Protocol.h) ↔ `PROTOCOL_VERSION` (connection.ts) ↔ documented in protocol.fbs. Client now sends `Handshake` ahead of `AuthRequest`; server validates version and gates `AuthRequest` on a recorded compatible handshake (`handshakedClients` set, cleared on disconnect). Mismatch / missing handshake → `AuthStatus.VersionMismatch`; client closes on auth failure (no cross-thread server close added — the message handler runs on the sim thread).
- **B2** `make test-cpp` now builds `spring-tests` (not the game server) and runs `ctest`; `enable_testing()` + `add_test` wired; `spring-tests` link fixed (added `PlayerTeamEventCollector.cpp`; also pulls `Crypto.cpp` + `openssl_crypto`).

**Adjacent fix folded in:** game `/api/restart` (GameHttpRoutes) — previously **unauthenticated** — now requires the admin role (same gate as `/api/exec`). The lobby restart path is the admin-gated `/api/exec` `lobby restart` command (no separate unauthenticated endpoint).

---

## Status update (2026-06-10, post PLAN-refactor-p3)

PLAN-refactor-p3 landed (7 commits, gated). **Resolved:** S4 (lobby SQL injection + snprintf truncation — prepared statements), C7 (ESC guard), C8 (resize leak), Q1 (`server_main.cpp` 3060→1073, decomposed into 5 Server/ units; ≤500 was unreachable given the stay-list), Q2 (worker split: 680-line typed entry + game-processor/lua-ui-host/worker-vfs/gp-context), Q3 (selection-core + storage:set consolidation incl. the dropped-persistence bug; input-manager deprecated, port still owed), Q4 lobby half (nlohmann/json in lobby_main + /api/exec), Q5 (dead code incl. libspringapi rtc.cpp = old finding 17 of the build review), B11 (analysis-debug.md), finding 21 (ValidateSession DB-fault logging).

**New finding:** `spring-tests` target fails to link (`playerTeamEvents` defined in a TU the test target omits) — pre-existing, surfaced by gating builds per-target. Fold into the B2 fix (test target + CTest wiring).

**Highest-leverage remaining:** the P0 security batch (S1–S3, S5–S7); **C1 handshake enforcement — now load-bearing for three specs** (PLAN-state-change Phase 5, PLAN-latency-impl L2/L3 schema work both gate on it); B1 CI (+B3 QUIC FetchContent), B2/spring-tests link, B6 serializer golden tests, B5 strict/warnings. Manual checks still owed from the refactor: visual smoke (chili, custom-shader world widget, drag-box/minimap/audio) and the two WP3 persistence-reload checks (show-allies pref, chili volume trackbar).

---

Date: 2026-06-10. Scope: new server C++ (`rts/Server`, `rts/System/Scripting`, `rts/System/SpringLog`, entry points), client TypeScript (`client/src`), build/tests/protocol/repo hygiene. Inherited legacy Spring sim code excluded. High-severity findings were verified directly against source; line numbers are current as of review date.

## Executive summary

The architecture is in good shape — the GW1–GW8 worker consolidation landed cleanly, the protocol design is coherent, and the debugging infrastructure is unusually strong. The biggest problems cluster in three areas:

1. **Security is pre-production grade.** Plaintext passwords, no permission check on console commands, predictable session tokens, one SQL injection, no request-size or connection limits. Fine for a dev sandbox; all must be fixed before any public exposure.
2. **Safety nets are missing.** No working CI, `make test-cpp` runs the wrong binary, TypeScript strict mode is off, no compiler warnings enabled, no linter, the protocol version handshake isn't enforced, and the byte-level serializers (the highest-risk code for silent desync) have no round-trip tests.
3. **Two god files.** `server_main.cpp` (~3,000 lines) and `lua-widget-worker.ts` (~8,300 lines) each absorb everything around them and will slow every future change.

---

## P0 — Security (fix before any non-local deployment)

### S1. Passwords stored and compared in plaintext — HIGH

`rts/Server/HttpAuth.h:153,187` — `user->passwordHash == password` compares the raw POST field against a stored value that was never hashed (the field name is aspirational). Anyone with the SQLite file — including via the SQL query proxy — has every account.
**Fix:** Hash with Argon2id or bcrypt at registration and login. One-time migration: rehash on next successful login.

### S2. ConsoleCommand has no permission check — HIGH

`rts/server_main.cpp:1826–1834` — any authenticated client (player or spectator) can push arbitrary code to `LuaExecEngine` in `LuaRules`/`server` scope: spawn units, pause, change speed, run Lua. The HTTP `/api/exec` path validates a token but also never checks role. This directly contradicts AGENTS.md's stated design ("privileged actions… gated behind a permissions system").
**Fix:** Gate on `session->role == "admin"` (or per-scope role mapping) before `luaExecEngine.Push`. `ScriptPermissions.h` already exists as the home for this.

### S3. Session tokens generated with `std::mt19937` — HIGH

`rts/Server/HttpAuth.h:20` and a duplicate in `rts/server_main.cpp:118`. mt19937 state is recoverable from observed outputs; tokens are predictable.
**Fix:** Use OpenSSL `RAND_bytes` (already linked for the QUIC cert). Delete the duplicated `generateToken` in `server_main.cpp` and call one shared implementation.

### S4. SQL injection in lobby `persistGameServer` — HIGH

`rts/lobby_main.cpp:413–419` — `snprintf` interpolates `mapId`/`gameId` (origin: HTTP POST body) directly into an `INSERT`. The 512-byte buffer also truncates silently.
**Fix:** Prepared statement with `sqlite3_bind_text`, same as the rest of `Database.cpp`.

### S5. No resource limits on network input — HIGH

- HTTP/1.1 and HTTP/2 body buffers grow unbounded (`rts/Server/NetworkServer.cpp:373,474`).
- No connection-count cap on either `NetworkServer` or `WebTransportServer`.
- WebTransport control-bidi framing trusts the client's `u32` length with no maximum before allocating.

**Fix:** `MAX_REQUEST_BODY` (~1 MB) → 413; `MAX_CONNECTIONS` guards in both accept paths; `MAX_MSG_SIZE` check before buffer allocation in `ProcessControlBidi`.

### S6. Auth fallback accepts raw tokens — MEDIUM

`rts/Server/HttpAuth.h:157–159` — an `Authorization` header that is neither `Bearer` nor `Basic` is validated directly as a session token. Remove the fallback.

### S7. ContentServer asset keys not checked for `..` — MEDIUM

`rts/Server/ContentServer.cpp:34–68` — lookup is manifest-bound so exploitation is limited, but add an explicit `..`-segment rejection for defence in depth (the decode happens upstream in `NetworkServer`, so the check there doesn't cover this path's assumptions).

---

## P1 — Correctness

### C1. Protocol version handshake logged but never enforced — CRITICAL for ops

`rts/server_main.cpp:1203–1209` — `protocol_version` is read, logged, and ignored. A cached old JS bundle is silently accepted against a changed schema — exactly the failure the Resolved Design Decisions table says this handshake exists to prevent. All the pieces (`Handshake` field, `AuthStatus` reject path) exist.
**Fix:** `constexpr uint16_t CURRENT_PROTOCOL_VERSION`; compare; reject with a version-mismatch `AuthResponse` and close.

### C2. RoomManager returns raw pointers used outside the lock — HIGH

`rts/Server/RoomManager.h` (`GetRoom`/`GetAllRooms`) release the mutex before callers (`roomToJson`, `broadcastRooms` at `lobby_main.cpp:1056–1068`) dereference. Currently saved only by single-threaded HTTP; any future thread (or the 10 Hz main-loop reaper racing a handler) makes this use-after-free.
**Fix:** Return `GameRoom` by value, or copy under lock inside `GetAllRooms`.

### C3. Wire-format width truncations — MEDIUM

- `EntityStateSerializer.cpp:149` casts `unitDef->id` (int) to `u16` — silently wrong past 65,535 defs (multi-game MMORTS makes this reachable).
- `ProjectileStateSerializer.cpp:58` casts projectile count to `u16` — wraps past 65,535 live projectiles, producing a malformed frame.

**Fix:** Widen to `u32` at the next protocol bump (cheap; you control both ends), or at minimum assert at startup / cap with a warning.

### C4. HTTP/1.1 body extraction re-scans for `\r\n\r\n` — MEDIUM

`NetworkServer.cpp:419` — a POST body containing `\r\n\r\n` yields a wrong body offset. Store the header-end offset from the parse pass on `ServerConn` and reuse it.

### C5. `ExecSync` blocks the single HTTP thread for up to 5 s — MEDIUM

`LuaExecEngine.h:55–87` via `/api/exec`. A paused/slow sim stalls all HTTP including SSE keep-alives. Shorten the timeout and/or move to async submit + result poll.

### C6. nghttp2 header lifetime pattern is fragile — MEDIUM

`NetworkServer.cpp:574–594` — currently safe (dynamic values are copied), but the mixed `NO_COPY_*` flags invite a future use-after-free; `resp.contentType`/`cacheControl` point into a stack-local `HttpResponse`. Always copy, or document ownership explicitly. Related: HEAD responses should test `stream.responseBody.empty()` not `resp.body.empty()` (`:592`).

### C7. Client: stale `engine` guard permanently disables ESC handler — HIGH

`client/src/main.ts:783` — `if (!engine) return;` but post-GW4 the main-thread `engine` is never assigned, so the ESC quit-confirm short-circuits every time. Guard on `gameWorker` instead. (See also Q5 — the variable itself is dead.)

### C8. Client: `resize` listener accumulates per game session — HIGH

`main.ts:681` — added in `startGame()`, never removed; stale closures post to terminated workers. Remove in `quitToLobby()` like `gfxConfigUnsub`.

### C9. Client: unbounded caches — MEDIUM

`audio.ts:239` `bufferCache` (decoded AudioBuffers, MBs each) has no eviction for the whole session. Add an LRU cap. Same review pass worth applying to def/model caches in long-running persistent rooms.

### C10. Client: `gpBootLuaUI` double-init race window — MEDIUM

`lua-widget-worker.ts:6393–6423` — the idempotency guard checks `runtime`, which is only set after long awaits (`gpDefsReady`, 90 s race); two rapid `gp:init`s can both pass. Add a `booting` flag. Also clear the VFS maps at the top of `init()` so worker reuse can't leak stale files.

### C11. Client: VFS prefetch swallows fetch errors silently — LOW

`lua-widget-worker.ts:346–358` — failed files vanish, surfacing later as nil-index errors deep in Lua. Log a summary of unrecoverable paths after the BFS.

### C12. Database not thread-safe but reachable from two threads — LOW

`Database.h` has no mutex; game-server auth (WebTransport thread) and HTTP exec auth can race. Add a mutex or route all DB access through one thread.

---

## P2 — Build, CI, testing

### B1. No working CI at all — HIGH

`.github/workflows/` are all orphaned upstream RecoilEngine pipelines (none reference `spring-server`/`spring-lobby`/`spring-tests`); `.travis.yml` is defunct upstream config. Every change lands unvalidated.
**Fix:** Delete inherited workflows + `.travis.yml`. Add one workflow: configure → build → `spring-tests` → `npx tsc --noEmit` → `vitest run`. Blocked partly by B3 (QUIC deps).

### B2. `make test-cpp` runs the game server, not the tests — HIGH

`Makefile:30–31` executes `./build/debug/spring-server`; the test binary is `spring-tests`. So `make test-all` never ran C++ tests. Also: no `enable_testing()`/`add_test()` anywhere, so the `testPresets` in CMakePresets.json are empty.

### B3. QUIC stack is Homebrew-only — MEDIUM

`CMakeLists.txt:92–130` — pkg-config only; the `SPRING_QUIC_FETCHCONTENT` branch referenced in comments doesn't exist. Linux/CI builds can't configure. Implement the FetchContent fallback with pinned tags.

### B4. Generated protocol files committed and version-skewed — HIGH

- `rts/protocol_generated.h` (871 KB) and 134 TS files in `client/src/protocol/` are tracked; they drift silently when `protocol.fbs` changes without regeneration.
- C++ flatc is pinned `v24.3.25`; the npm `flatbuffers` runtime is `^25.9.23` — generated-code/runtime skew that TS never catches because `src/protocol` is excluded from tsconfig.

**Fix:** Align both to one FlatBuffers release; either gitignore the generated outputs and regenerate in CI, or keep them tracked but add a CI "regenerate produces no diff" check.

### B5. No compiler warnings, no TS strict, no linter — MEDIUM

- C++: no `-Wall -Wextra` anywhere; only three `-Wno-*` suppressions (`CMakeLists.txt:43`). New code gets zero compiler diagnostics. Apply `-Wall -Wextra` via an interface target to the new targets first.
- TS: `tsconfig.json` lacks `strict`; `noUnusedLocals/Parameters` explicitly false; ~155 `any` usages, including the network decode path (`defs-fetch.ts`, 20×) and lobby JSON (`lobby-ui.ts`, 13×). Turn on `strictNullChecks` first, then `strict`.
- No ESLint/Biome at all. Add one with `no-explicit-any` and unused-vars rules.

### B6. Serializer round-trips untested — HIGH (testing gap)

`EntityStateSerializer`/`ProjectileStateSerializer` (C++) and `entity-state.ts`/`projectile-state.ts` (TS) must match byte-for-byte; nothing verifies this. 13 client test files cover ~95 sources; `connection.ts`, the worker, `entity-renderer.ts`, `audio.ts`, `lobby-ui.ts` have zero tests.
**Fix (highest value per hour):** golden-file tests — C++ writes snapshot fixtures to disk, Vitest parses them and asserts field equality. Catches every future wire-format drift, including the C3 truncations.

### B7. `-DNOT_USING_CREG` contradicts "creg is kept" — MEDIUM

`CMakeLists.txt:36` globally defines `NOT_USING_CREG` while AGENTS.md's design table says creg is retained for save/load. If the macro stubs creg out, snapshots will be silently empty. Audit and reconcile (code or docs).

### B8. Orphaned `test/` directory — LOW

Catch2-based upstream tests tracked in git, not wired into CMake, testing deleted code; the live suite uses doctest. Delete or port.

---

## P3 — Architecture & code quality

### Q1. `server_main.cpp` is a 2,986-line monolith — MEDIUM

arg parsing, HTTP routes, the giant `ClientPayload` dispatch switch, the 30 Hz loop, entity/projectile/LOS streaming, AI lifecycle, idle-exit — all in `main()`. Untestable in isolation. Extract `HandleClientMessage`, the streaming loop body, and HTTP registration into their own TUs first; that also unlocks unit-testing the dispatch (S2's fix lands cleaner there too).

### Q2. `lua-widget-worker.ts` is 8,324 lines — HIGH

Post-GW4 it owns LuaUI host + VFS + Babylon engine + render pipeline + WebTransport connection + decoders + camera + selection + overlays + audio bridge + minimap feed + the `onmessage` dispatcher, sharing module-level mutable singletons throughout. The boundary already exists on paper in `game-worker-protocol.ts`.
**Fix:** Extract `core/game-processor.ts` (the gp\* subsystem, ~lines 5044–6649) and `core/worker-vfs.ts`. Type the `onmessage` handler as `MessageEvent<GpWorkerInbound>` so the protocol file actually constrains the dispatch (currently `e.data` is untyped and the switch is raw string literals).

### Q3. Main-thread/worker duplication awaiting cleanup — MEDIUM

`input-manager.ts` (2,266 lines) vs `worker-selection.ts` duplicate the selection state machine and constants; `input-manager.ts` was superseded by GW4-c5b but still compiles and imports. Mark `@deprecated`, extract shared constants/order-dispatch to `selection-core.ts`, delete once build-placement/waypoint-drag are ported. Similarly: two worker→main persistence channels (`storage:set` via LuaWidgetManager vs `gp:config` localStorage writes in `main.ts:582`) — consolidate on one.

### Q4. Hand-rolled JSON parsing/serialisation in the lobby — MEDIUM

`HttpAuth.h:30–67` `JsonField` (no nesting, no `\uXXXX`) + string-concatenated JSON responses with incomplete escaping (`lobby_main.cpp:649`). One FetchContent of nlohmann/json removes a whole bug class, including S4's input path.

### Q5. Dead code / stale remnants — LOW

- `main.ts`: dead `engine` variable + `Engine` import + null-guards (`:85,318,402`); unused `LuaWidgetManager` import (`:62`) pulling 2,282 lines into the main bundle; `__widgetManagerDispose` no-ops.
- WebRTC leftovers: full `#ifdef SPRINGAPI_HAS_WEBRTC` implementation in `libspringapi/src/rtc.cpp`; stale comments in `vite.config.ts:22`, `lobby-ui.ts:256`, `transport.ts:6`.
- `analysis-debug.md` (dated internal debug notes) tracked in git — move to `PLAN-archive/`.
- Babylon private `_gl` access via casts in `lua-widget-worker.ts:6395` and `terrain.ts:548` — wrap in one helper as a single upgrade point.
- `(this as any)._field` state in `scenarios/bench/*.ts` — declare real private fields.
- Global singletons `g_luaDebugger`/`g_debugFlags` will break any future multi-room single process.
- `Database::ValidateSession` returns 0 for both "invalid" and "DB error" — callers can't tell auth failure from corruption.

---

## Suggested order of attack

1. **Day-one safety nets (small, compounding):** fix `make test-cpp` (B2) + add CTest; enforce protocol version (C1); enable `-Wall -Wextra` on new targets and `strictNullChecks` (B5); minimal GitHub Actions workflow (B1, after B3's FetchContent fallback).
2. **Security batch (S1–S7):** one focused pass over `HttpAuth.h`, the ConsoleCommand/exec gate, token generation, the lobby SQL, and resource limits. Most are <1 day each.
3. **Serializer golden-file tests (B6):** protects the riskiest surface before further protocol work; fold in the u16→u32 widenings (C3) as one version bump.
4. **Client leak/correctness batch (C7–C10):** small fixes in `main.ts` and the worker boot path.
5. **Structural refactors (Q1, Q2):** extract message dispatch from `server_main.cpp` and the game-processor from the worker file. Do after tests exist, not before.
6. **Housekeeping (Q3–Q5, B4, B7, B8):** opportunistic; good "cheap model + parallel agents" cleanup tasks per AGENTS.md.

---

_Generated by automated review (3 parallel agents over server C++, client TS, build/hygiene; high-severity findings spot-verified against source). Line numbers will drift — treat them as anchors, not gospel._
