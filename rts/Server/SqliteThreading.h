/**
 * SqliteThreading — put SQLite into serialized mode before anything opens a
 * connection.
 *
 * Why this exists (defect D33, PLAN-endtoend.md §Defect register):
 *
 * Every one of our processes that talks to SQLite is multi-threaded and
 * shares a single `sqlite3*` across those threads:
 *
 *   - spring-lobby   — NetworkServer runs every HTTP route handler on its own
 *                      thread (NetworkServer.cpp, NetworkThreadFunc), while
 *                      main() runs a 10 Hz loop that polls `game_status`,
 *                      write-throughs `game_servers` and reaps rooms. Both
 *                      use `mapDb` (also handed to RoomManager via
 *                      SetDatabase) and the `Database` handle.
 *   - spring-server  — network thread + sim loop.
 *   - spring-logserver — network thread + the SpringLog sqlite sink's flush
 *                      thread.
 *
 * macOS's /usr/lib/libsqlite3.dylib is compiled SQLITE_THREADSAFE=2
 * ("multi-thread"): mutexes exist, but the *default* for a new connection is
 * NOMUTEX. So a plain sqlite3_open() hands back a connection that serializes
 * nothing — not even its own lookaside allocator. Two threads inside one such
 * connection corrupt its **in-process** state. Observed outcomes:
 *
 *   - a hard crash in sqlite3DbMallocRawNN / sqlite3PExpr under load, and
 *   - the milder, stickier SQLITE_NOTADB (26, "file is not a database"):
 *     every subsequent statement on that handle fails forever while the file
 *     on disk stays perfectly valid — integrity_check ok, other processes
 *     reading it fine. That is D33, and it is why restarting the lobby cured
 *     it instantly: only the handle was dead, never the data.
 *
 * SQLITE_CONFIG_SERIALIZED must be called before sqlite3_initialize() — i.e.
 * before the first sqlite3_open of any kind — or it returns SQLITE_MISUSE.
 * It applies to every connection in the process, including ones opened by
 * code that does not pass SQLITE_OPEN_FULLMUTEX itself (Database::Open, the
 * SpringLog sqlite sink). The individually contended handles pass
 * SQLITE_OPEN_FULLMUTEX as well, so the requirement stays legible at the
 * point of use and survives this call being moved.
 */

#pragma once

#include <sqlite3.h>

#include <cstdio>

/// Switch SQLite to serialized threading mode. Call as the first statement
/// in main(), before springlog_init (the sqlite log sink opens a connection)
/// and before any other sqlite3_open. Returns false if the call was refused,
/// which means something already initialised SQLite — in that case the
/// process is about to share unserialized handles across threads and should
/// not continue.
inline bool SqliteEnableSerializedMode(const char* who) {
    const int rc = sqlite3_config(SQLITE_CONFIG_SERIALIZED);
    if (rc != SQLITE_OK) {
        // Deliberately fprintf and not SLOG: this runs before springlog_init.
        std::fprintf(stderr,
            "FATAL: %s: sqlite3_config(SQLITE_CONFIG_SERIALIZED) failed (%d). "
            "Refusing to run with unserialized SQLite handles shared across "
            "threads — see D33.\n", who, rc);
        return false;
    }
    return true;
}

/// Open flags for any handle reached from more than one thread. FULLMUTEX is
/// redundant once SqliteEnableSerializedMode has run, and intentionally so.
inline constexpr int kSqliteSharedOpenFlags =
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;

/// How long a writer waits for a competing writer before giving up.
///
/// data/spring-server.db is a multi-process backchannel: the lobby, every
/// spawned game server, the logserver and external tools (the MCP debug
/// server, springcli) all write it. SQLite's default busy timeout is **0 ms**
/// — a writer that finds the DB locked fails immediately with SQLITE_BUSY (5)
/// rather than waiting. Under spawn churn that surfaces as
/// "PersistRoom step failed: database is locked", i.e. room state silently
/// not reaching disk, which is indistinguishable from D33's symptom to
/// anyone reading the room list. WAL mode allows concurrent readers but
/// still serializes writers, so a timeout is required, not optional.
inline constexpr int kSqliteBusyTimeoutMs = 5000;

/// Apply the settings every handle on the shared DB needs. Call right after
/// a successful open.
inline void SqliteConfigureSharedHandle(sqlite3* db) {
    if (!db) return;
    sqlite3_busy_timeout(db, kSqliteBusyTimeoutMs);
}
