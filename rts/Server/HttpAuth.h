// HttpAuth — HTTP authentication endpoints and token validation.
//
// Provides POST /api/auth/login, POST /api/auth/register, and a
// helper to validate Bearer tokens from the Authorization header.
// Registers endpoints via NetworkServer::AddHttpPost().

#pragma once

#include "Database.h"
#include "NetworkServer.h"

#include <string>
#include <random>

namespace HttpAuth {

/// Generate a random hex token.
inline std::string GenerateToken(int length = 32) {
    static const char hex[] = "0123456789abcdef";
    static std::mt19937 rng(std::random_device{}());
    std::uniform_int_distribution<int> dist(0, 15);
    std::string token;
    token.reserve(length);
    for (int i = 0; i < length; i++) token += hex[dist(rng)];
    return token;
}

/// Extract a string field from a JSON body. Minimal parser, no nesting.
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
    // Quoted string value
    if (body[pos] == '"') {
        auto end = pos + 1;
        while (end < body.size() && body[end] != '"') {
            if (body[end] == '\\') end++;
            end++;
        }
        return body.substr(pos + 1, end - pos - 1);
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
        if (user && !user->isBanned && user->passwordHash == password) {
            return user->id;
        }
    }

    // Fallback: treat as raw token
    return db.ValidateSession(authHeader, 86400);
}

/// Legacy alias — callers that used ValidateToken still work.
inline int64_t ValidateToken(Database& db, const std::string& authHeader) {
    return ValidateAuth(db, authHeader);
}

/// Register auth HTTP endpoints on a NetworkServer.
/// POST /api/auth/login  — login with username+password, returns token
/// POST /api/auth/register — register a new account
inline void RegisterEndpoints(NetworkServer& net, Database& db) {
    // POST /api/auth/login
    net.AddHttpPost("/api/auth/login", [&db](const std::string&, const std::string& body, const HttpRequestHeaders&) -> HttpResponse {
        std::string username = JsonField(body, "username");
        std::string password = JsonField(body, "password");

        if (username.empty() || password.empty()) {
            return JsonResponse(400, R"({"error":"missing username or password"})");
        }

        auto user = db.FindUser(username);
        if (!user) {
            return JsonResponse(401, R"({"error":"invalid credentials"})");
        }
        if (user->isBanned) {
            return JsonResponse(403, R"({"error":"account banned"})");
        }
        if (user->passwordHash != password) {
            return JsonResponse(401, R"({"error":"invalid credentials"})");
        }

        std::string token = GenerateToken();
        db.CreateSession(user->id, token);

        std::string json = "{\"token\":\"" + token + "\""
            + ",\"user_id\":" + std::to_string(user->id)
            + ",\"username\":\"" + JsonEscape(user->username) + "\""
            + ",\"role\":\"" + JsonEscape(user->role) + "\"}";
        return JsonResponse(200, json);
    });

    // POST /api/auth/register
    net.AddHttpPost("/api/auth/register", [&db](const std::string&, const std::string& body, const HttpRequestHeaders&) -> HttpResponse {
        std::string username = JsonField(body, "username");
        std::string password = JsonField(body, "password");

        if (username.empty() || password.empty()) {
            return JsonResponse(400, R"({"error":"missing username or password"})");
        }
        if (username.size() < 2 || username.size() > 32) {
            return JsonResponse(400, R"({"error":"username must be 2-32 characters"})");
        }

        // Check if user already exists
        auto existing = db.FindUser(username);
        if (existing) {
            return JsonResponse(409, R"({"error":"username already taken"})");
        }

        int64_t userId = db.CreateUser(username, password);
        if (userId == 0) {
            return JsonResponse(500, R"({"error":"registration failed"})");
        }

        // Auto-login: create session token
        std::string token = GenerateToken();
        db.CreateSession(userId, token);

        std::string json = "{\"token\":\"" + token + "\""
            + ",\"user_id\":" + std::to_string(userId)
            + ",\"username\":\"" + JsonEscape(username) + "\""
            + ",\"role\":\"player\"}";
        return JsonResponse(201, json);
    });

    // POST /api/auth/validate — check if a token is still valid
    net.AddHttpPost("/api/auth/validate", [&db](const std::string&, const std::string&, const HttpRequestHeaders& headers) -> HttpResponse {
        int64_t userId = ValidateAuth(db, headers.authorization);
        if (userId <= 0) {
            return JsonResponse(401, R"({"valid":false,"error":"invalid or expired token"})");
        }
        auto user = db.FindUserById(userId);
        if (!user) {
            return JsonResponse(401, R"({"valid":false,"error":"user not found"})");
        }
        std::string json = "{\"valid\":true"
            ",\"user_id\":" + std::to_string(user->id) +
            ",\"username\":\"" + JsonEscape(user->username) + "\""
            ",\"role\":\"" + JsonEscape(user->role) + "\"}";
        return JsonResponse(200, json);
    });
}

} // namespace HttpAuth
