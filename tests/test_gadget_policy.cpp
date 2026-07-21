// PLAN-security-hardening task 9 (G7/G8/G9/G18/G19): the per-deployment
// gadget-set allow-list. We test the pure deny decision (detail::IsDeniedPath)
// with explicit operator extend/allow sets, so the asserts don't depend on the
// process-global env-driven strict flag (which initialises once per process).

#include <doctest/doctest.h>

#include <string>
#include <unordered_set>

#include "Lua/GadgetPolicy.h"

using GadgetPolicy::detail::IsDeniedPath;
using GadgetPolicy::detail::LowerBasename;

namespace {
const std::unordered_set<std::string> kNone;
}

TEST_CASE("GadgetPolicy excludes the audited dangerous gadgets") {
	// G7 / G8 / G9 / G18 / G19 — the named files must be denied when they sit
	// under a gadget path.
	CHECK(IsDeniedPath("LuaRules/Gadgets/AILoader.lua", kNone, kNone));            // G7
	CHECK(IsDeniedPath("LuaRules/Gadgets/game_restart_with_state.lua", kNone, kNone)); // G8
	CHECK(IsDeniedPath("LuaRules/Gadgets/ai_ruin_blueprint_tester.lua", kNone, kNone)); // G9 (also *_tester)
	CHECK(IsDeniedPath("LuaRules/Gadgets/dbg_synced_proxy.lua", kNone, kNone));    // G19 (also dbg_)
	CHECK(IsDeniedPath("LuaRules/Gadgets/unit_icongenerator.lua", kNone, kNone));  // G18
	// case-insensitive on the basename
	CHECK(IsDeniedPath("LuaRules/Gadgets/AiLoAdEr.LUA", kNone, kNone));
}

TEST_CASE("GadgetPolicy denies the dev/debug class by heuristic") {
	// dbg_* prefix — the whole ZK debug-spawner family (dbg_ceg_spawner, etc.)
	CHECK(IsDeniedPath("LuaRules/Gadgets/dbg_ceg_spawner.lua", kNone, kNone));
	CHECK(IsDeniedPath("LuaRules/Gadgets/dbg_animator.lua", kNone, kNone));
	CHECK(IsDeniedPath("LuaRules/Gadgets/dbg_dev_commands.lua", kNone, kNone));
	// *_tester.lua harnesses
	CHECK(IsDeniedPath("LuaRules/Gadgets/weapon_tester.lua", kNone, kNone));
}

TEST_CASE("GadgetPolicy leaves ordinary gadgets alone") {
	CHECK_FALSE(IsDeniedPath("LuaRules/Gadgets/unit_morph.lua", kNone, kNone));
	CHECK_FALSE(IsDeniedPath("LuaRules/Gadgets/game_over.lua", kNone, kNone));
	CHECK_FALSE(IsDeniedPath("LuaRules/Gadgets/api_gadget.lua", kNone, kNone));
}

TEST_CASE("GadgetPolicy is scoped to gadget paths") {
	// A file that happens to share a denied basename but is NOT under a gadget
	// path must not be dropped — the shared VFS chokepoint hosts this predicate.
	CHECK_FALSE(IsDeniedPath("units/dbg_animator.lua", kNone, kNone));
	CHECK_FALSE(IsDeniedPath("LuaUI/Widgets/dbg_widget.lua", kNone, kNone));
	// but the same name under a Gadgets/ path is denied
	CHECK(IsDeniedPath("LuaRules/Gadgets/dbg_animator.lua", kNone, kNone));
}

TEST_CASE("GadgetPolicy honours operator extend / re-allow") {
	const std::unordered_set<std::string> deny = {"unit_morph.lua"};
	const std::unordered_set<std::string> allow = {"dbg_animator.lua"};
	// SPRING_GADGET_DENY extends the set
	CHECK(IsDeniedPath("LuaRules/Gadgets/unit_morph.lua", deny, kNone));
	// SPRING_GADGET_ALLOW wins over both the default set and an extension
	CHECK_FALSE(IsDeniedPath("LuaRules/Gadgets/dbg_animator.lua", kNone, allow));
	CHECK_FALSE(IsDeniedPath("LuaRules/Gadgets/dbg_animator.lua", deny, allow));
}

TEST_CASE("GadgetPolicy AllowCheats mirrors IsStrict") {
	// Whatever this build's posture is, cheats-allowed is exactly its inverse.
	CHECK(GadgetPolicy::AllowCheats() == !GadgetPolicy::IsStrict());
}

TEST_CASE("GadgetPolicy basename extraction") {
	CHECK(LowerBasename("LuaRules/Gadgets/Foo.lua") == "foo.lua");
	CHECK(LowerBasename("bare.lua") == "bare.lua");
}
