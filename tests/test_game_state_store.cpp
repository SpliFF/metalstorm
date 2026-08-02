// test_game_state_store — PLAN-persistence task 1's durable snapshot store.
//
// PLAN-persistence §8 asks for: creg round-trip on a populated sim fixture,
// orchestrator atomicity, retention/prune, the E2 corruption ladder with
// flipped bytes, and the E1 hash-mismatch refusal.
//
// Everything here EXCEPT the creg round-trip is covered, because creg does not
// exist in this tree (see GameStateStore.h's header comment — the macros are
// no-ops and the implementation files are absent). The store is driven instead
// by a synthetic ISimSerializer whose "sim state" is a deterministic byte
// pattern, which exercises exactly the properties the store is responsible
// for. The round-trip-a-real-sim test belongs with whatever resolves
// PLAN-persistence Q-P1 and cannot be written before it.

#include <doctest/doctest.h>

#include "Server/GameStateStore.h"

#include <sqlite3.h>

#include <cstring>
#include <string>
#include <vector>

using namespace gamestate;

namespace {

// A stand-in sim: `state` is the whole world. Serialize copies it out,
// Deserialize copies it in, so a round-trip is byte-comparable.
class FakeSim : public ISimSerializer {
public:
    std::vector<uint8_t> state;
    int32_t  frame = 0;
    uint64_t layout = 0xABCDEF0123456789ull;
    bool     failSerialize = false;
    bool     failDeserialize = false;
    int      serializeCalls = 0;
    int      deserializeCalls = 0;

    bool Serialize(std::vector<uint8_t>& out, std::string& err) override {
        serializeCalls++;
        if (failSerialize) { err = "synthetic serialize failure"; return false; }
        out.insert(out.end(), state.begin(), state.end());
        return true;
    }
    bool Deserialize(const uint8_t* data, size_t size, std::string& err) override {
        deserializeCalls++;
        if (failDeserialize) { err = "synthetic deserialize refusal"; return false; }
        state.assign(data, data + size);
        return true;
    }
    uint64_t LayoutHash() const override { return layout; }
    int32_t  Frame() const override { return frame; }

    /// A compressible-but-varied pattern, so blobs differ per frame and
    /// deflate actually has something to do.
    void FillState(size_t n, uint8_t seed) {
        state.resize(n);
        for (size_t i = 0; i < n; ++i)
            state[i] = uint8_t((i * 7 + seed * 31) % 251);
    }
};

/// An in-memory SQLite DB, one per test.
struct TempDb {
    sqlite3* db = nullptr;
    TempDb() { REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK); }
    ~TempDb() { if (db) sqlite3_close(db); }
};

StoreConfig MakeCfg(const char* gameId = "g1", int retain = 3) {
    StoreConfig cfg;
    cfg.gameId     = gameId;
    cfg.engineHash = 0x1122334455667788ull;
    cfg.mapHash    = "map-hash-abc";
    cfg.retain     = retain;
    return cfg;
}

/// Overwrite the stored blob for `frame` — the "flipped bytes" of §8.
void CorruptBlobAt(sqlite3* db, const char* gameId, int32_t frame, size_t byteOffset) {
    sqlite3_stmt* st = nullptr;
    REQUIRE(sqlite3_prepare_v2(db,
        "SELECT id, blob FROM game_snapshots WHERE game_id=? AND frame=?",
        -1, &st, nullptr) == SQLITE_OK);
    sqlite3_bind_text(st, 1, gameId, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, 2, frame);
    REQUIRE(sqlite3_step(st) == SQLITE_ROW);
    const int64_t id = sqlite3_column_int64(st, 0);
    const uint8_t* p = static_cast<const uint8_t*>(sqlite3_column_blob(st, 1));
    const int size = sqlite3_column_bytes(st, 1);
    std::vector<uint8_t> blob(p, p + size);
    sqlite3_finalize(st);

    REQUIRE(byteOffset < blob.size());
    blob[byteOffset] ^= 0xFF;

    sqlite3_stmt* up = nullptr;
    REQUIRE(sqlite3_prepare_v2(db, "UPDATE game_snapshots SET blob=? WHERE id=?",
                               -1, &up, nullptr) == SQLITE_OK);
    sqlite3_bind_blob64(up, 1, blob.data(), blob.size(), SQLITE_TRANSIENT);
    sqlite3_bind_int64(up, 2, id);
    REQUIRE(sqlite3_step(up) == SQLITE_DONE);
    sqlite3_finalize(up);
}

