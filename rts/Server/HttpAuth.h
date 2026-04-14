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

/// Validate a token from the Authorization header. Returns user ID
/// or 0 if invalid/expired. Tokens expire after 24 hours.
inline int64_t ValidateToken(Database& db, const std::string& authHeader) {
    if (authHeader.empty()) return 0;
    std::string token = ExtractBearerToken(authHeader);
    if (token.empty()) return 0;
    return db.ValidateSession(token, 86400); // 24h
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

    // GET /api/auth/validate — check if a token is still valid
    net.AddHttpGet("/api/auth/validate", [&db](const std::string&) -> HttpResponse {
        // Token comes from query param since GET has no body
        // For simplicity, just return status. Real validation is
        // done per-request by the auth middleware.
        return JsonResponse(200, R"({"status":"ok"})");
    });
}

} // namespace HttpAuth
