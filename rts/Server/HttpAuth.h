// HttpAuth — HTTP authentication endpoints and token validation.
//
// Provides POST /api/auth/login, POST /api/auth/register, and a
// helper to validate Bearer tokens from the Authorization header.
// Registers endpoints via NetworkServer::AddHttpPost().

#pragma once

#include "AuthTokens.h"
#include "Database.h"
#include "FactionData.h"
#include "NetworkServer.h"
#include "Crypto.h"

#include <algorithm>
#include <chrono>
#include <ctime>
#include <mutex>
#include <string>
#include <unordered_map>

namespace HttpAuth {

/// How long an access session (a `sessions` row) is honoured for.
///
/// **Deliberately unchanged at 24 h by task 8a**, even though §7.2 calls the
/// access token "short-lived" and rotation now exists to renew it. What the
/// refresh token buys at this TTL is already the thing the persistent world
/// needs — a session that survives *days* without re-entering a password, and
/// one that can be revoked — and none of that depends on the window being
/// small. Shrinking it is a one-constant change with a blast radius the
/// constant does not show: `springrts-token` is read straight out of
/// localStorage by six client call sites (main.ts ×5, viewport.ts, minimap.ts,
/// connection.ts) which each cache it for the life of an object, so a token
/// that expires mid-session is not refreshed by any of them — it is simply
/// stale, and the failure surfaces as a mid-war reconnect asking for a
/// password. Making those call sites re-read is its own task; doing it blind
/// in the same fire is how that path breaks silently.
constexpr int kAccessTtlSeconds = 86400;

/// Wall-clock seconds. The token tables store absolute unix times (the
/// `sessions` table uses SQLite's `datetime('now')` instead — the two are not
/// mixed anywhere, and the absolute form is what lets a test drive the clock).
inline int64_t NowUnix() {
    return static_cast<int64_t>(std::time(nullptr));
}

/// PLAN-security-hardening task 3: per-username login lockout. In-memory
/// (a restart clearing counters is acceptable — this defends against online
/// credential stuffing, not offline analysis). Keyed on username rather than
/// remote IP because NetworkServer only exposes a loopback boolean, not the
/// peer address, to handlers.
class LoginLimiter {
public:
    static constexpr int kMaxFailures = 5;
    static constexpr int kLockoutSeconds = 60;

    using Clock = std::chrono::steady_clock;

    /// `now` is injectable so tests can drive the clock; production callers
    /// use the default.
    bool IsLocked(const std::string& username, Clock::time_point now = Clock::now()) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = byUsername_.find(username);
        if (it == byUsername_.end()) return false;
        return now < it->second.lockedUntil;
    }

    void RecordFailure(const std::string& username, Clock::time_point now = Clock::now()) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& e = byUsername_[username];
        // Sliding-window reset: once a lockout has elapsed, the account gets
        // a fresh kMaxFailures threshold. Without this, failCount only ever
        // grew, so after the first lockout every single further failure
        // re-tripped a full kLockoutSeconds lock — one bad login per minute
        // was a permanent lockout DoS against the account. A genuine burst
        // still locks after kMaxFailures failures.
        if (e.lockedUntil != Clock::time_point{} && now >= e.lockedUntil) {
            e.failCount = 0;
            e.lockedUntil = Clock::time_point{};
        }
        if (++e.failCount >= kMaxFailures)
            e.lockedUntil = now + std::chrono::seconds(kLockoutSeconds);
    }

    void RecordSuccess(const std::string& username) {
        std::lock_guard<std::mutex> lock(mutex_);
        byUsername_.erase(username);
    }

private:
    struct Entry {
        int failCount = 0;
        Clock::time_point lockedUntil{};
    };
    std::mutex mutex_;
    std::unordered_map<std::string, Entry> byUsername_;
};

#ifdef SPRING_PROD
/// PLAN-security-hardening G5: a global (not per-user — an attacker just
/// picks a new username each time) token-bucket cap on account creation, so
/// a script can't mass-mint accounts. Generous enough not to bother real
/// signup traffic; dev builds skip this entirely (registration-heavy test
/// flows — fresh-login/isolated-browser sessions — must stay unthrottled).
class RegistrationLimiter {
public:
    static constexpr double kBurst = 20.0;
    static constexpr double kPerSecond = 20.0 / 60.0;  // ~20/min sustained

