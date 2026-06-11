/**
 * Database — SQLite wrapper for server storage.
 *
 * Manages user accounts, sessions, and server configuration.
 * Phase 1 scope: user registration, login, session tokens.
 */
#pragma once

#include <cstdint>
#include <optional>
#include <string>

struct sqlite3;

struct UserRecord {
    int64_t id = 0;
    std::string username;
    std::string passwordHash;
    std::string role;           // "admin", "player", "spectator"
    bool isBanned = false;
};

class Database {
public:
    Database();
    ~Database();

    /// Open (or create) the database file. Returns true on success.
    bool Open(const std::string& path);

    /// Close the database.
    void Close();

    /// Create a user. Returns the new user ID, or 0 on failure (duplicate username).
    int64_t CreateUser(const std::string& username, const std::string& passwordHash,
                       const std::string& role = "player");

    /// Look up a user by username. Returns nullopt if not found.
    std::optional<UserRecord> FindUser(const std::string& username);

    /// Look up a user by integer id. Used by the game server's
    /// token-reconnect path which starts with a validated user id
    /// and needs the username back to check the lobby-supplied
    /// roster.
    std::optional<UserRecord> FindUserById(int64_t userId);

    /// Replace a user's stored password hash. Used by the login path to
    /// transparently upgrade legacy plaintext / weaker-parameter hashes
    /// (Crypto::VerifyPassword reports needsRehash). Returns true on success.
    bool UpdatePasswordHash(int64_t userId, const std::string& passwordHash);

    /// Store a session token for a user. Returns true on success.
    bool CreateSession(int64_t userId, const std::string& token);

    /// Validate a session token. Returns the user ID if valid, 0 if invalid.
    /// Tokens older than maxAgeSeconds are considered expired.
    int64_t ValidateSession(const std::string& token, int maxAgeSeconds = 86400);

    /// Grant the "admin" role to an existing account by username. Used at
    /// startup to provision the operator/admin account (privileged console
    /// + /api/exec access, S2) without elevating ordinary registrations.
    /// No-op if the user doesn't exist. Returns true if a row was updated.
    bool EnsureAdminRole(const std::string& username);

    /// Revoke a session token.
    void RevokeSession(const std::string& token);

    /// Delete all expired sessions (older than maxAgeSeconds).
    /// Returns the number of sessions deleted.
    int CleanExpiredSessions(int maxAgeSeconds = 86400);

private:
    void CreateTables();

    sqlite3* db = nullptr;
};