int CountRows(sqlite3* db, const char* gameId) {
    sqlite3_stmt* st = nullptr;
    REQUIRE(sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM game_snapshots WHERE game_id=?",
                               -1, &st, nullptr) == SQLITE_OK);
    sqlite3_bind_text(st, 1, gameId, -1, SQLITE_TRANSIENT);
    REQUIRE(sqlite3_step(st) == SQLITE_ROW);
    const int n = sqlite3_column_int(st, 0);
    sqlite3_finalize(st);
    return n;
}

} // namespace

// ───────────────────────── Blob framing (pure) ─────────────────────────

TEST_CASE("snapshot blob round-trips its payload and metadata") {
    BlobMeta meta;
    meta.engineHash = 42;
    meta.layoutHash = 99;
    meta.frame = 1234;
    MapDigestOf("some-map", meta.mapDigest);

    std::vector<uint8_t> payload(4096);
    for (size_t i = 0; i < payload.size(); ++i) payload[i] = uint8_t(i % 97);

    const std::vector<uint8_t> blob = EncodeBlob(payload, meta);
    CHECK(blob.size() >= kHeaderSize);
    CHECK(meta.rawSize == payload.size());
    // A repetitive payload must actually compress, or the codec is not wired.
    CHECK(blob.size() < payload.size());

    BlobMeta got;
    std::vector<uint8_t> out;
    CHECK(DecodeBlob(blob.data(), blob.size(), meta, got, out) == DecodeStatus::Ok);
    CHECK(out == payload);
    CHECK(got.frame == 1234);
    CHECK(got.rawSize == payload.size());
}

TEST_CASE("snapshot blob handles an empty payload") {
    BlobMeta meta;
    MapDigestOf("m", meta.mapDigest);
    const std::vector<uint8_t> blob = EncodeBlob({}, meta);
    BlobMeta got;
    std::vector<uint8_t> out;
    CHECK(DecodeBlob(blob.data(), blob.size(), meta, got, out) == DecodeStatus::Ok);
    CHECK(out.empty());
}

TEST_CASE("snapshot blob stores incompressible payloads verbatim") {
    BlobMeta meta;
    MapDigestOf("m", meta.mapDigest);
    // Pseudo-random bytes: deflate would grow this, so the codec must fall
    // back to None rather than paying a negative ratio.
    std::vector<uint8_t> payload(2048);
    uint32_t x = 0x12345678u;
    for (auto& b : payload) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        b = uint8_t(x);
    }
    const std::vector<uint8_t> blob = EncodeBlob(payload, meta);
    CHECK(meta.codec == Codec::None);

    BlobMeta got;
    std::vector<uint8_t> out;
    CHECK(DecodeBlob(blob.data(), blob.size(), meta, got, out) == DecodeStatus::Ok);
    CHECK(out == payload);
}

