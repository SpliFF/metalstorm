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
#include "Server/ProtocolSchemaHash.h"  // SCHEMA_HASH, stamped into the replay header
#include "Server/PlayerRosterBroadcast.h"
#include "Server/Database.h"
#include "Server/GameMetrics.h"
#include "Server/GrowthCounters.h"
#include <sys/stat.h>              // soak dump's db-size sample (S8)
#include "Lua/LuaHandleSynced.h"   // CSplitLuaHandle::GetGameParams — growth counters
#include "Server/GmVerbs.h"
#include "Server/EngineIdentity.h"
#include "Server/GameStateStore.h"
#include "Server/Hibernation.h"
#include "Server/ResumeVerify.h"
#include "Server/SimSnapshot.h"
#include "Server/SnapshotRoundTrip.h"
#include "Server/DevBuildGate.h"
#include "Server/ClientSession.h"
#include "Server/ClientEvalBroker.h"
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
#include "Server/AI/AICommandQueue.h"
#include "Server/AI/AIRuntimePool.h"
#include "Server/AI/AIDiscovery.h"
#include "Server/AI/AISpawn.h"
#include "Server/AI/AISpawnService.h"
#include "Server/PerfMetrics.h"
#include "Server/PlayerSlotReservation.h"
#include "Server/RoomManager.h"
#include "Server/AuthTokens.h"
#include "Server/GameEventsDb.h"
#include "Server/RuntimeAIRoster.h"
#include "Server/WarPlayerBindings.h"
#include "Server/WarStateSim.h"
#include "Server/PlayerOnboarding.h"
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

    // `--print-engine-hash`: print this binary's E1 identity and exit, before
    // logging, SQLite or anything else is touched (PLAN-persistence task 3c).
    //
    // It exists because the LOBBY has to apply the §2 post-upgrade policy
    // before it forks a server, and it cannot compute this value: the lobby is
    // a separate link target with its own build stamp, and it spawns
    // `build/release/spring-server` when one exists — possibly from another
    // build tree entirely. The binary that will read the snapshot is the only
    // honest source, so it answers for itself. stdout is exactly the 16 hex
    // digits + newline, which is what `game_snapshots.engine_hash` stores.
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) != "--print-engine-hash")
            continue;
        std::printf("%s\n",
                    engineid::HashHex(engineid::StampHash(SPRING_BUILD_STAMP)).c_str());
        return 0;
    }

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
    // PLAN-metalstorm-lobby.md §1/§2.1 task 1: which kind of session this
    // process is hosting. Skirmish (the default, and what every launcher that
    // does not pass --session-kind gets) holds GameStart until every rostered
    // human has connected. A persistent war does not wait: the war is the
    // thing that exists, and the players trickle into it.
    SessionKind sessionKind = SessionKind::Skirmish;
    // Task 2: how many humans a war seats per side before a dynamic joiner is
    // turned back to spectating. 0 = unlimited. Uniform across sides on
    // purpose — per-side capacity, war seeding and queue-when-full are task 7;
    // this exists so the join path ships a capacity check that is real.
    unsigned warSideCapacity = WAR_SIDE_CAPACITY_DEFAULT;
    // PLAN-metalstorm-wars.md §8.1 task 5: Σ slotCap — the number of human
    // player slots this process is being spawned FOR, decided by the War
    // Director at seed time and recorded as `wars.spawned_slot_cap`. The slots
    // are materialised during set-up so a dynamic joiner (§2.1) is seated into
    // a place that already exists rather than one it has to win from the
    // spectators. 0 (the default, and what every non-war launcher gets) means
    // "not sized" — the player list grows on demand exactly as before.
    unsigned playerSlotCap = 0;
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

    // --- Hibernation (PLAN-persistence task 3a) ---
    // `--resume`: come up by applying this room's newest valid snapshot
    // instead of the world staging just built. Bare flag — the partition key
    // (gameId, roomId) is already `--game` + `--room`; see Hibernation.h for
    // why §3's `--resume <gameId>` sketch is not what landed.
    bool resumeRequested = false;
    // `--resume-verify`: after the resume applies, re-capture the world and
    // byte-compare with the payload just applied, print the verdict and EXIT
    // — the fresh-process idempotence bar (ResumeVerify.h). Requires
    // `--resume`; driven by tools/scripts/hibernate-resume-recapture.sh.
    bool resumeVerifyRequested = false;
    /// Set once a resume has actually APPLIED a stored world, which is a
    /// stricter fact than `resumeRequested` and the only one the runtime-AI
    /// restore may act on: re-seating a caretaker over a freshly staged world
    /// would put a brain on a side whose pool and orders were never restored.
    bool resumedWorld = false;
    // `--no-hibernate`: exit without leaving a resumable world behind. The
    // escape hatch for a box being torn down for good, and the off switch a
    // bisect needs.
    bool hibernationEnabled = envInt("SPRING_HIBERNATE", 1) != 0;
    // How long a PERSISTENT room may sit with no connected clients before it
    // checkpoints and exits. **Default 0 = off, deliberately.** A persistent
    // war exiting when empty is only correct once something respawns it on
    // join, and that is the lobby's half (task 3b): with 0 the room behaves
    // exactly as it does today and the exit-checkpoint path below still runs
    // for signal exits, which is what makes a deploy drain resumable.
    // Non-persistent rooms are unaffected — they idle-exit as before.
    int hibernateIdleSeconds = envInt("SPRING_HIBERNATE_IDLE_SECONDS", 0);

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

    // --- Snapshot round-trip mode (PLAN-persistence §8) ---
    // `--snapshot-roundtrip <frame>[:<ticks>]` checkpoints a populated sim,
    // runs it on N ticks, restores the checkpoint and runs the same N ticks
    // again, requiring the two determinism-hash tracks and the two terminal
    // payloads to be identical. It rides the headless substrate for the same
    // reason --replay does: no browser client is needed for the sim to tick,
    // and the comparison is a batch job.
    snapshotrt::Config roundTripCfg;

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

    // PLAN-test-automation P7: browser-eval relay waiters. Registered by the
    // HTTP thread in POST /api/client/eval, resolved by the sim thread when
    // the addressed browser answers with a ClientEvalResponse.
    ClientEvalBroker evalBroker;

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
    // --snapshot-roundtrip <frame>[:<ticks>] (PLAN-persistence §8: checkpoint a
    //   populated sim, run N ticks, restore, run the same N ticks, and require
    //   the restore to be byte-exact and the two continuations to hold the same
    //   roster with the same vitals; movement divergence is measured and
    //   reported rather than failed (Q-P2 option D). Nonzero exit on a defect.
    //   Implies a headless uncapped run),
    // --roundtrip-strict (Q-P2's pre-decision bar: also require the two hash
    //   tracks and the two terminal payloads to be identical),
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
    // --player-slots N (PLAN-metalstorm-wars.md §8.1: pre-allocate N human
    //   player slots for a war's Σ slotCap; 0 = size on demand),
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
        } else if (arg == "--session-kind" && i + 1 < argc) {
            const std::string spec = argv[++i];
            if (auto kind = SessionKindFromString(spec)) {
                sessionKind = *kind;
            } else {
                // Refuse rather than default: a launcher that asked for a war
                // and silently got a skirmish would hang on a roster wait its
                // players were never going to satisfy, and the log line for
                // that is "waiting for N player(s)" — indistinguishable from
                // a slow browser.
                fprintf(stderr, "unknown --session-kind '%s' "
                        "(expected 'skirmish' or 'persistent')\n", spec.c_str());
                return 1;
            }
        } else if (arg == "--war-side-capacity" && i + 1 < argc) {
            const std::string spec = argv[++i];
            // Refused rather than defaulted, for the same reason
            // --session-kind is: a typo that silently became "unlimited" or
            // "8" would only show up as players being admitted to, or turned
            // away from, a war for no visible reason. `0` is a legitimate
            // value meaning unlimited; a negative or non-numeric one is not.
            if (spec.empty() ||
                spec.find_first_not_of("0123456789") != std::string::npos) {
                fprintf(stderr, "invalid --war-side-capacity '%s' "
                        "(expected a non-negative integer; 0 = unlimited)\n",
                        spec.c_str());
                return 1;
            }
            warSideCapacity = static_cast<unsigned>(std::strtoul(
                spec.c_str(), nullptr, 10));
        } else if (arg == "--player-slots" && i + 1 < argc) {
            const std::string spec = argv[++i];
            // Refused rather than defaulted, exactly like --war-side-capacity
            // above: a typo here sizes the war's player arrays wrong, and the
            // symptom (a joiner the lobby already promised a seat being seated
            // as a spectator instead) surfaces hours later at somebody else's
            // keyboard. `0` legitimately means "not sized".
            if (spec.empty() ||
                spec.find_first_not_of("0123456789") != std::string::npos) {
                fprintf(stderr, "invalid --player-slots '%s' "
                        "(expected a non-negative integer; 0 = not sized)\n",
                        spec.c_str());
                return 1;
            }
            playerSlotCap = static_cast<unsigned>(std::strtoul(
                spec.c_str(), nullptr, 10));
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
        } else if (arg == "--resume") {
            resumeRequested = true;
        } else if (arg == "--resume-verify") {
            resumeVerifyRequested = true;
        } else if (arg == "--no-hibernate") {
            hibernationEnabled = false;
        } else if (arg == "--hibernate-idle-seconds" && i + 1 < argc) {
            hibernateIdleSeconds = std::atoi(argv[++i]);
        } else if (arg == "--headless-run" && i + 1 < argc) {
            headlessConfigPath = argv[++i];
        } else if (arg == "--max-wall-min" && i + 1 < argc) {
            maxWallMin = std::atoi(argv[++i]);
        } else if (arg == "--snapshot-roundtrip" && i + 1 < argc) {
            std::string sperr;
            if (!snapshotrt::ParseSpec(argv[++i], roundTripCfg, sperr)) {
                SLOG(SPRING_LOG_ERROR, "--snapshot-roundtrip: %s", sperr.c_str());
                return 1;
            }
        } else if (arg == "--roundtrip-strict") {
            // PLAN-persistence Q-P2: the pre-decision bar, kept because it is
            // the bar a fixture with nothing under a move order can still hold
            // — and the one option A would restore for every fixture.
            roundTripCfg.strict = true;
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

    // --- Snapshot round-trip: ride the headless substrate (PLAN-persistence §8) ---
    // Same arrangement --replay uses. Uncapped, because the run is a batch
    // comparison nobody watches. NO frame stop condition: the controller ends
    // the run itself once both arms have been walked, and setting one would
    // stop the process in the middle of arm A. The stop conditions that ARE
    // set are the two ways the comparison can never complete — the wall
    // ceiling, and a game that declares over (which freezes the sim, so no
    // further tick would ever arrive).
    if (roundTripCfg.enabled) {
        headlessCfg.enabled = true;
        headlessCfg.maxWallSec = static_cast<int64_t>(std::max(1, maxWallMin)) * 60;
        headlessCfg.tickMode = headless::TickMode::Uncapped;
        headlessCfg.stopAt.gameOver = true;
        SLOG(SPRING_LOG_NOTICE,
            "snapshot round-trip: checkpoint at frame %lld, %lld ticks per arm, "
            "%s bar",
            (long long)roundTripCfg.atFrame, (long long)roundTripCfg.ticks,
            roundTripCfg.strict ? "strict (hash + payload identity)"
                                : "world (roster + vitals, movement measured)");
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
    // --resume brings a world up out of the store; a replay re-executes one
    // from a recorded input stream and the round-trip harness builds its own.
    // Each combination is a request for two different worlds in one process,
    // and there is no honest way to pick — refuse rather than let one quietly
    // overwrite the other (PLAN-persistence task 3a).
    if (resumeRequested && (!replayFilePath.empty() || roundTripCfg.enabled)) {
        SLOG(SPRING_LOG_ERROR,
            "--resume is mutually exclusive with --replay and "
            "--snapshot-roundtrip: each of them supplies the world, and this "
            "invocation asks for two");
        return 1;
    }
    if (resumeVerifyRequested && !resumeRequested) {
        SLOG(SPRING_LOG_ERROR,
            "--resume-verify requires --resume: it verifies the world a "
            "resume just applied, and this boot is not resuming one");
        return 1;
    }

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
    // PLAN-metalstorm-lobby.md §2.5/§5.1 (task 4): the account↔war seat table
    // and its per-player war state. Created from BOTH processes — the game
    // server is the writer, but a lobby that has never launched a war still
    // reads it (the faction override clears bindings, task 6's browser counts
    // them), and neither may depend on the other having started first.
    WarPlayerBindings::EnsureTable(db.Handle());
    // PLAN-persistence.md §4 (task 4b): the war's strategic history, appended
    // here and read by the lobby as the while-you-were-away digest. Same
    // both-processes rule as the bindings table above, and the same durability
    // rule — it is the only copy of what happened in a war.
    GameEventsDb::EnsureTable(db.Handle());
    // war_outcome — the durable record of how this war ended (wars §7, task
    // 4). Created here beside game_events for the same reason: both are
    // written by THIS process and read by the lobby, and both must exist
    // before the first write rather than on the lobby's schedule.
    WarOutcomeDb::EnsureTable(db.Handle());
    // room_runtime_ai — the AI seats this war takes on WHILE running (task
    // 4(b)'s open thread, RuntimeAIRoster.h). Written and read here; the lobby
    // only deletes it with the room. Created unconditionally for the same
    // reason as the two above: a scenario/direct boot may be the first process
    // to touch this database, and the seat happens mid-war, long after any
    // point where a failed prepare could still be noticed.
    RuntimeAIRoster::EnsureTable(db.Handle());
    // Task 8a, and for the same reason: the game server VALIDATES per-war
    // reconnect tokens (the lobby mints them), so it must find the table even
    // on a machine where no lobby has ever run — a scenario/direct boot brings
    // this process up on its own.
    AuthTokens::EnsureTables(db.Handle());

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

    // PLAN-metalstorm-wars.md §8.1: which side each pre-allocated player slot
    // belongs to. Empty until the `--player-slots` block below fills it (and
    // permanently empty for every session that was not sized), so "is this a
    // reserved number" and "reserve nothing" are the same question.
    playerslots::ReservedPlayerSlots reservedSlots;

    // PLAN-quickstart.md §3.3: reason carried by a client's PlayerLeaveIntent
    // (sent just before disconnect), consumed once when the disconnect drains.
    std::unordered_map<ClientID, uint8_t> pendingLeaveReason;

    // GameStart is deferred until all roster players have connected and
    // registered CPlayers (matches real Spring's "all clients loaded" gate).
    std::unordered_set<std::string> connectedRosterPlayers;
    const size_t rosterPlayersNeeded = requestedPlayers.size();

    // ...unless this is a persistent war, which never waits for its roster
    // (PLAN-metalstorm-lobby.md §2.1). The count above stays the true roster
    // size — it is what the team mapping and the logs read; only the *gate*
    // is session-kind dependent, so a war that happens to launch with a seed
    // roster still reports it honestly.
    const bool waitsForRoster = SessionWaitsForRoster(sessionKind);
    // The one expression both GameStart sites branch on: with no roster to
    // wait for, or no waiting to do, the game starts during set-up rather
    // than from CheckAndFireGameStart in the loop.
    const bool startsGameAtSetup =
        SessionStartsGameAtSetup(sessionKind, rosterPlayersNeeded);

    // C1: per-client handshake gate. A client must send a protocol-compatible
    // Handshake before its AuthRequest is honoured.
    std::unordered_set<ClientID> handshakedClients;

    // GameServerContext wires the long-lived objects to the extracted units.
    // Bound here, after all of net/rtcServer/sim/db/sessions/rooms/aiPool/
    // luaExecEngine are declared; defsCacheKey is assigned after the def-cache
    // bake below.
    GameServerContext ctx{
        net, rtcServer, sim, db, sessions, rooms, aiPool, luaExecEngine,
        evalBroker,
        roomId, gameId, mapId, port, logMessages, /*defsCacheKey=*/std::string{},
        requestedPlayers, requestedAIs, playerTeamByUsername,
        clientPlayerNum, pendingLeaveReason, nextPlayerNum, playerNumByAccount,
        connectedRosterPlayers,
        rosterPlayersNeeded, waitsForRoster, sessionKind, warSideCapacity,
        handshakedClients, reservedSlots,
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
    // One recipe, two readers: the same call answers `--print-engine-hash`
    // above, which is what the lobby probes to apply the E1 policy before it
    // forks (PLAN-persistence task 3c / EngineIdentity.h).
    snapCfg.engineHash = engineid::StampHash(SPRING_BUILD_STAMP);
    gamestate::GameStateStore gmSnapshotStore(db.Handle(), snapCfg);

    // PLAN-persistence task 1b: the ISimSerializer walk (Q-P1 option B). It is
    // attached only when its section table has no declared gap left AND the
    // game's own gadgets are all snapshottable — an attached-but-incomplete
    // serializer would flip Available() to true and tell the GM surface that
    // rollback works while every checkpoint it takes omits state.
    //
    // The decision is NOT taken here: the second half of it needs the synced
    // Lua state, which sim.Init() has not built yet. See AttachSimSerializer
    // below, called straight after sim.Init.
    static simsnapshot::SimSnapshotSerializer simSerializer;

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
                // The AI verb, spelled out. `subKind` alone made every AI
                // record indistinguishable on this route, which is the one
                // place a live run's cause stream is readable — and the
                // ai.intent-before-its-directive ordering (SG1 §2.5) is a
                // property of the stream, not of any single record.
                if (r.kind == syncedinput::InputKind::AICommand)
                    o["verb"] = AICommandKindName(static_cast<AICommandKind>(r.subKind));
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

    // --- Attach the snapshot serializer (PLAN-persistence tasks 1b/1c/1d/1e) ---
    //
    // Deliberately after sim.Init: the second gate reads the LIVE gadget
    // handler. A table of gadget names compiled into the engine could not
    // answer "does every gadget this game loaded have Save and Load", and that
    // question is exactly as load-bearing as "is every section implemented" —
    // a missing gadget is synced state a checkpoint drops without saying so.
    {
        const std::vector<std::string> missing = simsnapshot::MissingSections();
        // Asked unconditionally, and logged even while the walk is incomplete:
        // the gadget ledger is the list of work task 1d-b has to do, and an
        // operator (or the next fire) should be able to read it off a boot log
        // rather than infer it. Also the only place the question is asked on a
        // real game, since a doctest has no gadget handler.
        std::string coverageErr;
        const std::vector<std::string> luaGaps =
            simsnapshot::SyncedLuaCoverageGaps(coverageErr);

        const auto join = [](const std::vector<std::string>& v) {
            std::string s;
            for (size_t i = 0; i < v.size(); ++i) s += (i ? ", " : "") + v[i];
            return s;
        };

        if (coverageErr.empty()) {
            SLOG(SPRING_LOG_NOTICE,
                 "sim snapshots: synced Lua coverage - %zu gadget(s) with no "
                 "Save/Load pair%s%s",
                 luaGaps.size(),
                 luaGaps.empty() ? "" : ": ",
                 luaGaps.empty() ? "" : join(luaGaps).c_str());
        }

        if (!missing.empty()) {
            // FIDELITY-STANDIN: the snapshot walk is partial. Per the
            // code-session contract every capability gap gets a one-time
            // runtime warn naming it, so an operator who wonders why rollback
            // refuses reads the answer here instead of in a plan file.
            SLOG(SPRING_LOG_WARNING,
                 "sim snapshots: DISABLED - the serializer's walk is incomplete "
                 "(unimplemented sections: %s). Checkpoint/rollback refuse until "
                 "every declared section is written; the section table's own "
                 "note says which milestone owns each gap.", join(missing).c_str());
        } else if (!coverageErr.empty()) {
            SLOG(SPRING_LOG_WARNING,
                 "sim snapshots: DISABLED - cannot establish synced Lua "
                 "coverage (%s). Checkpoint/rollback refuse rather than take a "
                 "snapshot with unknown gadget coverage.", coverageErr.c_str());
        } else if (!luaGaps.empty()) {
            // FIDELITY-STANDIN: gadget state that no Save/Load pair covers.
            SLOG(SPRING_LOG_WARNING,
                 "sim snapshots: DISABLED - these gadgets implement neither "
                 "Save nor Load and do not declare themselves stateless: %s. "
                 "Their state would vanish on resume (PLAN-persistence §7.1d).",
                 join(luaGaps).c_str());
        } else {
            gmSnapshotStore.SetSerializer(&simSerializer);
            SLOG(SPRING_LOG_NOTICE,
                 "sim snapshots: serializer attached (layout %016llx)",
                 (unsigned long long)simSerializer.LayoutHash());
        }
    }

    // The round-trip has nothing to compare unless the walk is complete — and
    // an incomplete walk is exactly the state in which a run that "passed"
    // would be most misleading, because a section that captures nothing also
    // restores nothing and therefore never diverges. Refuse at boot, naming
    // the same refusal the attach gate just logged.
    snapshotrt::Controller roundTrip;
    int roundTripExitCode = 0;
    if (roundTripCfg.enabled) {
        if (gmSnapshotStore.Serializer() == nullptr) {
            SLOG(SPRING_LOG_ERROR,
                "--snapshot-roundtrip: no sim serializer is attached (see the "
                "'sim snapshots: DISABLED' line above) — there is nothing to "
                "round-trip, and an incomplete walk would pass this test by "
                "capturing nothing");
            return 1;
        }
        roundTrip.Configure(roundTripCfg);
    }

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

    // PLAN-def-reconciliation task 1: the snapshot store can only stamp the
    // defs it is told about, and this is the first moment in boot where that
    // fact exists — the store was constructed ~400 lines above, before
    // sim.Init() had parsed a single def. Empty (a failed bake) stamps 0,
    // "not recorded", which is exactly what it is.
    gmSnapshotStore.SetDefsHash(defsCacheKey);
    // Logged, because otherwise the only surface this wiring has is a column
    // in a row that a headless run never writes: `hibernate: no exit
    // checkpoint (headless-run)`. A stamp of 0 here is the honest report that
    // the bake failed and every snapshot this process takes will say
    // "vocabulary not recorded".
    SLOG(SPRING_LOG_NOTICE, "snapshots: defs vocabulary key=%s -> defsHash %016llx",
         defsCacheKey.empty() ? "(none)" : defsCacheKey.c_str(),
         (unsigned long long)gmSnapshotStore.DefsHash());

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
        // The one identity field in this header that is EXACT and enforced
        // (PLAN-protocol-guard task 7). engineHash above is a stand-in nobody
        // acts on; this is the sha256 of the binary wire schema the records
        // below are encoded against, and `Player::Load` refuses a file whose
        // stamp does not match the replaying build — see ReplayCompatPolicy.h.
        rhdr.schemaHash   = Protocol::SCHEMA_HASH;
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
    // The wire frame carries an envelope byte ahead of the FlatBuffer, and this
    // peek used to verify the buffer WITH it attached — so it read NONE for
    // every valid message and the replay gate below refused nothing (found
    // 2026-08-14 by pointing the scripted wire client at a replay server: a
    // spectator's PlayerCommand reached HandleMessage and was journaled). One
    // decoder now, `Protocol::PeekClientPayloadType`, shared with the handler.
    auto PeekClientPayloadType = [](const InboundMessage& m) -> uint8_t {
        return wireframe::PeekClientPayloadType(m.data.data(), m.data.size());
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
                    // The synced half, which `eventHandler` does not carry —
                    // see the live drain below and PlayerOnboarding.h. Without
                    // this the replay's leaver keeps a pool the recording had
                    // already merged back into the team.
                    FireSyncedPlayerRemoved(r.playerId, r.subKind);
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

    // --- Player-slot pre-allocation (PLAN-metalstorm-wars.md §8.1, task 5) ---
    //
    // The war was sized by the War Director before this process existed: Σ
    // slotCap arrived as `--player-slots`, and `wars.spawned_slot_cap` records
    // the same number so a dynamic joiner can be told what the running server
    // was sized FOR (task 2's field note: the live per-side caps may be raised
    // after boot, and a raise past this block is a promise nobody can keep).
    // Materialising the block here means the arrays are sized for the WAR, not
    // for the roster this process happened to boot with — the assertion §10's
    // integration row makes.
    //
    // Placed immediately BEFORE the AI virtual players, and that ordering is
    // the point: every player number minted after this — AI, spectator,
    // off-side roster player — is numbered ABOVE the block, so the war's own
    // seats can never be spent by somebody who came to watch.
    {
        const auto& opts = CGameSetup::GetModOptions();
        const auto wsIt = opts.find("war_sides");
        const WarSides sides =
            (wsIt != opts.end()) ? ParseWarSides(wsIt->second) : WarSides{};
        const auto wcIt = opts.find("war_side_capacities");
        const WarSideCapacities caps =
            (wcIt != opts.end()) ? ParseWarSideCapacities(wcIt->second)
                                 : WarSideCapacities{};

        // No `--player-slots`, but the modoptions describe a war with finite
        // sides: size it from those. The lobby computes the flag from exactly
        // these two modoptions, so the derived number is the same number — and
        // deriving it means the sizing survives every launcher that does not
        // pass the flag. Two of those matter:
        //   * a REPLAY, which is re-executed with map/game/modoptions/roster
        //     out of its own header and no world-describing arguments at all
        //     (see spawnGameServer). Without the block the re-execution would
        //     allocate a war's first joiner off the top of the list and stop on
        //     the player-number divergence check, which is to say every war
        //     recording containing a join would be unplayable.
        //   * a bare `spring-server --game … --map …` self-test, and any
        //     direct-start manifest that declares sides.
        // An explicit flag still wins: it is what the process was SPAWNED with
        // (`wars.spawned_slot_cap`), and after task 2's maintenance pass raises
        // a side the two deliberately stop agreeing.
        if (playerSlotCap == 0) {
            playerSlotCap =
                playerslots::TotalSlotCap(sides, caps, warSideCapacity);
            if (playerSlotCap > 0)
                SLOG(SPRING_LOG_NOTICE,
                     "no --player-slots given; sizing from the war's own sides "
                     "(Σ slotCap %u)", playerSlotCap);
        }

        // 0 = not sized — a skirmish, a legacy room, or a war with an unlimited
        // side. The player list grows on demand exactly as it always has, and
        // `ctx.reservedSlots` stays empty, which every reader treats as
        // "there is no block; allocate the next free number".
        if (playerSlotCap > 0) {
            unsigned slots = playerSlotCap;
            // MAX_PLAYERS is a hard ceiling on the vector whose own header
            // forbids reallocating it, so an over-large request is clamped
            // here — loudly. Refusing to boot instead would strand a war the
            // lobby has already written rows for; clamping seats as many as
            // the engine can hold and says exactly how many it could not.
            if (slots > static_cast<unsigned>(MAX_PLAYERS)) {
                SLOG(SPRING_LOG_WARNING,
                     "player-slot cap %u exceeds MAX_PLAYERS (%d) — reserving "
                     "%d; %u advertised seat(s) have no player number",
                     slots, MAX_PLAYERS, MAX_PLAYERS,
                     slots - static_cast<unsigned>(MAX_PLAYERS));
                slots = static_cast<unsigned>(MAX_PLAYERS);
            }

            reservedSlots = playerslots::PlanReservedSlots(slots, sides, caps,
                                                           warSideCapacity);
            playerHandler.ReserveSlots(static_cast<int>(slots),
                                       reservedSlots.teamOfSlot);
            nextPlayerNum = static_cast<int>(slots);

            std::string layout;
            for (const auto& [faction, team] : sides) {
                if (!layout.empty()) layout += ", ";
                layout += faction + "→team " + std::to_string(team) + " ×" +
                          std::to_string(reservedSlots.CountFor(
                              static_cast<int>(team)));
            }
            if (layout.empty())
                layout = "no sides declared — every slot unassigned";
            SLOG(SPRING_LOG_NOTICE,
                 "pre-allocated %u player slot(s) for this war's Σ slotCap "
                 "(%s); player numbers from %d up are AI, spectators and "
                 "off-side seats",
                 slots, layout.c_str(), nextPlayerNum);
        }
    }

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

    // No roster means no players to wait for (dev mode) — and so does a
    // persistent war, which has a roster but does not wait for it.
    //
    // A replay never takes this path, in EITHER roster shape. GameStart is an
    // input in its own right (journal chokepoint #5) and its position in the
    // stream is what every later record is relative to: fire it early and the
    // pre-game prologue lands on a started sim, fire it late and the opening
    // frames run without a roster. So under --replay the GameStart RECORD is
    // the only thing that starts the game — see the feed below.
    //
    // WHERE the prologue is fed depends on the roster shape, and the condition
    // below is deliberately the SAME `startsGameAtSetup` test the live run
    // branched on (PLAN-replay T2-a). A recording with no human roster
    // fired GameStart right here during set-up, so its prologue belongs here.
    // A recording WITH a roster did not: it fired GameStart from
    // CheckAndFireGameStart in the loop, once the last human authenticated —
    // which is after the AI slot resolution just above. Sweeping such a
    // prologue here would authenticate the humans *before* the AI virtual
    // players exist, so GameStart's leader pass would run over a different
    // player set and every team leader could land on a different player than
    // the recording had. That is caught by the GameStart record's own roster
    // check, but the fix is to feed at the right place, not to detect it.
    //
    // `startsGameAtSetup` now has a second input — the session kind — and the
    // replay header does not carry one, so a replay always evaluates it as a
    // skirmish. That is only lossy for a recording of a persistent war WITH a
    // roster, which is the one shape that also depends on T2-a (human-player
    // replay) and does not replay today for that reason; every shape that
    // replays now evaluates identically before and after this change. See
    // PLAN-metalstorm-lobby.md task 1's field notes.
    if (replay::IsReplaying() && startsGameAtSetup) {
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
    } else if (startsGameAtSetup) {
        if (waitsForRoster) {
            SLOG(SPRING_LOG_NOTICE,
                "no player roster (dev mode), firing GameStart immediately");
        } else {
            SLOG(SPRING_LOG_NOTICE,
                "persistent war: firing GameStart immediately, %zu roster "
                "player(s) will be joined as they connect", rosterPlayersNeeded);
        }
        // The journal's tick window has never been opened at this point (the
        // sim loop below is what calls BeginTick), so without this the
        // GameStart record — the anchor the entire stream is positioned
        // against — would be stamped with the Recorder's default frame 0 while
        // every other pre-game record carries the true pre-game frame of -1.
        // A replay would then look for the anchor at a frame it never visits.
        syncedinput::Journal().BeginTick(sim.GetFrameNum());
        sim.FireGameStart();
    }

    // --- Resume (PLAN-persistence task 3a) ---
    //
    // HERE, and not earlier, for two reasons that are both about applying a
    // world over a world rather than into a vacuum:
    //
    //  (a) The snapshot's `syncedLua` section calls each gadget's Load, and
    //      `units`/`features` tear down and rebuild the roster through
    //      UnitDestroyed/UnitCreated. Both need the gadget handler up and
    //      GameStart already fired — the same ordering task 1d found the hard
    //      way and wrote into ApplySyncedLua's placement.
    //  (b) Staging runs first and is then REPLACED, which looks wasteful and
    //      is the point: `game_scenario.lua` builds a complete, legal world
    //      out of the same defs the snapshot names, so the apply lands on the
    //      shape it was captured from. This is exactly the path
    //      --snapshot-roundtrip exercises 100 times a run (restore over a
    //      live world, byte-identical re-capture), rather than a second,
    //      untested "restore into an empty sim" path.
    //
    // And before the loop, so no client ever sees the staged world: the sim
    // has not ticked and nothing is being streamed yet.
    if (resumeRequested) {
        struct StoreResumeSource : hibernate::IResumeSource {
            gamestate::GameStateStore* store = nullptr;
            bool Available() const override { return store->Available(); }
            int32_t NewestFrame(uint32_t r) override { return store->NewestFrame(r); }
            bool RestoreNewestValid(uint32_t r, std::string& e, int32_t& f) override {
                return store->RestoreNewestValid(r, e, f);
            }
        } resumeSrc;
        resumeSrc.store = &gmSnapshotStore;
        // `--resume-verify` needs the exact bytes the restore applies, so ask
        // the store to keep them before it runs (GameStateStore.h).
        if (resumeVerifyRequested)
            gmSnapshotStore.RetainRestoredPayload(true);

        hibernate::ResumeRequest rq;
        rq.requested = true;
        rq.startsGameAtSetup = startsGameAtSetup;
        const hibernate::ResumeOutcome ro = hibernate::DoResume(resumeSrc, roomId, rq);

        if (ro.fatal) {
            // No half-resume, and no quiet fresh start. The lobby respawned
            // this process to hand rejoining players the world it told them
            // was frozen at frame N; coming up empty while publishing
            // game_status.ready replaces their war with a new match and
            // nothing in the system would ever say so.
            SLOG(SPRING_LOG_ERROR, "%s", hibernate::FormatResume(ro).c_str());
            return 1;
        }
        springlog_set_frame(sim.GetFrameNum());
        SLOG(SPRING_LOG_NOTICE, "room %u %s", roomId,
             hibernate::FormatResume(ro).c_str());
        // The world is back. Its AI seats are not — see the restore call below,
        // which has to wait for ctx.aiSpawnEnv (the plugin roots) to be filled.
        resumedWorld = true;

        // --- `--resume-verify` (PLAN-persistence §8, ResumeVerify.h) ---
        // Re-capture the world exactly as the resume left it — before the
        // first tick, before AI seats respawn, before any client can connect
        // — and byte-compare with the payload the resume applied. The verdict
        // is this boot's whole product: serving on would let the harness's
        // own SIGTERM write a checkpoint over the row it just verified, so
        // the process exits either way. The LOG LINE is the harness's gate,
        // not the exit code — a debug build aborts in static destructors on
        // every exit (PLAN-replay T5-c).
        if (resumeVerifyRequested) {
            std::vector<uint8_t> recap;
            std::string verr;
            gamestate::ISimSerializer* ser = gmSnapshotStore.Serializer();
            if (ser == nullptr || !ser->Serialize(recap, verr)) {
                SLOG(SPRING_LOG_ERROR,
                     "resume verify: re-capture FAILED — %s",
                     verr.empty() ? "no serializer attached" : verr.c_str());
                return 1;
            }
            const resumeverify::Verdict v = resumeverify::Compare(
                gmSnapshotStore.LastRestoredPayload(), recap);
            const std::string line = resumeverify::Format(v, ro.frame);
            if (v.identical) {
                SLOG(SPRING_LOG_NOTICE, "%s", line.c_str());
                return 0;
            }
            SLOG(SPRING_LOG_ERROR, "%s", line.c_str());
            return 1;
        }
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
    // The roots BOTH staging paths read: this block, and the mid-game
    // caretaker spawn (task 4(b), AISpawn.h). Filled unconditionally — a game
    // that starts with no AI slot at all is exactly the game the caretaker
    // hook exists for, so the env must not be gated on `requestedAIs`.
    ctx.aiSpawnEnv.enginePath = "content/engine";
    ctx.aiSpawnEnv.gamePath   = gamePath;
    ctx.aiSpawnEnv.mapDataDir = mapPath;
    ctx.aiSpawnEnv.defExportDir = defsCacheKey.empty()
        ? std::string()
        : DefsCache::CacheDir(gameId, defsCacheKey);

    // A resumed war brings back the AI seats it acquired while it was running
    // (RuntimeAIRoster.h, PLAN-metalstorm-ai task 4(b)'s open thread). Here and
    // not in the resume block above: the restore resolves plugins through the
    // same roots the two other staging paths use, and those roots are the four
    // lines directly above. Before the `--ai` loop so the operator log reads in
    // seating order — the pre-freeze seats, then this launch's slots.
    if (resumedWorld)
        RestoreRuntimeAISeats(ctx);

    if (!requestedAIs.empty()) {
        for (const auto& rq : requestedAIs) {
            // Same resolver the runtime spawn uses (AISpawn.h): one set of
            // rules for "which plugin is this id", so an AI the lobby can seat
            // at frame 0 is an AI the caretaker hook can seat at frame N.
            ResolvedAIPlugin plugin;
            std::string resolveErr;
            if (!ResolveAIPlugin(ctx.aiSpawnEnv.enginePath,
                                 ctx.aiSpawnEnv.gamePath, rq.id, plugin,
                                 resolveErr)) {
                SLOG(SPRING_LOG_WARNING, "--ai %s:%d: %s, skipping",
                    rq.id.c_str(), rq.team, resolveErr.c_str());
                continue;
            }

            // Classic Spring "LuaAI" entries (e.g. ZK's CAI / CAI2)
            // have no standalone runtime — the AI logic lives inside
            // the game's synced LuaRules gadgets, which dispatch on
            // `Spring.GetTeamLuaAI(teamId)`. The roster entry pushed
            // earlier already populates that map, so there's nothing
            // for AIRuntimePool to do.
            if (plugin.isLuaAI) {
                SLOG(SPRING_LOG_NOTICE,
                    "registered LuaAI '%s' on team %d (handled by game gadgets)",
                    plugin.displayName.c_str(), rq.team);
                continue;
            }

            const std::string& code = plugin.code;

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
            if (aiPool.AddAI(plugin.id, rq.team, allyTeam, code,
                             plugin.folderPath, ctx.aiSpawnEnv.mapDataDir,
                             ctx.aiSpawnEnv.defExportDir, rq.playerNum)) {
                SLOG(SPRING_LOG_NOTICE,
                    "loaded AI '%s' (%s) on team %d",
                    plugin.displayName.c_str(), plugin.id.c_str(), rq.team);
            } else {
                SLOG(SPRING_LOG_ERROR,
                    "failed to init AI '%s' on team %d",
                    plugin.id.c_str(), rq.team);
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
    // A persistent war is never idle-reaped regardless of what the `rooms`
    // row says (PLAN-metalstorm-lobby.md §5.3: a war with zero connected
    // humans keeps running). The lobby sets both, so this only matters for a
    // server launched by hand or by a harness with no room row to read — but
    // "the war exited because everyone stepped away" is exactly the failure
    // the session kind exists to prevent.
    bool roomPersistent = (sessionKind == SessionKind::PersistentWar);
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
            // |=, not =: the session kind may already have set it, and the
            // db row must not be able to un-say that.
            if (sqlite3_step(ps) == SQLITE_ROW)
                roomPersistent |= (sqlite3_column_int(ps, 0) != 0);
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
        // war_summary — the per-war digest the war browser reads
        // (PLAN-metalstorm-lobby.md §4, task 6). Same rendezvous discipline as
        // game_status above: this process is the only writer, the lobby only
        // reads, and the row deliberately OUTLIVES the process (task 3's
        // kill-and-resume) with `updated_at` telling the reader which it has.
        sqlite3_exec(statusDb,
            "CREATE TABLE IF NOT EXISTS war_summary ("
            " room_id INTEGER PRIMARY KEY,"
            " summary_json TEXT NOT NULL DEFAULT '',"
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
    /// Last war-state sweep (task 4). Wall-clock like the heartbeat above,
    /// not frame-based: what it protects against is the process dying, which
    /// is not something the sim frame counter has an opinion about.
    auto lastWarStateSweep = serverStartTime;
    // ── The war-summary digest (PLAN-metalstorm-lobby.md §4, task 6) ───────
    // Everything the war browser wants that only the sim knows: who is
    // actually seated on each side, who is watching, and who is winning. The
    // lobby owns the durable half (bindings, capacity, the seating promise)
    // and deliberately does not read it from here — a war whose server is
    // down still has to list, which is exactly what task 3 made possible.
    //
    // Written on the same 2s heartbeat as game_status rather than on a sim
    // cadence: it is a wall-clock promise to somebody looking at a browser,
    // and a paused war still has to say who is in it.
    //
    // Prepared, not snprintf'd like writeGameStatus above: this row carries
    // JSON, and the only reason the status row can get away with a formatted
    // string is that every one of its fields is an integer.
    auto writeWarSummary = [&]() {
        if (!statusDb) return;
        if (sessionKind != SessionKind::PersistentWar) return;
        // A replay re-executes a recording; its "population" is the cast of a
        // file, and publishing it would list a recording in the war browser
        // as a joinable war.
        if (replay::IsReplaying()) return;
        const auto& opts = CGameSetup::GetModOptions();
        const auto wsIt = opts.find("war_sides");
        const WarSides sides =
            (wsIt != opts.end()) ? ParseWarSides(wsIt->second) : WarSides{};
        const int64_t upSec = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - serverStartTime).count();
        const std::string json = EncodeWarSummary(BuildWarSummary(
            sides, GatherWarSummaryPlayers(), GatherWarSummaryRegions(),
            sim.GetFrameNum(), upSec, GatherWarFootholds(sides),
            GatherWarStakes()));

        // The war's ENDING (PLAN-metalstorm-wars.md §7, task 4) — a separate,
        // DURABLE row, not a field on this one. `war_summary` is deliberately
        // perishable (the lobby drops it after kWarSummaryStaleSec so a killed
        // server stops claiming players are online), and this process EXITS a
        // few minutes after declaring the result by design (§7.2's
        // --postgame-exit-seconds). Carried here, the fact that the war was
        // won would evaporate half a minute later.
        //
        // Written on every heartbeat while the war is over rather than once at
        // the declaration: `Record` replaces on room_id, and a one-shot would
        // be lost by any failure between the declaration and the commit — of
        // which the process's own scheduled exit is one.
        if (WarOutcomeRecord outcome; GatherWarOutcome(sides, outcome)) {
            outcome.roomId = roomId;
            outcome.recordedAt = static_cast<int64_t>(std::time(nullptr));
            WarOutcomeDb::Record(db.Handle(), outcome);
        }
        sqlite3_stmt* st = nullptr;
        if (sqlite3_prepare_v2(statusDb,
                "INSERT OR REPLACE INTO war_summary"
                " (room_id, summary_json, updated_at)"
                " VALUES (?, ?, strftime('%s','now'))",
                -1, &st, nullptr) != SQLITE_OK) {
            sqlite3_finalize(st);
            return;
        }
        sqlite3_bind_int(st, 1, static_cast<int>(roomId));
        sqlite3_bind_text(st, 2, json.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_step(st);
        sqlite3_finalize(st);
    };

    // ── The strategic event drain (PLAN-persistence §4, task 4b) ──────────
    // `game_warlog.lua` keeps the last 32 strategic events in a rulesParam
    // ring; this moves them into `game_events`, which is the durable record a
    // returning player's digest is built from.
    //
    // The watermark is recovered from the TABLE, not started at zero. The
    // gadget's seq rides the snapshot, so a war that comes back from
    // hibernation resumes counting where it left off — a fresh cursor would
    // re-offer its whole surviving ring as new (the INSERT OR IGNORE would
    // absorb it, but the elision arithmetic would then be reading a gap that
    // is not there and would file a loss that never happened).
    int64_t warLogWatermark = GameEventsDb::HighestSeq(db.Handle(), roomId);
    auto drainWarLog = [&]() {
        if (sessionKind != SessionKind::PersistentWar) return;
        // A replay re-emits the recorded war's events as it re-executes it.
        // Appending them would write a second copy of a history that is
        // already in the table under the same room id and the same seqs.
        if (replay::IsReplaying()) return;
        const warlog::DrainResult d = DrainWarLog(warLogWatermark);
        if (d.watermark == warLogWatermark) return;
        if (!d.events.empty()) {
            GameEventsDb::Append(db.Handle(), roomId, d.events,
                                 static_cast<int64_t>(std::time(nullptr)));
            GameEventsDb::Prune(db.Handle(), roomId);
        }
        // Advance only AFTER the write. A drain that read the ring and then
        // failed to store it must re-offer those events on the next
        // heartbeat; the table's UNIQUE makes the repeat a no-op when the
        // write did in fact land.
        warLogWatermark = d.watermark;
        if (d.elided > 0) {
            SLOG(SPRING_LOG_WARNING,
                "war log: %lld strategic event(s) were overwritten before the "
                "drain reached them (room %u, ring lapped between heartbeats) "
                "— the digest records the gap rather than hiding it",
                static_cast<long long>(d.elided), roomId);
        }
    };

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

    // PLAN-persistence task 3a: why this process is about to stop. Every site
    // that clears `keepRunning` from inside the loop names its reason here;
    // the signal handlers cannot (they run on a signal stack and set only the
    // atomic), so Signal is the default and the residue. The exit-checkpoint
    // decision below is a pure function of this plus the world's state.
    hibernate::ExitReason exitReason = hibernate::ExitReason::Signal;
    /// One-shot latch for the "idle, but the war is still settling" line
    /// (wars task 4, D1). The condition holds for every pass of the wind-down,
    /// and the log is where an operator looks for the resolve it precedes.
    bool hibernateDeferLogged = false;

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
                // Same heartbeat, same reason: both are liveness the lobby
                // reads, and splitting their cadences would let the browser
                // show a war as up with a population from a minute ago.
                writeWarSummary();
                // Same heartbeat again, and it must not be slower: the ring
                // holds 32 events, so the drain's safety margin is measured
                // in "how many strategic events can this war produce between
                // two of these calls".
                drainWarLog();
            }
            // ── War state, on a cadence as well as on disconnect (task 4) ──
            // (PLAN-metalstorm-lobby.md §2.5.) The disconnect capture is the
            // accurate one — it runs on the last frame the player owned their
            // pool. It is also the one that never runs when the process dies
            // without draining a disconnect, which is precisely task 3's
            // tested case: `kill -9` on a war's server leaves the room Active
            // and the next joiner resumes it. Without this sweep, every
            // connected player's state at that instant would be whatever they
            // last disconnected with — for a player who has been online since
            // the war started, nothing at all.
            //
            // One UPDATE per seated human per minute; a war with eight players
            // a side writes sixteen rows a minute, which is below the metrics
            // writer's own cadence and far below the 2s status heartbeat.
            if (sessionKind == SessionKind::PersistentWar &&
                !replay::IsReplaying() &&
                wall - lastWarStateSweep >= std::chrono::seconds(60)) {
                lastWarStateSweep = wall;
                for (const auto& [dcId, pNum] : clientPlayerNum) {
                    const auto* s = sessions.GetSession(dcId);
                    if (s == nullptr || s->team < 0) continue;
                    WarPlayerBindings::SaveState(
                        db.Handle(), roomId, s->userId,
                        CaptureWarPlayerState(s->team, pNum),
                        static_cast<int64_t>(std::time(nullptr)));
                }
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
                    exitReason = hibernate::ExitReason::Idle;
                    keepRunning.store(false);
                }
            }
            // Hibernation (PLAN-persistence task 3a): the PERSISTENT-room
            // counterpart. A war that nobody is in costs a whole process and
            // a port to simulate nothing; §3 turns that into a DB row. The
            // exit path below checkpoints it, so the world is frozen rather
            // than lost — but only when the operator has switched the window
            // on, because a room that exits is unjoinable until the lobby
            // learns to respawn it with --resume (task 3b). Default 0 = off.
            //
            // The decision itself is `hibernate::DecideIdleHibernate` — pure,
            // and it carries one input this loop cannot see from its own
            // timers: the WAR's state. A declared war spends 300 frames
            // settling, and only this process can run that settlement, so an
            // idle deadline that lands inside the grace truncates it
            // permanently (D1 — observed live: exit 269 frames before the
            // resolve, nothing settled, no escrow disposed).
            {
                hibernate::IdleHibernateContext hc;
                hc.persistentRoom = roomPersistent;
                hc.hibernationEnabled = hibernationEnabled;
                hc.idleSeconds = hibernateIdleSeconds;
                hc.headlessRun = headlessCfg.enabled;
                hc.replaying = replay::IsReplaying();
                hc.sinceStartSec = std::chrono::duration_cast<std::chrono::seconds>(
                    wall - serverStartTime).count();
                hc.startupGraceSec = kStartupGraceSec;
                hc.idleForSec = std::chrono::duration_cast<std::chrono::seconds>(
                    wall - lastClientTime).count();
                hc.warSimState = GatherWarSimState();
                const hibernate::IdleHibernateDecision hd =
                    hibernate::DecideIdleHibernate(hc);
                if (hd.hibernate) {
                    SLOG(SPRING_LOG_NOTICE,
                        "no connected clients for %llds — hibernating persistent "
                        "room %u at frame %d",
                        static_cast<long long>(hc.idleForSec), roomId,
                        sim.GetFrameNum());
                    exitReason = hibernate::ExitReason::Idle;
                    keepRunning.store(false);
                } else if (hd.deferredForWarEnding && !hibernateDeferLogged) {
                    // Once per process. A war that is ending is idle on every
                    // subsequent pass too, and a line per 5 s would bury the
                    // resolve it is waiting for.
                    hibernateDeferLogged = true;
                    SLOG(SPRING_LOG_NOTICE,
                         "no connected clients for %llds, but room %u is NOT "
                         "hibernating at frame %d: %s",
                         static_cast<long long>(hc.idleForSec), roomId,
                         sim.GetFrameNum(), hd.reason.c_str());
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
                    exitReason = hibernate::ExitReason::PostGame;
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
                    // ── Capture this player's war state (task 4) ───────────
                    // (PLAN-metalstorm-lobby.md §2.5/§5.1.) STRICTLY BEFORE
                    // eventHandler.PlayerRemoved below, and that ordering is
                    // the whole correctness of the capture: game_authority's
                    // PlayerRemoved merges a departing player's pool into the
                    // TEAM pool and zeroes theirs, for every leave reason.
                    // Capturing afterwards would faithfully record zero for
                    // everyone, every time, and the restore path would have
                    // nothing to give back but still look implemented.
                    //
                    // Only a war, and only a seated human: a spectator has no
                    // binding for the UPDATE to match (SaveState says so and
                    // returns false rather than inventing one).
                    if (sessionKind == SessionKind::PersistentWar &&
                        session->team >= 0 && !replay::IsReplaying()) {
                        const WarPlayerState st =
                            CaptureWarPlayerState(session->team, pNum);
                        if (WarPlayerBindings::SaveState(
                                db.Handle(), roomId, session->userId, st,
                                static_cast<int64_t>(std::time(nullptr)))) {
                            SLOG(SPRING_LOG_NOTICE,
                                "war state saved for '%s' (account %lld, team "
                                "%d): pool %.1f, earned %.1f, spent %.1f, "
                                "%d objective(s)",
                                session->username.c_str(),
                                (long long)session->userId, session->team,
                                st.authorityPool, st.scoreEarned, st.scoreSpent,
                                st.objectives);
                        }
                    }
                    // Journal chokepoint #2 of 5: a disconnect fires
                    // PlayerRemoved into synced Lua, so gadgets can (and in
                    // Metalstorm do) change synced state in response. Only
                    // recorded for a client that reached a player number —
                    // an unauthenticated drop touches nothing synced.
                    syncedinput::Journal().RecordDisconnect(pNum, leaveReason);
                    playerHandler.PlayerLeft(pNum, leaveReason);
                    eventHandler.PlayerRemoved(pNum, leaveReason);
                    // ...and the SYNCED half, which the line above does NOT
                    // deliver and never did (task 5). PlayerRemoved is an
                    // UNSYNCED event, so `CEventHandler::InsertEvent` refuses
                    // the synced LuaRules handle's registration outright and
                    // `eventHandler.PlayerRemoved` iterates a list the gadgets
                    // are not in — which is why the leaver-merge in
                    // game_authority.lua had never once run. Full argument in
                    // PlayerOnboarding.h.
                    FireSyncedPlayerRemoved(pNum, leaveReason);
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

        // --- Snapshot round-trip: drive the two arms (PLAN-persistence §8) ---
        //
        // Deliberately the SAME site as the state-hash block above, and for the
        // same reason it gives: a determinism hash is only comparable against
        // another taken at the same point in the tick. Arm A's hashes and arm
        // B's are taken by this block, one statement apart, so the two arms
        // cannot drift to different sample points however this loop grows.
        //
        // Everything fallible is checked and routed to Fail(), never ignored:
        // a run that could not take its checkpoint must report that it did not
        // run, not that it found no divergence.
        if (roundTrip.Enabled()) {
            const snapshotrt::Step step = roundTrip.OnFrame(frame);
            std::vector<uint8_t> payload;
            std::string rtErr;

            if (step.capture) {
                if (!simSerializer.Serialize(payload, rtErr)) {
                    roundTrip.Fail("the serializer refused the checkpoint: " + rtErr);
                } else {
                    SLOG(SPRING_LOG_NOTICE,
                        "snapshot round-trip: checkpoint taken at frame %d (%zu bytes), "
                        "arm A running to frame %lld",
                        frame, payload.size(),
                        (long long)(frame + roundTrip.Cfg().ticks));
                    roundTrip.SetCheckpoint(std::move(payload));
                }
            }
            if (step.record)
                roundTrip.RecordHash(computeStateHash());
            if (step.captureTerminal) {
                payload.clear();
                if (!simSerializer.Serialize(payload, rtErr))
                    roundTrip.Fail("the serializer refused the terminal capture: " + rtErr);
                else
                    roundTrip.SetTerminalPayload(std::move(payload));
            }
            if (step.finish && roundTrip.CurrentPhase() != snapshotrt::Phase::Done) {
                // The controller is pure, so the decode is the caller's job:
                // measure how the two continuations' rosters differ and hand
                // back the numbers it judges (PLAN-persistence Q-P2 option D).
                const simsnapshot::UnitsDivergence u = simsnapshot::CompareUnits(
                    roundTrip.TerminalA(), roundTrip.TerminalB());
                snapshotrt::Divergence d;
                d.measured = u.measured;
                d.unitsA = u.unitsA;
                d.unitsB = u.unitsB;
                d.transform = u.transform;
                d.vitals = u.vitals;
                d.onlyA = u.onlyA;
                d.onlyB = u.onlyB;
                d.maxPosDelta = u.maxPosDelta;
                d.maxHeadingDelta = u.maxHeadingDelta;
                roundTrip.Finish(d);
            }
            if (step.restore) {
                const std::vector<uint8_t>& cp = roundTrip.Checkpoint();
                if (!simSerializer.Deserialize(cp.data(), cp.size(), rtErr)) {
                    roundTrip.Fail("the restore failed: " + rtErr);
                } else {
                    springlog_set_frame(sim.GetFrameNum());
                    // Re-capture immediately, before a single further tick:
                    // capture→apply→capture idempotence is a property of the
                    // walk on its own, and separating it from the 100 ticks
                    // that follow is what makes a failure attributable.
                    std::vector<uint8_t> recap;
                    std::string cerr2;
                    if (!simSerializer.Serialize(recap, cerr2)) {
                        roundTrip.Fail("the re-capture after restore failed: " + cerr2);
                    } else {
                        SLOG(SPRING_LOG_NOTICE,
                            "snapshot round-trip: restored to frame %d (%zu bytes "
                            "re-captured), arm B running",
                            sim.GetFrameNum(), recap.size());
                        // Name the section the re-capture disagrees in. "The
                        // payloads differ at byte 51 234" is a fact nobody can
                        // act on; "section 'units', byte 812 of 44 709" is an
                        // owner.
                        if (recap != cp) {
                            size_t at = 0;
                            const size_t n = std::min(recap.size(), cp.size());
                            while (at < n && recap[at] == cp[at]) ++at;
                            SLOG(SPRING_LOG_WARNING,
                                "snapshot round-trip: the re-capture differs from the "
                                "checkpoint at %s (capture -> apply -> capture is not "
                                "idempotent)",
                                simsnapshot::DescribeOffset(cp.data(), cp.size(), at).c_str());
                            // Same reason the terminal comparison says it: "the
                            // units section differs" is true of a dropped kill
                            // and of a building landing 8 elmos from where it
                            // was captured, and only one of those is a restore
                            // that moved the world.
                            for (const auto& d : simsnapshot::DiffSections(cp, recap)) {
                                if (d != "units") continue;
                                SLOG(SPRING_LOG_WARNING,
                                    "snapshot round-trip: re-capture units — %s",
                                    simsnapshot::DescribeUnitsDivergence(cp, recap).c_str());
                            }
                        }
                        roundTrip.OnRestored(sim.GetFrameNum(), recap);
                    }
                }
            }
            if (roundTrip.CurrentPhase() == snapshotrt::Phase::Done) {
                const snapshotrt::Result& rr = roundTrip.Result_();
                SLOG(rr.pass ? SPRING_LOG_NOTICE : SPRING_LOG_ERROR, "%s",
                     roundTrip.FormatVerdict().c_str());
                if (rr.firstDifferentByte >= 0) {
                    // Under the world bar a payload difference is the EXPECTED
                    // shape of a resume (§7.1c's movement re-derivation), so it
                    // is reported at the severity of the verdict it belongs to
                    // rather than always as an error.
                    const int sev = rr.pass ? SPRING_LOG_NOTICE : SPRING_LOG_ERROR;
                    const std::vector<uint8_t>& ta = roundTrip.TerminalA();
                    SLOG(sev,
                        "snapshot round-trip: the two arms' terminal payloads first "
                        "differ in %s",
                        simsnapshot::DescribeOffset(
                            ta.data(), ta.size(),
                            static_cast<size_t>(rr.firstDifferentByte)).c_str());
                    // How WIDE the disagreement is. "Only `globals` differs"
                    // means every unit, team, feature and gadget table came out
                    // the same and the arms merely drew from the RNG a
                    // different number of times; "units differ too" is a
                    // different investigation entirely.
                    const auto diffs = simsnapshot::DiffSections(
                        ta, roundTrip.TerminalB());
                    std::string names;
                    for (const auto& d : diffs) names += (names.empty() ? "" : ", ") + d;
                    SLOG(sev,
                        "snapshot round-trip: sections that disagree at frame %lld: %s",
                        (long long)rr.endFrame, names.c_str());
                    for (const auto& d : diffs) {
                        if (d == "units") {
                            // "units differ" covers a dropped kill and a unit
                            // standing a millimetre further along its path.
                            // Those are opposite diagnoses, so say which.
                            SLOG(sev, "snapshot round-trip: units — %s",
                                 simsnapshot::DescribeUnitsDivergence(
                                     ta, roundTrip.TerminalB()).c_str());
                        } else if (d == "gameRules") {
                            // On a static fixture (roundtrip_static) there are
                            // no moving units to blame, so a failure lands in
                            // the gadgets' own state — name the key.
                            const std::string keys =
                                simsnapshot::DescribeRulesParamsDivergence(
                                    ta, roundTrip.TerminalB(),
                                    simsnapshot::SectionId::GameRules);
                            if (!keys.empty())
                                SLOG(sev, "snapshot round-trip: gameRules — %s",
                                     keys.c_str());
                        }
                    }
                }
                if (!rr.pass) roundTripExitCode = 1;
                exitReason = hibernate::ExitReason::Harness;
                keepRunning.store(false);
            }
        }

        // --- Headless run: stop-condition evaluation (PLAN-headless task 1) ---
        // Only reached under --headless-run, so a normal game never enters this
        // block (regression bar). Evaluated after the tick + streamer, so the
        // game-over relay and frame count reflect this frame. The synced-Lua
        // predicate is polled once per game-second and its result latched.
        // (It was every 30 game-seconds, first poll at frame 900 — so any run
        // whose frame limit fired earlier exited having never evaluated its
        // luaCondition even once, with zero output to say so. FU1.)
        if (headlessCfg.enabled) {
            if (headlessCfg.stopAt.luaCondition && !headlessLuaMet &&
                !headlessLuaErrored &&
                headless::LuaConditionPollDue(frame, GAME_SPEED)) {
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
                exitReason = hibernate::ExitReason::HeadlessRun;
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
    // A round-trip run that ends any other way than by its own verdict — the
    // wall ceiling, a game-over, a signal — has NOT passed. Saying so here is
    // the difference between "compared 100 ticks and they agreed" and "the run
    // stopped before it compared anything", which a bare exit code cannot tell
    // apart and a CI job would read as success.
    if (roundTrip.Enabled() && roundTrip.CurrentPhase() != snapshotrt::Phase::Done) {
        SLOG(SPRING_LOG_ERROR, "%s", roundTrip.FormatVerdict().c_str());
        roundTripExitCode = 1;
    }

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

    // --- Exit checkpoint (PLAN-persistence task 3a) ---
    //
    // The one site where a world becomes resumable, on the sim thread, after
    // the loop and before anything is torn down. One site rather than one per
    // exit path deliberately: a SIGTERM from a deploy drain, a hibernating
    // idle war and an operator's Ctrl-C are the same event as far as the
    // world is concerned, and the four in-loop stop sites only have to name
    // their `exitReason` for the policy to sort them.
    //
    // Everything fallible is said out loud. A room that could not save itself
    // is a data-loss event and logs at WARNING with the store's own reason;
    // the six benign refusals (a replay, an unstarted game, a finished match…)
    // log at NOTICE, because "no checkpoint taken" is the correct outcome for
    // each of them and an operator who cannot tell them apart learns to
    // ignore both.
    // One last drain before the world is frozen (PLAN-persistence task 4b).
    // The events between the final heartbeat and the exit are the ones a
    // returning player most wants — they are the last thing that happened in
    // the war — and up to two seconds of them would otherwise sit in a ring
    // that is about to stop being read. Cheap and unconditional: it no-ops on
    // a skirmish, on a replay, and on a war that emitted nothing.
    drainWarLog();

    {
        hibernate::ExitContext ec;
        ec.reason = restartRequested.load() ? hibernate::ExitReason::Restart : exitReason;
        ec.hibernationEnabled = hibernationEnabled;
        ec.serializerAttached = gmSnapshotStore.Available();
        ec.gameStarted = sim.HasGameStarted();
        ec.gameOverDeclared = gameOverRelay.IsDeclared();
        ec.replaying = replay::IsReplaying();

        const hibernate::CheckpointDecision cd = hibernate::DecideExitCheckpoint(ec);
        if (cd.checkpoint) {
            std::string cerr;
            // Synchronous: the process is about to exit, so an async write
            // would race the destructor. Checkpoint() flushes before it
            // returns, which is exactly the durability a hibernation needs.
            const int32_t f = gmSnapshotStore.Checkpoint(roomId, cd.label, cerr);
            if (f < 0) {
                SLOG(SPRING_LOG_WARNING,
                    "hibernate: room %u exiting on %s but the checkpoint FAILED "
                    "(%s) — this world is lost, not frozen",
                    roomId, hibernate::Describe(ec.reason),
                    cerr.empty() ? "no reason given" : cerr.c_str());
            } else {
                SLOG(SPRING_LOG_NOTICE,
                    "hibernate: room %u checkpointed at frame %d (%s) — "
                    "resumable with --resume",
                    roomId, f, cd.label.c_str());
            }
        } else {
            SLOG(cd.lossy ? SPRING_LOG_WARNING : SPRING_LOG_NOTICE,
                 "hibernate: no exit checkpoint (%s) — %s",
                 hibernate::Describe(ec.reason), cd.reason.c_str());
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
    if (replayExitCode != 0 || roundTripExitCode != 0) {
        // Tear down the log sinks before returning non-zero — a verify failure
        // (replay divergence, or a snapshot round-trip that did not agree) is
        // a normal, expected outcome of a CI run, not a crash.
        if (!logServer.empty())
            springlog_net_shutdown();
        springlog_sqlite_shutdown();
        springlog_shutdown();
        return replayExitCode != 0 ? replayExitCode : roundTripExitCode;
    }

    // Tear down optional sinks before the core logger
    if (!logServer.empty())
        springlog_net_shutdown();
    springlog_sqlite_shutdown();
    springlog_shutdown();

    return 0;
}
