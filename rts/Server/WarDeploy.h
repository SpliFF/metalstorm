// WarDeploy — "Deploy": which war should this player fight in?
//
// PLAN-metalstorm-lobby.md §6 / §4, task 7. The war browser (task 6) gives a
// player every fact about every war; Deploy is the one-click answer for the
// player who does not want to read a table. It is also where §6's two remaining
// balance levers live, because both of them are decisions about WHICH war:
//
//   * "a faction whose sides are full across all wars means new players queue
//     or trigger a new war to be seeded with a slot for them"
//   * "offer incentives to a player of the outnumbered faction in a given war —
//     pulling that faction's own waiting players toward the war that needs
//     them"
//
// ── Design call: there is no queue ──────────────────────────────────────────
// §6 offers "queue OR seed a new war" and this implements the second, with the
// first deliberately not built. A queue is a promise to seat somebody later, so
// it needs a durable list, a notification path, a fairness rule and an
// expiry — and every one of those is a surface that can strand a player
// silently. Seeding cannot: a war can always be created, so the answer to "your
// faction is full everywhere" is a new world with a seat in it, delivered now.
// The queue becomes worth building only if seeding is ever *rate-limited*
// (a server-capacity policy that does not exist), and that is the condition to
// revisit this under.
//
// ── NOT DONE: the incentive's AUTHORITY half ────────────────────────────────
// §6 names two incentives for the outnumbered faction — "bonus onboarding
// authority" and "a better starting region". Neither is here; only the routing
// is, and routing is the half §6 states the purpose of ("pulling that faction's
// own waiting players toward the war that needs them").
//
// The authority half is blocked on a real question rather than on effort. The
// grant is minted by `gadget:PlayerAdded` in synced Lua, and the only process
// that can compute the deficit without a SECOND copy of the formula is this
// one — but the server delivers that callin through `CLuaHandle::PlayerAdded`
// (PlayerOnboarding.cpp), whose signature is the engine's and carries a player
// number and nothing else. So the multiplier needs either a carrier into synced
// state or a second implementation in Lua that will drift from this one the
// first time either is touched — which is the exact failure mode this lane has
// now filed three times (D43/D13's cost-table-vs-ledger vocabularies being the
// most recent). That is a design call, not a mechanical follow-on.
//
// ── Design call: your own war wins outright, UNLESS it has no seat ──────────
// An account bound to a war (task 4) is DEPLOYED to that war whatever the
// ranking says. Deploy is a convenience for choosing a world, not a mechanism
// for abandoning one — a button that quietly moved a veteran off the front they
// have been holding since Tuesday, because a fresher war scored better, would
// be the single most hostile thing in the lobby.
//
// The one exception is PLAN-metalstorm-wars.md §5's own: "Rejoin is a special
// case: prefer the player's existing binding to a war; **if that side is now
// full, fall through to `findWar` for another war of the same faction**." A
// preference for a seat that does not exist is not a preference, it is a
// refusal — and it was the shape this file shipped with, because
// `ReturnToMyWar` was returned without ever consulting `DeployHasSeat`. The
// binding is not lost by falling through: it stays in the table, the seat is
// held against capacity for `WAR_SEAT_HOLD_SEC` by `WarRejoinPolicy`, and the
// veteran returns to it the moment somebody leaves. What falls through is only
// where Deploy sends them *right now*.
//
// What makes this safe is that the seat test DISCOUNTS the veteran's own seat
// when it is applied to the veteran's own war. `myBound` is a count of every
// binding on the side including theirs (lobby_main.cpp builds it that way, and
// the browser card needs it that way), so testing it raw would judge a side of
// "7 others + me, cap 8" as full and route the veteran away from a front they
// are already sitting on — the exact hostility the design call above exists to
// prevent, and a disagreement with the rest of the stack besides:
// `WarSlotReservation` short-circuits a bound account to `AlreadySeated`
// BEFORE it counts capacity, so the join they were diverted from would have
// succeeded.
//
// With the discount the fall-through fires only when the side holds `cap`
// OTHER bound players, i.e. when the war genuinely has no room for them. That
// is still reachable rather than dead: `WarSideMaintenance` can lower a cap
// below the side's already-seated population, and a veteran who was outside
// the new cap's first `cap` seats then has nowhere to sit.
//
// Pure function of values (the discipline of DynamicJoin.h / JoinPreview.h), so
// the whole policy is testable without a lobby, a database or a war.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

