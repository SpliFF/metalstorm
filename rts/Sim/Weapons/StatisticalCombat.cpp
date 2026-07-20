/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "StatisticalCombat.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>

#include "Sim/Weapons/Weapon.h"
#include "Sim/Weapons/WeaponDef.h"
#include "Sim/Weapons/WeaponTarget.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Misc/DamageArray.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Game/GameHelper.h"
#include "Map/Ground.h"
#include "Server/CombatEventCollector.h"
#include "System/creg/creg_cond.h"

StatisticalCombatManager statisticalCombatManager;

CR_BIND(PendingVolley, )
CR_REG_METADATA(PendingVolley, (
	CR_MEMBER(resolveFrame),
	CR_MEMBER(attackerId),
	CR_MEMBER(attackerGen),
	CR_MEMBER(targetId),
	CR_MEMBER(targetGen),
	CR_MEMBER(weaponDefId),
	CR_MEMBER(team),
	CR_MEMBER(targetTeam),
	CR_MEMBER(targetPos),
	CR_MEMBER(attackerPos),
	CR_MEMBER(damage),
	CR_MEMBER(rounds),
	CR_MEMBER(posture),
	CR_MEMBER(hit)
))

CR_BIND(StatisticalCombatManager, )
CR_REG_METADATA(StatisticalCombatManager, (
	CR_MEMBER(pending)
))

// Elmo span over which a full unit of `heightBonus` is granted. Firing this
// much higher than the target gives the whole bonus; equal-and-opposite uphill
// applies the same penalty. Cheap cover heuristic (PLAN §2.2) — richer cover
// comes from map metadata later.
static constexpr float HEIGHT_REF_SPAN = 200.0f;

// Statistical volleys never model >2s of flight (PLAN E3): clamp the scheduled
// travel time so a teleported/dead target still resolves promptly.
static constexpr int MAX_FLIGHT_FRAMES = 2 * GAME_SPEED;

// Morale retreat (Q-D-c). How far a retreating/panicking squad pulls back per
// re-issued move order, how often the order may re-issue (throttle), and how
// far to scan for the threat to flee away from.
static constexpr float RETREAT_DISTANCE     = 400.0f; // elmos pulled back per order
static constexpr int   RETREAT_REISSUE_FRAMES = GAME_SPEED; // >=1 order/sec/unit
static constexpr float RETREAT_SCAN_RADIUS  = 1200.0f; // elmos to look for the threat

namespace {
	float ReadFloat(const spring::unordered_map<std::string, std::string>& cp,
	                const char* key, float fallback) {
		const auto it = cp.find(key);
		if (it == cp.end() || it->second.empty())
			return fallback;
		return static_cast<float>(std::atof(it->second.c_str()));
	}
	int ReadInt(const spring::unordered_map<std::string, std::string>& cp,
	            const char* key, int fallback) {
		const auto it = cp.find(key);
		if (it == cp.end() || it->second.empty())
			return fallback;
		return std::atoi(it->second.c_str());
	}
}

WeaponResolution StatCombat::ParseResolution(
	const spring::unordered_map<std::string, std::string>& customParams)
{
	// New key wins; fall back to the legacy `combat_model` alias (PLAN §1).
	auto it = customParams.find("resolution");
	if (it == customParams.end())
		it = customParams.find("combat_model");
	if (it == customParams.end())
		return WEAPON_RESOLUTION_SIM;

	const std::string& v = it->second;
	if (v == "statistical") return WEAPON_RESOLUTION_STATISTICAL;
	if (v == "mixed")       return WEAPON_RESOLUTION_MIXED;
	if (v == "field")       return WEAPON_RESOLUTION_FIELD;
	// "sim" and the legacy "ballistic" both mean: a real server projectile.
	return WEAPON_RESOLUTION_SIM;
}

StatCombat::Tuning StatCombat::ParseTuning(
	const spring::unordered_map<std::string, std::string>& customParams)
{
	Tuning t; // defaults
	t.baseAccuracy     = ReadFloat(customParams, "stat_base_accuracy",   t.baseAccuracy);
	t.accuracyFalloff  = ReadFloat(customParams, "stat_accuracy_falloff", t.accuracyFalloff);
	t.movePenalty      = ReadFloat(customParams, "stat_move_penalty",     t.movePenalty);
	t.heightBonus      = ReadFloat(customParams, "stat_height_bonus",     t.heightBonus);
	t.minVolleyDamage  = ReadFloat(customParams, "min_volley_damage",     t.minVolleyDamage);
	t.skipFireStrength = ReadFloat(customParams, "skip_fire_strength",    t.skipFireStrength);
	t.targetingCadence = ReadInt  (customParams, "targeting_cadence",     t.targetingCadence);
	return t;
}

