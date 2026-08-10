// RoomManager — manages game rooms and their state machines.
//
// Room lifecycle:
//   CONFIGURING → FILLING → READY_CHECK → LOADING → ACTIVE → ENDED
//
// Each room tracks players, teams, readiness, and transitions.
// The server can host multiple rooms simultaneously.
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

struct sqlite3;

using ClientID = uint32_t;

enum class ERoomState : uint8_t {
    Configuring = 0,
    Filling,
    ReadyCheck,
    Loading,
    Active,
    Ended,
};

/// What KIND of session a room hosts (PLAN-metalstorm-lobby.md §1, task 1).
///
/// Two kinds coexist. `Skirmish` is the classic bounded match this engine was
/// built around: fill a roster, ready-check, launch, and GameStart waits until
/// every rostered human has connected. `PersistentWar` is Metalstorm's model:
/// the war is already running, players trickle in and out, and the session may
/// outlive any individual player — so it starts with whatever seed exists and
/// never waits for a roster.
///
/// Deliberately NOT the same field as `GameRoom::persistent`, even though a
/// persistent war is always persistent. `persistent` is a *reaping* policy
/// ("don't delete this room when the last human leaves"), and it is also used
/// for AI-testing rooms that are still ordinary skirmishes. Folding the two
/// together would silently give every such room the no-roster-wait behaviour.
/// The implication runs one way only and CreateRoom enforces it:
/// PersistentWar ⇒ persistent.
enum class SessionKind : uint8_t {
    Skirmish = 0,
    PersistentWar,
};

/// Wire/CLI spelling of a session kind. This exact string crosses three
/// boundaries — the room JSON, `POST /api/rooms`, and spring-server's
/// `--session-kind` flag — so it has one encoder and one decoder.
inline const char* SessionKindToString(SessionKind k) {
    return k == SessionKind::PersistentWar ? "persistent" : "skirmish";
}

/// Decode a session-kind spelling. Returns nullopt for anything unrecognised —
/// callers reject rather than defaulting, because silently downgrading an
/// unknown kind to Skirmish would make a typo'd war wait forever for a roster.
inline std::optional<SessionKind> SessionKindFromString(const std::string& s) {
    if (s == "skirmish") return SessionKind::Skirmish;
    if (s == "persistent" || s == "persistent_war") return SessionKind::PersistentWar;
    return std::nullopt;
}

struct RoomPlayer {
    uint32_t playerId = 0;
    ClientID clientId = 0;
    std::string username;
    uint8_t team = 0;
    bool ready = false;
    bool isSpectator = false;
    bool isHost = false;
    /// Map start position index (into the map's start_positions
    /// array). -1 means "unassigned" — the lobby auto-fills on
    /// game start if it's still -1 at that point.
    int8_t startPos = -1;
    /// The account's permanent faction (`users.faction_id`, e.g.
    /// "compact" / "union"), handed in by the caller at join time —
    /// RoomManager never touches the database. Empty for accounts that
    /// have none: dev/test auto-registrations, `/api/rooms/direct`
    /// manifest accounts, and any pre-faction legacy account.
    ///
    /// In-memory only, deliberately: it is a property of the ACCOUNT, not
    /// of the membership, so persisting a copy in `room_members` would
    /// create a second version of the truth that could go stale against
    /// an admin override. A lobby restart restores the seated `team`
    /// (which is what the room needs) and leaves this empty.
    ///
    /// Read by the seating rule — see GameRoom::TeamForFaction
    /// (PLAN-endtoend.md D40).
    std::string factionId;
};

/// An AI player slot in a room. Populated by the host via
/// RoomAddAI messages before the game starts. At game launch, the
/// lobby translates these into `--ai id:team:pos` args for spring-server,
/// which runs its own AIDiscovery and loads the matching plugin.
///
/// Unlike RoomPlayer, AI slots have no playerId or clientId — they
/// don't consume a session. A room can have arbitrarily many AI
/// slots up to a per-room limit enforced by RoomManager.
struct RoomAISlot {
    std::string aiId;         // stable id (folder name), matches AIInfo::id
    std::string displayName;  // human-readable label from ai.config
    uint8_t team = 0;
    /// Same semantics as RoomPlayer.startPos — -1 means auto-fill
    /// at game start.
    int8_t startPos = -1;
    /// Optional personality/difficulty profile name (e.g. "aggressive",
    /// "caretaker") for AI plugins that support one — PLAN-metalstorm-ai.md
    /// §10 task 6. Empty = no override (the plugin falls back to its own
    /// default, or a scenario-published one). Passed through spawnGameServer
    /// as a 4th "--ai id:team:pos:profile" field; the engine never
    /// interprets it, just carries it to the game-specific AI VM.
    std::string profile;
};

