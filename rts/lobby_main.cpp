/**
 * spring-lobby — lightweight lobby server.
 *
 * Handles authentication, room management, and game server spawning
 * via HTTP REST endpoints. When a room starts, spawns a spring-server
 * process and returns the port to clients.
 *
 * No simulation code — just HTTP serving, SQLite, and process management.
 */

#include "Server/NetworkServer.h"
#include "Server/Database.h"
#include "Server/RoomManager.h"
#include "Server/MapMetadata.h"

#include "Server/AI/AIDiscovery.h"
#include "Server/GameDiscovery.h"
#include "Server/ResourcesParser.h"
#include "Server/HttpAuth.h"
#include "Server/GmDashboardPage.h"
#include "Server/DevBuildGate.h"
#include "Server/CacheControl.h"
#include "System/SpringLog/SpringLog.h"
#include "System/SpringLog/SpringLogSqlite.h"
#include <cctype>
#include <optional>
#include <set>
#include <unordered_set>

#include <sqlite3.h>

#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <unordered_map>

#include <sys/types.h>
#include <cstring>
#include <sys/wait.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <functional>
#include <nlohmann/json.hpp>

#define LOG_SECTION "lobby"

static std::atomic<bool> keepRunning{true};
static std::atomic<bool> restartRequested{false};
static void signalHandler(int) { keepRunning.store(false); }
static void restartHandler(int) { restartRequested.store(true); keepRunning.store(false); }

/// Prepare/bind/step/finalize a single write statement. The `bind` callback
/// binds parameters onto the prepared statement before it is stepped once.
static bool ExecPrepared(sqlite3* db, const char* sql,
                         const std::function<void(sqlite3_stmt*)>& bind) {
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "ExecPrepared prepare failed: %s", sqlite3_errmsg(db));
        return false;
    }
    if (bind) bind(stmt);
    const int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE) {
        SLOG(SPRING_LOG_ERROR, "ExecPrepared step failed (%d): %s", rc, sqlite3_errmsg(db));
        return false;
    }
    return true;
}

// Saved for self-restart via execvp
static int savedArgc = 0;
static char** savedArgv = nullptr;

/// Tracks a spawned game server process.
struct GameServerInstance {
    uint32_t roomId = 0;
    int port = 0;
    pid_t pid = 0;
    std::string mapId;
    std::string gameId;
    enum State { Starting, Running, Ended, Crashed } state = Starting;
};

/// Find a free TCP port by actually trying to bind one. Caller can
/// pass a `floor` to start the search higher than `base` — used to
/// skip ports already held by adopted game-server processes whose
/// rows we read out of the `game_servers` table at startup. A range
/// of 1000 ports above the floor is searched; if nothing's free in
/// that window we return -1 and the caller fails the game spawn.
///
/// SO_REUSEADDR is set so a port that's in TIME_WAIT after a recent
/// `spring-server` exit can still be reused for the next room. Game
/// servers themselves bind their own listen socket; the brief bind
/// here is purely a "does anyone hold this?" probe.
///
/// `excluded` is the set of ports already held by live game-server
/// processes in the lobby's `gameServers` map. spring-server's
/// listen socket sets SO_REUSEPORT (NetworkServer.cpp:873), which
/// would otherwise allow the probe bind to succeed against a port
/// another spring-server is actively listening on — the kernel
/// then load-balances incoming connections across both, and clients
/// auth'd for one room land on another room's roster ("Not in this
/// room's roster"). Skipping known-busy ports avoids that collision.
static int findFreePort(int base = 9100, int floor = 0,
                        const std::unordered_set<int>& excluded = {}) {
    int start = (floor > base) ? floor : base;
    for (int port = start; port < start + 1000; ++port) {
        if (excluded.count(port)) continue;
        int s = ::socket(AF_INET, SOCK_STREAM, 0);
        if (s < 0) continue;
        int one = 1;
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons(static_cast<uint16_t>(port));
        if (::bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
            ::close(s);
            return port;
        }
        ::close(s);
    }
    return -1;
}

/// Spawn a spring-server process for a game room.
///
/// `playerRoster` is the list of human players the lobby accepted
/// into the room (non-spectators). Each one becomes a
/// `--player <username>:<team>:<posIdx>` argument pair; the sim
/// uses this to map authenticated WebSocket sessions back to
/// their lobby-assigned team.
///
/// `aiSlots` is the room's AI roster at game-start time. Each slot
/// becomes a `--ai <id>:<team>:<posIdx>` argument pair; the sim
/// runs its own AIDiscovery against the same game path and
/// resolves each id to a main.lua it can actually run.
///
/// Both rosters must have `startPos` populated (or -1 if the map
/// has no start positions at all). The lobby calls
/// AutoAssignStartPositions before this function to fill in any
/// -1 values, so a well-formed handoff always carries a concrete
/// slot assignment per team.
static GameServerInstance spawnGameServer(
    uint32_t roomId, const std::string& gameId,
    const std::string& gameVersion,
    const std::string& mapId, const std::string& dbPath,
    const std::vector<RoomPlayer>& playerRoster,
    const std::vector<RoomAISlot>& aiSlots,
    const std::unordered_map<std::string, std::string>& modOptions = {},
    const std::unordered_set<int>& excludedPorts = {},
    bool devBuildAcknowledged = false,
    // PLAN-security-hardening.md task 5 (G3): forwarded from the lobby's own
    // --wt-cert/--wt-key to every spawned spring-server, so an operator
    // configures the prod cert once at the lobby instead of per room.
    const std::string& wtCertPath = "",
    const std::string& wtKeyPath = "")
{
    GameServerInstance inst;
    inst.roomId = roomId;
    inst.port = findFreePort(9100, 0, excludedPorts);
    if (inst.port < 0) {
        SLOG(SPRING_LOG_ERROR, "no free port in [9100, 10100) for room %u", roomId);
        inst.state = GameServerInstance::Crashed;
        return inst;
    }
    inst.mapId = mapId;
    inst.gameId = gameId;

    // Build the command
    std::string serverBin = "./build/debug/spring-server";
    // Check if release build exists
    if (std::filesystem::exists("./build/release/spring-server"))
        serverBin = "./build/release/spring-server";

    // Create log directory
    std::filesystem::create_directories("data/logs");
    std::string logPath = "data/logs/game-" + std::to_string(roomId) + ".log";

    // Assemble the --player and --ai arguments outside the fork so
    // their string storage outlives the execvp call in the child.
    // Player spec format:  <username>:<team>:<posIdx>
    // AI spec format:      <id>:<team>:<posIdx>
    std::vector<std::string> playerArgStorage;
    playerArgStorage.reserve(playerRoster.size());
    for (const auto& p : playerRoster) {
        playerArgStorage.push_back(
            p.username + ":" +
            std::to_string(static_cast<int>(p.team)) + ":" +
            std::to_string(static_cast<int>(p.startPos)));
    }
    std::vector<std::string> aiArgStorage;
    aiArgStorage.reserve(aiSlots.size());
    for (const auto& slot : aiSlots) {
        aiArgStorage.push_back(
            slot.aiId + ":" +
            std::to_string(static_cast<int>(slot.team)) + ":" +
            std::to_string(static_cast<int>(slot.startPos)));
    }
    // Room modoptions → one "--modoption key=value" pair each. (§5)
    std::vector<std::string> modOptArgStorage;
    modOptArgStorage.reserve(modOptions.size());
    for (const auto& [key, value] : modOptions) {
        modOptArgStorage.push_back(key + "=" + value);
    }

    pid_t pid = fork();
    if (pid == 0) {
        // Child process — redirect stdout/stderr to log file
        FILE* logFile = fopen(logPath.c_str(), "w");
        if (logFile) {
            dup2(fileno(logFile), STDOUT_FILENO);
            dup2(fileno(logFile), STDERR_FILENO);
            fclose(logFile);
        }

        // Close all inherited file descriptors (except stdin/out/err).
        // uWebSockets sockets (our listen socket, all established WS client
        // connections) do not get FD_CLOEXEC by default on macOS, so without
        // this the child process ends up holding the parent's listen socket
        // + every active WebSocket. That leaks state into spring-server and
        // causes cross-talk between the lobby and game server.
        int maxFd = static_cast<int>(sysconf(_SC_OPEN_MAX));
        if (maxFd < 1024) maxFd = 1024;
        for (int fd = 3; fd < maxFd; fd++) {
            close(fd);
        }

        std::string portStr = std::to_string(inst.port);
        std::string roomStr = std::to_string(roomId);

        // Build argv: fixed args first, then one "--player <spec>"
        // pair per human slot, then one "--ai <spec>" pair per AI
        // slot. Player args come first so spring-server's own arg
        // parser doesn't care about ordering — it reads them into
        // separate vectors either way.
        std::vector<const char*> argv;
        argv.push_back(serverBin.c_str());
        argv.push_back("--port"); argv.push_back(portStr.c_str());
        argv.push_back("--room"); argv.push_back(roomStr.c_str());
        argv.push_back("--game"); argv.push_back(gameId.c_str());
        if (!gameVersion.empty()) {
            argv.push_back("--game-version");
            argv.push_back(gameVersion.c_str());
        }
        argv.push_back("--map");  argv.push_back(mapId.c_str());
        argv.push_back("--db");   argv.push_back(dbPath.c_str());
        if (!wtCertPath.empty() && !wtKeyPath.empty()) {
            argv.push_back("--wt-cert"); argv.push_back(wtCertPath.c_str());
            argv.push_back("--wt-key");  argv.push_back(wtKeyPath.c_str());
        }
        for (const auto& spec : playerArgStorage) {
            argv.push_back("--player");
            argv.push_back(spec.c_str());
        }
        for (const auto& spec : aiArgStorage) {
            argv.push_back("--ai");
            argv.push_back(spec.c_str());
        }
        for (const auto& spec : modOptArgStorage) {
            argv.push_back("--modoption");
            argv.push_back(spec.c_str());
        }
        if (devBuildAcknowledged) argv.push_back(DevBuildGate::kFlag);
        argv.push_back(nullptr);

        execvp(serverBin.c_str(), const_cast<char* const*>(argv.data()));
        // If execvp returns, it failed
        fprintf(stderr, "ERROR: failed to exec game server: %s\n", serverBin.c_str());
        _exit(1);
    } else if (pid > 0) {
        inst.pid = pid;
        inst.state = GameServerInstance::Starting;
        SLOG(SPRING_LOG_NOTICE, "spawned game server pid=%d port=%d for room %u "
            "(%zu players, %zu AI)",
            pid, inst.port, roomId, playerRoster.size(), aiSlots.size());
    } else {
        SLOG(SPRING_LOG_ERROR, "fork failed");
        inst.state = GameServerInstance::Crashed;
    }

    return inst;
}

/// Check if a process exists. Works for both children of this PID
/// (which `waitpid(pid, &status, WNOHANG)` could answer for) and
/// orphan processes that were re-parented to PID 1 after a previous
/// lobby instance died — those are the ones we want to adopt on
/// startup, and `waitpid` returns -1/ECHILD for them. `kill(pid, 0)`
/// is the standard portable existence probe: returns 0 if the pid
/// is alive, -1 with errno=ESRCH if it isn't.
static bool isProcessAlive(pid_t pid) {
    if (pid <= 0) return false;
    // Reap if it's a child of ours and has already exited — otherwise
    // kill(pid, 0) returns success for zombie processes and the lobby
    // never notices the game server has died. WNOHANG returns the pid
    // for an exited child, 0 if still running, -1 (ECHILD) if not our
    // child (e.g. adopted from the game_servers table across restart).
    int status = 0;
    pid_t r = ::waitpid(pid, &status, WNOHANG);
    if (r == pid) return false;        // reaped zombie — definitely dead
    if (::kill(pid, 0) == 0) return true;
    return (errno != ESRCH);  // EPERM means alive but not ours; still "alive"
}