/// One war, as Deploy sees it. Everything here is already computed by the war
/// browser's own row (task 6), so Deploy ranks the same numbers the player is
/// looking at — a recommendation that disagrees with the visible table reads as
/// a bug even when it is right.
struct DeployCandidate {
    uint32_t roomId = 0;
    /// True when this war declares a side for the deploying account's faction.
    bool fieldsMyFaction = false;
    /// Humans holding a seat on my faction's side (durable bindings, not the
    /// live digest — an offline veteran's seat is taken).
    unsigned myBound = 0;
    /// That side's capacity, or `WAR_SIDE_CAPACITY_UNLIMITED` (0).
    unsigned myCapacity = 0;
    /// The largest bound population any OTHER side of this war holds. The
    /// underdog measure: my side is outnumbered by exactly
    /// `opposingBound - myBound`.
    unsigned opposingBound = 0;
    /// Humans connected right now, across all sides. Tie-break only — of two
    /// wars that need me equally, the one with people in it is the better game.
    unsigned liveHumans = 0;
    /// True when the account already holds a seat in this war.
    bool iAmBound = false;

    // ── §5's ranking inputs ────────────────────────────────────────────────
    //
    // PLAN-metalstorm-wars.md §5 states the order outright: "rank by:
    // friends-present > most-needed (incentivised) > highest-stakes >
    // freshest". The three fields below are the ones this file did not have;
    // `opposingBound` was already here and is what "most-needed" is measured
    // on.

    /// Mutual friends of the deploying account who hold a seat in this war —
    /// on ANY side, deliberately. §8 calls friends "the primary discovery path
    /// in a persistent world"; a friend on the other side is still the reason
    /// you turn up, and Metalstorm has no cross-faction moves for that to
    /// corrupt (you play your own faction wherever you go, metalstorm §2). A
    /// friends-on-my-side-only count would also quietly punish the mixed
    /// friend group the feature exists for.
    unsigned friendsPresent = 0;

    /// §5's "highest-stakes": authority currently staked on this war's
    /// unresolved objectives. The measure of how much is riding on the war,
    /// which is what makes one worth walking into over another — and it is
    /// authority already committed by players, not a number anybody tunes.
    /// Absent (0) for a war whose server is not running, which costs it a
    /// tie-break and nothing more.
    double stakes = 0.0;

    /// Unix time this war was created. §5's "freshest" — the last tie-break,
    /// and the one that makes the whole ranking deterministic.
    int64_t createdAt = 0;
};

enum class DeployOutcome : uint8_t {
    /// Join this war (`roomId`).
    JoinWar = 0,
    /// Return to the war this account already holds a seat in (`roomId`).
    ReturnToMyWar,
    /// Every war that fields this faction is full — seed a new one.
    SeedNewWar,
    /// This account has no faction, so no side can be chosen for it (§2.3).
    /// The lobby answers with the browser rather than a war: a factionless
    /// account can still spectate anything.
    NoFaction,
};

inline const char* DeployOutcomeToString(DeployOutcome o) {
    switch (o) {
        case DeployOutcome::JoinWar:       return "join";
        case DeployOutcome::ReturnToMyWar: return "return";
        case DeployOutcome::SeedNewWar:    return "seed";
        case DeployOutcome::NoFaction:     return "no_faction";
    }
    return "unknown";
}

struct DeployDecision {
    DeployOutcome outcome = DeployOutcome::SeedNewWar;
    uint32_t roomId = 0;
    /// How far my side is outnumbered in the chosen war, 0 when it is not.
    /// Surfaced so the lobby can say *why* it picked this one.
    unsigned underdogBy = 0;
    /// True when this account IS bound to a war but that war's side had no
    /// seat, so §5's fall-through ran. Surfaced rather than inferred, because
    /// "you were sent somewhere other than your own front, and here is why"
    /// is the single sentence that keeps the fall-through from reading as a
    /// bug to the veteran it happens to.
    bool rejoinFellThrough = false;
};

/// True when `c` has room for one more human on my faction's side.
///
/// `discountMyOwnSeat` is for the one caller that asks the question about a war
/// the account is ALREADY bound to: there, `myBound` includes the asker, and
/// the question being asked is "is there room for me" — which they already
/// have. Without it a full-but-mine side reads as seatless. See the design call
/// at the top of this file; the parameter is not defaulted precisely so that
/// every caller has to say which of the two questions it is asking.
inline bool DeployHasSeat(const DeployCandidate& c, bool discountMyOwnSeat) {
    if (!c.fieldsMyFaction)
        return false;
    // Capacity 0 is unlimited (WAR_SIDE_CAPACITY_UNLIMITED) — the same
    // permissive reading DecideDynamicJoin uses, and for the same reason: a war
    // that never sized its sides must not lock everyone out.
    if (c.myCapacity == 0)
        return true;
    const unsigned others =
        (discountMyOwnSeat && c.myBound > 0) ? c.myBound - 1 : c.myBound;
    return others < c.myCapacity;
}

