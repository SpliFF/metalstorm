// LuaExecEngine — thread-safe queue for executing Lua code and
// server commands in specific scopes (LuaRules, LuaGaia, LuaAI, server).
//
// The HTTP/WS thread pushes requests; the sim thread pops and
// executes them each tick, then fulfils the result promise.

#pragma once

#include <string>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <unordered_map>
#include <cstdint>
#include <atomic>

struct LuaExecRequest {
    uint32_t requestId;
    std::string scope;     // "LuaRules", "LuaGaia", "LuaAI:<name>", "server"
    std::string code;
    uint32_t clientId;     // who sent it (for routing response)
};

struct LuaExecResult {
    uint32_t requestId;
    std::string scope;
    bool success;
    std::string output;
    uint32_t clientId;
};

class LuaExecEngine {
public:
    void Push(LuaExecRequest req) {
        std::lock_guard<std::mutex> lock(mutex_);
        pending_.push(std::move(req));
    }

    bool TryPop(LuaExecRequest& out) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (pending_.empty()) return false;
        out = std::move(pending_.front());
        pending_.pop();
        return true;
    }

    bool HasPending() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return !pending_.empty();
    }

    /// Push a request and block until the sim thread processes it.
    /// Returns the result. Safe to call from any thread (HTTP handler).
    /// Timeout in milliseconds, returns error on timeout.
    LuaExecResult ExecSync(const std::string& scope, const std::string& code,
                           int timeoutMs = 5000) {
        uint32_t reqId = nextSyncId_.fetch_add(1);
        LuaExecRequest req;
        req.requestId = reqId;
        req.scope = scope;
        req.code = code;
        req.clientId = 0; // no WS client

        // Register a result slot
        {
            std::lock_guard<std::mutex> lock(resultMutex_);
            pendingResults_[reqId] = {};
        }

        // Push to queue
        Push(req);

        // Wait for result
        std::unique_lock<std::mutex> lock(resultMutex_);
        bool ok = resultCv_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] {
            return pendingResults_.count(reqId) && pendingResults_[reqId].requestId != 0;
        });

        if (!ok) {
            pendingResults_.erase(reqId);
            return {reqId, scope, false, "timeout waiting for sim thread", 0};
        }

        LuaExecResult result = std::move(pendingResults_[reqId]);
        pendingResults_.erase(reqId);
        return result;
    }

    /// Called by the sim thread after executing a request to deliver
    /// the result to any waiting ExecSync caller.
    void DeliverResult(const LuaExecResult& result) {
        std::lock_guard<std::mutex> lock(resultMutex_);
        if (pendingResults_.count(result.requestId)) {
            pendingResults_[result.requestId] = result;
            resultCv_.notify_all();
        }
    }

private:
    mutable std::mutex mutex_;
    std::queue<LuaExecRequest> pending_;

    // Sync exec support
    std::atomic<uint32_t> nextSyncId_{0x80000000}; // high range to avoid collision with WS requestIds
    std::mutex resultMutex_;
    std::condition_variable resultCv_;
    std::unordered_map<uint32_t, LuaExecResult> pendingResults_;
};

/// Execute a request in the appropriate Lua/server scope.
/// Called from the sim thread.
LuaExecResult ExecuteLuaExecRequest(const LuaExecRequest& req);

/// Tri-state result of a synced-Lua predicate poll (headless-run stop condition).
enum class SyncedPredicateResult { False, True, Error };

/// Evaluate `expr` as a boolean predicate in the LuaRules synced Lua state
/// (e.g. "GG.Balance.Done"). Returns Error — and fills `errOut` — when LuaRules
/// is not loaded, the chunk fails to compile, or it raises at runtime. The
/// first returned value is coerced with Lua truthiness. Must run on the sim
/// thread. Used by the --headless-run stop-condition poller (PLAN-headless §1).
SyncedPredicateResult EvalSyncedPredicate(const std::string& expr,
                                          std::string& errOut);

/// Current LuaRules synced-Lua heap size in KB (0 if LuaRules isn't loaded).
/// Read-only (LUA_GCCOUNT), no GC side effect. Feeds the headless stats-dump
/// Lua-heap watermark field (PLAN-headless task 2, PLAN-long-uptime §S4).
int64_t GetSyncedLuaHeapKb();