    bool TryConsume() {
        std::lock_guard<std::mutex> lock(mutex_);
        auto now = std::chrono::steady_clock::now();
        double elapsed = std::chrono::duration<double>(now - last_).count();
        last_ = now;
        tokens_ = std::min(kBurst, tokens_ + elapsed * kPerSecond);
        if (tokens_ < 1.0) return false;
        tokens_ -= 1.0;
        return true;
    }

private:
    std::mutex mutex_;
    double tokens_ = kBurst;
    std::chrono::steady_clock::time_point last_ = std::chrono::steady_clock::now();
};
#endif

/// §7.2's "rate-limit … extended to refresh abuse". Global (an attacker holds
/// a stolen token, not an account name, so there is nothing per-user to key
/// on) and consumed **only on a failed refresh** — a legitimate client rotates
/// once per session and never touches this. Sized so that a script probing
/// token space is stopped while a fleet of real clients whose refresh tokens
/// all expired at once still gets through.
///
/// Unlike RegistrationLimiter this is NOT `#ifdef SPRING_PROD`: refresh is a
/// pure-machine path with no dev flow that hammers it, so leaving it live in
/// dev costs nothing and means the limiter is actually exercised by the suite.
class RefreshFailureLimiter {
public:
    static constexpr double kBurst     = 30.0;
    static constexpr double kPerSecond = 30.0 / 60.0;  // ~30/min sustained

    bool TryConsume(std::chrono::steady_clock::time_point now =
                        std::chrono::steady_clock::now()) {
        std::lock_guard<std::mutex> lock(mutex_);
        double elapsed = std::chrono::duration<double>(now - last_).count();
        last_ = now;
        tokens_ = std::min(kBurst, tokens_ + elapsed * kPerSecond);
        if (tokens_ < 1.0) return false;
        tokens_ -= 1.0;
        return true;
    }

private:
    std::mutex mutex_;
    double tokens_ = kBurst;
    std::chrono::steady_clock::time_point last_ = std::chrono::steady_clock::now();
};

/// Generate a cryptographically-secure random hex session token (S3).
/// 16 bytes of CSPRNG output → 32 hex chars (the previous token width).
inline std::string GenerateToken() {
    return Crypto::GenerateToken(16);
}

/// Extract a string field from a JSON body. Minimal parser, no nesting.
/// Unescapes JSON escape sequences (\n, \r, \t, \\, \", \/).
inline std::string JsonField(const std::string& body, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    auto pos = body.find(needle);
    if (pos == std::string::npos) return "";
    pos = body.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    // Skip whitespace after colon
    pos++;
    while (pos < body.size() && (body[pos] == ' ' || body[pos] == '\t')) pos++;
    if (pos >= body.size()) return "";
    // Quoted string value — unescape as we go
    if (body[pos] == '"') {
        std::string result;
        auto i = pos + 1;
        while (i < body.size() && body[i] != '"') {
            if (body[i] == '\\' && i + 1 < body.size()) {
                char next = body[i + 1];
                switch (next) {
                    case 'n':  result += '\n'; break;
                    case 'r':  result += '\r'; break;
                    case 't':  result += '\t'; break;
                    case '\\': result += '\\'; break;
                    case '"':  result += '"';  break;
                    case '/':  result += '/';  break;
                    default:   result += '\\'; result += next; break;
                }
                i += 2;
            } else {
                result += body[i];
                i++;
            }
        }
        return result;
    }
    // Unquoted value (number, boolean, null)
    auto end = body.find_first_of(",}\n\r ", pos);
    if (end == std::string::npos) end = body.size();
    return body.substr(pos, end - pos);
}

/// Escape a string for JSON output.
inline std::string JsonEscape(const std::string& s) {
    std::string out;
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c;
        }
    }
    return out;
}

/// Build a JSON response string.
inline HttpResponse JsonResponse(int status, const std::string& json) {
    return {.contentType = "application/json",
            .body = {json.begin(), json.end()}, .status = status};
}

/// Extract Bearer token from "Authorization: Bearer <token>" header.
/// Returns empty string if not present.
inline std::string ExtractBearerToken(const std::string& authHeader) {
    if (authHeader.rfind("Bearer ", 0) == 0)
        return authHeader.substr(7);
    return authHeader; // Treat raw token as-is
}