int main(int argc, char* argv[])
{
    savedArgc = argc;
    savedArgv = argv;

    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    std::signal(SIGHUP, restartHandler);
    // Ignore SIGPIPE. The lobby writes to a handful of things that
    // can get their peer closed under us: WebSocket client sockets,
    // stdout/stderr (captured by mprocs or similar), and — not yet
    // but soon — outbound connections to game servers as part of
    // the restart-recovery work. Default SIGPIPE action terminates
    // the process the first time any of those hit a closed peer,
    // which turns a transient write failure into a lobby crash.
    // Ignoring it means write() returns EPIPE instead, which every
    // reasonable caller already handles as "peer went away".
    std::signal(SIGPIPE, SIG_IGN);

    int port = 8011;
    std::string dbPath = "data/spring-server.db";
    std::string gamesDir = "data/games";
    std::string logFile;
    int logLevel = SPRING_LOG_NOTICE;
    bool debugMode = false;
    // S2: one-shot admin provisioning. `--promote-admin <user>` grants the
    // admin role to an existing account and exits without starting the server
    // — an explicit, auditable op rather than auto-elevating on every boot.
    std::string promoteAdmin;
    // PLAN-quickstart.md Part A: dev/test-only bypass of the whole lobby
    // dance. `dev_direct_start` gates the /api/rooms/direct HTTP endpoint
    // (E6: off by default, never set in a production config). `--direct
    // <manifest.json>` is a separate, always-available CLI flag — it's
    // operator-supplied at process launch, not reachable remotely, so it
    // doesn't need the same gate; it creates one standing room at boot
    // (mprocs dev flow: stack comes up with the game already running).
    bool devDirectStart = false;
    bool devBuildAcknowledged = false;
    std::string directManifestPath;
    // PLAN-security-hardening.md task 5 (G3): prod cert for every spawned
    // spring-server's QUIC/WebTransport endpoint. See spawnGameServer.
    std::string wtCertPath;
    std::string wtKeyPath;
    // PLAN-client-resilience.md task 3: server-operator opt-out for the
    // `/api/client-errors` report channel — the "lobby setting" the plan
    // describes (open-source courtesy: default on for the official beta,
    // off in a self-hosted sample config that explicitly passes this flag).
    // Surfaced to the client via /api/version.
    bool clientErrorReportsEnabled = true;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
        else if (arg == "--promote-admin" && i + 1 < argc) promoteAdmin = argv[++i];
        else if (arg == "--db" && i + 1 < argc) dbPath = argv[++i];
        else if (arg == "--games-dir" && i + 1 < argc) gamesDir = argv[++i];
        else if (arg == "--log-file" && i + 1 < argc) logFile = argv[++i];
        else if (arg == "--log-level" && i + 1 < argc) logLevel = std::atoi(argv[++i]);
        else if (arg == "--debug") { debugMode = true; logLevel = SPRING_LOG_DEBUG; }
        else if (arg == "--no-cache") { CacheControl::SetNoCache(true); }
        else if (arg == "--dev-direct-start") { devDirectStart = true; }
        else if (arg == DevBuildGate::kFlag) { devBuildAcknowledged = true; }
        else if (arg == "--direct" && i + 1 < argc) { directManifestPath = argv[++i]; }
        else if (arg == "--wt-cert" && i + 1 < argc) { wtCertPath = argv[++i]; }
        else if (arg == "--wt-key" && i + 1 < argc) { wtKeyPath = argv[++i]; }
        else if (arg == "--disable-client-error-reports") { clientErrorReportsEnabled = false; }
        else if (arg == "--game" && i + 1 < argc) {
            // Back-compat: `--game <path>` is translated into
            // `--games-dir <parent>` so existing scripts that point
            // at a single game folder still work. The lobby now
            // always scans a root directory of games rather than
            // running one-game-at-a-time.
            const std::string single = argv[++i];
            namespace fs = std::filesystem;
            const fs::path p(single);
            if (p.has_parent_path())
                gamesDir = p.parent_path().string();
        }
    }

    // PLAN-security-hardening E1: checked before any DB open / listen /
    // fork so a dev build can't spawn game-server children (--direct) or
    // start listening at all without the operator's explicit acknowledgment.
    if (!DevBuildGate::CheckAndWarn("spring-lobby", devBuildAcknowledged))
        return 1;

    if (wtCertPath.empty() != wtKeyPath.empty()) {
        SLOG(SPRING_LOG_ERROR, "--wt-cert and --wt-key must be given together (got only %s)",
             wtCertPath.empty() ? "--wt-key" : "--wt-cert");
        return 1;
    }

    // --- Logging ---
    uint32_t logOutputs = SPRING_LOG_OUTPUT_CONSOLE;
    if (!logFile.empty())
        logOutputs |= SPRING_LOG_OUTPUT_FILE;
    springlog_init("spring-lobby", logOutputs);
    springlog_set_min_level(logLevel);
    if (!logFile.empty())
        springlog_set_file(logFile.c_str());

    // Enable SQLite log sink so logs are visible in the debug console.
    // Uses the same debug.db as the log server and game servers.
    springlog_sqlite_init("data/debug.db");

    SLOG(SPRING_LOG_NOTICE, "starting on port %d...", port);

    // --- Database ---
    Database db;
    if (!db.Open(dbPath)) {
        SLOG(SPRING_LOG_ERROR, "failed to open database");
        springlog_shutdown();
        return 1;
    }

    // Clean up expired sessions on startup
    int cleaned = db.CleanExpiredSessions(86400); // 24h
    if (cleaned > 0) SLOG(SPRING_LOG_INFO, "cleaned %d expired session(s)", cleaned);

    // S2: `--promote-admin <user>` one-shot. Grants the admin role to an
    // already-registered account (privileged console / SQL exec gate) and
    // exits — it never starts the server and never creates an account, so it
    // can't forge credentials. Run once by the operator; ordinary
    // registrations stay "player".
    if (!promoteAdmin.empty()) {
        const bool ok = db.EnsureAdminRole(promoteAdmin);
        if (ok)
            SLOG(SPRING_LOG_NOTICE, "granted admin role to '%s'", promoteAdmin.c_str());
        else
            SLOG(SPRING_LOG_ERROR, "no such account '%s' — register it first",
                 promoteAdmin.c_str());
        // The SQLite write is already committed. This is a one-shot utility
        // invocation; skip the full server-shutdown path (springlog's async
        // sink thread isn't started in a joinable state this early in init and
        // aborts at teardown) and exit immediately with the result code.
        db.Close();
        std::fflush(stdout);
        std::_Exit(ok ? 0 : 1);
    }

    // --- Rooms ---
    RoomManager rooms;

    // --- Map processing ---
    // Access the raw sqlite3* handle for MapMetadataDb
    // (Database wrapper doesn't expose it, so we open a second connection)
    sqlite3* mapDb = nullptr;
    sqlite3_open(dbPath.c_str(), &mapDb);

    // Attach the lobby's SQLite handle to the RoomManager so every room
    // mutation is write-through. Tables are created (or dropped and
    // recreated on schema bump) before LoadFromDatabase populates the
    // in-memory `rooms` map from any rows that survived a previous
    // lobby instance.
    if (mapDb) {
        RoomManager::EnsureTables(mapDb);
        rooms.SetDatabase(mapDb);
        rooms.LoadFromDatabase();
    }

    // Create game_servers table — maintained in real-time so external tools
    // (MCP debug server, springcli) can discover running game server ports
    // without querying the lobby HTTP API.
    if (mapDb) {
        sqlite3_exec(mapDb,
            "CREATE TABLE IF NOT EXISTS game_servers ("
            "  room_id INTEGER PRIMARY KEY,"
            "  port INTEGER NOT NULL,"
            "  pid INTEGER NOT NULL,"
            "  map_id TEXT,"
            "  game_id TEXT,"
            "  started_at INTEGER DEFAULT (strftime('%s','now')),"
            "  state TEXT DEFAULT 'starting'"
            ")", nullptr, nullptr, nullptr);
        // game_status — liveness/readiness published by each running game server
        // (spring-server is the only writer; the lobby + tooling only read it).
        // Created here too so reads work before the first game ever launches.
        sqlite3_exec(mapDb,
            "CREATE TABLE IF NOT EXISTS game_status ("
            "  room_id INTEGER PRIMARY KEY,"
            "  ready INTEGER NOT NULL DEFAULT 0,"
            "  client_count INTEGER NOT NULL DEFAULT 0,"
            "  pid INTEGER NOT NULL DEFAULT 0,"
            "  port INTEGER NOT NULL DEFAULT 0,"
            "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))"
            ")", nullptr, nullptr, nullptr);
    }

    // Helper: persist a game server entry to SQLite
    auto persistGameServer = [&](const GameServerInstance& inst) {
        if (!mapDb) return;
        const char* stateStr = "starting";
        switch (inst.state) {
            case GameServerInstance::Starting: stateStr = "starting"; break;
            case GameServerInstance::Running:  stateStr = "running"; break;
            case GameServerInstance::Ended:    stateStr = "ended"; break;
            case GameServerInstance::Crashed:  stateStr = "crashed"; break;
        }
        ExecPrepared(mapDb,
            "INSERT OR REPLACE INTO game_servers (room_id, port, pid, map_id, game_id, state) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [&](sqlite3_stmt* s) {
                sqlite3_bind_int(s, 1, static_cast<int>(inst.roomId));
                sqlite3_bind_int(s, 2, inst.port);
                sqlite3_bind_int(s, 3, static_cast<int>(inst.pid));
                sqlite3_bind_text(s, 4, inst.mapId.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(s, 5, inst.gameId.c_str(), -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(s, 6, stateStr, -1, SQLITE_TRANSIENT);
            });
    };

    auto removeGameServer = [&](uint32_t roomId) {
        if (!mapDb) return;
        ExecPrepared(mapDb, "DELETE FROM game_servers WHERE room_id=?",
            [&](sqlite3_stmt* s) { sqlite3_bind_int(s, 1, static_cast<int>(roomId)); });
        // The game server normally clears its own game_status row on a clean
        // exit, but a SIGKILL/crash can leave it behind — drop it here too so a
        // dead room never looks "ready".
        ExecPrepared(mapDb, "DELETE FROM game_status WHERE room_id=?",
            [&](sqlite3_stmt* s) { sqlite3_bind_int(s, 1, static_cast<int>(roomId)); });
    };

    // Read the readiness flag a running game server publishes into `game_status`
    // (written only by spring-server; see server_main.cpp). Returns true once the
    // server is accepting connections, which the health-check loop uses to flip
    // the room Loading→Active. Missing table/row → not ready (false).
    auto gameServerReady = [&](uint32_t roomId) -> bool {
        if (!mapDb) return false;
        sqlite3_stmt* s = nullptr;
        bool ready = false;
        if (sqlite3_prepare_v2(mapDb, "SELECT ready FROM game_status WHERE room_id=?",
                -1, &s, nullptr) == SQLITE_OK) {
            sqlite3_bind_int(s, 1, static_cast<int>(roomId));
            if (sqlite3_step(s) == SQLITE_ROW)
                ready = sqlite3_column_int(s, 0) != 0;
        }
        if (s) sqlite3_finalize(s);
        return ready;
    };

    // Map processing is handled offline by tools/mapconverter.
    // The lobby reads pre-populated data/ + SQLite metadata.
    MapMetadataDb::EnsureTable(mapDb);

    // --- Game discovery ---
    // Enumerate every subdirectory of `gamesDir` that ships a
    // game.config.lua (or .json) via ConfigReader. This builds the
    // list shown in the lobby's "create game" dropdown and, for each
    // game, the set of AI plugins that game + the engine provide.
    // The result is immutable for the lifetime of the lobby process
    // — authors who add a new game must restart the lobby.
    const std::string enginePath = "content/engine";
    const std::vector<GameDiscovery::GameInfo> availableGames =
        GameDiscovery::Discover(gamesDir);

    // --- Per-game AI discovery ---
    // Game model conversion is handled offline by tools/gameconverter.
    // The lobby just discovers games and their AI plugins.
    std::unordered_map<std::string, std::string> gamePathsById;
    std::unordered_map<std::string, std::string> gameVersionsById;
    std::unordered_map<std::string, std::vector<AIDiscovery::AIInfo>> aisByGame;
    for (const auto& g : availableGames) {
        gamePathsById[g.id] = g.folderPath;
        gameVersionsById[g.id] = g.version;
        aisByGame[g.id] = AIDiscovery::Discover(enginePath, g.folderPath);
    }

    // --- Game server instances ---
    std::unordered_map<uint32_t, GameServerInstance> gameServers; // roomId → instance

    // --- Adopt-or-reset live game servers across a lobby restart ---
    //
    // Walk the `game_servers` table. For each row we either:
    //   - adopt the running process (re-populate gameServers[roomId])
    //     so /api/processes and the room browser show it correctly
    //     and we can SIGTERM it when its room is abandoned;
    //   - or, if the pid is dead, reset the matching room back to
    //     Filling and delete the stale row.
    //
    // This replaces the previous `waitpid(WNOHANG)` cleanup which
    // only worked for processes that were children of *this* PID —
    // every adopted orphan from a prior lobby instance fell through
    // and got DELETEd as if it had crashed.
    if (mapDb) {
        sqlite3_stmt* stmt = nullptr;
        sqlite3_prepare_v2(mapDb,
            "SELECT room_id, port, pid, map_id, game_id, state "
            "FROM game_servers", -1, &stmt, nullptr);

        std::vector<uint32_t> staleRooms;
        size_t adopted = 0;
        while (stmt && sqlite3_step(stmt) == SQLITE_ROW) {
            uint32_t rid = sqlite3_column_int(stmt, 0);
            int port = sqlite3_column_int(stmt, 1);
            pid_t pid = sqlite3_column_int(stmt, 2);
            const unsigned char* mid = sqlite3_column_text(stmt, 3);
            const unsigned char* gid = sqlite3_column_text(stmt, 4);
            const unsigned char* st  = sqlite3_column_text(stmt, 5);

            if (!isProcessAlive(pid)) {
                staleRooms.push_back(rid);
                continue;
            }

            GameServerInstance inst;
            inst.roomId = rid;
            inst.port   = port;
            inst.pid    = pid;
            inst.mapId  = mid ? reinterpret_cast<const char*>(mid) : "";
            inst.gameId = gid ? reinterpret_cast<const char*>(gid) : "";
            // We don't know the live process's real state without
            // talking to it. Trust the persisted state for now; the
            // health-check loop downgrades to Ended if the pid dies.
            const std::string stateStr =
                st ? reinterpret_cast<const char*>(st) : "running";
            if      (stateStr == "starting") inst.state = GameServerInstance::Starting;
            else if (stateStr == "ended")    inst.state = GameServerInstance::Ended;
            else if (stateStr == "crashed")  inst.state = GameServerInstance::Crashed;
            else                             inst.state = GameServerInstance::Running;

            gameServers[rid] = inst;
            // Mirror the live port back into the in-memory room so the
            // browser shows the right "Rejoin" target.
            if (auto* room = rooms.GetRoom(rid)) {
                room->gameServerPort = static_cast<uint16_t>(port);
            }
            adopted++;
            SLOG(SPRING_LOG_NOTICE,
                "adopted game server room=%u pid=%d port=%d (%s)",
                rid, (int)pid, port, stateStr.c_str());
        }
        if (stmt) sqlite3_finalize(stmt);

        for (auto rid : staleRooms) {
            ExecPrepared(mapDb, "DELETE FROM game_servers WHERE room_id=?",
                [&](sqlite3_stmt* s) { sqlite3_bind_int(s, 1, static_cast<int>(rid)); });
            // Room metadata is persistent; if a row in `rooms` matches,
            // reset it back to Filling so the host can launch again.
            if (rooms.GetRoom(rid))
                rooms.ResetRoomForNextGame(rid);
            SLOG(SPRING_LOG_NOTICE,
                "game_servers row room=%u was stale (pid dead) — cleared", rid);
        }

        SLOG(SPRING_LOG_NOTICE,
            "startup: adopted %zu game server(s), cleaned %zu stale row(s)",
            adopted, staleRooms.size());
    }

    // --- Reconcile rooms stuck mid-launch ---
    // A room in Loading/Active state must be backed by a live game server.
    // If the adoption pass above found none (the process died and its
    // game_servers row was already gone — e.g. a lobby restart raced the
    // bookkeeping), the room is orphaned: the health-check loop only watches
    // adopted servers, and the reaper below deliberately skips Loading/Active.
    // Reset any such room to Filling so it's usable again (and reapable if it
    // turns out to be abandoned).
    for (GameRoom* room : rooms.GetAllRooms()) {
        if ((room->state == ERoomState::Loading ||
             room->state == ERoomState::Active) &&
            gameServers.find(room->id) == gameServers.end()) {
            SLOG(SPRING_LOG_NOTICE,
                "room %u: %s with no live game server — resetting to Filling",
                room->id, room->state == ERoomState::Active ? "Active" : "Loading");
            rooms.ResetRoomForNextGame(room->id);
        }
    }

    // --- Reap abandoned rooms ---
    // The lobby is HTTP-only — no persistent lobby socket means a closed
    // browser never abandons its room, so non-persistent rooms with no live
    // game pile up in the DB and reload on every restart. Sweep them on
    // startup and periodically (below). Idle threshold is a proxy for player
    // presence (the HTTP lobby tracks no liveness). Rooms hosting a live game
    // and persistent rooms are always kept.
    constexpr int64_t kRoomIdleReapSeconds = 30 * 60;  // 30 minutes
    {
        auto reaped = rooms.ReapStaleRooms(kRoomIdleReapSeconds);
        if (!reaped.empty())
            SLOG(SPRING_LOG_NOTICE, "startup: reaped %zu abandoned room(s)",
                reaped.size());
    }

    // Reset any room stuck in Loading/Active without a live game-server.
    // Happens when the previous lobby was killed mid-game without a
    // clean shutdown (so room.state was persisted as Loading), or when
    // the game-server died while the lobby was running but its zombie
    // kept isProcessAlive returning true (waitpid fix applied at the
    // same time as this sweep). Without this, the room sits in
    // "Loading" forever in the browser and the host can't relaunch.
    {
        size_t reset = 0;
        for (auto* room : rooms.GetAllRooms()) {
            const auto st = static_cast<int>(room->state);
            const bool inFlight = (st >= 3 && st <= 4); // Loading, Active
            if (!inFlight) continue;
            if (gameServers.count(room->id) > 0) continue; // adopted; alive
            SLOG(SPRING_LOG_NOTICE,
                "room %u stuck in state=%d with no game-server — resetting",
                room->id, st);
            rooms.ResetRoomForNextGame(room->id);
            reset++;
        }
        if (reset > 0) {
            SLOG(SPRING_LOG_NOTICE, "startup: reset %zu orphaned room(s)", reset);
        }
    }

    // --- Network ---
    NetworkServer net;

    // PLAN-security-hardening task 6 (G20): wire the default-deny dispatch
    // gate for RouteAuth::TokenRequired/AdminOnly/LocalhostOrAdmin routes.
    net.SetRouteAuthCallbacks({
        .validateToken = [&db](const std::string& authHeader) -> int64_t {
            return HttpAuth::ValidateAuth(db, authHeader);
        },
        .isAdmin = [&db](int64_t userId) -> bool {
            auto user = db.FindUserById(userId);
            return user && user->role == "admin";
        },
    });

    // SSE channel for real-time room list pushes (replaces client polling)
    uint32_t roomStreamChannel = net.AddSSE("/api/rooms/stream");

    // Maps endpoint — full metadata from SQLite
    net.AddHttpGet("/api/maps", RouteAuth::Public, [mapDb](const std::string&) -> HttpResponse {
        MapMetadataDb db;
        auto maps = db.GetAllMaps(mapDb);
        nlohmann::json arr = nlohmann::json::array();
        for (const auto& m : maps) {
            nlohmann::json mj;
            mj["id"] = m.id;
            mj["name"] = m.name;
            mj["shortName"] = m.shortName;
            mj["description"] = m.description;
            mj["author"] = m.author;
            mj["version"] = m.version;
            mj["mapx"] = m.mapx;
            mj["mapy"] = m.mapy;
            mj["widthElmos"] = m.widthElmos;
            mj["heightElmos"] = m.heightElmos;
            mj["minHeight"] = m.minHeight;
            mj["maxHeight"] = m.maxHeight;
            mj["gravity"] = m.gravity;
            mj["tidalStrength"] = m.tidalStrength;
            mj["maxMetal"] = m.maxMetal;
            mj["extractorRadius"] = m.extractorRadius;
            mj["tilesX"] = m.tilesX;
            mj["tilesZ"] = m.tilesZ;
            mj["numTiles"] = m.numTiles;
            mj["maxPlayers"] = m.startPositions.size();
            mj["startPositions"] = nlohmann::json::array();
            for (const auto& sp : m.startPositions)
                mj["startPositions"].push_back({{"x", sp.x}, {"z", sp.z}});
            mj["hasLuaGaia"] = m.hasLuaGaia;
            mj["minimapUrl"] = "/api/maps/data/" + m.id + "/minimap.ktx2";
            arr.push_back(std::move(mj));
        }
        std::string json = arr.dump();
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // Static map / game / engine assets are no longer served by the
    // lobby. In dev the Vite plugin (client/vite-static-data-plugin.ts)
    // serves them with proper Last-Modified / ETag revalidation. In
    // production an external static server (nginx / apache / CDN) is
    // required for `/api/games/data/*`, `/api/maps/data/*` (except
    // the dynamic `metadata.json` below), `/api/engine/data/*` and
    // `/api/maps/thumb/*`, plus the built client bundle from
    // `client/dist/`. See CLAUDE.md for the production deployment notes.
    //
    // The only thing the lobby still serves under `/api/maps/data/*`
    // is the dynamic `metadata.json` endpoint, because it pulls live
    // map data out of the MapMetadataDb (SQLite) and composes URLs
    // pointing at the static files.
    net.AddHttpGet("/api/maps/data/*", RouteAuth::Public, [mapDb](const std::string& url) -> HttpResponse {
        // URL: /api/maps/data/{mapId}/metadata.json
        std::string rest = url.substr(std::string("/api/maps/data/").size());
        if (rest.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        auto slashPos = rest.find('/');
        if (slashPos != std::string::npos) {
            std::string mapId = rest.substr(0, slashPos);
            std::string filename = rest.substr(slashPos + 1);
            if (filename == "metadata.json") {
                MapMetadataDb db;
                auto m = db.GetMap(mapDb, mapId);
                if (m.id.empty())
                    return {.contentType = "text/plain", .body = {}, .status = 404};

                // Build JSON metadata
                nlohmann::json j;
                j["mapx"] = m.mapx;
                j["mapy"] = m.mapy;
                j["squareSize"] = 8;
                j["minHeight"] = m.minHeight;
                j["maxHeight"] = m.maxHeight;
                j["tilesX"] = m.tilesX;
                j["tilesZ"] = m.tilesZ;
                j["numTiles"] = m.numTiles;
                j["tileSize"] = 32;

                // Start positions
                j["startPositions"] = nlohmann::json::array();
                for (const auto& sp : m.startPositions)
                    j["startPositions"].push_back({{"x", sp.x}, {"z", sp.z}});

                // Feature types
                j["featureTypes"] = m.featureTypes;

                // Features
                j["features"] = nlohmann::json::array();
                for (const auto& f : m.features) {
                    j["features"].push_back({
                        {"typeIndex", f.featureType},
                        {"x", f.x}, {"y", f.y}, {"z", f.z},
                        {"rotation", f.rotation},
                        {"relativeSize", f.relativeSize},
                    });
                }

                // Feature defs
                j["featureDefs"] = nlohmann::json::array();
                for (const auto& d : m.featureDefs) {
                    std::string modelUrl = d.modelFile.empty()
                        ? "" : "/api/maps/data/" + m.id + "/features/" + d.modelFile;
                    std::string texUrl = d.textureFile.empty()
                        ? "" : "/api/maps/data/" + m.id + "/features/" + d.textureFile;
                    j["featureDefs"].push_back({
                        {"name", d.name},
                        {"modelUrl", modelUrl},
                        {"textureUrl", texUrl},
                        {"footprintX", d.footprintX},
                        {"footprintZ", d.footprintZ},
                        {"height", d.height},
                        {"radius", d.radius},
                        {"blocking", d.blocking},
                        {"reclaimable", d.reclaimable},
                        {"metal", d.metal},
                        {"energy", d.energy},
                        {"damage", d.damage},
                    });
                }

                // Decals
                auto decalUrl = [&](const std::string& f) -> std::string {
                    if (f.empty()) return "";
                    return "/api/maps/data/" + m.id + "/" + f;
                };
                {
                    nlohmann::json dj;
                    dj["detailTex"] = decalUrl(m.decals.detailTex);
                    dj["specularTex"] = decalUrl(m.decals.specularTex);
                    dj["splatDetailTex"] = decalUrl(m.decals.splatDetailTex);
                    dj["splatDistrTex"] = decalUrl(m.decals.splatDistrTex);
                    dj["splatNormal"] = {
                        decalUrl(m.decals.splatDetailNormalTex[0]),
                        decalUrl(m.decals.splatDetailNormalTex[1]),
                        decalUrl(m.decals.splatDetailNormalTex[2]),
                        decalUrl(m.decals.splatDetailNormalTex[3]),
                    };
                    dj["detailNormalTex"] = decalUrl(m.decals.detailNormalTex);
                    dj["splatScales"] = {
                        m.decals.splatScales[0], m.decals.splatScales[1],
                        m.decals.splatScales[2], m.decals.splatScales[3],
                    };
                    dj["splatMults"] = {
                        m.decals.splatMults[0], m.decals.splatMults[1],
                        m.decals.splatMults[2], m.decals.splatMults[3],
                    };
                    j["decals"] = std::move(dj);
                }

                // Water
                {
                    nlohmann::json wj;
                    wj["baseColor"] = {m.water.baseColor[0], m.water.baseColor[1], m.water.baseColor[2]};
                    wj["surfaceColor"] = {m.water.surfaceColor[0], m.water.surfaceColor[1], m.water.surfaceColor[2]};
                    wj["minColor"] = {m.water.minColor[0], m.water.minColor[1], m.water.minColor[2]};
                    wj["surfaceAlpha"] = m.water.surfaceAlpha;
                    wj["damage"] = m.water.damage;
                    wj["voidWater"] = m.water.voidWater;
                    j["water"] = std::move(wj);
                }

                // hasLuaGaia
                j["hasLuaGaia"] = m.hasLuaGaia;

                // Map sound preset (from mapinfo.lua's `sound = { preset = ... }`).
                // Client maps this to AudioManager.setReverbPreset; missing
                // / empty / "default" means no reverb.
                j["soundPreset"] = m.soundPreset;

                // Widgets
                j["widgets"] = m.widgets;

                // URLs for binary data and source assets
                j["minimapUrl"] = "/api/maps/data/" + m.id + "/minimap.ktx2";
                j["tilesUrl"] = "/api/maps/data/" + m.id + "/tiles.ktx2";
                j["mapDataUrl"] = "/api/maps/data/" + m.id;
                j["mapSourceUrl"] = "/api/maps/data/" + m.id;

                std::string json = j.dump();
                std::vector<uint8_t> body(json.begin(), json.end());
                return {
                    .contentType = "application/json",
                    .body = std::move(body),
                    .status = 200,
                    .cacheControl = CacheControl::StaticAssetHeader(),
                };
            }
        }

        // All other `/api/maps/data/*` paths are static assets served by
        // the Vite plugin in dev / nginx-or-CDN in prod.
        return {.contentType = "text/plain", .body = {}, .status = 404};
    });

    // The static handlers for `/api/games/data/*`, `/api/engine/data/*`,
    // and `/api/maps/thumb/*` were removed (2026-05-25). Dev now uses
    // the Vite static-data plugin (client/vite-static-data-plugin.ts)
    // with native Last-Modified / ETag revalidation; production
    // requires nginx/apache/CDN to serve those paths (see CLAUDE.md
    // production deployment notes).

    // --- Process management API ---
    // PLAN-security-hardening task 2 (G12): unauthenticated PID/port
    // disclosure is fine for local dev tooling (spring-debug MCP) but has no
    // place in a production binary — compiled out under SPRING_PROD rather
    // than left reachable-but-role-gated, since dev tooling connects with no
    // admin token at all.
#ifndef SPRING_PROD
    net.AddHttpGet("/api/processes", RouteAuth::Public, [&gameServers](const std::string&) -> HttpResponse {
        nlohmann::json arr = nlohmann::json::array();
        for (const auto& [roomId, inst] : gameServers) {
            const char* stateStr = "unknown";
            switch (inst.state) {
                case GameServerInstance::Starting: stateStr = "starting"; break;
                case GameServerInstance::Running:  stateStr = "running"; break;
                case GameServerInstance::Ended:    stateStr = "ended"; break;
                case GameServerInstance::Crashed:  stateStr = "crashed"; break;
            }
            arr.push_back({
                {"room_id", roomId},
                {"port", inst.port},
                {"pid", (int)inst.pid},
                {"state", stateStr},
                {"map", inst.mapId},
                {"game", inst.gameId},
            });
        }
        std::string json = arr.dump();
        return {.contentType = "application/json", .body = {json.begin(), json.end()}, .status = 200,
                .cacheControl = "no-cache"};
    });
#endif // !SPRING_PROD

    // --- HTTP auth endpoints ---
    HttpAuth::RegisterEndpoints(net, db);

    // Version endpoint — clients use this to get the build stamp for cache-busting
    net.AddHttpGet("/api/version", RouteAuth::Public, [clientErrorReportsEnabled](const std::string&) -> HttpResponse {
        std::string json = std::string("{\"engine\":\"springweb\"")
            + ",\"stamp\":\"" + CacheControl::BuildStamp() + "\""
            + ",\"no_cache\":" + (CacheControl::IsNoCache() ? "true" : "false")
            + ",\"errorReportingEnabled\":" + (clientErrorReportsEnabled ? "true" : "false") + "}";
        return {.contentType = "application/json",
                .body = {json.begin(), json.end()}, .status = 200,
                .cacheControl = CacheControl::DynamicHeader()};
    });

    // PLAN-client-resilience.md task 3: client crash/fatal report ingestion.
    // TokenRequired (not AdminOnly) — this is a "players" surface per
    // PLAN-security-hardening.md §1's row ("junk floods" risk, mitigated by
    // size cap + per-session rate + dedup — the client enforces its own
    // 5/hour advisory cap; CountRecentClientErrors below is the server-side
    // backstop for a client that ignores it). No SafeInvoke wrapper exists on
    // this branch yet (see DECISIONS.md Part 6 hygiene note) — every
    // exception-capable call is inside the try/catch so a malformed report
    // can't take the whole lobby down with it.
    net.AddHttpPost("/api/client-errors", RouteAuth::TokenRequired,
        [&db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0) return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

        // Client caps its own payload at 32KB; 40KB gives headroom for JSON
        // overhead without trusting the client to actually enforce its cap.
        if (body.size() > 40 * 1024)
            return HttpAuth::JsonResponse(413, R"({"error":"report too large"})");

        if (db.CountRecentClientErrors(userId, 3600) >= 20)
            return HttpAuth::JsonResponse(429, R"({"error":"rate limited"})");

        try {
            nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/true);
            if (!j.is_object())
                return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");

            Database::ClientErrorRecord rec;
            rec.userId = userId;
            rec.reason = j.value("reason", "");
            rec.errorClass = j.value("error_class", "");
            rec.message = j.value("message", "");
            rec.stack = j.value("stack", "");
            rec.stackHash = j.value("stack_hash", "");
            rec.recoveryRung = j.value("recovery_rung", "");
            rec.phase = j.value("phase", "");
            rec.frame = j.value("frame", 0);
            rec.entityCount = j.value("entity_count", 0);
            rec.gameId = j.value("game_id", "");
            rec.mapId = j.value("map_id", "");
            rec.buildStamp = j.value("build_stamp", "");
            rec.gpuRenderer = j.value("gpu_renderer", "");
            rec.count = j.value("count", 1);
            if (j.contains("log_ring") && j["log_ring"].is_array()) {
                std::string joined;
                for (const auto& line : j["log_ring"]) {
                    if (!line.is_string()) continue;
                    if (!joined.empty()) joined += "\n";
                    joined += line.get<std::string>();
                }
                rec.logRing = joined;
            }

            int64_t id = db.InsertClientError(rec);
            std::string resp = "{\"ok\":true,\"id\":" + std::to_string(id) + "}";
            return {.contentType = "application/json", .body = {resp.begin(), resp.end()}, .status = 200};
        } catch (const std::exception&) {
            return HttpAuth::JsonResponse(400, R"({"error":"malformed report"})");
        }
    });

    // ─────── PLAN-gm-tools: GM dashboard + admin verbs (lobby side) ───────
    // The GM per-game verbs (pause/rollback/grant/broadcast/inspect/kick) live
    // on each game server's own /api/gm/<verb> plane (browser→game port, same
    // admin token — the proven admin path; there is no lobby→game HTTP client).
    // The lobby owns: the fleet/timeline data (shared SQLite), account-level
    // ban, and the server-rendered dashboard page. These are the *production*
    // GM surface, so unlike /api/exec they are NOT compiled out under SPRING_PROD.
    auto requireLobbyAdmin = [&db](const HttpRequestHeaders& headers, int64_t& userId,
                                   std::string& username) -> std::optional<HttpResponse> {
        userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0)
            return HttpAuth::JsonResponse(401, R"({"ok":false,"error":"unauthorized"})");
        auto user = db.FindUserById(userId);
        if (!user || user->role != "admin")
            return HttpAuth::JsonResponse(403, R"({"ok":false,"error":"forbidden — admin role required"})");
        username = user->username;
        return std::nullopt;
    };

    // GET /admin — the server-rendered dashboard shell. Public (it's just HTML/JS
    // with its own login); every data route it calls is POST + AdminOnly.
    net.AddHttpGet("/admin", RouteAuth::Public, [](const std::string&) -> HttpResponse {
        std::string html = kGmDashboardHtml;
        return {.contentType = "text/html; charset=utf-8",
                .body = {html.begin(), html.end()}, .status = 200,
                .cacheControl = "no-cache"};
    });

    // POST /api/admin/fleet — every game server + its latest sim-health metrics.
    // GET can't carry a token (dispatch gate only sees POST headers), so admin
    // data endpoints are POST.
    net.AddHttpPost("/api/admin/fleet", RouteAuth::AdminOnly,
        [mapDb, requireLobbyAdmin](const std::string&, const std::string&,
                                   const HttpRequestHeaders& headers) -> HttpResponse {
            int64_t uid; std::string uname;
            if (auto e = requireLobbyAdmin(headers, uid, uname)) return *e;
            nlohmann::json games = nlohmann::json::array();
            if (mapDb) {
                // game_servers ⟕ game_status ⟕ latest game_metrics row per room.
                const char* sql =
                    "SELECT gs.room_id, gs.port, gs.pid, gs.map_id, gs.game_id, gs.state, "
                    "       st.ready, st.client_count, "
                    "       m.frame, m.tick_p95_us, m.frames_behind, m.entity_count, "
                    "       m.sim_fps, m.uptime_sec, m.db_size_bytes, m.snapshot_age_sec "
                    "FROM game_servers gs "
                    "LEFT JOIN game_status st ON st.room_id = gs.room_id "
                    "LEFT JOIN (SELECT room_id, MAX(id) AS mid FROM game_metrics GROUP BY room_id) lm "
                    "       ON lm.room_id = gs.room_id "
                    "LEFT JOIN game_metrics m ON m.id = lm.mid "
                    "ORDER BY gs.room_id";
                sqlite3_stmt* s = nullptr;
                if (sqlite3_prepare_v2(mapDb, sql, -1, &s, nullptr) == SQLITE_OK) {
                    auto colInt = [&](int c) -> nlohmann::json {
                        return sqlite3_column_type(s, c) == SQLITE_NULL
                            ? nlohmann::json(nullptr) : nlohmann::json(sqlite3_column_int64(s, c));
                    };
                    auto colTxt = [&](int c) -> std::string {
                        auto* t = sqlite3_column_text(s, c);
                        return t ? reinterpret_cast<const char*>(t) : "";
                    };
                    while (sqlite3_step(s) == SQLITE_ROW) {
                        nlohmann::json g;
                        g["room_id"] = sqlite3_column_int(s, 0);
                        g["port"] = sqlite3_column_int(s, 1);
                        g["game_id"] = colTxt(4);
                        g["map_id"] = colTxt(3);
                        g["state"] = colTxt(5);
                        g["client_count"] = colInt(7);
                        g["frame"] = colInt(8);
                        g["tick_p95_us"] = colInt(9);
                        g["frames_behind"] = colInt(10);
                        g["entity_count"] = colInt(11);
                        g["sim_fps"] = sqlite3_column_type(s, 12) == SQLITE_NULL
                            ? nlohmann::json(nullptr) : nlohmann::json(sqlite3_column_double(s, 12));
                        g["uptime_sec"] = colInt(13);
                        g["db_size_bytes"] = colInt(14);
                        g["snapshot_age_sec"] = colInt(15);
                        // Engine-sourced alarm badges (economy/long-uptime Lua
                        // counters land here once that Stage-7 Lua exists).
                        nlohmann::json alarms = nlohmann::json::array();
                        const std::string state = colTxt(5);
                        if (sqlite3_column_type(s, 10) != SQLITE_NULL && sqlite3_column_int(s, 10) > 60)
                            alarms.push_back({{"label", "lag"}, {"crit", true}});
                        if (sqlite3_column_type(s, 14) != SQLITE_NULL &&
                            sqlite3_column_int64(s, 14) > 1024LL * 1024 * 1024)
                            alarms.push_back({{"label", "db"}, {"crit", false}});
                        if (state == "crashed")
                            alarms.push_back({{"label", "crashed"}, {"crit", true}});
                        g["alarms"] = alarms;
                        games.push_back(std::move(g));
                    }
                }
                if (s) sqlite3_finalize(s);
            }
            nlohmann::json out;
            out["ok"] = true;
            out["games"] = games;
            return HttpAuth::JsonResponse(200, out.dump());
        });

    // POST /api/admin/game {roomId} — metric timeline + audit tail for one game.
    net.AddHttpPost("/api/admin/game", RouteAuth::AdminOnly,
        [mapDb, &db, requireLobbyAdmin](const std::string&, const std::string& body,
                                        const HttpRequestHeaders& headers) -> HttpResponse {
            int64_t uid; std::string uname;
            if (auto e = requireLobbyAdmin(headers, uid, uname)) return *e;
            nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
            if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"ok":false,"error":"bad json"})");
            const int roomId = j.value("roomId", -1);
            if (roomId < 0) return HttpAuth::JsonResponse(400, R"({"ok":false,"error":"roomId required"})");

            nlohmann::json timeline = nlohmann::json::array();
            if (mapDb) {
                sqlite3_stmt* s = nullptr;
                const char* sql =
                    "SELECT frame, taken_at, resolution, tick_p95_us, frames_behind, "
                    "entity_count, client_count, sim_fps, uptime_sec, db_size_bytes "
                    "FROM game_metrics WHERE room_id=? ORDER BY id DESC LIMIT 200";
                if (sqlite3_prepare_v2(mapDb, sql, -1, &s, nullptr) == SQLITE_OK) {
                    sqlite3_bind_int(s, 1, roomId);
                    while (sqlite3_step(s) == SQLITE_ROW) {
                        timeline.push_back({
                            {"frame", sqlite3_column_int(s, 0)},
                            {"taken_at", sqlite3_column_int64(s, 1)},
                            {"resolution", reinterpret_cast<const char*>(sqlite3_column_text(s, 2))},
                            {"tick_p95_us", sqlite3_column_int64(s, 3)},
                            {"frames_behind", sqlite3_column_int64(s, 4)},
                            {"entity_count", sqlite3_column_int(s, 5)},
                            {"client_count", sqlite3_column_int(s, 6)},
                            {"sim_fps", sqlite3_column_double(s, 7)},
                            {"uptime_sec", sqlite3_column_int64(s, 8)},
                            {"db_size_bytes", sqlite3_column_int64(s, 9)},
                        });
                    }
                }
                if (s) sqlite3_finalize(s);
            }
            // Audit tail for this game: GM verbs audit with roomTag "room=<id>"
            // or target "frame=…"; match on the room tag. (admin_audit has no
            // room column — the LIKE is a pragmatic per-game filter.)
            nlohmann::json audit = nlohmann::json::array();
            {
                const std::string tag = "room=" + std::to_string(roomId);
                for (const auto& e : db.GetRecentAuditEntries(400)) {
                    if (e.argsDigest.find(tag) == std::string::npos &&
                        e.target.find(tag) == std::string::npos) continue;
                    audit.push_back({{"createdAt", e.createdAt}, {"username", e.username},
                                     {"action", e.action}, {"target", e.target},
                                     {"argsDigest", e.argsDigest}});
                    if (audit.size() >= 60) break;
                }
            }
            nlohmann::json out;
            out["ok"] = true;
            out["timeline"] = timeline;
            out["audit"] = audit;
            return HttpAuth::JsonResponse(200, out.dump());
        });

    // POST /api/admin/ban {username} — account ban + immediate session revoke.
    net.AddHttpPost("/api/admin/ban", RouteAuth::AdminOnly,
        [&db, requireLobbyAdmin](const std::string&, const std::string& body,
                                 const HttpRequestHeaders& headers) -> HttpResponse {
            int64_t uid; std::string uname;
            if (auto e = requireLobbyAdmin(headers, uid, uname)) return *e;
            nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
            const std::string target = j.is_discarded() ? "" : j.value("username", std::string(""));
            if (target.empty()) return HttpAuth::JsonResponse(400, R"({"ok":false,"error":"username required"})");
            int64_t targetId = 0;
            if (!db.SetBannedByUsername(target, true, targetId))
                return HttpAuth::JsonResponse(404, R"({"ok":false,"error":"no such user"})");
            const int revoked = db.RevokeUserSessions(targetId);
            db.LogAudit(uid, uname, "ban", target, "sessions_revoked=" + std::to_string(revoked));
            return HttpAuth::JsonResponse(200,
                std::string(R"({"ok":true,"revoked":)") + std::to_string(revoked) + "}");
        });

    // POST /api/admin/unban {username}
    net.AddHttpPost("/api/admin/unban", RouteAuth::AdminOnly,
        [&db, requireLobbyAdmin](const std::string&, const std::string& body,
                                 const HttpRequestHeaders& headers) -> HttpResponse {
            int64_t uid; std::string uname;
            if (auto e = requireLobbyAdmin(headers, uid, uname)) return *e;
            nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
            const std::string target = j.is_discarded() ? "" : j.value("username", std::string(""));
            if (target.empty()) return HttpAuth::JsonResponse(400, R"({"ok":false,"error":"username required"})");
            int64_t targetId = 0;
            if (!db.SetBannedByUsername(target, false, targetId))
                return HttpAuth::JsonResponse(404, R"({"ok":false,"error":"no such user"})");
            db.LogAudit(uid, uname, "unban", target, "");
            return HttpAuth::JsonResponse(200, R"({"ok":true})");
        });

    // POST /api/admin/banned — the current ban list.
    net.AddHttpPost("/api/admin/banned", RouteAuth::AdminOnly,
        [&db, requireLobbyAdmin](const std::string&, const std::string&,
                                 const HttpRequestHeaders& headers) -> HttpResponse {
            int64_t uid; std::string uname;
            if (auto e = requireLobbyAdmin(headers, uid, uname)) return *e;
            nlohmann::json banned = nlohmann::json::array();
            for (const auto& u : db.GetBannedUsers(200))
                banned.push_back({{"id", u.id}, {"username", u.username}, {"role", u.role}});
            nlohmann::json out; out["ok"] = true; out["banned"] = banned;
            return HttpAuth::JsonResponse(200, out.dump());
        });

    // --- HTTP exec endpoint (for CLI/curl access to lobby commands) ---
    // PLAN-security-hardening task 2: compiled OUT entirely under
    // SPRING_PROD, not just role-gated — arbitrary SQLite exec on the map DB
    // has no place in a production binary, belt-and-braces on top of the
    // AdminOnly dispatch gate + the handler's own role check below.
