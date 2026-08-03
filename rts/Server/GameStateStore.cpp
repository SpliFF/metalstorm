// GameStateStore — see the header for the design, the creg premise failure it
// works around, and the zstd→zlib deviation.

#include "Server/GameStateStore.h"

#include "Server/SyncedInputJournal.h"

#include <sqlite3.h>
#include <zlib.h>
#include <openssl/evp.h>

#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <new>

namespace gamestate {

namespace {

constexpr char kMagic[4] = {'S', 'P', 'S', 'N'};

void LogWarn(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::fprintf(stderr, "[snapshot] ");
    std::vfprintf(stderr, fmt, ap);
    std::fprintf(stderr, "\n");
    va_end(ap);
}

// ── little-endian field access, so a blob written on one host decodes on
// another and the layout is exactly what the header comment claims ──
void PutU16(uint8_t* p, uint16_t v) { p[0] = uint8_t(v); p[1] = uint8_t(v >> 8); }
void PutU32(uint8_t* p, uint32_t v) {
    for (int i = 0; i < 4; ++i) p[i] = uint8_t(v >> (8 * i));
}
void PutU64(uint8_t* p, uint64_t v) {
    for (int i = 0; i < 8; ++i) p[i] = uint8_t(v >> (8 * i));
}
uint16_t GetU16(const uint8_t* p) { return uint16_t(uint16_t(p[0]) | uint16_t(uint16_t(p[1]) << 8)); }
uint32_t GetU32(const uint8_t* p) {
    uint32_t v = 0;
    for (int i = 0; i < 4; ++i) v |= uint32_t(p[i]) << (8 * i);
    return v;
}
uint64_t GetU64(const uint8_t* p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v |= uint64_t(p[i]) << (8 * i);
    return v;
}

int64_t NowUnix() {
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

} // namespace

// ─────────────────────────── Hashing ───────────────────────────

void Sha256(const uint8_t* data, size_t size, uint8_t* out32) {
    static const uint8_t kEmpty[1] = {0};
    std::memset(out32, 0, 32);
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (!ctx) return;
    unsigned int len = 0;
    // EVP_DigestUpdate(nullptr, 0) is not guaranteed well-defined; feed a
    // valid pointer with a zero length instead so the empty-payload digest is
    // the real sha256 of "" rather than an accident.
    const uint8_t* p = (data != nullptr) ? data : kEmpty;
    if (EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) == 1 &&
        EVP_DigestUpdate(ctx, p, size) == 1) {
        EVP_DigestFinal_ex(ctx, out32, &len);
    }
    EVP_MD_CTX_free(ctx);
}

std::string HexDigest(const uint8_t* d32) {
    static const char* kHex = "0123456789abcdef";
    std::string s(64, '0');
    for (int i = 0; i < 32; ++i) {
        s[i * 2]     = kHex[d32[i] >> 4];
        s[i * 2 + 1] = kHex[d32[i] & 0x0F];
    }
    return s;
}

void MapDigestOf(const std::string& mapHash, uint8_t* out32) {
    Sha256(reinterpret_cast<const uint8_t*>(mapHash.data()), mapHash.size(), out32);
}

// ─────────────────────────── Framing ───────────────────────────

const char* DecodeStatusName(DecodeStatus s) {
    switch (s) {
        case DecodeStatus::Ok:               return "ok";
        case DecodeStatus::TooShort:         return "truncated";
        case DecodeStatus::BadMagic:         return "bad-magic";
        case DecodeStatus::BadVersion:       return "bad-version";
        case DecodeStatus::UnknownCodec:     return "unknown-codec";
        case DecodeStatus::EngineMismatch:   return "engine-mismatch";
        case DecodeStatus::MapMismatch:      return "map-mismatch";
        case DecodeStatus::DecompressFailed: return "decompress-failed";
        case DecodeStatus::SizeMismatch:     return "size-mismatch";
        case DecodeStatus::ChecksumMismatch: return "checksum-mismatch";
    }
    return "?";
}

bool IsCorruption(DecodeStatus s) {
    switch (s) {
        case DecodeStatus::TooShort:
        case DecodeStatus::BadMagic:
        case DecodeStatus::UnknownCodec:
        case DecodeStatus::DecompressFailed:
        case DecodeStatus::SizeMismatch:
        case DecodeStatus::ChecksumMismatch:
            return true;
        // A version or hash mismatch is a policy refusal, not damage: every
        // retained rung carries the same stamps, so stepping the ladder would
        // just fail K times with the same reason.
        case DecodeStatus::BadVersion:
        case DecodeStatus::EngineMismatch:
        case DecodeStatus::MapMismatch:
        case DecodeStatus::Ok:
            return false;
    }
    return false;
}

// Header layout (little-endian), total kHeaderSize == 112:
//   0   4   magic "SPSN"
//   4   2   version
//   6   2   codec
//   8   8   engineHash
//   16  8   layoutHash
//   24  4   frame (int32)
//   28  4   reserved (0)
//   32  8   rawSize
//   40  8   compSize
//   48  32  sha256(raw payload)
//   80  32  mapDigest
std::vector<uint8_t> EncodeBlob(const std::vector<uint8_t>& payload, BlobMeta& meta) {
    meta.rawSize = payload.size();
    Sha256(payload.data(), payload.size(), meta.rawSha256);

    std::vector<uint8_t> comp;
    Codec codec = Codec::Deflate;
    if (!payload.empty()) {
        uLongf bound = compressBound(uLong(payload.size()));
        comp.resize(bound);
        uLongf outSize = bound;
        int rc = compress(comp.data(), &outSize, payload.data(), uLong(payload.size()));
        if (rc != Z_OK || outSize >= payload.size()) {
            // Either deflate failed or it made the payload bigger (already
            // compressed / high-entropy state). Store verbatim rather than
            // paying for a negative-ratio codec.
            codec = Codec::None;
            comp = payload;
        } else {
            comp.resize(outSize);
        }
    }
    meta.codec = codec;

    std::vector<uint8_t> out(kHeaderSize + comp.size());
    uint8_t* h = out.data();
    std::memcpy(h, kMagic, 4);
    PutU16(h + 4, kBlobVersion);
    PutU16(h + 6, uint16_t(codec));
    PutU64(h + 8, meta.engineHash);
    PutU64(h + 16, meta.layoutHash);
    PutU32(h + 24, uint32_t(meta.frame));
    PutU32(h + 28, 0);
    PutU64(h + 32, meta.rawSize);
    PutU64(h + 40, uint64_t(comp.size()));
    std::memcpy(h + 48, meta.rawSha256, 32);
    std::memcpy(h + 80, meta.mapDigest, 32);
    if (!comp.empty()) std::memcpy(h + kHeaderSize, comp.data(), comp.size());
    return out;
}

DecodeStatus DecodeBlob(const uint8_t* blob, size_t size, const BlobMeta& expect,
                        BlobMeta& meta, std::vector<uint8_t>& payload) {
    payload.clear();
    if (!blob || size < kHeaderSize) return DecodeStatus::TooShort;
    if (std::memcmp(blob, kMagic, 4) != 0) return DecodeStatus::BadMagic;

    const uint16_t version = GetU16(blob + 4);
    if (version != kBlobVersion) return DecodeStatus::BadVersion;

    const uint16_t codecRaw = GetU16(blob + 6);
    if (codecRaw != uint16_t(Codec::None) && codecRaw != uint16_t(Codec::Deflate))
        return DecodeStatus::UnknownCodec;

    meta = BlobMeta{};
    meta.codec      = Codec(codecRaw);
    meta.engineHash = GetU64(blob + 8);
    meta.layoutHash = GetU64(blob + 16);
    meta.frame      = int32_t(GetU32(blob + 24));
    meta.rawSize    = GetU64(blob + 32);
    const uint64_t compSize = GetU64(blob + 40);
    std::memcpy(meta.rawSha256, blob + 48, 32);
    std::memcpy(meta.mapDigest, blob + 80, 32);

    // E1 first: refuse foreign snapshots before spending CPU on inflate.
    if (meta.engineHash != expect.engineHash || meta.layoutHash != expect.layoutHash)
        return DecodeStatus::EngineMismatch;
    if (std::memcmp(meta.mapDigest, expect.mapDigest, 32) != 0)
        return DecodeStatus::MapMismatch;

    // The header's own length must agree with the stored blob's length —
    // a short read or a trailing-garbage write is caught here.
    if (compSize != size - kHeaderSize) return DecodeStatus::TooShort;

    if (meta.rawSize == 0) {
        uint8_t d[32];
        Sha256(nullptr, 0, d);
        return std::memcmp(d, meta.rawSha256, 32) == 0 ? DecodeStatus::Ok
                                                       : DecodeStatus::ChecksumMismatch;
    }

    if (meta.codec == Codec::None) {
        if (compSize != meta.rawSize) return DecodeStatus::SizeMismatch;
        payload.assign(blob + kHeaderSize, blob + kHeaderSize + compSize);
    } else {
        // rawSize comes out of a blob we have already decided may be damaged —
        // it is NOT trustworthy yet (the sha256 that would vouch for it covers
        // the payload, and we cannot check it until after we inflate). Sizing
        // the buffer straight from it lets one flipped byte in this field throw
        // std::bad_alloc out through RestoreNewestValid and abort the process,
        // which is precisely the outcome the E2 ladder exists to prevent.
        //
        // deflate cannot expand by more than 1032:1, so anything above that is
        // a damaged length field, not a big snapshot. This bounds the
        // allocation by the data we actually hold rather than by an arbitrary
        // cap, so legitimately large snapshots are unaffected.
        constexpr uint64_t kMaxDeflateRatio = 1032;
        if (meta.rawSize > compSize * kMaxDeflateRatio + kHeaderSize)
            return DecodeStatus::SizeMismatch;
        try {
            payload.resize(size_t(meta.rawSize));
        } catch (const std::bad_alloc&) {
            // Ratio-plausible but still unallocatable here: treat it as a
            // damaged rung so the ladder steps past it instead of unwinding.
            payload.clear();
            return DecodeStatus::SizeMismatch;
        }
        uLongf outSize = uLongf(meta.rawSize);
        int rc = uncompress(payload.data(), &outSize, blob + kHeaderSize, uLong(compSize));
        if (rc != Z_OK) {
            payload.clear();
            return DecodeStatus::DecompressFailed;
        }
        if (outSize != meta.rawSize) {
            payload.clear();
            return DecodeStatus::SizeMismatch;
        }
    }

    uint8_t actual[32];
    Sha256(payload.data(), payload.size(), actual);
    if (std::memcmp(actual, meta.rawSha256, 32) != 0) {
        payload.clear();
        return DecodeStatus::ChecksumMismatch;
    }
    return DecodeStatus::Ok;
}

// ─────────────────────────── Schema ───────────────────────────

void GameStateStore::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS game_snapshots ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  game_id TEXT NOT NULL,"
        "  room_id INTEGER NOT NULL,"
        "  frame INTEGER NOT NULL,"
        "  taken_at INTEGER NOT NULL,"
        "  engine_hash TEXT NOT NULL,"
        "  map_hash TEXT NOT NULL,"
        "  label TEXT NOT NULL DEFAULT 'auto',"
        "  raw_size INTEGER NOT NULL,"
        "  blob_size INTEGER NOT NULL,"
        "  sha256 TEXT NOT NULL,"
        "  blob BLOB NOT NULL"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_game_snapshots_game_id"
        " ON game_snapshots(game_id, id DESC)", nullptr, nullptr, nullptr);
}

