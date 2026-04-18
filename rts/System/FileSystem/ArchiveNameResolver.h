/**
 * Stub — ArchiveNameResolver removed (no archives).
 * Returns names unchanged since there are no rapid tags to resolve.
 */
#pragma once

#include <string>

namespace ArchiveNameResolver {
	inline std::string GetMap(const std::string& name) { return name; }
	inline std::string GetGame(const std::string& name) { return name; }
}

inline std::string GetRapidPackageFromTag(const std::string&) { return ""; }