#ifndef SPRING_PROD
    net.AddHttpPost("/api/exec", RouteAuth::AdminOnly, [&rooms, &gameServers, mapDb, &db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        // Validate auth token
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0) {
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized — use POST /api/auth/login first"})");
        }
        // S2: /api/exec runs privileged SQL + lobby control commands. Gate on
        // the admin role — a plain authenticated player must not reach it.
        std::string execUsername;
        {
            auto execUser = db.FindUserById(userId);
            if (!execUser || execUser->role != "admin") {
                return HttpAuth::JsonResponse(403, R"({"error":"forbidden — admin role required"})");
            }
            execUsername = execUser->username;
        }

        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string scope = j.value("scope", "");
        std::string code = j.value("code", "");
        bool success = true;
        std::string output;

        // Task 6: append-only admin audit trail — who ran what, when.
        // args_digest is truncated so a huge SQL blob can't bloat the table.
        db.LogAudit(userId, execUsername, "exec", scope, code.substr(0, 200));

        if (scope == "sql") {
            std::string upper = code;
            for (auto& c : upper) c = (char)toupper((unsigned char)c);
            bool rejected = false;
            for (const char* kw : {"INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE"}) {
                if (upper.find(kw) != std::string::npos) { rejected = true; break; }
            }
            if (rejected) {
                output = "read-only: mutation queries not allowed";
                success = false;
            } else {
                char* errMsg = nullptr;
                auto callback = [](void* data, int ncols, char** vals, char** names) -> int {
                    auto* out = static_cast<std::string*>(data);
                    if (!out->empty()) *out += "\\n";
                    for (int i = 0; i < ncols; i++) {
                        if (i > 0) *out += " | ";
                        *out += std::string(names[i]) + "=" + (vals[i] ? vals[i] : "NULL");
                    }
                    return 0;
                };
                int rc = sqlite3_exec(mapDb, code.c_str(), callback, &output, &errMsg);
                if (rc != SQLITE_OK) {
                    output = errMsg ? errMsg : "unknown error";
                    if (errMsg) sqlite3_free(errMsg);
                    success = false;
                }
                if (output.empty()) output = "(no results)";
            }
        } else if (scope == "lobby") {
            if (code == "rooms") {
                auto allRooms = rooms.GetAllRooms();
                for (const auto* r : allRooms) {
                    if (!r) continue;
                    if (!output.empty()) output += "\\n";
                    output += "Room " + std::to_string(r->id) + ": " + r->name
                        + " (" + std::to_string(r->players.size()) + " players)";
                }
                if (output.empty()) output = "(no rooms)";
            } else if (code == "process list") {
                for (const auto& [rid, inst] : gameServers) {
                    if (!output.empty()) output += "\\n";
                    output += "Room " + std::to_string(rid)
                        + ": pid=" + std::to_string(inst.pid)
                        + " port=" + std::to_string(inst.port);
                }
                if (output.empty()) output = "(no game servers)";
            } else if (code == "restart") {
                output = "restarting lobby server...";
                restartRequested.store(true);
                keepRunning.store(false);
            } else {
                output = "unknown lobby command: " + code;
                success = false;
            }
        } else {
            output = "unknown scope (lobby handles: sql, lobby)";
            success = false;
        }

        std::string json = "{\"success\":" + std::string(success ? "true" : "false")
            + ",\"output\":\"" + HttpAuth::JsonEscape(output) + "\"}";
        return HttpAuth::JsonResponse(200, json);
    });
