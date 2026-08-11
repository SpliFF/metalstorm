// HttpAuth — HTTP authentication endpoints and token validation.
//
// Provides POST /api/auth/login, POST /api/auth/register, and a
// helper to validate Bearer tokens from the Authorization header.
// Registers endpoints via NetworkServer::AddHttpPost().

#pragma once

#include "AuthTokens.h"
#include "Database.h"
#include "FactionData.h"
#include "GuestAccounts.h"
#include "NetworkServer.h"
#include "Crypto.h"
#include "Totp.h"
#include "WarPlayerBindings.h"

#include <sqlite3.h>

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

/// Task 8c: rate limit on `POST /api/auth/guest`, the one route that mints an
/// account with nothing presented and nothing chosen.
///
/// Global rather than per-anything, for the same reason RefreshFailureLimiter
/// is: there is no account name and no peer address to key on (NetworkServer
/// exposes only a loopback boolean to handlers). Consumed on every call rather
/// than only on failure — unlike a refresh, a *successful* guest mint is the
/// thing being abused.
///
/// NOT `#ifdef SPRING_PROD`, unlike RegistrationLimiter. That carve-out exists
/// so a dev box can script account creation; here the equivalent script is a
/// loop that fills `users` with rows nobody will ever log into, which is worth
/// catching locally too. 20/min is orders of magnitude above a human rate.
class GuestMintLimiter {
public:
    static constexpr double kBurst     = 20.0;
    static constexpr double kPerSecond = 20.0 / 60.0;  // ~20/min sustained

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

/// Is this account currently a member of any room? (Task 8c's rename guard.)
///
/// The hazard is not a database constraint — it is that `room_members` and the
/// game server's roster (`--player`, cross-checked by name in
/// ClientMessageHandler's AuthRequest) both identify a player by USERNAME, and
/// renaming under a live roster produces no error anywhere. The lookup simply
/// misses and the player falls through to the dynamic-join/spectator path: on
/// a war they land back on their own side (task 2 seats by faction), on a
/// skirmish they become a spectator of the game they were playing.
///
/// Returns false when the table is missing or the query fails, which is the
/// safe direction here in the sense that matters: the cost of a false negative
/// is a rename that demotes a player who can rejoin, the cost of a false
/// positive is an upgrade that can never complete.
inline bool AccountIsInARoom(sqlite3* db, int64_t accountId) {
    if (db == nullptr || accountId <= 0) return false;
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT 1 FROM room_members WHERE player_id=? LIMIT 1",
            -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return false;
    }
    sqlite3_bind_int64(s, 1, accountId);
    const bool present = sqlite3_step(s) == SQLITE_ROW;
    sqlite3_finalize(s);
    return present;
}

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
                // Task 8d: an account with a confirmed second factor cannot
                // authenticate by password alone, and Basic auth is exactly
                // that — it carries no code and has nowhere to put one. Without
                // this the whole feature is one header away from bypassed:
                // /api/auth/login would demand a code while every route that
                // accepts Basic would take the password on its own. Refusing
                // (rather than inventing a "password:code" convention) is the
                // safe direction — Basic is an inline convenience for dev and
                // manifest accounts, none of which enrol, and the player-facing
                // path is the Bearer session that /api/auth/login issues.
                if (Totp::IsEnabled(db.Handle(), user->id)) return 0;
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
    static GuestMintLimiter guestLimiter;
#ifdef SPRING_PROD
    static RegistrationLimiter registrationLimiter;
