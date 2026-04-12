/**
 * ProjectileStateSerializer — binary projectile state snapshots.
 */

#include "ProjectileStateSerializer.h"

#include "Sim/Projectiles/ProjectileHandler.h"
#include "Sim/Projectiles/Projectile.h"
#include "Sim/Projectiles/WeaponProjectiles/WeaponProjectile.h"
#include "Sim/Weapons/WeaponDef.h"
#include "System/float3.h"

#include <cstring>

namespace ProjectileState {

template<typename T>
static void Write(std::vector<uint8_t>& buf, size_t& offset, T value) {
    memcpy(&buf[offset], &value, sizeof(T));
    offset += sizeof(T);
}

std::vector<uint8_t> SerializeAllProjectiles(uint16_t fieldMask) {
    // Collect synced weapon projectiles only (container[1] = synced)
    const auto& syncedProjs = projectileHandler.projectileContainers[1];

    struct ProjData {
        uint32_t id;
        uint16_t weaponDefId;
        float px, py, pz;
        float dx, dy, dz;
        uint8_t team;
    };

    std::vector<ProjData> projs;
    projs.reserve(syncedProjs.size());

    for (const CProjectile* p : syncedProjs) {
        if (p == nullptr || p->deleteMe || !p->weapon)
            continue;

        const auto* wp = static_cast<const CWeaponProjectile*>(p);
        const WeaponDef* wd = wp->GetWeaponDef();

        ProjData d;
        d.id = static_cast<uint32_t>(p->id);
        d.weaponDefId = wd ? static_cast<uint16_t>(wd->id) : 0;
        d.px = p->pos.x;
        d.py = p->pos.y;
        d.pz = p->pos.z;
        d.dx = p->dir.x;
        d.dy = p->dir.y;
        d.dz = p->dir.z;
        d.team = static_cast<uint8_t>(p->GetTeamID());
        projs.push_back(d);
    }

    const uint16_t count = static_cast<uint16_t>(projs.size());

    // Calculate buffer size
    size_t size = 4; // header
    if (fieldMask & FIELD_PROJ_IDS)      size += count * sizeof(uint32_t);
    if (fieldMask & FIELD_WEAPON_DEF_ID) size += count * sizeof(uint16_t);
    if (fieldMask & FIELD_POSITION_X)    size += count * sizeof(float);
    if (fieldMask & FIELD_POSITION_Y)    size += count * sizeof(float);
    if (fieldMask & FIELD_POSITION_Z)    size += count * sizeof(float);
    if (fieldMask & FIELD_DIR_X)         size += count * sizeof(float);
    if (fieldMask & FIELD_DIR_Y)         size += count * sizeof(float);
    if (fieldMask & FIELD_DIR_Z)         size += count * sizeof(float);
    if (fieldMask & FIELD_TEAM)          size += count * sizeof(uint8_t);

    std::vector<uint8_t> buf(size);
    size_t offset = 0;

    // Header
    Write(buf, offset, count);
    Write(buf, offset, fieldMask);

    if (fieldMask & FIELD_PROJ_IDS) {
        for (const auto& d : projs) Write(buf, offset, d.id);
    }
    if (fieldMask & FIELD_WEAPON_DEF_ID) {
        for (const auto& d : projs) Write(buf, offset, d.weaponDefId);
    }
    if (fieldMask & FIELD_POSITION_X) {
        for (const auto& d : projs) Write(buf, offset, d.px);
    }
    if (fieldMask & FIELD_POSITION_Y) {
        for (const auto& d : projs) Write(buf, offset, d.py);
    }
    if (fieldMask & FIELD_POSITION_Z) {
        for (const auto& d : projs) Write(buf, offset, d.pz);
    }
    if (fieldMask & FIELD_DIR_X) {
        for (const auto& d : projs) Write(buf, offset, d.dx);
    }
    if (fieldMask & FIELD_DIR_Y) {
        for (const auto& d : projs) Write(buf, offset, d.dy);
    }
    if (fieldMask & FIELD_DIR_Z) {
        for (const auto& d : projs) Write(buf, offset, d.dz);
    }
    if (fieldMask & FIELD_TEAM) {
        for (const auto& d : projs) Write(buf, offset, d.team);
    }

    return buf;
}

} // namespace ProjectileState
