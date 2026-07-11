/**
 * GmVerbs — Game-Master operations verb set (PLAN-gm-tools task 2).
 *
 * Registers the role-gated, audited POST /api/gm/<verb> routes on the game
 * server.
 * These are the "backchannel" of PLAN-gm-tools: since there is no lobby→game
 * HTTP client (lobby↔game coordination is shared-SQLite only), the *proven*
 * admin path is a direct authenticated POST to the game server's own HTTP
 * plane — exactly how /api/exec and /api/restart already work. The GM dashboard
 * (lobby-served) POSTs these with a shared admin token; the game server
 * validates it against the same users/sessions tables.
 *
 * Every verb: AdminOnly dispatch tag + a belt-and-braces in-handler role
 * recheck + a `Database::LogAudit` row (audit order is truth — E4). The surface
 * is deliberately small (pause/resume/grant/broadcast/inspect/kick + the
 * persistence-gated rollback/checkpoint/hibernate) — GMs repair via rollback +
 * grant + ban, they do not puppet the world (§1).
 *
 * Unlike /api/exec (arbitrary Lua RCE — compiled out under SPRING_PROD), these
 * verbs are the *production* GM surface and stay compiled in: each executes a
 * bounded, server-constructed action, never client-supplied code.
 *
 * ROLLBACK is the Opus-flagged verb. Its full semantics (pre-checkpoint →
 * restore → generation-nonce full-boot → broadcast → audit) live here and are
 * unit-tested against a mock store, but the creg snapshot engine that backs
 * them is PLAN-persistence's GameStateStore, which is NOT YET BUILT. Until it
 * lands the verb refuses cleanly (503, audited) via NullSnapshotStore rather
 * than faking a restore. See DoRollback + ISnapshotStore below.
 */
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct GameServerContext;

// ─────────────────────────── Rollback seam ───────────────────────────
// The read/restore surface the rollback verb needs. PLAN-persistence task 1
// (GameStateStore: creg walk → zstd → SQLite + restore) will implement this.

struct SnapshotInfo {
    int32_t frame = 0;
    int64_t takenAt = 0;      ///< unix seconds
    int64_t sizeBytes = 0;
    std::string label;        ///< "auto" | "pre-rollback" | game-over | reason
};

class ISnapshotStore {
public:
    virtual ~ISnapshotStore() = default;
    /// Is a snapshot/restore engine wired for this server at all? False today
    /// (NullSnapshotStore) — persistence is not built.
    virtual bool Available() const = 0;
    /// Snapshots available as rollback targets, newest frame first.
    virtual std::vector<SnapshotInfo> List(uint32_t roomId) = 0;
    /// Checkpoint the *current* state (the pre-rollback evidence/undo snapshot,
    /// E1). Returns the frame checkpointed, or <0 on failure (sets `err`).
    virtual int32_t Checkpoint(uint32_t roomId, const std::string& label, std::string& err) = 0;
    /// Restore the sim to `frame`. MUST run frame-atomically on the sim thread
    /// (a persistence-impl concern). Returns false + `err` on failure.
    virtual bool Restore(uint32_t roomId, int32_t frame, std::string& err) = 0;
};

/// The always-unavailable store used until PLAN-persistence lands. Makes the
/// rollback verb refuse honestly instead of pretending to snapshot/restore.
class NullSnapshotStore : public ISnapshotStore {
public:
    bool Available() const override { return false; }
    std::vector<SnapshotInfo> List(uint32_t) override { return {}; }
    int32_t Checkpoint(uint32_t, const std::string&, std::string& err) override {
        err = "persistence layer not built (PLAN-persistence GameStateStore)";
        return -1;
    }
    bool Restore(uint32_t, int32_t, std::string& err) override {
        err = "persistence layer not built (PLAN-persistence GameStateStore)";
        return false;
    }
};

// ──────────────────── Rollback orchestration (pure) ────────────────────

enum class GmRollbackStatus {
    Ok,
    Unavailable,       ///< no snapshot engine (persistence not built)
    NoSuchSnapshot,    ///< target frame not in the store
    CheckpointFailed,  ///< pre-rollback checkpoint failed → nothing changed
    RestoreFailed,     ///< restore failed after checkpoint → undo via preCheckpointFrame
};

struct GmRollbackOutcome {
    GmRollbackStatus status = GmRollbackStatus::Unavailable;
    int32_t targetFrame = -1;
    int32_t preCheckpointFrame = -1;  ///< the auto-checkpoint made before restore (E1 undo)
    bool checkpointed = false;
    bool restored = false;
    std::string error;
};

/// The rollback SEQUENCE, isolated from all IO so it is unit-testable against a
/// mock store (the Opus-flagged "careful semantics"):
///   1. store Available()             → else Unavailable (nothing touched)
///   2. targetFrame ∈ List()          → else NoSuchSnapshot
///   3. Checkpoint(current) FIRST      → else CheckpointFailed (nothing changed)
///   4. Restore(target)                → else RestoreFailed (undo = preCheckpointFrame)
/// The route handler wraps this with role-gating, audit rows, the generation-
/// nonce full-boot broadcast, and pause/resume framing.
GmRollbackOutcome DoRollback(ISnapshotStore& store, uint32_t roomId, int32_t targetFrame);

// ─────────────────────────── Registration ───────────────────────────

/// Register every POST /api/gm/* verb on ctx.net. `store` backs
/// rollback/checkpoint/hibernate — pass a NullSnapshotStore until persistence
/// lands (it must outlive the server loop).
void RegisterGmVerbs(GameServerContext& ctx, ISnapshotStore& store);

/// GM broadcast wire sentinel — a GM-authored message reaches clients as a
/// LuaUIMsgRelay whose payload begins with this prefix and player_id = -1. The
/// client worker intercepts it BEFORE widget dispatch (so it can never crash a
/// widget) and renders a system toast. Kept here so server + client agree.
inline constexpr const char* kGmBroadcastSentinel = "\x01GM\x01";
