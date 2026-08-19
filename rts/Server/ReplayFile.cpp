#include "ReplayFile.h"

#include <nlohmann/json.hpp>
#include <zlib.h>

#include <algorithm>
#include <cstring>
#include <filesystem>
#include <memory>

#include <sys/stat.h>

using json = nlohmann::json;
using syncedinput::Record;

namespace replay {

namespace {

// Block markers. One byte in front of every block so a decoder that has lost
// framing stops at the first wrong byte instead of reading a length field out
// of a payload and allocating a gigabyte.
//
// A marker this build does not know is a NAMED HARD ERROR, not a skip: block
// lengths live inside the block, so an unknown marker means the reader cannot
// find the next one and every "recovered" byte after it would be guesswork.
constexpr uint8_t kRecordMarker     = 0x52;  // 'R'
constexpr uint8_t kTrailerMarker    = 0x54;  // 'T'
constexpr uint8_t kHashMarker       = 0x48;  // 'H' — task 3, state-hash track
constexpr uint8_t kCheckpointMarker = 0x43;  // 'C' — task 3, checkpoint index
constexpr uint8_t kStartCkptMarker  = 0x53;  // 'S' — task 3, embedded start state
constexpr uint8_t kOutcomeMarker    = 0x4F;  // 'O' — task 4c, how the game ended

void PutU8(std::vector<uint8_t>& o, uint8_t v) { o.push_back(v); }
void PutU32(std::vector<uint8_t>& o, uint32_t v) {
    for (int i = 0; i < 4; ++i) o.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
void PutU64(std::vector<uint8_t>& o, uint64_t v) {
    for (int i = 0; i < 8; ++i) o.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
void PutI32(std::vector<uint8_t>& o, int32_t v) {
    PutU32(o, static_cast<uint32_t>(v));
}

bool GetU8(const std::vector<uint8_t>& b, size_t& p, uint8_t& v) {
    if (p + 1 > b.size()) return false;
    v = b[p++];
    return true;
}
bool GetU32(const std::vector<uint8_t>& b, size_t& p, uint32_t& v) {
    if (p + 4 > b.size()) return false;
    v = 0;
    for (int i = 0; i < 4; ++i) v |= static_cast<uint32_t>(b[p + i]) << (8 * i);
    p += 4;
    return true;
}
bool GetU64(const std::vector<uint8_t>& b, size_t& p, uint64_t& v) {
    if (p + 8 > b.size()) return false;
    v = 0;
    for (int i = 0; i < 8; ++i) v |= static_cast<uint64_t>(b[p + i]) << (8 * i);
    p += 8;
    return true;
}
bool GetI32(const std::vector<uint8_t>& b, size_t& p, int32_t& v) {
    uint32_t u = 0;
    if (!GetU32(b, p, u)) return false;
    v = static_cast<int32_t>(u);
    return true;
}

// ── zlib whole-body codec ──
// Whole-body rather than per-block: the body of a finished segment is one
// object, the dictionary is shared across every record (wire messages repeat
// heavily), and a packed file is never appended to. See the header's note on
// why compression is an export step and never a recording one.
bool DeflateAll(const std::vector<uint8_t>& in, std::vector<uint8_t>& out,
                std::string& err) {
    uLongf cap = compressBound(static_cast<uLong>(in.size()));
    out.resize(cap);
    const int rc = compress2(out.data(), &cap, in.data(),
                             static_cast<uLong>(in.size()), Z_BEST_COMPRESSION);
    if (rc != Z_OK) {
        err = "replay pack: zlib compress2 failed (" + std::to_string(rc) + ")";
        return false;
    }
    out.resize(cap);
    return true;
}

bool InflateAll(const uint8_t* in, size_t inLen, size_t rawLen,
                std::vector<uint8_t>& out, std::string& err) {
    out.resize(rawLen);
    uLongf got = static_cast<uLongf>(rawLen);
    const int rc = uncompress(out.data(), &got, in, static_cast<uLong>(inLen));
    if (rc != Z_OK) {
        err = "replay is packed but its body failed to decompress (zlib " +
              std::to_string(rc) + ")";
        return false;
    }
    // A short inflate means the declared raw length lied. Trusting it would
    // hand the block parser a buffer whose tail is uninitialised, which reads
    // as an unknown marker at a random offset — a confusing way to say
    // "corrupt file".
    if (got != rawLen) {
        err = "replay body decompressed to " + std::to_string(got) +
              " bytes, header claimed " + std::to_string(rawLen);
        return false;
    }
    return true;
}

}  // namespace

const char* CodecName(Codec c) {
    switch (c) {
        case Codec::None:    return "none";
        case Codec::Deflate: return "deflate";
        case Codec::Zstd:    return "zstd";
    }
    return "?";
}

bool ParseCodec(const std::string& name, Codec& out, std::string& err) {
    if (name == "none" || name == "raw")   { out = Codec::None;    return true; }
    if (name == "deflate" || name == "zlib") { out = Codec::Deflate; return true; }
    if (name == "zstd") {
        err = "codec 'zstd' is reserved in the format but not built "
              "(this tree links zlib, not libzstd) — use 'deflate'";
        return false;
    }
    err = "unknown replay codec '" + name + "' (want none|deflate)";
    return false;
}

// ────────────────────────────── Encoding ──────────────────────────────
void EncodeRecord(const Record& r, std::vector<uint8_t>& out) {
    PutU8(out, kRecordMarker);
    PutU64(out, r.seq);
    PutI32(out, r.frame);
    PutU8(out, static_cast<uint8_t>(r.phase));
    PutU8(out, static_cast<uint8_t>(r.kind));
    PutU8(out, r.subKind);
    PutI32(out, r.playerId);
    PutU32(out, r.clientId);
    PutU32(out, static_cast<uint32_t>(r.payload.size()));
    out.insert(out.end(), r.payload.begin(), r.payload.end());
}

bool DecodeRecord(const std::vector<uint8_t>& buf, size_t& offset, Record& out) {
    size_t p = offset;
    uint8_t marker = 0;
    if (!GetU8(buf, p, marker) || marker != kRecordMarker) return false;

    Record r;
    uint8_t phase = 0, kind = 0;
    uint32_t len = 0;
    if (!GetU64(buf, p, r.seq))       return false;
    if (!GetI32(buf, p, r.frame))     return false;
    if (!GetU8(buf, p, phase))        return false;
    if (!GetU8(buf, p, kind))         return false;
    if (!GetU8(buf, p, r.subKind))    return false;
    if (!GetI32(buf, p, r.playerId))  return false;
    if (!GetU32(buf, p, r.clientId))  return false;
    if (!GetU32(buf, p, len))         return false;
    if (p + len > buf.size())         return false;

    r.phase = static_cast<syncedinput::TickPhase>(phase);
    r.kind  = static_cast<syncedinput::InputKind>(kind);
    r.payload.assign(buf.begin() + static_cast<long>(p),
                     buf.begin() + static_cast<long>(p + len));
    p += len;

    out = std::move(r);
    offset = p;
    return true;
}

std::string EncodeHeaderJson(const Header& h) {
    json j;
    j["engineHash"]   = h.engineHash;
    j["gameId"]       = h.gameId;
    j["gameVersion"]  = h.gameVersion;
    j["mapId"]        = h.mapId;
    j["defsCacheKey"] = h.defsCacheKey;
    j["roomId"]       = h.roomId;
    j["startFrame"]   = h.startFrame;
    j["seed"]         = h.seed;
    j["recordedAt"]   = h.recordedAt;

    json mo = json::array();
    for (const auto& kv : h.modOptions)
        mo.push_back(json{{"key", kv.first}, {"value", kv.second}});
    j["modOptions"] = std::move(mo);

    json ps = json::array();
    for (const auto& p : h.players)
        ps.push_back(json{{"username", p.username}, {"team", p.team},
                          {"startPos", p.startPos}});
    j["players"] = std::move(ps);

    json ai = json::array();
    for (const auto& s : h.aiSlots)
        ai.push_back(json{{"aiId", s.aiId}, {"team", s.team},
                          {"startPos", s.startPos}});
    j["aiSlots"] = std::move(ai);

    return j.dump();
}

bool DecodeHeaderJson(const std::string& text, Header& out, std::string& err) {
    json j = json::parse(text, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object()) {
        err = "replay header is not valid JSON";
        return false;
    }
    out.engineHash   = j.value("engineHash", std::string());
    out.gameId       = j.value("gameId", std::string());
    out.gameVersion  = j.value("gameVersion", std::string());
    out.mapId        = j.value("mapId", std::string());
    out.defsCacheKey = j.value("defsCacheKey", std::string());
    out.roomId       = j.value("roomId", 0u);
    out.startFrame   = j.value("startFrame", 0);
    out.seed         = j.value("seed", uint64_t{0});
    out.recordedAt   = j.value("recordedAt", std::string());

    out.modOptions.clear();
    if (j.contains("modOptions") && j["modOptions"].is_array()) {
        for (const auto& e : j["modOptions"]) {
            if (!e.is_object()) continue;
            out.modOptions.emplace_back(e.value("key", std::string()),
                                        e.value("value", std::string()));
        }
    }
    out.players.clear();
    if (j.contains("players") && j["players"].is_array()) {
        for (const auto& e : j["players"]) {
            if (!e.is_object()) continue;
            Header::PlayerSlot p;
            p.username = e.value("username", std::string());
            p.team     = e.value("team", 0);
            p.startPos = e.value("startPos", -1);
            out.players.push_back(std::move(p));
        }
    }
    out.aiSlots.clear();
    if (j.contains("aiSlots") && j["aiSlots"].is_array()) {
        for (const auto& e : j["aiSlots"]) {
            if (!e.is_object()) continue;
            Header::AiSlot s;
            s.aiId     = e.value("aiId", std::string());
            s.team     = e.value("team", 0);
            s.startPos = e.value("startPos", -1);
            out.aiSlots.push_back(std::move(s));
        }
    }
    return true;
}

// ───────────────────────── Section block encoders ─────────────────────
namespace {

void EncodeHashPoint(const HashPoint& p, std::vector<uint8_t>& out) {
    PutU8(out, kHashMarker);
    PutI32(out, p.frame);
    PutU64(out, p.hash);
}

void EncodeOutcome(const Outcome& o, std::vector<uint8_t>& out) {
    PutU8(out, kOutcomeMarker);
    PutI32(out, o.frame);
    PutU32(out, static_cast<uint32_t>(o.winningAllyTeams.size()));
    out.insert(out.end(), o.winningAllyTeams.begin(), o.winningAllyTeams.end());
}

void EncodeBlob(uint8_t marker, int32_t frame, const std::vector<uint8_t>& blob,
                std::vector<uint8_t>& out) {
    PutU8(out, marker);
    if (marker == kCheckpointMarker) PutI32(out, frame);
    PutU32(out, static_cast<uint32_t>(blob.size()));
    out.insert(out.end(), blob.begin(), blob.end());
}

/// Everything after the codec byte, for codec None: the header plus every
/// block in canonical section order. Shared by the packer and the round-trip
/// test; the streaming Writer emits the same blocks in arrival order instead.
std::vector<uint8_t> BuildBody(const LoadResult& c) {
    std::vector<uint8_t> body;
    const std::string hjson = EncodeHeaderJson(c.header);
    PutU32(body, static_cast<uint32_t>(hjson.size()));
    body.insert(body.end(), hjson.begin(), hjson.end());

    if (!c.startCheckpoint.empty())
        EncodeBlob(kStartCkptMarker, 0, c.startCheckpoint, body);
    for (const auto& r : c.records) EncodeRecord(r, body);
    for (const auto& h : c.hashTrack) EncodeHashPoint(h, body);
    for (const auto& cp : c.checkpoints)
        EncodeBlob(kCheckpointMarker, cp.frame, cp.blob, body);
    // Ahead of the trailer, mirroring the live writer: the outcome is the last
    // thing the game knows before the recording is closed.
    if (c.outcome.declared) EncodeOutcome(c.outcome, body);

    // A truncated segment stays trailer-less, so the repacked copy still
    // announces itself as truncated (E1). Laundering one into a clean file
    // would be the single most misleading thing this packer could do.
    if (!c.truncated) {
        PutU8(body, kTrailerMarker);
        PutI32(body, c.trailer.endFrame);
        PutU64(body, c.trailer.recordCount);
        PutU64(body, c.trailer.hashPointCount);
        PutU64(body, c.trailer.checkpointCount);
    }
    return body;
}

}  // namespace

// ─────────────────────────────── Writer ───────────────────────────────
Writer::~Writer() {
    if (fp != nullptr) {
        // No trailer: a Writer destroyed without Close() is by definition an
        // abnormal end, and the reader must see it as truncated (E1).
        std::fclose(fp);
        fp = nullptr;
    }
}

bool Writer::Open(const std::string& p, const Header& h, std::string& err) {
    path = p;
    fp = std::fopen(p.c_str(), "wb");
    if (fp == nullptr) {
        err = "cannot open replay file for writing: " + p;
        return false;
    }

    const std::string hjson = EncodeHeaderJson(h);
    std::vector<uint8_t> pre;
    pre.insert(pre.end(), kMagic, kMagic + sizeof(kMagic));
    PutU8(pre, static_cast<uint8_t>(kFormatVersion & 0xFF));
    PutU8(pre, static_cast<uint8_t>((kFormatVersion >> 8) & 0xFF));
    // A live recording is always Codec::None — see the header's note: a torn
    // compressed body cannot be salvaged, and E1 salvage is the point.
    PutU8(pre, static_cast<uint8_t>(Codec::None));
    PutU32(pre, static_cast<uint32_t>(hjson.size()));
    pre.insert(pre.end(), hjson.begin(), hjson.end());

    if (std::fwrite(pre.data(), 1, pre.size(), fp) != pre.size()) {
        err = "short write on replay header: " + p;
        std::fclose(fp);
        fp = nullptr;
        return false;
    }
    std::fflush(fp);
    return true;
}

void Writer::WriteBlock(const std::vector<uint8_t>& buf) {
    if (std::fwrite(buf.data(), 1, buf.size(), fp) != buf.size()) {
        // A failed write is loud once and then latched — the alternative is a
        // journal that quietly stops being complete, which is the exact
        // failure mode this whole subsystem exists to rule out.
        failed = true;
    }
}

void Writer::Append(Record&& r) {
    if (fp == nullptr) return;
    std::vector<uint8_t> buf;
    buf.reserve(32 + r.payload.size());
    EncodeRecord(r, buf);
    const bool wasFailed = failed;
    WriteBlock(buf);
    streamStarted = true;
    if (!failed && !wasFailed) ++written;
}

void Writer::AppendHashPoint(int32_t frame, uint64_t hash) {
    if (fp == nullptr) return;
    std::vector<uint8_t> buf;
    EncodeHashPoint({frame, hash}, buf);
    const bool wasFailed = failed;
    WriteBlock(buf);
    streamStarted = true;
    if (!failed && !wasFailed) ++hashPoints;
}

void Writer::AppendCheckpoint(int32_t frame, const std::vector<uint8_t>& blob) {
    if (fp == nullptr) return;
    std::vector<uint8_t> buf;
    EncodeBlob(kCheckpointMarker, frame, blob, buf);
    const bool wasFailed = failed;
    WriteBlock(buf);
    streamStarted = true;
    if (!failed && !wasFailed) ++checkpoints;
}

void Writer::WriteStartCheckpoint(const std::vector<uint8_t>& blob) {
    if (fp == nullptr) return;
    // Ordering is a contract, not a preference: a start checkpoint written
    // after records have begun would describe a world the earlier records were
    // already applied to. Refusing loudly beats writing a plausible lie.
    if (streamStarted) { failed = true; return; }
    std::vector<uint8_t> buf;
    EncodeBlob(kStartCkptMarker, 0, blob, buf);
    WriteBlock(buf);
}

void Writer::WriteOutcome(int32_t frame, const std::vector<uint8_t>& winners) {
    if (fp == nullptr) return;
    std::vector<uint8_t> buf;
    EncodeOutcome({true, frame, winners}, buf);
    WriteBlock(buf);
    streamStarted = true;
}

void Writer::Flush() {
    if (fp != nullptr) std::fflush(fp);
}

void Writer::Close(Trailer t) {
    if (fp == nullptr) return;
    t.hashPointCount  = hashPoints;
    t.checkpointCount = checkpoints;
    std::vector<uint8_t> buf;
    PutU8(buf, kTrailerMarker);
    PutI32(buf, t.endFrame);
    PutU64(buf, t.recordCount);
    PutU64(buf, t.hashPointCount);
    PutU64(buf, t.checkpointCount);
    WriteBlock(buf);
    std::fflush(fp);
    std::fclose(fp);
    fp = nullptr;
}

// ─────────────────────────────── Reader ───────────────────────────────
LoadResult Load(const std::string& path) {
    LoadResult res;

    std::FILE* fp = std::fopen(path.c_str(), "rb");
    if (fp == nullptr) {
        res.error = "cannot open replay file: " + path;
        return res;
    }
    std::vector<uint8_t> buf;
    {
        uint8_t chunk[64 * 1024];
        size_t n = 0;
        while ((n = std::fread(chunk, 1, sizeof(chunk), fp)) > 0)
            buf.insert(buf.end(), chunk, chunk + n);
    }
    std::fclose(fp);

    size_t p = 0;
    if (buf.size() < sizeof(kMagic) + 2 + 1 ||
        std::memcmp(buf.data(), kMagic, sizeof(kMagic)) != 0) {
        res.error = "not a replay file (bad magic): " + path;
        return res;
    }
    p += sizeof(kMagic);

    uint8_t vlo = 0, vhi = 0;
    GetU8(buf, p, vlo);
    GetU8(buf, p, vhi);
    const uint16_t version = static_cast<uint16_t>(vlo | (vhi << 8));
    if (version != kFormatVersion) {
        res.error = "replay format version " + std::to_string(version) +
                    " != supported " + std::to_string(kFormatVersion);
        return res;
    }

    uint8_t codecByte = 0;
    if (!GetU8(buf, p, codecByte)) {
        res.error = "replay header truncated (no codec byte)";
        return res;
    }
    res.codec = static_cast<Codec>(codecByte);

    // A packed body is decompressed whole, then parsed by the same block loop
    // as an unpacked one — the codec is a storage detail, never a second format.
    std::vector<uint8_t> body;
    if (res.codec != Codec::None) {
        if (res.codec != Codec::Deflate) {
            res.error = std::string("replay uses codec '") + CodecName(res.codec) +
                        "' which this build cannot decode";
            return res;
        }
        uint64_t rawLen = 0;
        uint32_t compLen = 0;
        if (!GetU64(buf, p, rawLen) || !GetU32(buf, p, compLen) ||
            p + compLen > buf.size()) {
            res.error = "packed replay is truncated in its compressed body";
            return res;
        }
        if (!InflateAll(buf.data() + p, compLen, static_cast<size_t>(rawLen),
                        body, res.error))
            return res;
        buf.swap(body);
        p = 0;
    }

    uint32_t hlen = 0;
    if (!GetU32(buf, p, hlen) || p + hlen > buf.size()) {
        res.error = "replay header truncated";
        return res;
    }
    const std::string hjson(reinterpret_cast<const char*>(buf.data() + p), hlen);
    p += hlen;
    if (!DecodeHeaderJson(hjson, res.header, res.error)) return res;

    // Block stream. Any short/garbled block at this point is the E1 case: a
    // recorder that died mid-write. Everything read so far is a valid prefix of
    // a real game, so it is returned — flagged, never discarded. An UNKNOWN
    // marker is the other thing entirely: framing is intact but this build does
    // not know how long the block is, so it cannot find the next one. That is a
    // named hard error (the seam the header promises new sections attach to),
    // not a truncation.
    bool sawTrailer = false;
    while (p < buf.size()) {
        const uint8_t marker = buf[p];
        if (marker == kTrailerMarker) {
            size_t tp = p + 1;
            int32_t endFrame = 0;
            uint64_t count = 0, hashes = 0, ckpts = 0;
            if (GetI32(buf, tp, endFrame) && GetU64(buf, tp, count) &&
                GetU64(buf, tp, hashes) && GetU64(buf, tp, ckpts)) {
                res.trailer.endFrame        = endFrame;
                res.trailer.recordCount     = count;
                res.trailer.hashPointCount  = hashes;
                res.trailer.checkpointCount = ckpts;
                sawTrailer = true;
                p = tp;
            } else {
                res.truncated = true;
            }
            break;
        }
        if (marker == kRecordMarker) {
            Record r;
            if (!DecodeRecord(buf, p, r)) { res.truncated = true; break; }
            res.records.push_back(std::move(r));
            continue;
        }
        if (marker == kHashMarker) {
            size_t hp = p + 1;
            HashPoint pt;
            if (!GetI32(buf, hp, pt.frame) || !GetU64(buf, hp, pt.hash)) {
                res.truncated = true;
                break;
            }
            res.hashTrack.push_back(pt);
            p = hp;
            continue;
        }
        if (marker == kCheckpointMarker || marker == kStartCkptMarker) {
            size_t cp = p + 1;
            int32_t frame = 0;
            uint32_t len = 0;
            if (marker == kCheckpointMarker && !GetI32(buf, cp, frame)) {
                res.truncated = true;
                break;
            }
            if (!GetU32(buf, cp, len) || cp + len > buf.size()) {
                res.truncated = true;
                break;
            }
            std::vector<uint8_t> blob(buf.begin() + static_cast<long>(cp),
                                      buf.begin() + static_cast<long>(cp + len));
            if (marker == kStartCkptMarker)
                res.startCheckpoint = std::move(blob);
            else
                res.checkpoints.push_back({frame, std::move(blob)});
            p = cp + len;
            continue;
        }
        if (marker == kOutcomeMarker) {
            size_t op = p + 1;
            Outcome o;
            uint32_t len = 0;
            if (!GetI32(buf, op, o.frame) || !GetU32(buf, op, len) ||
                op + len > buf.size()) {
                res.truncated = true;
                break;
            }
            o.declared = true;
            o.winningAllyTeams.assign(buf.begin() + static_cast<long>(op),
                                      buf.begin() + static_cast<long>(op + len));
            res.outcome = std::move(o);
            p = op + len;
            continue;
        }

        char hex[8];
        std::snprintf(hex, sizeof(hex), "0x%02X", marker);
        res.error = std::string("unknown replay block marker ") + hex +
                    " at offset " + std::to_string(p) +
                    " — this file carries a section this build does not know";
        return res;
    }

    // Frame order is the contract the verifier's binary search assumes; the
    // recorder emits them in order, but a merged/repacked file need not.
    std::sort(res.hashTrack.begin(), res.hashTrack.end(),
              [](const HashPoint& a, const HashPoint& b) { return a.frame < b.frame; });
    std::sort(res.checkpoints.begin(), res.checkpoints.end(),
              [](const Checkpoint& a, const Checkpoint& b) { return a.frame < b.frame; });

    if (!sawTrailer) res.truncated = true;
    res.ok = true;
    return res;
}

// ────────────────────────── Listing (task 4c) ──────────────────────────
namespace {

/// Sequential reader over either the file itself (codec None) or an inflated
/// body held in memory. The point of the abstraction is that the *walk* below
/// is written once: it is the same block framing either way, and the only
/// difference is whether skipping a payload is an fseek or a pointer bump.
class BlockSource {
public:
    explicit BlockSource(std::FILE* f) : fp(f) {}
    explicit BlockSource(std::vector<uint8_t>&& m) : mem(std::move(m)) {}

    bool Read(void* dst, size_t n) {
        if (fp != nullptr) return std::fread(dst, 1, n, fp) == n;
        if (pos + n > mem.size()) return false;
        std::memcpy(dst, mem.data() + pos, n);
        pos += n;
        return true;
    }
    /// Skip forward without materialising the bytes. Seeking past EOF is legal
    /// on a FILE* and only shows up as a short read on the next block, which is
    /// exactly the truncation outcome we want — but a payload length read out
    /// of a garbled block can be enormous, so the bound is checked here rather
    /// than trusted.
    bool Skip(uint64_t n) {
        if (fp != nullptr) {
            const long here = std::ftell(fp);
            if (here < 0) return false;
            if (static_cast<uint64_t>(here) + n > size) return false;
            return std::fseek(fp, static_cast<long>(n), SEEK_CUR) == 0;
        }
        if (pos + n > mem.size()) return false;
        pos += static_cast<size_t>(n);
        return true;
    }
    void SetSize(uint64_t s) { size = s; }

private:
    std::FILE* fp = nullptr;
    std::vector<uint8_t> mem;
    size_t pos = 0;
    uint64_t size = 0;
};

bool ReadU8(BlockSource& s, uint8_t& v)  { return s.Read(&v, 1); }
bool ReadU32(BlockSource& s, uint32_t& v) {
    uint8_t b[4];
    if (!s.Read(b, 4)) return false;
    v = static_cast<uint32_t>(b[0]) | (static_cast<uint32_t>(b[1]) << 8) |
        (static_cast<uint32_t>(b[2]) << 16) | (static_cast<uint32_t>(b[3]) << 24);
    return true;
}
bool ReadI32(BlockSource& s, int32_t& v) {
    uint32_t u = 0;
    if (!ReadU32(s, u)) return false;
    v = static_cast<int32_t>(u);
    return true;
}
bool ReadU64(BlockSource& s, uint64_t& v) {
    uint8_t b[8];
    if (!s.Read(b, 8)) return false;
    v = 0;
    for (int i = 7; i >= 0; --i) v = (v << 8) | b[i];
    return true;
}

}  // namespace

Summary LoadSummary(const std::string& path) {
    Summary sum;
    sum.path = path;

    std::FILE* fp = std::fopen(path.c_str(), "rb");
    if (fp == nullptr) {
        sum.error = "cannot open replay file: " + path;
        return sum;
    }
    std::fseek(fp, 0, SEEK_END);
    const long fileLen = std::ftell(fp);
    std::fseek(fp, 0, SEEK_SET);
    sum.fileBytes = fileLen > 0 ? static_cast<uint64_t>(fileLen) : 0;

    char magic[sizeof(kMagic)];
    uint8_t vlo = 0, vhi = 0, codecByte = 0;
    if (std::fread(magic, 1, sizeof(magic), fp) != sizeof(magic) ||
        std::memcmp(magic, kMagic, sizeof(kMagic)) != 0) {
        std::fclose(fp);
        sum.error = "not a replay file (bad magic): " + path;
        return sum;
    }
    if (std::fread(&vlo, 1, 1, fp) != 1 || std::fread(&vhi, 1, 1, fp) != 1 ||
        std::fread(&codecByte, 1, 1, fp) != 1) {
        std::fclose(fp);
        sum.error = "replay header truncated (no version/codec)";
        return sum;
    }
    const uint16_t version = static_cast<uint16_t>(vlo | (vhi << 8));
    if (version != kFormatVersion) {
        std::fclose(fp);
        sum.error = "replay format version " + std::to_string(version) +
                    " != supported " + std::to_string(kFormatVersion);
        return sum;
    }
    sum.codec = static_cast<Codec>(codecByte);

    // A packed body has to come in whole — the header sits inside the
    // compressed stream so that one codec byte makes the file self-describing
    // (see the header's note). The saving over Load() is still the one that
    // matters: the records are walked, not decoded into Record objects.
    std::unique_ptr<BlockSource> src;
    if (sum.codec == Codec::None) {
        src = std::make_unique<BlockSource>(fp);
        src->SetSize(sum.fileBytes);
    } else if (sum.codec == Codec::Deflate) {
        uint64_t rawLen = 0;
        uint32_t compLen = 0;
        uint8_t lenBuf[12];
        if (std::fread(lenBuf, 1, sizeof(lenBuf), fp) != sizeof(lenBuf)) {
            std::fclose(fp);
            sum.error = "packed replay is truncated in its compressed body";
            return sum;
        }
        for (int i = 7; i >= 0; --i) rawLen = (rawLen << 8) | lenBuf[i];
        compLen = static_cast<uint32_t>(lenBuf[8]) |
                  (static_cast<uint32_t>(lenBuf[9]) << 8) |
                  (static_cast<uint32_t>(lenBuf[10]) << 16) |
                  (static_cast<uint32_t>(lenBuf[11]) << 24);
        std::vector<uint8_t> comp(compLen);
        if (compLen > 0 && std::fread(comp.data(), 1, compLen, fp) != compLen) {
            std::fclose(fp);
            sum.error = "packed replay is truncated in its compressed body";
            return sum;
        }
        std::vector<uint8_t> body;
        if (!InflateAll(comp.data(), comp.size(), static_cast<size_t>(rawLen),
                        body, sum.error)) {
            std::fclose(fp);
            return sum;
        }
        std::fclose(fp);
        fp = nullptr;
        src = std::make_unique<BlockSource>(std::move(body));
        src->SetSize(rawLen);
    } else {
        std::fclose(fp);
        sum.error = std::string("replay uses codec '") + CodecName(sum.codec) +
                    "' which this build cannot decode";
        return sum;
    }

    struct Closer {
        std::FILE* f;
        ~Closer() { if (f != nullptr) std::fclose(f); }
    } closer{fp};

    uint32_t hlen = 0;
    if (!ReadU32(*src, hlen)) {
        sum.error = "replay header truncated";
        return sum;
    }
    std::string hjson(hlen, '\0');
    if (hlen > 0 && !src->Read(hjson.data(), hlen)) {
        sum.error = "replay header truncated";
        return sum;
    }
    if (!DecodeHeaderJson(hjson, sum.header, sum.error)) return sum;

    // Block walk. Every branch either consumes a fixed-width prefix and skips a
    // declared payload, or gives up and calls the file truncated — the same E1
    // reading Load() gives, reached without allocating a byte of payload.
    bool sawTrailer = false;
    for (;;) {
        uint8_t marker = 0;
        if (!ReadU8(*src, marker)) break;  // clean EOF or a torn block

        if (marker == kRecordMarker) {
            uint8_t fixed[27];  // seq(8) frame(4) phase kind subKind playerId(4) clientId(4) len(4)
            if (!src->Read(fixed, sizeof(fixed))) { sum.truncated = true; break; }
            int32_t frame = static_cast<int32_t>(
                static_cast<uint32_t>(fixed[8]) |
                (static_cast<uint32_t>(fixed[9]) << 8) |
                (static_cast<uint32_t>(fixed[10]) << 16) |
                (static_cast<uint32_t>(fixed[11]) << 24));
            const uint32_t len = static_cast<uint32_t>(fixed[23]) |
                                 (static_cast<uint32_t>(fixed[24]) << 8) |
                                 (static_cast<uint32_t>(fixed[25]) << 16) |
                                 (static_cast<uint32_t>(fixed[26]) << 24);
            if (!src->Skip(len)) { sum.truncated = true; break; }
            ++sum.recordCount;
            if (frame > sum.lastRecordFrame) sum.lastRecordFrame = frame;
            continue;
        }
        if (marker == kHashMarker) {
            if (!src->Skip(12)) { sum.truncated = true; break; }
            ++sum.hashPointCount;
            continue;
        }
        if (marker == kCheckpointMarker || marker == kStartCkptMarker) {
            int32_t frame = 0;
            uint32_t len = 0;
            if (marker == kCheckpointMarker && !ReadI32(*src, frame)) {
                sum.truncated = true;
                break;
            }
            if (!ReadU32(*src, len) || !src->Skip(len)) {
                sum.truncated = true;
                break;
            }
            if (marker == kCheckpointMarker) ++sum.checkpointCount;
            continue;
        }
        if (marker == kOutcomeMarker) {
            Outcome o;
            uint32_t len = 0;
            if (!ReadI32(*src, o.frame) || !ReadU32(*src, len)) {
                sum.truncated = true;
                break;
            }
            o.winningAllyTeams.resize(len);
            if (len > 0 && !src->Read(o.winningAllyTeams.data(), len)) {
                sum.truncated = true;
                break;
            }
            o.declared = true;
            sum.outcome = std::move(o);
            continue;
        }
        if (marker == kTrailerMarker) {
            Trailer t;
            if (!ReadI32(*src, t.endFrame) || !ReadU64(*src, t.recordCount) ||
                !ReadU64(*src, t.hashPointCount) ||
                !ReadU64(*src, t.checkpointCount)) {
                sum.truncated = true;
                break;
            }
            sum.trailer = t;
            sawTrailer = true;
            break;
        }

        char hex[8];
        std::snprintf(hex, sizeof(hex), "0x%02X", marker);
        sum.error = std::string("unknown replay block marker ") + hex +
                    " — this file carries a section this build does not know";
        return sum;
    }

    if (!sawTrailer) sum.truncated = true;
    sum.ok = true;
    return sum;
}

std::vector<Summary> ListDirectory(const std::string& dir) {
    std::vector<Summary> out;
    std::error_code ec;
    if (dir.empty() || !std::filesystem::is_directory(dir, ec)) return out;

    std::vector<std::pair<std::filesystem::file_time_type, std::string>> files;
    for (const auto& entry : std::filesystem::directory_iterator(dir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec)) continue;
        if (entry.path().extension() != ".msr") continue;
        std::error_code tec;
        files.emplace_back(entry.last_write_time(tec), entry.path().string());
    }
    // Newest first: a replay browser's default question is "what did I just
    // play", not "what is the oldest thing on disk".
    std::sort(files.begin(), files.end(),
              [](const auto& a, const auto& b) { return a.first > b.first; });

    out.reserve(files.size());
    for (const auto& [mtime, p] : files) {
        Summary s = LoadSummary(p);
        s.path = p;
        // Unix seconds via stat() rather than the file_time_type we sorted on:
        // `file_clock`'s epoch is unspecified and this libc++ has no
        // `clock_cast`, so converting it portably is more machinery than
        // asking the OS the question directly.
        struct stat st{};
        if (::stat(p.c_str(), &st) == 0)
            s.modifiedAtUnix = static_cast<int64_t>(st.st_mtime);
        out.push_back(std::move(s));
    }
    return out;
}

// ─────────────────────── Export / import (the packer) ──────────────────
bool WriteFile(const std::string& path, const LoadResult& content, Codec codec,
               std::string& err) {
    if (codec != Codec::None && codec != Codec::Deflate) {
        err = std::string("codec '") + CodecName(codec) + "' is not implemented";
        return false;
    }

    std::vector<uint8_t> out;
    out.insert(out.end(), kMagic, kMagic + sizeof(kMagic));
    PutU8(out, static_cast<uint8_t>(kFormatVersion & 0xFF));
    PutU8(out, static_cast<uint8_t>((kFormatVersion >> 8) & 0xFF));
    PutU8(out, static_cast<uint8_t>(codec));

    const std::vector<uint8_t> body = BuildBody(content);
    if (codec == Codec::None) {
        out.insert(out.end(), body.begin(), body.end());
    } else {
        std::vector<uint8_t> comp;
        if (!DeflateAll(body, comp, err)) return false;
        PutU64(out, static_cast<uint64_t>(body.size()));
        PutU32(out, static_cast<uint32_t>(comp.size()));
        out.insert(out.end(), comp.begin(), comp.end());
    }

    std::FILE* fp = std::fopen(path.c_str(), "wb");
    if (fp == nullptr) {
        err = "cannot open replay file for writing: " + path;
        return false;
    }
    const bool wrote = std::fwrite(out.data(), 1, out.size(), fp) == out.size();
    std::fclose(fp);
    if (!wrote) {
        err = "short write on replay export: " + path;
        return false;
    }
    return true;
}

bool Pack(const std::string& in, const std::string& out, Codec codec,
          std::string& err) {
    const LoadResult src = Load(in);
    if (!src.ok) {
        err = src.error;
        return false;
    }
    return WriteFile(out, src, codec, err);
}

}  // namespace replay
