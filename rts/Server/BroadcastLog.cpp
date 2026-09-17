#include "BroadcastLog.h"

#include <cstring>

#include <sys/stat.h>

namespace broadcast {

namespace {

// One byte in front of every block so a decoder that has lost framing stops at
// the first wrong byte instead of reading a length out of a payload. Markers
// are deliberately the SAME letters `ReplayFile.cpp` uses for the same jobs —
// a reader of either format reads R as "record" and T as "trailer".
constexpr uint8_t kRecordMarker   = 0x52;  // 'R'
constexpr uint8_t kKeyframeMarker = 0x4B;  // 'K'
constexpr uint8_t kTrailerMarker  = 0x54;  // 'T'

// Fixed prefix widths, used by both the writer and the skip-scan.
constexpr size_t kRecordPrefix   = 8 + 4 + 1 + 1 + 1 + 4;  // wall frame cls lane bcast len
constexpr size_t kKeyframePrefix = 8 + 4;                  // wall frame
constexpr size_t kTrailerPrefix  = 4 + 8 + 8 + 8;          // endFrame endWall recs kfs

void PutU8(std::vector<uint8_t>& o, uint8_t v) { o.push_back(v); }
void PutU32(std::vector<uint8_t>& o, uint32_t v) {
    for (int i = 0; i < 4; ++i) o.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
void PutU64(std::vector<uint8_t>& o, uint64_t v) {
    for (int i = 0; i < 8; ++i) o.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
void PutI32(std::vector<uint8_t>& o, int32_t v) { PutU32(o, static_cast<uint32_t>(v)); }

uint32_t GetU32(const uint8_t* b) {
    uint32_t v = 0;
    for (int i = 0; i < 4; ++i) v |= static_cast<uint32_t>(b[i]) << (8 * i);
    return v;
}
uint64_t GetU64(const uint8_t* b) {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v |= static_cast<uint64_t>(b[i]) << (8 * i);
    return v;
}
int32_t GetI32(const uint8_t* b) { return static_cast<int32_t>(GetU32(b)); }

uint64_t FileSize(std::FILE* fp) {
    struct stat st{};
    if (fstat(fileno(fp), &st) != 0) return 0;
    return st.st_size > 0 ? static_cast<uint64_t>(st.st_size) : 0;
}

}  // namespace

// ─────────────────────────────── Writer ───────────────────────────────
Writer::~Writer() {
    // No trailer: a Writer destroyed without Close() is by definition an
    // abnormal end, and a reader must see the log as unterminated.
    if (fp != nullptr) { std::fclose(fp); fp = nullptr; }
}

bool Writer::Open(const std::string& p, const replay::Header& h, std::string& err) {
    path = p;
    fp = std::fopen(p.c_str(), "wb");
    if (fp == nullptr) {
        err = "cannot open broadcast log for writing: " + p;
        return false;
    }

    const std::string hjson = replay::EncodeHeaderJson(h);
    std::vector<uint8_t> pre;
    pre.insert(pre.end(), kMagic, kMagic + sizeof(kMagic));
    PutU8(pre, static_cast<uint8_t>(kFormatVersion & 0xFF));
    PutU8(pre, static_cast<uint8_t>((kFormatVersion >> 8) & 0xFF));
    PutU32(pre, static_cast<uint32_t>(hjson.size()));
    pre.insert(pre.end(), hjson.begin(), hjson.end());

    if (std::fwrite(pre.data(), 1, pre.size(), fp) != pre.size()) {
        err = "short write on broadcast log header: " + p;
        std::fclose(fp);
        fp = nullptr;
        return false;
    }
    std::fflush(fp);
    return true;
}

void Writer::WriteBlock(const std::vector<uint8_t>& buf) {
    // A failed write is latched — the alternative is a log that quietly stops
    // being complete while the server keeps reporting it as recording.
    if (std::fwrite(buf.data(), 1, buf.size(), fp) != buf.size()) failed = true;
}

void Writer::AppendRecord(uint64_t wallMs, int32_t frame, uint8_t cls, uint8_t lane,
                          bool broadcastFlag, const uint8_t* data, size_t len) {
    if (fp == nullptr) return;
    std::vector<uint8_t> buf;
    buf.reserve(1 + kRecordPrefix + len);
    PutU8(buf, kRecordMarker);
    PutU64(buf, wallMs);
    PutI32(buf, frame);
    PutU8(buf, cls);
    PutU8(buf, lane);
    PutU8(buf, broadcastFlag ? 1 : 0);
    PutU32(buf, static_cast<uint32_t>(len));
    if (len > 0) buf.insert(buf.end(), data, data + len);
    const bool wasFailed = failed;
    WriteBlock(buf);
    if (!failed && !wasFailed) { ++records; bytes += len; }
}

void Writer::AppendKeyframe(uint64_t wallMs, int32_t frame) {
    if (fp == nullptr) return;
    std::vector<uint8_t> buf;
    PutU8(buf, kKeyframeMarker);
    PutU64(buf, wallMs);
    PutI32(buf, frame);
    const bool wasFailed = failed;
    WriteBlock(buf);
    if (!failed && !wasFailed) ++keyframes;
}

void Writer::Flush() {
    if (fp != nullptr) std::fflush(fp);
}

void Writer::Close(Trailer t) {
    if (fp == nullptr) return;
    t.recordCount   = records;
    t.keyframeCount = keyframes;
    std::vector<uint8_t> buf;
    PutU8(buf, kTrailerMarker);
    PutI32(buf, t.endFrame);
    PutU64(buf, t.endWallMs);
    PutU64(buf, t.recordCount);
    PutU64(buf, t.keyframeCount);
    WriteBlock(buf);
    std::fflush(fp);
    std::fclose(fp);
    fp = nullptr;
}

// ─────────────────────────────── Reader ───────────────────────────────
Reader::~Reader() {
    if (fp != nullptr) { std::fclose(fp); fp = nullptr; }
}

bool Reader::ReadAt(uint64_t off, void* dst, size_t len) {
    if (off + len > knownSize) return false;
    if (std::fseek(fp, static_cast<long>(off), SEEK_SET) != 0) return false;
    return std::fread(dst, 1, len, fp) == len;
}

bool Reader::Open(const std::string& p, std::string& err) {
    path = p;
    fp = std::fopen(p.c_str(), "rb");
    if (fp == nullptr) {
        err = "cannot open broadcast log: " + p;
        return false;
    }
    knownSize = FileSize(fp);

    char magic[sizeof(kMagic)];
    if (!ReadAt(0, magic, sizeof(magic)) ||
        std::memcmp(magic, kMagic, sizeof(kMagic)) != 0) {
        err = "not a broadcast log (bad magic): " + p;
        std::fclose(fp); fp = nullptr;
        return false;
    }
    uint8_t v[2];
    if (!ReadAt(sizeof(kMagic), v, 2)) {
        err = "broadcast log header cut short (no version)";
        std::fclose(fp); fp = nullptr;
        return false;
    }
    const uint16_t version = static_cast<uint16_t>(v[0] | (v[1] << 8));
    if (version != kFormatVersion) {
        err = "broadcast log format version " + std::to_string(version) +
              " != supported " + std::to_string(kFormatVersion);
        std::fclose(fp); fp = nullptr;
        return false;
    }
    uint8_t lenBuf[4];
    if (!ReadAt(sizeof(kMagic) + 2, lenBuf, 4)) {
        err = "broadcast log header cut short (no header length)";
        std::fclose(fp); fp = nullptr;
        return false;
    }
    const uint32_t hlen = GetU32(lenBuf);
    std::string hjson(hlen, '\0');
    if (hlen > 0 && !ReadAt(sizeof(kMagic) + 6, hjson.data(), hlen)) {
        err = "broadcast log header cut short";
        std::fclose(fp); fp = nullptr;
        return false;
    }
    if (!replay::DecodeHeaderJson(hjson, header, err)) {
        std::fclose(fp); fp = nullptr;
        return false;
    }
    cursor = sizeof(kMagic) + 6 + hlen;
    return true;
}

bool Reader::Rescan() {
    if (fp == nullptr) return false;
    // A torn tail on a GROWING file is the recorder mid-write, so re-statting
    // clears the stop: the bytes that were missing may now be there.
    const uint64_t now = FileSize(fp);
    if (now <= knownSize) return false;
    knownSize = now;
    torn = false;
    return true;
}

bool Reader::SeekTo(uint64_t offset) {
    if (fp == nullptr || offset > knownSize) return false;
    cursor = offset;
    torn = false;
    return true;
}

bool Reader::Next(Record& out) {
    if (fp == nullptr || torn) return false;
    for (;;) {
        uint8_t marker = 0;
        if (!ReadAt(cursor, &marker, 1)) return false;  // end of the known bytes

        if (marker == kRecordMarker) {
            uint8_t fixed[kRecordPrefix];
            if (!ReadAt(cursor + 1, fixed, sizeof(fixed))) return false;  // mid-write
            const uint32_t len = GetU32(fixed + 15);
            out.payload.resize(len);
            if (len > 0 && !ReadAt(cursor + 1 + kRecordPrefix, out.payload.data(), len))
                return false;  // payload not written yet — do NOT advance
            out.wallMs    = GetU64(fixed);
            out.frame     = GetI32(fixed + 8);
            out.cls       = fixed[12];
            out.lane      = fixed[13];
            out.broadcast = fixed[14];
            cursor += 1 + kRecordPrefix + len;
            return true;
        }
        if (marker == kKeyframeMarker) {
            uint8_t fixed[kKeyframePrefix];
            if (!ReadAt(cursor + 1, fixed, sizeof(fixed))) return false;
            Keyframe kf;
            kf.wallMs = GetU64(fixed);
            kf.frame  = GetI32(fixed + 8);
            kf.offset = cursor;
            if (keyframeIndex.empty() || keyframeIndex.back().offset != kf.offset)
                keyframeIndex.push_back(kf);
            cursor += 1 + kKeyframePrefix;
            continue;
        }
        if (marker == kTrailerMarker) {
            uint8_t fixed[kTrailerPrefix];
            if (!ReadAt(cursor + 1, fixed, sizeof(fixed))) return false;
            trailer.endFrame      = GetI32(fixed);
            trailer.endWallMs     = GetU64(fixed + 4);
            trailer.recordCount   = GetU64(fixed + 12);
            trailer.keyframeCount = GetU64(fixed + 20);
            sawTrailer = true;
            cursor += 1 + kTrailerPrefix;
            return false;  // a clean end of stream
        }
        // An unknown marker means framing is lost: block lengths live inside
        // the block, so there is no next marker to find. Stop, loudly.
        torn = true;
        return false;
    }
}

void Reader::ScanIndex() {
    if (fp == nullptr) return;
    const uint64_t save = cursor;
    const bool saveTorn = torn;
    keyframeIndex.clear();
    cursor = sizeof(kMagic) + 6;
    // Re-read the header length rather than remembering it: ScanIndex is
    // allowed to run on a reader whose cursor has been moved anywhere.
    uint8_t lenBuf[4];
    if (ReadAt(sizeof(kMagic) + 2, lenBuf, 4)) cursor += GetU32(lenBuf);
    torn = false;
    for (;;) {
        uint8_t marker = 0;
        if (!ReadAt(cursor, &marker, 1)) break;
        if (marker == kRecordMarker) {
            uint8_t fixed[kRecordPrefix];
            if (!ReadAt(cursor + 1, fixed, sizeof(fixed))) break;
            const uint32_t len = GetU32(fixed + 15);
            if (cursor + 1 + kRecordPrefix + len > knownSize) break;
            cursor += 1 + kRecordPrefix + len;   // payload SKIPPED, never copied
            continue;
        }
        if (marker == kKeyframeMarker) {
            uint8_t fixed[kKeyframePrefix];
            if (!ReadAt(cursor + 1, fixed, sizeof(fixed))) break;
            keyframeIndex.push_back({GetU64(fixed), GetI32(fixed + 8), cursor});
            cursor += 1 + kKeyframePrefix;
            continue;
        }
        break;  // trailer or an unknown marker: the index is complete either way
    }
    cursor = save;
    torn = saveTorn;
}

// ─────────────────────────── Listing / summary ─────────────────────────
Summary LoadSummary(const std::string& path) {
    Summary sum;
    sum.path = path;

    Reader r;
    if (!r.Open(path, sum.error)) return sum;
    sum.header = r.GetHeader();

    // One skip-scan over the framing. Counting from the blocks actually
    // present rather than reading the trailer's claim is the point: a live or
    // crashed log has no trailer at all, and those are precisely the ones a
    // catalogue most needs to describe.
    for (;;) {
        Record rec;
        if (!r.Next(rec)) break;
        ++sum.recordCount;
        sum.payloadBytes += rec.payload.size();
        if (sum.firstFrame < 0) { sum.firstFrame = rec.frame; sum.firstWallMs = rec.wallMs; }
        sum.lastFrame  = rec.frame;
        sum.lastWallMs = rec.wallMs;
    }
    sum.keyframes = r.Keyframes();
    sum.trailer   = r.GetTrailer();
    sum.truncated = !r.SawTrailer();

    struct stat st{};
    if (stat(path.c_str(), &st) == 0 && st.st_size > 0)
        sum.fileBytes = static_cast<uint64_t>(st.st_size);

    sum.ok = true;
    return sum;
}

}  // namespace broadcast