TEST_CASE("E1: a blob from another engine or map is refused, never decoded") {
    BlobMeta meta;
    meta.engineHash = 1;
    meta.layoutHash = 2;
    meta.frame = 7;
    MapDigestOf("map-a", meta.mapDigest);
    std::vector<uint8_t> payload(64, 0xAB);
    const std::vector<uint8_t> blob = EncodeBlob(payload, meta);

    BlobMeta got;
    std::vector<uint8_t> out;

    SUBCASE("engine hash differs") {
        BlobMeta expect = meta;
        expect.engineHash = 999;
        CHECK(DecodeBlob(blob.data(), blob.size(), expect, got, out) ==
              DecodeStatus::EngineMismatch);
        CHECK(out.empty());
    }
    SUBCASE("serializer layout differs") {
        BlobMeta expect = meta;
        expect.layoutHash = 3;
        CHECK(DecodeBlob(blob.data(), blob.size(), expect, got, out) ==
              DecodeStatus::EngineMismatch);
        CHECK(out.empty());
    }
    SUBCASE("map was re-processed") {
        BlobMeta expect = meta;
        MapDigestOf("map-b", expect.mapDigest);
        CHECK(DecodeBlob(blob.data(), blob.size(), expect, got, out) ==
              DecodeStatus::MapMismatch);
        CHECK(out.empty());
    }

    // A mismatch is policy, not damage — the E2 ladder must not step past it.
    CHECK_FALSE(IsCorruption(DecodeStatus::EngineMismatch));
    CHECK_FALSE(IsCorruption(DecodeStatus::MapMismatch));
}

TEST_CASE("E2: damaged blobs are detected, not decoded into garbage") {
    BlobMeta meta;
    meta.engineHash = 5;
    meta.layoutHash = 6;
    MapDigestOf("m", meta.mapDigest);
    std::vector<uint8_t> payload(1024);
    for (size_t i = 0; i < payload.size(); ++i) payload[i] = uint8_t(i % 13);
    const std::vector<uint8_t> good = EncodeBlob(payload, meta);

    BlobMeta got;
    std::vector<uint8_t> out;

    SUBCASE("truncated below the header") {
        CHECK(DecodeBlob(good.data(), 8, meta, got, out) == DecodeStatus::TooShort);
    }
    SUBCASE("truncated payload") {
        CHECK(DecodeBlob(good.data(), good.size() - 4, meta, got, out) ==
              DecodeStatus::TooShort);
    }
    SUBCASE("not a snapshot blob") {
        std::vector<uint8_t> bad = good;
        bad[0] = 'X';
        CHECK(DecodeBlob(bad.data(), bad.size(), meta, got, out) == DecodeStatus::BadMagic);
    }
    SUBCASE("header from another blob version") {
        std::vector<uint8_t> bad = good;
        bad[4] = uint8_t(kBlobVersion + 1);
        CHECK(DecodeBlob(bad.data(), bad.size(), meta, got, out) == DecodeStatus::BadVersion);
    }
    SUBCASE("flipped byte in the compressed payload") {
        std::vector<uint8_t> bad = good;
        bad[kHeaderSize + 3] ^= 0xFF;
        const DecodeStatus st = DecodeBlob(bad.data(), bad.size(), meta, got, out);
        // zlib may reject it outright or inflate to something whose checksum
        // fails; both are detections, and neither yields a payload.
        CHECK((st == DecodeStatus::DecompressFailed || st == DecodeStatus::SizeMismatch ||
               st == DecodeStatus::ChecksumMismatch));
        CHECK(out.empty());
        CHECK(IsCorruption(st));
    }
    SUBCASE("payload swapped for another valid deflate stream") {
        // The checksum, not the codec, is what catches a substituted payload.
        BlobMeta other = meta;
        std::vector<uint8_t> otherPayload(1024, 0x5A);
        const std::vector<uint8_t> otherBlob = EncodeBlob(otherPayload, other);
        std::vector<uint8_t> bad(good.begin(), good.begin() + kHeaderSize);
        bad.insert(bad.end(), otherBlob.begin() + kHeaderSize, otherBlob.end());
        // Fix up the recorded compressed length so only the checksum can fail.
        const uint64_t compLen = bad.size() - kHeaderSize;
        for (int i = 0; i < 8; ++i) bad[40 + i] = uint8_t(compLen >> (8 * i));
        const DecodeStatus st = DecodeBlob(bad.data(), bad.size(), meta, got, out);
        CHECK((st == DecodeStatus::ChecksumMismatch || st == DecodeStatus::SizeMismatch));
        CHECK(out.empty());
    }
}

// ───────────────────────── Store behaviour ─────────────────────────

