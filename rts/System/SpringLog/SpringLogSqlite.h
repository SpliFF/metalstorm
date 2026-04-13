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

#ifdef __cplusplus
}
#endif
