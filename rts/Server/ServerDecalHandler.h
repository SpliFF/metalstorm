// ServerDecalHandler — server-side ground-scar emitter.
//
// Mirrors Recoil's CGroundDecalHandler::ExplosionOccurred: registers as an
// IExplosionListener and, for every sim explosion whose WeaponDef authorises
// a scar, derives the scar geometry/lifetime/tint and pushes a ScarEventData
// into the global scarEvents collector. The sim loop drains and broadcasts
// these each tick (envelope 0x08).
#pragma once

#include "Sim/Projectiles/ExplosionListener.h"

struct CExplosionParams;

class ServerDecalHandler : public IExplosionListener {
public:
    void Register();
    void Unregister();
    void ExplosionOccurred(const CExplosionParams& event) override;
};

extern ServerDecalHandler serverDecalHandler;
