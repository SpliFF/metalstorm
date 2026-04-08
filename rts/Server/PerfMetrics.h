// PerfMetrics — server-side performance monitoring.
//
// Tracks tick timing, entity counts, network throughput, and
// AI processing time. Logged periodically and available via
// HTTP endpoint for monitoring dashboards.
#pragma once

#include <chrono>
#include <cinttypes>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>

struct PerfSnapshot {
    // Timing (microseconds)
    int64_t tickTimeUs = 0;        // total sim tick time
    int64_t networkTimeUs = 0;     // time spent processing network
    int64_t aiTimeUs = 0;          // time spent on AI processing
    int64_t serializeTimeUs = 0;   // time spent serializing state

    // Counts
    int entityCount = 0;
    int clientCount = 0;
    int aiCount = 0;
    int combatEventsPerTick = 0;

    // Network
    int64_t bytesSentPerSec = 0;
    int64_t bytesRecvPerSec = 0;

    // Frame
    int frame = 0;
    float simFps = 0.0f;          // actual ticks per second
};

class PerfMetrics {
public:
    /// Start timing a section.
    void BeginTick() {
        tickStart = std::chrono::steady_clock::now();
    }

    /// End timing and record.
    void EndTick() {
        auto end = std::chrono::steady_clock::now();
        auto us = std::chrono::duration_cast<std::chrono::microseconds>(end - tickStart).count();

        std::lock_guard<std::mutex> lock(mutex);
        snapshot.tickTimeUs = us;
        tickCount++;

        // Compute FPS every second
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - fpsStart).count();
        if (elapsed >= 1000) {
            snapshot.simFps = tickCount * 1000.0f / elapsed;
            tickCount = 0;
            fpsStart = now;
        }
    }

    void SetEntityCount(int count) { snapshot.entityCount = count; }
    void SetClientCount(int count) { snapshot.clientCount = count; }
    void SetAICount(int count) { snapshot.aiCount = count; }
    void SetCombatEvents(int count) { snapshot.combatEventsPerTick = count; }
    void SetFrame(int frame) { snapshot.frame = frame; }

    /// Get the latest performance snapshot.
    PerfSnapshot GetSnapshot() const {
        std::lock_guard<std::mutex> lock(mutex);
        return snapshot;
    }

    /// Format as JSON for the HTTP endpoint.
    std::string ToJSON() const {
        auto s = GetSnapshot();
        char buf[512];
        snprintf(buf, sizeof(buf),
            "{\"frame\":%d,\"tickUs\":%" PRId64 ",\"simFps\":%.1f,"
            "\"entities\":%d,\"clients\":%d,\"ais\":%d,"
            "\"combatEvents\":%d}",
            s.frame, s.tickTimeUs, s.simFps,
            s.entityCount, s.clientCount, s.aiCount,
            s.combatEventsPerTick);
        return buf;
    }

private:
    mutable std::mutex mutex;
    PerfSnapshot snapshot;
    std::chrono::steady_clock::time_point tickStart;
    std::chrono::steady_clock::time_point fpsStart = std::chrono::steady_clock::now();
    int tickCount = 0;
};

extern PerfMetrics perfMetrics;
