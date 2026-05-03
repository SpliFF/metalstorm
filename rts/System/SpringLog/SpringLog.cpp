// SpringLog core — console + file sinks, pluggable sink dispatch.
// Zero mandatory dependencies beyond C stdio + POSIX.

#include "SpringLog.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <mutex>
#include <vector>

// --- Internal state ---

static const char* g_processName = "unknown";
static uint32_t g_outputs = SPRING_LOG_OUTPUT_CONSOLE;
static int g_minLevel = SPRING_LOG_NOTICE;
static FILE* g_logFile = nullptr;
static std::mutex g_mutex;

// Thread-local sim frame
static thread_local int tl_frame = 0;

// Custom sinks
struct SinkEntry {
    SpringLogSinkFn fn;
    void* userdata;
    int id;
    bool active;
};
static std::vector<SinkEntry> g_sinks;
static int g_nextSinkId = 1;

// Format buffer (per-call, mutex-protected)
static char g_msgBuf[8192];

static const char* LevelStr(int level) {
    switch (level) {
        case SPRING_LOG_DEBUG:   return "DEBUG";
        case SPRING_LOG_INFO:    return "INFO";
        case SPRING_LOG_NOTICE:  return "NOTICE";
        case SPRING_LOG_WARNING: return "WARN";
        case SPRING_LOG_ERROR:   return "ERROR";
        case SPRING_LOG_FATAL:   return "FATAL";
        default:                 return "???";
    }
}

static uint64_t NowMs() {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

// --- Public API ---

void springlog_init(const char* processName, uint32_t outputs) {
    g_processName = processName ? processName : "unknown";
    g_outputs = outputs;

    // Check environment overrides
    const char* envLevel = getenv("SPRING_LOG_LEVEL");
    if (envLevel) {
        if      (strcmp(envLevel, "debug") == 0)   g_minLevel = SPRING_LOG_DEBUG;
        else if (strcmp(envLevel, "info") == 0)     g_minLevel = SPRING_LOG_INFO;
        else if (strcmp(envLevel, "notice") == 0)   g_minLevel = SPRING_LOG_NOTICE;
        else if (strcmp(envLevel, "warning") == 0)  g_minLevel = SPRING_LOG_WARNING;
        else if (strcmp(envLevel, "error") == 0)    g_minLevel = SPRING_LOG_ERROR;
        else if (strcmp(envLevel, "fatal") == 0)    g_minLevel = SPRING_LOG_FATAL;
    }

    const char* envFile = getenv("SPRING_LOG_FILE");
    if (envFile) springlog_set_file(envFile);

    const char* envDebug = getenv("SPRING_DEBUG");
    if (envDebug && strcmp(envDebug, "1") == 0) g_minLevel = SPRING_LOG_DEBUG;
}

void springlog_set_file(const char* path) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_logFile) { fclose(g_logFile); g_logFile = nullptr; }
    if (path && path[0]) {
        g_logFile = fopen(path, "a");
        if (g_logFile) g_outputs |= SPRING_LOG_OUTPUT_FILE;
    }
}

void springlog_set_min_level(int level) {
    g_minLevel = level;
}

void springlog_set_outputs(uint32_t outputs) {
    g_outputs = outputs;
}

void springlog_set_frame(int frame) {
    tl_frame = frame;
}

int springlog_get_frame(void) {
    return tl_frame;
}

int springlog_add_sink(SpringLogSinkFn fn, void* userdata) {
    std::lock_guard<std::mutex> lock(g_mutex);
    int id = g_nextSinkId++;
    g_sinks.push_back({fn, userdata, id, true});
    return id;
}

void springlog_remove_sink(int id) {
    std::lock_guard<std::mutex> lock(g_mutex);
    for (auto& s : g_sinks) {
        if (s.id == id) { s.active = false; break; }
    }
}

void springlog_logv(int level, const char* section, const char* scope,
                    int frame, const char* fmt, va_list args) {
    if (level < g_minLevel) return;
    if (!section) section = "";
    if (!scope) scope = "";
    if (frame < 0) frame = tl_frame;

    std::lock_guard<std::mutex> lock(g_mutex);

    vsnprintf(g_msgBuf, sizeof(g_msgBuf), fmt, args);

    SpringLogRecord rec;
    rec.timestamp = NowMs();
    rec.level     = level;
    rec.section   = section;
    rec.scope     = scope;
    rec.process   = g_processName;
    rec.frame     = frame;
    rec.message   = g_msgBuf;

    // Console sink
    if (g_outputs & SPRING_LOG_OUTPUT_CONSOLE) {
        FILE* out = (level >= SPRING_LOG_ERROR) ? stderr : stdout;
        if (scope[0]) {
            fprintf(out, "[%s:%s:%s] %s\n", g_processName, section, scope, g_msgBuf);
        } else {
            fprintf(out, "[%s:%s] %s\n", g_processName, section, g_msgBuf);
        }
        fflush(out);
    }

    // File sink
    if ((g_outputs & SPRING_LOG_OUTPUT_FILE) && g_logFile) {
        fprintf(g_logFile, "@L|%s|%s|%s|%d|%s\n",
                LevelStr(level), section, scope, frame, g_msgBuf);
        fflush(g_logFile);
    }

    // Custom sinks
    for (auto& s : g_sinks) {
        if (s.active) s.fn(&rec, s.userdata);
    }
}

void springlog_emit(const SpringLogRecord* record) {
    if (!record) return;
    if (record->level < g_minLevel) return;

    std::lock_guard<std::mutex> lock(g_mutex);

    const char* section = record->section ? record->section : "";
    const char* scope   = record->scope ? record->scope : "";
    const char* process = record->process ? record->process : g_processName;
    const char* message = record->message ? record->message : "";

    if (g_outputs & SPRING_LOG_OUTPUT_CONSOLE) {
        FILE* out = (record->level >= SPRING_LOG_ERROR) ? stderr : stdout;
        if (scope[0]) {
            fprintf(out, "[%s:%s:%s] %s\n", process, section, scope, message);
        } else {
            fprintf(out, "[%s:%s] %s\n", process, section, message);
        }
        fflush(out);
    }

    if ((g_outputs & SPRING_LOG_OUTPUT_FILE) && g_logFile) {
        fprintf(g_logFile, "@L|%s|%s|%s|%d|%s\n",
                LevelStr(record->level), section, scope, record->frame, message);
        fflush(g_logFile);
    }

    SpringLogRecord rec = *record;
    rec.section = section;
    rec.scope = scope;
    rec.process = process;
    rec.message = message;

    for (auto& s : g_sinks) {
        if (s.active) s.fn(&rec, s.userdata);
    }
}

void springlog_log(int level, const char* section, const char* scope,
                   int frame, const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    springlog_logv(level, section, scope, frame, fmt, args);
    va_end(args);
}

void springlog_shutdown(void) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_logFile) { fclose(g_logFile); g_logFile = nullptr; }
    g_sinks.clear();
}
