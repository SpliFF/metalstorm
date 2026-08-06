/**
 * spring-server entry point
 *
 * Headless authoritative game server. Runs the simulation at a fixed
 * 30 Hz tick rate. Clients connect over WebTransport (QUIC/HTTP-3); the
 * endpoint is discovered via `GET /api/wt/info`. HTTP also serves map/game
 * assets and REST API endpoints.
 */

#include "Server/Simulation.h"
#include "Server/NetworkServer.h"
#include "Server/Protocol.h"
#include "Server/PlayerRosterBroadcast.h"
#include "Server/Database.h"
#include "Server/GameMetrics.h"
#include "Server/GrowthCounters.h"
#include <sys/stat.h>              // soak dump's db-size sample (S8)
#include "Lua/LuaHandleSynced.h"   // CSplitLuaHandle::GetGameParams — growth counters
#include "Server/GmVerbs.h"
#include "Server/GameStateStore.h"
#include "Server/DevBuildGate.h"
#include "Server/ClientSession.h"
#include "Server/EntityStateSerializer.h"
#include "Server/ProjectileStateSerializer.h"
#include "Server/PieceStateSerializer.h"
#include "Server/BuildActivitySerializer.h"
#include "Server/ContentServer.h"
#include "Server/CombatEventCollector.h"
#include "Server/DecalEventCollector.h"
#include "Server/ServerDecalHandler.h"
#include "Server/ServerTrackEmitter.h"
#include "Server/SoundEventCollector.h"
#include "Server/ProjectileEventCollector.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/TeamHandler.h"
#include "Server/DefsCache.h"
#include "Server/CegLoader.h"
#include "Server/LuaDefsSerializer.h"
#include "Server/ResourcesParser.h"
#include "Server/StandingOrders.h"
#include "Server/OrgGroups.h"
#include "Server/SyncedInputJournal.h"
#include "Server/ReplayFile.h"
#include "Server/ReplayPlayer.h"
#include "Server/ReplayControlDeck.h"
#include "Server/ReplayStateBroadcast.h"
#include "Server/AI/AIRuntimePool.h"
#include "Server/AI/AIDiscovery.h"
#include "Server/PerfMetrics.h"
#include "Server/RoomManager.h"
#include "Server/MapMetadata.h"
#include "Server/LuaExecEngine.h"
#include "Server/LuaDebugger.h"
#include "Server/GameServerContext.h"
#include "Server/GameStartCoordinator.h"
#include "Server/ClientMessageHandler.h"
#include "Server/StateStreamer.h"
#include "Server/GameHttpRoutes.h"
#include "Server/HeadlessRun.h"
#include "Server/StatsDump.h"
#include "Server/GameOverState.h"
#include "Server/PostGamePolicy.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Lua/LuaRules.h"
#include "Server/HttpAuth.h"
#include "Server/CacheControl.h"
#include "Server/SqliteThreading.h"
#include "Server/WebTransport/WebTransportServer.h"
#include "System/SpringLog/SpringLog.h"
#include "System/SpringLog/SpringLogNet.h"
#include "System/SpringLog/SpringLogSqlite.h"
#include "System/SpringLogBridge.h"
#include <sqlite3.h>
#include <nlohmann/json.hpp>

#define LOG_SECTION "server"

#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Weapons/WeaponDefHandler.h"
#include "Sim/Features/FeatureDefHandler.h"
#include "Game/GameSetup.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/GlobalConstants.h"
#include "Sim/MoveTypes/MoveDefHandler.h"
#include "Sim/Path/IPathManager.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/Wind.h"
#include "Sim/Misc/ModInfo.h"
#include "Game/Players/PlayerHandler.h"
#include "System/EventHandler.h"
#include "Map/ReadMap.h"
#include "System/FileSystem/FileHandler.h"
#include "System/Misc/SpringTime.h"
#include "System/SpringMath.h"

#include <array>
#include <csignal>
#include <cstdio>
#include <ctime>
#include <unistd.h>
#include <atomic>
#include <fstream>
#include <chrono>
#include <filesystem>
#include <optional>
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