/// Rank and choose.
///
/// PLAN-metalstorm-wars.md §5's ordering, in strict precedence:
///
///   0. **A war I am already bound to, IF it still has a seat.** Not part of
///      §5's rank list because it is not a ranking — it is an identity. See
///      the design call above, and its one exception: a bound war whose side
///      is full of OTHER players (my own seat discounted) falls through to the
///      ranking below rather than sending the player at a seat that does not
///      exist.
///   1. **friends-present** — §8's "people play where their friends are", and
///      the first key because discovery in a persistent world is social before
///      it is tactical. A war with a friend in it beats a war that needs you
///      more; you can always be needed tomorrow.
///   2. **most-needed** — how far my side is outnumbered. This is the whole
///      balance mechanism that survives "players cannot change faction": we
///      cannot move anyone, but we can decide which war the next volunteer
///      walks into, and sending them where the deficit is largest is the only
///      choice that reduces it.
///   3. **highest-stakes** — the authority riding on the war's unresolved
///      objectives. Of two wars that need you equally, the one being fought
///      over is the better game.
///   4. **freshest**, then lowest room id. Freshest rather than
///      longest-running because §4's demand seeding creates wars to absorb
///      exactly this traffic, and sending nobody to them would leave them
///      empty while the ranking pointed everyone at the incumbent. The room-id
///      tie-break is what makes the same lobby state always deploy the same
///      way, which the tests depend on and an operator reading two log lines
///      does too.
///
/// **`liveHumans` is deliberately no longer a key.** It ranked above nothing
/// §5 names and it fought key 4: a war with people in it is by construction
/// not the fresh one, so a live-population key made demand-seeded wars
/// unreachable — the case §4 builds them for. It stays on the struct because
/// the browser shows it.
///
/// An empty candidate list, or one where every side is full, is `SeedNewWar` —
/// never a refusal. See the no-queue design call above.
inline DeployDecision DecideDeploy(const std::string& factionId,
                                   const std::vector<DeployCandidate>& wars) {
    if (factionId.empty())
        return {DeployOutcome::NoFaction, 0, 0, false};

    // My own war first — but only if there is somewhere to sit in it (§5).
    const DeployCandidate* mine = nullptr;
    bool boundAnywhere = false;
    for (const auto& c : wars) {
        if (!c.iAmBound)
            continue;
        boundAnywhere = true;
        // My own seat is one of the `myBound` — discount it, or a side of
        // "7 others + me" at cap 8 reads as full and sends me away from it.
        if (!DeployHasSeat(c, /*discountMyOwnSeat=*/true))
            continue;
        // Lowest room id, so an account that somehow holds two bindings gets
        // a deterministic answer rather than a hash-order one.
        if (mine == nullptr || c.roomId < mine->roomId)
            mine = &c;
    }
    if (mine != nullptr) {
        return {DeployOutcome::ReturnToMyWar, mine->roomId,
                mine->opposingBound > mine->myBound
                    ? mine->opposingBound - mine->myBound
                    : 0u,
                false};
    }

    // Strict lexicographic order on §5's four keys. Written as an explicit
    // "is a better than b" rather than a chain of ||s on a single running
    // best, because the chain is what let the old version's tie-break compare
    // a candidate's second key against the incumbent's first.
    auto deficitOf = [](const DeployCandidate& c) {
        return c.opposingBound > c.myBound ? c.opposingBound - c.myBound : 0u;
    };
    auto better = [&](const DeployCandidate& a, const DeployCandidate& b) {
        if (a.friendsPresent != b.friendsPresent)
            return a.friendsPresent > b.friendsPresent;
        const unsigned da = deficitOf(a), db = deficitOf(b);
        if (da != db)
            return da > db;
        if (a.stakes != b.stakes)
            return a.stakes > b.stakes;
        if (a.createdAt != b.createdAt)
            return a.createdAt > b.createdAt;
        return a.roomId < b.roomId;
    };

    const DeployCandidate* best = nullptr;
    for (const auto& c : wars) {
        if (!DeployHasSeat(c, /*discountMyOwnSeat=*/false))
            continue;
        if (best == nullptr || better(c, *best))
            best = &c;
    }
    if (best == nullptr)
        return {DeployOutcome::SeedNewWar, 0, 0, boundAnywhere};
    return {DeployOutcome::JoinWar, best->roomId, deficitOf(*best),
            boundAnywhere};
}
