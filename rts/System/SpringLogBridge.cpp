// SpringLogBridge — routes the legacy Spring LOG() macro system
// through the unified springlog interface.
//
// Register this sink early in process startup so all existing
// LOG() / LOG_L() calls flow through springlog's sinks (console,
// file, network, SQLite).

#include "System/SpringLog/SpringLog.h"
#include "System/Log/LogSinkHandler.h"
#include "System/Log/Level.h"

namespace {

int MapSpringLevel(int springLevel) {
    // Spring log levels: LOG_LEVEL_DEBUG=20, INFO=30, NOTICE=0 (default),
    // WARNING=1, ERROR=3, FATAL=4. The numeric values are non-standard.
    if (springLevel >= LOG_LEVEL_FATAL)   return SPRING_LOG_FATAL;
    if (springLevel >= LOG_LEVEL_ERROR)   return SPRING_LOG_ERROR;
    if (springLevel >= LOG_LEVEL_WARNING) return SPRING_LOG_WARNING;
    if (springLevel >= LOG_LEVEL_NOTICE)  return SPRING_LOG_NOTICE;
    if (springLevel >= LOG_LEVEL_INFO)    return SPRING_LOG_INFO;
    return SPRING_LOG_DEBUG;
}

class SpringLogBridgeSink : public ILogSink {
public:
    void RecordLogMessage(int level, const std::string& section,
                          const std::string& text) override {
        int lvl = MapSpringLevel(level);
        springlog_log(lvl, section.c_str(), "",
                      springlog_get_frame(), "%s", text.c_str());
    }
};

SpringLogBridgeSink g_bridgeSink;

} // namespace

namespace SpringLogBridge {

void Install() {
    logSinkHandler.AddSink(&g_bridgeSink);
}

} // namespace SpringLogBridge
