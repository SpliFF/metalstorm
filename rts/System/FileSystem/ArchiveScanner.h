/**
 * Stub — ArchiveScanner removed (no archives in server-authoritative model).
 * Provides the CArchiveScanner interface as no-ops so existing code compiles.
 * Will be replaced when content loading is reimplemented (PLAN-content.md).
 */
#pragma once

#include <string>
#include <vector>
#include <map>

class CArchiveScanner {
public:
	struct ArchiveData {
		std::string GetName() const { return ""; }
		std::string GetNameVersioned() const { return ""; }
		std::string GetDescription() const { return ""; }
		std::string GetShortName() const { return ""; }
		std::string GetVersion() const { return ""; }
		std::string GetMutator() const { return ""; }
		std::string GetGame() const { return ""; }
		std::string GetShortGame() const { return ""; }
		std::string GetMapFile() const { return ""; }
		int GetModType() const { return 0; }
		bool IsEmpty() const { return true; }
		const std::map<std::string, std::string>& GetInfo() const {
			static std::map<std::string, std::string> empty;
			return empty;
		}
	};

	static std::string GetSpringBaseContentName() { return ""; }

	std::string GameHumanNameFromArchive(const std::string&) const { return ""; }
	std::string NameFromArchive(const std::string&) const { return ""; }
	std::string ArchiveFromName(const std::string&) const { return ""; }
	std::string GetArchivePath(const std::string&) const { return ""; }

	ArchiveData GetArchiveData(const std::string&) const { return {}; }

	unsigned int GetArchiveSingleChecksumBytes(const std::string&) const { return 0; }
	unsigned int GetArchiveCompleteChecksumBytes(const std::string&) const { return 0; }

	std::vector<std::string> GetMaps() const { return {}; }
	std::vector<std::string> GetPrimaryMods() const { return {}; }
	std::vector<std::string> GetAllArchives() const { return {}; }
};

// Global instance
inline CArchiveScanner* archiveScanner = nullptr;
