// ReplayFile — the on-disk container for a recorded cause stream
// (PLAN-replay.md §1 "the replay artefact", task 2).
//
// WHAT THIS IS
// ------------
// PLAN-replay §1 defines a replay as `header + start checkpoint + frame-stamped
// command journal + checkpoint index + state-hash track`. This module owns the
// two halves that task 2 needs to feed a re-execution: the **header** (enough
// launch spec that `--replay <file>` alone can bring up an identical server)
// and the **record stream** (syncedinput::Record, verbatim, in seq order).
//
// Task 3 added the remaining three sections through that same seam: the
// **state-hash track** (recorded live, the reference series `--replay --verify`
// re-executes against), the **checkpoint index** and the **embedded start
// checkpoint**. The last two are format-complete and plumbed but carry no bytes
// yet — the blobs are PLAN-persistence's `ISimSerializer` output, which is
// unbuilt. That is stated rather than faked: a reader sees an empty index, not
// a fabricated one.
//
// COMPRESSION IS AN EXPORT STEP, NOT A RECORDING ONE (task 3)
// -----------------------------------------------------------
// PLAN-replay §1 calls the shareable artefact a "zstd container". The *codec*
// is a documented deviation (see Codec below); the *placement* is a deliberate
// design decision. A live recorder writes codec `None` — uncompressed, one
// block at a time — because a torn compressed stream is unrecoverable and would
// destroy the E1 truncation guarantee below, which is the property that makes a
// crashed server's file useful at all. `Pack()` compresses a *complete* segment
// at export time, when there is nothing left to lose.
//
// WHY NOT FLATBUFFERS
// -------------------
// Same reason SyncedInputJournal.h stays free of generated headers: this module
// must link into spring-tests without dragging in the sim or the wire schema,
// so the framing/truncation guarantees below are covered by a plain doctest.
// The encoding is dumb, little-endian and length-prefixed — a decoder is a
// mirror of the encoder, and every field is fixed-width or length-prefixed.
//
// TRUNCATION IS A FIRST-CLASS OUTCOME (§6 E1)
// -------------------------------------------
// A game server that crashes mid-write leaves a file whose last record is
// half-written and whose trailer is absent. That is the E1 case the plan
// specifies, and `Load` handles it by returning every complete record it read
// plus `truncated = true` — never an error, never a silently short replay with
// no explanation. The trailer is what distinguishes "the recording ended" from
// "the recorder died"; a reader that ignores it cannot tell those apart.
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "SyncedInputJournal.h"

namespace replay {

/// Bumped on any incompatible framing change. Readers refuse a file whose
/// version they do not know rather than misparse it. Adding a *section* does
/// not need a bump: sections are introduced as new block markers, and an
/// unknown marker is a hard stop with a named error, which is what forces the
/// version discussion to happen.
///
/// v2 (task 3) is such a bump, for two reasons the marker seam could not
/// absorb: a **codec byte** now sits between the version and the header (so a
/// packed file is self-describing rather than needing a second magic), and the
/// **trailer grew two counts**. A v1 reader would mis-frame both. Refusing v1
/// costs nothing — a replay is same-binary bound by construction (§1), so no v1
/// file outlives the binary that could replay it anyway.
constexpr uint16_t kFormatVersion = 2;

constexpr char kMagic[8] = {'M', 'S', 'R', 'E', 'P', 'L', 'A', 'Y'};

/// How the body after the codec byte is stored.
///
/// FIDELITY-STANDIN: PLAN-replay §1 specifies a **zstd** container. This tree
/// does not link zstd, and `find_package(ZSTD REQUIRED)` would add a new hard
/// system dependency to four targets on a CI runner whose brew step is already
/// the standing breakage (PLAN.md security S-A). zlib is `REQUIRED` and already
/// linked into every target that touches this file, so `Deflate` is what ships.
/// `Zstd` keeps its wire value reserved so adopting it later is a codec-byte
/// addition, not a format break — no reader written today will misparse one.
enum class Codec : uint8_t {
    None    = 0,   ///< raw blocks; what a live recorder always writes
    Deflate = 1,   ///< zlib, whole-body; what `Pack()` writes
    Zstd    = 2,   ///< RESERVED — not implemented, refused with a named error
};

/// One reference point of the determinism-hash track (§4). Recorded live at a
/// fixed frame cadence and re-computed at the identical tick position during
/// `--replay --verify`; a mismatch locates a divergence to a frame.
struct HashPoint {
    int32_t  frame = 0;
    uint64_t hash  = 0;
};

/// One entry of the checkpoint index (§1, "seek points, every ~5 min").
/// `blob` is PLAN-persistence's serialized sim state. Format-complete and
/// empty today: nothing writes one, because `ISimSerializer` is unbuilt.
struct Checkpoint {
    int32_t frame = 0;
    std::vector<uint8_t> blob;
};

/// The launch spec a replay server needs to reconstruct an identical world.
/// `--replay <file>` fills every CLI-equivalent field from here, so a replay is
/// self-contained: no "remember which map it was" step, and a mismatch between
/// the recording's content and the replaying binary's content is detectable
/// (engineHash/defsCacheKey) instead of surfacing as an unexplained divergence.
struct Header {
    std::string engineHash;      ///< build identity; a replay is same-binary bound (§1)
    std::string gameId;
    std::string gameVersion;
    std::string mapId;
    std::string defsCacheKey;    ///< the defs hash the recording ran against
    uint32_t    roomId    = 0;
    int32_t     startFrame = 0;  ///< frame the stream begins at (0 = from launch)
    uint64_t    seed      = 0;   ///< synced RNG state at record start, 0 if unknown
    std::string recordedAt;      ///< ISO-8601, informational only

