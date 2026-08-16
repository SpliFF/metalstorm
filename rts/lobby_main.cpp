/**
 * spring-lobby — lightweight lobby server.
 *
 * Handles authentication, room management, and game server spawning
 * via HTTP REST endpoints. When a room starts, spawns a spring-server
 * process and returns the port to clients.
 *
 * No simulation code — just HTTP serving, SQLite, and process management.
 */

#include "Server/Database.h"
#include "Server/GrowthCounters.h"
#include "Server/GameEventsDb.h"
#include "Server/GameServersDb.h"
#include "Server/GuestAccounts.h"
#include "Server/MapMetadata.h"
#include "Server/NetworkServer.h"
#include "Server/ReplayFile.h"
#include "Server/PlayerSlotReservation.h"
#include "Server/RoomManager.h"
#include "Server/RuntimeAIRoster.h"
#include "Server/WarDirector.h"
#include "Server/WarPlayerBindings.h"
#include "Server/JoinPreview.h"
#include "Server/WarDeploy.h"
#include "Server/WarDemandSeed.h"
#include "Server/WarSeeding.h"
#include "Server/WarLifecycleSweep.h"
#include "Server/WarOutcome.h"
#include "Server/WarSideMaintenance.h"
#include "Server/WarSlotReservation.h"
#include "Server/WarSummary.h"
#include "Server/SqliteThreading.h"

#include "Server/AI/AIDiscovery.h"
#include "Server/CacheControl.h"
#include "Server/DevBuildGate.h"
#include "Server/FactionData.h"
#include "Server/FriendPresence.h"
#include "Server/Friends.h"
#include "Server/GameDiscovery.h"
#include "Server/GmDashboardPage.h"
#include "Server/HttpAuth.h"
#include "Server/ResourcesParser.h"
#include "Server/ScenarioDb.h"
#include "Server/ScenarioDiscovery.h"
#include "Server/TokenBucket.h"
#include "Server/DeployDrain.h"
#include "Server/WarLifecycle.h"
#include "Server/WarResume.h"
#include "Server/WarStateEvents.h"
#include "System/SpringLog/SpringLog.h"
#include "System/SpringLog/SpringLogSqlite.h"
#include <cctype>
#include <optional>
#include <set>
#include <unordered_set>

#include <sqlite3.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <unordered_map>

#include <cstring>
#include <functional>
#include <netinet/in.h>
#include <nlohmann/json.hpp>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define LOG_SECTION "lobby"

static std::atomic<bool> keepRunning{true};
static std::atomic<bool> restartRequested{false};
static void signalHandler(int) { keepRunning.store(false); }
static void restartHandler(int) {
  restartRequested.store(true);
  keepRunning.store(false);
}

/// Prepare/bind/step/finalize a single write statement. The `bind` callback
/// binds parameters onto the prepared statement before it is stepped once.
static bool ExecPrepared(sqlite3 *db, const char *sql,
                         const std::function<void(sqlite3_stmt *)> &bind) {
  sqlite3_stmt *stmt = nullptr;
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    SLOG(SPRING_LOG_ERROR, "ExecPrepared prepare failed: %s",
         sqlite3_errmsg(db));
    return false;
  }
  if (bind)
    bind(stmt);
  const int rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if (rc != SQLITE_DONE) {
    SLOG(SPRING_LOG_ERROR, "ExecPrepared step failed (%d): %s", rc,
         sqlite3_errmsg(db));
    return false;
  }
  return true;
}

#ifndef MAPCONVERTER_BINARY_PATH
#define MAPCONVERTER_BINARY_PATH "mapconverter"
#endif

/// Run `mapconverter --all content/maps` synchronously at lobby startup so
/// a checkout whose `data/maps/` predates a `content/maps` source change
/// self-heals instead of staying stale forever (PLAN-metalstorm-impostors.md
/// M10 — `data/maps/<id>/features/impostors.json` never landed because
/// nothing ever called the conversion pipeline after the source manifest
/// was added). Mirrors gameconverter's own documented contract ("cheap to
/// run from CI or on every lobby startup as a pre-flight") — mapconverter's
/// per-map freshness check (`MapProcessor::ProcessedOutputCurrent` against
/// each map's `.processed-stamp`) makes every call after the first a fast
/// no-op scan, not a full reprocess.
///
/// Deliberately kept out-of-process rather than linking MapProcessor
/// straight into spring-lobby: MapProcessor pulls in ImageMagick/
/// modelimporter/Lua-map-processing, and mapconverter's `CopySourceTree`
/// step (which is what actually notices a new `content/maps/<id>/...`
/// file) lives in the tool's own main(), not in MapProcessor itself, so
/// merely calling `MapProcessor::ScanAndProcess` in-process would miss new
/// source files anyway. Failure is logged, not fatal — a missing
/// `content/maps` dir (e.g. a stripped prod image) or a missing binary
/// shouldn't block the lobby from serving whatever `data/` already has.
static void RunMapConverterPreflight(const std::string &dbPath) {
  const std::filesystem::path dbFsPath(dbPath);
  const std::string dataDir =
      dbFsPath.has_parent_path() && !dbFsPath.parent_path().empty()
          ? dbFsPath.parent_path().string()
          : "data";

  const std::string cmd = std::string("\"") + MAPCONVERTER_BINARY_PATH +
                          "\" --all content/maps --data-dir \"" + dataDir +
                          "\" --db \"" + dbPath + "\" 2>&1";
  FILE *p = popen(cmd.c_str(), "r");
  if (!p) {
    SLOG(SPRING_LOG_WARNING, "map preflight: failed to launch mapconverter");
    return;
  }
  char buf[256];
  std::string out;
  while (fgets(buf, sizeof(buf), p))
    out += buf;
  const int rc = pclose(p);
  if (rc != 0) {
    SLOG(SPRING_LOG_WARNING,
         "map preflight: mapconverter exited %d (maps may be stale):\n%s",
         rc, out.c_str());
  } else {
    SLOG(SPRING_LOG_NOTICE, "map preflight: maps up to date");
  }
}

/// One run of tools/mapgen/scenariogen.py.
struct ScenarioGenResult {
  bool ok = false;
  /// The generated scenario source — the thing that becomes the DB row's
  /// `lua` column. Empty unless `ok`.
  std::string lua;
  /// The `--meta-json` payload, parsed. Carries `id`, `display_name`,
  /// `map_id`, `seed`, `version` and the echoed `params`.
  nlohmann::json meta;
  /// Whatever the generator said on stderr — its human summary on success,
  /// and on failure the `REJECTED — …` line naming which of its five
  /// invariants the map violated. Surfaced verbatim to the admin caller:
  /// "this map cannot host a generated war, and here is which gate said so"
  /// is the single most useful thing this endpoint can report.
  std::string diagnostics;
  int exitCode = -1;
};

/// True when `s` is safe to interpolate into a shell command line.
///
/// Every argument this file passes to the generator goes through here rather
/// than through quoting alone. `mapId` in particular arrives from an HTTP body
/// and is concatenated into a popen() string; an allowlist is the only form of
/// this check that is obviously correct at a glance.
static bool IsShellSafeToken(const std::string &s) {
  if (s.empty() || s.size() > 128)
    return false;
  for (const char c : s) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
    if (!ok)
      return false;
  }
  // Leading '-' would be read as an option by the generator's argparse, and
  // ".." is a traversal even though every character in it passed above.
  return s.front() != '-' && s.find("..") == std::string::npos;
}

/// Run tools/mapgen/scenariogen.py for one (map, seed, knobs) and capture both
/// the scenario source and its metadata.
///
/// Shelling out rather than reimplementing: the generator owns the passability
/// mask, the five gates that refuse to emit an unplayable war, and the id hash.
/// A C++ port would be a second content pipeline that has to agree with the
/// first forever. The lobby already shells out to `mapconverter` at startup for
/// the same reason (RunMapConverterPreflight above).
///
/// stderr is redirected to a file rather than merged with 2>&1: under
/// `--stdout` the generator's stdout carries ONLY the scenario, and merging
/// would glue its human summary onto the front of the Lua — producing a file
/// that is not a scenario at all, and, being prose ahead of `return {`, one
/// ScenarioDiscovery silently drops.
static ScenarioGenResult
RunScenarioGen(const std::string &mapsDir, const std::string &mapId,
               const std::string &gamePath, int64_t seed,
               const nlohmann::json &knobs) {
  ScenarioGenResult out;

  if (!IsShellSafeToken(mapId)) {
    out.diagnostics = "invalid map id";
    return out;
  }

  const std::string mapDir = mapsDir + "/" + mapId;
  std::error_code ec;
  if (!std::filesystem::is_directory(mapDir, ec)) {
    out.diagnostics = "no processed map at '" + mapDir +
                      "' — run the map converter for this map first";
    return out;
  }

  // Unique scratch paths. The pid keeps two concurrent admin calls apart even
  // though HTTP handlers are single-threaded today, and both are removed
  // before return whatever the outcome.
  const std::string stem =
      (std::filesystem::temp_directory_path() /
       ("scenariogen_" + std::to_string(::getpid()) + "_" + mapId))
          .string();
  const std::string metaPath = stem + ".json";
  const std::string errPath = stem + ".err";

  std::string cmd = "python3 \"" + std::string(SCENARIOGEN_SCRIPT_PATH) +
                    "\" \"" + mapDir + "\"" +
                    " --seed " + std::to_string(seed) +
                    " --game-dir \"" + gamePath + "\"" +
                    " --stdout --meta-json \"" + metaPath + "\"";

  // Knobs. Integers are range-clamped and strings allowlisted — the generator
  // validates these too (argparse `choices`), but a bad value must never reach
  // the shell in the first place.
  const auto addInt = [&](const char *flag, const char *key, int lo, int hi) {
    if (!knobs.contains(key) || !knobs[key].is_number_integer())
      return;
    const int v = knobs[key].get<int>();
    if (v < lo || v > hi)
      return;
    cmd += std::string(" ") + flag + " " + std::to_string(v);
  };
  addInt("--sides", "sides", 2, 8);
  addInt("--towns", "towns", 0, 32);
  addInt("--outposts", "outposts", 0, 32);
  addInt("--bases", "bases", 0, 32);
  addInt("--mines", "mines", 0, 32);
  const auto addEnum = [&](const char *flag, const char *key) {
    if (!knobs.contains(key) || !knobs[key].is_string())
      return;
    const std::string v = knobs[key].get<std::string>();
    if (!IsShellSafeToken(v))
      return;
    cmd += std::string(" ") + flag + " " + v;
  };
  addEnum("--hostility", "hostility");
  addEnum("--roster", "roster");

  cmd += " 2>\"" + errPath + "\"";

  FILE *p = popen(cmd.c_str(), "r");
  if (!p) {
    out.diagnostics = "failed to launch scenariogen.py";
    return out;
  }
  char buf[4096];
  size_t n = 0;
  while ((n = fread(buf, 1, sizeof(buf), p)) > 0)
    out.lua.append(buf, n);
  const int rc = pclose(p);
  out.exitCode = WIFEXITED(rc) ? WEXITSTATUS(rc) : -1;

  {
    std::ifstream ef(errPath, std::ios::binary);
    if (ef)
      out.diagnostics.assign(std::istreambuf_iterator<char>(ef),
                             std::istreambuf_iterator<char>());
  }

  if (out.exitCode == 0) {
    std::ifstream mf(metaPath, std::ios::binary);
    if (mf) {
      const std::string metaText((std::istreambuf_iterator<char>(mf)),
                                 std::istreambuf_iterator<char>());
      out.meta = nlohmann::json::parse(metaText, nullptr, false);
    }
    // A run that exits 0 but produced no usable Lua or no metadata is a
    // failure here even though the generator thought it succeeded — storing a
    // row with an empty `lua` would materialise an empty scenario file, which
    // discovery drops with a warning that blames the content.
    out.ok = !out.lua.empty() && !out.meta.is_discarded() &&
             out.meta.is_object() && out.meta.contains("id");
    if (!out.ok && out.diagnostics.empty())
      out.diagnostics = "scenariogen.py produced no usable output";
  }

  std::filesystem::remove(metaPath, ec);
  std::filesystem::remove(errPath, ec);
  return out;
}

// Saved for self-restart via execvp
static int savedArgc = 0;
static char **savedArgv = nullptr;