// ─────────────────────────── Lifecycle ───────────────────────────

GameStateStore::GameStateStore(sqlite3* database, StoreConfig config)
    : db(database), cfg(std::move(config)) {
    MapDigestOf(cfg.mapHash, mapDigest);
    if (cfg.retain < 1) cfg.retain = 1;
    std::lock_guard<std::mutex> lk(dbMtx);
    EnsureTables(db);
}

GameStateStore::~GameStateStore() {
    Flush();
    {
        std::lock_guard<std::mutex> lk(mtx);
        stop = true;
    }
    cvJob.notify_all();
    if (worker.joinable()) worker.join();
}

BlobMeta GameStateStore::ExpectedMeta() const {
    BlobMeta m;
    m.engineHash = cfg.engineHash;
    m.layoutHash = serializer ? serializer->LayoutHash() : 0;
    std::memcpy(m.mapDigest, mapDigest, 32);
    return m;
}

std::string GameStateStore::NoSerializerReason() const {
    if (!warnedNoSerializer.exchange(true)) {
        // No-silent-stand-ins rule: a capability gap warns once, loudly.
        LogWarn("no sim serializer attached — checkpoint/restore refuse. creg is a "
                "stub in this tree (rts/System/creg/*), so nothing can walk the sim "
                "yet; see PLAN-persistence.md Q-P1.");
    }
    return "no sim serializer attached (creg is stubbed out in this tree; "
           "PLAN-persistence.md Q-P1 gates what replaces it)";
}

