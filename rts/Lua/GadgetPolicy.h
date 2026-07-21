/* GadgetPolicy — a per-deployment synced-gadget allow-list.
 *
 * PLAN-security-hardening task 9 (G7/G8/G9/G18/G19). This is the *faithful*
 * alternative to patching the game's Lua: the §1.3 faithfulness note is
 * explicit that ZK/BAR gadget handlers are faithful reproductions of upstream
 * game gadgets and MUST NOT be edited to "fix" security. Instead the control
 * lives at the engine VFS layer — the synced gadget handler enumerates its
 * gadgets with VFS.DirList(LuaRules/Gadgets/, "*.lua") and loads each with
 * VFS.LoadFile / VFS.Include (rts/Lua/LuaVFS.cpp). When a deployment's policy
 * is strict, those engine calls simply omit / refuse the excluded gadget
 * files, so the game's own gadgets.lua is untouched — it never sees them.
 *
 * The dangerous, player-reachable gadgets identified by the task-1 sweep:
 *   G7  BAR AILoader.lua              — drops playerID → GiveOrderToUnit on
 *                                       ANY unit = authority bypass
 *   G8  BAR game_restart_with_state   — loadstring() on client chunks, no cheat
 *                                       gate → arbitrary synced Lua
 *   G9  BAR ai_ruin_blueprint_tester  — VFS.Include(client filename) traversal
 *   G18 ZK dbg_* spawners + icongen   — no-validation debug/relay outliers
 *   G19 BAR dbg_synced_proxy          — RPC into synced _G (cheat-gated only)
 * plus the general class they belong to: anything dev/debug (dbg_*), a test
 * harness (*_tester.lua), or an AI-command relay.
 *
 * Posture:
 *   - Under SPRING_PROD the policy is ALWAYS strict; the env cannot relax it
 *     (E1: a self-hosted prod binary bound public must not be one setenv from
 *     re-exposing these).
 *   - In dev builds the policy is permissive by default (the whole debug
 *     surface this project lives on stays intact) but can be forced on for
 *     testing with SPRING_GADGET_POLICY=strict.
 *   - Operators tune the set per deployment: SPRING_GADGET_DENY=a.lua,b.lua
 *     adds basenames; SPRING_GADGET_ALLOW=c.lua removes them (e.g. an operator
 *     who audited a specific dbg_ gadget and wants it back).
 *
 * Header-only (function-local statics parse the env once) so it drops into the
 * rts/Lua glob without a new translation unit, and links trivially into
 * spring-tests.
 */
#pragma once

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <string>
#include <unordered_set>
#include <vector>

