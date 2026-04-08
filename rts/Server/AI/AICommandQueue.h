// AICommandQueue — thread-safe MPSC queue for AI commands back to sim.
//
// AI worker threads push commands here; the sim thread drains them
// each tick and applies them through the normal command pipeline.
#pragma once

#include <cstdint>
#include <mutex>
#include <vector>

/// A command from an AI to be applied to the sim.
struct AICommand {
    int teamId = 0;
    uint32_t unitId = 0;
    int commandId = 0;     // CMD_MOVE, CMD_ATTACK, etc.
    float params[8] = {};
    int numParams = 0;
    uint8_t options = 0;
};

class AICommandQueue {
public:
    /// Push a command (called from AI worker thread).
    void Push(const AICommand& cmd) {
        std::lock_guard<std::mutex> lock(mutex);
        queue.push_back(cmd);
    }

    /// Drain all pending commands (called from sim thread).
    std::vector<AICommand> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<AICommand> drained;
        drained.swap(queue);
        return drained;
    }

    size_t Size() const {
        std::lock_guard<std::mutex> lock(mutex);
        return queue.size();
    }

private:
    mutable std::mutex mutex;
    std::vector<AICommand> queue;
};

/// Global AI command queue.
extern AICommandQueue aiCommandQueue;