float StatCombat::HitProbability(const Tuning& t, float dist, float range,
                                 bool attackerMoving, float heightDelta)
{
	// falloff(dist/range): 1 at point-blank, 0 at max range, raised to the
	// configurable exponent (>1 = accuracy holds then drops sharply near max).
	const float safeRange = std::max(range, 1.0f);
	const float closeness  = std::clamp(1.0f - (dist / safeRange), 0.0f, 1.0f);
	const float falloff    = std::pow(closeness, std::max(t.accuracyFalloff, 0.0f));

	float p = t.baseAccuracy * falloff;
	if (attackerMoving)
		p *= t.movePenalty;

	// Height advantage: additive, scaled by normalised elevation delta.
	p += t.heightBonus * std::clamp(heightDelta, -1.0f, 1.0f);

	return std::clamp(p, 0.0f, 1.0f);
}

float StatCombat::VolleyDamage(float defDamage, float strengthFraction,
                               bool hit, float minVolleyDamage)
{
	if (!hit)
		return 0.0f;
	const float scaled = defDamage * std::clamp(strengthFraction, 0.0f, 1.0f);
	// E6: floor at minVolleyDamage so near-dead squads still land a real (if
	// small) hit rather than dealing an epsilon that stalls forever.
	return std::max(scaled, minVolleyDamage);
}

float StatCombat::DerivedMorale(float health, float maxHealth)
{
	// v0 derived proxy (Q-D-c): morale = clamp(hp% - 10, 0, 100). No stored
	// stat, no decay — a pure function of current health fraction.
	if (maxHealth <= 0.0f)
		return 100.0f;
	const float hpPct = 100.0f * std::clamp(health / maxHealth, 0.0f, 1.0f);
	return std::clamp(hpPct - 10.0f, 0.0f, 100.0f);
}

StatCombat::MoralePosture StatCombat::PostureFrom(float health, float maxHealth)
{
	const float m = DerivedMorale(health, maxHealth);
	if (m <= 0.0f)   return MORALE_PANIC;   // hp <= 10% — flee without fighting
	if (m <  10.0f)  return MORALE_RETREAT; // hp <  20% — retreat while firing
	return MORALE_NORMAL;
}

void StatisticalCombatManager::EnqueueVolley(const CWeapon* weapon,
	const SWeaponTarget& target, const float3& targetPos, int rounds)
{
	const CUnit* attacker = weapon->owner;
	const WeaponDef* wd = weapon->weaponDef;
	if (attacker == nullptr || wd == nullptr)
		return;

	const StatCombat::Tuning& tuning = wd->statTuning;

	// E6 skip-fire: a squad below the configured strength fraction holds fire
	// rather than trickling damage in a death spiral. 0 => never skip.
	const float strengthFraction = (attacker->maxHealth > 0.0f)
		? (attacker->health / attacker->maxHealth) : 1.0f;
	if (tuning.skipFireStrength > 0.0f && strengthFraction < tuning.skipFireStrength)
		return;

	const float3 firePos = weapon->GetAimFromPos(true);
	const float  dist    = firePos.distance(targetPos);

	// Height advantage from a ground sample at attacker vs target (PLAN §2.2).
	const float attackerGround = CGround::GetHeightReal(firePos.x, firePos.z);
	const float targetGround   = CGround::GetHeightReal(targetPos.x, targetPos.z);
	const float heightDelta     = (attackerGround - targetGround) / HEIGHT_REF_SPAN;

	const float p = StatCombat::HitProbability(tuning, dist, weapon->range,
	                                           attacker->IsMoving(), heightDelta);

	// Synced RNG — deterministic, replay/snapshot-exact (PLAN §2.2).
	const bool hit = (gsRNG.NextFloat() < p);

	const float damage = StatCombat::VolleyDamage(wd->damages.GetDefault(),
	                                              strengthFraction, hit,
	                                              tuning.minVolleyDamage);

	// resolve_frame = fire_frame + flight time (PLAN §2.1 step 5). Statistical
	// never means instant-hit. projectileSpeed is elmos/frame; 0 => treat as
	// effectively instant but still schedule at least the current frame.
	int flightFrames = 0;
	if (weapon->projectileSpeed > 0.0f)
		flightFrames = std::clamp(int(dist / weapon->projectileSpeed), 0, MAX_FLIGHT_FRAMES);

	PendingVolley v;
	v.resolveFrame = gs->frameNum + flightFrames;
	v.attackerId   = attacker->id;
	v.attackerGen  = unitHandler.GetUnitSpawnGen(attacker->id);
	v.weaponDefId  = wd->id;
	v.team         = attacker->team;
	v.targetPos    = targetPos;
	v.attackerPos  = firePos;
	v.damage       = damage;
	v.rounds       = static_cast<uint8_t>(std::clamp(rounds, 1, 255));
	// Attacker morale posture at fire time (foreknown-outcome: the whole volley
	// is decided now). Carried to the client so it can show a retreat/panic hint.
	v.posture      = static_cast<uint8_t>(
		StatCombat::PostureFrom(attacker->health, attacker->maxHealth));
	v.hit          = hit;

	if (target.type == Target_Unit && target.unit != nullptr) {
		v.targetId   = target.unit->id;
		v.targetGen  = unitHandler.GetUnitSpawnGen(target.unit->id);
		v.targetTeam = target.unit->team;
	} else {
		v.targetId   = -1;  // position-only volley (no unit to damage)
		v.targetTeam = 255; // no victim team
	}

	pending.push_back(v);
}

