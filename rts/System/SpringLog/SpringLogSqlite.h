// SpringLogSqlite — optional SQLite sink for springlog.
// Persists log entries to a local SQLite database.
// Links: springlog + sqlite3.

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// Call after springlog_init(). Opens/creates the database and registers
// itself as a custom sink. Returns 0 on success.
int springlog_sqlite_init(const char* dbPath);

// Flush pending writes and close the database. Called before springlog_shutdown().
void springlog_sqlite_shutdown(void);

// Delete debug_logs rows older than `retentionDays` and return how many went.
// Negative/zero retention is a no-op (fail closed — a bad config value must
// not empty the table).
//
// The sink had no retention at all, so data/debug.db grew unbounded: it
// reached 1.39 GB / 5.76M rows spanning four months before anyone noticed.
// Call this periodically from the owning process's main loop, the same shape
// as the lobby's Database::PruneClientErrors.
int springlog_sqlite_prune(int retentionDays);

// One-shot startup maintenance on `dbPath`: prune past the retention window
// and, if that freed a lot of rows, VACUUM so the space actually returns to
// the filesystem (a DELETE alone leaves the file at its high-water mark —
// measured 1.49 GB -> 72 MB in ~1.1 s). Returns rows deleted, or -1 if the
// database could not be opened.
//
// Uses its own connection, so it is safe to call before OR after
// springlog_sqlite_init; VACUUM cannot run on the sink's handle because the
// batching insert statement is left active between flushes.
int springlog_sqlite_maintain(const char* dbPath, int retentionDays);

#ifdef __cplusplus
}
#endif
