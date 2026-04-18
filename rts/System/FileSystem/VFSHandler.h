/**
 * Stub — VFSHandler removed (no virtual filesystem).
 * Provides the CVFSHandler interface as no-ops.
 */
#pragma once

#include <string>
#include <vector>

class CVFSHandler {
public:
	// Mode enum — stub values used by LuaGaia and others
	enum Section { Map = 0, Mod = 1, Base = 2 };

	bool FileExists(const std::string&, int = 0) const { return false; }
	// Overload for enum-based calls (e.g. FileExists(path, CVFSHandler::Map))
	bool FileExists(const std::string&, Section) const { return false; }
	bool AddArchive(const std::string&, bool = false) { return false; }
	bool AddArchiveWithDeps(const std::string&, bool = false) { return false; }
	bool RemoveArchive(const std::string&) { return false; }
	bool HasArchive(const std::string&) const { return false; }
	void UnMapArchives(bool = false) {}
	void ReMapArchives(bool = false) {}
	std::vector<std::string> DirList(const std::string&, const std::string& = "") const { return {}; }
	std::vector<std::string> SubDirs(const std::string&, const std::string& = "") const { return {}; }

	void SetName(const std::string&) {}
	const std::string& GetName() const { static std::string s; return s; }

	static void GrabLock() {}
	static void FreeLock() {}
};

inline CVFSHandler* vfsHandler = nullptr;
