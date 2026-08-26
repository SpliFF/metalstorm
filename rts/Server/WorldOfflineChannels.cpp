#include "WorldOfflineChannels.h"

#include <sqlite3.h>

#include <algorithm>
#include <mutex>

#include <curl/curl.h>

#include "SqliteThreading.h"
#include "System/SpringLog/SpringLog.h"
#include "WebPushCrypto.h"

#define LOG_SECTION "server"

// ─────────────────────────── per-world config ──────────────────────────────

namespace {

bool CfgBool(const nlohmann::json& j, const char* key, bool fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_boolean()) return fallback;
    return it->get<bool>();
}

std::string CfgString(const nlohmann::json& j, const char* key,
                      const std::string& fallback = {}) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_string()) return fallback;
    return it->get<std::string>();
}

int CfgInt(const nlohmann::json& j, const char* key, int fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return it->get<int>();
}

std::vector<std::string> CfgStringList(const nlohmann::json& j, const char* key) {
    std::vector<std::string> out;
    if (!j.is_object()) return out;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_array()) return out;
    for (const auto& v : *it)
        if (v.is_string()) out.push_back(v.get<std::string>());
    return out;
}

void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

std::string ColText(sqlite3_stmt* s, int idx) {
    if (const unsigned char* u = sqlite3_column_text(s, idx))
        return reinterpret_cast<const char*>(u);
    return {};
}

}  // namespace

WorldOfflineChannelRules WorldOfflineChannelRules::FromWorldConfig(
    const nlohmann::json& worldConfig) {
    WorldOfflineChannelRules r;
    const nlohmann::json notif =
        worldConfig.is_object() && worldConfig.contains("notifications")
            ? worldConfig["notifications"]
            : nlohmann::json();
    const nlohmann::json discord =
        notif.is_object() && notif.contains("discord") ? notif["discord"]
                                                        : nlohmann::json();
    r.discord.enabled = CfgBool(discord, "enabled", r.discord.enabled);
    r.discord.webhookUrl = CfgString(discord, "webhookUrl");
    r.discord.events = CfgStringList(discord, "events");

    const nlohmann::json push =
        notif.is_object() && notif.contains("webPush") ? notif["webPush"]
                                                        : nlohmann::json();
    r.webPush.enabled = CfgBool(push, "enabled", r.webPush.enabled);
    r.webPush.vapidPublicKey = CfgString(push, "vapidPublicKey");
    r.webPush.vapidPrivateKey = CfgString(push, "vapidPrivateKey");
    r.webPush.subject = CfgString(push, "subject");
    r.webPush.ttlSeconds = CfgInt(push, "ttlSeconds", r.webPush.ttlSeconds);
    r.webPush.jwtTtlSeconds = CfgInt(push, "jwtTtlSeconds", r.webPush.jwtTtlSeconds);
    r.webPush.events = CfgStringList(push, "events");
    return r;
}

bool WorldChannelEventEnabled(const std::vector<std::string>& events,
                              WorldNotificationKind kind) {
    if (events.empty()) return true;
    const char* name = WorldNotificationKindToString(kind);
    return std::find(events.begin(), events.end(), name) != events.end();
}

// ─────────────────────────── the subscription store ────────────────────────

void WebPushSubscriptions::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_push_subscriptions ("
        "  world_id TEXT NOT NULL,"
        "  account_id INTEGER NOT NULL,"
        "  endpoint TEXT NOT NULL,"
        "  p256dh TEXT NOT NULL,"
        "  auth TEXT NOT NULL,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  UNIQUE(world_id, account_id, endpoint)"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_push_subs_account "
        "ON world_push_subscriptions(world_id, account_id)",
        nullptr, nullptr, nullptr);
}

