#include "ReplayFile.h"

#include <nlohmann/json.hpp>

#include <cstring>

using json = nlohmann::json;
using syncedinput::Record;

namespace replay {

namespace {

// Block markers. One byte in front of every block so a decoder that has lost
// framing stops at the first wrong byte instead of reading a length field out
// of a payload and allocating a gigabyte.
constexpr uint8_t kRecordMarker  = 0x52;  // 'R'
constexpr uint8_t kTrailerMarker = 0x54;  // 'T'

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

}  // namespace

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

void Writer::Append(Record&& r) {
    if (fp == nullptr) return;
    std::vector<uint8_t> buf;
    buf.reserve(32 + r.payload.size());
    EncodeRecord(r, buf);
    if (std::fwrite(buf.data(), 1, buf.size(), fp) != buf.size()) {
        // A failed write is loud once and then latched — the alternative is a
        // journal that quietly stops being complete, which is the exact
        // failure mode this whole subsystem exists to rule out.
        failed = true;
        return;
    }
    ++written;
}

void Writer::Flush() {
    if (fp != nullptr) std::fflush(fp);
}

void Writer::Close(const Trailer& t) {
    if (fp == nullptr) return;
    std::vector<uint8_t> buf;
    PutU8(buf, kTrailerMarker);
    PutI32(buf, t.endFrame);
    PutU64(buf, t.recordCount);
    if (std::fwrite(buf.data(), 1, buf.size(), fp) != buf.size()) failed = true;
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
    if (buf.size() < sizeof(kMagic) + 2 + 4 ||
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

    uint32_t hlen = 0;
    if (!GetU32(buf, p, hlen) || p + hlen > buf.size()) {
        res.error = "replay header truncated";
        return res;
    }
    const std::string hjson(reinterpret_cast<const char*>(buf.data() + p), hlen);
    p += hlen;
    if (!DecodeHeaderJson(hjson, res.header, res.error)) return res;

    // Record stream. Any short/garbled block at this point is the E1 case: a
    // recorder that died mid-write. Everything read so far is a valid prefix of
    // a real game, so it is returned — flagged, never discarded.
    bool sawTrailer = false;
    while (p < buf.size()) {
        if (buf[p] == kTrailerMarker) {
            size_t tp = p + 1;
            int32_t endFrame = 0;
            uint64_t count = 0;
            if (GetI32(buf, tp, endFrame) && GetU64(buf, tp, count)) {
                res.trailer.endFrame    = endFrame;
                res.trailer.recordCount = count;
                sawTrailer = true;
                p = tp;
            } else {
                res.truncated = true;
            }
            break;
        }
        Record r;
        if (!DecodeRecord(buf, p, r)) {
            res.truncated = true;
            break;
        }
        res.records.push_back(std::move(r));
    }

    if (!sawTrailer) res.truncated = true;
    res.ok = true;
    return res;
}

}  // namespace replay