bool GameStateStore::Available() const {
    return db != nullptr && serializer != nullptr;
}

// ─────────────────────────── Read paths ───────────────────────────

std::vector<SnapshotInfo> GameStateStore::List(uint32_t /*roomId*/) {
    std::vector<SnapshotInfo> out;
    if (!db) return out;
    std::lock_guard<std::mutex> dbLock(dbMtx);
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT frame, taken_at, blob_size, label FROM game_snapshots"
            " WHERE game_id = ? ORDER BY id DESC", -1, &st, nullptr) != SQLITE_OK) {
        return out;
    }
    sqlite3_bind_text(st, 1, cfg.gameId.c_str(), -1, SQLITE_TRANSIENT);
    while (sqlite3_step(st) == SQLITE_ROW) {
        SnapshotInfo info;
        info.frame     = sqlite3_column_int(st, 0);
        info.takenAt   = sqlite3_column_int64(st, 1);
        info.sizeBytes = sqlite3_column_int64(st, 2);
        const unsigned char* lbl = sqlite3_column_text(st, 3);
        info.label = lbl ? reinterpret_cast<const char*>(lbl) : "";
        out.push_back(std::move(info));
    }
    sqlite3_finalize(st);
    return out;
}

int32_t GameStateStore::NewestFrame(uint32_t /*roomId*/) {
    if (!db) return -1;
    std::lock_guard<std::mutex> dbLock(dbMtx);
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT frame FROM game_snapshots WHERE game_id = ?"
            " ORDER BY id DESC LIMIT 1", -1, &st, nullptr) != SQLITE_OK) {
        return -1;
    }
    sqlite3_bind_text(st, 1, cfg.gameId.c_str(), -1, SQLITE_TRANSIENT);
    int32_t frame = -1;
    if (sqlite3_step(st) == SQLITE_ROW) frame = sqlite3_column_int(st, 0);
    sqlite3_finalize(st);
    return frame;
}

