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
// The remaining three sections — the embedded start checkpoint, the checkpoint
// index and the state-hash track — are PLAN-replay task 3's `.msr` packer and
// PLAN-persistence's snapshot blobs. They are deliberately NOT invented here:
// the container is a versioned, section-agnostic frame so task 3 can add them
// without a format break (see kFormatVersion's comment).
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
/// version they do not know rather than misparse it. Adding a *section* (task
/// 3's checkpoint index / hash track) does not need a bump: sections are
/// introduced as new block markers, and an unknown marker is a hard stop with
/// a named error, which is what forces the version discussion to happen.
constexpr uint16_t kFormatVersion = 1;

constexpr char kMagic[8] = {'M', 'S', 'R', 'E', 'P', 'L', 'A', 'Y'};

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

    /// Push buffered bytes to the OS. Called at tick end.
    void Flush();

    /// Write the trailer and close. After this the file is a *clean* recording;
    /// skipping it (crash, kill -9) leaves the truncation marker set instead.
    void Close(const Trailer& t);

    uint64_t Written() const { return written; }
    bool     Failed() const { return failed; }

private:
    std::FILE* fp      = nullptr;
    uint64_t   written = 0;
    bool       failed  = false;
    std::string path;
};

// ─────────────────────────────── Reading ───────────────────────────────
struct LoadResult {
    bool ok = false;                 ///< false = unusable (bad magic/version/header)
    std::string error;
    Header  header;
    Trailer trailer;
    /// True when the file ended without a trailer, or on a half-written record.
    /// `records` still holds every complete record read up to that point (E1).
    bool truncated = false;
    std::vector<syncedinput::Record> records;
};

/// Read a whole replay file into memory. Records come back in file order, which
/// is seq order — the funnel appends monotonically.
LoadResult Load(const std::string& path);

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
