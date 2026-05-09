/**
 * spring-server entry point
 *
 * Headless authoritative game server. Runs the simulation at a fixed
 * 30 Hz tick rate. Clients connect via WebRTC data channels (signaled
 * over HTTP). HTTP also serves map/game assets and REST API endpoints.
 */

#include "Server/Simulation.h"
#include "Server/NetworkServer.h"
#include "Server/Protocol.h"
#include "Server/Database.h"
#include "Server/ClientSession.h"
#include "Server/EntityStateSerializer.h"
#include "Server/ProjectileStateSerializer.h"
#include "Server/PieceStateSerializer.h"
#include "Server/BuildActivitySerializer.h"
#include "Server/ContentServer.h"
#include "Server/CombatEventCollector.h"
#include "Server/ProjectileEventCollector.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/TeamHandler.h"
#include "Server/DefsCache.h"
#include "Server/StandingOrders.h"
#include "Server/AI/AIRuntimePool.h"
#include "Server/AI/AIDiscovery.h"
#include "Server/PerfMetrics.h"
#include "Server/RoomManager.h"
#include "Server/MapMetadata.h"
#include "Server/LuaExecEngine.h"
#include "Server/LuaDebugger.h"
#include "Lua/LuaRules.h"
#include "Server/HttpAuth.h"
#include "Server/CacheControl.h"
#include "Server/WebRTCServer.h"
#include "System/SpringLog/SpringLog.h"
#include "System/SpringLog/SpringLogNet.h"
#include "System/SpringLog/SpringLogSqlite.h"
#include "System/SpringLogBridge.h"
#include <sqlite3.h>

#define LOG_SECTION "server"

#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Weapons/WeaponDefHandler.h"
#include "Game/GameSetup.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/GlobalConstants.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/Wind.h"
#include "Game/Players/PlayerHandler.h"
#include "System/EventHandler.h"
#include "Map/ReadMap.h"
#include "System/FileSystem/FileHandler.h"
#include "System/Misc/SpringTime.h"
#include "System/SpringMath.h"

#include <array>
#include <csignal>
#include <cstdio>
#include <unistd.h>
#include <atomic>
#include <fstream>
#include <chrono>
#include <filesystem>
#include <random>
#include <thread>
#include <unordered_set>

static std::atomic<bool> keepRunning{true};
static std::atomic<bool> restartRequested{false};

// Saved for self-restart via execvp
static int savedArgc = 0;
static char** savedArgv = nullptr;

static void signalHandler(int) {
    keepRunning.store(false);
}

static void restartHandler(int) {
    restartRequested.store(true);
    keepRunning.store(false);
}

#include <execinfo.h>
#include <unistd.h>
static void crashHandler(int sig, siginfo_t* info, void*) {
    void* frames[64];
    int n = backtrace(frames, 64);
    char hdr[128];
    int len = snprintf(hdr, sizeof(hdr),
        "\n*** SIGSEGV at addr=%p (signal %d) — backtrace:\n",
        info ? info->si_addr : nullptr, sig);
    write(STDERR_FILENO, hdr, len);
    backtrace_symbols_fd(frames, n, STDERR_FILENO);
    _exit(128 + sig);
}

/// Generate a random hex session token.
static std::string generateToken(int length = 32) {
    static const char hex[] = "0123456789abcdef";
    static std::mt19937 rng(std::random_device{}());
    std::uniform_int_distribution<int> dist(0, 15);
    std::string token;
    token.reserve(length);
    for (int i = 0; i < length; i++)
        token += hex[dist(rng)];
    return token;
}

