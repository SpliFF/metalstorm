# Unified Logging & Log Server

Part of the [Debugging & Logging Guide](debugging.md) family. This page covers `libspringlog` (the shared logging library every process links), the dedicated `spring-logserver` process, game session tracking, and how to add a custom sink.

## Table of Contents

- [Unified Logging (libspringlog)](#unified-logging-libspringlog)
  - [Log Levels](#log-levels)
  - [C API](#c-api)
  - [C++ Macros](#c-macros)
  - [Output Formats](#output-formats)
  - [Optional Sinks](#optional-sinks)
  - [Environment Variables](#environment-variables)
  - [CLI Flags](#cli-flags)
- [Log Server (spring-logserver)](#log-server-spring-logserver)
  - [Running the Log Server](#running-the-log-server)
  - [HTTP Query API](#http-query-api)
  - [WebSocket Protocol](#websocket-protocol)
  - [Ring Buffer](#ring-buffer)
  - [SQLite Persistence](#sqlite-persistence)
- [Game Session Tracking](#game-session-tracking)
- [Adding a Custom Sink](#adding-a-custom-sink)

---

## Unified Logging (libspringlog)

`libspringlog` is a shared library with a C-compatible API. Every executable in the project links it. It provides structured log records with level, section, scope, process name, sim frame, and message.

### Log Levels

| Level | Value | Use for |
|-------|-------|---------|
| `SPRING_LOG_DEBUG` | 0 | Verbose diagnostic output, command routing details |
| `SPRING_LOG_INFO` | 1 | Normal operation (map loaded, subsystem initialized) |
| `SPRING_LOG_NOTICE` | 2 | Important state changes (player connected, game started) |
| `SPRING_LOG_WARNING` | 3 | Non-fatal issues (malformed args, missing optional files) |
| `SPRING_LOG_ERROR` | 4 | Failures (database open failed, Lua syntax error) |
| `SPRING_LOG_FATAL` | 5 | Unrecoverable errors |

The default minimum level is `NOTICE`. Messages below the minimum are silently dropped.

### C API

```c
#include "System/SpringLog/SpringLog.h"

// Initialize at process start
springlog_init("my-process", SPRING_LOG_OUTPUT_CONSOLE);

// Log a message
springlog_log(SPRING_LOG_NOTICE, "section", "scope", frame, "format %s", arg);

// Set simulation frame (call each tick)
springlog_set_frame(frameNum);

// Register a custom sink
int sinkId = springlog_add_sink(mySinkFn, myUserdata);

// Clean up
springlog_shutdown();
```

### C++ Macros

Every C++ source file that logs should define `LOG_SECTION` at the top:

```cpp
#include "System/SpringLog/SpringLog.h"
#define LOG_SECTION "sim"

// Simple log (uses LOG_SECTION, current frame)
SLOG(SPRING_LOG_NOTICE, "loaded %u unit defs", count);

// Log with explicit scope (for Lua handles, AI names)
SLOG_SCOPED(SPRING_LOG_ERROR, "LuaRules", "runtime error: %s", msg);
```

The `SLOG` macro expands to:

```cpp
springlog_log(level, LOG_SECTION, "", springlog_get_frame(), fmt, ...)
```

### Output Formats

**Console** (stdout for level < ERROR, stderr for ERROR and above):

```
[spring-server:sim] loaded 42 unit defs
[spring-server:lua:LuaRules] runtime error in callin 'GameFrame': ...
```

**File** (structured, machine-parseable):

```
@L|NOTICE|sim||1234|loaded 42 unit defs
@L|ERROR|lua|LuaRules|1234|runtime error in callin 'GameFrame': ...
```

### Optional Sinks

**Network sink** (`springlog-net`) -- intended to stream log entries to the log server over a persistent WebSocket. **Currently a collection-only stub** (`SpringLogNet.cpp`): it buffers entries but does not yet send them, and the lobby does not pass `--log-server` to spawned game servers. In practice, game-server and lobby logs reach the log server through the **shared SQLite file** (`data/debug.db`): every process enables the SQLite sink (defaulting to that path), and the log server reads the same file for its HTTP query/search endpoints. This is why room/game-scoped queries hit SQLite rather than the in-memory ring buffer (which only holds the log server's own logs plus browser logs POSTed to `/api/logs/ingest`).

```cpp
#include "System/SpringLog/SpringLogNet.h"
springlog_net_init("ws://localhost:8010", "auth-token");
// ... logging ...
springlog_net_shutdown();
```

**SQLite sink** (`springlog-sqlite`) -- writes log entries to a local SQLite database on a background thread. Batches writes in transactions (every 1 second or 100 entries). Only persists entries at NOTICE level and above.

```cpp
#include "System/SpringLog/SpringLogSqlite.h"
springlog_sqlite_init("data/debug.db");
// ... logging ...
springlog_sqlite_shutdown();
```

### Environment Variables

| Variable | Effect |
|----------|--------|
| `SPRING_LOG_LEVEL` | Set min level: `debug`, `info`, `notice`, `warning`, `error`, `fatal` |
| `SPRING_LOG_FILE` | Enable file sink at the given path |
| `SPRING_DEBUG=1` | Set min level to DEBUG |

### CLI Flags

These flags are parsed by the executable's own argument handling (not by libspringlog):

| Flag | Applies to | Effect |
|------|-----------|--------|
| `--log-file <path>` | server, lobby | Enable file sink |
| `--log-level <level>` | server, lobby, tools | Set minimum level |
| `--log-server <url>` | server, tools | Connect to log server (springlog-net) |
| `--log-sqlite <path>` | server | Enable SQLite sink |
| `--debug` | server, lobby | Set level to DEBUG |
| `--log-messages` | server | Log every dispatched WS message type + size |

---

## Log Server (spring-logserver)

A dedicated process that collects, stores, and streams log entries. It is the single source of truth for all logs in the system.

### Running the Log Server

```bash
./build/debug/spring-logserver --port 8010 --db data/debug.db
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 8010 | HTTP + WebSocket listen port |
| `--db` | `data/debug.db` | SQLite database path |
| `--log-level` | notice | Minimum level for the log server's own logs |

### HTTP Query API

All endpoints return JSON with `Access-Control-Allow-Origin: *`.

**GET /api/logs/:roomId**

Fetch recent log entries. A non-zero `roomId` scopes results to a single game/room: each game server is launched with `--room <id>` and tags every log entry it writes with that room id (and its game id), so logs from concurrent or past games can be filtered apart in the shared store.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `roomId` (path) | int | required | Room ID (use `0` for all sources) |
| `limit` | int | 200 | Maximum entries to return |
| `level` | int | 0 | Minimum log level |
| `section` | string | | Filter by section (exact match) |
| `scope` | string | | Filter by scope (exact match) |
| `game` | string | | Filter by game content id (e.g. `zk`) |
| `since` | int | | Only entries with `timestamp >= since` (ms epoch) |

Returned entries now include `room_id` and `game_id` fields. The `room_id` filter is backed by the `idx_debug_logs_room` index. Note: a specific `roomId`/`game`/`since` always queries the persisted SQLite store (game-server logs live only there — see the network-sink note above).

> **Room IDs get reused across independent, time-separated sessions.** Because rooms are recycled, a `roomId`/`game` filter is not a hard guarantee that every returned row is from *your* current session — a log line that looks alarming and doesn't match what you expect from this run may be a stale row from a much older session that happened to share the same room id. If a finding looks suspicious (mentions content from a different game, or a bug that "shouldn't" still exist), cross-check with a direct query against `data/debug.db`'s `debug_logs` table (`room_id`, `game_id`, `timestamp` columns) before trusting it, and check whether it's already fixed in git history.

Response:

```json
[
  {
    "id": 42,
    "timestamp": 1713024000000,
    "level": 4,
    "section": "lua",
    "scope": "LuaRules",
    "process": "spring-server",
    "frame": 1234,
    "message": "runtime error in callin 'GameFrame': ..."
  }
]
```

**GET /api/logs/search**

Full-text search across log entries. Add a `room`/`game`/`section` selector and/or a `since` window to scope the search — without one, results span the entire history of every game ever run.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | | Search text (substring match on message). Optional if `room`/`game`/`section` is given |
| `room` | int | | Scope to one room/game instance |
| `game` | string | | Filter by game content id |
| `section` | string | | Filter by section (exact match) |
| `since` | int | | Only entries with `timestamp >= since` (ms epoch) |
| `limit` | int | 200 | Maximum results |
| `level` | int | 0 | Minimum log level |

**GET /api/sessions**

List recent game sessions.

```json
[
  {
    "session_id": "abc-123",
    "room_id": 1,
    "game_name": "papertanks",
    "map_name": "wanderlust2.1",
    "started_at": 1713024000,
    "ended_at": 1713025000,
    "end_reason": "normal",
    "exit_code": 0
  }
]
```

**GET /api/logs/sources**

Returns `{"status":"ok"}` (health check).

### WebSocket Protocol

Connect to the log server's WS endpoint at `ws://localhost:8010/`. All messages use the standard Spring Web envelope: `[0x01, ...FlatBuffers data]`.

**Client -> Log Server:**

| Message | Purpose |
|---------|---------|
| `LogIngest { entries: [LogEntryMsg] }` | Push log entries for storage |
| `LogSubscribe { room_id, min_level, section_filter, scope_filter }` | Start receiving log stream |
| `LogUnsubscribe {}` | Stop receiving log stream |

**Log Server -> Client:**

| Message | Purpose |
|---------|---------|
| `LogBatch { room_id, entries: [LogEntryMsg], latest_id }` | Streamed log entries |

### Ring Buffer

The log server maintains per-source ring buffers (keyed by `room_id`) plus an aggregate buffer (source 0). Each buffer holds up to 2000 entries. When full, the oldest entry is evicted. Entries are assigned monotonically increasing IDs for cursor-based pagination.

### SQLite Persistence

The log server's SQLite sink uses the same `debug_logs` schema as `springlog-sqlite`. Additionally, it creates a `game_sessions` table:

```sql
CREATE TABLE game_sessions (
    session_id TEXT PRIMARY KEY,
    room_id INTEGER,
    game_name TEXT,
    map_name TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    end_reason TEXT,       -- "normal", "crash", "killed", "timeout"
    exit_code INTEGER,
    player_count INTEGER,
    ai_count INTEGER
);
```

---

## Game Session Tracking

The log server maintains a `game_sessions` table for post-mortem analysis:

```sql
CREATE TABLE game_sessions (
    session_id TEXT PRIMARY KEY,
    room_id INTEGER,
    game_name TEXT,
    map_name TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    end_reason TEXT,       -- "normal", "crash", "killed", "timeout"
    exit_code INTEGER,
    player_count INTEGER,
    ai_count INTEGER
);
```

Query via the HTTP API:

```
GET http://localhost:8010/api/sessions
```

---

## Adding a Custom Sink

Register a function that receives every log record:

```cpp
#include "System/SpringLog/SpringLog.h"

void MyCustomSink(const SpringLogRecord* record, void* userdata) {
    // record->level, record->section, record->scope,
    // record->process, record->frame, record->message
    // are all valid for the duration of this call.
    MySystem* sys = static_cast<MySystem*>(userdata);
    sys->HandleLog(record);
}

// Register (returns an ID for later removal)
int sinkId = springlog_add_sink(MyCustomSink, mySystemPtr);

// Remove when done
springlog_remove_sink(sinkId);
```

Custom sinks are called under the global log mutex. Keep processing fast -- buffer entries and process them on another thread if needed.
