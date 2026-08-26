// WorldOfflineChannels — worldsim phase 3 item 3: the offline notification
// channels behind the `WorldNotificationBus` seam W11 left.
//
// W11's header says it exactly: "a later milestone adds a second sink here —
// a Discord webhook, a web-push fan-out — without editing any of those three
// call sites." This file is that milestone. It adds:
//   * a **Discord webhook** channel: one JSON POST per event to a per-world
//     configured webhook URL, filtered to per-world enabled event kinds;
//   * a **Web Push** channel (RFC 8291/8292): per-account browser push
//     subscriptions stored world-scoped, each event encrypted per
//     subscription and POSTed to its endpoint with a VAPID Authorization
//     header. The crypto lives in WebPushCrypto.h; this file owns the
//     storage, the config and the request assembly.
//
// ── The threading rule this file exists to respect ─────────────────────────
// The lobby's HTTP server is SINGLE-THREADED — routes and the notification
// bus's Publish run on the NetworkServer thread (or the lobby sweep loop).
// An outbound webhook POST is seconds of wall time when the far end is slow,
// so NOTHING here performs network I/O on the caller's thread. The sink
// formats the event into `OutboundHttpPost` values (pure CPU + a couple of
// indexed reads) and hands them to `WorldOfflineDispatcher`, a bounded queue
// drained by one worker thread. A dead webhook therefore costs the bus
// exactly one enqueue, never a stall — and when the queue is full the post
// is DROPPED with a log line, because an offline notification is advisory
// and backpressure into the lobby loop is the one failure mode that is not
// acceptable.
//
// The worker thread deliberately touches NO database handle: the lobby's
// SQLite handles are opened NOMUTEX (THREADSAFE=2) and owned by the
// NetworkServer thread. Everything a send needs is read at enqueue time on
// the caller's thread and carried by value. (Consequence, accepted: a push
// endpoint answering 410 Gone is logged, not yet auto-pruned — pruning needs
// a thread-safe write path back into the store and is left as a seam.)
//
// ── Config (numbers are data) ──────────────────────────────────────────────
// Everything is per-world config under `notifications`:
//   "notifications": {
//     "discord": {"enabled": true, "webhookUrl": "https://…",
//                  "events": ["opened","materialised"]},   // empty/absent = all
//     "webPush": {"enabled": true, "vapidPublicKey": "…",
//                  "vapidPrivateKey": "…", "subject": "mailto:…",
//                  "ttlSeconds": 3600, "jwtTtlSeconds": 43200,
//                  "events": [...]}
//   }
// Missing keys fall back per-key (`FromWorldConfig`), same discipline as
// every other world-layer rules struct. Both channels default DISABLED — an
// unconfigured world sends nothing anywhere.
#pragma once

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <queue>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "WorldNotifications.h"

struct sqlite3;

// ─────────────────────────── per-world config ──────────────────────────────

struct WorldDiscordConfig {
    bool enabled = false;
    std::string webhookUrl;
    /// Kind strings (`WorldNotificationKindToString`). Empty = every kind.
    std::vector<std::string> events;
};

struct WorldWebPushConfig {
    bool enabled = false;
    std::string vapidPublicKey;   ///< base64url uncompressed P-256 point
    std::string vapidPrivateKey;  ///< base64url raw 32-byte scalar
    /// RFC 8292 `sub` claim — a mailto: or https: contact for the push
    /// service's operators. Required by spec; sends are skipped without it.
    std::string subject;
    /// Push service retention for an undeliverable message (the TTL header).
    int ttlSeconds = 3600;
    /// VAPID JWT lifetime. RFC 8292 caps `exp` at 24 h ahead; default 12 h.
    int jwtTtlSeconds = 12 * 3600;
    std::vector<std::string> events;  ///< same register as Discord's
};

struct WorldOfflineChannelRules {
    WorldDiscordConfig discord;
    WorldWebPushConfig webPush;

    static WorldOfflineChannelRules FromWorldConfig(const nlohmann::json& worldConfig);
};

/// Is `kind` in `events`? An empty list means "all kinds" — a config that
/// names no events has not narrowed anything (same "a partial config must not
/// disable the rules it omits" discipline the rest of the layer uses).
bool WorldChannelEventEnabled(const std::vector<std::string>& events,
                              WorldNotificationKind kind);

// ─────────────────────────── the subscription store ────────────────────────

