/**
 * Stub — DataDirsAccess provides file location resolution.
 * Returns paths unchanged (no data dir search).
 */
#pragma once

#include <string>

class DataDirsAccess {
public:
	std::string LocateFile(const std::string& file, int = 0) const { return file; }
	std::string LocateDir(const std::string& dir, int = 0) const { return dir; }
	bool InReadDir(const std::string&) const { return true; }
	bool InWriteDir(const std::string&) const { return true; }
};

inline DataDirsAccess dataDirsAccess;
