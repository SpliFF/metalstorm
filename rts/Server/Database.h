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
#include <vector>

struct sqlite3;

struct UserRecord {
    int64_t id = 0;
    std::string username;
    std::string passwordHash;
    std::string role;           // "admin", "player", "spectator"
    bool isBanned = false;
    /// True for accounts minted by `/api/rooms/direct` (no password ever
    /// set — the account exists only to hold a pre-authorised session).
    bool isDev = false;
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
    /// `isDev` marks accounts minted by `/api/rooms/direct` for a manifest
    /// username that doesn't exist yet — never set for normal registration.
    int64_t CreateUser(const std::string& username, const std::string& passwordHash,
                       const std::string& role = "player", bool isDev = false);

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

    /// Ban / unban an account (PLAN-gm-tools task 4). Sets `users.is_banned`.
    /// Login (`/api/auth/login`) and Basic-auth already refuse `is_banned`
    /// accounts (HttpAuth.h), so a ban blocks *future* auth immediately — but
    /// an already-issued Bearer token is validated against the `sessions`
    /// table only (no per-request ban recheck), so a GM ban of a logged-in
    /// user must be paired with RevokeUserSessions() to take effect now.
    /// Returns true if a row was updated (false if the user doesn't exist).
    bool SetBanned(int64_t userId, bool banned);

    /// Ban / unban by username — the shape the GM `ban <player>` verb uses
    /// (operators name people, not row ids). Returns true if a row was
    /// updated. Out-param `userId` receives the affected id (0 if not found)
    /// so the caller can revoke sessions + audit with the id.
    bool SetBannedByUsername(const std::string& username, bool banned, int64_t& userId);

    /// Delete every session belonging to a user (immediate logout). Paired
    /// with SetBanned() so a ban ejects a currently-connected player from the
    /// lobby auth path. Returns the number of sessions deleted.
    int RevokeUserSessions(int64_t userId);

    /// All currently-banned accounts, newest-id first — the dashboard ban list
    /// (PLAN-gm-tools §2). Read-only.
    std::vector<UserRecord> GetBannedUsers(int limit = 200);

    /// Delete all expired sessions (older than maxAgeSeconds).
    /// Returns the number of sessions deleted.
    int CleanExpiredSessions(int maxAgeSeconds = 86400);

    /// Append an entry to the admin_audit log (PLAN-security-hardening task
    /// 6). Every admin-role action — exec, restart, GM verbs (rollback/
    /// grant), direct-start — goes through this. Append-only: there is no
    /// update/delete verb. `userId` is 0 for actions with no session
    /// (localhost-gated routes reached without a token, e.g.
    /// /api/rooms/direct off loopback). `argsDigest` should be a short
    /// summary/hash of the args, not the full payload verbatim (avoid
    /// bloating the audit table with e.g. full exec Lua source — callers
    /// decide what's worth keeping).
    void LogAudit(int64_t userId, const std::string& username, const std::string& action,
                  const std::string& target, const std::string& argsDigest);

    struct AuditEntry {
        int64_t id = 0;
        int64_t userId = 0;
        std::string username;
        std::string action;
        std::string target;
        std::string argsDigest;
        std::string createdAt;
    };

    /// Most recent audit entries, newest first. Read path for an operator
    /// dashboard / gm-tools; the write path (LogAudit) has no matching
    /// update/delete verb anywhere in this class — append-only by omission.
    std::vector<AuditEntry> GetRecentAuditEntries(int limit = 100);

private:
    void CreateTables();

    sqlite3* db = nullptr;
};
