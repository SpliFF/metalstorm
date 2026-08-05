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

    /// PLAN-long-uptime S8 / T2a-4: retention for the two append-only tables
    /// the S9 sweep left behind. Both are written on every admin action and
    /// every client crash report and neither had a DELETE anywhere, so on a
    /// long-lived lobby they only grow. Deleted by `created_at`, which both
    /// tables default to CURRENT_TIMESTAMP. Returns rows deleted.
    /// Call from a maintenance connection, not from `db` — see §8.2.
    int CleanOldAuditEntries(int maxAgeSeconds = 90 * 86400);
    int CleanOldClientErrors(int maxAgeSeconds = 30 * 86400);

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

    /// A client-side crash/fatal report (PLAN-client-resilience.md task 3).
    /// `count` is the dedup tally the client accumulated for this stack hash
    /// before sending (1 for a fresh report; >1 for a debounced recount of a
    /// crash-looping subsystem — see client-error-telemetry.ts).
    struct ClientErrorRecord {
        int64_t userId = 0;
        std::string reason;
        std::string errorClass;
        std::string message;
        std::string stack;
        std::string stackHash;
        std::string recoveryRung;
        std::string phase;
        int frame = 0;
        int entityCount = 0;
        std::string gameId;
        std::string mapId;
        std::string buildStamp;
        std::string gpuRenderer;
        /// Newline-joined log-ring lines (client sends an array; joined here
        /// to keep the table flat like every other text column).
        std::string logRing;
        int count = 1;
    };

    /// Insert a client-error report. Returns the new row id, or 0 on failure.
    int64_t InsertClientError(const ClientErrorRecord& rec);

    /// Count of reports from this user within the last `windowSeconds` —
    /// server-side rate-limit backstop (the client's own per-session cap of
    /// 5/hour is advisory only; PLAN-security-hardening.md §1 "junk floods" row).
    int CountRecentClientErrors(int64_t userId, int windowSeconds);

    /// A saved command-composer preset (PLAN-metalstorm-scripting.md task 6).
    /// `intentJson` is the client's compile-table.ts `CommandIntent`
    /// (verb/subject/target/priority/when), stored opaquely — the server
    /// never parses or interprets it, just round-trips it. This is a filled
    /// template, not logic: re-issuing a preset re-runs the client's compile,
    /// there is no server-side execution of presets.
    struct CommandPresetRecord {
        std::string name;
        std::string intentJson;
        std::string updatedAt;
    };

    /// Create or overwrite a preset (unique per user+name). Returns true on
    /// success.
    bool SaveCommandPreset(int64_t userId, const std::string& name, const std::string& intentJson);

    /// A user's saved presets, most-recently-updated first.
    std::vector<CommandPresetRecord> GetCommandPresets(int64_t userId, int limit = 200);

    /// Delete a preset by name. Returns true if a row was deleted.
    bool DeleteCommandPreset(int64_t userId, const std::string& name);

    /// Count of presets currently saved for a user — backs the per-account
    /// cap in the /api/presets/save route (SaveCommandPreset itself has no
    /// cap; the route enforces it before calling save on a brand-new name).
    int CountCommandPresets(int64_t userId);

    /// True if a preset with this name already exists for the user — lets
    /// the save route distinguish "update" (always allowed) from "create"
    /// (capped) without an extra round trip.
    bool CommandPresetExists(int64_t userId, const std::string& name);

private:
    void CreateTables();

    sqlite3* db = nullptr;
};
