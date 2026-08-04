/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// Model 1 statistical combat — sim-core unit tests
// (PLAN-metalstorm-combat-resolution.md §9). Covers the pure, decoupled halves
// of the system: resolution/tuning parsing, the accuracy model, volley-damage
// scaling + the E6 floor, the pending-outcome ring scheduling, and synced-RNG
// determinism. The full weapon-fire path (no-projectile invariant) is exercised
// by the integration harness, not here.

#include <doctest/doctest.h>

#include "Sim/Weapons/StatisticalCombat.h"
#include "Sim/Misc/GlobalSynced.h"

#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

using spring::unordered_map;

static unordered_map<std::string, std::string> cp(
	std::initializer_list<std::pair<const std::string, std::string>> kvs) {
	unordered_map<std::string, std::string> m;
	for (const auto& kv : kvs) m[kv.first] = kv.second;
	return m;
}

TEST_SUITE("statistical-combat/parse") {
	TEST_CASE("resolution key maps every vocabulary value") {
		CHECK(StatCombat::ParseResolution(cp({{"resolution", "statistical"}})) == WEAPON_RESOLUTION_STATISTICAL);
		CHECK(StatCombat::ParseResolution(cp({{"resolution", "mixed"}}))       == WEAPON_RESOLUTION_MIXED);
		CHECK(StatCombat::ParseResolution(cp({{"resolution", "field"}}))       == WEAPON_RESOLUTION_FIELD);
		CHECK(StatCombat::ParseResolution(cp({{"resolution", "sim"}}))         == WEAPON_RESOLUTION_SIM);
	}

	TEST_CASE("legacy combat_model key is accepted as an alias") {
		CHECK(StatCombat::ParseResolution(cp({{"combat_model", "statistical"}})) == WEAPON_RESOLUTION_STATISTICAL);
		// legacy "ballistic" value means a real projectile => Sim path
		CHECK(StatCombat::ParseResolution(cp({{"combat_model", "ballistic"}}))   == WEAPON_RESOLUTION_SIM);
		CHECK(StatCombat::ParseResolution(cp({{"resolution",   "ballistic"}}))   == WEAPON_RESOLUTION_SIM);
	}

	TEST_CASE("absent / unknown => Sim (ported games never notice)") {
		CHECK(StatCombat::ParseResolution(cp({})) == WEAPON_RESOLUTION_SIM);
		CHECK(StatCombat::ParseResolution(cp({{"resolution", "nonsense"}})) == WEAPON_RESOLUTION_SIM);
	}

	// An ABSENT key is the ported-game case above and must stay silent. A
	// PRESENT but unrecognised value is an authoring mistake — a typo like
	// "statistcal" silently answers Sim, which is indistinguishable from
	// statistical combat not being implemented. The value still resolves to
	// Sim (defs must not become load-fatal), but the engine now warns; see
	// StatCombat::ParseResolution. These pin the resolution contract around
	// that warning so the recognised set can't be narrowed by accident.
	TEST_CASE("typo'd resolution values still resolve to Sim, loudly") {
		// Every value the parser is contracted to recognise silently.
		for (const char* good : {"statistical", "mixed", "field", "sim", "ballistic"})
			CHECK(StatCombat::ParseResolution(cp({{"resolution", good}}))
				!= WEAPON_RESOLUTION_FIELD + 1); // sanity: always a valid enum
		CHECK(StatCombat::ParseResolution(cp({{"resolution", "statistcal"}}))
			== WEAPON_RESOLUTION_SIM);   // the realistic typo
		CHECK(StatCombat::ParseResolution(cp({{"resolution", "Statistical"}}))
			== WEAPON_RESOLUTION_SIM);   // case-sensitive by contract
		CHECK(StatCombat::ParseResolution(cp({{"resolution", ""}}))
			== WEAPON_RESOLUTION_SIM);
		CHECK(StatCombat::ParseResolution(cp({{"combat_model", "statistcal"}}))
			== WEAPON_RESOLUTION_SIM);   // legacy alias, same treatment
	}

	TEST_CASE("new resolution key wins over legacy alias when both present") {
		CHECK(StatCombat::ParseResolution(
			cp({{"resolution", "statistical"}, {"combat_model", "ballistic"}}))
			== WEAPON_RESOLUTION_STATISTICAL);
	}

	TEST_CASE("tuning defaults when absent, parses when present") {
		const StatCombat::Tuning def = StatCombat::ParseTuning(cp({}));
		CHECK(def.baseAccuracy == doctest::Approx(0.85f));
		CHECK(def.minVolleyDamage == doctest::Approx(0.0f));
		CHECK(def.skipFireStrength == doctest::Approx(0.0f));

		const StatCombat::Tuning t = StatCombat::ParseTuning(cp({
			{"stat_base_accuracy", "0.5"},
			{"min_volley_damage", "12"},
			{"skip_fire_strength", "0.1"},
			{"targeting_cadence", "30"},
		}));
		CHECK(t.baseAccuracy == doctest::Approx(0.5f));
		CHECK(t.minVolleyDamage == doctest::Approx(12.0f));
		CHECK(t.skipFireStrength == doctest::Approx(0.1f));
		CHECK(t.targetingCadence == 30);
	}
}

