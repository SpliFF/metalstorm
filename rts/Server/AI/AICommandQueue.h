// AICommandQueue — thread-safe MPSC queue for AI commands back to sim.
//
// AI worker threads push commands here; the sim thread drains them
// each tick and applies them through the normal command pipeline.
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

/// What a queued AI command actually is. The AI's *only* write surface is
/// directive-shaped (PLAN-metalstorm-ai §1/§4 "strategic floor"): it creates
/// org groups, issues macro directives, and sets postures — the SAME verbs a
/// human player sends over the wire. `UnitCommand` is the pre-existing generic
/// per-unit path (used by the AI-VM boundary tests as an observability channel
/// and available to any non-Metalstorm tactical AI); the Metalstorm strategos
/// actuator never emits it — its strategic floor is enforced in game Lua by
/// simply having no squad-command verb (actuators.lua).
enum class AICommandKind : uint8_t {
    UnitCommand    = 0,   // legacy per-unit CMD_* (generic runtime + test channel)
    CreateGroup    = 1,   // org-group create  → OrgGroupManager::Create
    IssueDirective = 2,   // macro directive   → DirectiveManager::Create (+ charge)
    SetPosture     = 3,   // group posture     → OrgGroupManager::SetPosture
    LuaMsg         = 4,   // opaque game-Lua message → luaRules->RecvLuaMsg (I1/SG1)
};

/// Name of an AICommandKind, for logs and the `/api/journal` audit rows.
/// Lives beside the enum so a new kind has one place to be named; an unknown
/// value reports itself rather than an empty string, because the number it
/// carries is the only clue an operator would have.
inline const char* AICommandKindName(AICommandKind k) {
    switch (k) {
        case AICommandKind::UnitCommand:    return "unit-command";
        case AICommandKind::CreateGroup:    return "create-group";
        case AICommandKind::IssueDirective: return "issue-directive";
        case AICommandKind::SetPosture:     return "set-posture";
        case AICommandKind::LuaMsg:         return "lua-msg";
    }
    return "unknown";
}

/// I1/SG1 clamps for the LuaMsg verb. Structural backstops below the planner
/// (PLAN-ai-synced-write §2.4, the §8 E6 philosophy): a defeated or buggy
/// planner must not be able to flood the journal or the synced Lua state.
/// Both are engine-side, so no game-Lua change can lift them.
inline constexpr size_t kAILuaMsgMaxBytes   = 2048;  // rejected at push
inline constexpr int    kAILuaMsgPerDrain   = 16;    // per AI player, per batch

/// Per-drain LuaMsg budget. Lives here (not inside the drain loop) so the
/// clamp is unit-testable without a sim, and so the live drain and the replay
/// feed — which both run through StateStreamer::ApplyAICommands — count with
/// one implementation and therefore drop the same commands in both.
class AILuaMsgDrainBudget {
public:
    /// True if this player may deliver one more LuaMsg in this batch.
    bool TryConsume(int playerId) {
        int& used = perPlayer[playerId];
        if (used >= kAILuaMsgPerDrain) return false;
        ++used;
        return true;
    }

private:
    std::unordered_map<int, int> perPlayer;
};

/// A command from an AI to be applied to the sim on the sim thread. The drain
/// (StateStreamer::TickAI) routes each kind through the exact manager call +
/// charge callin a human player's wire message would hit, so AI and human
/// command handling are one code path.
struct AICommand {
    AICommandKind kind = AICommandKind::UnitCommand;
    int teamId = 0;
    // The AI's virtual playerID (PLAN-metalstorm-ai.md §1, AI3). Every AI slot
    // is a real CPlayer, so its commands attribute to its own playerID — this
    // is the charge identity the authority gate debits (authority_player_<id>),
    // never the team leader. -1 means "no attributed player" (pre-AI3 / tests).
    int playerId = -1;

    // --- UnitCommand ---
    uint32_t unitId = 0;
    int commandId = 0;     // CMD_MOVE, CMD_ATTACK, etc.
    float params[8] = {};
    int numParams = 0;
    uint8_t options = 0;

    // --- Directive-shaped verbs (CreateGroup / IssueDirective / SetPosture) ---
    // Group handle model: an AI can't get a return value synchronously (its
    // commands drain a tick or two later, PLAN-metalstorm-ai §6). So
    // createGroup returns a NEGATIVE client-local token immediately; the drain
    // resolves it to the real engine group id within the same batch (commands
    // drain in push order, and the actuator pushes createGroup before the
    // directive that references it). A positive handle is a real engine group
    // id (learned from a prior snapshot); 0 is condition/area scope.
    uint8_t  echelon = 1;                  // CreateGroup: Echelon (1 = Platoon)
    std::vector<uint32_t> squadIds;        // CreateGroup: roster
    uint32_t groupToken = 0;               // CreateGroup: the token it minted
    // IssueDirective / SetPosture target:
    uint32_t groupId = 0;                  //   real engine group id, or 0 = area
    uint32_t refToken = 0;                 //   if non-zero, groupId is deferred:
                                           //   resolve this same-batch createGroup token
    // IssueDirective payload (mirrors GroupDirective create fields):
    uint8_t  directiveType = 0;            // DirectiveType
    uint8_t  priority = 0;
    uint8_t  shape = 0;                    // OrderShape
    std::vector<float> directiveParams;    // shape geometry [x,y,z,(radius)...]
    uint32_t requestedStrength = 0;        // demand cap (0 = take what idles)
    uint32_t expiresInFrames = 0;
    // Optional area condition (within-circle) so an area-scoped directive draws
    // only squads near its target; 0 radius = wildcard (draw any idle squad).
    float    withinX = 0.0f, withinZ = 0.0f, withinRadius = 0.0f;
    // SetPosture payload (also reused for a group name on CreateGroup, and for
    // the LuaMsg verb's opaque game-Lua payload — the engine never parses it;
    // the parley/wire.lua codec and the gadget handlers own that schema):
    std::string text;                      // posture JSON | group name | LuaMsg bytes
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
