/**
 * Stub — CFileHandler reads files from plain directories instead of VFS.
 * Provides the same interface for code that constructs CFileHandler objects.
 * Will be fully implemented when content loading is built (PLAN-content.md).
 */
#pragma once

#include <string>
#include <vector>
#include <fstream>
#include <cstring>

class CFileHandler {
public:
	CFileHandler(const std::string& filename, const std::string& modes = "")
		: name(filename)
	{
		stream.open(filename, std::ios::binary);
		valid = stream.good();
	}

	void Open(const std::string& filename, const std::string& /*modes*/ = "") {
		name = filename;
		stream.close();
		stream.open(filename, std::ios::binary);
		valid = stream.good();
	}

	void Close() {
		stream.close();
		valid = false;
		name.clear();
	}

	bool FileExists() const { return valid; }
	int FileSize() const {
		if (!valid) return -1;
		auto& s = const_cast<std::ifstream&>(stream);
		auto pos = s.tellg();
		s.seekg(0, std::ios::end);
		int size = static_cast<int>(s.tellg());
		s.seekg(pos);
		return size;
	}

	int Read(void* buf, int length) {
		if (!valid) return 0;
		stream.read(static_cast<char*>(buf), length);
		return static_cast<int>(stream.gcount());
	}

	int ReadString(void* buf, int length) {
		return Read(buf, length);
	}

	void Seek(int pos, std::ios_base::seekdir dir = std::ios::beg) {
		if (valid) stream.seekg(pos, dir);
	}

	int GetPos() {
		if (!valid) return -1;
		return static_cast<int>(stream.tellg());
	}

	bool Eof() const {
		return !valid || const_cast<std::ifstream&>(stream).peek() == EOF;
	}

	const std::string& GetName() const { return name; }

	static bool FileExists(const std::string& filename, const std::string& = "") {
		std::ifstream f(filename);
		return f.good();
	}
	static bool FileExists(const std::string& filename, const char* /*modes*/) {
		std::ifstream f(filename);
		return f.good();
	}

	static std::vector<std::string> DirList(const std::string&, const std::string& = "", const std::string& = "") {
		return {};
	}
	static std::vector<std::string> SubDirs(const std::string&, const std::string& = "", const std::string& = "") {
		return {};
	}

	bool IsBuffered() const { return false; }
	std::vector<unsigned char> GetBuffer() { return {}; }

	bool LoadStringData(std::string& data) {
		if (!valid) return false;
		const int sz = FileSize();
		if (sz < 0) return false;
		data.resize(sz);
		Seek(0);
		stream.read(&data[0], sz);
		return stream.gcount() == sz;
	}

	// No-op mode filters — no real VFS, return first arg unchanged.
	static std::string AllowModes(const std::string& modes, const std::string& /*allowed*/) { return modes; }
	static std::string AllowModes(const char* modes, const char* /*allowed*/) { return modes ? modes : ""; }
	static std::string ForbidModes(const char* modes, const char* /*forbidden*/) { return modes ? modes : ""; }
	static std::string ForbidModes(const std::string& modes, const std::string& /*forbidden*/) { return modes; }

	static std::string GetFileAbsolutePath(const std::string& f, const std::string& = "") { return f; }
	static std::string GetArchiveContainingFile(const std::string&, const std::string& = "") { return ""; }
	static std::string GetArchiveContainingFile(const std::string&, const char* /*modes*/) { return ""; }

private:
	std::string name;
	std::ifstream stream;
	bool valid = false;
};
