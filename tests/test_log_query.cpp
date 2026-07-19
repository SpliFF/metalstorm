#include <doctest/doctest.h>

#include "Server/LogQueryBuilder.h"

#include <sqlite3.h>
#include <string>
#include <vector>

// PLAN-security-hardening task 8 (G2): the logserver's /api/logs/<room> and
// /api/logs/search handlers built their SQL by string concatenation, mitigated
// only by quote-doubling. BuildLogQuery/PrepareLogQuery replace that with a
// parameterized statement — no caller value is ever spliced into the SQL text.
// These tests prove (a) the SQL carries only `?` placeholders and (b) a
// classic injection payload is treated as data, not code, against a real
// in-memory SQLite database.

TEST_CASE("BuildLogQuery emits placeholders, never interpolated user values") {
    LogQueryParams p;
    p.minLevel    = 2;
    p.roomId      = 42;
    p.game        = "zk";
    p.section     = "combat";
    p.messageLike = "boom";
    p.since       = 1000;
    p.limit       = 50;

    BuiltLogQuery q = BuildLogQuery(p);

    // Every variable is a bind, so none of the literal values appear in the SQL.
    CHECK(q.sql.find("zk") == std::string::npos);
    CHECK(q.sql.find("combat") == std::string::npos);
    CHECK(q.sql.find("boom") == std::string::npos);
    CHECK(q.sql.find("42") == std::string::npos);
    CHECK(q.sql.find("1000") == std::string::npos);
    CHECK(q.sql.find("50") == std::string::npos);

    // One placeholder per bound value: level + room + game + section + message
    // + since + limit = 7.
    size_t placeholders = 0;
    for (char c : q.sql) if (c == '?') placeholders++;
    CHECK(placeholders == 7);
    CHECK(q.binds.size() == 7);

    // The message LIKE bind carries the wildcards as data.
    bool foundLike = false;
    for (const auto& b : q.binds)
        if (b.kind == LogSqlBind::Kind::Text && b.textVal == "%boom%") foundLike = true;
    CHECK(foundLike);
}

TEST_CASE("BuildLogQuery omits absent filters entirely") {
    LogQueryParams p;   // only the defaults: minLevel 0, limit 200
    BuiltLogQuery q = BuildLogQuery(p);

    // WHERE level >= ? … LIMIT ?  → exactly 2 placeholders, 2 binds.
    size_t placeholders = 0;
    for (char c : q.sql) if (c == '?') placeholders++;
    CHECK(placeholders == 2);
    CHECK(q.binds.size() == 2);
    // room_id / game_id appear in the SELECT column list; assert the *filter*
    // fragments are absent instead.
    CHECK(q.sql.find("AND room_id") == std::string::npos);
    CHECK(q.sql.find("AND game_id") == std::string::npos);
    CHECK(q.sql.find("LIKE") == std::string::npos);
}

namespace {
// Build a debug_logs table with the columns the queries read, insert a few
// rows, and return the open handle. Caller closes.
sqlite3* MakeLogDb() {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    const char* ddl =
        "CREATE TABLE debug_logs ("
        " id INTEGER PRIMARY KEY, timestamp INTEGER, level INTEGER,"
        " section TEXT, scope TEXT, process TEXT, frame INTEGER,"
        " message TEXT, room_id INTEGER, game_id TEXT);";
    REQUIRE(sqlite3_exec(db, ddl, nullptr, nullptr, nullptr) == SQLITE_OK);
    const char* rows =
        "INSERT INTO debug_logs "
        "(timestamp,level,section,scope,process,frame,message,room_id,game_id) VALUES"
        " (1,2,'combat','','srv',0,'unit died',7,'zk'),"
        " (2,2,'combat','','srv',0,'boom happened',7,'zk'),"
        " (3,5,'net','','srv',0,'secret admin note',9,'bar');";
    REQUIRE(sqlite3_exec(db, rows, nullptr, nullptr, nullptr) == SQLITE_OK);
    return db;
}

int CountRows(sqlite3* db, const LogQueryParams& p) {
    int n = 0;
    int rc = RunLogQuery(db, p, [&](sqlite3_stmt*) { n++; });
    REQUIRE(rc >= 0);   // statement prepared
    return n;
}
} // namespace

TEST_CASE("PrepareLogQuery: a SQL-injection payload is treated as data, not code") {
    sqlite3* db = MakeLogDb();

    // Legit filter returns the two zk rows.
    LogQueryParams ok;
    ok.game = "zk";
    CHECK(CountRows(db, ok) == 2);

    // Classic injection: close the string literal, OR a tautology, comment out
    // the rest. Under the old string-concat path this would have leaked every
    // row (incl. the level-5 'secret admin note'). Parameterized, it is just a
    // game_id value that matches nothing.
    LogQueryParams inject;
    inject.game = "zk' OR '1'='1";
    CHECK(CountRows(db, inject) == 0);

    // A message search with a quote can't break out either — matches nothing
    // rather than erroring or leaking.
    LogQueryParams injectMsg;
    injectMsg.messageLike = "x' OR '1'='1";
    CHECK(CountRows(db, injectMsg) == 0);

    // And the honest search still works: LIKE %boom% finds the one row.
    LogQueryParams find;
    find.messageLike = "boom";
    CHECK(CountRows(db, find) == 1);

    sqlite3_close(db);
}

TEST_CASE("PrepareLogQuery: level / room / limit filters apply correctly") {
    sqlite3* db = MakeLogDb();

    LogQueryParams byRoom;
    byRoom.roomId = 7;
    CHECK(CountRows(db, byRoom) == 2);

    LogQueryParams byLevel;
    byLevel.minLevel = 5;   // only the level-5 net row
    CHECK(CountRows(db, byLevel) == 1);

    LogQueryParams limited;
    limited.limit = 1;
    CHECK(CountRows(db, limited) == 1);

    sqlite3_close(db);
}
