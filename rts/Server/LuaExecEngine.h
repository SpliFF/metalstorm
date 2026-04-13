// LuaExecEngine — thread-safe queue for executing Lua code and
// server commands in specific scopes (LuaRules, LuaGaia, LuaAI, server).
//
// The HTTP/WS thread pushes requests; the sim thread pops and
// executes them each tick, then fulfils the result promise.

#pragma once

#include <string>
#include <queue>
#include <mutex>
#include <cstdint>

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

private:
    mutable std::mutex mutex_;
    std::queue<LuaExecRequest> pending_;
};

/// Execute a request in the appropriate Lua/server scope.
/// Called from the sim thread.
LuaExecResult ExecuteLuaExecRequest(const LuaExecRequest& req);