bool GameStateStore::LoadBlob(int32_t frame, std::vector<uint8_t>& blob) {
    blob.clear();
    if (!db) return false;
    std::lock_guard<std::mutex> dbLock(dbMtx);
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT blob FROM game_snapshots WHERE game_id = ? AND frame = ?"
            " ORDER BY id DESC LIMIT 1", -1, &st, nullptr) != SQLITE_OK) {
        return false;
    }
    sqlite3_bind_text(st, 1, cfg.gameId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, 2, frame);
    bool found = false;
    if (sqlite3_step(st) == SQLITE_ROW) {
        const void* data = sqlite3_column_blob(st, 0);
        const int size = sqlite3_column_bytes(st, 0);
        if (data && size > 0) {
            const uint8_t* p = static_cast<const uint8_t*>(data);
            blob.assign(p, p + size);
        }
        found = true;   // a row with an empty blob is corruption, not absence
    }
    sqlite3_finalize(st);
    return found;
}

// ─────────────────────────── Write path ───────────────────────────

int32_t GameStateStore::CheckpointAsync(uint32_t roomId, const std::string& label,
                                        std::string& err) {
    uint64_t jobId = 0;
    return Enqueue(roomId, label, err, jobId);
}

int32_t GameStateStore::Enqueue(uint32_t roomId, const std::string& label,
                                std::string& err, uint64_t& jobId) {
    jobId = 0;
    if (!db) { err = "no database"; return -1; }
    if (!serializer) { err = NoSerializerReason(); return -1; }

    Job job;
    job.roomId = roomId;
    job.label  = label.empty() ? "auto" : label;
    job.meta   = ExpectedMeta();
    job.meta.frame = serializer->Frame();

    // The only step that must run on the sim thread, and the only one the
    // stall budget covers.
    const auto t0 = std::chrono::steady_clock::now();
    const bool ok = serializer->Serialize(job.payload, err);
    const auto t1 = std::chrono::steady_clock::now();
    const uint64_t serializeUs =
        uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count());

    {
        std::lock_guard<std::mutex> lk(mtx);
        stats.checkpointsRequested++;
        stats.lastSerializeUs = serializeUs;
        if (!ok) {
            stats.checkpointsFailed++;
            lastError = err;
        }
    }
    if (!ok) return -1;

    const int32_t frame = job.meta.frame;
    StartWorker();
    {
        std::unique_lock<std::mutex> lk(mtx);
        // Double buffer: one job in flight + one queued. Beyond that the sim
        // waits, so a stalled disk shows up as backpressure rather than
        // unbounded memory growth.
        cvDone.wait(lk, [this] { return stop || queue.empty(); });
        job.id = ++lastJobId;
        jobId = job.id;
        queue.push_back(std::move(job));
    }
    cvJob.notify_one();
    return frame;
}

