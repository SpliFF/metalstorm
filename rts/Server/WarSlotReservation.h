// WarSlotReservation — the last seat on a side, handed to exactly one person.
//
// PLAN-metalstorm-wars.md §4 ("atomic slot reservation") and task 2; it is the
// resolution of the race PLAN-metalstorm-lobby.md §2.3/§9.1 names and does not
// solve: two players reading "1 seat free" in the same instant both being told
// to go there, and the second one arriving to a full side after the lobby has
// already promised them a war.
//
// ── Why a table and not a mutex ────────────────────────────────────────────
// §4 says "`slotsUsed++` under a per-war lock", and a per-war lock in the
// lobby process would be the obvious reading. It is the wrong one here for two
// reasons this tree has already been bitten by:
//
//   * the seat is not counted in this process. A war's population is
//     `war_player_bindings`, and the process that WRITES it is the game server
//     (WarPlayerBindings.h's "who writes it"). A lock held in the lobby
//     protects the lobby's own arithmetic against the lobby, and not against
//     the seating that actually happens.
//   * the lobby restarts. `restart_lobby` re-execs in place and a war outlives
//     it (task 3); an in-memory reservation would release every outstanding
//     join the moment the lobby was rebuilt, which is the same last-slot race
//     with a slower fuse.
//
// So the lock is SQLite's: one `BEGIN IMMEDIATE` transaction that re-counts
// bound seats and live reservations against the side's `slot_cap` and inserts
// the reservation, all inside the write lock. Two concurrent `Reserve` calls
// for the last seat serialise; the second one re-counts and sees the first
// one's row. That is the whole mechanism, and it works between processes and
// across a restart because the state is on disk.
//
// ── Why the reservation expires ────────────────────────────────────────────
// A reservation is taken BEFORE the join token is handed out (§4), which means
// it is taken before anything can confirm the player will ever use it — they
// close the tab, the connection drops, the client crashes on load. Without a
// TTL the seat would be held by nobody until the war ended. With one, an
// abandoned join costs the side its last seat for `WAR_SLOT_RESERVATION_TTL_
// SECONDS` and no longer: expiry is evaluated at READ time (`expires_at > now`
// in every count), so a stale row is already not holding a seat before any
// sweep runs. `ReleaseExpired` is hygiene for the table's size, not for its
// correctness — a sweep that never runs cannot lock anybody out.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

struct sqlite3;

/// How long a reservation holds a seat for a join that has not completed.
///
/// Two minutes is sized from the thing it has to cover: mint a token, load the
/// client, connect to the game server and be seated — a cold client on a slow
/// link. Too short strands a legitimate joiner (their seat is gone by the time
/// they arrive, and they are the one player who was told it was theirs); too
/// long makes an abandoned join look like a full war to everyone else.
inline constexpr int WAR_SLOT_RESERVATION_TTL_SECONDS = 120;

struct WarSlotReservation {
    uint32_t    roomId = 0;
    std::string factionId;
    int64_t     accountId = 0;
    int64_t     reservedAt = 0;
    int64_t     expiresAt = 0;
};

enum class SlotReserveOutcome : uint8_t {
    /// A seat was taken for this account. The caller may hand out the join
    /// token.
    Granted = 0,
    /// This account already held a live reservation on this side; its expiry
    /// was pushed out. Distinguished from `Granted` so a client that retries
    /// (a double-clicked Deploy button) is not reported as two joiners.
    Renewed,
    /// This account already holds a durable seat in this war
    /// (`war_player_bindings`). No reservation is needed or taken — a rejoin
    /// is not a new seat, and reserving one would count the player twice
    /// against their own side's cap.
    AlreadySeated,
    /// Bound seats plus live reservations already fill the side's `slot_cap`.
    /// This is the loser of the race, and the honest answer to it is another
    /// war (Deploy re-ranks) rather than a queue.
    SideFull,
    /// This war declares no side for that faction — nothing to reserve.
    NoSuchSide,
    /// The write failed (no db, missing tables, a locked file past the busy
    /// timeout). Fail closed: never report a seat that was not written.
    Error,
};