namespace GadgetPolicy {

namespace detail {

inline std::string ToLower(std::string s) {
	std::transform(s.begin(), s.end(), s.begin(),
		[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
	return s;
}

/// basename of a '/'-separated VFS path, lowercased.
inline std::string LowerBasename(const std::string& path) {
	auto slash = path.find_last_of('/');
	return ToLower(slash == std::string::npos ? path : path.substr(slash + 1));
}

/// Split a comma/space-separated env list into lowercased basenames.
inline std::unordered_set<std::string> ParseEnvList(const char* name) {
	std::unordered_set<std::string> out;
	const char* v = std::getenv(name);
	if (!v) return out;
	std::string cur;
	for (const char* p = v; ; ++p) {
		if (*p == ',' || *p == ' ' || *p == '\0') {
			if (!cur.empty()) out.insert(LowerBasename(cur));
			cur.clear();
			if (*p == '\0') break;
		} else {
			cur.push_back(*p);
		}
	}
	return out;
}

struct Config {
	bool strict = false;
	std::unordered_set<std::string> denyExtra;   // SPRING_GADGET_DENY
	std::unordered_set<std::string> allowExtra;  // SPRING_GADGET_ALLOW
};

inline const Config& Cfg() {
	static const Config cfg = [] {
		Config c;
#ifdef SPRING_PROD
		c.strict = true;  // always on in prod, env cannot relax
#else
		const char* mode = std::getenv("SPRING_GADGET_POLICY");
		c.strict = (mode && ToLower(mode) == "strict");
#endif
		c.denyExtra = ParseEnvList("SPRING_GADGET_DENY");
		c.allowExtra = ParseEnvList("SPRING_GADGET_ALLOW");
		return c;
	}();
	return cfg;
}

/// The audited, always-denied gadget basenames (lowercased). Everything not
/// caught by this set or the dbg_/​_tester heuristics is allowed — the list is
/// an *allow-by-default* posture with a named exclusion set, per the plan.
inline bool InDefaultDenySet(const std::string& base) {
	static const std::unordered_set<std::string> kDenied = {
		"ailoader.lua",                  // G7  — authority bypass
		"game_restart_with_state.lua",   // G8  — loadstring on client chunks
		"ai_ruin_blueprint_tester.lua",  // G9  — VFS.Include traversal
		"dbg_synced_proxy.lua",          // G19 — RPC into synced _G
		"unit_icongenerator.lua",        // G18 — no field-count guard
	};
	if (kDenied.count(base)) return true;
	// The class the above belong to: dev/debug gadgets and test harnesses.
	if (base.rfind("dbg_", 0) == 0) return true;                      // dbg_* prefix
	const std::string suffix = "_tester.lua";
	if (base.size() >= suffix.size() &&
		base.compare(base.size() - suffix.size(), suffix.size(), suffix) == 0)
		return true;                                                 // *_tester.lua
	return false;
}

/// Pure deny decision for a gadget path given the operator extension/allow
/// sets — no dependency on the global strict flag, so it is directly unit
/// testable. Scoped to gadget paths: a path with no "gadget" component is
/// never denied, even if its basename matches (so the shared VFS chokepoint
/// can host this without dropping same-named non-gadget files).
inline bool IsDeniedPath(const std::string& path,
	const std::unordered_set<std::string>& extraDeny,
	const std::unordered_set<std::string>& extraAllow) {
	if (ToLower(path).find("gadget") == std::string::npos) return false;
	const std::string base = LowerBasename(path);
	if (extraAllow.count(base)) return false;  // operator re-allow wins
	if (extraDeny.count(base)) return true;    // operator extension
	return InDefaultDenySet(base);
}

}  // namespace detail

/// Is the deny-set enforced for this deployment?
inline bool IsStrict() { return detail::Cfg().strict; }

/// Are cheats permitted? A strict deployment keeps IsCheatingEnabled off so the
/// G18/G19 cheat-gated debug gadgets (and the synced "cheat" action) stay inert
/// even if a gadget slips through. No-op (true) when not strict.
inline bool AllowCheats() { return !detail::Cfg().strict; }

/// True if `path` names a gadget excluded under the active policy. Scoped to
/// gadget paths (the path must contain a "gadget" component) so it can sit on
/// the shared VFS load chokepoint without ever dropping a same-named non-gadget
/// file. Always false when the policy is permissive.
inline bool IsGadgetDenied(const std::string& path) {
	const auto& cfg = detail::Cfg();
	if (!cfg.strict) return false;
	return detail::IsDeniedPath(path, cfg.denyExtra, cfg.allowExtra);
}

/// Filter a VFS.DirList result in place, removing denied gadget files. Returns
/// the removed basenames (for a one-line audit log at the call site). No-op
/// when permissive.
inline std::vector<std::string> FilterDirList(std::vector<std::string>& entries) {
	std::vector<std::string> removed;
	if (!IsStrict()) return removed;
	entries.erase(std::remove_if(entries.begin(), entries.end(),
		[&](const std::string& e) {
			if (IsGadgetDenied(e)) { removed.push_back(detail::LowerBasename(e)); return true; }
			return false;
		}), entries.end());
	return removed;
}

}  // namespace GadgetPolicy