/// Tracks a spawned game server process.
struct GameServerInstance {
  uint32_t roomId = 0;
  int port = 0;
  pid_t pid = 0;
  std::string mapId;
  std::string gameId;
  /// `Hibernated` is the one state with no process behind it (PLAN-persistence
  /// task 3b): a war whose server checkpointed itself and exited keeps its
  /// `game_servers` row with `pid = 0` so /api/processes, the fleet view and the
  /// MCP debug tools show a frozen war rather than nothing at all. Every
  /// liveness check in this file goes through `isProcessAlive`, which returns
  /// false for pid 0, so a hibernated row can never be mistaken for a server.
  enum State { Starting, Running, Ended, Crashed, Hibernated } state = Starting;
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
/// processes in the lobby's `gameServers` map — a belt-and-suspenders
/// skip. The probe below is the real guard: it binds the port with the
/// *same* socket shape spring-server uses (dual-stack IPv6 wildcard,
/// SO_REUSEADDR, no SO_REUSEPORT — see NetworkServer.cpp), so a port a
/// live server holds fails to bind and is correctly reported busy. This
/// catches even a zombie server that outlived its DB row and so never
/// made it into `excluded`. (Previously the probe bound an IPv4
/// loopback socket, which did not collide with the server's `::`
/// wildcard the same way, so a busy port could read as free.)
static int findFreePort(int base = 9100, int floor = 0,
                        const std::unordered_set<int> &excluded = {}) {
  int start = (floor > base) ? floor : base;
  for (int port = start; port < start + 1000; ++port) {
    if (excluded.count(port))
      continue;
    int s = ::socket(AF_INET6, SOCK_STREAM, 0);
    if (s < 0)
      continue;
    int one = 1;
    int zero = 0;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    setsockopt(s, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof(zero));
    sockaddr_in6 addr{};
    addr.sin6_family = AF_INET6;
    addr.sin6_addr = in6addr_any;
    addr.sin6_port = htons(static_cast<uint16_t>(port));
    if (::bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) == 0) {
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
/// becomes a `--ai <id>:<team>:<posIdx>[:<profile>]` argument pair; the sim
/// runs its own AIDiscovery against the same game path and
/// resolves each id to a main.lua it can actually run. The optional
/// profile field (PLAN-metalstorm-ai.md §10 task 6) is opaque to the
/// engine — carried through to the AI plugin, which validates it.
///
/// Both rosters must have `startPos` populated (or -1 if the map
/// has no start positions at all). The lobby calls
/// AutoAssignStartPositions before this function to fill in any
/// -1 values, so a well-formed handoff always carries a concrete
/// slot assignment per team.
/// `--replay-dir <dir>`: when set, every game server the lobby spawns is given
/// a `--journal-file <dir>/room-<id>.msr` and records its own cause stream
/// (PLAN-replay task 2). Off by default — recording is a per-deployment choice,
/// not something a dev lobby should start doing silently — and file-scope
/// rather than an twelfth spawnGameServer parameter for the same reason
/// CacheControl::IsNoCache() is: it is a process-wide operator setting, not a
/// property of the room being started.
static std::string gReplayDir;

/// PLAN-metalstorm-lobby.md §8, task 9a: "when did this account last make an
/// authenticated request", the only source of the `online` presence state.
///
/// File scope because its one writer (the route-auth dispatch callback, wired
/// in `main` before any route exists) and its one reader (the friends list
/// route) are set up hundreds of lines apart, and because it is genuinely
/// process-wide — the same reason `gReplayDir` above is. Not a database table:
/// see FriendPresence.h for why, and for what a lobby restart costs.
static PresenceTracker gPresence;

/// Rooms that are WATCHING a replay rather than hosting a game (PLAN-replay
/// task 4c), roomId → the `.msr` basename being served.
///
/// A replay room is a real room on purpose: 4a and 4b both had to be verified
/// by hand-injecting a synthetic room object into the client, because a room is
/// already the only thing that carries a `game_server_port` to a browser and
/// the only thing whose lifecycle kills a server when the last person leaves.
/// Making the lobby produce a genuine one means the whole join → play → leave
/// path is the path players already use, and §5's "casting = one replay server,
/// many spectators" falls out of JoinRoom's existing behaviour rather than
/// needing a second concept.
///
/// The map is what the rest of the lobby consults to tell the two apart: the
/// room browser labels them, and the health loop DELETES a replay room whose
/// server exited instead of recycling it for another game (a replay room has no
/// next game — the recording ran out).
/// (`unordered_map` rather than `map`: `rts/Map/` shadows the `<map>` header on
/// a case-insensitive filesystem, so it cannot be included here at all.)
static std::unordered_map<uint32_t, std::string> gReplayRooms;

/// The game-server binary this lobby forks. Release wins when it exists —
/// which is also task 3b's field note ("a debug-only rebuild is invisible in a
/// lobby arm") and the reason the engine-hash probe below has to ask THIS file
/// rather than the lobby's own build stamp.
static std::string gameServerBinaryPath() {
  if (std::filesystem::exists("./build/release/spring-server"))
    return "./build/release/spring-server";
  return "./build/debug/spring-server";
}

/// The E1 identity of that binary (PLAN-persistence task 3c), probed by running
/// it with `--print-engine-hash` and cached on (path, mtime, size).
///
/// Cached rather than probed per call because it is consulted on every room
/// broadcast, once per war — a fork+exec per card would be absurd. Keyed on the
/// file's own stamp rather than on a lobby-lifetime flag because the case this
/// exists for is precisely *the binary being replaced*: a deploy that swaps
/// spring-server under a running lobby must be observed, or the lobby keeps
/// promising resumes the new binary will refuse.
///
/// An empty return means "could not tell" (an older binary with no such flag,
/// or a probe that failed). Every consumer treats that as "let the game server
/// decide", i.e. exactly the pre-3c behaviour — see
/// warresume::ResumeEligibility::UnknownBinary.
static std::string gameServerEngineHash() {
  static std::string cachedPath;
  static std::string cachedHash;
  static int64_t cachedMtime = 0;
  static uintmax_t cachedSize = 0;
  static bool warned = false;

  const std::string bin = gameServerBinaryPath();
  std::error_code ec;
  const auto mtime = std::filesystem::last_write_time(bin, ec);
  const int64_t mt =
      ec ? 0 : static_cast<int64_t>(mtime.time_since_epoch().count());
  std::error_code szEc;
  const uintmax_t sz = std::filesystem::file_size(bin, szEc);
  if (bin == cachedPath && mt == cachedMtime && sz == cachedSize)
    return cachedHash;

  std::string err;
  const std::string hash = deploydrain::ProbeServerEngineHash(bin, err);
  cachedPath = bin;
  cachedMtime = mt;
  cachedSize = sz;
  cachedHash = hash;
  if (hash.empty()) {
    // Once per process: this is a capability gap, not a per-war event, and the
    // consequence (no pre-flight, the server refuses instead) is the same for
    // every room.
    if (!warned) {
      warned = true;
      SLOG(SPRING_LOG_WARNING,
           "snapshot E1 pre-check disabled — %s; a post-upgrade war will be "
           "refused by the game server instead of by the lobby",
           err.c_str());
    }
  } else {
    SLOG(SPRING_LOG_NOTICE, "game server %s engine hash %s (snapshot E1)",
         bin.c_str(), hash.c_str());
  }
  return cachedHash;
}

/// Σ slotCap for a room — the number of human player slots the game server
/// this room spawns must pre-allocate (PLAN-metalstorm-wars.md §8.1, task 5).
///
/// Read off the ROOM rather than off the Director's `war_sides` table, and
/// that is the same authority split `ReconcileSeededSides` records: the
/// scenario owns which team a side sits on and how wide it is at boot, so the
/// room's own `war_sides`/`war_side_capacities` modoptions are what the
/// process is actually being launched with. Taking the number from anywhere
/// else risks sizing the arrays for a war the boot did not produce.
///
/// 0 for everything that is not a finite war — a skirmish, a legacy room, a
/// war with an unlimited side — which the server reads as "grow on demand".
static unsigned warPlayerSlotCap(const GameRoom &room) {
  if (room.sessionKind != SessionKind::PersistentWar)
    return 0;
  return playerslots::TotalSlotCap(room.SideTeams(), room.SideCapacities(),
                                   WAR_SIDE_CAPACITY_DEFAULT);
}

static GameServerInstance spawnGameServer(
    uint32_t roomId, const std::string &gameId, const std::string &gameVersion,
    const std::string &mapId, const std::string &dbPath,
    const std::vector<RoomPlayer> &playerRoster,
    const std::vector<RoomAISlot> &aiSlots,
    const std::unordered_map<std::string, std::string> &modOptions = {},
    const std::unordered_set<int> &excludedPorts = {},
    bool devBuildAcknowledged = false,
    // PLAN-security-hardening.md task 5 (G3): forwarded from the lobby's own
    // --wt-cert/--wt-key to every spawned spring-server, so an operator
    // configures the prod cert once at the lobby instead of per room.
    const std::string &wtCertPath = "", const std::string &wtKeyPath = "",
    // PLAN-replay task 4c: when set, this server RE-EXECUTES the named `.msr`
    // instead of hosting a live game. The replay file is its own launch spec
    // (map, game, modoptions, roster, AI slots all come out of the header), so
    // every argument that describes the world is deliberately NOT passed — the
    // engine treats an explicit flag as an override, and overriding here would
    // silently turn a playback into a divergence experiment.
    //
    // Deliberately NO `--replay-seek`: a start frame is a control a watcher
    // sends, never a launch option. See the watch route for the live evidence.
    const std::string &replayFile = "",
    // PLAN-metalstorm-lobby.md task 1: the room's session kind, forwarded as
    // `--session-kind`. The lobby is the authority on it — the game server
    // could read `rooms.session_kind` out of the shared db (it already reads
    // `persistent` there for its idle policy), but the kind decides whether
    // GameStart waits for the roster, and that decision is made during set-up,
    // before that read happens. One source, one reader.
    SessionKind sessionKind = SessionKind::Skirmish,
    // PLAN-persistence task 3b: bring this room's world up out of the snapshot
    // store instead of staging a fresh one (`--resume`). Only ever true when
    // the caller has SEEN a snapshot row for (gameId, roomId) — the server
    // treats a missing snapshot as fatal by design, so an unconditional flag
    // would abort every war's first launch. `warresume::PlanJoin` owns that
    // decision; this parameter only carries it.
    bool resumeFromSnapshot = false,
    // PLAN-persistence task 3b: the idle window after which a war checkpoints
    // itself and exits (`--hibernate-idle-seconds`). Passed by the LOBBY, for
    // the same reason `--session-kind` is: hibernating is only safe for a room
    // something will respawn on join, and the lobby is the only thing that
    // can. The server binary keeps its own default of 0 so a bare
    // `spring-server` still never exits a world nobody can bring back.
    int hibernateIdleSeconds = 0,
    // PLAN-metalstorm-wars.md §8.1 task 5: Σ slotCap — how many human player
    // slots this server must pre-allocate (`--player-slots`). The War Director
    // knows every side's `slotCap` at seed time, so the process is sized for
    // the WAR rather than for the roster it boots with, and a dynamic joiner
    // (§2.1) lands on a slot that already exists.
    //
    // Passed rather than left to the server to derive, even though the server
    // CAN derive it from the same `war_side_capacities` modoption: this is the
    // number that gets recorded as `wars.spawned_slot_cap`, i.e. what the
    // running process was sized for, and after task 2's maintenance pass raises
    // a side the recorded number and the live caps deliberately disagree. The
    // lobby has to send what it recorded, not what the caps say later.
    //
    // 0 (the default) = not sized: a skirmish, a legacy room, or a war with an
    // unlimited side. The server grows its player list on demand, as before.
    unsigned playerSlotCap = 0) {
  const bool isReplay = !replayFile.empty();
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
  const std::string serverBin = gameServerBinaryPath();

  // Create log directory
  std::filesystem::create_directories("data/logs");
  std::string logPath = "data/logs/game-" + std::to_string(roomId) + ".log";

  // Assemble the --player and --ai arguments outside the fork so
  // their string storage outlives the execvp call in the child.
  // Player spec format:  <username>:<team>:<posIdx>
  // AI spec format:      <id>:<team>:<posIdx>
  //
  // `playerRoster` is documented as "non-spectators" above, but callers
  // pass the room's full player list (spectators included) — filter here
  // so a spectator never gets baked into --player as a phantom team-0
  // player. Spectators reach the game server by authenticating without a
  // --player entry; ClientMessageHandler's AuthRequest handler treats
  // "authenticated but not in the roster" as role=spectator (see PLAN
  // metalstorm-onboarding.md §4).
  std::vector<std::string> playerArgStorage;
  playerArgStorage.reserve(playerRoster.size());
  for (const auto &p : playerRoster) {
    if (p.isSpectator)
      continue;
    playerArgStorage.push_back(p.username + ":" +
                               std::to_string(static_cast<int>(p.team)) + ":" +
                               std::to_string(static_cast<int>(p.startPos)));
  }
  std::vector<std::string> aiArgStorage;
  aiArgStorage.reserve(aiSlots.size());
  for (const auto &slot : aiSlots) {
    // 4th field (personality/difficulty profile, PLAN-metalstorm-ai.md §10
    // task 6) is appended only when set, so a slot with no profile still
    // produces the plain 3-field spec server_main.cpp has always parsed.
    std::string spec = slot.aiId + ":" +
                       std::to_string(static_cast<int>(slot.team)) + ":" +
                       std::to_string(static_cast<int>(slot.startPos));
    if (!slot.profile.empty())
      spec += ":" + slot.profile;
    aiArgStorage.push_back(std::move(spec));
  }
  // Room modoptions → one "--modoption key=value" pair each. (§5)
  std::vector<std::string> modOptArgStorage;
  modOptArgStorage.reserve(modOptions.size());
  for (const auto &[key, value] : modOptions) {
    modOptArgStorage.push_back(key + "=" + value);
  }

  // Replay recording (PLAN-replay). One file per room; the port disambiguates
  // rooms reusing an id across a lobby restart. Created here rather than in the
  // child so a directory that cannot be made is reported by the lobby instead
  // of vanishing into a forked process's log.
  std::string replayPathStorage;
  if (!gReplayDir.empty() && !isReplay) {
    std::error_code ec;
    std::filesystem::create_directories(gReplayDir, ec);
    if (ec) {
      SLOG(SPRING_LOG_WARNING, "--replay-dir '%s' is not usable (%s) — room %u "
           "will not be recorded",
           gReplayDir.c_str(), ec.message().c_str(), roomId);
    } else {
      replayPathStorage = gReplayDir + "/room-" + std::to_string(roomId) + "-p" +
                          std::to_string(inst.port) + ".msr";
    }
  }

  pid_t pid = fork();
  if (pid == 0) {
    // Child process — redirect stdout/stderr to log file
    FILE *logFile = fopen(logPath.c_str(), "w");
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
    if (maxFd < 1024)
      maxFd = 1024;
    for (int fd = 3; fd < maxFd; fd++) {
      close(fd);
    }

    std::string portStr = std::to_string(inst.port);
    std::string roomStr = std::to_string(roomId);
    std::string hibernateIdleStr = std::to_string(hibernateIdleSeconds);
    std::string playerSlotCapStr = std::to_string(playerSlotCap);

    // Build argv: fixed args first, then one "--player <spec>"
    // pair per human slot, then one "--ai <spec>" pair per AI
    // slot. Player args come first so spring-server's own arg
    // parser doesn't care about ordering — it reads them into
    // separate vectors either way.
    std::vector<const char *> argv;
    argv.push_back(serverBin.c_str());
    argv.push_back("--port");
    argv.push_back(portStr.c_str());
    argv.push_back("--room");
    argv.push_back(roomStr.c_str());
    if (!isReplay) {
      argv.push_back("--game");
      argv.push_back(gameId.c_str());
      if (!gameVersion.empty()) {
        argv.push_back("--game-version");
        argv.push_back(gameVersion.c_str());
      }
      argv.push_back("--map");
      argv.push_back(mapId.c_str());
    }
    // --db is passed on BOTH paths and is not optional on a replay: the
    // recorded auths take their identity from the stream (§7.10), but the
    // *live* spectator watching still authenticates its own session token
    // against this database like any other client.
    argv.push_back("--db");
    argv.push_back(dbPath.c_str());
    if (!wtCertPath.empty() && !wtKeyPath.empty()) {
      argv.push_back("--wt-cert");
      argv.push_back(wtCertPath.c_str());
      argv.push_back("--wt-key");
      argv.push_back(wtKeyPath.c_str());
    }
    if (isReplay) {
      argv.push_back("--replay");
      argv.push_back(replayFile.c_str());
    } else {
      // Not on the replay path: a recording re-executes with the gating its
      // own stream was produced under, and every argument that describes the
      // world is withheld there on purpose (see the parameter comment).
      argv.push_back("--session-kind");
      argv.push_back(SessionKindToString(sessionKind));
      for (const auto &spec : playerArgStorage) {
        argv.push_back("--player");
        argv.push_back(spec.c_str());
      }
      for (const auto &spec : aiArgStorage) {
        argv.push_back("--ai");
        argv.push_back(spec.c_str());
      }
      for (const auto &spec : modOptArgStorage) {
        argv.push_back("--modoption");
        argv.push_back(spec.c_str());
      }
      if (!replayPathStorage.empty()) {
        argv.push_back("--journal-file");
        argv.push_back(replayPathStorage.c_str());
      }
      // Hibernation (PLAN-persistence task 3b). Both flags are war-only: a
      // skirmish has its own idle exit and no world worth freezing, and
      // `--resume` on a skirmish would ask the store for a snapshot nobody
      // ever took.
      if (resumeFromSnapshot)
        argv.push_back("--resume");
      if (hibernateIdleSeconds > 0) {
        argv.push_back("--hibernate-idle-seconds");
        argv.push_back(hibernateIdleStr.c_str());
      }
      // §8.1: the war's player-slot sizing. Not on the replay path for the
      // same reason nothing else describing the world is — a re-execution
      // rebuilds its block from the header's own modoptions.
      if (playerSlotCap > 0) {
        argv.push_back("--player-slots");
        argv.push_back(playerSlotCapStr.c_str());
      }
    }
    if (devBuildAcknowledged)
      argv.push_back(DevBuildGate::kFlag);
    // Propagate --no-cache so a dev lobby's game servers also refresh
    // their on-disk defs cache each launch (the cache key is
    // content-blind — see DefsCache.h — so without this an edited
    // unit def never reaches the browser). Harmless in prod, where
    // the lobby is never launched with --no-cache.
    if (CacheControl::IsNoCache())
      argv.push_back("--no-cache");
    argv.push_back(nullptr);

    execvp(serverBin.c_str(), const_cast<char *const *>(argv.data()));
    // If execvp returns, it failed
    fprintf(stderr, "ERROR: failed to exec game server: %s\n",
            serverBin.c_str());
    _exit(1);
  } else if (pid > 0) {
    inst.pid = pid;
    inst.state = GameServerInstance::Starting;
    if (isReplay)
      SLOG(SPRING_LOG_NOTICE,
           "spawned REPLAY server pid=%d port=%d for room %u (%s)", pid,
           inst.port, roomId, replayFile.c_str());
    else
      SLOG(SPRING_LOG_NOTICE,
           "spawned game server pid=%d port=%d for room %u "
           "(%zu players, %zu AI, %u pre-allocated player slot(s))%s%s",
           pid, inst.port, roomId, playerRoster.size(), aiSlots.size(),
           playerSlotCap, resumeFromSnapshot ? " --resume" : "",
           hibernateIdleSeconds > 0 ? " (hibernates when idle)" : "");
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
  if (pid <= 0)
    return false;
  // Reap if it's a child of ours and has already exited — otherwise
  // kill(pid, 0) returns success for zombie processes and the lobby
  // never notices the game server has died. WNOHANG returns the pid
  // for an exited child, 0 if still running, -1 (ECHILD) if not our
  // child (e.g. adopted from the game_servers table across restart).
  int status = 0;
  pid_t r = ::waitpid(pid, &status, WNOHANG);
  if (r == pid)
    return false; // reaped zombie — definitely dead
  if (::kill(pid, 0) == 0)
    return true;
  return (errno != ESRCH); // EPERM means alive but not ours; still "alive"
}

int main(int argc, char *argv[]) {
  savedArgc = argc;
  savedArgv = argv;

  // D33: SQLite must be serialized before anything opens a connection —
  // the lobby shares `mapDb` and `db` between the NetworkServer thread and
  // main()'s 10 Hz loop. See Server/SqliteThreading.h for the full account.
  if (!SqliteEnableSerializedMode("spring-lobby"))
    return 1;

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
  // PLAN-client-resilience.md task 4 / §3: "SQLite table with retention (30
  // days)". Rows are pruned by age from the main loop. 0 or less disables
  // pruning entirely (an operator who wants the whole history), which is why
  // the default is a real number and not a sentinel.
  int clientErrorRetentionDays = 30;
  // PLAN-metalstorm-lobby.md §5.3, task 3: a persistent war's game server is
  // deliberately NOT killed when this lobby shuts down — the next lobby's
  // startup adoption pass re-attaches to the live pid, which is the only
  // resume that keeps the sim (nothing snapshots the world yet; §5.4). This
  // flag is the operator's way back to the old behaviour: a developer
  // restarting the stack in a loop wants the machine back, and a harness that
  // leaves wars running leaks a process per run. Env
  // `SPRING_LOBBY_KILL_WARS_ON_EXIT=1` does the same for mprocs-managed runs
  // that have no argv of their own to edit.
  bool killWarsOnExit = [] {
    const char *e = std::getenv("SPRING_LOBBY_KILL_WARS_ON_EXIT");
    return e && *e && std::string(e) != "0";
  }();
  // PLAN-persistence task 3b: how long a war's game server may sit with no
  // connected clients before it checkpoints itself and exits, freeing a process
  // and a port (`--hibernate-idle-seconds` on the spawned server). Task 3a
  // deliberately left the SERVER's default at 0, because a war that exits is
  // unjoinable until something respawns it — that something is this file, so
  // the default lives here and is ON.
  //
  // Five minutes, not five seconds: the window has to be longer than the gap a
  // player leaves by reloading their browser (a reload disconnects, and a war
  // that hibernated in that gap would make every refresh a resume). It also
  // has to be longer than the server's own startup grace, which it is.
  // `--war-hibernate-idle-seconds 0` switches hibernation off, which leaves
  // wars behaving exactly as they did before 3b: the process stays up forever
  // and the lossless resume is the adopted pid.
  int warHibernateIdleSeconds = [] {
    const char *e = std::getenv("SPRING_LOBBY_WAR_HIBERNATE_IDLE_SECONDS");
    return (e && *e) ? std::atoi(e) : 300;
  }();

  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    if (arg == "--port" && i + 1 < argc)
      port = std::atoi(argv[++i]);
    else if (arg == "--promote-admin" && i + 1 < argc)
      promoteAdmin = argv[++i];
    else if (arg == "--db" && i + 1 < argc)
      dbPath = argv[++i];
    else if (arg == "--games-dir" && i + 1 < argc)
      gamesDir = argv[++i];
    else if (arg == "--log-file" && i + 1 < argc)
      logFile = argv[++i];
    else if (arg == "--log-level" && i + 1 < argc)
      logLevel = std::atoi(argv[++i]);
    else if (arg == "--debug") {
      debugMode = true;
      logLevel = SPRING_LOG_DEBUG;
    } else if (arg == "--no-cache") {
      CacheControl::SetNoCache(true);
    } else if (arg == "--dev-direct-start") {
      devDirectStart = true;
    } else if (arg == DevBuildGate::kFlag) {
      devBuildAcknowledged = true;
    } else if (arg == "--direct" && i + 1 < argc) {
      directManifestPath = argv[++i];
    } else if (arg == "--wt-cert" && i + 1 < argc) {
      wtCertPath = argv[++i];
    } else if (arg == "--wt-key" && i + 1 < argc) {
      wtKeyPath = argv[++i];
    } else if (arg == "--replay-dir" && i + 1 < argc) {
      gReplayDir = argv[++i];
    } else if (arg == "--disable-client-error-reports") {
      clientErrorReportsEnabled = false;
    } else if (arg == "--client-error-retention-days" && i + 1 < argc) {
      clientErrorRetentionDays = std::atoi(argv[++i]);
    } else if (arg == "--kill-wars-on-exit") {
      killWarsOnExit = true;
    } else if (arg == "--war-hibernate-idle-seconds" && i + 1 < argc) {
      warHibernateIdleSeconds = std::atoi(argv[++i]);
    } else if (arg == "--game" && i + 1 < argc) {
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
    SLOG(SPRING_LOG_ERROR,
         "--wt-cert and --wt-key must be given together (got only %s)",
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
  int cleaned = db.CleanExpiredSessions(AuthTokens::kAccessTtlSeconds);
  if (cleaned > 0)
    SLOG(SPRING_LOG_INFO, "cleaned %d expired session(s)", cleaned);

  // S2: `--promote-admin <user>` one-shot. Grants the admin role to an
  // already-registered account (privileged console / SQL exec gate) and
  // exits — it never starts the server and never creates an account, so it
  // can't forge credentials. Run once by the operator; ordinary
  // registrations stay "player".
  if (!promoteAdmin.empty()) {
    const bool ok = db.EnsureAdminRole(promoteAdmin);
    if (ok)
      SLOG(SPRING_LOG_NOTICE, "granted admin role to '%s'",
           promoteAdmin.c_str());
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
  sqlite3 *mapDb = nullptr;
  // FULLMUTEX, not plain sqlite3_open: this handle is shared by the network
  // thread (every HTTP route) and the main thread (the 10 Hz poll/reap
  // loop). See the SQLITE_CONFIG_SERIALIZED note at the top of main() —
  // that call already covers this, but stating the flag here keeps the
  // requirement next to the handle it applies to. D33.
  if (const int rc = sqlite3_open_v2(dbPath.c_str(), &mapDb,
                                     SQLITE_OPEN_READWRITE |
                                         SQLITE_OPEN_CREATE |
                                         SQLITE_OPEN_FULLMUTEX,
                                     nullptr);
      rc != SQLITE_OK) {
    // Previously unchecked, so a failed open degraded into "the lobby runs
    // but serves no maps and persists no rooms" — D33's symptom without
    // D33's cause. Refuse to start instead.
    SLOG(SPRING_LOG_ERROR, "failed to open %s: %s (%d)", dbPath.c_str(),
         mapDb ? sqlite3_errmsg(mapDb) : "out of memory", rc);
    sqlite3_close(mapDb);
    springlog_shutdown();
    return 1;
  }
  // Wait out a competing writer on the shared backchannel rather than
  // dropping the write — see kSqliteBusyTimeoutMs.
  SqliteConfigureSharedHandle(mapDb);

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

  // game_servers/game_status — maintained in real-time so external tools
  // (MCP debug server, springcli) can discover running game server ports
  // without querying the lobby HTTP API. Schema-probed same as
  // RoomManager::EnsureTables / MapMetadataDb::EnsureTable.
  GameServersDb::EnsureTables(mapDb);

  // generated_scenarios — procedurally generated wars (scenariogen.py). The
  // row is the record of truth; `scenarios/gen_*.lua` is a cache rebuilt from
  // it below, once per game, before discovery runs. Migrated rather than
  // dropped on a schema bump: unlike game_servers or maps, a row here is the
  // only copy of the thing. See ScenarioDb.h.
  ScenarioDb::EnsureTable(mapDb);

  // war_player_bindings — which side an account holds in a persistent war and
  // the per-player war state that outlives the session (PLAN-metalstorm-lobby
  // §2.5/§5.1, task 4). The game server is the writer; the lobby reads it, and
  // the faction override deletes from it. Created here as well because a lobby
  // that has never launched a war must still be able to serve those paths —
  // and, like ScenarioDb above, it is migrated rather than dropped on a schema
  // bump: a row here is the only copy of the thing.
  WarPlayerBindings::EnsureTable(mapDb);

  // wars / war_sides — the war OBJECT, as opposed to the room it runs in
  // (PLAN-metalstorm-wars.md §1/§9 task 1, WarDirector.h). Strictly an
  // extension of `rooms`: the map, the port, the session kind and the roster
  // stay where RoomManager keeps them, and these two tables carry only what
  // `rooms` has no column for — the war's lifecycle stage, why it was
  // created, and what its sides are supposed to be when no game server is
  // running to be asked. Lobby-only (the Director never touches sim state),
  // and migrated additively rather than dropped for the same reason as the
  // bindings above: a row here is the only copy of the thing.
  WarDirector::EnsureTables(mapDb);

  // war_slot_reservations — the last seat on a side, held for the join that is
  // on its way (PLAN-metalstorm-wars.md §4, task 2). Created here rather than
  // lazily because the busy timeout `EnsureTable` sets on this handle is half
  // the mechanism: without it, losing the last-slot race reports a transport
  // error instead of a full side.
  WarSlotReservations::EnsureTable(mapDb);

  // friend_edges — the §8 social graph (task 9a). Lobby-only: unlike the
  // bindings above, nothing in the game server reads or writes it, so this is
  // the single creation site rather than one of two.
  Friends::EnsureTable(mapDb);

  // game_events — the war's strategic history, appended by the game server and
  // read here as the while-you-were-away digest (PLAN-persistence §4, task
  // 4b). Created from the lobby too, for the same reason and under the same
  // additive-migration rule as the bindings above: the digest query has to
  // work on a lobby that has never launched a war, and the alternative is a
  // failed prepare on every join-preview until one does.
  GameEventsDb::EnsureTable(mapDb);

  // room_runtime_ai — the AI seats a war acquires while it is RUNNING (a
  // caretaker seated on a side whose last human left: PLAN-metalstorm-ai task
  // 4(b), RuntimeAIRoster.h). The game server is both writer and reader — the
  // row carries the sim playerNum the AI holds, which only that process can
  // mint and only that process can honour on resume. The lobby's whole stake in
  // it is the DELETE that goes with the room (room ids are reused), and this
  // create is what makes that delete work on a lobby that has never launched a
  // war.
  RuntimeAIRoster::EnsureTable(mapDb);

  // Helper: persist a game server entry to SQLite
  auto persistGameServer = [&](const GameServerInstance &inst) {
    if (!mapDb)
      return;
    const char *stateStr = "starting";
    switch (inst.state) {
    case GameServerInstance::Starting:
      stateStr = "starting";
      break;
    case GameServerInstance::Running:
      stateStr = "running";
      break;
    case GameServerInstance::Ended:
      stateStr = "ended";
      break;
    case GameServerInstance::Crashed:
      stateStr = "crashed";
      break;
    case GameServerInstance::Hibernated:
      stateStr = "hibernated";
      break;
    }
    ExecPrepared(
        mapDb,
        "INSERT OR REPLACE INTO game_servers (room_id, port, pid, map_id, "
        "game_id, state) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [&](sqlite3_stmt *s) {
          sqlite3_bind_int(s, 1, static_cast<int>(inst.roomId));
          sqlite3_bind_int(s, 2, inst.port);
          sqlite3_bind_int(s, 3, static_cast<int>(inst.pid));
          sqlite3_bind_text(s, 4, inst.mapId.c_str(), -1, SQLITE_TRANSIENT);
          sqlite3_bind_text(s, 5, inst.gameId.c_str(), -1, SQLITE_TRANSIENT);
          sqlite3_bind_text(s, 6, stateStr, -1, SQLITE_TRANSIENT);
        });
  };

  auto removeGameServer = [&](uint32_t roomId) {
    if (!mapDb)
      return;
    // All three rows — the rendezvous row, the readiness flag and the war
    // digest — now go through GameServersDb::DeleteForRoom, because a room
    // being DELETED has to drop them too and never comes through here
    // (PLAN-persistence 4e; RoomManager::DeleteRoomFromDb is the other
    // caller). The reasons they must go are unchanged:
    //
    // The game server normally clears its own game_status row on a clean
    // exit, but a SIGKILL/crash can leave it behind — drop it here too so a
    // dead room never looks "ready".
    //
    // Same reasoning for the war digest, and it started to matter with
    // PLAN-persistence task 3b: nothing ever deleted this row, so a hibernated
    // war's card carried `live: true` and the population and frame it had a
    // minute before it froze, right next to `state: "hibernated"` — two halves
    // of one card contradicting each other, and the stale half is the one with
    // the numbers on it. `live` means "a running server is publishing a
    // digest"; a room with no process is not that (observed live, room 1
    // reporting frame 301 while frozen at 302).
    GameServersDb::DeleteForRoom(mapDb, roomId);
  };

  // Read the readiness flag a running game server publishes into `game_status`
  // (written only by spring-server; see server_main.cpp). Returns true once the
  // server is accepting connections, which the health-check loop uses to flip
  // the room Loading→Active. Missing table/row → not ready (false).
  auto gameServerReady = [&](uint32_t roomId) -> bool {
    if (!mapDb)
      return false;
    sqlite3_stmt *s = nullptr;
    bool ready = false;
    if (sqlite3_prepare_v2(mapDb,
                           "SELECT ready FROM game_status WHERE room_id=?", -1,
                           &s, nullptr) == SQLITE_OK) {
      sqlite3_bind_int(s, 1, static_cast<int>(roomId));
      if (sqlite3_step(s) == SQLITE_ROW)
        ready = sqlite3_column_int(s, 0) != 0;
    }
    if (s)
      sqlite3_finalize(s);
    return ready;
  };

  // Map processing itself still lives entirely in tools/mapconverter (the
  // lobby links only the read-only MapMetadataDb) — but we shell out to it
  // as a startup pre-flight so a lobby start self-heals stale processed
  // output instead of requiring an operator to remember to run it by hand.
  // See RunMapConverterPreflight above and PLAN-metalstorm-impostors.md M10.
  RunMapConverterPreflight(dbPath);
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
  // --- Per-game scenario discovery (PLAN-endtoend.md D10) ---
  // A scenario file IS a war template (PLAN-metalstorm-wars.md §7.1), and the
  // `victory = true` objective it declares is the only terminal condition
  // game_gameover.lua watches. Discovering them here lets the ordinary
  // create-room path default and offer one, instead of leaving the `scenario`
  // modoption writable only by the dev-only /api/rooms/direct manifest — which
  // is how a lobby-created Metalstorm war ended up with no way to finish.
  std::unordered_map<std::string, std::vector<ScenarioDiscovery::ScenarioInfo>>
      scenariosByGame;
  /// Rebuild `<game>/scenarios/gen_*.lua` from the `generated_scenarios` rows
  /// for `gameId`, then re-run discovery over the whole directory.
  ///
  /// WHY MATERIALISE-THEN-DISCOVER RATHER THAN MERGE TWO LISTS. A generated
  /// scenario has to end up in the same list as a shipped one, with the same
  /// `terminal` flag and the same resolved `sides` — and it has to be loadable
  /// by the sim, which reaches it only as `VFS.Include('scenarios/<id>.lua')`.
  /// Writing the file first and then letting `Discover` parse the directory
  /// satisfies both at once, and does it with ONE implementation of "what does
  /// this scenario say": the row's denormalised display name can never drift
  /// from the `name` the sim will actually read, because the lobby never reads
  /// the row's copy. The alternative — synthesising ScenarioInfo from columns
  /// — would be a second parser to keep in step with ScenarioDiscovery.cpp.
  ///
  /// Also the reason the rebuild-from-DB path is exercised on every single
  /// lobby start rather than only by its test: if it broke, the lobby would
  /// stop offering generated wars immediately and visibly.
  auto refreshScenarios = [&](const std::string &gameId) {
    auto pathIt = gamePathsById.find(gameId);
    if (pathIt == gamePathsById.end())
      return;
    ScenarioDb::SyncToDisk(mapDb, gameId, pathIt->second);
    scenariosByGame[gameId] = ScenarioDiscovery::Discover(pathIt->second);
  };

  for (const auto &g : availableGames) {
    gamePathsById[g.id] = g.folderPath;
    gameVersionsById[g.id] = g.version;
    aisByGame[g.id] = AIDiscovery::Discover(enginePath, g.folderPath);
    refreshScenarios(g.id);
  }

  /// Scenarios `gameId` offers — shipped and generated alike, since the
  /// generated ones are materialised into the same directory before discovery
  /// reads it. An empty list for an unknown game.
  ///
  /// Captured by reference everywhere below. `scenariosByGame` is no longer
  /// immutable — `refreshScenarios` replaces a game's vector after an admin
  /// ingest or delete — so the lifetime rule is now: the returned reference is
  /// valid until the next refresh, and every caller consumes it within one
  /// HTTP handler. That holds because NetworkServer dispatches every handler on
  /// its single network thread (NetworkServer.h:177), so no handler can be
  /// reading the vector while another replaces it. `unordered_map` nodes are
  /// stable across value assignment, so `kNone` is the only aliasing subtlety
  /// and it is `static const`.
  auto scenariosFor = [&scenariosByGame](const std::string &gameId)
      -> const std::vector<ScenarioDiscovery::ScenarioInfo> & {
    static const std::vector<ScenarioDiscovery::ScenarioInfo> kNone;
    auto it = scenariosByGame.find(gameId);
    return (it == scenariosByGame.end()) ? kNone : it->second;
  };
  // --- Per-game faction discovery (PLAN-metalstorm-lobby.md task 0) ---
  // gamedata/sidedata.lua factions, keyed by game id for the war-browser-
  // style /api/games/<id>/factions route. A game with no sidedata.lua (or
  // an empty one, e.g. papertanks) simply gets an empty vector — valid,
  // not an error.
  std::unordered_map<std::string, std::vector<FactionData::FactionInfo>> factionsByGame;
  for (const auto &g : availableGames)
    factionsByGame[g.id] = FactionData::Discover(g.folderPath);

  // Registration's faction registry is scoped to Metalstorm specifically,
  // not a union across every game folder this lobby happens to serve.
  // accounts.faction_id is Metalstorm's account model (this plan is
  // PLAN-metalstorm-lobby.md, not a generic multi-game abstraction) — a
  // leftover BAR/ZK/papertanks sidedata.lua (verified live: ZK ships a real
  // one, `{key:"robots", ...}`) would otherwise leak an unrelated faction
  // namespace into Metalstorm registration. Same "Metalstorm needs its own
  // rule" shape as GameOverState::IsEliminationEligible's `gameId !=
  // "metalstorm"` carve-out. Revisit if this lobby ever hosts a second game
  // with its own real faction registration.
  std::unordered_map<std::string, FactionData::FactionInfo> factionRegistry;
  {
    auto it = factionsByGame.find("metalstorm");
    if (it != factionsByGame.end())
      for (const auto &f : it->second)
        factionRegistry.emplace(f.key, f);
  }

  // --- Game server instances ---
  std::unordered_map<uint32_t, GameServerInstance>
      gameServers; // roomId → instance

  /// Everything `warresume` needs about one room, gathered in one place so the
  /// room card, the join route and the health loop cannot disagree about what a
  /// war is (PLAN-persistence task 3b).
  ///
  /// Liveness is by PID, never by the `game_servers` row: a stale row is the
  /// case the whole hold-for-resume path exists for. Readiness is
  /// `game_status.ready`, the only honest "is it serving?" signal — the room's
  /// own Loading→Active flip is driven FROM it by the health loop.
  auto warFactsFor = [&](const GameRoom &room) -> warresume::WarFacts {
    warresume::WarFacts f;
    f.roomState = room.state;
    if (auto it = gameServers.find(room.id); it != gameServers.end()) {
      f.serverProcessAlive = isProcessAlive(it->second.pid);
      if (f.serverProcessAlive)
        f.serverReady = gameServerReady(room.id);
    }
    if (room.sessionKind == SessionKind::PersistentWar) {
      f.snapshot = warresume::LatestSnapshot(mapDb, room.gameId, room.id);
      // The E1 pre-flight's other half (PLAN-persistence task 3c): what the
      // spawn would run. `mapHash` is the room's map id, which is what
      // server_main stamps into StoreConfig.mapHash, so a room re-pointed at
      // another map (or a map re-processed under the same id — that one the
      // stamp cannot see) is caught here rather than by an aborting process.
      f.binary.engineHash = gameServerEngineHash();
      f.binary.mapHash = room.mapId;
    }
    return f;
  };

  // A room whose game server is gone. Four callers reach this state (a stale
  // `game_servers` row at startup, two startup sweeps over Loading/Active
  // rooms with nothing adopted, and the health-check loop watching a pid
  // exit), and every one of them used to recycle the room to Filling.
  // PLAN-metalstorm-lobby.md §5.2/§5.3, task 3: that is right for a skirmish
  // and wrong for a war — it demotes a running world into a set-up screen its
  // host has to re-launch, and every player who walked up to it in between
  // would find one. A war is held as a war and resumed by the next joiner
  // (see the /api/rooms/join resume path); only its dead port is cleared, so
  // nobody is offered a rejoin target that answers nothing.
  auto onOrphanedRoom = [&](uint32_t rid, const char *why) {
    auto *room = rooms.GetRoom(rid);
    if (!room)
      return;
    if (ActionForOrphanedRoom(room->sessionKind) ==
        OrphanedRoomAction::HoldForResume) {
      room->gameServerPort = 0;
      rooms.PersistRoomGameSession(rid);
      SLOG(SPRING_LOG_NOTICE,
           "war room %u: %s — held for resume (state kept; the next join "
           "brings it back up)",
           rid, why);
      return;
    }
    rooms.ResetRoomForNextGame(rid);
  };

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
    sqlite3_stmt *stmt = nullptr;
    sqlite3_prepare_v2(mapDb,
                       "SELECT room_id, port, pid, map_id, game_id, state "
                       "FROM game_servers",
                       -1, &stmt, nullptr);

    std::vector<uint32_t> staleRooms;
    size_t adopted = 0;
    while (stmt && sqlite3_step(stmt) == SQLITE_ROW) {
      uint32_t rid = sqlite3_column_int(stmt, 0);
      int port = sqlite3_column_int(stmt, 1);
      pid_t pid = sqlite3_column_int(stmt, 2);
      const unsigned char *mid = sqlite3_column_text(stmt, 3);
      const unsigned char *gid = sqlite3_column_text(stmt, 4);
      const unsigned char *st = sqlite3_column_text(stmt, 5);
      const std::string stateStr =
          st ? reinterpret_cast<const char *>(st) : "running";

      // A hibernated/crashed war (PLAN-persistence task 3b) is a row with NO
      // process by construction — pid 0, written by the health loop when the
      // server checkpointed and exited. It is not stale: deleting it would lose
      // the "frozen at frame N" the fleet view shows, and the pid test below
      // would delete it every single lobby start. Checked on the state string
      // rather than on the pid so a recycled pid can never make it adoptable.
      if (stateStr == "hibernated" || stateStr == "crashed") {
        GameServerInstance held;
        held.roomId = rid;
        held.port = 0; // the port was handed back; the next resume picks one
        held.pid = 0;
        held.mapId = mid ? reinterpret_cast<const char *>(mid) : "";
        held.gameId = gid ? reinterpret_cast<const char *>(gid) : "";
        held.state = (stateStr == "hibernated") ? GameServerInstance::Hibernated
                                                : GameServerInstance::Crashed;
        gameServers[rid] = held;
        SLOG(SPRING_LOG_NOTICE,
             "adopted %s war room=%u (no process — the next join resumes it)",
             stateStr.c_str(), rid);
        continue;
      }

      if (!isProcessAlive(pid)) {
        staleRooms.push_back(rid);
        continue;
      }

      GameServerInstance inst;
      inst.roomId = rid;
      inst.port = port;
      inst.pid = pid;
      inst.mapId = mid ? reinterpret_cast<const char *>(mid) : "";
      inst.gameId = gid ? reinterpret_cast<const char *>(gid) : "";
      // We don't know the live process's real state without
      // talking to it. Trust the persisted state for now; the
      // health-check loop downgrades to Ended if the pid dies.
      if (stateStr == "starting")
        inst.state = GameServerInstance::Starting;
      else if (stateStr == "ended")
        inst.state = GameServerInstance::Ended;
      else if (stateStr == "crashed")
        inst.state = GameServerInstance::Crashed;
      else
        inst.state = GameServerInstance::Running;

      gameServers[rid] = inst;
      // Mirror the live port back into the in-memory room so the
      // browser shows the right "Rejoin" target.
      if (auto *room = rooms.GetRoom(rid)) {
        room->gameServerPort = static_cast<uint16_t>(port);
      }
      adopted++;
      SLOG(SPRING_LOG_NOTICE, "adopted game server room=%u pid=%d port=%d (%s)",
           rid, (int)pid, port, stateStr.c_str());
    }
    if (stmt)
      sqlite3_finalize(stmt);

    for (auto rid : staleRooms) {
      ExecPrepared(mapDb, "DELETE FROM game_servers WHERE room_id=?",
                   [&](sqlite3_stmt *s) {
                     sqlite3_bind_int(s, 1, static_cast<int>(rid));
                   });
      // Room metadata is persistent; if a row in `rooms` matches, recycle it
      // so the host can launch again — unless it is a war, which is held
      // (onOrphanedRoom).
      onOrphanedRoom(rid, "its game server process is gone (stale row)");
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
  for (GameRoom *room : rooms.GetAllRooms()) {
    if ((room->state == ERoomState::Loading ||
         room->state == ERoomState::Active) &&
        gameServers.find(room->id) == gameServers.end()) {
      SLOG(SPRING_LOG_NOTICE, "room %u: %s with no live game server", room->id,
           room->state == ERoomState::Active ? "Active" : "Loading");
      onOrphanedRoom(room->id, "no live game server at startup");
    }
  }

  // --- Reap abandoned rooms ---
  // The lobby is HTTP-only — no persistent lobby socket means a closed
  // browser never abandons its room, so non-persistent rooms with no live
  // game pile up in the DB and reload on every restart. Sweep them on
  // startup and periodically (below). Idle threshold is a proxy for player
  // presence (the HTTP lobby tracks no liveness). Rooms hosting a live game
  // and persistent rooms are always kept.
  constexpr int64_t kRoomIdleReapSeconds = 30 * 60; // 30 minutes
  {
    auto reaped = rooms.ReapStaleRooms(kRoomIdleReapSeconds);
    if (!reaped.empty())
      SLOG(SPRING_LOG_NOTICE, "startup: reaped %zu abandoned room(s)",
           reaped.size());
  }

  // --- Rows left by rooms that were deleted before the rule existed ---
  // PLAN-persistence task 4e. `DeleteRoomFromDb` keeps a war's story from
  // outliving its room from here on; this collects what earlier lobbies left.
  // It is not a leak sweep: the id counter re-seeds as MAX(id)+1 over the
  // survivors and climbs back through those very numbers, so every orphaned
  // row is on the reissue path (this tree's own database held five orphaned
  // `game_status` rows — rooms 95, 124, 310, 317 and 330 — against a `rooms`
  // table containing room 1). After the reap above, so a room reaped in the
  // same startup is purged in the same pass rather than a restart later.
  {
    const int purged = rooms.PurgeOrphanedWarRows();
    if (purged > 0)
      SLOG(SPRING_LOG_NOTICE,
           "startup: purged war rows for %d deleted room(s)", purged);
  }

  // --- Prune expired crash reports (PLAN-client-resilience task 4) ---
  // Once at startup and hourly below. A lobby that is restarted more often
  // than it runs for an hour still prunes; one that runs for weeks does not
  // need a restart to stay bounded.
  {
    const int pruned = db.PruneClientErrors(clientErrorRetentionDays);
    if (pruned > 0)
      SLOG(SPRING_LOG_NOTICE,
           "startup: pruned %d client error report(s) older than %d days",
           pruned, clientErrorRetentionDays);
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
    for (auto *room : rooms.GetAllRooms()) {
      const auto st = static_cast<int>(room->state);
      const bool inFlight = (st >= 3 && st <= 4); // Loading, Active
      if (!inFlight)
        continue;
      if (gameServers.count(room->id) > 0)
        continue; // adopted; alive
      SLOG(SPRING_LOG_NOTICE, "room %u stuck in state=%d with no game-server",
           room->id, st);
      // Routed through the same policy as the sweep above (which this one
      // duplicates): a held war stays Loading/Active by design, so a second
      // pass that reset unconditionally would undo the hold a few lines later.
      onOrphanedRoom(room->id, "stuck in-flight with no game-server");
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
      .validateToken = [&db](const std::string &authHeader) -> int64_t {
        const int64_t id = HttpAuth::ValidateAuth(db, authHeader);
        // Task 9a: the ONE presence funnel. Every RouteAuth::TokenRequired /
        // AdminOnly route in this process is dispatched through this callback
        // before its handler runs, so stamping here (and nowhere else) is what
        // makes "online in the lobby" a single fact rather than a set of
        // per-route ones that drift. `requireAuth` deliberately does NOT
        // stamp: it re-validates inside handlers the dispatcher has already
        // admitted. In-memory by design — see FriendPresence.h.
        if (id > 0) gPresence.Touch(id, static_cast<int64_t>(std::time(nullptr)));
        return id;
      },
      .isAdmin = [&db](int64_t userId) -> bool {
        auto user = db.FindUserById(userId);
        return user && user->role == "admin";
      },
  });

  // SSE channel for real-time room list pushes (replaces client polling)
  uint32_t roomStreamChannel = net.AddSSE("/api/rooms/stream");

  // Maps endpoint — full metadata from SQLite
  net.AddHttpGet(
      "/api/maps", RouteAuth::Public,
      [mapDb](const std::string &) -> HttpResponse {
        MapMetadataDb db;
        bool ok = true;
        auto maps = db.GetAllMaps(mapDb, &ok);
        if (!ok) {
          // D33: never answer a faulted handle with `200 []`. That is what
          // turned a dead DB connection into "No maps found in
          // content/maps/" in the Create Game dialog and cost a whole
          // session before anyone looked at the lobby log. 503 + an
          // explicit reason so the client can say what is actually wrong.
          SLOG(SPRING_LOG_ERROR,
               "/api/maps: map read FAILED (%s) — serving 503, not an empty "
               "list. The database handle is faulted; the maps on disk and "
               "the `maps` table are most likely fine. Restart the lobby.",
               sqlite3_errmsg(mapDb));
          nlohmann::json err;
          err["error"] = "map_database_unavailable";
          err["detail"] = sqlite3_errmsg(mapDb);
          std::string body = err.dump();
          return {.contentType = "application/json",
                  .body = std::vector<uint8_t>(body.begin(), body.end()),
                  .status = 503};
        }
        nlohmann::json arr = nlohmann::json::array();
        for (const auto &m : maps) {
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
          for (const auto &sp : m.startPositions)
            mj["startPositions"].push_back({{"x", sp.x}, {"z", sp.z}});
          mj["hasLuaGaia"] = m.hasLuaGaia;
          mj["minimapUrl"] = "/api/maps/data/" + m.id + "/minimap.ktx2";
          arr.push_back(std::move(mj));
        }
        std::string json = arr.dump();
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json",
                .body = std::move(body),
                .status = 200};
      });

  // Static map / game / engine assets are no longer served by the
  // lobby. In dev the Vite plugin (client/vite-static-data-plugin.ts)
  // serves them with proper Last-Modified / ETag revalidation. In
  // production an external static server (nginx / apache / CDN) is
  // required for `/api/games/data/*`, `/api/maps/data/*` (except
  // the dynamic `metadata.json` below), `/api/engine/data/*` and
  // `/api/maps/thumb/*`, plus the built client bundle from
  // `client/dist/`. See AGENTS.md for the production deployment notes.
  //
  // The only thing the lobby still serves under `/api/maps/data/*`
  // is the dynamic `metadata.json` endpoint, because it pulls live
  // map data out of the MapMetadataDb (SQLite) and composes URLs
  // pointing at the static files.
  net.AddHttpGet(
      "/api/maps/data/*", RouteAuth::Public,
      [mapDb](const std::string &url) -> HttpResponse {
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
            for (const auto &sp : m.startPositions)
              j["startPositions"].push_back({{"x", sp.x}, {"z", sp.z}});

            // Feature types
            j["featureTypes"] = m.featureTypes;

            // Features
            j["features"] = nlohmann::json::array();
            for (const auto &f : m.features) {
              j["features"].push_back({
                  {"typeIndex", f.featureType},
                  {"x", f.x},
                  {"y", f.y},
                  {"z", f.z},
                  {"rotation", f.rotation},
                  {"relativeSize", f.relativeSize},
              });
            }

            // Feature defs
            j["featureDefs"] = nlohmann::json::array();
            for (const auto &d : m.featureDefs) {
              std::string modelUrl =
                  d.modelFile.empty()
                      ? ""
                      : "/api/maps/data/" + m.id + "/features/" + d.modelFile;
              std::string texUrl =
                  d.textureFile.empty()
                      ? ""
                      : "/api/maps/data/" + m.id + "/features/" + d.textureFile;
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
            auto decalUrl = [&](const std::string &f) -> std::string {
              if (f.empty())
                return "";
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
                  m.decals.splatScales[0],
                  m.decals.splatScales[1],
                  m.decals.splatScales[2],
                  m.decals.splatScales[3],
              };
              dj["splatMults"] = {
                  m.decals.splatMults[0],
                  m.decals.splatMults[1],
                  m.decals.splatMults[2],
                  m.decals.splatMults[3],
              };
              dj["splatDetailNormalDiffuseAlpha"] =
                  m.decals.splatDetailNormalDiffuseAlpha;
              j["decals"] = std::move(dj);
            }

            // Water
            {
              nlohmann::json wj;
              wj["baseColor"] = {m.water.baseColor[0], m.water.baseColor[1],
                                 m.water.baseColor[2]};
              wj["surfaceColor"] = {m.water.surfaceColor[0],
                                    m.water.surfaceColor[1],
                                    m.water.surfaceColor[2]};
              wj["minColor"] = {m.water.minColor[0], m.water.minColor[1],
                                m.water.minColor[2]};
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
                // Composed from the maps DB on every request, under a URL that
                // never changes — immutable only if this caller stamped it
                // (PLAN-protocol-guard task 5; `fetchMapDataHttp` does not).
                .cacheControl = CacheControl::VersionedAssetHeader(
                    NetworkServer::CurrentQueryString()),
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
  // requires nginx/apache/CDN to serve those paths (see AGENTS.md
  // production deployment notes).

  // --- Process management API ---
  // PLAN-security-hardening G12: PID/port disclosure is compiled out entirely
  // under SPRING_PROD (task 2). In dev builds it now also refuses non-loopback
  // callers (task 11): the LocalhostOrAdmin tag on a GET route degrades to a
  // forgery-proof loopback-only check in DispatchGet — the local spring-debug
  // MCP keeps working, a remote peer on a dev box bound public can no longer
  // enumerate game-server PIDs/ports for recon.
#ifndef SPRING_PROD
  net.AddHttpGet("/api/processes", RouteAuth::LocalhostOrAdmin,
                 [&gameServers](const std::string &) -> HttpResponse {
                   nlohmann::json arr = nlohmann::json::array();
                   for (const auto &[roomId, inst] : gameServers) {
                     const char *stateStr = "unknown";
                     switch (inst.state) {
                     case GameServerInstance::Starting:
                       stateStr = "starting";
                       break;
                     case GameServerInstance::Running:
                       stateStr = "running";
                       break;
                     case GameServerInstance::Ended:
                       stateStr = "ended";
                       break;
                     case GameServerInstance::Crashed:
                       stateStr = "crashed";
                       break;
                     case GameServerInstance::Hibernated:
                       stateStr = "hibernated";
                       break;
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
                   return {.contentType = "application/json",
                           .body = {json.begin(), json.end()},
                           .status = 200,
                           .cacheControl = "no-cache"};
                 });
#endif // !SPRING_PROD

  // --- HTTP auth endpoints ---
  HttpAuth::RegisterEndpoints(net, db, factionRegistry);

  // Version endpoint — clients use this to get the build stamp for
  // cache-busting
  net.AddHttpGet(
      "/api/version", RouteAuth::Public,
      [clientErrorReportsEnabled](const std::string &) -> HttpResponse {
        std::string json =
            std::string("{\"engine\":\"springweb\"") + ",\"stamp\":\"" +
            CacheControl::BuildStamp() + "\"" +
            ",\"no_cache\":" + (CacheControl::IsNoCache() ? "true" : "false") +
            ",\"errorReportingEnabled\":" +
            (clientErrorReportsEnabled ? "true" : "false") + "}";
        return {.contentType = "application/json",
                .body = {json.begin(), json.end()},
                .status = 200,
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
  net.AddHttpPost(
      "/api/client-errors", RouteAuth::TokenRequired,
      [&db](const std::string &, const std::string &body,
            const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0)
          return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

        // Client caps its own payload at 32KB; 40KB gives headroom for JSON
        // overhead without trusting the client to actually enforce its cap.
        if (body.size() > 40 * 1024)
          return HttpAuth::JsonResponse(413, R"({"error":"report too large"})");

        if (db.CountRecentClientErrors(userId, 3600) >= 20)
          return HttpAuth::JsonResponse(429, R"({"error":"rate limited"})");

        try {
          nlohmann::json j =
              nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/true);
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
            for (const auto &line : j["log_ring"]) {
              if (!line.is_string())
                continue;
              if (!joined.empty())
                joined += "\n";
              joined += line.get<std::string>();
            }
            rec.logRing = joined;
          }

          int64_t id = db.InsertClientError(rec);
          std::string resp = "{\"ok\":true,\"id\":" + std::to_string(id) + "}";
          return {.contentType = "application/json",
                  .body = {resp.begin(), resp.end()},
                  .status = 200};
        } catch (const std::exception &) {
          return HttpAuth::JsonResponse(400, R"({"error":"malformed report"})");
        }
      });

  // PLAN-metalstorm-scripting.md task 6: command-composer presets, stored
  // per account. Each preset is a filled CommandIntent (verb/subject/
  // target/priority/when) — the server stores `intent` opaquely and never
  // parses or executes it; re-issuing a preset re-runs the client's own
  // compile (compile-table.ts). No saved logic, no triggers-on-triggers.
  // Scoped to the caller's own user id (TokenRequired), same auth shape as
  // /api/client-errors above.
  net.AddHttpPost(
      "/api/presets/list", RouteAuth::TokenRequired,
      [&db](const std::string &, const std::string &,
            const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0)
          return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

        nlohmann::json arr = nlohmann::json::array();
        for (const auto &p : db.GetCommandPresets(userId)) {
          try {
            nlohmann::json entry;
            entry["name"] = p.name;
            entry["updated_at"] = p.updatedAt;
            entry["intent"] = nlohmann::json::parse(p.intentJson);
            arr.push_back(std::move(entry));
          } catch (const std::exception &) {
            continue; // corrupt row — skip rather than send unparsable JSON to
                      // the client
          }
        }
        nlohmann::json resp;
        resp["presets"] = arr;
        std::string json = resp.dump();
        return {.contentType = "application/json",
                .body = {json.begin(), json.end()},
                .status = 200,
                .cacheControl = "no-store"};
      });

  net.AddHttpPost(
      "/api/presets/save", RouteAuth::TokenRequired,
      [&db](const std::string &, const std::string &body,
            const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0)
          return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

        // A filled intent (a handful of slot values) is nowhere near this
        // size; the cap exists to reject abuse, not to constrain a real one.
        if (body.size() > 8 * 1024)
          return HttpAuth::JsonResponse(413, R"({"error":"preset too large"})");

        try {
          nlohmann::json j =
              nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/true);
          if (!j.is_object() || !j.contains("name") || !j.contains("intent"))
            return HttpAuth::JsonResponse(400, R"({"error":"bad request"})");

          std::string name = j.value("name", "");
          if (name.empty() || name.size() > 80)
            return HttpAuth::JsonResponse(
                400,
                R"({"error":"invalid name - must be 1 to 80 characters"})");

          // Cap only bites on genuinely new names — re-saving an existing
          // preset (editing it in place) is always allowed.
          if (!db.CommandPresetExists(userId, name) &&
              db.CountCommandPresets(userId) >= 50)
            return HttpAuth::JsonResponse(
                429, R"({"error":"preset limit reached - max 50"})");

          std::string intentJson = j["intent"].dump();
          if (!db.SaveCommandPreset(userId, name, intentJson))
            return HttpAuth::JsonResponse(500, R"({"error":"save failed"})");

          return HttpAuth::JsonResponse(200, R"({"ok":true})");
        } catch (const std::exception &) {
          return HttpAuth::JsonResponse(400, R"({"error":"malformed preset"})");
        }
      });

  net.AddHttpPost(
      "/api/presets/delete", RouteAuth::TokenRequired,
      [&db](const std::string &, const std::string &body,
            const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0)
          return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

        try {
          nlohmann::json j =
              nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/true);
          std::string name = j.value("name", "");
          if (name.empty())
            return HttpAuth::JsonResponse(400, R"({"error":"invalid name"})");

          bool deleted = db.DeleteCommandPreset(userId, name);
          return HttpAuth::JsonResponse(200, deleted ? R"({"ok":true})"
                                                     : R"({"ok":false})");
        } catch (const std::exception &) {
          return HttpAuth::JsonResponse(400,
                                        R"({"error":"malformed request"})");
        }
      });

  // ─────── PLAN-gm-tools: GM dashboard + admin verbs (lobby side) ───────
  // The GM per-game verbs (pause/rollback/grant/broadcast/inspect/kick) live
  // on each game server's own /api/gm/<verb> plane (browser→game port, same
  // admin token — the proven admin path; there is no lobby→game HTTP client).
  // The lobby owns: the fleet/timeline data (shared SQLite), account-level
  // ban, and the server-rendered dashboard page. These are the *production*
  // GM surface, so unlike /api/exec they are NOT compiled out under
  // SPRING_PROD.
  auto requireLobbyAdmin =
      [&db](const HttpRequestHeaders &headers, int64_t &userId,
            std::string &username) -> std::optional<HttpResponse> {
    userId = HttpAuth::ValidateToken(db, headers.authorization);
    if (userId <= 0)
      return HttpAuth::JsonResponse(401,
                                    R"({"ok":false,"error":"unauthorized"})");
    auto user = db.FindUserById(userId);
    if (!user || user->role != "admin")
      return HttpAuth::JsonResponse(
          403, R"({"ok":false,"error":"forbidden — admin role required"})");
    username = user->username;
    return std::nullopt;
  };

  // GET /admin — the server-rendered dashboard shell. Public (it's just HTML/JS
  // with its own login); every data route it calls is POST + AdminOnly.
  net.AddHttpGet("/admin", RouteAuth::Public,
                 [](const std::string &) -> HttpResponse {
                   std::string html = kGmDashboardHtml;
                   return {.contentType = "text/html; charset=utf-8",
                           .body = {html.begin(), html.end()},
                           .status = 200,
                           .cacheControl = "no-cache"};
                 });

  // POST /api/admin/fleet — every game server + its latest sim-health metrics.
  // GET can't carry a token (dispatch gate only sees POST headers), so admin
  // data endpoints are POST.
  net.AddHttpPost(
      "/api/admin/fleet", RouteAuth::AdminOnly,
      [mapDb,
       requireLobbyAdmin](const std::string &, const std::string &,
                          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json games = nlohmann::json::array();
        if (mapDb) {
          // game_servers ⟕ game_status ⟕ latest game_metrics row per room.
          const char *sql =
              "SELECT gs.room_id, gs.port, gs.pid, gs.map_id, gs.game_id, "
              "gs.state, "
              "       st.ready, st.client_count, "
              "       m.frame, m.tick_p95_us, m.frames_behind, m.entity_count, "
              "       m.sim_fps, m.uptime_sec, m.db_size_bytes, "
              "m.snapshot_age_sec, m.extra_json "
              "FROM game_servers gs "
              "LEFT JOIN game_status st ON st.room_id = gs.room_id "
              "LEFT JOIN (SELECT room_id, MAX(id) AS mid FROM game_metrics "
              "GROUP BY room_id) lm "
              "       ON lm.room_id = gs.room_id "
              "LEFT JOIN game_metrics m ON m.id = lm.mid "
              "ORDER BY gs.room_id";
          sqlite3_stmt *s = nullptr;
          if (sqlite3_prepare_v2(mapDb, sql, -1, &s, nullptr) == SQLITE_OK) {
            auto colInt = [&](int c) -> nlohmann::json {
              return sqlite3_column_type(s, c) == SQLITE_NULL
                         ? nlohmann::json(nullptr)
                         : nlohmann::json(sqlite3_column_int64(s, c));
            };
            auto colTxt = [&](int c) -> std::string {
              auto *t = sqlite3_column_text(s, c);
              return t ? reinterpret_cast<const char *>(t) : "";
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
                                 ? nlohmann::json(nullptr)
                                 : nlohmann::json(sqlite3_column_double(s, 12));
              g["uptime_sec"] = colInt(13);
              g["db_size_bytes"] = colInt(14);
              g["snapshot_age_sec"] = colInt(15);
              // Lobby-evaluated badges: these read columns the lobby already
              // has and need no cooperation from the game server.
              nlohmann::json alarms = nlohmann::json::array();
              const std::string state = colTxt(5);
              if (sqlite3_column_type(s, 10) != SQLITE_NULL &&
                  sqlite3_column_int(s, 10) > 60)
                alarms.push_back(
                    {{"label", "lag"}, {"crit", true}, {"detail", "frames behind"}});
              if (sqlite3_column_type(s, 14) != SQLITE_NULL &&
                  sqlite3_column_int64(s, 14) > 1024LL * 1024 * 1024)
                alarms.push_back(
                    {{"label", "db"}, {"crit", false}, {"detail", "db over 1 GiB"}});
              if (state == "crashed")
                alarms.push_back(
                    {{"label", "crashed"}, {"crit", true}, {"detail", "server exited"}});
              // PLAN-long-uptime task 3: the growth alarms are evaluated by
              // the game server (it is the only process that can see a Lua
              // heap or an id pool) and ride the metric row's extra_json. The
              // lobby merges rather than re-derives — thresholds live in one
              // place, next to the counters they apply to.
              const std::string extraJson = colTxt(16);
              std::vector<growth::Alarm> growthAlarms;
              growth::ParseAlarms(extraJson, growthAlarms);
              for (const auto &a : growthAlarms)
                alarms.push_back({{"label", a.label},
                                  {"crit", a.crit},
                                  {"detail", a.detail}});
              g["alarms"] = alarms;
              // The raw counters too, so the drill-down can chart growth
              // without a second round trip. Absent (not zeroed) when the row
              // predates this or the gather found nothing.
              if (!extraJson.empty()) {
                nlohmann::json extra =
                    nlohmann::json::parse(extraJson, nullptr, false);
                if (!extra.is_discarded() && extra.is_object() &&
                    extra.contains("growth"))
                  g["growth"] = extra["growth"];
              }
              games.push_back(std::move(g));
            }
          }
          if (s)
            sqlite3_finalize(s);
        }
        nlohmann::json out;
        out["ok"] = true;
        out["games"] = games;
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/admin/game {roomId} — metric timeline + audit tail for one game.
  net.AddHttpPost(
      "/api/admin/game", RouteAuth::AdminOnly,
      [mapDb, &db,
       requireLobbyAdmin](const std::string &, const std::string &body,
                          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400,
                                        R"({"ok":false,"error":"bad json"})");
        const int roomId = j.value("roomId", -1);
        if (roomId < 0)
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"roomId required"})");

        nlohmann::json timeline = nlohmann::json::array();
        if (mapDb) {
          sqlite3_stmt *s = nullptr;
          const char *sql =
              "SELECT frame, taken_at, resolution, tick_p95_us, frames_behind, "
              "entity_count, client_count, sim_fps, uptime_sec, db_size_bytes, "
              "extra_json "
              "FROM game_metrics WHERE room_id=? ORDER BY id DESC LIMIT 200";
          if (sqlite3_prepare_v2(mapDb, sql, -1, &s, nullptr) == SQLITE_OK) {
            sqlite3_bind_int(s, 1, roomId);
            while (sqlite3_step(s) == SQLITE_ROW) {
              nlohmann::json row = {
                  {"frame", sqlite3_column_int(s, 0)},
                  {"taken_at", sqlite3_column_int64(s, 1)},
                  {"resolution",
                   reinterpret_cast<const char *>(sqlite3_column_text(s, 2))},
                  {"tick_p95_us", sqlite3_column_int64(s, 3)},
                  {"frames_behind", sqlite3_column_int64(s, 4)},
                  {"entity_count", sqlite3_column_int(s, 5)},
                  {"client_count", sqlite3_column_int(s, 6)},
                  {"sim_fps", sqlite3_column_double(s, 7)},
                  {"uptime_sec", sqlite3_column_int64(s, 8)},
                  {"db_size_bytes", sqlite3_column_int64(s, 9)},
              };
              // PLAN-long-uptime task 3: hoist the growth counters to the top
              // level of the row so the drill-down charts a series rather than
              // re-parsing a string per point. Rows written before this
              // existed (and hourly-downsampled rows, which carry the
              // *promoted* raw row's extra_json) simply have no `growth` key.
              if (const auto *t = sqlite3_column_text(s, 10)) {
                const nlohmann::json extra = nlohmann::json::parse(
                    reinterpret_cast<const char *>(t), nullptr, false);
                if (!extra.is_discarded() && extra.is_object() &&
                    extra.contains("growth"))
                  row["growth"] = extra["growth"];
              }
              timeline.push_back(std::move(row));
            }
          }
          if (s)
            sqlite3_finalize(s);
        }
        // Audit tail for this game: GM verbs audit with roomTag "room=<id>"
        // or target "frame=…"; match on the room tag. (admin_audit has no
        // room column — the tag match is a pragmatic per-game filter.)
        nlohmann::json audit = nlohmann::json::array();
        {
          const std::string tag = "room=" + std::to_string(roomId);
          // Anchored match, not a bare substring: the tag must sit on a
          // token boundary and be followed by a non-digit (or end of
          // string), otherwise roomId=1 also matches "room=10"/"room=199"
          // and leaks other rooms' audit rows. Writers (GmVerbs roomTag,
          // direct_start) compose the tag as exactly "room=<id>", but
          // keep the boundary check so a future "room=<id> …" digest
          // still matches.
          const auto hasRoomTag = [&tag](const std::string &s) {
            for (size_t pos = s.find(tag); pos != std::string::npos;
                 pos = s.find(tag, pos + 1)) {
              if (pos > 0 &&
                  std::isalnum(static_cast<unsigned char>(s[pos - 1])))
                continue;
              const size_t end = pos + tag.size();
              if (end < s.size() &&
                  std::isdigit(static_cast<unsigned char>(s[end])))
                continue;
              return true;
            }
            return false;
          };
          for (const auto &e : db.GetRecentAuditEntries(400)) {
            if (!hasRoomTag(e.argsDigest) && !hasRoomTag(e.target))
              continue;
            audit.push_back({{"createdAt", e.createdAt},
                             {"username", e.username},
                             {"action", e.action},
                             {"target", e.target},
                             {"argsDigest", e.argsDigest}});
            if (audit.size() >= 60)
              break;
          }
        }
        nlohmann::json out;
        out["ok"] = true;
        out["timeline"] = timeline;
        out["audit"] = audit;
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/admin/drain {timeout_ms, escalate} — the deploy drain
  // (PLAN-persistence task 3c).
  //
  // SIGTERM every game server this lobby owns, wait for each to checkpoint and
  // exit, and report which worlds survived. This is the operator's step BEFORE
  // replacing the binary, and the report is what tells them whether it is safe
  // to: `lossy` counts resumable worlds that were lost, and `drained` is false
  // while anything is still running.
  //
  // Every kind is signalled, wars included — see DeployDrain.h for why this is
  // deliberately NOT `ActionOnLobbyExit`'s rule (which leaves a war running,
  // correct for a lobby restart and exactly wrong for a deploy: the binary that
  // process is executing is about to be replaced under it).
  //
  // TWO THINGS THIS HANDLER DELIBERATELY DOES NOT DO:
  //   * it does not touch room state, `gameServers` or `game_servers`. The
  //     hibernated/crashed classification and the recycle-or-hold decision are
  //     the health loop's, and this lane has twice paid for a second copy of a
  //     policy. The exits it causes are observed there a fraction of a second
  //     later, exactly as an idle hibernation is.
  //   * it does not iterate any shared container while it waits. Targets are
  //     snapshotted into a local vector in one pass and the (up to `timeout_ms`)
  //     wait polls only local pids — the health loop runs on the main thread and
  //     erases from `gameServers`, so a handler holding an iterator across a
  //     ten-second sleep would be a use-after-erase rather than mere contention.
  //
  // It IS synchronous, so the lobby's HTTP surface is unresponsive for as long
  // as the slowest server takes to checkpoint. That is accepted: a drain is the
  // last thing an operator does before stopping the lobby, and an asynchronous
  // one would have to publish progress somewhere just to be waited on.
  net.AddHttpPost(
      "/api/admin/drain", RouteAuth::AdminOnly,
      [mapDb, &db, &rooms, &gameServers,
       requireLobbyAdmin](const std::string &, const std::string &body,
                          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        if (j.is_discarded())
          j = nlohmann::json::object();
        // 10 s covers a Metalstorm checkpoint with room to spare (task 3a
        // measured 12–13 kB written in well under a second); the 120 s ceiling
        // exists so a typo cannot wedge the lobby's HTTP surface for an hour.
        int timeoutMs = j.value("timeout_ms", 10000);
        if (timeoutMs < 100) timeoutMs = 100;
        if (timeoutMs > 120000) timeoutMs = 120000;
        const bool escalate = j.value("escalate", true);

        // One pass over the shared state, then nothing but local copies.
        struct Pending {
          deploydrain::DrainTarget target;
          warresume::SnapshotFacts before;
          bool exited = false;
          bool escalated = false;
          int64_t waitedMs = 0;
        };
        std::vector<Pending> pending;
        for (const auto &[roomId, inst] : gameServers) {
          Pending p;
          p.target.roomId = roomId;
          p.target.pid = inst.pid;
          p.target.alive = inst.pid > 0 && isProcessAlive(inst.pid);
          p.target.isReplay = gReplayRooms.count(roomId) > 0;
          if (const auto *room = rooms.GetRoom(roomId)) {
            p.target.kind = room->sessionKind;
            if (p.target.kind == SessionKind::PersistentWar)
              p.before = warresume::LatestSnapshot(mapDb, room->gameId, roomId);
          }
          pending.push_back(std::move(p));
        }

        const auto t0 = std::chrono::steady_clock::now();
        const auto elapsedMs = [&t0]() -> int64_t {
          return std::chrono::duration_cast<std::chrono::milliseconds>(
                     std::chrono::steady_clock::now() - t0)
              .count();
        };

        int signalled = 0;
        for (auto &p : pending) {
          if (deploydrain::DecideDrainAction(p.target) !=
              deploydrain::DrainAction::Signal)
            continue;
          kill(p.target.pid, SIGTERM);
          ++signalled;
        }
        SLOG(SPRING_LOG_NOTICE,
             "drain requested by '%s': SIGTERM to %d game server(s), waiting up "
             "to %d ms",
             uname.c_str(), signalled, timeoutMs);

        // Wait on local pids only.
        while (elapsedMs() < timeoutMs) {
          bool anyLeft = false;
          for (auto &p : pending) {
            if (p.exited ||
                deploydrain::DecideDrainAction(p.target) !=
                    deploydrain::DrainAction::Signal)
              continue;
            if (!isProcessAlive(p.target.pid)) {
              p.exited = true;
              p.waitedMs = elapsedMs();
            } else {
              anyLeft = true;
            }
          }
          if (!anyLeft)
            break;
          std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }

        for (auto &p : pending) {
          if (p.exited ||
              deploydrain::DecideDrainAction(p.target) !=
                  deploydrain::DrainAction::Signal)
            continue;
          p.waitedMs = elapsedMs();
          if (!escalate)
            continue;
          kill(p.target.pid, SIGKILL);
          p.escalated = true;
          // A SIGKILLed pid goes away promptly, but not instantly, and the
          // outcome must not depend on how fast this loop got back to it.
          for (int i = 0; i < 20 && isProcessAlive(p.target.pid); ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(25));
          p.exited = !isProcessAlive(p.target.pid);
        }

        // The store is read AFTER the exits: a checkpoint is committed by the
        // dying process, so a read taken any earlier proves nothing.
        std::vector<deploydrain::DrainResult> results;
        nlohmann::json detail = nlohmann::json::array();
        for (auto &p : pending) {
          warresume::SnapshotFacts after;
          std::string gameId;
          if (const auto *room = rooms.GetRoom(p.target.roomId)) {
            gameId = room->gameId;
            if (p.target.kind == SessionKind::PersistentWar)
              after = warresume::LatestSnapshot(mapDb, gameId, p.target.roomId);
          }
          auto r = deploydrain::BuildResult(p.target, p.exited, p.escalated,
                                            p.waitedMs, p.before, after);
          // "Resumable until the rebuild" — the eligibility under the CURRENT
          // binary. Nothing here can know the next one's hash; see DeployDrain.h.
          warresume::BinaryIdentity cur;
          cur.engineHash = gameServerEngineHash();
          if (const auto *room = rooms.GetRoom(p.target.roomId))
            cur.mapHash = room->mapId;
          r.eligibility =
              warresume::DecideResumeEligibility(after, cur).eligibility;
          const std::string line = deploydrain::Describe(r);
          SLOG(r.lossy ? SPRING_LOG_WARNING : SPRING_LOG_NOTICE, "drain: %s",
               line.c_str());
          detail.push_back({
              {"roomId", r.roomId},
              {"pid", r.pid},
              {"kind", r.kind == SessionKind::PersistentWar ? "persistent_war"
                                                           : "skirmish"},
              {"outcome", deploydrain::ToString(r.outcome)},
              {"frame", r.frame},
              {"label", r.label},
              {"waited_ms", r.waitedMs},
              {"lossy", r.lossy},
              {"resume_eligibility", warresume::ToString(r.eligibility)},
              {"describe", line},
          });
          results.push_back(std::move(r));
        }

        const auto summary = deploydrain::Summarise(results);
        const std::string headline = deploydrain::Describe(summary);
        SLOG(summary.lossy > 0 || !summary.drained ? SPRING_LOG_WARNING
                                                   : SPRING_LOG_NOTICE,
             "%s", headline.c_str());
        db.LogAudit(uid, uname, "deploy_drain", "lobby",
                    "servers=" + std::to_string(summary.servers) +
                        " checkpointed=" + std::to_string(summary.checkpointed) +
                        " lossy=" + std::to_string(summary.lossy) +
                        " killed=" + std::to_string(summary.killed) +
                        " drained=" + (summary.drained ? "1" : "0"));

        nlohmann::json out;
        out["ok"] = true;
        out["drained"] = summary.drained;
        out["servers"] = summary.servers;
        out["checkpointed"] = summary.checkpointed;
        out["lossy"] = summary.lossy;
        out["killed"] = summary.killed;
        out["still_alive"] = summary.stillAlive;
        out["engine_hash"] = gameServerEngineHash();
        out["summary"] = headline;
        out["detail"] = detail;
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/admin/ban {username} — account ban + immediate session revoke.
  net.AddHttpPost(
      "/api/admin/ban", RouteAuth::AdminOnly,
      [&db,
       requireLobbyAdmin](const std::string &, const std::string &body,
                          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        const std::string target =
            j.is_discarded() ? "" : j.value("username", std::string(""));
        if (target.empty())
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"username required"})");
        int64_t targetId = 0;
        if (!db.SetBannedByUsername(target, true, targetId))
          return HttpAuth::JsonResponse(
              404, R"({"ok":false,"error":"no such user"})");
        const int revoked = db.RevokeUserSessions(targetId);
        db.LogAudit(uid, uname, "ban", target,
                    "sessions_revoked=" + std::to_string(revoked));
        return HttpAuth::JsonResponse(200,
                                      std::string(R"({"ok":true,"revoked":)") +
                                          std::to_string(revoked) + "}");
      });

  // POST /api/admin/unban {username}
  net.AddHttpPost(
      "/api/admin/unban", RouteAuth::AdminOnly,
      [&db,
       requireLobbyAdmin](const std::string &, const std::string &body,
                          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        const std::string target =
            j.is_discarded() ? "" : j.value("username", std::string(""));
        if (target.empty())
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"username required"})");
        int64_t targetId = 0;
        if (!db.SetBannedByUsername(target, false, targetId))
          return HttpAuth::JsonResponse(
              404, R"({"ok":false,"error":"no such user"})");
        db.LogAudit(uid, uname, "unban", target, "");
        return HttpAuth::JsonResponse(200, R"({"ok":true})");
      });

  // POST /api/admin/set-faction {username, faction} — privileged, audited
  // override of a user's permanent faction (PLAN-metalstorm-lobby.md §1b:
  // "exceptional reassignment ... support/admin only ... audited"). There
  // is deliberately no equivalent player-facing route — faction is
  // immutable in the normal flow; POST /api/auth/register is the only
  // other writer, and it only ever sets an unset value on a brand-new
  // account. `faction` is validated against the same factionRegistry the
  // registration route uses, so an admin can't type a typo'd key any
  // more than a new player could.
  net.AddHttpPost(
      "/api/admin/set-faction", RouteAuth::AdminOnly,
      [&db, &factionRegistry,
       requireLobbyAdmin](const std::string &, const std::string &body,
                          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        const std::string target =
            j.is_discarded() ? "" : j.value("username", std::string(""));
        const std::string faction =
            j.is_discarded() ? "" : j.value("faction", std::string(""));
        if (target.empty() || faction.empty())
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"username and faction required"})");
        if (factionRegistry.find(faction) == factionRegistry.end())
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"unknown faction"})");
        int64_t targetId = 0;
        if (!db.SetFactionByUsername(target, faction, targetId))
          return HttpAuth::JsonResponse(
              404, R"({"ok":false,"error":"no such user"})");
        // §1b: an admin faction reassignment "clears the account's per-war
        // bindings". Task 0 recorded this as a documented no-op because the
        // binding store did not exist; task 4 built it, so the clause is now
        // real. It has to be: a binding records the team the OLD faction was
        // seated on, and leaving it in place would send the account back to
        // its former side on the next rejoin — the one path in the whole
        // seating rule that can put a player on a side their faction does not
        // fight for. The count goes into the audit row, so an override that
        // ejected somebody from three running wars says so.
        const int clearedBindings =
            WarPlayerBindings::DeleteForAccount(db.Handle(), targetId);
        // Task 8a: the reconnect token has to go with the binding it was
        // minted against. It does NOT by itself put the account back on the
        // old side — the token only authenticates, and seating still runs
        // through the faction rule, which now returns the new one. What it
        // would otherwise leave behind is a week-long credential into a war
        // that the account, by the route it is minted from, no longer
        // qualifies to hold a seat in.
        const int clearedWarTokens = AuthTokens::RevokeWarReconnectForAccount(
            db.Handle(), targetId, static_cast<int64_t>(std::time(nullptr)));
        db.LogAudit(uid, uname, "set_faction", target,
                    "faction=" + faction + " cleared_bindings=" +
                        std::to_string(clearedBindings) +
                        " cleared_war_tokens=" +
                        std::to_string(clearedWarTokens));
        return HttpAuth::JsonResponse(200, R"({"ok":true})");
      });

  // POST /api/admin/banned — the current ban list.
  net.AddHttpPost(
      "/api/admin/banned", RouteAuth::AdminOnly,
      [&db,
       requireLobbyAdmin](const std::string &, const std::string &,
                          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json banned = nlohmann::json::array();
        for (const auto &u : db.GetBannedUsers(200))
          banned.push_back(
              {{"id", u.id}, {"username", u.username}, {"role", u.role}});
        nlohmann::json out;
        out["ok"] = true;
        out["banned"] = banned;
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/admin/client-errors — the crash view (PLAN-client-resilience
  // task 4): client_errors grouped by stack hash, top crashers first. Task 3
  // has been writing these rows since 2026-07-19 and nothing read them; this
  // is the read side. Admin-gated like the rest of the dashboard's plane —
  // crash reports carry account ids, stacks and log-ring lines.
  net.AddHttpPost(
      "/api/admin/client-errors", RouteAuth::AdminOnly,
      [&db, requireLobbyAdmin,
       clientErrorRetentionDays](const std::string &, const std::string &body,
                                 const HttpRequestHeaders &headers)
          -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        int limit = j.is_discarded() ? 50 : j.value("limit", 50);
        int sinceDays = j.is_discarded() ? 0 : j.value("sinceDays", 0);
        limit = std::clamp(limit, 1, 200);
        nlohmann::json groups = nlohmann::json::array();
        for (const auto &g : db.GetClientErrorGroups(limit, sinceDays))
          groups.push_back({{"stack_hash", g.stackHash},
                            {"error_class", g.errorClass},
                            {"message", g.message},
                            {"recovery_rung", g.recoveryRung},
                            {"reports", g.reports},
                            {"occurrences", g.occurrences},
                            {"users", g.users},
                            {"first_seen", g.firstSeen},
                            {"last_seen", g.lastSeen},
                            {"first_build", g.firstBuild},
                            {"last_build", g.lastBuild},
                            {"games", g.games}});
        nlohmann::json out;
        out["ok"] = true;
        out["groups"] = groups;
        // So the operator can tell an empty view apart from a pruned one.
        out["retention_days"] = clientErrorRetentionDays;
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/admin/client-errors/detail {stack_hash} — every stored report
  // for one crash site. This is also the export-to-JSON payload: the
  // dashboard downloads this response verbatim for filing an issue, so it
  // carries the full stack and log ring rather than the group summary.
  // Stacks are MINIFIED — there is no source-map upload pipeline (task 3's
  // documented residual), so the frames read as `a.b@chunk-x.js:1:2345`.
  net.AddHttpPost(
      "/api/admin/client-errors/detail", RouteAuth::AdminOnly,
      [&db, requireLobbyAdmin](
          const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        const std::string stackHash =
            j.is_discarded() ? "" : j.value("stack_hash", std::string(""));
        if (stackHash.empty())
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"stack_hash required"})");
        int limit = j.is_discarded() ? 200 : j.value("limit", 200);
        limit = std::clamp(limit, 1, 500);
        nlohmann::json reports = nlohmann::json::array();
        for (const auto &r : db.GetClientErrorsByHash(stackHash, limit))
          reports.push_back({{"id", r.id},
                             {"created_at", r.createdAt},
                             {"user_id", r.userId},
                             {"reason", r.reason},
                             {"error_class", r.errorClass},
                             {"message", r.message},
                             {"stack", r.stack},
                             {"stack_hash", r.stackHash},
                             {"recovery_rung", r.recoveryRung},
                             {"phase", r.phase},
                             {"frame", r.frame},
                             {"entity_count", r.entityCount},
                             {"game_id", r.gameId},
                             {"map_id", r.mapId},
                             {"build_stamp", r.buildStamp},
                             {"gpu_renderer", r.gpuRenderer},
                             {"log_ring", r.logRing},
                             {"count", r.count}});
        nlohmann::json out;
        out["ok"] = true;
        out["stack_hash"] = stackHash;
        out["reports"] = reports;
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // --- Generated scenarios (PLAN-metalstorm-wars.md §7.1, scenariogen.py) ---
  //
  // The user-facing flow is "a scenario is created → saved to the DB →
  // selectable in the lobby", and these three endpoints are the whole of it.
  // Every one is POST + AdminOnly, which is not a style choice: GET cannot
  // carry an Authorization header anywhere in this codebase's client, so a
  // GET admin route is an unauthenticated admin route.
  //
  // Ingest is deliberately thin. It shells out to the generator, stores what
  // came back, materialises the file, and re-discovers — it does not decide
  // anything about the scenario's content. Every judgement about whether a war
  // is playable (reachability per movement class, no unit inside a yardmap,
  // exactly one victory objective, both sides staged) lives in scenariogen.py
  // and is expressed by refusing to emit. So a rejection here is reported, not
  // worked around.

  /// Where processed maps live — `<dataDir>/maps`, alongside the DB. Same
  /// derivation RunMapConverterPreflight uses for its --data-dir.
  const std::string mapsDir = [&]() -> std::string {
    const std::filesystem::path p(dbPath);
    const std::string dir =
        p.has_parent_path() && !p.parent_path().empty()
            ? p.parent_path().string()
            : std::string("data");
    return dir + "/maps";
  }();

  /// Serialise one stored scenario for an admin response. Deliberately shows
  /// the DISCOVERED view (`terminal`, `sides`) next to the stored provenance
  /// (`seed`, `params`): the two coming from different places is the point —
  /// if a materialised file ever failed to parse, `terminal` would read false
  /// and `discovered` would be false, and the admin list would say so instead
  /// of echoing the row back and looking healthy.
  auto describeStoredScenario = [&scenariosFor](const ScenarioDb::Record &r) {
    nlohmann::json j;
    j["id"] = r.id;
    j["gameId"] = r.gameId;
    j["displayName"] = r.displayName;
    j["map"] = r.mapId;
    j["seed"] = r.seed;
    j["generatorVersion"] = r.generatorVersion;
    j["params"] = nlohmann::json::parse(r.params, nullptr, false);
    if (j["params"].is_discarded())
      j["params"] = nlohmann::json::object();
    j["createdBy"] = r.createdBy;
    j["createdAt"] = r.createdAt;
    j["bytes"] = static_cast<uint64_t>(r.lua.size());

    const ScenarioDiscovery::ScenarioInfo *info =
        ScenarioDiscovery::FindById(scenariosFor(r.gameId), r.id);
    j["discovered"] = info != nullptr;
    j["terminal"] = info != nullptr && info->terminal;
    nlohmann::json sides = nlohmann::json::array();
    if (info) {
      for (const auto &s : ScenarioDiscovery::PlayableSides(*info))
        sides.push_back({{"faction", s.faction},
                         {"team", s.team},
                         {"staged", s.staged}});
    }
    j["sides"] = std::move(sides);
    return j;
  };

  // POST /api/admin/scenarios/generate
  //   {gameId, mapId, seed?, sides?, towns?, outposts?, bases?, mines?,
  //    hostility?, roster?}
  // Generate a war for `mapId`, store it, materialise it, and return the
  // entry exactly as the Create Game picker will now see it.
  net.AddHttpPost(
      "/api/admin/scenarios/generate", RouteAuth::AdminOnly,
      [&db, &mapDb, requireLobbyAdmin, &gamePathsById, &mapsDir,
       &refreshScenarios, &describeStoredScenario](
          const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;

        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        if (j.is_discarded() || !j.is_object())
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"invalid JSON body"})");

        const std::string gameId = j.value("gameId", std::string("metalstorm"));
        const std::string mapId = j.value("mapId", std::string(""));
        if (mapId.empty())
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"mapId required"})");

        auto pathIt = gamePathsById.find(gameId);
        if (pathIt == gamePathsById.end())
          return HttpAuth::JsonResponse(
              404, R"({"ok":false,"error":"no such game"})");

        // Default the seed from the map id exactly as scenariogen.py's own
        // default does (`sum(ord(c) for c in map_id)`), rather than from a
        // clock. A generated scenario is reproducible from (map, seed,
        // version) or it is not reproducible at all, and a timestamp seed
        // would quietly make every re-run a different war with a different id.
        int64_t seed = 0;
        if (j.contains("seed") && j["seed"].is_number_integer()) {
          seed = j["seed"].get<int64_t>();
        } else {
          for (const unsigned char c : mapId)
            seed += c;
        }
        if (seed < 0 || seed > 2147483647)
          return HttpAuth::JsonResponse(
              400, R"({"ok":false,"error":"seed out of range"})");

        const ScenarioGenResult gen =
            RunScenarioGen(mapsDir, mapId, pathIt->second, seed, j);
        if (!gen.ok) {
          nlohmann::json err;
          err["ok"] = false;
          // The generator's own words. A REJECTED line names which invariant
          // the map failed and, for the reachability gate, which components
          // the armies were stranded in — strictly more useful than anything
          // this layer could say about it.
          err["error"] = gen.diagnostics.empty()
                             ? std::string("scenario generation failed")
                             : gen.diagnostics;
          err["exitCode"] = gen.exitCode;
          // 422, not 500: a rejection means "this map cannot host a war on
          // these knobs", which is a property of the request, not a fault.
          return HttpAuth::JsonResponse(gen.exitCode == 2 ? 422 : 500,
                                        err.dump());
        }

        ScenarioDb::Record rec;
        rec.id = gen.meta.value("id", std::string(""));
        rec.gameId = gameId;
        rec.mapId = gen.meta.value("map_id", mapId);
        rec.seed = gen.meta.value("seed", seed);
        rec.generatorVersion = gen.meta.value("version", 0);
        rec.lua = gen.lua;
        rec.createdBy = uname;
        if (gen.meta.contains("params"))
          rec.params = gen.meta["params"].dump();

        if (!ScenarioDb::ValidateId(rec.id))
          return HttpAuth::JsonResponse(
              500,
              R"({"ok":false,"error":"generator returned an unusable id"})");

        // Two different seeds on one map can mint the same title (the
        // generator indexes its suffix table `seed % len`), and the picker is
        // a flat option list with nothing else to tell them apart.
        rec.displayName = ScenarioDb::DisambiguateDisplayName(
            mapDb, gameId, gen.meta.value("display_name", rec.id), rec.id);

        const bool existed =
            ScenarioDb::FindById(mapDb, rec.id).has_value();
        if (!ScenarioDb::Upsert(mapDb, rec))
          return HttpAuth::JsonResponse(
              500, R"({"ok":false,"error":"failed to store scenario"})");

        // Materialise + re-discover, so the very next GET
        // /api/games/<id>/scenarios sees it. No lobby restart: the whole
        // point of the requirement is that a created scenario is immediately
        // selectable.
        refreshScenarios(gameId);

        db.LogAudit(uid, uname, "scenario_generate", rec.id,
                    "map=" + rec.mapId + " seed=" + std::to_string(rec.seed));

        nlohmann::json out;
        out["ok"] = true;
        // An id encodes (map, seed, generator version) and generation is
        // deterministic, so re-running the same request is an idempotent
        // replace rather than a conflict. Reported so the caller can tell
        // "made a new war" from "re-made the one you already had".
        out["created"] = !existed;
        auto stored = ScenarioDb::FindById(mapDb, rec.id);
        out["scenario"] =
            stored ? describeStoredScenario(*stored) : nlohmann::json::object();
        out["diagnostics"] = gen.diagnostics;
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/admin/scenarios/list {gameId?} — stored scenarios, with the
  // discovered view of each alongside its provenance.
  net.AddHttpPost(
      "/api/admin/scenarios/list", RouteAuth::AdminOnly,
      [&db, &mapDb, requireLobbyAdmin, &describeStoredScenario](
          const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;
        (void)db;

        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        const std::string gameId =
            (j.is_discarded() || !j.is_object())
                ? std::string("")
                : j.value("gameId", std::string(""));

        const std::vector<ScenarioDb::Record> rows =
            gameId.empty() ? ScenarioDb::ListAll(mapDb)
                           : ScenarioDb::ListForGame(mapDb, gameId);
        nlohmann::json arr = nlohmann::json::array();
        for (const auto &r : rows)
          arr.push_back(describeStoredScenario(r));

        nlohmann::json out;
        out["ok"] = true;
        out["scenarios"] = std::move(arr);
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/admin/scenarios/delete {id} — drop the row AND the file.
  //
  // Both, in that order. A deleted row that left its `.lua` behind would keep
  // being discovered and offered in the picker forever, with nothing left in
  // the DB to explain where it came from — the orphan case this endpoint and
  // ScenarioDb::SyncToDisk's sweep exist to prevent.
  net.AddHttpPost(
      "/api/admin/scenarios/delete", RouteAuth::AdminOnly,
      [&db, &mapDb, requireLobbyAdmin, &gamePathsById, &refreshScenarios](
          const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;

        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        const std::string id =
            (j.is_discarded() || !j.is_object())
                ? std::string("")
                : j.value("id", std::string(""));
        if (id.empty())
          return HttpAuth::JsonResponse(400,
                                        R"({"ok":false,"error":"id required"})");

        auto rec = ScenarioDb::FindById(mapDb, id);
        if (!rec)
          return HttpAuth::JsonResponse(
              404, R"({"ok":false,"error":"no such generated scenario"})");
        const std::string gameId = rec->gameId;

        if (!ScenarioDb::Delete(mapDb, id))
          return HttpAuth::JsonResponse(
              500, R"({"ok":false,"error":"failed to delete scenario"})");

        // The sweep inside refreshScenarios would collect the now-unclaimed
        // file anyway; removing it explicitly first means the window in which
        // a concurrent discovery could still offer a deleted war is zero
        // rather than "until the resync finishes".
        auto pathIt = gamePathsById.find(gameId);
        if (pathIt != gamePathsById.end())
          ScenarioDb::Unmaterialise(id, pathIt->second);
        refreshScenarios(gameId);

        db.LogAudit(uid, uname, "scenario_delete", id, "game=" + gameId);
        return HttpAuth::JsonResponse(200, R"({"ok":true})");
      });

  // POST /api/admin/scenarios/resync {gameId?} — rebuild every generated
  // `.lua` from its row and sweep orphans, then re-discover.
  //
  // The same code path startup runs, exposed so an operator can repair a
  // `data/` tree by hand (it is gitignored, so "the files are gone" is a
  // routine state, not a disaster) without bouncing the lobby.
  net.AddHttpPost(
      "/api/admin/scenarios/resync", RouteAuth::AdminOnly,
      [&db, &mapDb, requireLobbyAdmin, &gamePathsById, &refreshScenarios](
          const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        int64_t uid;
        std::string uname;
        if (auto e = requireLobbyAdmin(headers, uid, uname))
          return *e;

        nlohmann::json j = nlohmann::json::parse(body, nullptr, false);
        const std::string only =
            (j.is_discarded() || !j.is_object())
                ? std::string("")
                : j.value("gameId", std::string(""));

        nlohmann::json games = nlohmann::json::array();
        for (const auto &kv : gamePathsById) {
          if (!only.empty() && kv.first != only)
            continue;
          const ScenarioDb::SyncResult r =
              ScenarioDb::SyncToDisk(mapDb, kv.first, kv.second);
          refreshScenarios(kv.first);
          games.push_back({{"gameId", kv.first},
                           {"written", r.written},
                           {"orphansRemoved", r.orphansRemoved},
                           {"failed", r.failed}});
        }

        db.LogAudit(uid, uname, "scenario_resync", only, "");
        nlohmann::json out;
        out["ok"] = true;
        out["games"] = std::move(games);
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // --- HTTP exec endpoint (for CLI/curl access to lobby commands) ---
  // PLAN-security-hardening task 2: compiled OUT entirely under
  // SPRING_PROD, not just role-gated — arbitrary SQLite exec on the map DB
  // has no place in a production binary, belt-and-braces on top of the
  // AdminOnly dispatch gate + the handler's own role check below.
#ifndef SPRING_PROD
  net.AddHttpPost(
      "/api/exec", RouteAuth::AdminOnly,
      [&rooms, &gameServers, mapDb,
       &db](const std::string &, const std::string &body,
            const HttpRequestHeaders &headers) -> HttpResponse {
        // Validate auth token
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0) {
          return HttpAuth::JsonResponse(
              401,
              R"({"error":"unauthorized — use POST /api/auth/login first"})");
        }
        // S2: /api/exec runs privileged SQL + lobby control commands. Gate on
        // the admin role — a plain authenticated player must not reach it.
        std::string execUsername;
        {
          auto execUser = db.FindUserById(userId);
          if (!execUser || execUser->role != "admin") {
            return HttpAuth::JsonResponse(
                403, R"({"error":"forbidden — admin role required"})");
          }
          execUsername = execUser->username;
        }

        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string scope = j.value("scope", "");
        std::string code = j.value("code", "");
        bool success = true;
        std::string output;

        // Task 6: append-only admin audit trail — who ran what, when.
        // args_digest is truncated so a huge SQL blob can't bloat the table.
        db.LogAudit(userId, execUsername, "exec", scope, code.substr(0, 200));

        if (scope == "sql") {
          std::string upper = code;
          for (auto &c : upper)
            c = (char)toupper((unsigned char)c);
          bool rejected = false;
          for (const char *kw :
               {"INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE"}) {
            if (upper.find(kw) != std::string::npos) {
              rejected = true;
              break;
            }
          }
          if (rejected) {
            output = "read-only: mutation queries not allowed";
            success = false;
          } else {
            char *errMsg = nullptr;
            auto callback = [](void *data, int ncols, char **vals,
                               char **names) -> int {
              auto *out = static_cast<std::string *>(data);
              if (!out->empty())
                *out += "\\n";
              for (int i = 0; i < ncols; i++) {
                if (i > 0)
                  *out += " | ";
                *out +=
                    std::string(names[i]) + "=" + (vals[i] ? vals[i] : "NULL");
              }
              return 0;
            };
            int rc =
                sqlite3_exec(mapDb, code.c_str(), callback, &output, &errMsg);
            if (rc != SQLITE_OK) {
              output = errMsg ? errMsg : "unknown error";
              if (errMsg)
                sqlite3_free(errMsg);
              success = false;
            }
            if (output.empty())
              output = "(no results)";
          }
        } else if (scope == "lobby") {
          if (code == "rooms") {
            auto allRooms = rooms.GetAllRooms();
            for (const auto *r : allRooms) {
              if (!r)
                continue;
              if (!output.empty())
                output += "\\n";
              output += "Room " + std::to_string(r->id) + ": " + r->name +
                        " (" + std::to_string(r->players.size()) + " players)";
            }
            if (output.empty())
              output = "(no rooms)";
          } else if (code == "process list") {
            for (const auto &[rid, inst] : gameServers) {
              if (!output.empty())
                output += "\\n";
              output += "Room " + std::to_string(rid) +
                        ": pid=" + std::to_string(inst.pid) +
                        " port=" + std::to_string(inst.port);
            }
            if (output.empty())
              output = "(no game servers)";
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

        std::string json =
            "{\"success\":" + std::string(success ? "true" : "false") +
            ",\"output\":\"" + HttpAuth::JsonEscape(output) + "\"}";
        return HttpAuth::JsonResponse(200, json);
      });
#endif // !SPRING_PROD

  // --- Room management HTTP endpoints ---
  // These mirror the WebSocket room commands for CLI/automation access.

  // Helper: get userId from auth header, return 0 + send 401 if invalid
  auto requireAuth = [&db](const HttpRequestHeaders &headers) -> int64_t {
    return HttpAuth::ValidateToken(db, headers.authorization);
  };

  // Helper: find a player's room by their userId
  auto findPlayerRoom = [&rooms](uint32_t userId) -> GameRoom * {
    // RoomManager doesn't have a FindRoomByUserId, so scan all rooms
    for (auto *room : rooms.GetAllRooms()) {
      if (!room)
        continue;
      if (room->FindPlayer(userId))
        return room;
    }
    return nullptr;
  };

  // Read the digest a running war publishes into `war_summary`
  // (PLAN-metalstorm-lobby.md §4, task 6 — written only by spring-server, see
  // server_main.cpp). A row older than `kWarSummaryStaleSec` is treated as
  // absent: nothing clears the row when a server is SIGKILLed, and a browser
  // that keeps showing "4 fighting, 2 watching" for a war whose process died
  // is worse than one that shows the durable half alone. Missing table, row,
  // version or a malformed blob all land in the same place for the same
  // reason.
  auto warSummaryFor = [&](uint32_t roomId, WarSummary &out) -> bool {
    if (!mapDb)
      return false;
    sqlite3_stmt *s = nullptr;
    bool ok = false;
    if (sqlite3_prepare_v2(mapDb,
                           "SELECT summary_json, updated_at FROM war_summary "
                           "WHERE room_id=?",
                           -1, &s, nullptr) == SQLITE_OK) {
      sqlite3_bind_int(s, 1, static_cast<int>(roomId));
      if (sqlite3_step(s) == SQLITE_ROW) {
        const char *json =
            reinterpret_cast<const char *>(sqlite3_column_text(s, 0));
        const int64_t updatedAt = sqlite3_column_int64(s, 1);
        const int64_t age = static_cast<int64_t>(std::time(nullptr)) - updatedAt;
        if (json && age <= kWarSummaryStaleSec)
          ok = DecodeWarSummary(json, out);
      }
    }
    if (s)
      sqlite3_finalize(s);
    return ok;
  };

  // Helper: JSON-serialize a room for API responses
  // `outState` (PLAN-persistence task 4d): the war state this row was built
  // with, handed back to the caller that wants the TRANSITION rather than the
  // datum. An out-param rather than a second computation because `warFactsFor`
  // is a DB read per war per call, and rather than a member because a
  // single-room GET must not be able to feed the transition watcher — a card
  // refresh would then consume the flip and the toast would never be sent.
  auto roomToJson = [&](const GameRoom *room,
                        warresume::WarState *outState = nullptr) -> std::string {
    if (!room)
      return "null";
    nlohmann::json j;
    j["id"] = room->id;
    j["name"] = room->name;
    j["map"] = room->mapId;
    j["game"] = room->gameId;
    j["state"] = static_cast<int>(room->state);
    j["players"] = nlohmann::json::array();
    for (const auto &p : room->players) {
      nlohmann::json pj;
      pj["player_id"] = p.playerId;
      pj["username"] = p.username;
      pj["team"] = p.team;
      pj["ready"] = p.ready;
      pj["is_host"] = p.isHost;
      pj["is_spectator"] = p.isSpectator;
      pj["start_pos"] = p.startPos;
      // The account's faction, when it has one (D40). Sent so the room screen
      // can say WHY a player holds the side they hold — a seat chosen by
      // permanent allegiance is only legible if the allegiance is visible.
      if (!p.factionId.empty())
        pj["faction"] = p.factionId;
      j["players"].push_back(std::move(pj));
    }
    j["ai_slots"] = nlohmann::json::array();
    for (const auto &ai : room->aiSlots) {
      nlohmann::json aj;
      aj["ai_id"] = ai.aiId;
      aj["name"] = ai.displayName;
      aj["team"] = ai.team;
      aj["start_pos"] = ai.startPos;
      aj["profile"] = ai.profile;
      j["ai_slots"].push_back(std::move(aj));
    }
    j["modoptions"] = nlohmann::json::object();
    for (const auto &[key, value] : room->modOptions)
      j["modoptions"][key] = value;
    if (room->gameServerPort > 0)
      j["game_server_port"] = room->gameServerPort;
    if (room->persistent)
      j["persistent"] = true;
    // Always emitted, unlike `persistent` above: the war browser
    // (PLAN-metalstorm-lobby.md §4) has to tell a war from a skirmish for
    // EVERY row, and an absent field would make "old lobby" and "skirmish"
    // indistinguishable to it.
    j["session_kind"] = SessionKindToString(room->sessionKind);
    // ── The war row the browser lists (§4, task 6) ───────────────────────
    //
    // Two sources, and which fact comes from which is the whole design:
    //
    //   * `bound` — humans who hold a seat in this war — comes from
    //     `war_player_bindings`, the durable half. A war's fighters are
    //     seated by the GAME server and never appear in `room->players` at
    //     all (the same trap JoinPreview documents: counting the room reports
    //     a full war as empty), and a bound player who is offline still holds
    //     their seat, which is what task 4 made true.
    //   * `online` / `ais` / `regions` / spectators / control — come from the
    //     live digest, and are simply absent when there is no running server
    //     to publish one. A war whose process was killed still lists, with
    //     its sides and its capacity, because task 3 made that a state a war
    //     can be in rather than the end of it.
    //
    // `open` is derived from the durable number, not the live one: an offline
    // veteran's seat is not free, and offering it would produce exactly the
    // promise the game server then breaks.
    if (room->sessionKind == SessionKind::PersistentWar) {
      const auto sides = room->SideTeams();
      WarSummary live;
      const bool haveLive = warSummaryFor(room->id, live);
      std::unordered_map<int, unsigned> boundPerTeam;
      for (const auto &b : WarPlayerBindings::ForRoom(db.Handle(), room->id))
        boundPerTeam[b.team]++;

      // Task 7: capacity is per side. `capacity_per_side` stays on the war for
      // the sides the war does not size (and for a client reading the old
      // shape), but every side now states its own — an asymmetric war is the
      // whole point of §6's seeding, and one number could only ever describe a
      // symmetric one.
      const WarSideCapacities caps = room->SideCapacities();
      nlohmann::json wj;
      wj["live"] = haveLive;
      wj["capacity_per_side"] = WAR_SIDE_CAPACITY_DEFAULT;
      wj["sides"] = nlohmann::json::array();
      for (const auto &[faction, team] : sides) {
        nlohmann::json sj;
        sj["team"] = static_cast<int>(team);
        sj["faction"] = faction;
        const unsigned bound = boundPerTeam.count(static_cast<int>(team))
                                   ? boundPerTeam[static_cast<int>(team)]
                                   : 0u;
        const unsigned capacity =
            CapacityForSideIn(caps, faction, WAR_SIDE_CAPACITY_DEFAULT);
        sj["bound"] = bound;
        sj["capacity"] = capacity;
        sj["open"] = (capacity > bound) ? (capacity - bound) : 0u;
        // An unlimited side is stated, not encoded as a number. `open` there
        // is 0 because there is no count to give, and 0 is exactly what "full"
        // looks like — so the one side that can never be full would read as
        // the only full one. A named flag cannot be misread that way.
        if (capacity == WAR_SIDE_CAPACITY_UNLIMITED)
          sj["unlimited"] = true;
        if (haveLive) {
          for (const auto &ls : live.sides) {
            if (ls.team != static_cast<int>(team))
              continue;
            sj["online"] = ls.humans;
            sj["ais"] = ls.ais;
            sj["regions"] = ls.regions;
            break;
          }
        }
        wj["sides"].push_back(std::move(sj));
      }
      // ── The hibernation state the card shows (PLAN-persistence task 3b) ──
      //
      // `live` above is "is a digest being published"; this is what the war IS,
      // which is a different question with three answers `live` cannot give:
      // resuming (a process is up but not serving — the state E5's second
      // joiner waits on), hibernated (frozen at a frame, brought back by the
      // next join) and crashed (no exit checkpoint, so frames were lost).
      //
      // Costs one indexed SELECT per war per broadcast, the same shape and
      // cadence as `warSummaryFor` immediately above.
      const auto wfacts = warFactsFor(*room);
      const auto wstate = warresume::Classify(room->sessionKind, wfacts);
      wj["state"] = warresume::ToString(wstate);
      if (outState != nullptr)
        *outState = wstate;
      // The frame the world would come back at. Emitted whenever there is
      // history — including while the war is live, where it is the last
      // durable point rather than the current frame (`frame` below is that).
      if (wfacts.snapshot.has) {
        wj["frozen_frame"] = wfacts.snapshot.frame;
        wj["frozen_at"] = wfacts.snapshot.takenAt;
        // Whether that frame is a promise or a loss (PLAN-persistence task 3c).
        // Published beside the frame, never instead of it: a card that dropped
        // the frame would say "fresh war" about a world somebody played for a
        // week, and one that dropped the verdict would offer to resume it.
        const auto elig =
            warresume::DecideResumeEligibility(wfacts.snapshot, wfacts.binary);
        wj["resume_eligibility"] = warresume::ToString(elig.eligibility);
        if (warresume::RefusesResume(elig.eligibility))
          wj["resume_blocked_reason"] = elig.reason;
      }
      if (haveLive) {
        wj["spectators"] = live.spectators;
        wj["frame"] = live.frame;
        wj["uptime_sec"] = live.uptimeSec;
        wj["control"] = {{"total", live.control.total},
                         {"contested", live.control.contested},
                         {"neutral", live.control.neutral}};
      }
      j["war"] = std::move(wj);
    }
    // PLAN-replay task 4c: a replay room reaches the client through exactly the
    // same JSON as a game room — that is the whole reason it IS a room — but
    // the browser must not offer to "join" one as a player, so it says which
    // recording it is serving.
    if (auto rit = gReplayRooms.find(room->id); rit != gReplayRooms.end())
      j["replay_file"] = rit->second;
    return j.dump();
  };

#define HTTP_ROOM_AUTH()                                                       \
  int64_t userId = requireAuth(headers);                                       \
  if (userId <= 0)                                                             \
    return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

  // PLAN-persistence task 4d: the last war state each room was broadcast in.
  // Lives beside the broadcast because that is the only place allowed to feed
  // it (see `roomToJson`'s `outState`). Pruned by `Retain` on every pass, so a
  // lobby up for weeks does not accumulate a row per room ever created, and a
  // reused room id starts from first-sight rather than inheriting the previous
  // war's state.
  warevents::Watcher warWatcher;

  // Broadcast the full room list to all SSE subscribers.
  // Called after every room mutation so clients stay in sync.
  auto broadcastRooms = [&]() {
    auto allRooms = rooms.GetAllRooms();
    std::string json = "[";
    bool first = true;
    // Collected during the same pass that serialises the list: the war state is
    // a DB read and this is the one place that has already paid for it.
    std::vector<std::pair<uint32_t, warresume::WarState>> warStates;
    std::set<uint32_t> liveRoomIds;
    for (const auto *r : allRooms) {
      if (!r)
        continue;
      if (!first)
        json += ",";
      first = false;
      warresume::WarState st = warresume::WarState::NotAWar;
      json += roomToJson(r, &st);
      liveRoomIds.insert(r->id);
      if (st != warresume::WarState::NotAWar)
        warStates.emplace_back(r->id, st);
    }
    json += "]";
    net.SendSSE(roomStreamChannel, json, "rooms");

    // Then the transitions, as their own named event on the same channel.
    //
    // The list goes first deliberately: a browser handling `war-state` looks up
    // the war it names in the list it holds (for the frame, the name and
    // whether the account is enlisted), and an event that arrived before the
    // row it describes would find the OLD state — or, for a war that just
    // appeared, no row at all.
    //
    // Broadcast, not per-account: the SSE layer has no per-connection
    // identity, and "is this war mine" is a question the browser can already
    // answer off `enlisted`. Answering it in two places is how the two answers
    // start disagreeing.
    warWatcher.Retain(liveRoomIds);
    for (const auto &[rid, st] : warStates) {
      const auto kind = warWatcher.Observe(rid, st);
      if (kind == warevents::Kind::None)
        continue;
      nlohmann::json ev;
      ev["room"] = rid;
      ev["kind"] = warevents::ToString(kind);
      ev["state"] = warresume::ToString(st);
      ev["headline"] = warevents::Headline(kind);
      const std::string body = ev.dump();
      SLOG(SPRING_LOG_NOTICE, "war %u: %s (state=%s) — %s", rid,
           warevents::ToString(kind), warresume::ToString(st),
           warevents::Headline(kind).c_str());
      net.SendSSE(roomStreamChannel, body, "war-state");
    }
  };

  // --- PLAN-quickstart.md Part A: direct-start composite ---
  //
  // Mint (or create) a session for a manifest-declared username without a
  // password step. A missing account is created dev-flagged (is_dev=1)
  // with an unusable random password hash — it can never log in via
  // /api/auth/login, only via the token minted here.
  auto ensureDevSession =
      [&](const std::string &username) -> std::pair<uint32_t, std::string> {
    auto user = db.FindUser(username);
    int64_t uid;
    if (user) {
      uid = user->id;
    } else {
      uid = db.CreateUser(username,
                          Crypto::HashPassword(Crypto::GenerateToken(32)),
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

  // Publish the room's slot layout as the `war_sides` modoption
  // (PLAN-metalstorm-wars.md §7.4, forced by endtoend D19).
  //
  // A scenario's sides declare many teams each but stage a starting force for
  // only one of them — Meridian Basin's compact side is teams 0–3 and its
  // army is on team 0; the union is 4–7 and its army is on team 4. The room's
  // slot dropdowns used to offer a hardcoded `Team 1`/`Team 2`, so the AI
  // opponent was seated on team 1: a declared compact *teammate* with no
  // units, while the union's whole army was skipped for want of a team 4.
  // The room had one army.
  //
  // So the room offers SIDES, and this is where the side→team resolution
  // (ScenarioDiscovery::EncodeWarSides) is written down — once, at create
  // time, in the same "ordinary room setting" shape §7.3 chose for
  // `scenario`. Everything downstream reads this one string: RoomManager's
  // GameRoom::SlotTeams() takes the integers, the client renders the labels,
  // and the sim receives it as a modoption like any other.
  //
  // Clears the option for a scenario-less room, so a host switching away from
  // a scenario does not leave a stale side list behind.
  auto applyWarSides = [&](uint32_t roomId, uint32_t hostId,
                           const std::string &gameId,
                           const std::string &scenarioId) {
    std::string encoded;
    if (!scenarioId.empty()) {
      const ScenarioDiscovery::ScenarioInfo *info =
          ScenarioDiscovery::FindById(scenariosFor(gameId), scenarioId);
      if (info != nullptr)
        encoded = ScenarioDiscovery::EncodeWarSides(*info);
    }
    rooms.SetModOption(roomId, hostId, "war_sides", encoded);
    if (!encoded.empty())
      SLOG(SPRING_LOG_NOTICE, "room %u: war sides '%s' (from scenario '%s')",
           roomId, encoded.c_str(), scenarioId.c_str());

    // ── Per-side capacity (PLAN-metalstorm-lobby.md §6, task 7) ────────────
    //
    // Written in the same place and at the same moment as the sides
    // themselves, because it is a property OF those sides and the two must
    // never be able to describe different wars. Two sources, merged in this
    // order:
    //
    //   1. the seeding rule (WarSeeding.h) sizes every side from the
    //      registered population of its faction, spread over the wars that
    //      will field it;
    //   2. the scenario's own `capacity` overrides that, per side, for an
    //      author who has a reason for one side's size.
    //
    // Only a persistent war gets one. A skirmish's cast is its roster: it was
    // sized, seated and start-gated on that list (task 1), so a capacity is a
    // limit on a join that cannot happen, and writing one would put a number
    // on the room screen that means nothing.
    std::string capsEncoded;
    const GameRoom *capRoom = rooms.GetRoom(roomId);
    if (!encoded.empty() && capRoom != nullptr &&
        capRoom->sessionKind == SessionKind::PersistentWar) {
      const WarSides sides = ParseWarSides(encoded);
      WarSeedPopulation pop;
      pop.registered = db.CountAccountsByFaction();
      // Wars ALREADY fielding each faction — this room is not among them (its
      // sides are being written right now), which is what `SeedSideCapacities`
      // expects: it adds this war itself.
      for (const auto *r : rooms.GetAllRooms()) {
        if (r == nullptr || r->id == roomId ||
            r->sessionKind != SessionKind::PersistentWar)
          continue;
        for (const auto &[faction, team] : r->SideTeams()) {
          (void)team;
          pop.warsFielding[faction]++;
        }
      }
      WarSideCapacities caps = SeedSideCapacities(sides, pop);
      if (!scenarioId.empty()) {
        const ScenarioDiscovery::ScenarioInfo *info =
            ScenarioDiscovery::FindById(scenariosFor(gameId), scenarioId);
        if (info != nullptr) {
          for (const auto &[faction, capacity] :
               ScenarioDiscovery::AuthoredSideCapacities(*info)) {
            auto it = std::find_if(caps.begin(), caps.end(),
                                   [&f = faction](const auto &c) {
                                     return c.first == f;
                                   });
            if (it != caps.end())
              it->second = capacity;
            else
              caps.emplace_back(faction, capacity);
          }
        }
      }
      capsEncoded = EncodeWarSideCapacities(caps);
    }
    rooms.SetModOption(roomId, hostId, "war_side_capacities", capsEncoded);
    if (!capsEncoded.empty())
      SLOG(SPRING_LOG_NOTICE, "room %u: war side capacities '%s'", roomId,
           capsEncoded.c_str());
  };

  // Resolve and apply the room's `scenario` modoption (PLAN-endtoend.md D10,
  // design call in PLAN-metalstorm-wars.md §7.1).
  //
  // `explicitChoice` is the host's pick, if they made one (nullptr = no pick).
  // A pick wins outright — including the empty string, which is how a host
  // deliberately asks for a scenario-less room and is therefore NOT
  // overridden by the map default. Callers validate the id against
  // `scenariosFor(gameId)` first; game_scenario.lua `error()`s on a missing
  // file at GameStart, so a typo should surface in the lobby, not the sim.
  //
  // With no pick at all, the map's default applies. A scenario declares the
  // map it was authored for (`world.map`), so this reads a coupling the
  // content already states — and the result lands in the room JSON, so the
  // player can see which war they are about to fight rather than having it
  // chosen behind their back.
  //
  // Also publishes the room's slot layout via applyWarSides above, on every
  // branch: the two settings are resolved from the same scenario and a room
  // must never carry one without the other.
  //
  // Returns the scenario id now in effect ("" if none).
  auto applyRoomScenario = [&](uint32_t roomId, uint32_t hostId,
                               const std::string &gameId,
                               const std::string &mapId,
                               const std::string *explicitChoice)
      -> std::string {
    if (explicitChoice != nullptr) {
      if (explicitChoice->empty()) {
        SLOG(SPRING_LOG_NOTICE,
             "room %u: host asked for no scenario on map '%s'", roomId,
             mapId.c_str());
        applyWarSides(roomId, hostId, gameId, {});
        return {};
      }
      rooms.SetModOption(roomId, hostId, "scenario", *explicitChoice);
      SLOG(SPRING_LOG_NOTICE, "room %u: scenario '%s' (host choice)", roomId,
           explicitChoice->c_str());
      applyWarSides(roomId, hostId, gameId, *explicitChoice);
      return *explicitChoice;
    }

    const ScenarioDiscovery::ScenarioInfo *def =
        ScenarioDiscovery::DefaultForMap(scenariosFor(gameId), mapId);
    if (def == nullptr) {
      applyWarSides(roomId, hostId, gameId, {});
      return {};
    }
    rooms.SetModOption(roomId, hostId, "scenario", def->id);
    SLOG(SPRING_LOG_NOTICE, "room %u: scenario '%s' (default for map '%s')%s",
         roomId, def->id.c_str(), mapId.c_str(),
         def->terminal ? "" : " — WARNING: declares no victory objective");
    applyWarSides(roomId, hostId, gameId, def->id);
    return def->id;
  };

  // Where a host who has expressed no preference belongs: their own faction's
  // side if this war declares one, else the first side of the room's slot
  // list. CreateRoom seats the host on team 0, which is right for a legacy
  // two-team room and right for Meridian by coincidence; this makes it right
  // on purpose.
  //
  // The faction branch (D40) fires even when the host is already on an offered
  // side, because "team 0 is a side this room offers" is exactly the state that
  // seated a union host on compact. The first-side branch keeps its original
  // "only if the current team isn't offered" guard — it is a repair, not a
  // preference.
  auto seatHostOnSide = [&](uint32_t roomId, uint32_t hostId) {
    const GameRoom *room = rooms.GetRoom(roomId);
    if (room == nullptr)
      return;
    const std::vector<uint8_t> slotTeams = room->SlotTeams();
    const RoomPlayer *host = nullptr;
    for (const auto &p : room->players)
      if (p.playerId == hostId)
        host = &p;
    if (host == nullptr || host->isSpectator)
      return;
    if (const auto sideTeam = room->TeamForFaction(host->factionId)) {
      if (host->team != *sideTeam) {
        rooms.SetTeam(roomId, hostId, *sideTeam);
        SLOG(SPRING_LOG_NOTICE,
             "room %u: host seated on team %u — faction '%s'", roomId,
             static_cast<unsigned>(*sideTeam), host->factionId.c_str());
      }
      return;
    }
    if (std::find(slotTeams.begin(), slotTeams.end(), host->team) !=
        slotTeams.end())
      return; // already on a side the room offers
    rooms.SetTeam(roomId, hostId, slotTeams.front());
    SLOG(SPRING_LOG_NOTICE, "room %u: host seated on team %u (first side)",
         roomId, static_cast<unsigned>(slotTeams.front()));
  };

  // The slot team to put a solo room's auto-added opponent on: the first of
  // the room's offered sides nobody occupies. Replaces a hardcoded
  // `hostTeam == 0 ? 1 : 0`, which on a Meridian room produced a Null AI on
  // team 1 — a live team the scenario stages no units for, which is the same
  // empty-army condition D19 filed.
  auto firstFreeSlotTeam = [](const GameRoom &room,
                              uint8_t hostTeam) -> uint8_t {
    const std::vector<uint8_t> slotTeams = room.SlotTeams();
    for (const uint8_t t : slotTeams) {
      bool taken = (t == hostTeam);
      for (const auto &p : room.players)
        if (!p.isSpectator && p.team == t)
          taken = true;
      for (const auto &a : room.aiSlots)
        if (a.team == t)
          taken = true;
      if (!taken)
        return t;
    }
    // Every offered side is occupied (or the room offers only one). Fall
    // back to the old behaviour so a single-side scenario still gets an
    // opponent rather than a same-team AI that ends the match instantly.
    return (hostTeam == 0) ? 1 : 0;
  };

  // The invariant this lane exists to encode: a war that no path can
  // terminate should not be created quietly. Called just before the game
  // server is spawned, on every start path.
  //
  // It warns rather than refuses. Scenario-less rooms are legitimate for
  // every game that ships no scenarios at all (Paper Tanks, ZK) and for
  // Metalstorm fixtures on maps with no authored war; refusing would break
  // those. What was actually wrong was that the endless case was silent.
  auto warnIfWarCannotEnd = [&](const GameRoom *room) {
    if (room == nullptr)
      return;
    const auto &available = scenariosFor(room->gameId);
    if (available.empty())
      return; // not a scenario-driven game — nothing to say

    std::string scenario;
    auto it = room->modOptions.find("scenario");
    if (it != room->modOptions.end())
      scenario = it->second;

    if (scenario.empty()) {
      SLOG(SPRING_LOG_WARNING,
           "room %u ('%s', game '%s', map '%s') starting with NO SCENARIO — "
           "no victory objective will be staged, so this war has no terminal "
           "condition and cannot end (PLAN-metalstorm-wars.md §7.1)",
           room->id, room->name.c_str(), room->gameId.c_str(),
           room->mapId.c_str());
      return;
    }
    const ScenarioDiscovery::ScenarioInfo *info =
        ScenarioDiscovery::FindById(available, scenario);
    if (info == nullptr) {
      SLOG(SPRING_LOG_WARNING,
           "room %u starting with scenario '%s', which game '%s' does not "
           "ship — game_scenario.lua will fail to load it at GameStart",
           room->id, scenario.c_str(), room->gameId.c_str());
    } else if (!info->terminal) {
      SLOG(SPRING_LOG_WARNING,
           "room %u starting with scenario '%s', which declares no "
           "`victory = true` objective — this war has no terminal condition "
           "and cannot end (PLAN-metalstorm-wars.md §7.1)",
           room->id, scenario.c_str());
    } else {
      SLOG(SPRING_LOG_NOTICE, "room %u: war '%s' is terminable via scenario %s",
           room->id, room->name.c_str(), scenario.c_str());
    }

    // Sibling invariant to "can this war end": can this war be *fought*?
    // A live team the scenario stages no starting force for is a side with
    // no army, and a war with one army is not a match — endtoend D19, where
    // a lobby-created Meridian room put the AI opponent on team 1 and the
    // player spent three minutes alone on the board. The sim re-checks the
    // staged board at frame 60 (game_scenario.lua), which is authoritative;
    // this says it before the game server is even spawned.
    // A scenario that declares no `sides` says nothing about which teams
    // should have an army (the smoke fixtures are like this), so there is
    // nothing to check it against.
    if (info == nullptr || info->sides.empty())
      return;
    std::set<uint8_t> occupied;
    for (const auto &p : room->players)
      if (!p.isSpectator)
        occupied.insert(p.team);
    for (const auto &a : room->aiSlots)
      occupied.insert(a.team);
    for (const uint8_t team : occupied) {
      bool staged = false;
      for (const auto &side : info->sides)
        if (side.team == team && side.staged)
          staged = true;
      if (!staged)
        SLOG(SPRING_LOG_WARNING,
             "room %u: team %u is occupied but scenario '%s' stages no "
             "starting force for it — that side begins the war with no army "
             "(PLAN-metalstorm-wars.md §7.4)",
             room->id, static_cast<unsigned>(team), scenario.c_str());
    }
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
  auto runDirectStart =
      [&](const nlohmann::json &manifest) -> DirectStartResult {
    DirectStartResult result;

    std::string name = manifest.value("name", "");
    if (name.empty())
      name = "dev:direct";
    std::string mapId = manifest.value("map", "");
    std::string gameId = manifest.value("game", "");
    if (gameId.empty() && !availableGames.empty())
      gameId = availableGames[0].id;
    if (mapId.empty()) {
      result.error = "map is required";
      return result;
    }

    // Session kind (PLAN-metalstorm-lobby.md task 1), same spelling and same
    // refuse-on-typo rule as POST /api/rooms. Carried here too because this is
    // the path a harness stages a war from: without it a persistent war could
    // only ever be created through the browser.
    SessionKind sessionKind = SessionKind::Skirmish;
    if (manifest.contains("sessionKind")) {
      const auto &sv = manifest["sessionKind"];
      if (!sv.is_string()) {
        result.error = "sessionKind must be a string";
        return result;
      }
      auto parsed = SessionKindFromString(sv.get<std::string>());
      if (!parsed) {
        result.error = "sessionKind must be 'skirmish' or 'persistent'";
        return result;
      }
      sessionKind = *parsed;
    }

    if (!manifest.contains("players") || !manifest["players"].is_array() ||
        manifest["players"].empty()) {
      result.error = "players[] must declare at least one player (the host)";
      return result;
    }

    // Idempotent restarts (§2.2): a standing room re-created under the
    // same name replaces the old one rather than accumulating duplicates.
    for (auto *existing : rooms.GetAllRooms()) {
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
      auto *prior = findPlayerRoom(playerId);
      if (!prior)
        return;
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
    for (const auto &pj : manifest["players"]) {
      std::string username = pj.value("username", "");
      if (username.empty()) {
        result.error = "player entry missing username";
        return result;
      }
      auto [uid, token] = ensureDevSession(username);
      result.sessions[username] = token;
      resolvedPlayers.push_back({
          uid,
          username,
          static_cast<uint8_t>(pj.value("team", 0)),
          static_cast<int8_t>(pj.value("startPos", -1)),
          pj.value("spectator", false),
      });
    }

    const ResolvedPlayer &host = resolvedPlayers[0];
    forceLeaveCurrentRoom(host.userId);

    uint32_t roomId = rooms.CreateRoom(name, mapId, gameId, 8, "", host.userId,
                                       0, host.username, /*persistent=*/false,
                                       /*hostFactionId=*/"", sessionKind);
    result.roomId = roomId;

    MapMetadataDb mdb;
    const size_t spCount = mdb.GetMap(mapDb, mapId).startPositions.size();
    const int8_t maxStartPos =
        static_cast<int8_t>(spCount > 127 ? 127 : spCount);

    // Host was added by CreateRoom as team 0, non-spectator, unready —
    // apply the manifest's team/startPos/ready on top.
    rooms.SetTeam(roomId, host.userId, host.team);
    if (host.startPos >= 0)
      rooms.SetPlayerStartPos(roomId, host.userId, host.userId, host.startPos,
                              maxStartPos);
    rooms.SetReady(roomId, host.userId, true);

    for (size_t i = 1; i < resolvedPlayers.size(); ++i) {
      const ResolvedPlayer &p = resolvedPlayers[i];
      forceLeaveCurrentRoom(p.userId);
      if (!rooms.JoinRoom(roomId, p.userId, 0, p.username, "", p.spectator)) {
        result.ok = false;
        result.error = "failed to bind player '" + p.username + "'";
        return result;
      }
      if (!p.spectator) {
        rooms.SetTeam(roomId, p.userId, p.team);
        if (p.startPos >= 0)
          rooms.SetPlayerStartPos(roomId, p.userId, p.userId, p.startPos,
                                  maxStartPos);
        rooms.SetReady(roomId, p.userId, true);
      }
    }

    if (manifest.contains("modoptions") && manifest["modoptions"].is_object()) {
      for (auto &[key, value] : manifest["modoptions"].items()) {
        std::string val =
            value.is_string() ? value.get<std::string>() : value.dump();
        rooms.SetModOption(roomId, host.userId, key, val);
      }
    }

    // Top-level "scenario" (PLAN-persistence.md §5): names a
    // scenarios/<name>.lua world file for game_scenario.lua to stage at
    // GameStart. Threaded as an ordinary modoption — Spring.GetModOptions()
    // is the existing, faithful path server Lua already reads config
    // through, so no new plumbing is needed beyond this one field.
    //
    // Routed through the SAME applyRoomScenario the ordinary create-room path
    // uses, deliberately (PLAN-endtoend.md D10). This field used to be the
    // only writer of the modoption anywhere, which is exactly why the two
    // paths diverged: every gameover verification ran through a manifest that
    // named a scenario, and nobody noticed the player path named none. A
    // manifest that omits the field now gets the map's default, same as a
    // lobby-created room.
    const std::string manifestScenario = manifest.value("scenario", "");
    applyRoomScenario(roomId, host.userId, gameId, mapId,
                      manifest.contains("scenario") ? &manifestScenario
                                                    : nullptr);

    if (manifest.contains("aiSlots") && manifest["aiSlots"].is_array()) {
      uint8_t slotIndex = 0;
      for (const auto &aj : manifest["aiSlots"]) {
        std::string aiId = aj.value("aiId", "");
        if (aiId.empty())
          continue;
        uint8_t team = static_cast<uint8_t>(aj.value("team", 0));
        if (!rooms.AddAISlot(roomId, host.userId, aiId, aiId, team))
          continue;
        int8_t sp = static_cast<int8_t>(aj.value("startPos", -1));
        if (sp >= 0)
          rooms.SetAIStartPos(roomId, host.userId, slotIndex, sp, maxStartPos);
        // PLAN-metalstorm-ai.md §10 task 6: the manifest's aiSlots[].profile
        // (already the "same shape as --headless-run" per the doc comment
        // above) reaches the AI VM via spawnGameServer's --ai 4th field.
        std::string profile = aj.value("profile", "");
        if (!profile.empty())
          rooms.SetAIProfile(roomId, host.userId, slotIndex, profile);
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
      GameRoom *room = rooms.GetRoom(roomId);
      std::set<uint8_t> teams;
      for (const auto &p : room->players)
        if (!p.isSpectator)
          teams.insert(p.team);
      for (const auto &a : room->aiSlots)
        teams.insert(a.team);
      if (teams.size() <= 1) {
        const uint8_t aiTeam = firstFreeSlotTeam(*room, host.team);
        rooms.AddAISlot(roomId, host.userId, "null", "Null AI", aiTeam);
      }
    }

    if (!rooms.StartGame(roomId, host.userId)) {
      result.ok = false;
      result.error = "cannot start game (internal — all declared players "
                     "should already be ready)";
      return result;
    }

    rooms.AutoAssignStartPositions(roomId, maxStartPos);

    GameRoom *room = rooms.GetRoom(roomId);
    warnIfWarCannotEnd(room);
    auto gpIt = gamePathsById.find(gameId);
    if (gpIt != gamePathsById.end()) {
      const auto vit = gameVersionsById.find(gameId);
      const std::string &gameVer =
          (vit != gameVersionsById.end()) ? vit->second : std::string();
      std::unordered_set<int> busyPorts;
      for (const auto &[rid, gi] : gameServers)
        if (gi.pid > 0 && isProcessAlive(gi.pid))
          busyPorts.insert(gi.port);
      auto inst =
          spawnGameServer(roomId, gameId, gameVer, mapId, dbPath, room->players,
                          room->aiSlots, room->modOptions, busyPorts,
                          devBuildAcknowledged, wtCertPath, wtKeyPath,
                          /*replayFile=*/"", room->sessionKind,
                          /*resumeFromSnapshot=*/false,
                          /*hibernateIdleSeconds=*/0,
                          warPlayerSlotCap(*room));
      gameServers[roomId] = inst;
      persistGameServer(inst);
      room->gameServerPort = inst.port;
    }

    result.ok = true;
    return result;
  };

  // POST /api/rooms — create a room
  net.AddHttpPost(
      "/api/rooms", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user)
          return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");

        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string name = j.value("name", "");
        std::string mapId = j.value("map", "");
        std::string gameId = j.value("game", "");
        if (name.empty())
          name = "Game";
        // An omitted `game` used to mean `availableGames[0]`, which is
        // alphabetical — on this tree that is `bar`, an archived game the
        // check below would then refuse (PLAN-endtoend.md D26). Default to
        // the first PLAYABLE game instead.
        if (gameId.empty()) {
          const GameDiscovery::GameInfo *fallback =
              GameDiscovery::DefaultPlayable(availableGames);
          if (fallback == nullptr)
            return HttpAuth::JsonResponse(
                500, R"({"error":"no playable game is installed"})");
          gameId = fallback->id;
        }
        // An archived game is on disk but does not run (PLAN.md 2026-08-02:
        // the BAR and ZK ports are archived, not deferred). The picker
        // already renders it disabled, so reaching here means a hand-made
        // request or a stale client; refusing keeps the rule in one place
        // the client cannot skip. Same shape — and same deliberate
        // exemption — as the retired-scenario check below: the
        // `/api/rooms/direct` manifest path does NOT check this, because
        // archived content is still stageable for fixtures and crash
        // repros (PLAN-bulk-spawn-crash.md runs on ZK content).
        {
          const GameDiscovery::GameInfo *picked =
              GameDiscovery::FindById(availableGames, gameId);
          if (picked != nullptr && picked->archived)
            return HttpAuth::JsonResponse(
                400, std::string(R"({"error":"that game is archived and )"
                                 R"(cannot be created","game":")") +
                         HttpAuth::JsonEscape(gameId) + "\"}");
        }
        if (mapId.empty())
          return HttpAuth::JsonResponse(400, R"({"error":"map is required"})");

        // Accept both JSON string ("true"/"1") and JSON bool/number for
        // `persistent`.
        bool persistent = false;
        if (j.contains("persistent")) {
          const auto &pv = j["persistent"];
          if (pv.is_string()) {
            const std::string persistStr = pv.get<std::string>();
            persistent = (persistStr == "true" || persistStr == "1");
          } else if (pv.is_boolean()) {
            persistent = pv.get<bool>();
          } else if (pv.is_number()) {
            persistent = (pv.get<double>() == 1.0);
          }
        }

        // Session kind (PLAN-metalstorm-lobby.md §1, task 1). Absent means
        // skirmish — the classic bounded match, and the only thing every
        // existing caller has ever created. An unrecognised spelling is a
        // 400 rather than a silent downgrade: a client that asked for a war
        // and got a skirmish would sit in a ready-check that a war never
        // reaches.
        SessionKind sessionKind = SessionKind::Skirmish;
        if (j.contains("sessionKind")) {
          const auto &sv = j["sessionKind"];
          if (!sv.is_string())
            return HttpAuth::JsonResponse(
                400, R"({"error":"sessionKind must be a string"})");
          auto parsed = SessionKindFromString(sv.get<std::string>());
          if (!parsed)
            return HttpAuth::JsonResponse(
                400,
                R"({"error":"sessionKind must be 'skirmish' or 'persistent'"})");
          sessionKind = *parsed;
        }

        // `scenario` is optional (PLAN-endtoend.md D10). Absent means "use
        // whatever this map's war is", which is what the Create Game dialog
        // sends when the host leaves the picker on its default. An
        // explicitly-empty string means "no scenario, deliberately".
        // Validate before CreateRoom so a typo never leaves a half-made room
        // behind.
        const bool hasScenarioChoice = j.contains("scenario");
        const std::string scenarioChoice = j.value("scenario", "");
        if (hasScenarioChoice && !scenarioChoice.empty()) {
          const ScenarioDiscovery::ScenarioInfo *picked =
              ScenarioDiscovery::FindById(scenariosFor(gameId), scenarioChoice);
          if (picked == nullptr)
            return HttpAuth::JsonResponse(
                400, R"({"error":"unknown scenario for this game"})");
          // A retired war is not a player choice (PLAN-metalstorm-wars.md
          // §7.6). The picker already omits it, so reaching here means a
          // hand-made request or a stale client; refusing keeps the rule in
          // one place the client cannot skip. The `/api/rooms/direct`
          // manifest path deliberately does NOT check this — retired
          // scenarios stay stageable for fixtures and for the objective
          // coverage they are kept for.
          if (picked->retired)
            return HttpAuth::JsonResponse(
                400,
                R"({"error":"that war is retired and cannot be created"})");
        }

        uint32_t roomId = rooms.CreateRoom(
            name, mapId, gameId, 8, "", static_cast<uint32_t>(userId),
            0 /*no WS clientId*/, user->username, persistent,
            user->factionId.value_or(""), sessionKind);

        applyRoomScenario(roomId, static_cast<uint32_t>(userId), gameId, mapId,
                          hasScenarioChoice ? &scenarioChoice : nullptr);
        // Only on this path: the direct-start manifest applies its own
        // explicit host team afterwards, and overruling it here would be the
        // same "chosen behind your back" property §7.3 rejected.
        seatHostOnSide(roomId, static_cast<uint32_t>(userId));

        auto *room = rooms.GetRoom(roomId);
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(room));
      });

  // GET /api/rooms — list rooms
  net.AddHttpGet("/api/rooms", RouteAuth::Public,
                 [&](const std::string &) -> HttpResponse {
                   auto allRooms = rooms.GetAllRooms();
                   std::string json = "[";
                   bool first = true;
                   for (const auto *r : allRooms) {
                     if (!r)
                       continue;
                     if (!first)
                       json += ",";
                     first = false;
                     json += roomToJson(r);
                   }
                   json += "]";
                   return HttpAuth::JsonResponse(200, json);
                 });

  // GET /api/games — list available games
  net.AddHttpGet(
      "/api/games", RouteAuth::Public,
      [&availableGames](const std::string &) -> HttpResponse {
        std::string json = "[";
        bool first = true;
        for (const auto &g : availableGames) {
          if (!first)
            json += ",";
          first = false;
          json += "{\"id\":\"" + HttpAuth::JsonEscape(g.id) + "\"" +
                  ",\"displayName\":\"" + HttpAuth::JsonEscape(g.displayName) +
                  "\"" + ",\"shortName\":\"" +
                  HttpAuth::JsonEscape(g.shortName) + "\"" +
                  ",\"description\":\"" + HttpAuth::JsonEscape(g.description) +
                  "\"" + ",\"version\":\"" + HttpAuth::JsonEscape(g.version) +
                  "\"" + ",\"lighting\":\"" + HttpAuth::JsonEscape(g.lighting) +
                  "\"" + ",\"modelMaterialPort\":\"" +
                  HttpAuth::JsonEscape(g.modelMaterialPort) + "\"" +
                  ",\"archived\":" + (g.archived ? "true" : "false") +
                  ",\"archivedReason\":\"" +
                  HttpAuth::JsonEscape(g.archivedReason) + "\"" +
                  ",\"resourceEconomy\":" +
                  (g.resourceEconomy ? "true" : "false") + "}";
        }
        json += "]";
        return HttpAuth::JsonResponse(200, json);
      });

  // GET /api/ai/* — list AI plugins for a game
  net.AddHttpGet(
      "/api/ai/*", RouteAuth::Public,
      [&aisByGame](const std::string &url) -> HttpResponse {
        std::string gameId = url.substr(std::string("/api/ai/").size());
        if (gameId.empty())
          return HttpAuth::JsonResponse(400, R"({"error":"missing game id"})");

        auto it = aisByGame.find(gameId);
        if (it == aisByGame.end())
          return HttpAuth::JsonResponse(404, R"({"error":"game not found"})");

        std::string json = "[";
        bool first = true;
        for (const auto &ai : it->second) {
          if (!first)
            json += ",";
          first = false;
          json += "{\"id\":\"" + HttpAuth::JsonEscape(ai.id) + "\"" +
                  ",\"displayName\":\"" + HttpAuth::JsonEscape(ai.displayName) +
                  "\"" + ",\"description\":\"" +
                  HttpAuth::JsonEscape(ai.description) + "\"" +
                  ",\"isEngineProvided\":" +
                  (ai.isEngineProvided ? "true" : "false") + "}";
        }
        json += "]";
        return HttpAuth::JsonResponse(200, json);
      });

  // GET /api/factions/* — list the factions a game declares in
  // gamedata/sidedata.lua (PLAN-metalstorm-lobby.md task 0), per game id.
  // The sign-up form fetches /api/factions/metalstorm specifically to
  // render the required faction picker with lore text; POST
  // /api/auth/register validates the chosen `faction` key against
  // factionRegistry, which is scoped to Metalstorm only (see its
  // declaration above) — not this per-game route's generic game→factions
  // map, which stays available for any game that ships one.
  net.AddHttpGet(
      "/api/factions/*", RouteAuth::Public,
      [&factionsByGame](const std::string &url) -> HttpResponse {
        std::string gameId = url.substr(std::string("/api/factions/").size());
        if (gameId.empty())
          return HttpAuth::JsonResponse(400, R"({"error":"missing game id"})");

        auto it = factionsByGame.find(gameId);
        if (it == factionsByGame.end())
          return HttpAuth::JsonResponse(404, R"({"error":"game not found"})");

        std::string json = "[";
        bool first = true;
        for (const auto &f : it->second) {
          if (!first)
            json += ",";
          first = false;
          json += "{\"key\":\"" + HttpAuth::JsonEscape(f.key) + "\"" +
                  ",\"name\":\"" + HttpAuth::JsonEscape(f.name) + "\"" +
                  ",\"fullName\":\"" + HttpAuth::JsonEscape(f.fullName) + "\"" +
                  ",\"description\":\"" + HttpAuth::JsonEscape(f.description) +
                  "\"}";
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
  net.AddHttpGet(
      "/api/games/*", RouteAuth::Public,
      [&gamesDir, &scenariosFor](const std::string &url) -> HttpResponse {
        // Match /api/games/<id>/resources.json, /api/games/<id>/ui-manifest
        // and /api/games/<id>/scenarios. /api/games/data/* and /api/games (no
        // trailing path) are handled by their own routes registered earlier —
        // the wildcard here only sees URLs that those didn't match.
        const std::string prefix = "/api/games/";
        if (url.size() <= prefix.size())
          return {.contentType = "text/plain", .body = {}, .status = 404};
        const std::string rest = url.substr(prefix.size());

        // /api/games/<id>/scenarios — the war templates this game ships
        // (PLAN-endtoend.md D10). Feeds the Create Game dialog's scenario
        // picker: `map` lets the client filter to the map being created on,
        // and `terminal` is what makes "this war can never end" a visible
        // property of the choice rather than a surprise 40 minutes in.
        // Always 200; an empty list for a game that ships no scenarios.
        const std::string scnSuffix = "/scenarios";
        if (rest.size() > scnSuffix.size() &&
            rest.compare(rest.size() - scnSuffix.size(), scnSuffix.size(),
                         scnSuffix) == 0) {
          const std::string gameId =
              rest.substr(0, rest.size() - scnSuffix.size());
          if (gameId.empty() || gameId.find('/') != std::string::npos ||
              gameId.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 400};

          nlohmann::json arr = nlohmann::json::array();
          for (const auto &s : scenariosFor(gameId)) {
            nlohmann::json sj;
            sj["id"] = s.id;
            sj["displayName"] = s.displayName;
            sj["map"] = s.mapId;
            sj["tutorial"] = s.tutorial;
            // A retired war is shipped, loadable and not offerable
            // (PLAN-metalstorm-wars.md §7.6). Reported rather than omitted for
            // the same reason `tutorial` is: the room screen resolves a room's
            // `scenario` modoption against this list, and a war staged through
            // the `?direct=` manifest path must still resolve to its name
            // instead of showing a raw id.
            sj["retired"] = s.retired;
            sj["terminal"] = s.terminal;
            // The scenario's playable sides, resolved to one team each
            // (PLAN-metalstorm-wars.md §7.4). NPC sides are omitted — a
            // player is never offered Meridian's reavers. The room screen
            // reads the *room's* `war_sides` modoption rather than this, but
            // the Create Game dialog needs it before a room exists.
            nlohmann::json sidesArr = nlohmann::json::array();
            for (const auto &side : ScenarioDiscovery::PlayableSides(s)) {
              nlohmann::json sd;
              sd["faction"] = side.faction;
              sd["team"] = side.team;
              sd["staged"] = side.staged;
              sidesArr.push_back(std::move(sd));
            }
            sj["sides"] = std::move(sidesArr);
            arr.push_back(std::move(sj));
          }
          const std::string body = arr.dump();
          return {.contentType = "application/json",
                  .body = std::vector<uint8_t>(body.begin(), body.end()),
                  .status = 200};
        }

        // /api/games/<id>/ui-manifest — JSON list of override files present
        // under data/games/<id>/ui/. Always 200; empty list when the dir
        // is missing entirely. The client uses this to decide which per-
        // file overrides to fetch, avoiding a 404 storm for games that
        // ship no overrides at all.
        const std::string uiSuffix = "/ui-manifest";
        if (rest.size() > uiSuffix.size() &&
            rest.compare(rest.size() - uiSuffix.size(), uiSuffix.size(),
                         uiSuffix) == 0) {
          const std::string gameId =
              rest.substr(0, rest.size() - uiSuffix.size());
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
                 it != fs::recursive_directory_iterator(); it.increment(ec)) {
              if (ec)
                break;
              if (!it->is_regular_file(ec))
                continue;
              const auto rel =
                  fs::relative(it->path(), uiDir, ec).generic_string();
              if (rel.empty() || rel.find("..") != std::string::npos)
                continue;
              if (!first)
                json += ",";
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
            rest.compare(rest.size() - suffix.size(), suffix.size(), suffix) !=
                0)
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
                // Parsed from the game's own files under a URL that never
                // changes — see the metadata.json site above (task 5).
                .cacheControl = CacheControl::VersionedAssetHeader(
                    NetworkServer::CurrentQueryString()),
            };
          }
        }

        const std::string gameDir = gamesDir + "/" + gameId;
        const std::string engineBaseDir = "cont/base/springcontent";
        const std::string json =
            ResourcesParser::ParseGameResources(gameId, gameDir, engineBaseDir);
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
            .cacheControl = CacheControl::VersionedAssetHeader(
                NetworkServer::CurrentQueryString()),
        };
      });

  // ── Spawning a game server, in one place ──
  //
  // Two paths spawn one now: the host pressing Start Game, and a player
  // joining a persistent war whose server is down (task 3). They must not be
  // two hand-rolled copies — a fork/exec that skips the fork-bomb brakes, the
  // start-position assignment or the audit row on one of the two paths is the
  // shape this lane keeps finding (task 2's `war_sides` decoder, task 1's
  // session-kind string).
  //
  // PLAN-security-hardening task 11 (G10): /api/rooms/start forks+execs a
  // spring-server. The host-only check (delegated to RoomManager::StartGame)
  // already scopes *who* may start *which* room, but nothing bounded the
  // fork/exec rate or the total live process count — an authenticated user
  // could loop create→start and fork-bomb the host. Two bounds:
  //   - a global token bucket (burst 10, ~10/min sustained) on spawns, and
  //   - a hard ceiling on concurrent live game servers.
  // Both apply in dev and prod (a spawn is expensive regardless of build).
  static TokenBucket roomSpawnLimiter(/*burst=*/10.0,
                                      /*perSecond=*/10.0 / 60.0);
  constexpr size_t kMaxConcurrentGameServers = 64;

  /// Brakes only, evaluated before any state mutation. Returns the refusal to
  /// send, or nullopt to proceed.
  auto gameServerSpawnRefusal =
      [&](uint32_t roomId) -> std::optional<HttpResponse> {
    size_t aliveServers = 0;
    for (const auto &[rid, gi] : gameServers)
      if (gi.pid > 0 && isProcessAlive(gi.pid))
        ++aliveServers;
    if (aliveServers >= kMaxConcurrentGameServers) {
      SLOG(SPRING_LOG_WARNING,
           "room %u start refused: %zu/%zu game servers already live", roomId,
           aliveServers, kMaxConcurrentGameServers);
      return HttpAuth::JsonResponse(
          503, R"({"error":"server capacity reached — try again shortly"})");
    }
    if (!roomSpawnLimiter.TryConsume())
      return HttpAuth::JsonResponse(
          429, R"({"error":"game-start rate limit exceeded"})");
    return std::nullopt;
  };

  /// Fork the game server for a room whose state has already been moved to
  /// Loading, and record it (in-memory instance, `game_servers` row, room
  /// port, audit row). `auditAction` distinguishes the two callers in the
  /// audit trail: a host starting a match and a war coming back up are not
  /// the same operator event even though they run the same code.
  /// A WAR always comes up on its stored world if it has one (PLAN-persistence
  /// task 3b) — decided here rather than passed in, because there is exactly one
  /// correct answer and a parameter would invite a caller to get it wrong. The
  /// caller that gets it wrong silently discards a frozen war and stages a fresh
  /// one over the top of it, which is the failure this whole task exists to
  /// prevent; `/api/rooms/start` on a war room in Filling was one keystroke away
  /// from being that caller.
  auto spawnServerForRoom = [&](GameRoom &room, int64_t userId,
                                const char *auditAction) {
    // Last line of defence before the game server forks: say out loud whether
    // the war we are about to spawn can ever finish (PLAN-endtoend.md D10).
    warnIfWarCannotEnd(&room);

    // Give every still-unassigned slot a distinct map start position before
    // spawning. AutoAssignStartPositions skips slots that already picked one
    // (via /api/rooms/startpos) and no-ops on maps with no start positions.
    // Without it every slot stays at startPos=-1, the sim spawns ALL teams at
    // map centre, and enemy commanders overlap into a premature GameOver.
    {
      MapMetadataDb mdb;
      const size_t spCount = mdb.GetMap(mapDb, room.mapId).startPositions.size();
      const int8_t maxStartPos =
          static_cast<int8_t>(spCount > 127 ? 127 : spCount);
      rooms.AutoAssignStartPositions(room.id, maxStartPos);
    }

    auto it = gamePathsById.find(room.gameId);
    if (it == gamePathsById.end())
      return;
    const auto vit = gameVersionsById.find(room.gameId);
    const std::string &gameVer =
        (vit != gameVersionsById.end()) ? vit->second : std::string();
    // Skip ports currently held by live spring-server processes. Without this
    // the new game-server binds via SO_REUSEPORT alongside the old one and
    // incoming client connections round-robin between the two — see
    // findFreePort.
    std::unordered_set<int> busyPorts;
    for (const auto &[rid, gi] : gameServers)
      if (gi.pid > 0 && isProcessAlive(gi.pid))
        busyPorts.insert(gi.port);
    // Only a war gets an idle-hibernate window: a skirmish already has its own
    // idle exit, and freezing a bounded match nobody will resume is a snapshot
    // written for nothing.
    const int hibernateIdle =
        (room.sessionKind == SessionKind::PersistentWar) ? warHibernateIdleSeconds
                                                        : 0;
    // `--resume` only when a snapshot row was SEEN: the server treats a missing
    // snapshot as fatal by design (Hibernation.h), so asking to resume a war
    // that has never run would abort the process instead of launching it.
    //
    // The decision runs through `warresume::PlanJoin` rather than re-testing
    // `.has` here (task 3c). The join route already logs that plan, and the two
    // reads used to be able to disagree about more than a pruned row: a world
    // this binary may not load (E1) has history and must NOT get the flag, and a
    // second copy of that rule here is how one of them would eventually not
    // learn it. `serverProcessAlive` is deliberately false in the facts we build
    // — we are the spawn, and PlanJoin's live-process branch would otherwise
    // short-circuit the resume decision the caller already made.
    warresume::WarFacts spawnFacts = warFactsFor(room);
    spawnFacts.serverProcessAlive = false;
    spawnFacts.serverReady = false;
    const auto spawnPlan = warresume::PlanJoin(room.sessionKind, spawnFacts);
    const bool resumeFromSnapshot = spawnPlan.withResume;
    if (!spawnPlan.blockedReason.empty())
      SLOG(SPRING_LOG_WARNING, "war room %u: %s", room.id,
           warresume::Describe(spawnPlan).c_str());
    auto inst = spawnGameServer(room.id, room.gameId, gameVer, room.mapId,
                                dbPath, room.players, room.aiSlots,
                                room.modOptions, busyPorts, devBuildAcknowledged,
                                wtCertPath, wtKeyPath,
                                /*replayFile=*/"", room.sessionKind,
                                resumeFromSnapshot, hibernateIdle,
                                warPlayerSlotCap(room));
    gameServers[room.id] = inst;
    persistGameServer(inst);
    room.gameServerPort = inst.port;
    rooms.PersistRoomGameSession(room.id);
    // Audit the process spawn (G10 / §3): who started which game/map on what
    // port. Append-only admin_audit row.
    auto starter = db.FindUserById(userId);
    db.LogAudit(userId, starter ? starter->username : std::string("?"),
                auditAction, room.gameId,
                "room=" + std::to_string(room.id) + " map=" + room.mapId +
                    " port=" + std::to_string(inst.port) +
                    " pid=" + std::to_string(inst.pid));
  };

  // NOTE: /api/rooms/end and /api/rooms/close are removed.
  // Room lifecycle is handled entirely through /api/rooms/leave:
  //   - Last human leaves non-persistent room → room abandoned, game killed
  //   - Host leaves with others present → host transferred
  //   - Persistent room → stays alive with 0 humans

  // POST /api/wars/join-preview — what will happen to ME if I join these wars?
  //
  // PLAN-metalstorm-lobby.md §2.4, task 5: "the lobby's job is to make this
  // legible pre-join ('you'll join Side B near the River Line with 100
  // authority')". A war is the one room kind where the answer is neither
  // obvious nor chosen — the side comes from an immutable faction the player
  // cannot change, the seat may already be held from a previous session, and
  // the authority they arrive with is one of three different things.
  //
  // POST rather than GET only because a GET handler in this server cannot see
  // the Authorization header (`HttpGetHandler` takes the url alone), and this
  // answer is per-account by construction. Body is optional and ignored.
  //
  // All wars in one response, not one call per room: the browser refreshes the
  // whole list on every SSE tick, and N round-trips per tick is a lot of
  // traffic for a line of text.
  //
  // It also carries the while-you-were-away digest (PLAN-persistence §4, task
  // 4b) for the same reason it carries everything else here: this is already
  // the per-account, per-war answer, and a returning player's "what did I
  // miss" is exactly that shape. The cap is on the RESPONSE, not on the
  // history — a war that moved a hundred times while somebody was on holiday
  // is a war whose card must still fit on a card.
  constexpr int kDigestMaxEvents = 8;
  net.AddHttpPost(
      "/api/wars/join-preview", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user)
          return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");
        const std::string faction = user->factionId.value_or("");
        const int64_t now = static_cast<int64_t>(std::time(nullptr));

        nlohmann::json out = nlohmann::json::array();
        for (const auto *room : rooms.GetAllRooms()) {
          if (!room || room->sessionKind != SessionKind::PersistentWar)
            continue;

          // Population per side comes from the BINDING table, not from the
          // room's player list: a war's fighters are seated by the game
          // server on dynamic join and never appear in `room->players` at
          // all, so counting the room would report a full war as empty. The
          // caller's own binding is excluded from the count for the same
          // reason `DecideRejoin` grants `bypassCapacity` — a returning
          // player must not be counted against the seat they are standing in.
          const auto sides = room->SideTeams();
          int factionTeam = -1;
          if (!faction.empty()) {
            if (const auto t = TeamForFactionIn(sides, faction))
              factionTeam = static_cast<int>(*t);
          }
          unsigned humansOnSide = 0;
          bool hasBinding = false;
          int boundTeam = -1;
          int64_t absenceSec = 0;
          int64_t digestSince = 0;
          double savedPool = 0.0;
          bool hasSavedState = false;
          for (const auto &b :
               WarPlayerBindings::ForRoom(db.Handle(), room->id)) {
            if (b.accountId == userId) {
              hasBinding = true;
              boundTeam = b.team;
              absenceSec = now - b.lastSeenAt;
              digestSince = b.lastSeenAt;
              savedPool = b.state.authorityPool;
              hasSavedState = b.HasSavedState();
              continue;
            }
            if (factionTeam >= 0 && b.team == factionTeam)
              humansOnSide++;
          }

          // The join grant the sim will actually mint. Same modoption
          // `game_authority.lua` reads, and the same default (100) — a
          // preview quoting a number the gadget does not use is worse than
          // no preview at all.
          double joinGrant = 100.0;
          if (auto it = room->modOptions.find("authority_join_grant");
              it != room->modOptions.end()) {
            try {
              joinGrant = std::stod(it->second);
            } catch (...) {
              // Leave the default: a malformed modoption is the room's
              // problem and must not 500 the whole browser.
            }
          }

          // Capacity comes from the room's own `war_side_capacities` (task 7),
          // which is the same modoption the game server is launched with and
          // reads at seating time — so the promise and the seating rule are
          // reading one value, not two that agree today. The lobby still never
          // passes `--war-side-capacity`, so `WAR_SIDE_CAPACITY_DEFAULT` is the
          // fallback here exactly as it is in the game server's `ctx`.
          const unsigned capacity = CapacityForSideIn(
              room->SideCapacities(), faction, WAR_SIDE_CAPACITY_DEFAULT);
          const JoinPreview p = PreviewJoin(
              room->sessionKind, faction, sides, humansOnSide, capacity,
              hasBinding, boundTeam, absenceSec, savedPool, hasSavedState,
              joinGrant);

          // §3, task 6: an account that asked to WATCH this war is not going
          // to fight in it whatever the seating rule would allow, and the
          // card has to say the thing that will actually happen. Read from
          // the membership rather than folded into PreviewJoin: the intent is
          // a fact about this room's roster, not about the seating policy,
          // and the game server reads it from the same row (RoomWatchIntent).
          const auto *member = room->FindPlayer(static_cast<uint32_t>(userId));
          const bool watching = member && member->spectateOnly;

          nlohmann::json jp;
          jp["room_id"] = room->id;
          jp["watching"] = watching;
          jp["will_fight"] = p.willFight && !watching;
          jp["reason"] = DynamicJoinOutcomeToString(p.outcome);
          jp["team"] = p.team;
          jp["side"] = p.side;
          jp["humans_on_side"] = p.humansOnSide;
          jp["capacity_per_side"] = p.capacityPerSide;
          jp["authority"] = p.authority;
          jp["authority_source"] = JoinAuthoritySourceToString(p.authoritySource);
          jp["returning"] = p.returning;

          // ── "Your games" (PLAN-persistence §4, task 4c) ─────────────────
          // `returning` answers "would a join seat you back where you were",
          // which is a seating question and goes false the moment the war's
          // sides stop seating this faction on the bound team. Enlistment is
          // the durable fact underneath it — this account has a binding, a
          // saved pool and a frozen world in this war — and it is what the
          // "My wars" list has to filter on. `seat` says which of the two the
          // player is looking at, so a superseded seat can be named rather
          // than silently rendered as a first-time join.
          jp["enlisted"] = hasBinding;
          jp["seat"] = RejoinSeatKey(p.seat);

          // The while-you-were-away digest (PLAN-persistence §4, task 4b).
          //
          // The cursor is the binding's own `last_seen_at`, not a new column:
          // the game server already stamps it on every state sweep and on
          // disconnect, so it IS the instant this account stopped watching
          // this war. That also makes the digest self-clearing — a player who
          // is currently connected has it refreshed every minute, so their
          // "while you were away" window is correctly empty.
          //
          // Only for a returning player, and deliberately: a first-time joiner
          // has not missed anything, they have simply not arrived, and
          // handing them a war's back-story as if it were news is a different
          // feature (a war summary) that nothing has asked for.
          if (hasBinding) {
            int total = 0;
            const auto events = GameEventsDb::Since(
                db.Handle(), room->id, digestSince, kDigestMaxEvents, &total);
            nlohmann::json jd = nlohmann::json::array();
            for (const auto &e : events) {
              nlohmann::json je;
              je["seq"] = e.seq;
              je["kind"] = e.kind;
              je["subject"] = e.subject;
              je["detail"] = e.detail;
              je["team"] = e.team;
              je["frame"] = e.frame;
              jd.push_back(std::move(je));
            }
            jp["digest"] = std::move(jd);
            // The true count, so the client can say "and 40 more" rather than
            // let a truncated list read as the whole story.
            jp["digest_total"] = total;
            jp["away_sec"] = absenceSec;
          }
          out.push_back(std::move(jp));
        }
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/wars/reconnect-token — mint this account's long-TTL key back
  // into ONE war.
  //
  // PLAN-metalstorm-lobby.md §7.3, task 8a. The game server authenticates a
  // returning player against the shared `sessions` row, which is an
  // account-wide bearer credential with a 24 h life; §2.5's promise is that a
  // player who closed the browser mid-war walks back into their side "later",
  // and later is measured in days. Rather than stretch the account-wide
  // credential to cover it, this mints a second one that authorises exactly
  // one thing — "seat this account in room N" — which is what makes a week-
  // long TTL defensible.
  //
  // The BINDING is the authority, not the room's player list: a war's fighters
  // are seated by the game server on dynamic join and never appear in
  // `room->players` (the same reason join-preview counts bindings). So the
  // account that gets a token is exactly the account that already holds a seat
  // in this war — a token is never the thing that grants one.
  net.AddHttpPost(
      "/api/wars/reconnect-token", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        const std::string roomIdStr = HttpAuth::JsonField(body, "room_id");
        uint32_t roomId = 0;
        try {
          roomId = static_cast<uint32_t>(std::stoul(roomIdStr));
        } catch (...) {
          return HttpAuth::JsonResponse(400, R"({"error":"missing or invalid room_id"})");
        }
        const auto *room = rooms.GetRoom(roomId);
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"no such room"})");
        // Skirmishes are excluded rather than silently served: a skirmish dies
        // with its lobby, so a week-long key into one is a credential that
        // outlives everything it could open.
        if (room->sessionKind != SessionKind::PersistentWar)
          return HttpAuth::JsonResponse(400, R"({"error":"not a persistent war"})");
        if (!WarPlayerBindings::Find(db.Handle(), roomId, userId))
          return HttpAuth::JsonResponse(403, R"({"error":"no seat held in this war"})");

        auto token = AuthTokens::IssueWarReconnect(
            db.Handle(), userId, roomId, AuthTokens::kWarReconnectTtlSeconds,
            static_cast<int64_t>(std::time(nullptr)));
        if (!token)
          return HttpAuth::JsonResponse(500, R"({"error":"could not mint token"})");

        nlohmann::json out;
        out["room_id"] = roomId;
        out["token"] = *token;
        out["expires_in"] = AuthTokens::kWarReconnectTtlSeconds;
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // ── Demand-driven seeding (PLAN-metalstorm-wars.md §4, task 2) ──────────
  //
  // The Director's `seed` outcome, made real. Until now `/api/wars/deploy`
  // answered "every war that fields your faction is full" and stopped there,
  // because nothing owned the act of creating one — task 1 wrote the war
  // object and said so explicitly. This is that owner, and it is deliberately
  // ONE composed call: `PlanWarSeed` decides, `BuildWarBootManifest` emits,
  // and `runDirectStart` does every step of the actual creation, so there is
  // no second room-creation path to drift out of sync with `POST /api/rooms`.
  //
  // Three properties this has to keep, none of them obvious:
  //
  //   1. **Never a reassignment.** A player always fights their own faction
  //      (metalstorm §2), so the seeded war contains a side for the requesting
  //      faction and is fought against whichever faction has the longest queue
  //      of its own — nobody is moved anywhere.
  //   2. **Self-limiting.** `warsFielding` comes from
  //      `WarDirector::WarsFielding` — a JOIN over live wars, not a counter —
  //      so each war a faction already fields halves the next one's side. A
  //      surplus faction gets more wars, each smaller, until the floor; the
  //      loop cannot run away. The cooldown below is a second, cruder brake on
  //      the same thing, because a seed spawns a real process.
  //   3. **Authored content only.** The theatre is chosen from the scenarios
  //      that exist, never invented: a map with no side for this faction has
  //      no start box and no staged army for it (§7.6), so if nothing fits,
  //      `seed` stays the recommendation it was rather than becoming a war
  //      that boots wrong.
  //
  // A demand seed is a whole game server process. One a minute is far above
  // any rate a real population produces (each seeded war makes the next one
  // unnecessary — it has open seats by construction) and far below the rate a
  // stuck client retrying Deploy could produce.
  constexpr int64_t kDemandSeedCooldownSeconds = 60;
  int64_t lastDemandSeedAt = 0;
  auto demandSeedWar = [&](const std::string &faction, int64_t now,
                           uint32_t &seededRoom,
                           std::string &err) -> bool {
    if (faction.empty()) {
      err = "account has no faction";
      return false;
    }
    if (lastDemandSeedAt != 0 &&
        now - lastDemandSeedAt < kDemandSeedCooldownSeconds) {
      err = "a war was seeded moments ago";
      return false;
    }

    // 1. Supply: registered players per faction, and the seats that exist for
    // them right now across every live war. Reservations count as taken —
    // that is the whole point of holding one.
    const auto registered = db.CountAccountsByFaction();
    std::unordered_map<std::string, unsigned> openSlots;
    std::unordered_map<std::string, unsigned> liveWarsOnMap;
    for (const auto *room : rooms.GetAllRooms()) {
      if (!room || room->sessionKind != SessionKind::PersistentWar)
        continue;
      liveWarsOnMap[room->mapId]++;
      std::unordered_map<std::string, unsigned> boundPerFaction;
      for (const auto &b : WarPlayerBindings::ForRoom(db.Handle(), room->id))
        boundPerFaction[b.factionId]++;
      const auto caps = room->SideCapacities();
      for (const auto &[sideFaction, team] : room->SideTeams()) {
        (void)team;
        const unsigned cap = CapacityForSideIn(caps, sideFaction,
                                               WAR_SIDE_CAPACITY_DEFAULT);
        if (cap == WAR_SIDE_CAPACITY_UNLIMITED) {
          // An unsized side is never full, so this faction never needs a war
          // seeded for it.
          openSlots[sideFaction] += WAR_SEED_MAX_CAPACITY;
          continue;
        }
        const unsigned used =
            boundPerFaction[sideFaction] +
            WarSlotReservations::LiveCount(mapDb, room->id, sideFaction, now);
        openSlots[sideFaction] += cap > used ? cap - used : 0u;
      }
    }
    std::vector<FactionDemand> supply;
    supply.reserve(registered.size());
    for (const auto &[f, n] : registered) {
      FactionDemand d;
      d.factionId = f;
      d.registered = n;
      const auto it = openSlots.find(f);
      d.openSlots = it == openSlots.end() ? 0u : it->second;
      supply.push_back(std::move(d));
    }
    const auto opponents = ChooseDemandSeedOpponents(faction, supply,
                                                     /*maxOpponents=*/3);
    if (opponents.empty()) {
      err = "no other faction has any registered players to fight";
      return false;
    }

    // 2. Theatre: an authored, terminal scenario that fields us against one of
    // them. `terminal` is required for the same reason `DefaultForMap` demands
    // it — the one thing this must not do is create a war that cannot end.
    const GameDiscovery::GameInfo *game =
        GameDiscovery::DefaultPlayable(availableGames);
    if (game == nullptr) {
      err = "no playable game is installed";
      return false;
    }
    MapMetadataDb mdb;
    std::vector<TheatreOption> theatres;
    for (const auto &info : scenariosFor(game->id)) {
      if (info.tutorial || info.retired || !info.terminal || info.mapId.empty())
        continue;
      TheatreOption t;
      t.mapId = info.mapId;
      t.scenarioId = info.id;
      for (const auto &s : ScenarioDiscovery::PlayableSides(info))
        t.factions.push_back(s.faction);
      if (t.factions.size() < 2)
        continue;
      t.startBoxCount =
          static_cast<unsigned>(mdb.GetMap(mapDb, info.mapId).startPositions.size());
      const auto it = liveWarsOnMap.find(info.mapId);
      t.liveWars = it == liveWarsOnMap.end() ? 0u : it->second;
      theatres.push_back(std::move(t));
    }
    const TheatreOption *pick =
        ChooseDemandSeedTheatre(theatres, faction, opponents);
    if (pick == nullptr) {
      err = "no authored theatre fields '" + faction +
            "' against a faction with players";
      return false;
    }

    // 3. Plan. The sides are the theatre's own, in its declaration order,
    // filtered to us and the opponents we ranked — so the war is exactly the
    // one the scenario knows how to stage.
    WarSeedRequest req;
    req.theatre = pick->mapId;
    req.gameId = game->id;
    req.scenario = pick->scenarioId;
    req.origin = WarOrigin::Demand;
    req.startBoxCount = pick->startBoxCount;
    for (const auto &f : pick->factions)
      if (f == faction || std::find(opponents.begin(), opponents.end(), f) !=
                              opponents.end())
        req.factions.push_back(f);
    // Unique by construction: `runDirectStart` REPLACES a standing room of the
    // same name (its idempotent-restart rule), so a fixed name would make
    // every demand seed kill the previous one.
    req.name = "War " + std::to_string(now) + " · " + pick->mapId;
    WarSeedPopulation pop;
    pop.registered = registered;
    for (const auto &f : req.factions)
      pop.warsFielding[f] = WarDirector::WarsFielding(mapDb, f);
    const WarSeedPlan plan = PlanWarSeed(req, pop);
    if (!plan.ok) {
      err = plan.error;
      return false;
    }

    // 4. One boot call.
    nlohmann::json manifest = nlohmann::json::parse(
        BuildWarBootManifest(plan), nullptr, /*allow_exceptions=*/false);
    if (manifest.is_discarded()) {
      err = "could not build the boot manifest";
      return false;
    }
    auto result = runDirectStart(manifest);
    if (!result.ok) {
      err = result.error.empty() ? "boot failed" : result.error;
      return false;
    }
    lastDemandSeedAt = now;
    seededRoom = result.roomId;

    // 5. Record what actually booted, not what was planned — see
    // `ReconcileSeededSides` for why the scenario, not the Director, is the
    // authority on which team a side sits on.
    WarSeedPlan booted = plan;
    unsigned spawnedSlotCap = 0;
    if (const GameRoom *room = rooms.GetRoom(result.roomId)) {
      booted = ReconcileSeededSides(plan, room->SideTeams(),
                                    room->SideCapacities());
      // The number the PROCESS was sized with, not the number the plan asked
      // for (§8.1). Same function `spawnGameServer` was handed a moment ago,
      // over the same room, so `wars.spawned_slot_cap` and `--player-slots`
      // cannot drift — and drift is exactly what would make a dynamic joiner
      // be promised a seat the game server has no player number for.
      spawnedSlotCap = warPlayerSlotCap(*room);
    }
    WarDirector::Register(mapDb, result.roomId, booted, now);
    WarDirector::SetState(mapDb, result.roomId, WarState::Open, now);
    WarDirector::RecordSpawnedSlotCap(mapDb, result.roomId, spawnedSlotCap);
    SLOG(SPRING_LOG_NOTICE,
         "demand-seed: war '%s' (room %u) on '%s' scenario '%s' for faction "
         "'%s', %zu side(s), Σ slotCap %u (%u player slot(s) pre-allocated)",
         booted.name.c_str(), result.roomId, booted.theatre.c_str(),
         booted.scenario.c_str(), faction.c_str(), booted.sides.size(),
         booted.TotalSlotCap(), spawnedSlotCap);
    return true;
  };

  // POST /api/wars/deploy — one click: which war should I fight in?
  //
  // PLAN-metalstorm-lobby.md §4/§6, task 7. The browser (task 6) gives a
  // player every fact about every war; this is the answer for the player who
  // does not want to read a table, and it is also where §6's balance lever
  // lives: we cannot move anyone off their faction, but we can decide which
  // war the next volunteer walks into, and sending them where their side is
  // most outnumbered is the only choice that reduces a deficit.
  //
  // Answers, never refuses: an account whose faction is full in every war gets
  // `seed` — §6's own alternative to a queue, and the reason no queue is built
  // (see WarDeploy.h). The lobby does not create the war here; `seed` is a
  // recommendation the client turns into the ordinary Create Game flow, so a
  // war is still created by somebody who chose its map and scenario.
  net.AddHttpPost(
      "/api/wars/deploy", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user)
          return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");
        const std::string faction = user->factionId.value_or("");

        std::vector<DeployCandidate> candidates;
        for (const auto *room : rooms.GetAllRooms()) {
          if (!room || room->sessionKind != SessionKind::PersistentWar)
            continue;
          const auto sides = room->SideTeams();
          const auto team = TeamForFactionIn(sides, faction);

          DeployCandidate c;
          c.roomId = room->id;
          c.fieldsMyFaction = team.has_value();
          c.myCapacity = CapacityForSideIn(room->SideCapacities(), faction,
                                           WAR_SIDE_CAPACITY_DEFAULT);
          // Same durable population the browser's card counts, for the same
          // reason: an offline veteran's seat is not free, so a war that looks
          // empty right now may have nothing to offer.
          std::unordered_map<int, unsigned> boundPerTeam;
          for (const auto &b :
               WarPlayerBindings::ForRoom(db.Handle(), room->id)) {
            boundPerTeam[b.team]++;
            if (b.accountId == static_cast<int64_t>(userId))
              c.iAmBound = true;
          }
          if (team) {
            const int t = static_cast<int>(*team);
            c.myBound = boundPerTeam.count(t) ? boundPerTeam[t] : 0u;
            for (const auto &[faction2, otherTeam] : sides) {
              (void)faction2;
              if (static_cast<int>(otherTeam) == t)
                continue;
              const unsigned n = boundPerTeam.count(otherTeam)
                                     ? boundPerTeam[otherTeam]
                                     : 0u;
              c.opposingBound = std::max(c.opposingBound, n);
            }
          }
          // Live population is the tie-break only, so its absence costs
          // nothing — a war with no server still ranks, it just never wins a
          // tie against one with people in it.
          WarSummary live;
          if (warSummaryFor(room->id, live)) {
            for (const auto &ls : live.sides)
              c.liveHumans += ls.humans;
          }
          candidates.push_back(c);
        }

        const int64_t nowSec = static_cast<int64_t>(std::time(nullptr));
        DeployDecision d = DecideDeploy(faction, candidates);

        // ── The reservation (§4, task 2) ────────────────────────────────
        //
        // Taken HERE, before this route answers, because this answer is what
        // the client turns into a join — §4's "reserve the slot *before*
        // handing the join token to the lobby". Ranking on a count that was
        // read a moment ago is exactly the last-slot race lobby §2.3/§9.1
        // names: two players both told to go to the same final seat.
        //
        // Losing the race is not an error and does not end the request. The
        // war that just filled is dropped from the candidate list and the
        // ranking runs again — which is the "others fall through" half of
        // §10's test row, and is strictly better for the loser than a queue:
        // they get the second-best war now instead of a promise.
        SlotReserveResult held;
        std::vector<uint32_t> lost;
        while (d.outcome == DeployOutcome::JoinWar ||
               d.outcome == DeployOutcome::ReturnToMyWar) {
          held = WarSlotReservations::Reserve(mapDb, d.roomId, faction, userId,
                                              nowSec);
          if (held.MayJoin())
            break;
          lost.push_back(d.roomId);
          std::vector<DeployCandidate> rest;
          for (const auto &c : candidates)
            if (std::find(lost.begin(), lost.end(), c.roomId) == lost.end())
              rest.push_back(c);
          candidates = std::move(rest);
          d = DecideDeploy(faction, candidates);
        }

        // ── The seed, as an ACTION (§4) ─────────────────────────────────
        //
        // The outcome stays `seed`: it is still the true answer to "where do I
        // fight", and a client that only understood task 1's contract keeps
        // working. What is new is that a war now exists to point at.
        std::string seedError;
        if (d.outcome == DeployOutcome::SeedNewWar && !faction.empty()) {
          uint32_t seededRoom = 0;
          if (demandSeedWar(faction, nowSec, seededRoom, seedError)) {
            d.roomId = seededRoom;
            held = WarSlotReservations::Reserve(mapDb, seededRoom, faction,
                                                userId, nowSec);
          }
        }

        nlohmann::json j;
        j["outcome"] = DeployOutcomeToString(d.outcome);
        j["faction"] = faction;
        j["underdog_by"] = d.underdogBy;
        if (d.roomId != 0) {
          j["room_id"] = d.roomId;
          if (const auto *room = rooms.GetRoom(d.roomId))
            j["room_name"] = room->name;
          j["seeded"] = d.outcome == DeployOutcome::SeedNewWar;
        }
        if (!seedError.empty())
          j["seed_error"] = seedError;
        // The reservation, reported whatever it said: a client that is handed
        // a war it has no held seat in must be able to tell, or it walks into
        // the refusal the reservation exists to prevent.
        if (held.outcome != SlotReserveOutcome::Error || d.roomId != 0) {
          j["reservation"] = SlotReserveOutcomeToString(held.outcome);
          if (held.expiresAt > 0)
            j["reservation_expires_in"] = held.expiresAt - nowSec;
        }
        // §4's underdog FLAG, surfaced. It is the Director's own row, not a
        // number re-derived here, so the lobby, the browser and teams'
        // `JOIN_GRANT` are all reading one answer about which side is
        // outnumbered.
        if (d.roomId != 0) {
          for (const auto &s : WarDirector::SidesFor(mapDb, d.roomId))
            if (s.factionId == faction)
              j["incentivised"] = s.incentivised;
        }
        SLOG(SPRING_LOG_NOTICE,
             "deploy: account %lld (faction '%s') → %s (room %u, underdog by "
             "%u) over %zu war(s)",
             (long long)userId, faction.c_str(),
             DeployOutcomeToString(d.outcome), d.roomId, d.underdogBy,
             candidates.size());
        return HttpAuth::JsonResponse(200, j.dump());
      });

  // ── Task 9a: friends, presence and "join my friend" (§8) ────────────────
  //
  // §8 calls friends "the primary discovery path in a persistent world —
  // people play where their friends are". Four routes, all TokenRequired:
  // the graph is per-account and there is nothing here a stranger may read.
  //
  // The presence half is assembled here rather than in Friends.cpp because
  // its three sources belong to three different owners — the binding table
  // (written by the game server), the room registry (in-memory, this process)
  // and gPresence (HTTP activity) — and the store has no business knowing
  // about any of them. FriendPresence.h holds the rule; this is the gathering.

  /// One account's presence, from every source the lobby actually has.
  auto presenceFactsFor = [&](int64_t accountId, int64_t now) -> PresenceFacts {
    PresenceFacts f;
    f.lobbyLastSeen = gPresence.LastSeen(accountId);
    // Newest binding first (WarPlayerBindings::ForAccount orders it), so the
    // first row that still points at a live war is the answer. A binding to a
    // room that has since been deleted is skipped rather than reported: the
    // seat is real but the war is not, and a friends list offering to join it
    // sends the player at a room id nothing will resolve.
    for (const auto &b : WarPlayerBindings::ForAccount(db.Handle(), accountId)) {
      const auto *room = rooms.GetRoom(b.roomId);
      if (!room || room->sessionKind != SessionKind::PersistentWar)
        continue;
      f.warRoomId = b.roomId;
      f.warTeam = b.team;
      f.warLastSeen = b.lastSeenAt;
      break;
    }
    for (const auto *room : rooms.GetAllRooms()) {
      if (room && room->FindPlayer(static_cast<uint32_t>(accountId))) {
        f.roomId = room->id;
        break;
      }
    }
    (void)now;
    return f;
  };

  /// Resolve a `{"username": ...}` body to an account, or an error response.
  auto friendTarget = [&](const std::string &body, int64_t selfId,
                          std::optional<UserRecord> &out) -> std::optional<HttpResponse> {
    const std::string name = HttpAuth::JsonField(body, "username");
    if (name.empty())
      return HttpAuth::JsonResponse(400, R"({"error":"missing username"})");
    auto target = db.FindUser(name);
    if (!target)
      return HttpAuth::JsonResponse(404, R"({"error":"no such player"})");
    if (target->id == selfId)
      return HttpAuth::JsonResponse(400, R"({"error":"you cannot friend yourself"})");
    out = std::move(target);
    return std::nullopt;
  };

  // POST /api/friends/list — the list, with presence and where each friend is.
  //
  // POST despite reading nothing, for the reason /api/auth/totp/status states:
  // an AddHttpGet handler is not handed the request headers, so a GET route
  // cannot learn WHICH account the dispatcher just admitted — and this
  // response is per-caller by construction.
  net.AddHttpPost(
      "/api/friends/list", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        const int64_t now = static_cast<int64_t>(std::time(nullptr));

        nlohmann::json out = nlohmann::json::array();
        for (const auto &e : Friends::ListFor(db.Handle(), userId)) {
          nlohmann::json fj;
          fj["account_id"] = e.accountId;
          fj["username"] = e.username;
          if (!e.factionId.empty())
            fj["faction"] = e.factionId;
          fj["edge"] = FriendEdgeToString(e.edge);
          fj["since"] = e.since;
          // Presence is published for MUTUAL friends only. An outgoing
          // request must not turn into a tracker for somebody who has not
          // answered it — "add them and watch when they are online" is
          // exactly the shape of surveillance a social graph should not hand
          // out for free, and an incoming request is the same fact from the
          // other end.
          if (e.edge != FriendEdge::Mutual) {
            fj["presence"] = "unknown";
          } else {
            const auto pf = presenceFactsFor(e.accountId, now);
            const auto state = DecidePresence(pf, now);
            fj["presence"] = PresenceStateToString(state);
            if (state == PresenceState::Fighting) {
              fj["war_room_id"] = pf.warRoomId;
              fj["team"] = pf.warTeam;
              if (const auto *room = rooms.GetRoom(pf.warRoomId))
                fj["war_name"] = room->name;
            }
          }
          out.push_back(std::move(fj));
        }
        return HttpAuth::JsonResponse(200, out.dump());
      });

  // POST /api/friends/add — "I consider you a friend."
  //
  // There is no separate accept route: calling this on somebody who has
  // already added you completes the friendship (Friends.h). `edge` in the
  // response says which of the two just happened.
  net.AddHttpPost(
      "/api/friends/add", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        std::optional<UserRecord> target;
        if (auto err = friendTarget(body, userId, target))
          return *err;
        const int64_t now = static_cast<int64_t>(std::time(nullptr));
        if (!Friends::Add(db.Handle(), userId, target->id, now))
          return HttpAuth::JsonResponse(500, R"({"error":"could not add friend"})");
        const auto edge = Friends::EdgeBetween(db.Handle(), userId, target->id);
        SLOG(SPRING_LOG_NOTICE, "friends: account %lld → %s: %s",
             (long long)userId, target->username.c_str(), FriendEdgeToString(edge));
        nlohmann::json j;
        j["ok"] = true;
        j["username"] = target->username;
        j["edge"] = FriendEdgeToString(edge);
        return HttpAuth::JsonResponse(200, j.dump());
      });

  // POST /api/friends/remove — withdraw, decline or unfriend. All one verb,
  // because they are all "there is no edge between us any more", and the
  // removal is symmetric (Friends::Remove).
  net.AddHttpPost(
      "/api/friends/remove", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        std::optional<UserRecord> target;
        if (auto err = friendTarget(body, userId, target))
          return *err;
        const int removed = Friends::Remove(db.Handle(), userId, target->id);
        nlohmann::json j;
        j["ok"] = true;
        j["removed"] = removed;
        return HttpAuth::JsonResponse(200, j.dump());
      });

  // POST /api/friends/join — "take me to where my friend is fighting."
  //
  // Answers, it does not seat: the reply names the war and which side the
  // caller would land on, and the client then calls the ordinary
  // `/api/rooms/join`. That is task 3's "one spawn body, not two" applied
  // again — a second join path here would be a copy that skips the fork
  // brakes, the resume decision and the audit row.
  //
  // §8 says "join their side"; §1b says a faction is permanent and §2.3 says
  // the side follows the faction. So the outcome distinguishes `same_side`
  // from `opposing_side` rather than reporting one `ok` — see FriendPresence.h.
  net.AddHttpPost(
      "/api/friends/join", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        std::optional<UserRecord> target;
        if (auto err = friendTarget(body, userId, target))
          return *err;
        // Mutual only. Following a stranger (or somebody who has not answered
        // your request) around the world is not a feature.
        if (Friends::EdgeBetween(db.Handle(), userId, target->id) !=
            FriendEdge::Mutual)
          return HttpAuth::JsonResponse(403, R"({"error":"not a mutual friend"})");

        auto me = db.FindUserById(userId);
        if (!me)
          return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");
        const int64_t now = static_cast<int64_t>(std::time(nullptr));

        FriendJoinFacts f;
        f.myFaction = me->factionId.value_or("");
        const auto their = presenceFactsFor(target->id, now);
        f.friendInWar = DecidePresence(their, now) == PresenceState::Fighting;
        f.friendTeam = their.warTeam;
        const GameRoom *room =
            f.friendInWar ? rooms.GetRoom(their.warRoomId) : nullptr;
        if (room) {
          f.sides = room->SideTeams();
          f.myCapacity = CapacityForSideIn(room->SideCapacities(), f.myFaction,
                                           WAR_SIDE_CAPACITY_DEFAULT);
          if (const auto myTeam = TeamForFactionIn(f.sides, f.myFaction)) {
            for (const auto &b :
                 WarPlayerBindings::ForRoom(db.Handle(), room->id)) {
              if (b.accountId == userId) { f.iAmBound = true; continue; }
              if (b.team == static_cast<int>(*myTeam)) f.myBound++;
            }
          }
        } else {
          f.friendInWar = false;
        }

        const FriendJoinDecision d = DecideFriendJoin(f);
        nlohmann::json j;
        j["outcome"] = FriendJoinOutcomeToString(d.outcome);
        j["friend"] = target->username;
        if (FriendJoinSeats(d.outcome) && room != nullptr) {
          j["room_id"] = room->id;
          j["room_name"] = room->name;
          j["team"] = d.myTeam;
          j["friend_team"] = f.friendTeam;
        }
        SLOG(SPRING_LOG_NOTICE,
             "friends: account %lld → join '%s' → %s (room %u, team %d)",
             (long long)userId, target->username.c_str(),
             FriendJoinOutcomeToString(d.outcome), room ? room->id : 0u,
             d.myTeam);
        return HttpAuth::JsonResponse(200, j.dump());
      });

  // POST /api/rooms/join — join a room
  net.AddHttpPost(
      "/api/rooms/join", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user)
          return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");

        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint32_t roomId =
            j.contains("room_id") && j["room_id"].is_string()
                ? (uint32_t)std::atoi(j["room_id"].get<std::string>().c_str())
                : (uint32_t)j.value("room_id", 0);
        std::string password = j.value("password", "");
        bool asSpectator = j.value("as_spectator", false);

        // The account's faction decides the side (D40) — RoomManager does the
        // deciding, this path just supplies the datum it never had.
        if (!rooms.JoinRoom(roomId, static_cast<uint32_t>(userId), 0,
                            user->username, password, asSpectator,
                            user->factionId.value_or("")))
          return HttpAuth::JsonResponse(403, R"({"error":"cannot join room"})");

        // PLAN-metalstorm-lobby.md §5.2/§5.3, task 3 — resume on join. A war
        // is not hosted: nobody presses Start Game for it, and after a lobby
        // restart (or a server that died with nobody watching) the room is
        // held rather than recycled, so there is no host action left that
        // could bring it back. The player walking up to it is the trigger.
        //
        // PLAN-persistence task 3b: the respawn now carries the WORLD. If the
        // store holds a snapshot for this room the server comes up with
        // `--resume` and the war is where the players left it; without one it
        // launches from frame 0 exactly as before, and the log says which of
        // the two happened. `warresume::PlanJoin` owns the choice — including
        // the E5 case, where a second joiner arriving mid-respawn is told to
        // wait on the same `resuming` state instead of forking a rival sim.
        if (auto *joined = rooms.GetRoom(roomId)) {
          const auto facts = warFactsFor(*joined);
          const auto plan = warresume::PlanJoin(joined->sessionKind, facts);
          if (plan.action == warresume::WarJoinAction::Spawn) {
            if (auto refusal = gameServerSpawnRefusal(roomId))
              return *refusal;
            rooms.SetRoomState(roomId, ERoomState::Loading);
            // The plan's `withResume` is what this line REPORTS;
            // spawnServerForRoom re-reads the store and is what actually
            // happens. They can only differ if a prune lands between the two
            // reads, and the honest outcome then is the spawn's, not the log's.
            // A dropped world is a WARNING, not a notice: the frames are gone
            // and this line is the only record of which ones (task 3c).
            SLOG(plan.blockedReason.empty() ? SPRING_LOG_NOTICE
                                            : SPRING_LOG_WARNING,
                 "war room %u: %s for '%s'", roomId,
                 warresume::Describe(plan).c_str(), user->username.c_str());
            spawnServerForRoom(*joined, userId, "war_resume");
          } else if (joined->sessionKind == SessionKind::PersistentWar) {
            SLOG(SPRING_LOG_INFO, "war room %u: join by '%s' — %s", roomId,
                 user->username.c_str(), warresume::Describe(plan).c_str());
          }
        }

        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(roomId)));
      });

  // POST /api/rooms/leave — leave a room. If this was the last
  // human in a non-persistent room, the room is abandoned and any
  // running game server is killed. If the host leaves with other
  // humans still present, host is transferred to a random player.
  net.AddHttpPost(
      "/api/rooms/leave", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        uint32_t rid = room->id;
        auto result = rooms.LeaveRoom(rid, static_cast<uint32_t>(userId));

        if (result == LeaveResult::Abandoned) {
          // Kill the game server if one is running
          auto gsIt = gameServers.find(rid);
          if (gsIt != gameServers.end()) {
            kill(gsIt->second.pid, SIGTERM);
            gsIt->second.state = GameServerInstance::Ended;
            removeGameServer(rid);
            SLOG(SPRING_LOG_NOTICE,
                 "room %u abandoned, killed game server pid %d", rid,
                 gsIt->second.pid);
          }
          // A replay room's last watcher leaving ends the cast — the same
          // abandon rule a game room already has (PLAN-replay task 4c).
          gReplayRooms.erase(rid);
          rooms.DeleteRoom(rid);
        }

        broadcastRooms();
        std::string resultStr;
        switch (result) {
        case LeaveResult::Left:
          resultStr = "left";
          break;
        case LeaveResult::HostTransferred:
          resultStr = "host_transferred";
          break;
        case LeaveResult::Abandoned:
          resultStr = "abandoned";
          break;
        case LeaveResult::StillPersistent:
          resultStr = "persistent";
          break;
        default:
          resultStr = "not_found";
          break;
        }
        return HttpAuth::JsonResponse(200, "{\"ok\":true,\"result\":\"" +
                                               resultStr + "\"}");
      });

  // POST /api/rooms/ready
  net.AddHttpPost(
      "/api/rooms/ready", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        // Accept JSON string ("true"/"1") or JSON bool/number for `ready`.
        bool ready = false;
        if (j.contains("ready")) {
          const auto &rv = j["ready"];
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
  net.AddHttpPost(
      "/api/rooms/team", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint8_t team =
            j.contains("team") && j["team"].is_string()
                ? (uint8_t)std::atoi(j["team"].get<std::string>().c_str())
                : (uint8_t)j.value("team", 0);
        // A faction is a permanent allegiance, so it has to hold against the
        // player's own dropdown too — otherwise D40's seating fix is undone by
        // the next click and the "permanent" claim is decoration. Refused
        // here, at the route where a HUMAN chooses, rather than in
        // RoomManager::SetTeam: that call stays deliberately permissive
        // because `/api/rooms/direct` manifests seat NPCs (and real accounts)
        // on teams no side declares, and §7.4's escape hatch is load-bearing
        // for the test vehicles.
        const RoomPlayer *self = room->FindPlayer(static_cast<uint32_t>(userId));
        if (self != nullptr) {
          if (const auto sideTeam = room->TeamForFaction(self->factionId)) {
            if (team != *sideTeam)
              return HttpAuth::JsonResponse(
                  403, "{\"error\":\"you fight for " +
                           HttpAuth::JsonEscape(self->factionId) +
                           "\",\"team\":" +
                           std::to_string(static_cast<unsigned>(*sideTeam)) +
                           "}");
          }
        }
        rooms.SetTeam(room->id, static_cast<uint32_t>(userId), team);
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/enlist — spectator → player (PLAN-metalstorm-onboarding
  // §4). Only converts the LOBBY's roster; a spectator who enlists while
  // watching an already-Active game keeps observing under their existing
  // spring-server session until they rejoin — the running game server's
  // --player roster is fixed at spawn time (dynamic mid-game roster growth
  // is the Stage-7-gated "metalstorm-lobby" work). Enlisting before the
  // game starts converts cleanly: the next spawnGameServer call picks up
  // the updated non-spectator roster.
  net.AddHttpPost(
      "/api/rooms/enlist", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint8_t team =
            j.contains("team") && j["team"].is_string()
                ? (uint8_t)std::atoi(j["team"].get<std::string>().c_str())
                : (uint8_t)j.value("team", 255);
        if (!rooms.EnlistSpectator(room->id, static_cast<uint32_t>(userId),
                                   team))
          return HttpAuth::JsonResponse(403, R"({"error":"cannot enlist"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/startpos
  net.AddHttpPost(
      "/api/rooms/startpos", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        int8_t pos =
            j.contains("pos") && j["pos"].is_string()
                ? (int8_t)std::atoi(j["pos"].get<std::string>().c_str())
                : (int8_t)j.value("pos", 0);
        // An AI slot is a distinct kind of target, not a player id, so it gets
        // read first: the client's `startpos-select` for an AI row sends
        // `target_ai_slot` and no `target_player_id`, and this route used to
        // parse only the latter. Since `target_player_id` defaults to the
        // caller, "move AI slot 0" silently became "move my own start
        // position" — the host's seat jumped and the AI never moved
        // (PLAN-endtoend D63). `protocol_generated.h`'s RoomSetStartPos has
        // documented `target_ai_slot >= 0: target that AI slot, host only`
        // all along; only this HTTP path never honoured it.
        const int aiSlot =
            j.contains("target_ai_slot") && j["target_ai_slot"].is_string()
                ? std::atoi(j["target_ai_slot"].get<std::string>().c_str())
                : j.value("target_ai_slot", -1);
        if (aiSlot >= 0) {
          rooms.SetAIStartPos(room->id, static_cast<uint32_t>(userId),
                              static_cast<uint8_t>(aiSlot), pos, 6);
        } else {
          // Find the target player — default to self
          uint32_t target =
              j.contains("target_player_id") && j["target_player_id"].is_string()
                  ? (uint32_t)std::atoi(
                        j["target_player_id"].get<std::string>().c_str())
                  : (uint32_t)j.value("target_player_id",
                                      static_cast<uint32_t>(userId));
          rooms.SetPlayerStartPos(room->id, static_cast<uint32_t>(userId),
                                  target, pos, 6);
        }
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/kick
  net.AddHttpPost(
      "/api/rooms/kick", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint32_t target =
            j.contains("target_player_id") && j["target_player_id"].is_string()
                ? (uint32_t)std::atoi(
                      j["target_player_id"].get<std::string>().c_str())
                : (uint32_t)j.value("target_player_id", 0);
        if (!rooms.KickPlayer(room->id, static_cast<uint32_t>(userId), target))
          return HttpAuth::JsonResponse(403, R"({"error":"cannot kick"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/ai/add
  net.AddHttpPost(
      "/api/rooms/ai/add", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string aiId = j.value("ai_id", "");
        std::string aiName = j.value("name", "");
        if (aiName.empty())
          aiName = aiId;
        uint8_t team =
            j.contains("team") && j["team"].is_string()
                ? (uint8_t)std::atoi(j["team"].get<std::string>().c_str())
                : (uint8_t)j.value("team", 0);
        if (!rooms.AddAISlot(room->id, static_cast<uint32_t>(userId), aiId,
                             aiName, team))
          return HttpAuth::JsonResponse(400, R"({"error":"cannot add AI"})");
        // Optional personality/difficulty profile at creation time
        // (PLAN-metalstorm-ai.md §10 task 6) — same effect as adding the
        // slot then calling /api/rooms/ai/profile, just one round trip.
        std::string profile = j.value("profile", "");
        if (!profile.empty()) {
          GameRoom *added = rooms.GetRoom(room->id);
          if (added && !added->aiSlots.empty())
            rooms.SetAIProfile(room->id, static_cast<uint32_t>(userId),
                               static_cast<uint8_t>(added->aiSlots.size() - 1),
                               profile);
        }
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/ai/remove
  net.AddHttpPost(
      "/api/rooms/ai/remove", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint8_t slotIndex =
            j.contains("slot_index") && j["slot_index"].is_string()
                ? (uint8_t)std::atoi(j["slot_index"].get<std::string>().c_str())
                : (uint8_t)j.value("slot_index", 0);
        if (!rooms.RemoveAISlot(room->id, static_cast<uint32_t>(userId),
                                slotIndex))
          return HttpAuth::JsonResponse(400, R"({"error":"cannot remove AI"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/modoption — host sets/clears one room modoption.
  // Body: {"key":"...","value":"..."}. An empty/absent value clears it.
  // (PLAN-bar.md §5.)
  net.AddHttpPost(
      "/api/rooms/modoption", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        std::string key = j.value("key", "");
        std::string value = j.value("value", "");
        if (!rooms.SetModOption(room->id, static_cast<uint32_t>(userId), key,
                                value))
          return HttpAuth::JsonResponse(400,
                                        R"({"error":"cannot set modoption"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/ai/team — change an AI slot's team
  net.AddHttpPost(
      "/api/rooms/ai/team", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint8_t slotIndex =
            j.contains("slot_index") && j["slot_index"].is_string()
                ? (uint8_t)std::atoi(j["slot_index"].get<std::string>().c_str())
                : (uint8_t)j.value("slot_index", 0);
        uint8_t team =
            j.contains("team") && j["team"].is_string()
                ? (uint8_t)std::atoi(j["team"].get<std::string>().c_str())
                : (uint8_t)j.value("team", 0);
        if (!rooms.SetAITeam(room->id, static_cast<uint32_t>(userId), slotIndex,
                             team))
          return HttpAuth::JsonResponse(400,
                                        R"({"error":"cannot set AI team"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/ai/profile — set (or, with an empty/absent value,
  // clear) an AI slot's personality/difficulty profile (PLAN-metalstorm-ai.md
  // §10 task 6). Body: {"slot_index": N, "profile": "aggressive"}.
  net.AddHttpPost(
      "/api/rooms/ai/profile", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        uint8_t slotIndex =
            j.contains("slot_index") && j["slot_index"].is_string()
                ? (uint8_t)std::atoi(j["slot_index"].get<std::string>().c_str())
                : (uint8_t)j.value("slot_index", 0);
        std::string profile = j.value("profile", "");
        if (!rooms.SetAIProfile(room->id, static_cast<uint32_t>(userId),
                                slotIndex, profile))
          return HttpAuth::JsonResponse(
              400, R"({"error":"cannot set AI profile"})");
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
      });

  // POST /api/rooms/start — start the game
  net.AddHttpPost(
      "/api/rooms/start", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto *room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
          return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");

        // Fork-bomb brakes (G10), evaluated before any state mutation. Count
        // only genuinely-alive servers so ended/crashed rooms don't wedge the
        // cap.
        if (auto refusal = gameServerSpawnRefusal(room->id))
          return *refusal;

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
          for (const auto &p : room->players) {
            if (!p.isSpectator)
              teams.insert(p.team);
          }
          for (const auto &a : room->aiSlots)
            teams.insert(a.team);
          if (teams.size() <= 1) {
            uint8_t hostTeam = 0;
            for (const auto &p : room->players) {
              if (p.playerId == room->hostPlayerId) {
                hostTeam = p.team;
                break;
              }
            }
            const uint8_t aiTeam = firstFreeSlotTeam(*room, hostTeam);
            if (rooms.AddAISlot(room->id, static_cast<uint32_t>(userId), "null",
                                "Null AI", aiTeam)) {
              SLOG(SPRING_LOG_NOTICE,
                   "room %u: solo start detected — auto-added Null AI on team "
                   "%u",
                   room->id, static_cast<unsigned>(aiTeam));
            } else {
              SLOG(SPRING_LOG_WARNING,
                   "room %u: solo start but auto-AddAISlot failed", room->id);
            }
          }
        }

        if (!rooms.StartGame(room->id, static_cast<uint32_t>(userId))) {
          // Say WHY. RoomManager::StartGame folds four distinct refusals
          // into one bool, and the generic "cannot start game" that used to
          // be returned here was the whole of the player's feedback — the
          // client discarded it too, so pressing Start Game with an unready
          // player in the room did nothing at all and said nothing at all
          // (PLAN-endtoend.md D41, found fire 19). The commonest case by far
          // is the host's own Ready: AllReady() counts the host like anyone
          // else, so a host who adds an AI and presses Start is refused.
          std::string reason =
              room->StartRefusalReason(static_cast<uint32_t>(userId));
          if (reason.empty())
            reason = "cannot start game";
          SLOG(SPRING_LOG_INFO, "room %u start refused: %s", room->id,
               reason.c_str());
          return HttpAuth::JsonResponse(
              400, R"({"error":")" + HttpAuth::JsonEscape(reason) + R"("})");
        }

        // Everything from here — the can-this-war-end warning, start
        // positions, the fork itself, the `game_servers` row and the audit
        // entry — is shared with the war-resume path (task 3), so the two
        // cannot drift apart. Deliberately does NOT back-fill a missing
        // scenario: applyRoomScenario at create time is the single owner of
        // that decision, and silently overturning a host's choice at start is
        // the same "chosen behind your back" property the design call
        // rejected.
        spawnServerForRoom(*room, userId, "room_start");

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
  net.AddHttpPost(
      "/api/rooms/direct", RouteAuth::LocalhostOrAdmin,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        if (!devDirectStart)
          return HttpAuth::JsonResponse(404, R"({"error":"not found"})");
        int64_t callerId = 0;
        std::string callerName = "(loopback)";
        if (!headers.remoteIsLoopback) {
          callerId = HttpAuth::ValidateToken(db, headers.authorization);
          auto caller = callerId > 0 ? db.FindUserById(callerId) : std::nullopt;
          if (!caller || caller->role != "admin")
            return HttpAuth::JsonResponse(
                403,
                R"({"error":"forbidden — direct-start requires admin role or localhost"})");
          callerName = caller->username;
        }

        nlohmann::json manifest =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (manifest.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");

        auto result = runDirectStart(manifest);
        if (!result.ok)
          return HttpAuth::JsonResponse(
              400,
              "{\"error\":\"" + HttpAuth::JsonEscape(result.error) + "\"}");

        // Task 6: direct-start spawns a game-server process off a
        // client-supplied manifest — audit who triggered it.
        db.LogAudit(callerId, callerName, "direct_start",
                    manifest.value("gameId", ""),
                    "room=" + std::to_string(result.roomId));

        nlohmann::json resp =
            nlohmann::json::parse(roomToJson(rooms.GetRoom(result.roomId)));
        resp["sessions"] = nlohmann::json::object();
        for (const auto &[username, token] : result.sessions)
          resp["sessions"][username] = token;
        broadcastRooms();
        return HttpAuth::JsonResponse(200, resp.dump());
      });

  // ─────────────── Replay browser (PLAN-replay.md task 4c) ───────────────
  //
  // T4a-2, stated in §7.13: "the lobby has no replay-serving surface at all —
  // it can record (--replay-dir) and it can spawn game servers, but it cannot
  // enumerate what it recorded and has no path that spawns a
  // `spring-server --replay`." These two routes are that surface. Both 404
  // when --replay-dir is unset, because with no directory there is nothing to
  // browse and nothing to serve — an operator who never turned recording on
  // should not be told the feature is broken.

  /// Resolve a client-supplied replay name to a path inside gReplayDir.
  ///
  /// The name is matched against the directory listing rather than
  /// concatenated onto it. That is deliberately stricter than sanitising the
  /// string: a name that is not one of the files we just enumerated cannot be
  /// served, so no amount of `..`, absolute paths, symlink games or unicode
  /// separators reaches the filesystem. The cost is one directory scan per
  /// watch request, which is nothing next to spawning a process.
  auto resolveReplayFile = [](const std::string &name,
                              std::string &pathOut) -> bool {
    if (gReplayDir.empty() || name.empty())
      return false;
    std::error_code ec;
    for (const auto &entry :
         std::filesystem::directory_iterator(gReplayDir, ec)) {
      if (ec)
        return false;
      if (!entry.is_regular_file(ec))
        continue;
      if (entry.path().extension() != ".msr")
        continue;
      if (entry.path().filename().string() == name) {
        pathOut = entry.path().string();
        return true;
      }
    }
    return false;
  };

  /// One listing row. `LoadSummary` is the cheap read — header, trailer,
  /// outcome and block counts, with the record stream walked but never
  /// decoded — so listing a directory of long campaign segments costs a pass
  /// over their framing rather than the memory to hold every match.
  auto replayToJson = [&](const replay::Summary &s) -> nlohmann::json {
    nlohmann::json j;
    j["file"] = std::filesystem::path(s.path).filename().string();
    j["bytes"] = s.fileBytes;
    if (!s.ok) {
      // Kept in the list rather than dropped: a replay the lobby cannot open
      // is an operator-visible fact, and a silently shorter list is how a
      // corrupt recording goes unnoticed for a month.
      j["ok"] = false;
      j["error"] = s.error;
      return j;
    }
    j["ok"] = true;
    j["game"] = s.header.gameId;
    j["game_version"] = s.header.gameVersion;
    j["map"] = s.header.mapId;
    j["room_id"] = s.header.roomId;
    j["recorded_at"] = s.header.recordedAt;
    j["modified_at"] = s.modifiedAtUnix;
    j["start_frame"] = s.header.startFrame;
    j["end_frame"] = s.EndFrame();
    j["truncated"] = s.truncated;
    j["codec"] = replay::CodecName(s.codec);
    j["records"] = s.recordCount;
    j["hash_points"] = s.hashPointCount;
    // A viewer needs to know a backward seek is impossible before it clicks
    // (§7.15 T4b-1); this is the fact the playback bar's refusal rests on.
    j["checkpoints"] = s.checkpointCount;
    j["players"] = nlohmann::json::array();
    for (const auto &p : s.header.players)
      j["players"].push_back(
          {{"username", p.username}, {"team", p.team}, {"start_pos", p.startPos}});
    j["ai_slots"] = nlohmann::json::array();
    for (const auto &a : s.header.aiSlots)
      j["ai_slots"].push_back(
          {{"ai_id", a.aiId}, {"team", a.team}, {"start_pos", a.startPos}});
    j["modoptions"] = nlohmann::json::object();
    for (const auto &[k, v] : s.header.modOptions)
      j["modoptions"][k] = v;
    // §5's fourth listing column. `declared=false` reads as "no result" and
    // covers two cases that are the same statement to a viewer: a recording
    // that predates the outcome block, and a game that never finished.
    j["outcome"] = nlohmann::json::object();
    j["outcome"]["declared"] = s.outcome.declared;
    if (s.outcome.declared) {
      j["outcome"]["frame"] = s.outcome.frame;
      j["outcome"]["winning_ally_teams"] = s.outcome.winningAllyTeams;
    }
    // Whether this recording already has a live cast to join (§5 casting).
    for (const auto &[rid, f] : gReplayRooms) {
      if (f == j["file"].get<std::string>()) {
        j["watching_room"] = rid;
        break;
      }
    }
    return j;
  };

  // POST /api/replays/list — what has been recorded.
  //
  // A POST for a read, because a GET has to be: `HttpGetHandler` never
  // receives an Authorization header, so NetworkServer degrades every
  // non-Public GET to loopback-only (see RouteAuth's note in
  // NetworkServer.h). A replay list names players and rooms, so it wants real
  // token auth, and real token auth means POST today.
  net.AddHttpPost(
      "/api/replays/list", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &,
          const HttpRequestHeaders &headers) -> HttpResponse {
        if (requireAuth(headers) <= 0)
          return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");
        if (gReplayDir.empty())
          return HttpAuth::JsonResponse(
              404,
              R"({"error":"this lobby is not recording replays - no --replay-dir is set"})");
        nlohmann::json resp;
        resp["dir"] = gReplayDir;
        resp["replays"] = nlohmann::json::array();
        for (const auto &s : replay::ListDirectory(gReplayDir))
          resp["replays"].push_back(replayToJson(s));
        return HttpAuth::JsonResponse(200, resp.dump());
      });

  // POST /api/replays/watch {"file": "..."} — watch one.
  //
  // Returns a room, in the same JSON every other room route returns, because
  // the client already knows how to turn "a room with a game_server_port and
  // state Loading" into a connected game. A second caller for a recording
  // already being watched JOINS the existing room instead of spawning a
  // second server — that is §5's "casting = one replay server, many
  // spectators", and it is also what makes 4b's controller/succession rule
  // reachable from the lobby at all.
  //
  // THERE IS NO START-FRAME PARAMETER, and that is a finding rather than an
  // omission. §5's deep link is `watch?game=X&frame=N`, and the obvious
  // implementation — pass `--replay-seek N` to the server being spawned — was
  // built, run, and does not work: the launch-time seek is an *uncapped*
  // fast-forward (no checkpoints, so it re-executes every frame from the
  // start) and the server does not service its QUIC connections while it runs.
  // Observed live at frame 2000 of a 6150-frame recording: the watcher's
  // handshake sat unanswered for the whole fast-forward, its WebTransport
  // timed out ("Connection lost"), and it came back as a client the deck no
  // longer recognised as the controller — so the deep link produced a playback
  // bar with every button dead. The frame therefore travels as a
  // `ReplayControl::Seek` from the watcher once it has attached (4b's channel,
  // which already reports "seeking…" and refuses honestly), which is also the
  // more correct model: a start frame is a request to a cast, not a property
  // of the server serving it.
  net.AddHttpPost(
      "/api/replays/watch", RouteAuth::TokenRequired,
      [&](const std::string &, const std::string &body,
          const HttpRequestHeaders &headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user)
          return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");
        if (gReplayDir.empty())
          return HttpAuth::JsonResponse(
              404,
              R"({"error":"this lobby is not recording replays - no --replay-dir is set"})");

        nlohmann::json j =
            nlohmann::json::parse(body, nullptr, /*allow_exceptions=*/false);
        if (j.is_discarded())
          return HttpAuth::JsonResponse(400, R"({"error":"bad json"})");
        const std::string file = j.value("file", "");

        std::string path;
        if (!resolveReplayFile(file, path))
          return HttpAuth::JsonResponse(
              404, R"({"error":"no such replay in this lobby's replay dir"})");

        // Refuse a file we cannot read BEFORE forking: a replay server given
        // an unreadable file exits immediately, and the room it left behind
        // would read to a player as "the game crashed" rather than "this
        // recording is broken".
        const replay::Summary sum = replay::LoadSummary(path);
        if (!sum.ok)
          return HttpAuth::JsonResponse(
              422, "{\"error\":\"" + HttpAuth::JsonEscape(sum.error) + "\"}");

        // Already being cast? Join that room rather than starting a rival
        // server over the same file.
        for (const auto &[rid, f] : gReplayRooms) {
          if (f != file)
            continue;
          auto gsIt = gameServers.find(rid);
          if (gsIt == gameServers.end() || !isProcessAlive(gsIt->second.pid))
            break; // stale entry; the health loop will clear it, spawn anew
          if (!rooms.JoinRoom(rid, static_cast<uint32_t>(userId), 0,
                              user->username, "", /*asSpectator=*/true))
            return HttpAuth::JsonResponse(
                403, R"({"error":"cannot join the cast for this replay"})");
          SLOG(SPRING_LOG_NOTICE, "'%s' joined the cast of '%s' (room %u)",
               user->username.c_str(), file.c_str(), rid);
          broadcastRooms();
          return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(rid)));
        }

        // One watcher may only be in one room; leaving is implicit, same as
        // the direct-start path treats it.
        if (auto *prior = findPlayerRoom(static_cast<uint32_t>(userId))) {
          const uint32_t priorId = prior->id;
          if (rooms.LeaveRoom(priorId, static_cast<uint32_t>(userId)) ==
              LeaveResult::Abandoned) {
            auto gsIt = gameServers.find(priorId);
            if (gsIt != gameServers.end()) {
              kill(gsIt->second.pid, SIGTERM);
              removeGameServer(priorId);
              gameServers.erase(gsIt);
            }
            gReplayRooms.erase(priorId);
            rooms.DeleteRoom(priorId);
          }
        }

        // The room's map/game come out of the RECORDING's header, not from a
        // caller-supplied field: they are what the client preloads content
        // for, and a mismatch there is a black screen rather than an error.
        const uint32_t roomId = rooms.CreateRoom(
            "▶ " + file, sum.header.mapId, sum.header.gameId, /*maxPlayers=*/8,
            /*password=*/"", static_cast<uint32_t>(userId), 0, user->username,
            /*persistent=*/false);
        gReplayRooms[roomId] = file;

        std::unordered_set<int> busyPorts;
        for (const auto &[rid, gi] : gameServers)
          if (gi.pid > 0 && isProcessAlive(gi.pid))
            busyPorts.insert(gi.port);
        auto inst = spawnGameServer(
            roomId, sum.header.gameId, sum.header.gameVersion, sum.header.mapId,
            dbPath, /*playerRoster=*/{}, /*aiSlots=*/{}, /*modOptions=*/{},
            busyPorts, devBuildAcknowledged, wtCertPath, wtKeyPath, path);
        if (inst.state == GameServerInstance::Crashed) {
          gReplayRooms.erase(roomId);
          rooms.DeleteRoom(roomId);
          return HttpAuth::JsonResponse(
              500, R"({"error":"could not start a replay server"})");
        }
        gameServers[roomId] = inst;
        persistGameServer(inst);

        GameRoom *room = rooms.GetRoom(roomId);
        room->gameServerPort = inst.port;
        // Loading, not Active: the health loop promotes it once the server
        // publishes game_status.ready, exactly as it does for a live game. The
        // client's connect-retry already tolerates the gap.
        rooms.SetRoomState(roomId, ERoomState::Loading);

        db.LogAudit(userId, user->username, "replay_watch", file,
                    "room=" + std::to_string(roomId));
        broadcastRooms();
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(roomId)));
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
      SLOG(SPRING_LOG_ERROR, "--direct: cannot open manifest '%s'",
           directManifestPath.c_str());
    } else {
      std::string content((std::istreambuf_iterator<char>(mf)),
                          std::istreambuf_iterator<char>());
      nlohmann::json manifest =
          nlohmann::json::parse(content, nullptr, /*allow_exceptions=*/false);
      if (manifest.is_discarded()) {
        SLOG(SPRING_LOG_ERROR, "--direct: bad JSON in '%s'",
             directManifestPath.c_str());
      } else {
        auto result = runDirectStart(manifest);
        if (result.ok) {
          SLOG(SPRING_LOG_NOTICE,
               "--direct: standing room ready (room %u, '%s')", result.roomId,
               manifest.value("name", "dev:direct").c_str());
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

  // --- Periodic maintenance connection (PLAN-long-uptime S9) ---
  // The expired-session sweep below has to run from this thread, and it must
  // NOT run through `db`: the HTTP route handlers use that handle unguarded
  // from the NetworkServer thread, and macOS's system libsqlite3 hands out
  // NOMUTEX handles, so sharing it across threads is a data race on the
  // handle rather than mere lock contention. A second connection to the same
  // WAL file is safe by construction (and `Database::Open` gives it a busy
  // timeout, which is what makes the two writers coexist).
  Database maintenanceDb;
  const bool haveMaintenanceDb = maintenanceDb.Open(dbPath);
  if (!haveMaintenanceDb)
    SLOG(SPRING_LOG_ERROR,
         "maintenance db connection failed — expired sessions will not be "
         "swept while this lobby runs");

  // --- Main loop (10 Hz for lobby — HTTP serving + process management) ---
  int reapTick = 0;
  int errorPruneTick = 0;
  int sessionSweepTick = 0;
  /// War-browser refresh cadence (task 6) — see the tick below for why a war
  /// needs one and a room does not.
  int warBroadcastTick = 0;
  // PLAN-long-uptime task 3 (§3): the durable record of a growth alarm.
  // Per-room, the set of alarm labels this lobby has already written an audit
  // row for. The fleet view already *shows* live alarms off the same JSON;
  // this exists so an alarm that trips at 03:00 and clears before anyone looks
  // still leaves a trace, and so the drill-down's audit trail — which is where
  // an operator reconstructs what happened to a long game — carries it.
  //
  // §3 asks for a `game_events` entry. That table does not exist and §7.3
  // struck it from S3 for the same reason; `admin_audit` is the table the
  // dashboard already reads, so the alarm lands there with userId 0 (no human
  // took this action) and username "system".
  // (unordered_map, not map: `rts/Map/` shadows the `<map>` header on macOS.)
  int alarmScanTick = 0;
  std::unordered_map<int, std::set<std::string>> knownRoomAlarms;
  // PLAN-metalstorm-wars.md §4, task 2: the side-sizing / underdog sweep.
  int warSideMaintenanceTick = 0;
  // §7, task 4: the meta-state machine's driver.
  int warLifecycleTick = 0;
  while (keepRunning.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));

    // Maintain every live war's sides (~every 30 s at 10 Hz). Two rules, both
    // §4's, and both of which need a clock rather than an event: a cap is
    // raised because a side has been full for a while, and the underdog flag
    // follows a population that changes when the game server writes a binding
    // — a write this process is not notified of.
    //
    // 30 s is chosen against the thing it feeds: the flag routes the NEXT
    // volunteer (Deploy's ranking) and pays their join grant, so it has to be
    // fresh on the scale of somebody clicking Deploy, not of a war ending.
    if (++warSideMaintenanceTick >= 300) {
      warSideMaintenanceTick = 0;
      const int64_t now = static_cast<int64_t>(std::time(nullptr));
      // Lapsed reservations are already not counted anywhere (expiry is read
      // at query time); this only keeps the table from growing for the life of
      // the db.
      WarSlotReservations::ReleaseExpired(mapDb, now);
      for (const auto &war : WarDirector::ListLive(mapDb)) {
        WarSizingLimits limits;
        // The map limit §4 says a raise must stay within, supplied by the only
        // code that has it: `war_sides` deliberately does not know the map,
        // and the room does — its `maxPlayers` is the seat count this theatre
        // was actually opened with. `spawnedSlotCap` (the size of the running
        // server's player arrays) is filled from the `wars` row.
        if (const auto *room = rooms.GetRoom(war.roomId))
          limits.mapSlotLimit = room->maxPlayers;
        const auto r = MaintainWarSides(mapDb, war.roomId, limits, now);
        if (r.capsRaised > 0 || r.flagsChanged > 0)
          SLOG(SPRING_LOG_NOTICE,
               "war %u: %u side cap(s) raised, %u incentive flag(s) changed",
               war.roomId, r.capsRaised, r.flagsChanged);
      }
    }

    // Advance every live war's meta-state (~every 5 s at 10 Hz) —
    // PLAN-metalstorm-wars.md §7, task 4. This is the half §7.2 explicitly
    // left to the Director: "the lobby still lists a finished room as In
    // Progress ... that is the Director's half (task 1/4)". The game server
    // now records its ending in `war_outcome` and exits; nothing was reading
    // that.
    //
    // 5 s, not the 30 s the side sweep uses, because the chain is walked one
    // link per pass (`NextWarState`) and there are three of them between a
    // declared win and an archived war. At 30 s a finished war would keep
    // advertising itself for a minute and a half; at 5 s the browser catches
    // up inside the sim's own 10 s wind-down beat. The cost of a pass over an
    // idle population is one indexed read per war and no transaction —
    // `AdvanceWarLifecycle` returns early when nothing moved.
    if (++warLifecycleTick >= 50) {
      warLifecycleTick = 0;
      const int64_t now = static_cast<int64_t>(std::time(nullptr));
      for (const auto &war : WarDirector::ListLive(mapDb)) {
        WarTerminationFacts facts;
        // The sim's declaration. The DURABLE row is the signal, not the
        // perishable summary: the game server exits a few minutes after
        // declaring the result (§7.2's --postgame-exit-seconds) and its
        // summary is dropped as stale half a minute later, so a lobby that
        // was down for a maintenance restart would otherwise miss the ending
        // entirely and leave the war live forever.
        if (WarOutcomeDb::HasOutcome(mapDb, war.roomId))
          facts.simWarState = "over";

        // The foothold census and the live-human count both come off the
        // summary, and both are absent for a hibernated war — which is
        // exactly right. A frozen war ends for no reason at all: the census
        // is unusable (so elimination is inert) and `hasLiveHumans` is false
        // (so nothing is promoted). teams §4.5 as corrected by review §A8.
        bool hasLiveHumans = false;
        WarSummary live;
        if (warSummaryFor(war.roomId, live)) {
          facts.footholdsKnown = live.footholdsKnown;
          for (const auto &side : live.sides) {
            if (side.humans > 0) hasLiveHumans = true;
            if (live.footholdsKnown)
              facts.footholds.push_back({side.faction, side.footholds});
          }
        }
        facts.warSeasonId = war.seasonId;
        // NOT WIRED YET, and deliberately visible as such rather than
        // silently absent: `operatorRetire` needs a live-ops verb (a GmVerbs
        // entry) and `currentSeasonId` needs a season the lobby is
        // configured with. Neither exists, so both stay empty/false — which
        // the rule reads as "no seasons configured, nobody pressed retire",
        // the correct answer for this deployment rather than a default
        // standing in for a missing one.

        const auto step =
            AdvanceWarLifecycle(mapDb, war.roomId, facts, hasLiveHumans, now);
        if (!step) continue;
        SLOG(SPRING_LOG_NOTICE, "war %u: %s -> %s (%s)%s", war.roomId,
             WarStateToString(step->from), WarStateToString(step->to),
             WarTerminalReasonToString(step->reason),
             step->archived ? " — archived, digest emitted" : "");
      }
    }

    // Prune expired crash reports ~hourly at 10 Hz. Cheap (one indexed
    // DELETE on created_at) and idempotent, so a no-op hour costs nothing.
    if (++errorPruneTick >= 36000) {
      errorPruneTick = 0;
      const int pruned = db.PruneClientErrors(clientErrorRetentionDays);
      if (pruned > 0)
        SLOG(SPRING_LOG_NOTICE,
             "pruned %d client error report(s) older than %d days", pruned,
             clientErrorRetentionDays);
    }

    // Scan for growth-alarm transitions (~every 60 s at 10 Hz). Matched to the
    // game server's own metric cadence deliberately: the scan only ever looks
    // at the *newest* row per room, so any slower cadence silently skips rows
    // and the audit trail becomes a sample of the transitions rather than a
    // record of them. Cost is one indexed join over the live rooms per minute.
    if (haveMaintenanceDb && ++alarmScanTick >= 600) {
      alarmScanTick = 0;
      std::set<int> seenRooms;
      for (const auto &[roomId, extraJson] : maintenanceDb.LatestGameExtraJson()) {
        seenRooms.insert(roomId);
        std::vector<growth::Alarm> alarms;
        growth::ParseAlarms(extraJson, alarms);
        std::set<std::string> now;
        for (const auto &a : alarms)
          now.insert(a.label);
        auto &known = knownRoomAlarms[roomId];
        for (const auto &a : alarms) {
          if (known.count(a.label))
            continue;
          maintenanceDb.LogAudit(0, "system",
                                 a.crit ? "alarm_crit" : "alarm_warn",
                                 "room=" + std::to_string(roomId), a.detail);
          SLOG(SPRING_LOG_WARNING, "room %d growth alarm [%s]: %s", roomId,
               a.label.c_str(), a.detail.c_str());
        }
        for (const auto &label : known) {
          if (!now.count(label))
            maintenanceDb.LogAudit(0, "system", "alarm_clear",
                                   "room=" + std::to_string(roomId), label);
        }
        known = std::move(now);
      }
      // Forget rooms whose game has ended — otherwise this map is itself an
      // unbounded container in a lobby that stays up for weeks, which would
      // be a poor look for the plan it implements.
      for (auto it = knownRoomAlarms.begin(); it != knownRoomAlarms.end();)
        it = seenRooms.count(it->first) ? std::next(it)
                                        : knownRoomAlarms.erase(it);
    }

    // Sweep expired sessions (~hourly at 10 Hz). PLAN-long-uptime S9: the
    // sweep existed but ran exactly once, at start-up, so a lobby that stays
    // up for the weeks this plan set exists for swept once and never again —
    // `sessions` then grew one row per login for the lifetime of the process.
    if (haveMaintenanceDb && ++sessionSweepTick >= 36000) {
      sessionSweepTick = 0;
      const int swept = maintenanceDb.CleanExpiredSessions(AuthTokens::kAccessTtlSeconds);
      if (swept > 0)
        SLOG(SPRING_LOG_INFO, "swept %d expired session(s)", swept);

      // PLAN-long-uptime T2a-4: `sessions` was the only one of the three
      // retention-free tables the S9 sweep covered. `admin_audit` and
      // `client_errors` are append-only and were never deleted from at all,
      // so they ride the same cadence and the same connection. Windows differ
      // by what the row is for: audit is a compliance trail (90 d), a crash
      // report stops being actionable long before that (30 d — the window
      // client_errors' own schema comment already promised and never got).
      const int audit = maintenanceDb.CleanOldAuditEntries(90 * 86400);
      const int errs = maintenanceDb.CleanOldClientErrors(30 * 86400);
      if (audit > 0 || errs > 0)
        SLOG(SPRING_LOG_INFO, "swept %d audit + %d client-error row(s)", audit,
             errs);

      // PLAN-metalstorm-lobby.md task 8c: abandoned guest accounts, on the
      // same cadence and the same connection. `POST /api/auth/guest` is the
      // one route in the app that mints an account with nothing presented, so
      // without this it is `users` that grows for the life of the deployment
      // — the exact shape T2a-4 above closed for the other three tables.
      //
      // Deletes only a guest who never upgraded, has not been seen for 30
      // days AND holds no war binding: a guest who took a seat owns durable
      // per-player state in a world that may still be running, and the row is
      // the only thing that can give it back to them.
      const int guests =
          GuestAccounts::PruneAbandoned(maintenanceDb.Handle(),
                                        static_cast<int64_t>(std::time(nullptr)));
      if (guests > 0)
        SLOG(SPRING_LOG_INFO, "swept %d abandoned guest account(s)", guests);

      // Task 9a: friend edges whose other end the sweep above just deleted.
      // Ordered AFTER the guest prune deliberately — running it first would
      // leave this fire's own deletions dangling until the next hour. The
      // guest sweep has no idea this table exists (and should not: it deletes
      // accounts, not social graphs), so the cleanup belongs here.
      const int edges = Friends::PruneOrphans(maintenanceDb.Handle());
      if (edges > 0)
        SLOG(SPRING_LOG_INFO, "swept %d orphaned friend edge(s)", edges);
    }

    // Re-broadcast the room list while a war is running (~every 5s at 10 Hz).
    //
    // PLAN-metalstorm-lobby.md §4, task 6. Every other broadcast in this file
    // fires on a room MUTATION, which is the right rule for a room: nothing
    // about a lobby room changes unless somebody changes it. A war is the
    // opposite — its populations, its spectator count and its region control
    // all move without anyone touching the room row, and the game server
    // republishes them every 2s. Without this tick the browser would show a
    // war's opening minute until somebody happened to create a room.
    //
    // Gated on a war existing so a lobby serving only skirmishes keeps its
    // old mutation-only cadence and costs nothing.
    if (++warBroadcastTick >= 50) {
      warBroadcastTick = 0;
      bool anyWar = false;
      for (const auto *r : rooms.GetAllRooms())
        if (r && r->sessionKind == SessionKind::PersistentWar) {
          anyWar = true;
          break;
        }
      if (anyWar)
        broadcastRooms();
    }

    // Periodically reap abandoned rooms (~every 60s at 10 Hz). Catches
    // rooms whose host closed the browser during a long-lived lobby,
    // not just stale rows inherited at startup.
    if (++reapTick >= 600) {
      reapTick = 0;
      auto reaped = rooms.ReapStaleRooms(kRoomIdleReapSeconds);
      if (!reaped.empty()) {
        for (uint32_t rid : reaped) {
          removeGameServer(rid); // safety
          gReplayRooms.erase(rid);
        }
        SLOG(SPRING_LOG_NOTICE, "reaped %zu abandoned room(s)", reaped.size());
        broadcastRooms();
      }
    }

    // Check game server health every loop iteration
    for (auto &[roomId, inst] : gameServers) {
      if (inst.state == GameServerInstance::Starting ||
          inst.state == GameServerInstance::Running) {
        if (!isProcessAlive(inst.pid)) {
          inst.state = GameServerInstance::Ended;
          removeGameServer(roomId);
          SLOG(SPRING_LOG_NOTICE, "game server for room %u (pid %d) has exited",
               roomId, inst.pid);

          // PLAN-replay task 4c: a replay room has no next game. Its server
          // exits when the recording runs out, and recycling it to Filling
          // would leave a room in the browser that offers to start a match
          // nobody configured. Delete it instead — the recording is still on
          // disk and watching it again spawns a fresh server.
          if (auto rit = gReplayRooms.find(roomId); rit != gReplayRooms.end()) {
            SLOG(SPRING_LOG_NOTICE,
                 "replay room %u closed — '%s' played out", roomId,
                 rit->second.c_str());
            gReplayRooms.erase(rit);
            rooms.DeleteRoom(roomId);
            broadcastRooms();
            continue;
          }

          // A war's exit is classified, not just noted (PLAN-persistence task
          // 3b). Two exits look identical from here — the pid is gone either
          // way — and they mean opposite things to the next joiner:
          //
          //   * it checkpointed on the way out → 'hibernated', frozen at a
          //     frame, and `--resume` hands the war back intact;
          //   * it died without one → 'crashed', and whatever it had simulated
          //     since the last snapshot is gone.
          //
          // The store's newest label is the evidence, NOT the exit status: on a
          // debug build the pre-existing `~DynDamageArray` assert makes every
          // exit report 134 (task 3a's field note), so a code-based verdict
          // would call every clean hibernation a crash.
          if (auto *war = rooms.GetRoom(roomId);
              war && war->sessionKind == SessionKind::PersistentWar) {
            const auto snap =
                warresume::LatestSnapshot(mapDb, war->gameId, roomId);
            inst.pid = 0;  // no process; keeps every isProcessAlive() honest
            inst.port = 0; // the port went back to the pool with the process —
                           // a row still naming it would send a tool at a port
                           // the next room may already hold
            inst.state = snap.fromHibernation ? GameServerInstance::Hibernated
                                              : GameServerInstance::Crashed;
            // Re-record the row removeGameServer() just dropped, so the fleet
            // view lists a frozen war instead of losing it. game_status stays
            // deleted — nothing about this room is ready.
            persistGameServer(inst);
            if (snap.fromHibernation)
              SLOG(SPRING_LOG_NOTICE,
                   "war room %u hibernated — frozen at frame %d (%s); the next "
                   "join resumes it",
                   roomId, snap.frame, snap.label.c_str());
            else {
              const std::string fallback =
                  snap.has ? " (resumable from the older frame " +
                                 std::to_string(snap.frame) + ")"
                           : " and has no snapshot history at all";
              SLOG(SPRING_LOG_WARNING,
                   "war room %u CRASHED — its server left no exit checkpoint%s",
                   roomId, fallback.c_str());
            }
          }

          // Recycle the room: transition back to Filling,
          // clear ready flags, zero gameServerPort, drop
          // reconnection roster — unless it is a war, which keeps its state
          // and is resumed by the next joiner (task 3).
          onOrphanedRoom(roomId, "its game server exited");
          broadcastRooms();
          continue;
        }

        // Readiness handshake: when a Starting server publishes ready=1
        // (it's accepting connections + the sim is up), promote it to
        // Running and flip the room Loading→Active. Until now the
        // Loading→Active transition was never driven, so rooms read as
        // "Starting" forever and clients/launch_game raced a not-yet-
        // listening port. game_status is the only honest ready signal.
        if (inst.state == GameServerInstance::Starting &&
            gameServerReady(roomId)) {
          inst.state = GameServerInstance::Running;
          persistGameServer(inst); // game_servers.state → 'running'
          if (auto *room = rooms.GetRoom(roomId);
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
    SLOG(SPRING_LOG_NOTICE,
         "restart requested — persisting game server state...");

    // game_servers table is already up-to-date (maintained in real-time).
    // Just close the database handle.
    if (mapDb) {
      for (auto &[rid, inst] : gameServers) {
        if (inst.state == GameServerInstance::Starting ||
            inst.state == GameServerInstance::Running) {
          SLOG(SPRING_LOG_NOTICE,
               "preserving game server room=%u port=%d pid=%d", rid, inst.port,
               inst.pid);
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

  // Kill any running game servers — except the wars (PLAN-metalstorm-lobby.md
  // §5.3, task 3). A persistent war is *supposed* to outlive the people in it,
  // and this loop was the one end-on-empty path that killed one: the room
  // abandon is gated on `persistent` and the server's own idle exit is gated
  // on the session kind, but "the lobby restarted" tore the war down with the
  // skirmishes. Leaving the process alive is also the only lossless resume
  // that exists today — the startup adoption pass re-attaches by pid and the
  // sim never stopped, whereas a respawn starts the world again at frame 0
  // (§5.4 / PLAN-persistence owns snapshots; creg is stubbed out).
  for (auto &[roomId, inst] : gameServers) {
    if (!isProcessAlive(inst.pid))
      continue;
    const auto *room = rooms.GetRoom(roomId);
    const SessionKind kind = room ? room->sessionKind : SessionKind::Skirmish;
    if (ActionOnLobbyExit(kind, killWarsOnExit) ==
        LobbyExitAction::LeaveRunning) {
      SLOG(SPRING_LOG_NOTICE,
           "left war room=%u (pid %d, port %d) running — it is adopted on the "
           "next lobby start",
           roomId, inst.pid, inst.port);
      continue;
    }
    kill(inst.pid, SIGTERM);
    SLOG(SPRING_LOG_NOTICE, "killed game server pid %d", inst.pid);
  }

  net.Stop();
  db.Close();
  SLOG(SPRING_LOG_NOTICE, "exited cleanly");
  springlog_sqlite_shutdown();
  springlog_shutdown();
  return 0;
}
