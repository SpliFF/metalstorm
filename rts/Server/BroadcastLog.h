// BroadcastLog — the `.msb` on-disk container for a TAPPED outbound stream
// (PLAN-beta.md "Design decisions — delayed spectating", PLAN-beta-broadcast.md
// lane S1).
//
// WHAT THIS IS — AND WHAT IT IS NOT
// ---------------------------------
// A `.msr` replay holds CAUSES (syncedinput::Record inputs) and is re-executed.
// A `.msb` broadcast log holds EFFECTS: the exact bytes a global-visibility
// spectator was sent, frame- and wall-stamped, in send order. Playing one back
// is a memcpy and a clock, never a sim — which is the whole reason the decision
// of record is "broadcast tap, not re-execution" (a watch room costs no sim).
//
// It reuses `replay::Header` verbatim rather than inventing a second launch
// spec: a relay needs exactly what a replay server needs to answer an
// AuthResponse and let a client fetch defs (gameId, mapId, defsCacheKey,
// schemaHash, roomId, modOptions, players), and two structs that must agree
// forever is a divergence waiting to happen.
//
// FRAMING DISCIPLINE — same as ReplayFile.h, deliberately
// ------------------------------------------------------
// Dumb little-endian, marker-typed blocks, length-prefixed payloads, no
// FlatBuffers (so this links into spring-tests without the sim or the wire
// schema), and a torn tail is FIRST-CLASS: the trailer's ABSENCE is the signal
// that the recorder died or is still running. Unlike a replay, "still running"
// is the *normal* state here — a live mission's log is read while it grows.
//
// No compression at any layer. A packed body cannot be appended to or read from
// a growing file, and both are the point.
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "ReplayFile.h"

namespace broadcast {

/// Bumped on any incompatible framing change; a reader refuses an unknown
/// version rather than misparse it. Adding a *block* does not need a bump —
/// a new marker is a named hard stop, which forces the discussion.
constexpr uint16_t kFormatVersion = 1;

constexpr char kMagic[8] = {'M', 'S', 'B', 'C', 'A', 'S', 'T', '\0'};

/// Keyframe cadence: 1800 frames = 60 s at 30 Hz. A backward seek lands on the
/// nearest `K` at or before the target, so this is the worst-case catch-up
/// distance a watcher pays for a seek — and the granularity of the whole
/// stream's random access.
constexpr int kKeyframeFrames = 1800;

/// One tapped send. `cls`/`lane` are the `(StreamClass, lane)` pair the
/// funnel already tags every byte with; keeping them means a relay re-sends on
/// the identical tier and newest-wins lane rather than guessing one.
struct Record {
    uint64_t wallMs    = 0;   ///< recorder wall clock, the pacing authority
    int32_t  frame     = 0;   ///< sim frame at send time
    uint8_t  cls       = 0;   ///< StreamClass (Control/State/Vision/Bulk)
    uint8_t  lane      = 0;   ///< newest-wins lane within the State tier
    uint8_t  broadcast = 0;   ///< 1 = came from BroadcastStream (fan out per watcher)
    std::vector<uint8_t> payload;
};

/// One `K` block: "a re-emitted join bundle follows". `offset` is the byte
/// offset OF THE MARKER, so a seek is `Reader::SeekTo(kf.offset)` and the next
/// `Next()` returns the first record of the bundle.
struct Keyframe {
    uint64_t wallMs = 0;
    int32_t  frame  = 0;
    uint64_t offset = 0;
};

/// Written on a clean close. Its ABSENCE means the log is live or the recorder
/// died — a distinction a broadcast catalogue has to draw to label a mission
/// "live" vs "recorded", so it can never be inferred from content.
struct Trailer {
    int32_t  endFrame      = -1;
    uint64_t endWallMs     = 0;
    uint64_t recordCount   = 0;
    uint64_t keyframeCount = 0;
};

// ─────────────────────────────── Writing ───────────────────────────────
/// Streaming recorder. Buffered, with an explicit Flush() the server calls once
/// per tick beside `replayWriter.Flush()`. Per-append fsync would put a syscall
/// on the sim thread for no benefit — the failure it would buy back is exactly
/// the torn tail the format already handles.
class Writer {
public:
    Writer() = default;
    ~Writer();
    Writer(const Writer&) = delete;
    Writer& operator=(const Writer&) = delete;

    /// Create `path` (replacing any existing file), write magic + version +
    /// header JSON.
    bool Open(const std::string& path, const replay::Header& h, std::string& err);
    bool Enabled() const { return fp != nullptr; }

