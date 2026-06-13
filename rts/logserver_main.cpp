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
#include <chrono>
#include <atomic>
#include <csignal>
#include <cerrno>

#define LOG_SECTION "logserver"

// --- Lifecycle / self-restart -------------------------------------------
//
// Mirrors the lobby's in-place re-exec (spring-lobby): a restart replaces
// this process image via execvp, so the PID is preserved and a process
// manager (mprocs) keeps tracking the same pid instead of seeing a crash +
// respawn. Triggered by SIGHUP or `POST /api/logs/restart` (used by the
// MCP `restart_logserver` tool). SIGINT/SIGTERM are a plain clean stop.
static std::atomic<bool> g_shutdown{false};
static std::atomic<bool> g_restart{false};
static int   g_savedArgc = 0;
static char** g_savedArgv = nullptr;
static void stopHandler(int)    { g_shutdown.store(true); }
static void restartHandler(int) { g_restart.store(true); g_shutdown.store(true); }

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
    uint32_t room_id;
    std::string game_id;
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
    std::string json;
    json += R"({"id":)" + std::to_string(e.id);
    json += R"(,"timestamp":)" + std::to_string(e.timestamp);
    json += R"(,"level":)" + std::to_string(e.level);
    json += R"(,"section":")" + JsonEscape(e.section) + "\"";
    json += R"(,"scope":")" + JsonEscape(e.scope) + "\"";
    json += R"(,"process":")" + JsonEscape(e.process) + "\"";
    json += R"(,"frame":)" + std::to_string(e.frame);
    json += R"(,"room_id":)" + std::to_string(e.room_id);
    json += R"(,"game_id":")" + JsonEscape(e.game_id) + "\"";
    json += R"(,"message":")" + JsonEscape(e.message) + "\"}";
    return json;
}

/// Escape a string for safe inclusion in a single-quoted SQL literal by
/// doubling embedded quotes. Used for the optional game/section filters
/// (these come from trusted local callers, but doubling keeps a stray
/// quote from breaking the query).
static std::string SqlEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '\'') out += "''";
        else out += c;
    }
    return out;
}

/// Extract a path segment after a prefix. E.g. "/api/logs/42" with
/// prefix "/api/logs/" returns "42". Stops at '?' for query string.
static std::string ExtractPathSegment(const std::string& url, const std::string& prefix) {
    if (url.rfind(prefix, 0) != 0) return "";
    auto rest = url.substr(prefix.size());
    auto qpos = rest.find('?');
    return (qpos != std::string::npos) ? rest.substr(0, qpos) : rest;
}