    /// `key=value` modoptions, in the order the launcher passed them. These
    /// change synced gadget behaviour AND the defs-cache key, so a replay that
    /// dropped them would diverge on frame 1.
    std::vector<std::pair<std::string, std::string>> modOptions;

    /// `username:team:startPos` roster entries (the `--player` flags).
    struct PlayerSlot { std::string username; int team = 0; int startPos = -1; };
    std::vector<PlayerSlot> players;

    /// `id:team:startPos` AI slots (the `--ai` flags). A replay re-creates the
    /// slots — the AI's *virtual player* registration and team leadership are
    /// synced state — but suppresses the AI runtime's output and feeds the
    /// recorded AICommand records instead (see ReplayPlayer.h).
    struct AiSlot { std::string aiId; int team = 0; int startPos = -1; };
    std::vector<AiSlot> aiSlots;
};

/// Written on a clean close. Its ABSENCE is the E1 truncation signal.
struct Trailer {
    int32_t  endFrame    = -1;   ///< last frame the recording server ticked
    uint64_t recordCount = 0;    ///< records written; a cross-check on the stream
    uint64_t hashPointCount  = 0;  ///< §4 reference points written
    uint64_t checkpointCount = 0;  ///< index entries written (0 until persistence lands)
};

// ─────────────────────────────── Writing ───────────────────────────────
/// Streaming recorder. Implements syncedinput::IJournal so it plugs straight
/// into the funnel — the recording path is literally "attach this and run".
///
/// Durability: buffered writes with an explicit Flush() the server calls once
/// per tick. Per-append fsync would put a syscall on the sim thread's hot path
/// for no benefit — the failure mode it would buy back is exactly the E1
/// truncation the format already handles.
class Writer : public syncedinput::IJournal {
public:
    Writer() = default;
    ~Writer() override;

    Writer(const Writer&) = delete;
    Writer& operator=(const Writer&) = delete;

    /// Create/truncate `path` and write magic + version + header. Returns false
    /// and fills `err` on any I/O failure (the caller treats that as fatal:
    /// silently recording nothing is the one outcome a journal must not have).
    bool Open(const std::string& path, const Header& h, std::string& err);

    bool Enabled() const override { return fp != nullptr; }
    void Append(syncedinput::Record&& r) override;

    /// Append one determinism-hash reference point (§4). The caller must emit
    /// these at a *fixed frame cadence and a fixed position in the tick*: the
    /// verifier re-computes the hash from the identical site, and a reference
    /// taken a few statements earlier in the tick than the check is a false
    /// divergence that looks exactly like a real one.
    void AppendHashPoint(int32_t frame, uint64_t hash);

    /// Append one checkpoint-index entry. Nothing calls this yet — the blob is
    /// PLAN-persistence's serialized sim state and that serializer is unbuilt.
    void AppendCheckpoint(int32_t frame, const std::vector<uint8_t>& blob);

