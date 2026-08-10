// HttpAuth — HTTP authentication endpoints and token validation.
//
// Provides POST /api/auth/login, POST /api/auth/register, and a
// helper to validate Bearer tokens from the Authorization header.
// Registers endpoints via NetworkServer::AddHttpPost().

#pragma once

#include "Database.h"
#include "FactionData.h"
#include "NetworkServer.h"
#include "Crypto.h"

#include <algorithm>
#include <chrono>
#include <mutex>
#include <string>
#include <unordered_map>

namespace HttpAuth {

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
        if (!token.empty()) return db.ValidateSession(token, 86400);
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
/// `factionRegistry` is the flattened key→FactionInfo map built at lobby
/// startup (see lobby_main.cpp's per-game FactionData::Discover loop) —
/// registration validates the required `faction` field against it
/// (PLAN-metalstorm-lobby.md task 0). Held by reference: the registry is
/// immutable for the lobby process lifetime, same as availableGames.
inline void RegisterEndpoints(NetworkServer& net, Database& db,
                              const std::unordered_map<std::string, FactionData::FactionInfo>& factionRegistry) {
    static LoginLimiter loginLimiter;
#ifdef SPRING_PROD
    static RegistrationLimiter registrationLimiter;
#endif

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
            + ",\"faction\":\"" + JsonEscape(faction) + "\"}";
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
}

} // namespace HttpAuth
