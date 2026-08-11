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
#include <unordered_map>
#include <utility>
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
    /// Permanent faction allegiance (PLAN-metalstorm-lobby.md §1a/§1b/§7.1),
    /// e.g. "compact" / "union" — matches a key from the game's
    /// gamedata/sidedata.lua (FactionData::Discover). Set once at
    /// registration and immutable thereafter in the normal flow; nullopt
    /// only for a not-yet-upgraded guest/provisional account (guest
    /// accounts themselves are not implemented yet — see PLAN-lobby.md
    /// §7.1 guest→upgrade). The only normal-flow writer is CreateUser;
    /// SetFactionByUsername exists solely for the audited admin override.
    std::optional<std::string> factionId;
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
    /// `factionId` is the permanent faction choice from the sign-up form
    /// (PLAN-metalstorm-lobby.md task 0); the HTTP register handler
    /// validates it against the game's declared factions before calling
    /// this, so by the time it reaches here it is trusted. Left nullopt for
    /// paths that aren't the real sign-up form (dev/test auto-register,
    /// `/api/rooms/direct` manifest accounts) — those accounts are not
    /// normal player registrations.
    int64_t CreateUser(const std::string& username, const std::string& passwordHash,
                       const std::string& role = "player", bool isDev = false,
                       const std::optional<std::string>& factionId = std::nullopt);

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

    /// Privileged override of a user's permanent faction
    /// (PLAN-metalstorm-lobby.md §1b: "exceptional reassignment ...
    /// support/admin only ... audited"). There is deliberately no
    /// player-facing setter for this — CreateUser's `factionId` parameter
    /// is the only normal-flow write, and it only ever goes from unset to
    /// set (a fresh registration), never reassigns an existing account.
    /// Callers of this override are expected to pair it with
    /// LogAudit(...) and, per §1b, clear the account's per-war bindings
    /// (not implemented here — no per-war binding storage exists yet;
    /// tracked by PLAN-metalstorm-lobby §5.1/task 4). Returns true if a
    /// row was updated (false if the user doesn't exist). Out-param
    /// `userId` receives the affected id (0 if not found).
    bool SetFactionByUsername(const std::string& username, const std::string& factionId,
                              int64_t& userId);

    /// Registered accounts per faction — the population §6's war seeding sizes
    /// a new war's sides against (PLAN-metalstorm-lobby.md §6, task 7).
    ///
    /// Counts every account that HAS a faction, banned or not: a side's
    /// capacity is a ceiling on how many people could want in, and a war seeded
    /// while an account is suspended must still have room for it when the
    /// suspension lifts. Accounts with no faction are not counted at all —
    /// they can never take a side (§2.3), so they are not population for this
    /// purpose.
    std::unordered_map<std::string, unsigned> CountAccountsByFaction();

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
        /// Row id + insert time. Set only on the read paths
        /// (GetClientErrorsByHash); the insert path never binds them.
        int64_t id = 0;
        std::string createdAt;
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

    /// One stack-hash group for the GM dashboard's crash view
    /// (PLAN-client-resilience.md task 4). Grouping is by hash and not by
    /// message because stacks arrive **minified** — there is no source-map
    /// upload pipeline (task 3's documented residual), so the frames are
    /// unreadable but the hash is still a stable identity for one crash site.
    struct ClientErrorGroup {
        std::string stackHash;
        /// Class + message of the most recent report in the group.
        std::string errorClass;
        std::string message;
        std::string recoveryRung;
        /// Rows stored, vs. SUM(count) — occurrences includes the tallies the
        /// client deduped away before sending, so a crash loop that sent one
        /// row with count=40 reads as 1 report / 40 occurrences.
        int reports = 0;
        int occurrences = 0;
        /// Distinct accounts affected. `user_id` is 0 for an unattributed
        /// report, so this can exceed the number of real accounts by one.
        int users = 0;
        std::string firstSeen;
        std::string lastSeen;
        /// Build range: lexical min/max of the non-empty build stamps seen.
        std::string firstBuild;
        std::string lastBuild;
        /// Comma-joined distinct non-empty game ids this crash was seen in.
        std::string games;
    };

    /// Top crashers, most-recently-seen first. `sinceDays <= 0` = no time
    /// bound. Read-only; never mutates or prunes.
    std::vector<ClientErrorGroup> GetClientErrorGroups(int limit = 50,
                                                       int sinceDays = 0);

    /// Every stored report for one stack hash, newest first — the dashboard's
    /// drill-down and the body of its export-to-JSON.
    std::vector<ClientErrorRecord> GetClientErrorsByHash(
        const std::string& stackHash, int limit = 200);

    /// Delete `client_errors` rows older than `retentionDays`
    /// (PLAN-client-resilience.md §3: "SQLite table with retention (30 days)").
    /// Returns rows deleted. A non-positive retention keeps everything and
    /// deletes nothing — retention is opt-out, never accidentally "0 days".
    int PruneClientErrors(int retentionDays);

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

    /// Raw handle, for modules that own their own tables and statements
    /// (GameStateStore's game_snapshots, GameServersDb's game_servers) rather
    /// than adding a method here per query. Null until Open() succeeds.
    ///
    /// Callers using it off the main thread rely on SQLite's default
    /// serialized threading mode; they must also serialise their own
    /// multi-statement transactions, since sharing a handle means sharing the
    /// connection's single transaction scope.
    sqlite3* Handle() const { return db; }
    /// PLAN-long-uptime task 3: `(room_id, extra_json)` from the newest
    /// `game_metrics` row of every room with a **live game server**. Rooms
    /// whose newest row carries an empty `extra_json` are omitted — there is
    /// nothing to scan — and so are rooms whose server has exited, whose
    /// metric rows outlive them.
    ///
    /// Lives on Database rather than being a raw query in the lobby loop for
    /// the §8.2 reason: the maintenance thread must not touch the handle the
    /// route handlers use, and the only handle it legitimately owns is this
    /// object's. `game_metrics` is created by the *game* server, so a lobby
    /// that has never hosted a game has no such table; that is not an error
    /// and yields an empty result.
    std::vector<std::pair<int, std::string>> LatestGameExtraJson();

private:
    void CreateTables();

    sqlite3* db = nullptr;
};
