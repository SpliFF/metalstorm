// spring-logserver — dedicated log collection and streaming server.
//
// Receives LogIngest from any authenticated WS client (game servers,
// lobby, tools). Stores entries in SQLite (debug.db), maintains
// per-source ring buffers, streams LogBatch to subscribers, and
// serves HTTP query endpoints.

#include "System/SpringLog/SpringLog.h"
#include "System/SpringLog/SpringLogSqlite.h"
#include "protocol_generated.h"

#include <App.h>  // uWebSockets

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

// --- Per-connection state ---

struct ConnectionData {
    bool authenticated = false;
    bool subscribing = false;
    uint32_t subscribeRoomId = 0;
    uint8_t subscribeMinLevel = 0;
    std::string sectionFilter;
    std::string scopeFilter;
};

// --- Globals ---

static LogBuffer g_logBuffer;
static int g_port = 8010;
static std::string g_dbPath = "data/debug.db";

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
    SLOG(SPRING_LOG_NOTICE, "starting on port %d, db=%s", g_port, g_dbPath.c_str());

    // uWebSockets app
    uWS::App()
        // --- HTTP log query endpoints ---
        .get("/api/logs/:roomId", [](auto* res, auto* req) {
            auto roomStr = std::string(req->getParameter("roomId"));
            uint32_t roomId = (uint32_t)atoi(roomStr.c_str());

            // Parse query params
            int limit = 200;
            uint8_t minLevel = 0;
            std::string section, scope;
            auto qLimit = std::string(req->getQuery("limit"));
            if (!qLimit.empty()) limit = atoi(qLimit.c_str());
            auto qLevel = std::string(req->getQuery("level"));
            if (!qLevel.empty()) minLevel = (uint8_t)atoi(qLevel.c_str());
            section = std::string(req->getQuery("section"));
            scope = std::string(req->getQuery("scope"));

            auto entries = g_logBuffer.Query(roomId, 0, limit, minLevel, section, scope);
            std::string json = "[";
            for (size_t i = 0; i < entries.size(); i++) {
                if (i > 0) json += ",";
                json += LogEntryToJson(entries[i]);
            }
            json += "]";
            res->writeHeader("Content-Type", "application/json")
               ->writeHeader("Access-Control-Allow-Origin", "*")
               ->end(json);
        })
        .get("/api/logs/search", [](auto* res, auto* req) {
            std::string query = std::string(req->getQuery("q"));
            int limit = 200;
            uint8_t minLevel = 0;
            auto qLimit = std::string(req->getQuery("limit"));
            if (!qLimit.empty()) limit = atoi(qLimit.c_str());
            auto qLevel = std::string(req->getQuery("level"));
            if (!qLevel.empty()) minLevel = (uint8_t)atoi(qLevel.c_str());

            // Search across all sources
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
            res->writeHeader("Content-Type", "application/json")
               ->writeHeader("Access-Control-Allow-Origin", "*")
               ->end(json);
        })
        .get("/api/logs/sources", [](auto* res, auto* /*req*/) {
            // Return a simple status response
            std::string json = R"({"status":"ok"})";
            res->writeHeader("Content-Type", "application/json")
               ->writeHeader("Access-Control-Allow-Origin", "*")
               ->end(json);
        })
        // --- WebSocket for log ingestion + streaming ---
        .ws<ConnectionData>("/*", {
            .maxPayloadLength = 1024 * 1024,
            .open = [](uWS::WebSocket<false, true, ConnectionData>* ws) {
                auto* data = ws->getUserData();
                data->authenticated = true; // TODO: proper auth
                SLOG(SPRING_LOG_INFO, "log client connected");
            },
            .message = [](uWS::WebSocket<false, true, ConnectionData>* ws, std::string_view message, uWS::OpCode opCode) {
                if (opCode != uWS::BINARY || message.size() < 2) return;

                uint8_t envelope = (uint8_t)message[0];
                if (envelope != 0x01) return;

                auto* fbData = (const uint8_t*)message.data() + 1;

                auto clientMsg = flatbuffers::GetRoot<SpringWeb::ClientMessage>(fbData);
                if (!clientMsg || !clientMsg->payload()) return;

                auto payloadType = clientMsg->payload_type();

                if (payloadType == SpringWeb::ClientPayload_LogIngest) {
                    auto* ingest = clientMsg->payload_as_LogIngest();
                    if (!ingest || !ingest->entries()) return;

                    for (auto* entry : *ingest->entries()) {
                        BufferedLogEntry be;
                        be.timestamp = entry->timestamp();
                        be.level = entry->level();
                        be.section = entry->section() ? entry->section()->str() : "";
                        be.scope = entry->scope() ? entry->scope()->str() : "";
                        be.process = entry->process() ? entry->process()->str() : "";
                        be.message = entry->message() ? entry->message()->str() : "";
                        be.frame = entry->frame();
                        g_logBuffer.Append(0, std::move(be));
                    }
                }
                else if (payloadType == SpringWeb::ClientPayload_LogSubscribe) {
                    auto* sub = clientMsg->payload_as_LogSubscribe();
                    auto* data = ws->getUserData();
                    data->subscribing = true;
                    data->subscribeRoomId = sub ? sub->room_id() : 0;
                    data->subscribeMinLevel = sub ? sub->min_level() : 0;
                    data->sectionFilter = sub && sub->section_filter() ? sub->section_filter()->str() : "";
                    data->scopeFilter = sub && sub->scope_filter() ? sub->scope_filter()->str() : "";
                    SLOG(SPRING_LOG_INFO, "client subscribed to logs (room=%u, level>=%d)",
                         data->subscribeRoomId, data->subscribeMinLevel);
                }
                else if (payloadType == SpringWeb::ClientPayload_LogUnsubscribe) {
                    ws->getUserData()->subscribing = false;
                }
            },
            .close = [](uWS::WebSocket<false, true, ConnectionData>* /*ws*/, int /*code*/, std::string_view /*msg*/) {
                SLOG(SPRING_LOG_INFO, "log client disconnected");
            }
        })
        .listen(g_port, [](auto* listenSocket) {
            if (listenSocket) {
                SLOG(SPRING_LOG_NOTICE, "listening on port %d", g_port);
            } else {
                SLOG(SPRING_LOG_FATAL, "failed to listen on port %d", g_port);
                exit(1);
            }
        })
        .run();

    springlog_sqlite_shutdown();
    springlog_shutdown();
    return 0;
}