TEST_CASE("store refuses honestly while no serializer is attached") {
    TempDb tdb;
    GameStateStore store(tdb.db, MakeCfg());

    CHECK_FALSE(store.Available());

    std::string err;
    CHECK(store.Checkpoint(1, "auto", err) < 0);
    // The refusal must name the actual missing piece, not a generic failure —
    // this is what stops a caller from believing a checkpoint happened.
    CHECK(err.find("serializer") != std::string::npos);

    err.clear();
    CHECK_FALSE(store.Restore(1, 0, err));
    CHECK(err.find("serializer") != std::string::npos);

    CHECK(store.List(1).empty());
}

TEST_CASE("checkpoint commits a snapshot that restores byte-identical state") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg());
    store.SetSerializer(&sim);
    CHECK(store.Available());

    sim.FillState(8192, 1);
    sim.frame = 100;
    const std::vector<uint8_t> atFrame100 = sim.state;

    std::string err;
    CHECK(store.Checkpoint(1, "auto", err) == 100);
    CHECK(err.empty());

    // The world moves on.
    sim.FillState(8192, 2);
    sim.frame = 200;
    CHECK(sim.state != atFrame100);

    CHECK(store.Restore(1, 100, err));
    CHECK(sim.state == atFrame100);

    const StoreStats st = store.Stats();
    CHECK(st.checkpointsCommitted == 1);
    CHECK(st.checkpointsFailed == 0);
    CHECK(st.restores == 1);
    CHECK(st.lastRawSize == 8192);
    CHECK(st.lastBlobSize > 0);
}

TEST_CASE("List reports snapshots newest-first with their labels") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg("g1", 10));
    store.SetSerializer(&sim);

    std::string err;
    for (int i = 1; i <= 3; ++i) {
        sim.frame = i * 10;
        sim.FillState(256, uint8_t(i));
        REQUIRE(store.Checkpoint(1, i == 2 ? "pre-rollback" : "auto", err) == i * 10);
    }

    const std::vector<SnapshotInfo> list = store.List(1);
    REQUIRE(list.size() == 3);
    CHECK(list[0].frame == 30);
    CHECK(list[1].frame == 20);
    CHECK(list[2].frame == 10);
    CHECK(list[1].label == "pre-rollback");
    CHECK(list[0].sizeBytes > 0);
    CHECK(store.NewestFrame(1) == 30);
}

TEST_CASE("retention keeps the last K snapshots and prunes the rest") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg("g1", 3));
    store.SetSerializer(&sim);

    std::string err;
    for (int i = 1; i <= 7; ++i) {
        sim.frame = i;
        sim.FillState(512, uint8_t(i));
        REQUIRE(store.Checkpoint(1, "auto", err) == i);
    }

    CHECK(CountRows(tdb.db, "g1") == 3);
    const std::vector<SnapshotInfo> list = store.List(1);
    REQUIRE(list.size() == 3);
    CHECK(list[0].frame == 7);
    CHECK(list[2].frame == 5);

    // Pruning is per-game: another game's history is untouched.
    GameStateStore other(tdb.db, MakeCfg("g2", 3));
    FakeSim sim2;
    other.SetSerializer(&sim2);
    sim2.frame = 42;
    sim2.FillState(64, 9);
    REQUIRE(other.Checkpoint(2, "auto", err) == 42);
    CHECK(CountRows(tdb.db, "g1") == 3);
    CHECK(CountRows(tdb.db, "g2") == 1);
}

TEST_CASE("E2 ladder: a damaged newest snapshot falls back to the previous rung") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg("g1", 3));
    store.SetSerializer(&sim);

    std::string err;
    std::vector<uint8_t> stateAt20;
    for (int i = 1; i <= 3; ++i) {
        sim.frame = i * 10;
        sim.FillState(1024, uint8_t(i));
        if (i == 2) stateAt20 = sim.state;
        REQUIRE(store.Checkpoint(1, "auto", err) == i * 10);
    }

    // Flip a byte inside the newest snapshot's compressed payload.
    CorruptBlobAt(tdb.db, "g1", 30, kHeaderSize + 5);

    sim.state.clear();
    sim.frame = 0;
    int32_t restored = -1;
    CHECK(store.RestoreNewestValid(1, err, restored));
    CHECK(restored == 20);
    CHECK(sim.state == stateAt20);
    CHECK(store.Stats().corruptRungsSkipped == 1);

    // Asking for the damaged frame *by name* refuses instead of silently
    // landing somewhere else — a GM named that frame on purpose.
    std::string exactErr;
    CHECK_FALSE(store.Restore(1, 30, exactErr));
    CHECK_FALSE(exactErr.empty());
}