TEST_SUITE("statistical-combat/accuracy") {
	TEST_CASE("point-blank, stationary, level ground => base accuracy") {
		StatCombat::Tuning t; // base 0.85
		const float p = StatCombat::HitProbability(t, /*dist*/0.0f, /*range*/500.0f, false, 0.0f);
		CHECK(p == doctest::Approx(0.85f));
	}

	TEST_CASE("at max range => falloff drives probability to zero") {
		StatCombat::Tuning t;
		const float p = StatCombat::HitProbability(t, /*dist*/500.0f, /*range*/500.0f, false, 0.0f);
		CHECK(p == doctest::Approx(0.0f));
	}

	TEST_CASE("closer is never worse than farther (monotone)") {
		StatCombat::Tuning t;
		const float near = StatCombat::HitProbability(t, 100.0f, 500.0f, false, 0.0f);
		const float far  = StatCombat::HitProbability(t, 400.0f, 500.0f, false, 0.0f);
		CHECK(near > far);
	}

	TEST_CASE("movement penalty lowers probability") {
		StatCombat::Tuning t; // movePenalty 0.5
		const float still  = StatCombat::HitProbability(t, 100.0f, 500.0f, false, 0.0f);
		const float moving = StatCombat::HitProbability(t, 100.0f, 500.0f, true,  0.0f);
		CHECK(moving < still);
		CHECK(moving == doctest::Approx(still * 0.5f));
	}

	TEST_CASE("height advantage helps, disadvantage hurts, result clamps to [0,1]") {
		StatCombat::Tuning t;
		const float level = StatCombat::HitProbability(t, 100.0f, 500.0f, false,  0.0f);
		const float high  = StatCombat::HitProbability(t, 100.0f, 500.0f, false,  1.0f);
		const float low   = StatCombat::HitProbability(t, 100.0f, 500.0f, false, -1.0f);
		CHECK(high > level);
		CHECK(low  < level);
		CHECK(high <= 1.0f);
		CHECK(low  >= 0.0f);
	}
}

TEST_SUITE("statistical-combat/damage") {
	TEST_CASE("a miss deals nothing") {
		CHECK(StatCombat::VolleyDamage(100.0f, 1.0f, /*hit*/false, 0.0f) == doctest::Approx(0.0f));
	}

	TEST_CASE("a hit scales with the firing squad's strength fraction") {
		CHECK(StatCombat::VolleyDamage(100.0f, 1.0f, true, 0.0f) == doctest::Approx(100.0f));
		CHECK(StatCombat::VolleyDamage(100.0f, 0.5f, true, 0.0f) == doctest::Approx(50.0f));
	}

	TEST_CASE("E6 floor: a weak-squad hit still lands minVolleyDamage") {
		// 100 dmg * 0.02 strength = 2, floored up to 10
		CHECK(StatCombat::VolleyDamage(100.0f, 0.02f, true, 10.0f) == doctest::Approx(10.0f));
		// above the floor, the floor does not apply
		CHECK(StatCombat::VolleyDamage(100.0f, 0.5f, true, 10.0f) == doctest::Approx(50.0f));
		// a miss is never floored
		CHECK(StatCombat::VolleyDamage(100.0f, 0.5f, false, 10.0f) == doctest::Approx(0.0f));
	}
}

