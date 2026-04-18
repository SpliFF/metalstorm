/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */


#include "LargeBeamLaserProjectile.h"
#include "Game/GlobalUnsynced.h"
#include "Sim/Projectiles/ExplosionGenerator.h"
#include "Sim/Projectiles/ProjectileHandler.h"
#include "Sim/Weapons/WeaponDef.h"
#include "System/SpringMath.h"
#include <cstring> //memset

CR_BIND_DERIVED(CLargeBeamLaserProjectile, CWeaponProjectile, )

CR_REG_METADATA(CLargeBeamLaserProjectile,(
	CR_SETFLAG(CF_Synced),
	CR_MEMBER(coreColStart),
	CR_MEMBER(edgeColStart),
	CR_MEMBER(thickness),
	CR_MEMBER(corethickness),
	CR_MEMBER(flaresize),
	CR_MEMBER(tilelength),
	CR_MEMBER(scrollspeed),
	CR_MEMBER(pulseSpeed),
	CR_MEMBER(decay),
))


CLargeBeamLaserProjectile::CLargeBeamLaserProjectile(const ProjectileParams& params): CWeaponProjectile(params)
	, thickness(0.0f)
	, corethickness(0.0f)
	, flaresize(0.0f)
	, tilelength(0.0f)
	, scrollspeed(0.0f)
	, pulseSpeed(0.0f)
	, decay(1.0f)
{
	projectileType = WEAPON_LARGEBEAMLASER_PROJECTILE;

	if (weaponDef != NULL) {
		assert(weaponDef->IsHitScanWeapon());

		thickness     = weaponDef->visuals.thickness;
		corethickness = weaponDef->visuals.corethickness;
		flaresize     = weaponDef->visuals.laserflaresize;
		tilelength    = weaponDef->visuals.tilelength;
		scrollspeed   = weaponDef->visuals.scrollspeed;
		pulseSpeed    = weaponDef->visuals.pulseSpeed;
		decay         = weaponDef->visuals.beamdecay;


		coreColStart[0] = (weaponDef->visuals.color2.x * 255);
		coreColStart[1] = (weaponDef->visuals.color2.y * 255);
		coreColStart[2] = (weaponDef->visuals.color2.z * 255);
		coreColStart[3] = 1;
		edgeColStart[0] = (weaponDef->visuals.color.x * 255);
		edgeColStart[1] = (weaponDef->visuals.color.y * 255);
		edgeColStart[2] = (weaponDef->visuals.color.z * 255);
		edgeColStart[3] = 1;
	} else {
		memset(&coreColStart[0], 0, sizeof(coreColStart));
		memset(&edgeColStart[0], 0, sizeof(edgeColStart));
	}
}



void CLargeBeamLaserProjectile::Update()
{
	if ((--ttl) <= 0) {
		deleteMe = true;
	} else {
		for (int i = 0; i < 3; i++) {
			coreColStart[i] = (unsigned char) (coreColStart[i] * decay);
			edgeColStart[i] = (unsigned char) (edgeColStart[i] * decay);
		}

		explGenHandler.GenExplosion(cegID, startPos + ((targetPos - startPos) / ttl), (targetPos - startPos), 0.0f, flaresize, 0.0f, NULL, NULL);
	}

	UpdateInterception();
}