/// Result of a LeaveRoom call, telling the caller what action to take.
enum class LeaveResult : uint8_t {
    Left,           // Player removed; room still has humans
    HostTransferred,// Host left; new host assigned
    Abandoned,      // Last human left non-persistent room; room deleted
    StillPersistent,// Last human left a persistent room; room stays
    NotFound,       // Room or player not found
};

struct GameRoom {
    uint32_t id = 0;
    std::string name;
    std::string mapId;
    std::string gameId;
    ERoomState state = ERoomState::Configuring;
    uint8_t maxPlayers = 8;
    std::string password;      // empty = no password
    uint32_t hostPlayerId = 0;

    /// When true, the room persists even with zero human players.
    /// The original host retains host status indefinitely. Only
    /// the persistent host can modify or end the game. Used for
    /// AI testing, persistent worlds, etc.
    bool persistent = false;

    /// Skirmish (default) or persistent war — see SessionKind. Decides
    /// whether the spawned game server waits for its launch roster before
    /// firing GameStart, and is handed to spring-server as `--session-kind`.
    /// A PersistentWar room always has `persistent = true` (CreateRoom
    /// enforces it); the reverse does not hold.
    SessionKind sessionKind = SessionKind::Skirmish;

    std::vector<RoomPlayer> players;

    /// AI players slotted into this room by the host. Empty until
    /// the host adds the first one. Preserved across room state
    /// transitions up to game start, at which point the roster is
    /// handed off to spring-server via --ai command-line args.
    std::vector<RoomAISlot> aiSlots;

    /// Room-level modoptions (key→value), set by the host before game
    /// start. Handed off to spring-server as `--modoption key=value` args
    /// so synced gadgets read them via Spring.GetModOptions() and the
    /// def-cache key reflects them. (PLAN-bar.md §5.) Empty until the host
    /// sets one; both games' Lua degrade to defaults when absent.
    std::unordered_map<std::string, std::string> modOptions;

    int countdownSeconds = 0;
    uint16_t gameServerPort = 0;   // set when game server is spawned

    /// Original player roster at game start (for reconnection).
    /// Maps playerId → team. Set when room transitions to Loading.
    std::unordered_map<uint32_t, uint8_t> originalRoster;

    /// Check if a player was in the original game roster.
    bool WasOriginalPlayer(uint32_t playerId) const {
        return originalRoster.count(playerId) > 0;
    }

    /// Get original team for a reconnecting player. Returns -1 if not found.
    int GetOriginalTeam(uint32_t playerId) const {
        auto it = originalRoster.find(playerId);
        return (it != originalRoster.end()) ? static_cast<int>(it->second) : -1;
    }

    /// The sides this room offers, as `(faction, team)` in the order the
    /// lobby offers them.
    ///
    /// Read out of the `war_sides` modoption
    /// (`"<faction>:<team>[,<faction>:<team>…]"`, written once by the lobby's
    /// applyRoomScenario from the room's scenario — PLAN-metalstorm-wars.md
    /// §7.4). RoomManager stays entirely scenario-agnostic: as far as it is
    /// concerned this is just "which sides does this room use, and on which
    /// team index does each sit".
    ///
    /// Empty when the modoption is absent or unparseable — see SlotTeams()
    /// for the legacy two-team fallback, which is deliberately NOT applied
    /// here: a legacy room's `{0, 1}` has no faction names, and inventing
    /// some would let the faction seating rule (TeamForFaction) fire on a
    /// room that never declared a side.
    std::vector<std::pair<std::string, uint8_t>> SideTeams() const {
        std::vector<std::pair<std::string, uint8_t>> out;
        const auto it = modOptions.find("war_sides");
        if (it != modOptions.end()) {
            size_t pos = 0;
            const std::string& spec = it->second;
            while (pos < spec.size()) {
                const size_t comma = spec.find(',', pos);
                const std::string entry = spec.substr(
                    pos, comma == std::string::npos ? std::string::npos
                                                    : comma - pos);
                // `colon > 0` — an entry with no faction name is not a side,
                // however parseable its number looks.
                const size_t colon = entry.find(':');
                if (colon != std::string::npos && colon > 0 &&
                    colon + 1 < entry.size()) {
                    const std::string num = entry.substr(colon + 1);
                    // Reject anything non-numeric rather than let atoi's 0
                    // quietly seat two sides on the same team.
                    if (!num.empty() &&
                        num.find_first_not_of("0123456789") ==
                            std::string::npos) {
                        const int team = std::atoi(num.c_str());
                        if (team >= 0 && team <= 255) {
                            const auto t = static_cast<uint8_t>(team);
                            const bool seen = std::any_of(
                                out.begin(), out.end(),
                                [t](const auto& s) { return s.second == t; });
                            if (!seen)
                                out.emplace_back(entry.substr(0, colon), t);
                        }
                    }
                }
                if (comma == std::string::npos)
                    break;
                pos = comma + 1;
            }
        }
        return out;
    }