bool WebPushSubscriptions::Upsert(sqlite3* db, const WebPushSubscriptionRecord& sub) {
    if (!db || sub.worldId.empty() || sub.accountId <= 0 || sub.endpoint.empty() ||
        sub.p256dh.empty() || sub.auth.empty())
        return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WebPushSubscribe", [&] {
        static const char* kSql =
            "INSERT INTO world_push_subscriptions "
            "(world_id, account_id, endpoint, p256dh, auth, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(world_id, account_id, endpoint) "
            "DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, sub.worldId);
        sqlite3_bind_int64(stmt, 2, sub.accountId);
        BindText(stmt, 3, sub.endpoint);
        BindText(stmt, 4, sub.p256dh);
        BindText(stmt, 5, sub.auth);
        sqlite3_bind_int64(stmt, 6, sub.createdAt);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

bool WebPushSubscriptions::Remove(sqlite3* db, const std::string& worldId,
                                  int64_t accountId, const std::string& endpoint) {
    if (!db) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WebPushUnsubscribe", [&] {
        static const char* kSql =
            "DELETE FROM world_push_subscriptions "
            "WHERE world_id=? AND account_id=? AND endpoint=?";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, worldId);
        sqlite3_bind_int64(stmt, 2, accountId);
        BindText(stmt, 3, endpoint);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

namespace {

WebPushSubscriptionRecord ReadSubRow(sqlite3_stmt* stmt) {
    WebPushSubscriptionRecord s;
    s.worldId   = ColText(stmt, 0);
    s.accountId = sqlite3_column_int64(stmt, 1);
    s.endpoint  = ColText(stmt, 2);
    s.p256dh    = ColText(stmt, 3);
    s.auth      = ColText(stmt, 4);
    s.createdAt = sqlite3_column_int64(stmt, 5);
    return s;
}

}  // namespace

std::vector<WebPushSubscriptionRecord> WebPushSubscriptions::ListForAccount(
    sqlite3* db, const std::string& worldId, int64_t accountId) {
    std::vector<WebPushSubscriptionRecord> out;
    if (!db || worldId.empty()) return out;
    static const char* kSql =
        "SELECT world_id, account_id, endpoint, p256dh, auth, created_at "
        "FROM world_push_subscriptions WHERE world_id=? AND account_id=? "
        "ORDER BY endpoint ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return out;
    BindText(stmt, 1, worldId);
    sqlite3_bind_int64(stmt, 2, accountId);
    while (sqlite3_step(stmt) == SQLITE_ROW) out.push_back(ReadSubRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WebPushSubscriptionRecord> WebPushSubscriptions::ListForAccounts(
    sqlite3* db, const std::string& worldId, const std::vector<int64_t>& accountIds) {
    std::vector<WebPushSubscriptionRecord> out;
    for (const int64_t id : accountIds) {
        auto rows = ListForAccount(db, worldId, id);
        out.insert(out.end(), rows.begin(), rows.end());
    }
    return out;
}

// ─────────────────────────── the outbound queue ────────────────────────────

WorldOfflineDispatcher::WorldOfflineDispatcher(Sender sender, size_t maxQueue)
    : sender_(std::move(sender)), maxQueue_(maxQueue) {
    worker_ = std::thread([this] { WorkerLoop(); });
}

WorldOfflineDispatcher::~WorldOfflineDispatcher() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stopping_ = true;
    }
    cv_.notify_all();
    if (worker_.joinable()) worker_.join();
}

bool WorldOfflineDispatcher::Enqueue(OutboundHttpPost post) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopping_ || queue_.size() >= maxQueue_) {
            ++dropped_;
            SLOG(SPRING_LOG_WARNING,
                 "offline-notify: DROPPED '%s' (%s)", post.label.c_str(),
                 stopping_ ? "dispatcher stopping" : "queue full");
            return false;
        }
        queue_.push(std::move(post));
    }
    cv_.notify_one();
    return true;
}

void WorldOfflineDispatcher::DrainForTest() {
    std::unique_lock<std::mutex> lock(mutex_);
    idleCv_.wait(lock, [this] { return queue_.empty() && !busy_; });
}

uint64_t WorldOfflineDispatcher::DroppedCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return dropped_;
}

void WorldOfflineDispatcher::WorkerLoop() {
    for (;;) {
        OutboundHttpPost post;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            cv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
            if (queue_.empty()) return;  // stopping_ with nothing left
            post = std::move(queue_.front());
            queue_.pop();
            busy_ = true;
        }
        // Failure isolation: whatever the sender does — timeout, throw,
        // refuse — the loop survives and the next post still goes out.
        int status = -1;
        try {
            status = sender_(post);
        } catch (const std::exception& e) {
            SLOG(SPRING_LOG_WARNING, "offline-notify: '%s' sender threw: %s",
                 post.label.c_str(), e.what());
        } catch (...) {
            SLOG(SPRING_LOG_WARNING, "offline-notify: '%s' sender threw",
                 post.label.c_str());
        }
        if (status < 0) {
            SLOG(SPRING_LOG_WARNING,
                 "offline-notify: '%s' transport failure (%d)",
                 post.label.c_str(), status);
        } else if (status == 404 || status == 410) {
            // A push endpoint answering Gone should eventually be pruned —
            // logged loudly, not yet auto-removed (the worker owns no DB
            // handle by design; see the header).
            SLOG(SPRING_LOG_WARNING,
                 "offline-notify: '%s' endpoint gone (HTTP %d) — subscription "
                 "should be pruned", post.label.c_str(), status);
        } else if (status >= 400) {
            SLOG(SPRING_LOG_WARNING, "offline-notify: '%s' rejected (HTTP %d)",
                 post.label.c_str(), status);
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            busy_ = false;
        }
        idleCv_.notify_all();
    }
}

namespace {

size_t CurlDiscardBody(char*, size_t size, size_t nmemb, void*) {
    return size * nmemb;
}

}  // namespace

