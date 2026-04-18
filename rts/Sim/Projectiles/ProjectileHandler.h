/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef PROJECTILE_HANDLER_H
#define PROJECTILE_HANDLER_H

#include <array>
#include <vector>

#include "Sim/Projectiles/ProjectileFunctors.h"
#include "System/float3.h"

// bypass id and event handling for unsynced projectiles (faster)
#define PH_UNSYNCED_PROJECTILE_EVENTS 0

class CProjectile;
class CUnit;
class CFeature;
class CPlasmaRepulser;


typedef std::vector<CProjectile*> ProjectileContainer; // <unsorted>


class CProjectileHandler
{
	CR_DECLARE_STRUCT(CProjectileHandler)

public:
	void Init();
	void Kill();

	/// @see ConfigHandler::ConfigNotifyCallback
	void ConfigNotify(const std::string& key, const std::string& value);

	CProjectile* GetProjectileBySyncedID(int id);
	CProjectile* GetProjectileByUnsyncedID(int id);

	void CheckUnitCollisions(CProjectile*, std::vector<CUnit*>&, const float3, const float3);
	void CheckFeatureCollisions(CProjectile*, std::vector<CFeature*>&, const float3, const float3);
	void CheckShieldCollisions(CProjectile*, std::vector<CPlasmaRepulser*>&, const float3, const float3);
	void CheckUnitFeatureCollisions(ProjectileContainer&);
	void CheckGroundCollisions(ProjectileContainer&);
	void CheckCollisions();

	void SetMaxParticles(int value) { maxParticles = std::max(0, value); }
	void SetMaxNanoParticles(int value) { maxNanoParticles = std::max(0, value); }

	void Update();

	float GetParticleSaturation(bool randomized = true) const;
	float GetNanoParticleSaturation(float priority) const {
		const float total = std::max(1.0f, maxNanoParticles * priority);
		const float fract = std::max(int(currentNanoParticles >= maxNanoParticles), currentNanoParticles) / total;

		return std::min(1.0f, fract);
	}

	int GetCurrentParticles() const;

	void AddProjectile(CProjectile* p);

public:
	int maxParticles = 0;
	int maxNanoParticles = 0;
	int currentNanoParticles = 0;

	// these vars are used to precache parts of GetCurrentParticles() calculations
	int lastCurrentParticles = 0;
	int lastProjectileCounts[2] = {0, 0};

	// [0] contains only projectiles that can not change simulation state
	// [1] contains only projectiles that can     change simulation state
	ProjectileContainer projectileContainers[2];

private:
	// event-notifiers
	void CreateProjectile(CProjectile*);
	void DestroyProjectile(CProjectile*);

	void UpdateProjectiles(bool);
	void UpdateProjectiles() {
		UpdateProjectiles( true);
		UpdateProjectiles(false);
	}

private:
	// [0] := available unsynced projectile ID's
	// [1] := available synced (weapon, piece) projectile ID's
	std::vector<int> freeProjectileIDs[2];

	// [0] := ID ==> projectile* map for living unsynced projectiles
	// [1] := ID ==> projectile* map for living   synced projectiles
	std::vector<CProjectile*> projectileMaps[2];
};


extern CProjectileHandler projectileHandler;

#endif /* PROJECTILE_HANDLER_H */
