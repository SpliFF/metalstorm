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

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
// <unordered_map>, not <map>: `rts/Map/` shadows the latter's header name.
#include <unordered_map>
#include <vector>

#include "System/SpringLog/SpringLog.h"

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

/// True for the two result codes that mean "someone else has the lock, this
/// statement did nothing, and running it again may work". Everything else is
/// a real error and must not be retried.
///
/// `SQLITE_BUSY` is a competing *process*; `SQLITE_LOCKED` is a competing
/// connection inside this one (shared-cache), which we do not use — it is
/// listed because the two are interchangeable at every call site and leaving
/// it out is the kind of omission nobody notices until it bites.
inline bool SqliteIsBusy(int rc) {
    return rc == SQLITE_BUSY || rc == SQLITE_LOCKED;
}

/// How many times a write transaction is attempted in total before the write
/// is reported lost (defect D35's residual, PLAN-endtoend.md).
///
/// `kSqliteBusyTimeoutMs` above makes a writer *wait* for the lock; it does
/// not make the write *happen*. When the timeout expires SQLite returns
/// SQLITE_BUSY and — before this — every caller in the tree logged a warning
/// and moved on, so the row simply never reached disk. A timeout is a wait
/// policy; durability needs a retry policy on top of it.
///
/// Worst case is `kSqliteBusyRetries * kSqliteBusyTimeoutMs` plus backoff
/// (~15 s) on the calling thread. That is a long time to hold an HTTP route
/// thread, and it is deliberately preferred over the alternative: the lobby
/// silently forgetting a room's roster. It is only reachable when a competing
/// writer has held the lock continuously for 5 s, which no real play rate
/// produces — it took an artificial spawn-every-8s loop to see it once.
inline constexpr int kSqliteBusyRetries = 3;

/// Backoff before attempt N+1 (1-based `attempt`). Short and linear: the
/// point is to let the current holder's transaction finish, not to implement
/// congestion control — the 5 s timeout already did the waiting.
inline constexpr int SqliteBusyBackoffMs(int attempt) { return 50 * attempt; }

// ---------------------------------------------------------------------------
// The one write transaction (defect D35's residual, and the shared-handle half
// D33 left open).
// ---------------------------------------------------------------------------
//
// Serialized mode (above) makes every *statement* on a shared handle safe. It
// does nothing for a *transaction*, because a transaction is a property of the
// CONNECTION, not of the thread that opened it. On the lobby's one `mapDb`
// handle — shared by the NetworkServer route threads and main()'s 10 Hz loop —
// two threads hand-rolling `BEGIN IMMEDIATE`/`COMMIT` produce two defects that
// no busy timeout touches, because the failing rc is `SQLITE_ERROR`, not
// `SQLITE_BUSY`:
//
//   - The second `BEGIN` fails ("cannot start a transaction within a
//     transaction"), so thread B's writes silently land inside thread A's
//     transaction and B's `COMMIT` commits A's half-finished work early.
//   - A's later `ROLLBACK` discards B's writes — including writes whose
//     helper already returned `true` to its caller.
//
// So the transaction needs a lock that spans the whole body, not just each
// statement. `SqliteWriteTransaction` is that lock, plus the two properties
// `RoomManager::WriteTransactionLocked` already had and which now live here so
// every writer on a shared handle gets them:
//
//   1. **Re-entrant, not nested.** A call made from inside this thread's own
//      transaction runs `body` inline and lets the outermost call own the
//      COMMIT and the retry (`PersistRoomLocked` → the three `Persist*Locked`
//      helpers is the original case; `WarDirector::Forget` reached from a
//      room-delete transaction is the new one).
//   2. **Every rc is checked**, and a failed COMMIT is always followed by a
//      ROLLBACK — an open transaction left on a shared handle poisons every
//      later writer on it.
//
// RULE for anything writing a handle that more than one thread can reach:
// route it through here. Do not write a `BEGIN`/`COMMIT` pair by hand.