int main(int argc, char* argv[])
{
    savedArgc = argc;
    savedArgv = argv;

    // D33: serialize SQLite before the first connection is opened —
    // springlog_init's sqlite sink is one, and the sim loop and network
    // thread later share `mapDb`/`statusDb`. Must precede springlog_init.
    // See Server/SqliteThreading.h.
    if (!SqliteEnableSerializedMode("spring-server"))
        return 1;

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
    uint32_t roomId = 0;       // Owning lobby room (--room); tags this process's logs
    std::string gameId;
    std::string gameVersion;   // From modinfo.lua via lobby --game-version arg
    std::string gamesDir = "data/games";
    std::string mapId;
    std::string mapsDir = "data/maps";
    std::string dbPath = "data/spring-server.db";
    // PLAN-security-hardening.md task 5 (G3): prod cert for the QUIC/WebTransport
    // endpoint. Both paths must be given together, or neither — see
    // WebTransportServer::Start(). Empty (the default) runs the endpoint in
    // Hashes mode (self-signed, serverCertificateHashes pinning) — fine for dev,
    // not for a public deployment (see docs/deployment.md).
    std::string wtCertPath;
    std::string wtKeyPath;
    // Idle self-termination tuning (non-persistent rooms only). A non-persistent
    // server exits after idleExitSeconds with zero connected clients, but not
    // before idleStartupGraceSeconds have passed (so it waits for the first
    // client). idleExitSeconds <= 0 disables idle exit (run until killed).
    //
    // Precedence: --idle-exit-seconds flag > env SPRING_IDLE_EXIT_SECONDS >
    // default. The env fallback lets the lobby (or mprocs) set a short timeout
    // for testing that every spawned game server inherits via execvp, without
    // the lobby having to forward the flag. Grace mirrors the same pattern.
    auto envInt = [](const char* key, int def) {
        const char* v = getenv(key);
        return (v && *v) ? std::atoi(v) : def;
    };
    int idleExitSeconds = envInt("SPRING_IDLE_EXIT_SECONDS", 300);          // 5 min
    int idleStartupGraceSeconds = envInt("SPRING_IDLE_STARTUP_GRACE_SECONDS", 120);  // 2 min
    // Post-game observation window: how long a *finished* server stays up with
    // its world frozen before shutting down and releasing its port. Distinct
    // from idle exit — this one runs with clients still connected, which is the
    // case idle exit by definition never covers. Same flag > env > default
    // precedence; <= 0 disables it (the room then lives until idle exit or a
    // kill). See PostGamePolicy.h.
    int postGameExitSeconds =
        envInt("SPRING_POSTGAME_EXIT_SECONDS", postgame::kDefaultExitSeconds);

    // --- Headless run mode (PLAN-headless task 1) ---
    // `--headless-run <config.json>` runs the sim to completion with no browser
    // client: no clients, no idle-exit, run-config-driven pacing (uncapped /
    // realtime / xN) and stop conditions (frame / gameOver / luaCondition), all
    // under a hard wall-clock ceiling (`--max-wall-min`, default 60, E4). When
    // no config is given the mode stays disabled and the loop behaves exactly
    // as a normal game (the tick-gate-off regression bar, PLAN-headless §6).
    std::string headlessConfigPath;
    int maxWallMin = 60;
    headless::Config headlessCfg;

    // --- Replay record/playback (PLAN-replay task 2) ---
    // `--journal-file <path>` records this game's cause stream to a replay file;
    // `--replay <path>` re-executes one. The two are mutually exclusive: a
    // replay that re-recorded its own feed would produce a file whose stream is
    // a copy of another file's, and the first person to diff them would spend a
    // day discovering that.
    std::string journalFilePath;
    std::string replayFilePath;
    std::string replayVerifyRef;
    bool replayVerify = false;
    int replaySeekFrame = 0;
    // PLAN-replay task 3: state-hash cadence for a recording, in sim frames
    // (300 = every 10 s at GAME_SPEED 30). On by default because a replay
    // without its own hash track cannot be verified at all, and the cost is one
    // unit-list walk twice a game-minute. 0 disables it.
    int journalHashEvery = 300;
    // `--replay <in> --replay-export <out>`: repack and exit, no sim.
    std::string replayExportPath;
    replay::Codec replayExportCodec = replay::Codec::Deflate;

    // Human player roster from the lobby. Each `--player <username>:<team>:<pos>`
    // entry gets one slot here. The sim uses this for two things:
    //   1. At AuthRequest time, look up the authenticating username
    //      to decide which team the session belongs to (rejects
    //      usernames not in the roster so a random WebSocket
    //      client can't materialise onto an arbitrary team).
    //   2. At SetupTestGame time, spawn units on each team slot at
    //      the requested map start position.
    std::vector<RequestedPlayer> requestedPlayers;

    // AI slot requests from the lobby. Each `--ai <id>:<team>:<pos>`
    // pair becomes one entry here; we resolve them against
    // AIDiscovery after content roots are set up. Empty list = no
    // AI players (human-only or dev-smoketest spawn).
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

    // --ai takes an optional 4th field (PLAN-metalstorm-ai.md §10 task 6):
    // "id:team:pos:profile". Same missing-trailing-field semantics as
    // splitSpec above, just one field wider.
    auto splitAiSpec = [](const std::string& spec) {
        std::array<std::string, 4> out;
        size_t prev = 0;
        for (int i = 0; i < 4; ++i) {
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

    // PLAN-replay task 1: 0 = no journal attached (the funnel still counts).
    int journalAuditRecords = 0;

    // Simple arg parsing: --port N, --game PATH, --map PATH, --db PATH,
    // --idle-exit-seconds N (0 = never), --idle-startup-grace-seconds N,
    // --postgame-exit-seconds N (0 = never; shutdown delay after game over),
    // --log-file PATH, --log-level LEVEL, --log-server URL,
    // --log-sqlite PATH, --debug, --log-messages,
    // --wt-cert PATH, --wt-key PATH,
    // --headless-run config.json (PLAN-headless: no-client batch/soak run),
    // --max-wall-min N (headless hard wall-clock ceiling, default 60),
    // --journal-audit [N] (PLAN-replay: record the synced-input cause stream
    //   in memory, cap N records, expose at GET /api/journal),
    // --journal-file PATH (PLAN-replay task 2: record the cause stream to a
    //   replay file),
    // --journal-hash-every N (PLAN-replay task 3: embed a state-hash reference
    //   point every N sim frames; 0 = none),
    // --replay PATH (re-execute a replay file instead of listening for input),
    // --replay-seek N (fast-forward to frame N with streaming suppressed),
    // --verify [PATH] (compare the replay's state-hash series against the
    //   file's own embedded track, or against a --headless-run stats dump when
    //   PATH is given; nonzero exit on divergence),
    // --replay-export PATH / --replay-export-codec none|deflate (repack the
    //   file given by --replay into a shareable .msr and exit),
    // --player username:team:pos (repeatable),
    // --ai id:team:pos (repeatable)
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) {
            port = std::atoi(argv[++i]);
        } else if (arg == "--room" && i + 1 < argc) {
            roomId = (uint32_t)std::strtoul(argv[++i], nullptr, 10);
        } else if (arg == "--game" && i + 1 < argc) {
            gameId = argv[++i];
        } else if (arg == "--game-version" && i + 1 < argc) {
            gameVersion = argv[++i];
        } else if (arg == "--map" && i + 1 < argc) {
            mapId = argv[++i];
        } else if (arg == "--db" && i + 1 < argc) {
            dbPath = argv[++i];
        } else if (arg == "--wt-cert" && i + 1 < argc) {
            wtCertPath = argv[++i];
        } else if (arg == "--wt-key" && i + 1 < argc) {
            wtKeyPath = argv[++i];
        } else if (arg == "--idle-exit-seconds" && i + 1 < argc) {
            idleExitSeconds = std::atoi(argv[++i]);
        } else if (arg == "--idle-startup-grace-seconds" && i + 1 < argc) {
            idleStartupGraceSeconds = std::atoi(argv[++i]);
        } else if (arg == "--postgame-exit-seconds" && i + 1 < argc) {
            postGameExitSeconds = std::atoi(argv[++i]);
        } else if (arg == "--headless-run" && i + 1 < argc) {
            headlessConfigPath = argv[++i];
        } else if (arg == "--max-wall-min" && i + 1 < argc) {
            maxWallMin = std::atoi(argv[++i]);
        } else if (arg == "--journal-file" && i + 1 < argc) {
            journalFilePath = argv[++i];
        } else if (arg == "--replay" && i + 1 < argc) {
            replayFilePath = argv[++i];
        } else if (arg == "--replay-seek" && i + 1 < argc) {
            replaySeekFrame = std::max(0, std::atoi(argv[++i]));
        } else if (arg == "--journal-hash-every" && i + 1 < argc) {
            journalHashEvery = std::max(0, std::atoi(argv[++i]));
        } else if (arg == "--replay-export" && i + 1 < argc) {
            replayExportPath = argv[++i];
        } else if (arg == "--replay-export-codec" && i + 1 < argc) {
            std::string cerr_;
            if (!replay::ParseCodec(argv[++i], replayExportCodec, cerr_)) {
                SLOG(SPRING_LOG_ERROR, "--replay-export-codec: %s", cerr_.c_str());
                return 1;
            }
        } else if (arg == "--verify") {
            // The argument is OPTIONAL as of task 3: a recording carries its own
            // hash track, so `--verify` alone is the normal form. A PATH still
            // works and overrides the embedded track — that is how the negative
            // control (verify a stream against another game's hashes) is run.
            replayVerify = true;
            if (i + 1 < argc && argv[i + 1][0] != '-')
                replayVerifyRef = argv[++i];
        } else if (arg == "--journal-audit") {
            // PLAN-replay task 1. Attaches the in-memory journal so the cause
            // stream is observable live (GET /api/journal) and summarised at
            // shutdown. Storage is deliberately in-memory only: the durable
            // journal belongs to PLAN-persistence phase 2, and this flag is
            // how the completeness audit is checked against a real game
            // without waiting for it.
            journalAuditRecords = 100000;
            if (i + 1 < argc && argv[i + 1][0] != '-')
                journalAuditRecords = std::max(1, std::atoi(argv[++i]));
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
        } else if (arg == DevBuildGate::kFlag) {
            // Accepted for consistency with spring-lobby/spring-logserver
            // (propagated automatically by spawnGameServer when the lobby
            // itself was acknowledged) — spring-server only warns, it never
            // hard-refuses to start. See DevBuildGate::WarnOnly.
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
        } else if (arg == "--modoption" && i + 1 < argc) {
            // Format: key=value. The lobby passes the room's modoptions
            // (FFA / commshare / multipliers / chicken-mode / …) so synced
            // gadgets read them via Spring.GetModOptions() and the def-cache
            // key reflects them. Seeded into the global CGameSetup before
            // sim init. (PLAN-bar.md §5.)
            const std::string kv = argv[++i];
            const auto eq = kv.find('=');
            if (eq == std::string::npos || eq == 0) {
                SLOG(SPRING_LOG_WARNING,
                    "ignoring malformed --modoption '%s' (expected key=value)",
                    kv.c_str());
                continue;
            }
            CGameSetup::SetModOption(kv.substr(0, eq), kv.substr(eq + 1));
        } else if (arg == "--ai" && i + 1 < argc) {
            // Format: <id>:<team>:<pos>:<profile>. We parse here and
            // resolve later, once we have a discovered AI list to look up
            // against. Accepts the legacy 2/3-tuple forms too, for
            // dev-smoketest invocations that predate start positions and
            // the profile field (PLAN-metalstorm-ai.md §10 task 6).
            const std::string spec = argv[++i];
            const auto parts = splitAiSpec(spec);
            if (parts[0].empty()) {
                SLOG(SPRING_LOG_WARNING,
                    "ignoring malformed --ai '%s' (expected id:team[:pos[:profile]])",
                    spec.c_str());
                continue;
            }
            RequestedAI rq;
            rq.id = parts[0];
            rq.team = parts[1].empty() ? 0 : std::atoi(parts[1].c_str());
            rq.startPos = parts[2].empty() ? -1 : std::atoi(parts[2].c_str());
            rq.profile = parts[3];
            requestedAIs.push_back(std::move(rq));
        } else if (arg[0] != '-') {
            // Legacy: bare number = port
            port = std::atoi(argv[i]);
        }
    }

    // --- Headless run config (PLAN-headless task 1) ---
    // Parse the run manifest and fold its self-contained map/game/aiSlots into
    // the same structures the CLI flags fill, but only where a flag was absent
    // (explicit --map/--game/--ai win over the manifest). The `headless` block
    // (tickMode / stopAt / statsDump / stateHashEvery) drives the sim loop below.
    if (!headlessConfigPath.empty()) {
        std::string cfgErr;
        if (!headless::ParseConfigFile(headlessConfigPath, headlessCfg, cfgErr)) {
            SLOG(SPRING_LOG_ERROR, "--headless-run: %s", cfgErr.c_str());
            return 1;
        }
        headlessCfg.enabled = true;
        headlessCfg.maxWallSec = static_cast<int64_t>(std::max(1, maxWallMin)) * 60;

        if (mapId.empty() && !headlessCfg.map.empty())
            mapId = headlessCfg.map;
        if (gameId.empty() && !headlessCfg.game.empty())
            gameId = headlessCfg.game;
        if (requestedAIs.empty() && !headlessCfg.aiSlots.empty()) {
            for (const auto& s : headlessCfg.aiSlots) {
                RequestedAI rq;
                rq.id = s.aiId;
                rq.team = s.team;
                rq.startPos = s.startPos;
                // PLAN-metalstorm-ai.md §10 task 6: previously dropped here —
                // the manifest's aiSlots[].profile was parsed by
                // HeadlessRun::ParseConfig but never reached the AI.
                rq.profile = s.profile;
                requestedAIs.push_back(std::move(rq));
            }
        }
        // Manifest modoptions fill gaps left by --modoption, same precedence
        // rule as map/game/aiSlots above. Per-key rather than all-or-nothing:
        // a fixture that sets three options and an operator who overrides one
        // of them from the command line both get what they asked for.
        for (const auto& kv : headlessCfg.modOptions) {
            if (CGameSetup::GetModOptions().count(kv.first) > 0)
                continue;
            CGameSetup::SetModOption(kv.first, kv.second);
        }

        std::string modeStr =
            headlessCfg.tickMode == headless::TickMode::Uncapped ? "uncapped"
          : headlessCfg.tickMode == headless::TickMode::Multiple
                ? ("x" + std::to_string(headlessCfg.tickMultiple))
          :                                                          "realtime";
        SLOG(SPRING_LOG_NOTICE,
            "headless run: tickMode=%s maxWall=%dmin stopAt{frame=%lld gameOver=%d lua=%s}",
            modeStr.c_str(),
            maxWallMin,
            headlessCfg.stopAt.frame ? (long long)*headlessCfg.stopAt.frame : -1LL,
            headlessCfg.stopAt.gameOver ? 1 : 0,
            headlessCfg.stopAt.luaCondition ? headlessCfg.stopAt.luaCondition->c_str() : "-");
    }

    // --- Replay export/import (PLAN-replay task 3, the `.msr` packer) ---
    // A pure file-to-file transform: no sim, no content, no port. Handled here
    // so `--replay-export` costs a process start and nothing else, and so a
    // corrupt file is reported by the packer rather than by a half-built world.
    if (!replayExportPath.empty()) {
        if (replayFilePath.empty()) {
            SLOG(SPRING_LOG_ERROR,
                "--replay-export needs --replay <input.msr> to say what to pack");
            return 1;
        }
        std::string perr;
        if (!replay::Pack(replayFilePath, replayExportPath, replayExportCodec, perr)) {
            SLOG(SPRING_LOG_ERROR, "--replay-export: %s", perr.c_str());
            return 1;
        }
        // Re-load the product and report what it actually contains. Reporting
        // the *input's* tallies would hide precisely the bug this export could
        // have: a section dropped on the way through.
        const replay::LoadResult out = replay::Load(replayExportPath);
        auto fileSize = [](const std::string& p) -> long long {
            std::FILE* f = std::fopen(p.c_str(), "rb");
            if (f == nullptr) return -1;
            std::fseek(f, 0, SEEK_END);
            const long long n = std::ftell(f);
            std::fclose(f);
            return n;
        };
        const long long inBytes = fileSize(replayFilePath);
        const long long outBytes = fileSize(replayExportPath);
        SLOG(SPRING_LOG_NOTICE,
            "replay export: %s -> %s (codec=%s, %lld -> %lld bytes, "
            "%zu records, %zu hash points, %zu checkpoints)%s",
            replayFilePath.c_str(), replayExportPath.c_str(),
            replay::CodecName(replayExportCodec), inBytes, outBytes,
            out.records.size(), out.hashTrack.size(), out.checkpoints.size(),
            out.truncated ? " [TRUNCATED SEGMENT — preserved as truncated]" : "");
        if (!out.ok) {
            SLOG(SPRING_LOG_ERROR, "replay export produced an unreadable file: %s",
                 out.error.c_str());
            return 1;
        }
        return 0;
    }

    // --- Replay playback setup (PLAN-replay task 2) ---
    // A replay file carries its own launch spec, so `--replay <file>` alone is
    // a complete invocation: map, game, modoptions, roster and AI slots all
    // come out of the header. Explicit CLI flags still win, so an operator can
    // deliberately re-run a stream against different content — that is a
    // divergence experiment, and the engineHash/defsCacheKey lines logged below
    // are what tell them they ran one.
    if (!replayFilePath.empty()) {
        if (!journalFilePath.empty()) {
            SLOG(SPRING_LOG_ERROR,
                "--replay and --journal-file are mutually exclusive "
                "(a replay must not re-record its own feed)");
            return 1;
        }
        std::string rerr;
        if (!replay::Feed().Load(replayFilePath, rerr)) {
            SLOG(SPRING_LOG_ERROR, "--replay: %s", rerr.c_str());
            return 1;
        }
        const replay::Header& rh = replay::Feed().GetHeader();
        replay::SetCurrentMode(replayVerify ? replay::Mode::Verify
                                            : replay::Mode::Play);

        if (mapId.empty())      mapId = rh.mapId;
        if (gameId.empty())     gameId = rh.gameId;
        if (gameVersion.empty()) gameVersion = rh.gameVersion;
        if (CGameSetup::GetModOptions().empty()) {
            for (const auto& kv : rh.modOptions)
                CGameSetup::SetModOption(kv.first, kv.second);
        }
        if (requestedPlayers.empty()) {
            for (const auto& ps : rh.players) {
                RequestedPlayer rq;
                rq.username = ps.username;
                rq.team     = ps.team;
                rq.startPos = ps.startPos;
                requestedPlayers.push_back(std::move(rq));
            }
        }
        if (requestedAIs.empty()) {
            // The AI SLOTS are re-created (each is a virtual CPlayer and its
            // team's leader — synced state the sim start depends on), but the
            // runtime's OUTPUT is discarded and the recorded AICommand stream
            // applied instead. See StateStreamer::TickAI's replay branch.
            for (const auto& as : rh.aiSlots) {
                RequestedAI rq;
                rq.id       = as.aiId;
                rq.team     = as.team;
                rq.startPos = as.startPos;
                requestedAIs.push_back(std::move(rq));
            }
        }

        // Replay rides the headless substrate (PLAN-replay task 2 is literally
        // "--replay feed mode ON the headless substrate"): no client is needed
        // for the sim to run to the end of the stream, and the stop condition
        // is the recording's own end frame.
        headlessCfg.enabled = true;
        headlessCfg.maxWallSec = static_cast<int64_t>(std::max(1, maxWallMin)) * 60;
        headlessCfg.stopAt.frame = replay::Feed().EndFrame();
        headlessCfg.tickMode = (replay::CurrentMode() == replay::Mode::Verify)
            ? headless::TickMode::Uncapped   // verification is a batch job
            : headless::TickMode::Realtime;  // playback is watched by a human
        if (replaySeekFrame > 0) replay::Feed().SetSeekTarget(replaySeekFrame);

        if (replayVerify) {
            if (!replayVerifyRef.empty()) {
                // Explicit reference file: overrides the embedded track. Two
                // real uses — cross-checking against an independent
                // `--headless-run`, and the negative control that proves the
                // gate is not vacuous.
                std::vector<std::pair<int64_t, uint64_t>> track;
                std::string terr;
                if (!statsdump::ReadHashTrack(replayVerifyRef, track, terr)) {
                    SLOG(SPRING_LOG_ERROR, "--verify: %s", terr.c_str());
                    return 1;
                }
                std::vector<replay::HashPoint> pts;
                pts.reserve(track.size());
                for (const auto& t : track)
                    pts.push_back({static_cast<int32_t>(t.first), t.second});
                SLOG(SPRING_LOG_NOTICE,
                    "--verify: %zu reference hash points from %s (overriding the "
                    "file's own embedded track)", pts.size(), replayVerifyRef.c_str());
                replay::Feed().SetHashTrack(std::move(pts));
            } else if (replay::Feed().HasHashTrack()) {
                SLOG(SPRING_LOG_NOTICE,
                    "--verify: using the recording's own embedded hash track");
            } else {
                // Refused rather than run: a verify with no reference points
                // reaches the end reporting checked=0, and while VerifyResult
                // already calls that a failure, "FAIL, checked=0" three minutes
                // from now is a worse message than this one right now.
                SLOG(SPRING_LOG_ERROR,
                    "--verify: %s carries no embedded hash track (recorded "
                    "before task 3, or with --journal-hash-every 0) and no "
                    "reference file was given — nothing to verify against",
                    replayFilePath.c_str());
                return 1;
            }
        }

        SLOG(SPRING_LOG_NOTICE,
            "replay: %s — %zu records, %zu hash points, %zu checkpoints, "
            "frames %d..%d, map=%s game=%s%s%s",
            replayFilePath.c_str(), replay::Feed().RecordCount(),
            replay::Feed().HashTrackSize(), replay::Feed().Checkpoints().size(),
            rh.startFrame, replay::Feed().EndFrame(),
            rh.mapId.c_str(), rh.gameId.c_str(),
            replay::Feed().Truncated() ? " [TRUNCATED SEGMENT]" : "",
            replaySeekFrame > 0 ? " [seeking]" : "");
        if (replaySeekFrame > 0) {
            SLOG(SPRING_LOG_NOTICE,
                "replay: seeking to frame %d — the checkpoint index is %s, so "
                "this is a full uncapped fast-forward from the start with "
                "streaming suppressed (T2-d)",
                replaySeekFrame,
                replay::Feed().Checkpoints().empty()
                    ? "empty (PLAN-persistence sim serializer unlanded, so no "
                      "recorder writes checkpoint blobs)"
                    : "populated but restore is not implemented");
        }
    } else if (!journalFilePath.empty()) {
        SLOG(SPRING_LOG_NOTICE, "recording synced-input cause stream to %s",
             journalFilePath.c_str());
    }

    // PLAN-security-hardening E1 (warn-only — see DevBuildGate::WarnOnly).
    DevBuildGate::WarnOnly("spring-server");

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
    if (wtCertPath.empty() != wtKeyPath.empty()) {
        SLOG(SPRING_LOG_ERROR, "--wt-cert and --wt-key must be given together (got only %s)",
             wtCertPath.empty() ? "--wt-key" : "--wt-cert");
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
    // Tag every record from this process with its room + game so the
    // shared debug.db can be filtered to a single room/game instance.
    springlog_set_context(roomId, gameId.c_str());

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
        // FULLMUTEX — shared with the network thread (D33).
        if (sqlite3_open_v2(dbPath.c_str(), &mapDb, kSqliteSharedOpenFlags,
                            nullptr) == SQLITE_OK) {
            SqliteConfigureSharedHandle(mapDb);
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

    // WebTransport (QUIC/HTTP-3) game transport + the simulation are declared
    // up here (their ctors are inert — Start()/Init() below do the real work)
    // so the GameServerContext can bind references to them before the
    // extracted HTTP routes / message handler / state streamer are built.
    // `rtcServer` keeps its (now-historical) name so the ~80
    // SendReliable/Broadcast call sites carried over unchanged from the
    // removed WebRTC server (GW7).
    WebTransportServer rtcServer;
    CSimulation sim;

    // --- Content server (Init happens inside RegisterGameHttpRoutes) ---
    ContentServer content;
    std::vector<std::string> contentRoots;
    if (!gamePath.empty()) contentRoots.push_back(gamePath);
    if (!mapPath.empty()) contentRoots.push_back(mapPath);

    // Player/session bookkeeping that the GameServerContext binds by reference.
    // Declared up here (ahead of the sim init / def-cache bake that compute
    // their contents) so the extracted units can share them; populated below.

    // Build a `username -> team` map from the --player args so the auth handler
    // can stamp the session's team on login.
    std::unordered_map<std::string, int> playerTeamByUsername;
    for (const auto& rp : requestedPlayers) {
        playerTeamByUsername[rp.username] = rp.team;
    }

    // Map WebTransport clientId -> Spring playerNum so we can fire
    // eventHandler.PlayerRemoved() with the correct id on disconnect.
    std::unordered_map<ClientID, int> clientPlayerNum;
    int nextPlayerNum = 0;

    // D16: account id -> sim playerNum, allocated once per account and reused
    // for every subsequent connection of that account. See GameServerContext.h.
    // Note for PLAN-replay T2-a-3: replay spectators draw from a reserved range
    // (`kSpectatorPlayerNumBase = 200`) and must NOT be seeded into this map —
    // it only ever holds numbers minted from `nextPlayerNum`.
    std::unordered_map<int64_t, int> playerNumByAccount;

    // PLAN-quickstart.md §3.3: reason carried by a client's PlayerLeaveIntent
    // (sent just before disconnect), consumed once when the disconnect drains.
    std::unordered_map<ClientID, uint8_t> pendingLeaveReason;

    // GameStart is deferred until all roster players have connected and
    // registered CPlayers (matches real Spring's "all clients loaded" gate).
    std::unordered_set<std::string> connectedRosterPlayers;
    const size_t rosterPlayersNeeded = requestedPlayers.size();

    // C1: per-client handshake gate. A client must send a protocol-compatible
    // Handshake before its AuthRequest is honoured.
    std::unordered_set<ClientID> handshakedClients;

    // GameServerContext wires the long-lived objects to the extracted units.
    // Bound here, after all of net/rtcServer/sim/db/sessions/rooms/aiPool/
    // luaExecEngine are declared; defsCacheKey is assigned after the def-cache
    // bake below.
    GameServerContext ctx{
        net, rtcServer, sim, db, sessions, rooms, aiPool, luaExecEngine,
        roomId, gameId, mapId, port, logMessages, /*defsCacheKey=*/std::string{},
        requestedPlayers, requestedAIs, playerTeamByUsername,
        clientPlayerNum, pendingLeaveReason, nextPlayerNum, playerNumByAccount,
        connectedRosterPlayers,
        rosterPlayersNeeded, handshakedClients,
    };

    GameStartCoordinator gameStart(ctx);
    ClientMessageHandler msgHandler(ctx, gameStart);
    StateStreamer streamer(ctx);

    // Register all HTTP GET/POST routes (heightmap, map info, maps list/thumb,
    // metrics, content server, auth + exec, restart, WebTransport discovery).
    RegisterGameHttpRoutes(ctx, content, contentRoots, mapsDir,
                           restartRequested, keepRunning);

    // PLAN-gm-tools task 2: the GM verb set (POST /api/gm/*). rollback/
    // checkpoint ride a snapshot store. Must outlive the server loop.
    //
    // PLAN-persistence task 1: this is now the real GameStateStore (framing,
    // integrity, atomic SQLite commits, retention, the E1/E2 ladders) rather
    // than NullSnapshotStore. It still reports Available()==false until a
    // sim serializer is attached — creg is stubbed out in this tree, so
    // nothing can walk the sim yet (PLAN-persistence Q-P1). The difference
    // from the old null store is that the refusal now names the missing piece
    // and everything around the walk is built, tested and ready to carry it.
    //
    // engineHash: FNV-1a of the build stamp, so a rebuilt binary refuses
    // snapshots taken by the previous one (E1). mapHash: the processed map id.
    // §2 also wants a defsHash for PLAN-def-reconciliation; it is deliberately
    // absent here because defsCacheKey is not computed until later in boot —
    // see PLAN-persistence.md §2.1.
    gamestate::StoreConfig snapCfg;
    snapCfg.gameId  = gameId;
    snapCfg.mapHash = mapId;
    {
        const char* stamp = SPRING_BUILD_STAMP;
        uint64_t h = 1469598103934665603ull;
        for (const char* p = stamp; *p; ++p) {
            h ^= uint64_t(uint8_t(*p));
            h *= 1099511628211ull;
        }
        snapCfg.engineHash = h;
    }
    gamestate::GameStateStore gmSnapshotStore(db.Handle(), snapCfg);
    RegisterGmVerbs(ctx, gmSnapshotStore);

    // PLAN-replay task 1: attach the in-memory cause-stream journal under
    // --journal-audit. Must outlive the server loop (the funnel holds a raw
    // pointer, deliberately — a shared_ptr here would imply an ownership
    // question that does not exist: there is exactly one journal per process
    // and it is this one).
    syncedinput::MemoryJournal auditJournal(
        journalAuditRecords > 0 ? static_cast<size_t>(journalAuditRecords) : 1);
    // The durable recorder (--journal-file). Declared here so it outlives the
    // server loop like the audit ring does; opened further down, once the defs
    // cache key exists, because the key is part of the replay header's identity
    // check. Only one journal can be attached at a time — --journal-file wins,
    // since a run asked to produce a shareable artefact must not have its
    // records land in a diagnostic ring instead.
    replay::Writer replayWriter;
    if (journalAuditRecords > 0) {
        syncedinput::Journal().SetJournal(&auditJournal);
        SLOG(SPRING_LOG_NOTICE,
             "synced-input journal: audit mode, cap %d records (GET /api/journal)",
             journalAuditRecords);
    }
    // Always registered — with no journal attached it reports the counters
    // only, which is the useful answer to "is anything bypassing the funnel".
    // GET + LocalhostOrAdmin degrades to loopback-only (NetworkServer.h's
    // enforcement note); that is the right ceiling for a diagnostic that
    // exposes raw player input.
    net.AddHttpGet("/api/journal", RouteAuth::LocalhostOrAdmin,
                   [&auditJournal](const std::string&) -> HttpResponse {
        const auto& rec = syncedinput::Journal();
        const auto& c = rec.Stats();
        nlohmann::json j;
        j["enabled"]  = rec.Enabled();
        j["frame"]    = rec.Frame();
        j["seen"]     = c.seen;
        j["recorded"] = c.recorded;
        j["appended"] = c.appended;
        j["skipped"]  = c.skipped;
        // Bound by the counter array, not a literal: a kind added without
        // widening this loop reads as "never happened" on the one route an
        // operator uses to check the cause stream is complete.
        for (size_t k = 0; k < std::size(c.byKind); ++k) {
            j["byKind"][syncedinput::InputKindName(
                static_cast<syncedinput::InputKind>(k))] = c.byKind[k];
        }
        if (rec.Enabled()) {
            j["ringDropped"] = auditJournal.Dropped();
            // Head/tail only: the whole ring can be 100 k records and this is
            // a diagnostic, not the export path (that is PLAN-replay task 3's
            // .msr packer, which reads Records() directly).
            const auto& rs = auditJournal.Records();
            j["ringSize"] = rs.size();
            auto row = [](const syncedinput::Record& r) {
                nlohmann::json o;
                o["seq"]      = r.seq;
                o["frame"]    = r.frame;
                o["phase"]    = syncedinput::TickPhaseName(r.phase);
                o["kind"]     = syncedinput::InputKindName(r.kind);
                o["subKind"]  = r.subKind;
                o["playerId"] = r.playerId;
                o["bytes"]    = r.payload.size();
                return o;
            };
            const size_t n = rs.size();
            const size_t head = std::min<size_t>(n, 20);
            for (size_t i = 0; i < head; ++i) j["head"].push_back(row(rs[i]));
            for (size_t i = (n > 20 ? n - 20 : head); i < n; ++i)
                j["tail"].push_back(row(rs[i]));
        }
        const std::string body = j.dump();
        HttpResponse resp;
        resp.contentType = "application/json";
        resp.body.assign(body.begin(), body.end());
        return resp;
    });

    if (!net.Start(port)) {
        SLOG(SPRING_LOG_ERROR, "failed to start network server");
        springlog_shutdown();
        return 1;
    }

    // QUIC is a hard dependency (no WebRTC fallback) — fail fast if it can't bind.
    if (!rtcServer.Start(port, wtCertPath, wtKeyPath)) {
        SLOG(SPRING_LOG_ERROR, "failed to start WebTransport (QUIC) server on udp/:%d", port);
        springlog_shutdown();
        return 1;
    }
    SLOG(SPRING_LOG_NOTICE, "WebTransport (QUIC) listening on udp/:%d (mode=%s)", port,
         rtcServer.CertMode() == WtCertMode::Webpki ? "webpki" : "hashes");

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

    if (!mapMeta.id.empty())
        sim.SetMapMetadata(mapMeta);

    sim.Init(smfPath);

    // Standing-order broadcast hook. Fires whenever an order is
    // created / updated / removed / its assigned-count changes. Pushes
    // a StandingOrderState snapshot to every session whose viewer team
    // is allied with the team that owns the changed order. The hook
    // delegates to GameStartCoordinator::PushStandingOrdersTo so it sees
    // the live values at notification time — safe because notifications
    // fire from the sim-tick path on the main thread.
    standingOrders.SetChangeNotifier([&gameStart, &sessions](int changedTeam) {
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            if (session.team < 0) return;
            // Skip sessions that can't see this team's orders.
            if (changedTeam != session.team &&
                !teamHandler.AlliedTeams(session.team, changedTeam)) return;
            gameStart.PushStandingOrdersTo(clientId, session.team);
        });
    });

    // Macro C&C broadcast hooks (PLAN-macro-directives §1). Same visibility
    // discipline as standing orders — org-group + directive state stream on
    // change to the owner team and its allies. Both fire from the sim-tick
    // path on the main thread, so reading live values is safe.
    orgGroups.SetChangeNotifier([&gameStart, &sessions](int changedTeam) {
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            if (session.team < 0) return;
            if (changedTeam != session.team &&
                !teamHandler.AlliedTeams(session.team, changedTeam)) return;
            gameStart.PushOrgGroupsTo(clientId, session.team);
        });
    });
    directiveManager.SetChangeNotifier([&gameStart, &sessions](int changedTeam) {
        sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
            if (session.team < 0) return;
            if (changedTeam != session.team &&
                !teamHandler.AlliedTeams(session.team, changedTeam)) return;
            gameStart.PushDirectivesTo(clientId, session.team);
        });
    });

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
    std::string& defsCacheKey = ctx.defsCacheKey;
    if (unitDefHandler && weaponDefHandler && !gameId.empty()) {
        // Serialize the full def set to Lua source FIRST, then derive the
        // cache key from the emitted payload (DefsCache::ComputeContentKey).
        // Serialization is cheap (once per game-server process) and this is
        // what makes the key content-aware: the old ComputeCacheKey hashed
        // only gameId/version/modOptions, so any def edit left the key —
        // and thus the URL the client fetches — frozen at its first bake.
        // The client then received stale def_ids that disagreed with the
        // live server def_ids and every native model rendered as a fallback
        // shape. See DefsCache.h.
        namespace fs = std::filesystem;

        // Probe the game's gamedata/resources.lua for the set of
        // projectile-texture names. The weapon-def baker uses this to
        // choose between the primary and fallback name when applying
        // Spring's per-weaponType defaults (e.g. `missileflaretexture` is
        // preferred when defined, otherwise `flare`). With an empty set the
        // baker still writes the primary; the client's resolver chases any
        // remaining alias.
        const std::string gameDir = "data/games/" + gameId;
        const std::string engineBaseDir = "cont/base/springcontent";
        const auto projTextureNames =
            ResourcesParser::GetProjectileTextureNames(
                gameId, gameDir, engineBaseDir);

        // Serialize each def category to Lua source. Output files end in
        // `.lua.br` and are served with `Content-Encoding: br` so the
        // browser decompresses transparently. See PLAN-defs.md.
        namespace L = LuaDefsSerializer;
        std::string udSrc = L::SerializeUnitDefs(
            unitDefHandler->GetUnitDefsVec(), gameId);
        std::string wdSrc = L::SerializeWeaponDefs(
            weaponDefHandler->GetWeaponDefsVec(), gameId,
            &projTextureNames);
        auto cegDefs = CegLoader::LoadAllCegDefs();
        std::string cdSrc = L::SerializeCegDefs(cegDefs);

        std::string fdSrc;
        size_t fdDefCount = 0;
        if (featureDefHandler != nullptr) {
            const fs::path modelsDir = fs::path("data/games") / gameId / "models";
            const auto& fdVec = featureDefHandler->GetFeatureDefsVec();
            fdSrc = L::SerializeFeatureDefs(fdVec, gameId, modelsDir);
            fdDefCount = fdVec.empty() ? 0 : fdVec.size() - 1;
        } else {
            fdSrc = "return{base_url=[[]],defs={}}";
        }

        defsCacheKey = DefsCache::ComputeContentKey(
            gameId, gameVersion, CGameSetup::GetModOptions(),
            udSrc, wdSrc, cdSrc, fdSrc);

        // Skip re-baking (brotli + disk write) if the cache files already
        // exist for this key. With a content-derived key the warm path is
        // reached only when the emitted defs are byte-identical to a prior
        // bake, so it can never serve stale def_ids. Under --no-cache we
        // still force the cold path AND overwrite below.
        const fs::path dir = DefsCache::CacheDir(gameId, defsCacheKey);
        const bool warm = !CacheControl::IsNoCache()
                       && fs::exists(dir / "unitdefs.lua.br")
                       && fs::exists(dir / "weapondefs.lua.br")
                       && fs::exists(dir / "cegdefs.lua.br")
                       && fs::exists(dir / "featuredefs.lua.br");

        if (warm) {
            SLOG(SPRING_LOG_NOTICE, "defs cache warm: gameId=%s key=%s",
                 gameId.c_str(), defsCacheKey.c_str());
        } else {
            auto udBytes = L::CompressBrotli(udSrc);
            auto wdBytes = L::CompressBrotli(wdSrc);
            auto cdBytes = L::CompressBrotli(cdSrc);
            auto fdBytes = L::CompressBrotli(fdSrc);

            if (DefsCache::WriteIfMissing(gameId, defsCacheKey,
                                          udBytes, wdBytes, cdBytes,
                                          fdBytes,
                                          /*overwrite=*/CacheControl::IsNoCache())) {
                SLOG(SPRING_LOG_NOTICE,
                     "defs cache baked: gameId=%s key=%s "
                     "(unitdefs=%zu B src/%zu B brotli, "
                     "weapondefs=%zu B src/%zu B brotli, "
                     "cegdefs=%zu B src/%zu B brotli/%zu defs, "
                     "featuredefs=%zu B src/%zu B brotli/%zu defs)",
                     gameId.c_str(), defsCacheKey.c_str(),
                     udSrc.size(), udBytes.size(),
                     wdSrc.size(), wdBytes.size(),
                     cdSrc.size(), cdBytes.size(), cegDefs.size(),
                     fdSrc.size(), fdBytes.size(), fdDefCount);
            } else {
                SLOG(SPRING_LOG_ERROR,
                     "defs cache write failed: gameId=%s key=%s",
                     gameId.c_str(), defsCacheKey.c_str());
                defsCacheKey.clear();
            }
        }

        // Expected-DPS power table (AI4 / combat-resolution §2.3, ask C7).
        // A compact power.json written into the same content-addressed cache
        // dir, alongside the .lua.br def files. It is plain JSON (served with
        // Content-Type: application/json by the static handler), so BOTH the
        // strategic AI (via the sandboxed AI.getDefExport file API) and the
        // browser client (a future fetch at the same cache/defs URL) read the
        // identical numbers — no AI-only power math. Derived from the same
        // parsed defs as weapondefs.lua's expected_dps. Written whenever
        // absent (or under --no-cache); the content key already covers the
        // inputs, so a stale power.json is impossible for a live key.
        if (!defsCacheKey.empty()) {
            const fs::path powerPath =
                fs::path(DefsCache::CacheDir(gameId, defsCacheKey)) / "power.json";
            if (CacheControl::IsNoCache() || !fs::exists(powerPath)) {
                const std::string powerSrc =
                    L::SerializePowerTable(unitDefHandler->GetUnitDefsVec());
                std::error_code pec;
                fs::create_directories(powerPath.parent_path(), pec);
                std::ofstream pf(powerPath, std::ios::binary | std::ios::trunc);
                if (pf) {
                    pf.write(powerSrc.data(),
                             static_cast<std::streamsize>(powerSrc.size()));
                }
                if (pf) {
                    SLOG(SPRING_LOG_NOTICE,
                         "power table baked: gameId=%s key=%s (%zu B JSON)",
                         gameId.c_str(), defsCacheKey.c_str(), powerSrc.size());
                } else {
                    SLOG(SPRING_LOG_WARNING,
                         "power table write failed: gameId=%s key=%s",
                         gameId.c_str(), defsCacheKey.c_str());
                }
            }
        }
    }

    // (playerTeamByUsername / clientPlayerNum / nextPlayerNum /
    // connectedRosterPlayers / rosterPlayersNeeded were declared above, ahead
    // of the GameServerContext that binds them; deferred-GameStart logic now
    // lives in GameStartCoordinator::CheckAndFireGameStart.)

    // --- Open the replay recorder (PLAN-replay task 2) ---
    // Here and not earlier: the header carries defsCacheKey, which the defs
    // bake above computes, and a replay whose header cannot say which defs it
    // ran against cannot detect the content mismatch that would otherwise
    // surface as an unexplained divergence. Here and not later: GameStart —
    // chokepoint #5, the record the whole stream is anchored on — fires a few
    // lines below, and a recorder opened after it would produce a headless
    // replay file with no anchor at all.
    if (!journalFilePath.empty()) {
        replay::Header rhdr;
        // FIDELITY-STANDIN: PLAN-replay §1 binds a replay to the exact engine
        // build ("same-binary bound"), but this tree has no build-identity
        // macro (no git hash, no version string) for it to record. The stand-in
        // is the wire protocol version plus this translation unit's compile
        // stamp: it catches a protocol break and a from-scratch rebuild, and
        // MISSES a change to any other file in an incremental build. So a
        // header match is weak evidence of same-binary; a mismatch is still
        // conclusive evidence of not-same-binary, which is the direction that
        // prevents a wrong replay from being trusted.
        rhdr.engineHash   = "proto" + std::to_string(Protocol::CURRENT_PROTOCOL_VERSION) +
                            "-" + std::string(__DATE__ " " __TIME__);
        rhdr.gameId       = gameId;
        rhdr.gameVersion  = gameVersion;
        rhdr.mapId        = mapId;
        rhdr.defsCacheKey = defsCacheKey;
        rhdr.roomId       = roomId;
        rhdr.startFrame   = sim.GetFrameNum();
        // §1 has carried a `recordedAt` since task 2 and nothing ever wrote
        // one — a dead producer that only showed up when task 4c's listing
        // went looking for the date column. Wall clock is safe here precisely
        // because it is informational: the replay path never feeds it back
        // into the sim, so it cannot fork a re-execution the way any other
        // clock read would.
        {
            const std::time_t now = std::time(nullptr);
            std::tm utc{};
            gmtime_r(&now, &utc);
            char stamp[32] = {0};
            std::strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%SZ", &utc);
            rhdr.recordedAt = stamp;
        }
        for (const auto& kv : CGameSetup::GetModOptions())
            rhdr.modOptions.emplace_back(kv.first, kv.second);
        for (const auto& rp : requestedPlayers)
            rhdr.players.push_back({rp.username, rp.team, rp.startPos});
        for (const auto& ra : requestedAIs)
            rhdr.aiSlots.push_back({ra.id, ra.team, ra.startPos});

        std::string werr;
        if (!replayWriter.Open(journalFilePath, rhdr, werr)) {
            // Fatal on purpose. A run told to produce a replay that silently
            // produces nothing is worse than one that refuses to start: the
            // first is discovered days later, when the recording was the point.
            SLOG(SPRING_LOG_ERROR, "--journal-file: %s", werr.c_str());
            return 1;
        }
        syncedinput::Journal().SetJournal(&replayWriter);
        SLOG(SPRING_LOG_NOTICE,
             "replay recording open: %s (defs=%s, state-hash every %d frames%s)",
             journalFilePath.c_str(), defsCacheKey.c_str(), journalHashEvery,
             journalHashEvery > 0 ? "" : " — DISABLED, this file will not be verifiable");
        SLOG(SPRING_LOG_WARNING,
            "replay: engineHash is a stand-in (protocol version + TU compile "
            "stamp) — this tree exposes no build identity, so a header match "
            "does NOT prove the replaying binary is the recording one");
    }

    // ── Replay feed: the inverse of the five recording chokepoints ──
    //
    // PLAN-replay §7.1 enumerated exactly five sites at which external input
    // enters the server. Re-execution has to re-enter at the SAME five, in the
    // same tick positions, or the cause stream is being replayed against a
    // different tick shape than it was recorded on. Four of them are fed here
    // (Inbound, Disconnect, LuaExec, plus the GameStart anchor and the restore
    // discontinuity); the fifth — the AI drain — is fed inside
    // StateStreamer::TickAI, because its position relative to standing-order
    // evaluation inside the streamer tick is load-bearing.
    //
    // Everything a record cannot honestly reproduce stops the replay instead of
    // being skipped. A short replay that says why is a usable artefact; a
    // complete-looking replay that quietly dropped an input is the failure this
    // whole subsystem exists to make impossible.
    auto PeekClientPayloadType = [](const InboundMessage& m) -> uint8_t {
        flatbuffers::Verifier v(m.data.data(), m.data.size());
        if (!SpringWeb::VerifyClientMessageBuffer(v)) return 0;
        const auto* cm = SpringWeb::GetClientMessage(m.data.data());
        return cm == nullptr ? 0 : static_cast<uint8_t>(cm->payload_type());
    };

    auto FeedReplayRecord = [&](const syncedinput::Record& r) {
        switch (r.kind) {
            case syncedinput::InputKind::ClientMessage: {
                // The recorded RAW wire bytes go back through the identical
                // HandleMessage, under the recorded connection id remapped into
                // the virtual range. Everything the live run did to this
                // message — verify, rate-limit, sequence-check, authority gate,
                // and rejection — happens again, identically, because it is the
                // same code seeing the same bytes from the same client.
                InboundMessage im;
                im.clientId = static_cast<ClientID>(replay::VirtualClientId(r.clientId));
                im.data = r.payload;
                msgHandler.HandleMessage(im);
                break;
            }
            case syncedinput::InputKind::PlayerDisconnect: {
                // Only the synced half is replayed. The PlayerLeft broadcast is
                // a consequence for the OTHER clients, and on a replay server
                // the streamer's own state broadcasts already tell a spectator
                // what changed.
                if (r.playerId >= 0) {
                    playerHandler.PlayerLeft(r.playerId, r.subKind);
                    eventHandler.PlayerRemoved(r.playerId, r.subKind);
                    playerTeamEvents.Push({PlayerTeamEventData::PlayerRemoved, r.subKind,
                                           static_cast<uint32_t>(r.playerId)});
                }
                break;
            }
            case syncedinput::InputKind::LuaExec: {
                // Payload is "<scope>\0<code>" (Recorder::RecordLuaExec).
                const auto nul = std::find(r.payload.begin(), r.payload.end(), '\0');
                if (nul == r.payload.end()) {
                    replay::Feed().RequestStop("malformed LuaExec record (no scope separator)");
                    break;
                }
                LuaExecRequest req;
                req.requestId = 0;
                req.clientId  = 0;
                req.scope.assign(r.payload.begin(), nul);
                req.code.assign(nul + 1, r.payload.end());
                ExecuteLuaExecRequest(req);   // result goes nowhere: nobody asked
                break;
            }
            case syncedinput::InputKind::GameStart: {
                if (!sim.HasGameStarted()) {
                    SLOG(SPRING_LOG_NOTICE,
                        "replay: GameStart record reached — firing GameStart");
                    sim.FireGameStart();
                }
                // The record's payload is the roster the live run started with.
                // Rebuilding it here and comparing is the earliest possible
                // divergence check: a mismatch means the replay's teams, ally
                // teams or leaders differ from the recording's, and EVERY later
                // command is being applied to the wrong world. Caught at frame
                // 0 instead of as an inexplicable hash mismatch minutes later.
                std::string roster;
                for (int t = 0; t < teamHandler.ActiveTeams(); ++t) {
                    const CTeam* team = teamHandler.Team(t);
                    if (team == nullptr) continue;
                    roster += "t" + std::to_string(t) +
                              ":a" + std::to_string(team->teamAllyteam) +
                              ":l" + std::to_string(team->GetLeader()) + ";";
                }
                const std::string recorded(r.payload.begin(), r.payload.end());
                if (roster != recorded) {
                    SLOG(SPRING_LOG_ERROR,
                        "replay: roster divergence at GameStart — recorded '%s', replay '%s'",
                        recorded.c_str(), roster.c_str());
                    replay::Feed().RequestStop("roster divergence at GameStart");
                }
                break;
            }
            case syncedinput::InputKind::SnapshotRestore: {
                // §6 E2. Honouring this needs PLAN-persistence's sim serializer
                // to restore a checkpoint mid-stream; it does not exist yet
                // (Q-P1 decided the approach 2026-08-03, the walk is unbuilt).
                // Until it does, a rollback ends the segment — which is what §6
                // E2 says a rollback does anyway ("rollback starts a NEW
                // segment"). Replaying the next segment is a separate run.
                int32_t from = 0, to = 0;
                if (r.payload.size() >= sizeof(int32_t) * 2) {
                    std::memcpy(&from, r.payload.data(), sizeof(int32_t));
                    std::memcpy(&to, r.payload.data() + sizeof(int32_t), sizeof(int32_t));
                }
                SLOG(SPRING_LOG_NOTICE,
                    "replay: snapshot-restore record (frame %d -> %d) ends this segment",
                    from, to);
                replay::Feed().RequestStop("snapshot restore — segment boundary (E2)");
                break;
            }
            case syncedinput::InputKind::AICommand: {
                // Fed by StateStreamer::TickAI, never here — reaching this case
                // means an AI record was stamped outside the Stream phase.
                replay::Feed().RequestStop("AICommand record outside the Stream phase");
                break;
            }
            case syncedinput::InputKind::AuthIdentity: {
                // Deliberate no-op (PLAN-replay T2-a). This record is the DB's
                // ANSWER to an AuthRequest, not an input — and it necessarily
                // sits AFTER the message it describes, so consuming it in
                // stream order would arrive too late to be of any use. It is
                // indexed at Player::Load() instead, and ClientMessageHandler
                // reads it while re-entering the AuthRequest. It stays in the
                // stream so the container, the packer and the audit route need
                // no special case.
                break;
            }
        }
    };

    // --- AI virtual players (PLAN-metalstorm-ai.md §1, AI3) ---
    //
    // Each AI slot becomes a real CPlayer with its own playerID, registered
    // NOW — before GameStart fires — so:
    //   (a) FireGameStart's leader pass makes the AI its OWN team's leader (its
    //       virtual player is the only active player on that team), instead of
    //       the old SetLeader(hostHuman) fallback; and
    //   (b) game_authority.lua's GameStart loop over Spring.GetPlayerList()
    //       runs its PlayerAdded flow for the AI, creating authority_player_<id>
    //       — the exact same pool-creation path a human takes. The AI's charge
    //       identity (its authority pool) is thus keyed by this playerID.
    // Registering here (ahead of both the dev-mode and roster-mode GameStart)
    // keeps the AI in GetPlayerList() at GameStart time in either mode.
    //
    // Deliberate departure from stock Spring, where a SkirmishAI is NOT a
    // player (CLAUDE.md "never deviate silently"): Metalstorm's design makes
    // the AI a virtual player (§1) so it pays authority through the same gate.
    // isAI marks it so "lowest active player = host human" logic skips it
    // (Simulation.cpp FireGameStart). The AI runtime setup below reads back
    // rq.playerNum so strategos keys its spend by the same id.
    for (auto& rq : requestedAIs) {
        const int pNum = nextPlayerNum++;
        CPlayer p;
        p.name      = "AI:" + rq.id + "@t" + std::to_string(rq.team);
        p.team      = rq.team;
        p.active    = true;
        p.spectator = false;
        p.isAI      = true;
        p.playerNum = pNum;
        playerHandler.AddPlayer(p);
        rq.playerNum = pNum;
        SLOG(SPRING_LOG_NOTICE,
            "registered AI virtual player #%d '%s' on team %d",
            pNum, p.name.c_str(), rq.team);

        // PLAN-metalstorm-ai.md §10 task 6: hand a lobby/manifest-chosen
        // personality/difficulty profile to the AI VM through the SAME
        // modoption transport `--modoption` already uses — no new engine
        // surface. A synced gadget (game_teams.lua) reads this back at
        // GameStart and republishes it as the team rulesParam
        // `ai_profile_<playerID>` that ai/strategos/picture.lua already
        // reads (Picture.readProfileHint). Untrusted text end to end;
        // main.lua's resolveProfile() is the sole validator (Config.PROFILES
        // allow-list) — this is just a transport, not a trust boundary.
        if (!rq.profile.empty()) {
            CGameSetup::SetModOption(
                "ai_profile_player" + std::to_string(pNum), rq.profile);
        }
    }

    // Dev-mode: no roster means no players to wait for.
    //
    // A replay never takes this path, in EITHER roster shape. GameStart is an
    // input in its own right (journal chokepoint #5) and its position in the
    // stream is what every later record is relative to: fire it early and the
    // pre-game prologue lands on a started sim, fire it late and the opening
    // frames run without a roster. So under --replay the GameStart RECORD is
    // the only thing that starts the game — see the feed below.
    //
    // WHERE the prologue is fed depends on the roster shape, and the condition
    // below is deliberately the SAME `rosterPlayersNeeded == 0` test the live
    // run branched on (PLAN-replay T2-a). A recording with no human roster
    // fired GameStart right here during set-up, so its prologue belongs here.
    // A recording WITH a roster did not: it fired GameStart from
    // CheckAndFireGameStart in the loop, once the last human authenticated —
    // which is after the AI slot resolution just above. Sweeping such a
    // prologue here would authenticate the humans *before* the AI virtual
    // players exist, so GameStart's leader pass would run over a different
    // player set and every team leader could land on a different player than
    // the recording had. That is caught by the GameStart record's own roster
    // check, but the fix is to feed at the right place, not to detect it.
    if (replay::IsReplaying() && rosterPlayersNeeded == 0) {
        // Feed the pre-game prologue HERE, at the exact point in start-up where
        // the recording fired its own GameStart — not on the first loop tick.
        //
        // The distinction is a real off-by-one, not pedantry. The sim frame
        // counter starts at -1 and the first SimFrame() makes it 0, so a
        // recording that started the game during set-up entered its loop with
        // GameStart already fired and its first tick stamped -1. A replay that
        // waited for its first tick to fire GameStart would stamp that same
        // tick -1 too — but would have spent it starting the game, so every
        // subsequent input would land one frame later than it was recorded at.
        // Feeding the prologue at the same point in start-up keeps the two
        // loops in lockstep from their first tick.
        //
        // Only the INBOUND phase is swept here, and the boundary is exact
        // rather than conservative. Set-up runs before the loop, so it sits
        // ahead of the tick's first phase; the pre-SimFrame phases (inbound,
        // disconnect) are equivalent whether they run here or on the first
        // tick, because nothing simulates in between. The phases AFTER
        // SimFrame — exec and the AI drain — are not: in the recording they
        // ran with the sim already advanced to frame 0, so sweeping them here
        // would apply them to a world one frame younger than the one they were
        // recorded against. That is a real divergence, and it is the second
        // one this milestone's verify run caught.
        syncedinput::Journal().BeginTick(sim.GetFrameNum());
        for (const syncedinput::Record* r :
                 replay::Feed().Due(sim.GetFrameNum(), syncedinput::TickPhase::Inbound)) {
            FeedReplayRecord(*r);
        }
        if (!sim.HasGameStarted()) {
            SLOG(SPRING_LOG_WARNING,
                "replay: the recorded prologue contained no GameStart anchor — "
                "the sim will not start until one arrives in the stream");
        }
    } else if (rosterPlayersNeeded == 0) {
        SLOG(SPRING_LOG_NOTICE, "no player roster (dev mode), firing GameStart immediately");
        // The journal's tick window has never been opened at this point (the
        // sim loop below is what calls BeginTick), so without this the
        // GameStart record — the anchor the entire stream is positioned
        // against — would be stamped with the Recorder's default frame 0 while
        // every other pre-game record carries the true pre-game frame of -1.
        // A replay would then look for the anchor at a frame it never visits.
        syncedinput::Journal().BeginTick(sim.GetFrameNum());
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
            // Pass the plugin folder so the AI VM's plugin-scoped `require`
            // (AI0-loader) can resolve sibling modules (a multi-file AI like
            // strategos wires config/picture/slate/planner/... via require).
            //
            // Also pass the two AI4 file-read sandbox roots: the processed
            // map data dir (mapPath = data/maps/<id>, holds regions.json) and
            // the game def cache dir (holds power.json). Empty when unset —
            // the accessor then returns nil and the Picture treats it as
            // "unknown", never an error.
            //
            // rq.playerNum was allocated by the AI virtual-player block above
            // (AI3): strategos keys its authority charge identity by this id.
            const std::string aiDefExportDir = defsCacheKey.empty()
                ? std::string()
                : DefsCache::CacheDir(gameId, defsCacheKey);
            if (aiPool.AddAI(match->id, rq.team, allyTeam, code, match->folderPath,
                             mapPath, aiDefExportDir, rq.playerNum)) {
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

    // --- Variable-speed loop, GAME_SPEED Hz × wantedSpeedFactor ---
    //
    // The tick interval is recomputed every iteration from
    // `gs->wantedSpeedFactor` so the `speed N` exec verb (which
    // mutates that field) takes effect on the next tick. Default 1.0×
    // gives the canonical 30 Hz cadence; values >1 shrink the sleep
    // for faster sims, values <1 lengthen it. Matches upstream
    // Spring/RecoilEngine — see rts/Game/Game.cpp `wantedSpeedFactor`
    // usage in the reference checkout.
    auto computeTickInterval = []() {
        // Clamp so a misbehaving caller can't divide by zero or push
        // us into a busy-spin. 0.05× ≈ 1.5s/tick (matches the verb's
        // own clamp); 100× ≈ 333µs/tick.
        const float spd = std::clamp(gs->wantedSpeedFactor, 0.05f, 100.0f);
        return std::chrono::microseconds(
            static_cast<int64_t>(1'000'000.0 / (GAME_SPEED * spd)));
    };
    auto tickInterval = computeTickInterval();
    auto nextTick = std::chrono::steady_clock::now();

    if (sim.IsWaitingForPlayers()) {
        SLOG(SPRING_LOG_NOTICE, "waiting for %zu player(s) to connect before starting game...",
            rosterPlayersNeeded);
    }
    SLOG(SPRING_LOG_NOTICE, "entering sim loop at %d Hz (port %d)", GAME_SPEED, port);

    // --- Lifetime: idle self-termination + readiness reporting ---
    //
    // The game server has no backchannel to the lobby (no HTTP client) — it can
    // only reach the lobby through the shared SQLite db. Two jobs:
    //  1. Read whether this room is persistent (persistent rooms never idle-out).
    //  2. Publish liveness to a `game_status` table that ONLY this process writes
    //     (the lobby only reads it). The lobby uses `ready` to flip the room
    //     Loading→Active and `updated_at`/`client_count` for liveness; launch_game
    //     polls it so automation gets a server that's actually accepting.
    //
    // Idle policy (non-persistent only): exit once there have been zero connected
    // clients for kIdleExitSec, with a kStartupGraceSec window after launch so a
    // freshly-spawned server waits for its first client. This is what makes a
    // game stop on its own once everyone has left, instead of orphaning a process.
    bool roomPersistent = false;
    sqlite3* statusDb = nullptr;
    // FULLMUTEX — shared with the network thread (D33).
    if (sqlite3_open_v2(dbPath.c_str(), &statusDb, kSqliteSharedOpenFlags,
                        nullptr) == SQLITE_OK) {
        // Busy timeout comes from SqliteConfigureSharedHandle — one policy
        // for every handle on the shared DB (was an ad-hoc 3000 here).
        SqliteConfigureSharedHandle(statusDb);
        sqlite3_stmt* ps = nullptr;
        if (sqlite3_prepare_v2(statusDb, "SELECT persistent FROM rooms WHERE id=?",
                -1, &ps, nullptr) == SQLITE_OK) {
            sqlite3_bind_int(ps, 1, static_cast<int>(roomId));
            if (sqlite3_step(ps) == SQLITE_ROW)
                roomPersistent = sqlite3_column_int(ps, 0) != 0;
        }
        sqlite3_finalize(ps);
        sqlite3_exec(statusDb,
            "CREATE TABLE IF NOT EXISTS game_status ("
            " room_id INTEGER PRIMARY KEY,"
            " ready INTEGER NOT NULL DEFAULT 0,"
            " client_count INTEGER NOT NULL DEFAULT 0,"
            " pid INTEGER NOT NULL DEFAULT 0,"
            " port INTEGER NOT NULL DEFAULT 0,"
            " updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))",
            nullptr, nullptr, nullptr);
    }
    // idleExitSeconds <= 0 → never idle-exit (treat like a persistent room).
    // Headless runs have no clients by construction — idle-exit would kill them
    // right after the startup grace, so it is force-disabled; the run instead
    // ends on its own stop conditions + the --max-wall-min ceiling.
    const bool idleExitEnabled = idleExitSeconds > 0 && !headlessCfg.enabled;
    const int kStartupGraceSec = idleStartupGraceSeconds;  // wait for first client
    const int kIdleExitSec = idleExitSeconds;              // then exit after no clients
    if (!roomPersistent && idleExitEnabled)
        SLOG(SPRING_LOG_NOTICE, "idle self-termination: exit after %ds with no "
            "clients (%ds startup grace)", kIdleExitSec, kStartupGraceSec);
    const bool postGameExitEnabled = postGameExitSeconds > 0 && !headlessCfg.enabled;
    const int kPostGameExitSec = postGameExitSeconds;
    if (postGameExitEnabled)
        SLOG(SPRING_LOG_NOTICE, "post-game shutdown: exit %ds after game over",
            kPostGameExitSec);
    auto writeGameStatus = [&](bool ready, int clients) {
        if (!statusDb) return;
        char sql[256];
        snprintf(sql, sizeof(sql),
            "INSERT OR REPLACE INTO game_status"
            " (room_id, ready, client_count, pid, port, updated_at)"
            " VALUES (%u, %d, %d, %d, %d, strftime('%%s','now'))",
            roomId, ready ? 1 : 0, clients, static_cast<int>(getpid()), port);
        sqlite3_exec(statusDb, sql, nullptr, nullptr, nullptr);
    };
    // The QUIC endpoint has been accepting since rtcServer.Start above and the sim
    // is initialised — publish ready=1 so the lobby can mark the room Active.
    writeGameStatus(true, 0);

    // PLAN-gm-tools task 1: per-game sim-health metrics for the GM dashboard.
    // Shares the game_status DB handle; writes on a wall-clock cadence with
    // 7-day-raw / hourly-tail downsampling (E5). No-op if statusDb failed open.
    GameMetricsWriter metricsWriter;
    metricsWriter.Init(statusDb, roomId, /*cadenceSec=*/60);

    // PLAN-long-uptime task 3: the growth counters ride the same row's
    // `extra_json`, which GameMetrics reserved for exactly this. Thresholds
    // are read once at start-up rather than per sample — an operator changing
    // a ceiling restarts the game server, and re-reading getenv 30×/s to
    // support a case nobody has is the wrong trade.
    const growth::Thresholds growthThresholds = growth::ThresholdsFromEnv();
    // The last alarm set we logged, so a standing alarm produces one line
    // rather than one per minute for the life of the campaign. The durable
    // record is the admin_audit row the lobby writes off the same JSON; this
    // is the server's own log breadcrumb.
    std::vector<std::string> lastGrowthAlarmLabels;

    const auto serverStartTime = std::chrono::steady_clock::now();
    auto lastClientTime = serverStartTime;   // last instant clientCount > 0 (or launch)
    auto lastStatusWrite = serverStartTime;
    /// Playback-bar heartbeat (task 4b). Wall-clock, not frame-based, on
    /// purpose: a PAUSED replay advances no frames at all, and the bar still
    /// has to learn that the controller changed or that a seek finished.
    auto lastReplayStateAt = serverStartTime;
    // Wall clock of the first tick that observed a declared result. Stamped
    // from the loop rather than read off the sim frame because the observation
    // window is a wall-clock promise to the humans looking at the overlay, and
    // the sim frame stops advancing the moment the result lands.
    std::optional<std::chrono::steady_clock::time_point> gameOverAt;

    // (The team-stats-history send cursor + win-check latch + State-tier lane
    // constants now live as StateStreamer members.)

    // Headless-run stop-condition latches (PLAN-headless task 1). Once the
    // synced-Lua predicate has been observed true / errored it stays latched so
    // the run stops even if a later poll would read differently. Unused unless
    // headlessCfg.enabled.
    bool headlessLuaMet = false;
    bool headlessLuaErrored = false;
    headless::StopReason headlessStopReason = headless::StopReason::None;

    // Stats-dump snapshots (PLAN-headless task 2), taken every
    // headlessCfg.stateHashEvery sim frames plus once more at termination.
    // Unused unless headlessCfg.enabled && headlessCfg.stateHashEvery > 0.
    std::vector<statsdump::Snapshot> headlessSnapshots;

    // PLAN-long-uptime task 4: ONE gather for both growth surfaces. Task 3
    // wrote these counters inline at the metrics-write site; the soak dump
    // needs the identical set on the stats-dump cadence, and two copies of an
    // eleven-field gather would diverge exactly the way §7.3 warns about — the
    // dashboard and the soak report would then disagree about a game and the
    // disagreement would be a fact about this file. Two of the reads are O(id
    // space) and O(teams × params), so callers must gate on their own cadence
    // (DueForWrite / stateHashEvery), never call this per frame.
    auto gatherGrowthCounters = [&]() -> growth::Counters {
        growth::Counters gc;
        gc.rssKb = statsdump::GetRssKb();
        gc.luaHeapKb = GetSyncedLuaHeapKb();
        gc.paramKeys = static_cast<int64_t>(streamer.KeyDictionarySize());
        gc.paramKeysRev = static_cast<int64_t>(streamer.KeyDictionaryRev());
        gc.rulesParams = static_cast<int64_t>(CSplitLuaHandle::GetGameParams().size());
        for (int t = 0; t < teamHandler.ActiveTeams(); ++t) {
            if (const CTeam* team = teamHandler.Team(t))
                gc.rulesParams += static_cast<int64_t>(team->modParams.size());
        }
        gc.unitIdsMax = static_cast<int64_t>(unitHandler.MaxUnitIDs());
        gc.unitIdsUsed = gc.unitIdsMax - static_cast<int64_t>(unitHandler.NumFreeUnitIDs());
        gc.unitSpawns = static_cast<int64_t>(unitHandler.TotalUnitSpawnGens());
        gc.standingOrders = static_cast<int64_t>(standingOrders.GetAllOrders().size());
        gc.players = static_cast<int64_t>(playerHandler.ActivePlayers());
        gc.playersMax = MAX_PLAYERS;
        return gc;
    };

    // S8's reading: the disk the run's SQLite database actually occupies.
    // `stat` rather than a `page_count * page_size` pragma because the
    // question a retention policy has to answer is about the file on disk — a
    // DB that deletes rows without vacuuming keeps its size, and §9.5 already
    // recorded that as the live caveat.
    //
    // The `-wal` and `-shm` siblings are summed in, and that is not tidiness.
    // The first soak this sampler ever ran reported a dead-flat 4096 bytes for
    // twenty minutes while the sidecar WAL held half a megabyte and climbing:
    // in WAL mode the main file does not grow until a checkpoint, so stat'ing
    // it alone measures how recently sqlite checkpointed, not how much this
    // game is storing. A retention policy verified against that number would
    // have "passed" on a database with no retention at all.
    //
    // A failed stat contributes 0 rather than a guess — and a missing `-wal`
    // is the normal state of a checkpointed database, not an error.
    auto sampleDbBytes = [&dbPath]() -> int64_t {
        int64_t total = 0;
        for (const char* suffix : {"", "-wal", "-shm"}) {
            struct stat st {};
            if (::stat((dbPath + suffix).c_str(), &st) == 0)
                total += static_cast<int64_t>(st.st_size);
        }
        return total;
    };

    // Determinism digest: xor-fold every active unit's id/team/pos/health
    // (stable engine-defined iteration order) plus the synced RNG state.
    // Extracted from the snapshot capture because `--replay --verify` needs the
    // hash at the reference track's frames WITHOUT paying for a full stats
    // snapshot (teams, weapons, RSS) at every one of them (PLAN-replay §4).
    auto computeStateHash = [&]() -> uint64_t {
        std::vector<statsdump::UnitDigest> digest;
        digest.reserve(unitHandler.GetActiveUnits().size());
        for (const CUnit* u : unitHandler.GetActiveUnits()) {
            statsdump::UnitDigest d;
            d.id = u->id;
            d.team = static_cast<int16_t>(u->team);
            d.x = u->pos.x; d.y = u->pos.y; d.z = u->pos.z;
            d.health = u->health;
            digest.push_back(d);
        }
        return statsdump::ComputeStateHash(digest, gsRNG.GetGenState());
    };

    auto captureHeadlessSnapshot = [&](int64_t wallSec) {
        statsdump::Snapshot snap;
        snap.frame = sim.GetFrameNum();
        snap.gameSeconds = snap.frame / (double)GAME_SPEED;
        snap.wallSeconds = wallSec;
        snap.simFps = perfMetrics.GetSnapshot().simFps;
        snap.rssKb = statsdump::GetRssKb();
        snap.luaHeapKb = GetSyncedLuaHeapKb();
        snap.growth = gatherGrowthCounters();
        snap.dbBytes = sampleDbBytes();

        snap.stateHash = computeStateHash();

        for (int t = 0; t < teamHandler.ActiveTeams(); ++t) {
            const CTeam* team = teamHandler.Team(t);
            const TeamStatistics& ts = team->GetCurrentStats();
            statsdump::TeamSnapshot row;
            row.teamId = t;
            row.allyTeam = team->teamAllyteam;
            row.dead = team->isDead;
            row.numUnits = static_cast<int>(team->numUnits);
            row.metal = team->res.metal;
            row.energy = team->res.energy;
            row.metalIncome = team->resIncome.metal;
            row.energyIncome = team->resIncome.energy;
            row.metalExpense = team->resExpense.metal;
            row.energyExpense = team->resExpense.energy;
            row.damageDealt = ts.damageDealt;
            row.damageReceived = ts.damageReceived;
            row.unitsProduced = ts.unitsProduced;
            row.unitsDied = ts.unitsDied;
            row.unitsKilled = ts.unitsKilled;
            snap.teams.push_back(row);
        }

        for (const auto& [weaponDefId, totals] : combatStats.Snapshot()) {
            statsdump::WeaponStats row;
            row.weaponDefId = weaponDefId;
            row.volleys = totals.volleys;
            row.kills = totals.kills;
            row.damage = totals.damage;
            snap.weapons.push_back(row);
        }

        headlessSnapshots.push_back(std::move(snap));
    };

    while (keepRunning.load()) {
        // --- Pacing ---
        // Normal games (and headless realtime / xN) sleep to hit the target tick
        // interval; headless "uncapped" skips wall-clock pacing entirely and
        // ticks as fast as the sim computes (the sim thread is decoupled from
        // any render). The `headlessUncapped` guard is the ONLY divergence on
        // the normal path — with headless off it is always false, so behaviour
        // is byte-identical (the tick-gate-off regression bar, PLAN-headless §6).
        // A seek races to its target as fast as the sim computes, with the
        // wire muted so a watching spectator does not receive the skipped
        // frames (PLAN-replay §2). Suppression is at the transport, never at
        // the streamer — see WebTransportServer::SetOutboundSuppressed for why
        // muting the streamer would change the simulation.
        if (replay::IsReplaying()) {
            const bool ff = replay::Feed().FastForwarding(sim.GetFrameNum());
            if (ff != rtcServer.OutboundSuppressed()) {
                rtcServer.SetOutboundSuppressed(ff);
                if (!ff) {
                    SLOG(SPRING_LOG_NOTICE,
                        "replay: seek complete at frame %d — resuming streaming",
                        sim.GetFrameNum());
                    // Task 4b: the bar has been showing "seeking" since the
                    // control landed, and the frames it would have learned the
                    // truth from were the ones the suppression muted. Clear
                    // the flag and tell every watcher, on the tick streaming
                    // comes back rather than on the next heartbeat.
                    replay::Controls().SeekFinished();
                    Protocol::BroadcastReplayState(ctx);
                }
            }
        }
        const bool headlessUncapped =
            (headlessCfg.enabled && headlessCfg.tickMode == headless::TickMode::Uncapped) ||
            (replay::IsReplaying() && replay::Feed().FastForwarding(sim.GetFrameNum()));
        if (!headlessUncapped) {
            // Re-read wantedSpeedFactor every tick so live speed changes (via the
            // `speed` exec verb) apply immediately. A headless realtime/xN run
            // paces from its run config instead — there is no client to send
            // speed verbs.
            //
            // A REPLAY in Play mode is the exception to that last sentence and
            // takes computeTickInterval() too (task 4b). It is headless-enabled
            // — that is how it inherits the stop conditions — but it very much
            // does have a client sending speed verbs, and pacing it from the
            // run config instead would have made the playback-speed control a
            // dead button. Verify mode keeps the config pacing: it is an
            // uncapped batch job with no clients at all.
            tickInterval =
                (headlessCfg.enabled && replay::CurrentMode() != replay::Mode::Play)
                ? std::chrono::microseconds(headless::TickIntervalMicros(
                      headlessCfg.tickMode, headlessCfg.tickMultiple, GAME_SPEED))
                : computeTickInterval();

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
        }

        // --- Lifetime bookkeeping (idle self-termination + heartbeat) ---
        {
            const auto wall = std::chrono::steady_clock::now();
            const int clients = rtcServer.GetClientCount();
            if (clients > 0) lastClientTime = wall;
            // Heartbeat the status row ~every 2s (also refreshes client_count).
            if (wall - lastStatusWrite >= std::chrono::seconds(2)) {
                lastStatusWrite = wall;
                writeGameStatus(true, clients);
            }
            // Idle exit: non-persistent rooms shut down once they've had no
            // connected clients for kIdleExitSec (past the startup grace).
            if (!roomPersistent && idleExitEnabled) {
                const auto sinceStart = std::chrono::duration_cast<std::chrono::seconds>(
                    wall - serverStartTime).count();
                const auto idleFor = std::chrono::duration_cast<std::chrono::seconds>(
                    wall - lastClientTime).count();
                if (sinceStart > kStartupGraceSec && idleFor > kIdleExitSec) {
                    SLOG(SPRING_LOG_NOTICE,
                        "no connected clients for %llds — shutting down idle game server",
                        static_cast<long long>(idleFor));
                    keepRunning.store(false);
                }
            }
            // Post-game exit: a finished war has nothing left to serve, so the
            // process stops and hands its port back once the observation
            // window closes. Idle exit does not cover this — players who leave
            // the result overlay open never trip it, and the room held :9100
            // indefinitely (observed live, 2026-08-03). Applies to persistent
            // rooms too: persistence is about surviving an *empty* room, not
            // about outliving the match. Headless runs are excluded — their
            // own stop conditions already treat game over as a stop and would
            // otherwise be pre-empted by this timer's exit reason.
            if (postGameExitEnabled && gameOverRelay.IsDeclared()) {
                if (!gameOverAt) gameOverAt = wall;
                const int since = static_cast<int>(
                    std::chrono::duration_cast<std::chrono::seconds>(
                        wall - *gameOverAt).count());
                if (postgame::ShouldExit(true, since, kPostGameExitSec)) {
                    SLOG(SPRING_LOG_NOTICE,
                        "game over %ds ago — shutting down finished game server "
                        "(frame %d, %d client(s) still connected)",
                        since, sim.GetFrameNum(), clients);
                    keepRunning.store(false);
                }
            }
        }

        perfMetrics.BeginTick();
        // Rate-limit token buckets now refill lazily on command arrival;
        // no per-tick reset required. See ClientSession::TryConsumeCommandBudget.

        // Open the journal's tick window (PLAN-replay task 1). Everything
        // recorded until the next BeginTick is stamped with this frame; the
        // SetPhase calls below mark which of the tick's five input phases each
        // record belongs to. Note the frame is read BEFORE SimFrame — inputs
        // applied this tick act on the state at frame N and must replay there,
        // not at N+1. While the sim is paused or pre-GameStart the frame does
        // not advance at all, which is exactly why records also carry the
        // monotonic `seq` (see TickPhase's comment).
        syncedinput::Journal().BeginTick(sim.GetFrameNum());

        // --- Replay feed, phase 1 of 5: Inbound (PLAN-replay task 2) ---
        // The inverse of the recording funnel. Fed BEFORE the live drain so a
        // recorded input always precedes a live spectator's message on the same
        // tick, exactly as it did when the recording was made (the spectator
        // did not exist then, so it can only ever be "later").
        if (replay::IsReplaying()) {
            for (const syncedinput::Record* r :
                     replay::Feed().Due(syncedinput::Journal().Frame(),
                                        syncedinput::TickPhase::Inbound)) {
                FeedReplayRecord(*r);
            }
        }

        // Drain inbound messages from WebTransport streams and dispatch each
        // through the extracted ClientMessageHandler.
        auto messages = rtcServer.DrainInbound();
        for (auto& msg : messages) {
            // A replay's synced state comes from the recorded stream and
            // nowhere else. A live client attached to a replay server is a
            // SPECTATOR by construction — even if it authenticates as the
            // player whose game this is — so its sim-mutating verbs are
            // refused here rather than being allowed to fork the re-execution.
            // View-state verbs (viewport, selection, path preview) pass
            // through untouched: they are what makes spectating work, and by
            // the classifier's own definition they cannot change the sim.
            //
            // TWO Setup verbs are exempted (PLAN-replay §7.11 T2-a-3). Until
            // 2026-08-05 this gate refused every recordable verb, which
            // includes Handshake and AuthRequest — so no live client could
            // authenticate against a replay server at all, and nothing could
            // spectate one. That was a gap, not a policy: a spectator MUST
            // authenticate to watch anything, and both verbs are recorded
            // precisely because they shape who may cause what, which is an
            // argument about the RECORDED connections. A live connection's
            // handshake and auth decide only what that connection may do, and
            // ClientMessageHandler pins that answer to "spectator, team -1, a
            // player number from a reserved range, absent from the sim's
            // roster" regardless of what its account says.
            if (replay::IsReplaying() && !replay::IsVirtualClient(msg.clientId)) {
                const uint8_t ptype = PeekClientPayloadType(msg);
                const bool admissionVerb =
                    ptype == SpringWeb::ClientPayload_Handshake ||
                    ptype == SpringWeb::ClientPayload_AuthRequest;
                if (syncedinput::ShouldRecordClientPayload(ptype) &&
                    !admissionVerb) {
                    static std::unordered_set<ClientID> warnedReplayClients;
                    if (warnedReplayClients.insert(msg.clientId).second) {
                        SLOG(SPRING_LOG_NOTICE,
                            "replay: client %u sent sim-affecting verb %u — refused "
                            "(a replay server accepts spectators, not players)",
                            msg.clientId, static_cast<unsigned>(ptype));
                    }
                    continue;
                }
            }
            msgHandler.HandleMessage(msg);
        }

        // --- Handle client disconnects ---
        // The network thread pushes disconnected ClientIDs to a queue;
        // we drain it here and fire the Lua PlayerRemoved callin so
        // game scripts can decide what to do (kill units, pause, hand
        // to AI, end the game, etc.). We also broadcast a PlayerLeft
        // FlatBuffers message so remaining clients can update their UI.
        {
            syncedinput::Journal().SetPhase(syncedinput::TickPhase::Disconnect);
            // Replay feed, phase 2 of 5.
            if (replay::IsReplaying()) {
                for (const syncedinput::Record* r :
                         replay::Feed().Due(syncedinput::Journal().Frame(),
                                            syncedinput::TickPhase::Disconnect)) {
                    FeedReplayRecord(*r);
                }
            }
            auto disconnects = rtcServer.DrainDisconnects();
            for (ClientID dcId : disconnects) {
                // C1: drop the handshake gate first — a client that handshook
                // but disconnected before authenticating has no session, so
                // this must run ahead of the no-session early-continue below.
                handshakedClients.erase(dcId);

                auto* session = sessions.GetSession(dcId);
                if (!session) continue;

                // PLAN-quickstart.md §3.3: a PlayerLeaveIntent sent just before
                // this disconnect (e.g. gpDetach) overrides the default reason
                // 0 (voluntary quit) — lets PlayerRemoved distinguish a parked/
                // reconnecting player from one who actually quit.
                uint8_t leaveReason = 0;
                auto lrIt = pendingLeaveReason.find(dcId);
                if (lrIt != pendingLeaveReason.end()) {
                    leaveReason = lrIt->second;
                    pendingLeaveReason.erase(lrIt);
                }

                SLOG(SPRING_LOG_NOTICE,
                    "player '%s' (client %u, team %d) disconnected (reason=%d)",
                    session->username.c_str(), dcId, session->team, leaveReason);

                // Broadcast PlayerLeft to remaining clients
                auto plMsg = Protocol::BuildPlayerLeft(
                    static_cast<uint32_t>(session->userId),
                    session->username,
                    static_cast<int8_t>(session->team),
                    leaveReason);
                rtcServer.BroadcastReliable(plMsg.data(), plMsg.size());

                // Fire the Spring PlayerRemoved callin into Lua so
                // game gadgets can react (the callin signature is
                // gadget:PlayerRemoved(playerId, reason)).
                auto pIt = clientPlayerNum.find(dcId);
                if (pIt != clientPlayerNum.end()) {
                    int pNum = pIt->second;
                    // Journal chokepoint #2 of 5: a disconnect fires
                    // PlayerRemoved into synced Lua, so gadgets can (and in
                    // Metalstorm do) change synced state in response. Only
                    // recorded for a client that reached a player number —
                    // an unauthenticated drop touches nothing synced.
                    syncedinput::Journal().RecordDisconnect(pNum, leaveReason);
                    playerHandler.PlayerLeft(pNum, leaveReason);
                    eventHandler.PlayerRemoved(pNum, leaveReason);
                    // Forward to the client LuaUI worker (widget:PlayerRemoved).
                    playerTeamEvents.Push({PlayerTeamEventData::PlayerRemoved, leaveReason,
                                           static_cast<uint32_t>(pNum)});
                    clientPlayerNum.erase(pIt);
                }

                // A replay watcher leaving (task 4b). Two things follow from
                // mechanism (3) of §7.12 — the spectator is not in
                // `playerHandler` and has no `clientPlayerNum` entry — and
                // both are load-bearing: the PlayerRemoved block above is
                // skipped entirely, so nothing synced fires (T4a-3's implicit
                // invariant, now with a comment at the site that depends on
                // it), and the controls have to be handed on HERE, because
                // there is no roster change to notice it anywhere else.
                const int replayWatcher = session->replaySpectatorPlayerNum;
                if (replayWatcher >= 0) {
                    replay::Controls().Detach(replayWatcher);
                    SLOG(SPRING_LOG_NOTICE,
                        "replay: spectator playerNum %d detached (%zu still "
                        "watching, controller is now %d)",
                        replayWatcher, replay::Controls().WatcherCount(),
                        replay::Controls().Controller());
                }

                handshakedClients.erase(dcId);
                sessions.RemoveSession(dcId);
                // After RemoveSession, so the departing watcher is not one of
                // the recipients and the successor learns it is driving.
                if (replayWatcher >= 0) Protocol::BroadcastReplayState(ctx);

                // The roster changed: the leaver's entry is now inactive.
                // Broadcast after RemoveSession/erase so the snapshot reflects
                // the post-disconnect state rather than the state we just left.
                // Kept (not removed) so a scoreboard can still name a player
                // who dropped — see PlayerEntry.active in protocol.fbs.
                Protocol::BroadcastPlayerRoster(ctx);
            }
        }

        // Only tick the sim after GameStart has fired (all players in).
        // Skip when the debugger has paused at a breakpoint, OR when the
        // game is paused (`gs->paused`, set by the `pause` console command /
        // the client Pause hotkey). The latter was previously NOT checked,
        // so a "paused" game kept ticking — units kept moving, sounds and
        // combat events kept streaming. Gating SimFrame here stops the sim
        // cleanly while the loop keeps running (GameInfo still broadcasts
        // paused=true, console commands still process).
        //
        // Also skip once the match is over. Declaring a winner used to be a
        // pure notification: the sim ran on past the declared frame for as
        // long as the room lived, spawning objectives and paying out income
        // into a finished war (PostGamePolicy.h has the measurements). Game
        // over freezes the world at the frame the clients were shown as the
        // result. The loop itself keeps running — admin `exec` still works
        // for post-mortem inspection, and the observation-window timer in the
        // lifetime-bookkeeping block above is what stops the process.
        if (sim.HasGameStarted() && !g_luaDebugger.IsPaused() && !gs->paused
            && !gameOverRelay.IsDeclared()) {
            sim.SimFrame();
            springlog_set_frame(sim.GetFrameNum());
        }

        // Process pending console commands (from WS thread or HTTP)
        {
            syncedinput::Journal().SetPhase(syncedinput::TickPhase::LuaExec);
            // Replay feed, phase 3 of 5.
            // NOTE the frame source, here and at every other feed site: the
            // JOURNAL's tick stamp, never a fresh sim.GetFrameNum(). SimFrame()
            // has already run by this point in the tick, so the sim's counter
            // has advanced past the value the recorder stamped this tick's
            // records with. Re-reading it would make every post-SimFrame input
            // (exec, AI) arrive one frame late on replay — which is exactly
            // what it did, and the resulting hash divergence at the very first
            // checkpoint is what found it.
            if (replay::IsReplaying()) {
                for (const syncedinput::Record* r :
                         replay::Feed().Due(syncedinput::Journal().Frame(),
                                            syncedinput::TickPhase::LuaExec)) {
                    FeedReplayRecord(*r);
                }
            }
            LuaExecRequest req;
            while (luaExecEngine.TryPop(req)) {
                // Same rule as the wire: a live operator poking a replay would
                // be injecting an input the recording never had. Refused with a
                // reply, not silently dropped — the console is interactive and
                // an unanswered request looks like a hung server.
                if (replay::IsReplaying()) {
                    LuaExecResult refused;
                    refused.requestId = req.requestId;
                    refused.clientId  = req.clientId;
                    refused.scope     = req.scope;
                    refused.success   = false;
                    refused.output    = "refused: this server is replaying a "
                                        "recorded game; exec would diverge it";
                    luaExecEngine.DeliverResult(refused);
                    SLOG(SPRING_LOG_NOTICE,
                        "replay: refused a live exec request (scope=%s)",
                        req.scope.c_str());
                    continue;
                }
                // Journal chokepoint #3 of 5: exec runs arbitrary Lua against
                // the synced state (spawn, kill, give resources, set cheats —
                // the whole spring-debug MCP surface arrives here via
                // /api/exec). Recorded at the drain, not at Push: Push happens
                // on the network/HTTP thread at an indeterminate moment, and
                // it is the drain frame that decides what the code observes.
                syncedinput::Journal().RecordLuaExec(-1, req.scope, req.code);
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

        // Per-tick broadcast pipeline (win-check, resource/command/entity/
        // piece/build streaming, standing-order eval, AI tick, combat/decal/
        // heightmap/lifecycle/team-stats/LOS broadcasts). Runs every block in
        // the exact prior source order; see StateStreamer::Tick.
        syncedinput::Journal().SetPhase(syncedinput::TickPhase::Stream);
        streamer.Tick(sim.GetFrameNum());

        // Playback-bar heartbeat (task 4b). Every control that lands already
        // broadcasts; this is the self-heal for a bar that missed one, and the
        // only thing that moves the frame readout while nothing else is
        // happening. Suppressed during a seek's fast-forward — the transport
        // is muted there anyway, and the bar should not animate through frames
        // the watcher is not being shown.
        if (replay::IsReplaying() &&
            !replay::Feed().FastForwarding(sim.GetFrameNum())) {
            const auto wallNow = std::chrono::steady_clock::now();
            if (wallNow - lastReplayStateAt >= std::chrono::seconds(1)) {
                lastReplayStateAt = wallNow;
                Protocol::BroadcastReplayState(ctx);
            }
        }

        const int entityCount = static_cast<int>(unitHandler.GetActiveUnits().size());
        perfMetrics.SetFrame(sim.GetFrameNum());
        perfMetrics.SetClientCount(rtcServer.GetClientCount());
        perfMetrics.SetEntityCount(entityCount);   // was never wired → /api/metrics read 0
        perfMetrics.SetAICount(static_cast<int>(aiPool.GetAICount()));
        perfMetrics.EndTick();

        // PLAN-gm-tools task 1: feed the metric writer. SampleTick every frame
        // (p95 window); MaybeWrite gates itself to the cadence. `simRunning`
        // mirrors the SimFrame gate above so a paused/empty game reports no
        // false frames-behind lag.
        {
            const auto snap = perfMetrics.GetSnapshot();
            metricsWriter.SampleTick(snap.tickTimeUs);
            const bool simRunning = sim.HasGameStarted() && !g_luaDebugger.IsPaused() &&
                                    !gs->paused && !gameOverRelay.IsDeclared() &&
                                    rtcServer.GetClientCount() > 0;

            // PLAN-long-uptime task 3: gather the growth counters only on the
            // ticks that will actually write a row. Two of them are O(id
            // space) and O(teams × params), which is nothing once a minute and
            // would be a measurable per-frame cost otherwise — hence
            // DueForWrite rather than gathering unconditionally and letting
            // MaybeWrite throw the work away.
            std::string extraJson;
            if (metricsWriter.DueForWrite()) {
                const growth::Counters gc = gatherGrowthCounters();

                const std::vector<growth::Alarm> alarms =
                    growth::Evaluate(gc, growthThresholds);
                extraJson = growth::ToJson(gc, alarms);

                // Log only on a *change* of the tripped set. A campaign that
                // legitimately sits above the id warn for a week should not
                // write 10 000 identical WARN lines into the very log table
                // task 2b just put a retention policy on.
                std::vector<std::string> labels;
                labels.reserve(alarms.size());
                for (const growth::Alarm& a : alarms)
                    labels.push_back(a.label + (a.crit ? "!" : ""));
                if (labels != lastGrowthAlarmLabels) {
                    for (const growth::Alarm& a : alarms)
                        SLOG(a.crit ? SPRING_LOG_WARNING : SPRING_LOG_NOTICE,
                             "growth alarm [%s]: %s", a.label.c_str(), a.detail.c_str());
                    if (alarms.empty() && !lastGrowthAlarmLabels.empty())
                        SLOG(SPRING_LOG_NOTICE, "growth alarms cleared");
                    lastGrowthAlarmLabels = std::move(labels);
                }
            }

            metricsWriter.MaybeWrite(snap.frame, snap.clientCount, entityCount,
                                     snap.simFps, gs->speedFactor, simRunning,
                                     extraJson);
        }

        // Periodic status
        int frame = sim.GetFrameNum();
        if (frame > 0 && (frame % (GAME_SPEED * 10)) == 0) {
            SLOG(SPRING_LOG_INFO, "frame %d (%.1fs) clients=%d",
                frame, frame / (float)GAME_SPEED, rtcServer.GetClientCount());
        }

        // --- State-hash track: record and verify (PLAN-replay §4, task 3) ---
        //
        // ONE site for both halves, on purpose. A determinism hash is only
        // comparable against another hash taken at the SAME point in the tick,
        // and the two halves run in different processes months apart — if they
        // drift to different statements the divergence report becomes a report
        // about this file. Recording and verifying from the same `if` makes
        // that drift impossible rather than merely unlikely.
        //
        // It sits outside the `headlessCfg.enabled` block below because
        // recording happens in ordinary player-facing games, which are not
        // headless. (Task 2 verified inside that block, against a track that
        // came from a --headless-run stats dump captured a few statements
        // later, after the stop-condition Lua poll. That poll only runs under
        // --headless-run with a luaCondition set, so the two sites agreed in
        // practice; they are now the same site and agree by construction.)
        //
        // Frame 0 is skipped: before GameStart there is nothing to hash.
        if (frame > 0) {
            if (journalHashEvery > 0 && replayWriter.Enabled() &&
                (frame % journalHashEvery) == 0) {
                replayWriter.AppendHashPoint(frame, computeStateHash());
            }
            // A divergence is LOCATED — that frame is the bisection point a
            // desync investigation starts from — and the run keeps going so the
            // report can say whether the state re-converged (it never does, but
            // "diverged once at N and stayed wrong" and "diverged at N" are
            // different bug shapes).
            if (replay::CurrentMode() == replay::Mode::Verify &&
                replay::Feed().WantHashAt(frame)) {
                const uint64_t h = computeStateHash();
                if (!replay::Feed().CheckHash(frame, h) &&
                    replay::Feed().Verify().firstDivergenceFrame == frame) {
                    SLOG(SPRING_LOG_ERROR,
                        "replay verify: DIVERGENCE at frame %d — expected %016llx, got %016llx",
                        frame,
                        (unsigned long long)replay::Feed().Verify().expected,
                        (unsigned long long)replay::Feed().Verify().actual);
                }
            }
        }

        // --- Headless run: stop-condition evaluation (PLAN-headless task 1) ---
        // Only reached under --headless-run, so a normal game never enters this
        // block (regression bar). Evaluated after the tick + streamer, so the
        // game-over relay and frame count reflect this frame. The synced-Lua
        // predicate is polled every 30 game-seconds (§1) and its result latched.
        if (headlessCfg.enabled) {
            if (headlessCfg.stopAt.luaCondition && !headlessLuaMet &&
                !headlessLuaErrored && frame > 0 &&
                (frame % (GAME_SPEED * 30)) == 0) {
                std::string perr;
                const auto pr = EvalSyncedPredicate(
                    *headlessCfg.stopAt.luaCondition, perr);
                if (pr == SyncedPredicateResult::Error) {
                    headlessLuaErrored = true;   // E3: treat as stop, never a hang
                    SLOG(SPRING_LOG_ERROR, "headless luaCondition '%s' errored: %s",
                        headlessCfg.stopAt.luaCondition->c_str(), perr.c_str());
                } else if (pr == SyncedPredicateResult::True) {
                    headlessLuaMet = true;
                }
            }

            headless::RunState rs;
            rs.frame = frame;
            rs.gameOverDeclared = gameOverRelay.IsDeclared();
            rs.luaConditionMet = headlessLuaMet;
            rs.luaConditionErrored = headlessLuaErrored;
            rs.wallElapsedSec = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::steady_clock::now() - serverStartTime).count();

            // Stats-dump snapshot cadence (task 2 §1 "stateHashEvery"). Frame 0
            // is skipped — before GameStart there is nothing meaningful to hash.
            if (headlessCfg.stateHashEvery > 0 && frame > 0 &&
                (frame % headlessCfg.stateHashEvery) == 0) {
                captureHeadlessSnapshot(rs.wallElapsedSec);
            }

            headlessStopReason = headless::EvaluateStop(
                headlessCfg.stopAt, headlessCfg.maxWallSec, rs);

            // Replay's own terminal conditions, evaluated after the shared ones
            // so a frame limit or wall ceiling still wins. ReplayEnd is a
            // SUCCESSFUL end: the stream ran out at the frame the recording
            // ended at, which is the whole job.
            if (replay::IsReplaying() && headlessStopReason == headless::StopReason::None) {
                if (replay::Feed().StopRequested()) {
                    SLOG(SPRING_LOG_ERROR, "replay aborted: %s",
                         replay::Feed().StopReason().c_str());
                    headlessStopReason = headless::StopReason::ReplayAborted;
                } else if (replay::Feed().Exhausted() &&
                           frame >= replay::Feed().EndFrame()) {
                    headlessStopReason = headless::StopReason::ReplayEnd;
                }
            }

            if (headlessStopReason != headless::StopReason::None) {
                SLOG(SPRING_LOG_NOTICE,
                    "headless run complete: stop=%s frame=%d (%.1fs) wall=%llds",
                    headless::StopReasonName(headlessStopReason), frame,
                    frame / (float)GAME_SPEED, (long long)rs.wallElapsedSec);
                keepRunning.store(false);

                // Final stats dump (task 2 §1 "JSON at termination"). Always
                // takes one last snapshot regardless of stateHashEvery cadence,
                // so the dump's terminal row matches the reported stop frame.
                if (!headlessCfg.statsDump.empty()) {
                    if (headlessCfg.stateHashEvery <= 0 ||
                        (frame % headlessCfg.stateHashEvery) != 0) {
                        captureHeadlessSnapshot(rs.wallElapsedSec);
                    }
                    statsdump::FinalDump dump;
                    dump.status = headless::StopReasonName(headlessStopReason);
                    dump.frame = frame;
                    dump.gameSeconds = frame / (double)GAME_SPEED;
                    dump.wallSeconds = rs.wallElapsedSec;
                    dump.snapshots = headlessSnapshots;
                    std::string dumpErr;
                    if (!statsdump::WriteDumpFile(headlessCfg.statsDump, dump, dumpErr)) {
                        SLOG(SPRING_LOG_ERROR, "headless stats dump write failed: %s",
                            dumpErr.c_str());
                    } else {
                        SLOG(SPRING_LOG_NOTICE, "headless stats dump written: %s (%zu snapshots)",
                            headlessCfg.statsDump.c_str(), headlessSnapshots.size());
                    }
                }
            }
        }

        // Push this tick's journal records to the OS. Per-tick rather than
        // per-record: the granularity a crash can lose is one tick of inputs,
        // and the file format already treats a torn tail as the E1 truncation
        // case rather than as corruption.
        if (replayWriter.Enabled()) replayWriter.Flush();
    }

    // --- Close the replay recording (PLAN-replay task 2) ---
    // The trailer is what marks this file as a COMPLETE segment. Detach from
    // the funnel first: anything recorded during the teardown below would land
    // after the trailer and be unreachable to a reader.
    int replayExitCode = 0;
    if (replayWriter.Enabled()) {
        syncedinput::Journal().SetJournal(nullptr);
        // How the game ENDED (task 4c). Written only when a result was
        // actually declared: the block's absence is the "still running / never
        // finished" answer a replay browser needs, and an empty block would
        // erase that distinction rather than record it. It goes in ahead of the
        // trailer because the trailer is what closes the segment.
        if (gameOverRelay.IsDeclared())
            replayWriter.WriteOutcome(gameOverRelay.DeclaredFrame(),
                                      gameOverRelay.Winners());
        replay::Trailer tr;
        tr.endFrame    = sim.GetFrameNum();
        tr.recordCount = replayWriter.Written();
        const bool wroteBadly = replayWriter.Failed();
        const uint64_t hashPts = replayWriter.HashPointsWritten();
        replayWriter.Close(tr);
        SLOG(wroteBadly ? SPRING_LOG_ERROR : SPRING_LOG_NOTICE,
            "replay recording closed: %s (%llu records, %llu hash points, "
            "end frame %d)%s",
            journalFilePath.c_str(), (unsigned long long)tr.recordCount,
            (unsigned long long)hashPts, tr.endFrame,
            wroteBadly ? " — WITH WRITE ERRORS, the segment is incomplete" : "");
        // A recording with no hash track cannot be verified later, and the
        // reason is always a flag the operator set — say so at the moment the
        // file is finished, not when a CI run three weeks later refuses it.
        if (!wroteBadly && hashPts == 0) {
            SLOG(SPRING_LOG_WARNING,
                "replay: no state-hash reference points were recorded "
                "(--journal-hash-every %d, ended at frame %d) — `--replay %s "
                "--verify` will have nothing to check against",
                journalHashEvery, tr.endFrame, journalFilePath.c_str());
        }
        if (wroteBadly) replayExitCode = 1;
    }

    // --- Replay verification verdict (PLAN-replay §4) ---
    if (replay::CurrentMode() == replay::Mode::Verify) {
        replay::Feed().FinishVerify(sim.GetFrameNum());
        const auto& v = replay::Feed().Verify();
        if (v.Passed()) {
            SLOG(SPRING_LOG_NOTICE,
                "replay verify: PASS — %d/%d state hashes matched, %llu records fed",
                v.matched, v.checked, (unsigned long long)replay::Feed().Fed());
        } else {
            SLOG(SPRING_LOG_ERROR,
                "replay verify: FAIL — checked=%d matched=%d missing=%d "
                "firstDivergence=%d expected=%016llx actual=%016llx",
                v.checked, v.matched, v.missing, v.firstDivergenceFrame,
                (unsigned long long)v.expected, (unsigned long long)v.actual);
            replayExitCode = 2;
        }
    }
    if (replay::IsReplaying()) {
        // A late record is a record that came due at a frame the replay had
        // already passed — i.e. the re-execution's frame progression did not
        // match the recording's. It never silently drops the input, but it is
        // a divergence signal in its own right and must be said out loud.
        if (replay::Feed().Late() > 0) {
            SLOG(SPRING_LOG_WARNING,
                "replay: %llu record(s) were fed LATE — the replay's frame "
                "progression did not match the recording's",
                (unsigned long long)replay::Feed().Late());
        }
        if (!replay::Feed().Exhausted()) {
            SLOG(SPRING_LOG_WARNING,
                "replay: ended with %zu record(s) unfed",
                replay::Feed().RecordCount() - static_cast<size_t>(replay::Feed().Fed()));
        }
    }

    // Final metric row (graceful shutdown / game-over / idle-exit) so the
    // dashboard timeline ends at the true last frame, not the last cadence tick.
    {
        const auto snap = perfMetrics.GetSnapshot();
        metricsWriter.WriteNow(snap.frame, snap.clientCount,
                               static_cast<int>(unitHandler.GetActiveUnits().size()),
                               snap.simFps, gs->speedFactor, /*simRunning=*/false);
    }

    // Synced-input cause-stream summary (PLAN-replay task 1). Emitted whether
    // or not --journal-audit attached a journal: the funnel's counters run
    // unconditionally, so every run reports how many synced inputs it applied.
    // A run that reports recorded=0 while units clearly moved is the signal
    // that an input path bypassed the funnel.
    SLOG(SPRING_LOG_NOTICE, "synced-input journal: %s",
         syncedinput::FormatAudit(syncedinput::Journal().Stats()).c_str());

    // Clear our liveness row so the lobby/launch_game stop treating us as a
    // live, ready game server. On restart the re-exec'd process republishes it.
    if (statusDb) {
        char sql[96];
        snprintf(sql, sizeof(sql), "DELETE FROM game_status WHERE room_id=%u", roomId);
        sqlite3_exec(statusDb, sql, nullptr, nullptr, nullptr);
        sqlite3_close(statusDb);
        statusDb = nullptr;
    }

    if (restartRequested.load()) {
        SLOG(SPRING_LOG_NOTICE, "restart requested — notifying clients and re-exec'ing...");

        // Tell clients to reset and reconnect
        auto msg = Protocol::BuildGameRestarting();
        rtcServer.BroadcastReliable(msg.data(), msg.size());

        // Brief pause to let the message flush over WebTransport
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
    if (replayExitCode != 0) {
        // Tear down the log sinks before returning non-zero — a verify failure
        // is a normal, expected outcome of a CI run, not a crash.
        if (!logServer.empty())
            springlog_net_shutdown();
        springlog_sqlite_shutdown();
        springlog_shutdown();
        return replayExitCode;
    }

    // Tear down optional sinks before the core logger
    if (!logServer.empty())
        springlog_net_shutdown();
    springlog_sqlite_shutdown();
    springlog_shutdown();

    return 0;
}
