/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef STATISTICAL_COMBAT_H
#define STATISTICAL_COMBAT_H

#include <string>
#include <vector>
#include <cstdint>

#include "System/UnorderedMap.hpp"
#include "System/creg/creg_cond.h"
#include "System/float3.h"

class CWeapon;
struct SWeaponTarget;

// ---------------------------------------------------------------------------
// Metalstorm statistical combat (Model 1 — per-volley resolution).
//
// PLAN-metalstorm-combat-resolution.md §2. Opt-in per weapon def via the
// `resolution` customParam (legacy alias `combat_model`). A `statistical`
// weapon spawns NO projectile: the volley is rolled at fire time with the
// synced RNG, damage is scheduled for fire+flightTime, and applied through the
// normal CUnit::DoDamage path at the resolve frame (the "foreknown outcome"
// pattern, PLAN-latency-projectiles.md Tier C).
//
// The faithful-Recoil path (sim projectiles) is untouched — this only runs for
// defs that explicitly opt in. See CLAUDE.md "Faithful Recoil Reproduction":
// this is a called-out, opt-in divergence, never a silent substitution.
// ---------------------------------------------------------------------------

// One weapon-def field reconciling ARCHITECTURE.md's `strategy` and the old
// `combat_model` (PLAN §1). Absent field => Sim (ported games never notice).
enum WeaponResolution : uint8_t {
	WEAPON_RESOLUTION_SIM         = 0, // server projectile entity (today's path)
	WEAPON_RESOLUTION_MIXED       = 1, // server projectile, client-invented visuals
	WEAPON_RESOLUTION_STATISTICAL = 2, // Model 1 per-volley roll — no projectile
	WEAPON_RESOLUTION_FIELD       = 3, // Model 3 damage field (phase 2)
};

namespace StatCombat {
	// Statistical tuning, parsed once from a weapon def's customParams. These
	// are distinct from Spring's `accuracy` (a cone-spread value with different
	// semantics) — they live in customParams so they never collide with the
	// faithful weapon-def fields. Defaults chosen so an opted-in weapon with no
	// tuning still behaves sanely.
	struct Tuning {
		float baseAccuracy     = 0.85f; // p(hit) at point-blank, no penalties
		float accuracyFalloff  = 1.0f;  // exponent on the (1 - dist/range) term
		float movePenalty      = 0.5f;  // p multiplier while the attacker is moving
		float heightBonus      = 0.15f; // added to p per full unit of height advantage (normalised)
		float minVolleyDamage  = 0.0f;  // floor for aggregate volley damage (E6)
		float skipFireStrength = 0.0f;  // skip-fire below this strengthFraction (E6); 0 = never skip
		int   targetingCadence = 0;     // frames a squad must hold a target between switches (0 = one reload)
	};

	// Parse the reconciled resolution enum. Accepts both the new `resolution`
	// key and the legacy `combat_model` alias; maps the legacy `ballistic`
	// value onto Sim (a real trajectory). Unknown/absent => Sim.
	WeaponResolution ParseResolution(const spring::unordered_map<std::string, std::string>& customParams);

	// Parse the statistical tuning knobs (all optional, all fall back to Tuning
	// defaults). Values are read as floats/ints from customParams strings.
	Tuning ParseTuning(const spring::unordered_map<std::string, std::string>& customParams);

	// Pure accuracy model (PLAN §2.2). p = base * falloff(dist/range)^k *
	// movePenalty(moving) + heightBonus*heightDelta, clamped to [0,1].
	// `heightDelta` is (attackerY - targetY) normalised by a reference span, so
	// firing downhill (>0) helps and uphill (<0) hurts. Deterministic and
	// side-effect free so it is directly unit-testable.
	float HitProbability(const Tuning& t, float dist, float range, bool attackerMoving, float heightDelta);

	// Aggregate volley damage: def damage scaled by the firing squad's strength
	// fraction, floored at minVolleyDamage on a hit (E6). A miss deals 0.
	float VolleyDamage(float defDamage, float strengthFraction, bool hit, float minVolleyDamage);
}

// A rolled-but-not-yet-applied volley outcome. Rolled at fire time, applied at
// resolveFrame. Stores the attacker/target ids + spawn generations so a
// destroyed-and-reused id does not receive misattributed damage (§2.1 / E2).
struct PendingVolley {
	CR_DECLARE_STRUCT(PendingVolley)

	int      resolveFrame = 0;   // sim frame at which damage lands + event emits
	int      attackerId   = -1;  // firing unit id (FX attribution only)
	uint16_t attackerGen  = 0;   // attacker spawn generation at fire time
	int      targetId     = -1;  // victim unit id (-1 => position-only volley)
	uint16_t targetGen    = 0;   // target spawn generation at fire time
	int      weaponDefId  = 0;
	int      team         = 0;   // attacker team (for FX/visibility)
	float3   targetPos;          // fire-time target position (FX + squad impact hint)
	float    damage       = 0.0f;// aggregate damage to apply (0 on a miss)
	uint8_t  rounds       = 1;   // cosmetic shot count for client tracer fan-out
	bool     hit          = false;
};

// Owns the frame-indexed pending-outcome ring; drained once per sim frame
// (Simulation.cpp SimFrame, right after unitHandler.Update()). creg-registered
// so in-flight volleys survive save/load (E4).
class StatisticalCombatManager {
	CR_DECLARE_STRUCT(StatisticalCombatManager)

public:
	void Init() { pending.clear(); }
	void Kill() { pending.clear(); }

	// Roll and schedule a volley for `weapon` against its current target.
	// Range/LOS are assumed already checked by the aim/UpdateFire path (no
	// double work, PLAN §2.1 step 1-2). Does the accuracy roll, computes the
	// resolve frame from flight time, and pushes a PendingVolley. `rounds` is
	// the cosmetic shot count (salvoSize * projectilesPerShot).
	void EnqueueVolley(const CWeapon* weapon, const SWeaponTarget& target,
	                   const float3& targetPos, int rounds);

	// Per-frame drain: apply damage for every entry due at <= frame, emit its
	// (future) VolleyOutcome event, and remove it.
	void Update(int frame);

	// Pure scheduling half of Update(), exposed for tests. Moves every entry
	// due at <= frame into `out` (removing it from the ring); leaves the rest.
	void CollectDue(int frame, std::vector<PendingVolley>& out);

	void Schedule(const PendingVolley& v) { pending.push_back(v); }

	size_t PendingCount() const { return pending.size(); }

private:
	std::vector<PendingVolley> pending;
};

extern StatisticalCombatManager statisticalCombatManager;

#endif // STATISTICAL_COMBAT_H
