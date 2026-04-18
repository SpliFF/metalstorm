/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */


#include "ExplosiveProjectile.h"
#include "Map/Ground.h"
#include "Sim/Projectiles/ExplosionGenerator.h"
#include "Sim/Projectiles/ProjectileHandler.h"
#include "Sim/Weapons/WeaponDef.h"

CR_BIND_DERIVED(CExplosiveProjectile, CWeaponProjectile, )

CR_REG_METADATA(CExplosiveProjectile, (
	CR_SETFLAG(CF_Synced),
	CR_MEMBER(invttl),
	CR_MEMBER(curTime)
))


CExplosiveProjectile::CExplosiveProjectile(const ProjectileParams& params): CWeaponProjectile(params)
	, invttl(0.0f)
	, curTime(0.0f)
{
	projectileType = WEAPON_EXPLOSIVE_PROJECTILE;

	mygravity = params.gravity;
	useAirLos = true;

	if (weaponDef != nullptr) {
		SetRadiusAndHeight(weaponDef->collisionSize, 0.0f);
		drawRadius = weaponDef->size;
	}

	if (ttl <= 0) {
		invttl = 1.0f;
	} else {
		invttl = 1.0f / ttl;
	}
}

void CExplosiveProjectile::Update()
{
	CProjectile::Update();

	if (--ttl == 0) {
		Collision();
	} else {
		if (ttl > 0)
			explGenHandler.GenExplosion(cegID, pos, speed, ttl, damages->damageAreaOfEffect, 0.0f, nullptr, nullptr);
	}

	curTime += invttl;
	curTime = std::min(curTime, 1.0f);

	if (weaponDef->noExplode && TraveledRange()) {
		CProjectile::Collision();
		return;
	}

	UpdateGroundBounce();
	UpdateInterception();
}

int CExplosiveProjectile::ShieldRepulse(const float3& shieldPos, float shieldForce, float shieldMaxSpeed)
{
	if (luaMoveCtrl)
		return 0;

	const float3 rdir = (pos - shieldPos).Normalize();

	if (rdir.dot(speed) < shieldMaxSpeed) {
		SetVelocityAndSpeed(speed + (rdir * shieldForce));
		return 2;
	}

	return 0;
}

int CExplosiveProjectile::GetProjectilesCount() const
{
	return weaponDef->visuals.stages;
}
