/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef WEAPONPROJECTILE_FACTORY_H
#define WEAPONPROJECTILE_FACTORY_H

struct ProjectileParams;

class WeaponProjectileFactory {
public:
	/// Unconditionally construct the projectile. This is the raw entry point
	/// and stays raw: Spring.SpawnProjectile calls it and expects an id back,
	/// so it must never be substituted away.
	static unsigned int LoadProjectile(const ProjectileParams& params);

	/// The weapon-fire entry point (PLAN-latency L2.1). Gives the Tier-C
	/// resolver first refusal — if the shot is resolved cosmetically no
	/// projectile is constructed and -1u comes back. Every CWeapon::FireImpl
	/// goes through here; nothing else should.
	static unsigned int FireWeaponProjectile(const ProjectileParams& params);
};

#endif

