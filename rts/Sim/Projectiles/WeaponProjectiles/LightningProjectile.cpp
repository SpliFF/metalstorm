/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */


#include "LightningProjectile.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Projectiles/ExplosionGenerator.h"
#include "Sim/Weapons/WeaponDef.h"
#include "System/SpringMath.h"

CR_BIND_DERIVED(CLightningProjectile, CWeaponProjectile, )

CR_REG_METADATA(CLightningProjectile,(
	CR_SETFLAG(CF_Synced),
	CR_MEMBER(color),
	CR_MEMBER(displacements),
	CR_MEMBER(displacements2)
))


CLightningProjectile::CLightningProjectile(const ProjectileParams& params): CWeaponProjectile(params)
{
	projectileType = WEAPON_LIGHTNING_PROJECTILE;
	useAirLos = false;

	if (weaponDef != nullptr) {
		assert(weaponDef->IsHitScanWeapon());
		color = weaponDef->visuals.color;
	}

	displacements[0] = 0.0f;
	displacements2[0] = 0.0f;

	for (int d = 1; d < NUM_DISPLACEMENTS; ++d) {
		displacements [d] = (gsRNG.NextFloat() - 0.5f) * drawRadius * 0.05f;
		displacements2[d] = (gsRNG.NextFloat() - 0.5f) * drawRadius * 0.05f;
	}
}

void CLightningProjectile::Update()
{
	if (--ttl <= 0) {
		deleteMe = true;
	} else {
		explGenHandler.GenExplosion(cegID, startPos + ((targetPos - startPos) / ttl), (targetPos - startPos), 0.0f, displacements[0], 0.0f, NULL, NULL);
	}

	for (int d = 1; d < NUM_DISPLACEMENTS; ++d) {
		displacements [d] += (gsRNG.NextFloat() - 0.5f) * 0.3f;
		displacements2[d] += (gsRNG.NextFloat() - 0.5f) * 0.3f;
	}

	UpdateInterception();
}