#endif

    // Task 8a: both long-lived credential tables. Created here rather than in
    // Database::CreateTables because the game server also opens this db and
    // must find `war_reconnect_tokens` present whether or not it ever
    // registered an HTTP auth route — see the EnsureTables call in
    // server_main's start-up.
    AuthTokens::EnsureTables(db.Handle());
    // Task 8d: the optional second factor. Created alongside the token tables
    // for the same reason — ValidateAuth consults `user_totp` on every Basic
    // request, and the game server reaches that path without having registered
    // a single TOTP route.
    Totp::EnsureTables(db.Handle());

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

        // Task 8d — the second factor, checked BEFORE the lockout is cleared
        // and before any credential is minted.
        //
        // The password being right is not a success here: clearing the lockout
        // on a correct password would hand an attacker who has the password an
        // unlimited, un-rate-limited channel to guess six digits against. So a
        // missing or wrong code counts as a login failure exactly like a wrong
        // password does, and the account locks out the same way.
        if (auto enrolment = Totp::Load(db.Handle(), user->id);
            enrolment && enrolment->confirmed) {
            const std::string code = JsonField(body, "totp_code");
            if (code.empty()) {
                loginLimiter.RecordFailure(username);
                // A distinct, machine-readable answer rather than a generic
                // 401: the client has to know to ask for a code, and by this
                // point the caller has already proved they hold the password,
                // so `totp_required` tells them nothing they did not know.
                return JsonResponse(401,
                    R"({"error":"two-factor code required","totp_required":true})");
            }
            const int64_t step = Totp::VerifyCode(enrolment->secret, code,
                                                  NowUnix(), enrolment->lastStep);
            if (step != 0) {
                // Spend the step. A code is valid for 30 s of wall clock and
                // is typed into a form that may be shoulder-surfed or replayed
                // off the wire; recording the floor is what stops the same six
                // digits opening a second session inside that window.
                Totp::RecordStep(db.Handle(), user->id, step);
            } else if (!Totp::ConsumeRecoveryCode(db.Handle(), user->id, code)) {
                loginLimiter.RecordFailure(username);
                return JsonResponse(401,
                    R"({"error":"invalid two-factor code","totp_required":true})");
            }
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
        // Task 8d: whether this account carries a second factor. Reported on
        // the session-validation path specifically because that is the one a
        // returning browser always takes — a settings screen that had to ask
        // separately would render "2FA: off" for a moment on every load of an
        // account that has it on.
        json += std::string(",\"totp_enabled\":") +
                (Totp::IsEnabled(db.Handle(), user->id) ? "true" : "false");
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

    // ── Task 8d: optional TOTP (§7.2) ──────────────────────────────────────
    //
    // Four verbs, all TokenRequired: enrolling, confirming and disabling a
    // second factor are things only the account holder does, and they are done
    // from a session they are already holding. There is deliberately no
    // password-reset-style out-of-band path — the recovery codes ARE that
    // path, and adding a second one would make the weaker of the two the real
    // security of the account.

    // POST /api/auth/totp/enroll — mint a pending secret + its enrolment URI.
    //
    // Task 8c: refused outright for a provisional account, and this is a
    // one-way door rather than a tidiness rule. Turning the factor off costs
    // the PASSWORD as well as a code (see the disable route — a stolen session
    // must not be able to strip it), and a guest has no password: an enrolled
    // guest would hold a factor nothing can remove. Meanwhile it would gate
    // nothing, because a guest signs in through `guest/resume` with a device
    // token and never visits /api/auth/login. Available the moment the account
    // is claimed, which is the moment it starts meaning something.
    net.AddHttpPost("/api/auth/totp/enroll", RouteAuth::TokenRequired, [&db](const std::string&, const std::string&, const HttpRequestHeaders& headers) -> HttpResponse {
        const int64_t userId = ValidateAuth(db, headers.authorization);
        if (userId <= 0) return JsonResponse(401, R"({"error":"unauthorized"})");
        auto user = db.FindUserById(userId);
        if (!user) return JsonResponse(401, R"({"error":"unauthorized"})");
        if (user->isProvisional) {
            return JsonResponse(409,
                R"({"error":"claim your account first — two-factor needs a password to turn off"})");
        }

        // 409 rather than silently re-enrolling: replacing a live second factor
        // with an unproven one is how an account ends up protected by a secret
        // nothing holds. Disabling first is deliberate friction, and it costs a
        // password.
        if (Totp::IsEnabled(db.Handle(), userId)) {
            return JsonResponse(409, R"({"error":"two-factor is already enabled — disable it first"})");
        }
        const std::string secret = Totp::GenerateSecret();
        if (secret.empty() ||
            !Totp::BeginEnrolment(db.Handle(), userId, secret, NowUnix())) {
            return JsonResponse(500, R"({"error":"could not start enrolment"})");
        }
        // Both forms are returned because a player either scans or types: the
        // URI is what a QR encodes, the secret is what the manual-entry field
        // wants. Neither is derivable from the other by the client without
        // re-implementing the URI format.
        const std::string uri = Totp::EnrolmentUri("Spring RTS Web",
                                                    user->username, secret);
        std::string json = "{\"secret\":\"" + JsonEscape(secret) + "\""
            ",\"uri\":\"" + JsonEscape(uri) + "\""
            ",\"digits\":" + std::to_string(Totp::kDigits) +
            ",\"period\":" + std::to_string(Totp::kStepSeconds) + "}";
        return JsonResponse(200, json);
    });

    // POST /api/auth/totp/confirm — prove the authenticator works, turn it on,
    // and hand back the recovery codes (the only time they exist).
    net.AddHttpPost("/api/auth/totp/confirm", RouteAuth::TokenRequired, [&db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        const int64_t userId = ValidateAuth(db, headers.authorization);
        if (userId <= 0) return JsonResponse(401, R"({"error":"unauthorized"})");

        auto enrolment = Totp::Load(db.Handle(), userId);
        if (!enrolment) {
            return JsonResponse(409, R"({"error":"no pending enrolment"})");
        }
        if (enrolment->confirmed) {
            return JsonResponse(409, R"({"error":"two-factor is already enabled"})");
        }
        const std::string code = JsonField(body, "code");
        if (code.empty()) return JsonResponse(400, R"({"error":"missing code"})");

        const int64_t step = Totp::VerifyCode(enrolment->secret, code, NowUnix(),
                                              enrolment->lastStep);
        if (step == 0) {
            return JsonResponse(401, R"({"error":"invalid code"})");
        }
        // The confirming step is recorded as spent in the same call that
        // enables the factor, so the code the player just typed is not also
        // their first login code.
        if (!Totp::Confirm(db.Handle(), userId, step, NowUnix())) {
            return JsonResponse(409, R"({"error":"no pending enrolment"})");
        }
        const auto codes = Totp::IssueRecoveryCodes(db.Handle(), userId,
                                                    Totp::kRecoveryCodes,
                                                    NowUnix());
        std::string json = "{\"ok\":true,\"enabled\":true,\"recovery_codes\":[";
        for (size_t i = 0; i < codes.size(); ++i) {
            if (i) json += ",";
            json += "\"" + JsonEscape(codes[i]) + "\"";
        }
        json += "]}";
        return JsonResponse(200, json);
    });

    // POST /api/auth/totp/disable — turn it off. Costs the password AND a
    // current code (or a recovery code).
    //
    // Both, not either: a stolen session alone must not be able to strip the
    // factor (that is the attack 2FA exists to stop), and the password alone is
    // the thing the second factor assumes is already compromised.
    net.AddHttpPost("/api/auth/totp/disable", RouteAuth::TokenRequired, [&db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        const int64_t userId = ValidateAuth(db, headers.authorization);
        if (userId <= 0) return JsonResponse(401, R"({"error":"unauthorized"})");
        auto user = db.FindUserById(userId);
        if (!user) return JsonResponse(401, R"({"error":"unauthorized"})");

        auto enrolment = Totp::Load(db.Handle(), userId);
        if (!enrolment || !enrolment->confirmed) {
            // A pending, never-confirmed enrolment is not protecting anything,
            // so abandoning one is free — otherwise a player who mis-scanned a
            // secret would have to produce a code from it to get rid of it.
            Totp::Disable(db.Handle(), userId);
            return JsonResponse(200, R"({"ok":true,"enabled":false})");
        }

        const std::string password = JsonField(body, "password");
        bool needsRehash = false;
        if (password.empty() ||
            !Crypto::VerifyPassword(password, user->passwordHash, needsRehash)) {
            return JsonResponse(401, R"({"error":"invalid credentials"})");
        }
        const std::string code = JsonField(body, "code");
        if (code.empty()) return JsonResponse(400, R"({"error":"missing code"})");
        const int64_t step = Totp::VerifyCode(enrolment->secret, code, NowUnix(),
                                              enrolment->lastStep);
        if (step == 0 && !Totp::ConsumeRecoveryCode(db.Handle(), userId, code)) {
            return JsonResponse(401, R"({"error":"invalid two-factor code"})");
        }
        Totp::Disable(db.Handle(), userId);
        return JsonResponse(200, R"({"ok":true,"enabled":false})");
    });

    // POST /api/auth/totp/status — is it on, and how much recovery is left.
    //
    // POST rather than GET even though it reads nothing: every other route in
    // this file is a POST and the client's authenticated-fetch helper is built
    // around that. `recovery_remaining` is here because running out silently is
    // how a recovery mechanism turns out not to exist on the day it is needed.
    net.AddHttpPost("/api/auth/totp/status", RouteAuth::TokenRequired, [&db](const std::string&, const std::string&, const HttpRequestHeaders& headers) -> HttpResponse {
        const int64_t userId = ValidateAuth(db, headers.authorization);
        if (userId <= 0) return JsonResponse(401, R"({"error":"unauthorized"})");
        auto enrolment = Totp::Load(db.Handle(), userId);
        const bool enabled = enrolment && enrolment->confirmed;
        std::string json = std::string("{\"enabled\":") +
            (enabled ? "true" : "false") +
            ",\"pending\":" + ((enrolment && !enrolment->confirmed) ? "true" : "false") +
            ",\"recovery_remaining\":" +
            std::to_string(Totp::RemainingRecoveryCodes(db.Handle(), userId)) + "}";
        return JsonResponse(200, json);
    });

    // ── Task 8c: guest accounts and the upgrade ────────────────────────────
    //
    // Created here for the same reason as the two above: the game server opens
    // this db and reaches `users` on every AuthRequest, so it must find the
    // guest tables present whether or not it registered a single route.
    GuestAccounts::EnsureTables(db.Handle());

    // POST /api/auth/guest — mint a provisional account and its device token.
    //
    // The only route in the app that creates an account with no credential
    // presented and none chosen, which is exactly what makes it useful (a
    // player who wants to look at a war should not meet a sign-up form first)
    // and exactly what makes it the cheapest abuse surface here. Hence the
    // limiter, which unlike RegistrationLimiter is NOT `#ifdef SPRING_PROD`:
    // a dev lobby that mints guests in a loop is a bug worth catching locally,
    // and 20/min is far above any human rate.
    net.AddHttpPost("/api/auth/guest", RouteAuth::Public, [&db, &factionRegistry](const std::string&, const std::string& body, const HttpRequestHeaders&) -> HttpResponse {
        if (!guestLimiter.TryConsume()) {
            return JsonResponse(429, R"({"error":"too many guest sign-ins — try again shortly"})");
        }
        // The provisional faction is optional and validated when present.
        // Optional because §7.1's guest can *spectate* — and a factionless
        // account is precisely the shape task 6 seats as a spectator, so
        // "no faction" is a working guest, not a broken one.
        const std::string faction = JsonField(body, "faction");
        if (!faction.empty() && factionRegistry.find(faction) == factionRegistry.end()) {
            return JsonResponse(400, R"({"error":"unknown faction"})");
        }

        // The password hash is stored EMPTY, not as a sentinel string. This is
        // load-bearing: Crypto::VerifyPassword treats any stored value without
        // the scrypt prefix as legacy plaintext and compares it directly, so a
        // sentinel like "!guest" would be a working password for every guest
        // in the deployment. The empty string is the one value that path
        // refuses unconditionally (`!stored.empty()`), which is why a guest is
        // unreachable by /api/auth/login and by Basic auth without either of
        // them needing to know guests exist.
        int64_t userId = 0;
        std::string username;
        for (int attempt = 0; attempt < 5 && userId == 0; ++attempt) {
            username = GuestAccounts::GenerateUsername();
            userId = db.CreateUser(username, /*passwordHash=*/"", "player",
                                   /*isDev=*/false,
                                   faction.empty() ? std::nullopt
                                                   : std::optional<std::string>(faction),
                                   /*isProvisional=*/true);
        }
        if (userId == 0) {
            return JsonResponse(500, R"({"error":"guest sign-in failed"})");
        }

        auto device = GuestAccounts::IssueDevice(db.Handle(), userId,
                                                 GuestAccounts::kDeviceTtlSeconds,
                                                 NowUnix());
        if (!device) {
            // Fail closed and loudly rather than handing back an account whose
            // only credential was never minted — that account is unreachable
            // forever the moment this response is discarded.
            return JsonResponse(500, R"({"error":"guest sign-in failed"})");
        }

        std::string token = GenerateToken();
        db.CreateSession(userId, token);

        std::string json = "{\"token\":\"" + token + "\""
            + ",\"user_id\":" + std::to_string(userId)
            + ",\"username\":\"" + JsonEscape(username) + "\""
            + ",\"role\":\"player\""
            + ",\"provisional\":true"
            + ",\"device_token\":\"" + JsonEscape(*device) + "\"";
        if (!faction.empty())
            json += ",\"faction\":\"" + JsonEscape(faction) + "\"";
        json += "}";
        return JsonResponse(201, json);
    });

    // POST /api/auth/guest/resume — device token → a fresh session.
    //
    // The guest's whole login flow. Deliberately does NOT mint a refresh
    // token: the device token already IS the long-lived credential, and
    // issuing a second one would give a guest two independently revocable
    // lineages for an account that has no password to re-authenticate with if
    // they diverge.
    net.AddHttpPost("/api/auth/guest/resume", RouteAuth::Public, [&db](const std::string&, const std::string& body, const HttpRequestHeaders&) -> HttpResponse {
        const std::string device = JsonField(body, "device_token");
        if (device.empty()) {
            return JsonResponse(400, R"({"error":"missing device token"})");
        }
        const int64_t userId = GuestAccounts::ValidateDevice(db.Handle(), device, NowUnix());
        if (userId <= 0) {
            return JsonResponse(401, R"({"error":"invalid or expired device token"})");
        }
        auto user = db.FindUserById(userId);
        if (!user) {
            return JsonResponse(401, R"({"error":"invalid or expired device token"})");
        }
        if (user->isBanned) {
            return JsonResponse(403, R"({"error":"account banned"})");
        }
        // A device token belonging to an account that has since upgraded is
        // refused here as well as revoked by the upgrade. Belt and braces on
        // purpose: this is the check that holds if a future path clears the
        // provisional flag without going through ConfirmProvisionalUpgrade,
        // and the failure it prevents is a password-free session on a real
        // account.
        if (!user->isProvisional) {
            return JsonResponse(401, R"({"error":"invalid or expired device token"})");
        }

        std::string token = GenerateToken();
        db.CreateSession(userId, token);
        std::string json = "{\"token\":\"" + token + "\""
            + ",\"user_id\":" + std::to_string(userId)
            + ",\"username\":\"" + JsonEscape(user->username) + "\""
            + ",\"role\":\"" + JsonEscape(user->role) + "\""
            + ",\"provisional\":true";
        if (user->factionId && !user->factionId->empty())
            json += ",\"faction\":\"" + JsonEscape(*user->factionId) + "\"";
        json += "}";
        return JsonResponse(200, json);
    });

    // POST /api/auth/upgrade — become a full account, in place.
    //
    // TokenRequired: the caller proves they are the guest by holding its
    // session, which is the only identity a guest has. Everything durable the
    // account owns is keyed on `users.id` and that id does not change here —
    // see GuestAccounts.h for why "keep the progress" is a decision about
    // where NOT to write.
    net.AddHttpPost("/api/auth/upgrade", RouteAuth::TokenRequired, [&db, &factionRegistry](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        const int64_t userId = ValidateAuth(db, headers.authorization);
        if (userId <= 0) return JsonResponse(401, R"({"error":"unauthorized"})");
        auto user = db.FindUserById(userId);
        if (!user) return JsonResponse(401, R"({"error":"unauthorized"})");

        GuestAccounts::UpgradeRequest req;
        req.username  = JsonField(body, "username");
        req.password  = JsonField(body, "password");
        req.factionId = JsonField(body, "faction");

        GuestAccounts::AccountState before;
        before.id            = user->id;
        before.username      = user->username;
        before.isProvisional = user->isProvisional;
        before.factionId     = user->factionId;

        const bool factionKnown = !req.factionId.empty() &&
            factionRegistry.find(req.factionId) != factionRegistry.end();
        const bool nameTaken = !req.username.empty() &&
            db.FindUser(req.username).has_value();
        // "Is this account sitting in a room right now?" — the rename hazard.
        // Asked of `room_members` rather than of the sim because the lobby is
        // the process serving this route and the room row is what it owns; a
        // member row exists for the whole time a player is in a room, set-up
        // or running.
        const bool nameInUse = AccountIsInARoom(db.Handle(), userId);

        const auto plan = GuestAccounts::DecideUpgrade(req, before, factionKnown,
                                                       nameTaken, nameInUse);
        switch (plan.status) {
            case GuestAccounts::UpgradeStatus::OK: break;
            case GuestAccounts::UpgradeStatus::NotProvisional:
                return JsonResponse(409, R"({"error":"this account is already a full account"})");
            case GuestAccounts::UpgradeStatus::MissingPassword:
                return JsonResponse(400, R"({"error":"password is required"})");
            case GuestAccounts::UpgradeStatus::WeakPassword:
                return JsonResponse(400, R"({"error":"password must be at least 8 characters"})");
            case GuestAccounts::UpgradeStatus::BadUsername:
                return JsonResponse(400, R"({"error":"username must be 2-32 letters, digits, - or _, and cannot start with 'guest-'"})");
            case GuestAccounts::UpgradeStatus::NameTaken:
                return JsonResponse(409, R"({"error":"username already taken"})");
            case GuestAccounts::UpgradeStatus::NameInUse:
                // 409 with its own wording: this is the one failure the player
                // can clear by doing something (leaving the room), and telling
                // them "already taken" would send them off to invent a name
                // they do not need to.
                return JsonResponse(409, R"({"error":"leave your current game before changing your name","name_in_use":true})");
            case GuestAccounts::UpgradeStatus::UnknownFaction:
                return JsonResponse(400, R"({"error":"unknown faction"})");
            case GuestAccounts::UpgradeStatus::NoFaction:
                return JsonResponse(400, R"({"error":"faction is required"})");
        }

        const std::string hashed = Crypto::HashPassword(req.password);
        if (hashed.empty()) {
            return JsonResponse(500, R"({"error":"upgrade failed"})");
        }
        if (!db.ConfirmProvisionalUpgrade(userId, plan.username, hashed, plan.factionId)) {
            // The guarded UPDATE wrote nothing, which at this point means a
            // concurrent upgrade won. Reported as the same conflict a second
            // deliberate attempt gets, because that is what it is.
            return JsonResponse(409, R"({"error":"this account is already a full account"})");
        }

        // §1b, inherited: the faction moved, so the seats held on the old side
        // go with it — bindings AND the war reconnect tokens that would
        // otherwise re-seat the account on a side it has just left. Ordered
        // after the UPDATE so a failed upgrade never costs a binding.
        int clearedBindings = 0, clearedWarTokens = 0;
        if (plan.clearsBindings) {
            WarPlayerBindings::EnsureTable(db.Handle());
            clearedBindings  = WarPlayerBindings::DeleteForAccount(db.Handle(), userId);
            clearedWarTokens = AuthTokens::RevokeWarReconnectForAccount(
                db.Handle(), userId, NowUnix());
        } else if (plan.renaming) {
            // The seats survive, so their denormalised name copy has to move
            // with them — this is the first path in the system that renames
            // an account, which is why the column never needed maintaining
            // before. Skipped when the bindings were just deleted: there is
            // nothing left to re-stamp.
            WarPlayerBindings::EnsureTable(db.Handle());
            WarPlayerBindings::RenameAccount(db.Handle(), userId, plan.username);
        }
        // The device token is spent by the upgrade — see GuestAccounts.h.
        GuestAccounts::RevokeDevicesForUser(db.Handle(), userId, NowUnix());

        // A fresh session and a first refresh family, so the upgrading device
        // is not logged out by the credential it just replaced. The old
        // session is left alone deliberately: the player may be upgrading from
        // their phone while the desktop stands in a war.
        std::string token = GenerateToken();
        db.CreateSession(userId, token);

        db.LogAudit(userId, plan.username, "guest-upgrade", before.username,
                    plan.clearsBindings ? "faction-changed" : "faction-kept");

        std::string json = "{\"token\":\"" + token + "\""
            + ",\"user_id\":" + std::to_string(userId)
            + ",\"username\":\"" + JsonEscape(plan.username) + "\""
            + ",\"role\":\"" + JsonEscape(user->role) + "\""
            + ",\"faction\":\"" + JsonEscape(plan.factionId) + "\""
            + ",\"provisional\":false"
            + ",\"cleared_bindings\":" + std::to_string(clearedBindings)
            + ",\"cleared_war_tokens\":" + std::to_string(clearedWarTokens);
        if (auto issued = AuthTokens::IssueRefresh(db.Handle(), userId,
                                                   AuthTokens::kRefreshTtlSeconds,
                                                   NowUnix()))
            json += ",\"refresh_token\":\"" + issued->token + "\""
                    ",\"expires_in\":" + std::to_string(kAccessTtlSeconds);
        json += "}";
        return JsonResponse(200, json);
    });
}

} // namespace HttpAuth