    void AppendRecord(uint64_t wallMs, int32_t frame, uint8_t cls, uint8_t lane,
                      bool broadcast, const uint8_t* data, size_t len);
    void AppendKeyframe(uint64_t wallMs, int32_t frame);

    void Flush();
    /// Write the trailer and close. `t`'s counts are overwritten with what was
    /// actually written — the trailer states fact, not intent.
    void Close(Trailer t);

    uint64_t Written() const { return records; }
    uint64_t KeyframesWritten() const { return keyframes; }
    uint64_t BytesWritten() const { return bytes; }
    bool     Failed() const { return failed; }

private:
    void WriteBlock(const std::vector<uint8_t>& buf);

    std::FILE* fp = nullptr;
    uint64_t records   = 0;
    uint64_t keyframes = 0;
    uint64_t bytes     = 0;   ///< payload bytes tapped, for the rate estimate
    bool     failed    = false;
    std::string path;
};

// ─────────────────────────────── Reading ───────────────────────────────
/// A streaming cursor over a log that MAY STILL BE GROWING.
///
/// `Next()` returns false on a short tail WITHOUT advancing the cursor: a
/// half-written block at the end of a live file is not corruption, it is the
/// recorder mid-write, and the next `Rescan()` completes it. That is the one
/// behaviour that separates this reader from `replay::Load` — a replay is read
/// once, whole, after the fact; a broadcast is read while it is being written.
class Reader {
public:
    Reader() = default;
    ~Reader();
    Reader(const Reader&) = delete;
    Reader& operator=(const Reader&) = delete;

    /// Open and consume magic/version/header. Leaves the cursor at the first
    /// block. Returns false and fills `err` on a bad magic/version/header.
    bool Open(const std::string& path, std::string& err);

    const replay::Header& GetHeader() const { return header; }

    /// Pick up bytes appended since the last call (re-stats the file).
    /// Returns true if the known size grew.
    bool Rescan();

    /// Read the next `R` block. False = nothing complete at the cursor (end of
    /// the known bytes, or a torn tail). `K` and `T` blocks encountered on the
    /// way are consumed and recorded in `Keyframes()`/`GetTrailer()`.
    bool Next(Record& out);

    /// Byte offset of the cursor; a `Keyframe::offset` is valid here.
    uint64_t Offset() const { return cursor; }
    bool SeekTo(uint64_t offset);

    /// Keyframes seen so far by this cursor. `ScanIndex()` fills it for the
    /// whole known file without disturbing the cursor or copying a payload.
    const std::vector<Keyframe>& Keyframes() const { return keyframeIndex; }
    void ScanIndex();

    bool SawTrailer() const { return sawTrailer; }
    const Trailer& GetTrailer() const { return trailer; }
    /// True once a block was found torn or carried an unknown marker — the
    /// cursor stops there rather than guessing where the next block starts.
    bool Torn() const { return torn; }

private:
    bool ReadAt(uint64_t off, void* dst, size_t len);

    std::FILE* fp = nullptr;
    std::string path;
    uint64_t knownSize = 0;
    uint64_t cursor    = 0;
    replay::Header header;
    std::vector<Keyframe> keyframeIndex;
    Trailer trailer;
    bool sawTrailer = false;
    bool torn = false;
};

// ─────────────────────────── Listing / summary ─────────────────────────
/// What a broadcast catalogue needs about a file, which is everything except
/// the payloads. Built by a single skip-scan over the framing (no payload is
/// ever copied), exactly like `replay::LoadSummary`.
struct Summary {
    bool ok = false;
    std::string error;
    std::string path;
    uint64_t fileBytes = 0;

    replay::Header header;
    Trailer trailer;
    bool truncated = false;      ///< no trailer: still live, or the recorder died

    uint64_t recordCount = 0;
    uint64_t payloadBytes = 0;
    int32_t  firstFrame  = -1;
    int32_t  lastFrame   = -1;
    uint64_t firstWallMs = 0;    ///< the catalogue's "available_since" input
    uint64_t lastWallMs  = 0;
    std::vector<Keyframe> keyframes;

    /// Frame a viewer should be told the log runs to: the trailer when clean,
    /// the last record's frame when the tail is torn or still growing.
    int32_t EndFrame() const { return truncated ? lastFrame : trailer.endFrame; }
};

Summary LoadSummary(const std::string& path);

}  // namespace broadcast
