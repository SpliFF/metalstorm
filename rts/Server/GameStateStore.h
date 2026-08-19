// GameStateStore — the durable half of game-state snapshots
// (PLAN-persistence.md task 1).
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// ---------------------------------------------
// PLAN-persistence task 1 was written as "the creg snapshot orchestrator":
// a between-tick creg walk of the sim, compressed and committed to SQLite.
// Its §1 review table asserts creg was "kept (Phase-0 removal reversed) and
// registered across Sim types".
//
// **That premise is false.** `rts/System/creg/` contains only stubs: every
// CR_DECLARE / CR_BIND / CR_MEMBER macro in creg_cond.h expands to nothing,
// Serializer.h is a two-line no-op, and SerializeLuaState.h is a seven-line
// no-op whose AutoRegisterCFunctions does nothing. The ~4,500 lines that
// implement creg upstream (creg.cpp, Serializer.cpp, VarTypes.cpp,
// SerializeLuaState.cpp, ISerializer.h, BasicTypes.h, TypeDeduction.h) are
// all absent. The 228 files that still carry CR_ macros are decorative — they
// produce zero runtime metadata. So there is nothing to "walk", and choosing
// what replaces creg is an open design question gated on the user
// (PLAN-persistence.md §2.1 "Q-P1").
//
// Everything *around* the walk, though, is mechanism-agnostic: durable
// framing, integrity, atomicity, retention, and the hash-stamped refusal
// rules are the same whatever produces the bytes. That is this module. It
// takes an opaque payload from an ISimSerializer and owns the rest:
//
//   * a self-describing blob frame (magic/version/hashes/sha256) that can be
//     validated standalone, decoupled from the SQLite row;
//   * compression (see "zstd → zlib" below);
//   * one snapshot = one SQLite transaction, so a kill mid-write leaves the
//     previous snapshot intact rather than a torn row;
//   * double-buffered writes: the sim thread serializes and hands off, a
//     worker compresses and commits, and the sim keeps ticking (§2's ≤1-tick
//     stall budget);
//   * the E1 refusal (engine/map hash mismatch → refuse loudly, never
//     half-load) and the E2 corruption ladder (sha256 per rung, fall back
//     through the retained K, flag unresumable when all rungs are bad);
//   * retention/prune.
//
// It implements ISnapshotStore (GmVerbs.h), so PLAN-gm-tools' rollback verb
// binds to it instead of NullSnapshotStore. Until a serializer is attached,
// Available() is false and every verb refuses with a *specific* reason naming
// the missing piece — an honest refusal, not a fake restore.
//
// PLAN-persistence §7.6 asks the phase-2 durable journal to share "the
// snapshot store's transaction discipline"; the framing + integrity helpers
// here (EncodeBlob/DecodeBlob) are that shared piece.
//
// ROOM SCOPING — why roomId is a per-call argument and not StoreConfig
// -------------------------------------------------------------------
// A snapshot's partition key is the PAIR (gameId, roomId). `gameId` alone is
// not an identity: it is the *content* id (`--game`, e.g. "metalstorm"), so
// every concurrent room of the same game carries the same one — and the lobby
// launches every game-server process against the same `--db`, so all of those
// rooms share one `game_snapshots` table. Partitioning on `game_id` alone let
// a second room's prune delete a first room's entire history and then let the
// first room restore the *second room's world* into its own sim, returning
// true. E1 cannot catch that: same engine, same map, same layout hash, so
// every stamp matches. Every read, restore, ladder walk and prune below binds
// both columns, and retention is last-K PER ROOM.
//
// The room is carried per call rather than in StoreConfig deliberately.
// ISnapshotStore (GmVerbs.h) already passes roomId on every method, so a
// StoreConfig field would create a second source of truth for the same fact,
// and there is no correct way to reconcile them at runtime: refusing on
// disagreement breaks a store that legitimately serves more than one room,
// and preferring either one silently discards a caller's argument — which is
// exactly the defect this scoping replaces. With no room in the config the
// store has no room opinion that can be wrong, and a caller's roomId is
// always the one that is honoured. StoreConfig keeps `gameId` because it is
// process-wide content identity that no interface method carries.
//
// DEVIATION — zstd → zlib deflate
// -------------------------------
// The plan specifies zstd. zstd is not a dependency of this build and adding
// a third-party library is out of this task's scope; zlib is already linked
// into spring-server, spring-lobby and spring-tests. Snapshots target
// single-digit MB, where deflate's worse ratio is immaterial. The blob header
// carries a `flags` codec field, so switching to zstd later is a new flag
// value plus a branch in DecodeBlob — old blobs keep decoding.
//
// We call zlib's compress/uncompress directly rather than the zlib::deflate /
// zlib::inflate helpers in System/StringUtil.h: those guess the decompressed
// size by doubling a buffer, while our header records rawSize exactly. Using
// it makes a size disagreement an integrity signal instead of a silent
// reallocation.
//
// PURITY
// ------
// Depends only on sqlite3, zlib, OpenSSL libcrypto and GmVerbs.h — no sim
// globals — so it links into spring-tests and its guarantees are covered by
// plain doctests (tests/test_game_state_store.cpp) driven by a synthetic
// serializer.
#pragma once