    /// The team indices a slot in this room may be seated on, in the order
    /// the lobby offers them — SideTeams() with the faction names dropped.
    ///
    /// `{0, 1}` when the room declares no parseable side, which is the legacy
    /// two-team room every non-scenario game (Paper Tanks, ZK) keeps.
    ///
    /// This is what a slot is *offered*, not a whitelist — SetTeam and
    /// AddAISlot still accept anything, because the direct-start manifests
    /// legitimately seat an NPC on a team no side declares (Meridian's team-8
    /// reavers), and that escape hatch is the only reason endtoend D19 was
    /// findable at all.
    std::vector<uint8_t> SlotTeams() const {
        std::vector<uint8_t> out;
        for (const auto& [faction, team] : SideTeams())
            out.push_back(team);
        if (out.empty())
            return {0, 1};
        return out;
    }

    /// The team a given faction is seated on in this room, or nullopt if this
    /// war declares no side for it (including every legacy no-scenario room,
    /// whose sides have no names at all).
    ///
    /// This is the read that makes `users.faction_id` mean something: an
    /// account's faction is a permanent allegiance, so a player must never be
    /// seated against it by a balancer (PLAN-endtoend.md D40,
    /// PLAN-metalstorm-lobby.md §2.3). An empty `factionId` — a dev account, a
    /// `/api/rooms/direct` manifest account, a pre-faction legacy account —
    /// never matches, which is what keeps those paths on the old behaviour.
    std::optional<uint8_t> TeamForFaction(const std::string& factionId) const {
        if (factionId.empty())
            return std::nullopt;
        for (const auto& [faction, team] : SideTeams())
            if (faction == factionId)
                return team;
        return std::nullopt;
    }

    // --- Helpers ---

    RoomPlayer* FindPlayer(uint32_t playerId) {
        for (auto& p : players)
            if (p.playerId == playerId) return &p;
        return nullptr;
    }

    RoomPlayer* FindPlayerByClient(ClientID clientId) {
        for (auto& p : players)
            if (p.clientId == clientId) return &p;
        return nullptr;
    }

    bool IsFull() const {
        int nonSpectators = 0;
        for (const auto& p : players)
            if (!p.isSpectator) nonSpectators++;
        return nonSpectators >= maxPlayers;
    }

    bool AllReady() const {
        for (const auto& p : players)
            if (!p.isSpectator && !p.ready) return false;
        return !players.empty();
    }

    /// Why RoomManager::StartGame would refuse `requesterId`, as a sentence
    /// for the player. Empty string means it would not refuse.
    ///
    /// StartGame folds four distinct refusals into one bool, and the lobby
    /// route used to answer all of them with a flat "cannot start game" that
    /// the client then discarded — so a refused Start Game was silent in both
    /// directions (PLAN-endtoend.md D41). The commonest case is the host's
    /// own Ready: AllReady() counts the host like anyone else, so a host who
    /// seats an AI and presses Start is refused with no explanation.
    ///
    /// Kept beside AllReady() rather than in the route so the conditions
    /// cannot drift apart from the ones StartGame actually tests.
    std::string StartRefusalReason(uint32_t requesterId) const {
        if (hostPlayerId != requesterId)
            return "only the host can start the game";
        if (state != ERoomState::Filling)
            return "this room has already started";
        if (players.empty())
            return "the room is empty";
        std::string unready;
        for (const auto& p : players) {
            if (p.isSpectator || p.ready) continue;
            if (!unready.empty()) unready += ", ";
            unready += p.username;
        }
        if (!unready.empty())
            return "waiting for players to ready up: " + unready;
        return "";
    }

    int PlayerCount() const { return static_cast<int>(players.size()); }
};

class RoomManager {
public:
    /// Attach a SQLite database for write-through persistence. When set,
    /// every state-changing method writes to both the in-memory map and
    /// the `rooms` / `room_members` / `room_ai_slots` tables.
    ///
    /// The lobby calls this once at startup. spring-server does not
    /// (its RoomManager is process-local for the lifetime of the game
    /// and should not race the lobby on the same tables).
    ///
    /// Caller owns the sqlite3* and must call this with nullptr (or
    /// destroy the RoomManager) before closing the handle.
    void SetDatabase(sqlite3* db);

