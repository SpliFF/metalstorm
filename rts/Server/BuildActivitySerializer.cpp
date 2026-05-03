/**
 * BuildActivitySerializer — see header for wire format.
 */

#include "BuildActivitySerializer.h"

#include "Sim/Features/Feature.h"
#include "Sim/Misc/NanoPieceCache.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Objects/SolidObject.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitTypes/Builder.h"

#include <algorithm>
#include <cstring>

namespace BuildActivity {

namespace {

template<typename T>
void Write(std::vector<uint8_t>& buf, T value) {
    const size_t off = buf.size();
    buf.resize(off + sizeof(T));
    std::memcpy(&buf[off], &value, sizeof(T));
}

bool IsUnitVisibleTo(const CUnit* u, int viewerAllyTeam) {
    if (viewerAllyTeam < 0) return true;
    const int unitAllyTeam = teamHandler.AllyTeam(u->team);
    if (unitAllyTeam == viewerAllyTeam) return true;
    constexpr uint8_t VISIBLE_MASK = LOS_INLOS | LOS_INRADAR | LOS_PREVLOS | LOS_CONTRADAR;
    return (u->losStatus[viewerAllyTeam] & VISIBLE_MASK) != 0;
}

struct BuildAction {
    uint32_t builderId;
    uint32_t targetId;
    float targetX, targetY, targetZ;
    float targetRadius;
    uint8_t kind;
    float strength;
    const std::vector<int>* pieces;  // borrowed from NanoPieceCache
};

/// Inspect a builder's `cur*` task pointers and fill in a BuildAction.
/// Returns false when the builder is idle (no nano spray to draw).
bool DescribeBuilderTask(const CBuilder* b, BuildAction& out) {
    out.targetX = out.targetY = out.targetZ = 0.0f;
    out.targetRadius = b->buildDistance > 0.0f ? b->buildDistance * 0.5f : 24.0f;
    out.targetId = 0;

    if (b->curBuild != nullptr) {
        out.kind = KIND_BUILD;
        // Repair vs build: buildProgress == 1 means the unit is finished
        // and the builder is healing it instead of constructing it.
        if (b->curBuild->buildProgress >= 1.0f) out.kind = KIND_REPAIR;
        out.targetId = static_cast<uint32_t>(b->curBuild->id);
        out.targetX = b->curBuild->midPos.x;
        out.targetY = b->curBuild->midPos.y;
        out.targetZ = b->curBuild->midPos.z;
        out.targetRadius = b->curBuild->radius * 0.5f;
        return true;
    }
    if (b->curReclaim != nullptr) {
        out.kind = KIND_RECLAIM;
        // Differentiate unit-reclaim (id) from feature-reclaim (sentinel).
        const CSolidObject* obj = b->curReclaim;
        if (b->reclaimingUnit) {
            out.targetId = static_cast<uint32_t>(obj->id);
        } else {
            out.targetId = TARGET_FEATURE;
        }
        out.targetX = obj->pos.x;
        out.targetY = obj->pos.y;
        out.targetZ = obj->pos.z;
        out.targetRadius = obj->radius * 0.5f;
        return true;
    }
    if (b->curResurrect != nullptr) {
        out.kind = KIND_RESURRECT;
        out.targetId = TARGET_FEATURE;
        out.targetX = b->curResurrect->pos.x;
        out.targetY = b->curResurrect->pos.y;
        out.targetZ = b->curResurrect->pos.z;
        out.targetRadius = b->curResurrect->radius * 0.5f;
        return true;
    }
    if (b->curCapture != nullptr) {
        out.kind = KIND_CAPTURE;
        out.targetId = static_cast<uint32_t>(b->curCapture->id);
        out.targetX = b->curCapture->midPos.x;
        out.targetY = b->curCapture->midPos.y;
        out.targetZ = b->curCapture->midPos.z;
        out.targetRadius = b->curCapture->radius * 0.5f;
        return true;
    }
    if (b->terraforming || b->helpTerraform != nullptr) {
        out.kind = KIND_TERRAFORM;
        out.targetId = 0;
        out.targetX = b->terraformCenter.x;
        out.targetY = b->terraformCenter.y;
        out.targetZ = b->terraformCenter.z;
        out.targetRadius = b->terraformRadius > 0.0f
            ? b->terraformRadius : out.targetRadius;
        return true;
    }
    return false;
}

} // namespace

std::vector<uint8_t> SerializeAll(uint32_t frame, int viewerAllyTeam) {
    std::vector<uint8_t> buf;
    buf.resize(6); // header patched at the end

    uint16_t count = 0;

    const auto& activeUnits = unitHandler.GetActiveUnits();
    for (CUnit* u : activeUnits) {
        if (u == nullptr || u->isDead) continue;
        if (u->unitDef == nullptr || !u->unitDef->IsBuilderUnit()) continue;
        if (!IsUnitVisibleTo(u, viewerAllyTeam)) continue;

        CBuilder* b = static_cast<CBuilder*>(u);

        // `inBuildStance` is the engine's live "I'm currently emitting
        // nano spray" flag — flipped on by the builder's script when
        // the build animation reaches the spraying frame, and flipped
        // off the moment construction completes (or the builder
        // changes target). Without this gate we keep emitting beam
        // entries while `curBuild` lingers for one extra tick after
        // completion and during the StopBuild cleanup; visually that
        // shows as a beam that hangs in the air after the structure
        // has finished. Spectator-style "no allyteam" sessions still
        // see beams on enemy builders because IsUnitVisibleTo gates
        // the visibility separately.
        if (!b->inBuildStance) continue;

        BuildAction a{};
        a.builderId = static_cast<uint32_t>(b->id);
        a.pieces = &b->GetNanoPieceCache().GetNanoPieces();
        // GetBuildPower() returns 0..1 over the recent half-second
        // window; idle builders read 0. Combined with the inBuildStance
        // check above this stays a useful "is the spray strong right
        // now" signal but no longer doubles as the on/off gate.
        a.strength = b->GetNanoPieceCache().GetBuildPower();

        if (!DescribeBuilderTask(b, a)) continue;

        const uint8_t pieceCount = a.pieces == nullptr ? 0
            : static_cast<uint8_t>(std::min<size_t>(a.pieces->size(), 255));

        Write<uint32_t>(buf, a.builderId);
        Write<uint32_t>(buf, a.targetId);
        Write<float>(buf, a.targetX);
        Write<float>(buf, a.targetY);
        Write<float>(buf, a.targetZ);
        Write<float>(buf, a.targetRadius);
        Write<uint8_t>(buf, a.kind);
        Write<uint8_t>(buf, pieceCount);
        for (uint8_t i = 0; i < pieceCount; ++i) {
            // model-piece indices clamp to u8; commander-class units
            // sit well under that limit.
            const int idx = (*a.pieces)[i];
            Write<uint8_t>(buf, static_cast<uint8_t>(std::min(idx, 255)));
        }
        Write<float>(buf, a.strength);

        ++count;
    }

    if (count == 0) return {};

    std::memcpy(&buf[0], &frame, sizeof(uint32_t));
    std::memcpy(&buf[4], &count, sizeof(uint16_t));
    return buf;
}

} // namespace BuildActivity