TEST_CASE("E2 ladder: every rung damaged means unresumable, not a wrong world") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg("g1", 3));
    store.SetSerializer(&sim);

    std::string err;
    for (int i = 1; i <= 3; ++i) {
        sim.frame = i * 10;
        sim.FillState(1024, uint8_t(i));
        REQUIRE(store.Checkpoint(1, "auto", err) == i * 10);
    }
    for (int i = 1; i <= 3; ++i) CorruptBlobAt(tdb.db, "g1", i * 10, kHeaderSize + 2);

    const std::vector<uint8_t> before = sim.state;
    int32_t restored = 0;
    CHECK_FALSE(store.RestoreNewestValid(1, err, restored));
    CHECK(restored == -1);
    CHECK(err.find("unresumable") != std::string::npos);
    CHECK(sim.state == before);          // nothing half-loaded
    CHECK(store.Stats().corruptRungsSkipped == 3);
}

TEST_CASE("E1: a snapshot history from another binary is refused, ladder not walked") {
    TempDb tdb;
    FakeSim sim;
    std::string err;
    {
        GameStateStore store(tdb.db, MakeCfg("g1", 3));
        store.SetSerializer(&sim);
        for (int i = 1; i <= 3; ++i) {
            sim.frame = i * 10;
            sim.FillState(256, uint8_t(i));
            REQUIRE(store.Checkpoint(1, "auto", err) == i * 10);
        }
    }

    SUBCASE("engine upgraded") {
        StoreConfig cfg = MakeCfg("g1", 3);
        cfg.engineHash = 0xDEADBEEFull;
        GameStateStore upgraded(tdb.db, cfg);
        upgraded.SetSerializer(&sim);
        int32_t restored = 0;
        CHECK_FALSE(upgraded.RestoreNewestValid(1, err, restored));
        CHECK(err.find("engine-mismatch") != std::string::npos);
        // Not corruption: the ladder must stop on the first rung rather than
        // grind through K identical refusals.
        CHECK(upgraded.Stats().corruptRungsSkipped == 0);
    }
    SUBCASE("map re-processed") {
        StoreConfig cfg = MakeCfg("g1", 3);
        cfg.mapHash = "a-different-map-hash";
        GameStateStore remapped(tdb.db, cfg);
        remapped.SetSerializer(&sim);
        int32_t restored = 0;
        CHECK_FALSE(remapped.RestoreNewestValid(1, err, restored));
        CHECK(err.find("map-mismatch") != std::string::npos);
        CHECK(remapped.Stats().corruptRungsSkipped == 0);
    }
    SUBCASE("serializer layout changed") {
        GameStateStore store(tdb.db, MakeCfg("g1", 3));
        FakeSim newSim;
        newSim.layout = 0x0F0F0F0Full;    // a different serialized shape
        store.SetSerializer(&newSim);
        int32_t restored = 0;
        CHECK_FALSE(store.RestoreNewestValid(1, err, restored));
        CHECK(err.find("engine-mismatch") != std::string::npos);
    }
}

TEST_CASE("a failing serializer fails the checkpoint without writing a row") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg());
    store.SetSerializer(&sim);

    sim.frame = 55;
    sim.failSerialize = true;
    std::string err;
    CHECK(store.Checkpoint(1, "auto", err) < 0);
    CHECK(err == "synthetic serialize failure");
    CHECK(CountRows(tdb.db, "g1") == 0);
    CHECK(store.Stats().checkpointsFailed == 1);
    CHECK(store.Stats().checkpointsCommitted == 0);
}