    /// Ensure the rooms / room_members / room_ai_slots tables exist
    /// at the current schema version. If the schema is stale (probe
    /// for the newest column fails) the tables are dropped and
    /// recreated. Same pattern as MapMetadataDb::EnsureTable.
    static void EnsureTables(sqlite3* db);

    /// Replay the rooms / room_members / room_ai_slots tables into
    /// memory. Called once at lobby startup before the main loop, so
    /// the room browser is correct from the first request. Sets
    /// nextRoomId to MAX(rooms.id)+1 so freshly-created rooms don't
    /// reuse the id of a still-running game.
    void LoadFromDatabase();

    /// Create a new room. Returns room ID.
    uint32_t CreateRoom(const std::string& name, const std::string& mapId,
                        const std::string& gameId, uint8_t maxPlayers,
                        const std::string& password,
                        uint32_t hostPlayerId, ClientID hostClientId,
                        const std::string& hostUsername,
                        bool persistent = false,
                        const std::string& hostFactionId = "",
                        SessionKind sessionKind = SessionKind::Skirmish);

    /// Join a room. Returns true on success.
    ///
    /// `factionId` is the joining account's permanent faction
    /// (`users.faction_id`); when the room declares a side for it the joiner
    /// is seated there instead of being auto-balanced (D40). Empty — the
    /// default — is "this account has no faction", which keeps the pure
    /// balance behaviour for dev/manifest accounts and legacy rooms. The
    /// caller supplies it: RoomManager never reads the database.
    bool JoinRoom(uint32_t roomId, uint32_t playerId, ClientID clientId,
                  const std::string& username, const std::string& password,
                  bool asSpectator = false,
                  const std::string& factionId = "");

    /// Leave a room. Returns what happened so the caller can take
    /// appropriate action (e.g. kill game server on Abandoned).
    LeaveResult LeaveRoom(uint32_t roomId, uint32_t playerId);

    /// Set a player's team.
    bool SetTeam(uint32_t roomId, uint32_t playerId, uint8_t team);

    /// Set a player's ready state.
    bool SetReady(uint32_t roomId, uint32_t playerId, bool ready);

    /// Convert a spectator to an active player ("Enlist"). Returns true on
    /// success. Fails if the requester is not a spectator, the room is full
    /// of non-spectator players, or the specified team is invalid. If team
    /// is 255, auto-assigns the next available team.
    bool EnlistSpectator(uint32_t roomId, uint32_t playerId, uint8_t team);

    /// Kick a player (host only).
    bool KickPlayer(uint32_t roomId, uint32_t requesterId, uint32_t targetId);

    /// Delete a room unconditionally (internal use — called after
    /// LeaveRoom returns Abandoned). Callers must kill any game
    /// subprocess before calling this.
    void DeleteRoom(uint32_t roomId);

    /// Reap abandoned rooms.
    ///
    /// The lobby is HTTP-only: there is no persistent lobby socket whose
    /// disconnect could abandon a room (RemoveClient is never called), so
    /// non-persistent rooms with no running game accumulate in the DB and
    /// survive lobby restarts via LoadFromDatabase. This removes any room
    /// that is (a) not persistent, (b) not hosting a live game
    /// (gameServerPort == 0 and state ∉ {Loading, Active}), and (c) has not
    /// been touched (`rooms.updated_at`) within `maxIdleSeconds`.
    ///
    /// Staleness is a proxy for player presence — the HTTP lobby tracks no
    /// liveness signal, so a room is judged abandoned by how long since its
    /// last mutation. Persistent rooms and rooms with a live game server are
    /// always kept. `maxIdleSeconds <= 0` reaps every eligible room
    /// regardless of age (force-clean). Returns the ids reaped so the caller
    /// can release any associated resources and refresh the room browser.
    std::vector<uint32_t> ReapStaleRooms(int64_t maxIdleSeconds);

    /// Add an AI slot to the room (host only). `aiId` / `displayName`
    /// are opaque strings from the lobby's AIDiscovery list; the
    /// caller is responsible for validating the id against the
    /// discovered set before calling. Returns true on success.
    /// Fails if the requester is not the host, the room is past
    /// Filling (too late to add AI), or the AI slot cap is reached.
    bool AddAISlot(uint32_t roomId, uint32_t requesterId,
                   const std::string& aiId,
                   const std::string& displayName,
                   uint8_t team);