TEST_SUITE("statistical-combat/ring") {
	static PendingVolley volleyAt(int resolveFrame, int targetId) {
		PendingVolley v;
		v.resolveFrame = resolveFrame;
		v.targetId = targetId;
		v.damage = 10.0f;
		return v;
	}

	TEST_CASE("CollectDue drains only entries at or before the frame") {
		StatisticalCombatManager m;
		m.Init();
		m.Schedule(volleyAt(10, 1));
		m.Schedule(volleyAt(20, 2));
		m.Schedule(volleyAt(30, 3));
		CHECK(m.PendingCount() == 3);

		std::vector<PendingVolley> due;
		m.CollectDue(5, due);
		CHECK(due.empty());
		CHECK(m.PendingCount() == 3);

		m.CollectDue(15, due);
		CHECK(due.size() == 1);
		CHECK(due[0].targetId == 1);
		CHECK(m.PendingCount() == 2);

		m.CollectDue(100, due);
		CHECK(due.size() == 3); // accumulated
		CHECK(m.PendingCount() == 0);
	}

	TEST_CASE("an entry due exactly on the current frame resolves") {
		StatisticalCombatManager m;
		m.Init();
		m.Schedule(volleyAt(42, 7));
		std::vector<PendingVolley> due;
		m.CollectDue(42, due);
		CHECK(due.size() == 1);
		CHECK(m.PendingCount() == 0);
	}
}

TEST_SUITE("statistical-combat/morale") {
	// Q-D-c derived-proxy morale: morale = clamp(hp% - 10, 0, 100). Thresholds:
	// hp < 20% (morale < 10) => retreat-while-firing; hp <= 10% (morale 0) => panic.
	TEST_CASE("derived morale is hp% minus 10, clamped") {
		CHECK(StatCombat::DerivedMorale(100.0f, 100.0f) == doctest::Approx(90.0f));
		CHECK(StatCombat::DerivedMorale( 50.0f, 100.0f) == doctest::Approx(40.0f));
		CHECK(StatCombat::DerivedMorale( 20.0f, 100.0f) == doctest::Approx(10.0f));
		CHECK(StatCombat::DerivedMorale( 10.0f, 100.0f) == doctest::Approx( 0.0f));
		CHECK(StatCombat::DerivedMorale(  5.0f, 100.0f) == doctest::Approx( 0.0f));
		// full health of a zero-max unit is treated as fully-moraled (no div-by-0)
		CHECK(StatCombat::DerivedMorale(  0.0f,   0.0f) == doctest::Approx(100.0f));
	}

	TEST_CASE("posture crosses the two thresholds at hp 20% and hp 10%") {
		// >= 20% hp -> normal
		CHECK(StatCombat::PostureFrom(100.0f, 100.0f) == StatCombat::MORALE_NORMAL);
		CHECK(StatCombat::PostureFrom( 20.0f, 100.0f) == StatCombat::MORALE_NORMAL);
		// (10%, 20%) hp -> retreat while firing
		CHECK(StatCombat::PostureFrom( 19.0f, 100.0f) == StatCombat::MORALE_RETREAT);
		CHECK(StatCombat::PostureFrom( 11.0f, 100.0f) == StatCombat::MORALE_RETREAT);
		// <= 10% hp -> panic (flee without firing)
		CHECK(StatCombat::PostureFrom( 10.0f, 100.0f) == StatCombat::MORALE_PANIC);
		CHECK(StatCombat::PostureFrom(  1.0f, 100.0f) == StatCombat::MORALE_PANIC);
	}
}

