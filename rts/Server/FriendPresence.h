// FriendPresence — where a player IS, and what "join them" can mean.
//
// PLAN-metalstorm-lobby.md §8, task 9a: "Show friends' presence + current
// war/side in the browser; one-click 'join their side' (subject to balance
// caps, §6)."
//
// Two pure decisions and one tiny in-memory tracker. Pure in the shape this
// lane keeps using (DynamicJoin.h, GameStartCoordinator.h, WarDeploy.h): the
// policy is a function of values, so the whole of it is testable without a
// server, a database or a socket, and the route is left with nothing but the
// gathering of facts.
//
// ── 1. Presence has exactly three observable sources, and no heartbeat ─────
// The lobby is not told when a player is "online". It can only observe:
//
//   * `war_player_bindings.last_seen_at` — re-stamped by the GAME server when
//     it seats a player and again on its 60 s state sweep (task 4). A fresh
//     stamp is the strongest presence fact in the system: it means a sim
//     currently has this account on a side.
//   * room membership — the lobby's own in-memory registry, so a player
//     standing in a set-up screen is visible without asking anybody.
//   * HTTP activity — every authenticated request passes one funnel
//     (`SetRouteAuthCallbacks().validateToken` in lobby_main), which is where
//     PresenceTracker below is stamped.
//
// Deliberately NOT added: a client-side presence ping, or a `last_seen` column
// on `sessions` stamped per request. The first is a new client obligation for
// a field nothing else needs; the second is a database write on every
// authenticated request to learn something a process-local map already knows.
// The cost of the in-memory choice is stated rather than hidden: **a lobby
// restart shows every friend as offline until they next touch the API.** That
// is the honest answer — a presence table that survives a restart is
// describing people who are not there.
//
// The `Fighting` state outranks the other two on purpose: a player in a war is
// also making HTTP requests, and "online" is the less useful of the two true
// answers.
//
// ── 2. "Join their side" is usually not their side, and that is §8 vs §1b ──
// §8 asks for one-click "join their side". §1b makes a faction permanent and
// §2.3 makes the side follow the faction — so if your friend fights for the
// other faction, joining "their side" is the one thing the whole design
// forbids. The verb that actually exists is **join their WAR, on my faction's
// side**, and the two cases are different enough that the UI must not conflate
// them: seating somebody alongside their friend and seating them opposite
// their friend are both correct outcomes of the same click.
//
// So DecideFriendJoin names them separately (`SameSide` / `OpposingSide`)
// rather than returning one `ok`. A button that quietly put a player on the
// enemy side of their friend's war would be the most confusing control in the
// lobby, and it is the default behaviour if this distinction is not carried.
#pragma once

#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>

#include "WarSides.h"

// ── Presence ───────────────────────────────────────────────────────────────

/// How stale a war binding's `last_seen_at` may be and still mean "fighting".
///
/// The game server re-stamps it on its 60 s state sweep (task 4), so this is
/// two missed sweeps — the same shape of reasoning as kWarSummaryStaleSec, and
/// for the same reason: a loaded machine must not blink a player out of the
/// war they are standing in, while a player who left an hour ago must not
/// still be shown in it.
inline constexpr int64_t kWarPresenceFreshSec = 150;

/// How long after their last authenticated request an account is still
/// "online in the lobby". The client's own renewal timer and room polling
/// touch the API well inside this, and it is short enough that a closed
/// browser drops off within a couple of minutes.
inline constexpr int64_t kLobbyPresenceFreshSec = 120;

enum class PresenceState {
    Offline,   ///< nothing has heard from this account recently
    Online,    ///< authenticated HTTP activity, but in no room and no war
    Staging,   ///< a member of a lobby room (skirmish set-up, or a war's room)
    Fighting,  ///< a war's sim currently holds this account on a side
};

inline const char* PresenceStateToString(PresenceState s) {
    switch (s) {
        case PresenceState::Fighting: return "fighting";
        case PresenceState::Staging:  return "staging";
        case PresenceState::Online:   return "online";
        case PresenceState::Offline:  break;
    }
    return "offline";
}

/// Everything the three sources above can say about one account. A value
/// type: the route fills it, DecidePresence reads it, neither knows where the
/// other's data comes from.
struct PresenceFacts {
    /// Newest `war_player_bindings.last_seen_at` across every war, and the war
    /// it came from. `warRoomId == 0` means no binding at all.
    uint32_t warRoomId = 0;
    int      warTeam = -1;
    int64_t  warLastSeen = 0;
    /// A lobby room the account is a member of right now (0 = none).
    uint32_t roomId = 0;
    /// Last authenticated HTTP request, from PresenceTracker (0 = never).
    int64_t  lobbyLastSeen = 0;
};

/// The one presence rule. Ordered strongest-fact-first.
inline PresenceState DecidePresence(const PresenceFacts& f, int64_t now) {
    if (f.warRoomId != 0 && f.warLastSeen > 0 &&
        now - f.warLastSeen <= kWarPresenceFreshSec)
        return PresenceState::Fighting;
    if (f.roomId != 0)
        return PresenceState::Staging;
    if (f.lobbyLastSeen > 0 && now - f.lobbyLastSeen <= kLobbyPresenceFreshSec)
        return PresenceState::Online;
    return PresenceState::Offline;
}

