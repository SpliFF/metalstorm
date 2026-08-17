// ClientEvalBroker — correlates POST /api/client/eval (HTTP thread) with the
// addressed browser's ClientEvalResponse (sim thread, ClientMessageHandler).
//
// PLAN-test-automation P7. Same shape and thread topology as LuaExecEngine's
// ExecSync/DeliverResult waiters: the HTTP thread parks on a condition
// variable keyed by request_id, the sim thread resolves it while draining
// inbound client messages. Header-only on purpose — no state outside the
// map, nothing to link.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>

class ClientEvalBroker {
public:
    /// Register a slot addressed to `targetClientId`; the returned id goes
    /// into the outgoing ClientEvalRequest and comes back on the response.
    /// The top bit is set so relay ids can never be confused with the
    /// browser console's own ConsoleCommand request ids in a log.
    uint32_t Begin(uint32_t targetClientId) {
        const uint32_t id = (nextId_.fetch_add(1) & 0x7fffffffu) | 0x80000000u;
        std::lock_guard<std::mutex> lk(m_);
        pending_[id] = Slot{targetClientId};
        return id;
    }

    /// HTTP thread: block until Deliver() or timeout. Always erases the slot,
    /// so a late response finds no waiter and is dropped (and logged) rather
    /// than resolving a stranger's request.
    bool Wait(uint32_t id, int timeoutMs, bool& success, std::string& output) {
        std::unique_lock<std::mutex> lk(m_);
        const bool ok = cv_.wait_for(
            lk, std::chrono::milliseconds(timeoutMs), [&] {
                auto it = pending_.find(id);
                return it != pending_.end() && it->second.done;
            });
        auto it = pending_.find(id);
        if (!ok || it == pending_.end()) {
            pending_.erase(id);
            return false;
        }
        success = it->second.success;
        output  = std::move(it->second.output);
        pending_.erase(it);
        return true;
    }

    /// Sim thread: resolve the waiter — but ONLY if `sender` is the client the
    /// request was addressed to. Returns false for unknown ids (already timed
    /// out, or never ours) and for spoofed senders; the caller logs.
    bool Deliver(uint32_t id, uint32_t sender, bool success, std::string output) {
        std::lock_guard<std::mutex> lk(m_);
        auto it = pending_.find(id);
        if (it == pending_.end() || it->second.target != sender) return false;
        it->second.done    = true;
        it->second.success = success;
        it->second.output  = std::move(output);
        cv_.notify_all();
        return true;
    }

    /// Test/diagnostic: how many requests are parked right now.
    size_t PendingCount() const {
        std::lock_guard<std::mutex> lk(m_);
        return pending_.size();
    }

private:
    struct Slot {
        uint32_t    target  = 0;
        bool        done    = false;
        bool        success = false;
        std::string output;
    };

    mutable std::mutex      m_;
    std::condition_variable cv_;
    std::unordered_map<uint32_t, Slot> pending_;
    std::atomic<uint32_t>   nextId_{1};
};