inline const char* SlotReserveOutcomeToString(SlotReserveOutcome o) {
    switch (o) {
        case SlotReserveOutcome::Granted:       return "granted";
        case SlotReserveOutcome::Renewed:       return "renewed";
        case SlotReserveOutcome::AlreadySeated: return "already_seated";
        case SlotReserveOutcome::SideFull:      return "side_full";
        case SlotReserveOutcome::NoSuchSide:    return "no_such_side";
        case SlotReserveOutcome::Error:         return "error";
    }
    return "error";
}

struct SlotReserveResult {
    SlotReserveOutcome outcome = SlotReserveOutcome::Error;
    /// When the held seat lapses (0 when nothing is held).
    int64_t  expiresAt = 0;
    /// The numbers the decision was made on, so the caller can say *why*
    /// without re-querying and disagreeing with the transaction that decided.
    unsigned slotCap = 0;
    unsigned bound = 0;
    unsigned reserved = 0;

    /// May this account be handed a join token?
    bool MayJoin() const {
        return outcome == SlotReserveOutcome::Granted ||
               outcome == SlotReserveOutcome::Renewed ||
               outcome == SlotReserveOutcome::AlreadySeated;
    }
};

/// The reservation table. Static, like `WarPlayerBindings` and `WarDirector`:
/// there is no per-instance state, and every process that touches it holds its
/// own handle on the same file.
class WarSlotReservations {
public:
    /// Create the table if absent, and set a busy timeout on this handle.
    ///
    /// The timeout is not incidental — it is half the mechanism. `BEGIN
    /// IMMEDIATE` on a file another connection is already writing returns
    /// SQLITE_BUSY *immediately* without one, so N concurrent joins would
    /// produce one winner and N-1 `Error`s rather than one winner and N-1
    /// `SideFull`s. The second of those is the true answer; the first is a
    /// transport failure wearing its clothes.
    static void EnsureTable(sqlite3* db);

    /// Take (or renew) a seat on `factionId`'s side of war `roomId`, if the
    /// side has one free. One transaction, `BEGIN IMMEDIATE`, re-counting
    /// inside the write lock — see the header.
    ///
    /// A `slot_cap` of 0 is UNLIMITED (`WAR_SIDE_CAPACITY_UNLIMITED`), the
    /// same permissive reading `DeployHasSeat` and `DecideDynamicJoin` use: a
    /// war whose sides were never sized must not lock everyone out.
    static SlotReserveResult Reserve(sqlite3* db, uint32_t roomId,
                                     const std::string& factionId,
                                     int64_t accountId, int64_t now,
                                     int ttlSeconds =
                                         WAR_SLOT_RESERVATION_TTL_SECONDS);

    /// Give the seat back. Called on a completed join (the durable binding now
    /// holds the seat, and leaving the reservation would count the player
    /// twice) and on an explicit cancel. Returns false when there was nothing
    /// to release, which is not an error — a reservation may already have
    /// lapsed.
    static bool Release(sqlite3* db, uint32_t roomId, int64_t accountId);

    /// Drop every lapsed row. Hygiene only: expiry is enforced at read time,
    /// so this changes no answer. Returns rows deleted.
    static int ReleaseExpired(sqlite3* db, int64_t now);

    /// Live (unexpired) reservations held on one side.
    static unsigned LiveCount(sqlite3* db, uint32_t roomId,
                              const std::string& factionId, int64_t now);

    static std::optional<WarSlotReservation> Find(sqlite3* db, uint32_t roomId,
                                                  int64_t accountId);

    /// Every live reservation in a war, oldest first.
    static std::vector<WarSlotReservation> ForRoom(sqlite3* db, uint32_t roomId,
                                                   int64_t now);

    /// Drop every reservation in a war. For room deletion — rows pointing at a
    /// war that no longer exists are unreachable and would accumulate.
    static int DeleteForRoom(sqlite3* db, uint32_t roomId);
};