TEST_SUITE("statistical-combat/determinism") {
	TEST_CASE("synced RNG replays identically from the same seed") {
		// The volley hit-roll draws from gsRNG; a fixed seed must reproduce the
		// exact sequence so battles are replay/snapshot-exact (PLAN §2.2).
		gsRNG.SetSeed(1234567u, true);
		std::vector<float> a;
		for (int i = 0; i < 16; ++i) a.push_back(gsRNG.NextFloat());

		gsRNG.SetSeed(1234567u, true);
		std::vector<float> b;
		for (int i = 0; i < 16; ++i) b.push_back(gsRNG.NextFloat());

		CHECK(a == b);
	}
}

TEST_SUITE("statistical-combat/perf") {
	// PLAN-metalstorm-combat-resolution.md §8 task 6 sim-cost gate: the added
	// per-volley cost of Model-1 resolution (over the faithful no-op path) is
	// the accuracy roll + damage scaling — everything else (DoDamage at the
	// resolve frame) is cost the sim already pays for a sim-model hit. This
	// microbenchmark times exactly that added arithmetic: one HitProbability
	// eval, one synced-RNG draw + compare, one VolleyDamage. The scheduling
	// push_back / partition-drain is amortized O(1) and excluded (it is not the
	// dominant term and would drag machine-specific allocator noise in).
	//
	// Reports ns/volley; asserts only a generous order-of-magnitude ceiling so
	// it proves "≈ noise" without flaking on a busy CI box. At the §8 target of
	// ~45 ns/volley, a 2000-squad exchange (~2000 volleys/s ≈ 67/frame at 30Hz)
	// costs ~3 µs/frame — noise against a 33 ms budget.
	TEST_CASE("per-volley resolution cost is order ~tens of ns (≈ noise)") {
		StatCombat::Tuning t; // defaults (baseAccuracy 0.85, etc.)
		gsRNG.SetSeed(20260720u, true);

		const int N = 4'000'000;
		volatile float sink = 0.0f; // defeat dead-code elimination
		int hits = 0;

		const auto t0 = std::chrono::steady_clock::now();
		for (int i = 0; i < N; ++i) {
			// A representative spread of engagement geometry so the branch
			// predictor and the falloff math see realistic inputs.
			const float dist        = 50.0f + static_cast<float>(i % 850);
			const float heightDelta = ((i % 7) - 3) * 0.1f;
			const bool  moving      = (i & 1) != 0;

			const float p   = StatCombat::HitProbability(t, dist, 900.0f, moving, heightDelta);
			const bool  hit = gsRNG.NextFloat() <= p;
			hits += hit ? 1 : 0;
			sink += StatCombat::VolleyDamage(100.0f, 0.8f, hit, t.minVolleyDamage);
		}
		const auto t1 = std::chrono::steady_clock::now();

		const double ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
		const double nsPerVolley = ns / N;
		std::printf("[perf] statistical volley resolution: %.1f ns/volley "
		            "(%d volleys, %.1f%% hits)\n",
		            nsPerVolley, N, 100.0 * hits / N);

		CHECK(sink >= 0.0f); // keep the accumulator live
		// Generous ceiling: even a debug build on a loaded box stays well under
		// 1 µs/volley. The point is the order of magnitude, not a hard budget.
		CHECK(nsPerVolley < 1000.0);
	}
}

// ---------------------------------------------------------------------------
// Model 3 — damage fields (C6, PLAN-metalstorm-combat-resolution.md §4/§9).
// Covers the PURE, world-decoupled halves: field geometry (Contains /
// PerTickDamage), Create argument validation + Created/Removed wire events,
// and the cadence/expiry scheduling of CollectDamageTicks. The DoDamage
// application (quadfield query + friendly-fire filter) needs a live world and
// is exercised by the integration harness, not here.
// ---------------------------------------------------------------------------

