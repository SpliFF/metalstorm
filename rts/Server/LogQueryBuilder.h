/**
 * LogQueryBuilder — parameterized SELECTs over the logserver's debug_logs
 * table.
 *
 * PLAN-security-hardening task 8 (G2): the logserver's log-query handlers
 * (/api/logs/<room> and /api/logs/search) previously built their SQL by string
 * concatenation, mitigated only by quote-doubling (SqlEscape). That is
 * bypassable and fragile. This header builds the same queries with `?`
 * placeholders and a typed bind list — no caller-supplied value is ever spliced
 * into the SQL text — eliminating the injection surface. Header-only and
 * dependency-light (just sqlite3) so both the logserver and the doctest suite
 * can use it.
 */
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include <sqlite3.h>

/// A single bound value for a debug_logs query. Tagged union so the builder can
/// return a mixed int/text list in bind order.
struct LogSqlBind {
    enum class Kind { Int, Text } kind;
    int64_t     intVal = 0;
    std::string textVal;

    static LogSqlBind Int64(int64_t v) { return {Kind::Int, v, {}}; }
    static LogSqlBind Text(std::string v) { return {Kind::Text, 0, std::move(v)}; }
};

/// Filters for a debug_logs query. Empty/zero fields are omitted from the WHERE
/// clause entirely (no placeholder, no bind).
struct LogQueryParams {
    uint8_t     minLevel = 0;
    uint32_t    roomId   = 0;   ///< 0 → no room filter
    uint64_t    since    = 0;   ///< 0 → no timestamp floor
    std::string game;           ///< "" → no game_id filter
    std::string section;        ///< "" → no section filter
    std::string scope;          ///< "" → no scope filter
    std::string messageLike;    ///< "" → no message-substring (LIKE %…%) filter
    int         limit    = 200;
};

/// The built query: a parameterized SQL string (only `?` placeholders) and the
/// ordered bind values to apply to it.
struct BuiltLogQuery {
    std::string              sql;
    std::vector<LogSqlBind>  binds;
};

/// Build a fully parameterized SELECT over debug_logs. The column order is
/// fixed (id, timestamp, level, section, scope, process, frame, message,
/// room_id, game_id) so callers can read result columns by index.
inline BuiltLogQuery BuildLogQuery(const LogQueryParams& p) {
    BuiltLogQuery q;
    q.sql =
        "SELECT id, timestamp, level, section, scope, process, frame, message, room_id, game_id "
        "FROM debug_logs WHERE level >= ?";
    q.binds.push_back(LogSqlBind::Int64(p.minLevel));

    if (p.roomId != 0) {
        q.sql += " AND room_id = ?";
        q.binds.push_back(LogSqlBind::Int64(p.roomId));
    }
    if (!p.game.empty()) {
        q.sql += " AND game_id = ?";
        q.binds.push_back(LogSqlBind::Text(p.game));
    }
    if (!p.section.empty()) {
        q.sql += " AND section = ?";
        q.binds.push_back(LogSqlBind::Text(p.section));
    }
    if (!p.scope.empty()) {
        q.sql += " AND scope = ?";
        q.binds.push_back(LogSqlBind::Text(p.scope));
    }
    if (!p.messageLike.empty()) {
        q.sql += " AND message LIKE ?";
        // The %wildcards% are part of the *bound value*, not the SQL text, so
        // the user's substring can't break out of the string literal. (LIKE
        // metacharacters % and _ inside the value stay literal-ish to LIKE but
        // are harmless — this is a log search, not an ACL.)
        q.binds.push_back(LogSqlBind::Text("%" + p.messageLike + "%"));
    }
    if (p.since != 0) {
        q.sql += " AND timestamp >= ?";
        q.binds.push_back(LogSqlBind::Int64(static_cast<int64_t>(p.since)));
    }

    q.sql += " ORDER BY id DESC LIMIT ?";
    q.binds.push_back(LogSqlBind::Int64(p.limit));
    return q;
}

/// Prepare + bind a debug_logs query. Returns a ready-to-step statement, or
/// nullptr on prepare failure. Caller finalizes.
inline sqlite3_stmt* PrepareLogQuery(sqlite3* db, const LogQueryParams& p) {
    const BuiltLogQuery q = BuildLogQuery(p);
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, q.sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return nullptr;
    int idx = 1;
    for (const auto& b : q.binds) {
        if (b.kind == LogSqlBind::Kind::Int)
            sqlite3_bind_int64(stmt, idx, b.intVal);
        else
            sqlite3_bind_text(stmt, idx, b.textVal.c_str(), -1, SQLITE_TRANSIENT);
        idx++;
    }
    return stmt;
}

/// Prepare, bind, and step a debug_logs query, invoking `onRow(stmt)` for each
/// result row. Returns the number of rows visited, or -1 if the statement could
/// not be prepared.
inline int RunLogQuery(sqlite3* db, const LogQueryParams& p,
                       const std::function<void(sqlite3_stmt*)>& onRow) {
    sqlite3_stmt* stmt = PrepareLogQuery(db, p);
    if (!stmt) return -1;
    int n = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        onRow(stmt);
        n++;
    }
    sqlite3_finalize(stmt);
    return n;
}
