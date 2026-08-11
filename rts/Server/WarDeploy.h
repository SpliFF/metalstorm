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
// ── Design call: your own war wins outright ─────────────────────────────────
// An account bound to a war (task 4) is DEPLOYED to that war whatever the
// ranking says. Deploy is a convenience for choosing a world, not a mechanism
// for abandoning one — a button that quietly moved a veteran off the front they
// have been holding since Tuesday, because a fresher war scored better, would
// be the single most hostile thing in the lobby.
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
};

/// True when `c` has room for one more human on my faction's side.
inline bool DeployHasSeat(const DeployCandidate& c) {
    if (!c.fieldsMyFaction)
        return false;
    // Capacity 0 is unlimited (WAR_SIDE_CAPACITY_UNLIMITED) — the same
    // permissive reading DecideDynamicJoin uses, and for the same reason: a war
    // that never sized its sides must not lock everyone out.
    return c.myCapacity == 0 || c.myBound < c.myCapacity;
}

/// Rank and choose.
///
/// Ordering, in strict precedence:
///   1. A war I am already bound to (any of them; the lowest room id if the
///      account somehow holds two, so the answer is deterministic).
///   2. Of the wars with a free seat on my side: the one where my side is most
///      outnumbered — §6's incentive, expressed as routing. This is the whole
///      balance mechanism that survives "players cannot change faction": we
///      cannot move anyone, but we can decide which war the next volunteer
///      walks into, and sending them where the deficit is largest is the only
///      choice that reduces it.
///   3. Tie-break on live population (a war with people in it), then on the
///      lowest room id, so the same lobby state always deploys the same way.
///
/// An empty candidate list, or one where every side is full, is `SeedNewWar` —
/// never a refusal. See the no-queue design call above.
inline DeployDecision DecideDeploy(const std::string& factionId,
                                   const std::vector<DeployCandidate>& wars) {
    if (factionId.empty())
        return {DeployOutcome::NoFaction, 0, 0};

    const DeployCandidate* mine = nullptr;
    for (const auto& c : wars) {
        if (!c.iAmBound)
            continue;
        if (mine == nullptr || c.roomId < mine->roomId)
            mine = &c;
    }
    if (mine != nullptr) {
        return {DeployOutcome::ReturnToMyWar, mine->roomId,
                mine->opposingBound > mine->myBound
                    ? mine->opposingBound - mine->myBound
                    : 0u};
    }

    const DeployCandidate* best = nullptr;
    unsigned bestDeficit = 0;
    for (const auto& c : wars) {
        if (!DeployHasSeat(c))
            continue;
        const unsigned deficit =
            c.opposingBound > c.myBound ? c.opposingBound - c.myBound : 0u;
        if (best == nullptr || deficit > bestDeficit ||
            (deficit == bestDeficit &&
             (c.liveHumans > best->liveHumans ||
              (c.liveHumans == best->liveHumans && c.roomId < best->roomId)))) {
            best = &c;
            bestDeficit = deficit;
        }
    }
    if (best == nullptr)
        return {DeployOutcome::SeedNewWar, 0, 0};
    return {DeployOutcome::JoinWar, best->roomId, bestDeficit};
}