    /// Remove the AI slot at `slotIndex` (host only). Out-of-range
    /// indices are silently ignored.
    bool RemoveAISlot(uint32_t roomId, uint32_t requesterId,
                      uint8_t slotIndex);

    /// Set (or, with an empty value, clear) a single room modoption
    /// (host only, pre-start). Returns false if the requester is not the
    /// host or the room is past the pre-game states. (PLAN-bar.md §5.)
    bool SetModOption(uint32_t roomId, uint32_t requesterId,
                      const std::string& key, const std::string& value);

    /// Reassign the AI slot at `slotIndex` to a different team
    /// (host only). Start position is preserved. Returns false if
    /// the requester is not the host or the index is out of range.
    bool SetAITeam(uint32_t roomId, uint32_t requesterId,
                   uint8_t slotIndex, uint8_t team);

    /// Set (or, with an empty string, clear) the AI slot at `slotIndex`'s
    /// personality/difficulty profile (host only) — PLAN-metalstorm-ai.md
    /// §10 task 6. Not validated against any allow-list here: the profile
    /// name is opaque, game-specific data (ai/strategos/config.lua's
    /// Config.PROFILES for Metalstorm); the engine only carries it.
    /// Returns false if the requester is not the host or the index is out
    /// of range.
    bool SetAIProfile(uint32_t roomId, uint32_t requesterId,
                      uint8_t slotIndex, const std::string& profile);

    /// Set the start position for a player slot.
    ///
    /// Permissions: a player can only set their own slot; the host
    /// can set any player's slot. `posIndex == -1` clears the slot
    /// (it'll be auto-assigned at game start).
    ///
    /// Returns false if the requester lacks permission, the target
    /// player doesn't exist in the room, the position is out of
    /// range for `maxStartPos`, or the position is already taken
    /// by another slot.
    bool SetPlayerStartPos(uint32_t roomId, uint32_t requesterId,
                           uint32_t targetPlayerId, int8_t posIndex,
                           int8_t maxStartPos);

    /// Set the start position for an AI slot. Host-only; otherwise
    /// same semantics as SetPlayerStartPos.
    bool SetAIStartPos(uint32_t roomId, uint32_t requesterId,
                       uint8_t slotIndex, int8_t posIndex,
                       int8_t maxStartPos);

    /// Persist `room.gameServerPort` and the host's `start_pos` after
    /// AutoAssignStartPositions runs. Called by the lobby right
    /// before spawning the game subprocess. No-op when no DB is set.
    void PersistRoomGameSession(uint32_t roomId);

    /// Auto-assign unassigned start positions in the room. Called
    /// by the lobby at game-start time so any slot that still has
    /// `startPos == -1` gets a concrete index before the roster is
    /// handed off to spring-server. Positions are picked in
    /// ascending order from the pool `[0, maxStartPos)`, skipping
    /// anything already taken. Slots that can't be auto-assigned
    /// (not enough unique positions in the map) are left at -1
    /// and the caller decides whether to proceed or error.
    void AutoAssignStartPositions(uint32_t roomId, int8_t maxStartPos);

    /// Start the game (host triggers, requires all players ready).
    bool StartGame(uint32_t roomId, uint32_t requesterId);

    /// Transition a room to a new state.
    void SetRoomState(uint32_t roomId, ERoomState newState);

    /// Recycle a room after its game subprocess has exited. Puts
    /// the room back into Filling state, clears per-player ready
    /// flags, zeroes the stored gameServerPort, and drops the
    /// original-roster reconnection map. Called by the health-check
    /// loop in lobby_main when a game's subprocess dies so the
    /// same room can immediately host another game without the
    /// host having to close + recreate it. No-op on unknown roomId.
    void ResetRoomForNextGame(uint32_t roomId);

    /// Get a room by ID.
    GameRoom* GetRoom(uint32_t roomId);

    /// Get all rooms (for room browser).
    std::vector<GameRoom*> GetAllRooms();

    /// Find which room a client is in.
    GameRoom* FindRoomByClient(ClientID clientId);

    /// Remove a client from any room they're in.
    void RemoveClient(ClientID clientId);

private:
    // --- SQLite write-through helpers (no-op when db is null) ---
    void PersistRoomLocked(const GameRoom& room);
    void DeleteRoomFromDb(uint32_t roomId);
    void PersistMembersLocked(const GameRoom& room);
    void PersistAISlotsLocked(const GameRoom& room);
    void PersistModOptionsLocked(const GameRoom& room);

    std::recursive_mutex mutex;
    std::unordered_map<uint32_t, GameRoom> rooms;
    uint32_t nextRoomId = 1;
    sqlite3* db = nullptr;
};