int main(int argc, char* argv[])
{
    savedArgc = argc;
    savedArgv = argv;

    // Initialise unified logging as early as possible so every
    // subsequent log call goes through springlog.
    springlog_init("spring-server", SPRING_LOG_OUTPUT_CONSOLE);
    SpringLogBridge::Install();

    // Populate SpringMath's heading→vector lookup table before any
    // sim code runs. Upstream Spring called this from SpringApp.cpp
    // init; that file was deleted in Phase 0 along with every other
    // rendering-side bootstrap, so the call was silently dropped. Without
    // it, headingToVectorTable[] stays zero-initialised, every
    // GetVectorFromHeading() returns (0,0,0), UpdateDirVectors falls
    // into its degenerate-basis recovery path, and frontdir gets pinned
    // to +X for every unit — which is why move orders all marched east
    // regardless of the target.
    SpringMath::Init();

    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    std::signal(SIGHUP, restartHandler);
    // Ignore SIGPIPE so writes to closed sockets / pipes surface
    // as EPIPE errors instead of terminating the process.
    std::signal(SIGPIPE, SIG_IGN);

    {
        struct sigaction sa{};
        sa.sa_sigaction = crashHandler;
        sa.sa_flags = SA_SIGINFO | SA_RESETHAND;
        sigemptyset(&sa.sa_mask);
        sigaction(SIGSEGV, &sa, nullptr);
        sigaction(SIGBUS,  &sa, nullptr);
        sigaction(SIGABRT, &sa, nullptr);
    }

    int port = 9001;
    std::string gameId;
    std::string gameVersion;   // From modinfo.lua via lobby --game-version arg
    std::string gamesDir = "data/games";
    std::string mapId;
    std::string mapsDir = "data/maps";
    std::string dbPath = "data/spring-server.db";

    // Human player roster from the lobby. Each `--player <username>:<team>:<pos>`
    // entry gets one slot here. The sim uses this for two things:
    //   1. At AuthRequest time, look up the authenticating username
    //      to decide which team the session belongs to (rejects
    //      usernames not in the roster so a random WebSocket
    //      client can't materialise onto an arbitrary team).
    //   2. At SetupTestGame time, spawn units on each team slot at
    //      the requested map start position.
    struct RequestedPlayer {
        std::string username;
        int team = 0;
        int startPos = -1;
    };
    std::vector<RequestedPlayer> requestedPlayers;

    // AI slot requests from the lobby. Each `--ai <id>:<team>:<pos>`
    // pair becomes one entry here; we resolve them against
    // AIDiscovery after content roots are set up. Empty list = no
    // AI players (human-only or dev-smoketest spawn).
    struct RequestedAI {
        std::string id;
        int team = 0;
        int startPos = -1;
    };
    std::vector<RequestedAI> requestedAIs;

    // Console command execution queue (pushed by WS thread, drained by sim)
    LuaExecEngine luaExecEngine;

    // Parse a "field1:field2:field3" spec used by --player and --ai.
    // Returns {field1, field2, field3}; missing trailing fields are
    // left empty so callers can check and fall back to defaults.
    auto splitSpec = [](const std::string& spec) {
        std::array<std::string, 3> out;
        size_t prev = 0;
        for (int i = 0; i < 3; ++i) {
            const size_t next = spec.find(':', prev);
            if (next == std::string::npos) {
                out[i] = spec.substr(prev);
                break;
            }
            out[i] = spec.substr(prev, next - prev);
            prev = next + 1;
        }
        return out;
    };

    // --- Logging CLI flags ---
    std::string logFile;
    std::string logLevel;
    std::string logServer;
    std::string logSqlite;
    bool debugMode = false;
    bool logMessages = false;

    // Simple arg parsing: --port N, --game PATH, --map PATH, --db PATH,
    // --log-file PATH, --log-level LEVEL, --log-server URL,
    // --log-sqlite PATH, --debug, --log-messages,
    // --player username:team:pos (repeatable),
    // --ai id:team:pos (repeatable)
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) {
            port = std::atoi(argv[++i]);
        } else if (arg == "--game" && i + 1 < argc) {
            gameId = argv[++i];
        } else if (arg == "--game-version" && i + 1 < argc) {
            gameVersion = argv[++i];
        } else if (arg == "--map" && i + 1 < argc) {
            mapId = argv[++i];
        } else if (arg == "--db" && i + 1 < argc) {
            dbPath = argv[++i];
        } else if (arg == "--log-file" && i + 1 < argc) {
            logFile = argv[++i];
        } else if (arg == "--log-level" && i + 1 < argc) {
            logLevel = argv[++i];
        } else if (arg == "--log-server" && i + 1 < argc) {
            logServer = argv[++i];
        } else if (arg == "--log-sqlite" && i + 1 < argc) {
            logSqlite = argv[++i];
        } else if (arg == "--debug") {
            debugMode = true;
        } else if (arg == "--no-cache") {
            CacheControl::SetNoCache(true);
        } else if (arg == "--log-messages") {
            logMessages = true;
        } else if (arg == "--player" && i + 1 < argc) {
            const std::string spec = argv[++i];
            const auto parts = splitSpec(spec);
            if (parts[0].empty()) {
                SLOG(SPRING_LOG_WARNING,
                    "ignoring malformed --player '%s' (expected username:team:pos)",
                    spec.c_str());
                continue;
            }
            RequestedPlayer rq;
            rq.username = parts[0];
            rq.team = parts[1].empty() ? 0 : std::atoi(parts[1].c_str());
            rq.startPos = parts[2].empty() ? -1 : std::atoi(parts[2].c_str());
            requestedPlayers.push_back(std::move(rq));
        } else if (arg == "--ai" && i + 1 < argc) {
            // Format: <id>:<team>:<pos>. We parse here and resolve
            // later, once we have a discovered AI list to look up
            // against. Accepts the legacy 2-tuple form too, for
            // dev-smoketest invocations that predate start positions.
            const std::string spec = argv[++i];
            const auto parts = splitSpec(spec);
            if (parts[0].empty()) {
                SLOG(SPRING_LOG_WARNING,
                    "ignoring malformed --ai '%s' (expected id:team[:pos])",
                    spec.c_str());
                continue;
            }
            RequestedAI rq;
            rq.id = parts[0];
            rq.team = parts[1].empty() ? 0 : std::atoi(parts[1].c_str());
            rq.startPos = parts[2].empty() ? -1 : std::atoi(parts[2].c_str());
            requestedAIs.push_back(std::move(rq));
        } else if (arg[0] != '-') {
            // Legacy: bare number = port
            port = std::atoi(argv[i]);
        }
    }

    // Validate content ids — must be plain identifiers, no path traversal
    auto isValidContentId = [](const std::string& id) {
        return std::all_of(id.begin(), id.end(), [](char c) {
            return std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-' || c == '.';
        });
    };
    if (!gameId.empty() && !isValidContentId(gameId)) {
        SLOG(SPRING_LOG_ERROR, "invalid --game id '%s' (must be alphanumeric)", gameId.c_str());
        return 1;
    }
    if (!mapId.empty() && !isValidContentId(mapId)) {
        SLOG(SPRING_LOG_ERROR, "invalid --map id '%s' (must be alphanumeric)", mapId.c_str());
        return 1;
    }

    // Resolve content paths from ids
    std::string gamePath;
    if (!gameId.empty()) {
        gamePath = gamesDir + "/" + gameId;
        if (!std::filesystem::is_directory(gamePath)) {
            SLOG(SPRING_LOG_ERROR, "game '%s' not found at %s", gameId.c_str(), gamePath.c_str());
            return 1;
        }
    }
    std::string mapPath;
    if (!mapId.empty()) {
        mapPath = mapsDir + "/" + mapId;
        if (!std::filesystem::is_directory(mapPath)) {
            SLOG(SPRING_LOG_ERROR, "map '%s' not found at %s", mapId.c_str(), mapPath.c_str());
            return 1;
        }
    }

    // --- Apply logging CLI flags ---
    if (debugMode)
        springlog_set_min_level(SPRING_LOG_DEBUG);
    if (!logLevel.empty()) {
        // Accept level names or numeric values
        int lvl = -1;
        if (logLevel == "debug")   lvl = SPRING_LOG_DEBUG;
        else if (logLevel == "info")    lvl = SPRING_LOG_INFO;
        else if (logLevel == "notice")  lvl = SPRING_LOG_NOTICE;
        else if (logLevel == "warning") lvl = SPRING_LOG_WARNING;
        else if (logLevel == "error")   lvl = SPRING_LOG_ERROR;
        else if (logLevel == "fatal")   lvl = SPRING_LOG_FATAL;
        else lvl = std::atoi(logLevel.c_str());
        if (lvl >= 0)
            springlog_set_min_level(lvl);
    }
    if (!logFile.empty()) {
        springlog_set_file(logFile.c_str());
        springlog_set_outputs(SPRING_LOG_OUTPUT_CONSOLE | SPRING_LOG_OUTPUT_FILE);
    }
    // Enable SQLite log sink — defaults to data/debug.db so the log
    // server can query game server logs. Override with --log-sqlite.
    if (logSqlite.empty()) logSqlite = "data/debug.db";
    springlog_sqlite_init(logSqlite.c_str());
    if (!logServer.empty())
        springlog_net_init(logServer.c_str(), "");

    SLOG(SPRING_LOG_NOTICE, "starting...");

    // Initialise Spring's time system
    spring_clock::PushTickRate(true);
    spring_time::setstarttime(spring_time::gettime(true));

    // --- Content roots ---
    // Game content is searched first, then map, then cwd
    if (!gamePath.empty()) {
        CFileHandler::AddContentRoot(gamePath, RootCategory::Mod);
        SLOG(SPRING_LOG_NOTICE, "game content: %s", gamePath.c_str());

        // Also expose the preprocessed game models dir as a content
        // root, so SolidObjectDef::LoadModel can find each unit's
        // `<modelName>.config.json` / `<modelName>.config.lua` via
        // the bare-name lookup.
        namespace fs = std::filesystem;
        const std::string processedModels = "data/games/" + gameId + "/models";
        if (fs::is_directory(processedModels)) {
            CFileHandler::AddContentRoot(processedModels, RootCategory::Mod);
            SLOG(SPRING_LOG_NOTICE, "processed game models: %s",
                processedModels.c_str());
        }
    }
    if (!mapPath.empty()) {
        CFileHandler::AddContentRoot(mapPath, RootCategory::Map);
        SLOG(SPRING_LOG_NOTICE, "map content: %s", mapPath.c_str());

        // Also expose the preprocessed data dir for this map as a
        // content root, so SolidObjectDef::LoadModel can find the
        // `<feature>.config.json` files the modelimporter writes
        // there. Layout convention (set by FeatureProcessor):
        //     data/maps/<mapId>/features/<stem>.config.json
        // The map id is the basename of mapPath (e.g.
        // "scorched_crossing_v2.4").
        namespace fs = std::filesystem;
        const std::string mapId = fs::path(mapPath).filename().string();
        const std::string processedFeatures = "data/maps/" + mapId + "/features";
        if (fs::is_directory(processedFeatures)) {
            CFileHandler::AddContentRoot(processedFeatures, RootCategory::Map);
            SLOG(SPRING_LOG_NOTICE, "processed map features: %s",
                processedFeatures.c_str());
        }
    }
    // Engine base content (gamedata/defs.lua, system.lua, gadgets, etc.)
    CFileHandler::AddContentRoot("cont/base/springcontent", RootCategory::Base);
    // Always search cwd as fallback
    CFileHandler::AddContentRoot(".", RootCategory::Raw);

    // --- Database ---
    Database db;
    if (!db.Open(dbPath)) {
        SLOG(SPRING_LOG_ERROR, "failed to open database");
        springlog_shutdown();
        return 1;
    }

    // --- Map metadata (from mapconverter processing, stored in SQLite) ---
    MapMetadata mapMeta;
    {
        sqlite3* mapDb = nullptr;
        if (sqlite3_open(dbPath.c_str(), &mapDb) == SQLITE_OK) {
            if (!mapPath.empty()) {
                std::filesystem::path p(mapPath);
                std::string mapId = p.filename().string();
                if (mapId.empty() && p.has_parent_path())
                    mapId = p.parent_path().filename().string();

                MapMetadataDb db;
                mapMeta = db.GetMap(mapDb, mapId);
                if (mapMeta.id.empty()) {
                    SLOG(SPRING_LOG_WARNING, "map '%s' not in SQLite. "
                        "Run mapconverter first to process maps.", mapId.c_str());
                } else {
                    SLOG(SPRING_LOG_NOTICE, "loaded map '%s' (%s): %dx%d, "
                        "%zu features, %zu start positions",
                        mapMeta.id.c_str(), mapMeta.name.c_str(),
                        mapMeta.mapx, mapMeta.mapy,
                        mapMeta.features.size(), mapMeta.startPositions.size());
                }
            }
            sqlite3_close(mapDb);
        }
    }

    // --- Sessions & Rooms ---
    SessionManager sessions;
    RoomManager rooms;

    // --- AI ---
    AIRuntimePool aiPool;

    // --- Network ---
    NetworkServer net;

    // HTTP endpoints for terrain data (handlers check readMap at request time)
    net.AddHttpGet("/api/map/heightmap", [](const std::string&) -> HttpResponse {
        if (readMap == nullptr)
            return {.contentType = "text/plain", .body = {}, .status = 404};

        const float* hm = readMap->GetCornerHeightMapSynced();
        int w = mapDims.mapxp1;
        int h = mapDims.mapyp1;

        // Binary format: u32 width, u32 height, then f32[w*h] row-major
        size_t headerSize = 8;
        size_t dataSize = w * h * sizeof(float);
        std::vector<uint8_t> body(headerSize + dataSize);

        uint32_t wu = static_cast<uint32_t>(w);
        uint32_t hu = static_cast<uint32_t>(h);
        memcpy(body.data(), &wu, 4);
        memcpy(body.data() + 4, &hu, 4);
        memcpy(body.data() + 8, hm, dataSize);

        return {.contentType = "application/octet-stream", .body = std::move(body), .status = 200};
    });

    net.AddHttpGet("/api/map/info", [](const std::string&) -> HttpResponse {
        if (readMap == nullptr)
            return {.contentType = "text/plain", .body = {}, .status = 404};

        // Simple JSON with map dimensions
        char buf[256];
        int len = snprintf(buf, sizeof(buf),
            "{\"mapx\":%d,\"mapy\":%d,\"squareSize\":%d,\"widthElmos\":%d,\"heightElmos\":%d}",
            mapDims.mapx, mapDims.mapy, SQUARE_SIZE,
            mapDims.mapx * SQUARE_SIZE, mapDims.mapy * SQUARE_SIZE);

        std::vector<uint8_t> body(buf, buf + len);
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // Available maps endpoint — scans mapsDir for SMF files
    net.AddHttpGet("/api/maps", [&mapsDir](const std::string&) -> HttpResponse {
        namespace fs = std::filesystem;
        std::string json = "[";
        bool first = true;
        if (!fs::is_directory(mapsDir))
            return {.contentType = "application/json", .body = {'[', ']'}, .status = 200};

        for (auto& mapDir : fs::directory_iterator(mapsDir)) {
            if (!mapDir.is_directory()) continue;

            // Find .smf file
            std::string smfPath;
            std::string thumbPath;
            for (auto& entry : fs::recursive_directory_iterator(mapDir.path())) {
                if (entry.is_regular_file()) {
                    auto ext = entry.path().extension().string();
                    if (ext == ".smf" && smfPath.empty())
                        smfPath = entry.path().string();
                    auto fname = entry.path().filename().string();
                    if (fname.find("minimap") != std::string::npos &&
                        (ext == ".png" || ext == ".jpg"))
                        thumbPath = entry.path().string();
                }
            }
            if (smfPath.empty()) continue;

            // Read SMF header for dimensions
            int mapx = 0, mapy = 0;
            float minH = 0, maxH = 0;
            {
                std::ifstream f(smfPath, std::ios::binary);
                if (f.is_open()) {
                    char magic[16];
                    int version, mapid;
                    f.read(magic, 16);
                    f.read(reinterpret_cast<char*>(&version), 4);
                    f.read(reinterpret_cast<char*>(&mapid), 4);
                    f.read(reinterpret_cast<char*>(&mapx), 4);
                    f.read(reinterpret_cast<char*>(&mapy), 4);
                    f.seekg(4, std::ios::cur); // squareSize
                    f.seekg(4, std::ios::cur); // texelPerSquare
                    f.seekg(4, std::ios::cur); // tilesize
                    f.read(reinterpret_cast<char*>(&minH), 4);
                    f.read(reinterpret_cast<char*>(&maxH), 4);
                }
            }

            std::string dirName = mapDir.path().filename().string();
            std::string thumbUrl = thumbPath.empty() ? "" :
                "/api/content/assets/" + fs::relative(thumbPath, mapDir.path()).string();

            if (!first) json += ",";
            first = false;
            char buf[512];
            snprintf(buf, sizeof(buf),
                "{\"id\":\"%s\",\"name\":\"%s\",\"path\":\"%s\","
                "\"mapx\":%d,\"mapy\":%d,\"widthElmos\":%d,\"heightElmos\":%d,"
                "\"minHeight\":%.1f,\"maxHeight\":%.1f,\"thumbnail\":\"%s\"}",
                dirName.c_str(), dirName.c_str(), mapDir.path().string().c_str(),
                mapx, mapy, mapx * 8, mapy * 8,
                minH, maxH, thumbUrl.c_str());
            json += buf;
        }
        json += "]";
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // Serve map thumbnail images
    net.AddHttpGet("/api/maps/thumb/*", [&mapsDir](const std::string& url) -> HttpResponse {
        std::string mapId = url.substr(std::string("/api/maps/thumb/").size());
        namespace fs = std::filesystem;
        fs::path mapDir = fs::path(mapsDir) / mapId;
        if (!fs::is_directory(mapDir))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        // Search for minimap image
        for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
            if (!entry.is_regular_file()) continue;
            auto fname = entry.path().filename().string();
            auto ext = entry.path().extension().string();
            if (fname.find("minimap") != std::string::npos &&
                (ext == ".png" || ext == ".jpg")) {
                std::ifstream f(entry.path(), std::ios::binary);
                if (!f.is_open()) continue;
                std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                           std::istreambuf_iterator<char>());
                std::string ct = (ext == ".png") ? "image/png" : "image/jpeg";
                return {.contentType = ct, .body = std::move(data), .status = 200};
            }
        }
        return {.contentType = "text/plain", .body = {}, .status = 404};
    });

    // Performance metrics endpoint
    net.AddHttpGet("/api/metrics", [](const std::string&) -> HttpResponse {
        std::string json = perfMetrics.ToJSON();
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // --- Content server ---
    ContentServer content;
    {
        std::vector<std::string> contentRoots;
        if (!gamePath.empty()) contentRoots.push_back(gamePath);
        if (!mapPath.empty()) contentRoots.push_back(mapPath);
        content.Init(net, contentRoots);
    }

    // --- HTTP auth + exec endpoints ---
    HttpAuth::RegisterEndpoints(net, db);

    // Restart-in-place: re-exec this binary with the same argv.
    // Clients get a GameRestarting message before the connection drops.
    net.AddHttpPost("/api/restart", [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
        SLOG(SPRING_LOG_NOTICE, "restart requested via /api/restart");
        restartRequested.store(true);
        keepRunning.store(false);
        return {.contentType = "application/json",
                .body = {'{',' ','"','o','k','"',':','t','r','u','e',' ','}'},
                .status = 200};
    });

    net.AddHttpPost("/api/exec", [&luaExecEngine, &db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        // Validate auth token
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0) {
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized — use POST /api/auth/login first"})");
        }

        std::string scope = HttpAuth::JsonField(body, "scope");
        std::string code = HttpAuth::JsonField(body, "code");

        if (scope.empty() || code.empty()) {
            return HttpAuth::JsonResponse(400, R"({"success":false,"output":"missing scope or code"})");
        }

        auto result = luaExecEngine.ExecSync(scope, code, 5000);

        std::string json = "{\"success\":" + std::string(result.success ? "true" : "false")
            + ",\"output\":\"" + HttpAuth::JsonEscape(result.output) + "\"}";
        return HttpAuth::JsonResponse(200, json);
    });

    // --- WebRTC signaling endpoints ---
    WebRTCServer rtcServer;

    net.AddHttpPost("/api/rtc/offer", [&rtcServer, &db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0) {
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");
        }
        std::string sdpOffer = HttpAuth::JsonField(body, "sdp");
        if (sdpOffer.empty()) {
            return HttpAuth::JsonResponse(400, R"({"error":"missing sdp field"})");
        }
        auto result = rtcServer.HandleOffer(sdpOffer, headers.authorization);
        if (!result.success) {
            return HttpAuth::JsonResponse(500, "{\"error\":\"" + HttpAuth::JsonEscape(result.error) + "\"}");
        }
        std::string json = "{\"client_id\":" + std::to_string(result.clientId)
            + ",\"sdp\":\"" + HttpAuth::JsonEscape(result.sdpAnswer) + "\"}";
        return HttpAuth::JsonResponse(200, json);
    });

    net.AddHttpPost("/api/rtc/candidate", [&rtcServer, &db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0) {
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");
        }
        std::string candidate = HttpAuth::JsonField(body, "candidate");
        std::string mid = HttpAuth::JsonField(body, "mid");
        std::string clientIdStr = HttpAuth::JsonField(body, "client_id");
        uint32_t clientId = clientIdStr.empty() ? 0 : (uint32_t)std::atoi(clientIdStr.c_str());
        if (clientId == 0) {
            return HttpAuth::JsonResponse(400, R"({"error":"missing client_id"})");
        }
        bool ok = rtcServer.AddCandidate(clientId, candidate, mid);
        return HttpAuth::JsonResponse(200, ok ? R"({"ok":true})" : R"({"ok":false})");
    });

    if (!net.Start(port)) {
        SLOG(SPRING_LOG_ERROR, "failed to start network server");
        springlog_shutdown();
        return 1;
    }

    // --- Simulation ---
    // Find .smf file in the map directory
    std::string smfPath;
    if (!mapPath.empty()) {
        namespace fs = std::filesystem;
        for (auto& entry : fs::recursive_directory_iterator(mapPath)) {
            if (entry.is_regular_file() && entry.path().extension() == ".smf") {
                smfPath = entry.path().string();
                break;
            }
        }
        if (smfPath.empty())
            SLOG(SPRING_LOG_WARNING, "no .smf file found in %s", mapPath.c_str());
    }

    CSimulation sim;

    // Hand the roster to the sim before Init() runs SetupTestGame.
    // Merge human players and AI slots into a single RosterEntry
    // vector — the sim doesn't distinguish the two, it just needs
    // to know what teams exist and where each one spawns. Empty
    // vector preserves the legacy 2-team dev fallback.
    {
        std::vector<RosterEntry> merged;
        merged.reserve(requestedPlayers.size() + requestedAIs.size());
        for (const auto& rp : requestedPlayers)
            merged.push_back({rp.team, rp.startPos, false, ""});
        for (const auto& rq : requestedAIs)
            merged.push_back({rq.team, rq.startPos, true, rq.id});
        sim.SetRoster(std::move(merged));
    }

    sim.Init(smfPath);

    // --- Bake def cache for HTTP delivery ---
    //
    // After sim.Init the engine has parsed gamedata/defs.lua (with the
    // room's modOptions in scope) and populated unitDefHandler /
    // weaponDefHandler. Serialize the full def set to a content-addressed
    // path under data/games/{gameId}/cache/defs/{key}/ so the lobby's
    // static handler can serve it as immutable HTTP. Clients fetch via
    // HTTP and have the full def set populated before LuaUI bootstrap
    // — replaces per-tick on-demand def streaming.
    //
    // The cache key includes modOptions so different rooms with
    // different post-processing don't collide. Same modOptions across
    // rooms ⇒ same key ⇒ file already on disk ⇒ no rewrite, no
    // re-serialize, browser cache hit.
    std::string defsCacheKey;
    if (unitDefHandler && weaponDefHandler && !gameId.empty()) {
        defsCacheKey = DefsCache::ComputeCacheKey(
            gameId, gameVersion, CGameSetup::GetModOptions());

        // Skip re-baking if the cache files already exist for this key.
        // This is the warm path: same modOptions in repeat sessions.
        namespace fs = std::filesystem;
        const fs::path dir = DefsCache::CacheDir(gameId, defsCacheKey);
        const bool warm = fs::exists(dir / "unitdefs.bin")
                       && fs::exists(dir / "weapondefs.bin");

        if (warm) {
            SLOG(SPRING_LOG_NOTICE, "defs cache warm: gameId=%s key=%s",
                 gameId.c_str(), defsCacheKey.c_str());
        } else {
            auto udBytes = Protocol::BuildGameUnitDefs(
                unitDefHandler->GetUnitDefsVec(), gameId);
            auto wdBytes = Protocol::BuildGameWeaponDefs(
                weaponDefHandler->GetWeaponDefsVec(), gameId);
            if (DefsCache::WriteIfMissing(gameId, defsCacheKey, udBytes, wdBytes)) {
                SLOG(SPRING_LOG_NOTICE,
                     "defs cache baked: gameId=%s key=%s "
                     "(unitdefs=%zu B, weapondefs=%zu B)",
                     gameId.c_str(), defsCacheKey.c_str(),
                     udBytes.size(), wdBytes.size());
            } else {
                SLOG(SPRING_LOG_ERROR,
                     "defs cache write failed: gameId=%s key=%s "
                     "(falling back to per-session WebRTC streaming)",
                     gameId.c_str(), defsCacheKey.c_str());
                defsCacheKey.clear();
            }
        }
    }

    // --- Player roster lookup ---
    //
    // Build a `username -> team` map from the --player args so the
    // WebRTC auth handler can stamp the session's team on login.
    std::unordered_map<std::string, int> playerTeamByUsername;
    for (const auto& rp : requestedPlayers) {
        playerTeamByUsername[rp.username] = rp.team;
    }

    // Map WebRTC clientId -> Spring playerNum so we can fire
    // eventHandler.PlayerRemoved() with the correct id on disconnect.
    std::unordered_map<ClientID, int> clientPlayerNum;
    int nextPlayerNum = 0;

    // --- Waiting-for-players ---
    //
    // GameStart is deferred until all roster players have connected
    // and registered CPlayers. This matches real Spring's behaviour
    // where GameStart fires after all clients signal "loaded".
    std::unordered_set<std::string> connectedRosterPlayers;
    const size_t rosterPlayersNeeded = requestedPlayers.size();

    auto checkAndFireGameStart = [&]() {
        if (sim.HasGameStarted())
            return;
        if (connectedRosterPlayers.size() < rosterPlayersNeeded)
            return;
        SLOG(SPRING_LOG_NOTICE, "all %zu roster players connected, firing GameStart",
            rosterPlayersNeeded);
        sim.FireGameStart();
    };

    // Dev-mode: no roster means no players to wait for
    if (rosterPlayersNeeded == 0) {
        SLOG(SPRING_LOG_NOTICE, "no player roster (dev mode), firing GameStart immediately");
        sim.FireGameStart();
    }

    // --- AI slot resolution ---
    //
    // The lobby passes zero or more `--ai <id>:<team>` pairs on the
    // command line, one per AI slot the host added before starting.
    // Resolve each id against the server's own AIDiscovery run over
    // the same game path the lobby scanned, so a plugin shadowing
    // an engine default resolves the same way in both tiers. For
    // each resolved plugin we slurp its main.lua into memory and
    // hand it to AIRuntimePool::AddAI, which spawns a worker thread
    // running the Lua VM.
    //
    // A failed resolution is a soft error: log it, move on. One bad
    // AI entry shouldn't stop the game from starting for the rest
    // of the roster.
    if (!requestedAIs.empty()) {
        const std::string enginePath = "content/engine";
        const auto discovered = AIDiscovery::Discover(enginePath, gamePath);

        for (const auto& rq : requestedAIs) {
            const AIDiscovery::AIInfo* match = nullptr;
            for (const auto& ai : discovered) {
                if (ai.id == rq.id) { match = &ai; break; }
            }
            if (!match) {
                SLOG(SPRING_LOG_WARNING,
                    "--ai %s:%d: no matching plugin found, skipping",
                    rq.id.c_str(), rq.team);
                continue;
            }

            // Classic Spring "LuaAI" entries (e.g. ZK's CAI / CAI2)
            // have no standalone runtime — the AI logic lives inside
            // the game's synced LuaRules gadgets, which dispatch on
            // `Spring.GetTeamLuaAI(teamId)`. The roster entry pushed
            // earlier already populates that map, so there's nothing
            // for AIRuntimePool to do.
            if (match->isLuaAI) {
                SLOG(SPRING_LOG_NOTICE,
                    "registered LuaAI '%s' on team %d (handled by game gadgets)",
                    match->displayName.c_str(), rq.team);
                continue;
            }

            std::ifstream mainFile(match->entryPath);
            if (!mainFile.is_open()) {
                SLOG(SPRING_LOG_ERROR,
                    "--ai %s:%d: failed to open entry '%s'",
                    rq.id.c_str(), rq.team, match->entryPath.c_str());
                continue;
            }
            const std::string code((std::istreambuf_iterator<char>(mainFile)),
                                    std::istreambuf_iterator<char>());

            // allyTeam defaults to the team id until we grow a real
            // alliance concept — teams are their own ally for now.
            const int allyTeam = rq.team;
            if (aiPool.AddAI(match->id, rq.team, allyTeam, code)) {
                SLOG(SPRING_LOG_NOTICE,
                    "loaded AI '%s' (%s) on team %d",
                    match->displayName.c_str(), match->id.c_str(), rq.team);
            } else {
                SLOG(SPRING_LOG_ERROR,
                    "failed to init AI '%s' on team %d",
                    match->id.c_str(), rq.team);
            }
        }
    } else {
        SLOG(SPRING_LOG_NOTICE, "no AI slots configured; human-only game");
    }

    // --- Fixed-timestep loop at GAME_SPEED Hz (30 Hz) ---
    const auto tickInterval = std::chrono::microseconds(1'000'000 / GAME_SPEED);
    auto nextTick = std::chrono::steady_clock::now();

    if (sim.IsWaitingForPlayers()) {
        SLOG(SPRING_LOG_NOTICE, "waiting for %zu player(s) to connect before starting game...",
            rosterPlayersNeeded);
    }
    SLOG(SPRING_LOG_NOTICE, "entering sim loop at %d Hz (port %d)", GAME_SPEED, port);

    while (keepRunning.load()) {
        // Wait for next tick
        auto now = std::chrono::steady_clock::now();
        if (now < nextTick) {
            std::this_thread::sleep_until(nextTick);
        }
        nextTick += tickInterval;

        // If we fell behind, skip ticks rather than accumulating
        now = std::chrono::steady_clock::now();
        if (now > nextTick + tickInterval) {
            int skipped = 0;
            while (nextTick + tickInterval < now) {
                nextTick += tickInterval;
                skipped++;
            }
            if (skipped > 0) {
                SLOG(SPRING_LOG_WARNING, "sim fell behind, skipped %d ticks", skipped);
            }
        }

        perfMetrics.BeginTick();
        sessions.ResetTickCounters();

        // Drain inbound messages from WebRTC data channels
        auto messages = rtcServer.DrainInbound();
        for (auto& msg : messages) {
            auto* clientMsg = Protocol::ParseClientMessage(msg.data.data(), msg.data.size());
            if (!clientMsg || !clientMsg->payload()) {
                auto err = Protocol::BuildServerError(400, "Invalid message");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                continue;
            }

            if (logMessages) {
                SLOG(SPRING_LOG_DEBUG, "msg: client=%u type=%d size=%zu",
                    msg.clientId, (int)clientMsg->payload_type(), msg.data.size());
            }

            switch (clientMsg->payload_type()) {
                case SpringWeb::ClientPayload_Ping: {
                    auto* ping = clientMsg->payload_as_Ping();
                    auto pong = Protocol::BuildPong(
                        ping->client_time(),
                        static_cast<uint64_t>(sim.GetFrameNum()));
                    rtcServer.SendReliable(msg.clientId, pong.data(), pong.size());
                    break;
                }
                case SpringWeb::ClientPayload_Handshake: {
                    auto* hs = clientMsg->payload_as_Handshake();
                    SLOG(SPRING_LOG_INFO, "handshake from client %u: v%d %s",
                        msg.clientId,
                        hs->protocol_version(),
                        hs->client_version() ? hs->client_version()->c_str() : "unknown");
                    break;
                }
                case SpringWeb::ClientPayload_AuthRequest: {
                    auto* auth = clientMsg->payload_as_AuthRequest();
                    const char* username = auth->username() ? auth->username()->c_str() : "";
                    const char* passHash = auth->password_hash() ? auth->password_hash()->c_str() : "";

                    // Helper: resolve a username against the lobby-
                    // supplied roster. Returns the assigned team, or
                    // -1 if the roster is empty (dev-mode permissive)
                    // OR the username isn't in the roster at all.
                    // Callers use -1 as a reject signal when the
                    // roster is non-empty.
                    auto resolveTeam = [&](const std::string& name) -> int {
                        if (playerTeamByUsername.empty()) return -1;
                        auto it = playerTeamByUsername.find(name);
                        return (it != playerTeamByUsername.end()) ? it->second : -1;
                    };
                    const bool rosterRequired = !playerTeamByUsername.empty();

                    // Try token-based reconnection first
                    const bool hasToken = auth->token() && auth->token()->size() > 0;
                    if (hasToken) {
                        int64_t userId = db.ValidateSession(auth->token()->str());
                        if (userId > 0) {
                            // Look up the username from the userId so we
                            // can cross-check against the lobby roster.
                            auto reconnectUser = db.FindUserById(userId);
                            if (!reconnectUser) {
                                auto resp = Protocol::BuildAuthResponse(
                                    SpringWeb::AuthStatus_InvalidCredentials,
                                    "", 0, "Session user missing");
                                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                                break;
                            }
                            const int team = resolveTeam(reconnectUser->username);
                            if (rosterRequired && team < 0) {
                                auto resp = Protocol::BuildAuthResponse(
                                    SpringWeb::AuthStatus_InvalidCredentials,
                                    "", 0, "Not in this room's roster");
                                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                                break;
                            }
                            auto resp = Protocol::BuildAuthResponse(
                                SpringWeb::AuthStatus_OK, auth->token()->str(),
                                static_cast<uint32_t>(userId), "",
                                static_cast<int8_t>(team), defsCacheKey);
                            rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                            // Register the session — previously the
                            // token path skipped this, which meant a
                            // reconnected client had no session and
                            // every PlayerCommand bounced at the
                            // REQUIRE_SESSION guard.
                            sessions.AddSession(msg.clientId, userId,
                                reconnectUser->username, reconnectUser->role);
                            if (auto* s = sessions.GetSession(msg.clientId))
                                s->team = team;
                            // Register a Spring CPlayer so Lua can
                            // query player info and receive callins.
                            {
                                int pNum = nextPlayerNum++;
                                CPlayer p;
                                p.name = reconnectUser->username;
                                p.team = team;
                                p.active = true;
                                p.playerNum = pNum;
                                playerHandler.AddPlayer(p);
                                clientPlayerNum[msg.clientId] = pNum;
                            }
                            SLOG(SPRING_LOG_NOTICE,
                                "client %u reconnected as '%s' (id=%lld) team=%d",
                                msg.clientId, reconnectUser->username.c_str(),
                                userId, team);
                            // Track roster connection for GameStart
                            if (playerTeamByUsername.count(reconnectUser->username)) {
                                connectedRosterPlayers.insert(reconnectUser->username);
                                checkAndFireGameStart();
                            }
                            // Map data is now served via HTTP from the lobby
                            // server at /api/maps/data/{mapId}/metadata.json +
                            // binary .bin files. No longer sent over WebRTC.
                            // Defs stream incrementally via entity/projectile state.
                            break;
                        }
                        // Token was present but ValidateSession failed.
                        // If no password was supplied this is a pure
                        // reconnect attempt and falling through into
                        // the password branch would surface as a
                        // misleading "Wrong password" error — reject
                        // cleanly with "Session expired" so the client
                        // can drop the stale token and re-auth. Mirrors
                        // the lobby's behaviour at lobby_main.cpp.
                        if (strlen(passHash) == 0) {
                            auto resp = Protocol::BuildAuthResponse(
                                SpringWeb::AuthStatus_InvalidCredentials,
                                "", 0, "Session expired");
                            rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                            break;
                        }
                    }

                    // Look up or create user
                    auto user = db.FindUser(username);
                    if (!user) {
                        // Auto-register for now (Phase 1 MVP)
                        int64_t newId = db.CreateUser(username, passHash);
                        if (newId == 0) {
                            auto resp = Protocol::BuildAuthResponse(
                                SpringWeb::AuthStatus_InvalidCredentials, "", 0,
                                "Registration failed");
                            rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                            break;
                        }
                        user = db.FindUser(username);
                    }

                    // Check password
                    if (user->passwordHash != passHash) {
                        auto resp = Protocol::BuildAuthResponse(
                            SpringWeb::AuthStatus_InvalidCredentials, "", 0,
                            "Wrong password");
                        rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                        break;
                    }

                    // Check ban
                    if (user->isBanned) {
                        auto resp = Protocol::BuildAuthResponse(
                            SpringWeb::AuthStatus_AccountBanned, "", 0,
                            "Account banned");
                        rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                        break;
                    }

                    // Roster membership: reject anyone the lobby
                    // didn't pre-authorise for this game. Dev-mode
                    // (empty roster) skips this check.
                    const int team = resolveTeam(user->username);
                    if (rosterRequired && team < 0) {
                        auto resp = Protocol::BuildAuthResponse(
                            SpringWeb::AuthStatus_InvalidCredentials,
                            "", 0, "Not in this room's roster");
                        rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                        SLOG(SPRING_LOG_WARNING,
                            "client %u rejected: '%s' not in roster",
                            msg.clientId, user->username.c_str());
                        break;
                    }

                    // Create session
                    std::string token = generateToken();
                    db.CreateSession(user->id, token);

                    auto resp = Protocol::BuildAuthResponse(
                        SpringWeb::AuthStatus_OK, token,
                        static_cast<uint32_t>(user->id), "",
                        static_cast<int8_t>(team), defsCacheKey);
                    rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                    sessions.AddSession(msg.clientId, user->id, user->username, user->role);
                    if (auto* s = sessions.GetSession(msg.clientId))
                        s->team = team;
                    // Register a Spring CPlayer so Lua can query
                    // player info and receive callins.
                    {
                        int pNum = nextPlayerNum++;
                        CPlayer p;
                        p.name = user->username;
                        p.team = team;
                        p.active = true;
                        p.playerNum = pNum;
                        playerHandler.AddPlayer(p);
                        clientPlayerNum[msg.clientId] = pNum;
                    }
                    SLOG(SPRING_LOG_NOTICE, "client %u authenticated as '%s' (id=%lld) team=%d",
                        msg.clientId, username, user->id, team);

                    // Track roster connection for GameStart
                    if (playerTeamByUsername.count(user->username)) {
                        connectedRosterPlayers.insert(user->username);
                        checkAndFireGameStart();
                    }

                    // Send room list to newly authenticated client
                    {
                        auto allRooms = rooms.GetAllRooms();
                        auto listMsg = Protocol::BuildRoomListUpdate(allRooms);
                        rtcServer.SendReliable(msg.clientId, listMsg.data(), listMsg.size());
                    }

                    // Map data is now served via HTTP from the lobby server
                    // at /api/maps/data/{mapId}/metadata.json + binary .bin
                    // files. No longer sent as a FlatBuffer over WebRTC
                    // (the 2+ MB MapData message exceeded SCTP's 256KB limit).
                    // Unit and weapon defs are NOT sent eagerly on auth.
                    // They stream incrementally as the client encounters
                    // new entity/projectile types during state updates.
                    break;
                }
                case SpringWeb::ClientPayload_PlayerCommand: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) {
                        auto err = Protocol::BuildServerError(401, "Not authenticated");
                        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                        break;
                    }

                    // Rate limiting
                    if (session->commandsThisTick >= SessionManager::MAX_COMMANDS_PER_TICK) {
                        auto err = Protocol::BuildServerError(429, "Command rate limit exceeded");
                        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                        break;
                    }
                    session->commandsThisTick++;

                    auto* cmd = clientMsg->payload_as_PlayerCommand();

                    // Sequence validation (must be monotonically increasing)
                    if (cmd->sequence() <= session->lastCommandSeq && session->lastCommandSeq > 0) {
                        auto err = Protocol::BuildServerError(400, "Stale command sequence");
                        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                        break;
                    }
                    session->lastCommandSeq = cmd->sequence();

                    // Build a Command from the PlayerCommand message
                    {
                        Command simCmd(cmd->command_id(), static_cast<unsigned char>(cmd->options()));
                        if (cmd->timeout_frames() > 0)
                            simCmd.SetTimeOut(static_cast<int>(cmd->timeout_frames()));

                        // Copy parameters
                        if (cmd->params()) {
                            for (unsigned i = 0; i < cmd->params()->size(); i++)
                                simCmd.PushParam(cmd->params()->Get(i));
                        }

                        // Route command to each target unit, dropping
                        // any that don't belong to this session's
                        // team. session->team == -1 means "no roster
                        // restriction" (dev smoketest or spectator)
                        // and lets the command through unchanged,
                        // which preserves the old behaviour when the
                        // lobby isn't in the loop.
                        int routed = 0;
                        int rejectedTeam = 0;
                        if (cmd->squad_ids()) {
                            for (unsigned i = 0; i < cmd->squad_ids()->size(); i++) {
                                uint32_t unitId = cmd->squad_ids()->Get(i);
                                CUnit* unit = unitHandler.GetUnit(unitId);
                                if (unit == nullptr || unit->isDead)
                                    continue;
                                if (session->team >= 0 && unit->team != session->team) {
                                    rejectedTeam++;
                                    continue;
                                }
                                unit->commandAI->GiveCommand(simCmd);
                                routed++;
                            }
                        }

                        SLOG(SPRING_LOG_DEBUG,
                            "cmd: client %u (%s, team=%d): cmd=%d seq=%u routed=%d rejected=%d/%d",
                            msg.clientId, session->username.c_str(), session->team,
                            cmd->command_id(), cmd->sequence(),
                            routed, rejectedTeam,
                            cmd->squad_ids() ? (int)cmd->squad_ids()->size() : 0);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_ViewportUpdate: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) {
                        auto err = Protocol::BuildServerError(401, "Not authenticated");
                        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                        break;
                    }

                    auto* vpu = clientMsg->payload_as_ViewportUpdate();
                    int vpId = vpu->viewport_id();
                    if (vpId >= MAX_VIEWPORTS) {
                        auto err = Protocol::BuildServerError(400, "Invalid viewport ID");
                        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                        break;
                    }

                    auto& vp = session->viewports[vpId];
                    vp.centerX   = vpu->center_x();
                    vp.centerZ   = vpu->center_z();
                    vp.width     = vpu->width();
                    vp.height    = vpu->height();
                    vp.rotation  = vpu->rotation();
                    vp.zoomLevel = vpu->zoom_level();
                    vp.active    = (vp.width > 0.0f && vp.height > 0.0f);
                    break;
                }
                // --- Room message helpers ---
                // Broadcasts room state to members + room list to everyone
                #define BROADCAST_ROOM_UPDATE(roomPtr) do { \
                    if (roomPtr) { \
                        auto _sm = Protocol::BuildRoomStateUpdate(*roomPtr); \
                        for (const auto& _p : roomPtr->players) \
                            rtcServer.SendReliable(_p.clientId, _sm.data(), _sm.size()); \
                    } \
                    auto _all = rooms.GetAllRooms(); \
                    auto _lm = Protocol::BuildRoomListUpdate(_all); \
                    rtcServer.BroadcastReliable(_lm.data(), _lm.size()); \
                } while(0)

                case SpringWeb::ClientPayload_RoomCreate: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) { auto e = Protocol::BuildServerError(401, "Auth required"); rtcServer.SendReliable(msg.clientId, e.data(), e.size()); break; }

                    auto* rc = clientMsg->payload_as_RoomCreate();
                    uint32_t roomId = rooms.CreateRoom(
                        rc->name() ? rc->name()->str() : "Game",
                        rc->map_id() ? rc->map_id()->str() : "",
                        rc->game_id() ? rc->game_id()->str() : "",
                        rc->max_players() > 0 ? rc->max_players() : 8,
                        rc->password() ? rc->password()->str() : "",
                        static_cast<uint32_t>(session->userId), msg.clientId, session->username);
                    BROADCAST_ROOM_UPDATE(rooms.GetRoom(roomId));
                    break;
                }
                case SpringWeb::ClientPayload_RoomJoin: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) { auto e = Protocol::BuildServerError(401, "Auth required"); rtcServer.SendReliable(msg.clientId, e.data(), e.size()); break; }

                    auto* rj = clientMsg->payload_as_RoomJoin();
                    if (!rooms.JoinRoom(rj->room_id(), static_cast<uint32_t>(session->userId),
                                        msg.clientId, session->username,
                                        rj->password() ? rj->password()->str() : "")) {
                        auto e = Protocol::BuildServerError(403, "Cannot join room");
                        rtcServer.SendReliable(msg.clientId, e.data(), e.size());
                        break;
                    }
                    BROADCAST_ROOM_UPDATE(rooms.GetRoom(rj->room_id()));
                    break;
                }
                case SpringWeb::ClientPayload_RoomLeave: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) break;
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room) {
                        uint32_t rid = room->id;
                        rooms.LeaveRoom(rid, static_cast<uint32_t>(session->userId));
                        BROADCAST_ROOM_UPDATE(rooms.GetRoom(rid));
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomTeamSelect: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) break;
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room) {
                        rooms.SetTeam(room->id, static_cast<uint32_t>(session->userId),
                                      clientMsg->payload_as_RoomTeamSelect()->team());
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomReady: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) break;
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room) {
                        rooms.SetReady(room->id, static_cast<uint32_t>(session->userId),
                                       clientMsg->payload_as_RoomReady()->ready());
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomStartGame: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) break;
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room && rooms.StartGame(room->id, static_cast<uint32_t>(session->userId))) {
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomKick: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) break;

                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room) {
                        rooms.KickPlayer(room->id, static_cast<uint32_t>(session->userId),
                                         clientMsg->payload_as_RoomKick()->player_id());
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_LuaRulesMsg: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) {
                        SLOG(SPRING_LOG_NOTICE,
                             "[server] LuaRulesMsg drop: no session for client %u",
                             msg.clientId);
                        auto err = Protocol::BuildServerError(401, "Not authenticated");
                        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                        break;
                    }
                    if (luaRules == nullptr) {
                        SLOG(SPRING_LOG_NOTICE,
                             "[server] LuaRulesMsg drop: luaRules not loaded");
                        break;
                    }

                    auto pIt = clientPlayerNum.find(msg.clientId);
                    if (pIt == clientPlayerNum.end()) {
                        SLOG(SPRING_LOG_NOTICE,
                             "[server] LuaRulesMsg drop: no playerNum for client %u",
                             msg.clientId);
                        break;
                    }

                    auto* lrm = clientMsg->payload_as_LuaRulesMsg();
                    auto* dataVec = lrm ? lrm->data() : nullptr;
                    if (dataVec == nullptr) {
                        SLOG(SPRING_LOG_NOTICE,
                             "[server] LuaRulesMsg drop: empty data vector");
                        break;
                    }

                    std::string payload(reinterpret_cast<const char*>(dataVec->data()),
                                        dataVec->size());
                    SLOG(SPRING_LOG_NOTICE,
                         "[server] LuaRulesMsg dispatch: client=%u player=%d bytes=%zu head='%s'",
                         msg.clientId, pIt->second, payload.size(),
                         payload.substr(0, std::min<size_t>(payload.size(), 64)).c_str());
                    luaRules->RecvLuaMsg(payload, pIt->second);
                    break;
                }
                case SpringWeb::ClientPayload_ConsoleCommand: {
                    auto* cc = clientMsg->payload_as_ConsoleCommand();
                    if (!cc) break;
                    LuaExecRequest req;
                    req.requestId = cc->request_id();
                    req.scope = cc->scope() ? cc->scope()->str() : "server";
                    req.code = cc->command() ? cc->command()->str() : "";
                    req.clientId = msg.clientId;
                    luaExecEngine.Push(std::move(req));
                    break;
                }
                default:
                    break;
            }
        }

        // --- Handle client disconnects ---
        // The network thread pushes disconnected ClientIDs to a queue;
        // we drain it here and fire the Lua PlayerRemoved callin so
        // game scripts can decide what to do (kill units, pause, hand
        // to AI, end the game, etc.). We also broadcast a PlayerLeft
        // FlatBuffers message so remaining clients can update their UI.
        {
            auto disconnects = rtcServer.DrainDisconnects();
            for (ClientID dcId : disconnects) {
                auto* session = sessions.GetSession(dcId);
                if (!session) continue;

                SLOG(SPRING_LOG_NOTICE,
                    "player '%s' (client %u, team %d) disconnected",
                    session->username.c_str(), dcId, session->team);

                // Broadcast PlayerLeft to remaining clients
                auto plMsg = Protocol::BuildPlayerLeft(
                    static_cast<uint32_t>(session->userId),
                    session->username,
                    static_cast<int8_t>(session->team),
                    0 /* reason: voluntary quit */);
                rtcServer.BroadcastReliable(plMsg.data(), plMsg.size());

                // Fire the Spring PlayerRemoved callin into Lua so
                // game gadgets can react (the callin signature is
                // gadget:PlayerRemoved(playerId, reason)).
                auto pIt = clientPlayerNum.find(dcId);
                if (pIt != clientPlayerNum.end()) {
                    int pNum = pIt->second;
                    playerHandler.PlayerLeft(pNum, 0);
                    eventHandler.PlayerRemoved(pNum, 0);
                    clientPlayerNum.erase(pIt);
                }

                sessions.RemoveSession(dcId);
            }
        }

        // Only tick the sim after GameStart has fired (all players in)
        // Skip sim tick when debugger has paused at a breakpoint
        if (sim.HasGameStarted() && !g_luaDebugger.IsPaused()) {
            sim.SimFrame();
            springlog_set_frame(sim.GetFrameNum());
        }

        // Process pending console commands (from WS thread or HTTP)
        {
            LuaExecRequest req;
            while (luaExecEngine.TryPop(req)) {
                auto result = ExecuteLuaExecRequest(req);
                // Deliver to sync waiters (HTTP POST /api/exec)
                luaExecEngine.DeliverResult(result);
                // Send to WS client if this came from a WS connection
                if (result.clientId != 0) {
                    auto resp = Protocol::BuildConsoleResponse(
                        result.requestId, result.scope, result.success,
                        result.output, result.success ? 0 : 4);
                    rtcServer.SendReliable(result.clientId, resp.data(), resp.size());
                }
            }
        }

        // Check win condition every ~1s (30 ticks) after frame 30
        static int winningTeam = -1;
        {
        int frame = sim.GetFrameNum();
        if (frame > 30 && (frame % 30) == 0 && winningTeam < 0) {
            // Count alive units per team
            int alive[2] = {0, 0};
            const auto& activeUnits = unitHandler.GetActiveUnits();
            for (CUnit* u : activeUnits) {
                if (u && !u->isDead && u->team >= 0 && u->team < 2)
                    alive[u->team]++;
            }

            if (alive[0] == 0 && alive[1] > 0) winningTeam = 1;
            else if (alive[1] == 0 && alive[0] > 0) winningTeam = 0;

            if (winningTeam >= 0) {
                SLOG(SPRING_LOG_NOTICE, "GAME OVER: team %d wins (frame %d)",
                    winningTeam, frame);
                // Broadcast GameInfo with paused=true to signal game over
                auto gameOver = Protocol::BuildGameInfo("", "", 0.0f,
                    static_cast<uint32_t>(frame), true);
                rtcServer.BroadcastReliable(gameOver.data(), gameOver.size());
            }
        }
        }

        // Broadcast resource updates every 10 ticks (~0.33s)
        {
        int curFrame = sim.GetFrameNum();
        if (curFrame >= 0 && (curFrame % 10) == 0 && rtcServer.GetClientCount() > 0) {
            sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                if (session.team < 0) return;
                CTeam* team = teamHandler.Team(session.team);
                if (!team) return;
                auto msg = Protocol::BuildResourceUpdate(
                    static_cast<uint8_t>(session.team),
                    team->res.metal,        team->resStorage.metal,
                    team->res.energy,       team->resStorage.energy,
                    team->resPrevIncome.metal,   team->resPrevIncome.energy,
                    team->resPrevPull.metal,     team->resPrevPull.energy,
                    team->resPrevExpense.metal,  team->resPrevExpense.energy,
                    team->resShare.metal,        team->resShare.energy,
                    team->resPrevSent.metal,     team->resPrevSent.energy,
                    team->resPrevReceived.metal, team->resPrevReceived.energy,
                    team->resPrevExcess.metal,   team->resPrevExcess.energy);
                rtcServer.SendReliable(clientId, msg.data(), msg.size());
            });
        }
        }

        // Broadcast unit command queues every 30 ticks (~1s). Queues
        // change far slower than entity state, so a low cadence is
        // fine; widgets that read GetUnitCommands tolerate the
        // occasional stale frame.
        //
        // Visibility: queues are sent for any team allied with the
        // session's team (own team + teammates). Build-command descs
        // stay own-team only — they're meaningless for allied units
        // the player can't actually issue build orders to.
        {
        int curFrame = sim.GetFrameNum();
        if (curFrame >= 0 && (curFrame % 30) == 0 && rtcServer.GetClientCount() > 0) {
            sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                if (session.team < 0) return;

                // Gather units across every team in the session's
                // alliance. AlliedTeams handles asymmetric alliance
                // declarations correctly. teamHandler.AllyTeam(self)
                // is always self-allied so own units are included.
                std::vector<CUnit*> visibleUnits;
                const int activeTeams = teamHandler.ActiveTeams();
                for (int t = 0; t < activeTeams; ++t) {
                    if (!teamHandler.AlliedTeams(session.team, t)) continue;
                    const auto& tu = unitHandler.GetUnitsByTeam(t);
                    visibleUnits.insert(visibleUnits.end(), tu.begin(), tu.end());
                }
                if (!visibleUnits.empty()) {
                    auto msg = Protocol::BuildUnitCommandQueues(visibleUnits);
                    rtcServer.SendReliable(clientId, msg.data(), msg.size());
                }

                // Cmd descs stay own-team — players can't issue build
                // orders to allied units, so streaming their build
                // options is wasted bandwidth.
                const auto& ownUnits = unitHandler.GetUnitsByTeam(session.team);
                if (!ownUnits.empty()) {
                    auto descs = Protocol::BuildUnitCmdDescs(ownUnits);
                    rtcServer.SendReliable(clientId, descs.data(), descs.size());
                }
            });
        }
        }

        // Broadcast periodic GameInfo every 30 ticks (~1s)
        {
        int curFrame = sim.GetFrameNum();
        if (curFrame >= 0 && (curFrame % 30) == 0 && rtcServer.GetClientCount() > 0 && winningTeam < 0) {
            const float3& wv = envResHandler.GetCurrentWindVec();
            auto msg = Protocol::BuildGameInfo(mapId, gameId, 1.0f,
                static_cast<uint32_t>(curFrame), false,
                wv.x, wv.y, wv.z,
                envResHandler.GetCurrentWindStrength(),
                envResHandler.GetCurrentTidalStrength());
            rtcServer.BroadcastReliable(msg.data(), msg.size());
        }
        }

        // Send entity state to connected clients every 3 ticks (~10 Hz)
        // Full snapshot every 30 ticks (~1s), delta updates otherwise.
        // Envelope: 0x02 = full snapshot, 0x03 = delta update.
        {
        int curFrame = sim.GetFrameNum();
        if (curFrame >= 0 && (curFrame % 3) == 0 && rtcServer.GetClientCount() > 0) {
            bool isFullSnapshot = (curFrame % 30) == 0;

            sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                // Map session->team to its ally team so the
                // visibility filter can skip enemy units that
                // aren't in this ally team's LOS.
                int viewerAllyTeam = -1;
                if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                    viewerAllyTeam = teamHandler.AllyTeam(session.team);

                // Collect candidate units (viewport-filtered or all)
                std::vector<CUnit*> candidates;
                if (session.HasViewport() && sim.HasMap()) {
                    candidates = EntityState::CollectViewportUnits(
                        session.viewports.data(),
                        static_cast<int>(session.viewports.size()),
                        viewerAllyTeam);
                } else {
                    candidates = EntityState::CollectAllUnits(viewerAllyTeam);
                }

                // (Def streaming removed — clients fetch the full def
                // set via HTTP at game start using AuthResponse's
                // defs_cache_key. See DefsCache::WriteIfMissing.)

                uint8_t envelope;
                std::vector<uint8_t> stateData;

                if (isFullSnapshot) {
                    envelope = 0x02;
                    stateData = EntityState::SerializeUnits(
                        candidates, EntityState::FIELD_ALL, viewerAllyTeam);
                    session.deltaCache.Clear();
                    for (CUnit* u : candidates)
                        session.deltaCache.Update(u, viewerAllyTeam);
                } else {
                    std::vector<CUnit*> changed;
                    for (CUnit* u : candidates) {
                        if (session.deltaCache.HasChanged(u, viewerAllyTeam))
                            changed.push_back(u);
                    }
                    for (CUnit* u : changed)
                        session.deltaCache.Update(u, viewerAllyTeam);

                    envelope = 0x03;
                    stateData = EntityState::SerializeUnits(
                        changed, EntityState::FIELD_ALL, viewerAllyTeam);
                }

                std::vector<uint8_t> frame;
                frame.reserve(1 + stateData.size());
                frame.push_back(envelope);
                frame.insert(frame.end(), stateData.begin(), stateData.end());
                rtcServer.SendUnreliable(clientId, frame.data(), frame.size());
            });
        }
        }

        // Projectile state used to stream every 3 ticks under envelope 0x04
        // as a struct-of-arrays snapshot of every live projectile. That
        // model has been replaced by event-based streaming: ProjectileFired
        // / ProjectileImpact / ProjectileTrajectory events ride alongside
        // combat events in the GameEventBatch broadcast below. The client
        // simulates motion locally between events. The serializer is kept
        // around (still useful for diagnostics / replays) but is no longer
        // wired into the broadcast path.

        // Send animated piece transforms (envelope 0x05) at the same
        // ~10 Hz cadence as projectiles. Piece animation is purely
        // cosmetic so the lower rate is fine — the client interpolates.
        // Visibility filtering reuses the per-session candidate list
        // logic below by rebuilding it here; piece-transform fanout is
        // small (only animated units appear in the payload), so the
        // overhead is acceptable.
        {
        int curFrame = sim.GetFrameNum();
        if (curFrame >= 0 && (curFrame % 3) == 0 && rtcServer.GetClientCount() > 0) {
            sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                int viewerAllyTeam = -1;
                if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                    viewerAllyTeam = teamHandler.AllyTeam(session.team);

                std::vector<CUnit*> candidates;
                if (session.HasViewport() && sim.HasMap()) {
                    candidates = EntityState::CollectViewportUnits(
                        session.viewports.data(),
                        static_cast<int>(session.viewports.size()),
                        viewerAllyTeam);
                } else {
                    candidates = EntityState::CollectAllUnits(viewerAllyTeam);
                }

                auto pieceData = PieceState::SerializeUnits(
                    candidates, static_cast<uint32_t>(curFrame));
                if (pieceData.empty()) return;

                std::vector<uint8_t> pieceFrame;
                pieceFrame.reserve(1 + pieceData.size());
                pieceFrame.push_back(Protocol::ENVELOPE_PIECE_STATE);
                pieceFrame.insert(pieceFrame.end(), pieceData.begin(), pieceData.end());
                rtcServer.SendUnreliable(clientId, pieceFrame.data(), pieceFrame.size());
            });
        }
        }

        // Send build-activity snapshot (envelope 0x06) at the same
        // ~10 Hz cadence. Per-session because enemy build activity
        // respects LOS — the client treats the absence of an entry as
        // "fade out the beam" so brief drops between snapshots don't
        // pop. We send the snapshot even when no builders are active so
        // the client can age out beams that completed or were cancelled
        // since the last snapshot; SerializeAll returns a 6-byte header
        // for the empty case, so the per-session bandwidth cost is ~7
        // bytes every 3rd frame.
        {
        int curFrame = sim.GetFrameNum();
        if (curFrame >= 0 && (curFrame % 3) == 0 && rtcServer.GetClientCount() > 0) {
            sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                int viewerAllyTeam = -1;
                if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                    viewerAllyTeam = teamHandler.AllyTeam(session.team);

                auto baData = BuildActivity::SerializeAll(
                    static_cast<uint32_t>(curFrame), viewerAllyTeam);
                if (baData.empty()) return;

                std::vector<uint8_t> baFrame;
                baFrame.reserve(1 + baData.size());
                baFrame.push_back(Protocol::ENVELOPE_BUILD_ACTIVITY);
                baFrame.insert(baFrame.end(), baData.begin(), baData.end());
                rtcServer.SendUnreliable(clientId, baFrame.data(), baFrame.size());
            });
        }
        }

        // Evaluate standing orders every ~1s (30 ticks)
        if (sim.GetFrameNum() > 0 && (sim.GetFrameNum() % 30) == 0) {
            standingOrders.Evaluate();
        }

        // Tick AI runtime and drain AI commands
        aiPool.Tick(sim.GetFrameNum());
        {
            auto aiCmds = aiPool.DrainCommands();
            for (const auto& cmd : aiCmds) {
                CUnit* unit = unitHandler.GetUnit(cmd.unitId);
                if (unit == nullptr || unit->isDead) continue;
                if (unit->team != cmd.teamId) continue; // validate ownership

                Command simCmd(cmd.commandId, cmd.options);
                for (int i = 0; i < cmd.numParams; i++)
                    simCmd.PushParam(cmd.params[i]);
                unit->commandAI->GiveCommand(simCmd);
            }
        }

        // Broadcast combat events + projectile lifecycle events. Projectiles
        // moved from per-tick state streaming (envelope 0x04) to event-based:
        // Fired/Impact/Trajectory events let the client run its own ballistic
        // simulation between sparse server updates. See PLAN-network.md.
        //
        // Per-session LOS / intel filter: each session only receives events
        // whose position is in its ally-team's line-of-sight, OR whose owner
        // team is allied to the viewer (so a player always sees their own
        // and allied projectiles even if the impact lands in fog of war).
        // Spectators and pre-auth sessions get the unfiltered stream.
        {
        auto events = combatEvents.Drain();
        auto projDrain = projectileEvents.Drain();
        const bool hasAny = !events.empty()
            || !projDrain.fired.empty()
            || !projDrain.impacts.empty()
            || !projDrain.trajectories.empty();
        if (hasAny && rtcServer.GetClientCount() > 0) {
            const uint32_t frameNo = static_cast<uint32_t>(sim.GetFrameNum());

            sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                int viewerAllyTeam = -1;
                if (session.team >= 0 && teamHandler.IsValidTeam(session.team))
                    viewerAllyTeam = teamHandler.AllyTeam(session.team);

                // Predicate: is event-position visible to the viewer?
                // Spectator (viewerAllyTeam < 0) sees everything.
                auto posVisible = [&](const float3& p) -> bool {
                    if (viewerAllyTeam < 0) return true;
                    if (losHandler == nullptr) return true;
                    return losHandler->InLos(p, viewerAllyTeam)
                        || losHandler->InAirLos(p, viewerAllyTeam)
                        || losHandler->InRadar(p, viewerAllyTeam);
                };

                // Predicate: is the owner team friendly to the viewer?
                // (Always show own/ally projectiles regardless of LOS.)
                auto teamFriendly = [&](uint8_t projTeam) -> bool {
                    if (viewerAllyTeam < 0) return true;
                    if (!teamHandler.IsValidTeam(projTeam)) return false;
                    return teamHandler.AllyTeam(projTeam) == viewerAllyTeam;
                };

                std::vector<ProjectileFiredEventData> fired;
                fired.reserve(projDrain.fired.size());
                for (const auto& e : projDrain.fired) {
                    // Fired: owner-friendly, OR launch in LOS, OR target in LOS
                    // (so a player sees an incoming missile at the moment its
                    // trajectory grazes their LOS bubble).
                    if (teamFriendly(e.team)
                        || posVisible(e.pos)
                        || posVisible(e.targetPos))
                        fired.push_back(e);
                }

                std::vector<ProjectileImpactEventData> impacts;
                impacts.reserve(projDrain.impacts.size());
                for (const auto& e : projDrain.impacts) {
                    if (teamFriendly(e.team) || posVisible(e.pos))
                        impacts.push_back(e);
                }

                std::vector<ProjectileTrajectoryEventData> trajectories;
                trajectories.reserve(projDrain.trajectories.size());
                for (const auto& e : projDrain.trajectories) {
                    if (teamFriendly(e.team) || posVisible(e.pos))
                        trajectories.push_back(e);
                }

                // Combat events also benefit from the same filter — the
                // current broadcast leaks fire+miss outcomes from fog.
                std::vector<CombatEventData> visibleCombat;
                visibleCombat.reserve(events.size());
                for (const auto& e : events) {
                    if (viewerAllyTeam < 0 || posVisible(e.position))
                        visibleCombat.push_back(e);
                }

                if (visibleCombat.empty() && fired.empty()
                    && impacts.empty() && trajectories.empty())
                    return;

                auto batch = Protocol::BuildCombatEventBatch(
                    frameNo, visibleCombat, fired, impacts, trajectories);
                rtcServer.SendReliable(clientId, batch.data(), batch.size());
            });
        }
        }

        // Broadcast unit deaths as EntityDestroy messages
        {
        auto deaths = unitDeaths.Drain();
        for (const auto& death : deaths) {
            auto msg = Protocol::BuildEntityDestroy(death.unitId, 1, death.x, death.y, death.z);
            rtcServer.BroadcastReliable(msg.data(), msg.size());
        }
        }

        perfMetrics.SetFrame(sim.GetFrameNum());
        perfMetrics.SetClientCount(rtcServer.GetClientCount());
        perfMetrics.SetAICount(static_cast<int>(aiPool.GetAICount()));
        perfMetrics.EndTick();

        // Periodic status
        int frame = sim.GetFrameNum();
        if (frame > 0 && (frame % (GAME_SPEED * 10)) == 0) {
            SLOG(SPRING_LOG_INFO, "frame %d (%.1fs) clients=%d",
                frame, frame / (float)GAME_SPEED, rtcServer.GetClientCount());
        }
    }

    if (restartRequested.load()) {
        SLOG(SPRING_LOG_NOTICE, "restart requested — notifying clients and re-exec'ing...");

        // Tell clients to reset and reconnect
        auto msg = Protocol::BuildGameRestarting();
        rtcServer.BroadcastReliable(msg.data(), msg.size());

        // Brief pause to let the message flush over WebRTC
        std::this_thread::sleep_for(std::chrono::milliseconds(150));

        net.Stop();
        sim.Kill();
        db.Close();

        SLOG(SPRING_LOG_NOTICE, "re-exec'ing: %s", savedArgv[0]);
        if (!logServer.empty())
            springlog_net_shutdown();
        springlog_sqlite_shutdown();
        springlog_shutdown();

        execvp(savedArgv[0], savedArgv);
        // If execvp returns, it failed
        fprintf(stderr, "ERROR: restart failed: %s\n", strerror(errno));
        return 1;
    }

    SLOG(SPRING_LOG_NOTICE, "shutting down (frame %d)...", sim.GetFrameNum());
    net.Stop();
    sim.Kill();
    db.Close();
    SLOG(SPRING_LOG_NOTICE, "exited cleanly");

    // Tear down optional sinks before the core logger
    if (!logServer.empty())
        springlog_net_shutdown();
    springlog_sqlite_shutdown();
    springlog_shutdown();

    return 0;
}