WorldOfflineDispatcher::Sender CurlSender() {
    static std::once_flag curlInit;
    std::call_once(curlInit, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
    return [](const OutboundHttpPost& post) -> int {
        CURL* curl = curl_easy_init();
        if (curl == nullptr) return -1;
        curl_slist* headers = nullptr;
        for (const auto& h : post.headers)
            headers = curl_slist_append(headers, h.c_str());
        curl_easy_setopt(curl, CURLOPT_URL, post.url.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS,
                         reinterpret_cast<const char*>(post.body.data()));
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,
                         static_cast<long>(post.body.size()));
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, CurlDiscardBody);
        // Short and bounded: this runs on the ONE worker thread, so one
        // stuck far end must not starve every other channel for long.
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 10000L);
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 3000L);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
        curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "https");
        const CURLcode rc = curl_easy_perform(curl);
        long status = -1;
        if (rc == CURLE_OK)
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        return rc == CURLE_OK ? static_cast<int>(status) : -1;
    };
}

// ─────────────────────────── request assembly ──────────────────────────────

nlohmann::json DiscordWebhookPayload(const WorldNotificationEvent& ev) {
    const std::string headline =
        ev.headline.empty() ? WorldNotificationHeadline(ev.kind, ev.poiName)
                            : ev.headline;
    nlohmann::json body;
    body["content"] = headline;
    nlohmann::json embed;
    embed["title"] = ev.poiName.empty() ? ev.poiId : ev.poiName;
    nlohmann::json fields = nlohmann::json::array();
    auto field = [](const char* name, const std::string& value) {
        nlohmann::json f;
        f["name"] = name;
        f["value"] = value;
        f["inline"] = true;
        return f;
    };
    fields.push_back(field("Event", WorldNotificationKindToString(ev.kind)));
    if (!ev.attackerFactionId.empty())
        fields.push_back(field("Attacker", ev.attackerFactionId));
    if (!ev.defenderFactionId.empty())
        fields.push_back(field("Defender", ev.defenderFactionId));
    embed["fields"] = std::move(fields);
    body["embeds"] = nlohmann::json::array({std::move(embed)});
    return body;
}

std::optional<OutboundHttpPost> BuildDiscordPost(const WorldDiscordConfig& cfg,
                                                 const WorldNotificationEvent& ev) {
    if (!cfg.enabled || cfg.webhookUrl.empty()) return std::nullopt;
    if (!WorldChannelEventEnabled(cfg.events, ev.kind)) return std::nullopt;
    OutboundHttpPost post;
    post.url = cfg.webhookUrl;
    post.headers.push_back("Content-Type: application/json");
    const std::string body = DiscordWebhookPayload(ev).dump();
    post.body.assign(body.begin(), body.end());
    post.label = "discord " + ev.worldId + "/" + ev.poiId + " " +
                 WorldNotificationKindToString(ev.kind);
    return post;
}

std::optional<OutboundHttpPost> BuildWebPushPost(
    const WebPushSubscriptionRecord& sub, const WorldWebPushConfig& cfg,
    const WorldNotificationEvent& ev, int64_t nowUnixSeconds) {
    if (!cfg.enabled || cfg.vapidPrivateKey.empty() || cfg.vapidPublicKey.empty() ||
        cfg.subject.empty())
        return std::nullopt;
    if (!WorldChannelEventEnabled(cfg.events, ev.kind)) return std::nullopt;

    const std::string audience = WebPush::EndpointOrigin(sub.endpoint);
    if (audience.empty()) return std::nullopt;

    const std::string payload = WorldNotificationToJson(ev).dump();
    const std::vector<uint8_t> plaintext(payload.begin(), payload.end());
    std::vector<uint8_t> body =
        WebPush::EncryptAes128Gcm(plaintext, sub.p256dh, sub.auth);
    if (body.empty()) return std::nullopt;

    const std::string authz = WebPush::VapidAuthorizationHeader(
        audience, cfg.subject, nowUnixSeconds + cfg.jwtTtlSeconds,
        cfg.vapidPrivateKey, cfg.vapidPublicKey);
    if (authz.empty()) return std::nullopt;

    OutboundHttpPost post;
    post.url = sub.endpoint;
    post.headers.push_back("Content-Type: application/octet-stream");
    post.headers.push_back("Content-Encoding: aes128gcm");
    post.headers.push_back("TTL: " + std::to_string(cfg.ttlSeconds));
    post.headers.push_back("Urgency: normal");
    post.headers.push_back("Authorization: " + authz);
    post.body = std::move(body);
    post.label = "webpush " + ev.worldId + " acct " +
                 std::to_string(sub.accountId) + " " +
                 WorldNotificationKindToString(ev.kind);
    return post;
}
