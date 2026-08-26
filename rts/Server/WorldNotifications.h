// WorldNotifications — PLAN-worldsim.md W11: staging alerts.
//
// Design source: PLAN-worldsim.md's W11 line, read literally — "players with
// a commander/holding at the affected POI get lobby notifications when
// staging opens/closes". The affected set is therefore exactly three groups,
// unioned: the attacking faction's members (WorldFactions::MembersOf), the
// defending faction's members (the POI's `ownerFactionId`, same lookup), and
// every account with a commander garrisoned at the POI
// (WorldStats::CommandersAtPoi) — the more literal reading of "a holding",
// distinct from mere faction membership.
//
// ── What this file is, and what it deliberately is not ─────────────────────
// It is the world-layer's notification VOCABULARY (one event type, its JSON
// shape and its headline sentence), the pure recipient computation, and a
// tiny in-process pub/sub bus. It sends nothing itself — `rts/lobby_main.cpp`
// is the one place that owns an SSE channel, and it is the only subscriber
// today, delivering over the lobby's existing IDENTIFIED chat channel
// (`/api/chat/stream`) restricted to `WorldNotificationRecipients`. There is
// no in-game room SSE (see the plan's W2 note) — this reaches lobby browsers
// only, which the milestone says is fine for now.
//
// ── The seam PLAN-worldsim.md W11 asks for ──────────────────────────────────
// "Offline channels (Discord, web push) are a LATER milestone — leave a
// seam, not an integration." `WorldNotificationBus::Subscribe` IS that seam:
// every staging transition already funnels through one `Publish` call at
// each of its three detection sites (the commit route, the cancel route, the
// materialisation sweep in `lobby_main.cpp`), so a later milestone adds a
// second sink here — a Discord webhook, a web-push fan-out — without editing
// any of those three call sites.

#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

struct sqlite3;

/// The four transitions a staging row can announce. `Staging::Load`'s
/// terminal states (Materialised/Cancelled/Failed) map 1:1; `Opened` has no
/// row-state counterpart because it fires at Commit(), before the row's
/// state is ever anything but `Staging`.
enum class WorldNotificationKind : uint8_t {
    StagingOpened,
    StagingMaterialised,
    StagingCancelled,
    StagingFailed,
    /// The conquest rule fired: a POI changed hands at war end
    /// (WorldConquest.h). `attackerFactionId` is the NEW owner,
    /// `defenderFactionId` the previous one — the same attacker/defender
    /// reading every staging event already uses, so the recipient union
    /// (both factions' members + the garrison) applies unchanged.
    PoiOwnershipChanged,
};

const char* WorldNotificationKindToString(WorldNotificationKind k);

/// The SSE event name one kind is delivered under: staging transitions keep
/// W11's `world-staging`; an ownership change is `world-poi`. Decided here so
/// the sink in lobby_main.cpp does not grow a switch of its own.
const char* WorldNotificationSseEvent(WorldNotificationKind k);

/// One staging transition, as data. Deliberately carries both faction ids
/// rather than a POI id alone — the recipient computation and the client's
/// rendering both want "who is attacking" and "who is defending" without a
/// second lookup, and the defender may be empty (an unheld POI has no
/// defending faction, only whichever commanders happen to be standing there).
struct WorldNotificationEvent {
    std::string worldId;
    std::string poiId;
    std::string poiName;
    WorldNotificationKind kind = WorldNotificationKind::StagingOpened;
    std::string attackerFactionId;
    std::string defenderFactionId;
    int64_t     stagingId = 0;
    /// The winning claim, for `PoiOwnershipChanged` events; 0 otherwise.
    int64_t     claimId = 0;
    /// The WORLD clock reading the event fired at — a march is measured on
    /// the world clock, so this is the same unit every other world-layer
    /// timestamp uses, not a wall-clock stamp.
    int64_t     worldMs = 0;
    /// Empty unless a caller wants to override `WorldNotificationToJson`'s
    /// default sentence (`WorldNotificationHeadline`). No caller does today;
    /// the field exists so a later milestone can localise or personalise a
    /// headline without changing this struct's shape.
    std::string headline;
};

/// The sentence a toast or a notification-list row shows verbatim — built
/// once, here, so the toast and the list never disagree about what happened,
/// the same discipline `warevents::Headline` set for war-state events.
std::string WorldNotificationHeadline(WorldNotificationKind kind,
                                      const std::string& poiName);

/// The wire shape delivered over SSE (event name `world-staging`) and read by
/// `client/src/lobby/world-notifications.ts`'s `parseWorldStagingEvent`.
nlohmann::json WorldNotificationToJson(const WorldNotificationEvent& ev);

/// Every account this event is this player's business for, deduplicated: the
/// attacking faction's members, the defending faction's members (when the POI
/// has an owner), and every account with a commander garrisoned at the POI.
/// An account that qualifies more than one way still appears once — the
/// caller addresses accounts, not roles, so a second reason to notify someone
/// must never become a second copy of the same toast.
///
/// Either faction id may be empty (an unowned POI has no defender; nothing in
/// this layer forbids a factionless committer either, though the staging
/// route never produces one) — an empty id simply contributes nothing.
std::vector<int64_t> WorldNotificationRecipients(sqlite3* db,
                                                  const std::string& worldId,
                                                  const std::string& attackerFactionId,
                                                  const std::string& defenderFactionId,
                                                  const std::string& poiId);

/// The seam. Everything above this line detects and describes a staging
/// transition; everything below decides what happens with one. Exactly one
/// sink is subscribed today (`lobby_main.cpp`'s SSE push); a later milestone
/// adds another without touching a `Publish` call site.
class WorldNotificationBus {
public:
    using Sink = std::function<void(const WorldNotificationEvent&)>;

    void Subscribe(Sink sink) { sinks_.push_back(std::move(sink)); }

    /// Fires every subscribed sink, in subscription order. Every subscription
    /// in this program happens once, at lobby startup, before the network
    /// loop begins — this is not guarded against a concurrent Subscribe.
    void Publish(const WorldNotificationEvent& ev) const {
        for (const auto& sink : sinks_) sink(ev);
    }

private:
    std::vector<Sink> sinks_;
};