int32_t GameStateStore::Checkpoint(uint32_t roomId, const std::string& label,
                                   std::string& err) {
    uint64_t jobId = 0;
    const int32_t frame = Enqueue(roomId, label, err, jobId);
    if (frame < 0) return -1;
    Flush();
    // A GM's pre-rollback checkpoint must not report success for a row that
    // never committed, so report on *this* job rather than on a global tally.
    std::lock_guard<std::mutex> lk(mtx);
    auto it = failedJobs.find(jobId);
    if (it != failedJobs.end()) {
        err = it->second;
        failedJobs.erase(it);
        return -1;
    }
    return frame;
}

void GameStateStore::StartWorker() {
    std::lock_guard<std::mutex> lk(mtx);
    if (worker.joinable() || stop) return;
    worker = std::thread(&GameStateStore::WorkerLoop, this);
}

void GameStateStore::WorkerLoop() {
    for (;;) {
        Job job;
        {
            std::unique_lock<std::mutex> lk(mtx);
            cvJob.wait(lk, [this] { return stop || !queue.empty(); });
            if (queue.empty()) {
                if (stop) return;
                continue;
            }
            job = std::move(queue.front());
            queue.pop_front();
            busy = true;
        }
        // Freeing the queue slot before the write is what makes this a double
        // buffer: the sim can serialize the next checkpoint while this one is
        // still being compressed and committed.
        cvDone.notify_all();

        std::string err;
        const bool ok = WriteJob(job, err);

        {
            std::lock_guard<std::mutex> lk(mtx);
            busy = false;
            if (ok) {
                stats.checkpointsCommitted++;
            } else {
                stats.checkpointsFailed++;
                lastError = err;
                // Bounded: only a synchronous Checkpoint() consumes these, and
                // an async caller that never looks must not leak memory.
                if (failedJobs.size() > 64) failedJobs.clear();
                failedJobs[job.id] = err;
            }
        }
        if (!ok) LogWarn("checkpoint write failed at frame %d: %s", job.meta.frame, err.c_str());
        cvDone.notify_all();
    }
}