/// One browser push subscription, world-scoped (hard boundary: `world_id`
/// keyed, never room-scoped). An account may hold several (one per browser).
struct WebPushSubscriptionRecord {
    std::string worldId;
    int64_t     accountId = 0;
    std::string endpoint;  ///< the push service URL, unique per subscription
    std::string p256dh;    ///< base64url uncompressed point (subscription key)
    std::string auth;      ///< base64url 16-byte auth secret
    int64_t     createdAt = 0;
};

class WebPushSubscriptions {
public:
    /// `world_push_subscriptions` if absent. ADDITIVE only, like every other
    /// table in this layer.
    static void EnsureTables(sqlite3* db);

    /// Insert-or-replace on (world, account, endpoint) — a browser
    /// re-subscribing rotates its keys, and the newest keys must win.
    static bool Upsert(sqlite3* db, const WebPushSubscriptionRecord& sub);

    static bool Remove(sqlite3* db, const std::string& worldId, int64_t accountId,
                       const std::string& endpoint);

    static std::vector<WebPushSubscriptionRecord> ListForAccount(
        sqlite3* db, const std::string& worldId, int64_t accountId);

    /// Every subscription belonging to any account in `accountIds` — the
    /// fan-out read the notification sink performs.
    static std::vector<WebPushSubscriptionRecord> ListForAccounts(
        sqlite3* db, const std::string& worldId,
        const std::vector<int64_t>& accountIds);
};

// ─────────────────────────── the outbound queue ────────────────────────────

/// One HTTP POST, fully assembled — everything the worker thread needs,
/// carried by value so the worker never touches a database or a config blob.
struct OutboundHttpPost {
    std::string url;
    std::vector<std::string> headers;  ///< "Name: value" lines
    std::vector<uint8_t> body;
    /// For the log line only ("discord poi-x", "webpush acct 12") — never
    /// parsed.
    std::string label;
};

/// The bounded queue + single worker thread between the bus and the network.
/// The `Sender` is injectable so spring-tests drive the whole dispatch path
/// against a fake HTTP sink; production passes `CurlSender()`.
class WorldOfflineDispatcher {
public:
    /// Returns the HTTP status, or a negative value on transport failure.
    using Sender = std::function<int(const OutboundHttpPost&)>;

    /// `maxQueue` is the drop threshold — a stuck far end must never grow an
    /// unbounded queue in the lobby process.
    explicit WorldOfflineDispatcher(Sender sender, size_t maxQueue = 256);
    ~WorldOfflineDispatcher();

    WorldOfflineDispatcher(const WorldOfflineDispatcher&) = delete;
    WorldOfflineDispatcher& operator=(const WorldOfflineDispatcher&) = delete;

    /// Never blocks beyond the queue mutex. Returns false when the post was
    /// dropped (queue full or dispatcher stopped) — callers may log, never
    /// retry.
    bool Enqueue(OutboundHttpPost post);

    /// Block until the queue is empty and the worker is idle. TESTS ONLY —
    /// production never waits on this thread.
    void DrainForTest();

    /// Posts dropped because the queue was full. Monotonic.
    uint64_t DroppedCount() const;

private:
    void WorkerLoop();

    Sender sender_;
    const size_t maxQueue_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::condition_variable idleCv_;
    std::queue<OutboundHttpPost> queue_;
    bool stopping_ = false;
    bool busy_ = false;
    uint64_t dropped_ = 0;
    std::thread worker_;
};

/// The production sender: libcurl, short timeouts, https only. Lives here so
/// lobby_main constructs the dispatcher in one line and tests never link a
/// network path by accident.
WorldOfflineDispatcher::Sender CurlSender();

// ─────────────────────────── request assembly ──────────────────────────────

/// The Discord webhook body for one event — pure, so its shape is testable
/// without any config. `content` carries the headline; an `embeds` entry
/// carries the structured fields.
nlohmann::json DiscordWebhookPayload(const WorldNotificationEvent& ev);

/// Full webhook POST, or nullopt when the channel is disabled, has no URL,
/// or the event kind is not enabled.
std::optional<OutboundHttpPost> BuildDiscordPost(const WorldDiscordConfig& cfg,
                                                 const WorldNotificationEvent& ev);

/// Full Web Push POST for ONE subscription, or nullopt when the channel is
/// disabled/misconfigured, the kind is not enabled, or the subscription's
/// keys are malformed. The payload is `WorldNotificationToJson(ev)`
/// encrypted per RFC 8291; headers carry TTL, aes128gcm and the VAPID
/// authorization. `nowUnixSeconds` anchors the JWT expiry.
std::optional<OutboundHttpPost> BuildWebPushPost(
    const WebPushSubscriptionRecord& sub, const WorldWebPushConfig& cfg,
    const WorldNotificationEvent& ev, int64_t nowUnixSeconds);
