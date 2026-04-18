#pragma once
// Server-build stub — archive system removed.
#include <string>
#include <vector>

class IArchive {
public:
	virtual ~IArchive() = default;
	bool GetFile(unsigned int, std::vector<unsigned char>&) { return false; }
	bool GetFile(const std::string&, std::vector<unsigned char>&) { return false; }
	unsigned int NumFiles() const { return 0; }
	bool FileExists(const std::string&) const { return false; }
	unsigned int FindFile(const std::string&) const { return 0; }
	void FileInfo(unsigned int, std::string&, int&, int&) const {}
};