bool GameStateStore::WriteJob(const Job& job, std::string& err) {
    BlobMeta meta = job.meta;
    const std::vector<uint8_t> blob = EncodeBlob(job.payload, meta);

    std::lock_guard<std::mutex> dbLock(dbMtx);

    // One snapshot = one transaction (§8 "kill mid-write → previous snapshot
    // intact"). The prune rides the same transaction so a crash can never
    // leave the history trimmed against a row that was not committed.
    if (sqlite3_exec(db, "BEGIN IMMEDIATE", nullptr, nullptr, nullptr) != SQLITE_OK) {
        err = std::string("begin failed: ") + sqlite3_errmsg(db);
        return false;
    }

    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "INSERT INTO game_snapshots"
            " (game_id, room_id, frame, taken_at, engine_hash, map_hash, label,"
            "  raw_size, blob_size, sha256, blob)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)", -1, &st, nullptr) != SQLITE_OK) {
        err = std::string("prepare failed: ") + sqlite3_errmsg(db);
        sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
        return false;
    }

    char engineHex[32];
    std::snprintf(engineHex, sizeof(engineHex), "%016llx",
                  static_cast<unsigned long long>(meta.engineHash));
    const std::string sha = HexDigest(meta.rawSha256);

    sqlite3_bind_text(st, 1, cfg.gameId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, 2, int(job.roomId));
    sqlite3_bind_int(st, 3, meta.frame);
    sqlite3_bind_int64(st, 4, NowUnix());
    sqlite3_bind_text(st, 5, engineHex, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 6, cfg.mapHash.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 7, job.label.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(st, 8, sqlite3_int64(meta.rawSize));
    sqlite3_bind_int64(st, 9, sqlite3_int64(blob.size()));
    sqlite3_bind_text(st, 10, sha.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_blob64(st, 11, blob.data(), sqlite3_uint64(blob.size()), SQLITE_TRANSIENT);

    const int rc = sqlite3_step(st);
    sqlite3_finalize(st);
    if (rc != SQLITE_DONE) {
        err = std::string("insert failed: ") + sqlite3_errmsg(db);
        sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
        return false;
    }

    PruneLocked();

    if (sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr) != SQLITE_OK) {
        err = std::string("commit failed: ") + sqlite3_errmsg(db);
        sqlite3_exec(db, "ROLLBACK", nullptr, nullptr, nullptr);
        return false;
    }

    {
        std::lock_guard<std::mutex> lk(mtx);
        stats.bytesWritten += blob.size();
        stats.lastRawSize   = meta.rawSize;
        stats.lastBlobSize  = blob.size();
    }
    return true;
}

int GameStateStore::PruneLocked() {
    if (!db) return 0;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM game_snapshots WHERE game_id = ? AND id NOT IN ("
            "  SELECT id FROM game_snapshots WHERE game_id = ? ORDER BY id DESC LIMIT ?"
            ")", -1, &st, nullptr) != SQLITE_OK) {
        return 0;
    }
    sqlite3_bind_text(st, 1, cfg.gameId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 2, cfg.gameId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, 3, cfg.retain);
    sqlite3_step(st);
    sqlite3_finalize(st);
    return sqlite3_changes(db);
}

int GameStateStore::Prune() {
    std::lock_guard<std::mutex> dbLock(dbMtx);
    return PruneLocked();
}

void GameStateStore::Flush() {
    std::unique_lock<std::mutex> lk(mtx);
    if (!worker.joinable()) return;
    cvDone.wait(lk, [this] { return queue.empty() && !busy; });
}

// ─────────────────────────── Restore paths ───────────────────────────

DecodeStatus GameStateStore::ApplyBlob(const std::vector<uint8_t>& blob,
                                       int32_t& frameOut, std::string& err,
                                       bool& simRefused) {
    simRefused = false;
    const BlobMeta expect = ExpectedMeta();
    BlobMeta meta;
    std::vector<uint8_t> payload;
    const DecodeStatus st = DecodeBlob(blob.data(), blob.size(), expect, meta, payload);
    if (st != DecodeStatus::Ok) {
        err = DecodeStatusName(st);
        return st;
    }

    const int32_t fromFrame = serializer->Frame();
    if (!serializer->Deserialize(payload.data(), payload.size(), err)) {
        // The blob was fine; the sim refused it. Not an E2 rung to step past.
        simRefused = true;
        return DecodeStatus::Ok;
    }
    frameOut = meta.frame;

    // The journal must see the discontinuity or a replay would re-apply the
    // post-restore cause stream against the wrong state (SyncedInputJournal.h,
    // InputKind::SnapshotRestore).
    syncedinput::Journal().RecordSnapshotRestore(fromFrame, meta.frame);
    return DecodeStatus::Ok;
}