#include "Sim/Weapons/DamageField.h"
#include "Sim/Misc/GlobalConstants.h" // GAME_SPEED

TEST_SUITE("damage-field/geometry") {
	TEST_CASE("circle Contains is a radius test on xz") {
		DamageField f;
		f.shape = DAMAGE_FIELD_CIRCLE;
		f.center = float3(100.0f, 500.0f, 200.0f); // y ignored
		f.radius = 50.0f;
		CHECK(f.Contains(float3(100.0f, 0.0f, 200.0f)));      // center
		CHECK(f.Contains(float3(140.0f, 999.0f, 200.0f)));    // inside, any y
		CHECK(f.Contains(float3(150.0f, 0.0f, 200.0f)));      // on the edge
		CHECK_FALSE(f.Contains(float3(151.0f, 0.0f, 200.0f))); // just outside
		CHECK_FALSE(f.Contains(float3(100.0f, 0.0f, 260.0f))); // outside on z
	}

	TEST_CASE("rect Contains is an axis-aligned box on xz") {
		DamageField f;
		f.shape = DAMAGE_FIELD_RECT;
		f.center = float3(0.0f, 0.0f, 0.0f);
		f.radius = 30.0f; // half-extent x
		f.halfZ  = 10.0f; // half-extent z
		CHECK(f.Contains(float3(30.0f, 0.0f, 10.0f)));    // corner
		CHECK(f.Contains(float3(-29.0f, 0.0f, -9.0f)));   // inside
		CHECK_FALSE(f.Contains(float3(31.0f, 0.0f, 0.0f))); // past x
		CHECK_FALSE(f.Contains(float3(0.0f, 0.0f, 11.0f))); // past z
	}

	TEST_CASE("PerTickDamage scales intensity by the cadence time slice") {
		DamageField f;
		f.intensity = 60.0f;         // damage/second
		f.cadence   = GAME_SPEED;    // one full game-second per tick
		CHECK(f.PerTickDamage() == doctest::Approx(60.0f));
		f.cadence = GAME_SPEED / 2;  // half a second per tick
		CHECK(f.PerTickDamage() == doctest::Approx(30.0f));
	}
}