#include "Server/GmVerbs.h"   // ISnapshotStore, SnapshotInfo

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
// NOT <map>: `rts` is an include dir and `rts/Map/` shadows <map> on a
// case-insensitive filesystem (macOS). unordered_map has no such collision.
#include <unordered_map>
#include <vector>

struct sqlite3;

namespace gamestate {

// ───────────────────────── The payload seam ─────────────────────────
/// What creg was supposed to provide: something that can turn the full synced
/// sim state into bytes and back. Implementing this is the open question
/// (PLAN-persistence Q-P1) — this store is complete without it and refuses
/// honestly while none is attached.
///
/// THREADING: Serialize() and Deserialize() are called on the sim thread,
/// between ticks. Serialize() must be frame-atomic and should do no IO — the
/// store compresses and writes on a worker thread so the sim can resume.
class ISimSerializer {
public:
    virtual ~ISimSerializer() = default;

    /// Capture the current synced state into `out` (appended-to, not cleared
    /// by the caller). Return false + `err` to abort the checkpoint.
    virtual bool Serialize(std::vector<uint8_t>& out, std::string& err) = 0;

    /// Replace the synced state with the contents of `data`. Return false +
    /// `err` on failure; a failed Deserialize MUST leave the sim untouched
    /// rather than half-loaded (§2 "mismatches refuse loudly, never
    /// half-load").
    virtual bool Deserialize(const uint8_t* data, size_t size, std::string& err) = 0;

    /// Layout hash of the serialized shape. Any change to what Serialize()
    /// emits must change this; it is stamped into every blob and a mismatch
    /// refuses the load (E1).
    virtual uint64_t LayoutHash() const = 0;

