/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "DamageField.h"

#include <algorithm>
#include <cmath>

#include "Sim/Misc/DamageArray.h"
#include "Sim/Misc/GlobalConstants.h"   // GAME_SPEED
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Misc/QuadField.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "System/creg/creg_cond.h"

DamageFieldManager damageFieldManager;

CR_BIND(DamageField, )
CR_REG_METADATA(DamageField, (
	CR_MEMBER(id),
	CR_MEMBER(shape),
	CR_MEMBER(center),
	CR_MEMBER(radius),
	CR_MEMBER(halfZ),
	CR_MEMBER(weaponDefId),
	CR_MEMBER(intensity),
	CR_MEMBER(cadence),
	CR_MEMBER(nextTickFrame),
	CR_MEMBER(expireFrame),
	CR_MEMBER(ownerUnitId),
	CR_MEMBER(ownerGen),
	CR_MEMBER(ownerTeam),
	CR_MEMBER(friendlyFire)
))

CR_BIND(DamageFieldManager, )
CR_REG_METADATA(DamageFieldManager, (
	CR_MEMBER(fields),
	CR_MEMBER(nextId)
))

// ---------------------------------------------------------------------------
// DamageField geometry (pure)
// ---------------------------------------------------------------------------

float DamageField::PerTickDamage() const
{
	// intensity is damage/second; one tick covers `cadence` frames of sim time.
	const float dt = static_cast<float>(std::max(cadence, 1)) / static_cast<float>(GAME_SPEED);
	return intensity * dt;
}

bool DamageField::Contains(const float3& p) const
{
	const float dx = p.x - center.x;
	const float dz = p.z - center.z;
	if (shape == DAMAGE_FIELD_RECT)
		return std::fabs(dx) <= radius && std::fabs(dz) <= halfZ;
	// circle
	return (dx * dx + dz * dz) <= (radius * radius);
}

float DamageField::QueryRadius() const
{
	if (shape == DAMAGE_FIELD_RECT)
		return std::sqrt(radius * radius + halfZ * halfZ);
	return radius;
}

// ---------------------------------------------------------------------------
// DamageFieldManager
// ---------------------------------------------------------------------------

void DamageFieldManager::Init()
{
	fields.clear();
	pendingEvents.clear();
	nextId = 1;
}

void DamageFieldManager::Kill()
{
	fields.clear();
	pendingEvents.clear();
}

DamageFieldEventData DamageFieldManager::MakeEvent(
	const DamageField& f, uint8_t kind, int currentFrame) const
{
	DamageFieldEventData ev;
	ev.fieldId     = f.id;
	ev.kind        = kind;
	ev.shape       = f.shape;
	ev.center      = f.center;
	ev.radius      = f.radius;
	ev.halfZ       = f.halfZ;
	ev.weaponDefId = (f.weaponDefId >= 0) ? static_cast<uint16_t>(f.weaponDefId) : 0u;
	ev.intensity   = f.intensity;
	ev.cadence     = static_cast<uint16_t>(std::max(f.cadence, 1));
	// Remaining frames (0 for Removed — the field is gone).
	ev.duration    = (kind == 0 && f.expireFrame > currentFrame)
		? static_cast<uint32_t>(f.expireFrame - currentFrame) : 0u;
	ev.team        = static_cast<uint8_t>(f.ownerTeam);
	return ev;
}

uint32_t DamageFieldManager::Create(
	uint8_t shape, const float3& center, float radius, float halfZ,
	int weaponDefId, float intensity, int cadence, int durationFrames,
	int ownerUnitId, int ownerTeam, bool friendlyFire, int currentFrame)
{
	// Fields must be bounded (E-none: an infinite barrage would never expire
	// and would leak forever). Reject non-positive duration / radius.
	if (durationFrames <= 0 || radius <= 0.0f || intensity <= 0.0f)
		return 0;

	DamageField f;
	f.id           = nextId++;
	f.shape        = (shape == DAMAGE_FIELD_RECT) ? DAMAGE_FIELD_RECT : DAMAGE_FIELD_CIRCLE;
	f.center       = center;
	f.radius       = radius;
	f.halfZ        = (f.shape == DAMAGE_FIELD_RECT) ? std::max(halfZ, 0.0f) : 0.0f;
	f.weaponDefId  = weaponDefId;
	f.intensity    = intensity;
	f.cadence      = std::max(cadence, 1);
	f.nextTickFrame = currentFrame + f.cadence; // first tick one cadence out
	f.expireFrame  = currentFrame + durationFrames;
	f.ownerUnitId  = ownerUnitId;
	f.ownerGen     = (ownerUnitId >= 0) ? unitHandler.GetUnitSpawnGen(ownerUnitId) : 0u;
	f.ownerTeam    = ownerTeam;
	f.friendlyFire = friendlyFire;

	pendingEvents.push_back(MakeEvent(f, /*Created*/ 0, currentFrame));
	fields.push_back(f);
	return f.id;
}

