// SpringLogSqlite — SQLite persistence sink for springlog.
//
// Batches log records and writes in a single transaction every
// 1 second or 100 entries, whichever comes first. Runs writes
// on a background thread to avoid blocking the caller.

#include "SpringLogSqlite.h"
#include "SpringLog.h"

#include <sqlite3.h>
#include <string>
#include <vector>
#include <mutex>
#include <thread>
#include <atomic>
#include <chrono>
#include <condition_variable>

static sqlite3* g_db = nullptr;
static sqlite3_stmt* g_insertStmt = nullptr;
static int g_sqliteSinkId = -1;
static std::atomic<bool> g_running{false};
static std::thread g_flushThread;
static std::mutex g_queueMutex;
static std::condition_variable g_queueCv;

struct SqliteLogEntry {
    uint64_t timestamp;
    int level;
    std::string section;
    std::string scope;
    std::string process;
    std::string message;
    int frame;
};

static std::vector<SqliteLogEntry> g_queue;
static constexpr size_t BATCH_SIZE = 100;

static void FlushBatch(std::vector<SqliteLogEntry>& batch) {
    if (!g_db || batch.empty()) return;

    sqlite3_exec(g_db, "BEGIN", nullptr, nullptr, nullptr);
    for (auto& e : batch) {
        // Only persist level >= notice
        if (e.level < SPRING_LOG_NOTICE) continue;

        sqlite3_reset(g_insertStmt);
        sqlite3_bind_int64(g_insertStmt, 1, (sqlite3_int64)e.timestamp);
        sqlite3_bind_text(g_insertStmt, 2, e.process.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(g_insertStmt, 3, e.level);
        sqlite3_bind_text(g_insertStmt, 4, e.section.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(g_insertStmt, 5, e.scope.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(g_insertStmt, 6, e.frame);
        sqlite3_bind_text(g_insertStmt, 7, e.message.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_step(g_insertStmt);
    }
    sqlite3_exec(g_db, "COMMIT", nullptr, nullptr, nullptr);
    batch.clear();
}

static void FlushThread() {
    while (g_running.load()) {
        std::vector<SqliteLogEntry> batch;
        {
            std::unique_lock<std::mutex> lock(g_queueMutex);
            g_queueCv.wait_for(lock, std::chrono::seconds(1), [] {
                return g_queue.size() >= BATCH_SIZE || !g_running.load();
            });
            batch.swap(g_queue);
        }
        FlushBatch(batch);
    }
    // Final flush
    std::lock_guard<std::mutex> lock(g_queueMutex);
    FlushBatch(g_queue);
}

static void SqliteSinkFn(const SpringLogRecord* record, void* /*userdata*/) {
    std::lock_guard<std::mutex> lock(g_queueMutex);
    g_queue.push_back({
        record->timestamp,
        record->level,
        record->section ? record->section : "",
        record->scope ? record->scope : "",
        record->process ? record->process : "",
        record->message ? record->message : "",
        record->frame
    });
    if (g_queue.size() >= BATCH_SIZE) g_queueCv.notify_one();
}

int springlog_sqlite_init(const char* dbPath) {
    if (!dbPath || !dbPath[0]) return -1;

    int rc = sqlite3_open(dbPath, &g_db);
    if (rc != SQLITE_OK) return -1;

    // Create table
    const char* createSql =
        "CREATE TABLE IF NOT EXISTS debug_logs ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  timestamp INTEGER NOT NULL,"
        "  process TEXT NOT NULL,"
        "  level INTEGER NOT NULL,"
        "  section TEXT NOT NULL,"
        "  scope TEXT NOT NULL DEFAULT '',"
        "  frame INTEGER DEFAULT 0,"
        "  message TEXT NOT NULL,"
        "  room_id INTEGER,"
        "  game_id TEXT,"
        "  source_file TEXT,"
        "  source_line INTEGER"
        ");"
        "CREATE INDEX IF NOT EXISTS idx_debug_logs_level ON debug_logs(level, timestamp);"
        "CREATE INDEX IF NOT EXISTS idx_debug_logs_scope ON debug_logs(scope, timestamp);"
        "CREATE INDEX IF NOT EXISTS idx_debug_logs_process ON debug_logs(process, timestamp);";

    char* errMsg = nullptr;
    sqlite3_exec(g_db, createSql, nullptr, nullptr, &errMsg);
    if (errMsg) sqlite3_free(errMsg);

    // Prepare insert statement
    const char* insertSql =
        "INSERT INTO debug_logs (timestamp, process, level, section, scope, frame, message) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)";
    sqlite3_prepare_v2(g_db, insertSql, -1, &g_insertStmt, nullptr);

    // Start flush thread
    g_running.store(true);
    g_flushThread = std::thread(FlushThread);

    // Register as sink
    g_sqliteSinkId = springlog_add_sink(SqliteSinkFn, nullptr);
    return 0;
}

void springlog_sqlite_shutdown(void) {
    if (g_sqliteSinkId >= 0) {
        springlog_remove_sink(g_sqliteSinkId);
        g_sqliteSinkId = -1;
    }

    g_running.store(false);
    g_queueCv.notify_one();
    if (g_flushThread.joinable()) g_flushThread.join();

    if (g_insertStmt) { sqlite3_finalize(g_insertStmt); g_insertStmt = nullptr; }
    if (g_db) { sqlite3_close(g_db); g_db = nullptr; }
}