namespace SqliteTxnDetail {

/// Per-handle transaction gate. Held for the whole `BEGIN … COMMIT`, so at
/// most one thread in this process is inside a transaction on a given handle.
/// Never erased: handles live as long as the process, and a gate is 64 bytes.
inline std::mutex& GateFor(sqlite3* db) {
    static std::mutex registryMutex;
    // <unordered_map>, not <map>: `rts/Map/` shadows the latter's header.
    static std::unordered_map<sqlite3*, std::unique_ptr<std::mutex>> gates;
    std::lock_guard<std::mutex> lk(registryMutex);
    auto& slot = gates[db];
    if (!slot) slot = std::make_unique<std::mutex>();
    return *slot;
}

/// Handles this thread currently holds a transaction on. Thread-local, so
/// reading it needs no lock — which is the point: the re-entrancy test runs
/// before the gate is taken.
inline std::vector<sqlite3*>& OwnedByThisThread() {
    static thread_local std::vector<sqlite3*> owned;
    return owned;
}

/// RAII: mark `db` owned by this thread for the life of the transaction.
struct OwnedMark {
    sqlite3* db;
    explicit OwnedMark(sqlite3* d) : db(d) { OwnedByThisThread().push_back(d); }
    ~OwnedMark() { OwnedByThisThread().pop_back(); }
    OwnedMark(const OwnedMark&) = delete;
    OwnedMark& operator=(const OwnedMark&) = delete;
};

}  // namespace SqliteTxnDetail

/// Run `body` as one `BEGIN IMMEDIATE … COMMIT` on `db`, serialized against
/// every other writer in this process on the same handle and retried as a
/// whole when a competing *process* outlasts the busy timeout.
///
/// `body` returns an sqlite result code: `SQLITE_OK` to commit, a busy code to
/// have the whole transaction retried, `SQLITE_ABORT` to roll back *by
/// decision* (silently — nothing was lost), anything else to roll back as a
/// failure. `what` names the write in the failure log. Returns false — loudly,
/// at ERROR, except for the ABORT case — when the write did not reach disk.
inline bool SqliteWriteTransaction(sqlite3* db, const char* what,
                                   const std::function<int()>& body) {
    if (!db) return false;

    // Already inside this thread's own transaction on this handle: run inline
    // and let the outermost call own the commit and the retry. Checked before
    // the gate, because the gate is not recursive and this thread holds it.
    {
        const auto& owned = SqliteTxnDetail::OwnedByThisThread();
        if (std::find(owned.begin(), owned.end(), db) != owned.end())
            return body() == SQLITE_OK;
    }

    std::lock_guard<std::mutex> hold(SqliteTxnDetail::GateFor(db));
    SqliteTxnDetail::OwnedMark mark(db);

    // A transaction opened on this handle by code that does NOT go through
    // here (or by a caller that leaked one). Joining is the least-bad option:
    // our `BEGIN` would fail with SQLITE_ERROR and every statement below would
    // land in their transaction regardless — this way at least the rc is not
    // mistaken for success and the foreign owner still commits.
    if (!sqlite3_get_autocommit(db))
        return body() == SQLITE_OK;

    int rc = SQLITE_OK;
    for (int attempt = 1; attempt <= kSqliteBusyRetries; ++attempt) {
        // IMMEDIATE, not deferred: take the write lock up front so the busy
        // timeout is spent here, once, rather than on whichever statement
        // inside `body` happens to be the first write. For the readers in
        // `body` it is also what makes a read-then-write decision (a capacity
        // count, say) atomic against a competing writer.
        rc = sqlite3_exec(db, "BEGIN IMMEDIATE", nullptr, nullptr, nullptr);
        if (rc == SQLITE_OK) {
            rc = body();
            if (rc == SQLITE_OK) {
                rc = sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr);
                if (rc == SQLITE_OK) return true;
            }
            // Unconditional: after a failed COMMIT the transaction is still
            // open, and leaving it open poisons every later writer on this
            // shared handle.
            sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
        }
        // SQLITE_ABORT is the body saying "roll this back, I decided not to
        // write" — a full side, a war that fields no such faction. Rolled back
        // above, reported false, and deliberately NOT logged as a lost write:
        // nothing was lost.
        if (rc == SQLITE_ABORT) return false;
        if (!SqliteIsBusy(rc)) break;
        if (attempt < kSqliteBusyRetries) {
            // springlog_log, not SLOG: SLOG expands a per-TU LOG_SECTION
            // macro, which a header cannot rely on.
            springlog_log(SPRING_LOG_NOTICE, "lobby", "",
                springlog_get_frame(), "%s: database busy, retrying (%d/%d)",
                what, attempt + 1, kSqliteBusyRetries);
            std::this_thread::sleep_for(
                std::chrono::milliseconds(SqliteBusyBackoffMs(attempt)));
        }
    }
    // Loud, and at ERROR: this is durable state that did not reach disk, and
    // the whole point of D35 is that it used to disappear into a WARNING.
    springlog_log(SPRING_LOG_ERROR, "lobby", "", springlog_get_frame(),
        "%s: write LOST after %d attempt(s) (%d): %s",
        what, kSqliteBusyRetries, rc, sqlite3_errmsg(db));
    return false;
}