#endif // !SPRING_PROD

    // --- Room management HTTP endpoints ---
    // These mirror the WebSocket room commands for CLI/automation access.

    // Helper: get userId from auth header, return 0 + send 401 if invalid
    auto requireAuth = [&db](const HttpRequestHeaders& headers) -> int64_t {
        return HttpAuth::ValidateToken(db, headers.authorization);
    };

    // Helper: find a player's room by their userId
    auto findPlayerRoom = [&rooms](uint32_t userId) -> GameRoom* {
        // RoomManager doesn't have a FindRoomByUserId, so scan all rooms
        for (auto* room : rooms.GetAllRooms()) {
            if (!room) continue;
            if (room->FindPlayer(userId)) return room;
        }
        return nullptr;
    };

    // Helper: JSON-serialize a room for API responses
    auto roomToJson = [](const GameRoom* room) -> std::string {
        if (!room) return "null";
        nlohmann::json j;
        j["id"] = room->id;
        j["name"] = room->name;
        j["map"] = room->mapId;
        j["game"] = room->gameId;
        j["state"] = static_cast<int>(room->state);
        j["players"] = nlohmann::json::array();
        for (const auto& p : room->players) {
            nlohmann::json pj;
            pj["player_id"] = p.playerId;
            pj["username"] = p.username;
            pj["team"] = p.team;
            pj["ready"] = p.ready;
            pj["is_host"] = p.isHost;
            pj["start_pos"] = p.startPos;
            j["players"].push_back(std::move(pj));
        }
        j["ai_slots"] = nlohmann::json::array();
        for (const auto& ai : room->aiSlots) {
            nlohmann::json aj;
            aj["ai_id"] = ai.aiId;
            aj["name"] = ai.displayName;
            aj["team"] = ai.team;
            aj["start_pos"] = ai.startPos;
            j["ai_slots"].push_back(std::move(aj));
        }
        j["modoptions"] = nlohmann::json::object();
        for (const auto& [key, value] : room->modOptions)
            j["modoptions"][key] = value;
        if (room->gameServerPort > 0)
            j["game_server_port"] = room->gameServerPort;
        if (room->persistent)
            j["persistent"] = true;
        return j.dump();
    };

    #define HTTP_ROOM_AUTH() \
        int64_t userId = requireAuth(headers); \
        if (userId <= 0) return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

    // Broadcast the full room list to all SSE subscribers.
    // Called after every room mutation so clients stay in sync.
    auto broadcastRooms = [&]() {
        auto allRooms = rooms.GetAllRooms();
        std::string json = "[";
        bool first = true;
        for (const auto* r : allRooms) {
            if (!r) continue;
            if (!first) json += ",";
            first = false;
            json += roomToJson(r);
        }
        json += "]";
        net.SendSSE(roomStreamChannel, json, "rooms");
    };

    // --- PLAN-quickstart.md Part A: direct-start composite ---
    //
    // Mint (or create) a session for a manifest-declared username without a
    // password step. A missing account is created dev-flagged (is_dev=1)
    // with an unusable random password hash — it can never log in via
    // /api/auth/login, only via the token minted here.
    auto ensureDevSession = [&](const std::string& username) -> std::pair<uint32_t, std::string> {
        auto user = db.FindUser(username);
        int64_t uid;
        if (user) {
            uid = user->id;
        } else {
            uid = db.CreateUser(username, Crypto::HashPassword(Crypto::GenerateToken(32)),
                "player", /*isDev=*/true);
        }
        std::string token = HttpAuth::GenerateToken();
        db.CreateSession(uid, token);
        return {static_cast<uint32_t>(uid), token};
    };

    struct ResolvedPlayer {
        uint32_t userId;
        std::string username;
        uint8_t team;
        int8_t startPos;
        bool spectator;
    };

    struct DirectStartResult {
        bool ok = false;
        std::string error;
        uint32_t roomId = 0;
        std::unordered_map<std::string, std::string> sessions;
    };

    // Composes CreateRoom -> modoptions -> AI slots -> player joins ->
    // ready -> StartGame -> spawnGameServer: the same sequence
    // /api/rooms/start already drives (§2.2 "reuse rooms/start's path so
    // nothing forks"), gathered from one manifest instead of N round trips.
    // Returns as soon as the game-server process is spawned and its port
    // known (room state = Loading) — the same synchronous contract
    // /api/rooms/start already has. The room flips Loading->Active
    // asynchronously via the health-check loop below, same as today; the
    // client's existing connect-retry logic already tolerates that gap.
    auto runDirectStart = [&](const nlohmann::json& manifest) -> DirectStartResult {
        DirectStartResult result;

        std::string name = manifest.value("name", "");
        if (name.empty()) name = "dev:direct";
        std::string mapId = manifest.value("map", "");
        std::string gameId = manifest.value("game", "");
        if (gameId.empty() && !availableGames.empty()) gameId = availableGames[0].id;
        if (mapId.empty()) { result.error = "map is required"; return result; }

        if (!manifest.contains("players") || !manifest["players"].is_array() ||
            manifest["players"].empty()) {
            result.error = "players[] must declare at least one player (the host)";
            return result;
        }

        // Idempotent restarts (§2.2): a standing room re-created under the
        // same name replaces the old one rather than accumulating duplicates.
        for (auto* existing : rooms.GetAllRooms()) {
            if (existing && existing->name == name) {
                auto gsIt = gameServers.find(existing->id);
                if (gsIt != gameServers.end()) {
                    kill(gsIt->second.pid, SIGTERM);
                    removeGameServer(existing->id);
                    gameServers.erase(gsIt);
                }
                rooms.DeleteRoom(existing->id);
                break;
            }
        }

        // E1: a declared player already in a (different) room is force-left
        // — the direct endpoint owns the whole dance atomically now.
        auto forceLeaveCurrentRoom = [&](uint32_t playerId) {
            auto* prior = findPlayerRoom(playerId);
            if (!prior) return;
            uint32_t priorId = prior->id;
            auto res = rooms.LeaveRoom(priorId, playerId);
            if (res == LeaveResult::Abandoned) {
                auto gsIt = gameServers.find(priorId);
                if (gsIt != gameServers.end()) {
                    kill(gsIt->second.pid, SIGTERM);
                    removeGameServer(priorId);
                    gameServers.erase(gsIt);
                }
                rooms.DeleteRoom(priorId);
            }
        };

        std::vector<ResolvedPlayer> resolvedPlayers;
        resolvedPlayers.reserve(manifest["players"].size());
        for (const auto& pj : manifest["players"]) {
            std::string username = pj.value("username", "");
            if (username.empty()) { result.error = "player entry missing username"; return result; }
            auto [uid, token] = ensureDevSession(username);
            result.sessions[username] = token;
            resolvedPlayers.push_back({
                uid, username,
                static_cast<uint8_t>(pj.value("team", 0)),
                static_cast<int8_t>(pj.value("startPos", -1)),
                pj.value("spectator", false),
            });
        }

        const ResolvedPlayer& host = resolvedPlayers[0];
        forceLeaveCurrentRoom(host.userId);

        uint32_t roomId = rooms.CreateRoom(name, mapId, gameId, 8, "",
            host.userId, 0, host.username, /*persistent=*/false);
        result.roomId = roomId;

        MapMetadataDb mdb;
        const size_t spCount = mdb.GetMap(mapDb, mapId).startPositions.size();
        const int8_t maxStartPos = static_cast<int8_t>(spCount > 127 ? 127 : spCount);

        // Host was added by CreateRoom as team 0, non-spectator, unready —
        // apply the manifest's team/startPos/ready on top.
        rooms.SetTeam(roomId, host.userId, host.team);
        if (host.startPos >= 0)
            rooms.SetPlayerStartPos(roomId, host.userId, host.userId, host.startPos, maxStartPos);
        rooms.SetReady(roomId, host.userId, true);

        for (size_t i = 1; i < resolvedPlayers.size(); ++i) {
            const ResolvedPlayer& p = resolvedPlayers[i];
            forceLeaveCurrentRoom(p.userId);
            if (!rooms.JoinRoom(roomId, p.userId, 0, p.username, "", p.spectator)) {
                result.ok = false;
                result.error = "failed to bind player '" + p.username + "'";
                return result;
            }
            if (!p.spectator) {
                rooms.SetTeam(roomId, p.userId, p.team);
                if (p.startPos >= 0)
                    rooms.SetPlayerStartPos(roomId, p.userId, p.userId, p.startPos, maxStartPos);
                rooms.SetReady(roomId, p.userId, true);
            }
        }

        if (manifest.contains("modoptions") && manifest["modoptions"].is_object()) {
            for (auto& [key, value] : manifest["modoptions"].items()) {
                std::string val = value.is_string() ? value.get<std::string>() : value.dump();
                rooms.SetModOption(roomId, host.userId, key, val);
            }
        }

        // Top-level "scenario" (PLAN-persistence.md §5): names a
        // scenarios/<name>.lua world file for game_scenario.lua to stage at
        // GameStart. Threaded as an ordinary modoption — Spring.GetModOptions()
        // is the existing, faithful path server Lua already reads config
        // through, so no new plumbing is needed beyond this one field.
        std::string scenarioName = manifest.value("scenario", "");
        if (!scenarioName.empty()) {
            rooms.SetModOption(roomId, host.userId, "scenario", scenarioName);
        }

        if (manifest.contains("aiSlots") && manifest["aiSlots"].is_array()) {
            uint8_t slotIndex = 0;
            for (const auto& aj : manifest["aiSlots"]) {
                std::string aiId = aj.value("aiId", "");
                if (aiId.empty()) continue;
                uint8_t team = static_cast<uint8_t>(aj.value("team", 0));
                if (!rooms.AddAISlot(roomId, host.userId, aiId, aiId, team)) continue;
                int8_t sp = static_cast<int8_t>(aj.value("startPos", -1));
                if (sp >= 0)
                    rooms.SetAIStartPos(roomId, host.userId, slotIndex, sp, maxStartPos);
                slotIndex++;
            }
        }

        const bool autoStart = manifest.value("autoStart", true);
        if (!autoStart) {
            result.ok = true;
            return result;
        }

        // Same solo-team Null AI safety net as /api/rooms/start (§2.2):
        // a single-team room trips ZK's game_over.lua ~1.5s in.
        {
            GameRoom* room = rooms.GetRoom(roomId);
            std::set<uint8_t> teams;
            for (const auto& p : room->players)
                if (!p.isSpectator) teams.insert(p.team);
            for (const auto& a : room->aiSlots) teams.insert(a.team);
            if (teams.size() <= 1) {
                const uint8_t aiTeam = (host.team == 0) ? 1 : 0;
                rooms.AddAISlot(roomId, host.userId, "null", "Null AI", aiTeam);
            }
        }

        if (!rooms.StartGame(roomId, host.userId)) {
            result.ok = false;
            result.error = "cannot start game (internal — all declared players should already be ready)";
            return result;
        }

        rooms.AutoAssignStartPositions(roomId, maxStartPos);

        GameRoom* room = rooms.GetRoom(roomId);
        auto gpIt = gamePathsById.find(gameId);
        if (gpIt != gamePathsById.end()) {
            const auto vit = gameVersionsById.find(gameId);
            const std::string& gameVer = (vit != gameVersionsById.end()) ? vit->second : std::string();
            std::unordered_set<int> busyPorts;
            for (const auto& [rid, gi] : gameServers)
                if (gi.pid > 0 && isProcessAlive(gi.pid)) busyPorts.insert(gi.port);
            auto inst = spawnGameServer(roomId, gameId, gameVer, mapId, dbPath,
                room->players, room->aiSlots, room->modOptions, busyPorts, devBuildAcknowledged,
                wtCertPath, wtKeyPath);
            gameServers[roomId] = inst;
            persistGameServer(inst);
            room->gameServerPort = inst.port;
        }

        result.ok = true;
        return result;
    };

    // POST /api/rooms — create a room
    net.AddHttpPost("/api/rooms", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user) return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");

        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string name = j.value("name", "");
        std::string mapId = j.value("map", "");
        std::string gameId = j.value("game", "");
        if (name.empty()) name = "Game";
        if (gameId.empty() && !availableGames.empty()) gameId = availableGames[0].id;
        if (mapId.empty())
            return HttpAuth::JsonResponse(400, R"({"error":"map is required"})");

        // Accept both JSON string ("true"/"1") and JSON bool/number for `persistent`.
        bool persistent = false;
        if (j.contains("persistent")) {
            const auto& pv = j["persistent"];
            if (pv.is_string()) {
                const std::string persistStr = pv.get<std::string>();
                persistent = (persistStr == "true" || persistStr == "1");
            } else if (pv.is_boolean()) {
                persistent = pv.get<bool>();
            } else if (pv.is_number()) {
                persistent = (pv.get<double>() == 1.0);
            }
        }

        uint32_t roomId = rooms.CreateRoom(name, mapId, gameId, 8, "",
            static_cast<uint32_t>(userId), 0 /*no WS clientId*/, user->username,
            persistent);
        auto* room = rooms.GetRoom(roomId);
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(room));
    });

    // GET /api/rooms — list rooms
    net.AddHttpGet("/api/rooms", RouteAuth::Public, [&](const std::string&) -> HttpResponse {
        auto allRooms = rooms.GetAllRooms();
        std::string json = "[";
        bool first = true;
        for (const auto* r : allRooms) {
            if (!r) continue;
            if (!first) json += ",";
            first = false;
            json += roomToJson(r);
        }
        json += "]";
        return HttpAuth::JsonResponse(200, json);
    });

    // GET /api/games — list available games
    net.AddHttpGet("/api/games", RouteAuth::Public, [&availableGames](const std::string&) -> HttpResponse {
        std::string json = "[";
        bool first = true;
        for (const auto& g : availableGames) {
            if (!first) json += ",";
            first = false;
            json += "{\"id\":\"" + HttpAuth::JsonEscape(g.id) + "\""
                + ",\"displayName\":\"" + HttpAuth::JsonEscape(g.displayName) + "\""
                + ",\"shortName\":\"" + HttpAuth::JsonEscape(g.shortName) + "\""
                + ",\"description\":\"" + HttpAuth::JsonEscape(g.description) + "\""
                + ",\"version\":\"" + HttpAuth::JsonEscape(g.version) + "\""
                + ",\"lighting\":\"" + HttpAuth::JsonEscape(g.lighting) + "\""
                + ",\"modelMaterialPort\":\"" + HttpAuth::JsonEscape(g.modelMaterialPort) + "\"}";
        }
        json += "]";
        return HttpAuth::JsonResponse(200, json);
    });

    // GET /api/ai/* — list AI plugins for a game
    net.AddHttpGet("/api/ai/*", RouteAuth::Public, [&aisByGame](const std::string& url) -> HttpResponse {
        std::string gameId = url.substr(std::string("/api/ai/").size());
        if (gameId.empty())
            return HttpAuth::JsonResponse(400, R"({"error":"missing game id"})");

        auto it = aisByGame.find(gameId);
        if (it == aisByGame.end())
            return HttpAuth::JsonResponse(404, R"({"error":"game not found"})");

        std::string json = "[";
        bool first = true;
        for (const auto& ai : it->second) {
            if (!first) json += ",";
            first = false;
            json += "{\"id\":\"" + HttpAuth::JsonEscape(ai.id) + "\""
                + ",\"displayName\":\"" + HttpAuth::JsonEscape(ai.displayName) + "\""
                + ",\"description\":\"" + HttpAuth::JsonEscape(ai.description) + "\""
                + ",\"isEngineProvided\":" + (ai.isEngineProvided ? "true" : "false") + "}";
        }
        json += "]";
        return HttpAuth::JsonResponse(200, json);
    });

    // GET /api/games/<id>/resources.json — Spring's gamedata/resources.lua
    // parsed and serialised as JSON. The client uses the
    // `graphics.projectiletextures` map (and friends) to turn weapon
    // texture names like `largelaser` into the actual file path
    // (`gpl/largelaserfalloff.png`), then looks up the matching
    // `.ktx2` URL via the recursive bitmaps manifest. Selection is
    // entirely client-side; the lobby does only the Lua-eval step
    // because resources.lua needs a real Lua VM with a VFS shim.
    //
    // Parsed JSON is cached per game on first request — the lobby
    // is single-threaded for HTTP work so a plain unordered_map
    // protected by a mutex is enough. Cache invalidation is implicit
    // (lobby restart re-parses).
    static std::mutex resourcesCacheMutex;
    static std::unordered_map<std::string, std::string> resourcesCache;
    net.AddHttpGet("/api/games/*", RouteAuth::Public, [&gamesDir](const std::string& url) -> HttpResponse {
        // Match /api/games/<id>/resources.json and /api/games/<id>/ui-manifest.
        // /api/games/data/* and /api/games (no trailing path) are handled by
        // their own routes registered earlier — the wildcard here only sees
        // URLs that those didn't match.
        const std::string prefix = "/api/games/";
        if (url.size() <= prefix.size())
            return {.contentType = "text/plain", .body = {}, .status = 404};
        const std::string rest = url.substr(prefix.size());

        // /api/games/<id>/ui-manifest — JSON list of override files present
        // under data/games/<id>/ui/. Always 200; empty list when the dir
        // is missing entirely. The client uses this to decide which per-
        // file overrides to fetch, avoiding a 404 storm for games that
        // ship no overrides at all.
        const std::string uiSuffix = "/ui-manifest";
        if (rest.size() > uiSuffix.size() &&
            rest.compare(rest.size() - uiSuffix.size(), uiSuffix.size(), uiSuffix) == 0)
        {
            const std::string gameId = rest.substr(0, rest.size() - uiSuffix.size());
            if (gameId.empty() || gameId.find('/') != std::string::npos ||
                gameId.find("..") != std::string::npos)
                return {.contentType = "text/plain", .body = {}, .status = 400};

            namespace fs = std::filesystem;
            const fs::path uiDir = fs::path(gamesDir) / gameId / "ui";
            std::string json = "{\"files\":[";
            std::error_code ec;
            if (fs::is_directory(uiDir, ec)) {
                bool first = true;
                for (auto it = fs::recursive_directory_iterator(uiDir, ec);
                     it != fs::recursive_directory_iterator(); it.increment(ec))
                {
                    if (ec) break;
                    if (!it->is_regular_file(ec)) continue;
                    const auto rel = fs::relative(it->path(), uiDir, ec).generic_string();
                    if (rel.empty() || rel.find("..") != std::string::npos) continue;
                    if (!first) json += ",";
                    first = false;
                    json += "\"" + HttpAuth::JsonEscape(rel) + "\"";
                }
            }
            json += "]}";
            std::vector<uint8_t> body(json.begin(), json.end());
            return {
                .contentType = "application/json",
                .body = std::move(body),
                .status = 200,
            };
        }

        const std::string suffix = "/resources.json";
        if (rest.size() <= suffix.size() ||
            rest.compare(rest.size() - suffix.size(), suffix.size(), suffix) != 0)
            return {.contentType = "text/plain", .body = {}, .status = 404};
        const std::string gameId = rest.substr(0, rest.size() - suffix.size());
        if (gameId.empty() || gameId.find('/') != std::string::npos ||
            gameId.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 400};

        // Cache hit?
        {
            std::lock_guard<std::mutex> lock(resourcesCacheMutex);
            auto it = resourcesCache.find(gameId);
            if (it != resourcesCache.end()) {
                std::vector<uint8_t> body(it->second.begin(), it->second.end());
                return {
                    .contentType = "application/json",
                    .body = std::move(body),
                    .status = 200,
                    .cacheControl = CacheControl::StaticAssetHeader(),
                };
            }
        }

        const std::string gameDir = gamesDir + "/" + gameId;
        const std::string engineBaseDir = "cont/base/springcontent";
        const std::string json = ResourcesParser::ParseGameResources(
            gameId, gameDir, engineBaseDir);
        if (json.empty()) {
            const std::string err = R"({"error":"parse failed"})";
            return {
                .contentType = "application/json",
                .body = std::vector<uint8_t>(err.begin(), err.end()),
                .status = 500,
            };
        }
        {
            std::lock_guard<std::mutex> lock(resourcesCacheMutex);
            resourcesCache.emplace(gameId, json);
        }
        std::vector<uint8_t> body(json.begin(), json.end());
        return {
            .contentType = "application/json",
            .body = std::move(body),
            .status = 200,
            .cacheControl = CacheControl::StaticAssetHeader(),
        };
    });

    // NOTE: /api/rooms/end and /api/rooms/close are removed.
    // Room lifecycle is handled entirely through /api/rooms/leave:
    //   - Last human leaves non-persistent room → room abandoned, game killed
    //   - Host leaves with others present → host transferred
    //   - Persistent room → stays alive with 0 humans

    // POST /api/rooms/join — join a room
    net.AddHttpPost("/api/rooms/join", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user) return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");

        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint32_t roomId = j.contains("room_id") && j["room_id"].is_string()
            ? (uint32_t)std::atoi(j["room_id"].get<std::string>().c_str())
            : (uint32_t)j.value("room_id", 0);
        std::string password = j.value("password", "");

        if (!rooms.JoinRoom(roomId, static_cast<uint32_t>(userId), 0, user->username, password))
            return HttpAuth::JsonResponse(403, R"({"error":"cannot join room"})");

        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(roomId)));
    });

    // POST /api/rooms/leave — leave a room. If this was the last
    // human in a non-persistent room, the room is abandoned and any
    // running game server is killed. If the host leaves with other
    // humans still present, host is transferred to a random player.
    net.AddHttpPost("/api/rooms/leave", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        uint32_t rid = room->id;
        auto result = rooms.LeaveRoom(rid, static_cast<uint32_t>(userId));

        if (result == LeaveResult::Abandoned) {
            // Kill the game server if one is running
            auto gsIt = gameServers.find(rid);
            if (gsIt != gameServers.end()) {
                kill(gsIt->second.pid, SIGTERM);
                gsIt->second.state = GameServerInstance::Ended;
                removeGameServer(rid);
                SLOG(SPRING_LOG_NOTICE, "room %u abandoned, killed game server pid %d",
                    rid, gsIt->second.pid);
            }
            rooms.DeleteRoom(rid);
        }

        broadcastRooms();
        std::string resultStr;
        switch (result) {
            case LeaveResult::Left:            resultStr = "left"; break;
            case LeaveResult::HostTransferred: resultStr = "host_transferred"; break;
            case LeaveResult::Abandoned:       resultStr = "abandoned"; break;
            case LeaveResult::StillPersistent: resultStr = "persistent"; break;
            default:                           resultStr = "not_found"; break;
        }
        return HttpAuth::JsonResponse(200,
            "{\"ok\":true,\"result\":\"" + resultStr + "\"}");
    });

    // POST /api/rooms/ready
    net.AddHttpPost("/api/rooms/ready", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        // Accept JSON string ("true"/"1") or JSON bool/number for `ready`.
        bool ready = false;
        if (j.contains("ready")) {
            const auto& rv = j["ready"];
            if (rv.is_string()) {
                const std::string readyStr = rv.get<std::string>();
                ready = (readyStr == "true" || readyStr == "1");
            } else if (rv.is_boolean()) {
                ready = rv.get<bool>();
            } else if (rv.is_number()) {
                ready = (rv.get<double>() == 1.0);
            }
        }
        rooms.SetReady(room->id, static_cast<uint32_t>(userId), ready);
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/team
    net.AddHttpPost("/api/rooms/team", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint8_t team = j.contains("team") && j["team"].is_string()
            ? (uint8_t)std::atoi(j["team"].get<std::string>().c_str())
            : (uint8_t)j.value("team", 0);
        rooms.SetTeam(room->id, static_cast<uint32_t>(userId), team);
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/startpos
    net.AddHttpPost("/api/rooms/startpos", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        int8_t pos = j.contains("pos") && j["pos"].is_string()
            ? (int8_t)std::atoi(j["pos"].get<std::string>().c_str())
            : (int8_t)j.value("pos", 0);
        // Find the target player — default to self
        uint32_t target = j.contains("target_player_id") && j["target_player_id"].is_string()
            ? (uint32_t)std::atoi(j["target_player_id"].get<std::string>().c_str())
            : (uint32_t)j.value("target_player_id", static_cast<uint32_t>(userId));
        rooms.SetPlayerStartPos(room->id, static_cast<uint32_t>(userId), target, pos, 6);
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/kick
    net.AddHttpPost("/api/rooms/kick", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint32_t target = j.contains("target_player_id") && j["target_player_id"].is_string()
            ? (uint32_t)std::atoi(j["target_player_id"].get<std::string>().c_str())
            : (uint32_t)j.value("target_player_id", 0);
        if (!rooms.KickPlayer(room->id, static_cast<uint32_t>(userId), target))
            return HttpAuth::JsonResponse(403, R"({"error":"cannot kick"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/ai/add
    net.AddHttpPost("/api/rooms/ai/add", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string aiId = j.value("ai_id", "");
        std::string aiName = j.value("name", "");
        if (aiName.empty()) aiName = aiId;
        uint8_t team = j.contains("team") && j["team"].is_string()
            ? (uint8_t)std::atoi(j["team"].get<std::string>().c_str())
            : (uint8_t)j.value("team", 0);
        if (!rooms.AddAISlot(room->id, static_cast<uint32_t>(userId), aiId, aiName, team))
            return HttpAuth::JsonResponse(400, R"({"error":"cannot add AI"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/ai/remove
    net.AddHttpPost("/api/rooms/ai/remove", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint8_t slotIndex = j.contains("slot_index") && j["slot_index"].is_string()
            ? (uint8_t)std::atoi(j["slot_index"].get<std::string>().c_str())
            : (uint8_t)j.value("slot_index", 0);
        if (!rooms.RemoveAISlot(room->id, static_cast<uint32_t>(userId), slotIndex))
            return HttpAuth::JsonResponse(400, R"({"error":"cannot remove AI"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/modoption — host sets/clears one room modoption.
    // Body: {"key":"...","value":"..."}. An empty/absent value clears it.
    // (PLAN-bar.md §5.)
    net.AddHttpPost("/api/rooms/modoption", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string key = j.value("key", "");
        std::string value = j.value("value", "");
        if (!rooms.SetModOption(room->id, static_cast<uint32_t>(userId), key, value))
            return HttpAuth::JsonResponse(400, R"({"error":"cannot set modoption"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/ai/team — change an AI slot's team
    net.AddHttpPost("/api/rooms/ai/team", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint8_t slotIndex = j.contains("slot_index") && j["slot_index"].is_string()
            ? (uint8_t)std::atoi(j["slot_index"].get<std::string>().c_str())
            : (uint8_t)j.value("slot_index", 0);
        uint8_t team = j.contains("team") && j["team"].is_string()
            ? (uint8_t)std::atoi(j["team"].get<std::string>().c_str())
            : (uint8_t)j.value("team", 0);
        if (!rooms.SetAITeam(room->id, static_cast<uint32_t>(userId), slotIndex, team))
            return HttpAuth::JsonResponse(400, R"({"error":"cannot set AI team"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/start — start the game
    net.AddHttpPost("/api/rooms/start", RouteAuth::TokenRequired, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");

        // Auto-add a Null AI if every participant ends up on the same
        // team. Without an opposing ally, ZK's game_over.lua trips its
        // "no opposing team" check ~1.5s in (gadget runs every 45
        // frames) and the host gets a Game Over before they can build.
        // The Null AI is engine-provided (content/engine/ai/null) and
        // owns its team without issuing orders, so this is invisible to
        // anyone who *did* set up an opponent and only kicks in for a
        // genuinely-solo room.
        {
            std::set<uint8_t> teams;
            for (const auto& p : room->players) {
                if (!p.isSpectator) teams.insert(p.team);
            }
            for (const auto& a : room->aiSlots) teams.insert(a.team);
            if (teams.size() <= 1) {
                uint8_t hostTeam = 0;
                for (const auto& p : room->players) {
                    if (p.playerId == room->hostPlayerId) { hostTeam = p.team; break; }
                }
                const uint8_t aiTeam = (hostTeam == 0) ? 1 : 0;
                if (rooms.AddAISlot(room->id, static_cast<uint32_t>(userId),
                                    "null", "Null AI", aiTeam)) {
                    SLOG(SPRING_LOG_NOTICE,
                        "room %u: solo start detected — auto-added Null AI on team %u",
                        room->id, static_cast<unsigned>(aiTeam));
                } else {
                    SLOG(SPRING_LOG_WARNING,
                        "room %u: solo start but auto-AddAISlot failed", room->id);
                }
            }
        }

        if (!rooms.StartGame(room->id, static_cast<uint32_t>(userId)))
            return HttpAuth::JsonResponse(400, R"({"error":"cannot start game"})");

        // Give every still-unassigned slot a distinct map start position
        // before spawning the game server. AutoAssignStartPositions skips
        // slots that already picked a position (via /api/rooms/startpos)
        // and no-ops on maps with no start positions (the sim then falls
        // back to its map-centre default). This call was written for the
        // start path but never wired in — without it every slot stays at
        // startPos=-1, the sim spawns ALL teams at map centre, and enemy
        // commanders overlap and immediately fight to a premature GameOver.
        {
            MapMetadataDb mdb;
            const size_t spCount = mdb.GetMap(mapDb, room->mapId).startPositions.size();
            const int8_t maxStartPos =
                static_cast<int8_t>(spCount > 127 ? 127 : spCount);
            rooms.AutoAssignStartPositions(room->id, maxStartPos);
        }

        // Verify game exists before spawning
        auto it = gamePathsById.find(room->gameId);

        if (it != gamePathsById.end()) {
            const auto vit = gameVersionsById.find(room->gameId);
            const std::string& gameVer = (vit != gameVersionsById.end()) ? vit->second : std::string();
            // Skip ports currently held by live spring-server processes.
            // Without this, the new game-server binds via SO_REUSEPORT
            // alongside the old one and incoming client connections
            // round-robin between the two — see findFreePort comment.
            std::unordered_set<int> busyPorts;
            for (const auto& [rid, gi] : gameServers) {
                if (gi.pid > 0 && isProcessAlive(gi.pid)) {
                    busyPorts.insert(gi.port);
                }
            }
            auto inst = spawnGameServer(room->id, room->gameId, gameVer,
                room->mapId, dbPath,
                room->players, room->aiSlots, room->modOptions, busyPorts, devBuildAcknowledged,
                wtCertPath, wtKeyPath);
            gameServers[room->id] = inst;
            persistGameServer(inst);
            room->gameServerPort = inst.port;
        }

        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/direct — PLAN-quickstart.md Part A. Dev/test-only:
    // collapses the whole lobby dance (login, create, add AI, join, ready,
    // start) into one manifest + one round trip. Gated by dev_direct_start
    // (off by default, never set in prod) AND (admin role OR localhost
    // origin) — two independent latches (E6).
    //
    // Response is the same room JSON /api/rooms/start already returns
    // (state, players, ai_slots, modoptions, game_server_port) plus a
    // `sessions` map of username -> token. Deliberately does NOT include a
    // wtInfo field: the lobby process links neither WebTransportServer nor
    // an outbound HTTP client, so it cannot fetch the spawned game server's
    // own /api/wt/info without either a new dependency or blocking this
    // single-threaded HTTP loop for the game server's full cold-boot time
    // (observed up to 90s+ for a heavy game). The client already does its
    // own /api/wt/info discovery with connect-retry once it has gamePort,
    // exactly as it does today after a normal /api/rooms/start — this
    // reuses that path instead of duplicating it server-side.
    net.AddHttpPost("/api/rooms/direct", RouteAuth::LocalhostOrAdmin, [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        if (!devDirectStart)
            return HttpAuth::JsonResponse(404, R"({"error":"not found"})");
        int64_t callerId = 0;
        std::string callerName = "(loopback)";
        if (!headers.remoteIsLoopback) {
            callerId = HttpAuth::ValidateToken(db, headers.authorization);
            auto caller = callerId > 0 ? db.FindUserById(callerId) : std::nullopt;
            if (!caller || caller->role != "admin")
                return HttpAuth::JsonResponse(403,
                    R"({"error":"forbidden — direct-start requires admin role or localhost"})");
            callerName = caller->username;
        }

        nlohmann::json manifest = nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (manifest.is_discarded()) return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");

        auto result = runDirectStart(manifest);
        if (!result.ok)
            return HttpAuth::JsonResponse(400, "{\"error\":\"" + HttpAuth::JsonEscape(result.error) + "\"}");

        // Task 6: direct-start spawns a game-server process off a
        // client-supplied manifest — audit who triggered it.
        db.LogAudit(callerId, callerName, "direct_start",
            manifest.value("gameId", ""), "room=" + std::to_string(result.roomId));

        nlohmann::json resp = nlohmann::json::parse(roomToJson(rooms.GetRoom(result.roomId)));
        resp["sessions"] = nlohmann::json::object();
        for (const auto& [username, token] : result.sessions) resp["sessions"][username] = token;
        broadcastRooms();
        return HttpAuth::JsonResponse(200, resp.dump());
    });

    #undef HTTP_ROOM_AUTH

    // --direct <manifest.json>: create one standing room at boot, driven
    // through the same runDirectStart composite as the HTTP endpoint. Not
    // gated by dev_direct_start — this is an operator-supplied CLI flag at
    // process launch, not reachable remotely (mprocs dev flow: the stack
    // comes up with the game already running).
    if (!directManifestPath.empty()) {
        std::ifstream mf(directManifestPath);
        if (!mf) {
            SLOG(SPRING_LOG_ERROR, "--direct: cannot open manifest '%s'", directManifestPath.c_str());
        } else {
            std::string content((std::istreambuf_iterator<char>(mf)), std::istreambuf_iterator<char>());
            nlohmann::json manifest = nlohmann::json::parse(content, nullptr, /*allow_exceptions=*/false);
            if (manifest.is_discarded()) {
                SLOG(SPRING_LOG_ERROR, "--direct: bad JSON in '%s'", directManifestPath.c_str());
            } else {
                auto result = runDirectStart(manifest);
                if (result.ok) {
                    SLOG(SPRING_LOG_NOTICE, "--direct: standing room ready (room %u, '%s')",
                        result.roomId, manifest.value("name", "dev:direct").c_str());
                    broadcastRooms();
                } else {
                    SLOG(SPRING_LOG_ERROR, "--direct: failed to create standing room: %s",
                        result.error.c_str());
                }
            }
        }
    }

    if (!net.Start(port)) {
        SLOG(SPRING_LOG_ERROR, "failed to start network");
        springlog_shutdown();
        return 1;
    }

    SLOG(SPRING_LOG_NOTICE, "running (port %d)", port);

    // --- Main loop (10 Hz for lobby — HTTP serving + process management) ---
    int reapTick = 0;
    while (keepRunning.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

        // Periodically reap abandoned rooms (~every 60s at 10 Hz). Catches
        // rooms whose host closed the browser during a long-lived lobby,
        // not just stale rows inherited at startup.
        if (++reapTick >= 600) {
            reapTick = 0;
            auto reaped = rooms.ReapStaleRooms(kRoomIdleReapSeconds);
            if (!reaped.empty()) {
                for (uint32_t rid : reaped) removeGameServer(rid);  // safety
                SLOG(SPRING_LOG_NOTICE, "reaped %zu abandoned room(s)",
                    reaped.size());
                broadcastRooms();
            }
        }

        // Check game server health every loop iteration
        for (auto& [roomId, inst] : gameServers) {
            if (inst.state == GameServerInstance::Starting || inst.state == GameServerInstance::Running) {
                if (!isProcessAlive(inst.pid)) {
                    inst.state = GameServerInstance::Ended;
                    removeGameServer(roomId);
                    SLOG(SPRING_LOG_NOTICE, "game server for room %u (pid %d) has exited",
                        roomId, inst.pid);

                    // Recycle the room: transition back to Filling,
                    // clear ready flags, zero gameServerPort, drop
                    // reconnection roster.
                    rooms.ResetRoomForNextGame(roomId);
                    broadcastRooms();
                    continue;
                }

                // Readiness handshake: when a Starting server publishes ready=1
                // (it's accepting connections + the sim is up), promote it to
                // Running and flip the room Loading→Active. Until now the
                // Loading→Active transition was never driven, so rooms read as
                // "Starting" forever and clients/launch_game raced a not-yet-
                // listening port. game_status is the only honest ready signal.
                if (inst.state == GameServerInstance::Starting && gameServerReady(roomId)) {
                    inst.state = GameServerInstance::Running;
                    persistGameServer(inst);  // game_servers.state → 'running'
                    if (auto* room = rooms.GetRoom(roomId);
                        room && room->state == ERoomState::Loading) {
                        rooms.SetRoomState(roomId, ERoomState::Active);
                    }
                    SLOG(SPRING_LOG_NOTICE,
                        "game server for room %u is ready — room now Active", roomId);
                    broadcastRooms();
                }
            }
        }
    }

    if (restartRequested.load()) {
        SLOG(SPRING_LOG_NOTICE, "restart requested — persisting game server state...");

        // game_servers table is already up-to-date (maintained in real-time).
        // Just close the database handle.
        if (mapDb) {
            for (auto& [rid, inst] : gameServers) {
                if (inst.state == GameServerInstance::Starting ||
                    inst.state == GameServerInstance::Running) {
                    SLOG(SPRING_LOG_NOTICE, "preserving game server room=%u port=%d pid=%d",
                        rid, inst.port, inst.pid);
                }
            }
            sqlite3_close(mapDb);
            mapDb = nullptr;
        }

        net.Stop();
        db.Close();
        SLOG(SPRING_LOG_NOTICE, "re-exec'ing: %s", savedArgv[0]);
        springlog_sqlite_shutdown();
        springlog_shutdown();

        // Re-exec with the same arguments — replaces this process
        // in-place, so PID is preserved and process managers don't
        // see a crash.
        execvp(savedArgv[0], savedArgv);
        // If execvp returns, it failed
        fprintf(stderr, "ERROR: restart failed: %s\n", strerror(errno));
        return 1;
    }

    SLOG(SPRING_LOG_NOTICE, "shutting down...");

    // Kill any running game servers
    for (auto& [roomId, inst] : gameServers) {
        if (isProcessAlive(inst.pid)) {
            kill(inst.pid, SIGTERM);
            SLOG(SPRING_LOG_NOTICE, "killed game server pid %d", inst.pid);
        }
    }

    net.Stop();
    db.Close();
    SLOG(SPRING_LOG_NOTICE, "exited cleanly");
    springlog_sqlite_shutdown();
    springlog_shutdown();
    return 0;
}