    /// The sim frame the next Serialize() would capture.
    virtual int32_t Frame() const = 0;
};

// ───────────────────────── Blob framing (pure) ─────────────────────────

/// Bumped whenever the header layout below changes. A blob with a different
/// version is refused, never reinterpreted.
///
/// v2 (PLAN-def-reconciliation task 1) appended `defsHash`. A v1 blob is
/// therefore refused by this binary — deliberately, and it costs nothing that
/// matters: v1 blobs also carry a different LayoutHash (the payload gained the
/// `defNames` section in the same milestone), so E1 would refuse them one
/// field later anyway.
inline constexpr uint16_t kBlobVersion = 2;

/// Payload codec, stored in the header's `flags` field so the choice is
/// per-blob and future codecs decode alongside old ones.
enum class Codec : uint16_t {
    None    = 0,  ///< stored verbatim (used when deflate would inflate)
    Deflate = 1,  ///< zlib, the current default (see the zstd deviation above)
};

/// Fixed-width header prefixed to every stored blob. Little-endian on the
/// wire; see kHeaderSize for the byte layout.
struct BlobMeta {
    uint64_t engineHash = 0;   ///< build/engine identity (E1)
    uint64_t layoutHash = 0;   ///< ISimSerializer::LayoutHash (E1)
    uint8_t  mapDigest[32]{};  ///< sha256 of the processed-map hash string (E1)
    int32_t  frame = 0;
    uint64_t rawSize = 0;      ///< payload size before compression
    Codec    codec = Codec::Deflate;
    uint8_t  rawSha256[32]{};  ///< sha256 of the *uncompressed* payload (E2)
    /// Identity of the def vocabulary this snapshot was taken under
    /// (PLAN-def-reconciliation task 1). **Deliberately NOT an E1 hash**: a
    /// defs change is reported, never refused — §3 "reconcile is not
    /// optional" means a snapshot taken before a balance patch has to reach
    /// the restore path, or resuming a campaign across a patch is impossible.
    /// DecodeBlob therefore returns what the blob carries and compares
    /// nothing. 0 means "not recorded" (a snapshot taken before the key
    /// existed, i.e. early in boot).
    uint64_t defsHash = 0;
};

/// 4+2+2+8+8+4+4+8+8+32+32+8 — see EncodeBlob for the field order.
inline constexpr size_t kHeaderSize = 120;

/// Fold a defs content key (`DefsCache::ComputeContentKey`) into the header
/// word BlobMeta::defsHash carries. FNV-1a 64. Empty in, 0 out — the header
/// documents 0 as "not recorded", so a key that folded to it would be
/// indistinguishable from no key at all.
uint64_t DefsDigestOf(const std::string& defsKey);

/// Why a blob could not be turned back into a payload. The distinction is the
/// whole point of the E1/E2 split: a mismatch is a *policy* refusal (the
/// snapshot is intact, this binary just must not load it) while corruption is
/// a *durability* failure (fall back a rung).
enum class DecodeStatus {
    Ok,
    TooShort,           ///< truncated below the header, or short payload
    BadMagic,           ///< not a snapshot blob at all
    BadVersion,         ///< header layout from another engine generation
    UnknownCodec,
    EngineMismatch,     ///< E1: engineHash/layoutHash differ
    MapMismatch,        ///< E1: map was re-processed
    DecompressFailed,   ///< E2
    SizeMismatch,       ///< E2: inflated to a different length than recorded
    ChecksumMismatch,   ///< E2: sha256 of the payload does not match
};

const char* DecodeStatusName(DecodeStatus s);

/// True for the statuses that mean "this blob is damaged", i.e. the ones the
/// E2 ladder should step past. Mismatches are NOT corruption — every retained
/// rung would fail them identically, so the ladder stops instead of grinding.
bool IsCorruption(DecodeStatus s);

/// sha256 of `size` bytes, as 32 raw bytes into `out32`.
void Sha256(const uint8_t* data, size_t size, uint8_t* out32);
/// Lowercase hex of 32 raw bytes.
std::string HexDigest(const uint8_t* d32);

/// Frame `payload` into a self-describing, integrity-stamped blob. `meta`
/// supplies the hashes and frame; its rawSize/rawSha256/codec are filled in
/// from the payload and returned via `meta` so the caller can record them on
/// the SQLite row too.
std::vector<uint8_t> EncodeBlob(const std::vector<uint8_t>& payload, BlobMeta& meta);

/// Validate and unframe. `expect` carries the engine/layout/map identity this
/// process will accept — the hash checks (E1) run before decompression, so a
/// snapshot from another binary is refused without spending CPU on it. On
/// DecodeStatus::Ok, `payload` holds the original bytes and `meta` the header
/// as stored.
DecodeStatus DecodeBlob(const uint8_t* blob, size_t size, const BlobMeta& expect,
                        BlobMeta& meta, std::vector<uint8_t>& payload);

/// Compute the fixed-width map digest a BlobMeta carries from the
/// processed-map hash string the game server was started with.
void MapDigestOf(const std::string& mapHash, uint8_t* out32);

// ───────────────────────────── The store ─────────────────────────────

struct StoreConfig {
    /// Content id (`--game`). Half of the partition key — the other half is
    /// the per-call roomId; see "ROOM SCOPING" above for why it is not here.
    std::string gameId;
    uint64_t    engineHash = 0;  ///< this binary's identity (E1)
    std::string mapHash;         ///< processed-map hash (E1)
    /// Retention: how many snapshots to keep per (game, room). §2 default 3,
    /// which is also the depth of the E2 fallback ladder. Applied per room, so
    /// a busy room cannot prune a quiet one's history away.
    int retain = 3;
};

/// Per-store counters — the honest reporting surface for a subsystem whose
/// failures happen on a worker thread and would otherwise be invisible.
struct StoreStats {
    uint64_t checkpointsRequested = 0;
    uint64_t checkpointsCommitted = 0;
    uint64_t checkpointsFailed    = 0;
    uint64_t restores             = 0;
    uint64_t corruptRungsSkipped  = 0;  ///< E2 ladder steps taken
    uint64_t bytesWritten         = 0;
    uint64_t lastRawSize          = 0;
    uint64_t lastBlobSize         = 0;
    /// Microseconds the sim thread spent inside the last Checkpoint's
    /// serialize step — the ≤1-tick stall budget (§2) is measured on this,
    /// NOT on the total write, which happens off-thread.
    uint64_t lastSerializeUs      = 0;
};

class GameStateStore : public ISnapshotStore {
public:
    /// `db` must outlive the store and stay open. EnsureTables() is called
    /// here, so the caller does not have to.
    ///
    /// THREADING: the store serialises its own SQLite use internally, but it
    /// writes from a worker thread, so a handle shared with the main thread
    /// (e.g. Database's) requires SQLite's default serialized threading mode.
    /// Passing a handle opened exclusively for snapshots avoids the question.
    GameStateStore(sqlite3* db, StoreConfig cfg);
    ~GameStateStore() override;

