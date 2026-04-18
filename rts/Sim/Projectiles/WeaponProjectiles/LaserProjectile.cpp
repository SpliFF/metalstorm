/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */


#include "LaserProjectile.h"
#include "Map/Ground.h"
#include "Sim/Misc/GlobalConstants.h"
#include "Sim/Projectiles/ExplosionGenerator.h"
#include "Sim/Projectiles/ProjectileHandler.h"
#include "Sim/Weapons/WeaponDef.h"

CR_BIND_DERIVED(CLaserProjectile, CWeaponProjectile, )

CR_REG_METADATA(CLaserProjectile,(
	CR_SETFLAG(CF_Synced),
	CR_MEMBER(intensity),
	CR_MEMBER(color),
	CR_MEMBER(color2),
	CR_MEMBER(speedf),
	CR_MEMBER(maxLength),
	CR_MEMBER(curLength),
	CR_MEMBER(stayTime),
	CR_MEMBER(intensityFalloff),
	CR_MEMBER(midtexx)
))


CLaserProjectile::CLaserProjectile(const ProjectileParams& params): CWeaponProjectile(params)
	// NB: constant, assumes |speed=dir*projectileSpeed| never changes after creation
	, speedf(speed.w)
	, maxLength(0.0f)
	, curLength(0.0f)
	, intensity(0.0f)
	, intensityFalloff(0.0f)
	, midtexx(0.0f)

	, stayTime(0)
{
	projectileType = WEAPON_LASER_PROJECTILE;

	if (weaponDef != nullptr) {
		SetRadiusAndHeight(weaponDef->collisionSize, 0.0f);

		maxLength = weaponDef->duration * (speedf * GAME_SPEED);
		intensity = weaponDef->intensity;
		intensityFalloff = intensity * weaponDef->falloffRate;

		midtexx =
			(weaponDef->visuals.texture2->xstart +
			(weaponDef->visuals.texture2->xend - weaponDef->visuals.texture2->xstart) * 0.5f);

		color = weaponDef->visuals.color;
		color2 = weaponDef->visuals.color2;
	}

	drawRadius = maxLength;
}

void CLaserProjectile::Update()
{
	const float4 oldSpeed = speed;

	UpdateIntensity();
	UpdateLength();
	UpdateInterception();
	UpdatePos(oldSpeed);

	// pre-decrement ttl: if projectile has to live for N frames
	// we want to check for collisions only N (not N + 1) times!
	checkCol &= ((ttl -= 1) >= 0);
	deleteMe |= ((curLength <= 0.01f) * ( weaponDef->laserHardStop));
	deleteMe |= ((intensity <= 0.01f) * (!weaponDef->laserHardStop));
}

void CLaserProjectile::UpdateIntensity() {
	if (ttl > 0) {
		explGenHandler.GenExplosion(cegID, pos, speed, ttl, intensity, 0.0f, NULL, NULL);
		return;
	}

	if (weaponDef->laserHardStop) {
		// bolt reached its max-range but wasn't fully extended yet
		if (curLength < maxLength && speed != ZeroVector)
			stayTime = 1 + int((maxLength - curLength) / speedf);

		SetVelocityAndSpeed(ZeroVector);
	} else {
		// fade out over the next 5 frames at most
		intensity -= std::max(intensityFalloff * 0.2f, 0.2f);
		intensity = std::max(intensity, 0.0f);
	}
}

void CLaserProjectile::UpdateLength() {
	if (speed != ZeroVector) {
		// expand bolt to maximum length if not
		// stopped / collided OR after hardstop
		curLength = std::min(curLength + speedf, maxLength);
	} else {
		// contract bolt to zero length after stayTime
		// expires (can be immediately if not hardstop)
		curLength = std::max(curLength - speedf * (stayTime == 0), 0.0f);
	}

	stayTime = std::max(stayTime - 1, 0);
}

void CLaserProjectile::UpdatePos(const float4& oldSpeed) {
	if (luaMoveCtrl)
		return;

	SetPosition(pos + speed);
	// note: this can change pos *and* speed
	UpdateGroundBounce();

	if (oldSpeed != speed) {
		SetVelocityAndSpeed(speed);
	}
}



void CLaserProjectile::CollisionCommon(const float3& oldPos) {
	// we will fade out over some time
	deleteMe = false;

	if (weaponDef->noExplode)
		return;

	checkCol = false;

	SetPosition(oldPos);
	SetVelocityAndSpeed(ZeroVector);

	if (curLength < maxLength) {
		stayTime = 1 + int((maxLength - curLength) / speedf);
	}
}

void CLaserProjectile::Collision(CUnit* unit)
{
	const float3 oldPos = pos;

	CWeaponProjectile::Collision(unit);
	CollisionCommon(oldPos);
}

void CLaserProjectile::Collision(CFeature* feature)
{
	const float3 oldPos = pos;

	CWeaponProjectile::Collision(feature);
	CollisionCommon(oldPos);
}

void CLaserProjectile::Collision()
{
	const float3 oldPos = pos;

	CWeaponProjectile::Collision();
	CollisionCommon(oldPos);
}



int CLaserProjectile::ShieldRepulse(const float3& shieldPos, float shieldForce, float shieldMaxSpeed)
{
	if (luaMoveCtrl)
		return 0;

	const float3 rdir = (pos - shieldPos).Normalize();

	if (rdir.dot(speed) < 0.0f) {
		SetVelocityAndSpeed(speed - (rdir * rdir.dot(speed) * 2.0f));
		return 1;
	}

	return 0;
}

