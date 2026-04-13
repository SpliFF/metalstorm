// SpringLog — unified logging for all Spring RTS Web executables.
//
// Core depends only on C stdio + POSIX write(). Optional sinks
// (network, SQLite) are separate compilation units — consumers
// link only what they need.

#pragma once

#include <stdint.h>
#include <stdarg.h>

#ifdef __cplusplus
extern "C" {
#endif

// --- Log levels ---
enum SpringLogLevel {
    SPRING_LOG_DEBUG   = 0,
    SPRING_LOG_INFO    = 1,
    SPRING_LOG_NOTICE  = 2,
    SPRING_LOG_WARNING = 3,
    SPRING_LOG_ERROR   = 4,
    SPRING_LOG_FATAL   = 5,
};

// --- Log output modes (bitfield) ---
enum SpringLogOutput {
    SPRING_LOG_OUTPUT_CONSOLE = 0x01,
    SPRING_LOG_OUTPUT_FILE    = 0x02,
};

// --- Structured log record ---
typedef struct {
    uint64_t timestamp;      // ms since epoch
    int level;               // SpringLogLevel
    const char* section;     // "sim", "net", "lua", "lobby", etc.
    const char* scope;       // "LuaRules", "LuaGaia", "LuaAI:basic_ai", "" for non-Lua
    const char* process;     // "spring-server", "spring-lobby", etc.
    int frame;               // sim frame, 0 if not in sim context
    const char* message;     // formatted message
} SpringLogRecord;

// --- Pluggable sink interface ---
typedef void (*SpringLogSinkFn)(const SpringLogRecord* record, void* userdata);

// --- Initialisation ---
void springlog_init(const char* processName, uint32_t outputs);

// --- Configuration ---
void springlog_set_file(const char* path);
void springlog_set_min_level(int level);
void springlog_set_outputs(uint32_t outputs);

// --- Runtime state ---
void springlog_set_frame(int frame);
int  springlog_get_frame(void);

// --- Sink management ---
int  springlog_add_sink(SpringLogSinkFn fn, void* userdata);
void springlog_remove_sink(int id);

// --- Logging functions ---
void springlog_log(int level, const char* section, const char* scope,
                   int frame, const char* fmt, ...)
#ifdef __GNUC__
    __attribute__((format(printf, 5, 6)))
#endif
    ;

void springlog_logv(int level, const char* section, const char* scope,
                    int frame, const char* fmt, va_list args);

// --- Shutdown ---
void springlog_shutdown(void);

#ifdef __cplusplus
} // extern "C"

// --- C++ convenience wrappers ---
namespace SpringLog {

inline void Init(const char* process, uint32_t outputs) {
    springlog_init(process, outputs);
}
inline void Log(int level, const char* section, const char* scope,
                int frame, const char* fmt, ...)
#ifdef __GNUC__
    __attribute__((format(printf, 5, 6)))
#endif
    ;
inline void Log(int level, const char* section, const char* scope,
                int frame, const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    springlog_logv(level, section, scope, frame, fmt, args);
    va_end(args);
}
inline void SetFrame(int f) { springlog_set_frame(f); }
inline int  Frame()         { return springlog_get_frame(); }
inline void Shutdown()      { springlog_shutdown(); }

} // namespace SpringLog

// Convenience macros -- each source file defines LOG_SECTION
#define SLOG(level, fmt, ...) \
    springlog_log(level, LOG_SECTION, "", springlog_get_frame(), fmt, ##__VA_ARGS__)

#define SLOG_SCOPED(level, scope, fmt, ...) \
    springlog_log(level, LOG_SECTION, scope, springlog_get_frame(), fmt, ##__VA_ARGS__)

#endif // __cplusplus
