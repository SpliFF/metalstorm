/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// Metalstorm mixed-size group flow — footprint profile parsing + F2 permeability
// (PLAN-metalstorm-flow.md §1/§3/§9). Covers the pure, decoupled halves of the
// system: the gamedata/footprints.lua grammar (parsed via LoadFromChunk, the
// same ParseRoot path the runtime Load() uses), and the permeability decision
// matrix (class × moving/stopped/turning → passability). The underpass
// name→pathType RESOLVE step needs a live MoveDefHandler + map, so it is
// exercised at boot, not here; the decision tests set underpassPathTypes
// directly to isolate the rule.

#include <doctest/doctest.h>

#include "Sim/MoveTypes/FootprintProfile.h"

#include <string>

using footprint::Contact;
using footprint::HullMotion;
using footprint::Passability;
using footprint::Profile;

// The §1 reference chunk: a quad walker (feet, underpass=infantry), a tracked
// heavy (track strips), and a scale-4 with an empty underpass list (solid).
static const char* kChunk = R"LUA(
return {
  quad_walker_l = {
    hull = { x = 96, z = 128 },
    clearance = 18,
    underpass = { 'INFANTRY' },
    contacts = {
      { kind = 'foot', x = -40, z =  48, r = 12, gait = { phase = 0.00, duty = 0.62 } },
      { kind = 'foot', x =  40, z =  48, r = 12, gait = { phase = 0.50, duty = 0.62 } },
      { kind = 'foot', x = -40, z = -48, r = 12, gait = { phase = 0.25, duty = 0.62 } },
      { kind = 'foot', x =  40, z = -48, r = 12, gait = { phase = 0.75, duty = 0.62 } },
    },
  },
  heavy_tracks = {
    hull = { x = 72, z = 104 },
    clearance = 10,
    underpass = { 'INFANTRY' },
    contacts = {
      { kind = 'track', x = -28, z = 0, halfWidth = 10, halfLength = 52 },
      { kind = 'track', x =  28, z = 0, halfWidth = 10, halfLength = 52 },
    },
  },
  dreadnought = {
    hull = { x = 160, z = 224 },
    clearance = 26,
    underpass = {},
    contacts = {
      { kind = 'foot', x = -60, z = 80, r = 18, gait = { phase = 0.0, duty = 0.66 } },
    },
  },
}
)LUA";


TEST_SUITE("footprint-profile/parse") {
	TEST_CASE("chunk parses every profile with the §1 schema") {
		FootprintProfileHandler h;
		REQUIRE(h.LoadFromChunk(kChunk));
		CHECK(h.Size() == 3);

		const Profile* qw = h.Get("quad_walker_l");
		REQUIRE(qw != nullptr);
		CHECK(qw->hullX == 96);
		CHECK(qw->hullZ == 128);
		CHECK(qw->clearance == 18);
		REQUIRE(qw->underpass.size() == 1);
		CHECK(qw->underpass[0] == "INFANTRY"); // value kept verbatim (not lowercased)
		REQUIRE(qw->contacts.size() == 4);
	}

	TEST_CASE("foot contacts carry radius + gait, in authored order") {
		FootprintProfileHandler h;
		REQUIRE(h.LoadFromChunk(kChunk));
		const Profile* qw = h.Get("quad_walker_l");
		REQUIRE(qw != nullptr);
		REQUIRE(qw->contacts.size() == 4);

		const Contact& c0 = qw->contacts[0];
		CHECK(c0.kind == Contact::Kind::Foot);
		CHECK(c0.x == doctest::Approx(-40.0f));
		CHECK(c0.z == doctest::Approx(48.0f));
		CHECK(c0.r == doctest::Approx(12.0f));
		CHECK(c0.gaitPhase == doctest::Approx(0.00f));
		CHECK(c0.gaitDuty  == doctest::Approx(0.62f));

		// phases interleave across the four legs (0.00 / 0.50 / 0.25 / 0.75)
		CHECK(qw->contacts[1].gaitPhase == doctest::Approx(0.50f));
		CHECK(qw->contacts[2].gaitPhase == doctest::Approx(0.25f));
		CHECK(qw->contacts[3].gaitPhase == doctest::Approx(0.75f));
	}

	TEST_CASE("track contacts carry strip dims and no gait") {
		FootprintProfileHandler h;
		REQUIRE(h.LoadFromChunk(kChunk));
		const Profile* ht = h.Get("heavy_tracks");
		REQUIRE(ht != nullptr);
		REQUIRE(ht->contacts.size() == 2);

		const Contact& t = ht->contacts[0];
		CHECK(t.kind == Contact::Kind::Track);
		CHECK(t.x == doctest::Approx(-28.0f));
		CHECK(t.halfWidth  == doctest::Approx(10.0f));
		CHECK(t.halfLength == doctest::Approx(52.0f));
		CHECK(t.r == doctest::Approx(0.0f)); // no foot radius on a track
	}

	TEST_CASE("empty underpass list parses (scale-4 solid case)") {
		FootprintProfileHandler h;
		REQUIRE(h.LoadFromChunk(kChunk));
		const Profile* dn = h.Get("dreadnought");
		REQUIRE(dn != nullptr);
		CHECK(dn->underpass.empty());
		CHECK(dn->hullX == 160);
	}

	TEST_CASE("unknown key returns null, malformed chunk fails cleanly") {
		FootprintProfileHandler h;
		REQUIRE(h.LoadFromChunk(kChunk));
		CHECK(h.Get("no_such_profile") == nullptr);

		FootprintProfileHandler bad;
		CHECK_FALSE(bad.LoadFromChunk("return this is not lua"));
		CHECK(bad.Size() == 0);
	}
}