/// Extract a query parameter value from the request currently being
/// dispatched. The handler's `url` argument is the decoded path only (the
/// NetworkServer strips the query string before routing), so we read the raw
/// query string back from the thread-local stashed by the dispatcher. The
/// `url` parameter is retained for call-site readability but unused.
static std::string QueryParam(const std::string& /*url*/, const std::string& key) {
    std::string qs = NetworkServer::CurrentQueryString();
    if (qs.empty()) return "";
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

// --- Custom log sink that pushes to LogBuffer + SSE subscribers ---
//
// Registered with springlog so every record routed through SpringLog (from
// any process or via the /api/logs/ingest endpoint) lands in the in-memory
// ring buffer for fast HTTP-GET queries AND streams via SSE for real-time
// log delivery to the browser debug console.

static void logSinkCallback(const SpringLogRecord* rec, void* /*userdata*/) {
    if (!g_server || !rec) return;

    BufferedLogEntry entry{};
    entry.timestamp = rec->timestamp;
    entry.level = rec->level;
    entry.section = rec->section ? rec->section : "";
    entry.scope = rec->scope ? rec->scope : "";
    entry.process = rec->process ? rec->process : "";
    entry.message = rec->message ? rec->message : "";
    entry.frame = rec->frame;
    entry.room_id = rec->room_id;
    entry.game_id = rec->game_id ? rec->game_id : "";
    g_logBuffer.Append(0, entry);

    std::string json = "{\"level\":" + std::to_string(entry.level)
        + ",\"section\":\"" + JsonEscape(entry.section)
        + "\",\"scope\":\"" + JsonEscape(entry.scope)
        + "\",\"process\":\"" + JsonEscape(entry.process)
        + "\",\"frame\":" + std::to_string(entry.frame)
        + ",\"room_id\":" + std::to_string(entry.room_id)
        + ",\"game_id\":\"" + JsonEscape(entry.game_id)
        + "\",\"message\":\"" + JsonEscape(entry.message) + "\"}";
    g_server->SendSSE(g_logStreamChannel, json, "log");
}

// --- JSON parsing (minimal — we only handle the ingest body shape) ---
//
// Returns the unescaped string value of a top-level "key" field, or the
// empty string if not found. Stops at the first matching key. Escapes
// recognised: \", \\, \n, \r, \t, \uXXXX (BMP only).
static std::string JsonGetString(const std::string& body, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    auto kpos = body.find(needle);
    if (kpos == std::string::npos) return "";
    auto cpos = body.find(':', kpos + needle.size());
    if (cpos == std::string::npos) return "";
    auto vstart = body.find('"', cpos + 1);
    if (vstart == std::string::npos) return "";
    vstart++;
    std::string out;
    for (size_t i = vstart; i < body.size(); i++) {
        char c = body[i];
        if (c == '\\' && i + 1 < body.size()) {
            char esc = body[i + 1];
            switch (esc) {
                case '"':  out += '"';  i++; break;
                case '\\': out += '\\'; i++; break;
                case '/':  out += '/';  i++; break;
                case 'n':  out += '\n'; i++; break;
                case 'r':  out += '\r'; i++; break;
                case 't':  out += '\t'; i++; break;
                case 'b':  out += '\b'; i++; break;
                case 'f':  out += '\f'; i++; break;
                case 'u': {
                    if (i + 5 < body.size()) {
                        unsigned cp = 0;
                        for (int k = 0; k < 4; k++) {
                            char h = body[i + 2 + k];
                            cp <<= 4;
                            if (h >= '0' && h <= '9') cp |= h - '0';
                            else if (h >= 'a' && h <= 'f') cp |= h - 'a' + 10;
                            else if (h >= 'A' && h <= 'F') cp |= h - 'A' + 10;
                        }
                        if (cp < 0x80) out += (char)cp;
                        else if (cp < 0x800) {
                            out += (char)(0xC0 | (cp >> 6));
                            out += (char)(0x80 | (cp & 0x3F));
                        } else {
                            out += (char)(0xE0 | (cp >> 12));
                            out += (char)(0x80 | ((cp >> 6) & 0x3F));
                            out += (char)(0x80 | (cp & 0x3F));
                        }
                        i += 5;
                    }
                    break;
                }
                default: out += esc; i++; break;
            }
        } else if (c == '"') {
            return out;
        } else {
            out += c;
        }
    }
    return out;
}

static int JsonGetInt(const std::string& body, const std::string& key, int def) {
    std::string needle = "\"" + key + "\"";
    auto kpos = body.find(needle);
    if (kpos == std::string::npos) return def;
    auto cpos = body.find(':', kpos + needle.size());
    if (cpos == std::string::npos) return def;
    size_t i = cpos + 1;
    while (i < body.size() && (body[i] == ' ' || body[i] == '\t')) i++;
    if (i >= body.size()) return def;
    bool neg = false;
    if (body[i] == '-') { neg = true; i++; }
    if (i >= body.size() || body[i] < '0' || body[i] > '9') return def;
    int v = 0;
    while (i < body.size() && body[i] >= '0' && body[i] <= '9') {
        v = v * 10 + (body[i] - '0');
        i++;
    }
    return neg ? -v : v;
}

// --- Main ---

int main(int argc, char** argv) {
    springlog_init("spring-logserver", SPRING_LOG_OUTPUT_CONSOLE);

    // Saved for self-restart via execvp (see g_restart handling below).
    g_savedArgc = argc;
    g_savedArgv = argv;

    // SIGINT/SIGTERM → clean stop; SIGHUP → restart-in-place (same pid).
    std::signal(SIGINT,  stopHandler);
    std::signal(SIGTERM, stopHandler);
    std::signal(SIGHUP,  restartHandler);

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

    // Init SQLite sink (writes log records to debug.db on a flush thread)
    springlog_sqlite_init(g_dbPath.c_str());

    // Register the in-process ring-buffer + SSE fanout sink. Every record
    // routed through SpringLog (including those POSTed to /api/logs/ingest)
    // lands in g_logBuffer for fast HTTP queries and on the SSE stream so
    // the in-game debug console sees it in real time.
    springlog_add_sink(logSinkCallback, nullptr);

    // Create game_sessions table for post-mortem tracking
    {
        sqlite3* sessDb = nullptr;
        if (sqlite3_open(g_dbPath.c_str(), &sessDb) == SQLITE_OK) {
            sqlite3_exec(sessDb,
                "CREATE TABLE IF NOT EXISTS game_sessions ("
                "  session_id TEXT PRIMARY KEY,"
                "  room_id INTEGER,"
                "  game_id TEXT,"
                "  map_id TEXT,"
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
        std::string section, scope, game;
        uint64_t since = 0;
        auto qLimit = QueryParam(url, "limit");
        if (!qLimit.empty()) limit = atoi(qLimit.c_str());
        auto qLevel = QueryParam(url, "level");
        if (!qLevel.empty()) minLevel = (uint8_t)atoi(qLevel.c_str());
        section = QueryParam(url, "section");
        scope = QueryParam(url, "scope");
        game = QueryParam(url, "game");
        auto qSince = QueryParam(url, "since");
        if (!qSince.empty()) since = strtoull(qSince.c_str(), nullptr, 10);

        // Ring buffer holds only this process's own + browser-ingested logs
        // (game-server logs reach us via the shared SQLite file). Use it only
        // for the aggregate (roomId 0) with no game/since narrowing — anything
        // more specific goes straight to SQLite where the room/game tags live.
        std::string json;
        auto entries = (roomId == 0 && game.empty() && since == 0)
            ? g_logBuffer.Query(roomId, 0, limit, minLevel, section, scope)
            : std::vector<BufferedLogEntry>{};
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
                std::string sql = "SELECT id, timestamp, level, section, scope, process, frame, message, room_id, game_id "
                    "FROM debug_logs WHERE level >= " + std::to_string(minLevel);
                if (roomId != 0) sql += " AND room_id = " + std::to_string(roomId);
                if (!game.empty()) sql += " AND game_id = '" + SqlEscape(game) + "'";
                if (since != 0) sql += " AND timestamp >= " + std::to_string(since);
                if (!section.empty()) sql += " AND section = '" + SqlEscape(section) + "'";
                if (!scope.empty()) sql += " AND scope = '" + SqlEscape(scope) + "'";
                sql += " ORDER BY id DESC LIMIT " + std::to_string(limit);

                json = "[";
                bool first = true;
                auto cb = [](void* data, int ncols, char** vals, char** /*names*/) -> int {
                    auto* pair = static_cast<std::pair<std::string*, bool*>*>(data);
                    if (!*pair->second) *pair->first += ",";
                    *pair->second = false;
                    std::string entry;
                    entry += R"({"id":)" + std::string(vals[0] ? vals[0] : "0");
                    entry += R"(,"timestamp":)" + std::string(vals[1] ? vals[1] : "0");
                    entry += R"(,"level":)" + std::string(vals[2] ? vals[2] : "0");
                    entry += R"(,"section":")" + JsonEscape(vals[3] ? vals[3] : "") + "\"";
                    entry += R"(,"scope":")" + JsonEscape(vals[4] ? vals[4] : "") + "\"";
                    entry += R"(,"process":")" + JsonEscape(vals[5] ? vals[5] : "") + "\"";
                    entry += R"(,"frame":)" + std::string(vals[6] ? vals[6] : "0");
                    entry += R"(,"room_id":)" + std::string(vals[8] ? vals[8] : "0");
                    entry += R"(,"game_id":")" + JsonEscape(vals[9] ? vals[9] : "") + "\"";
                    entry += R"(,"message":")" + JsonEscape(vals[7] ? vals[7] : "") + "\"}";
                    *pair->first += entry;
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
        // Optional scope filters — narrow a search to one room/game/section
        // and/or a recent time window so results aren't a flood of history.
        uint32_t room = (uint32_t)atoi(QueryParam(url, "room").c_str());
        std::string game = QueryParam(url, "game");
        std::string section = QueryParam(url, "section");
        uint64_t since = strtoull(QueryParam(url, "since").c_str(), nullptr, 10);

        // Try ring buffer first (logserver-own + browser-ingested logs)
        auto entries = g_logBuffer.Query(0, 0, limit * 5, minLevel);
        std::string json = "[";
        int count = 0;
        for (auto& e : entries) {
            if (count >= limit) break;
            if (!query.empty() && e.message.find(query) == std::string::npos) continue;
            if (room != 0 && e.room_id != room) continue;
            if (!game.empty() && e.game_id != game) continue;
            if (!section.empty() && e.section != section) continue;
            if (since != 0 && e.timestamp < since) continue;
            if (count > 0) json += ",";
            json += LogEntryToJson(e);
            count++;
        }

        // Fall back to SQLite for the persisted store (game-server logs live
        // only here). Hit it whenever the ring buffer came up empty and the
        // caller gave at least one selector.
        bool haveSelector = !query.empty() || room != 0 || !game.empty() || !section.empty();
        if (count == 0 && haveSelector) {
            sqlite3* db = nullptr;
            if (sqlite3_open_v2(g_dbPath.c_str(), &db, SQLITE_OPEN_READONLY, nullptr) == SQLITE_OK) {
                std::string sql = "SELECT id, timestamp, level, section, scope, process, frame, message, room_id, game_id "
                    "FROM debug_logs WHERE level >= " + std::to_string(minLevel);
                if (!query.empty()) sql += " AND message LIKE '%" + SqlEscape(query) + "%'";
                if (room != 0) sql += " AND room_id = " + std::to_string(room);
                if (!game.empty()) sql += " AND game_id = '" + SqlEscape(game) + "'";
                if (!section.empty()) sql += " AND section = '" + SqlEscape(section) + "'";
                if (since != 0) sql += " AND timestamp >= " + std::to_string(since);
                sql += " ORDER BY id DESC LIMIT " + std::to_string(limit);
                bool first = true;
                auto cb = [](void* data, int ncols, char** vals, char** /*names*/) -> int {
                    auto* pair = static_cast<std::pair<std::string*, bool*>*>(data);
                    if (!*pair->second) *pair->first += ",";
                    *pair->second = false;
                    std::string entry;
                    entry += R"({"id":)" + std::string(vals[0] ? vals[0] : "0");
                    entry += R"(,"timestamp":)" + std::string(vals[1] ? vals[1] : "0");
                    entry += R"(,"level":)" + std::string(vals[2] ? vals[2] : "0");
                    entry += R"(,"section":")" + JsonEscape(vals[3] ? vals[3] : "") + "\"";
                    entry += R"(,"scope":")" + JsonEscape(vals[4] ? vals[4] : "") + "\"";
                    entry += R"(,"process":")" + JsonEscape(vals[5] ? vals[5] : "") + "\"";
                    entry += R"(,"frame":)" + std::string(vals[6] ? vals[6] : "0");
                    entry += R"(,"room_id":)" + std::string(vals[8] ? vals[8] : "0");
                    entry += R"(,"game_id":")" + JsonEscape(vals[9] ? vals[9] : "") + "\"";
                    entry += R"(,"message":")" + JsonEscape(vals[7] ? vals[7] : "") + "\"}";
                    *pair->first += entry;
                    return 0;
                };
                auto pair = std::make_pair(&json, &first);
                sqlite3_exec(db, sql.c_str(), cb, &pair, nullptr);
                sqlite3_close(db);
            }
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
                    R"({"session_id":"%s","room_id":%s,"game_id":"%s","map_id":"%s","started_at":%s,"ended_at":%s,"end_reason":"%s","exit_code":%s})",
                    vals[0] ? vals[0] : "", vals[1] ? vals[1] : "0",
                    vals[2] ? vals[2] : "", vals[3] ? vals[3] : "",
                    vals[4] ? vals[4] : "0", vals[5] ? vals[5] : "0",
                    vals[6] ? vals[6] : "", vals[7] ? vals[7] : "0");
                *out.first += buf;
                return 0;
            };
            auto pair = std::make_pair(&json, &first);
            sqlite3_exec(db,
                "SELECT session_id, room_id, game_id, map_id, started_at, ended_at, end_reason, exit_code "
                "FROM game_sessions ORDER BY started_at DESC LIMIT 50",
                cb, &pair, nullptr);
            json += "]";
            sqlite3_close(db);
        }
        return {.contentType = "application/json",
                .body = {json.begin(), json.end()}, .status = 200};
    });

    // POST endpoint for client-side log ingestion. Browser code (the LuaUI
    // worker, the chrome-devtools console wrapper, etc.) POSTs JSON entries
    // here so they land in the same SQLite + ring buffer + SSE stream as
    // server-side logs. The body is either a single entry object or
    // {"entries":[...]}; each entry has level/section/scope/process/message.
    //
    // We parse with our own minimal JSON helper to avoid pulling in a full
    // library — the schema is narrow and stable, and we already use a
    // similar approach for test-event.
    net.AddHttpPost("/api/logs/ingest", [](const std::string&, const std::string& body,
                                            const HttpRequestHeaders&) -> HttpResponse {
        // Locate either a top-level entry (no "entries" key) or each
        // element in the entries array. We slice the array string and walk
        // brace-balanced object substrings — the entries are flat, so a
        // depth counter is sufficient.
        auto ingestOne = [](const std::string& obj) {
            int level = JsonGetInt(obj, "level", SPRING_LOG_NOTICE);
            int frame = JsonGetInt(obj, "frame", 0);
            int roomId = JsonGetInt(obj, "room_id", 0);
            std::string section = JsonGetString(obj, "section");
            std::string scope = JsonGetString(obj, "scope");
            std::string process = JsonGetString(obj, "process");
            std::string message = JsonGetString(obj, "message");
            std::string gameId = JsonGetString(obj, "game_id");
            if (section.empty()) section = "client";
            if (process.empty()) process = "browser";

            SpringLogRecord rec{};
            rec.timestamp = (uint64_t)
                std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count();
            rec.level = level;
            rec.section = section.c_str();
            rec.scope = scope.c_str();
            rec.process = process.c_str();
            rec.frame = frame;
            rec.message = message.c_str();
            // Browser logs may carry their own room/game so client-side
            // widget logs filter alongside server logs for the same room.
            rec.room_id = (uint32_t)roomId;
            rec.game_id = gameId.c_str();
            // springlog_emit preserves the caller-provided process tag and
            // dispatches to every registered sink (console + SQLite + our
            // ring-buffer/SSE sink) so the entry is discoverable via
            // spring-debug, the SSE log stream, and the persisted DB.
            springlog_emit(&rec);
        };

        size_t epos = body.find("\"entries\"");
        if (epos != std::string::npos) {
            auto arrStart = body.find('[', epos);
            if (arrStart == std::string::npos) {
                std::string err = "{\"ok\":false,\"error\":\"entries not array\"}";
                return {.contentType = "application/json",
                        .body = {err.begin(), err.end()}, .status = 400};
            }
            int depth = 0;
            size_t objStart = std::string::npos;
            int count = 0;
            for (size_t i = arrStart + 1; i < body.size(); i++) {
                char c = body[i];
                if (c == '{') {
                    if (depth == 0) objStart = i;
                    depth++;
                } else if (c == '}') {
                    depth--;
                    if (depth == 0 && objStart != std::string::npos) {
                        ingestOne(body.substr(objStart, i - objStart + 1));
                        objStart = std::string::npos;
                        count++;
                    }
                } else if (c == ']' && depth == 0) {
                    break;
                }
            }
            std::string resp = "{\"ok\":true,\"count\":" + std::to_string(count) + "}";
            return {.contentType = "application/json",
                    .body = {resp.begin(), resp.end()}, .status = 200};
        }

        // Single-entry form
        ingestOne(body);
        std::string resp = "{\"ok\":true,\"count\":1}";
        return {.contentType = "application/json",
                .body = {resp.begin(), resp.end()}, .status = 200};
    });

    // POST endpoint for SSE testing — generates a synthetic log event
    net.AddHttpPost("/api/logs/test-event", [](const std::string&, const std::string& body,
                                                const HttpRequestHeaders&) -> HttpResponse {
        // Parse optional message from body
        std::string msg = "test event";
        auto mpos = body.find("\"message\"");
        if (mpos != std::string::npos) {
            auto vstart = body.find('"', body.find(':', mpos) + 1);
            auto vend = body.find('"', vstart + 1);
            if (vstart != std::string::npos && vend != std::string::npos)
                msg = body.substr(vstart + 1, vend - vstart - 1);
        }

        // Push to SSE subscribers
        std::string json = "{\"level\":2,\"section\":\"test\",\"message\":\""
            + JsonEscape(msg) + "\"}";
        g_server->SendSSE(g_logStreamChannel, json, "log");

        std::string resp = "{\"ok\":true,\"message\":\"" + JsonEscape(msg) + "\"}";
        return {.contentType = "application/json",
                .body = {resp.begin(), resp.end()}, .status = 200};
    });

    // POST /api/logs/restart — re-exec this process in place (same pid).
    // Used by the MCP `restart_logserver` tool after rebuilding the binary;
    // keeps mprocs authoritative over the pid (no kill + respawn). Sets the
    // restart flag + wakes the run loop; the actual execvp happens on the
    // main thread once the network server has stopped.
    net.AddHttpPost("/api/logs/restart", [](const std::string&, const std::string&,
                                            const HttpRequestHeaders&) -> HttpResponse {
        g_restart.store(true);
        g_shutdown.store(true);
        const char* resp = "{\"ok\":true,\"message\":\"restarting log server...\"}";
        return {.contentType = "application/json",
                .body = {resp, resp + strlen(resp)}, .status = 200};
    });

    net.Start(g_port);

    // Run until a stop/restart is requested. Poll the atomics rather than
    // pause() so the HTTP restart endpoint (network thread) can wake us
    // without relying on cross-thread signal delivery.
    SLOG(SPRING_LOG_NOTICE,
        "log server running (SIGINT=stop, SIGHUP/POST /api/logs/restart=re-exec)");
    while (!g_shutdown.load()) {
        struct timespec ts{0, 200L * 1000 * 1000};  // 200 ms
        nanosleep(&ts, nullptr);
    }

    net.Stop();
    g_server = nullptr;

    // Re-exec in place if a restart was requested — replaces the process
    // image so the pid is preserved (mprocs stays authoritative). Matches
    // the lobby's execvp restart path.
    if (g_restart.load()) {
        SLOG(SPRING_LOG_NOTICE, "re-exec'ing: %s", g_savedArgv[0]);
        springlog_sqlite_shutdown();
        springlog_shutdown();
        execvp(g_savedArgv[0], g_savedArgv);
        // Only reached if execvp failed.
        fprintf(stderr, "ERROR: log server restart failed: %s\n", strerror(errno));
        return 1;
    }
    springlog_sqlite_shutdown();
    springlog_shutdown();
    return 0;
}