    GameStateStore(const GameStateStore&) = delete;
    GameStateStore& operator=(const GameStateStore&) = delete;

    /// Create the game_snapshots table + index if absent. Idempotent; safe to
    /// call from the lobby (which owns pruning/vacuum scheduling) too.
    static void EnsureTables(sqlite3* db);

    /// Attach the thing that produces/consumes payloads. Until this is called
    /// the store is Available()==false and every verb refuses with a reason.
    void SetSerializer(ISimSerializer* s) { serializer = s; }
    ISimSerializer* Serializer() const { return serializer; }

    /// Record the def vocabulary snapshots are being taken under
    /// (PLAN-def-reconciliation task 1). Separate from StoreConfig because
    /// **boot order makes it impossible to supply at construction**: the store
    /// is built before the def cache has parsed a def, so the alternative is a
    /// config field that is empty for the first part of every process's life
    /// and looks like a configuration mistake. A snapshot taken before this is
    /// called stamps 0 = "not recorded" and is still fully restorable.
    void SetDefsHash(const std::string& defsKey) { defsHash = DefsDigestOf(defsKey); }
    uint64_t DefsHash() const { return defsHash; }

    // ── ISnapshotStore (the PLAN-gm-tools rollback seam) ──
    bool Available() const override;
    std::vector<SnapshotInfo> List(uint32_t roomId) override;
    /// Synchronous: serializes, then blocks until the row is committed, so a
    /// GM's pre-rollback undo snapshot (E1) is durable before the restore
    /// runs. The periodic cadence should use CheckpointAsync instead.
    int32_t Checkpoint(uint32_t roomId, const std::string& label, std::string& err) override;
    /// Restore the *exact* frame. Fails if that blob is damaged — a GM asked
    /// for that frame specifically, so silently landing on another one would
    /// be worse than refusing. Resume uses RestoreNewestValid (the E2 ladder).
    bool Restore(uint32_t roomId, int32_t frame, std::string& err) override;

    // ── Beyond the seam ──

    /// The ≤1-tick path (§2): serialize on the calling (sim) thread, hand the
    /// buffer to the writer, return immediately. Returns the frame captured,
    /// or <0 on failure. At most one write is in flight and one queued — the
    /// "double buffer" — so a slow disk backpressures the sim rather than
    /// growing memory without bound.
    int32_t CheckpointAsync(uint32_t roomId, const std::string& label, std::string& err);

