# libspringapi

Client library for interacting with Spring RTS Web servers. Link it into your own tools, lobbies, bots, or monitoring systems.

Three interfaces:

| Interface | Transport | Use |
|-----------|-----------|-----|
| **HTTP** | REST over TCP | Auth, command execution, log queries, room management |
| **WebRTC reliable** | DataChannel (ordered) | FlatBuffer messages (commands, events, entity lifecycle) |
| **WebRTC unreliable** | DataChannel (unordered) | Entity/projectile state snapshots |

For the full server API, see [docs/api.md](../docs/api.md).

## Building

### Standalone (no engine dependencies)

```bash
cd libspringapi
cmake -B build
cmake --build build
```

The core HTTP library has zero external dependencies (raw POSIX sockets).

### With Python bindings

```bash
cmake -B build -DSPRINGAPI_PYTHON=ON
cmake --build build
```

Fetches [pybind11](https://github.com/pybind/pybind11) v2.13.6 via FetchContent. Produces a `pyspringapi` Python module.

### As part of the engine tree

When built from the project root, libspringapi is automatically included with WebRTC enabled:

```bash
cmake --preset debug
cmake --build build/debug --target springapi
```

## Linking

```cmake
# In your CMakeLists.txt:
add_subdirectory(path/to/libspringapi)
target_link_libraries(mytool PRIVATE springapi)
```

Or after installing:

```cmake
find_package(springapi REQUIRED)
target_link_libraries(mytool PRIVATE springapi)
```

## C++ API

### Authentication

```cpp
#include <springapi/springapi.h>

auto auth = springapi::login("http://localhost:8011", "test1", "test");
if (auth.success) {
    std::cout << "token: " << auth.token << "\n";
    std::cout << "user: " << auth.username << " (id=" << auth.userId << ")\n";
}

// Register a new account (auto-logs in).
// The 4th argument is the faction key. It is optional here — the field is
// omitted from the request when empty — but the server may require it: a
// Metalstorm lobby rejects a factionless sign-up with
// 400 {"error":"faction is required"}, surfaced as reg.error.
// Valid keys come from GET /api/factions/<gameId>.
auto reg = springapi::registerUser("http://localhost:8011", "newplayer", "secret", "compact");
```

### Command Execution

```cpp
// Execute on the game server (needs a token from login)
auto r = springapi::exec("http://localhost:<game-port>", "server", "state", auth.token);
// r.success == true, r.output == "frame=1234 teams=3 units=5"

// Lua execution
auto lua = springapi::exec("http://localhost:<game-port>", "LuaRules", "return 1+1", auth.token);
// lua.output == "2"

// SQL query on the lobby
auto sql = springapi::exec("http://localhost:8011", "sql",
    "SELECT id, username FROM users LIMIT 5", auth.token);

// Lobby commands
auto rooms = springapi::exec("http://localhost:8011", "lobby", "rooms", auth.token);
```

All `exec()` calls map to `POST /api/exec` on the target server. See [docs/api.md](../docs/api.md) for available scopes and commands.

### Log Queries

```cpp
// Recent logs (returns raw JSON)
std::string logs = springapi::getLogs("http://localhost:8010",
    0,      // roomId (0 = all)
    4,      // minLevel (4 = ERROR)
    50,     // limit
    "lua",  // section filter
    "");    // scope filter

// Full-text search
std::string results = springapi::searchLogs("http://localhost:8010",
    "runtime error", 0, 100);

// Game server processes
std::string procs = springapi::getProcesses("http://localhost:8011");
```

### Raw HTTP

```cpp
std::string body = springapi::httpGet("http://localhost:8010/api/logs/sources");

std::string resp = springapi::httpPost(
    "http://localhost:8011/api/auth/login",
    R"({"username":"test1","password":"test"})");

// With auth token:
std::string resp2 = springapi::httpPost(
    "http://localhost:8011/api/exec",
    R"({"scope":"lobby","code":"rooms"})",
    auth.token);
```

### JSON Helpers

```cpp
std::string json = R"({"name":"foo","count":42})";
std::string name = springapi::jsonExtract(json, "name");   // "foo"
std::string count = springapi::jsonExtract(json, "count");  // "42"

std::string safe = springapi::jsonEscape("line1\nline2");   // "line1\\nline2"
```

### Game-connect (`connectRtc`) — removed (GW7)

The real-time game transport moved to WebTransport (HTTP/3 / QUIC) and the
server's WebRTC plane was deleted. `springapi::connectRtc(...)` is retained as
an inert stub that always returns `nullptr`, pending a C++ WebTransport client
port. Lobby/HTTP functionality (auth, rooms, exec, logs) is unaffected.

## Python API

Build with `-DSPRINGAPI_PYTHON=ON`, then:

```python
import pyspringapi as api

# Auth
auth = api.login("http://localhost:8011", "test1", "test")
print(f"token: {auth.token}, user: {auth.username}")

# Execute
result = api.exec("http://localhost:<game-port>", "server", "state", auth.token)
print(f"success={result.success}, output={result.output}")

# Lua
r = api.exec("http://localhost:<game-port>", "LuaRules", "return 42", auth.token)

# Logs
logs = api.get_logs("http://localhost:8010", room_id=0, level=4, limit=10)
results = api.search_logs("http://localhost:8010", "error", level=4)

# SQL
sql = api.exec("http://localhost:8011", "sql",
    "SELECT count(*) FROM users", auth.token)

# Processes
procs = api.get_processes("http://localhost:8011")

# Raw HTTP
body = api.http_get("http://localhost:8010/api/logs/sources")
resp = api.http_post("http://localhost:8011/api/exec",
    '{"scope":"lobby","code":"rooms"}', auth.token)

# JSON helpers
val = api.json_extract('{"x":42}', "x")  # "42"
```

## springcli

The `springcli` command-line tool is built on this library. See [docs/api.md](../docs/api.md#springcli) for usage.

## Data Types

```cpp
struct AuthResult {
    bool success;
    std::string token;
    std::string error;      // non-empty on failure
    int64_t userId;
    std::string username;
    std::string role;        // "admin", "player", "spectator"
};

struct ExecResult {
    bool success;
    std::string output;
};

// WebRTC callbacks
using DataCallback = std::function<void(const uint8_t* data, size_t len)>;
using StateCallback = std::function<void(const std::string& state)>;
```

## Architecture

```
Your tool / lobby / bot
        │
        ▼
   libspringapi
   ├── HTTP (POSIX sockets, zero deps)
   │   ├── /api/auth/login
   │   ├── /api/exec
   │   ├── /api/logs/*
   │   └── /api/rooms/*
   │
   └── Game-connect (connectRtc) — removed (GW7); inert stub pending
       a WebTransport client port
        │
        ▼
   Spring servers
   ├── spring-lobby (:8011)
   ├── spring-server (:dynamic)
   └── spring-logserver (:8010)
```

## License

Same as the Spring RTS engine (GPL v2 or later).