/// Base64 decode (minimal, for Basic auth only).
inline std::string Base64Decode(const std::string& in) {
    static const int T[128] = {
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
        52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
        -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
        15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
        -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
        41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1
    };
    std::string out;
    int val = 0, bits = -8;
    for (unsigned char c : in) {
        if (c > 127 || T[c] == -1) break;
        val = (val << 6) + T[c];
        bits += 6;
        if (bits >= 0) { out += char((val >> bits) & 0xFF); bits -= 8; }
    }
    return out;
}

/// Parse "Authorization: Basic <base64(user:pass)>" into user and pass.
/// Returns true if valid Basic auth header.
inline bool ParseBasicAuth(const std::string& authHeader,
                           std::string& username, std::string& password) {
    if (authHeader.rfind("Basic ", 0) != 0) return false;
    std::string decoded = Base64Decode(authHeader.substr(6));
    auto colon = decoded.find(':');
    if (colon == std::string::npos) return false;
    username = decoded.substr(0, colon);
    password = decoded.substr(colon + 1);
    return !username.empty();
}

/// Validate auth from the Authorization header. Supports both:
///   - "Bearer <token>" — validate session token (24h expiry)
///   - "Basic <base64(user:pass)>" — inline login, creates a session
/// Returns user ID or 0 if invalid.
inline int64_t ValidateAuth(Database& db, const std::string& authHeader) {
    if (authHeader.empty()) return 0;

    // Try Bearer token first
    if (authHeader.rfind("Bearer ", 0) == 0) {
        std::string token = authHeader.substr(7);
        if (!token.empty()) return db.ValidateSession(token, kAccessTtlSeconds);
    }

    // Try Basic auth — validate credentials directly
    std::string username, password;
    if (ParseBasicAuth(authHeader, username, password)) {
        auto user = db.FindUser(username);
        if (user && !user->isBanned) {
            bool needsRehash = false;
            if (Crypto::VerifyPassword(password, user->passwordHash, needsRehash)) {
                if (needsRehash)
                    db.UpdatePasswordHash(user->id, Crypto::HashPassword(password));
                return user->id;
            }
        }
    }

    // S6: no raw-token fallback. A header that is neither a valid Bearer token
    // nor valid Basic credentials is unauthenticated — treating arbitrary
    // header bytes as a session token let a malformed header impersonate a
    // session and bypassed the Bearer/Basic structure entirely.
    return 0;
}

/// Legacy alias — callers that used ValidateToken still work.
inline int64_t ValidateToken(Database& db, const std::string& authHeader) {
    return ValidateAuth(db, authHeader);
}

