// spring-logserver — dedicated log collection and streaming server.
//
// Stores log entries in SQLite (debug.db), maintains per-source ring
// buffers, serves HTTP query endpoints and SSE streaming for real-time
// log delivery. Uses NetworkServer (HTTP/2 h2c + HTTP/1.1).

#include "Server/NetworkServer.h"
#include "System/SpringLog/SpringLog.h"
#include "System/SpringLog/SpringLogSqlite.h"

#include <sqlite3.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <deque>
#include <unordered_map>
#include <mutex>

#define LOG_SECTION "logserver"

// --- Log ring buffer ---

struct BufferedLogEntry {
    uint64_t id;
    uint64_t timestamp;
    int level;
    std::string section;
    std::string scope;
    std::string process;
    std::string message;
    int frame;
};

class LogBuffer {
public:
    void Append(uint32_t sourceId, BufferedLogEntry entry) {
        std::lock_guard<std::mutex> lock(mutex_);
        entry.id = nextId_++;
        auto& q = sources_[sourceId];
        q.push_back(std::move(entry));
        // Also add to the "all sources" buffer
        if (sourceId != 0) {
            sources_[0].push_back(q.back());
            if (sources_[0].size() > MAX_PER_SOURCE)
                sources_[0].pop_front();
        }
        if (q.size() > MAX_PER_SOURCE)
            q.pop_front();
    }

    std::vector<BufferedLogEntry> Query(uint32_t sourceId, uint64_t sinceId,
            int limit = 200, uint8_t minLevel = 0,
            const std::string& sectionFilter = "",
            const std::string& scopeFilter = "") {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<BufferedLogEntry> result;
        auto it = sources_.find(sourceId);
        if (it == sources_.end()) return result;
        for (auto& e : it->second) {
            if (e.id <= sinceId) continue;
            if (e.level < minLevel) continue;
            if (!sectionFilter.empty() && e.section != sectionFilter) continue;
            if (!scopeFilter.empty() && e.scope != scopeFilter) continue;
            result.push_back(e);
            if ((int)result.size() >= limit) break;
        }
        return result;
    }

    uint64_t LatestId(uint32_t sourceId) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = sources_.find(sourceId);
        if (it == sources_.end() || it->second.empty()) return 0;
        return it->second.back().id;
    }

private:
    mutable std::mutex mutex_;
    std::unordered_map<uint32_t, std::deque<BufferedLogEntry>> sources_;
    uint64_t nextId_ = 1;
    static constexpr size_t MAX_PER_SOURCE = 2000;
};

// --- Globals ---

static LogBuffer g_logBuffer;
static int g_port = 8010;
static std::string g_dbPath = "data/debug.db";
static NetworkServer* g_server = nullptr;
static uint32_t g_logStreamChannel = 0;

// --- HTTP helpers ---

static std::string JsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:   out += c;
        }
    }
    return out;
}

static std::string LogEntryToJson(const BufferedLogEntry& e) {
    char buf[512];
    snprintf(buf, sizeof(buf),
        R"({"id":%llu,"timestamp":%llu,"level":%d,"section":"%s","scope":"%s","process":"%s","frame":%d,"message":"%s"})",
        (unsigned long long)e.id, (unsigned long long)e.timestamp,
        e.level, JsonEscape(e.section).c_str(), JsonEscape(e.scope).c_str(),
        JsonEscape(e.process).c_str(), e.frame, JsonEscape(e.message).c_str());
    return buf;
}

/// Extract a path segment after a prefix. E.g. "/api/logs/42" with
/// prefix "/api/logs/" returns "42". Stops at '?' for query string.
static std::string ExtractPathSegment(const std::string& url, const std::string& prefix) {
    if (url.rfind(prefix, 0) != 0) return "";
    auto rest = url.substr(prefix.size());
    auto qpos = rest.find('?');
    return (qpos != std::string::npos) ? rest.substr(0, qpos) : rest;
}

/// Extract query parameter value from URL.
static std::string QueryParam(const std::string& url, const std::string& key) {
    auto qpos = url.find('?');
    if (qpos == std::string::npos) return "";
    std::string qs = url.substr(qpos + 1);
    std::string needle = key + "=";
    auto pos = qs.find(needle);
    while (pos != std::string::npos) {
        if (pos == 0 || qs[pos - 1] == '&') {
            auto valStart = pos + needle.size();
            auto valEnd = qs.find('&', valStart);
            return qs.substr(valStart, valEnd == std::string::npos ? valEnd : valEnd - valStart);
        }
        pos = qs.find(needle, pos + 1);
    }
    return "";
}