bool DamageFieldManager::Remove(uint32_t fieldId, int team)
{
	for (size_t i = 0; i < fields.size(); ++i) {
		if (fields[i].id != fieldId)
			continue;
		// Owner check: team == -1 bypasses (engine-initiated removal).
		if (team >= 0 && fields[i].ownerTeam != 255 && fields[i].ownerTeam != team)
			return false;
		pendingEvents.push_back(MakeEvent(fields[i], /*Removed*/ 1, gs != nullptr ? gs->frameNum : 0));
		fields.erase(fields.begin() + i);
		return true;
	}
	return false;
}

std::vector<DamageField> DamageFieldManager::CollectDamageTicks(
	int frame, std::vector<uint32_t>& expiredOut)
{
	std::vector<DamageField> ticking;
	if (fields.empty())
		return ticking;

	// Expire finished fields first (Removed events), compacting in place.
	for (size_t i = 0; i < fields.size();) {
		if (frame >= fields[i].expireFrame) {
			expiredOut.push_back(fields[i].id);
			pendingEvents.push_back(MakeEvent(fields[i], /*Removed*/ 1, frame));
			fields.erase(fields.begin() + i);
		} else {
			++i;
		}
	}

	// Then collect (and advance) every survivor reaching a cadence tick. A
	// field may have missed several ticks (save/load, long pause) — advance
	// past all of them but only apply damage once, matching the "one tick of
	// warm-up is invisible" tolerance (E4). Cap the catch-up at the expire
	// frame so an expired-this-frame field doesn't over-tick.
	for (DamageField& f : fields) {
		if (frame < f.nextTickFrame)
			continue;
		ticking.push_back(f); // snapshot for damage application by the caller
		// Advance nextTickFrame to the first future tick.
		const int step = std::max(f.cadence, 1);
		do {
			f.nextTickFrame += step;
		} while (f.nextTickFrame <= frame);
	}
	return ticking;
}

void DamageFieldManager::Update(int frame)
{
	if (fields.empty())
		return;

	std::vector<uint32_t> expired;
	std::vector<DamageField> ticking = CollectDamageTicks(frame, expired);

	for (const DamageField& f : ticking) {
		const float dmg = f.PerTickDamage();
		if (dmg <= 0.0f)
			continue;

		// Attacker = the field's owner unit while it lives (id-reuse guarded),
		// else nullptr (team-attributed damage — DoDamage handles a null
		// attacker fine). PLAN §4.
		CUnit* attacker = nullptr;
		if (f.ownerUnitId >= 0 &&
		    unitHandler.GetUnitSpawnGen(f.ownerUnitId) == f.ownerGen) {
			attacker = unitHandler.GetUnit(f.ownerUnitId);
		}

		const int ownerAlly = (f.ownerTeam != 255 && teamHandler.IsValidTeam(f.ownerTeam))
			? teamHandler.AllyTeam(f.ownerTeam) : -1;

		QuadFieldQuery qfq;
		quadField.GetUnitsExact(qfq, f.center, f.QueryRadius(), /*spherical=*/false);
		if (qfq.units == nullptr)
			continue;

		for (CUnit* u : *qfq.units) {
			if (u == nullptr)
				continue;
			// Exact shape test (the quadfield query is a coarse bound).
			if (!f.Contains(u->pos))
				continue;
			// Friendly-fire filter (called-out gameplay choice, see header):
			// skip units allied to the owner unless friendlyFire is set. A
			// neutral-owner field (ownerAlly < 0) hits everyone.
			if (!f.friendlyFire && ownerAlly >= 0 &&
			    teamHandler.AllyTeam(u->allyteam) == ownerAlly)
				continue;

			DamageArray da(dmg);
			u->DoDamage(da, float3(0.0f, 0.0f, 0.0f), attacker, f.weaponDefId, -1);
		}
	}
}

std::vector<DamageFieldEventData> DamageFieldManager::DrainEvents()
{
	std::vector<DamageFieldEventData> out;
	out.swap(pendingEvents);
	return out;
}
