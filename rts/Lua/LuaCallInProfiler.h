/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef LUA_CALLIN_PROFILER_H
#define LUA_CALLIN_PROFILER_H

#include <string>
#include <unordered_map>
#include <vector>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <sstream>

/**
 * LuaCallInProfiler — per-(handle, callin) wall-time accumulator for the
 * server-side synced Lua handles (LuaRules / LuaGaia). PLAN-performance.md
 * Phase 4.1: answers "which callin dominates the tick" and "how big a slice
 * of the sim tick is Lua".
 *
 * All synced Lua runs on the sim thread, and the `server lua profile` console
 * command is also drained on the sim thread (LuaExecEngine), so this is
 * single-threaded by construction — no locking. Disabled by default; the
 * per-call cost when off is a single bool load at the RunCallInTraceback
 * chokepoint (LuaHandle.cpp).
 *
 * Granularity is per (handle, callin), e.g. `LuaRules::GameFrame`. True
 * per-*gadget* attribution lives below the C++ boundary (gadgetHandler
 * dispatches each gadget's callin inside one Lua VM); that needs a Lua-side
 * hook and is left as a follow-up. This C++ cut already isolates the hot
 * callin and the Lua share of the tick, which is the first thing to know.
 *
 * Header-only with inline statics so both LuaHandle.cpp (producer) and
 * LuaExecEngine.cpp (console reporter) share one accumulator without a new
 * translation unit / CMake edit.
 */
class LuaCallInProfiler {
public:
	struct Entry {
		uint64_t count = 0;
		double totalUs = 0.0;
		double maxUs = 0.0;
	};

	static bool IsEnabled() { return enabled_; }
	static void SetEnabled(bool on) { enabled_ = on; }

	static void Record(const std::string& handle, const char* callin, double us) {
		Entry& e = entries_[handle + "::" + (callin != nullptr ? callin : "?")];
		e.count++;
		e.totalUs += us;
		if (us > e.maxUs)
			e.maxUs = us;
	}

	static void Reset() { entries_.clear(); }

	/// Ranked report (descending total time). topN <= 0 reports all rows.
	static std::string Report(int topN = 25) {
		std::vector<std::pair<std::string, Entry>> rows(entries_.begin(), entries_.end());
		std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
			return a.second.totalUs > b.second.totalUs;
		});

		std::ostringstream ss;
		ss << "lua profile: " << (enabled_ ? "on" : "off")
		   << ", " << rows.size() << " callin(s) tracked\n";
		ss << "callin                                          calls    total_ms    avg_us    max_us\n";

		int n = 0;
		for (const auto& [key, e] : rows) {
			if (topN > 0 && n >= topN)
				break;
			char buf[256];
			snprintf(buf, sizeof(buf), "%-46.46s %8llu %11.2f %9.1f %9.1f\n",
			         key.c_str(),
			         static_cast<unsigned long long>(e.count),
			         e.totalUs / 1000.0,
			         e.count != 0 ? e.totalUs / static_cast<double>(e.count) : 0.0,
			         e.maxUs);
			ss << buf;
			n++;
		}
		if (rows.empty())
			ss << "(no samples — enable with `server lua profile on`)\n";
		return ss.str();
	}

private:
	static inline bool enabled_ = false;
	static inline std::unordered_map<std::string, Entry> entries_;
};

#endif // LUA_CALLIN_PROFILER_H
