// ServerDecalHandler — see header.
#include "ServerDecalHandler.h"

#include "DecalEventCollector.h"
#include "Game/GameHelper.h"        // CExplosionParams
#include "Sim/Misc/DamageArray.h"
#include "Sim/Misc/GlobalConstants.h"  // GAME_SPEED
#include "Sim/Weapons/WeaponDef.h"
#include "System/float3.h"
#include "System/float4.h"

#include <algorithm>
#include <cmath>

ServerDecalHandler serverDecalHandler;

void ServerDecalHandler::Register() {
    CExplosionCreator::AddExplosionListener(this);
}

void ServerDecalHandler::Unregister() {
    CExplosionCreator::RemoveExplosionListener(this);
}

// Faithful port of Recoil's CGroundDecalHandler::AddExplosion scar path
// (rts/Rendering/Env/Decals/GroundDecalHandler.cpp). Only the rendering tail
// (atlas quad, glow colormap) is replaced by a ScarEventData pushed onto the
// wire — the geometry/lifetime/alpha derivation matches 1:1.
void ServerDecalHandler::ExplosionOccurred(const CExplosionParams& event) {
    const WeaponDef* wd = event.weaponDef;
    if (wd != nullptr && !wd->visuals.explosionScar)
        return;

    float radius = event.craterAreaOfEffect;
    float damage = event.damages.GetDefault();

    const bool radiusOverride = (wd != nullptr && wd->visuals.scarDiameter >= 0.0f);
    if (radiusOverride)
        radius = 0.5f * wd->visuals.scarDiameter;

    // NOTE: ground-snap + altitude gating (Recoil scales radius/damage by the
    // burst's height above ground and rejects in-air bursts) is done on the
    // CLIENT, which holds the heightmap — consistent with keeping render-
    // derived data off the headless server. Here we run Recoil's altitude-0
    // math (the common ground-level-burst case); the client refines y + gating.
    if (radius <= 0.0f)
        return;

    damage = std::min(damage, radius * 30.0f);
    if (!radiusOverride)
        radius = std::min(radius, damage * 0.25f);
    if (radius < 5.0f)
        return;

    // Recoil compresses high damage before deriving alpha / glow / ttl.
    if (damage > 400.0f)
        damage = 400.0f + std::sqrt(damage - 400.0f);

    const float alpha = (wd != nullptr && wd->visuals.scarAlpha > 0.0f)
        ? wd->visuals.scarAlpha
        : std::clamp(2.0f * damage / 255.0f, 0.8f, 1.0f);

    // Recoil derives TTL in frames; the wire carries seconds.
    const float ttlSeconds = (wd != nullptr && wd->visuals.scarTtl > 0.0f)
        ? wd->visuals.scarTtl
        : std::clamp(3.0f * damage, 15.0f, 1800.0f) / GAME_SPEED;

    const float glow = (wd != nullptr && wd->visuals.scarGlow > 0.0f)
        ? wd->visuals.scarGlow
        : std::clamp(2.0f * damage / 255.0f, 0.0f, 1.0f);
    const float glowTtlSeconds = (wd != nullptr && wd->visuals.scarGlowTtl > 0.0f)
        ? wd->visuals.scarGlowTtl
        : 60.0f / GAME_SPEED; // Recoil default: 60 frames

    const float4 tint = (wd != nullptr)
        ? wd->visuals.scarColorTint
        : float4{0.5f, 0.5f, 0.5f, 0.5f};

    ScarEventData s;
    s.pos = event.pos; // client snaps y to the heightmap on receipt
    s.radius = radius;
    s.ttl = ttlSeconds;
    s.alpha = alpha;
    s.glow = glow;
    s.glowTtl = glowTtlSeconds;
    s.r = tint.x;
    s.g = tint.y;
    s.b = tint.z;
    s.a = tint.w;
    scarEvents.Push(s);
}