/// Register auth HTTP endpoints on a NetworkServer.
/// POST /api/auth/login  — login with username+password, returns token
/// POST /api/auth/register — register a new account
/// POST /api/auth/validate — check whether a token is still valid
/// POST /api/auth/logout — revoke the presented token (D45)
/// `factionRegistry` is the flattened key→FactionInfo map built at lobby
/// startup (see lobby_main.cpp's per-game FactionData::Discover loop) —
/// registration validates the required `faction` field against it
/// (PLAN-metalstorm-lobby.md task 0). Held by reference: the registry is
/// immutable for the lobby process lifetime, same as availableGames.
inline void RegisterEndpoints(NetworkServer& net, Database& db,
                              const std::unordered_map<std::string, FactionData::FactionInfo>& factionRegistry) {
    static LoginLimiter loginLimiter;
    static RefreshFailureLimiter refreshLimiter;
#ifdef SPRING_PROD
    static RegistrationLimiter registrationLimiter;
#endif

    // Task 8a: both long-lived credential tables. Created here rather than in
    // Database::CreateTables because the game server also opens this db and
    // must find `war_reconnect_tokens` present whether or not it ever
    // registered an HTTP auth route — see the EnsureTables call in
    // server_main's start-up.
    AuthTokens::EnsureTables(db.Handle());

    // POST /api/auth/login
    net.AddHttpPost("/api/auth/login", RouteAuth::Public, [&db](const std::string&, const std::string& body, const HttpRequestHeaders&) -> HttpResponse {
        std::string username = JsonField(body, "username");
        std::string password = JsonField(body, "password");

        if (username.empty() || password.empty()) {
            return JsonResponse(400, R"({"error":"missing username or password"})");
        }

        // Task 3: per-username lockout ahead of the DB lookup so a flood
        // against one username can't be used to time-probe existence either.
        if (loginLimiter.IsLocked(username)) {
            return JsonResponse(429, R"({"error":"too many failed attempts — try again shortly"})");
        }

        auto user = db.FindUser(username);
        if (!user) {
            loginLimiter.RecordFailure(username);
            return JsonResponse(401, R"({"error":"invalid credentials"})");
        }
        if (user->isBanned) {
            return JsonResponse(403, R"({"error":"account banned"})");
        }
        bool needsRehash = false;
        if (!Crypto::VerifyPassword(password, user->passwordHash, needsRehash)) {
            loginLimiter.RecordFailure(username);
            return JsonResponse(401, R"({"error":"invalid credentials"})");
        }
        loginLimiter.RecordSuccess(username);
        // Transparently upgrade legacy plaintext / weaker hashes on success.
        if (needsRehash)
            db.UpdatePasswordHash(user->id, Crypto::HashPassword(password));

        std::string token = GenerateToken();
        db.CreateSession(user->id, token);

        // `faction` is echoed here as well as on register (D40): it is the
        // account's permanent allegiance, and login is the only place a
        // returning session can learn it. Omitted rather than sent empty for
        // an account that has none (dev/manifest accounts), so a client can
        // tell "no faction" from "faction unknown".
        std::string json = "{\"token\":\"" + token + "\""
            + ",\"user_id\":" + std::to_string(user->id)
            + ",\"username\":\"" + JsonEscape(user->username) + "\""
            + ",\"role\":\"" + JsonEscape(user->role) + "\"";
        if (user->factionId && !user->factionId->empty())
            json += ",\"faction\":\"" + JsonEscape(*user->factionId) + "\"";
        // Each password authentication opens its OWN refresh family (§7.2), so
        // revoking a compromised lineage never disturbs the session the player
        // is opening right now. Omitted rather than sent empty if minting
        // failed, so a client can tell "this deployment has no refresh" from
        // "your refresh token is the empty string" — the second would have it
        // POST /api/auth/refresh forever.
        if (auto issued = AuthTokens::IssueRefresh(db.Handle(), user->id,
                                                   AuthTokens::kRefreshTtlSeconds,
                                                   NowUnix()))
            json += ",\"refresh_token\":\"" + issued->token + "\""
                    ",\"expires_in\":" + std::to_string(kAccessTtlSeconds);
        json += "}";
        return JsonResponse(200, json);
    });

    // POST /api/auth/register
    net.AddHttpPost("/api/auth/register", RouteAuth::Public, [&db, &factionRegistry](const std::string&, const std::string& body, const HttpRequestHeaders&) -> HttpResponse {
#ifdef SPRING_PROD
        // G5: registration itself stays self-service (a public beta needs
        // players to be able to sign up) but a script can no longer mass-mint
        // accounts — see RegistrationLimiter above.
        if (!registrationLimiter.TryConsume()) {
            return JsonResponse(429, R"({"error":"too many registrations — try again shortly"})");
        }
#endif
        std::string username = JsonField(body, "username");
        std::string password = JsonField(body, "password");
        std::string faction = JsonField(body, "faction");

        if (username.empty() || password.empty()) {
            return JsonResponse(400, R"({"error":"missing username or password"})");
        }
        if (username.size() < 2 || username.size() > 32) {
            return JsonResponse(400, R"({"error":"username must be 2-32 characters"})");
        }
        // PLAN-metalstorm-lobby.md §1b/task 0: faction is a required,
        // permanent choice made at sign-up — there is no player-facing
        // change flow, so this is the only place a normal account's
        // faction_id is ever written. Validated against the game's
        // declared factions (GET /api/factions/<id>), not accepted as
        // free text.
        if (faction.empty()) {
            return JsonResponse(400, R"({"error":"faction is required"})");
        }
        if (factionRegistry.find(faction) == factionRegistry.end()) {
            return JsonResponse(400, R"({"error":"unknown faction"})");
        }

        // Check if user already exists
        auto existing = db.FindUser(username);
        if (existing) {
            return JsonResponse(409, R"({"error":"username already taken"})");
        }

        // S1: store a scrypt hash, never the plaintext.
        std::string hashed = Crypto::HashPassword(password);
        if (hashed.empty()) {
            return JsonResponse(500, R"({"error":"registration failed"})");
        }
        int64_t userId = db.CreateUser(username, hashed, "player", /*isDev=*/false, faction);
        if (userId == 0) {
            return JsonResponse(500, R"({"error":"registration failed"})");
        }

        // Auto-login: create session token
        std::string token = GenerateToken();
        db.CreateSession(userId, token);

        std::string json = "{\"token\":\"" + token + "\""
            + ",\"user_id\":" + std::to_string(userId)
            + ",\"username\":\"" + JsonEscape(username) + "\""
            + ",\"role\":\"player\""
            + ",\"faction\":\"" + JsonEscape(faction) + "\"";
        if (auto issued = AuthTokens::IssueRefresh(db.Handle(), userId,
                                                   AuthTokens::kRefreshTtlSeconds,
                                                   NowUnix()))
            json += ",\"refresh_token\":\"" + issued->token + "\""
                    ",\"expires_in\":" + std::to_string(kAccessTtlSeconds);
        json += "}";
        return JsonResponse(201, json);
    });

    // POST /api/auth/validate — check if a token is still valid
    net.AddHttpPost("/api/auth/validate", RouteAuth::Public, [&db](const std::string&, const std::string&, const HttpRequestHeaders& headers) -> HttpResponse {
        int64_t userId = ValidateAuth(db, headers.authorization);
        if (userId <= 0) {
            return JsonResponse(401, R"({"valid":false,"error":"invalid or expired token"})");
        }
        auto user = db.FindUserById(userId);
        if (!user) {
            return JsonResponse(401, R"({"valid":false,"error":"user not found"})");
        }
        // Same `faction` echo as login (D40) — this is the path a returning
        // browser session actually takes, so omitting it here would leave the
        // client faction-blind for every visit after the first.
        std::string json = "{\"valid\":true"
            ",\"user_id\":" + std::to_string(user->id) +
            ",\"username\":\"" + JsonEscape(user->username) + "\""
            ",\"role\":\"" + JsonEscape(user->role) + "\"";
        if (user->factionId && !user->factionId->empty())
            json += ",\"faction\":\"" + JsonEscape(*user->factionId) + "\"";
        json += "}";
        return JsonResponse(200, json);
    });

    // POST /api/auth/logout — revoke the presented session token.
    //
    // PLAN-endtoend.md D45: there was no way off an account at all, so a
    // shared machine could not be handed over and a mistyped registration
    // could not be abandoned. Clearing the browser's localStorage is not a
    // logout — the session row lives in the DB until it ages out, so the
    // token stays valid for 24h in anything that copied it.
    //
    // Public rather than TokenRequired, and 200 even when there is nothing to
    // revoke: a logout must succeed at exactly the moment the token has gone
    // bad, or the client is stuck on an account it cannot leave. `revoked`
    // reports which happened. Only the holder of a token can name it, so
    // there is no authorisation to do beyond parsing the header.
    net.AddHttpPost("/api/auth/logout", RouteAuth::Public, [&db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        const std::string& authHeader = headers.authorization;
        if (authHeader.rfind("Bearer ", 0) != 0) {
            // Basic-auth callers hold no session row (ValidateAuth logs them
            // in per request), so there is nothing to revoke.
            return JsonResponse(200, R"({"ok":true,"revoked":false})");
        }
        std::string token = authHeader.substr(7);
        if (token.empty()) {
            return JsonResponse(200, R"({"ok":true,"revoked":false})");
        }
        const bool wasValid = db.ValidateSession(token, kAccessTtlSeconds) > 0;
        db.RevokeSession(token);
        // Task 8a: revoking the access session alone is no longer a logout —
        // the client also holds a 30-day refresh token, and leaving that live
        // means the next page load silently mints a new session for the
        // account the player just left. The family (not the single row) goes,
        // because the rotation lineage is the credential. `refresh_token` is
        // optional in the body: a caller that has none is still logged out of
        // the session it named, which is what D45's 200-on-anything promise is
        // for.
        const std::string presentedRefresh = JsonField(body, "refresh_token");
        const int revokedRefresh = presentedRefresh.empty() ? 0
            : AuthTokens::RevokeFamilyOfToken(db.Handle(), presentedRefresh,
                                              NowUnix());
        std::string json = std::string("{\"ok\":true,\"revoked\":") +
            (wasValid ? "true" : "false") +
            ",\"refresh_revoked\":" + std::to_string(revokedRefresh) + "}";
        return JsonResponse(200, json);
    });

    // POST /api/auth/refresh — rotate a refresh token into a new access
    // session (§7.2). Public: the whole point is that the caller's access
    // token has aged out, so requiring one would be circular.
    //
    // The response is shaped exactly like /api/auth/login's, so a client has
    // one code path for "I now hold a session" rather than two that drift.
    net.AddHttpPost("/api/auth/refresh", RouteAuth::Public, [&db](const std::string&, const std::string& body, const HttpRequestHeaders&) -> HttpResponse {
        const std::string presented = JsonField(body, "refresh_token");
        if (presented.empty()) {
            return JsonResponse(400, R"({"error":"missing refresh_token"})");
        }
        auto outcome = AuthTokens::Rotate(db.Handle(), presented,
                                          AuthTokens::kRefreshTtlSeconds,
                                          NowUnix());
        if (outcome.status != AuthTokens::RefreshStatus::OK) {
            // Every failure is one 401 with one message. The status ladder is
            // load-bearing on the server (Reused kills the family) and is
            // deliberately NOT reported: telling a caller "that token was
            // already used" tells a thief they are holding a live lineage.
            if (!refreshLimiter.TryConsume()) {
                return JsonResponse(429, R"({"error":"too many refresh attempts — try again shortly"})");
            }
            return JsonResponse(401, R"({"error":"invalid or expired refresh token"})");
        }
        auto user = db.FindUserById(outcome.userId);
        if (!user) {
            // The account went away under a live lineage (deleted, or a db
            // restored from before it existed). Kill the family rather than
            // leave a token that authenticates nobody but still rotates.
            AuthTokens::RevokeFamily(db.Handle(), outcome.next.familyId, NowUnix());
            return JsonResponse(401, R"({"error":"invalid or expired refresh token"})");
        }
        if (user->isBanned) {
            // A ban must not be survivable by a credential minted before it.
            AuthTokens::RevokeAllRefreshForUser(db.Handle(), user->id, NowUnix());
            return JsonResponse(403, R"({"error":"account banned"})");
        }

        const std::string token = GenerateToken();
        db.CreateSession(user->id, token);

        std::string json = "{\"token\":\"" + token + "\""
            + ",\"refresh_token\":\"" + outcome.next.token + "\""
            + ",\"expires_in\":" + std::to_string(kAccessTtlSeconds)
            + ",\"user_id\":" + std::to_string(user->id)
            + ",\"username\":\"" + JsonEscape(user->username) + "\""
            + ",\"role\":\"" + JsonEscape(user->role) + "\"";
        if (user->factionId && !user->factionId->empty())
            json += ",\"faction\":\"" + JsonEscape(*user->factionId) + "\"";
        json += "}";
        return JsonResponse(200, json);
    });

    // POST /api/auth/logout-all — §7.2's "log out everywhere" verb.
    //
    // Kept separate from /api/auth/logout on purpose, and the header's logout
    // control is deliberately NOT wired to it: one browser signing out should
    // not evict the player's phone from a war they are standing in. This is
    // the compromise response, so it takes both halves — every session row AND
    // every refresh family — because revoking either alone leaves the other as
    // a live path back into the account.
    //
    // TokenRequired rather than Public: unlike a logout, this affects devices
    // the caller is not holding, so it has to be an authenticated act.
    net.AddHttpPost("/api/auth/logout-all", RouteAuth::TokenRequired, [&db](const std::string&, const std::string&, const HttpRequestHeaders& headers) -> HttpResponse {
        const int64_t userId = ValidateAuth(db, headers.authorization);
        if (userId <= 0) {
            return JsonResponse(401, R"({"error":"unauthorized"})");
        }
        const int sessions = db.RevokeUserSessions(userId);
        const int families = AuthTokens::RevokeAllRefreshForUser(db.Handle(),
                                                                 userId, NowUnix());
        std::string json = "{\"ok\":true,\"sessions_revoked\":" +
            std::to_string(sessions) + ",\"refresh_revoked\":" +
            std::to_string(families) + "}";
        return JsonResponse(200, json);
    });
}

} // namespace HttpAuth