/// Process-local "when did this account last authenticate". Stamped from the
/// single route-auth funnel; read by the friends list.
///
/// Not a database table — see the header block. Bounded by the number of
/// accounts that have made a request since the last prune, and pruned on
/// write rather than on a timer so it needs no thread of its own.
class PresenceTracker {
public:
    void Touch(int64_t accountId, int64_t now) {
        if (accountId <= 0) return;
        std::lock_guard<std::mutex> lock(mutex_);
        seen_[accountId] = now;
        // Amortised prune: an entry older than the freshness window can never
        // change an answer again, so keeping it only costs memory in a process
        // that stays up for weeks.
        if (seen_.size() > kPruneAt && now != lastPrune_) {
            lastPrune_ = now;
            for (auto it = seen_.begin(); it != seen_.end();) {
                if (now - it->second > kLobbyPresenceFreshSec) it = seen_.erase(it);
                else ++it;
            }
        }
    }

    int64_t LastSeen(int64_t accountId) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = seen_.find(accountId);
        return it == seen_.end() ? 0 : it->second;
    }

private:
    static constexpr size_t kPruneAt = 512;
    mutable std::mutex mutex_;
    std::unordered_map<int64_t, int64_t> seen_;
    int64_t lastPrune_ = 0;
};

// ── "Join my friend" ───────────────────────────────────────────────────────

enum class FriendJoinOutcome {
    /// The caller has no faction (a dev/manifest account, or a guest who never
    /// chose one). Task 2 seats those as spectators, and that is what they get
    /// here too — stated rather than reported as an error.
    NoFaction,
    /// The friend is not in a war right now, so there is nothing to join.
    NotInAWar,
    /// The war fields no side for the caller's faction. §1a is explicit that
    /// drop-in requires the player's faction to be a participating side, and
    /// there is no reassignment — so this war is closed to this account no
    /// matter how many seats are free.
    FactionAbsent,
    /// The caller's faction fields a side and it is full (§6's capacity).
    SideFull,
    /// Joinable, on the same side as the friend — §8's "join their side",
    /// which only happens when the two share a faction.
    SameSide,
    /// Joinable, on the OPPOSING side. The common case for cross-faction
    /// friends and the reason this enum has five members instead of an `ok`
    /// boolean: the click succeeds and the player must be told they will be
    /// fighting their friend, not beside them.
    OpposingSide,
};

inline const char* FriendJoinOutcomeToString(FriendJoinOutcome o) {
    switch (o) {
        case FriendJoinOutcome::NoFaction:     return "no_faction";
        case FriendJoinOutcome::NotInAWar:     return "not_in_a_war";
        case FriendJoinOutcome::FactionAbsent: return "faction_absent";
        case FriendJoinOutcome::SideFull:      return "side_full";
        case FriendJoinOutcome::SameSide:      return "same_side";
        case FriendJoinOutcome::OpposingSide:  break;
    }
    return "opposing_side";
}

inline bool FriendJoinSeats(FriendJoinOutcome o) {
    return o == FriendJoinOutcome::SameSide || o == FriendJoinOutcome::OpposingSide;
}

struct FriendJoinFacts {
    /// The caller's permanent faction, empty when they have none.
    std::string myFaction;
    /// Is the friend currently in a war (PresenceState::Fighting)?
    bool friendInWar = false;
    /// The team the friend holds there.
    int  friendTeam = -1;
    /// The war's declared sides, and the caller's side's capacity/occupancy.
    WarSides sides;
    unsigned myCapacity = 0;   ///< WAR_SIDE_CAPACITY_UNLIMITED (0) = no limit
    unsigned myBound = 0;      ///< seats already held on the caller's side
    /// True when the caller already holds a seat on that side. A player who is
    /// already bound is never refused their own seat — the same carve-out
    /// task 2's occupancy count makes for a reload whose old transport has not
    /// been reaped.
    bool iAmBound = false;
};

struct FriendJoinDecision {
    FriendJoinOutcome outcome = FriendJoinOutcome::NotInAWar;
    /// The team the caller would take, when the outcome seats them.
    int myTeam = -1;
};

/// The one rule. Pure.
inline FriendJoinDecision DecideFriendJoin(const FriendJoinFacts& f) {
    FriendJoinDecision d;
    if (f.myFaction.empty()) { d.outcome = FriendJoinOutcome::NoFaction; return d; }
    if (!f.friendInWar)      { d.outcome = FriendJoinOutcome::NotInAWar; return d; }

    const auto team = TeamForFactionIn(f.sides, f.myFaction);
    if (!team) { d.outcome = FriendJoinOutcome::FactionAbsent; return d; }
    d.myTeam = static_cast<int>(*team);

    // Capacity is checked BEFORE the same/opposing question, because a full
    // side is equally closed either way — and answering "same side!" about a
    // seat that does not exist is the promise the game server then breaks
    // (the trap task 6 documents for the browser's `open` field).
    if (!f.iAmBound && f.myCapacity != WAR_SIDE_CAPACITY_UNLIMITED &&
        f.myBound >= f.myCapacity) {
        d.outcome = FriendJoinOutcome::SideFull;
        return d;
    }
    d.outcome = (d.myTeam == f.friendTeam) ? FriendJoinOutcome::SameSide
                                           : FriendJoinOutcome::OpposingSide;
    return d;
}
