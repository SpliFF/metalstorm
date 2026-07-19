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