// --- Custom log sink that pushes to SSE subscribers ---

static void logSinkCallback(const char* section, int level,
                              const char* fmt, va_list args) {
    if (!g_server) return;

    char msg[1024];
    vsnprintf(msg, sizeof(msg), fmt, args);

    // Push to SSE subscribers as JSON
    std::string json = "{\"level\":" + std::to_string(level)
        + ",\"section\":\"" + JsonEscape(section ? section : "")
        + "\",\"message\":\"" + JsonEscape(msg) + "\"}";
    g_server->SendSSE(g_logStreamChannel, json, "log");
}

// --- Main ---

int main(int argc, char** argv) {
    springlog_init("spring-logserver", SPRING_LOG_OUTPUT_CONSOLE);

    // Parse args
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc)
            g_port = atoi(argv[++i]);
        else if (strcmp(argv[i], "--db") == 0 && i + 1 < argc)
            g_dbPath = argv[++i];
        else if (strcmp(argv[i], "--log-level") == 0 && i + 1 < argc) {
            const char* lvl = argv[++i];
            if (strcmp(lvl, "debug") == 0) springlog_set_min_level(SPRING_LOG_DEBUG);
            else if (strcmp(lvl, "info") == 0) springlog_set_min_level(SPRING_LOG_INFO);
            else if (strcmp(lvl, "warning") == 0) springlog_set_min_level(SPRING_LOG_WARNING);
            else if (strcmp(lvl, "error") == 0) springlog_set_min_level(SPRING_LOG_ERROR);
        }
    }

    // Init SQLite sink
    springlog_sqlite_init(g_dbPath.c_str());

    // Create game_sessions table for post-mortem tracking
    {
        sqlite3* sessDb = nullptr;
        if (sqlite3_open(g_dbPath.c_str(), &sessDb) == SQLITE_OK) {
            sqlite3_exec(sessDb,
                "CREATE TABLE IF NOT EXISTS game_sessions ("
                "  session_id TEXT PRIMARY KEY,"
                "  room_id INTEGER,"
                "  game_name TEXT,"
                "  map_name TEXT,"
                "  started_at INTEGER,"
                "  ended_at INTEGER,"
                "  end_reason TEXT,"
                "  exit_code INTEGER,"
                "  player_count INTEGER,"
                "  ai_count INTEGER"
                ")", nullptr, nullptr, nullptr);
            sqlite3_close(sessDb);
        }
    }

    SLOG(SPRING_LOG_NOTICE, "starting on port %d, db=%s", g_port, g_dbPath.c_str());

    NetworkServer net;
    g_server = &net;

    // Register SSE channel for live log streaming
    g_logStreamChannel = net.AddSSE("/api/logs/stream");

    // --- HTTP log query endpoints ---

    net.AddHttpGet("/api/logs/*", [](const std::string& url) -> HttpResponse {
        // Extract roomId from path: /api/logs/42?limit=... → "42"
        std::string roomStr = ExtractPathSegment(url, "/api/logs/");
        if (roomStr.empty() || roomStr == "search" || roomStr == "sources" || roomStr == "stream")
            return {.contentType = "text/plain", .body = {'4','0','4'}, .status = 404};

        uint32_t roomId = (uint32_t)atoi(roomStr.c_str());

        // Parse query params
        int limit = 200;
        uint8_t minLevel = 0;
        std::string section, scope;
        auto qLimit = QueryParam(url, "limit");
        if (!qLimit.empty()) limit = atoi(qLimit.c_str());
        auto qLevel = QueryParam(url, "level");
        if (!qLevel.empty()) minLevel = (uint8_t)atoi(qLevel.c_str());
        section = QueryParam(url, "section");
        scope = QueryParam(url, "scope");

        // Try ring buffer first, fall back to SQLite
        auto entries = g_logBuffer.Query(roomId, 0, limit, minLevel, section, scope);
        std::string json;
        if (!entries.empty()) {
            json = "[";
            for (size_t i = 0; i < entries.size(); i++) {
                if (i > 0) json += ",";
                json += LogEntryToJson(entries[i]);
            }
            json += "]";
        } else {
            // Query SQLite directly
            sqlite3* db = nullptr;
            json = "[]";
            if (sqlite3_open_v2(g_dbPath.c_str(), &db, SQLITE_OPEN_READONLY, nullptr) == SQLITE_OK) {
                std::string sql = "SELECT id, timestamp, level, section, scope, process, frame, message "
                    "FROM debug_logs WHERE level >= " + std::to_string(minLevel);
                if (!section.empty()) sql += " AND section = '" + section + "'";
                if (!scope.empty()) sql += " AND scope = '" + scope + "'";
                sql += " ORDER BY id DESC LIMIT " + std::to_string(limit);

                json = "[";
                bool first = true;
                auto cb = [](void* data, int ncols, char** vals, char** /*names*/) -> int {
                    auto* pair = static_cast<std::pair<std::string*, bool*>*>(data);
                    if (!*pair->second) *pair->first += ",";
                    *pair->second = false;
                    char buf[1024];
                    snprintf(buf, sizeof(buf),
                        R"({"id":%s,"timestamp":%s,"level":%s,"section":"%s","scope":"%s","process":"%s","frame":%s,"message":"%s"})",
                        vals[0] ? vals[0] : "0", vals[1] ? vals[1] : "0",
                        vals[2] ? vals[2] : "0", vals[3] ? vals[3] : "",
                        vals[4] ? vals[4] : "", vals[5] ? vals[5] : "",
                        vals[6] ? vals[6] : "0", vals[7] ? vals[7] : "");
                    *pair->first += buf;
                    return 0;
                };
                auto pair = std::make_pair(&json, &first);
                sqlite3_exec(db, sql.c_str(), cb, &pair, nullptr);
                json += "]";
                sqlite3_close(db);
            }
        }

        std::string body = json;
        return {.contentType = "application/json",
                .body = {body.begin(), body.end()}, .status = 200};
    });

    net.AddHttpGet("/api/logs/search", [](const std::string& url) -> HttpResponse {
        std::string query = QueryParam(url, "q");
        int limit = 200;
        uint8_t minLevel = 0;
        auto qLimit = QueryParam(url, "limit");
        if (!qLimit.empty()) limit = atoi(qLimit.c_str());
        auto qLevel = QueryParam(url, "level");
        if (!qLevel.empty()) minLevel = (uint8_t)atoi(qLevel.c_str());

        auto entries = g_logBuffer.Query(0, 0, limit * 5, minLevel);
        std::string json = "[";
        int count = 0;
        for (auto& e : entries) {
            if (count >= limit) break;
            if (!query.empty() && e.message.find(query) == std::string::npos) continue;
            if (count > 0) json += ",";
            json += LogEntryToJson(e);
            count++;
        }
        json += "]";
        return {.contentType = "application/json",
                .body = {json.begin(), json.end()}, .status = 200};
    });

    net.AddHttpGet("/api/logs/sources", [](const std::string&) -> HttpResponse {
        std::string json = R"({"status":"ok"})";
        return {.contentType = "application/json",
                .body = {json.begin(), json.end()}, .status = 200};
    });

    net.AddHttpGet("/api/sessions", [](const std::string&) -> HttpResponse {
        sqlite3* db = nullptr;
        std::string json = "[]";
        if (sqlite3_open(g_dbPath.c_str(), &db) == SQLITE_OK) {
            json = "[";
            bool first = true;
            auto cb = [](void* data, int ncols, char** vals, char** /*names*/) -> int {
                auto& out = *static_cast<std::pair<std::string*, bool*>*>(data);
                if (!*out.second) *out.first += ",";
                *out.second = false;
                char buf[512];
                snprintf(buf, sizeof(buf),
                    R"({"session_id":"%s","room_id":%s,"game_name":"%s","map_name":"%s","started_at":%s,"ended_at":%s,"end_reason":"%s","exit_code":%s})",
                    vals[0] ? vals[0] : "", vals[1] ? vals[1] : "0",
                    vals[2] ? vals[2] : "", vals[3] ? vals[3] : "",
                    vals[4] ? vals[4] : "0", vals[5] ? vals[5] : "0",
                    vals[6] ? vals[6] : "", vals[7] ? vals[7] : "0");
                *out.first += buf;
                return 0;
            };
            auto pair = std::make_pair(&json, &first);
            sqlite3_exec(db,
                "SELECT session_id, room_id, game_name, map_name, started_at, ended_at, end_reason, exit_code "
                "FROM game_sessions ORDER BY started_at DESC LIMIT 50",
                cb, &pair, nullptr);
            json += "]";
            sqlite3_close(db);
        }
        return {.contentType = "application/json",
                .body = {json.begin(), json.end()}, .status = 200};
    });

    net.Start(g_port);

    // Run until interrupted — the network thread handles everything
    SLOG(SPRING_LOG_NOTICE, "log server running, press Ctrl-C to stop");
    pause();  // Wait for signal

    net.Stop();
    g_server = nullptr;
    springlog_sqlite_shutdown();
    springlog_shutdown();
    return 0;
}