    /// Block until every queued write has been committed (or failed). Called
    /// by Checkpoint(), by the hibernate/drain paths, and by the destructor.
    void Flush();

    /// The E2 ladder: walk retained snapshots newest-first, restoring the
    /// first that decodes cleanly. Each skipped rung is logged and counted.
    /// Returns false with `err` when every rung is bad (the room is then
    /// 'unresumable'; `newestValidFrame` is -1) or when a hash mismatch (E1)
    /// makes the whole history unloadable by this binary.
    bool RestoreNewestValid(uint32_t roomId, std::string& err, int32_t& restoredFrame);

    /// Delete rows beyond `retain` for (gameId, roomId), oldest first. Called
    /// after every successful commit; exposed for the lobby's scheduled prune.
    /// Returns the number of rows deleted. Never touches another room.
    int Prune(uint32_t roomId);

    /// Newest snapshot frame for (gameId, roomId), or -1 if there are none.
    /// Does not validate the blob.
    int32_t NewestFrame(uint32_t roomId);

    StoreStats Stats() const;
    /// Most recent write-path error (worker thread included), "" if none.
    std::string LastError() const;

private:
    struct Job {
        uint64_t id = 0;
        uint32_t roomId = 0;
        std::string label;
        BlobMeta meta;
        std::vector<uint8_t> payload;
    };

    /// Shared body of Checkpoint/CheckpointAsync: serialize on this thread and
    /// queue the write. `jobId` identifies the queued job so the synchronous
    /// caller can find out whether *its* write committed.
    int32_t Enqueue(uint32_t roomId, const std::string& label, std::string& err,
                    uint64_t& jobId);
    void StartWorker();
    void WorkerLoop();
    /// Compress + frame + commit one job in a single transaction, then prune.
    bool WriteJob(const Job& job, std::string& err);
    /// Prune with dbMtx already held (the in-transaction path).
    int PruneLocked(uint32_t roomId);
    /// Read the blob for an exact frame in this room. Returns false if there
    /// is no such row — including when another room has that frame.
    bool LoadBlob(uint32_t roomId, int32_t frame, std::vector<uint8_t>& blob);
    /// Decode + hand to the serializer. Shared by Restore/RestoreNewestValid.
    /// `simRefused` distinguishes "the bytes were good but the sim said no"
    /// from a blob problem — only the latter is an E2 rung to step past.
    DecodeStatus ApplyBlob(const std::vector<uint8_t>& blob, int32_t& frameOut,
                           std::string& err, bool& simRefused);
    /// Fill `expect` from the store's configured identity.
    BlobMeta ExpectedMeta() const;
    /// The one-time "no serializer" warning required by the no-silent-
    /// stand-ins rule, plus the message every refusing verb reports.
    std::string NoSerializerReason() const;

    sqlite3*    db = nullptr;
    StoreConfig cfg;
    ISimSerializer* serializer = nullptr;
    uint8_t     mapDigest[32]{};
    /// 0 until SetDefsHash — see it for why this is not in StoreConfig.
    std::atomic<uint64_t> defsHash{0};

    mutable std::mutex      dbMtx;        ///< serialises this store's SQLite use
    mutable std::mutex      mtx;          ///< guards queue + stats + lastError
    std::condition_variable cvJob;        ///< worker wakes on a queued job
    std::condition_variable cvDone;       ///< Flush()/Enqueue() wait on drain
    std::deque<Job>         queue;
    uint64_t                lastJobId = 0;
    /// Write failures by job id, consumed by the synchronous Checkpoint().
    std::unordered_map<uint64_t, std::string> failedJobs;
    bool                    busy = false; ///< a job is being written right now
    bool                    stop = false;
    std::thread             worker;
    StoreStats              stats;
    std::string             lastError;
    mutable std::atomic<bool> warnedNoSerializer{false};
};

} // namespace gamestate