TEST_CASE("a sim that refuses a valid snapshot leaves the store's history intact") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg());
    store.SetSerializer(&sim);

    sim.frame = 10;
    sim.FillState(128, 3);
    std::string err;
    REQUIRE(store.Checkpoint(1, "auto", err) == 10);

    sim.failDeserialize = true;
    CHECK_FALSE(store.Restore(1, 10, err));
    CHECK(err == "synthetic deserialize refusal");
    CHECK(store.Stats().restores == 0);
    // The row is still there — a refused restore is not a lost snapshot.
    CHECK(CountRows(tdb.db, "g1") == 1);
}

TEST_CASE("restoring a frame that was never checkpointed refuses by name") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg());
    store.SetSerializer(&sim);
    sim.frame = 10;
    sim.FillState(64, 1);
    std::string err;
    REQUIRE(store.Checkpoint(1, "auto", err) == 10);

    CHECK_FALSE(store.Restore(1, 999, err));
    CHECK(err.find("999") != std::string::npos);

    int32_t restored = 0;
    GameStateStore empty(tdb.db, MakeCfg("no-such-game"));
    empty.SetSerializer(&sim);
    CHECK_FALSE(empty.RestoreNewestValid(1, err, restored));
    CHECK(err.find("no snapshots") != std::string::npos);
}

TEST_CASE("async checkpoints are double-buffered and all commit on flush") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg("g1", 16));
    store.SetSerializer(&sim);

    std::string err;
    for (int i = 1; i <= 8; ++i) {
        sim.frame = i;
        sim.FillState(4096, uint8_t(i));
        REQUIRE(store.CheckpointAsync(1, "auto", err) == i);
    }
    store.Flush();

    CHECK(store.Stats().checkpointsCommitted == 8);
    CHECK(store.Stats().checkpointsFailed == 0);
    CHECK(CountRows(tdb.db, "g1") == 8);
    // The sim thread only ever paid for the serialize step.
    CHECK(sim.serializeCalls == 8);
}

TEST_CASE("atomicity: a failed write leaves the previous snapshot intact") {
    TempDb tdb;
    FakeSim sim;
    GameStateStore store(tdb.db, MakeCfg("g1", 3));
    store.SetSerializer(&sim);

    sim.frame = 10;
    sim.FillState(1024, 1);
    const std::vector<uint8_t> good = sim.state;
    std::string err;
    REQUIRE(store.Checkpoint(1, "auto", err) == 10);

    // Stand in for "killed mid-write": make the INSERT fail at commit time by
    // dropping the table's write path out from under the store. The store must
    // report the failure and must not have destroyed the committed history.
    REQUIRE(sqlite3_exec(tdb.db,
        "CREATE TRIGGER block_ins BEFORE INSERT ON game_snapshots"
        " BEGIN SELECT RAISE(ABORT, 'disk full'); END", nullptr, nullptr, nullptr) == SQLITE_OK);

    sim.frame = 20;
    sim.FillState(1024, 2);
    CHECK(store.Checkpoint(1, "auto", err) < 0);
    CHECK_FALSE(err.empty());
    CHECK(store.Stats().checkpointsFailed == 1);

    REQUIRE(sqlite3_exec(tdb.db, "DROP TRIGGER block_ins", nullptr, nullptr, nullptr) == SQLITE_OK);

    // Frame 10 survived the failed write, byte-for-byte.
    CHECK(CountRows(tdb.db, "g1") == 1);
    sim.state.clear();
    int32_t restored = -1;
    CHECK(store.RestoreNewestValid(1, err, restored));
    CHECK(restored == 10);
    CHECK(sim.state == good);
}

TEST_CASE("EnsureTables is idempotent and safe on a null handle") {
    TempDb tdb;
    GameStateStore::EnsureTables(tdb.db);
    GameStateStore::EnsureTables(tdb.db);
    GameStateStore::EnsureTables(nullptr);
    CHECK(CountRows(tdb.db, "anything") == 0);
}
