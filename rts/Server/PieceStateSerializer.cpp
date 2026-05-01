/**
 * PieceStateSerializer — see header for wire format.
 */

#include "PieceStateSerializer.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/Scripts/LocalModelPieceStub.h"

#include <cstring>
#include <cmath>

namespace PieceState {

namespace {

template<typename T>
void Write(std::vector<uint8_t>& buf, T value) {
    const size_t off = buf.size();
    buf.resize(off + sizeof(T));
    std::memcpy(&buf[off], &value, sizeof(T));
}

// Floats this close to the rest pose are treated as un-animated and
// skipped on the wire. Spring's float coordinates are in elmos
// (1 elmo ≈ 1/8 of a map square ≈ 7-ish cm in metric); a delta below
// 1e-3 is well below visible threshold.
constexpr float kPosEpsilon = 1e-3f;
constexpr float kRotEpsilon = 1e-4f;

bool IsAnimated(const LocalModelPiece& p) {
    if (p.original == nullptr) return false;
    const float3& rest = p.original->offset;
    const float3 pos = p.GetPosition();
    if (std::fabs(pos.x - rest.x) > kPosEpsilon) return true;
    if (std::fabs(pos.y - rest.y) > kPosEpsilon) return true;
    if (std::fabs(pos.z - rest.z) > kPosEpsilon) return true;
    const float3 rot = p.GetRotation();
    if (std::fabs(rot.x) > kRotEpsilon) return true;
    if (std::fabs(rot.y) > kRotEpsilon) return true;
    if (std::fabs(rot.z) > kRotEpsilon) return true;
    return false;
}

} // namespace

std::vector<uint8_t> SerializeUnits(
    const std::vector<CUnit*>& units,
    uint32_t frame)
{
    std::vector<uint8_t> buf;
    // Header is written last once we know the unit count; for now leave
    // a 6-byte gap at the start so the per-unit blocks can be appended
    // and we patch the count back in at the end.
    buf.resize(6);

    uint16_t unitCount = 0;

    // Per-piece scratch buffer to avoid repeated heap allocs.
    struct PieceEntry {
        uint8_t pieceIdx;
        float px, py, pz;
        float rx, ry, rz;
    };
    std::vector<PieceEntry> entries;

    for (const CUnit* u : units) {
        if (u == nullptr || u->isDead) continue;
        const auto& pieces = u->localModel.pieces;
        if (pieces.empty()) continue;

        entries.clear();
        // pieceIdx must fit in u8 — clamp at 255 pieces / unit. Spring
        // models don't approach this limit (typical commander has ~30).
        const size_t maxPieces = std::min<size_t>(pieces.size(), 255);
        for (size_t i = 0; i < maxPieces; ++i) {
            const LocalModelPiece& p = pieces[i];
            if (!IsAnimated(p)) continue;
            const float3 pos = p.GetPosition();
            const float3 rot = p.GetRotation();
            entries.push_back({static_cast<uint8_t>(i),
                pos.x, pos.y, pos.z, rot.x, rot.y, rot.z});
        }

        if (entries.empty()) continue;

        Write<uint32_t>(buf, static_cast<uint32_t>(u->id));
        Write<uint8_t>(buf, static_cast<uint8_t>(entries.size()));
        for (const auto& e : entries) {
            Write<uint8_t>(buf, e.pieceIdx);
            Write<float>(buf, e.px);
            Write<float>(buf, e.py);
            Write<float>(buf, e.pz);
            Write<float>(buf, e.rx);
            Write<float>(buf, e.ry);
            Write<float>(buf, e.rz);
        }
        ++unitCount;
    }

    if (unitCount == 0) return {};

    std::memcpy(&buf[0], &frame, sizeof(uint32_t));
    std::memcpy(&buf[4], &unitCount, sizeof(uint16_t));
    return buf;
}

} // namespace PieceState