void StatisticalCombatManager::CollectDue(int frame, std::vector<PendingVolley>& out)
{
	// Partition: due entries (resolveFrame <= frame) move to `out`, the rest
	// stay. Order among survivors is irrelevant (frame-indexed, not FIFO).
	auto mid = std::partition(pending.begin(), pending.end(),
		[frame](const PendingVolley& v) { return v.resolveFrame > frame; });
	out.insert(out.end(), std::make_move_iterator(mid),
	           std::make_move_iterator(pending.end()));
	pending.erase(mid, pending.end());
}

void StatisticalCombatManager::Update(int frame)
{
	if (pending.empty())
		return;

	std::vector<PendingVolley> due;
	CollectDue(frame, due);

	for (const PendingVolley& v : due) {
		// Apply damage through the normal DoDamage path so every downstream
		// system (CombatEventCollector, UnitDamaged callin, objectives, squad
		// casualty derivation) works unchanged (PLAN §2.1).
		if (v.targetId >= 0 && v.damage > 0.0f) {
			CUnit* tgt = unitHandler.GetUnit(v.targetId);
			// id-reuse generation guard (E2/§2.1): a destroyed-and-reused slot
			// must not receive misattributed damage. Mismatch => drop damage,
			// FX still emit below at the stored target_pos.
			if (tgt != nullptr && unitHandler.GetUnitSpawnGen(v.targetId) == v.targetGen) {
				CUnit* atk = nullptr;
				if (v.attackerId >= 0 &&
				    unitHandler.GetUnitSpawnGen(v.attackerId) == v.attackerGen) {
					atk = unitHandler.GetUnit(v.attackerId);
				}
				DamageArray da(v.damage);
				// DoDamage no-ops on a dead target — the shots were in the air.
				tgt->DoDamage(da, float3(0.0f, 0.0f, 0.0f), atk, v.weaponDefId, -1);
			}
		}

		// Emit the VolleyOutcome regardless of hit/miss/dead-target (E2: the
		// shots were already in the air). Ground truth only — the per-session
		// visibility matrix (Hit/Miss vs Unknown, counterbattery reveal) is
		// applied later in StateStreamer::BroadcastCombatEvents. §2.3.
		VolleyOutcomeData ev{};
		ev.attackerId   = (v.attackerId >= 0) ? static_cast<uint32_t>(v.attackerId) : 0u;
		ev.attackerTeam = static_cast<uint8_t>(v.team);
		ev.weaponDefId  = static_cast<uint16_t>(v.weaponDefId);
		ev.targetId     = (v.targetId >= 0) ? static_cast<uint32_t>(v.targetId) : 0u;
		ev.targetTeam   = static_cast<uint8_t>(v.targetTeam);
		ev.targetPos    = v.targetPos;
		ev.attackerPos  = v.attackerPos;
		ev.resolveFrame = static_cast<uint32_t>(v.resolveFrame);
		ev.result       = v.hit ? 0 : 1; // 0=hit, 1=miss (pre-visibility)
		ev.damage       = v.damage;
		ev.rounds       = v.rounds;
		ev.posture      = v.posture;
		volleyOutcomes.Push(ev);
	}
}

void StatisticalCombatManager::RequestRetreat(CUnit* unit, int frame)
{
	if (unit == nullptr)
		return;

	// Per-unit throttle so a low-HP squad with several weapons (each calling
	// this every fire tick) issues at most one move order per second.
	int& last = retreatFrame[unit->id];
	if (last != 0 && (frame - last) < RETREAT_REISSUE_FRAMES)
		return;
	last = frame;

	// Flee away from the nearest enemy (LOS-tested). With no enemy in scan
	// range, back straight up along -front so a unit under artillery it can't
	// see still pulls back.
	const CUnit* enemy = CGameHelper::GetClosestEnemyUnit(
		unit, unit->pos, RETREAT_SCAN_RADIUS, unit->allyteam);

	float3 away = (enemy != nullptr) ? (unit->pos - enemy->pos)
	                                 : (float3(unit->frontdir) * -1.0f);
	away.y = 0.0f;
	if (away.SqLength() < 1.0f)
		away = float3(unit->frontdir) * -1.0f;
	away.SafeNormalize();

	float3 fleePos = unit->pos + away * RETREAT_DISTANCE;
	fleePos.ClampInBounds();

	// fromSynced move order — replaces the current command for the fleeing
	// squad (the CALLED-OUT divergence documented on the header declaration).
	Command c(CMD_MOVE, fleePos);
	unit->commandAI->GiveCommand(c);
}
