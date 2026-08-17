// WarPlayerBindings — the durable account↔war record: which side an account
// holds in a persistent war, and the per-player war state that has to survive
// the account leaving (and the game server exiting).
//
// PLAN-metalstorm-lobby.md §5.1 ("player→side bindings + per-player war state
// (authority pool, participation credit, org groups)" is named there as state
// the LOBBY/WORLD layer owns, not the sim) and §2.5 (leave → rejoin
// continuity). Task 4.
//
// ── Why a table and not the sim ────────────────────────────────────────────
// A war's sim state lives in the running game server and dies with it: task 3
// made a war outlive the lobby, but a resumed war still restarts its sim at
// frame 0 (nothing snapshots the world — PLAN-persistence owns that, creg is
// stubbed out). So every fact about a player that is supposed to outlast a
// session has to be somewhere else, and the shared SQLite db is the only
// backchannel the two processes have.
//
// ── Who writes it ──────────────────────────────────────────────────────────
// The GAME server writes: it is the process that seats a player (task 2's
// AuthRequest promotion) and the only one that can read the sim for the state
// capture. The LOBBY reads (and deletes, on the audited faction override —
// task 0's route left that clause as a documented no-op precisely because this
// table did not exist yet). Both hold their own handle on the same file; every
// write here is a single statement, so it needs no transaction of its own.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

struct sqlite3;

/// The per-player war state the world layer persists. Deliberately a value
/// type with no db or sim in it: the capture side fills it from rules params,
/// the store writes it, and the restore side hands it back — none of the three
/// needs to know about the other two.
struct WarPlayerState {
    /// `authority_player_<playerNum>`, the player's own pool (§1 of
    /// PLAN-metalstorm-economy). Captured BEFORE PlayerRemoved merges it into
    /// the team pool, or the saved value is always zero.
    double authorityPool = 0.0;
    /// Participation credit — `score_<playerNum>_{earned,spent,objectives}`.
    /// Lifetime counters, not resources: they are restored on every rejoin
    /// regardless of how long the absence was.
    double scoreEarned = 0.0;
    double scoreSpent = 0.0;
    int    objectives = 0;
};

struct WarPlayerBinding {
    uint32_t    roomId = 0;
    int64_t     accountId = 0;
    std::string username;
    std::string factionId;
    /// The team this account holds in this war. Derived from the faction at
    /// bind time; the faction stays the authority if the war's sides are
    /// re-authored (WarRejoinPolicy.h).
    int         team = -1;
    int64_t     firstSeenAt = 0;
    int64_t     lastSeenAt = 0;
    WarPlayerState state;
    /// Unix time of the last state capture, or 0 if none ever ran. Kept
    /// separate from a `state` sentinel because a player can legitimately
    /// leave with an empty pool and a zero score, and that must not read as
    /// "never saved" (WarRejoinPolicy's `hasSavedState`).
    int64_t     stateSavedAt = 0;

    bool HasSavedState() const { return stateSavedAt > 0; }
};

class WarPlayerBindings {
public:
    /// Create the table if absent, at the current schema version. Same
    /// probe-and-recreate pattern as RoomManager::EnsureTables /
    /// GameServersDb::EnsureTables — call before any read or write. Safe to
    /// call from either process and from both.
    static void EnsureTable(sqlite3* db);

    /// Bind (or re-bind) an account to a side in a war, stamping `last_seen_at`.
    /// Idempotent: re-seating the same account on the same team only moves the
    /// timestamp. Never touches the saved state columns — a rebind must not
    /// erase the pool the player is about to have restored.
    static bool BindSeat(sqlite3* db, uint32_t roomId, int64_t accountId,
                         const std::string& username, const std::string& factionId,
                         int team, int64_t now);

    /// Save the per-player war state for an existing binding, stamping
    /// `state_saved_at` and `last_seen_at`. A no-op (returns false) when no
    /// binding exists: state without a seat is not a thing this table models,
    /// and inventing a row here would create a binding for a spectator.
    static bool SaveState(sqlite3* db, uint32_t roomId, int64_t accountId,
                          const WarPlayerState& state, int64_t now);

    /// Read one binding, or nullopt.
    static std::optional<WarPlayerBinding> Find(sqlite3* db, uint32_t roomId,
                                                int64_t accountId);

    /// Every binding in a war, oldest first. The war browser's per-side
    /// population and the "my wars" filter (task 6) read this.
    static std::vector<WarPlayerBinding> ForRoom(sqlite3* db, uint32_t roomId);

    /// Every binding an account holds, in every war, newest contact first.
    ///
    /// Task 9a's presence read: `last_seen_at` is re-stamped by the game
    /// server when it seats a player and again on its 60 s state sweep, so the
    /// newest row is the strongest statement in the system about where an
    /// account actually is. Ordered here rather than at the call site because
    /// "which war is this player in" has exactly one right answer and it is
    /// this ordering — a caller sorting it a second way is a caller that can
    /// disagree with the friends list.
    static std::vector<WarPlayerBinding> ForAccount(sqlite3* db, int64_t accountId);

    /// Re-stamp the denormalised `username` on every binding an account
    /// holds (task 8c).
    ///
    /// The column is a copy of `users.username`, kept for operator reads and
    /// log lines — every functional reader keys on `account_id`, which is why
    /// this is not a correctness fix today. It exists because until the guest
    /// upgrade there was no path in the system that renamed an account, so
    /// the copy could never go stale and nothing had to maintain it. Now one
    /// does, and a table whose name column silently disagrees with `users`
    /// is exactly the sort of thing the next reader trusts.
    ///
    /// Returns rows updated.
    static int RenameAccount(sqlite3* db, int64_t accountId,
                             const std::string& username);

    /// Drop every binding an account holds, in every war. The audited faction
    /// override (`POST /api/admin/set-faction`) calls this: §1b says changing
    /// a faction "clears the account's per-war bindings", and task 0 recorded
    /// that clause as a no-op only because this table did not exist. Returns
    /// rows deleted.
    static int DeleteForAccount(sqlite3* db, int64_t accountId);

    /// Drop every binding in a war. Called when the room itself is deleted —
    /// bindings to a war that no longer exists are unreachable by every read
    /// path above and would otherwise accumulate for the life of the db.
    static int DeleteForRoom(sqlite3* db, uint32_t roomId);
};