    /// Embed the start checkpoint (§1). Must be called before the first
    /// Append() so it lands ahead of the stream; also unused today, same reason.
    void WriteStartCheckpoint(const std::vector<uint8_t>& blob);

    /// Push buffered bytes to the OS. Called at tick end.
    void Flush();

    /// Write the trailer and close. After this the file is a *clean* recording;
    /// skipping it (crash, kill -9) leaves the truncation marker set instead.
    /// `t`'s hashPointCount/checkpointCount are overwritten with what was
    /// actually written — the trailer states fact, not intent.
    void Close(Trailer t);

    uint64_t Written() const { return written; }
    uint64_t HashPointsWritten() const { return hashPoints; }
    uint64_t CheckpointsWritten() const { return checkpoints; }
    bool     Failed() const { return failed; }

private:
    void WriteBlock(const std::vector<uint8_t>& buf);

    std::FILE* fp      = nullptr;
    uint64_t   written = 0;
    uint64_t   hashPoints  = 0;
    uint64_t   checkpoints = 0;
    bool       failed  = false;
    bool       streamStarted = false;   ///< guards WriteStartCheckpoint's ordering
    std::string path;
};

// ─────────────────────────────── Reading ───────────────────────────────
struct LoadResult {
    bool ok = false;                 ///< false = unusable (bad magic/version/header)
    std::string error;
    Header  header;
    Trailer trailer;
    Codec   codec = Codec::None;     ///< how the file on disk stored its body
    /// True when the file ended without a trailer, or on a half-written record.
    /// `records` still holds every complete record read up to that point (E1).
    bool truncated = false;
    std::vector<syncedinput::Record> records;
    std::vector<HashPoint>  hashTrack;     ///< §4 reference series, frame order
    std::vector<Checkpoint> checkpoints;   ///< seek index (empty today)
    std::vector<uint8_t>    startCheckpoint;  ///< §1 embedded start state (empty today)
};

/// Read a whole replay file into memory, transparently decompressing a packed
/// one. Records come back in file order, which is seq order — the funnel
/// appends monotonically. Blocks of different KINDS may be interleaved in any
/// order: the reader buckets by marker and never assumes a section layout, so
/// a streaming recorder and the packer can write the same file differently.
LoadResult Load(const std::string& path);

// ─────────────────────── Export / import (the `.msr` packer) ───────────────
/// Write a complete container from in-memory content. Section order is
/// canonical (start checkpoint → records → hash points → checkpoints), so
/// packing the same content twice is byte-identical. `content.truncated`
/// is honoured: a truncated segment is re-emitted WITHOUT a trailer, so the
/// packed copy still reads as truncated rather than laundering a crashed
/// recording into a clean-looking one.
bool WriteFile(const std::string& path, const LoadResult& content, Codec codec,
               std::string& err);

/// Load `in`, re-emit it to `out` under `codec`. `Codec::Deflate` is the export
/// form (shareable, ~one order of magnitude smaller on a real stream);
/// `Codec::None` is the import/unpack form. Round-tripping is lossless.
bool Pack(const std::string& in, const std::string& out, Codec codec,
          std::string& err);

/// Parse a codec name for the CLI. Returns false on an unknown/unimplemented
/// name (including "zstd", which is reserved but not built).
bool ParseCodec(const std::string& name, Codec& out, std::string& err);
const char* CodecName(Codec c);

// ───────────────────── Encoding primitives (test seam) ─────────────────
/// Encode/decode one record. Exposed so the doctest can prove round-trip
/// fidelity and truncation behaviour without touching the filesystem.
void EncodeRecord(const syncedinput::Record& r, std::vector<uint8_t>& out);

/// Decode one record starting at `offset` (which must point at the record
/// marker). Advances `offset` past the record on success. Returns false on a
/// short/garbled buffer WITHOUT advancing — the caller treats that as E1
/// truncation, not corruption, when it happens at the end of a file.
bool DecodeRecord(const std::vector<uint8_t>& buf, size_t& offset,
                  syncedinput::Record& out);

std::string EncodeHeaderJson(const Header& h);
bool DecodeHeaderJson(const std::string& json, Header& out, std::string& err);

}  // namespace replay
