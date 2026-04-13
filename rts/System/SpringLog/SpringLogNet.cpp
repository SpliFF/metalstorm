// SpringLogNet — WebSocket network sink for springlog.
//
// Connects to the log server as a WS client and streams LogIngest
// messages. Batches entries and flushes periodically to reduce
// overhead. Uses uWebSockets client connect().

#include "SpringLogNet.h"
#include "SpringLog.h"

#include <string>
#include <vector>
#include <mutex>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstring>

// Forward-declare FlatBuffers types to avoid header dependency in this stub
// The real implementation will include protocol_generated.h and uWS headers.

static int g_netSinkId = -1;
static std::atomic<bool> g_netConnected{false};
static std::mutex g_netMutex;

struct PendingEntry {
    uint64_t timestamp;
    int level;
    std::string section;
    std::string scope;
    std::string process;
    std::string message;
    int frame;
};

static std::vector<PendingEntry> g_pendingEntries;
static constexpr size_t MAX_PENDING = 1000;

static void NetSinkFn(const SpringLogRecord* record, void* /*userdata*/) {
    // Buffer entries for batch send
    std::lock_guard<std::mutex> lock(g_netMutex);
    if (g_pendingEntries.size() >= MAX_PENDING) return; // drop if buffer full

    g_pendingEntries.push_back({
        record->timestamp,
        record->level,
        record->section ? record->section : "",
        record->scope ? record->scope : "",
        record->process ? record->process : "",
        record->message ? record->message : "",
        record->frame
    });
}

int springlog_net_init(const char* url, const char* token) {
    if (!url || !url[0]) return -1;

    // Register the sink — entries will be buffered until the WS
    // connection is established. For now this is a collection-only
    // stub; the actual WS client will be wired when the log server
    // exists and can accept connections.
    g_netSinkId = springlog_add_sink(NetSinkFn, nullptr);

    // TODO: Start WS client thread connecting to `url` with `token`
    // and flush g_pendingEntries as LogIngest messages.
    (void)token;

    return 0;
}

void springlog_net_shutdown(void) {
    if (g_netSinkId >= 0) {
        springlog_remove_sink(g_netSinkId);
        g_netSinkId = -1;
    }
    g_netConnected.store(false);
    std::lock_guard<std::mutex> lock(g_netMutex);
    g_pendingEntries.clear();
}