// The F2 permeability matrix (PLAN-metalstorm-flow §3/§9). The RESOLVE step is
// isolated out by setting underpassPathTypes directly: pathType 7 = a permitted
// class (e.g. infantry), pathType 3 = a non-permitted class (e.g. tank).
TEST_SUITE("footprint-profile/permeability") {
	static Profile permitInfantry() {
		Profile p;
		p.name = "quad_walker_l";
		p.hullX = 96; p.hullZ = 128;
		p.underpass = { "infantry" };
		p.underpassPathTypes = { 7 };
		return p;
	}

	TEST_CASE("PermitsUnderpass is exactly the resolved set") {
		const Profile p = permitInfantry();
		CHECK(p.PermitsUnderpass(7));       // permitted class
		CHECK_FALSE(p.PermitsUnderpass(3)); // non-permitted class
		CHECK_FALSE(p.PermitsUnderpass(0));
	}

	TEST_CASE("permitted class: passable while moving OR stopped, blocked while turning") {
		const Profile p = permitInfantry();
		CHECK(p.PassabilityFor(7, HullMotion::Moving)         == Passability::PassableWithCost);
		CHECK(p.PassabilityFor(7, HullMotion::Stopped)        == Passability::PassableWithCost);
		// turn-in-place hard-blocks even a permitted class (§3)
		CHECK(p.PassabilityFor(7, HullMotion::TurningInPlace) == Passability::Solid);
	}

	TEST_CASE("non-permitted class: solid in every motion state") {
		const Profile p = permitInfantry();
		CHECK(p.PassabilityFor(3, HullMotion::Moving)         == Passability::Solid);
		CHECK(p.PassabilityFor(3, HullMotion::Stopped)        == Passability::Solid);
		CHECK(p.PassabilityFor(3, HullMotion::TurningInPlace) == Passability::Solid);
	}

	TEST_CASE("empty underpass (scale-4 solid): solid to all") {
		Profile solid;
		solid.name = "dreadnought";
		// no underpassPathTypes
		CHECK_FALSE(solid.PermitsUnderpass(7));
		CHECK(solid.PassabilityFor(7, HullMotion::Moving)  == Passability::Solid);
		CHECK(solid.PassabilityFor(7, HullMotion::Stopped) == Passability::Solid);
	}

	TEST_CASE("the plan's ×2 underpass cost constant is exposed (F2b applies it)") {
		CHECK(footprint::kUnderpassCostMult == doctest::Approx(2.0f));
	}
}