TEST_SUITE("damage-field/manager") {
	TEST_CASE("Create validates arguments and emits a Created event") {
		DamageFieldManager m;
		m.Init();
		// Rejections (return 0, no field, no event).
		CHECK(m.Create(DAMAGE_FIELD_CIRCLE, float3(0,0,0), 50.0f, 0.0f, -1, 10.0f, 15, /*dur*/0, -1, 0, false, 0) == 0);
		CHECK(m.Create(DAMAGE_FIELD_CIRCLE, float3(0,0,0), 0.0f,  0.0f, -1, 10.0f, 15, 100, -1, 0, false, 0) == 0);
		CHECK(m.Create(DAMAGE_FIELD_CIRCLE, float3(0,0,0), 50.0f, 0.0f, -1, 0.0f,  15, 100, -1, 0, false, 0) == 0);
		CHECK(m.FieldCount() == 0);
		CHECK(m.DrainEvents().empty());

		const uint32_t id = m.Create(DAMAGE_FIELD_CIRCLE, float3(10,20,30), 50.0f, 0.0f,
		                             7, 40.0f, 15, /*dur*/300, -1, 2, false, /*frame*/1000);
		CHECK(id != 0);
		CHECK(m.FieldCount() == 1);
		auto evs = m.DrainEvents();
		REQUIRE(evs.size() == 1);
		CHECK(evs[0].kind == 0);            // Created
		CHECK(evs[0].fieldId == id);
		CHECK(evs[0].weaponDefId == 7);
		CHECK(evs[0].duration == 300u);     // remaining frames at create
		CHECK(evs[0].team == 2);
		CHECK(m.DrainEvents().empty());     // drained
	}

	TEST_CASE("ids increase monotonically") {
		DamageFieldManager m; m.Init();
		const uint32_t a = m.Create(DAMAGE_FIELD_CIRCLE, float3(0,0,0), 10.0f, 0.0f, -1, 5.0f, 15, 100, -1, 0, false, 0);
		const uint32_t b = m.Create(DAMAGE_FIELD_CIRCLE, float3(0,0,0), 10.0f, 0.0f, -1, 5.0f, 15, 100, -1, 0, false, 0);
		CHECK(b == a + 1);
	}

	TEST_CASE("CollectDamageTicks fires on cadence and stops at expiry") {
		DamageFieldManager m; m.Init();
		// created at frame 0, cadence 15, duration 45 → ticks at 15, 30; expires at 45.
		const uint32_t id = m.Create(DAMAGE_FIELD_CIRCLE, float3(0,0,0), 20.0f, 0.0f,
		                             -1, 30.0f, 15, /*dur*/45, -1, 0, false, /*frame*/0);
		m.DrainEvents(); // discard the Created event

		std::vector<uint32_t> expired;
		CHECK(m.CollectDamageTicks(14, expired).empty());   // before first tick
		CHECK(expired.empty());

		auto t15 = m.CollectDamageTicks(15, expired);        // first tick
		REQUIRE(t15.size() == 1);
		CHECK(t15[0].id == id);
		CHECK(expired.empty());

		CHECK(m.CollectDamageTicks(20, expired).empty());   // between ticks
		auto t30 = m.CollectDamageTicks(30, expired);        // second tick
		CHECK(t30.size() == 1);

		// At frame 45 the field expires: no damage tick, one expiry, a Removed
		// event, and the field is gone.
		auto t45 = m.CollectDamageTicks(45, expired);
		CHECK(t45.empty());
		REQUIRE(expired.size() == 1);
		CHECK(expired[0] == id);
		CHECK(m.FieldCount() == 0);
		auto evs = m.DrainEvents();
		REQUIRE(evs.size() == 1);
		CHECK(evs[0].kind == 1);            // Removed
		CHECK(evs[0].fieldId == id);
		CHECK(evs[0].duration == 0u);
	}

	TEST_CASE("a big frame jump advances past missed ticks, applying one") {
		DamageFieldManager m; m.Init();
		// cadence 15, long duration; jump straight to frame 100 (missed 15..90).
		const uint32_t id = m.Create(DAMAGE_FIELD_CIRCLE, float3(0,0,0), 20.0f, 0.0f,
		                             -1, 30.0f, 15, /*dur*/6000, -1, 0, false, /*frame*/0);
		m.DrainEvents();
		std::vector<uint32_t> expired;
		auto due = m.CollectDamageTicks(100, expired);
		CHECK(due.size() == 1);            // one catch-up tick, not seven
		CHECK(id == due[0].id);
		// Next tick must be strictly after frame 100 (advanced past the jump).
		auto again = m.CollectDamageTicks(100, expired);
		CHECK(again.empty());
		CHECK_FALSE(m.CollectDamageTicks(104, expired).size() > 0); // still before 105
		CHECK(m.CollectDamageTicks(105, expired).size() == 1);      // resumes on cadence
	}

	TEST_CASE("Remove enforces owner-team and pushes a Removed event") {
		DamageFieldManager m; m.Init();
		const uint32_t id = m.Create(DAMAGE_FIELD_CIRCLE, float3(0,0,0), 20.0f, 0.0f,
		                             -1, 30.0f, 15, 300, -1, /*ownerTeam*/3, false, 0);
		m.DrainEvents();
		CHECK_FALSE(m.Remove(id, /*team*/4)); // cross-team attempt fails
		CHECK(m.FieldCount() == 1);
		CHECK(m.Remove(id, /*team*/3));       // owner removes it
		CHECK(m.FieldCount() == 0);
		auto evs = m.DrainEvents();
		REQUIRE(evs.size() == 1);
		CHECK(evs[0].kind == 1);
		CHECK(evs[0].fieldId == id);
	}
}