bool GameStateStore::Restore(uint32_t /*roomId*/, int32_t frame, std::string& err) {
    if (!db) { err = "no database"; return false; }
    if (!serializer) { err = NoSerializerReason(); return false; }

    std::vector<uint8_t> blob;
    if (!LoadBlob(frame, blob)) {
        err = "no snapshot at frame " + std::to_string(frame);
        return false;
    }
    int32_t landed = -1;
    bool simRefused = false;
    const DecodeStatus st = ApplyBlob(blob, landed, err, simRefused);
    if (st != DecodeStatus::Ok || simRefused) {
        LogWarn("restore of frame %d refused: %s", frame, err.c_str());
        return false;
    }
    std::lock_guard<std::mutex> lk(mtx);
    stats.restores++;
    return true;
}

bool GameStateStore::RestoreNewestValid(uint32_t /*roomId*/, std::string& err,
                                        int32_t& restoredFrame) {
    restoredFrame = -1;
    if (!db) { err = "no database"; return false; }
    if (!serializer) { err = NoSerializerReason(); return false; }

    struct Rung { int32_t frame; std::vector<uint8_t> blob; };
    std::vector<Rung> rungs;
    {
        std::lock_guard<std::mutex> dbLock(dbMtx);
        sqlite3_stmt* st = nullptr;
        if (sqlite3_prepare_v2(db,
                "SELECT frame, blob FROM game_snapshots WHERE game_id = ?"
                " ORDER BY id DESC LIMIT ?", -1, &st, nullptr) != SQLITE_OK) {
            err = std::string("prepare failed: ") + sqlite3_errmsg(db);
            return false;
        }
        sqlite3_bind_text(st, 1, cfg.gameId.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 2, cfg.retain);
        while (sqlite3_step(st) == SQLITE_ROW) {
            Rung r;
            r.frame = sqlite3_column_int(st, 0);
            const void* data = sqlite3_column_blob(st, 1);
            const int size = sqlite3_column_bytes(st, 1);
            if (data && size > 0) {
                const uint8_t* p = static_cast<const uint8_t*>(data);
                r.blob.assign(p, p + size);
            }
            rungs.push_back(std::move(r));
        }
        sqlite3_finalize(st);
    }

    if (rungs.empty()) { err = "no snapshots for game " + cfg.gameId; return false; }

    for (const Rung& r : rungs) {
        int32_t landed = -1;
        std::string rungErr;
        bool simRefused = false;
        const DecodeStatus ds = ApplyBlob(r.blob, landed, rungErr, simRefused);

        if (ds == DecodeStatus::Ok && !simRefused) {
            restoredFrame = landed;
            std::lock_guard<std::mutex> lk(mtx);
            stats.restores++;
            return true;
        }
        if (simRefused) {
            // The bytes were good and the sim still said no. Another rung is
            // unlikely to help and each attempt touches the sim — stop here
            // with the sim's own reason rather than grinding through K.
            err = "sim refused a valid snapshot at frame " + std::to_string(r.frame) +
                  ": " + rungErr;
            LogWarn("%s", err.c_str());
            return false;
        }
        if (!IsCorruption(ds)) {
            // E1: the whole retained history carries these stamps. Refuse with
            // the specific reason instead of walking K identical failures.
            err = std::string("snapshot refused (") + rungErr + ") — this binary "
                  "cannot load game " + cfg.gameId + "'s snapshots";
            LogWarn("%s", err.c_str());
            return false;
        }
        // E2: damaged rung — log it, count it, step down.
        LogWarn("snapshot at frame %d is damaged (%s); falling back a rung",
                r.frame, rungErr.c_str());
        std::lock_guard<std::mutex> lk(mtx);
        stats.corruptRungsSkipped++;
    }

    err = "all " + std::to_string(rungs.size()) + " retained snapshots for game " +
          cfg.gameId + " are damaged — unresumable";
    LogWarn("%s", err.c_str());
    return false;
}

// ─────────────────────────── Reporting ───────────────────────────

StoreStats GameStateStore::Stats() const {
    std::lock_guard<std::mutex> lk(mtx);
    return stats;
}

std::string GameStateStore::LastError() const {
    std::lock_guard<std::mutex> lk(mtx);
    return lastError;
}

} // namespace gamestate
